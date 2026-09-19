use serde::Serialize;
use std::path::Path;

use super::GitError;
use super::cli::{GitCli, read_bounded};
use super::path::{RootMode, normalize_repo_relative};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub has_staged: bool,
    pub has_unstaged: bool,
    pub has_conflicts: bool,
    pub tracking: Option<String>,
    pub files: Vec<FileGitStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileGitStatus {
    pub path: String,
    /// "modified" | "untracked" | "deleted" | "conflict"
    pub state: String,
}

pub async fn get_remote(cli: &GitCli, space_dir: &Path) -> Result<Option<String>, GitError> {
    let out = cli
        .exec(space_dir, &["config", "--get", "remote.origin.url"])
        .await?;
    if out.exit_code != 0 {
        return Ok(None);
    }
    let url = out.stdout.trim().to_string();
    if url.is_empty() {
        Ok(None)
    } else {
        Ok(Some(url))
    }
}

/// Get space git status by parsing `git status --porcelain=v2 --branch -z`.
pub async fn status(cli: &GitCli, space_dir: &Path) -> Result<GitStatus, GitError> {
    let prefix = status_path_prefix(cli, space_dir).await?;
    let (success, bytes) = read_bounded(
        cli,
        space_dir,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=all",
            "--ignore-submodules=dirty",
            "-z",
            "--",
            ".",
        ],
        4 * 1024 * 1024,
    )
    .await?;
    if !success || bytes.len() > 4 * 1024 * 1024 {
        return Err(GitError::GitCommandFailed(
            "Repository status unavailable or exceeds the read limit".into(),
        ));
    }
    let output = String::from_utf8(bytes)
        .map_err(|_| GitError::GitCommandFailed("Repository paths have invalid encoding".into()))?;
    let mut status = parse_status_porcelain_v2_z(&output)?;
    if status.files.len() > 20_000 {
        return Err(GitError::GitCommandFailed(
            "Repository status exceeds the item limit".into(),
        ));
    }
    strip_status_path_prefix(&mut status, &prefix)?;
    let local_conflicts = status
        .files
        .iter()
        .any(|file| super::policy::contains(&file.path) && file.state == "conflict");
    status.files.retain(|file| {
        if super::policy::contains(&file.path) {
            return false;
        }
        let mut ancestor = space_dir.to_path_buf();
        let parts: Vec<_> = file.path.split('/').collect();
        for (index, part) in parts.iter().enumerate() {
            ancestor.push(part);
            if ancestor.join(".git").exists() {
                return index + 1 == parts.len() && file.state != "untracked";
            }
        }
        true
    });
    if status.files.is_empty() {
        status.has_staged = false;
        status.has_unstaged = false;
        status.has_conflicts = local_conflicts;
    }
    Ok(status)
}

pub async fn status_with_remote_counts(
    cli: &GitCli,
    space_dir: &Path,
) -> Result<GitStatus, GitError> {
    let mut status = status(cli, space_dir).await?;
    if get_remote(cli, space_dir).await?.is_none() {
        return Ok(status);
    }

    let branch = match current_branch(cli, space_dir).await {
        Ok(branch) if branch != "HEAD" && !branch.is_empty() => branch,
        _ => return Ok(status),
    };

    let remote_ref = format!("refs/remotes/origin/{branch}");
    if ref_exists(cli, space_dir, &remote_ref).await? {
        status.behind = count_rev_list(cli, space_dir, &format!("HEAD..{remote_ref}")).await?;
        status.ahead = count_rev_list(cli, space_dir, &format!("{remote_ref}..HEAD")).await?;
    } else {
        status.behind = 0;
        status.ahead = count_rev_list(cli, space_dir, "HEAD").await.unwrap_or(0);
    }

    Ok(status)
}
pub async fn ref_exists(cli: &GitCli, space_dir: &Path, reference: &str) -> Result<bool, GitError> {
    let out = cli
        .exec(space_dir, &["rev-parse", "--verify", reference])
        .await?;
    Ok(out.exit_code == 0)
}

async fn count_rev_list(cli: &GitCli, space_dir: &Path, rev: &str) -> Result<u32, GitError> {
    let out = cli.exec(space_dir, &["rev-list", "--count", rev]).await?;
    if out.exit_code != 0 {
        return Err(GitError::GitCommandFailed(format!(
            "git rev-list failed: {}",
            out.stderr.trim()
        )));
    }
    Ok(out.stdout.trim().parse().unwrap_or(0))
}

async fn status_path_prefix(cli: &GitCli, space_dir: &Path) -> Result<String, GitError> {
    let out = cli.exec(space_dir, &["rev-parse", "--show-prefix"]).await?;
    if out.exit_code != 0 {
        return Err(GitError::GitCommandFailed(format!(
            "git rev-parse failed: {}",
            out.stderr
        )));
    }
    Ok(out.stdout.trim().replace('\\', "/"))
}

pub fn strip_status_path_prefix(status: &mut GitStatus, prefix: &str) -> Result<(), GitError> {
    let normalized = prefix.trim_matches('/');
    if normalized.is_empty() {
        return Ok(());
    }
    let with_slash = format!("{normalized}/");
    status.files = status
        .files
        .drain(..)
        .filter_map(|file| {
            file.path.strip_prefix(&with_slash).map(|path| {
                normalize_repo_relative(path, RootMode::Reject).map(|path| FileGitStatus {
                    path,
                    state: file.state,
                })
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(())
}

pub fn parse_status_porcelain_v2_z(stdout: &str) -> Result<GitStatus, GitError> {
    let mut branch = String::from("HEAD");
    let mut ahead: u32 = 0;
    let mut behind: u32 = 0;
    let mut has_staged = false;
    let mut has_unstaged = false;
    let mut has_conflicts = false;
    let mut tracking: Option<String> = None;
    let mut files: Vec<FileGitStatus> = Vec::new();

    let records: Vec<&str> = stdout.split('\0').collect();
    let mut idx = 0;
    while idx < records.len() {
        let record = records[idx];
        idx += 1;
        if record.is_empty() {
            continue;
        }

        if let Some(rest) = record.strip_prefix("# branch.head ") {
            branch = rest.to_string();
            continue;
        }
        if let Some(rest) = record.strip_prefix("# branch.upstream ") {
            tracking = Some(rest.to_string());
            continue;
        }
        if let Some(rest) = record.strip_prefix("# branch.ab ") {
            for part in rest.split_whitespace() {
                if let Some(n) = part.strip_prefix('+') {
                    ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix('-') {
                    behind = n.parse().unwrap_or(0);
                }
            }
            continue;
        }

        if record.starts_with("u ") {
            has_conflicts = true;
            if let Some(path) = split_status_fields(record, 11).get(10) {
                files.push(FileGitStatus {
                    path: normalize_git_path(path)?,
                    state: "conflict".to_string(),
                });
            }
            continue;
        }

        if record.starts_with("1 ") {
            let fields = split_status_fields(record, 9);
            if fields.len() >= 9 {
                update_staged_flags(fields[1], &mut has_staged, &mut has_unstaged);
                files.push(FileGitStatus {
                    path: normalize_git_path(fields[8])?,
                    state: status_state_for_xy(fields[1]).to_string(),
                });
            }
            continue;
        }

        if record.starts_with("2 ") {
            let fields = split_status_fields(record, 10);
            if fields.len() >= 10 {
                update_staged_flags(fields[1], &mut has_staged, &mut has_unstaged);
                files.push(FileGitStatus {
                    path: normalize_git_path(fields[9])?,
                    state: status_state_for_xy(fields[1]).to_string(),
                });
                if idx < records.len() && !records[idx].is_empty() {
                    files.push(FileGitStatus {
                        path: normalize_git_path(records[idx])?,
                        state: "deleted".to_string(),
                    });
                    idx += 1;
                }
            }
            continue;
        }

        if let Some(rest) = record.strip_prefix("? ") {
            has_unstaged = true;
            files.push(FileGitStatus {
                path: normalize_git_path(rest)?,
                state: "untracked".to_string(),
            });
        }
    }

    Ok(GitStatus {
        repository: None,
        branch,
        ahead,
        behind,
        has_staged,
        has_unstaged,
        has_conflicts,
        tracking,
        files,
    })
}

fn split_status_fields(record: &str, fields: usize) -> Vec<&str> {
    record.splitn(fields, ' ').collect()
}

fn update_staged_flags(xy: &str, has_staged: &mut bool, has_unstaged: &mut bool) {
    if xy.len() < 2 {
        return;
    }
    let x = xy.as_bytes()[0];
    let y = xy.as_bytes()[1];
    if x != b'.' {
        *has_staged = true;
    }
    if y != b'.' {
        *has_unstaged = true;
    }
}

fn status_state_for_xy(xy: &str) -> &'static str {
    if xy.as_bytes().iter().any(|status| *status == b'D') {
        return "deleted";
    }
    "modified"
}

pub fn normalize_git_path(path: &str) -> Result<String, GitError> {
    let normalized = path.replace('\\', "/");
    let trimmed = normalized.trim_end_matches('/');
    normalize_repo_relative(trimmed, RootMode::Reject)
}
pub async fn current_branch(cli: &GitCli, space_dir: &Path) -> Result<String, GitError> {
    let out = cli
        .exec(space_dir, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await?;
    if out.exit_code != 0 {
        return Err(GitError::GitCommandFailed(format!(
            "git rev-parse failed: {}",
            out.stderr
        )));
    }
    Ok(out.stdout.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reads_status_without_desktop_or_mutating_repository() {
        let repository = tempfile::tempdir().unwrap();
        let cli = GitCli::detect().unwrap();
        assert_eq!(
            cli.exec(repository.path(), &["init"])
                .await
                .unwrap()
                .exit_code,
            0
        );
        std::fs::write(repository.path().join("note.md"), "body").unwrap();
        let before = std::fs::read(repository.path().join("note.md")).unwrap();
        let state = status(&cli, repository.path()).await.unwrap();
        assert!(
            state
                .files
                .iter()
                .any(|file| file.path == "note.md" && file.state == "untracked")
        );
        assert_eq!(
            std::fs::read(repository.path().join("note.md")).unwrap(),
            before
        );
    }
}

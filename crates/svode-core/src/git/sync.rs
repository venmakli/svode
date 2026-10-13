use std::path::Path;

use serde::Serialize;

use super::GitError;
use super::auth::{GitAuthChallenge, GitRemoteOperation};
use super::branch::GitOperation;
use super::cli::GitCli;
use super::path::{RootMode, normalize_repo_relative};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum SyncResult {
    Success {
        #[serde(rename = "publishedHead")]
        published_head: String,
    },
    Conflict {
        files: Vec<String>,
    },
    NoRemote,
    AuthRequired {
        challenge: GitAuthChallenge,
    },
    /// The last conflicted file was resolved while no merge was in progress.
    Resolved,
    /// Sync stopped before pull and push: the operation is finished in Git.
    OperationInProgress {
        operation: GitOperation,
    },
}

#[cfg(test)]
pub async fn sync_if_enabled(
    cli: &GitCli,
    repo: &Path,
    requested: bool,
) -> Result<Option<SyncResult>, GitError> {
    if !requested || !super::policy::effective_user_policy(repo).auto_sync {
        return Ok(None);
    }
    sync(cli, repo).await.map(Some)
}

/// Pull then push. Handle conflicts, no-remote, and auth errors.
pub async fn sync(cli: &GitCli, space_dir: &Path) -> Result<SyncResult, GitError> {
    if let Some(stopped) = preflight(cli, space_dir).await? {
        return Ok(stopped);
    }
    super::branch::prepare_existing(cli, space_dir).await?;
    // Check if remote is configured
    let remote_out = cli.exec(space_dir, &["remote"]).await?;
    if remote_out.stdout.trim().is_empty() {
        return Ok(SyncResult::NoRemote);
    }
    let target = super::operations::read_transport(cli, space_dir).await?;

    if upstream_ref(cli, space_dir).await?.is_none() {
        return sync_without_upstream(cli, space_dir, &target).await;
    }

    // Pull
    let pull_out = cli
        .exec(
            space_dir,
            &[
                "-c",
                "submodule.recurse=false",
                "-c",
                "rebase.autoStash=false",
                "-c",
                "merge.autoStash=false",
                "pull",
                "--no-rebase",
                "--no-recurse-submodules",
            ],
        )
        .await?;

    if pull_out.exit_code != 0 {
        return handle_pull_failure(cli, space_dir, &pull_out.stderr, &pull_out.stdout).await;
    }

    // Push
    validate_transport(cli, space_dir, &target).await?;
    let (push_out, published_head) =
        super::publication::push_snapshot(cli, space_dir, false).await?;
    if push_out.exit_code != 0 {
        let stderr = push_out.stderr.trim();

        if super::ops::is_git_auth_error(stderr) {
            return auth_required(cli, space_dir, GitRemoteOperation::Sync, Some(stderr)).await;
        }

        let error = super::ops::git_remote_command_error("git push", stderr);
        return remote_error_to_sync_result(cli, space_dir, GitRemoteOperation::Sync, error).await;
    }

    tracing::info!("Synced space {}", space_dir.display());
    Ok(SyncResult::Success {
        published_head: published_head.unwrap_or_default(),
    })
}

/// The state that stops sync before branch preparation, pull and push.
/// A merge in progress is the sync conflict with its files; any other
/// operation is named and left to Git.
pub async fn preflight(cli: &GitCli, repo: &Path) -> Result<Option<SyncResult>, GitError> {
    Ok(
        match super::branch::operation_in_progress(cli, repo).await? {
            None => None,
            Some(GitOperation::Merge) => Some(SyncResult::Conflict {
                files: conflict_files(cli, repo).await?,
            }),
            Some(operation) => Some(SyncResult::OperationInProgress { operation }),
        },
    )
}

async fn sync_without_upstream(
    cli: &GitCli,
    space_dir: &Path,
    target: &str,
) -> Result<SyncResult, GitError> {
    match super::ops::fetch_remote(cli, space_dir).await {
        Ok(false) => return Ok(SyncResult::NoRemote),
        Ok(true) => {}
        Err(GitError::AuthRequired(detail)) => {
            return auth_required(
                cli,
                space_dir,
                GitRemoteOperation::FirstPush,
                Some(detail.as_str()),
            )
            .await;
        }
        Err(GitError::NoRemote) => return Ok(SyncResult::NoRemote),
        Err(err) => return Err(err),
    }

    let branch = super::ops::current_branch(cli, space_dir).await?;
    if branch == "HEAD" || branch.is_empty() {
        return Err(GitError::GitCommandFailed(
            "Cannot sync detached HEAD without an upstream".to_string(),
        ));
    }

    if super::ops::remote_branch_exists(cli, space_dir, &branch).await? {
        let pull_out = cli
            .exec(
                space_dir,
                &[
                    "-c",
                    "submodule.recurse=false",
                    "-c",
                    "rebase.autoStash=false",
                    "-c",
                    "merge.autoStash=false",
                    "pull",
                    "--no-rebase",
                    "--no-recurse-submodules",
                    "origin",
                    &branch,
                ],
            )
            .await?;
        if pull_out.exit_code != 0 {
            return handle_pull_failure(cli, space_dir, &pull_out.stderr, &pull_out.stdout).await;
        }
    }

    validate_transport(cli, space_dir, target).await?;
    let (out, published_head) = super::publication::push_snapshot(cli, space_dir, true).await?;
    if out.exit_code != 0 {
        return remote_error_to_sync_result(
            cli,
            space_dir,
            GitRemoteOperation::FirstPush,
            super::ops::git_remote_command_error("git push", &out.stderr),
        )
        .await;
    }
    Ok(SyncResult::Success {
        published_head: published_head.unwrap_or_default(),
    })
}

pub async fn validate_transport(cli: &GitCli, repo: &Path, expected: &str) -> Result<(), GitError> {
    if super::operations::read_transport(cli, repo).await? != expected {
        return Err(super::operations::target_changed(repo));
    }
    Ok(())
}

async fn upstream_ref(cli: &GitCli, space_dir: &Path) -> Result<Option<String>, GitError> {
    let out = cli
        .exec(
            space_dir,
            &[
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}",
            ],
        )
        .await?;
    if out.exit_code != 0 {
        return Ok(None);
    }
    let upstream = out.stdout.trim().to_string();
    if upstream.is_empty() {
        Ok(None)
    } else {
        Ok(Some(upstream))
    }
}

async fn handle_pull_failure(
    cli: &GitCli,
    space_dir: &Path,
    stderr: &str,
    stdout: &str,
) -> Result<SyncResult, GitError> {
    let stderr = stderr.trim();

    if super::ops::is_git_auth_error(stderr) {
        return auth_required(cli, space_dir, GitRemoteOperation::Sync, Some(stderr)).await;
    }

    if stderr.contains("CONFLICT")
        || stderr.contains("Automatic merge failed")
        || stdout.contains("CONFLICT")
        || stdout.contains("Automatic merge failed")
    {
        let files = conflict_files(cli, space_dir).await?;
        return Ok(SyncResult::Conflict { files });
    }

    if blocked_by_local_files(stderr) {
        // A refused merge leaves FETCH_HEAD at the revision it would have merged.
        match interfering_paths(cli, space_dir, "FETCH_HEAD").await {
            Ok(files) if !files.is_empty() => {
                return Err(GitError::PullBlocked {
                    repository: space_dir.to_string_lossy().into_owned(),
                    files,
                });
            }
            Ok(_) => tracing::warn!("git pull refused without interfering local files"),
            Err(error) => tracing::warn!("interfering local files unavailable: {error}"),
        }
    }

    let error = super::ops::git_remote_command_error("git pull", stderr);
    remote_error_to_sync_result(cli, space_dir, GitRemoteOperation::Sync, error).await
}

async fn remote_error_to_sync_result(
    cli: &GitCli,
    space_dir: &Path,
    operation: GitRemoteOperation,
    error: GitError,
) -> Result<SyncResult, GitError> {
    match error {
        GitError::AuthRequired(detail) => {
            auth_required(cli, space_dir, operation, Some(detail.as_str())).await
        }
        GitError::NoRemote => Ok(SyncResult::NoRemote),
        other => Err(other),
    }
}

async fn auth_required(
    cli: &GitCli,
    space_dir: &Path,
    operation: GitRemoteOperation,
    detail: Option<&str>,
) -> Result<SyncResult, GitError> {
    Ok(SyncResult::AuthRequired {
        challenge: super::auth::build_auth_challenge(cli, space_dir, operation, detail).await,
    })
}

/// Git refused to start the merge because it would overwrite uncommitted or
/// untracked files.
fn blocked_by_local_files(stderr: &str) -> bool {
    [
        "would be overwritten by merge",
        "would be removed by merge",
        "would lose untracked files",
    ]
    .iter()
    .any(|marker| stderr.contains(marker))
}

/// Uncommitted and untracked paths of `repo` that merging `incoming` into
/// HEAD would overwrite: local edits overlapping paths the incoming side
/// changed since the merge base. A merge that is not a fast-forward also
/// requires the index to equal HEAD, so every staged path interferes then.
/// Read-only: neither the index nor the working tree is refreshed.
pub(crate) async fn interfering_paths(
    cli: &GitCli,
    repo: &Path,
    incoming: &str,
) -> Result<Vec<String>, GitError> {
    let head = revision(cli, repo, &["rev-parse", "--verify", "-q", "HEAD"]).await?;
    let (incoming_paths, staged, merge) = match head {
        Some(head) => {
            let base = revision(cli, repo, &["merge-base", "HEAD", incoming]).await?;
            let from = base.as_deref().unwrap_or("HEAD");
            let incoming_paths = path_list(
                cli,
                repo,
                &["diff", "--name-only", "-z", "--no-renames", from, incoming],
            )
            .await?;
            let staged = path_list(
                cli,
                repo,
                &[
                    "diff",
                    "--cached",
                    "--name-only",
                    "-z",
                    "--no-renames",
                    "HEAD",
                ],
            )
            .await?;
            (
                incoming_paths,
                staged,
                base.as_deref() != Some(head.as_str()),
            )
        }
        None => {
            let incoming_paths = path_list(
                cli,
                repo,
                &[
                    "ls-tree",
                    "-r",
                    "-z",
                    "--name-only",
                    "--full-tree",
                    incoming,
                ],
            )
            .await?;
            let staged =
                path_list(cli, repo, &["ls-files", "-z", "--full-name", "--", ":/"]).await?;
            (incoming_paths, staged, false)
        }
    };
    // Git leaves a submodule checkout alone when merging its gitlink.
    let unstaged = path_list(
        cli,
        repo,
        &[
            "diff",
            "--name-only",
            "-z",
            "--no-renames",
            "--ignore-submodules=all",
        ],
    )
    .await?;
    let untracked = path_list(
        cli,
        repo,
        &[
            "ls-files",
            "-z",
            "--others",
            "--exclude-standard",
            "--full-name",
            "--",
            ":/",
        ],
    )
    .await?;
    let mut files: std::collections::BTreeSet<String> = staged
        .iter()
        .chain(&unstaged)
        .chain(&untracked)
        .filter(|path| {
            incoming_paths
                .iter()
                .any(|changed| paths_overlap(path, changed))
        })
        .cloned()
        .collect();
    if merge {
        files.extend(staged);
    }
    Ok(files.into_iter().collect())
}

/// The same path, or one is a directory containing the other.
fn paths_overlap(local: &str, incoming: &str) -> bool {
    let nested = |outer: &str, inner: &str| {
        inner
            .strip_prefix(outer)
            .is_some_and(|rest| rest.starts_with('/'))
    };
    local == incoming || nested(local, incoming) || nested(incoming, local)
}

async fn revision(cli: &GitCli, repo: &Path, args: &[&str]) -> Result<Option<String>, GitError> {
    let out = cli.exec(repo, args).await?;
    let oid = out.stdout.trim();
    Ok((out.exit_code == 0 && !oid.is_empty()).then(|| oid.to_string()))
}

async fn path_list(cli: &GitCli, repo: &Path, args: &[&str]) -> Result<Vec<String>, GitError> {
    let out = cli.exec(repo, args).await?;
    if out.exit_code != 0 {
        return Err(GitError::GitCommandFailed(format!(
            "git {} failed: {}",
            args[0],
            out.stderr.trim()
        )));
    }
    out.stdout
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(|path| {
            // `ls-files --others` names an untracked nested repository as a directory.
            crate::git::path::normalize_repo_relative(
                path.trim_end_matches('/'),
                crate::git::path::RootMode::Reject,
            )
        })
        .collect()
}

/// Get list of conflicted files.
pub async fn conflict_files(cli: &GitCli, space_dir: &Path) -> Result<Vec<String>, GitError> {
    let out = cli
        .exec(space_dir, &["diff", "--name-only", "-z", "--diff-filter=U"])
        .await?;

    out.stdout
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(|path| {
            crate::git::path::normalize_repo_relative(path, crate::git::path::RootMode::Reject)
        })
        .collect()
}

/// Continue a sync merge with the conflicted `paths` (relative to `space_dir`)
/// the user resolved. Only those without Git conflict markers are staged; the
/// merge commit and push run once no file is left in conflict.
pub async fn resolve_and_continue(
    cli: &GitCli,
    space_dir: &Path,
    paths: &[String],
) -> Result<SyncResult, GitError> {
    let target = super::operations::read_transport(cli, space_dir).await?;
    let mut resolved = Vec::new();
    for path in paths {
        let path = normalize_repo_relative(path, RootMode::Reject)?;
        let literal = format!(":(literal){path}");
        let unmerged = cli
            .exec(space_dir, &["ls-files", "--unmerged", "-z", "--", &literal])
            .await?;
        if unmerged.exit_code != 0 {
            return Err(GitError::GitCommandFailed(format!(
                "git ls-files failed: {}",
                unmerged.stderr
            )));
        }
        if unmerged.stdout.is_empty() {
            continue;
        }
        if has_conflict_markers(&space_dir.join(&path))? {
            return Err(GitError::Conflict(format!(
                "Conflict markers remain in {path}"
            )));
        }
        resolved.push(literal);
    }
    if !resolved.is_empty() {
        let mut args = vec!["add", "--"];
        args.extend(resolved.iter().map(String::as_str));
        let add_out = cli.exec(space_dir, &args).await?;
        if add_out.exit_code != 0 {
            return Err(GitError::GitCommandFailed(format!(
                "git add failed: {}",
                add_out.stderr
            )));
        }
    }

    let files = conflict_files(cli, space_dir).await?;
    if !files.is_empty() {
        return Ok(SyncResult::Conflict { files });
    }
    let merge_head = cli
        .exec(space_dir, &["rev-parse", "-q", "--verify", "MERGE_HEAD"])
        .await?;
    if merge_head.exit_code != 0 {
        // Conflicted files without a merge leave ordinary changes for an ordinary save.
        return Ok(SyncResult::Resolved);
    }

    // The index holds the merge result and the resolved paths only.
    let commit_out = cli.exec(space_dir, &["commit", "--no-edit"]).await?;
    if commit_out.exit_code != 0 {
        return Err(GitError::GitCommandFailed(format!(
            "git commit failed: {}",
            commit_out.stderr
        )));
    }

    // Push
    validate_transport(cli, space_dir, &target).await?;
    let (push_out, published_head) =
        super::publication::push_snapshot(cli, space_dir, false).await?;
    if push_out.exit_code != 0 {
        let stderr = push_out.stderr.trim();
        if super::ops::is_git_auth_error(stderr) {
            return auth_required(cli, space_dir, GitRemoteOperation::Sync, Some(stderr)).await;
        }
        return Err(GitError::GitCommandFailed(format!(
            "git push failed: {stderr}"
        )));
    }

    tracing::info!("Resolved conflicts and pushed in {}", space_dir.display());
    Ok(SyncResult::Success {
        published_head: published_head.unwrap_or_default(),
    })
}

/// A line starting with a Git conflict marker; a lone `=======` is valid Markdown.
fn has_conflict_markers(file: &Path) -> Result<bool, GitError> {
    let content = match std::fs::read(file) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    Ok(content.split(|byte| *byte == b'\n').any(|line| {
        [b"<<<<<<< ", b"||||||| ", b">>>>>>> "]
            .iter()
            .any(|marker| line.starts_with(*marker))
    }))
}

/// Abort current merge.
pub async fn merge_abort(cli: &GitCli, space_dir: &Path) -> Result<(), GitError> {
    let out = cli.exec(space_dir, &["merge", "--abort"]).await?;
    if out.exit_code != 0 {
        return Err(GitError::GitCommandFailed(format!(
            "git merge --abort failed: {}",
            out.stderr
        )));
    }
    tracing::info!("Aborted merge in {}", space_dir.display());
    Ok(())
}

#[cfg(test)]
#[path = "pull_block_tests.rs"]
mod pull_block_tests;

#[cfg(test)]
#[path = "sync_preflight_tests.rs"]
mod preflight_tests;

use std::path::Path;

use serde::Serialize;

use super::cli::GitCli;
use crate::AppError;

const GITIGNORE_TEMPLATE: &str = "# CombAI local files
.combai/local.json
.combai/*.db
.combai/*.db-wal
.combai/*.db-shm
";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitStatus {
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub has_staged: bool,
    pub has_unstaged: bool,
    pub has_conflicts: bool,
    pub tracking: Option<String>,
    pub files: Vec<FileGitStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileGitStatus {
    pub path: String,
    /// "modified" | "untracked" | "conflict"
    pub state: String,
}

/// Get configured remote URL (origin).
pub async fn get_remote(cli: &GitCli, workspace_dir: &Path) -> Result<Option<String>, AppError> {
    let out = cli
        .exec(workspace_dir, &["config", "--get", "remote.origin.url"])
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

/// Set or add the `origin` remote URL.
pub async fn set_remote(
    cli: &GitCli,
    workspace_dir: &Path,
    url: &str,
) -> Result<(), AppError> {
    // Check if origin exists
    let exists = cli
        .exec(workspace_dir, &["remote", "get-url", "origin"])
        .await?;
    let args: Vec<&str> = if exists.exit_code == 0 {
        vec!["remote", "set-url", "origin", url]
    } else {
        vec!["remote", "add", "origin", url]
    };
    let out = cli.exec(workspace_dir, &args).await?;
    if out.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "git remote failed: {}",
            out.stderr
        )));
    }
    Ok(())
}

/// Push current branch silently. Used for app-focus auto-push of unpushed commits.
pub async fn push(cli: &GitCli, workspace_dir: &Path) -> Result<(), AppError> {
    let out = cli.exec(workspace_dir, &["push"]).await?;
    if out.exit_code != 0 {
        let stderr = out.stderr.trim();
        if stderr.contains("Authentication")
            || stderr.contains("could not read Username")
            || stderr.contains("terminal prompts disabled")
        {
            return Err(AppError::GitAuthRequired(stderr.to_string()));
        }
        if stderr.contains("No configured push destination")
            || stderr.contains("does not appear to be a git repository")
        {
            return Err(AppError::GitNoRemote);
        }
        return Err(AppError::GitCommandFailed(format!(
            "git push failed: {stderr}"
        )));
    }
    Ok(())
}

/// Initialize a new git repo in workspace_dir.
pub async fn init(cli: &GitCli, workspace_dir: &Path) -> Result<(), AppError> {
    // git init
    let out = cli.exec(workspace_dir, &["init"]).await?;
    if out.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "git init failed: {}",
            out.stderr
        )));
    }

    // config core.quotePath false (for unicode filenames)
    cli.exec(workspace_dir, &["config", "core.quotePath", "false"])
        .await?;

    // write .gitignore
    let gitignore_path = workspace_dir.join(".gitignore");
    if !gitignore_path.exists() {
        tokio::fs::write(&gitignore_path, GITIGNORE_TEMPLATE).await?;
    }

    // git add .
    let out = cli.exec(workspace_dir, &["add", "."]).await?;
    if out.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "git add failed: {}",
            out.stderr
        )));
    }

    // initial commit
    let _ = commit(cli, workspace_dir, "Initialize workspace").await?;

    tracing::info!("Initialized git repo at {}", workspace_dir.display());
    Ok(())
}

/// Get workspace git status by parsing `git status --porcelain=v2 --branch`.
pub async fn status(
    cli: &GitCli,
    workspace_dir: &Path,
) -> Result<WorkspaceGitStatus, AppError> {
    let out = cli
        .exec(workspace_dir, &["status", "--porcelain=v2", "--branch"])
        .await?;

    if out.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "git status failed: {}",
            out.stderr
        )));
    }

    let mut branch = String::from("HEAD");
    let mut ahead: u32 = 0;
    let mut behind: u32 = 0;
    let mut has_staged = false;
    let mut has_unstaged = false;
    let mut has_conflicts = false;
    let mut tracking: Option<String> = None;
    let mut files: Vec<FileGitStatus> = Vec::new();

    for line in out.stdout.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            branch = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("# branch.upstream ") {
            tracking = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            // Format: +N -M
            for part in rest.split_whitespace() {
                if let Some(n) = part.strip_prefix('+') {
                    ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix('-') {
                    behind = n.parse().unwrap_or(0);
                }
            }
        } else if line.starts_with("u ") {
            // Unmerged entry: "u XY sub m1 m2 m3 h1 h2 h3 path"
            has_conflicts = true;
            if let Some(path) = line.split_whitespace().nth(10) {
                files.push(FileGitStatus {
                    path: path.to_string(),
                    state: "conflict".to_string(),
                });
            }
        } else if line.starts_with("1 ") {
            // Changed entry: "1 XY sub mH mI mW hH hI path"
            let parts: Vec<&str> = line.splitn(9, ' ').collect();
            if parts.len() >= 9 {
                let xy = parts[1];
                if xy.len() >= 2 {
                    let x = xy.as_bytes()[0];
                    let y = xy.as_bytes()[1];
                    if x != b'.' {
                        has_staged = true;
                    }
                    if y != b'.' {
                        has_unstaged = true;
                    }
                }
                files.push(FileGitStatus {
                    path: parts[8].to_string(),
                    state: "modified".to_string(),
                });
            }
        } else if line.starts_with("2 ") {
            // Renamed/copied: "2 XY sub mH mI mW hH hI Xscore path\tsource"
            let parts: Vec<&str> = line.splitn(10, ' ').collect();
            if parts.len() >= 10 {
                let xy = parts[1];
                if xy.len() >= 2 {
                    let x = xy.as_bytes()[0];
                    let y = xy.as_bytes()[1];
                    if x != b'.' {
                        has_staged = true;
                    }
                    if y != b'.' {
                        has_unstaged = true;
                    }
                }
                let path_field = parts[9];
                let path = path_field.split('\t').next().unwrap_or(path_field);
                files.push(FileGitStatus {
                    path: path.to_string(),
                    state: "modified".to_string(),
                });
            }
        } else if let Some(rest) = line.strip_prefix("? ") {
            // Untracked file
            has_unstaged = true;
            files.push(FileGitStatus {
                path: rest.to_string(),
                state: "untracked".to_string(),
            });
        }
    }

    Ok(WorkspaceGitStatus {
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

/// Stage a specific file.
pub async fn add(
    cli: &GitCli,
    workspace_dir: &Path,
    path: &str,
) -> Result<(), AppError> {
    let out = cli.exec(workspace_dir, &["add", path]).await?;
    if out.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "git add failed: {}",
            out.stderr
        )));
    }
    Ok(())
}

/// Stage all changes.
pub async fn add_all(
    cli: &GitCli,
    workspace_dir: &Path,
) -> Result<(), AppError> {
    let out = cli.exec(workspace_dir, &["add", "."]).await?;
    if out.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "git add failed: {}",
            out.stderr
        )));
    }
    Ok(())
}

/// Commit with a given message. Returns `Ok(false)` if there was nothing
/// to commit, `Ok(true)` if a commit was created.
pub async fn commit(
    cli: &GitCli,
    workspace_dir: &Path,
    message: &str,
) -> Result<bool, AppError> {
    let out = cli.exec(workspace_dir, &["commit", "-m", message]).await?;
    if out.exit_code != 0 {
        let combined = format!("{}{}", out.stdout, out.stderr);
        if combined.contains("nothing to commit")
            || combined.contains("no changes added to commit")
            || combined.contains("nothing added to commit")
        {
            return Ok(false);
        }
        return Err(AppError::GitCommandFailed(format!(
            "git commit failed: {}",
            out.stderr
        )));
    }
    Ok(true)
}

/// Stage a specific file and auto-commit with a generated message.
/// Returns `true` if a commit was actually created.
pub async fn commit_file(
    cli: &GitCli,
    workspace_dir: &Path,
    file_path: &str,
) -> Result<bool, AppError> {
    add(cli, workspace_dir, file_path).await?;
    let message = generate_commit_message(cli, workspace_dir).await?;
    let created = commit(cli, workspace_dir, &message).await?;
    if created {
        tracing::info!(
            "Auto-committed file {} in {}",
            file_path,
            workspace_dir.display()
        );
    }
    Ok(created)
}

/// Stage all changes and auto-commit with a generated message.
pub async fn commit_all(
    cli: &GitCli,
    workspace_dir: &Path,
) -> Result<bool, AppError> {
    add_all(cli, workspace_dir).await?;
    let message = generate_commit_message(cli, workspace_dir).await?;
    let created = commit(cli, workspace_dir, &message).await?;
    if created {
        tracing::info!("Auto-committed all in {}", workspace_dir.display());
    }
    Ok(created)
}

/// Generate a commit message based on staged changes.
pub async fn generate_commit_message(
    cli: &GitCli,
    workspace_dir: &Path,
) -> Result<String, AppError> {
    let out = cli
        .exec(workspace_dir, &["diff", "--cached", "--stat"])
        .await?;

    if out.stdout.trim().is_empty() {
        return Ok("Update workspace".to_string());
    }

    let mut added: Vec<String> = Vec::new();
    let mut modified: Vec<String> = Vec::new();
    let mut deleted: Vec<String> = Vec::new();

    // Also check diff --cached --name-status for accurate categorization
    let name_status = cli
        .exec(workspace_dir, &["diff", "--cached", "--name-status"])
        .await?;

    for line in name_status.stdout.lines() {
        let parts: Vec<&str> = line.splitn(2, '\t').collect();
        if parts.len() < 2 {
            continue;
        }
        let status = parts[0].trim();
        let file = parts[1]
            .rsplit('/')
            .next()
            .unwrap_or(parts[1])
            .to_string();

        match status.chars().next() {
            Some('A') => added.push(file),
            Some('M') => modified.push(file),
            Some('D') => deleted.push(file),
            Some('R') => modified.push(file),
            _ => modified.push(file),
        }
    }

    let total = added.len() + modified.len() + deleted.len();

    if total == 0 {
        return Ok("Update workspace".to_string());
    }

    if total <= 5 {
        // List individual files
        let mut parts: Vec<String> = Vec::new();
        if !modified.is_empty() {
            parts.push(format!("Update {}", modified.join(", ")));
        }
        if !added.is_empty() {
            parts.push(format!("Add {}", added.join(", ")));
        }
        if !deleted.is_empty() {
            parts.push(format!("Delete {}", deleted.join(", ")));
        }
        Ok(parts.join("; "))
    } else {
        // Summarize counts
        let mut parts: Vec<String> = Vec::new();
        if !modified.is_empty() {
            parts.push(format!(
                "Update {} file{}",
                modified.len(),
                if modified.len() == 1 { "" } else { "s" }
            ));
        }
        if !added.is_empty() {
            parts.push(format!(
                "Add {} file{}",
                added.len(),
                if added.len() == 1 { "" } else { "s" }
            ));
        }
        if !deleted.is_empty() {
            parts.push(format!(
                "Delete {} file{}",
                deleted.len(),
                if deleted.len() == 1 { "" } else { "s" }
            ));
        }
        Ok(parts.join(", "))
    }
}

/// Get list of files changed since last pull.
pub async fn diff_after_pull(
    cli: &GitCli,
    workspace_dir: &Path,
) -> Result<Vec<String>, AppError> {
    let out = cli
        .exec(
            workspace_dir,
            &["diff", "--name-only", "HEAD@{1}", "HEAD"],
        )
        .await?;

    if out.exit_code != 0 {
        // HEAD@{1} may not exist if no reflog yet
        return Ok(Vec::new());
    }

    Ok(out
        .stdout
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect())
}

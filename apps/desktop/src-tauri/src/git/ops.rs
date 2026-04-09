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
    let out = cli
        .exec(
            workspace_dir,
            &["commit", "-m", "Initialize workspace"],
        )
        .await?;
    if out.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "git commit failed: {}",
            out.stderr
        )));
    }

    tracing::info!("Initialized git repo at {}", workspace_dir.display());
    Ok(())
}

/// Clone a remote repository.
pub async fn clone(
    cli: &GitCli,
    url: &str,
    target_dir: &Path,
) -> Result<(), AppError> {
    let target_str = target_dir
        .to_str()
        .ok_or_else(|| AppError::General("Invalid target path".to_string()))?;

    let out = cli.exec_no_dir(&["clone", "--", url, target_str]).await?;
    if out.exit_code != 0 {
        let stderr = out.stderr.trim();
        if stderr.contains("Authentication")
            || stderr.contains("could not read Username")
            || stderr.contains("terminal prompts disabled")
        {
            return Err(AppError::GitAuthRequired(stderr.to_string()));
        }
        return Err(AppError::GitCommandFailed(format!(
            "git clone failed: {stderr}"
        )));
    }

    tracing::info!("Cloned {} to {}", url, target_dir.display());
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
            // Unmerged entry
            has_conflicts = true;
        } else if line.starts_with("1 ") || line.starts_with("2 ") {
            // Changed entry: "1 XY ..." or "2 XY ..."
            // X = index status, Y = worktree status
            let parts: Vec<&str> = line.splitn(3, ' ').collect();
            if parts.len() >= 2 {
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
            }
        } else if line.starts_with("? ") {
            // Untracked file
            has_unstaged = true;
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

/// Commit with a given message.
pub async fn commit(
    cli: &GitCli,
    workspace_dir: &Path,
    message: &str,
) -> Result<(), AppError> {
    let out = cli.exec(workspace_dir, &["commit", "-m", message]).await?;
    if out.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "git commit failed: {}",
            out.stderr
        )));
    }
    Ok(())
}

/// Stage a specific file and auto-commit with a generated message.
pub async fn commit_file(
    cli: &GitCli,
    workspace_dir: &Path,
    file_path: &str,
) -> Result<(), AppError> {
    add(cli, workspace_dir, file_path).await?;
    let message = generate_commit_message(cli, workspace_dir).await?;
    commit(cli, workspace_dir, &message).await?;
    tracing::info!(
        "Auto-committed file {} in {}",
        file_path,
        workspace_dir.display()
    );
    Ok(())
}

/// Stage all changes and auto-commit with a generated message.
pub async fn commit_all(
    cli: &GitCli,
    workspace_dir: &Path,
) -> Result<(), AppError> {
    add_all(cli, workspace_dir).await?;
    let message = generate_commit_message(cli, workspace_dir).await?;
    commit(cli, workspace_dir, &message).await?;
    tracing::info!("Auto-committed all in {}", workspace_dir.display());
    Ok(())
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

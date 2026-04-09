use std::path::Path;

use serde::Serialize;

use super::cli::GitCli;
use crate::AppError;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum SyncResult {
    Success,
    Conflict { files: Vec<String> },
    NoRemote,
    AuthRequired,
}

/// Pull then push. Handle conflicts, no-remote, and auth errors.
pub async fn sync(
    cli: &GitCli,
    workspace_dir: &Path,
) -> Result<SyncResult, AppError> {
    // Check if remote is configured
    let remote_out = cli.exec(workspace_dir, &["remote"]).await?;
    if remote_out.stdout.trim().is_empty() {
        return Ok(SyncResult::NoRemote);
    }

    // Pull
    let pull_out = cli
        .exec(workspace_dir, &["pull", "--no-rebase"])
        .await?;

    if pull_out.exit_code != 0 {
        let stderr = pull_out.stderr.trim();

        // Auth error
        if stderr.contains("Authentication")
            || stderr.contains("could not read Username")
            || stderr.contains("terminal prompts disabled")
        {
            return Ok(SyncResult::AuthRequired);
        }

        // Merge conflict
        if stderr.contains("CONFLICT") || stderr.contains("Automatic merge failed") {
            let files = conflict_files(cli, workspace_dir).await?;
            return Ok(SyncResult::Conflict { files });
        }

        // Check stdout too — git sometimes reports conflicts there
        let stdout = pull_out.stdout.trim();
        if stdout.contains("CONFLICT") || stdout.contains("Automatic merge failed") {
            let files = conflict_files(cli, workspace_dir).await?;
            return Ok(SyncResult::Conflict { files });
        }

        return Err(AppError::GitCommandFailed(format!(
            "git pull failed: {stderr}"
        )));
    }

    // Push
    let push_out = cli.exec(workspace_dir, &["push"]).await?;
    if push_out.exit_code != 0 {
        let stderr = push_out.stderr.trim();

        if stderr.contains("Authentication")
            || stderr.contains("could not read Username")
            || stderr.contains("terminal prompts disabled")
        {
            return Ok(SyncResult::AuthRequired);
        }

        return Err(AppError::GitCommandFailed(format!(
            "git push failed: {stderr}"
        )));
    }

    tracing::info!("Synced workspace {}", workspace_dir.display());
    Ok(SyncResult::Success)
}

/// Get list of conflicted files.
pub async fn conflict_files(
    cli: &GitCli,
    workspace_dir: &Path,
) -> Result<Vec<String>, AppError> {
    let out = cli
        .exec(
            workspace_dir,
            &["diff", "--name-only", "--diff-filter=U"],
        )
        .await?;

    Ok(out
        .stdout
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect())
}

/// Resolve conflicts: stage all and commit, then push.
pub async fn resolve_and_continue(
    cli: &GitCli,
    workspace_dir: &Path,
) -> Result<SyncResult, AppError> {
    // Stage all resolved files
    let add_out = cli.exec(workspace_dir, &["add", "."]).await?;
    if add_out.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "git add failed: {}",
            add_out.stderr
        )));
    }

    // Commit the merge
    let commit_out = cli
        .exec(workspace_dir, &["commit", "--no-edit"])
        .await?;
    if commit_out.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "git commit failed: {}",
            commit_out.stderr
        )));
    }

    // Push
    let push_out = cli.exec(workspace_dir, &["push"]).await?;
    if push_out.exit_code != 0 {
        let stderr = push_out.stderr.trim();
        if stderr.contains("Authentication")
            || stderr.contains("could not read Username")
            || stderr.contains("terminal prompts disabled")
        {
            return Ok(SyncResult::AuthRequired);
        }
        return Err(AppError::GitCommandFailed(format!(
            "git push failed: {stderr}"
        )));
    }

    tracing::info!(
        "Resolved conflicts and pushed in {}",
        workspace_dir.display()
    );
    Ok(SyncResult::Success)
}

/// Abort current merge.
pub async fn merge_abort(
    cli: &GitCli,
    workspace_dir: &Path,
) -> Result<(), AppError> {
    let out = cli
        .exec(workspace_dir, &["merge", "--abort"])
        .await?;
    if out.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "git merge --abort failed: {}",
            out.stderr
        )));
    }
    tracing::info!("Aborted merge in {}", workspace_dir.display());
    Ok(())
}

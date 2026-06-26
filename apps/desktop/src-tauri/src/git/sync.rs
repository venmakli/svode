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
pub async fn sync(cli: &GitCli, space_dir: &Path) -> Result<SyncResult, AppError> {
    // Check if remote is configured
    let remote_out = cli.exec(space_dir, &["remote"]).await?;
    if remote_out.stdout.trim().is_empty() {
        return Ok(SyncResult::NoRemote);
    }

    if upstream_ref(cli, space_dir).await?.is_none() {
        return sync_without_upstream(cli, space_dir).await;
    }

    // Pull
    let pull_out = cli.exec(space_dir, &["pull", "--no-rebase"]).await?;

    if pull_out.exit_code != 0 {
        return handle_pull_failure(cli, space_dir, &pull_out.stderr, &pull_out.stdout).await;
    }

    // Push
    let push_out = cli.exec(space_dir, &["push"]).await?;
    if push_out.exit_code != 0 {
        let stderr = push_out.stderr.trim();

        if super::ops::is_git_auth_error(stderr) {
            return Ok(SyncResult::AuthRequired);
        }

        return remote_error_to_sync_result(super::ops::git_remote_command_error(
            "git push", stderr,
        ));
    }

    tracing::info!("Synced space {}", space_dir.display());
    Ok(SyncResult::Success)
}

async fn sync_without_upstream(cli: &GitCli, space_dir: &Path) -> Result<SyncResult, AppError> {
    match super::ops::fetch_remote(cli, space_dir).await {
        Ok(false) => return Ok(SyncResult::NoRemote),
        Ok(true) => {}
        Err(AppError::GitAuthRequired(_)) => return Ok(SyncResult::AuthRequired),
        Err(AppError::GitNoRemote) => return Ok(SyncResult::NoRemote),
        Err(err) => return Err(err),
    }

    let branch = super::ops::current_branch(cli, space_dir).await?;
    if branch == "HEAD" || branch.is_empty() {
        return Err(AppError::GitCommandFailed(
            "Cannot sync detached HEAD without an upstream".to_string(),
        ));
    }

    if super::ops::remote_branch_exists(cli, space_dir, &branch).await? {
        let pull_out = cli
            .exec(space_dir, &["pull", "--no-rebase", "origin", &branch])
            .await?;
        if pull_out.exit_code != 0 {
            return handle_pull_failure(cli, space_dir, &pull_out.stderr, &pull_out.stdout).await;
        }
    }

    match super::ops::push_set_upstream(cli, space_dir).await {
        Ok(()) => {
            tracing::info!("Synced space {}", space_dir.display());
            Ok(SyncResult::Success)
        }
        Err(AppError::GitAuthRequired(_)) => Ok(SyncResult::AuthRequired),
        Err(AppError::GitNoRemote) => Ok(SyncResult::NoRemote),
        Err(err) => Err(err),
    }
}

async fn upstream_ref(cli: &GitCli, space_dir: &Path) -> Result<Option<String>, AppError> {
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
) -> Result<SyncResult, AppError> {
    let stderr = stderr.trim();

    if super::ops::is_git_auth_error(stderr) {
        return Ok(SyncResult::AuthRequired);
    }

    if stderr.contains("CONFLICT")
        || stderr.contains("Automatic merge failed")
        || stdout.contains("CONFLICT")
        || stdout.contains("Automatic merge failed")
    {
        let files = conflict_files(cli, space_dir).await?;
        return Ok(SyncResult::Conflict { files });
    }

    remote_error_to_sync_result(super::ops::git_remote_command_error("git pull", stderr))
}

fn remote_error_to_sync_result(error: AppError) -> Result<SyncResult, AppError> {
    match error {
        AppError::GitAuthRequired(_) => Ok(SyncResult::AuthRequired),
        AppError::GitNoRemote => Ok(SyncResult::NoRemote),
        other => Err(other),
    }
}

/// Get list of conflicted files.
pub async fn conflict_files(cli: &GitCli, space_dir: &Path) -> Result<Vec<String>, AppError> {
    let out = cli
        .exec(space_dir, &["diff", "--name-only", "-z", "--diff-filter=U"])
        .await?;

    out.stdout
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(|path| {
            crate::repo_path::normalize_repo_relative(path, crate::repo_path::RootMode::Reject)
        })
        .collect()
}

/// Resolve conflicts: stage all and commit, then push.
pub async fn resolve_and_continue(cli: &GitCli, space_dir: &Path) -> Result<SyncResult, AppError> {
    // Stage all resolved files
    let add_out = cli.exec(space_dir, &["add", "."]).await?;
    if add_out.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "git add failed: {}",
            add_out.stderr
        )));
    }

    // Commit the merge
    let commit_out = cli.exec(space_dir, &["commit", "--no-edit"]).await?;
    if commit_out.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "git commit failed: {}",
            commit_out.stderr
        )));
    }

    // Push
    let push_out = cli.exec(space_dir, &["push"]).await?;
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

    tracing::info!("Resolved conflicts and pushed in {}", space_dir.display());
    Ok(SyncResult::Success)
}

/// Abort current merge.
pub async fn merge_abort(cli: &GitCli, space_dir: &Path) -> Result<(), AppError> {
    let out = cli.exec(space_dir, &["merge", "--abort"]).await?;
    if out.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "git merge --abort failed: {}",
            out.stderr
        )));
    }
    tracing::info!("Aborted merge in {}", space_dir.display());
    Ok(())
}

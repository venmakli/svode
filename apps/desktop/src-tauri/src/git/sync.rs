use std::path::Path;

use serde::Serialize;

use super::auth::{GitAuthChallenge, GitRemoteOperation};
use super::cli::GitCli;
use crate::AppError;

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
}

#[cfg(test)]
pub(crate) async fn sync_if_enabled(
    cli: &GitCli,
    repo: &Path,
    requested: bool,
) -> Result<Option<SyncResult>, AppError> {
    if !requested || !crate::space::config::effective_git_user_policy(repo).auto_sync {
        return Ok(None);
    }
    sync(cli, repo).await.map(Some)
}

/// Pull then push. Handle conflicts, no-remote, and auth errors.
pub async fn sync(cli: &GitCli, space_dir: &Path) -> Result<SyncResult, AppError> {
    super::branch::prepare_existing(cli, space_dir).await?;
    super::branch::ensure_no_operation(cli, space_dir).await?;
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

async fn sync_without_upstream(
    cli: &GitCli,
    space_dir: &Path,
    target: &str,
) -> Result<SyncResult, AppError> {
    match super::ops::fetch_remote(cli, space_dir).await {
        Ok(false) => return Ok(SyncResult::NoRemote),
        Ok(true) => {}
        Err(AppError::GitAuthRequired(detail)) => {
            return auth_required(
                cli,
                space_dir,
                GitRemoteOperation::FirstPush,
                Some(detail.as_str()),
            )
            .await;
        }
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

pub(crate) async fn validate_transport(
    cli: &GitCli,
    repo: &Path,
    expected: &str,
) -> Result<(), AppError> {
    if super::operations::read_transport(cli, repo).await? != expected {
        return Err(super::operations::target_changed(repo));
    }
    Ok(())
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

    let error = super::ops::git_remote_command_error("git pull", stderr);
    remote_error_to_sync_result(cli, space_dir, GitRemoteOperation::Sync, error).await
}

async fn remote_error_to_sync_result(
    cli: &GitCli,
    space_dir: &Path,
    operation: GitRemoteOperation,
    error: AppError,
) -> Result<SyncResult, AppError> {
    match error {
        AppError::GitAuthRequired(detail) => {
            auth_required(cli, space_dir, operation, Some(detail.as_str())).await
        }
        AppError::GitNoRemote => Ok(SyncResult::NoRemote),
        other => Err(other),
    }
}

async fn auth_required(
    cli: &GitCli,
    space_dir: &Path,
    operation: GitRemoteOperation,
    detail: Option<&str>,
) -> Result<SyncResult, AppError> {
    Ok(SyncResult::AuthRequired {
        challenge: super::auth::build_auth_challenge(cli, space_dir, operation, detail).await,
    })
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
    let target = super::operations::read_transport(cli, space_dir).await?;
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
    validate_transport(cli, space_dir, &target).await?;
    let (push_out, published_head) =
        super::publication::push_snapshot(cli, space_dir, false).await?;
    if push_out.exit_code != 0 {
        let stderr = push_out.stderr.trim();
        if super::ops::is_git_auth_error(stderr) {
            return auth_required(cli, space_dir, GitRemoteOperation::Sync, Some(stderr)).await;
        }
        return Err(AppError::GitCommandFailed(format!(
            "git push failed: {stderr}"
        )));
    }

    tracing::info!("Resolved conflicts and pushed in {}", space_dir.display());
    Ok(SyncResult::Success {
        published_head: published_head.unwrap_or_default(),
    })
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

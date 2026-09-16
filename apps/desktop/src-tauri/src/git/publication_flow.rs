use super::{
    access, branch,
    commands::{self, GitState},
    ops,
    sync::SyncResult,
};
use crate::AppError;
use serde::Serialize;
use std::path::Path;
use tauri::{AppHandle, Manager};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    #[serde(flatten)]
    child: SyncResult,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent: Option<ParentPublication>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParentPublication {
    repository: String,
    pointer: PointerState,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<SyncResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<AppError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    policy_skipped: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum PointerState {
    Pending,
    Local,
    Published,
}

/// Lock order is child then root, matching clone, manual save and Actors.
/// Root-only operations never acquire child locks or initiate child writes.
pub(crate) async fn sync(
    app: &AppHandle,
    repo: &Path,
    background: bool,
    resolve: bool,
) -> Result<SyncReport, AppError> {
    let state = app.state::<GitState>();
    let cli = commands::require_cli(&state)?;
    let repository = access::resolve_repository(&cli, repo).await?;
    let repo = repository.as_path();
    let lock = state.get_lock(repo).await;
    let _guard = lock.lock().await;
    if background && !crate::space::config::effective_git_user_policy(repo).auto_sync {
        return Ok(SyncReport {
            child: SyncResult::NoRemote,
            parent: None,
        });
    }
    let child = run_repository(app, &cli, repo, resolve, background).await?;
    if !matches!(child, SyncResult::Success { .. }) {
        return Ok(SyncReport {
            child,
            parent: None,
        });
    }
    // These effects belong to child success even if the parent later fails.
    commands::refresh_synced_repository(app, &cli, repo).await;
    let parent = match branch::parent(&cli, repo).await {
        Ok(Some(root)) => root,
        Ok(None) => {
            return Ok(SyncReport {
                child,
                parent: None,
            });
        }
        Err(error) => {
            return Ok(SyncReport {
                child,
                parent: Some(ParentPublication {
                    repository: repo.parent().unwrap_or(repo).to_string_lossy().into_owned(),
                    pointer: PointerState::Pending,
                    result: None,
                    error: Some(error),
                    policy_skipped: None,
                }),
            });
        }
    };
    let mut outcome = ParentPublication {
        repository: parent.to_string_lossy().into_owned(),
        pointer: PointerState::Pending,
        result: None,
        error: None,
        policy_skipped: None,
    };
    let expected = match &child {
        SyncResult::Success { published_head } => published_head.clone(),
        _ => unreachable!(),
    };
    let parent_lock = state.get_lock(&parent).await;
    let _parent_guard = parent_lock.lock().await;
    if let Ok(path) =
        crate::repo_path::repo_relative_from_base(&parent, repo, crate::repo_path::RootMode::Reject)
    {
        if let Ok(pointer) = cli
            .exec(&parent, &["rev-parse", &format!("HEAD:{path}")])
            .await
        {
            if pointer.exit_code == 0 && pointer.stdout.trim() == expected {
                outcome.pointer = PointerState::Local;
            }
        }
    }
    let policy = crate::space::config::effective_git_user_policy(&parent);
    if background && !policy.auto_sync {
        outcome.policy_skipped = Some(true);
        return Ok(SyncReport {
            child,
            parent: Some(outcome),
        });
    }
    let result = async {
        access::require_repository_mutation(app, &parent).await?;
        if ops::repository_head_oid(&cli, repo).await? != expected {
            return Err(AppError::GitPublicationBlocked {
                repository: parent.to_string_lossy().into_owned(),
                child: Some(repo.to_string_lossy().into_owned()),
                reason: super::publication::PublicationBlockReason::TargetChanged,
            });
        }
        if !background || policy.auto_commit_structural {
            super::published_pointer::commit(&cli, &parent, repo, &expected).await?;
        }
        // A pre-existing local pointer is allowed even when structural auto-commit is off.
        let path = crate::repo_path::repo_relative_from_base(
            &parent,
            repo,
            crate::repo_path::RootMode::Reject,
        )?;
        let pointer = cli
            .exec(&parent, &["rev-parse", &format!("HEAD:{path}")])
            .await?;
        if pointer.exit_code == 0 && pointer.stdout.trim() == expected {
            outcome.pointer = PointerState::Local;
        }
        let root_result = run_repository(app, &cli, &parent, false, background).await?;
        if let SyncResult::Success { published_head } = &root_result {
            commands::refresh_synced_repository(app, &cli, &parent).await;
            let pointer = cli
                .exec(&parent, &["rev-parse", &format!("{published_head}:{path}")])
                .await?;
            outcome.pointer = if pointer.exit_code == 0 && pointer.stdout.trim() == expected {
                PointerState::Published
            } else {
                PointerState::Pending
            };
        }
        outcome.result = Some(root_result);
        Ok::<_, AppError>(())
    }
    .await;
    if let Err(error) = result {
        outcome.error = Some(error);
    }
    Ok(SyncReport {
        child,
        parent: Some(outcome),
    })
}

async fn run_repository(
    app: &AppHandle,
    cli: &super::cli::GitCli,
    repo: &Path,
    resolve: bool,
    background: bool,
) -> Result<SyncResult, AppError> {
    let result = if resolve {
        super::sync::resolve_and_continue(cli, repo).await
    } else if background {
        super::sync::sync_if_enabled(cli, repo, true)
            .await
            .map(|result| result.unwrap_or(SyncResult::NoRemote))
    } else {
        super::sync::sync(cli, repo).await
    };
    let invalidate = match &result {
        Ok(SyncResult::AuthRequired { .. }) => true,
        Err(AppError::GitBranchBlocked { .. } | AppError::GitPublicationBlocked { .. }) => false,
        Err(_) => true,
        _ => false,
    };
    if invalidate {
        commands::invalidate_repository_access(
            app,
            &app.state::<access::RepositoryAccessState>(),
            cli,
            repo,
        )
        .await;
    }
    result
}

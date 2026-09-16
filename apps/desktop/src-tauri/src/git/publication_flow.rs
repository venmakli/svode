use super::{
    access, branch,
    commands::{self, GitState},
    ops,
    sync::SyncResult,
};
use crate::AppError;
use serde::Serialize;
use std::path::Path;
use tauri::{AppHandle, Emitter, Manager};

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
    pub(crate) repository: String,
    pub(crate) pointer: PointerState,
    target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<SyncResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<AppError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    policy_skipped: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PointerState {
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
    if background {
        access::require_repository_mutation(app, repo).await?;
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
                    target: String::new(),
                    result: None,
                    error: Some(error),
                    policy_skipped: None,
                }),
            });
        }
    };
    let expected = match &child {
        SyncResult::Success { published_head } => published_head.clone(),
        _ => unreachable!(),
    };
    let outcome = parent_step(app, &cli, repo, &parent, &expected, background, true).await;
    let report = SyncReport {
        child,
        parent: Some(outcome),
    };
    let _ = app.emit(
        "git:publication",
        PublicationEvent {
            space_path: repo.to_string_lossy().into_owned(),
            child_head: expected,
            child: "published",
            parent: report.parent.as_ref(),
        },
    );
    Ok(report)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicationEvent<'a> {
    space_path: String,
    child_head: String,
    child: &'static str,
    parent: Option<&'a ParentPublication>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveReport {
    #[serde(flatten)]
    pub(crate) status: ops::GitStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) parent: Option<ParentPublication>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationStatus {
    child_head: String,
    child: &'static str,
    parent: ParentPublication,
}

pub(crate) async fn parent_step(
    app: &AppHandle,
    cli: &super::cli::GitCli,
    repo: &Path,
    parent: &Path,
    expected: &str,
    background: bool,
    publish: bool,
) -> ParentPublication {
    let state = app.state::<GitState>();
    let parent_lock = state.get_lock(parent).await;
    let _parent_guard = parent_lock.lock().await;
    let permission = access::require_repository_mutation(app, parent)
        .await
        .map(|_| ());
    let outcome =
        parent_step_locked(cli, repo, parent, expected, background, publish, permission).await;
    if matches!(outcome.result, Some(SyncResult::Success { .. })) {
        commands::refresh_synced_repository(app, cli, parent).await;
    } else if matches!(outcome.result, Some(SyncResult::AuthRequired { .. }))
        || outcome.error.as_ref().is_some_and(|error| {
            !matches!(
                error,
                AppError::RepositoryAccessDenied { .. }
                    | AppError::GitBranchBlocked { .. }
                    | AppError::GitPublicationBlocked { .. }
            )
        })
    {
        commands::invalidate_repository_access(
            app,
            &app.state::<access::RepositoryAccessState>(),
            cli,
            parent,
        )
        .await;
    }
    outcome
}

pub(crate) async fn parent_step_locked(
    cli: &super::cli::GitCli,
    repo: &Path,
    parent: &Path,
    expected: &str,
    background: bool,
    publish: bool,
    permission: Result<(), AppError>,
) -> ParentPublication {
    let target = publication_target(cli, repo, parent).await;
    let mut outcome = ParentPublication {
        repository: parent.to_string_lossy().into_owned(),
        pointer: PointerState::Pending,
        target: target.as_ref().cloned().unwrap_or_default(),
        result: None,
        error: None,
        policy_skipped: None,
    };
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
        return outcome;
    }
    let result = async {
        permission?;
        target?;
        if ops::current_branch(cli, parent).await? == "HEAD" {
            return Err(AppError::GitBranchBlocked {
                reason: super::branch::BranchBlockReason::RootDetached,
            });
        }
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
        if !publish {
            return Ok(());
        }
        let root_result = super::sync::sync(cli, parent).await?;
        if let SyncResult::Success { published_head } = &root_result {
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
    outcome
}

pub(crate) async fn inspect(
    app: &AppHandle,
    repo: &Path,
) -> Result<Option<PublicationStatus>, AppError> {
    let state = app.state::<GitState>();
    let cli = commands::require_cli(&state)?;
    let repo = access::resolve_repository(&cli, repo).await?;
    let lock = state.get_lock(&repo).await;
    let _guard = lock.lock().await;
    let Some(parent) = branch::parent(&cli, &repo).await? else {
        return Ok(None);
    };
    let parent_lock = state.get_lock(&parent).await;
    let _parent_guard = parent_lock.lock().await;
    inspect_locked(app, &cli, &repo, &parent).await.map(Some)
}

async fn inspect_locked(
    app: &AppHandle,
    cli: &super::cli::GitCli,
    repo: &Path,
    parent: &Path,
) -> Result<PublicationStatus, AppError> {
    let head = ops::repository_head_oid(cli, repo).await?;
    let child = if super::publication::head_is_published(cli, repo, &head)
        .await
        .unwrap_or(false)
    {
        "published"
    } else {
        "unpublished"
    };
    let path = crate::repo_path::repo_relative_from_base(
        parent,
        repo,
        crate::repo_path::RootMode::Reject,
    )?;
    let root_head = ops::repository_head_oid(cli, parent).await?;
    let pointer = cli
        .exec(parent, &["rev-parse", &format!("{root_head}:{path}")])
        .await?;
    let matches = pointer.exit_code == 0 && pointer.stdout.trim() == head;
    let permission = access::require_repository_mutation(app, parent).await;
    let published = matches
        && permission.is_ok()
        && super::publication::head_is_published(cli, parent, &root_head)
            .await
            .unwrap_or(false);
    Ok(PublicationStatus {
        child_head: head,
        child,
        parent: ParentPublication {
            repository: parent.to_string_lossy().into_owned(),
            target: publication_target(cli, repo, parent).await?,
            pointer: if published {
                PointerState::Published
            } else if matches {
                PointerState::Local
            } else {
                PointerState::Pending
            },
            result: if cli
                .exec(parent, &["rev-parse", "--verify", "MERGE_HEAD"])
                .await?
                .exit_code
                == 0
            {
                Some(SyncResult::Conflict {
                    files: super::sync::conflict_files(cli, parent).await?,
                })
            } else {
                None
            },
            error: permission.err(),
            policy_skipped: None,
        },
    })
}

pub(crate) async fn retry_parent(
    app: &AppHandle,
    repo: &Path,
    expected: &str,
    expected_parent: &Path,
    expected_target: &str,
) -> Result<PublicationStatus, AppError> {
    let state = app.state::<GitState>();
    let cli = commands::require_cli(&state)?;
    let repo = access::resolve_repository(&cli, repo).await?;
    let lock = state.get_lock(&repo).await;
    let _guard = lock.lock().await;
    validate_parent_target(&cli, &repo, expected, expected_parent, expected_target).await?;
    if !super::publication::head_is_published(&cli, &repo, expected).await? {
        return Err(AppError::GitPublicationBlocked {
            repository: expected_parent.to_string_lossy().into_owned(),
            child: Some(repo.to_string_lossy().into_owned()),
            reason: super::publication::PublicationBlockReason::RevisionUnavailable,
        });
    }
    let outcome = parent_step(app, &cli, &repo, expected_parent, expected, false, true).await;
    Ok(PublicationStatus {
        child_head: expected.into(),
        child: "published",
        parent: outcome,
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

pub(crate) async fn publication_target(
    cli: &super::cli::GitCli,
    repo: &Path,
    parent: &Path,
) -> Result<String, AppError> {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    for path in [repo, parent] {
        let config = cli
            .exec(
                path,
                &[
                    "config",
                    "--null",
                    "--get-regexp",
                    "^(remote\\.|branch\\.|push\\.)",
                ],
            )
            .await?;
        if config.exit_code > 1 {
            return Err(AppError::GitCommandFailed(
                "Cannot inspect publication target".into(),
            ));
        }
        hash.update(config.stdout.as_bytes());
        hash.update([0]);
    }
    hash.update(std::fs::read(parent.join(".gitmodules"))?);
    Ok(format!("{:x}", hash.finalize()))
}

pub(crate) async fn validate_parent_target(
    cli: &super::cli::GitCli,
    repo: &Path,
    expected: &str,
    expected_parent: &Path,
    expected_target: &str,
) -> Result<(), AppError> {
    let parent = branch::parent(&cli, &repo).await?;
    let canonical_parent = std::fs::canonicalize(expected_parent)?;
    if parent.as_deref() != Some(canonical_parent.as_path())
        || ops::repository_head_oid(&cli, &repo).await? != expected
    {
        return Err(AppError::GitPublicationBlocked {
            repository: repo.to_string_lossy().into_owned(),
            child: None,
            reason: super::publication::PublicationBlockReason::TargetChanged,
        });
    }
    if publication_target(&cli, &repo, expected_parent).await? != expected_target {
        return Err(AppError::GitPublicationBlocked {
            repository: expected_parent.to_string_lossy().into_owned(),
            child: None,
            reason: super::publication::PublicationBlockReason::TargetChanged,
        });
    }
    Ok(())
}

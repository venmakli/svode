use super::operations::{
    Completion, Intent, Output, ParentEvidence, Request, SharedError, Snapshot,
};
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    #[serde(flatten)]
    pub(crate) child: SyncResult,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) parent: Option<ParentPublication>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParentPublication {
    pub(crate) repository: String,
    pub(crate) pointer: PointerState,
    target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) result: Option<SyncResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<SharedError>,
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
) -> Result<SyncReport, SharedError> {
    let intent = if resolve {
        Intent::Resolve
    } else {
        Intent::Sync { background }
    };
    match request(app, repo, intent).await? {
        Output::Sync(report) => Ok(report),
        _ => unreachable!("sync request returned a different intent"),
    }
}

pub(crate) async fn request(
    app: &AppHandle,
    repo: &Path,
    intent: Intent,
) -> Result<Output, SharedError> {
    let state = app.state::<GitState>();
    let cli = commands::require_cli(&state)?;
    let owned_app = app.clone();
    state
        .operations
        .run(cli, repo, intent, move |request| async move {
            execute(&owned_app, request).await
        })
        .await
}

pub(crate) async fn push(
    app: &AppHandle,
    path: &Path,
    publish: bool,
) -> Result<ops::GitStatus, SharedError> {
    let intent = if publish {
        Intent::Publish
    } else {
        Intent::Push
    };
    let Output::Status(status) = request(app, path, intent).await? else {
        unreachable!("push result")
    };
    let state = app.state::<GitState>();
    let cli = commands::require_cli(&state)?;
    let repository = access::resolve_repository(&cli, path).await?;
    if std::fs::canonicalize(path).map_err(AppError::from)? == repository {
        return Ok(status);
    }
    // The publication is repository-scoped; each inline caller keeps its
    // original display/status scope. This read never starts another publisher.
    let lock = state.get_lock(&repository).await;
    let _guard = lock.lock().await;
    ops::status(&cli, path).await.map_err(Into::into)
}

async fn execute(app: &AppHandle, request: Request) -> Completion {
    let state = app.state::<GitState>();
    let repo = request.repo.as_path();
    let lock = state.get_lock(repo).await;
    let _guard = lock.lock().await;
    let mut before = request.snapshot.clone();
    let mut after = before.clone();
    let mut parent_evidence = None;
    let result = async {
        let cli = commands::require_cli(&state)?;
        before = Snapshot::read(&cli, repo).await?;
        if before.target != request.snapshot.target {
            return Err(super::operations::target_changed(repo));
        }
        let result = match &request.intent {
            Intent::Sync { background } => sync_locked(
                app,
                &cli,
                repo,
                *background,
                false,
                &request,
                &mut parent_evidence,
            )
            .await
            .map(Output::Sync),
            Intent::Resolve => {
                sync_locked(app, &cli, repo, false, true, &request, &mut parent_evidence)
                    .await
                    .map(Output::Sync)
            }
            Intent::Push | Intent::Publish => {
                direct_push_locked(app, &cli, repo, request.intent == Intent::Publish)
                    .await
                    .map(Output::Status)
            }
            Intent::RetryParent {
                head,
                parent,
                target,
            } => retry_parent_locked(app, &cli, repo, head, parent, target, &mut parent_evidence)
                .await
                .map(Output::Parent),
        };
        after = Snapshot::read(&cli, repo)
            .await
            .unwrap_or_else(|_| before.clone());
        result
    }
    .await;
    Completion {
        result: result.map_err(Into::into),
        before,
        after,
        parent: parent_evidence,
    }
}

async fn direct_push_locked(
    app: &AppHandle,
    cli: &super::cli::GitCli,
    repo: &Path,
    publish: bool,
) -> Result<ops::GitStatus, AppError> {
    let result = if publish {
        ops::push_set_upstream(cli, repo).await
    } else {
        ops::push(cli, repo).await
    };
    if let Err(error) = result {
        if !matches!(
            error,
            AppError::GitPublicationBlocked { .. } | AppError::GitBranchBlocked { .. }
        ) {
            commands::invalidate_repository_access(
                app,
                &app.state::<access::RepositoryAccessState>(),
                cli,
                repo,
            )
            .await;
        }
        return Err(error);
    }
    let access_state = app.state::<access::RepositoryAccessState>();
    let store_path = access::access_store_path(app)?;
    match access_state
        .record_writable_evidence(cli, repo, &store_path)
        .await
    {
        Ok(snapshot) => access::emit_repository_access_changed(app, &snapshot.repository_id),
        Err(error) => {
            tracing::warn!("failed to record repository write evidence after push: {error}")
        }
    }
    ops::status(cli, repo).await
}

async fn sync_locked(
    app: &AppHandle,
    cli: &super::cli::GitCli,
    repo: &Path,
    background: bool,
    resolve: bool,
    request: &Request,
    parent_evidence: &mut Option<ParentEvidence>,
) -> Result<SyncReport, AppError> {
    if !request.intent.admitted(repo) {
        return Ok(SyncReport {
            child: SyncResult::NoRemote,
            parent: None,
        });
    }
    if background {
        access::require_repository_mutation(app, repo).await?;
    }
    let child = run_repository(app, &cli, repo, resolve).await?;
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
                    error: Some(error.into()),
                    policy_skipped: None,
                }),
            });
        }
    };
    let expected = match &child {
        SyncResult::Success { published_head } => published_head.clone(),
        _ => unreachable!(),
    };
    let expected_target = request
        .parent
        .as_ref()
        .filter(|(path, _)| path == &parent)
        .and_then(|(_, snapshot)| snapshot.as_ref());
    let (outcome, evidence) = if expected_target.is_some() {
        parent_step_recorded(
            app,
            cli,
            repo,
            &parent,
            &expected,
            background,
            true,
            expected_target,
            None,
        )
        .await
    } else {
        (
            ParentPublication {
                repository: parent.to_string_lossy().into_owned(),
                pointer: PointerState::Pending,
                target: String::new(),
                result: None,
                error: Some(super::operations::target_changed(&parent).into()),
                policy_skipped: None,
            },
            None,
        )
    };
    *parent_evidence = evidence;
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

#[derive(Debug, Clone, Serialize)]
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
    parent_step_recorded(
        app, cli, repo, parent, expected, background, publish, None, None,
    )
    .await
    .0
}

async fn parent_step_recorded(
    app: &AppHandle,
    cli: &super::cli::GitCli,
    repo: &Path,
    parent: &Path,
    expected: &str,
    background: bool,
    publish: bool,
    expected_target: Option<&Snapshot>,
    retry_target: Option<&str>,
) -> (ParentPublication, Option<ParentEvidence>) {
    let state = app.state::<GitState>();
    let parent_lock = state.get_lock(parent).await;
    let _parent_guard = parent_lock.lock().await;
    let before = Snapshot::read(cli, parent).await;
    let mut permission = match &before {
        Ok(before) if expected_target.is_none_or(|expected| before.target == expected.target) => {
            access::require_repository_mutation(app, parent)
                .await
                .map(|_| ())
        }
        _ => Err(super::operations::target_changed(parent)),
    };
    if let Some(target) = retry_target {
        if let Err(error) = validate_parent_target(cli, repo, expected, parent, target).await {
            permission = Err(error);
        }
    }
    let outcome =
        parent_step_locked(cli, repo, parent, expected, background, publish, permission).await;
    if matches!(outcome.result, Some(SyncResult::Success { .. })) {
        commands::refresh_synced_repository(app, cli, parent).await;
    } else if matches!(outcome.result, Some(SyncResult::AuthRequired { .. }))
        || outcome.error.as_ref().is_some_and(|error| {
            !matches!(
                &**error,
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
    let evidence = match (&outcome.result, before) {
        (Some(result @ SyncResult::Success { .. }), Ok(before)) => Snapshot::read(cli, parent)
            .await
            .ok()
            .map(|after| ParentEvidence {
                repo: parent.to_path_buf(),
                before,
                after,
                result: result.clone(),
                background,
            }),
        _ => None,
    };
    (outcome, evidence)
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
    let transport = Snapshot::read(cli, parent)
        .await
        .map(|snapshot| snapshot.transport);
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
    if background && publish && !policy.auto_sync {
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
        super::sync::validate_transport(cli, parent, &transport?).await?;
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
        outcome.error = Some(error.into());
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
            error: permission.err().map(Into::into),
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
) -> Result<PublicationStatus, SharedError> {
    match request(
        app,
        repo,
        Intent::RetryParent {
            head: expected.into(),
            parent: expected_parent.into(),
            target: expected_target.into(),
        },
    )
    .await?
    {
        Output::Parent(report) => Ok(report),
        _ => unreachable!("parent retry returned a different intent"),
    }
}

async fn retry_parent_locked(
    app: &AppHandle,
    cli: &super::cli::GitCli,
    repo: &Path,
    expected: &str,
    expected_parent: &Path,
    expected_target: &str,
    parent_evidence: &mut Option<ParentEvidence>,
) -> Result<PublicationStatus, AppError> {
    validate_parent_target(&cli, &repo, expected, expected_parent, expected_target).await?;
    if !super::publication::head_is_published(&cli, &repo, expected).await? {
        return Err(AppError::GitPublicationBlocked {
            repository: expected_parent.to_string_lossy().into_owned(),
            child: Some(repo.to_string_lossy().into_owned()),
            reason: super::publication::PublicationBlockReason::RevisionUnavailable,
        });
    }
    let (outcome, evidence) = parent_step_recorded(
        app,
        &cli,
        &repo,
        expected_parent,
        expected,
        false,
        true,
        None,
        Some(expected_target),
    )
    .await;
    *parent_evidence = evidence;
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
) -> Result<SyncResult, AppError> {
    let result = if resolve {
        super::sync::resolve_and_continue(cli, repo).await
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

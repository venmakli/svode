use super::GitError;
use super::cli::GitCli;
use super::host::GitHost;
use super::operations::{
    Completion, Intent, Output, ParentEvidence, Request, SharedError, Snapshot,
};
use super::state::GitRuntime;
use super::{access, branch, ops, sync::SyncResult};
use serde::Serialize;
use std::path::Path;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    #[serde(flatten)]
    pub(crate) child: SyncResult,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) parent: Option<ParentPublication>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) remote_status: Option<ops::GitStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParentPublication {
    pub(crate) repository: String,
    pub(crate) pointer: PointerState,
    pub(crate) target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) result: Option<SyncResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<SharedError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) policy_skipped: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PointerState {
    Pending,
    Local,
    Published,
}

/// Lock order is child then root, matching clone, manual save and Actors.
/// Root-only operations never acquire child locks or initiate child writes.
pub async fn sync(
    runtime: &Arc<GitRuntime>,
    host: &Arc<dyn GitHost>,
    repo: &Path,
    background: bool,
    resolve: bool,
) -> Result<SyncReport, SharedError> {
    let intent = if resolve {
        Intent::Resolve
    } else {
        Intent::Sync { background }
    };
    match request(runtime, host, repo, intent).await? {
        Output::Sync(mut report) => {
            if report.remote_status.is_some() {
                let cli = runtime.require_cli()?;
                let repository = access::resolve_repository(&cli, repo).await?;
                if std::fs::canonicalize(repo).map_err(GitError::from)? != repository {
                    let lock = runtime.get_lock(&repository).await;
                    let _guard = lock.lock().await;
                    report.remote_status = ops::status_with_remote_counts(&cli, repo)
                        .await
                        .ok()
                        .map(|mut status| {
                            status.repository = Some(repository.to_string_lossy().into_owned());
                            status
                        });
                }
            }
            Ok(report)
        }
        _ => unreachable!("sync request returned a different intent"),
    }
}

pub(crate) async fn request(
    runtime: &Arc<GitRuntime>,
    host: &Arc<dyn GitHost>,
    repo: &Path,
    intent: Intent,
) -> Result<Output, SharedError> {
    let cli = runtime.require_cli()?;
    let owned_runtime = runtime.clone();
    let owned_host = host.clone();
    runtime
        .operations()
        .run(cli, repo, intent, move |request| async move {
            execute(&owned_runtime, owned_host.as_ref(), request).await
        })
        .await
}

pub async fn push(
    runtime: &Arc<GitRuntime>,
    host: &Arc<dyn GitHost>,
    path: &Path,
    publish: bool,
) -> Result<ops::GitStatus, SharedError> {
    let intent = if publish {
        Intent::Publish
    } else {
        Intent::Push
    };
    let Output::Status(mut status) = request(runtime, host, path, intent).await? else {
        unreachable!("push result")
    };
    let cli = runtime.require_cli()?;
    let repository = access::resolve_repository(&cli, path).await?;
    status.repository = Some(repository.to_string_lossy().into_owned());
    if std::fs::canonicalize(path).map_err(GitError::from)? == repository {
        return Ok(status);
    }
    // The publication is repository-scoped; each inline caller keeps its
    // original display/status scope. This read never starts another publisher.
    let lock = runtime.get_lock(&repository).await;
    let _guard = lock.lock().await;
    let mut status = ops::status(&cli, path).await?;
    status.repository = Some(repository.to_string_lossy().into_owned());
    Ok(status)
}

async fn execute(runtime: &GitRuntime, host: &dyn GitHost, request: Request) -> Completion {
    let repo = request.repo.as_path();
    if !request.intent.reader() {
        host.publish_sync_state(repo, true, None, None);
    }
    let lock = runtime.get_lock(repo).await;
    let _guard = lock.lock().await;
    let mut before = request.snapshot.clone();
    let mut after = before.clone();
    let mut parent_evidence = request
        .previous
        .as_ref()
        .and_then(|done| done.parent.clone());
    let mut read_sync = None;
    let result = async {
        let cli = runtime.require_cli()?;
        before = Snapshot::read(&cli, repo).await?;
        if before.target != request.snapshot.target {
            return Err(super::operations::target_changed(repo));
        }
        if request.intent.reader() {
            read_sync = super::readers::covered_sync(request.previous.as_ref(), &before).cloned();
        }
        let mut result = match &request.intent {
            Intent::Sync { background } => sync_locked(
                runtime,
                host,
                &cli,
                repo,
                *background,
                false,
                &request,
                &mut parent_evidence,
            )
            .await
            .map(Output::Sync),
            Intent::Resolve => sync_locked(
                runtime,
                host,
                &cli,
                repo,
                false,
                true,
                &request,
                &mut parent_evidence,
            )
            .await
            .map(Output::Sync),
            Intent::Push | Intent::Publish => {
                direct_push_locked(host, &cli, repo, request.intent == Intent::Publish)
                    .await
                    .map(Output::Status)
            }
            Intent::RetryParent {
                head,
                parent,
                target,
            } => retry_parent_locked(
                runtime,
                host,
                &cli,
                repo,
                head,
                parent,
                target,
                &mut parent_evidence,
            )
            .await
            .map(Output::Parent),
            Intent::FetchStatus => {
                match super::readers::fetch_status(&cli, repo, request.previous.as_ref(), &before)
                    .await
                {
                    Ok((status, fetched)) => {
                        if fetched {
                            host.invalidate_actor_space(repo).await;
                        }
                        Ok(Output::Status(status))
                    }
                    Err(error) => {
                        host.invalidate_repository_access(&cli, repo).await;
                        Err(error)
                    }
                }
            }
            Intent::InspectPublication => inspect_reader(
                runtime,
                host,
                &cli,
                repo,
                request.previous.as_ref(),
                &before,
            )
            .await
            .map(Output::Inspection),
        };
        after = Snapshot::read(&cli, repo)
            .await
            .unwrap_or_else(|_| before.clone());
        if request.intent.reader() {
            if after != before || result.is_err() {
                read_sync = None;
            }
            if after.target != before.target
                || after.head != before.head
                || (request.intent == Intent::InspectPublication && after != before)
            {
                return Err(super::operations::target_changed(repo));
            }
        }
        if let Ok(Output::Sync(report)) = &mut result {
            if let SyncResult::Success { published_head } = &report.child {
                if !after.publication_covers(&before, published_head) {
                    report.remote_status = None;
                }
            }
        }
        result
    }
    .await;
    let result = result.map_err(SharedError::from);
    if !request.intent.reader() {
        host.publish_sync_state(
            repo,
            false,
            match &result {
                Ok(Output::Sync(report)) => Some(report),
                _ => None,
            },
            result.as_ref().err(),
        );
    }
    Completion {
        result,
        before,
        after,
        parent: parent_evidence,
        read_sync,
    }
}

async fn direct_push_locked(
    host: &dyn GitHost,
    cli: &GitCli,
    repo: &Path,
    publish: bool,
) -> Result<ops::GitStatus, GitError> {
    let result = if publish {
        ops::push_set_upstream(cli, repo).await
    } else {
        ops::push(cli, repo).await
    };
    if let Err(error) = result {
        if !matches!(
            error,
            GitError::PublicationBlocked { .. } | GitError::BranchBlocked { .. }
        ) {
            host.invalidate_repository_access(cli, repo).await;
        }
        return Err(error);
    }
    host.record_write_evidence(cli, repo).await;
    ops::status(cli, repo).await
}

#[allow(clippy::too_many_arguments)]
async fn sync_locked(
    runtime: &GitRuntime,
    host: &dyn GitHost,
    cli: &GitCli,
    repo: &Path,
    background: bool,
    resolve: bool,
    request: &Request,
    parent_evidence: &mut Option<ParentEvidence>,
) -> Result<SyncReport, GitError> {
    if !request.intent.admitted(repo) {
        return Ok(SyncReport {
            child: SyncResult::NoRemote,
            remote_status: None,
            parent: None,
        });
    }
    if background {
        host.authorize_repository(repo).await?;
    }
    let child = run_repository(host, cli, repo, resolve).await?;
    if !matches!(child, SyncResult::Success { .. }) {
        return Ok(SyncReport {
            child,
            remote_status: None,
            parent: None,
        });
    }
    let remote_status = super::readers::sync_status(cli, repo, &child).await;
    // These effects belong to child success even if the parent later fails.
    host.refresh_synced_repository(cli, repo).await;
    let parent = match branch::parent(cli, repo).await {
        Ok(Some(root)) => root,
        Ok(None) => {
            return Ok(SyncReport {
                child,
                remote_status,
                parent: None,
            });
        }
        Err(error) => {
            return Ok(SyncReport {
                child,
                remote_status,
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
            runtime,
            host,
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
        remote_status,
        parent: Some(outcome),
    };
    host.publish_publication(repo, &expected, report.parent.as_ref());
    Ok(report)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveReport {
    #[serde(flatten)]
    pub status: ops::GitStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<ParentPublication>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationStatus {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) inspection_error: Option<SharedError>,
    pub(crate) child_head: String,
    pub(crate) child: &'static str,
    pub(crate) parent: ParentPublication,
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn parent_step(
    runtime: &GitRuntime,
    host: &dyn GitHost,
    cli: &GitCli,
    repo: &Path,
    parent: &Path,
    expected: &str,
    background: bool,
    publish: bool,
) -> ParentPublication {
    parent_step_recorded(
        runtime, host, cli, repo, parent, expected, background, publish, None, None,
    )
    .await
    .0
}

#[allow(clippy::too_many_arguments)]
async fn parent_step_recorded(
    runtime: &GitRuntime,
    host: &dyn GitHost,
    cli: &GitCli,
    repo: &Path,
    parent: &Path,
    expected: &str,
    background: bool,
    publish: bool,
    expected_target: Option<&Snapshot>,
    retry_target: Option<&str>,
) -> (ParentPublication, Option<ParentEvidence>) {
    let parent_lock = runtime.get_lock(parent).await;
    let _parent_guard = parent_lock.lock().await;
    if publish {
        host.publish_sync_state(parent, true, None, None);
    }
    let before = Snapshot::read(cli, parent).await;
    let mut permission = match &before {
        Ok(before) if expected_target.is_none_or(|expected| before.target == expected.target) => {
            host.authorize_repository(parent).await
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
        host.refresh_synced_repository(cli, parent).await;
    } else if matches!(outcome.result, Some(SyncResult::AuthRequired { .. }))
        || outcome.error.as_ref().is_some_and(|error| {
            !matches!(
                &**error,
                GitError::RepositoryAccessDenied { .. }
                    | GitError::BranchBlocked { .. }
                    | GitError::PublicationBlocked { .. }
            )
        })
    {
        host.invalidate_repository_access(cli, parent).await;
    }
    let remote_status = match &outcome.result {
        Some(result) => super::readers::sync_status(cli, parent, result).await,
        None => None,
    };
    let evidence = match (&outcome.result, before) {
        (Some(result @ SyncResult::Success { published_head }), Ok(before)) => {
            Snapshot::read(cli, parent)
                .await
                .ok()
                .map(|after| ParentEvidence {
                    remote_status: if after.publication_covers(&before, published_head) {
                        remote_status
                    } else {
                        None
                    },
                    repo: parent.to_path_buf(),
                    before,
                    after,
                    result: result.clone(),
                    background,
                })
        }
        _ => None,
    };
    if publish {
        let report = outcome.result.as_ref().map(|result| SyncReport {
            child: result.clone(),
            parent: None,
            remote_status: evidence.as_ref().and_then(|e| e.remote_status.clone()),
        });
        host.publish_sync_state(parent, false, report.as_ref(), outcome.error.as_ref());
    }
    (outcome, evidence)
}

#[allow(clippy::too_many_arguments)]
pub async fn parent_step_locked(
    cli: &GitCli,
    repo: &Path,
    parent: &Path,
    expected: &str,
    background: bool,
    publish: bool,
    permission: Result<(), GitError>,
) -> ParentPublication {
    let target = publication_target(cli, repo, parent).await;
    let transport = super::operations::read_transport(cli, parent).await;
    let mut outcome = ParentPublication {
        repository: parent.to_string_lossy().into_owned(),
        pointer: PointerState::Pending,
        target: target.as_ref().cloned().unwrap_or_default(),
        result: None,
        error: None,
        policy_skipped: None,
    };
    if let Ok(path) =
        crate::git::path::repo_relative_from_base(&parent, repo, crate::git::path::RootMode::Reject)
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
    let policy = super::policy::effective_user_policy(parent);
    if background && publish && !policy.auto_sync {
        outcome.policy_skipped = Some(true);
        return outcome;
    }
    let result = async {
        permission?;
        target?;
        if ops::current_branch(cli, parent).await? == "HEAD" {
            return Err(GitError::BranchBlocked {
                reason: super::branch::BranchBlockReason::RootDetached,
            });
        }
        if ops::repository_head_oid(&cli, repo).await? != expected {
            return Err(GitError::PublicationBlocked {
                repository: parent.to_string_lossy().into_owned(),
                child: Some(repo.to_string_lossy().into_owned()),
                reason: super::publication::PublicationBlockReason::TargetChanged,
            });
        }
        if !background || policy.auto_commit_structural {
            super::published_pointer::commit(&cli, &parent, repo, &expected).await?;
        }
        // A pre-existing local pointer is allowed even when structural auto-commit is off.
        let path = crate::git::path::repo_relative_from_base(
            &parent,
            repo,
            crate::git::path::RootMode::Reject,
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
        Ok::<_, GitError>(())
    }
    .await;
    if let Err(error) = result {
        outcome.error = Some(error.into());
    }
    outcome
}

pub async fn fetch_status(
    runtime: &Arc<GitRuntime>,
    host: &Arc<dyn GitHost>,
    path: &Path,
) -> Result<ops::GitStatus, SharedError> {
    let Output::Status(mut status) = request(runtime, host, path, Intent::FetchStatus).await?
    else {
        unreachable!("status reader result")
    };
    let cli = runtime.require_cli()?;
    let repository = access::resolve_repository(&cli, path).await?;
    status.repository = Some(repository.to_string_lossy().into_owned());
    if std::fs::canonicalize(path).map_err(GitError::from)? == repository {
        return Ok(status);
    }
    let lock = runtime.get_lock(&repository).await;
    let _guard = lock.lock().await;
    let mut status = ops::status_with_remote_counts(&cli, path).await?;
    status.repository = Some(repository.to_string_lossy().into_owned());
    Ok(status)
}

pub async fn inspect(
    runtime: &Arc<GitRuntime>,
    host: &Arc<dyn GitHost>,
    repo: &Path,
) -> Result<Option<PublicationStatus>, SharedError> {
    let Output::Inspection(read) = request(runtime, host, repo, Intent::InspectPublication).await?
    else {
        unreachable!("publication reader result")
    };
    Ok(read.status)
}

async fn inspect_reader(
    runtime: &GitRuntime,
    host: &dyn GitHost,
    cli: &GitCli,
    repo: &Path,
    previous: Option<&Completion>,
    current: &Snapshot,
) -> Result<super::readers::PublicationRead, GitError> {
    let Some(parent) = branch::parent(cli, repo).await? else {
        return Ok(super::readers::PublicationRead {
            status: None,
            parent: None,
        });
    };
    let lock = runtime.get_lock(&parent).await;
    let _guard = lock.lock().await;
    let permission = host.authorize_repository(&parent).await;
    super::readers::inspect(cli, repo, &parent, previous, current, permission).await
}

pub async fn retry_parent(
    runtime: &Arc<GitRuntime>,
    host: &Arc<dyn GitHost>,
    repo: &Path,
    expected: &str,
    expected_parent: &Path,
    expected_target: &str,
) -> Result<PublicationStatus, SharedError> {
    match request(
        runtime,
        host,
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

#[allow(clippy::too_many_arguments)]
async fn retry_parent_locked(
    runtime: &GitRuntime,
    host: &dyn GitHost,
    cli: &GitCli,
    repo: &Path,
    expected: &str,
    expected_parent: &Path,
    expected_target: &str,
    parent_evidence: &mut Option<ParentEvidence>,
) -> Result<PublicationStatus, GitError> {
    validate_parent_target(cli, repo, expected, expected_parent, expected_target).await?;
    if !super::publication::head_is_published(cli, repo, expected).await? {
        return Err(GitError::PublicationBlocked {
            repository: expected_parent.to_string_lossy().into_owned(),
            child: Some(repo.to_string_lossy().into_owned()),
            reason: super::publication::PublicationBlockReason::RevisionUnavailable,
        });
    }
    let (outcome, evidence) = parent_step_recorded(
        runtime,
        host,
        cli,
        repo,
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
        inspection_error: None,
        child_head: expected.into(),
        child: "published",
        parent: outcome,
    })
}

async fn run_repository(
    host: &dyn GitHost,
    cli: &GitCli,
    repo: &Path,
    resolve: bool,
) -> Result<SyncResult, GitError> {
    let result = if resolve {
        super::sync::resolve_and_continue(cli, repo).await
    } else {
        super::sync::sync(cli, repo).await
    };
    let invalidate = match &result {
        Ok(SyncResult::AuthRequired { .. }) => true,
        Err(GitError::BranchBlocked { .. } | GitError::PublicationBlocked { .. }) => false,
        Err(_) => true,
        _ => false,
    };
    if invalidate {
        host.invalidate_repository_access(cli, repo).await;
    }
    result
}

pub async fn publication_target(
    cli: &GitCli,
    repo: &Path,
    parent: &Path,
) -> Result<String, GitError> {
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
            return Err(GitError::GitCommandFailed(
                "Cannot inspect publication target".into(),
            ));
        }
        hash.update(config.stdout.as_bytes());
        hash.update([0]);
    }
    hash.update(std::fs::read(parent.join(".gitmodules"))?);
    Ok(format!("{:x}", hash.finalize()))
}

pub async fn validate_parent_target(
    cli: &GitCli,
    repo: &Path,
    expected: &str,
    expected_parent: &Path,
    expected_target: &str,
) -> Result<(), GitError> {
    let parent = branch::parent(cli, repo).await?;
    let canonical_parent = std::fs::canonicalize(expected_parent)?;
    if parent.as_deref() != Some(canonical_parent.as_path())
        || ops::repository_head_oid(cli, repo).await? != expected
    {
        return Err(GitError::PublicationBlocked {
            repository: repo.to_string_lossy().into_owned(),
            child: None,
            reason: super::publication::PublicationBlockReason::TargetChanged,
        });
    }
    if publication_target(cli, repo, expected_parent).await? != expected_target {
        return Err(GitError::PublicationBlocked {
            repository: expected_parent.to_string_lossy().into_owned(),
            child: None,
            reason: super::publication::PublicationBlockReason::TargetChanged,
        });
    }
    Ok(())
}

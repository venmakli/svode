//! Desktop side of the Git save/sync services: repository authorization,
//! prepared notifications and the runtime effects that follow a landed commit
//! or a successful sync. Planning, locking, staging and publication stay in
//! `svode_core::git`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::GitState;
use super::access::{self, RepositoryAccessState};
use super::cli::GitCli;
use svode_core::git::GitError;
use svode_core::git::flow::{ParentPublication, SyncReport};
use svode_core::git::host::{GitHost, HostFuture};
use svode_core::git::operations::SharedError;

const EVENT_COMMITTED: &str = "git:committed";
const EVENT_SYNC_STATE: &str = "git:sync-state";
const EVENT_PUBLICATION: &str = "git:publication";

/// Tauri-managed handle to the one Git host of this process.
pub struct GitHostState(Arc<dyn GitHost>);

impl GitHostState {
    pub fn new(app: AppHandle) -> Self {
        Self(Arc::new(DesktopGitHost { app }))
    }

    pub(crate) fn handle(&self) -> &Arc<dyn GitHost> {
        &self.0
    }
}

pub(crate) fn host(app: &AppHandle) -> Arc<dyn GitHost> {
    app.state::<GitHostState>().0.clone()
}

pub(crate) fn runtime(app: &AppHandle) -> Arc<svode_core::git::state::GitRuntime> {
    app.state::<GitState>().runtime().clone()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CommittedPayload {
    space_path: String,
    repo_path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncStateEvent<'a> {
    repository: String,
    active: bool,
    report: Option<&'a SyncReport>,
    error: Option<&'a SharedError>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicationEvent<'a> {
    space_path: String,
    child_head: &'a str,
    child: &'static str,
    parent: Option<&'a ParentPublication>,
}

struct DesktopGitHost {
    app: AppHandle,
}

impl DesktopGitHost {
    async fn authorize(&self, repository: &Path) -> Result<(), GitError> {
        let git_state = self.app.state::<GitState>();
        let cli = git_state.runtime().require_cli()?;
        let store = store_path(&self.app)?;
        self.app
            .state::<RepositoryAccessState>()
            .core()
            .require_mutation(&cli, repository, &store)
            .await
            .map(|_| ())
    }
}

fn store_path(app: &AppHandle) -> Result<PathBuf, GitError> {
    access::access_store_path(app).map_err(|error| GitError::General(error.to_string()))
}

impl GitHost for DesktopGitHost {
    fn authorize_repository<'a>(
        &'a self,
        repository: &'a Path,
    ) -> HostFuture<'a, Result<(), GitError>> {
        Box::pin(self.authorize(repository))
    }

    fn authorize_paths<'a>(&'a self, paths: Vec<PathBuf>) -> HostFuture<'a, Result<(), GitError>> {
        Box::pin(async move {
            let mut repositories = std::collections::HashSet::new();
            for path in paths {
                let repository = svode_core::git::access::local_repository_root(&path)?;
                if repositories.insert(repository.clone()) {
                    self.authorize(&repository).await?;
                }
            }
            Ok(())
        })
    }

    fn invalidate_repository_access<'a>(
        &'a self,
        cli: &'a GitCli,
        repository: &'a Path,
    ) -> HostFuture<'a, ()> {
        Box::pin(async move {
            match self
                .app
                .state::<RepositoryAccessState>()
                .core()
                .invalidate(cli, repository)
                .await
            {
                Ok(repository_id) => {
                    access::emit_repository_access_changed(&self.app, &repository_id);
                }
                Err(error) => tracing::warn!(
                    repository = %repository.display(),
                    "failed to invalidate repository access: {error}"
                ),
            }
        })
    }

    fn record_write_evidence<'a>(
        &'a self,
        cli: &'a GitCli,
        repository: &'a Path,
    ) -> HostFuture<'a, ()> {
        Box::pin(async move {
            let evidence = async {
                let store = store_path(&self.app)?;
                self.app
                    .state::<RepositoryAccessState>()
                    .core()
                    .record_writable_evidence(cli, repository, &store)
                    .await
            }
            .await;
            match evidence {
                Ok(snapshot) => {
                    access::emit_repository_access_changed(&self.app, &snapshot.repository_id)
                }
                Err(error) => {
                    tracing::warn!("failed to record repository write evidence: {error}")
                }
            }
        })
    }

    fn refresh_synced_repository<'a>(
        &'a self,
        cli: &'a GitCli,
        repository: &'a Path,
    ) -> HostFuture<'a, ()> {
        Box::pin(super::commands::refresh_synced_repository(
            &self.app, cli, repository,
        ))
    }

    fn invalidate_actor_space<'a>(&'a self, space: &'a Path) -> HostFuture<'a, ()> {
        Box::pin(super::commands::invalidate_actor_space(&self.app, space))
    }

    fn publish_commit(&self, space: &Path, repository: &Path) {
        if let Err(error) = crate::actors::invalidate_repository(&self.app, repository) {
            tracing::warn!(
                repository = %repository.display(),
                "failed to invalidate actor catalog after commit: {error}"
            );
        }
        let payload = CommittedPayload {
            space_path: space.to_string_lossy().into_owned(),
            repo_path: repository.to_string_lossy().into_owned(),
        };
        if let Err(error) = self.app.emit(EVENT_COMMITTED, payload) {
            tracing::warn!("failed to emit {EVENT_COMMITTED}: {error}");
        }
    }

    fn schedule_auto_sync(&self, repository: &Path) {
        let app = self.app.clone();
        let repository = repository.to_path_buf();
        tauri::async_runtime::spawn(async move {
            let runtime = runtime(&app);
            let host = host(&app);
            if let Err(error) =
                svode_core::git::flow::sync(&runtime, &host, &repository, true, false).await
            {
                tracing::warn!(kind = error.kind(), "auto-sync after commit failed");
            }
        });
    }

    fn publish_sync_state(
        &self,
        repository: &Path,
        active: bool,
        report: Option<&SyncReport>,
        error: Option<&SharedError>,
    ) {
        let _ = self.app.emit(
            EVENT_SYNC_STATE,
            SyncStateEvent {
                repository: repository.to_string_lossy().into_owned(),
                active,
                report,
                error,
            },
        );
    }

    fn publish_publication(
        &self,
        repository: &Path,
        child_head: &str,
        parent: Option<&ParentPublication>,
    ) {
        let _ = self.app.emit(
            EVENT_PUBLICATION,
            PublicationEvent {
                space_path: repository.to_string_lossy().into_owned(),
                child_head,
                child: "published",
                parent,
            },
        );
    }
}

/// Deliver a landed exact-path commit and start the sync its policy allows.
pub(crate) fn publish_commit(app: &AppHandle, space: &Path, repo: &Path) {
    let host = host(app);
    host.publish_commit(space, repo);
    svode_core::git::autocommit::schedule_auto_sync(host.as_ref(), repo);
}

/// Test seam over the same order: deliver the commit, then admit the sync.
#[cfg(test)]
pub(crate) fn dispatch_commit(
    space: &Path,
    repo: &Path,
    emit: impl FnOnce(&Path, &Path),
    sync: impl FnOnce(&Path),
) {
    emit(space, repo);
    if svode_core::git::policy::effective_user_policy(repo).auto_sync {
        sync(repo);
    }
}

/// Host composition for the shared local ignore repair: resolve the runtime
/// and the host of this process, then run the core policy rollout.
pub(crate) async fn repair_scope_best_effort(app: &AppHandle, project: &Path, space: &Path) {
    svode_core::git::local_repair::repair_scope_best_effort(
        &runtime(app),
        host(app).as_ref(),
        project,
        space,
    )
    .await;
}

pub(crate) async fn require_scope_repair(
    app: &AppHandle,
    project: &Path,
    space: &Path,
) -> Result<(), crate::AppError> {
    Ok(svode_core::git::local_repair::require_scope_repair(
        &runtime(app),
        host(app).as_ref(),
        project,
        space,
    )
    .await?)
}

pub(crate) async fn repair_scope(
    app: &AppHandle,
    project: &Path,
    space: &Path,
) -> Result<svode_core::git::local_repair::RepairOutcome, crate::AppError> {
    Ok(svode_core::git::local_repair::repair_scope(
        &runtime(app),
        host(app).as_ref(),
        project,
        space,
    )
    .await?)
}

pub(crate) async fn repair_project(app: &AppHandle, root: &Path) {
    svode_core::git::local_repair::repair_project(&runtime(app), host(app).as_ref(), root).await;
}

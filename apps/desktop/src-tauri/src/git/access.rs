use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::{GitState, require_cli};
use crate::AppError;
use svode_core::git::access::RepositoryAccessBlocker;
use svode_core::git::access::RepositoryAccessObserver;
use svode_core::git::cli::GitCli;

pub use svode_core::git::access::{
    RepositoryAccessSnapshot, RepositoryAccessStatus, RoutineClaimResult,
};

const REPOSITORY_ACCESS_CHANGED_EVENT: &str = "git:repository-access-changed";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryAccessChangedPayload<'a> {
    repository_id: &'a str,
}

pub struct RepositoryAccessState(svode_core::git::access::RepositoryAccessState);

/// Delivers changes that passive reads and gates of this process pick up,
/// such as evidence saved by `svode git access verify`, to the windows.
struct DesktopAccessObserver {
    app: AppHandle,
}

impl RepositoryAccessObserver for DesktopAccessObserver {
    fn publication_changed(&self, repository_id: &str) {
        emit_repository_access_changed(&self.app, repository_id);
    }
}

impl RepositoryAccessState {
    pub fn new(app: AppHandle) -> Self {
        Self(
            svode_core::git::access::RepositoryAccessState::with_observer(Arc::new(
                DesktopAccessObserver { app },
            )),
        )
    }

    pub(crate) fn core(&self) -> &svode_core::git::access::RepositoryAccessState {
        &self.0
    }

    pub async fn snapshot(
        &self,
        cli: &GitCli,
        space: &Path,
        store: &Path,
    ) -> Result<RepositoryAccessSnapshot, AppError> {
        Ok(self.0.snapshot(cli, space, store).await?)
    }

    pub async fn verify_requested(
        &self,
        cli: &GitCli,
        space: &Path,
        store: &Path,
        automatic: bool,
        on_checking: impl Fn(&str),
    ) -> Result<RepositoryAccessSnapshot, AppError> {
        Ok(self
            .0
            .verify_requested(cli, space, store, automatic, on_checking)
            .await?)
    }

    pub async fn require_mutation(
        &self,
        cli: &GitCli,
        space: &Path,
        store: &Path,
    ) -> Result<RepositoryAccessSnapshot, AppError> {
        match self.0.require_mutation(cli, space, store).await {
            Err(svode_core::git::GitError::RepositoryAccessDenied {
                repository_id,
                status,
                reason,
            }) => Err(AppError::RepositoryAccessDenied {
                blockers: vec![RepositoryAccessBlocker {
                    repository_id: repository_id.clone(),
                    repository_path: repository_location(space),
                    status: status.clone(),
                    reason: reason.clone(),
                }],
                repository_id,
                status,
                reason,
            }),
            result => Ok(result?),
        }
    }

    pub async fn claim_routine(
        &self,
        cli: &GitCli,
        repository: &Path,
        store: &Path,
        snapshot: &RepositoryAccessSnapshot,
        routine_id: &str,
        run_key: &str,
        definition_hash: &str,
        claimed_at: i64,
    ) -> Result<RoutineClaimResult, AppError> {
        Ok(self
            .0
            .claim_routine(
                cli,
                repository,
                store,
                snapshot,
                routine_id,
                run_key,
                definition_hash,
                claimed_at,
            )
            .await?)
    }

    pub async fn routine_repository_id(
        &self,
        cli: &GitCli,
        repository: &Path,
        snapshot: &RepositoryAccessSnapshot,
    ) -> Result<Option<String>, AppError> {
        Ok(self
            .0
            .routine_repository_id(cli, repository, snapshot)
            .await?)
    }

    pub async fn record_writable_evidence(
        &self,
        cli: &GitCli,
        space: &Path,
        store: &Path,
    ) -> Result<RepositoryAccessSnapshot, AppError> {
        Ok(self.0.record_writable_evidence(cli, space, store).await?)
    }
}

#[tauri::command]
pub async fn repository_access_get(
    app: AppHandle,
    space_path: String,
    git_state: State<'_, GitState>,
    access_state: State<'_, RepositoryAccessState>,
) -> Result<RepositoryAccessSnapshot, AppError> {
    let cli = require_cli(&git_state)?;
    let store_path = access_store_path(&app)?;
    access_state
        .snapshot(&cli, Path::new(&space_path), &store_path)
        .await
}

#[tauri::command]
pub async fn repository_access_verify(
    app: AppHandle,
    space_path: String,
    git_state: State<'_, GitState>,
    access_state: State<'_, RepositoryAccessState>,
) -> Result<RepositoryAccessSnapshot, AppError> {
    run_verification_command(app, space_path, git_state, access_state, false).await
}

#[tauri::command]
pub async fn repository_access_activate(
    app: AppHandle,
    space_path: String,
    git_state: State<'_, GitState>,
    access_state: State<'_, RepositoryAccessState>,
) -> Result<RepositoryAccessSnapshot, AppError> {
    run_verification_command(app, space_path, git_state, access_state, true).await
}

async fn run_verification_command(
    app: AppHandle,
    space_path: String,
    git_state: State<'_, GitState>,
    access_state: State<'_, RepositoryAccessState>,
    automatic: bool,
) -> Result<RepositoryAccessSnapshot, AppError> {
    let cli = require_cli(&git_state)?;
    let store_path = access_store_path(&app)?;
    let snapshot = match access_state
        .verify_requested(&cli, Path::new(&space_path), &store_path, automatic, |id| {
            emit_repository_access_changed(&app, id);
        })
        .await
    {
        Ok(snapshot) => snapshot,
        Err(error) => {
            if let Ok(snapshot) = access_state
                .snapshot(&cli, Path::new(&space_path), &store_path)
                .await
            {
                emit_repository_access_changed(&app, &snapshot.repository_id);
            }
            return Err(error);
        }
    };
    emit_repository_access_changed(&app, &snapshot.repository_id);
    if !automatic
        && matches!(
            snapshot.status,
            RepositoryAccessStatus::Local | RepositoryAccessStatus::Writable
        )
    {
        if let Err(error) = crate::actors::invalidate_space(&app, Path::new(&space_path)).await {
            tracing::warn!(
                space = %space_path,
                "failed to invalidate actor catalog after repository access recovery: {error}"
            );
        }
    }
    Ok(snapshot)
}

pub(crate) fn emit_repository_access_changed(app: &AppHandle, repository_id: &str) {
    if let Err(error) = app.emit(
        REPOSITORY_ACCESS_CHANGED_EVENT,
        RepositoryAccessChangedPayload { repository_id },
    ) {
        tracing::warn!(
            repository_id,
            "failed to emit repository access invalidation: {error}"
        );
    }
}

pub async fn require_repository_mutation(
    app: &AppHandle,
    space_path: &Path,
) -> Result<RepositoryAccessSnapshot, AppError> {
    let git_state = app.state::<GitState>();
    let cli = require_cli(&git_state)?;
    let access_state = app.state::<RepositoryAccessState>();
    let store_path = access_store_path(app)?;
    access_state
        .require_mutation(&cli, space_path, &store_path)
        .await
}

pub async fn repository_access_snapshot(
    app: &AppHandle,
    space_path: &Path,
) -> Result<RepositoryAccessSnapshot, AppError> {
    let git_state = app.state::<GitState>();
    let cli = require_cli(&git_state)?;
    let access_state = app.state::<RepositoryAccessState>();
    let store_path = access_store_path(app)?;
    access_state.snapshot(&cli, space_path, &store_path).await
}

pub async fn require_repository_mutation_paths(
    app: &AppHandle,
    paths: impl IntoIterator<Item = PathBuf>,
) -> Result<Vec<RepositoryAccessSnapshot>, AppError> {
    require_each_repository(paths, |repository| async move {
        require_repository_mutation(app, &repository).await
    })
    .await
}

/// Checks every repository of the touched-set against its local snapshot
/// before any side effect and refuses once with all blocking repositories,
/// in the order the plan names them. Any other failure stops the check.
async fn require_each_repository<F, Fut>(
    paths: impl IntoIterator<Item = PathBuf>,
    mut require: F,
) -> Result<Vec<RepositoryAccessSnapshot>, AppError>
where
    F: FnMut(PathBuf) -> Fut,
    Fut: std::future::Future<Output = Result<RepositoryAccessSnapshot, AppError>>,
{
    let mut authorized = Vec::new();
    let mut blockers = Vec::new();
    let mut repositories = std::collections::HashSet::new();
    for path in paths {
        let repository = svode_core::git::access::local_repository_root(&path)?;
        if !repositories.insert(repository.clone()) {
            continue;
        }
        match require(repository).await {
            Ok(snapshot) => authorized.push(snapshot),
            Err(AppError::RepositoryAccessDenied {
                blockers: denied, ..
            }) if !denied.is_empty() => blockers.extend(denied),
            Err(error) => return Err(error),
        }
    }
    let Some(first) = blockers.first().cloned() else {
        return Ok(authorized);
    };
    Err(AppError::RepositoryAccessDenied {
        repository_id: first.repository_id,
        status: first.status,
        reason: first.reason,
        blockers,
    })
}

fn repository_location(path: &Path) -> String {
    let repository =
        svode_core::git::access::local_repository_root(path).unwrap_or_else(|_| path.to_path_buf());
    svode_core::system_path::user_facing_path(&repository)
}

pub(crate) fn access_store_path(app: &AppHandle) -> Result<PathBuf, AppError> {
    let config_dir = app.path().app_config_dir().map_err(|error| {
        AppError::General(format!("failed to resolve app config path: {error}"))
    })?;
    Ok(config_dir.join(svode_core::git::access::ACCESS_STORE_FILE))
}

pub async fn resolve_repository(cli: &GitCli, path: &Path) -> Result<PathBuf, AppError> {
    Ok(svode_core::git::access::resolve_repository(cli, path).await?)
}

pub async fn scope_authorized_mutation_paths<F, T, E>(
    paths: Vec<PathBuf>,
    future: F,
) -> Result<T, E>
where
    F: std::future::Future<Output = Result<T, E>>,
    E: From<AppError>,
{
    svode_core::git::access::scope_authorized_mutation_paths(paths, future, |error| {
        E::from(AppError::from(error))
    })
    .await
}

pub fn ensure_mutation_paths_were_authorized(paths: &[PathBuf]) -> Result<(), AppError> {
    Ok(svode_core::git::access::ensure_mutation_paths_were_authorized(paths)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repository(root: &Path, name: &str) -> PathBuf {
        let path = root.join(name);
        std::fs::create_dir_all(path.join(".git")).unwrap();
        path.canonicalize().unwrap()
    }

    fn snapshot(id: &str) -> RepositoryAccessSnapshot {
        RepositoryAccessSnapshot {
            repository_id: id.to_string(),
            generation: 1,
            status: RepositoryAccessStatus::Local,
            reason: None,
            checked_at: None,
            expires_at: None,
            last_known_status: None,
        }
    }

    fn denied(repository: &Path, status: &str, reason: &str) -> AppError {
        let repository_id = format!("id:{}", repository.display());
        AppError::RepositoryAccessDenied {
            repository_id: repository_id.clone(),
            status: status.to_string(),
            reason: reason.to_string(),
            blockers: vec![RepositoryAccessBlocker {
                repository_id,
                repository_path: repository_location(repository),
                status: status.to_string(),
                reason: reason.to_string(),
            }],
        }
    }

    #[tokio::test]
    async fn gate_refuses_once_with_every_blocker_in_plan_order() {
        let dir = tempfile::tempdir().unwrap();
        let page = repository(dir.path(), "page");
        let first = repository(dir.path(), "first");
        let second = repository(dir.path(), "second");
        let checked = std::sync::Mutex::new(Vec::new());

        let error = require_each_repository(
            [
                second.join("README.md"),
                page.join("doc.md"),
                first.join("links.md"),
                second.join("other.md"),
            ],
            |repository| {
                checked.lock().unwrap().push(repository.clone());
                let (page, first) = (page.clone(), first.clone());
                async move {
                    if repository == page {
                        Ok(snapshot("page"))
                    } else if repository == first {
                        Err(denied(&repository, "unknown", "not_checked"))
                    } else {
                        Err(denied(&repository, "read_only", "none"))
                    }
                }
            },
        )
        .await
        .unwrap_err();

        assert_eq!(
            *checked.lock().unwrap(),
            vec![second.clone(), page.clone(), first.clone()],
            "every repository is checked once"
        );
        let AppError::RepositoryAccessDenied {
            repository_id,
            status,
            reason,
            blockers,
        } = error
        else {
            panic!("expected a typed access denial");
        };
        assert_eq!(
            blockers
                .iter()
                .map(|blocker| blocker.repository_path.clone())
                .collect::<Vec<_>>(),
            vec![
                svode_core::system_path::user_facing_path(&second),
                svode_core::system_path::user_facing_path(&first),
            ]
        );
        assert_eq!(repository_id, blockers[0].repository_id);
        assert_eq!(status, "read_only");
        assert_eq!(reason, "none");
        assert_eq!(blockers[1].status, "unknown");
        assert_eq!(blockers[1].reason, "not_checked");
    }

    #[tokio::test]
    async fn gate_authorizes_when_every_repository_allows_writes() {
        let dir = tempfile::tempdir().unwrap();
        let page = repository(dir.path(), "page");
        let other = repository(dir.path(), "other");

        let authorized =
            require_each_repository(
                [page.join("a.md"), other.join("b.md"), page.join("c.md")],
                |repository| async move {
                    Ok(snapshot(&repository.file_name().unwrap().to_string_lossy()))
                },
            )
            .await
            .unwrap();

        assert_eq!(
            authorized
                .iter()
                .map(|snapshot| snapshot.repository_id.as_str())
                .collect::<Vec<_>>(),
            vec!["page", "other"]
        );
    }

    #[tokio::test]
    async fn gate_stops_on_a_failure_that_is_not_an_access_refusal() {
        let dir = tempfile::tempdir().unwrap();
        let first = repository(dir.path(), "first");
        let second = repository(dir.path(), "second");
        let checked = std::sync::Mutex::new(0);

        let error = require_each_repository([first.join("a.md"), second.join("b.md")], |_| {
            *checked.lock().unwrap() += 1;
            async { Err(AppError::GitNotFound) }
        })
        .await
        .unwrap_err();

        assert!(matches!(error, AppError::GitNotFound));
        assert_eq!(*checked.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn gate_keeps_a_refusal_without_location_closed() {
        let dir = tempfile::tempdir().unwrap();
        let first = repository(dir.path(), "first");
        let second = repository(dir.path(), "second");

        let error =
            require_each_repository([first.join("a.md"), second.join("b.md")], |repository| {
                let first = first.clone();
                async move {
                    if repository == first {
                        Err(AppError::RepositoryAccessDenied {
                            repository_id: "first".to_string(),
                            status: "unknown".to_string(),
                            reason: "mutation_plan_changed".to_string(),
                            blockers: Vec::new(),
                        })
                    } else {
                        Ok(snapshot("second"))
                    }
                }
            })
            .await
            .unwrap_err();

        assert!(matches!(
            error,
            AppError::RepositoryAccessDenied { ref reason, .. } if reason == "mutation_plan_changed"
        ));
    }
}

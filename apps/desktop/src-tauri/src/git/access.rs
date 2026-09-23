use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::{GitState, require_cli};
use crate::AppError;
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

impl RepositoryAccessState {
    pub fn new() -> Self {
        Self(svode_core::git::access::RepositoryAccessState::new())
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
        Ok(self.0.require_mutation(cli, space, store).await?)
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

impl Default for RepositoryAccessState {
    fn default() -> Self {
        Self::new()
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
    let mut authorized = Vec::new();
    let mut repositories = std::collections::HashSet::new();
    for path in paths {
        let repository = svode_core::git::access::local_repository_root(&path)?;
        if repositories.insert(repository.clone()) {
            authorized.push(require_repository_mutation(app, &repository).await?);
        }
    }
    Ok(authorized)
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

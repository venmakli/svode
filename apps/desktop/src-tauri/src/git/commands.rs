use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::State;

use super::cli::{GitAvailability, GitCli};
use super::ops::WorkspaceGitStatus;
use super::sync::SyncResult;
use crate::AppError;

pub struct GitState {
    cli: Option<GitCli>,
    locks: tokio::sync::Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>,
}

impl GitState {
    pub fn new() -> Self {
        let cli = match GitCli::detect() {
            Ok(cli) => Some(cli),
            Err(e) => {
                tracing::warn!("Git not available: {e}");
                None
            }
        };
        Self {
            cli,
            locks: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    /// Get the GitCli instance, returning GitNotFound if git is not available.
    fn cli(&self) -> Result<&GitCli, AppError> {
        self.cli.as_ref().ok_or(AppError::GitNotFound)
    }

    /// Get or create a per-workspace lock.
    async fn get_lock(&self, path: &Path) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.locks.lock().await;
        locks
            .entry(path.to_path_buf())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }
}

#[tauri::command]
pub async fn git_check_availability(
    state: State<'_, GitState>,
) -> Result<GitAvailability, AppError> {
    match &state.cli {
        Some(cli) => Ok(cli.check_availability().await),
        None => Ok(GitAvailability {
            git: false,
            git_lfs: false,
            git_version: None,
        }),
    }
}

#[tauri::command]
pub async fn git_init_workspace(
    state: State<'_, GitState>,
    workspace_path: String,
) -> Result<(), AppError> {
    let path = PathBuf::from(&workspace_path);
    let lock = state.get_lock(&path).await;
    let _guard = lock.lock().await;
    super::ops::init(state.cli()?, &path).await
}

#[tauri::command]
pub async fn git_clone_workspace(
    state: State<'_, GitState>,
    url: String,
    target_path: String,
) -> Result<(), AppError> {
    let path = PathBuf::from(&target_path);
    let lock = state.get_lock(&path).await;
    let _guard = lock.lock().await;
    super::ops::clone(state.cli()?, &url, &path).await
}

#[tauri::command]
pub async fn git_status(
    state: State<'_, GitState>,
    workspace_path: String,
) -> Result<WorkspaceGitStatus, AppError> {
    let path = PathBuf::from(&workspace_path);
    let lock = state.get_lock(&path).await;
    let _guard = lock.lock().await;
    super::ops::status(state.cli()?, &path).await
}

#[tauri::command]
pub async fn git_commit_file(
    state: State<'_, GitState>,
    workspace_path: String,
    file_path: String,
) -> Result<(), AppError> {
    let path = PathBuf::from(&workspace_path);
    let lock = state.get_lock(&path).await;
    let _guard = lock.lock().await;
    super::ops::commit_file(state.cli()?, &path, &file_path).await
}

#[tauri::command]
pub async fn git_commit_all(
    state: State<'_, GitState>,
    workspace_path: String,
) -> Result<(), AppError> {
    let path = PathBuf::from(&workspace_path);
    let lock = state.get_lock(&path).await;
    let _guard = lock.lock().await;
    super::ops::commit_all(state.cli()?, &path).await
}

#[tauri::command]
pub async fn git_sync(
    state: State<'_, GitState>,
    workspace_path: String,
) -> Result<SyncResult, AppError> {
    let path = PathBuf::from(&workspace_path);
    let lock = state.get_lock(&path).await;
    let _guard = lock.lock().await;
    super::sync::sync(state.cli()?, &path).await
}

#[tauri::command]
pub async fn git_conflict_files(
    state: State<'_, GitState>,
    workspace_path: String,
) -> Result<Vec<String>, AppError> {
    let path = PathBuf::from(&workspace_path);
    let lock = state.get_lock(&path).await;
    let _guard = lock.lock().await;
    super::sync::conflict_files(state.cli()?, &path).await
}

#[tauri::command]
pub async fn git_resolve_continue(
    state: State<'_, GitState>,
    workspace_path: String,
) -> Result<SyncResult, AppError> {
    let path = PathBuf::from(&workspace_path);
    let lock = state.get_lock(&path).await;
    let _guard = lock.lock().await;
    super::sync::resolve_and_continue(state.cli()?, &path).await
}

#[tauri::command]
pub async fn git_merge_abort(
    state: State<'_, GitState>,
    workspace_path: String,
) -> Result<(), AppError> {
    let path = PathBuf::from(&workspace_path);
    let lock = state.get_lock(&path).await;
    let _guard = lock.lock().await;
    super::sync::merge_abort(state.cli()?, &path).await
}

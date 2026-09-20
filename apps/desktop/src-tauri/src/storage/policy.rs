//! Desktop entrypoint for the shared binary routing policy. The rules, the
//! generated blocks and the diagnostics live in `svode-core`; this exposes the
//! Settings IPC over them.

use std::path::PathBuf;

use tauri::State;

use crate::error::AppError;
use crate::git::GitState;
use crate::index::IndexState;

use super::scope::resolve_effective_storage_scope;

use svode_core::storage::policy::{LfsPolicyDiagnostic, diagnose_repo_lfs_policy};

/// IPC: report whether the generated routing block is current and which dirty
/// files are not covered by an effective Git LFS filter.
#[tauri::command]
pub async fn diagnose_lfs_policy(
    project_path: String,
    space_id: Option<String>,
    git_state: State<'_, GitState>,
    index_state: State<'_, IndexState>,
) -> Result<LfsPolicyDiagnostic, AppError> {
    let project = PathBuf::from(&project_path);
    let scope =
        resolve_effective_storage_scope(&index_state, &project, space_id.as_deref()).await?;
    let cli = git_state.cli.clone().ok_or(AppError::GitNotFound)?;
    let lock = git_state.get_lock(&scope.repo_dir).await;
    let _guard = lock.lock().await;

    Ok(diagnose_repo_lfs_policy(cli.core(), &scope.repo_dir, &scope.config).await?)
}

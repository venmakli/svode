use std::path::{Path, PathBuf};

use tauri::State;

use super::{
    apply_identity_to_project, get_effective_identity, get_global_identity, get_local_identity,
    set_global_identity, set_local_identity, FanoutPreviewEntry, GlobalIdentityResult,
    RepoIdentityResult,
};
use crate::AppError;
use crate::git::commands::{require_cli, GitState};
use crate::git::ops;
use crate::space::config;
use crate::space::types::SpaceGitType;

#[tauri::command]
pub async fn get_git_identity(
    state: State<'_, GitState>,
) -> Result<GlobalIdentityResult, AppError> {
    let cli = require_cli(&state)?;
    let global = get_global_identity(&cli).await?;
    let source = if global.is_some() { "global" } else { "missing" };
    Ok(GlobalIdentityResult { global, source })
}

#[tauri::command]
pub async fn set_git_identity(
    state: State<'_, GitState>,
    name: String,
    email: String,
) -> Result<(), AppError> {
    let cli = require_cli(&state)?;
    set_global_identity(&cli, &name, &email).await
}

#[tauri::command]
pub async fn get_repo_identity(
    state: State<'_, GitState>,
    repo_path: String,
) -> Result<RepoIdentityResult, AppError> {
    let cli = require_cli(&state)?;
    let path = PathBuf::from(&repo_path);
    get_effective_identity(&cli, &path).await
}

#[tauri::command]
pub async fn set_repo_identity(
    state: State<'_, GitState>,
    repo_path: String,
    name: Option<String>,
    email: Option<String>,
) -> Result<(), AppError> {
    let cli = require_cli(&state)?;
    let path = PathBuf::from(&repo_path);
    set_local_identity(&cli, &path, name.as_deref(), email.as_deref()).await
}

#[tauri::command]
pub async fn get_project_fanout_preview(
    state: State<'_, GitState>,
    root_path: String,
) -> Result<Vec<FanoutPreviewEntry>, AppError> {
    let cli = require_cli(&state)?;
    let root = PathBuf::from(&root_path);
    let cfg = config::read_space_config(&root)?;

    let mut out: Vec<FanoutPreviewEntry> = Vec::new();
    if let Some(spaces) = cfg.spaces.as_ref() {
        for sp in spaces {
            let space_dir = root.join(&sp.path);
            // Skip non-existent (ghost / missing) spaces — nothing to write to.
            if !space_dir.exists() {
                continue;
            }
            // Only non-inline spaces have their own repo to receive identity.
            let git_type = match ops::detect_space_git_type(&cli, &root, &space_dir).await {
                Ok(gt) => gt,
                Err(_) => continue,
            };
            if matches!(git_type, SpaceGitType::Inline) {
                continue;
            }

            let space_name = config::read_space_config(&space_dir)
                .map(|c| c.name)
                .unwrap_or_else(|_| {
                    space_dir
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| sp.path.clone())
                });

            let current_local = get_local_identity(&cli, &space_dir).await.unwrap_or(None);
            let will_replace = current_local.is_some();

            out.push(FanoutPreviewEntry {
                space_path: space_dir.to_string_lossy().to_string(),
                space_name,
                current_local,
                will_replace,
            });
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn set_project_identity(
    state: State<'_, GitState>,
    root_path: String,
    name: Option<String>,
    email: Option<String>,
    target_spaces: Vec<String>,
) -> Result<(), AppError> {
    let cli = require_cli(&state)?;
    let root: &Path = Path::new(&root_path);
    apply_identity_to_project(
        &cli,
        root,
        name.as_deref(),
        email.as_deref(),
        &target_spaces,
    )
    .await
}

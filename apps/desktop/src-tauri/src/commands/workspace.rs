use std::path::Path;
use std::path::PathBuf;

use tauri::{AppHandle, Manager, State};

use crate::error::AppError;
use crate::git::commands::GitState;
use crate::index::IndexState;
use crate::workspace::{config, project, registry, settings, symlinks, types::*};

// --- App Settings ---

#[tauri::command]
pub fn get_app_settings(app: AppHandle) -> Result<AppSettings, AppError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;
    settings::read_app_settings(&config_dir)
}

#[tauri::command]
pub fn save_app_settings(app: AppHandle, settings_data: AppSettings) -> Result<(), AppError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;
    settings::write_app_settings(&config_dir, &settings_data)
}

// --- Root Workspaces ---

#[tauri::command]
pub fn list_workspaces(app: AppHandle) -> Result<Vec<WorkspaceInfo>, AppError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;
    let reg = registry::read_registry(&config_dir)?;
    let mut workspaces = Vec::new();
    for ws_ref in &reg.workspaces {
        let ws_path = Path::new(&ws_ref.path);
        match config::read_workspace_config(ws_path) {
            Ok(cfg) => {
                workspaces.push(WorkspaceInfo {
                    id: ws_ref.id.clone(),
                    name: cfg.name,
                    icon: cfg.icon,
                    description: cfg.description,
                    path: ws_ref.path.clone(),
                    has_spaces: cfg
                        .spaces
                        .as_ref()
                        .map(|s| !s.is_empty())
                        .unwrap_or(false),
                    last_opened: ws_ref.last_opened.clone(),
                });
            }
            Err(_) => continue,
        }
    }
    Ok(workspaces)
}

#[tauri::command]
pub async fn create_workspace(
    app: AppHandle,
    git_state: State<'_, GitState>,
    name: String,
    icon: String,
    description: Option<String>,
    path: String,
) -> Result<WorkspaceInfo, AppError> {
    let ws_path = Path::new(&path);

    // Check if project already exists at this path
    if ws_path.join(".combai").join("config.json").exists() {
        return Err(AppError::ProjectAlreadyExists(path.clone()));
    }

    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;
    let (id, cfg) = project::create_workspace(
        &config_dir,
        &name,
        &icon,
        description.as_deref().unwrap_or(""),
        ws_path,
    )?;

    // Auto git init
    if let Some(cli) = &git_state.cli {
        let lock = git_state.get_lock(ws_path).await;
        let _guard = lock.lock().await;
        if let Err(e) = crate::git::ops::init(cli, ws_path).await {
            tracing::warn!("git init failed for new project: {e}");
        }
    }

    Ok(WorkspaceInfo {
        id,
        name: cfg.name,
        icon: cfg.icon,
        description: cfg.description,
        path,
        has_spaces: false,
        last_opened: None,
    })
}

#[tauri::command]
pub async fn open_workspace_folder(
    app: AppHandle,
    git_state: State<'_, GitState>,
    path: String,
) -> Result<WorkspaceInfo, AppError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;
    let ws_path = Path::new(&path);
    let (id, cfg) = project::open_workspace_folder(&config_dir, ws_path)?;

    // Auto git init if no .git/ exists
    if !ws_path.join(".git").exists() {
        if let Some(cli) = &git_state.cli {
            let lock = git_state.get_lock(ws_path).await;
            let _guard = lock.lock().await;
            if let Err(e) = crate::git::ops::init(cli, ws_path).await {
                tracing::warn!("git init failed for opened folder: {e}");
            }
        }
    }

    Ok(WorkspaceInfo {
        id,
        name: cfg.name,
        icon: cfg.icon,
        description: cfg.description,
        path,
        has_spaces: cfg
            .spaces
            .as_ref()
            .map(|s| !s.is_empty())
            .unwrap_or(false),
        last_opened: None,
    })
}

#[tauri::command]
pub async fn delete_workspace(
    app: AppHandle,
    index_state: State<'_, IndexState>,
    id: String,
    delete_files: Option<bool>,
) -> Result<(), AppError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;

    // Close the index pool before any filesystem operations so SQLite releases
    // file handles (Windows would otherwise refuse to remove the directory).
    if let Some(ws_ref) = registry::find_workspace(&config_dir, &id)? {
        index_state.close(&ws_ref.path).await;
    }

    project::delete_workspace(&config_dir, &id, delete_files.unwrap_or(false))
}

#[tauri::command]
pub fn get_last_active_workspace(app: AppHandle) -> Result<Option<String>, AppError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;
    let reg = registry::read_registry(&config_dir)?;
    Ok(reg.last_active)
}

#[tauri::command]
pub async fn open_workspace(
    app: AppHandle,
    index_state: State<'_, IndexState>,
    id: String,
) -> Result<WorkspaceConfig, AppError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;
    registry::update_last_active(&config_dir, &id)?;
    registry::update_last_opened(&config_dir, &id)?;

    let ws_ref = registry::find_workspace(&config_dir, &id)?
        .ok_or_else(|| AppError::WorkspaceNotFound(id.clone()))?;

    let cfg = config::read_workspace_config(Path::new(&ws_ref.path))?;

    // Build/refresh the SQLite index in the background so the UI doesn't wait
    // on filesystem walk + N upserts. Failure is logged but does not block
    // workspace open — the user can always trigger a manual reindex later.
    let pool = index_state.get_or_create(&ws_ref.path).await?;
    let reindex_lock = index_state.reindex_lock(&ws_ref.path).await;
    let workspace_dir: PathBuf = PathBuf::from(&ws_ref.path);
    tokio::spawn(async move {
        let _guard = reindex_lock.lock().await;
        if let Err(e) = crate::index::reindex::full_reindex(&pool, &workspace_dir).await {
            tracing::warn!(
                "background reindex failed for {}: {e}",
                workspace_dir.display()
            );
        }
    });

    Ok(cfg)
}

// --- Spaces ---

#[tauri::command]
pub fn list_spaces(workspace_path: String) -> Result<Vec<WorkspaceInfo>, AppError> {
    let path = Path::new(&workspace_path);
    project::list_spaces(path)
}

#[tauri::command]
pub fn create_space(
    parent_path: String,
    name: String,
    icon: String,
) -> Result<WorkspaceInfo, AppError> {
    let path = Path::new(&parent_path);
    project::create_space(path, &name, &icon)
}

#[tauri::command]
pub fn delete_space(
    parent_path: String,
    space_id: String,
    delete_files: Option<bool>,
) -> Result<(), AppError> {
    let path = Path::new(&parent_path);
    project::delete_space(path, &space_id, delete_files.unwrap_or(false))
}

#[tauri::command]
pub fn register_cloned_space(
    parent_path: String,
    folder_name: String,
    fallback_name: String,
    icon: String,
) -> Result<WorkspaceInfo, AppError> {
    let path = Path::new(&parent_path);
    project::register_cloned_space(path, &folder_name, &fallback_name, &icon)
}

// --- Clone project ---

#[tauri::command]
pub async fn project_clone(
    app: AppHandle,
    git_state: State<'_, GitState>,
    url: String,
    target_path: String,
) -> Result<WorkspaceInfo, AppError> {
    let path = PathBuf::from(&target_path);
    let cli = crate::git::commands::require_cli(&git_state)?;
    let lock = git_state.get_lock(&path).await;
    let _guard = lock.lock().await;
    crate::git::clone::clone_with_progress(&cli, &app, &url, &path).await?;
    drop(_guard);

    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;
    let (id, cfg) = project::open_workspace_folder(&config_dir, &path)?;

    Ok(WorkspaceInfo {
        id,
        name: cfg.name,
        icon: cfg.icon,
        description: cfg.description,
        path: target_path,
        has_spaces: cfg
            .spaces
            .as_ref()
            .map(|s| !s.is_empty())
            .unwrap_or(false),
        last_opened: None,
    })
}

#[tauri::command]
pub fn path_exists(path: String) -> Result<bool, AppError> {
    Ok(Path::new(&path).exists())
}

/// Register the `<workspace_path>/.assets` directory with the Tauri asset
/// protocol scope so the webview can render images/videos/audio uploaded
/// to that workspace.
#[tauri::command]
pub fn ensure_assets_scope(app: AppHandle, workspace_path: String) -> Result<(), AppError> {
    let assets_dir = Path::new(&workspace_path).join(".assets");
    app.asset_protocol_scope()
        .allow_directory(&assets_dir, true)
        .map_err(|e| AppError::General(e.to_string()))
}

// --- Config ---

#[tauri::command]
pub fn get_workspace_config(workspace_path: String) -> Result<WorkspaceConfig, AppError> {
    let path = Path::new(&workspace_path);
    config::read_workspace_config(path)
}

#[tauri::command]
pub fn save_workspace_config(
    workspace_path: String,
    config_data: WorkspaceConfig,
) -> Result<(), AppError> {
    let path = Path::new(&workspace_path);
    config::write_workspace_config(path, &config_data)
}

// --- CLI Symlinks ---

#[tauri::command]
pub fn setup_cli_symlinks_cmd(
    workspace_path: String,
    cli_name: String,
) -> Result<Vec<String>, AppError> {
    let path = Path::new(&workspace_path);
    symlinks::setup_cli_symlinks(path, &cli_name)
}

#[tauri::command]
pub fn teardown_cli_symlinks_cmd(
    workspace_path: String,
    cli_name: String,
) -> Result<(), AppError> {
    let path = Path::new(&workspace_path);
    symlinks::teardown_cli_symlinks(path, &cli_name)
}

#[tauri::command]
pub fn check_symlink_health(
    workspace_path: String,
    cli_name: String,
) -> Result<symlinks::SymlinkHealthReport, AppError> {
    let path = Path::new(&workspace_path);
    symlinks::health_check_symlinks(path, &cli_name)
}

#[tauri::command]
pub fn read_agents_md(workspace_path: String) -> Result<Option<String>, AppError> {
    let path = Path::new(&workspace_path).join(".combai").join("AGENTS.md");
    if path.exists() {
        Ok(Some(std::fs::read_to_string(&path)?))
    } else {
        Ok(None)
    }
}

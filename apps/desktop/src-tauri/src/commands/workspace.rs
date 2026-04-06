use std::path::Path;

use tauri::{AppHandle, Manager};

use crate::error::AppError;
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
                    has_children: cfg
                        .children
                        .as_ref()
                        .map(|ch| !ch.is_empty())
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
pub fn create_workspace(
    app: AppHandle,
    name: String,
    icon: String,
    description: Option<String>,
    path: String,
) -> Result<WorkspaceInfo, AppError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;
    let ws_path = Path::new(&path);
    let (id, cfg) = project::create_workspace(
        &config_dir,
        &name,
        &icon,
        description.as_deref().unwrap_or(""),
        ws_path,
    )?;
    Ok(WorkspaceInfo {
        id,
        name: cfg.name,
        icon: cfg.icon,
        description: cfg.description,
        path,
        has_children: false,
        last_opened: None,
    })
}

#[tauri::command]
pub fn open_workspace_folder(app: AppHandle, path: String) -> Result<WorkspaceInfo, AppError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;
    let ws_path = Path::new(&path);
    let (id, cfg) = project::open_workspace_folder(&config_dir, ws_path)?;
    Ok(WorkspaceInfo {
        id,
        name: cfg.name,
        icon: cfg.icon,
        description: cfg.description,
        path,
        has_children: cfg
            .children
            .as_ref()
            .map(|ch| !ch.is_empty())
            .unwrap_or(false),
        last_opened: None,
    })
}

#[tauri::command]
pub fn delete_workspace(
    app: AppHandle,
    id: String,
    delete_files: Option<bool>,
) -> Result<(), AppError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;
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
pub fn open_workspace(app: AppHandle, id: String) -> Result<WorkspaceConfig, AppError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;
    registry::update_last_active(&config_dir, &id)?;
    registry::update_last_opened(&config_dir, &id)?;

    let ws_ref = registry::find_workspace(&config_dir, &id)?
        .ok_or_else(|| AppError::WorkspaceNotFound(id.clone()))?;

    config::read_workspace_config(Path::new(&ws_ref.path))
}

// --- Children ---

#[tauri::command]
pub fn list_children(workspace_path: String) -> Result<Vec<WorkspaceInfo>, AppError> {
    let path = Path::new(&workspace_path);
    project::list_children(path)
}

#[tauri::command]
pub fn create_child(
    parent_path: String,
    name: String,
    icon: String,
) -> Result<WorkspaceInfo, AppError> {
    let path = Path::new(&parent_path);
    project::create_child(path, &name, &icon)
}

#[tauri::command]
pub fn delete_child(
    parent_path: String,
    child_id: String,
    delete_files: Option<bool>,
) -> Result<(), AppError> {
    let path = Path::new(&parent_path);
    project::delete_child(path, &child_id, delete_files.unwrap_or(false))
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

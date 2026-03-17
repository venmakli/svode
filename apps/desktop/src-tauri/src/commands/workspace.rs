use tauri::{AppHandle, Manager};

use crate::error::AppError;
use crate::workspace::{config, project, registry, scaffold, settings, types::*};

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

#[tauri::command]
pub fn list_projects(app: AppHandle) -> Result<Vec<Project>, AppError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;
    let reg = registry::read_registry(&config_dir)?;
    let mut projects = Vec::new();
    for pr in &reg.projects {
        match project::read_project_config(&config_dir, &pr.id) {
            Ok(cfg) => {
                projects.push(Project {
                    id: pr.id.clone(),
                    name: cfg.name,
                    icon: cfg.icon,
                    description: cfg.description,
                    workspace_count: cfg.workspaces.len(),
                    last_opened: pr.last_opened.clone(),
                });
            }
            Err(_) => continue, // skip broken entries
        }
    }
    Ok(projects)
}

#[tauri::command]
pub fn create_project(
    app: AppHandle,
    name: String,
    icon: String,
    description: Option<String>,
) -> Result<Project, AppError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;
    let (id, cfg) = project::create_project(
        &config_dir,
        &name,
        &icon,
        description.as_deref().unwrap_or(""),
    )?;
    Ok(Project {
        id,
        name: cfg.name,
        icon: cfg.icon,
        description: cfg.description,
        workspace_count: 0,
        last_opened: None,
    })
}

#[tauri::command]
pub fn delete_project(app: AppHandle, id: String) -> Result<(), AppError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;
    project::delete_project(&config_dir, &id)
}

#[tauri::command]
pub fn open_project(app: AppHandle, id: String) -> Result<ProjectConfig, AppError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;
    registry::update_last_active(&config_dir, &id)?;
    registry::update_last_opened(&config_dir, &id)?;
    project::read_project_config(&config_dir, &id)
}

#[tauri::command]
pub fn list_workspaces(app: AppHandle, project_id: String) -> Result<Vec<Workspace>, AppError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;
    let cfg = project::read_project_config(&config_dir, &project_id)?;
    let mut workspaces = Vec::new();
    for ws_ref in &cfg.workspaces {
        let path = std::path::Path::new(&ws_ref.path);
        let exists = path.exists();
        let ws_config = if exists {
            config::read_workspace_config(path).ok()
        } else {
            None
        };
        workspaces.push(Workspace {
            id: ws_ref.id.clone(),
            name: ws_config
                .as_ref()
                .map(|c| c.name.clone())
                .unwrap_or_else(|| {
                    path.file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default()
                }),
            icon: ws_config
                .as_ref()
                .map(|c| c.icon.clone())
                .unwrap_or_default(),
            path: ws_ref.path.clone(),
            exists,
        });
    }
    Ok(workspaces)
}

#[tauri::command]
pub fn create_workspace(
    app: AppHandle,
    project_id: String,
    name: String,
    path: String,
) -> Result<Workspace, AppError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;
    let ws_path = std::path::Path::new(&path);

    // Create directory if it doesn't exist
    std::fs::create_dir_all(ws_path)?;

    // Scaffold workspace
    let ws_config = scaffold::scaffold_workspace(ws_path, &name)?;

    let ws_id = ulid::Ulid::new().to_string().to_lowercase();
    let ws_ref = WorkspaceRef {
        id: ws_id.clone(),
        path: path.clone(),
    };
    project::add_workspace_to_project(&config_dir, &project_id, ws_ref)?;

    Ok(Workspace {
        id: ws_id,
        name: ws_config.name,
        icon: ws_config.icon,
        path,
        exists: true,
    })
}

#[tauri::command]
pub fn open_folder_as_workspace(
    app: AppHandle,
    project_id: String,
    path: String,
) -> Result<Workspace, AppError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;
    let ws_path = std::path::Path::new(&path);

    if !ws_path.exists() || !ws_path.is_dir() {
        return Err(AppError::PathNotAccessible(path));
    }

    // Read existing config or create minimal one
    let ws_config = match config::read_workspace_config(ws_path) {
        Ok(cfg) => cfg,
        Err(_) => {
            // Create .combai/config.json for existing folder
            let name = ws_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "Workspace".to_string());
            let cfg = WorkspaceConfig {
                name,
                description: String::new(),
                icon: String::new(),
                agent: None,
            };
            config::write_workspace_config(ws_path, &cfg)?;
            cfg
        }
    };

    let ws_id = ulid::Ulid::new().to_string().to_lowercase();
    let ws_ref = WorkspaceRef {
        id: ws_id.clone(),
        path: path.clone(),
    };
    project::add_workspace_to_project(&config_dir, &project_id, ws_ref)?;

    Ok(Workspace {
        id: ws_id,
        name: ws_config.name,
        icon: ws_config.icon,
        path,
        exists: true,
    })
}

#[tauri::command]
pub fn delete_workspace(
    app: AppHandle,
    project_id: String,
    workspace_id: String,
) -> Result<(), AppError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;
    project::remove_workspace_from_project(&config_dir, &project_id, &workspace_id)
}

#[tauri::command]
pub fn get_last_active_project(app: AppHandle) -> Result<Option<String>, AppError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;
    let reg = registry::read_registry(&config_dir)?;
    Ok(reg.last_active)
}

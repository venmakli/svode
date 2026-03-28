use std::path::Path;

use tauri::{AppHandle, Manager};

use crate::error::AppError;
use crate::files::entry::slugify;
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
        // Directory project: read config from on-disk path
        if let Some(ref path) = pr.path {
            let project_path = Path::new(path);
            match project::read_directory_project_config(project_path) {
                Ok(cfg) => {
                    projects.push(Project {
                        id: pr.id.clone(),
                        name: cfg.name,
                        icon: cfg.icon,
                        description: cfg.description,
                        variant: cfg.variant,
                        path: Some(path.clone()),
                        workspace_count: cfg.workspaces.len(),
                        last_opened: pr.last_opened.clone(),
                    });
                }
                Err(_) => continue,
            }
        } else {
            // Lightweight project: read from app config dir
            match project::read_project_config(&config_dir, &pr.id) {
                Ok(cfg) => {
                    projects.push(Project {
                        id: pr.id.clone(),
                        name: cfg.name,
                        icon: cfg.icon,
                        description: cfg.description,
                        variant: cfg.variant,
                        path: None,
                        workspace_count: cfg.workspaces.len(),
                        last_opened: pr.last_opened.clone(),
                    });
                }
                Err(_) => continue,
            }
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
        variant: None,
        path: None,
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

    let project_ref = registry::find_project(&config_dir, &id)?
        .ok_or_else(|| AppError::ProjectNotFound(id.clone()))?;

    if let Some(ref path) = project_ref.path {
        project::read_directory_project_config(Path::new(path))
    } else {
        project::read_project_config(&config_dir, &id)
    }
}

#[tauri::command]
pub fn list_workspaces(app: AppHandle, project_id: String) -> Result<Vec<Workspace>, AppError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;

    let project_ref = registry::find_project(&config_dir, &project_id)?
        .ok_or_else(|| AppError::ProjectNotFound(project_id.clone()))?;

    // Read project config depending on variant
    let (cfg, project_path) = if let Some(ref path) = project_ref.path {
        let p = Path::new(path);
        let cfg = project::read_directory_project_config(p)?;
        (cfg, Some(p.to_path_buf()))
    } else {
        let cfg = project::read_project_config(&config_dir, &project_id)?;
        (cfg, None)
    };

    let mut workspaces = Vec::new();
    for ws_ref in &cfg.workspaces {
        // For Directory projects, resolve relative paths from project path
        let resolved_path = if let Some(ref pp) = project_path {
            let rel = Path::new(&ws_ref.path);
            if rel.is_relative() {
                pp.join(rel).to_string_lossy().to_string()
            } else {
                ws_ref.path.clone()
            }
        } else {
            ws_ref.path.clone()
        };

        let path = Path::new(&resolved_path);
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
            path: resolved_path,
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
    let ws_path = Path::new(&path);

    // Folder must already exist (user picks it)
    if !ws_path.exists() || !ws_path.is_dir() {
        return Err(AppError::PathNotAccessible(path));
    }

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
    let ws_path = Path::new(&path);

    if !ws_path.exists() || !ws_path.is_dir() {
        return Err(AppError::PathNotAccessible(path.clone()));
    }

    let project_ref = registry::find_project(&config_dir, &project_id)?
        .ok_or_else(|| AppError::ProjectNotFound(project_id.clone()))?;

    // For Directory projects, validate the folder is inside the project folder
    let stored_path = if let Some(ref project_path_str) = project_ref.path {
        let project_path = Path::new(project_path_str);
        let canonical_project = project_path
            .canonicalize()
            .map_err(|_| AppError::PathNotAccessible(project_path_str.clone()))?;
        let canonical_ws = ws_path
            .canonicalize()
            .map_err(|_| AppError::PathNotAccessible(path.clone()))?;
        if !canonical_ws.starts_with(&canonical_project) {
            return Err(AppError::General(
                "Workspace folder must be inside the project directory".to_string(),
            ));
        }
        // Store relative path for Directory projects
        canonical_ws
            .strip_prefix(&canonical_project)
            .map(|rel| rel.to_string_lossy().to_string())
            .unwrap_or_else(|_| path.clone())
    } else {
        path.clone()
    };

    // Read existing config or create minimal one
    let ws_config = match config::read_workspace_config(ws_path) {
        Ok(cfg) => cfg,
        Err(_) => {
            let name = ws_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "Workspace".to_string());
            let cfg = WorkspaceConfig {
                type_: Some("workspace".to_string()),
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
        path: stored_path,
    };

    // Add workspace ref to the right config
    if project_ref.path.is_some() {
        let project_path = Path::new(project_ref.path.as_ref().unwrap());
        project::add_workspace_to_directory_project(project_path, ws_ref)?;
    } else {
        project::add_workspace_to_project(&config_dir, &project_id, ws_ref)?;
    }

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

    let project_ref = registry::find_project(&config_dir, &project_id)?
        .ok_or_else(|| AppError::ProjectNotFound(project_id.clone()))?;

    if let Some(ref path) = project_ref.path {
        project::remove_workspace_from_directory_project(Path::new(path), &workspace_id)
    } else {
        project::remove_workspace_from_project(&config_dir, &project_id, &workspace_id)
    }
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

#[tauri::command]
pub fn open_project_folder(app: AppHandle, path: String) -> Result<Project, AppError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;
    let project_path = Path::new(&path);

    // Read and validate the project config
    let cfg = project::read_directory_project_config(project_path)?;

    // Check if this path is already registered
    let reg = registry::read_registry(&config_dir)?;
    if let Some(existing) = reg.projects.iter().find(|p| p.path.as_deref() == Some(&path)) {
        return Ok(Project {
            id: existing.id.clone(),
            name: cfg.name,
            icon: cfg.icon,
            description: cfg.description,
            variant: cfg.variant,
            path: Some(path),
            workspace_count: cfg.workspaces.len(),
            last_opened: existing.last_opened.clone(),
        });
    }

    // Generate an id and register with path
    let id = ulid::Ulid::new().to_string().to_lowercase();
    registry::add_directory_project(&config_dir, &id, &path)?;

    Ok(Project {
        id,
        name: cfg.name,
        icon: cfg.icon,
        description: cfg.description,
        variant: cfg.variant,
        path: Some(path),
        workspace_count: cfg.workspaces.len(),
        last_opened: None,
    })
}

#[tauri::command]
pub fn create_workspace_in_directory(
    app: AppHandle,
    project_id: String,
    name: String,
    icon: String,
) -> Result<Workspace, AppError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;

    let project_ref = registry::find_project(&config_dir, &project_id)?
        .ok_or_else(|| AppError::ProjectNotFound(project_id.clone()))?;

    let project_path_str = project_ref.path.ok_or_else(|| {
        AppError::General("Project is not a Directory project".to_string())
    })?;
    let project_path = Path::new(&project_path_str);

    // Generate slug from name (slugify returns "untitled" for empty input)
    let slug = slugify(&name);

    // Handle collision: try slug, slug-1, slug-2, etc.
    let mut folder_name = slug.clone();
    let mut counter = 1u32;
    while project_path.join(&folder_name).exists() {
        folder_name = format!("{}-{}", slug, counter);
        counter += 1;
    }

    let ws_dir = project_path.join(&folder_name);
    std::fs::create_dir_all(&ws_dir)?;

    // Scaffold workspace inside the new folder
    let mut ws_config = scaffold::scaffold_workspace(&ws_dir, &name)?;
    if !icon.is_empty() {
        ws_config.icon = icon;
        config::write_workspace_config(&ws_dir, &ws_config)?;
    }

    let ws_id = ulid::Ulid::new().to_string().to_lowercase();
    let ws_ref = WorkspaceRef {
        id: ws_id.clone(),
        path: folder_name.clone(), // relative path
    };
    project::add_workspace_to_directory_project(project_path, ws_ref)?;

    Ok(Workspace {
        id: ws_id,
        name: ws_config.name,
        icon: ws_config.icon,
        path: ws_dir.to_string_lossy().to_string(),
        exists: true,
    })
}

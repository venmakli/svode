use std::path::Path;

use crate::error::AppError;

use super::registry;
use super::types::{ProjectConfig, ProjectDefaults, ProjectRef, WorkspaceRef};

/// Read project config from config_dir/projects/{id}/config.json.
pub fn read_project_config(config_dir: &Path, id: &str) -> Result<ProjectConfig, AppError> {
    let path = config_dir.join("projects").join(id).join("config.json");
    if !path.exists() {
        return Err(AppError::ProjectNotFound(id.to_string()));
    }
    let data = std::fs::read_to_string(&path)?;
    Ok(serde_json::from_str(&data)?)
}

/// Write project config to config_dir/projects/{id}/config.json.
pub fn write_project_config(
    config_dir: &Path,
    id: &str,
    config: &ProjectConfig,
) -> Result<(), AppError> {
    let dir = config_dir.join("projects").join(id);
    std::fs::create_dir_all(&dir)?;
    let data = serde_json::to_string_pretty(config)?;
    std::fs::write(dir.join("config.json"), data)?;
    Ok(())
}

/// Create a new project: generate ULID, write config, add to registry.
/// Returns (id, ProjectConfig).
pub fn create_project(
    config_dir: &Path,
    name: &str,
    icon: &str,
    description: &str,
) -> Result<(String, ProjectConfig), AppError> {
    let id = ulid::Ulid::new().to_string().to_lowercase();
    let config = ProjectConfig {
        type_: None,
        variant: None,
        name: name.to_string(),
        description: description.to_string(),
        icon: icon.to_string(),
        workspaces: Vec::new(),
        defaults: ProjectDefaults::default(),
    };
    write_project_config(config_dir, &id, &config)?;
    registry::add_project(config_dir, &id)?;
    Ok((id, config))
}

/// Delete a project: remove config directory and registry entry.
/// If `delete_files` is true, also delete project data from disk:
/// - Directory project: remove the entire project folder
/// - Lightweight project: remove each workspace folder
pub fn delete_project(
    config_dir: &Path,
    id: &str,
    delete_files: bool,
) -> Result<(), AppError> {
    let project_ref = registry::find_project(config_dir, id)?;

    if delete_files {
        if let Some(ref project_ref) = project_ref {
            if let Some(ref project_path) = project_ref.path {
                // Directory project: delete entire project folder
                let path = Path::new(project_path);
                if path.exists() {
                    std::fs::remove_dir_all(path)?;
                }
            } else {
                // Lightweight project: delete each workspace folder
                if let Ok(cfg) = read_project_config(config_dir, id) {
                    for ws in &cfg.workspaces {
                        let ws_path = Path::new(&ws.path);
                        if ws_path.exists() && ws_path.is_dir() {
                            std::fs::remove_dir_all(ws_path)?;
                        }
                    }
                }
            }
        }
    }

    // Always remove lightweight config dir
    let dir = config_dir.join("projects").join(id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    registry::remove_project(config_dir, id)
}

/// Add a workspace reference to the project config.
pub fn add_workspace_to_project(
    config_dir: &Path,
    project_id: &str,
    ws_ref: WorkspaceRef,
) -> Result<(), AppError> {
    let mut config = read_project_config(config_dir, project_id)?;
    config.workspaces.push(ws_ref);
    write_project_config(config_dir, project_id, &config)
}

/// Read a Directory project config from {path}/.combai/config.json.
pub fn read_directory_project_config(path: &Path) -> Result<ProjectConfig, AppError> {
    let config_path = path.join(".combai").join("config.json");
    if !config_path.exists() {
        return Err(AppError::FileNotFound(
            config_path.to_string_lossy().to_string(),
        ));
    }
    let data = std::fs::read_to_string(&config_path)?;
    let config: ProjectConfig = serde_json::from_str(&data)?;
    if config.type_.as_deref() != Some("project") {
        return Err(AppError::General(
            "Config is not a project config".to_string(),
        ));
    }
    Ok(config)
}

/// Write a Directory project config to {path}/.combai/config.json.
pub fn write_directory_project_config(
    path: &Path,
    config: &ProjectConfig,
) -> Result<(), AppError> {
    let dir = path.join(".combai");
    std::fs::create_dir_all(&dir)?;
    let data = serde_json::to_string_pretty(config)?;
    std::fs::write(dir.join("config.json"), data)?;
    Ok(())
}

/// Check if a ProjectRef points to a Directory project (has a path).
pub fn is_directory_project(project_ref: &ProjectRef) -> bool {
    project_ref.path.is_some()
}

/// Add a workspace reference to a Directory project config (on-disk).
pub fn add_workspace_to_directory_project(
    project_path: &Path,
    ws_ref: WorkspaceRef,
) -> Result<(), AppError> {
    let mut config = read_directory_project_config(project_path)?;
    config.workspaces.push(ws_ref);
    write_directory_project_config(project_path, &config)
}

/// Remove a workspace reference from the project config.
pub fn remove_workspace_from_project(
    config_dir: &Path,
    project_id: &str,
    ws_id: &str,
) -> Result<(), AppError> {
    let mut config = read_project_config(config_dir, project_id)?;
    config.workspaces.retain(|w| w.id != ws_id);
    write_project_config(config_dir, project_id, &config)
}

/// Remove a workspace reference from a Directory project config (on-disk).
pub fn remove_workspace_from_directory_project(
    project_path: &Path,
    ws_id: &str,
) -> Result<(), AppError> {
    let mut config = read_directory_project_config(project_path)?;
    config.workspaces.retain(|w| w.id != ws_id);
    write_directory_project_config(project_path, &config)
}

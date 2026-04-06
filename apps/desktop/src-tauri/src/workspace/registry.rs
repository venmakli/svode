use std::path::Path;

use crate::error::AppError;

use super::types::{WorkspaceRef, WorkspaceRegistry};

/// Read the workspace registry from config_dir/workspaces.json, creating defaults if missing.
pub fn read_registry(config_dir: &Path) -> Result<WorkspaceRegistry, AppError> {
    let path = config_dir.join("workspaces.json");
    if !path.exists() {
        let registry = WorkspaceRegistry::default();
        write_registry(config_dir, &registry)?;
        return Ok(registry);
    }
    let data = std::fs::read_to_string(&path)?;
    Ok(serde_json::from_str(&data)?)
}

/// Write the workspace registry to config_dir/workspaces.json.
pub fn write_registry(config_dir: &Path, registry: &WorkspaceRegistry) -> Result<(), AppError> {
    std::fs::create_dir_all(config_dir)?;
    let data = serde_json::to_string_pretty(registry)?;
    std::fs::write(config_dir.join("workspaces.json"), data)?;
    Ok(())
}

/// Add a workspace reference to the registry.
pub fn add_workspace(config_dir: &Path, id: &str, path: &str) -> Result<(), AppError> {
    let mut registry = read_registry(config_dir)?;
    if !registry.workspaces.iter().any(|w| w.id == id) {
        registry.workspaces.push(WorkspaceRef {
            id: id.to_string(),
            last_opened: None,
            path: path.to_string(),
        });
    }
    write_registry(config_dir, &registry)
}

/// Find a workspace ref by id.
pub fn find_workspace(config_dir: &Path, id: &str) -> Result<Option<WorkspaceRef>, AppError> {
    let registry = read_registry(config_dir)?;
    Ok(registry.workspaces.iter().find(|w| w.id == id).cloned())
}

/// Remove a workspace reference from the registry.
pub fn remove_workspace(config_dir: &Path, id: &str) -> Result<(), AppError> {
    let mut registry = read_registry(config_dir)?;
    registry.workspaces.retain(|w| w.id != id);
    if registry.last_active.as_deref() == Some(id) {
        registry.last_active = None;
    }
    write_registry(config_dir, &registry)
}

/// Set the last active workspace in the registry.
pub fn update_last_active(config_dir: &Path, id: &str) -> Result<(), AppError> {
    let mut registry = read_registry(config_dir)?;
    registry.last_active = Some(id.to_string());
    write_registry(config_dir, &registry)
}

/// Update the last_opened timestamp on a workspace reference.
pub fn update_last_opened(config_dir: &Path, id: &str) -> Result<(), AppError> {
    let mut registry = read_registry(config_dir)?;
    let now = chrono::Utc::now().to_rfc3339();
    if let Some(ws) = registry.workspaces.iter_mut().find(|w| w.id == id) {
        ws.last_opened = Some(now);
    }
    write_registry(config_dir, &registry)
}

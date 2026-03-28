use std::path::Path;

use crate::error::AppError;

use super::types::{ProjectRef, ProjectRegistry};

/// Read the project registry from config_dir/projects.json, creating defaults if missing.
pub fn read_registry(config_dir: &Path) -> Result<ProjectRegistry, AppError> {
    let path = config_dir.join("projects.json");
    if !path.exists() {
        let registry = ProjectRegistry::default();
        write_registry(config_dir, &registry)?;
        return Ok(registry);
    }
    let data = std::fs::read_to_string(&path)?;
    Ok(serde_json::from_str(&data)?)
}

/// Write the project registry to config_dir/projects.json.
pub fn write_registry(config_dir: &Path, registry: &ProjectRegistry) -> Result<(), AppError> {
    std::fs::create_dir_all(config_dir)?;
    let data = serde_json::to_string_pretty(registry)?;
    std::fs::write(config_dir.join("projects.json"), data)?;
    Ok(())
}

/// Add a project reference to the registry.
pub fn add_project(config_dir: &Path, id: &str) -> Result<(), AppError> {
    let mut registry = read_registry(config_dir)?;
    // Avoid duplicates
    if !registry.projects.iter().any(|p| p.id == id) {
        registry.projects.push(ProjectRef {
            id: id.to_string(),
            last_opened: None,
            path: None,
        });
    }
    write_registry(config_dir, &registry)
}

/// Add a directory project reference (with path) to the registry.
pub fn add_directory_project(
    config_dir: &Path,
    id: &str,
    path: &str,
) -> Result<(), AppError> {
    let mut registry = read_registry(config_dir)?;
    // Avoid duplicates
    if !registry.projects.iter().any(|p| p.id == id) {
        registry.projects.push(ProjectRef {
            id: id.to_string(),
            last_opened: None,
            path: Some(path.to_string()),
        });
    }
    write_registry(config_dir, &registry)
}

/// Find a project ref by id.
pub fn find_project(config_dir: &Path, id: &str) -> Result<Option<ProjectRef>, AppError> {
    let registry = read_registry(config_dir)?;
    Ok(registry.projects.iter().find(|p| p.id == id).cloned())
}

/// Remove a project reference from the registry.
pub fn remove_project(config_dir: &Path, id: &str) -> Result<(), AppError> {
    let mut registry = read_registry(config_dir)?;
    registry.projects.retain(|p| p.id != id);
    // Clear last_active if it was the removed project
    if registry.last_active.as_deref() == Some(id) {
        registry.last_active = None;
    }
    write_registry(config_dir, &registry)
}

/// Set the last active project in the registry.
pub fn update_last_active(config_dir: &Path, id: &str) -> Result<(), AppError> {
    let mut registry = read_registry(config_dir)?;
    registry.last_active = Some(id.to_string());
    write_registry(config_dir, &registry)
}

/// Update the last_opened timestamp on a project reference.
pub fn update_last_opened(config_dir: &Path, id: &str) -> Result<(), AppError> {
    let mut registry = read_registry(config_dir)?;
    let now = chrono::Utc::now().to_rfc3339();
    if let Some(project) = registry.projects.iter_mut().find(|p| p.id == id) {
        project.last_opened = Some(now);
    }
    write_registry(config_dir, &registry)
}

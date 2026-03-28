use std::path::Path;

use crate::error::AppError;

use super::config::write_workspace_config;
use super::types::{LocalConfig, ProjectConfig, ProjectDefaults, WorkspaceConfig};

/// Scaffold a new workspace at the given path.
/// Creates .combai/config.json and .combai/local.json.
pub fn scaffold_workspace(path: &Path, name: &str) -> Result<WorkspaceConfig, AppError> {
    let combai_dir = path.join(".combai");
    std::fs::create_dir_all(&combai_dir)?;

    // Workspace config
    let ws_config = WorkspaceConfig {
        type_: Some("workspace".to_string()),
        name: name.to_string(),
        description: String::new(),
        icon: "\u{1F4C2}".to_string(),
        agent: None,
    };
    write_workspace_config(path, &ws_config)?;

    // Local config
    let local_config = LocalConfig::default();
    let local_data = serde_json::to_string_pretty(&local_config)?;
    std::fs::write(combai_dir.join("local.json"), local_data)?;

    Ok(ws_config)
}

/// Scaffold a Directory project inside an existing folder.
/// Creates .combai/config.json with type=project, variant=directory.
pub fn scaffold_directory_project(
    path: &Path,
    name: &str,
    description: &str,
    icon: &str,
) -> Result<ProjectConfig, AppError> {
    if !path.exists() || !path.is_dir() {
        return Err(AppError::PathNotAccessible(
            path.to_string_lossy().to_string(),
        ));
    }

    let combai_dir = path.join(".combai");
    let config_path = combai_dir.join("config.json");

    // Check if a project config already exists
    if config_path.exists() {
        let data = std::fs::read_to_string(&config_path)?;
        let existing: serde_json::Value = serde_json::from_str(&data)?;
        if existing.get("type").and_then(|v| v.as_str()) == Some("project") {
            return Err(AppError::FileAlreadyExists(
                config_path.to_string_lossy().to_string(),
            ));
        }
    }

    std::fs::create_dir_all(&combai_dir)?;

    let config = ProjectConfig {
        type_: Some("project".to_string()),
        variant: Some("directory".to_string()),
        name: name.to_string(),
        description: description.to_string(),
        icon: icon.to_string(),
        workspaces: Vec::new(),
        defaults: ProjectDefaults::default(),
    };

    let data = serde_json::to_string_pretty(&config)?;
    std::fs::write(&config_path, data)?;

    Ok(config)
}

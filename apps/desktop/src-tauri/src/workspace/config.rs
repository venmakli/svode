use std::path::Path;

use crate::error::AppError;

use super::types::{LocalConfig, WorkspaceConfig};

/// Read workspace config from {workspace_path}/.combai/config.json.
pub fn read_workspace_config(path: &Path) -> Result<WorkspaceConfig, AppError> {
    let config_path = path.join(".combai").join("config.json");
    if !config_path.exists() {
        return Err(AppError::FileNotFound(
            config_path.to_string_lossy().to_string(),
        ));
    }
    let data = std::fs::read_to_string(&config_path)?;
    Ok(serde_json::from_str(&data)?)
}

/// Write workspace config to {workspace_path}/.combai/config.json.
pub fn write_workspace_config(path: &Path, config: &WorkspaceConfig) -> Result<(), AppError> {
    let dir = path.join(".combai");
    std::fs::create_dir_all(&dir)?;
    let data = serde_json::to_string_pretty(config)?;
    std::fs::write(dir.join("config.json"), data)?;
    Ok(())
}

/// Read local config from {workspace_path}/.combai/local.json.
pub fn read_local_config(path: &Path) -> Result<LocalConfig, AppError> {
    let config_path = path.join(".combai").join("local.json");
    if !config_path.exists() {
        return Ok(LocalConfig::default());
    }
    let data = std::fs::read_to_string(&config_path)?;
    Ok(serde_json::from_str(&data)?)
}

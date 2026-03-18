use std::path::Path;

use crate::error::AppError;

use super::config::write_workspace_config;
use super::types::{LocalConfig, WorkspaceConfig};

/// Scaffold a new workspace at the given path.
/// Creates .combai/config.json and .combai/local.json.
pub fn scaffold_workspace(path: &Path, name: &str) -> Result<WorkspaceConfig, AppError> {
    let combai_dir = path.join(".combai");
    std::fs::create_dir_all(&combai_dir)?;

    // Workspace config
    let ws_config = WorkspaceConfig {
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

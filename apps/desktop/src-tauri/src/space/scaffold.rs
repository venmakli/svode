use std::path::Path;

use crate::error::AppError;

use super::config::write_space_config;
use super::types::SpaceConfig;

/// Scaffold a new space at the given path.
/// Creates .combai/config.json and supporting files.
/// Used for both root spaces and child spaces.
pub fn scaffold_space(
    path: &Path,
    name: &str,
    icon: &str,
    description: &str,
) -> Result<SpaceConfig, AppError> {
    let combai_dir = path.join(".combai");
    std::fs::create_dir_all(&combai_dir)?;

    let sp_config = SpaceConfig {
        name: name.to_string(),
        description: description.to_string(),
        icon: if icon.is_empty() {
            "\u{1F4C1}".to_string()
        } else {
            icon.to_string()
        },
        spaces: None,
        agent: None,
        defaults: None,
        git: None,
        assets: None,
    };
    write_space_config(path, &sp_config)?;

    // Local config
    let local_config = super::types::LocalConfig::default();
    let local_data = serde_json::to_string_pretty(&local_config)?;
    std::fs::write(combai_dir.join("local.json"), local_data)?;

    // AGENTS.md (only if not exists)
    let agents_md_path = combai_dir.join("AGENTS.md");
    if !agents_md_path.exists() {
        std::fs::write(
            &agents_md_path,
            "# Agent Instructions\n\n- Follow project conventions\n- Write clean, documented code\n",
        )?;
    }

    // mcp.json (only if not exists)
    let mcp_json_path = combai_dir.join("mcp.json");
    if !mcp_json_path.exists() {
        std::fs::write(&mcp_json_path, "{ \"mcpServers\": {} }")?;
    }

    // skills/ directory (only if not exists)
    let skills_dir = combai_dir.join("skills");
    if !skills_dir.exists() {
        std::fs::create_dir_all(&skills_dir)?;
    }

    // agents/ directory (only if not exists)
    let agents_dir = combai_dir.join("agents");
    if !agents_dir.exists() {
        std::fs::create_dir_all(&agents_dir)?;
    }

    Ok(sp_config)
}

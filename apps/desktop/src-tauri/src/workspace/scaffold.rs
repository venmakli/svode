use std::path::Path;

use crate::error::AppError;

use super::config::write_workspace_config;
use super::types::{LocalConfig, WorkspaceConfig};

/// Scaffold a new workspace at the given path.
/// Creates .combai/config.json, .combai/local.json, AGENTS.md, and welcome.md.
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

    // AGENTS.md
    let agents_content = "# Agents\n\nConfigure AI agents for this workspace.\n\n## Default Agent\n\n- Model: (not configured)\n- Instructions: (none)\n";
    std::fs::write(path.join("AGENTS.md"), agents_content)?;

    // welcome.md with YAML frontmatter
    let welcome_id = ulid::Ulid::new().to_string().to_lowercase();
    let now = chrono::Utc::now().to_rfc3339();
    let welcome_content = format!(
        "---\nid: {welcome_id}\ntitle: Welcome\ncreated: \"{now}\"\nupdated: \"{now}\"\n---\n\n# Welcome\n\nThis is your new workspace. Start adding documents, tasks, and more.\n"
    );
    std::fs::write(path.join("welcome.md"), welcome_content)?;

    Ok(ws_config)
}

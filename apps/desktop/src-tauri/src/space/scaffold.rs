use std::path::Path;

use crate::error::AppError;

use super::config::write_space_config;
use super::types::SpaceConfig;

/// Scaffold a new space at the given path.
/// Creates .svode/config.json and .svode/local.json.
/// Used for both root spaces and child spaces.
pub fn scaffold_space(
    path: &Path,
    name: &str,
    icon: &str,
    description: &str,
) -> Result<SpaceConfig, AppError> {
    let svode_dir = path.join(".svode");
    std::fs::create_dir_all(&svode_dir)?;

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
    std::fs::write(svode_dir.join("local.json"), local_data)?;

    Ok(sp_config)
}

#[cfg(test)]
mod tests {
    use super::scaffold_space;

    #[test]
    fn scaffold_creates_only_stage_5_default_svode_files() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let space_path = temp_dir.path();

        scaffold_space(space_path, "Stage 5", "", "").expect("scaffold space");

        let svode_dir = space_path.join(".svode");
        assert!(svode_dir.join("config.json").is_file());
        assert!(svode_dir.join("local.json").is_file());
        assert!(!svode_dir.join("AGENTS.md").exists());
        assert!(!svode_dir.join("mcp.json").exists());
        assert!(!svode_dir.join("skills").exists());
        assert!(!svode_dir.join("agents").exists());
    }

    #[test]
    fn scaffold_preserves_existing_legacy_agent_artifacts() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let space_path = temp_dir.path();
        let svode_dir = space_path.join(".svode");
        std::fs::create_dir_all(svode_dir.join("skills")).expect("skills dir");
        std::fs::create_dir_all(svode_dir.join("agents")).expect("agents dir");
        std::fs::write(svode_dir.join("AGENTS.md"), "legacy instructions").expect("agents md");
        std::fs::write(svode_dir.join("mcp.json"), "{ \"legacy\": true }").expect("mcp json");

        scaffold_space(space_path, "Stage 5", "", "").expect("scaffold space");

        assert_eq!(
            std::fs::read_to_string(svode_dir.join("AGENTS.md")).expect("read agents md"),
            "legacy instructions"
        );
        assert_eq!(
            std::fs::read_to_string(svode_dir.join("mcp.json")).expect("read mcp json"),
            "{ \"legacy\": true }"
        );
        assert!(svode_dir.join("skills").is_dir());
        assert!(svode_dir.join("agents").is_dir());
    }
}

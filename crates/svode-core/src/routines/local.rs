use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalConfig {
    #[serde(default)]
    pub agent: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git: Option<GitUserPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routines: Option<RoutinesLocalConfig>,
    #[serde(flatten)]
    pub extensions: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoutinesLocalConfig {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub automatic_authority: BTreeMap<String, bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storage_generation: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery: Option<RoutinesRecoveryLocalConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoutinesRecoveryLocalConfig {
    pub reason: String,
    pub observed_at: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub quarantine_files: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitUserPolicy {
    #[serde(default)]
    pub auto_sync: bool,
    #[serde(default)]
    pub auto_commit_structural: bool,
    #[serde(default)]
    pub auto_commit_system: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum LocalConfigError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("Storage: {0}")]
    Storage(#[from] crate::variables::Error),
}

/// Keys that moved to the Project navigation state. Nothing reads them, and
/// the next ordinary write of `local.json` drops them.
const DROPPED_KEYS: &[&str] = &["agentSessions", "expandedPaths"];

pub fn read(path: &Path) -> Result<LocalConfig, LocalConfigError> {
    let config_path = path.join(".svode").join("local.json");
    if !config_path.exists() {
        return Ok(LocalConfig::default());
    }
    let data = std::fs::read_to_string(config_path)?;
    let mut local: LocalConfig = serde_json::from_str(&data)?;
    for key in DROPPED_KEYS {
        local.extensions.remove(*key);
    }
    Ok(local)
}

pub fn mutate<T>(
    path: &Path,
    operation: impl FnOnce(&mut LocalConfig) -> Result<T, LocalConfigError>,
) -> Result<T, LocalConfigError> {
    mutate_with(path, operation)
}

pub fn mutate_with<T, E>(
    path: &Path,
    operation: impl FnOnce(&mut LocalConfig) -> Result<T, E>,
) -> Result<T, E>
where
    E: From<LocalConfigError>,
{
    let directory = path.join(".svode");
    let _guard = crate::variables::files::lock(&directory)
        .map_err(LocalConfigError::from)
        .map_err(E::from)?;
    crate::variables::files::check_pending(&directory)
        .map_err(LocalConfigError::from)
        .map_err(E::from)?;
    let mut local = read(path).map_err(E::from)?;
    let result = operation(&mut local)?;
    crate::variables::files::write_preserving_variables(
        &directory.join("local.json"),
        &serde_json::to_value(local)
            .map_err(LocalConfigError::from)
            .map_err(E::from)?,
    )
    .map_err(LocalConfigError::from)
    .map_err(E::from)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_write_drops_keys_moved_to_navigation_state() {
        let temp = tempfile::tempdir().expect("temp dir");
        let directory = temp.path().join(".svode");
        std::fs::create_dir_all(&directory).expect("svode dir");
        std::fs::write(
            directory.join("local.json"),
            serde_json::to_vec(&serde_json::json!({
                "agentSessions": { "pinnedSessionIds": ["codex:one"] },
                "expandedPaths": ["notes"],
                "custom": true,
                "variables": { "TOKEN": { "kind": "ordinary", "value": "x" } }
            }))
            .expect("json"),
        )
        .expect("write legacy local config");

        let local = read(temp.path()).expect("read local config");
        assert!(!local.extensions.contains_key("agentSessions"));
        assert!(!local.extensions.contains_key("expandedPaths"));

        mutate(temp.path(), |local| {
            local.git = Some(GitUserPolicy::default());
            Ok(())
        })
        .expect("ordinary write");

        let written: serde_json::Value = serde_json::from_slice(
            &std::fs::read(directory.join("local.json")).expect("read written"),
        )
        .expect("written json");
        assert!(written.get("agentSessions").is_none());
        assert!(written.get("expandedPaths").is_none());
        assert_eq!(written["custom"], serde_json::json!(true));
        assert!(written.get("variables").is_some());
        assert!(written.get("git").is_some());
    }
}

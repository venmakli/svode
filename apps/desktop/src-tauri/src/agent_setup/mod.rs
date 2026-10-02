//! Desktop host of agent setup: the device-local adapter directory in the
//! app data and the user's enable choices in the app config. Rules and
//! installation belong to `svode_agents::adapters`.

pub mod commands;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use svode_agents::adapters::{AdapterStore, RegistryPackageSource};
use svode_core::agent_adapters::AgentAdapterKind;

use crate::error::AppError;

const ENABLEMENT_FILE: &str = "agents.json";

pub struct AgentSetupState {
    store: AdapterStore,
    source: RegistryPackageSource,
    config_dir: PathBuf,
    /// Serializes read-modify-write of the enable choices.
    choices: Mutex<()>,
}

impl AgentSetupState {
    pub fn new(data_dir: &Path, config_dir: PathBuf) -> Self {
        Self {
            store: AdapterStore::new(data_dir.join("agent-adapters")),
            source: RegistryPackageSource::new(),
            config_dir,
            choices: Mutex::new(()),
        }
    }

    fn choice(&self, agent: AgentAdapterKind) -> Option<bool> {
        read_choices(&self.config_dir)
            .unwrap_or_else(|error| {
                tracing::warn!("agent enable choices are unreadable: {error}");
                BTreeMap::new()
            })
            .get(agent.as_str())
            .copied()
    }

    fn set_choice(&self, agent: AgentAdapterKind, enabled: bool) -> Result<(), AppError> {
        let _guard = self.choices.lock().unwrap();
        write_choice(&self.config_dir, agent.as_str(), enabled)
    }
}

/// `agents.json`: `{ "agents": { "<agent id>": { "enabled": bool } } }`.
/// Entries of ids this build does not know are kept.
fn read_choices(config_dir: &Path) -> Result<BTreeMap<String, bool>, AppError> {
    let Some(value) = read_file(config_dir)? else {
        return Ok(BTreeMap::new());
    };
    Ok(value
        .get("agents")
        .and_then(serde_json::Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(id, agent)| Some((id.clone(), agent.get("enabled")?.as_bool()?)))
        .collect())
}

fn write_choice(config_dir: &Path, agent: &str, enabled: bool) -> Result<(), AppError> {
    let mut value = read_file(config_dir)?.unwrap_or_else(|| serde_json::json!({}));
    let root = value
        .as_object_mut()
        .ok_or_else(|| AppError::General(format!("{ENABLEMENT_FILE} must be an object")))?;
    let agents = root
        .entry("agents")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| AppError::General(format!("{ENABLEMENT_FILE} agents must be an object")))?;
    let entry = agents.entry(agent).or_insert_with(|| serde_json::json!({}));
    if !entry.is_object() {
        *entry = serde_json::json!({});
    }
    entry["enabled"] = serde_json::Value::Bool(enabled);
    std::fs::create_dir_all(config_dir)?;
    let staged = tempfile::NamedTempFile::new_in(config_dir)?;
    serde_json::to_writer_pretty(staged.as_file(), &value)?;
    staged.as_file().sync_all()?;
    staged
        .persist(config_dir.join(ENABLEMENT_FILE))
        .map_err(|error| AppError::Io(error.error))?;
    Ok(())
}

fn read_file(config_dir: &Path) -> Result<Option<serde_json::Value>, AppError> {
    match std::fs::read(config_dir.join(ENABLEMENT_FILE)) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enable_choices_round_trip_and_keep_unknown_agents() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_choices(dir.path()).unwrap().is_empty());
        std::fs::write(
            dir.path().join(ENABLEMENT_FILE),
            r#"{"agents":{"future-agent":{"enabled":false,"extra":1}},"other":true}"#,
        )
        .unwrap();

        write_choice(dir.path(), "codex", true).unwrap();
        write_choice(dir.path(), "claude-code", false).unwrap();
        write_choice(dir.path(), "codex", false).unwrap();

        let choices = read_choices(dir.path()).unwrap();
        assert_eq!(choices.get("codex"), Some(&false));
        assert_eq!(choices.get("claude-code"), Some(&false));
        assert_eq!(choices.get("future-agent"), Some(&false));
        let value = read_file(dir.path()).unwrap().unwrap();
        assert_eq!(value["agents"]["future-agent"]["extra"], 1);
        assert_eq!(value["other"], true);
    }

    #[test]
    fn a_malformed_file_is_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(ENABLEMENT_FILE), "{not json").unwrap();
        assert!(write_choice(dir.path(), "codex", true).is_err());
        assert_eq!(
            std::fs::read_to_string(dir.path().join(ENABLEMENT_FILE)).unwrap(),
            "{not json"
        );
    }
}

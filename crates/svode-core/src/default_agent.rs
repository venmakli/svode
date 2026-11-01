//! The default agent of this device: one agent with the values of all its
//! settings, the mode included, for every project. A new chat draft starts
//! with it, and an Actor bound to the participant's agent runs with it.
//!
//! It lives in a device directory the host chooses, outside every project
//! and Git. Any agent the chat offers may be the default agent, a custom
//! agent of this device included.

use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::agent_actors::{AgentSettingValue, validate_settings};
use crate::agent_adapters::AgentId;

const FILE_NAME: &str = "default-agent.json";
const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DefaultAgent {
    pub agent: AgentId,
    /// Values in the agent's terms; a missing setting is its native default.
    #[serde(default)]
    pub settings: Vec<AgentSettingValue>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DefaultAgentFile {
    schema_version: u32,
    /// `None`: no default agent is chosen on this device.
    default_agent: Option<DefaultAgent>,
}

#[derive(Debug, thiserror::Error)]
pub enum DefaultAgentError {
    #[error("default agent file is unreadable: {0}")]
    Io(#[from] std::io::Error),
    #[error("default agent is invalid: {0}")]
    Invalid(String),
    #[error("default agent file has unknown schema version {0}")]
    UnknownSchema(u32),
}

pub fn file_path(directory: &Path) -> PathBuf {
    directory.join(FILE_NAME)
}

/// The default agent of the device; `None` when none is chosen or the
/// device has not stored one yet.
pub fn read(directory: &Path) -> Result<Option<DefaultAgent>, DefaultAgentError> {
    let bytes = match fs::read(file_path(directory)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|error| DefaultAgentError::Invalid(error.to_string()))?;
    let version = value
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| DefaultAgentError::Invalid("missing schemaVersion".into()))?;
    if version != u64::from(SCHEMA_VERSION) {
        return Err(DefaultAgentError::UnknownSchema(
            u32::try_from(version).unwrap_or(u32::MAX),
        ));
    }
    let file: DefaultAgentFile = serde_json::from_value(value)
        .map_err(|error| DefaultAgentError::Invalid(error.to_string()))?;
    if let Some(default) = &file.default_agent {
        validate_settings(&default.settings).map_err(DefaultAgentError::Invalid)?;
    }
    Ok(file.default_agent)
}

/// Chooses the default agent of the device, or clears it with `None`.
pub fn write(directory: &Path, default: Option<&DefaultAgent>) -> Result<(), DefaultAgentError> {
    if let Some(default) = default {
        validate_settings(&default.settings).map_err(DefaultAgentError::Invalid)?;
    }
    write_file(directory, default.cloned())
}

/// The initial value after the update that introduced the default agent:
/// the agent the chat remembered as last used, without setting values, or
/// no default agent. Runs only while the device has stored none, so a later
/// last used agent never changes the choice. Returns whether it wrote.
pub fn seed(directory: &Path, last_used: Option<&str>) -> Result<bool, DefaultAgentError> {
    if fs::symlink_metadata(file_path(directory)).is_ok() {
        return Ok(false);
    }
    let default = last_used
        .and_then(|agent| AgentId::parse(agent).ok())
        .map(|agent| DefaultAgent {
            agent,
            settings: Vec::new(),
        });
    write_file(directory, default)?;
    Ok(true)
}

fn write_file(directory: &Path, default: Option<DefaultAgent>) -> Result<(), DefaultAgentError> {
    fs::create_dir_all(directory)?;
    let bytes = serde_json::to_vec_pretty(&DefaultAgentFile {
        schema_version: SCHEMA_VERSION,
        default_agent: default,
    })
    .map_err(|error| DefaultAgentError::Invalid(error.to_string()))?;
    let mut file = tempfile::Builder::new()
        .prefix(".default-agent-")
        .tempfile_in(directory)?;
    file.write_all(&bytes)?;
    file.as_file().sync_all()?;
    file.persist(file_path(directory))
        .map_err(|error| DefaultAgentError::Io(error.error))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn value(setting: &str, value: &str) -> AgentSettingValue {
        AgentSettingValue {
            setting: setting.into(),
            value: value.into(),
        }
    }

    #[test]
    fn the_initial_value_is_the_last_used_chat_agent_without_values_and_is_stored_once() {
        let device = tempdir().unwrap();
        assert_eq!(read(device.path()).unwrap(), None);

        assert!(seed(device.path(), Some("claude-code")).unwrap());
        let seeded = DefaultAgent {
            agent: AgentId::parse("claude-code").unwrap(),
            settings: Vec::new(),
        };
        assert_eq!(read(device.path()).unwrap(), Some(seeded.clone()));
        // A later last used agent does not change the choice.
        assert!(!seed(device.path(), Some("codex")).unwrap());
        assert_eq!(read(device.path()).unwrap(), Some(seeded));

        let none = tempdir().unwrap();
        assert!(seed(none.path(), None).unwrap());
        assert_eq!(read(none.path()).unwrap(), None);
        assert!(!seed(none.path(), Some("codex")).unwrap());
        assert_eq!(read(none.path()).unwrap(), None);
    }

    #[test]
    fn the_default_agent_keeps_every_value_its_mode_included_and_may_be_custom() {
        let device = tempdir().unwrap();
        let default = DefaultAgent {
            agent: AgentId::parse("custom-hermes").unwrap(),
            settings: vec![
                value("model", "openai-codex:gpt"),
                value("mode", "accept_edits"),
            ],
        };
        write(device.path(), Some(&default)).unwrap();
        assert_eq!(read(device.path()).unwrap(), Some(default));
        write(device.path(), None).unwrap();
        assert_eq!(read(device.path()).unwrap(), None);
        assert!(file_path(device.path()).exists());
    }

    #[test]
    fn a_repeated_setting_unknown_field_or_newer_schema_is_refused() {
        let device = tempdir().unwrap();
        let repeated = DefaultAgent {
            agent: AgentId::parse("codex").unwrap(),
            settings: vec![value("model", "a"), value("model", "b")],
        };
        assert!(matches!(
            write(device.path(), Some(&repeated)),
            Err(DefaultAgentError::Invalid(_))
        ));
        assert!(!file_path(device.path()).exists());

        fs::write(
            file_path(device.path()),
            r#"{"schemaVersion":1,"defaultAgent":null,"future":true}"#,
        )
        .unwrap();
        assert!(matches!(
            read(device.path()),
            Err(DefaultAgentError::Invalid(_))
        ));
        fs::write(
            file_path(device.path()),
            r#"{"schemaVersion":2,"defaultAgent":null}"#,
        )
        .unwrap();
        assert!(matches!(
            read(device.path()),
            Err(DefaultAgentError::UnknownSchema(2))
        ));
    }

    #[test]
    fn the_file_lives_in_the_device_directory_not_in_a_project() {
        let device = tempdir().unwrap();
        let project = tempdir().unwrap();
        write(
            device.path(),
            Some(&DefaultAgent {
                agent: AgentId::parse("codex").unwrap(),
                settings: Vec::new(),
            }),
        )
        .unwrap();
        assert!(file_path(device.path()).starts_with(device.path()));
        assert_eq!(fs::read_dir(project.path()).unwrap().count(), 0);
    }
}

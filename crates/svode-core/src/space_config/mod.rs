//! Portable configuration of a Project or Space in `.svode/config.json`.
//!
//! The file is shared through Git by Svode versions of different ages. A
//! version keeps every key it does not know, with its value as is, at every
//! level of the structure it knows: each such level carries the keys in its
//! `extensions`. A write takes those keys from the file at write time, under
//! the `.svode` lock, so neither a copy read earlier nor one that went through
//! a frontend can drop a key another version or a sync added meanwhile.
//! Entries of `spaces` are matched by `id`; removing a known object or entry
//! removes the keys inside it. The `variables` section belongs to Variables,
//! which writes it itself.
//!
//! A file that exists but cannot be read is never replaced: every write
//! refuses with the reason, and only a missing file is created anew.

use std::collections::BTreeMap;
use std::path::Path;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::storage::config::AssetsSpaceConfig;
use crate::variables::files;

/// Keys a version of Svode does not know, kept with their values as is.
pub type UnknownKeys = BTreeMap<String, Value>;

/// The section of the file that Variables owns and writes.
const VARIABLES_KEY: &str = "variables";

#[derive(Debug, thiserror::Error)]
pub enum SpaceConfigError {
    #[error("File not found: {0}")]
    Missing(String),
    #[error(".svode/config.json cannot be read: {0}")]
    Unreadable(Unreadable),
    #[error(".svode/config.json already exists")]
    Exists,
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("Storage: {0}")]
    Storage(#[from] crate::variables::Error),
}

/// Why an existing `.svode/config.json` cannot be read. It names neither the
/// path nor the contents of the file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Unreadable {
    /// The file holds the markers of a merge conflict.
    Conflict,
    /// The file is not a JSON object.
    NotJson,
    /// The file is a JSON object, but this field does not read as config.
    Field { field: String },
    /// The file cannot be opened.
    Access,
}

impl std::fmt::Display for Unreadable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Conflict => f.write_str("it is in a conflict after sync"),
            Self::NotJson => f.write_str("it is not JSON"),
            Self::Field { field } => write!(f, "Svode cannot read the field `{field}`"),
            Self::Access => f.write_str("access to it is denied"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceConfig {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_icon")]
    pub icon: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spaces: Option<Vec<SpaceRef>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub defaults: Option<SpaceDefaults>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git: Option<GitSpaceConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assets: Option<AssetsSpaceConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tree: Option<TreeSpaceConfig>,
    #[serde(flatten)]
    pub extensions: UnknownKeys,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TreeSpaceConfig {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exclude: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub include: Vec<String>,
    #[serde(default)]
    pub show_ignored_placeholders: bool,
    #[serde(flatten)]
    pub extensions: UnknownKeys,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSpaceConfig {
    /// Legacy per-user policy fields. Kept for backward-compatible parsing of
    /// older shared `.svode/config.json` files, but ignored as effective policy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_sync: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_commit_structural: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_commit_system: Option<bool>,
}

fn default_icon() -> String {
    "\u{1F4C1}".to_string()
}

impl SpaceConfig {
    /// The config in memory of a project or space whose file cannot be read:
    /// nothing but its name.
    pub fn named(name: &str) -> Self {
        Self {
            name: name.to_string(),
            description: String::new(),
            icon: String::new(),
            spaces: None,
            agent: None,
            defaults: None,
            git: None,
            assets: None,
            tree: None,
            extensions: UnknownKeys::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpaceRef {
    pub id: String,
    pub path: String,
    pub repo: Option<String>,
    #[serde(flatten)]
    pub extensions: UnknownKeys,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clis: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_timeout: Option<u32>,
    #[serde(flatten)]
    pub extensions: UnknownKeys,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceDefaults {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentConfig>,
    #[serde(flatten)]
    pub extensions: UnknownKeys,
}

/// Read the config of `space`. The `variables` section is left out: it is
/// not part of this model and every write keeps it as it is in the file.
pub fn read(space: &Path) -> Result<SpaceConfig, SpaceConfigError> {
    let path = space.join(".svode").join("config.json");
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(SpaceConfigError::Missing(
                path.to_string_lossy().to_string(),
            ));
        }
        Err(_) => return Err(SpaceConfigError::Unreadable(Unreadable::Access)),
    };
    let mut config = parse(&bytes).map_err(SpaceConfigError::Unreadable)?;
    config.extensions.remove(VARIABLES_KEY);
    Ok(config)
}

fn parse(bytes: &[u8]) -> Result<SpaceConfig, Unreadable> {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return Err(Unreadable::NotJson);
    };
    let error = match serde_json::from_str::<SpaceConfig>(text) {
        Ok(config) => return Ok(config),
        Err(error) => error,
    };
    if has_conflict_markers(text) {
        return Err(Unreadable::Conflict);
    }
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(object)) => Err(Unreadable::Field {
            field: unreadable_field(&object, &error),
        }),
        _ => Err(Unreadable::NotJson),
    }
}

fn has_conflict_markers(text: &str) -> bool {
    text.lines().any(|line| line.starts_with("<<<<<<<"))
        && text.lines().any(|line| line.starts_with(">>>>>>>"))
}

/// The first known field whose value does not read as its type; otherwise
/// the missing or repeated field serde names.
fn unreadable_field(object: &serde_json::Map<String, Value>, error: &serde_json::Error) -> String {
    fn reads<T: DeserializeOwned>(value: &Value) -> bool {
        T::deserialize(value).is_ok()
    }
    let fields: [(&str, fn(&Value) -> bool); 9] = [
        ("name", reads::<String>),
        ("description", reads::<String>),
        ("icon", reads::<String>),
        ("spaces", reads::<Option<Vec<SpaceRef>>>),
        ("agent", reads::<Option<AgentConfig>>),
        ("defaults", reads::<Option<SpaceDefaults>>),
        ("git", reads::<Option<GitSpaceConfig>>),
        ("assets", reads::<Option<AssetsSpaceConfig>>),
        ("tree", reads::<Option<TreeSpaceConfig>>),
    ];
    if let Some((field, _)) = fields
        .iter()
        .find(|(field, reads)| object.get(*field).is_some_and(|value| !reads(value)))
    {
        return (*field).to_string();
    }
    let message = error.to_string();
    ["missing field `", "duplicate field `"]
        .iter()
        .find_map(|prefix| {
            let rest = message.strip_prefix(prefix)?;
            Some(rest[..rest.find('`')?].to_string())
        })
        .unwrap_or_default()
}

/// Write `config` over the known fields of the file. The unknown keys come
/// from the file at write time; a missing file has none.
pub fn write(space: &Path, config: &SpaceConfig) -> Result<(), SpaceConfigError> {
    let dir = space.join(".svode");
    let _guard = files::lock(&dir)?;
    files::check_pending(&dir)?;
    let current = if dir.join("config.json").exists() {
        Some(read(space)?)
    } else {
        None
    };
    let mut next = config.clone();
    adopt_unknown_keys(&mut next, current.as_ref());
    persist(&dir, next)
}

/// Read the config under the `.svode` lock, change it and write it back, so
/// both its known fields and its unknown keys are the ones in the file.
pub fn mutate<T, E>(
    space: &Path,
    operation: impl FnOnce(&mut SpaceConfig) -> Result<T, E>,
) -> Result<T, E>
where
    E: From<SpaceConfigError>,
{
    let dir = space.join(".svode");
    let _guard = files::lock(&dir).map_err(SpaceConfigError::from)?;
    files::check_pending(&dir).map_err(SpaceConfigError::from)?;
    let mut config = read(space)?;
    let result = operation(&mut config)?;
    persist(&dir, config)?;
    Ok(result)
}

/// Write the config a scaffold creates. A file that is already there, even
/// one that cannot be read, is left as it is.
pub fn create(space: &Path, config: &SpaceConfig) -> Result<(), SpaceConfigError> {
    let dir = space.join(".svode");
    let _guard = files::lock(&dir)?;
    if dir.join("config.json").symlink_metadata().is_ok() {
        return Err(SpaceConfigError::Exists);
    }
    persist(&dir, config.clone())
}

/// The caller holds the `.svode` lock.
fn persist(dir: &Path, mut config: SpaceConfig) -> Result<(), SpaceConfigError> {
    // Personal Git automation policy is local-only. Older versions stored it in
    // shared config; every shared config write now drops those legacy fields.
    config.git = None;
    files::write_preserving_variables(&dir.join("config.json"), &serde_json::to_value(&config)?)?;
    Ok(())
}

/// Give every level of `next` the unknown keys of the same level in
/// `current`: a level `current` lacks gets none, and an entry of `spaces`
/// is the entry with the same `id`.
fn adopt_unknown_keys(next: &mut SpaceConfig, current: Option<&SpaceConfig>) {
    adopt(&mut next.extensions, current.map(|c| &c.extensions));
    if let Some(spaces) = next.spaces.as_mut() {
        let current = current.and_then(|c| c.spaces.as_ref());
        for space in spaces {
            let same = current.and_then(|entries| entries.iter().find(|e| e.id == space.id));
            adopt(&mut space.extensions, same.map(|e| &e.extensions));
        }
    }
    if let Some(agent) = next.agent.as_mut() {
        adopt_agent(agent, current.and_then(|c| c.agent.as_ref()));
    }
    if let Some(defaults) = next.defaults.as_mut() {
        let current = current.and_then(|c| c.defaults.as_ref());
        adopt(&mut defaults.extensions, current.map(|d| &d.extensions));
        if let Some(agent) = defaults.agent.as_mut() {
            adopt_agent(agent, current.and_then(|d| d.agent.as_ref()));
        }
    }
    if let Some(assets) = next.assets.as_mut() {
        let current = current.and_then(|c| c.assets.as_ref());
        adopt(&mut assets.extensions, current.map(|a| &a.extensions));
        if let Some(routing) = assets.binary_routing.as_mut() {
            let current = current.and_then(|a| a.binary_routing.as_ref());
            adopt(&mut routing.extensions, current.map(|r| &r.extensions));
        }
        if let Some(s3) = assets.s3.as_mut() {
            let current = current.and_then(|a| a.s3.as_ref());
            adopt(&mut s3.extensions, current.map(|s| &s.extensions));
        }
    }
    if let Some(tree) = next.tree.as_mut() {
        let current = current.and_then(|c| c.tree.as_ref());
        adopt(&mut tree.extensions, current.map(|t| &t.extensions));
    }
}

fn adopt_agent(next: &mut AgentConfig, current: Option<&AgentConfig>) {
    adopt(&mut next.extensions, current.map(|a| &a.extensions));
}

fn adopt(next: &mut UnknownKeys, current: Option<&UnknownKeys>) {
    *next = current.cloned().unwrap_or_default();
}

#[cfg(test)]
mod tests;

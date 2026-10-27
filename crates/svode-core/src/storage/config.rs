//! Portable assets configuration stored in a Space `.svode/config.json`.
//!
//! The routing rules, the effective storage scope and managed import all read
//! this model, so it lives with the storage owner rather than with a desktop
//! DTO. Only the assets facts are parsed here; the whole Space config and
//! its write rule belong to `crate::space_config`.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

pub const BINARY_ROUTING_VERSION: u32 = 1;
pub const DEFAULT_LFS_THRESHOLD_BYTES: u64 = 10_000_000;

#[derive(Debug, thiserror::Error)]
pub enum StorageConfigError {
    #[error("File not found: {0}")]
    Missing(String),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Serialization error: {0}")]
    Serde(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(from = "String", into = "String")]
pub enum AssetsStrategy {
    #[default]
    Local,
    InGit,
    LfsRemote,
    LfsS3,
    /// A strategy set by a newer Svode version, kept as written. Operations
    /// whose meaning depends on the strategy refuse it; see
    /// `policy::supported_strategy`.
    Unknown(String),
}

impl AssetsStrategy {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Local => "local",
            Self::InGit => "in-git",
            Self::LfsRemote => "lfs-remote",
            Self::LfsS3 => "lfs-s3",
            Self::Unknown(value) => value,
        }
    }
}

impl From<String> for AssetsStrategy {
    fn from(value: String) -> Self {
        match value.as_str() {
            "local" => Self::Local,
            "in-git" => Self::InGit,
            "lfs-remote" => Self::LfsRemote,
            "lfs-s3" => Self::LfsS3,
            _ => Self::Unknown(value),
        }
    }
}

impl From<AssetsStrategy> for String {
    fn from(strategy: AssetsStrategy) -> Self {
        match strategy {
            AssetsStrategy::Unknown(value) => value,
            known => known.as_str().to_string(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetsSpaceConfig {
    #[serde(default)]
    pub strategy: AssetsStrategy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary_routing: Option<BinaryRoutingConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub s3: Option<AssetsS3Config>,
    #[serde(flatten)]
    pub extensions: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BinaryRoutingConfig {
    pub version: u32,
    #[serde(default)]
    pub lfs_extensions: Vec<String>,
    #[serde(default)]
    pub lfs_threshold_bytes: Option<u64>,
    /// Preserve fields written by a future Svode version even though current
    /// asset mutations fail closed when `version` is unsupported.
    #[serde(flatten)]
    pub extensions: BTreeMap<String, serde_json::Value>,
}

impl BinaryRoutingConfig {
    pub fn new_project_default() -> Self {
        Self {
            version: BINARY_ROUTING_VERSION,
            lfs_extensions: Vec::new(),
            lfs_threshold_bytes: Some(DEFAULT_LFS_THRESHOLD_BYTES),
            extensions: BTreeMap::new(),
        }
    }
}

impl AssetsSpaceConfig {
    pub fn new_project_default() -> Self {
        Self {
            strategy: AssetsStrategy::Local,
            binary_routing: Some(BinaryRoutingConfig::new_project_default()),
            s3: None,
            extensions: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetsS3Config {
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    #[serde(default)]
    pub prefix: String,
    // NOTE: access/secret keys intentionally NOT stored here — they belong in
    // OS keychain (deferred to Phase 4.3).
    #[serde(flatten)]
    pub extensions: BTreeMap<String, serde_json::Value>,
}

/// Git wiring shape of a Space directory inside its Project.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SpaceGitType {
    Inline,
    Independent,
    Submodule,
}

/// The assets facts of one `.svode/config.json`.
#[derive(Debug, Clone, Deserialize)]
pub struct SpaceAssetsConfig {
    pub name: String,
    #[serde(default)]
    pub assets: Option<AssetsSpaceConfig>,
}

/// Read the assets facts of `directory`'s Space config. A missing file is an
/// error, matching the existing Space config read.
pub fn read_space_assets_config(directory: &Path) -> Result<SpaceAssetsConfig, StorageConfigError> {
    let config_path = directory.join(".svode").join("config.json");
    if !config_path.exists() {
        return Err(StorageConfigError::Missing(
            config_path.to_string_lossy().to_string(),
        ));
    }
    let data = std::fs::read_to_string(&config_path)?;
    Ok(serde_json::from_str(&data)?)
}

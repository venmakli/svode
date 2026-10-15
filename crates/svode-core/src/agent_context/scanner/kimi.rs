//! The plugin registry of Kimi Code, `plugins/installed.json` (E02, Kimi
//! Code 2.1.1): the folder and switch of each installed plugin. Only those
//! fields are kept.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::agent_adapters::AgentAdapterKind;

use super::DiscoveryResult;
use super::io::{diagnostic, path_string, read_config_text};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct KimiPlugin {
    pub root: PathBuf,
    pub enabled: bool,
}

#[derive(Deserialize)]
struct Registry {
    #[serde(default)]
    plugins: Vec<Entry>,
}

#[derive(Deserialize)]
struct Entry {
    root: Option<String>,
    enabled: Option<bool>,
}

/// The installed plugins; a relative root lies in the Kimi Code home.
pub(super) fn installed_plugins(
    registry: &Path,
    kimi_home: &Path,
    result: &mut DiscoveryResult,
) -> Vec<KimiPlugin> {
    result.observed_personal_paths.push(path_string(registry));
    let Some(text) = read_config_text(
        registry,
        Some(AgentAdapterKind::KimiCode),
        "kimi_plugin_registry",
        "Kimi Code plugin registry",
        &mut result.diagnostics,
    ) else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<Registry>(&text) else {
        result.diagnostics.push(diagnostic(
            registry,
            Some(AgentAdapterKind::KimiCode),
            "kimi_plugin_registry_parse",
            "Could not parse the Kimi Code plugin registry".to_string(),
        ));
        return Vec::new();
    };
    parsed
        .plugins
        .into_iter()
        .filter_map(|entry| {
            let root = PathBuf::from(entry.root?);
            Some(KimiPlugin {
                root: if root.is_absolute() {
                    root
                } else {
                    kimi_home.join(root)
                },
                enabled: entry.enabled.unwrap_or(true),
            })
        })
        .collect()
}

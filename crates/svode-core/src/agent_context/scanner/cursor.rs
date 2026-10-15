//! `plugins` of the project `.cursor/settings.json` of Cursor, JSON with
//! comments (E02, Cursor CLI 2026.10.01): the plugins the project switches.
//! Only their `enabled` is kept.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Deserialize;

use crate::agent_adapters::AgentAdapterKind;

use super::DiscoveryResult;
use super::io::{diagnostic, path_string, read_config_text};

#[derive(Deserialize)]
struct Settings {
    #[serde(default)]
    plugins: BTreeMap<String, PluginEntry>,
}

#[derive(Deserialize)]
struct PluginEntry {
    enabled: Option<bool>,
}

/// The plugins the project switches, by `<marketplace>/<name>` or `<name>`.
pub(super) fn project_plugins(
    target_root: &Path,
    result: &mut DiscoveryResult,
) -> BTreeMap<String, bool> {
    let path = target_root.join(".cursor/settings.json");
    result.observed_project_paths.push(path_string(&path));
    let Some(text) = read_config_text(
        &path,
        Some(AgentAdapterKind::Cursor),
        "cursor_settings",
        "Cursor project settings",
        &mut result.diagnostics,
    ) else {
        return BTreeMap::new();
    };
    let options = jsonc_parser::ParseOptions::default();
    let settings = match jsonc_parser::parse_to_serde_value::<Option<Settings>>(&text, &options) {
        Ok(Some(settings)) => settings,
        Ok(None) => return BTreeMap::new(),
        Err(_) => {
            // The parser's message may quote the file.
            result.diagnostics.push(diagnostic(
                &path,
                Some(AgentAdapterKind::Cursor),
                "cursor_settings_parse",
                "Could not parse Cursor project settings".to_string(),
            ));
            return BTreeMap::new();
        }
    };
    settings
        .plugins
        .into_iter()
        .filter_map(|(name, entry)| Some((name, entry.enabled?)))
        .collect()
}

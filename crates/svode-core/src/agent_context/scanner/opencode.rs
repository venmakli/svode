//! The `plugins` lists of the opencode configs, JSON with comments: the
//! plugins they add and turn off and on again. Only those lists are kept:
//! the configs also hold provider keys and MCP secrets.

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::agent_adapters::{AgentAdapterKind, SourceRegistryEnvironment};

use super::io::{diagnostic, path_string};
use super::{DiscoveryResult, TargetPlaces};

const CONFIG_BYTES: u64 = 256 * 1024;
const CONFIG_NAMES: [&str; 2] = ["opencode.json", "opencode.jsonc"];

/// The plugin lists the reader keeps: `plugins`, and `plugin` of opencode 1.
#[derive(Deserialize)]
struct Config {
    plugins: Option<Vec<serde_json::Value>>,
    plugin: Option<Vec<serde_json::Value>>,
}

/// A `plugins` entry of an opencode config, in the order opencode applies
/// them.
#[derive(Debug, Clone)]
pub(super) struct ConfiguredPlugin {
    pub config: PathBuf,
    pub inside: bool,
    pub entry: String,
}

/// Whether the built-in plugin `id` is on, as the opencode configs leave it.
pub(super) fn built_in_plugin_enabled(
    id: &str,
    environment: &SourceRegistryEnvironment,
    places: &TargetPlaces,
    global: bool,
    result: &mut DiscoveryResult,
) -> bool {
    plugin_switched_on(&configured_plugins(environment, places, global, result), id)
}

/// The `plugins` entries of the global config, then the configs in the
/// directories from the filesystem root down to the target, then their
/// `.opencode` configs. Configs outside the repository boundary count only
/// when `global`.
pub(super) fn configured_plugins(
    environment: &SourceRegistryEnvironment,
    places: &TargetPlaces,
    global: bool,
    result: &mut DiscoveryResult,
) -> Vec<ConfiguredPlugin> {
    let mut configs = Vec::new();
    if global {
        configs.extend(
            CONFIG_NAMES
                .iter()
                .map(|name| (environment.opencode_config_dir.join(name), false)),
        );
    }
    let walk = places.walk(crate::agent_adapters::DirectoryWalk::FilesystemToTarget);
    for relative in ["", ".opencode"] {
        for directory in &walk {
            if !directory.inside && !global {
                continue;
            }
            configs.extend(
                CONFIG_NAMES
                    .iter()
                    .map(|name| (directory.path.join(relative).join(name), directory.inside)),
            );
        }
    }

    let mut entries = Vec::new();
    for (config, inside) in configs {
        let observed = path_string(&config);
        if inside {
            result.observed_project_paths.push(observed);
        } else {
            result.observed_personal_paths.push(observed);
        }
        for entry in plugin_entries(&config, result) {
            entries.push(ConfiguredPlugin {
                config: config.clone(),
                inside,
                entry,
            });
        }
    }
    entries
}

/// A later mention wins; `-<pattern>` turns plugins off.
pub(super) fn plugin_switched_on(entries: &[ConfiguredPlugin], id: &str) -> bool {
    let mut enabled = true;
    for entry in entries {
        let (switch_on, pattern) = match entry.entry.strip_prefix('-') {
            Some(pattern) => (false, pattern),
            None => (true, entry.entry.as_str()),
        };
        if matches(pattern, id) {
            enabled = switch_on;
        }
    }
    enabled
}

/// `*` is every plugin and `prefix.*` every plugin under `prefix.`.
fn matches(pattern: &str, id: &str) -> bool {
    pattern == "*"
        || pattern == id
        || pattern
            .strip_suffix('*')
            .is_some_and(|prefix| prefix.ends_with('.') && id.starts_with(prefix))
}

fn plugin_entries(config: &Path, result: &mut DiscoveryResult) -> Vec<String> {
    let Some(text) = read_config(config, result) else {
        return Vec::new();
    };
    let Ok(parsed) = jsonc_parser::parse_to_serde_value::<Option<Config>>(
        text.trim_start_matches('\u{feff}'),
        &jsonc_parser::ParseOptions::default(),
    ) else {
        // The parser's message may quote the file, which can hold secrets.
        result.diagnostics.push(diagnostic(
            config,
            Some(AgentAdapterKind::Opencode),
            "opencode_config_parse",
            "Could not parse opencode config".to_string(),
        ));
        return Vec::new();
    };
    let Some(parsed) = parsed else {
        return Vec::new();
    };
    parsed
        .plugin
        .into_iter()
        .chain(parsed.plugins)
        .flatten()
        .filter_map(|entry| match entry {
            serde_json::Value::String(entry) => Some(entry),
            // `{ package, options }`: the options may hold keys and are not
            // kept.
            serde_json::Value::Object(entry) => entry
                .get("package")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            _ => None,
        })
        .collect()
}

fn read_config(config: &Path, result: &mut DiscoveryResult) -> Option<String> {
    let file = match File::open(config) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            result.diagnostics.push(diagnostic(
                config,
                Some(AgentAdapterKind::Opencode),
                "opencode_config_read",
                format!("Could not read opencode config: {error}"),
            ));
            return None;
        }
    };
    let mut bytes = Vec::new();
    if let Err(error) = file.take(CONFIG_BYTES + 1).read_to_end(&mut bytes) {
        result.diagnostics.push(diagnostic(
            config,
            Some(AgentAdapterKind::Opencode),
            "opencode_config_read",
            format!("Could not read opencode config: {error}"),
        ));
        return None;
    }
    if bytes.len() as u64 > CONFIG_BYTES {
        result.diagnostics.push(diagnostic(
            config,
            Some(AgentAdapterKind::Opencode),
            "opencode_config_limit",
            "opencode config exceeds the supported 256 KiB scan limit".to_string(),
        ));
        return None;
    }
    match String::from_utf8(bytes) {
        Ok(text) => Some(text),
        Err(_) => {
            result.diagnostics.push(diagnostic(
                config,
                Some(AgentAdapterKind::Opencode),
                "opencode_config_parse",
                "Could not parse opencode config".to_string(),
            ));
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::matches;

    #[test]
    fn plugin_patterns_name_one_plugin_a_prefix_or_all() {
        let id = "opencode.config.compatibility";
        assert!(matches(id, id));
        assert!(matches("opencode.config.*", id));
        assert!(matches("opencode.*", id));
        assert!(matches("*", id));
        assert!(!matches("opencode.config.instruction", id));
        assert!(!matches("opencode.conf*", id));
    }
}

//! `context.fileName` of the Qwen Code settings, JSON with comments, and the
//! activation of its extensions. Only those keys are kept: the settings
//! also hold keys and other secrets.

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::agent_adapters::{AgentAdapterKind, SourceRegistryEnvironment};

use super::io::{diagnostic, path_string};
use super::{DiscoveryResult, TargetPlaces};

const SETTINGS_BYTES: u64 = 256 * 1024;

/// The one settings key the reader keeps.
#[derive(Deserialize)]
struct Settings {
    context: Option<serde_json::Value>,
}

/// The instruction names that replace the defaults: the workspace settings
/// of the target, else — when `global` — the user settings in the Qwen home.
pub(super) fn context_file_names(
    environment: &SourceRegistryEnvironment,
    places: &TargetPlaces,
    global: bool,
    result: &mut DiscoveryResult,
) -> Option<Vec<String>> {
    let workspace = places.target_root.join(".qwen/settings.json");
    result.observed_project_paths.push(path_string(&workspace));
    if let Some(names) = read_names(&workspace, result) {
        return Some(names);
    }
    if !global {
        return None;
    }
    let user = environment.qwen_home.join("settings.json");
    result.observed_personal_paths.push(path_string(&user));
    read_names(&user, result)
}

fn read_names(settings: &Path, result: &mut DiscoveryResult) -> Option<Vec<String>> {
    let text = read_settings(settings, result)?;
    let Ok(parsed) = jsonc_parser::parse_to_serde_value::<Option<Settings>>(
        text.trim_start_matches('\u{feff}'),
        &jsonc_parser::ParseOptions::default(),
    ) else {
        // The parser's message may quote the file, which can hold secrets.
        result.diagnostics.push(diagnostic(
            settings,
            Some(AgentAdapterKind::QwenCode),
            "qwen_settings_parse",
            "Could not parse Qwen Code settings".to_string(),
        ));
        return None;
    };
    let configured = parsed?.context?.get("fileName")?.clone();
    let values = match &configured {
        serde_json::Value::String(name) => vec![name.as_str()],
        serde_json::Value::Array(names) => {
            names.iter().filter_map(serde_json::Value::as_str).collect()
        }
        _ => Vec::new(),
    };
    let mut names = Vec::new();
    for value in values {
        let path = PathBuf::from(value);
        let basename = path.components().count() == 1 && path.file_name().is_some();
        if basename && !names.iter().any(|name| name == value) {
            names.push(value.to_string());
        } else if !basename {
            result.diagnostics.push(diagnostic(
                settings,
                Some(AgentAdapterKind::QwenCode),
                "qwen_context_file_name_ignored",
                format!("Ignored a Qwen Code context file name that is not a file name: {value}"),
            ));
        }
    }
    (!names.is_empty()).then_some(names)
}

fn read_settings(settings: &Path, result: &mut DiscoveryResult) -> Option<String> {
    let file = match File::open(settings) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            result.diagnostics.push(diagnostic(
                settings,
                Some(AgentAdapterKind::QwenCode),
                "qwen_settings_read",
                format!("Could not read Qwen Code settings: {error}"),
            ));
            return None;
        }
    };
    let mut bytes = Vec::new();
    let read = file.take(SETTINGS_BYTES + 1).read_to_end(&mut bytes);
    if let Err(error) = read {
        result.diagnostics.push(diagnostic(
            settings,
            Some(AgentAdapterKind::QwenCode),
            "qwen_settings_read",
            format!("Could not read Qwen Code settings: {error}"),
        ));
        return None;
    }
    if bytes.len() as u64 > SETTINGS_BYTES {
        result.diagnostics.push(diagnostic(
            settings,
            Some(AgentAdapterKind::QwenCode),
            "qwen_settings_limit",
            "Qwen Code settings exceed the supported 256 KiB scan limit".to_string(),
        ));
        return None;
    }
    match String::from_utf8(bytes) {
        Ok(text) => Some(text),
        Err(_) => {
            result.diagnostics.push(diagnostic(
                settings,
                Some(AgentAdapterKind::QwenCode),
                "qwen_settings_parse",
                "Could not parse Qwen Code settings".to_string(),
            ));
            None
        }
    }
}

#[derive(Deserialize)]
struct ExtensionStore {
    #[serde(default)]
    extensions: std::collections::BTreeMap<String, ExtensionPolicy>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionPolicy {
    name: String,
    default_activation: Option<String>,
    #[serde(default)]
    workspace_overrides: std::collections::BTreeMap<String, String>,
}

/// Whether the extensions of the Qwen Code extension store are on in the
/// target, by name: the target's override, else the default activation.
/// An extension the store does not name is on.
pub(super) fn extension_activation(
    environment: &SourceRegistryEnvironment,
    target_root: &Path,
    result: &mut DiscoveryResult,
) -> std::collections::BTreeMap<String, bool> {
    let path = environment.qwen_home.join("extension-store/state.json");
    result.observed_personal_paths.push(path_string(&path));
    let Some(text) = super::io::read_config_text(
        &path,
        Some(AgentAdapterKind::QwenCode),
        "qwen_extension_store",
        "Qwen Code extension store",
        &mut result.diagnostics,
    ) else {
        return Default::default();
    };
    let Ok(store) = serde_json::from_str::<ExtensionStore>(&text) else {
        result.diagnostics.push(diagnostic(
            &path,
            Some(AgentAdapterKind::QwenCode),
            "qwen_extension_store_parse",
            "Could not parse the Qwen Code extension store".to_string(),
        ));
        return Default::default();
    };
    let target = path_string(target_root);
    store
        .extensions
        .into_values()
        .map(|policy| {
            let activation = match policy.workspace_overrides.get(&target).map(String::as_str) {
                Some(value @ ("enabled" | "disabled")) => value.to_string(),
                _ => policy.default_activation.unwrap_or_default(),
            };
            (policy.name, activation != "disabled")
        })
        .collect()
}

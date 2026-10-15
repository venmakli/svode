//! The Hermes config, YAML (E02, Hermes 2026.9.24): `skills.create_dir` and
//! `skills.external_dirs`, the folders of skills Hermes reads after its
//! own. Only those keys are kept: the config may hold secrets.

use std::io::Read;
use std::path::{Path, PathBuf};

use crate::agent_adapters::{
    AgentAdapterKind, AgentSourcePolicy, SkillPlace, SkillRootRule, SourceRegistryEnvironment,
};

use super::super::model::SkillDiscoveryKind;
use super::DiscoveryResult;
use super::io::{diagnostic, path_string};

const AGENT: AgentAdapterKind = AgentAdapterKind::Hermes;
const CONFIG_BYTES: u64 = 256 * 1024;

/// The folders of the profile's config that exist. `global` reads the
/// config.
pub(super) fn skill_dirs(
    environment: &SourceRegistryEnvironment,
    global: bool,
) -> (Vec<PathBuf>, DiscoveryResult) {
    let mut result = DiscoveryResult::default();
    if !global {
        return (Vec::new(), result);
    }
    let path = environment.hermes_home.join("config.yaml");
    result.observed_personal_paths.push(path_string(&path));
    let Some(skills) =
        read_config(&path, &mut result).and_then(|config| config.get("skills").cloned())
    else {
        return (Vec::new(), result);
    };
    let entries = |key: &str| match skills.get(key) {
        Some(serde_norway::Value::String(value)) => vec![value.clone()],
        Some(serde_norway::Value::Sequence(values)) => values
            .iter()
            .filter_map(|value| value.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    };
    let own = environment.hermes_home.join("skills");
    let mut dirs = Vec::<PathBuf>::new();
    for entry in entries("create_dir")
        .into_iter()
        .chain(entries("external_dirs"))
    {
        let Some(dir) = expand(entry.trim(), environment) else {
            continue;
        };
        if dir.is_dir() && dir != own && !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    (dirs, result)
}

/// `~`, `$HOME` and `${HOME}` as Hermes expands them; a relative path is
/// relative to the Hermes home. An entry with another variable is skipped:
/// Svode does not know it.
fn expand(entry: &str, environment: &SourceRegistryEnvironment) -> Option<PathBuf> {
    if entry.is_empty() {
        return None;
    }
    let home = path_string(&environment.home_dir);
    let entry = if entry == "~" || entry.starts_with("~/") {
        format!("{home}{}", &entry[1..])
    } else {
        entry.to_string()
    };
    let entry = entry.replace("${HOME}", &home).replace("$HOME", &home);
    if entry.contains('$') {
        return None;
    }
    let path = PathBuf::from(entry);
    Some(if path.is_absolute() {
        path
    } else {
        environment.hermes_home.join(path)
    })
}

fn read_config(path: &Path, result: &mut DiscoveryResult) -> Option<serde_norway::Value> {
    let mut failed = |code: &str, message: String| {
        result
            .diagnostics
            .push(diagnostic(path, Some(AGENT), code, message));
        None
    };
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            return failed(
                "hermes_config_read",
                format!("Could not read Hermes config: {error}"),
            );
        }
    };
    let mut bytes = Vec::new();
    if let Err(error) = file.take(CONFIG_BYTES + 1).read_to_end(&mut bytes) {
        return failed(
            "hermes_config_read",
            format!("Could not read Hermes config: {error}"),
        );
    }
    if bytes.len() > CONFIG_BYTES as usize {
        return failed(
            "hermes_config_limit",
            "Hermes config exceeds the supported 256 KiB scan limit".to_string(),
        );
    }
    match serde_norway::from_slice(&bytes) {
        Ok(value) => Some(value),
        Err(error) => {
            // The config may hold secrets, so the message names the line only.
            let line = error
                .location()
                .map(|location| format!(" near line {}", location.line()))
                .unwrap_or_default();
            failed(
                "hermes_config_parse",
                format!("Could not parse Hermes config{line}"),
            )
        }
    }
}

/// Adds the folders of the config after the profile's own skill folder.
pub(super) fn apply_skill_dirs(policy: &mut AgentSourcePolicy, dirs: &[PathBuf]) {
    let roots = &mut policy.capabilities.skills.roots;
    let Some(layout) = roots.last().map(|root| root.layout) else {
        return;
    };
    for dir in dirs {
        let place = SkillPlace::Personal(path_string(dir));
        if roots.iter().all(|root| root.place != place) {
            roots.push(SkillRootRule {
                kind: SkillDiscoveryKind::PersonalRoot,
                place,
                layout,
                excluded_names: Vec::new(),
                switch: None,
            });
        }
    }
}

/// `plugins.enabled` and `plugins.disabled` of the profile's config, the
/// names of the plugins Hermes loads and skips.
pub(super) fn plugin_lists(
    environment: &SourceRegistryEnvironment,
    result: &mut DiscoveryResult,
) -> (Vec<String>, Vec<String>) {
    let path = environment.hermes_home.join("config.yaml");
    result.observed_personal_paths.push(path_string(&path));
    let Some(plugins) =
        read_config(&path, result).and_then(|config| config.get("plugins").cloned())
    else {
        return (Vec::new(), Vec::new());
    };
    let names = |key: &str| match plugins.get(key) {
        Some(serde_norway::Value::Sequence(values)) => values
            .iter()
            .filter_map(|value| value.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    };
    (names("enabled"), names("disabled"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn config_lists_existing_skill_folders_relative_to_the_hermes_home() {
        let home = TempDir::new().unwrap();
        let home = home.path().to_path_buf();
        let environment = SourceRegistryEnvironment::for_tests(home.clone());
        let hermes = &environment.hermes_home;
        std::fs::create_dir_all(home.join(".agents/skills")).unwrap();
        std::fs::create_dir_all(hermes.join("team")).unwrap();
        std::fs::write(
            hermes.join("config.yaml"),
            "api_key: secret-value\nskills:\n  external_dirs:\n    - ~/.agents/skills  # svode\n    - team\n    - /missing\n    - ${OTHER}/skills\n",
        )
        .unwrap();

        let (dirs, result) = skill_dirs(&environment, true);
        let (disabled, _) = skill_dirs(&environment, false);

        assert_eq!(dirs, vec![home.join(".agents/skills"), hermes.join("team")]);
        assert!(result.diagnostics.is_empty());
        assert!(disabled.is_empty());

        std::fs::write(
            hermes.join("config.yaml"),
            "api_key: secret-value\nskills: [\n",
        )
        .unwrap();
        let (_, broken) = skill_dirs(&environment, true);
        assert_eq!(broken.diagnostics.len(), 1);
        assert!(!format!("{:?}", broken.diagnostics).contains("secret-value"));
    }
}

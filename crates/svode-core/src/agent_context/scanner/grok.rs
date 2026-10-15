//! The Grok Build config, TOML (E02, Grok Build 1.0.46): its compatibility
//! cells, `[skills] paths` and `ignore`, `[plugins] enabled`, `disabled`
//! and `paths`, and `disabled_mcp_servers`. Only those keys are kept: the
//! config also holds API keys.

use std::collections::BTreeSet;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::agent_adapters::{
    AgentAdapterKind, AgentSourcePolicy, GrokSurface, GrokVendor, SkillLayout, SkillPlace,
    SkillRootRule, SourceRegistryEnvironment, SourceSwitch,
};

use super::super::model::{SkillDiscoveryKind, SkillRow};
use super::DiscoveryResult;
use super::io::{diagnostic, path_string};

const AGENT: AgentAdapterKind = AgentAdapterKind::GrokBuild;
const CONFIG_BYTES: u64 = 256 * 1024;

/// What the config and the environment decide for discovery.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct Config {
    pub switched_off: BTreeSet<SourceSwitch>,
    /// `[skills] paths`: more folders of skills.
    pub skill_paths: Vec<PathBuf>,
    /// `[skills] ignore`: the skills under these paths are hidden.
    pub ignored_paths: Vec<PathBuf>,
    /// `[plugins] enabled`: plugins are off until named here.
    pub plugins_enabled: Vec<String>,
    /// `[plugins] disabled`, which wins over `enabled`.
    pub plugins_disabled: Vec<String>,
    /// `[plugins] paths`: more plugin folders, on unless disabled.
    pub plugin_paths: Vec<PathBuf>,
    /// `disabled_mcp_servers`: MCP servers Grok skips, of every source.
    pub mcp_disabled: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
struct ConfigFile {
    #[serde(default)]
    compat: CompatFile,
    #[serde(default)]
    skills: SkillsFile,
    #[serde(default)]
    plugins: PluginsFile,
    #[serde(default)]
    disabled_mcp_servers: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
struct PluginsFile {
    #[serde(default)]
    enabled: Vec<String>,
    #[serde(default)]
    disabled: Vec<String>,
    #[serde(default)]
    paths: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
struct CompatFile {
    #[serde(default)]
    claude: CellsFile,
    #[serde(default)]
    cursor: CellsFile,
}

#[derive(Debug, Default, Deserialize)]
struct CellsFile {
    agents: Option<bool>,
    skills: Option<bool>,
    mcps: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
struct SkillsFile {
    #[serde(default)]
    paths: Vec<String>,
    #[serde(default)]
    ignore: Vec<String>,
}

/// A cell resolves from the environment, then the config, then on. `global`
/// reads the config in the Grok home.
pub(super) fn config(
    environment: &SourceRegistryEnvironment,
    global: bool,
) -> (Config, DiscoveryResult) {
    let mut result = DiscoveryResult::default();
    let file = if global {
        read_config(&environment.grok_home.join("config.toml"), &mut result)
    } else {
        ConfigFile::default()
    };
    let cells = [
        (
            GrokVendor::Claude,
            GrokSurface::Agents,
            file.compat.claude.agents,
        ),
        (
            GrokVendor::Claude,
            GrokSurface::Skills,
            file.compat.claude.skills,
        ),
        (
            GrokVendor::Cursor,
            GrokSurface::Agents,
            file.compat.cursor.agents,
        ),
        (
            GrokVendor::Cursor,
            GrokSurface::Skills,
            file.compat.cursor.skills,
        ),
        (
            GrokVendor::Claude,
            GrokSurface::Mcps,
            file.compat.claude.mcps,
        ),
        (
            GrokVendor::Cursor,
            GrokSurface::Mcps,
            file.compat.cursor.mcps,
        ),
    ];
    let switched_off = cells
        .into_iter()
        .map(|(vendor, surface, configured)| {
            (SourceSwitch::GrokCompat(vendor, surface), configured)
        })
        .filter(|(switch, configured)| {
            let set = environment
                .grok_switches
                .iter()
                .find(|(known, _)| known == switch)
                .map(|(_, on)| *on);
            !set.or(*configured).unwrap_or(true)
        })
        .map(|(switch, _)| switch)
        .collect();
    // Entries are absolute or start with `~/`; others load nothing.
    let expand = |value: &String| {
        let path = Path::new(value);
        match path.strip_prefix("~") {
            Ok(rest) => Some(environment.home_dir.join(rest)),
            Err(_) => path.is_absolute().then(|| path.to_path_buf()),
        }
    };
    (
        Config {
            switched_off,
            skill_paths: file.skills.paths.iter().filter_map(expand).collect(),
            ignored_paths: file.skills.ignore.iter().filter_map(expand).collect(),
            plugins_enabled: file.plugins.enabled,
            plugins_disabled: file.plugins.disabled,
            plugin_paths: file.plugins.paths.iter().filter_map(expand).collect(),
            mcp_disabled: file.disabled_mcp_servers,
        },
        result,
    )
}

fn read_config(path: &Path, result: &mut DiscoveryResult) -> ConfigFile {
    result.observed_personal_paths.push(path_string(path));
    let failed = |result: &mut DiscoveryResult, code: &str, message: String| {
        result
            .diagnostics
            .push(diagnostic(path, Some(AGENT), code, message));
        ConfigFile::default()
    };
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return ConfigFile::default();
        }
        Err(error) => {
            return failed(
                result,
                "grok_config_read",
                format!("Could not read Grok Build config: {error}"),
            );
        }
    };
    let mut bytes = Vec::new();
    if let Err(error) = file.take(CONFIG_BYTES + 1).read_to_end(&mut bytes) {
        return failed(
            result,
            "grok_config_read",
            format!("Could not read Grok Build config: {error}"),
        );
    }
    if bytes.len() > CONFIG_BYTES as usize {
        return failed(
            result,
            "grok_config_limit",
            "Grok Build config exceeds the supported 256 KiB scan limit".to_string(),
        );
    }
    let text = String::from_utf8_lossy(&bytes);
    match toml::from_str(&text) {
        Ok(config) => config,
        Err(error) => {
            // The config holds API keys, so the message names the line only.
            let line = error
                .span()
                .map(|span| text[..span.start.min(text.len())].lines().count().max(1));
            failed(
                result,
                "grok_config_parse",
                match line {
                    Some(line) => {
                        format!(
                            "Could not parse supported Grok Build config fields near line {line}"
                        )
                    }
                    None => "Could not parse supported Grok Build config fields".to_string(),
                },
            )
        }
    }
}

/// Adds the folders of `[skills] paths` after the user's skill folders.
pub(super) fn apply_skill_paths(policy: &mut AgentSourcePolicy, config: &Config) {
    let roots = &mut policy.capabilities.skills.roots;
    let layout = roots
        .first()
        .map_or(SkillLayout::DIRECT_CHILDREN, |root| root.layout);
    for path in config.skill_paths.iter().filter(|path| path.is_dir()) {
        let place = SkillPlace::Personal(path_string(path));
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

/// Hides the skills under `[skills] ignore` from Grok Build.
pub(super) fn apply_ignore(skills: &mut Vec<SkillRow>, config: &Config) {
    if config.ignored_paths.is_empty() {
        return;
    }
    let ignored = config
        .ignored_paths
        .iter()
        .map(|path| path.canonicalize().unwrap_or_else(|_| path.clone()))
        .collect::<Vec<_>>();
    let hidden = |path: &Path| ignored.iter().any(|ignored| path.starts_with(ignored));
    for row in skills.iter_mut() {
        let canonical_hidden = hidden(Path::new(&row.canonical_path));
        row.aliases.retain(|alias| {
            alias.adapter_id != AGENT || !(canonical_hidden || hidden(Path::new(&alias.path)))
        });
    }
    skills.retain(|row| !row.aliases.is_empty());
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn environment(home: &Path) -> SourceRegistryEnvironment {
        std::fs::create_dir_all(home.join(".grok")).unwrap();
        SourceRegistryEnvironment::for_tests(home.to_path_buf())
    }

    #[test]
    fn cells_resolve_environment_over_config_over_on() {
        let home = TempDir::new().unwrap();
        let mut environment = environment(home.path());
        std::fs::write(
            environment.grok_home.join("config.toml"),
            "api_key = \"secret-value\"\n[compat.claude]\nagents = false\nskills = false\n[skills]\npaths = [\"~/team\", \"relative\"]\nignore = [\"/abs/wip\"]\n",
        )
        .unwrap();
        environment.grok_switches = vec![(
            SourceSwitch::GrokCompat(GrokVendor::Claude, GrokSurface::Skills),
            true,
        )];

        let (enabled, _) = config(&environment, true);
        let (disabled, _) = config(&environment, false);

        assert_eq!(
            enabled.switched_off,
            BTreeSet::from([SourceSwitch::GrokCompat(
                GrokVendor::Claude,
                GrokSurface::Agents
            )])
        );
        assert_eq!(enabled.skill_paths, vec![home.path().join("team")]);
        assert_eq!(enabled.ignored_paths, vec![PathBuf::from("/abs/wip")]);
        assert_eq!(disabled, Config::default());
    }

    #[test]
    fn parse_error_names_the_line_without_quoting_the_file() {
        let home = TempDir::new().unwrap();
        let environment = environment(home.path());
        std::fs::write(
            environment.grok_home.join("config.toml"),
            "api_key = \"secret-value\"\n[compat.claude\n",
        )
        .unwrap();

        let (config, result) = config(&environment, true);

        assert!(config.switched_off.is_empty());
        assert_eq!(result.diagnostics.len(), 1);
        assert!(result.diagnostics[0].message.contains("line"));
        assert!(!format!("{:?}", result.diagnostics).contains("secret-value"));
    }
}

//! Plugins and extensions of the agents (Stage 10 `05`, «Плагины»): the
//! sources each policy declares, one row per canonical plugin, and whether
//! each agent that finds it has it on by its own config.

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::agent_adapters::{
    AgentAdapterKind, AgentSourcePolicy, PluginEnablement, PluginLayout, PluginPlace,
    PluginPrecedence, PluginRegistry, PluginSourceRule, SkillPlace, SourceRegistryEnvironment,
    SourceSwitch,
};

use super::super::model::{
    InstructionOwner, InstructionOwnerKind, PluginFinding, PluginRow, PluginSwitch, SkillScope,
    SourceHealth, SourceLinkKind,
};
use super::io::{diagnostic, path_string};
use super::plugin_folder::{self, FolderRule, PluginFolder};
use super::{
    DiscoveryResult, TargetPlaces, claude, codex, cursor, grok, hermes, kimi, opencode, pi, qwen,
};

/// A path by which an agent finds a plugin.
struct Candidate {
    path: PathBuf,
    inside: bool,
    /// The agent's id of the plugin where its config switches it by one.
    id: Option<String>,
    /// A registry names the path, with the plugin's switch when it keeps it.
    registered: bool,
    registry_switch: Option<bool>,
    /// Codex installed it from the account, outside the config.
    remote: bool,
    /// A config names the plugin without a folder on the device.
    declared: Option<PathBuf>,
}

impl Candidate {
    fn folder(path: PathBuf, inside: bool) -> Self {
        Self {
            path,
            inside,
            id: None,
            registered: false,
            registry_switch: None,
            remote: false,
            declared: None,
        }
    }
}

/// One plugin while its findings are collected.
struct Collected {
    row: PluginRow,
    default_enabled: Option<bool>,
}

/// What the switches of the agents' configs say, read once per scan.
#[derive(Default)]
struct Switches {
    claude: BTreeMap<PathBuf, BTreeMap<String, bool>>,
    codex: Option<BTreeMap<String, bool>>,
    cursor: Option<BTreeMap<String, bool>>,
    qwen: Option<BTreeMap<String, bool>>,
    hermes: Option<(Vec<String>, Vec<String>)>,
    opencode: Option<Vec<opencode::ConfiguredPlugin>>,
}

pub(super) fn discover(
    places: &TargetPlaces,
    adapters: &[AgentSourcePolicy],
    global_agents: &[AgentAdapterKind],
    environment: &SourceRegistryEnvironment,
    grok: &grok::Config,
) -> DiscoveryResult {
    let mut result = DiscoveryResult::default();
    let mut switches = Switches::default();
    let svode_home = environment.svode_home.canonicalize().ok();
    let mut plugins = BTreeMap::<PathBuf, Option<Collected>>::new();
    // Per agent, the first plugin of each name in source order.
    let mut first_by_name = BTreeMap::<(AgentAdapterKind, String), String>::new();

    for adapter in adapters {
        let agent = adapter.id;
        let global = global_agents.contains(&agent);
        let capability = &adapter.capabilities.plugins;
        for rule in &capability.sources {
            if rule.switch == Some(SourceSwitch::HermesProjectPlugins)
                && !environment.hermes_project_plugins
            {
                continue;
            }
            for candidate in candidates(agent, rule, places, environment, global, grok, &mut result)
            {
                let Some((canonical, link_kind)) = resolve(
                    &candidate,
                    places,
                    global,
                    svode_home.as_deref(),
                    agent,
                    &mut result,
                ) else {
                    continue;
                };
                let entry = plugins.entry(canonical.clone()).or_insert_with(|| {
                    read_plugin(&canonical, &candidate, rule, places, agent, &mut result)
                });
                let Some(collected) = entry else {
                    continue;
                };
                let id = candidate
                    .id
                    .clone()
                    .unwrap_or_else(|| collected.row.name.clone());
                let switch = plugin_switch(
                    agent,
                    rule,
                    &candidate,
                    &id,
                    &collected.row.name,
                    collected.default_enabled,
                    places,
                    environment,
                    global,
                    grok,
                    &mut switches,
                    &mut result,
                );
                let path = path_string(&candidate.path);
                let superseded_by = match capability.precedence {
                    PluginPrecedence::Coexist => None,
                    PluginPrecedence::FirstWinsByName => {
                        let winner = first_by_name
                            .entry((agent, collected.row.name.clone()))
                            .or_insert_with(|| path.clone());
                        (*winner != path).then(|| winner.clone())
                    }
                };
                if collected
                    .row
                    .findings
                    .iter()
                    .any(|finding| finding.adapter_id == agent && finding.path == path)
                {
                    continue;
                }
                collected.row.findings.push(PluginFinding {
                    adapter_id: agent,
                    scope: if candidate.inside {
                        SkillScope::Project
                    } else {
                        SkillScope::Personal
                    },
                    path,
                    link_kind,
                    switch,
                    superseded_by,
                });
            }
        }
    }
    result.plugins = plugins
        .into_values()
        .flatten()
        .map(|collected| collected.row)
        .collect();
    result.plugins.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.directory.cmp(&right.directory))
    });
    result
}

/// The paths a source rule names. Places outside the repository boundary
/// and registries in the agent's home are read only when `global`.
fn candidates(
    agent: AgentAdapterKind,
    rule: &PluginSourceRule,
    places: &TargetPlaces,
    environment: &SourceRegistryEnvironment,
    global: bool,
    grok: &grok::Config,
    result: &mut DiscoveryResult,
) -> Vec<Candidate> {
    match &rule.place {
        PluginPlace::Folder { place, layout } => {
            let roots = match place {
                SkillPlace::Walk { walk, relative } => places
                    .walk(*walk)
                    .into_iter()
                    .filter(|directory| directory.inside || global)
                    .map(|directory| (directory.path.join(relative), directory.inside))
                    .collect::<Vec<_>>(),
                SkillPlace::Personal(path) if global => vec![(PathBuf::from(path), false)],
                SkillPlace::Personal(_) => Vec::new(),
            };
            let mut found = Vec::new();
            for (root, inside) in roots {
                let observed = path_string(&root);
                if inside {
                    result.observed_project_paths.push(observed);
                } else {
                    result.observed_personal_paths.push(observed);
                }
                found.extend(folder_candidates(&root, *layout, inside));
            }
            found
        }
        PluginPlace::Registry(_) if !global && !local_registry(rule) => Vec::new(),
        PluginPlace::Registry(PluginRegistry::ClaudeInstalled(registry)) => {
            claude::installed_plugins(Path::new(registry), agent, result)
                .into_iter()
                .filter(|installed| match installed.scope.as_str() {
                    "user" | "managed" => true,
                    // A project or local install counts in its project.
                    _ => installed.project_path.as_ref().is_some_and(|project| {
                        project
                            .canonicalize()
                            .is_ok_and(|project| places.target_root.starts_with(project))
                    }),
                })
                .map(|installed| Candidate {
                    id: Some(installed.id),
                    registered: true,
                    ..Candidate::folder(installed.install_path, false)
                })
                .collect()
        }
        PluginPlace::Registry(PluginRegistry::KimiInstalled(registry)) => {
            kimi::installed_plugins(Path::new(registry), &environment.kimi_code_home, result)
                .into_iter()
                .map(|installed| Candidate {
                    registered: true,
                    registry_switch: Some(installed.enabled),
                    ..Candidate::folder(installed.root, false)
                })
                .collect()
        }
        PluginPlace::Registry(PluginRegistry::GrokConfigPaths) => grok
            .plugin_paths
            .iter()
            .map(|path| Candidate {
                registered: true,
                ..Candidate::folder(path.clone(), false)
            })
            .collect(),
        PluginPlace::Registry(PluginRegistry::OpencodeConfig) => {
            opencode::configured_plugins(environment, places, global, result)
                .into_iter()
                .filter_map(|configured| opencode_candidate(&configured, &environment.home_dir))
                .collect()
        }
        PluginPlace::Registry(PluginRegistry::PiPackages) => {
            pi::packages(environment, places, global, result)
                .into_iter()
                .map(|package| match package.folder {
                    Some(folder) => Candidate {
                        id: Some(package.name),
                        registered: true,
                        ..Candidate::folder(folder, package.inside)
                    },
                    None => Candidate {
                        id: Some(package.name),
                        declared: Some(package.settings.clone()),
                        ..Candidate::folder(package.settings, package.inside)
                    },
                })
                .collect()
        }
    }
}

/// Registries that also read the configs of the project.
fn local_registry(rule: &PluginSourceRule) -> bool {
    matches!(
        rule.place,
        PluginPlace::Registry(PluginRegistry::OpencodeConfig | PluginRegistry::PiPackages)
    )
}

fn folder_candidates(root: &Path, layout: PluginLayout, inside: bool) -> Vec<Candidate> {
    let directories = |path: &Path| {
        plugin_folder::entries(path)
            .into_iter()
            .filter(|entry| entry.is_dir())
            .collect::<Vec<_>>()
    };
    match layout {
        PluginLayout::Children => directories(root)
            .into_iter()
            .map(|path| Candidate::folder(path, inside))
            .collect(),
        // A folder that is no plugin may group plugins; the reader tells.
        PluginLayout::Grouped => directories(root)
            .into_iter()
            .flat_map(|path| {
                let grouped = directories(&path)
                    .into_iter()
                    .filter(|child| has_any_manifest(child))
                    .collect::<Vec<_>>();
                if has_any_manifest(&path) || grouped.is_empty() {
                    vec![path]
                } else {
                    grouped
                }
            })
            .map(|path| Candidate::folder(path, inside))
            .collect(),
        PluginLayout::Cache => {
            let mut found = Vec::new();
            for marketplace in directories(root) {
                for plugin in directories(&marketplace) {
                    let Some(version) = active_version(&directories(&plugin)) else {
                        continue;
                    };
                    let name = |path: &Path| {
                        path.file_name()
                            .map(|name| name.to_string_lossy().into_owned())
                            .unwrap_or_default()
                    };
                    found.push(Candidate {
                        id: Some(format!("{}@{}", name(&plugin), name(&marketplace))),
                        remote: plugin.join(".codex-remote-plugin-install.json").is_file(),
                        ..Candidate::folder(version, inside)
                    });
                }
            }
            found
        }
        PluginLayout::ClaudeSkillsDir => directories(root)
            .into_iter()
            .filter(|path| {
                path.file_name().is_some_and(|name| name != "synced")
                    && !path.join("SKILL.md").exists()
                    && path.join(".claude-plugin/plugin.json").is_file()
            })
            .map(|path| {
                let name = path
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default();
                Candidate {
                    id: Some(format!("{name}@skills-dir")),
                    ..Candidate::folder(path, inside)
                }
            })
            .collect(),
        PluginLayout::CodeModules => plugin_folder::entries(root)
            .into_iter()
            .filter(|path| {
                let module = path.is_file()
                    && path
                        .extension()
                        .is_some_and(|extension| extension == "ts" || extension == "js")
                    && !path.to_string_lossy().ends_with(".d.ts");
                module || path.is_dir()
            })
            .map(|path| Candidate::folder(path, inside))
            .collect(),
    }
}

const ANY_MANIFEST: &[&str] = &["plugin.yaml", "plugin.yml", "plugin.json"];

fn has_any_manifest(folder: &Path) -> bool {
    ANY_MANIFEST.iter().any(|name| folder.join(name).is_file())
}

/// The `local` version, else the highest by its numeric parts.
fn active_version(versions: &[PathBuf]) -> Option<PathBuf> {
    if let Some(local) = versions
        .iter()
        .find(|version| version.file_name().is_some_and(|name| name == "local"))
    {
        return Some(local.clone());
    }
    versions
        .iter()
        .max_by(|left, right| compare_versions(&file_name(left), &file_name(right)))
        .cloned()
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn compare_versions(left: &str, right: &str) -> Ordering {
    let parts = |version: &str| {
        version
            .split(['.', '-', '+'])
            .map(|part| part.parse::<u64>().ok())
            .collect::<Vec<_>>()
    };
    let (left_parts, right_parts) = (parts(left), parts(right));
    for (left_part, right_part) in left_parts.iter().zip(&right_parts) {
        let order = match (left_part, right_part) {
            (Some(left), Some(right)) => left.cmp(right),
            (Some(_), None) => Ordering::Greater,
            (None, Some(_)) => Ordering::Less,
            (None, None) => Ordering::Equal,
        };
        if order != Ordering::Equal {
            return order;
        }
    }
    left_parts
        .len()
        .cmp(&right_parts.len())
        .then_with(|| left.cmp(right))
}

/// A path entry is a module of its own; an npm or git entry is a plugin the
/// config names. Built-in plugins and turned-off entries are no plugins.
fn opencode_candidate(configured: &opencode::ConfiguredPlugin, home: &Path) -> Option<Candidate> {
    let entry = configured.entry.trim();
    if entry.starts_with('-') || entry.starts_with("opencode.") || entry.contains('*') {
        return None;
    }
    let base = configured.config.parent()?;
    let path = if let Some(rest) = entry.strip_prefix("file://") {
        Some(PathBuf::from(rest))
    } else if let Some(rest) = entry.strip_prefix("~/") {
        Some(home.join(rest))
    } else if entry.starts_with('.') || Path::new(entry).is_absolute() {
        Some(base.join(entry))
    } else {
        None
    };
    Some(match path {
        Some(path) => Candidate::folder(path, configured.inside),
        None => {
            let name = spec_name(entry)?;
            Candidate {
                id: Some(name),
                declared: Some(configured.config.clone()),
                ..Candidate::folder(configured.config.clone(), configured.inside)
            }
        }
    })
}

/// The name of an npm entry without its version, or the repository of a
/// git entry without credentials, ref or `.git`.
fn spec_name(entry: &str) -> Option<String> {
    let entry = entry.split('#').next()?;
    if let Some((_, location)) = entry.split_once("://").or_else(|| entry.split_once(':')) {
        let location = location.rsplit_once('@').map_or(location, |(_, rest)| rest);
        let name = location.trim_end_matches('/').rsplit('/').next()?;
        let name = name.trim_end_matches(".git");
        return (!name.is_empty()).then(|| name.to_string());
    }
    let name = match entry.rfind('@') {
        Some(at) if at > 0 => &entry[..at],
        _ => entry,
    };
    (!name.is_empty()).then(|| name.to_string())
}

/// The canonical plugin of a path inside the repository boundary, the home
/// directory of an enabled agent or the stable Svode folder.
fn resolve(
    candidate: &Candidate,
    places: &TargetPlaces,
    global: bool,
    svode_home: Option<&Path>,
    agent: AgentAdapterKind,
    result: &mut DiscoveryResult,
) -> Option<(PathBuf, SourceLinkKind)> {
    if let Some(config) = &candidate.declared {
        let name = candidate.id.clone().unwrap_or_default();
        return Some((
            PathBuf::from(format!("{}#{name}", path_string(config))),
            SourceLinkKind::Direct,
        ));
    }
    let metadata = fs::symlink_metadata(&candidate.path).ok()?;
    let canonical = match candidate.path.canonicalize() {
        Ok(canonical) => canonical,
        Err(error) => {
            result.diagnostics.push(diagnostic(
                &candidate.path,
                Some(agent),
                "plugin_alias_unresolved",
                format!(
                    "Could not resolve plugin {} (broken link or cycle): {error}",
                    candidate.path.display()
                ),
            ));
            return None;
        }
    };
    let allowed = canonical.starts_with(&places.repository_root)
        || (global && canonical.starts_with(&places.home))
        || svode_home.is_some_and(|svode| canonical.starts_with(svode));
    if !allowed {
        result.diagnostics.push(diagnostic(
            &candidate.path,
            Some(agent),
            "plugin_outside_boundary",
            format!(
                "Plugin {} resolves outside the project and the agents' homes and was not read",
                candidate.path.display()
            ),
        ));
        return None;
    }
    let link_kind = if metadata.file_type().is_symlink() {
        SourceLinkKind::SymbolicLink
    } else if canonical != candidate.path {
        SourceLinkKind::DirectoryAlias
    } else {
        SourceLinkKind::Direct
    };
    Some((canonical, link_kind))
}

fn read_plugin(
    canonical: &Path,
    candidate: &Candidate,
    rule: &PluginSourceRule,
    places: &TargetPlaces,
    agent: AgentAdapterKind,
    result: &mut DiscoveryResult,
) -> Option<Collected> {
    let fallback = candidate
        .id
        .as_deref()
        .and_then(|id| id.split('@').next())
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            canonical
                .file_stem()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default()
        });
    let (folder, place, directory, owner_root) = if let Some(config) = &candidate.declared {
        let folder = plugin_folder::declared(&fallback, config);
        let owner = config.parent().unwrap_or(config).to_path_buf();
        (folder, config.clone(), canonical.to_path_buf(), owner)
    } else {
        let owner_root = if canonical.is_file() {
            canonical.parent().unwrap_or(canonical).to_path_buf()
        } else {
            canonical.to_path_buf()
        };
        let owner = InstructionOwner {
            kind: if canonical.starts_with(&places.repository_root) {
                InstructionOwnerKind::TargetSpace
            } else {
                InstructionOwnerKind::ClientConfiguration
            },
            root: path_string(&owner_root),
        };
        let folder = plugin_folder::read(
            canonical,
            &fallback,
            &FolderRule {
                manifests: &rule.manifests,
                manifest_required: rule.manifest_required,
                registered: candidate.registered,
            },
            &owner,
            agent,
            &mut result.diagnostics,
        )?;
        let place = canonical.parent().unwrap_or(canonical).to_path_buf();
        (folder, place, canonical.to_path_buf(), owner_root)
    };
    let PluginFolder {
        name,
        description,
        path,
        composition,
        manifest,
        default_enabled,
        icon,
        readme,
        skills,
        instructions,
        counts,
        problems,
    } = folder;
    Some(Collected {
        row: PluginRow {
            id: format!("plugin:{}", path_string(&directory)),
            name,
            description,
            path: path_string(&path),
            directory: path_string(&directory),
            place: path_string(&place),
            owner_root: path_string(&owner_root),
            composition,
            manifest,
            icon,
            readme,
            skills,
            instructions,
            counts,
            health: if problems.is_empty() {
                SourceHealth::Normal
            } else {
                SourceHealth::Degraded
            },
            health_reasons: problems,
            findings: Vec::new(),
        },
        default_enabled,
    })
}

/// Whether `agent` has the plugin on, as its configs say.
#[allow(clippy::too_many_arguments)]
fn plugin_switch(
    agent: AgentAdapterKind,
    rule: &PluginSourceRule,
    candidate: &Candidate,
    id: &str,
    name: &str,
    default_enabled: Option<bool>,
    places: &TargetPlaces,
    environment: &SourceRegistryEnvironment,
    global: bool,
    grok: &grok::Config,
    switches: &mut Switches,
    result: &mut DiscoveryResult,
) -> PluginSwitch {
    let on = |on: bool| {
        if on {
            PluginSwitch::On
        } else {
            PluginSwitch::Off
        }
    };
    match rule.enablement {
        PluginEnablement::Installed => PluginSwitch::On,
        PluginEnablement::ClaudeEnabledPlugins { default_on } => {
            let user_dir = match &rule.place {
                PluginPlace::Registry(PluginRegistry::ClaudeInstalled(registry)) => {
                    Path::new(registry)
                        .parent()
                        .and_then(Path::parent)
                        .map(Path::to_path_buf)
                }
                _ => Some(environment.claude_config_dir.clone()),
            }
            .unwrap_or_else(|| environment.claude_config_dir.clone());
            let enabled = switches.claude.entry(user_dir.clone()).or_insert_with(|| {
                claude::enabled_plugins(
                    global.then_some(user_dir.as_path()),
                    &places.target_root,
                    agent,
                    result,
                )
            });
            on(enabled
                .get(id)
                .copied()
                .unwrap_or_else(|| default_enabled.unwrap_or(default_on)))
        }
        PluginEnablement::CodexConfig => {
            let configured = switches
                .codex
                .get_or_insert_with(|| codex::plugin_switches(environment, result));
            match configured.get(id) {
                Some(enabled) => on(*enabled),
                None if candidate.remote => PluginSwitch::Unverified,
                None => PluginSwitch::Off,
            }
        }
        PluginEnablement::CursorServer => {
            let project = switches
                .cursor
                .get_or_insert_with(|| cursor::project_plugins(&places.target_root, result));
            let marketplace_name = id
                .split_once('@')
                .map(|(plugin, marketplace)| format!("{marketplace}/{plugin}"));
            let configured = marketplace_name
                .as_deref()
                .and_then(|key| project.get(key))
                .or_else(|| project.get(name));
            match configured {
                Some(false) => PluginSwitch::Off,
                _ => PluginSwitch::Unverified,
            }
        }
        PluginEnablement::GrokConfig => {
            let named = |list: &[String]| list.iter().any(|entry| entry == name || entry == id);
            if named(&grok.plugins_disabled) {
                PluginSwitch::Off
            } else if named(&grok.plugins_enabled)
                || matches!(
                    rule.place,
                    PluginPlace::Registry(PluginRegistry::GrokConfigPaths)
                )
            {
                PluginSwitch::On
            } else {
                PluginSwitch::Off
            }
        }
        PluginEnablement::QwenExtensionStore => {
            let activation = switches.qwen.get_or_insert_with(|| {
                qwen::extension_activation(environment, &places.target_root, result)
            });
            on(activation.get(name).copied().unwrap_or(true))
        }
        PluginEnablement::KimiRegistry => on(candidate.registry_switch.unwrap_or(true)),
        PluginEnablement::HermesConfig => {
            let (enabled, disabled) = switches.hermes.get_or_insert_with(|| {
                if global {
                    hermes::plugin_lists(environment, result)
                } else {
                    (Vec::new(), Vec::new())
                }
            });
            on(!disabled.iter().any(|entry| entry == name)
                && enabled.iter().any(|entry| entry == name))
        }
        PluginEnablement::OpencodeConfig => {
            let entries = switches.opencode.get_or_insert_with(|| {
                opencode::configured_plugins(environment, places, global, result)
            });
            on(opencode::plugin_switched_on(entries, id))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use tempfile::TempDir;

    use crate::agent_adapters::{AgentAdapterKind, SourceRegistryEnvironment};
    use crate::agent_context::model::{
        ContextItem, ContextItemKind, PluginComponentKind, PluginComposition, UnappliedReason,
    };
    use crate::agent_context::scanner::scan;

    use AgentAdapterKind::{ClaudeCode, Codex, Cursor, GrokBuild, Hermes, KimiCode, Opencode, Pi};

    struct Fixture {
        project: TempDir,
        _home: TempDir,
        environment: SourceRegistryEnvironment,
    }

    impl Fixture {
        fn new() -> Self {
            let project = TempDir::new().unwrap();
            std::fs::create_dir(project.path().join(".git")).unwrap();
            let home = TempDir::new().unwrap();
            let environment = SourceRegistryEnvironment::for_tests(home.path().to_path_buf());
            Self {
                project,
                _home: home,
                environment,
            }
        }

        fn home(&self) -> PathBuf {
            self.environment.home_dir.clone()
        }

        fn write(&self, path: &Path, text: &str) {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }

        fn skill(&self, folder: &Path, name: &str) {
            self.write(
                &folder.join(name).join("SKILL.md"),
                &format!("---\nname: {name}\ndescription: {name} skill\n---\n# {name}\n"),
            );
        }

        fn items(&self, enabled: &[AgentAdapterKind]) -> Vec<ContextItem> {
            scan(
                self.project.path(),
                self.project.path(),
                &self.environment,
                enabled,
            )
            .unwrap()
            .items
        }

        fn diagnostics(&self, enabled: &[AgentAdapterKind]) -> Vec<String> {
            scan(
                self.project.path(),
                self.project.path(),
                &self.environment,
                enabled,
            )
            .unwrap()
            .diagnostics
            .into_iter()
            .map(|diagnostic| format!("{} {}", diagnostic.code, diagnostic.message))
            .collect()
        }
    }

    fn plugin<'a>(items: &'a [ContextItem], name: &str) -> &'a ContextItem {
        items
            .iter()
            .find(|item| item.kind == ContextItemKind::Plugin && item.name == name)
            .unwrap_or_else(|| panic!("no plugin {name} in {items:#?}"))
    }

    fn top_level_skills(items: &[ContextItem]) -> Vec<&str> {
        items
            .iter()
            .filter(|item| item.kind == ContextItemKind::Skill)
            .map(|item| item.name.as_str())
            .collect()
    }

    fn component_names(item: &ContextItem) -> Vec<(ContextItemKind, &str)> {
        item.components
            .iter()
            .map(|component| (component.kind, component.name.as_str()))
            .collect()
    }

    #[test]
    fn a_claude_skills_dir_plugin_is_one_row_with_its_skills_as_components() {
        let fixture = Fixture::new();
        let kit = fixture.project.path().join(".claude/skills/kit");
        fixture.write(
            &kit.join(".claude-plugin/plugin.json"),
            r#"{"name":"kit","description":"Team kit","version":"1.2.0","author":{"name":"Team","email":"t@example.com"},"keywords":["team"],"mcpServers":{"db":{"command":"db","env":{"TOKEN":"secret-token"}}}}"#,
        );
        fixture.skill(&kit.join("skills"), "review");
        fixture.write(&kit.join("commands/ship.md"), "ship");
        fixture.write(&kit.join("agents/helper.md"), "helper");
        fixture.write(
            &kit.join("hooks/hooks.json"),
            r#"{"hooks":{"Stop":[{"hooks":[]}],"PreToolUse":[{},{}]}}"#,
        );
        fixture.write(&kit.join("README.md"), "# Kit\nAbout the kit.");

        let items = fixture.items(&[ClaudeCode]);

        let kit = plugin(&items, "kit");
        assert_eq!(kit.providers, vec![ClaudeCode]);
        assert_eq!(kit.description.as_deref(), Some("Team kit"));
        assert_eq!(
            component_names(kit),
            vec![(ContextItemKind::Skill, "review")]
        );
        assert_eq!(kit.components[0].providers, vec![ClaudeCode]);
        assert_eq!(kit.components[0].location, kit.location);
        let facts = kit.plugin.as_ref().unwrap();
        assert_eq!(facts.composition, PluginComposition::Declared);
        assert!(facts.has_readme);
        assert!(kit.preview.markdown.contains("About the kit"));
        let manifest = facts.manifest.as_ref().unwrap();
        assert_eq!(manifest.file, "plugin.json");
        assert_eq!(manifest.version.as_deref(), Some("1.2.0"));
        assert_eq!(manifest.author.as_deref(), Some("Team"));
        assert_eq!(manifest.keywords, vec!["team"]);
        let counts = facts
            .counts
            .iter()
            .map(|count| (count.kind, count.count))
            .collect::<Vec<_>>();
        assert_eq!(
            counts,
            vec![
                (PluginComponentKind::Commands, 1),
                (PluginComponentKind::Subagents, 1),
                (PluginComponentKind::Hooks, 3),
            ]
        );
        // The plugin's skill is no skill row of its own.
        assert!(top_level_skills(&items).is_empty());
        assert!(!format!("{items:?}").contains("secret-token"));

        // The project plugin stays without enabled agents.
        let none = fixture.items(&[]);
        assert_eq!(
            plugin(&none, "kit").unapplied,
            Some(UnappliedReason::NotFound {
                readers: vec![ClaudeCode]
            })
        );

        fixture.write(
            &fixture.project.path().join(".claude/settings.local.json"),
            r#"{"enabledPlugins":{"kit@skills-dir":false}}"#,
        );
        let off = fixture.items(&[ClaudeCode]);
        let kit = plugin(&off, "kit");
        assert!(kit.providers.is_empty());
        assert_eq!(kit.unapplied, Some(UnappliedReason::Disabled));
        assert!(kit.sources[0].readers[0].disabled);
        assert_eq!(kit.components[0].unapplied, Some(UnappliedReason::Disabled));
    }

    #[cfg(unix)]
    #[test]
    fn the_connected_svode_plugin_is_managed_by_svode_without_diagnostics() {
        use std::os::unix::fs::symlink;

        let fixture = Fixture::new();
        let home = fixture.home();
        let payload = home.join(".svode/runtimes/desktop-1/plugins/svode");
        let manifest =
            r#"{"name":"svode","version":"0.0.9","description":"Read and change Svode projects."}"#;
        fixture.write(&payload.join(".claude-plugin/plugin.json"), manifest);
        fixture.write(
            &payload.join("plugin.json"),
            r#"{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"svode"}"#,
        );
        fixture.write(
            &payload.join(".mcp.json"),
            r#"{"mcpServers":{"svode":{"command":"svode-mcp"}}}"#,
        );
        fixture.write(
            &payload.join("mcp.json"),
            r#"{"mcpServers":{"svode":{"command":"svode-mcp"}}}"#,
        );
        fixture.write(&payload.join("bin/svode"), "#!/bin/sh");
        fixture.write(&payload.join("bin/svode-mcp"), "#!/bin/sh");
        fixture.skill(&payload.join("skills"), "svode");
        fixture.write(&payload.join("skills/svode/references/guide.md"), "# Guide");
        symlink("runtimes/desktop-1", home.join(".svode/current")).unwrap();
        std::fs::create_dir_all(home.join(".claude/skills")).unwrap();
        std::fs::create_dir_all(home.join(".agents/skills")).unwrap();
        symlink(
            home.join(".svode/current/plugins/svode"),
            home.join(".claude/skills/svode"),
        )
        .unwrap();
        symlink(
            home.join(".svode/current/plugins/svode/skills/svode"),
            home.join(".agents/skills/svode"),
        )
        .unwrap();

        let enabled = [ClaudeCode, Codex, Opencode, Cursor, GrokBuild];
        let items = fixture.items(&enabled);

        let svode = plugin(&items, "svode");
        assert!(svode.managed_by_svode);
        assert_eq!(svode.providers, vec![ClaudeCode]);
        assert_eq!(
            component_names(svode),
            vec![(ContextItemKind::Skill, "svode")]
        );
        assert!(svode.components[0].managed_by_svode);
        assert_eq!(
            svode.plugin.as_ref().unwrap().counts[0].kind,
            PluginComponentKind::Executables
        );
        // The shared skill is a skill of the agents that read it as one.
        let shared = items
            .iter()
            .find(|item| item.kind == ContextItemKind::Skill && item.name == "svode")
            .unwrap();
        assert!(shared.managed_by_svode);
        assert!(!shared.providers.contains(&ClaudeCode));
        assert_eq!(fixture.diagnostics(&enabled), Vec::<String>::new());
    }

    fn claude_marketplace(fixture: &Fixture) -> PathBuf {
        let home = fixture.home();
        let install = home.join(".claude/plugins/cache/official/design/abc123");
        fixture.write(
            &install.join(".claude-plugin/plugin.json"),
            r#"{"name":"design","description":"Design skill"}"#,
        );
        fixture.skill(&install.join("skills"), "design-review");
        fixture.write(
            &home.join(".claude/plugins/installed_plugins.json"),
            &format!(
                r#"{{"version":2,"plugins":{{"design@official":[{{"scope":"user","installPath":"{}","version":"abc123"}}]}}}}"#,
                install.display()
            ),
        );
        install
    }

    #[test]
    fn a_claude_marketplace_plugin_found_by_cursor_and_grok_is_one_row() {
        let fixture = Fixture::new();
        claude_marketplace(&fixture);
        let home = fixture.home();

        // Claude Code takes it by default; Cursor needs `true`, Grok needs
        // its own `enabled`.
        let items = fixture.items(&[ClaudeCode, Cursor, GrokBuild]);
        let design = plugin(&items, "design");
        assert_eq!(items.iter().filter(|item| item.name == "design").count(), 1);
        assert_eq!(design.providers, vec![ClaudeCode]);
        assert_eq!(
            component_names(design),
            vec![(ContextItemKind::Skill, "design-review")]
        );

        fixture.write(
            &home.join(".claude/settings.json"),
            r#"{"enabledPlugins":{"design@official":true},"env":{"API_KEY":"secret-key"}}"#,
        );
        fixture.write(
            &home.join(".grok/config.toml"),
            "api_key = \"secret-key\"\n[plugins]\nenabled = [\"design\"]\n",
        );
        let items = fixture.items(&[ClaudeCode, Cursor, GrokBuild]);
        let design = plugin(&items, "design");
        assert_eq!(design.providers, vec![ClaudeCode, Cursor, GrokBuild]);
        assert_eq!(design.sources.len(), 1);
        assert!(!format!("{items:?}").contains("secret-key"));

        fixture.write(
            &home.join(".claude/settings.json"),
            r#"{"enabledPlugins":{"design@official":false}}"#,
        );
        let items = fixture.items(&[ClaudeCode, Cursor]);
        assert_eq!(
            plugin(&items, "design").unapplied,
            Some(UnappliedReason::Disabled)
        );
        // A disabled agent adds no machine plugins.
        assert!(
            fixture
                .items(&[Codex])
                .iter()
                .all(|item| item.name != "design")
        );
    }

    #[test]
    fn codex_plugins_follow_its_config_and_remote_installs_are_unverified() {
        let fixture = Fixture::new();
        let cache = fixture.home().join(".codex/plugins/cache");
        for (marketplace, name, version) in [
            ("openai-curated", "drive", "1.0.0"),
            ("openai-curated", "drive", "1.10.0"),
            ("openai-curated-remote", "pages", "0.1.23"),
            ("local-market", "unused", "2.0.0"),
        ] {
            let root = cache.join(marketplace).join(name).join(version);
            fixture.write(
                &root.join(".codex-plugin/plugin.json"),
                &format!(
                    r#"{{"name":"{name}","version":"{version}","skills":"./skills/","interface":{{"composerIcon":"./assets/icon.svg"}}}}"#
                ),
            );
            fixture.write(&root.join("assets/icon.svg"), "<svg/>");
            fixture.skill(&root.join("skills"), &format!("{name}-skill"));
        }
        fixture.write(
            &cache.join("openai-curated-remote/pages/.codex-remote-plugin-install.json"),
            r#"{"schema_version":1}"#,
        );
        fixture.write(
            &fixture.home().join(".codex/config.toml"),
            "[plugins.\"drive@openai-curated\"]\nenabled = true\n",
        );

        let items = fixture.items(&[Codex]);

        let drive = plugin(&items, "drive");
        assert_eq!(drive.providers, vec![Codex]);
        assert_eq!(
            drive
                .plugin
                .as_ref()
                .unwrap()
                .manifest
                .as_ref()
                .unwrap()
                .version
                .as_deref(),
            Some("1.10.0")
        );
        assert!(
            drive
                .icon
                .as_deref()
                .is_some_and(|icon| icon.starts_with("data:image/svg+xml;base64,"))
        );
        assert_eq!(
            component_names(drive),
            vec![(ContextItemKind::Skill, "drive-skill")]
        );
        let pages = plugin(&items, "pages");
        assert_eq!(pages.providers, vec![Codex]);
        assert!(pages.sources[0].readers[0].unverified);
        assert_eq!(
            plugin(&items, "unused").unapplied,
            Some(UnappliedReason::Disabled)
        );
    }

    #[test]
    fn cursor_marketplace_plugins_are_unverified_unless_the_project_turns_them_off() {
        let fixture = Fixture::new();
        let root = fixture
            .home()
            .join(".cursor/plugins/cache/cursor/tools/1.0.0");
        fixture.write(
            &root.join(".cursor-plugin/plugin.json"),
            r#"{"name":"tools","logo":"assets/logo.png"}"#,
        );
        fixture.write(&root.join("assets/logo.png"), "png");
        fixture.write(&root.join("rules/style.mdc"), "rule");

        let items = fixture.items(&[Cursor]);
        let tools = plugin(&items, "tools");
        assert_eq!(tools.providers, vec![Cursor]);
        assert!(tools.sources[0].readers[0].unverified);
        assert!(tools.icon.as_deref().unwrap().starts_with("data:image/png"));
        assert_eq!(
            tools.plugin.as_ref().unwrap().counts[0].kind,
            PluginComponentKind::Rules
        );

        fixture.write(
            &fixture.project.path().join(".cursor/settings.json"),
            "{ // project\n \"plugins\": { \"cursor/tools\": { \"enabled\": false }, },\n}",
        );
        let items = fixture.items(&[Cursor]);
        assert_eq!(
            plugin(&items, "tools").unapplied,
            Some(UnappliedReason::Disabled)
        );
    }

    #[test]
    fn qwen_extensions_bring_their_context_file_and_follow_the_extension_store() {
        let fixture = Fixture::new();
        let qwen = fixture.home().join(".qwen");
        let extension = qwen.join("extensions/helper");
        fixture.write(
            &extension.join("qwen-extension.json"),
            r#"{"name":"helper","version":"0.1.0","contextFileName":"GUIDE.md","mcpServers":{"x":{"command":"x","env":{"KEY":"secret-env"}}}}"#,
        );
        fixture.write(&extension.join("GUIDE.md"), "# Guide");
        fixture.skill(&extension.join("skills"), "helper-skill");
        fixture.write(&extension.join("commands/run.toml"), "prompt = \"run\"");

        let items = fixture.items(&[AgentAdapterKind::QwenCode]);
        let helper = plugin(&items, "helper");
        assert_eq!(helper.providers, vec![AgentAdapterKind::QwenCode]);
        assert_eq!(
            component_names(helper),
            vec![
                (ContextItemKind::Skill, "helper-skill"),
                (ContextItemKind::Instruction, "GUIDE.md")
            ]
        );
        assert!(!format!("{items:?}").contains("secret-env"));

        let target = fixture.project.path().canonicalize().unwrap();
        fixture.write(
            &qwen.join("extension-store/state.json"),
            &format!(
                r#"{{"version":2,"extensions":{{"{id}":{{"name":"helper","defaultActivation":"enabled","workspaceOverrides":{{"{target}":"disabled"}}}}}}}}"#,
                id = "a".repeat(64),
                target = target.display()
            ),
        );
        let items = fixture.items(&[AgentAdapterKind::QwenCode]);
        assert_eq!(
            plugin(&items, "helper").unapplied,
            Some(UnappliedReason::Disabled)
        );
    }

    #[test]
    fn kimi_plugins_bring_a_root_skill_and_their_system_prompt() {
        let fixture = Fixture::new();
        let kimi = fixture.home().join(".kimi-code");
        let root = kimi.join("plugins/managed/notes");
        fixture.write(
            &root.join("kimi.plugin.json"),
            r#"{"name":"notes","description":"Notes","systemPrompt":"Always take notes.","hooks":[{"event":"Stop","command":"x"}],"tools":["ignored"]}"#,
        );
        fixture.write(
            &root.join("SKILL.md"),
            "---\nname: notes\ndescription: notes skill\n---\nbody",
        );
        fixture.write(
            &kimi.join("plugins/installed.json"),
            &format!(
                r#"{{"version":1,"plugins":[{{"id":"notes","root":"{}","enabled":true}}]}}"#,
                root.display()
            ),
        );

        let items = fixture.items(&[KimiCode]);
        let notes = plugin(&items, "notes");
        assert_eq!(notes.providers, vec![KimiCode]);
        assert_eq!(
            component_names(notes),
            vec![
                (ContextItemKind::Skill, "notes"),
                (ContextItemKind::Instruction, "systemPrompt")
            ]
        );
        assert_eq!(notes.components[1].preview.markdown, "Always take notes.");
        assert_eq!(
            notes.plugin.as_ref().unwrap().counts[0].kind,
            PluginComponentKind::Hooks
        );
    }

    #[test]
    fn code_plugins_of_opencode_pi_and_hermes_have_no_components() {
        let fixture = Fixture::new();
        let home = fixture.home();
        let project = fixture.project.path();
        fixture.write(&project.join(".opencode/plugins/notify.ts"), "export {}");
        fixture.write(
            &project.join("opencode.json"),
            r#"{"plugins":["opencode-wakatime@1.0.0","-opencode.config.compatibility"],"provider":{"key":"secret-provider"}}"#,
        );
        fixture.write(
            &home.join(".pi/agent/extensions/guard/index.ts"),
            "export {}",
        );
        fixture.write(
            &home.join(".pi/agent/npm/node_modules/pi-tools/package.json"),
            r#"{"name":"pi-tools","version":"2.0.0","description":"Tools for pi"}"#,
        );
        fixture.write(
            &home.join(".pi/agent/settings.json"),
            r#"{"packages":["npm:pi-tools@2.0.0"]}"#,
        );
        let hermes = home.join(".hermes/plugins");
        fixture.write(
            &hermes.join("tracker/plugin.yaml"),
            "name: tracker\nversion: 1.0.0\ndescription: Tracks\n",
        );
        fixture.write(
            &hermes.join("tools/portable/plugin.json"),
            r#"{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"portable"}"#,
        );
        fixture.skill(&hermes.join("tools/portable/skills"), "portable-skill");
        fixture.write(
            &home.join(".hermes/config.yaml"),
            "plugins:\n  enabled: [tracker, portable]\n  disabled: [portable]\n",
        );

        let items = fixture.items(&[Opencode, Pi, Hermes]);

        for name in [
            "notify",
            "opencode-wakatime",
            "guard",
            "pi-tools",
            "tracker",
        ] {
            let code = plugin(&items, name);
            assert_eq!(
                code.plugin.as_ref().unwrap().composition,
                PluginComposition::Code,
                "{name}"
            );
            assert!(code.components.is_empty(), "{name}");
            assert!(!code.providers.is_empty(), "{name}");
        }
        assert_eq!(
            plugin(&items, "pi-tools").description.as_deref(),
            Some("Tools for pi")
        );
        let portable = plugin(&items, "portable");
        assert_eq!(
            component_names(portable),
            vec![(ContextItemKind::Skill, "portable-skill")]
        );
        assert_eq!(portable.unapplied, Some(UnappliedReason::Disabled));
        assert!(!format!("{items:?}").contains("secret-provider"));
    }

    #[test]
    fn grok_takes_the_first_plugin_of_a_name() {
        let fixture = Fixture::new();
        let project = fixture.project.path();
        fixture.write(
            &project.join(".grok/plugins/kit/plugin.json"),
            r#"{"name":"kit"}"#,
        );
        fixture.write(
            &fixture.home().join(".grok/plugins/kit/plugin.json"),
            r#"{"name":"kit"}"#,
        );
        fixture.write(
            &fixture.home().join(".grok/config.toml"),
            "[plugins]\nenabled = [\"kit\"]\n",
        );

        let items = fixture.items(&[GrokBuild]);
        let kits = items
            .iter()
            .filter(|item| item.name == "kit")
            .collect::<Vec<_>>();
        assert_eq!(kits.len(), 2);
        let personal = kits
            .iter()
            .find(|item| {
                item.location.kind != crate::agent_context::model::ContextLocationKind::Target
            })
            .unwrap();
        assert!(matches!(
            personal.unapplied,
            Some(UnappliedReason::Superseded { .. })
        ));
    }
}

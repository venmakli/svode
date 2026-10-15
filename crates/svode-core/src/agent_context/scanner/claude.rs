use std::collections::{BTreeMap, HashSet};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use regex::Regex;
use serde::Deserialize;

use crate::agent_adapters::{AgentAdapterKind, DirectoryWalk, SourceRegistryEnvironment};

use super::super::model::{
    InstructionDiscovery, InstructionDiscoveryPolicy, InstructionOwner, InstructionOwnerKind,
    InstructionReference, InstructionReferenceStatus, InstructionRow, InstructionSourceKind,
    SourceHealth, SourceResolution, SourceSupport,
};
use super::io::{diagnostic, inspect, path_string};
use super::{DiscoveryResult, TargetPlaces};

const PREVIEW_BYTES: usize = 64 * 1024;
const MAX_IMPORT_DEPTH: usize = 5;
const MAX_IMPORT_REFERENCES: usize = 128;
const SETTINGS_BYTES: u64 = 256 * 1024;
const CLAUDE_NAMES: [&str; 3] = ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"];
const AGENTS_NAMES: [&str; 2] = ["AGENTS.md", ".claude/AGENTS.md"];
/// Ids by which Claude Code settings address its built-in `agents-md`
/// plugin.
const AGENTS_MD_PLUGIN_IDS: [&str; 2] = ["agents-md@builtin", "cc-plugin-agents-md@builtin"];

/// Which instruction files Claude Code loads, by the `instructionFiles`
/// option of its built-in `agents-md` plugin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InstructionFiles {
    ClaudeMd,
    /// The default: `AGENTS.md` only when no CLAUDE file is on the walk.
    ClaudeMdOrAgentsMd,
    ClaudeMdAndAgentsMd,
    /// Only the organization's managed files, which Svode does not scan.
    ManagedOnly,
}

impl InstructionFiles {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "claude-md" => Some(Self::ClaudeMd),
            "claude-md-or-agents-md" => Some(Self::ClaudeMdOrAgentsMd),
            "claude-md-and-agents-md" => Some(Self::ClaudeMdAndAgentsMd),
            "managed-only" => Some(Self::ManagedOnly),
            _ => None,
        }
    }

    /// The legacy `projectInstructions` option, honoured while
    /// `instructionFiles` keeps its default.
    fn parse_legacy(value: &serde_json::Value) -> Self {
        match value.as_str() {
            Some("none") => Self::ManagedOnly,
            Some("agents-fallback") => Self::ClaudeMdOrAgentsMd,
            Some("both") => Self::ClaudeMdAndAgentsMd,
            _ => Self::ClaudeMd,
        }
    }
}

/// The fields of Claude Code user settings that choose instruction files;
/// everything else in the file is skipped while parsing.
#[derive(Debug, Default, Deserialize)]
struct ClaudeSettings {
    #[serde(default, rename = "enabledPlugins")]
    enabled_plugins: BTreeMap<String, serde_json::Value>,
    #[serde(default, rename = "pluginConfigs")]
    plugin_configs: BTreeMap<String, PluginConfig>,
}

#[derive(Debug, Default, Deserialize)]
struct PluginConfig {
    #[serde(default)]
    options: AgentsMdOptions,
}

#[derive(Debug, Default, Deserialize)]
struct AgentsMdOptions {
    #[serde(default, rename = "instructionFiles")]
    instruction_files: Option<serde_json::Value>,
    #[serde(default, rename = "projectInstructions")]
    project_instructions: Option<serde_json::Value>,
}

impl ClaudeSettings {
    fn instruction_files(&self) -> InstructionFiles {
        let plugin_disabled = AGENTS_MD_PLUGIN_IDS
            .iter()
            .find_map(|id| self.enabled_plugins.get(*id))
            .is_some_and(|enabled| enabled.as_bool() == Some(false));
        if plugin_disabled {
            return InstructionFiles::ClaudeMd;
        }
        let Some(options) = AGENTS_MD_PLUGIN_IDS
            .iter()
            .find_map(|id| self.plugin_configs.get(*id))
            .map(|config| &config.options)
        else {
            return InstructionFiles::ClaudeMdOrAgentsMd;
        };
        let chosen = options
            .instruction_files
            .as_ref()
            .and_then(serde_json::Value::as_str)
            .and_then(InstructionFiles::parse)
            .unwrap_or(InstructionFiles::ClaudeMdOrAgentsMd);
        match &options.project_instructions {
            Some(legacy) if chosen == InstructionFiles::ClaudeMdOrAgentsMd => {
                InstructionFiles::parse_legacy(legacy)
            }
            _ => chosen,
        }
    }
}

/// A directory Claude Code walks for instruction files, outermost first.
struct WalkedDirectory {
    directory: PathBuf,
    inside: bool,
    source_kind: InstructionSourceKind,
    owner: InstructionOwner,
    /// Where the file itself may resolve.
    file_root: PathBuf,
    directory_depth: usize,
}

/// `global` reads the Claude configuration: the personal `CLAUDE.md`, user
/// settings and the directories above the repository boundary, which
/// Claude Code walks up to the filesystem root.
pub(super) fn discover(
    places: &TargetPlaces,
    environment: &SourceRegistryEnvironment,
    global: bool,
) -> DiscoveryResult {
    let repository_root = places.repository_root.as_path();
    let mut result = DiscoveryResult::default();
    let personal = environment.claude_config_dir.join("CLAUDE.md");
    let instruction_files = if global {
        read_settings(environment, &mut result).instruction_files()
    } else {
        InstructionFiles::ClaudeMdOrAgentsMd
    };
    if global {
        result.observed_personal_paths.push(path_string(&personal));
        if instruction_files != InstructionFiles::ManagedOnly {
            discover_file(
                &personal,
                &environment.claude_config_dir,
                &environment.claude_config_dir,
                InstructionSourceKind::Personal,
                InstructionOwner {
                    kind: InstructionOwnerKind::ClientConfiguration,
                    root: path_string(&environment.claude_config_dir),
                },
                InstructionDiscoveryPolicy::ClaudeHierarchy,
                0,
                0,
                None,
                &mut result,
            );
        }
    }

    // The filesystem root itself is not on the walk.
    let walk = places
        .walk(DirectoryWalk::FilesystemToTarget)
        .into_iter()
        .filter(|directory| directory.path.parent().is_some() && (directory.inside || global))
        .map(|directory| {
            if directory.inside {
                let directory_depth = places
                    .directory_chain
                    .iter()
                    .position(|chained| *chained == directory.path)
                    .unwrap_or_default();
                WalkedDirectory {
                    owner: InstructionOwner {
                        kind: InstructionOwnerKind::TargetSpace,
                        root: path_string(&directory.path),
                    },
                    directory: directory.path,
                    inside: true,
                    source_kind: InstructionSourceKind::Project,
                    file_root: places.repository_root.clone(),
                    directory_depth,
                }
            } else {
                let root = places.outside_root(&directory.path);
                WalkedDirectory {
                    owner: InstructionOwner {
                        kind: InstructionOwnerKind::ClientConfiguration,
                        root: path_string(&root),
                    },
                    directory: directory.path,
                    inside: false,
                    source_kind: InstructionSourceKind::Personal,
                    file_root: root,
                    directory_depth: 0,
                }
            }
        })
        .collect::<Vec<_>>();
    let observe = |result: &mut DiscoveryResult, walked: &WalkedDirectory, path: &Path| {
        if walked.inside {
            result.observed_project_paths.push(path_string(path));
        } else {
            result.observed_personal_paths.push(path_string(path));
        }
    };

    // The personal file is the user's, not a file on the walk, even where the
    // walk passes the Claude configuration directory.
    let walked_personal = environment
        .claude_config_dir
        .canonicalize()
        .unwrap_or_else(|_| environment.claude_config_dir.clone())
        .join("CLAUDE.md");
    let mut claude_files = Vec::new();
    let first_claude_row = result.rows.len();
    for walked in &walk {
        for (precedence, name) in CLAUDE_NAMES.iter().enumerate() {
            let candidate = walked.directory.join(name);
            if candidate == walked_personal {
                continue;
            }
            observe(&mut result, walked, &candidate);
            if candidate.is_file() {
                claude_files.push(candidate.clone());
            }
            if instruction_files == InstructionFiles::ManagedOnly {
                continue;
            }
            discover_file(
                &candidate,
                &walked.file_root,
                repository_root,
                walked.source_kind,
                walked.owner.clone(),
                InstructionDiscoveryPolicy::ClaudeHierarchy,
                walked.directory_depth,
                precedence,
                None,
                &mut result,
            );
        }
    }
    let loaded_claude_texts = result.rows[first_claude_row..]
        .iter()
        .filter_map(|row| {
            let preview = row.preview.as_ref()?;
            let text = preview.markdown.trim();
            (!preview.truncated && !text.is_empty()).then(|| (text.to_string(), row.path.clone()))
        })
        .collect::<Vec<_>>();

    if matches!(
        instruction_files,
        InstructionFiles::ClaudeMd | InstructionFiles::ManagedOnly
    ) {
        return result;
    }
    // By default a CLAUDE file anywhere on the walk keeps every `AGENTS.md`
    // out; the nearest one is named as what shadows them.
    let shadowed_by = (instruction_files == InstructionFiles::ClaudeMdOrAgentsMd)
        .then(|| claude_files.last().map(|path| path_string(path)))
        .flatten();
    for walked in &walk {
        for (precedence, name) in AGENTS_NAMES.iter().enumerate() {
            let candidate = walked.directory.join(name);
            observe(&mut result, walked, &candidate);
            discover_file(
                &candidate,
                &walked.file_root,
                repository_root,
                walked.source_kind,
                walked.owner.clone(),
                InstructionDiscoveryPolicy::ClaudeAgentsMd,
                walked.directory_depth,
                precedence,
                Some(Shadowing {
                    by: shadowed_by.clone(),
                    loaded_texts: &loaded_claude_texts,
                }),
                &mut result,
            );
        }
    }
    result
}

/// How an `AGENTS.md` is shadowed for Claude Code: by a CLAUDE file on the
/// walk, or, beside CLAUDE files, by one with the same text.
struct Shadowing<'a> {
    by: Option<String>,
    loaded_texts: &'a [(String, String)],
}

impl Shadowing<'_> {
    fn of(&self, markdown: &str) -> Option<String> {
        if let Some(by) = &self.by {
            return Some(by.clone());
        }
        let text = markdown.trim();
        self.loaded_texts
            .iter()
            .find(|(loaded, _)| !text.is_empty() && loaded == text)
            .map(|(_, path)| path.clone())
    }
}

#[allow(clippy::too_many_arguments)]
fn discover_file(
    path: &Path,
    file_root: &Path,
    import_root: &Path,
    source_kind: InstructionSourceKind,
    owner: InstructionOwner,
    policy: InstructionDiscoveryPolicy,
    directory_depth: usize,
    precedence: usize,
    shadowing: Option<Shadowing<'_>>,
    result: &mut DiscoveryResult,
) {
    let adapter_id = AgentAdapterKind::ClaudeCode;
    let Some(mut source) = inspect(path, file_root, PREVIEW_BYTES, Some(adapter_id)) else {
        return;
    };
    let mut health_reasons = Vec::new();
    if let Some(diagnostic) = source.diagnostic.take() {
        health_reasons.push(diagnostic.message.clone());
        result.diagnostics.push(diagnostic);
    }
    let Some(preview) = &source.preview else {
        return;
    };
    let superseded_by = shadowing.and_then(|shadowing| shadowing.of(&preview.markdown));
    let mut references = Vec::new();
    if superseded_by.is_none() {
        let mut visited = HashSet::from([source
            .canonical_path
            .clone()
            .unwrap_or_else(|| path.to_path_buf())]);
        collect_references(
            path,
            &preview.markdown,
            import_root,
            1,
            &mut visited,
            &mut references,
            result,
        );
    }
    result.rows.push(InstructionRow {
        id: format!("claude-code:{}", path_string(path)),
        adapter_id: Some(adapter_id),
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "CLAUDE.md".to_string()),
        path: path_string(path),
        canonical_path: source.canonical_path.as_deref().map(path_string),
        link_kind: source.link_kind,
        owner,
        source_kind,
        support: SourceSupport::ClientNative,
        resolution: if superseded_by.is_some() {
            SourceResolution::Superseded
        } else {
            SourceResolution::Included
        },
        health: if health_reasons.is_empty() {
            SourceHealth::Normal
        } else {
            SourceHealth::Degraded
        },
        health_reasons,
        discovery: InstructionDiscovery {
            policy,
            directory_depth,
            precedence,
        },
        superseded_by,
        preview: source.preview,
        references,
    });
}

/// Reads the fields of the Claude user settings that choose instruction
/// files. A missing file keeps the defaults; an unreadable one is a
/// diagnostic that never quotes the file.
fn read_settings(
    environment: &SourceRegistryEnvironment,
    result: &mut DiscoveryResult,
) -> ClaudeSettings {
    let path = environment.claude_config_dir.join("settings.json");
    result.observed_personal_paths.push(path_string(&path));
    let adapter_id = Some(AgentAdapterKind::ClaudeCode);
    let file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return ClaudeSettings::default();
        }
        Err(error) => {
            result.diagnostics.push(diagnostic(
                &path,
                adapter_id,
                "claude_settings_read",
                format!("Could not read Claude Code settings: {}", error.kind()),
            ));
            return ClaudeSettings::default();
        }
    };
    let mut bytes = Vec::new();
    if let Err(error) = file.take(SETTINGS_BYTES + 1).read_to_end(&mut bytes) {
        result.diagnostics.push(diagnostic(
            &path,
            adapter_id,
            "claude_settings_read",
            format!("Could not read Claude Code settings: {}", error.kind()),
        ));
        return ClaudeSettings::default();
    }
    if bytes.len() > SETTINGS_BYTES as usize {
        result.diagnostics.push(diagnostic(
            &path,
            adapter_id,
            "claude_settings_limit",
            "Claude Code settings exceed the supported 256 KiB scan limit".to_string(),
        ));
        return ClaudeSettings::default();
    }
    match serde_json::from_slice(&bytes) {
        Ok(settings) => settings,
        Err(error) => {
            result.diagnostics.push(diagnostic(
                &path,
                adapter_id,
                "claude_settings_parse",
                format!(
                    "Could not parse Claude Code settings at line {}, column {}",
                    error.line(),
                    error.column()
                ),
            ));
            ClaudeSettings::default()
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn collect_references(
    source_path: &Path,
    markdown: &str,
    allowed_root: &Path,
    depth: usize,
    visited: &mut HashSet<PathBuf>,
    references: &mut Vec<InstructionReference>,
    result: &mut DiscoveryResult,
) {
    if depth > MAX_IMPORT_DEPTH || references.len() >= MAX_IMPORT_REFERENCES {
        return;
    }
    let import_pattern = Regex::new(r"(?m)(?:^|\s)@([^\s`]+)").expect("valid import regex");
    for capture in import_pattern.captures_iter(markdown) {
        if references.len() >= MAX_IMPORT_REFERENCES {
            result.diagnostics.push(diagnostic(
                source_path,
                Some(AgentAdapterKind::ClaudeCode),
                "claude_import_limit",
                format!("Claude import graph exceeded {MAX_IMPORT_REFERENCES} references"),
            ));
            break;
        }
        let Some(token) = capture
            .get(1)
            .map(|value| trim_import_token(value.as_str()))
        else {
            continue;
        };
        if token.is_empty() || token.contains("://") {
            continue;
        }
        let Some(candidate) = resolve_import_path(source_path, token) else {
            continue;
        };
        result.observed_project_paths.push(path_string(&candidate));
        if !candidate.starts_with(allowed_root) {
            references.push(InstructionReference {
                path: path_string(&candidate),
                canonical_path: None,
                depth,
                status: InstructionReferenceStatus::RequiresClientApproval,
                preview: None,
            });
            result.diagnostics.push(diagnostic(
                source_path,
                Some(AgentAdapterKind::ClaudeCode),
                "claude_import_external",
                format!(
                    "Claude import {} is outside the allowed scan boundary and requires client approval",
                    candidate.display()
                ),
            ));
            continue;
        }
        let Some(mut inspected) = inspect(
            &candidate,
            allowed_root,
            PREVIEW_BYTES,
            Some(AgentAdapterKind::ClaudeCode),
        ) else {
            references.push(InstructionReference {
                path: path_string(&candidate),
                canonical_path: None,
                depth,
                status: InstructionReferenceStatus::Unreadable,
                preview: None,
            });
            continue;
        };
        if let Some(diagnostic) = inspected.diagnostic.take() {
            result.diagnostics.push(diagnostic);
        }
        let canonical = inspected
            .canonical_path
            .clone()
            .unwrap_or_else(|| candidate.clone());
        if !visited.insert(canonical.clone()) {
            references.push(InstructionReference {
                path: path_string(&candidate),
                canonical_path: Some(path_string(&canonical)),
                depth,
                status: InstructionReferenceStatus::Cyclic,
                preview: None,
            });
            result.diagnostics.push(diagnostic(
                source_path,
                Some(AgentAdapterKind::ClaudeCode),
                "claude_import_cycle",
                format!("Claude import cycle includes {}", candidate.display()),
            ));
            continue;
        }
        let preview = inspected.preview.clone();
        references.push(InstructionReference {
            path: path_string(&candidate),
            canonical_path: inspected.canonical_path.as_deref().map(path_string),
            depth,
            status: if preview.is_some() {
                InstructionReferenceStatus::Included
            } else {
                InstructionReferenceStatus::OutsideBoundary
            },
            preview,
        });
        if depth < MAX_IMPORT_DEPTH {
            if let Some(preview) = inspected.preview {
                collect_references(
                    &candidate,
                    &preview.markdown,
                    allowed_root,
                    depth + 1,
                    visited,
                    references,
                    result,
                );
            }
        } else if inspected
            .preview
            .as_ref()
            .is_some_and(|preview| import_pattern.is_match(&preview.markdown))
        {
            result.diagnostics.push(diagnostic(
                &candidate,
                Some(AgentAdapterKind::ClaudeCode),
                "claude_import_depth",
                format!("Claude import graph reached maximum depth {MAX_IMPORT_DEPTH}"),
            ));
        }
    }
}

fn trim_import_token(token: &str) -> &str {
    token.trim_end_matches(|character: char| {
        matches!(character, '.' | ',' | ';' | ':' | ')' | ']' | '}')
    })
}

fn resolve_import_path(source_path: &Path, token: &str) -> Option<PathBuf> {
    if token.starts_with('~') || Path::new(token).is_absolute() {
        return lexical_normalize(Path::new(token));
    }
    lexical_normalize(&source_path.parent()?.join(token))
}

fn lexical_normalize(path: &Path) -> Option<PathBuf> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(Path::new(std::path::MAIN_SEPARATOR_STR)),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return None;
                }
            }
            Component::Normal(value) => normalized.push(value),
        }
    }
    Some(normalized)
}

/// A plugin `installed_plugins.json` of Claude Code names.
#[derive(Debug, Clone)]
pub(super) struct InstalledPlugin {
    /// `<plugin>@<marketplace>`.
    pub id: String,
    /// `user`, `project`, `local` or `managed`.
    pub scope: String,
    pub project_path: Option<PathBuf>,
    pub install_path: PathBuf,
}

#[derive(Deserialize)]
struct InstalledRegistry {
    #[serde(default)]
    plugins: BTreeMap<String, Vec<InstalledEntry>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledEntry {
    scope: Option<String>,
    project_path: Option<String>,
    install_path: Option<String>,
}

/// The installs of the Claude Code plugin registry, which `adapter_id` reads.
pub(super) fn installed_plugins(
    registry: &Path,
    adapter_id: AgentAdapterKind,
    result: &mut DiscoveryResult,
) -> Vec<InstalledPlugin> {
    result.observed_personal_paths.push(path_string(registry));
    let Some(text) = super::io::read_config_text(
        registry,
        Some(adapter_id),
        "claude_plugin_registry",
        "Claude Code plugin registry",
        &mut result.diagnostics,
    ) else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<InstalledRegistry>(&text) else {
        result.diagnostics.push(diagnostic(
            registry,
            Some(adapter_id),
            "claude_plugin_registry_parse",
            "Could not parse the Claude Code plugin registry".to_string(),
        ));
        return Vec::new();
    };
    parsed
        .plugins
        .into_iter()
        .flat_map(|(id, entries)| {
            entries.into_iter().filter_map(move |entry| {
                Some(InstalledPlugin {
                    id: id.clone(),
                    scope: entry.scope.unwrap_or_else(|| "user".to_string()),
                    project_path: entry.project_path.map(PathBuf::from),
                    install_path: PathBuf::from(entry.install_path?),
                })
            })
        })
        .collect()
}

#[derive(Deserialize)]
struct PluginSettings {
    #[serde(default, rename = "enabledPlugins")]
    enabled_plugins: BTreeMap<String, serde_json::Value>,
}

/// `enabledPlugins` of the Claude Code settings: the user settings in
/// `user_dir` when given, then `.claude/settings.json` and
/// `.claude/settings.local.json` of the target; a later file wins.
pub(super) fn enabled_plugins(
    user_dir: Option<&Path>,
    target_root: &Path,
    adapter_id: AgentAdapterKind,
    result: &mut DiscoveryResult,
) -> BTreeMap<String, bool> {
    let mut files = Vec::new();
    if let Some(user_dir) = user_dir {
        let user = user_dir.join("settings.json");
        result.observed_personal_paths.push(path_string(&user));
        files.push(user);
    }
    for name in ["settings.json", "settings.local.json"] {
        let project = target_root.join(".claude").join(name);
        result.observed_project_paths.push(path_string(&project));
        files.push(project);
    }
    let mut enabled = BTreeMap::new();
    for file in files {
        let Some(text) = super::io::read_config_text(
            &file,
            Some(adapter_id),
            "claude_settings",
            "Claude Code settings",
            &mut result.diagnostics,
        ) else {
            continue;
        };
        let settings = match serde_json::from_str::<PluginSettings>(&text) {
            Ok(settings) => settings,
            Err(error) => {
                result.diagnostics.push(diagnostic(
                    &file,
                    Some(adapter_id),
                    "claude_settings_parse",
                    format!(
                        "Could not parse Claude Code settings at line {}, column {}",
                        error.line(),
                        error.column()
                    ),
                ));
                continue;
            }
        };
        for (id, value) in settings.enabled_plugins {
            if let Some(on) = value.as_bool() {
                enabled.insert(id, on);
            }
        }
    }
    enabled
}

/// The `projects` key of the global config of Claude Code for a target: the
/// root of its main repository, which its worktrees share, else the target.
pub(super) fn project_key(places: &TargetPlaces) -> PathBuf {
    let git = places.repository_root.join(".git");
    if git.is_dir() {
        return places.repository_root.clone();
    }
    // A worktree's `.git` file names `<main>/.git/worktrees/<name>`.
    let main = std::fs::read_to_string(&git).ok().and_then(|text| {
        let gitdir = text.lines().find_map(|line| line.strip_prefix("gitdir:"))?;
        let gitdir = places.repository_root.join(gitdir.trim());
        let worktrees = gitdir.parent()?;
        if worktrees.file_name()? != "worktrees" {
            return None;
        }
        Some(worktrees.parent()?.parent()?.to_path_buf())
    });
    match main {
        Some(main) => main.canonicalize().unwrap_or(main),
        None if git.exists() => places.repository_root.clone(),
        None => places.target_root.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn root_precedence_and_external_import_stay_explicit() {
        let project = TempDir::new().unwrap();
        std::fs::create_dir(project.path().join(".git")).unwrap();
        std::fs::create_dir(project.path().join(".claude")).unwrap();
        std::fs::write(project.path().join("CLAUDE.md"), "root\n@../outside.md").unwrap();
        std::fs::write(project.path().join(".claude/CLAUDE.md"), "shadowed").unwrap();
        let home = TempDir::new().unwrap();
        let environment = SourceRegistryEnvironment::for_tests(home.path().to_path_buf());

        let rows = super::super::discover(
            project.path(),
            project.path(),
            &environment,
            &[AgentAdapterKind::ClaudeCode],
        )
        .unwrap()
        .instructions
        .into_iter()
        .filter(|row| row.adapter_id == Some(AgentAdapterKind::ClaudeCode))
        .collect::<Vec<_>>();
        let root = rows
            .iter()
            .find(|row| row.path.ends_with("/CLAUDE.md") && !row.path.contains("/.claude/"))
            .unwrap();
        let shadowed = rows
            .iter()
            .find(|row| row.path.contains("/.claude/CLAUDE.md"))
            .unwrap();

        assert_eq!(root.resolution, SourceResolution::Included);
        assert_eq!(shadowed.resolution, SourceResolution::Included);
        assert_eq!(
            root.references[0].status,
            InstructionReferenceStatus::RequiresClientApproval
        );
        assert!(root.references[0].preview.is_none());
    }

    struct Walk {
        home: TempDir,
        project: PathBuf,
        environment: SourceRegistryEnvironment,
    }

    impl Walk {
        /// A project repository two levels below the home directory.
        fn new() -> Self {
            let home = TempDir::new().unwrap();
            let project = home.path().join("work/proj");
            std::fs::create_dir_all(project.join(".git")).unwrap();
            let environment = SourceRegistryEnvironment::for_tests(home.path().to_path_buf());
            Self {
                home,
                project,
                environment,
            }
        }

        fn write(&self, relative: &str, text: &str) -> String {
            let path = self.home.path().join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, text).unwrap();
            path_string(&path.canonicalize().unwrap())
        }

        fn settings(&self, json: &str) {
            self.write(".claude/settings.json", json);
        }

        fn discovery(&self, enabled: bool) -> crate::agent_context::model::AgentContextDiscovery {
            let enabled: &[AgentAdapterKind] = if enabled {
                &[AgentAdapterKind::ClaudeCode]
            } else {
                &[]
            };
            super::super::discover(&self.project, &self.project, &self.environment, enabled)
                .unwrap()
        }

        fn rows(&self, enabled: bool) -> Vec<InstructionRow> {
            self.discovery(enabled)
                .instructions
                .into_iter()
                .filter(|row| row.adapter_id == Some(AgentAdapterKind::ClaudeCode))
                .collect()
        }
    }

    fn find<'a>(rows: &'a [InstructionRow], path: &str) -> &'a InstructionRow {
        rows.iter()
            .find(|row| row.canonical_path.as_deref() == Some(path))
            .unwrap_or_else(|| panic!("no Claude row {path} in {rows:#?}"))
    }

    fn agents_md_paths(rows: &[InstructionRow]) -> Vec<&str> {
        rows.iter()
            .filter(|row| row.discovery.policy == InstructionDiscoveryPolicy::ClaudeAgentsMd)
            .map(|row| row.path.as_str())
            .collect()
    }

    #[test]
    fn agents_md_is_read_where_no_claude_file_is_on_the_walk_and_the_personal_file_does_not_count()
    {
        let walk = Walk::new();
        let agents = walk.write("work/proj/AGENTS.md", "agents");
        let dot_agents = walk.write("work/proj/.claude/AGENTS.md", "dot agents");
        walk.write(".claude/CLAUDE.md", "personal");

        let rows = walk.rows(true);

        for path in [&agents, &dot_agents] {
            let row = find(&rows, path);
            assert_eq!(row.resolution, SourceResolution::Included);
            assert_eq!(
                row.discovery.policy,
                InstructionDiscoveryPolicy::ClaudeAgentsMd
            );
        }
        let personal = rows
            .iter()
            .filter(|row| row.path.ends_with("/.claude/CLAUDE.md"))
            .collect::<Vec<_>>();
        assert_eq!(personal.len(), 1);
        assert_eq!(personal[0].source_kind, InstructionSourceKind::Personal);
    }

    #[test]
    fn the_nearest_claude_file_on_the_walk_shadows_every_agents_md() {
        let walk = Walk::new();
        let agents = walk.write("work/proj/AGENTS.md", "agents");
        let local = walk.write("work/proj/CLAUDE.local.md", "local");
        walk.write("work/CLAUDE.md", "ancestor");

        let rows = walk.rows(true);

        let shadowed = find(&rows, &agents);
        assert_eq!(shadowed.resolution, SourceResolution::Superseded);
        assert!(
            shadowed
                .superseded_by
                .as_deref()
                .unwrap()
                .ends_with("/CLAUDE.local.md")
        );
        assert!(shadowed.references.is_empty());
        assert_eq!(find(&rows, &local).resolution, SourceResolution::Included);
    }

    #[test]
    fn files_above_the_repository_boundary_are_read_only_while_claude_is_enabled() {
        let walk = Walk::new();
        let agents = walk.write("work/proj/AGENTS.md", "agents");
        let ancestor = walk.write("work/CLAUDE.md", "ancestor @proj/AGENTS.md");
        let ancestor_agents = walk.write("work/AGENTS.md", "ancestor agents");

        let enabled = walk.discovery(true);
        let rows = enabled
            .instructions
            .iter()
            .filter(|row| row.adapter_id == Some(AgentAdapterKind::ClaudeCode))
            .cloned()
            .collect::<Vec<_>>();
        let above = find(&rows, &ancestor);
        assert_eq!(above.source_kind, InstructionSourceKind::Personal);
        assert_eq!(above.resolution, SourceResolution::Included);
        assert_eq!(
            above.references[0].status,
            InstructionReferenceStatus::Included
        );
        assert!(enabled.observed_personal_paths.contains(&above.path));
        assert_eq!(
            find(&rows, &ancestor_agents).resolution,
            SourceResolution::Superseded
        );
        assert_eq!(
            find(&rows, &agents).resolution,
            SourceResolution::Superseded
        );

        let disabled = walk.rows(false);
        assert!(
            disabled
                .iter()
                .all(|row| row.source_kind != InstructionSourceKind::Personal)
        );
        assert_eq!(
            find(&disabled, &agents).resolution,
            SourceResolution::Included
        );
    }

    #[test]
    fn the_home_dot_claude_file_is_on_the_walk_when_the_configuration_lives_elsewhere() {
        let mut walk = Walk::new();
        walk.environment.claude_config_dir = walk.home.path().join("cfg");
        let agents = walk.write("work/proj/AGENTS.md", "agents");
        let home_dot_claude = walk.write(".claude/CLAUDE.md", "home .claude");

        let rows = walk.rows(true);

        assert_eq!(
            find(&rows, &home_dot_claude).source_kind,
            InstructionSourceKind::Personal
        );
        assert_eq!(
            find(&rows, &agents).superseded_by.as_deref(),
            Some(home_dot_claude.as_str())
        );
    }

    #[test]
    fn beside_claude_files_an_agents_md_with_the_same_text_is_shadowed_by_it() {
        let walk = Walk::new();
        walk.settings(
            r#"{"pluginConfigs":{"agents-md@builtin":{"options":{"instructionFiles":"claude-md-and-agents-md"}}}}"#,
        );
        let agents = walk.write("work/proj/AGENTS.md", "same text\n");
        let claude = walk.write("work/proj/CLAUDE.md", "same text");
        let dot_agents = walk.write("work/proj/.claude/AGENTS.md", "other text");

        let rows = walk.rows(true);

        assert_eq!(
            find(&rows, &agents).superseded_by.as_deref(),
            Some(claude.as_str())
        );
        assert_eq!(
            find(&rows, &dot_agents).resolution,
            SourceResolution::Included
        );
    }

    #[test]
    fn instruction_files_option_and_plugin_switch_choose_what_claude_reads() {
        let cases = [
            (
                r#"{"pluginConfigs":{"agents-md@builtin":{"options":{"instructionFiles":"claude-md"}}}}"#,
                0,
                1,
            ),
            (r#"{"enabledPlugins":{"agents-md@builtin":false}}"#, 0, 1),
            (
                r#"{"pluginConfigs":{"cc-plugin-agents-md@builtin":{"options":{"projectInstructions":"both"}}}}"#,
                2,
                1,
            ),
            (
                r#"{"pluginConfigs":{"agents-md@builtin":{"options":{"instructionFiles":"managed-only"}}}}"#,
                0,
                0,
            ),
        ];
        for (settings, agents_rows, claude_rows) in cases {
            let walk = Walk::new();
            walk.settings(settings);
            walk.write("work/proj/AGENTS.md", "agents");
            walk.write("work/proj/.claude/AGENTS.md", "dot agents");
            walk.write("work/proj/CLAUDE.md", "claude");

            let rows = walk.rows(true);

            let included_agents = rows
                .iter()
                .filter(|row| {
                    row.discovery.policy == InstructionDiscoveryPolicy::ClaudeAgentsMd
                        && row.resolution == SourceResolution::Included
                })
                .count();
            assert_eq!(included_agents, agents_rows, "{settings}");
            assert_eq!(
                rows.len() - agents_md_paths(&rows).len(),
                claude_rows,
                "{settings}"
            );
        }
    }

    #[test]
    fn user_settings_are_read_only_while_claude_is_enabled() {
        let walk = Walk::new();
        walk.settings(r#"{"enabledPlugins":{"agents-md@builtin":false}}"#);
        walk.write("work/proj/AGENTS.md", "agents");

        assert!(agents_md_paths(&walk.rows(true)).is_empty());
        assert_eq!(agents_md_paths(&walk.rows(false)).len(), 1);
    }

    #[test]
    fn unparseable_settings_keep_the_defaults_without_quoting_the_file() {
        let walk = Walk::new();
        walk.settings(r#"{"env":{"API_KEY":"sk-do-not-show"},"enabledPlugins":"#);
        walk.write("work/proj/AGENTS.md", "agents");

        let discovery = walk.discovery(true);

        assert_eq!(
            discovery
                .instructions
                .iter()
                .filter(|row| row.discovery.policy == InstructionDiscoveryPolicy::ClaudeAgentsMd)
                .count(),
            1
        );
        let diagnostic = discovery
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == "claude_settings_parse")
            .unwrap();
        assert!(!diagnostic.message.contains("sk-do-not-show"));
        assert!(!format!("{discovery:?}").contains("sk-do-not-show"));
    }
}

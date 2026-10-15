//! A plugin as its folder and manifest declare it (Stage 10 `05`,
//! «Плагины»): the manifest fields the "Context" shows, its icon and
//! `README.md`, and its components — skills, instructions and MCP servers as
//! rows, the other kinds as counts. Only allowlisted manifest fields are
//! kept: a manifest may declare MCP servers with secrets, whose fields are
//! allowlisted too.

use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use base64::Engine as _;

use crate::agent_adapters::{AgentAdapterKind, PluginManifestRule, PluginScheme};

use super::super::model::{
    AgentContextDiagnostic, InstructionOwner, MarkdownPreview, PluginComponentCount,
    PluginComponentKind, PluginComposition, PluginInstruction, PluginManifestFacts,
    PluginMcpServer, SkillRow,
};
use super::io::{diagnostic, inspect, path_string, read_config_text};
use super::mcp_config::{self, McpDeclaration};

const README: &str = "README.md";
const PREVIEW_BYTES: usize = 64 * 1024;
const ICON_BYTES: u64 = 64 * 1024;
/// Entries of one component folder the scanner reads.
const MAX_ENTRIES: usize = 512;
/// How deep component folders such as `commands/` are counted.
const MAX_COUNT_DEPTH: usize = 4;
/// Folders that make a folder without a manifest a plugin of the client
/// layout.
const CONVENTIONAL_COMPONENTS: &[&str] = &[
    "skills",
    "commands",
    "agents",
    "hooks/hooks.json",
    ".mcp.json",
    ".lsp.json",
];

/// What a plugin folder declares.
#[derive(Debug, Clone)]
pub(super) struct PluginFolder {
    pub name: String,
    pub description: Option<String>,
    /// The file the plugin opens: its manifest, its module, else the folder.
    pub path: PathBuf,
    pub composition: PluginComposition,
    pub manifest: Option<PluginManifestFacts>,
    /// `defaultEnabled` of a Claude Code manifest.
    pub default_enabled: Option<bool>,
    pub icon: Option<String>,
    pub readme: Option<MarkdownPreview>,
    pub skills: Vec<SkillRow>,
    pub instructions: Vec<PluginInstruction>,
    pub mcp_servers: Vec<PluginMcpServer>,
    pub counts: Vec<PluginComponentCount>,
    /// Why a part of the plugin was not read.
    pub problems: Vec<String>,
}

/// How a source names a plugin folder.
pub(super) struct FolderRule<'a> {
    pub manifests: &'a [PluginManifestRule],
    pub manifest_required: bool,
    /// A registry names the folder, so it is a plugin even without a
    /// manifest or a component.
    pub registered: bool,
}

/// The plugin `canonical` is, or `None` when it is no plugin of the rule.
/// `fallback_name` names a plugin whose manifest does not.
pub(super) fn read(
    canonical: &Path,
    fallback_name: &str,
    rule: &FolderRule<'_>,
    owner: &InstructionOwner,
    adapter_id: AgentAdapterKind,
    diagnostics: &mut Vec<AgentContextDiagnostic>,
) -> Option<PluginFolder> {
    if canonical.is_file() {
        return Some(code_module(canonical));
    }
    let found = rule
        .manifests
        .iter()
        .find(|manifest| canonical.join(&manifest.path).is_file());
    let scheme = match found {
        Some(manifest) => manifest.scheme,
        None if rule.manifest_required => return None,
        None => match rule.manifests.first().map(|manifest| manifest.scheme) {
            Some(PluginScheme::Code) => {
                if !rule.registered && !has_module_entry(canonical) {
                    return None;
                }
                PluginScheme::Code
            }
            _ => {
                if !rule.registered
                    && !CONVENTIONAL_COMPONENTS
                        .iter()
                        .any(|component| canonical.join(component).exists())
                {
                    return None;
                }
                PluginScheme::ClientFolders
            }
        },
    };

    let mut folder = PluginFolder {
        name: fallback_name.to_string(),
        description: None,
        path: canonical.to_path_buf(),
        composition: if scheme == PluginScheme::Code {
            PluginComposition::Code
        } else {
            PluginComposition::Declared
        },
        manifest: None,
        default_enabled: None,
        icon: None,
        readme: None,
        skills: Vec::new(),
        instructions: Vec::new(),
        mcp_servers: Vec::new(),
        counts: Vec::new(),
        problems: Vec::new(),
    };
    let mut document = None;
    if let Some(manifest) = found {
        let path = canonical.join(&manifest.path);
        folder.path = path.clone();
        document = parse_manifest(&path, adapter_id, &mut folder.problems, diagnostics);
        let file = Path::new(&manifest.path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| manifest.path.clone());
        folder.manifest = Some(manifest_facts(file, document.as_ref()));
    } else if let Some(entry) = if scheme == PluginScheme::Code {
        module_entry(canonical)
    } else {
        // "Open with" opens a file: the README or a component file.
        [README, ".mcp.json", ".lsp.json", "hooks/hooks.json"]
            .iter()
            .map(|name| canonical.join(name))
            .find(|path| path.is_file())
    } {
        folder.path = entry;
    }
    if let Some(document) = &document {
        if let Some(name) = text(document.get("name")) {
            folder.name = name;
        }
        folder.description = text(document.get("description"));
        folder.default_enabled = document
            .get("defaultEnabled")
            .and_then(|value| value.as_bool());
        folder.icon = icon(canonical, document);
    }
    folder.readme = readme(canonical, adapter_id);

    let manifest = document.unwrap_or(serde_json::Value::Null);
    let mut reader = Components {
        canonical,
        owner,
        adapter_id,
        folder: &mut folder,
        diagnostics,
    };
    match scheme {
        PluginScheme::AgentPlugins => {
            reader.skills(&["skills".to_string()]);
            reader.mcp_file("mcp.json");
        }
        PluginScheme::ClientFolders | PluginScheme::QwenExtension => {
            reader.skills(&paths(&manifest, "skills", "skills"));
            reader.mcp_manifest(&manifest, scheme == PluginScheme::ClientFolders);
            reader.count_files(
                PluginComponentKind::Commands,
                &paths(&manifest, "commands", "commands"),
                &["md", "toml"],
            );
            reader.count_files(
                PluginComponentKind::Subagents,
                &paths(&manifest, "agents", "agents"),
                &["md", "yaml", "yml"],
            );
            reader.count_hooks(&manifest);
            reader.count_files(
                PluginComponentKind::Rules,
                &["rules".to_string()],
                &["md", "mdc", "markdown"],
            );
            reader.count_files(PluginComponentKind::Executables, &["bin".to_string()], &[]);
            reader.count_lsp(&manifest);
            reader.count_files(PluginComponentKind::Themes, &["themes".to_string()], &[]);
            if scheme == PluginScheme::QwenExtension {
                let names = match manifest.get("contextFileName") {
                    Some(serde_json::Value::String(name)) => vec![name.clone()],
                    Some(serde_json::Value::Array(names)) => names
                        .iter()
                        .filter_map(|name| name.as_str().map(str::to_string))
                        .collect(),
                    _ => vec!["QWEN.md".to_string()],
                };
                for name in names {
                    reader.instruction_file(&name);
                }
            }
        }
        PluginScheme::KimiPlugin => {
            let declared = paths(&manifest, "skills", "");
            if canonical.join("SKILL.md").is_file() {
                reader.skill(canonical);
            }
            reader.skills(
                &declared
                    .into_iter()
                    .filter(|path| !path.is_empty())
                    .collect::<Vec<_>>(),
            );
            reader.count_files(
                PluginComponentKind::Commands,
                &paths(&manifest, "commands", "commands"),
                &["md"],
            );
            reader.count_files(
                PluginComponentKind::Subagents,
                &paths(&manifest, "agents", "agents"),
                &["md", "yaml", "yml"],
            );
            reader.count_hooks(&manifest);
            reader.mcp_manifest(&manifest, false);
            if let Some(prompt) = text(manifest.get("systemPrompt")) {
                let path = path_string(&reader.folder.path);
                reader.folder.instructions.push(PluginInstruction {
                    name: "systemPrompt".to_string(),
                    path,
                    preview: MarkdownPreview {
                        bytes_read: prompt.len(),
                        total_bytes: prompt.len() as u64,
                        markdown: prompt,
                        truncated: false,
                    },
                });
            }
            if let Some(path) = text(manifest.get("systemPromptPath")) {
                reader.instruction_file(&path);
            }
        }
        PluginScheme::Code => {}
    }
    folder.counts.retain(|count| count.count > 0);
    folder.counts.sort_by_key(|count| count.kind);
    Some(folder)
}

/// A plugin that is one module file: its code is all it declares.
fn code_module(file: &Path) -> PluginFolder {
    let name = file
        .file_stem()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    PluginFolder {
        name,
        description: None,
        path: file.to_path_buf(),
        composition: PluginComposition::Code,
        manifest: None,
        default_enabled: None,
        icon: None,
        readme: None,
        skills: Vec::new(),
        instructions: Vec::new(),
        mcp_servers: Vec::new(),
        counts: Vec::new(),
        problems: Vec::new(),
    }
}

/// A plugin a config only names, without a folder on the device.
pub(super) fn declared(name: &str, config: &Path) -> PluginFolder {
    let mut folder = code_module(config);
    folder.name = name.to_string();
    folder
}

const MODULE_ENTRIES: &[&str] = &["package.json", "index.ts", "index.js"];

fn has_module_entry(folder: &Path) -> bool {
    module_entry(folder).is_some()
}

fn module_entry(folder: &Path) -> Option<PathBuf> {
    MODULE_ENTRIES
        .iter()
        .map(|name| folder.join(name))
        .find(|path| path.is_file())
}

fn parse_manifest(
    path: &Path,
    adapter_id: AgentAdapterKind,
    problems: &mut Vec<String>,
    diagnostics: &mut Vec<AgentContextDiagnostic>,
) -> Option<serde_json::Value> {
    let before = diagnostics.len();
    let text = read_config_text(
        path,
        Some(adapter_id),
        "plugin_manifest",
        "Plugin manifest",
        diagnostics,
    );
    if diagnostics.len() > before {
        problems.extend(
            diagnostics[before..]
                .iter()
                .map(|found| found.message.clone()),
        );
    }
    let text = text?;
    let yaml = path
        .extension()
        .is_some_and(|extension| extension == "yaml" || extension == "yml");
    let parsed = if yaml {
        serde_norway::from_str::<serde_json::Value>(&text).ok()
    } else {
        serde_json::from_str::<serde_json::Value>(&text).ok()
    };
    match parsed {
        Some(value) if value.is_object() => Some(value),
        _ => {
            // The parser's message may quote the manifest.
            let message = format!("Could not parse plugin manifest {}", path.display());
            problems.push(message.clone());
            diagnostics.push(diagnostic(
                path,
                Some(adapter_id),
                "plugin_manifest_parse",
                message,
            ));
            None
        }
    }
}

fn manifest_facts(file: String, document: Option<&serde_json::Value>) -> PluginManifestFacts {
    let Some(document) = document else {
        return PluginManifestFacts {
            file,
            ..PluginManifestFacts::default()
        };
    };
    let named = |value: Option<&serde_json::Value>, key: &str| {
        text(value).or_else(|| text(value.and_then(|value| value.get(key))))
    };
    PluginManifestFacts {
        file,
        version: text(document.get("version")),
        author: named(document.get("author"), "name"),
        homepage: text(document.get("homepage")),
        repository: named(document.get("repository"), "url"),
        license: text(document.get("license")),
        keywords: match document.get("keywords") {
            Some(serde_json::Value::Array(keywords)) => keywords
                .iter()
                .filter_map(|keyword| keyword.as_str())
                .map(str::trim)
                .filter(|keyword| !keyword.is_empty())
                .map(str::to_string)
                .collect(),
            _ => Vec::new(),
        },
    }
}

fn text(value: Option<&serde_json::Value>) -> Option<String> {
    let value = value?.as_str()?.trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// The image a manifest declares: `icon`, `logo` of Cursor, or
/// `interface.composerIcon` and `interface.logo` of Codex — a file inside
/// the plugin folder, as a data URI.
fn icon(canonical: &Path, document: &serde_json::Value) -> Option<String> {
    let interface = document.get("interface");
    [
        document.get("icon"),
        document.get("logo"),
        interface.and_then(|interface| interface.get("composerIcon")),
        interface.and_then(|interface| interface.get("logo")),
    ]
    .into_iter()
    .filter_map(text)
    .find_map(|relative| icon_data(canonical, &relative))
}

fn icon_data(canonical: &Path, relative: &str) -> Option<String> {
    let path = inside(canonical, relative)?;
    let mime = match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => return None,
    };
    let file = fs::File::open(&path).ok()?;
    let mut bytes = Vec::new();
    file.take(ICON_BYTES + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > ICON_BYTES {
        return None;
    }
    Some(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// `relative` inside the canonical folder, after links; `None` outside it.
fn inside(canonical: &Path, relative: &str) -> Option<PathBuf> {
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return None;
    }
    let resolved = canonical.join(relative).canonicalize().ok()?;
    resolved.starts_with(canonical).then_some(resolved)
}

fn readme(canonical: &Path, adapter_id: AgentAdapterKind) -> Option<MarkdownPreview> {
    let path = canonical.join(README);
    let source = inspect(&path, canonical, PREVIEW_BYTES, Some(adapter_id))?;
    source.preview
}

/// The paths a manifest declares for a component, a string or a list;
/// `default` when it declares none.
fn paths(manifest: &serde_json::Value, key: &str, default: &str) -> Vec<String> {
    match manifest.get(key) {
        Some(serde_json::Value::String(path)) => vec![path.clone()],
        Some(serde_json::Value::Array(paths)) => paths
            .iter()
            .filter_map(|path| path.as_str().map(str::to_string))
            .collect(),
        _ => vec![default.to_string()],
    }
}

struct Components<'a> {
    canonical: &'a Path,
    owner: &'a InstructionOwner,
    adapter_id: AgentAdapterKind,
    folder: &'a mut PluginFolder,
    diagnostics: &'a mut Vec<AgentContextDiagnostic>,
}

impl Components<'_> {
    fn problem(&mut self, path: &Path, code: &str, message: String) {
        self.folder.problems.push(message.clone());
        self.diagnostics
            .push(diagnostic(path, Some(self.adapter_id), code, message));
    }

    /// Skills of declared paths: a folder with `SKILL.md`, or the folders
    /// with one directly inside it.
    fn skills(&mut self, declared: &[String]) {
        for relative in declared {
            let relative = relative.trim_start_matches("./");
            let Some(root) = inside(self.canonical, relative) else {
                if self.canonical.join(relative).exists() {
                    self.problem(
                        &self.canonical.join(relative),
                        "plugin_component_outside",
                        format!(
                            "Plugin skills {} resolve outside the plugin and were not read",
                            self.canonical.join(relative).display()
                        ),
                    );
                }
                continue;
            };
            if !root.is_dir() {
                continue;
            }
            if root.join("SKILL.md").is_file() {
                self.skill(&root);
                continue;
            }
            for entry in entries(&root) {
                if entry.is_dir() && entry.join("SKILL.md").is_file() {
                    match entry.canonicalize() {
                        Ok(canonical) if canonical.starts_with(self.canonical) => {
                            self.skill(&canonical)
                        }
                        _ => self.problem(
                            &entry,
                            "plugin_component_outside",
                            format!(
                                "Plugin skill {} resolves outside the plugin and was not read",
                                entry.display()
                            ),
                        ),
                    }
                }
            }
        }
    }

    fn skill(&mut self, canonical: &Path) {
        if self
            .folder
            .skills
            .iter()
            .any(|skill| Path::new(&skill.canonical_path) == canonical)
        {
            return;
        }
        match super::skills::plugin_skill(canonical, self.owner) {
            Ok(skill) => self.folder.skills.push(skill),
            Err((code, message)) => self.problem(&canonical.join("SKILL.md"), code, message),
        }
    }

    fn instruction_file(&mut self, relative: &str) {
        let relative = relative.trim_start_matches("./");
        let path = self.canonical.join(relative);
        if self
            .folder
            .instructions
            .iter()
            .any(|instruction| Path::new(&instruction.path) == path)
        {
            return;
        }
        let Some(mut source) = inspect(&path, self.canonical, PREVIEW_BYTES, Some(self.adapter_id))
        else {
            return;
        };
        if let Some(found) = source.diagnostic.take() {
            if source.preview.is_none() {
                self.folder.problems.push(found.message.clone());
            }
            self.diagnostics.push(found);
        }
        let Some(preview) = source.preview else {
            return;
        };
        self.folder.instructions.push(PluginInstruction {
            name: path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| relative.to_string()),
            path: path_string(source.canonical_path.as_deref().unwrap_or(&path)),
            preview,
        });
    }

    /// The MCP servers of the manifest: an inline `mcpServers` object, or
    /// with `files` the MCP files it names, `.mcp.json` by default.
    fn mcp_manifest(&mut self, manifest: &serde_json::Value, files: bool) {
        let declared = manifest.get("mcpServers");
        if let Some(servers) = declared.filter(|servers| servers.is_object()) {
            let path = self.folder.path.clone();
            self.mcp_servers(&path, mcp_config::inline_servers(servers));
        }
        if !files {
            return;
        }
        let named = match declared {
            Some(serde_json::Value::String(path)) => vec![path.clone()],
            Some(serde_json::Value::Array(paths)) => paths
                .iter()
                .filter_map(|path| path.as_str().map(str::to_string))
                .collect(),
            _ => vec![".mcp.json".to_string()],
        };
        for relative in named {
            self.mcp_file(&relative);
        }
    }

    /// The MCP servers of a file inside the plugin.
    fn mcp_file(&mut self, relative: &str) {
        let Some(path) = inside(self.canonical, relative.trim_start_matches("./")) else {
            return;
        };
        if !path.is_file() {
            return;
        }
        let before = self.diagnostics.len();
        let text = read_config_text(
            &path,
            Some(self.adapter_id),
            "plugin_component",
            "Plugin component file",
            self.diagnostics,
        );
        let failed = self.diagnostics[before..]
            .iter()
            .map(|found| found.message.clone())
            .collect::<Vec<_>>();
        self.folder.problems.extend(failed);
        let Some(text) = text else {
            return;
        };
        match mcp_config::plugin_file_servers(&text) {
            Some(servers) => self.mcp_servers(&path, servers),
            None => self.problem(
                &path,
                "plugin_component_parse",
                format!("Could not parse plugin component file {}", path.display()),
            ),
        }
    }

    fn mcp_servers(&mut self, path: &Path, servers: Vec<McpDeclaration>) {
        for server in servers {
            if self
                .folder
                .mcp_servers
                .iter()
                .any(|known| known.name == server.name && Path::new(&known.path) == path)
            {
                continue;
            }
            let problems = server.problem.iter().cloned().collect::<Vec<_>>();
            for problem in &problems {
                self.diagnostics.push(diagnostic(
                    path,
                    Some(self.adapter_id),
                    "plugin_component_invalid",
                    format!("{problem} in {}", path.display()),
                ));
            }
            let declared_off = server.declared_off();
            self.folder.mcp_servers.push(PluginMcpServer {
                name: server.name,
                path: path_string(path),
                facts: server.facts,
                declared_off,
                problems,
            });
        }
    }

    /// Files with one of `extensions` (any when empty) under the declared
    /// folders or files.
    fn count_files(&mut self, kind: PluginComponentKind, declared: &[String], extensions: &[&str]) {
        let mut count = 0;
        for relative in declared {
            let Some(path) = inside(self.canonical, relative.trim_start_matches("./")) else {
                continue;
            };
            count += count_files(&path, extensions, 0);
        }
        self.add(kind, count);
    }

    /// Hook groups of `hooks/hooks.json` and of the manifest's `hooks`:
    /// an inline object, paths of hook files or a list of hooks.
    fn count_hooks(&mut self, manifest: &serde_json::Value) {
        let mut count = 0;
        let mut files = Vec::new();
        match manifest.get("hooks") {
            Some(serde_json::Value::Object(_)) => count += hook_groups(&manifest["hooks"]),
            Some(serde_json::Value::String(path)) => files.push(path.clone()),
            Some(serde_json::Value::Array(entries)) => {
                for entry in entries {
                    match entry {
                        serde_json::Value::String(path) => files.push(path.clone()),
                        serde_json::Value::Object(_) => count += 1,
                        _ => {}
                    }
                }
            }
            _ => files.push("hooks/hooks.json".to_string()),
        }
        for relative in files {
            count += self.json_count(&relative, hook_groups);
        }
        self.add(PluginComponentKind::Hooks, count);
    }

    /// Servers of `.lsp.json` and of the manifest's `lspServers`.
    fn count_lsp(&mut self, manifest: &serde_json::Value) {
        let servers = |value: &serde_json::Value| {
            let servers = value.get("lspServers").unwrap_or(value);
            servers.as_object().map_or(0, |servers| servers.len())
        };
        let mut count = match manifest.get("lspServers") {
            Some(serde_json::Value::Object(declared)) => declared.len(),
            Some(serde_json::Value::String(path)) => self.json_count(path, servers),
            _ => 0,
        };
        if !matches!(
            manifest.get("lspServers"),
            Some(serde_json::Value::String(_))
        ) {
            count += self.json_count(".lsp.json", servers);
        }
        self.add(PluginComponentKind::LspServers, count);
    }

    fn json_count(&mut self, relative: &str, count: fn(&serde_json::Value) -> usize) -> usize {
        let Some(path) = inside(self.canonical, relative.trim_start_matches("./")) else {
            return 0;
        };
        let before = self.diagnostics.len();
        let text = read_config_text(
            &path,
            Some(self.adapter_id),
            "plugin_component",
            "Plugin component file",
            self.diagnostics,
        );
        let failed = self.diagnostics[before..]
            .iter()
            .map(|found| found.message.clone())
            .collect::<Vec<_>>();
        self.folder.problems.extend(failed);
        let Some(text) = text else {
            return 0;
        };
        match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(value) => count(&value),
            Err(_) => {
                self.problem(
                    &path,
                    "plugin_component_parse",
                    format!("Could not parse plugin component file {}", path.display()),
                );
                0
            }
        }
    }

    fn add(&mut self, kind: PluginComponentKind, count: usize) {
        match self
            .folder
            .counts
            .iter_mut()
            .find(|known| known.kind == kind)
        {
            Some(known) => known.count += count,
            None => self
                .folder
                .counts
                .push(PluginComponentCount { kind, count }),
        }
    }
}

/// `{ "hooks": { Event: [group, …] } }` or `{ Event: [group, …] }`.
fn hook_groups(value: &serde_json::Value) -> usize {
    let events = value.get("hooks").unwrap_or(value);
    events.as_object().map_or(0, |events| {
        events
            .values()
            .map(|groups| groups.as_array().map_or(0, Vec::len))
            .sum()
    })
}

fn count_files(path: &Path, extensions: &[&str], depth: usize) -> usize {
    if path.is_file() {
        let matches = extensions.is_empty()
            || path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extensions.contains(&extension));
        return usize::from(matches);
    }
    if depth >= MAX_COUNT_DEPTH || !path.is_dir() {
        return 0;
    }
    entries(path)
        .iter()
        .map(|entry| count_files(entry, extensions, depth + 1))
        .sum()
}

/// The entries of a folder in name order, without hidden ones, bounded.
pub(super) fn entries(folder: &Path) -> Vec<PathBuf> {
    let Ok(read) = fs::read_dir(folder) else {
        return Vec::new();
    };
    let mut entries = read
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| !name.starts_with('.') && name != "node_modules")
        })
        .take(MAX_ENTRIES * 4)
        .collect::<Vec<_>>();
    entries.sort();
    entries.truncate(MAX_ENTRIES);
    entries
}

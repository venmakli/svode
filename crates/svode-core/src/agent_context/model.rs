use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::agent_adapters::AgentAdapterKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstructionOwnerKind {
    TargetSpace,
    ClientConfiguration,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionOwner {
    pub kind: InstructionOwnerKind,
    pub root: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceSupport {
    ClientNative,
    SvodeRecognized,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceResolution {
    Selected,
    Included,
    Superseded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceHealth {
    Normal,
    Degraded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstructionSourceKind {
    Personal,
    Project,
    Recognized,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstructionDiscoveryPolicy {
    CodexUserPrecedence,
    CodexDirectoryPrecedence,
    ClaudeHierarchy,
    /// `AGENTS.md` read by Claude Code's built-in `agents-md` plugin.
    ClaudeAgentsMd,
    ClaudeImport,
    TargetRootRecognition,
    /// A file of a declared rule in a directory of its walk or of the
    /// agent's configuration.
    DirectoryChain,
    /// A file of a declared slot, where the first readable file counts.
    FileSlot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionDiscovery {
    pub policy: InstructionDiscoveryPolicy,
    pub directory_depth: usize,
    pub precedence: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownPreview {
    pub markdown: String,
    pub truncated: bool,
    pub bytes_read: usize,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionReference {
    pub path: String,
    pub canonical_path: Option<String>,
    pub depth: usize,
    pub status: InstructionReferenceStatus,
    pub preview: Option<MarkdownPreview>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstructionReferenceStatus {
    Included,
    OutsideBoundary,
    RequiresClientApproval,
    Unreadable,
    Cyclic,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionRow {
    pub id: String,
    pub adapter_id: Option<AgentAdapterKind>,
    pub name: String,
    pub path: String,
    pub canonical_path: Option<String>,
    #[serde(default)]
    pub link_kind: SourceLinkKind,
    pub owner: InstructionOwner,
    pub source_kind: InstructionSourceKind,
    pub support: SourceSupport,
    pub resolution: SourceResolution,
    pub health: SourceHealth,
    pub health_reasons: Vec<String>,
    pub discovery: InstructionDiscovery,
    /// The file that shadows this one for its agent when `superseded`.
    pub superseded_by: Option<String>,
    pub preview: Option<MarkdownPreview>,
    pub references: Vec<InstructionReference>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillScope {
    Project,
    Personal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillDiscoveryKind {
    CodexProject,
    /// `.codex/skills` of a project directory.
    CodexProjectConfig,
    CodexStandardPersonal,
    /// `$CODEX_HOME/skills`.
    CodexHome,
    ClaudeProject,
    ClaudePersonal,
    /// A declared project skills root of an agent.
    ProjectRoot,
    /// A declared personal skills root of an agent.
    PersonalRoot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum SourceLinkKind {
    #[default]
    Direct,
    SymbolicLink,
    DirectoryAlias,
}

pub type SkillLinkKind = SourceLinkKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillValidationStatus {
    Valid,
    Warning,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDiscoveryAlias {
    pub adapter_id: AgentAdapterKind,
    pub scope: SkillScope,
    pub discovery_kind: SkillDiscoveryKind,
    pub path: String,
    pub root: String,
    pub owner: InstructionOwner,
    pub support: SourceSupport,
    pub resolution: SourceResolution,
    /// The skill that shadows this path for its agent when `superseded`.
    pub superseded_by: Option<String>,
    pub link_kind: SkillLinkKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub path: String,
    pub canonical_path: String,
    pub owner: InstructionOwner,
    pub license: Option<String>,
    pub compatibility: Option<String>,
    pub metadata: Option<BTreeMap<String, SkillMetadataValue>>,
    pub allowed_tools: Option<String>,
    pub validation: SkillValidationStatus,
    pub health: SourceHealth,
    pub health_reasons: Vec<String>,
    pub warnings: Vec<String>,
    pub preview: MarkdownPreview,
    pub aliases: Vec<SkillDiscoveryAlias>,
}

/// A `metadata` value of `SKILL.md`: a scalar as text, a list of scalars, or
/// an object whose values are scalars or lists of scalars.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum SkillMetadataValue {
    Text(String),
    List(Vec<String>),
    Object(BTreeMap<String, SkillMetadataLeaf>),
}

/// A value inside a `metadata` object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum SkillMetadataLeaf {
    Text(String),
    List(Vec<String>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticSeverity {
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentContextDiagnostic {
    pub code: String,
    pub severity: DiagnosticSeverity,
    pub message: String,
    pub path: Option<String>,
    pub adapter_id: Option<AgentAdapterKind>,
}

/// What the source policies find for a target: one record per agent and
/// discovery path. Agent Context builds its items from it, and the project
/// Knowledge projection reads its project part.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentContextDiscovery {
    pub project_root: String,
    pub target_root: String,
    pub repository_root: String,
    pub instructions: Vec<InstructionRow>,
    pub skills: Vec<SkillRow>,
    pub plugins: Vec<PluginRow>,
    pub diagnostics: Vec<AgentContextDiagnostic>,
    pub observed_project_paths: Vec<String>,
    pub observed_personal_paths: Vec<String>,
}

/// Whether the files of a plugin declare what it brings or its code
/// registers it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginComposition {
    Declared,
    Code,
}

/// A kind of plugin component that is no row of the "Context".
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginComponentKind {
    Commands,
    Subagents,
    Hooks,
    Rules,
    /// Files of `bin/`.
    Executables,
    LspServers,
    Themes,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginComponentCount {
    pub kind: PluginComponentKind,
    pub count: usize,
}

/// Whether an agent that finds a plugin has it on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginSwitch {
    On,
    Off,
    /// The agent keeps the switch outside the device's files: an installed
    /// plugin counts as on.
    Unverified,
}

/// How one agent finds a plugin by one path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFinding {
    pub adapter_id: AgentAdapterKind,
    pub scope: SkillScope,
    pub path: String,
    pub link_kind: SourceLinkKind,
    pub switch: PluginSwitch,
    /// The plugin of the same name the agent takes instead.
    pub superseded_by: Option<String>,
}

/// The fields of a plugin manifest the "Context" shows; the rest of the file
/// is dropped while parsing.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifestFacts {
    /// The manifest's file name, such as `plugin.json`.
    pub file: String,
    pub version: Option<String>,
    pub author: Option<String>,
    pub homepage: Option<String>,
    pub repository: Option<String>,
    pub license: Option<String>,
    pub keywords: Vec<String>,
}

/// An instruction a plugin brings: a file, or the system prompt its
/// manifest holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstruction {
    pub name: String,
    /// The file the instruction opens: its own, or the manifest.
    pub path: String,
    pub preview: MarkdownPreview,
}

/// One plugin, whichever agents and paths find it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRow {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// The file the row opens: the manifest, the module, or the config that
    /// declares the plugin.
    pub path: String,
    /// The canonical plugin folder, or the file of a plugin without one.
    pub directory: String,
    /// The folder the plugin lies in, or the config that declares it.
    pub place: String,
    pub owner_root: String,
    pub composition: PluginComposition,
    pub manifest: Option<PluginManifestFacts>,
    /// The image the manifest declares, as a data URI.
    pub icon: Option<String>,
    /// `README.md` in the plugin folder.
    pub readme: Option<MarkdownPreview>,
    pub skills: Vec<SkillRow>,
    pub instructions: Vec<PluginInstruction>,
    pub counts: Vec<PluginComponentCount>,
    pub health: SourceHealth,
    pub health_reasons: Vec<String>,
    pub findings: Vec<PluginFinding>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextItemKind {
    Instruction,
    Skill,
    Plugin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextLocationKind {
    /// Inside the repository boundary of the target, relative to the target
    /// root; an empty path is the target root itself.
    Target,
    /// In the home directory, relative to it; an empty path is `~` itself.
    Home,
    Absolute,
}

/// Where an item lies: the folder of its canonical file, or the folder that
/// holds its skill directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextLocation {
    pub kind: ContextLocationKind,
    pub path: String,
}

/// An agent that reads an item by one path; a shadowed one names what
/// shadows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextItemReader {
    pub agent: AgentAdapterKind,
    pub superseded_by: Option<String>,
    /// The agent has the plugin installed but off.
    #[serde(default)]
    pub disabled: bool,
    /// The agent keeps whether the plugin is on outside the device's files.
    #[serde(default)]
    pub unverified: bool,
}

/// A path by which enabled agents find an item, with a link's target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextItemSource {
    pub path: String,
    pub target: Option<String>,
    pub link_kind: SourceLinkKind,
    pub readers: Vec<ContextItemReader>,
}

/// Why no enabled agent applies an item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UnappliedReason {
    /// No enabled agent finds it; `readers` read it by their policy.
    NotFound { readers: Vec<AgentAdapterKind> },
    /// Every enabled agent that finds it takes another file instead.
    Superseded { by: Vec<String> },
    /// Enabled agents that find it have it off in their config.
    Disabled,
}

/// Facts of a skill: its folder and the optional frontmatter of `SKILL.md`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSkillFacts {
    /// The canonical skill folder, the boundary its files are read within.
    pub directory: String,
    /// Whether the folder holds files Svode supports besides `SKILL.md`.
    pub has_files: bool,
    pub license: Option<String>,
    pub compatibility: Option<String>,
    pub metadata: Option<BTreeMap<String, SkillMetadataValue>>,
    pub allowed_tools: Option<String>,
}

/// Facts of a plugin: its folder, manifest and components that are no rows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextPluginFacts {
    pub directory: String,
    pub composition: PluginComposition,
    pub manifest: Option<PluginManifestFacts>,
    pub counts: Vec<PluginComponentCount>,
    /// The item's preview is the plugin's `README.md`.
    pub has_readme: bool,
}

/// One canonical source of the target's context: one row of the "Context"
/// collection, whichever agents and paths find it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextItem {
    pub id: String,
    pub kind: ContextItemKind,
    pub name: String,
    pub description: Option<String>,
    /// The file the item opens: the instruction, `SKILL.md`, or a
    /// plugin's manifest, module or declaring config.
    pub path: String,
    /// The root an external open re-validates the file against.
    pub owner_root: String,
    pub location: ContextLocation,
    pub modified_at: Option<String>,
    pub health: SourceHealth,
    pub health_reasons: Vec<String>,
    /// Enabled agents that apply the item.
    pub providers: Vec<AgentAdapterKind>,
    /// Set when `providers` is empty.
    pub unapplied: Option<UnappliedReason>,
    pub sources: Vec<ContextItemSource>,
    pub preview: MarkdownPreview,
    pub references: Vec<InstructionReference>,
    pub skill: Option<ContextSkillFacts>,
    pub plugin: Option<ContextPluginFacts>,
    /// The nested rows of a plugin: its skills and instructions, with the
    /// plugin's providers and sources.
    pub components: Vec<ContextItem>,
    /// The image the source declares, as a data URI.
    pub icon: Option<String>,
    /// A part of the Svode integration, which the connection manager keeps.
    pub managed_by_svode: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentContextSnapshotContent {
    pub project_root: String,
    pub target_root: String,
    pub repository_root: String,
    /// The agents enabled in Providers whose sources outside the repository
    /// boundary were scanned.
    pub enabled_agents: Vec<AgentAdapterKind>,
    pub items: Vec<ContextItem>,
    pub diagnostics: Vec<AgentContextDiagnostic>,
    pub observed_project_paths: Vec<String>,
    pub observed_personal_paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentContextSnapshot {
    pub generation: u64,
    #[serde(flatten)]
    pub content: AgentContextSnapshotContent,
}

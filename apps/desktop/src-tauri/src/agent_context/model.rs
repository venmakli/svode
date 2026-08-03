use serde::{Deserialize, Serialize};

use crate::supported_adapters::{SupportedAdapterId, SupportedAdapterSnapshot};

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
pub enum InstructionAvailability {
    Available,
    Shadowed,
    RecognizedOnly,
    CompatibilityUnknown,
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
    ClaudeImport,
    TargetRootRecognition,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionDiscovery {
    pub policy: InstructionDiscoveryPolicy,
    pub directory_depth: usize,
    pub precedence: usize,
    pub effective: bool,
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
    pub availability: InstructionAvailability,
    pub reason: Option<String>,
    pub preview: Option<MarkdownPreview>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionRow {
    pub id: String,
    pub adapter_id: Option<SupportedAdapterId>,
    pub name: String,
    pub path: String,
    pub canonical_path: Option<String>,
    pub owner: InstructionOwner,
    pub source_kind: InstructionSourceKind,
    pub availability: InstructionAvailability,
    pub reason: Option<String>,
    pub discovery: InstructionDiscovery,
    pub preview: Option<MarkdownPreview>,
    pub references: Vec<InstructionReference>,
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
    pub adapter_id: Option<SupportedAdapterId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentContextSnapshotContent {
    pub project_root: String,
    pub target_root: String,
    pub repository_root: String,
    pub adapters: Vec<SupportedAdapterSnapshot>,
    pub instructions: Vec<InstructionRow>,
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

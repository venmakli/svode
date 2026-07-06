use serde::{Deserialize, Serialize};

pub(crate) const MAX_SOURCE_DIAGNOSTICS: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentSessionSource {
    Codex,
    ClaudeCode,
}

impl AgentSessionSource {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::ClaudeCode => "claude-code",
        }
    }

    pub(crate) fn resume_program(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::ClaudeCode => "claude",
        }
    }

    pub(crate) fn resume_args(self, source_session_id: &str) -> Vec<String> {
        match self {
            Self::Codex => vec!["resume".to_string(), source_session_id.to_string()],
            Self::ClaudeCode => vec!["--resume".to_string(), source_session_id.to_string()],
        }
    }

    pub(crate) fn resume_argv(self, source_session_id: &str) -> Vec<String> {
        let mut argv = vec![self.resume_program().to_string()];
        argv.extend(self.resume_args(source_session_id));
        argv
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentSessionStatus {
    Active,
    Done,
    Failed,
    Stopped,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentSessionActiveFlag {
    WaitingOnApproval,
    WaitingOnUserInput,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentSessionTitleSource {
    CliTitle,
    FirstUserPrompt,
    SessionId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentSessionScopeKind {
    Project,
    Space,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentSessionScopeStatus {
    Ready,
    Missing,
    Broken,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentSessionScopeConfidence {
    Exact,
    CwdPrefix,
    WorktreeOriginal,
    DecodedSourceFile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentSessionStatusSource {
    EmbeddedTerminal,
    SvodeAgentRuntime,
    SourceLog,
    SourceIndex,
    Fallback,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentSessionStatusConfidence {
    Strong,
    Medium,
    Weak,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentSessionsListStatus {
    Ok,
    Partial,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentSessionSourceStatus {
    Ok,
    MissingRoot,
    PartialError,
    Unreadable,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentSessionsCacheMode {
    FreshScan,
    FingerprintHit,
    ForceRefresh,
    Mixed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub id: String,
    pub source: AgentSessionSource,
    pub source_session_id: String,
    pub title: String,
    pub title_source: AgentSessionTitleSource,
    pub status: AgentSessionStatus,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub active_flags: Vec<AgentSessionActiveFlag>,
    pub status_source: AgentSessionStatusSource,
    pub status_confidence: AgentSessionStatusConfidence,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<AgentSessionRuntime>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    pub scope_kind: AgentSessionScopeKind,
    pub scope_status: AgentSessionScopeStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space_path: Option<String>,
    pub scope_confidence: AgentSessionScopeConfidence,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    pub last_activity_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waiting_since: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_command: Option<AgentSessionResumeCommand>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_file: Option<AgentSessionSourceFileRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub counts: Option<AgentSessionCounts>,
    pub capabilities: AgentSessionCapabilities,
    pub pinned: bool,
    pub source_meta: AgentSessionSourceMeta,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionRuntime {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pty_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    pub live: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_output_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_input_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionResumeCommand {
    pub display: String,
    pub program: String,
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionSourceFileRef {
    pub path: String,
    pub mtime_ms: u128,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionCounts {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub messages: Option<u32>,
    pub user_messages: u32,
    pub assistant_messages: u32,
    pub function_calls: u32,
    pub malformed_lines: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionCapabilities {
    pub can_resume: bool,
    pub can_reveal_file: bool,
    pub has_readable_log: bool,
}

impl Default for AgentSessionCapabilities {
    fn default() -> Self {
        Self {
            can_resume: true,
            can_reveal_file: true,
            has_readable_log: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionScope {
    pub kind: AgentSessionScopeKind,
    pub status: AgentSessionScopeStatus,
    pub confidence: AgentSessionScopeConfidence,
    pub project_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionSourceMeta {
    pub history_present: bool,
    pub detail_present: bool,
    pub session_index_present: bool,
    pub detail_file_count: u32,
    pub history_line_count: u32,
    pub detail_line_count: u32,
    pub malformed_line_count: u32,
    pub function_call_count: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionsListResult {
    pub status: AgentSessionsListStatus,
    pub generated_at: String,
    pub project_path: String,
    pub sessions: Vec<AgentSession>,
    pub sources: Vec<AgentSessionSourceReport>,
    pub summary: AgentSessionsSummary,
    pub cache: AgentSessionsCacheReport,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionsSummary {
    pub returned_sessions: usize,
    pub pinned_sessions: usize,
    pub unresolved_candidates: usize,
    pub incomplete_candidates: usize,
    pub malformed_lines: usize,
    pub source_errors: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionsCacheReport {
    pub mode: AgentSessionsCacheMode,
    pub hit: bool,
    pub source_hits: usize,
    pub source_misses: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionSourceReport {
    pub source: AgentSessionSource,
    pub status: AgentSessionSourceStatus,
    pub root_path: String,
    pub scanned_at: String,
    pub cache_hit: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u128>,
    pub counts: AgentSessionSourceCounts,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
    pub diagnostics: Vec<AgentSessionDiagnostic>,
    pub truncated_diagnostics: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionSourceCounts {
    pub files_scanned: usize,
    pub records_read: usize,
    pub candidates: usize,
    pub returned_sessions: usize,
    pub unresolved_candidates: usize,
    pub incomplete_candidates: usize,
    pub malformed_lines: usize,
    pub source_errors: usize,
}

impl AgentSessionSourceReport {
    pub(crate) fn new(source: AgentSessionSource, root: String) -> Self {
        Self {
            source,
            status: AgentSessionSourceStatus::Ok,
            root_path: root,
            scanned_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            cache_hit: false,
            duration_ms: None,
            counts: AgentSessionSourceCounts::default(),
            fingerprint: None,
            diagnostics: Vec::new(),
            truncated_diagnostics: 0,
        }
    }

    pub(crate) fn push_diagnostic(
        &mut self,
        severity: AgentSessionDiagnosticSeverity,
        code: impl Into<String>,
        message: impl Into<String>,
        path: Option<String>,
        line: Option<u64>,
    ) {
        if matches!(severity, AgentSessionDiagnosticSeverity::Error) {
            self.counts.source_errors += 1;
        }
        if self.diagnostics.len() >= MAX_SOURCE_DIAGNOSTICS {
            self.truncated_diagnostics += 1;
            return;
        }
        self.diagnostics.push(AgentSessionDiagnostic {
            severity,
            code: code.into(),
            message: message.into(),
            path,
            line,
        });
    }

    pub(crate) fn mark_partial_if_ok(&mut self) {
        if matches!(self.status, AgentSessionSourceStatus::Ok) {
            self.status = AgentSessionSourceStatus::PartialError;
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentSessionDiagnosticSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionDiagnostic {
    pub severity: AgentSessionDiagnosticSeverity,
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionsPinResult {
    pub session_id: String,
    pub pinned: bool,
    pub pinned_session_ids: Vec<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentSessionReentryMode {
    FocusedManagedPty,
    SpawnedResumePty,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentSessionReentryErrorCode {
    TerminalUnavailable,
    CliNotFound,
    CwdNotAccessible,
    ResumeUnavailable,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionReentryError {
    pub code: AgentSessionReentryErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionReentryResult {
    pub mode: AgentSessionReentryMode,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pty_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<AgentSessionResumeCommand>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<AgentSessionReentryError>,
}

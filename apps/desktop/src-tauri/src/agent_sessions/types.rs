use serde::{Deserialize, Serialize};

use svode_agents::identity::{IdentityNamespace, SessionKey};
use svode_agents::registry::AdapterRuntimeRegistry;
use svode_agents::status::SessionStatus;
use svode_core::agent_adapters::AgentId;

/// Writer-registry key of a session a Sessions source reports: terminal
/// sessions carry the agent's native session id.
pub(crate) fn native_writer_key(agent: &AgentId, source_session_id: &str) -> SessionKey {
    SessionKey {
        agent: agent.as_str().to_string(),
        namespace: IdentityNamespace::Native,
        session_id: source_session_id.to_string(),
    }
}

/// Catalogue id of a session: its agent and native id; an ACP id without
/// equality evidence keeps its own namespace, so it never meets a native
/// record of the same agent.
pub(crate) fn catalog_session_id(agent: &AgentId, key: &SessionKey) -> String {
    match key.namespace {
        IdentityNamespace::Native => format!("{}:{}", agent.as_str(), key.session_id),
        IdentityNamespace::Acp => format!("{}:acp:{}", agent.as_str(), key.session_id),
    }
}

/// The runtime key of a catalogue record, recovered from its id.
pub(crate) fn catalog_session_key(session: &AgentSession) -> Option<SessionKey> {
    [IdentityNamespace::Native, IdentityNamespace::Acp]
        .into_iter()
        .map(|namespace| SessionKey {
            agent: session.source.as_str().to_string(),
            namespace,
            session_id: session.source_session_id.clone(),
        })
        .find(|key| catalog_session_id(&session.source, key) == session.id)
}

/// The command that continues a session in its agent's terminal by native
/// id, when the agent's description has one.
pub(crate) fn terminal_resume_argv(
    agent: &AgentId,
    source_session_id: &str,
) -> Option<Vec<String>> {
    let builtin = agent.builtin()?;
    let mut argv = vec![builtin.executable().to_string()];
    argv.extend(AdapterRuntimeRegistry.terminal_resume_args(builtin, source_session_id)?);
    Some(argv)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentSessionTitleSource {
    CliTitle,
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentSessionsListStatus {
    Ok,
    Partial,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentSessionSourceStatus {
    Ok,
    /// The last good list is shown; the agent did not answer the latest
    /// read.
    Stale,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentSessionsCacheMode {
    /// Every list was read by this app process.
    Current,
    /// A list saved before the app started is shown until its agent's
    /// connection opens; it confirms no session missing.
    StaleSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routine_run_id: Option<String>,
    pub source: AgentId,
    pub source_session_id: String,
    pub title: String,
    pub title_source: AgentSessionTitleSource,
    pub status: SessionStatus,
    /// Evidence behind the status, or the diagnostic of an unresolvable
    /// contradiction between sources.
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
    pub resume_command: Option<AgentSessionResumeCommand>,
    pub capabilities: AgentSessionCapabilities,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionRuntime {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pty_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    pub live: bool,
    #[serde(default)]
    pub provisional: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_output_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_input_at: Option<String>,
    /// The key a Svode ACP connection drives the session under; the chat
    /// subscribes to its activity by it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acp_session: Option<SessionKey>,
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
pub struct AgentSessionCapabilities {
    pub can_resume: bool,
    /// The record carries the key the agent's runtime opens it under: a
    /// session of its ACP list or one the runtime drives.
    #[serde(default)]
    pub can_open_in_chat: bool,
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
    pub unresolved_candidates: usize,
    pub incomplete_candidates: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionsCacheReport {
    pub mode: AgentSessionsCacheMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionsHotStatusResult {
    pub generated_at: String,
    pub project_path: String,
    pub sessions: Vec<AgentSession>,
    pub checked_sessions: usize,
    pub updated_sessions: usize,
    pub skipped_sessions: usize,
}

/// One agent's session list as the catalogue shows it: the agent's ACP
/// `session/list`, its declared catalogue source.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionSourceReport {
    pub source: AgentId,
    pub status: AgentSessionSourceStatus,
    /// When the shown list was read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u128>,
    pub counts: AgentSessionSourceCounts,
    pub diagnostics: Vec<AgentSessionDiagnostic>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionSourceCounts {
    pub records_read: usize,
    pub candidates: usize,
    pub returned_sessions: usize,
    pub unresolved_candidates: usize,
    pub incomplete_candidates: usize,
}

impl AgentSessionSourceReport {
    pub(crate) fn new(source: AgentId) -> Self {
        Self {
            source,
            status: AgentSessionSourceStatus::Ok,
            read_at: None,
            duration_ms: None,
            counts: AgentSessionSourceCounts::default(),
            diagnostics: Vec::new(),
        }
    }

    pub(crate) fn push_diagnostic(
        &mut self,
        severity: AgentSessionDiagnosticSeverity,
        code: impl Into<String>,
        message: impl Into<String>,
    ) {
        self.diagnostics.push(AgentSessionDiagnostic {
            severity,
            code: code.into(),
            message: message.into(),
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentSessionDiagnosticSeverity {
    Info,
    Warning,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionDiagnostic {
    pub severity: AgentSessionDiagnosticSeverity,
    pub code: String,
    pub message: String,
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
    /// Another managed writer of Svode drives the session.
    WriterActive,
    /// A process outside Svode writes to the session.
    ExternalActive,
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

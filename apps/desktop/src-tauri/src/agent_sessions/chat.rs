//! What opening a catalogue session in the chat needs (Stage 10 `04`,
//! opening and continuing): the key the agent's runtime opens it under, the
//! directory it works in and what Svode knows about other writers.

use std::path::{Path, PathBuf};

use svode_agents::identity::SessionKey;
use svode_agents::native_settings::NativeSessionSettings;
use svode_agents::registry::AdapterRuntimeRegistry;
use svode_agents::writer::ExternalLiveness;
use svode_agents::{ExistingSessionDirectory, catalog::RuntimeSession};
use svode_core::agent_adapters::{AgentAdapterKind, AgentId};

use super::AgentSessionsState;
use super::live_status::{external_liveness, native_turn_open};
use super::read_model;
use super::reentry::resolve_safe_cwd;
use super::types::catalog_session_key;
use crate::error::AppError;
use crate::terminal::AgentTerminalSurface;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatTarget {
    pub agent: String,
    pub key: SessionKey,
    pub cwd: PathBuf,
    pub(super) qwen_cwd: Option<PathBuf>,
    pub liveness: ExternalLiveness,
    /// The agent's native status tells a turn open, whoever runs it.
    pub turn_open: bool,
}

impl ChatTarget {
    pub(crate) fn directory(&self) -> ExistingSessionDirectory<'_> {
        match &self.qwen_cwd {
            Some(cwd) => ExistingSessionDirectory::qwen(&self.cwd, cwd),
            None => self.cwd.as_path().into(),
        }
    }
}

/// The chat target of a listed session, under the native id the agent
/// continues it under (`07` N6: the tip of a Hermes chain); `None` when the
/// session is not in the project's catalogue, its origin does not open in
/// the chat or its record carries no runtime key, such as a launch whose
/// agent has not named its session yet.
pub fn chat_target(
    state: &AgentSessionsState,
    project_path: String,
    session_id: &str,
    terminal_surfaces: Vec<AgentTerminalSurface>,
    runtime_sessions: Vec<RuntimeSession>,
) -> Result<Option<ChatTarget>, AppError> {
    let list = read_model::list_sessions(state, project_path, terminal_surfaces, runtime_sessions)?;
    let Some(session) = list
        .sessions
        .iter()
        .find(|session| session.is_addressed_by(session_id))
        .filter(|session| session.capabilities.can_open_in_chat)
    else {
        return Ok(None);
    };
    let Some(key) = catalog_session_key(session) else {
        return Ok(None);
    };
    let project = Path::new(&list.project_path);
    let (cwd, qwen_cwd) =
        if cfg!(windows) && session.source.builtin() == Some(AgentAdapterKind::QwenCode) {
            let scope = Path::new(session.space_path.as_deref().unwrap_or(&list.project_path));
            let checked = session
                .cwd
                .as_deref()
                .and_then(|cwd| std::fs::canonicalize(cwd).ok())
                .filter(|cwd| cwd.starts_with(project) && cwd.starts_with(scope) && cwd.is_dir())
                .ok_or_else(|| {
                    AppError::PathNotAccessible(
                        session
                            .cwd
                            .clone()
                            .unwrap_or_else(|| list.project_path.clone()),
                    )
                })?;
            let qwen_cwd =
                AdapterRuntimeRegistry.qwen_session_cwd(&checked, session.acp_cwd.as_deref());
            (checked, Some(qwen_cwd))
        } else {
            let raw = resolve_safe_cwd(session, project).map_err(|raw| {
                AppError::PathNotAccessible(raw.unwrap_or_else(|| list.project_path.clone()))
            })?;
            (PathBuf::from(raw), None)
        };
    Ok(Some(ChatTarget {
        agent: session.source.as_str().to_string(),
        key,
        cwd,
        qwen_cwd,
        liveness: external_liveness(session),
        turn_open: native_turn_open(session),
    }))
}

/// The model and reasoning of the target's last turn in its agent's native
/// store, read now (DF-171 R2); Claude Code and Codex record them.
pub fn native_session_settings(
    state: &AgentSessionsState,
    target: &ChatTarget,
) -> Option<NativeSessionSettings> {
    let agent = AgentId::parse(&target.agent).ok()?;
    state
        .native_status
        .session_settings(&agent, &target.key.session_id)
}

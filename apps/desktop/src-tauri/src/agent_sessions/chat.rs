//! What opening a catalogue session in the chat needs (Stage 10 `04`,
//! opening and continuing): the key the agent's runtime opens it under, the
//! directory it works in and what Svode knows about other writers.

use std::path::PathBuf;

use svode_agents::catalog::RuntimeSession;
use svode_agents::identity::SessionKey;
use svode_agents::writer::ExternalLiveness;

use super::AgentSessionsState;
use super::live_status::external_liveness;
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
    pub liveness: ExternalLiveness,
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
    let cwd = resolve_safe_cwd(session, &PathBuf::from(&list.project_path)).map_err(|raw| {
        AppError::PathNotAccessible(raw.unwrap_or_else(|| list.project_path.clone()))
    })?;
    Ok(Some(ChatTarget {
        agent: session.source.as_str().to_string(),
        key,
        cwd: PathBuf::from(cwd),
        liveness: external_liveness(session),
    }))
}

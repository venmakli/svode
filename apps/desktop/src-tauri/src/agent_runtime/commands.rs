//! Thin Tauri commands over the agent runtime. They run on the async
//! runtime, where the agent runtime owns its calls.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use svode_agents::activity::DetailOutcome;
use svode_agents::adapters::LaunchUnavailable;
use svode_agents::identity::SessionKey;
use svode_agents::interaction::{AnswerOutcome, InteractionAnswer};
use svode_agents::{AgentCheck, SettingValue};
use tauri::ipc::Channel;
use tauri::{State, Webview};

use super::connections::{AgentConnections, SessionStart};
use super::{ActivityMessage, AgentRuntimeState};
use crate::agent_sessions::types::catalog_session_id;
use crate::agent_setup::AgentSetupState;
use crate::error::AppError;
use svode_core::agent_adapters::AgentId;

/// Opens a delivery of the session's snapshot and deltas; returns its id.
#[tauri::command]
pub async fn agent_runtime_subscribe(
    webview: Webview,
    state: State<'_, AgentRuntimeState>,
    session: SessionKey,
    channel: Channel<ActivityMessage>,
) -> Result<u64, AppError> {
    Ok(state.subscribe(webview.label(), &session, move |message| {
        channel.send(message).is_ok()
    })?)
}

#[tauri::command]
pub async fn agent_runtime_unsubscribe(
    state: State<'_, AgentRuntimeState>,
    subscription: u64,
) -> Result<(), AppError> {
    state.unsubscribe(subscription);
    Ok(())
}

#[tauri::command]
pub async fn agent_runtime_detail(
    state: State<'_, AgentRuntimeState>,
    session: SessionKey,
    item_id: String,
) -> Result<DetailOutcome, AppError> {
    Ok(state.runtime().detail(&session, &item_id))
}

/// Returns the turn id once the runtime accepted the prompt.
#[tauri::command]
pub async fn agent_runtime_prompt(
    state: State<'_, AgentRuntimeState>,
    session: SessionKey,
    text: String,
) -> Result<String, AppError> {
    Ok(state.runtime().prompt(&session, &text)?)
}

#[tauri::command]
pub async fn agent_runtime_cancel(
    state: State<'_, AgentRuntimeState>,
    session: SessionKey,
) -> Result<(), AppError> {
    Ok(state.runtime().cancel(&session)?)
}

#[tauri::command]
pub async fn agent_runtime_answer(
    state: State<'_, AgentRuntimeState>,
    session: SessionKey,
    interaction: String,
    answer: InteractionAnswer,
) -> Result<AnswerOutcome, AppError> {
    Ok(state.runtime().answer(&session, &interaction, answer)?)
}

/// The user's explicit check of an agent: starts it, runs `initialize` and
/// closes it unless something else needs the connection.
#[tauri::command]
pub async fn agent_runtime_check(
    connections: State<'_, Arc<AgentConnections>>,
    agent: String,
) -> Result<AgentCheck, AppError> {
    Ok(connections.check(&agent).await)
}

/// The outcome a new session draft shows for its agent; a ready agent's
/// connection stays while the hold lives.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftAgent {
    pub hold: Option<u64>,
    pub check: AgentCheck,
}

/// A new session draft chose `agent`: its connection starts (a C1
/// boundary) so its readiness shows before the first prompt.
#[tauri::command]
pub async fn agent_runtime_hold_draft(
    webview: Webview,
    connections: State<'_, Arc<AgentConnections>>,
    agent: String,
) -> Result<DraftAgent, AppError> {
    let (hold, check) = connections.hold_draft(webview.label(), &agent).await;
    Ok(DraftAgent { hold, check })
}

#[tauri::command]
pub async fn agent_runtime_release_draft(
    connections: State<'_, Arc<AgentConnections>>,
    hold: u64,
) -> Result<(), AppError> {
    connections.release_draft(hold);
    Ok(())
}

/// What the first send of a new session draft did.
#[derive(Debug, Serialize)]
#[serde(
    tag = "outcome",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum StartedSession {
    /// `session_id` is the catalogue id the session is listed under.
    Started {
        session: SessionKey,
        session_id: String,
        turn_id: String,
    },
    Unavailable {
        reason: LaunchUnavailable,
    },
}

/// The first send of a new session draft: creates the session in `cwd`,
/// applies the draft's setting values and sends the prompt. The agent
/// becomes the device's last chat agent.
#[tauri::command]
pub async fn agent_runtime_start_session(
    connections: State<'_, Arc<AgentConnections>>,
    setup: State<'_, AgentSetupState>,
    agent: String,
    cwd: PathBuf,
    settings: Vec<SettingValue>,
    text: String,
) -> Result<StartedSession, AppError> {
    if !cwd.is_absolute() || !cwd.is_dir() {
        return Err(AppError::PathNotAccessible(
            cwd.to_string_lossy().into_owned(),
        ));
    }
    let source = AgentId::parse(&agent)
        .map_err(|error| AppError::General(format!("invalid agent id: {error}")))?;
    match connections
        .start_session(&agent, &cwd, &settings, &text)
        .await?
    {
        SessionStart::Started { session, turn_id } => {
            if let Err(error) = setup.set_last_chat_agent(&agent) {
                tracing::warn!("the last chat agent was not saved: {error}");
            }
            Ok(StartedSession::Started {
                session_id: catalog_session_id(&source, &session),
                session,
                turn_id,
            })
        }
        SessionStart::Unavailable { reason } => Ok(StartedSession::Unavailable { reason }),
    }
}

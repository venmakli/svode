//! Thin Tauri commands over the agent runtime. They run on the async
//! runtime, where the agent runtime owns its calls.

use std::sync::Arc;

use svode_agents::AgentCheck;
use svode_agents::activity::DetailOutcome;
use svode_agents::identity::SessionKey;
use svode_agents::interaction::{AnswerOutcome, InteractionAnswer};
use tauri::ipc::Channel;
use tauri::{State, Webview};

use super::connections::AgentConnections;
use super::{ActivityMessage, AgentRuntimeState};
use crate::error::AppError;

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

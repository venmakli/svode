use tauri::State;

use super::AgentSessionsState;
use super::read_model;
use super::types::{AgentSessionsListResult, AgentSessionsPinResult};
use crate::error::AppError;

#[tauri::command]
pub fn agent_sessions_list(
    state: State<'_, AgentSessionsState>,
    project_path: String,
) -> Result<AgentSessionsListResult, AppError> {
    read_model::list_sessions(state.inner(), project_path, false)
}

#[tauri::command]
pub fn agent_sessions_refresh(
    state: State<'_, AgentSessionsState>,
    project_path: String,
) -> Result<AgentSessionsListResult, AppError> {
    read_model::list_sessions(state.inner(), project_path, true)
}

#[tauri::command]
pub fn agent_sessions_set_pinned(
    _state: State<'_, AgentSessionsState>,
    _project_path: String,
    _session_id: String,
    _pinned: bool,
) -> Result<AgentSessionsPinResult, AppError> {
    Err(AppError::General(
        "agent_sessions_set_pinned is deferred to Stage 7 Phase 1.2.5".to_string(),
    ))
}

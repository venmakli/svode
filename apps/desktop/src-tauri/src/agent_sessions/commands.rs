use tauri::State;

use super::AgentSessionsState;
use super::read_model;
use super::types::{AgentSessionsListResult, AgentSessionsPinResult};
use crate::error::AppError;
use crate::terminal::TerminalManager;

#[tauri::command]
pub fn agent_sessions_list(
    state: State<'_, AgentSessionsState>,
    terminal_manager: State<'_, TerminalManager>,
    project_path: String,
) -> Result<AgentSessionsListResult, AppError> {
    read_model::list_sessions_with_surfaces(
        state.inner(),
        project_path,
        false,
        terminal_manager.list_agent_surfaces()?,
    )
}

#[tauri::command]
pub fn agent_sessions_refresh(
    state: State<'_, AgentSessionsState>,
    terminal_manager: State<'_, TerminalManager>,
    project_path: String,
) -> Result<AgentSessionsListResult, AppError> {
    read_model::list_sessions_with_surfaces(
        state.inner(),
        project_path,
        true,
        terminal_manager.list_agent_surfaces()?,
    )
}

#[tauri::command]
pub fn agent_sessions_set_pinned(
    state: State<'_, AgentSessionsState>,
    terminal_manager: State<'_, TerminalManager>,
    project_path: String,
    session_id: String,
    pinned: bool,
) -> Result<AgentSessionsPinResult, AppError> {
    read_model::set_pinned(
        state.inner(),
        project_path,
        session_id,
        pinned,
        terminal_manager.list_agent_surfaces()?,
    )
}

use tauri::{AppHandle, State};

use super::AgentSessionsState;
use super::read_model;
use super::reentry;
use super::types::{AgentSessionReentryResult, AgentSessionsListResult, AgentSessionsPinResult};
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

#[tauri::command]
pub fn agent_sessions_reenter(
    app: AppHandle,
    state: State<'_, AgentSessionsState>,
    terminal_manager: State<'_, TerminalManager>,
    project_path: String,
    session_id: String,
) -> Result<AgentSessionReentryResult, AppError> {
    let terminal_surfaces = match terminal_manager.list_agent_surfaces() {
        Ok(surfaces) => surfaces,
        Err(error) => {
            return Ok(reentry::terminal_unavailable_result(
                session_id,
                format!("Failed to read managed terminal surfaces: {error}"),
            ));
        }
    };
    let home_dir = state.inner().home_dir.clone();

    reentry::reenter_session(
        state.inner(),
        project_path,
        session_id,
        terminal_surfaces,
        move |session, scope_dir| {
            reentry::resolve_agent_cli_binary(session.source, scope_dir, &home_dir)
        },
        move |spawn| {
            terminal_manager
                .spawn_agent_shell_session(app.clone(), spawn)
                .map(|session| session.pty_id)
        },
    )
}

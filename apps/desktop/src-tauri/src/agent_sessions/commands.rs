use tauri::{AppHandle, State};

use super::AgentSessionsState;
use super::read_model;
use super::reentry;
use super::types::{
    AgentSessionReentryResult, AgentSessionsHotStatusResult, AgentSessionsListResult,
    AgentSessionsPinResult,
};
use crate::error::AppError;
use crate::terminal::TerminalManager;

#[tauri::command]
pub async fn agent_sessions_list(
    state: State<'_, AgentSessionsState>,
    terminal_manager: State<'_, TerminalManager>,
    project_path: String,
) -> Result<AgentSessionsListResult, AppError> {
    let state = state.inner().clone();
    let terminal_manager = terminal_manager.inner().clone();
    run_blocking(move || {
        read_model::list_sessions_with_surfaces(
            &state,
            project_path,
            false,
            terminal_manager.list_agent_surfaces()?,
        )
    })
    .await
}

#[tauri::command]
pub async fn agent_sessions_refresh(
    state: State<'_, AgentSessionsState>,
    terminal_manager: State<'_, TerminalManager>,
    project_path: String,
) -> Result<AgentSessionsListResult, AppError> {
    let state = state.inner().clone();
    let terminal_manager = terminal_manager.inner().clone();
    run_blocking(move || {
        read_model::list_sessions_with_surfaces(
            &state,
            project_path,
            true,
            terminal_manager.list_agent_surfaces()?,
        )
    })
    .await
}

#[tauri::command]
pub async fn agent_sessions_hot_status(
    state: State<'_, AgentSessionsState>,
    terminal_manager: State<'_, TerminalManager>,
    project_path: String,
    session_ids: Vec<String>,
) -> Result<AgentSessionsHotStatusResult, AppError> {
    let state = state.inner().clone();
    let terminal_manager = terminal_manager.inner().clone();
    run_blocking(move || {
        read_model::hot_status_with_surfaces(
            &state,
            project_path,
            session_ids,
            terminal_manager.list_agent_surfaces()?,
        )
    })
    .await
}

#[tauri::command]
pub async fn agent_sessions_set_pinned(
    state: State<'_, AgentSessionsState>,
    terminal_manager: State<'_, TerminalManager>,
    project_path: String,
    session_id: String,
    pinned: bool,
) -> Result<AgentSessionsPinResult, AppError> {
    let state = state.inner().clone();
    let terminal_manager = terminal_manager.inner().clone();
    run_blocking(move || {
        read_model::set_pinned(
            &state,
            project_path,
            session_id,
            pinned,
            terminal_manager.list_agent_surfaces()?,
        )
    })
    .await
}

#[tauri::command]
pub async fn agent_sessions_reenter(
    app: AppHandle,
    state: State<'_, AgentSessionsState>,
    terminal_manager: State<'_, TerminalManager>,
    project_path: String,
    session_id: String,
) -> Result<AgentSessionReentryResult, AppError> {
    let state = state.inner().clone();
    let terminal_manager = terminal_manager.inner().clone();
    run_blocking(move || {
        let terminal_surfaces = match terminal_manager.list_agent_surfaces() {
            Ok(surfaces) => surfaces,
            Err(error) => {
                return Ok(reentry::terminal_unavailable_result(
                    session_id,
                    format!("Failed to read managed terminal surfaces: {error}"),
                ));
            }
        };
        let home_dir = state.home_dir.clone();

        reentry::reenter_session(
            &state,
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
    })
    .await
}

async fn run_blocking<T>(
    task: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError>
where
    T: Send + 'static,
{
    tokio::task::spawn_blocking(task)
        .await
        .map_err(|error| AppError::General(format!("Agent sessions task failed: {error}")))?
}

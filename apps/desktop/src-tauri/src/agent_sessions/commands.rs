use std::ffi::OsStr;
use std::sync::Arc;

use tauri::{AppHandle, State, Webview};

use super::AgentSessionsState;
use super::read_model;
use super::reentry;
use super::refresh::AgentSessionsReadKind;
use super::types::{
    AgentSessionReentryResult, AgentSessionsHotStatusResult, AgentSessionsListResult,
};
use crate::agent_runtime::AgentRuntimeState;
use crate::agent_runtime::connections::AgentConnections;
use crate::error::AppError;
use crate::process::path_env::ProcessPath;
use crate::terminal::TerminalManager;

#[tauri::command]
pub async fn agent_sessions_list(
    app: AppHandle,
    state: State<'_, AgentSessionsState>,
    terminal_manager: State<'_, TerminalManager>,
    agent_runtime: State<'_, AgentRuntimeState>,
    project_path: String,
) -> Result<AgentSessionsListResult, AppError> {
    let root = super::scope::normalize_project_path(&project_path)?;
    crate::git::delivery::repair_scope_best_effort(&app, &root, &root).await;
    // Off the response path: this read shows the last good lists.
    state.acp_lists.refresh(agent_runtime.runtime());
    let state = state.inner().clone();
    let terminal_manager = terminal_manager.inner().clone();
    let runtime = agent_runtime.runtime().clone();
    let project_key = root.to_string_lossy().into_owned();
    let reads = state.reads.clone();
    reads
        .run(
            project_key,
            AgentSessionsReadKind::Discovery,
            "agent_sessions_list",
            move || {
                let result = read_model::list_sessions(
                    &state,
                    project_path,
                    terminal_manager.list_agent_surfaces()?,
                    runtime.sessions(),
                )?;
                terminal_manager.reconcile_agent_sessions(&result.sessions)?;
                Ok(result)
            },
        )
        .await
}

#[tauri::command]
pub async fn agent_sessions_refresh(
    app: AppHandle,
    state: State<'_, AgentSessionsState>,
    terminal_manager: State<'_, TerminalManager>,
    agent_runtime: State<'_, AgentRuntimeState>,
    project_path: String,
) -> Result<AgentSessionsListResult, AppError> {
    let root = super::scope::normalize_project_path(&project_path)?;
    crate::git::delivery::repair_scope_best_effort(&app, &root, &root).await;
    // Off the response path: this read shows the last good lists.
    state.acp_lists.refresh(agent_runtime.runtime());
    let state = state.inner().clone();
    let terminal_manager = terminal_manager.inner().clone();
    let runtime = agent_runtime.runtime().clone();
    let project_key = root.to_string_lossy().into_owned();
    let reads = state.reads.clone();
    reads
        .run(
            project_key,
            AgentSessionsReadKind::FullRefresh,
            "agent_sessions_refresh",
            move || {
                let result = read_model::list_sessions(
                    &state,
                    project_path,
                    terminal_manager.list_agent_surfaces()?,
                    runtime.sessions(),
                )?;
                terminal_manager.reconcile_agent_sessions(&result.sessions)?;
                Ok(result)
            },
        )
        .await
}

/// A Sessions collection opened in this webview: the catalogue connections
/// of agents that list their sessions over ACP start and stay until the
/// hold is released or the webview reloads.
#[tauri::command]
pub async fn agent_sessions_hold_catalog(
    webview: Webview,
    state: State<'_, AgentSessionsState>,
    agent_runtime: State<'_, AgentRuntimeState>,
    connections: State<'_, Arc<AgentConnections>>,
) -> Result<u64, AppError> {
    let hold = connections.hold_catalog(webview.label());
    state.acp_lists.raise(&connections, agent_runtime.runtime());
    Ok(hold)
}

/// An explicit refresh or the window's return to the foreground: starts the
/// catalogue connections an open collection needs and is not running;
/// without an open collection it starts nothing. Polls never call it.
#[tauri::command]
pub async fn agent_sessions_raise_catalog(
    state: State<'_, AgentSessionsState>,
    agent_runtime: State<'_, AgentRuntimeState>,
    connections: State<'_, Arc<AgentConnections>>,
) -> Result<(), AppError> {
    state.acp_lists.raise(&connections, agent_runtime.runtime());
    Ok(())
}

#[tauri::command]
pub async fn agent_sessions_release_catalog(
    connections: State<'_, Arc<AgentConnections>>,
    hold: u64,
) -> Result<(), AppError> {
    connections.release_catalog(hold);
    Ok(())
}

#[tauri::command]
pub async fn agent_sessions_hot_status(
    app: AppHandle,
    state: State<'_, AgentSessionsState>,
    terminal_manager: State<'_, TerminalManager>,
    agent_runtime: State<'_, AgentRuntimeState>,
    project_path: String,
    session_ids: Vec<String>,
) -> Result<AgentSessionsHotStatusResult, AppError> {
    let root = super::scope::normalize_project_path(&project_path)?;
    crate::git::delivery::repair_scope_best_effort(&app, &root, &root).await;
    let state = state.inner().clone();
    let terminal_manager = terminal_manager.inner().clone();
    let runtime = agent_runtime.runtime().clone();
    run_blocking(move || {
        let result = read_model::hot_status(
            &state,
            project_path,
            session_ids,
            terminal_manager.list_agent_surfaces()?,
            runtime.sessions(),
        )?;
        terminal_manager.reconcile_agent_sessions(&result.sessions)?;
        Ok(result)
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
    let root = super::scope::normalize_project_path(&project_path)?;
    crate::git::delivery::repair_scope_best_effort(&app, &root, &root).await;
    let state = state.inner().clone();
    let terminal_manager = terminal_manager.inner().clone();
    let search_path = ProcessPath::session().get().await.map(OsStr::to_os_string);
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

        let writers = terminal_manager.writers().clone();
        reentry::reenter_session(
            &state,
            project_path,
            session_id,
            terminal_surfaces,
            &writers,
            move |session, scope_dir| {
                reentry::resolve_agent_cli_binary(
                    &session.source,
                    scope_dir,
                    &home_dir,
                    search_path.as_deref(),
                )
            },
            move |spawn, claim| {
                terminal_manager
                    .spawn_agent_shell_session(app.clone(), spawn, claim)
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

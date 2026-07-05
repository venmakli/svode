use serde::Serialize;
use tauri::{AppHandle, State};

use super::{AgentTerminalSurface, TerminalManager, TerminalSession};
use crate::agent_sessions::types::AgentSessionSource;
use crate::error::AppError;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAgentSurfaceSession {
    pub pty_id: String,
    pub agent_session_id: String,
    pub title: Option<String>,
    pub source: AgentSessionSource,
    pub source_session_id: String,
    pub shell_cwd: String,
    pub created_at: String,
    pub last_output_at: Option<String>,
    pub last_input_at: Option<String>,
}

#[tauri::command]
pub fn terminal_spawn(
    app: AppHandle,
    manager: State<'_, TerminalManager>,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<TerminalSession, AppError> {
    manager.spawn(app, cwd, cols, rows)
}

#[tauri::command]
pub fn terminal_write(
    manager: State<'_, TerminalManager>,
    pty_id: String,
    data: String,
) -> Result<(), AppError> {
    manager.write(&pty_id, &data)
}

#[tauri::command]
pub fn terminal_resize(
    manager: State<'_, TerminalManager>,
    pty_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), AppError> {
    manager.resize(&pty_id, cols, rows)
}

#[tauri::command]
pub fn terminal_kill(manager: State<'_, TerminalManager>, pty_id: String) -> Result<(), AppError> {
    manager.kill(&pty_id)
}

#[tauri::command]
pub fn terminal_list(
    manager: State<'_, TerminalManager>,
) -> Result<Vec<TerminalSession>, AppError> {
    manager.list()
}

#[tauri::command]
pub fn terminal_list_agent_surfaces(
    manager: State<'_, TerminalManager>,
) -> Result<Vec<TerminalAgentSurfaceSession>, AppError> {
    Ok(manager
        .list_agent_surfaces()?
        .into_iter()
        .map(TerminalAgentSurfaceSession::from)
        .collect())
}

#[tauri::command]
pub fn terminal_register_agent_session(
    manager: State<'_, TerminalManager>,
    pty_id: String,
    agent_session_id: String,
    title: Option<String>,
    source: AgentSessionSource,
    source_session_id: String,
    shell_cwd: Option<String>,
    created_at: Option<String>,
) -> Result<(), AppError> {
    manager.register_existing_agent_session(
        pty_id,
        agent_session_id,
        title,
        source,
        source_session_id,
        shell_cwd,
        created_at,
    )
}

impl From<AgentTerminalSurface> for TerminalAgentSurfaceSession {
    fn from(surface: AgentTerminalSurface) -> Self {
        Self {
            pty_id: surface.pty_id,
            agent_session_id: surface.agent_session_id,
            title: surface.title,
            source: surface.source,
            source_session_id: surface.source_session_id,
            shell_cwd: surface.shell_cwd,
            created_at: surface.created_at,
            last_output_at: surface.last_output_at,
            last_input_at: surface.last_input_at,
        }
    }
}

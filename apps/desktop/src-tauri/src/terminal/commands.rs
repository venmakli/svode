use tauri::{AppHandle, State};

use super::{TerminalManager, TerminalResourcePath, TerminalSession};
use crate::error::AppError;
use svode_core::agent_adapters::AgentId;

#[tauri::command]
pub fn terminal_spawn(
    app: AppHandle,
    manager: State<'_, TerminalManager>,
    cwd: String,
    mcp_project_path: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<TerminalSession, AppError> {
    manager.spawn(app, cwd, mcp_project_path, cols, rows)
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
pub fn terminal_prepare_paths(
    manager: State<'_, TerminalManager>,
    pty_id: String,
    paths: Vec<String>,
) -> Result<String, AppError> {
    manager.prepare_paths(&pty_id, paths)
}

#[tauri::command]
pub fn terminal_prepare_resource_paths(
    manager: State<'_, TerminalManager>,
    pty_id: String,
    resources: Vec<TerminalResourcePath>,
) -> Result<String, AppError> {
    manager.prepare_resource_paths(&pty_id, resources)
}

#[tauri::command]
pub fn terminal_register_agent_session(
    manager: State<'_, TerminalManager>,
    pty_id: String,
    agent_session_id: String,
    title: Option<String>,
    source: AgentId,
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

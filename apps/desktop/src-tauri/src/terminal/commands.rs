use tauri::ipc::Invoke;
use tauri::{AppHandle, Manager, Runtime, State};

use super::{TerminalManager, TerminalResourcePath, TerminalSession};
use crate::commands::ordered;
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

/// The command that [`crate::commands::ordered`] dispatches itself.
pub(crate) const TERMINAL_WRITE: &str = "terminal_write";

/// `terminal_write`, dispatched by [`crate::commands::ordered`]: the window
/// sends terminal input without waiting for each call, so the input is queued
/// on the main thread in call order and the call is answered once the PTY
/// takes it (DF-365 R2). Its name, arguments, result and errors are those of
/// the former `#[tauri::command]`.
pub(crate) fn terminal_write<R: Runtime>(invoke: Invoke<R>) {
    ordered::answer(invoke, TERMINAL_WRITE, |call| {
        let pty_id: String = call.arg("ptyId")?;
        let data: String = call.arg("data")?;
        Ok(call
            .webview()
            .state::<TerminalManager>()
            .write_queued(&pty_id, data)?)
    });
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

/// Stops the terminal off the main thread: the stop waits for its process
/// and records its outcome (DF-365 R2).
#[tauri::command]
pub async fn terminal_kill(
    manager: State<'_, TerminalManager>,
    pty_id: String,
) -> Result<(), AppError> {
    let manager = manager.inner().clone();
    tokio::task::spawn_blocking(move || manager.kill(&pty_id))
        .await
        .map_err(|error| AppError::General(format!("Terminal task failed: {error}")))?
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

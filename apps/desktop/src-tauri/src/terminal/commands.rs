use tauri::ipc::{CommandArg, CommandItem, Invoke, InvokeError};
use tauri::{AppHandle, Manager, Runtime, State};

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

/// The command that [`with_ordered_input`] dispatches itself.
const TERMINAL_WRITE: &str = "terminal_write";

/// `tauri::generate_handler!` over the listed commands, with `terminal_write`
/// dispatched by [`with_ordered_input`].
macro_rules! ordered_input_handler {
    ($($commands:tt)*) => {
        $crate::terminal::commands::with_ordered_input(::tauri::generate_handler![$($commands)*])
    };
}
pub(crate) use ordered_input_handler;

/// The generated command handler with `terminal_write` dispatched by hand.
///
/// The window sends terminal input without waiting for each call, and only
/// the main thread sees IPC calls in the order they were made: a sync
/// `#[tauri::command]` would wait there for the PTY, and an async one starts
/// on a tokio worker in no fixed order. So `terminal_write` queues its input
/// on the main thread and answers once the write is done, from a task that
/// waits without holding a worker (DF-365 R2). Its name, arguments, result
/// and errors are those of the former `#[tauri::command]`.
pub(crate) fn with_ordered_input<R: Runtime>(
    commands: impl Fn(Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        if invoke.message.command() != TERMINAL_WRITE {
            return commands(invoke);
        }
        terminal_write(invoke);
        true
    }
}

fn terminal_write<R: Runtime>(invoke: Invoke<R>) {
    let Invoke {
        message,
        resolver,
        acl,
    } = invoke;
    let arg = |key| CommandItem {
        plugin: None,
        name: TERMINAL_WRITE,
        key,
        message: &message,
        acl: &acl,
    };
    let queued = <String as CommandArg<R>>::from_command(arg("ptyId")).and_then(|pty_id| {
        let data = <String as CommandArg<R>>::from_command(arg("data"))?;
        message
            .webview_ref()
            .state::<TerminalManager>()
            .write_queued(&pty_id, data)
            .map_err(InvokeError::from)
    });
    match queued {
        Ok(written) => {
            resolver.respond_async(async move { written.await.map_err(InvokeError::from) })
        }
        Err(error) => resolver.respond::<()>(Err(error)),
    }
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

use tauri::{AppHandle, State};

use super::{TerminalManager, TerminalSession};
use crate::error::AppError;

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

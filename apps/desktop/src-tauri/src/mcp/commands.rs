use tauri::{AppHandle, State};

use super::active::{self, ActiveProjectContext, ActiveProjectState};
use super::config::{self, DoctorReport, ManualConfig, McpClient, McpStatus};
use crate::AppError;

#[tauri::command]
pub fn mcp_get_active_context(
    state: State<'_, ActiveProjectState>,
) -> Option<ActiveProjectContext> {
    state.get()
}

#[tauri::command]
pub fn mcp_clear_active_context(state: State<'_, ActiveProjectState>) {
    state.clear();
}

#[tauri::command]
pub fn mcp_set_active_context(
    state: State<'_, ActiveProjectState>,
    project_path: String,
    active_space_id: Option<String>,
    active_space_path: Option<String>,
) -> Result<ActiveProjectContext, AppError> {
    let context = active::build_context(project_path, active_space_id, active_space_path)?;
    state.set(context.clone());
    Ok(context)
}

#[tauri::command]
pub async fn mcp_get_status() -> Result<McpStatus, AppError> {
    Ok(config::status(
        super::ipc::discovery_exists(),
        super::ipc::desktop_reachable().await,
    ))
}

#[tauri::command]
pub fn mcp_print_config(client: Option<String>) -> Result<ManualConfig, AppError> {
    if let Some(client) = client {
        McpClient::parse(&client).map_err(|e| AppError::General(e.message))?;
    }
    Ok(config::manual_config_object())
}

#[tauri::command]
pub async fn mcp_install_client(client: String) -> Result<McpStatus, AppError> {
    let client = McpClient::parse(&client).map_err(|e| AppError::General(e.message))?;
    config::install_client(client).map_err(|e| AppError::General(e.message))?;
    Ok(config::status(
        super::ipc::discovery_exists(),
        super::ipc::desktop_reachable().await,
    ))
}

#[tauri::command]
pub async fn mcp_remove_client(client: String) -> Result<McpStatus, AppError> {
    let client = McpClient::parse(&client).map_err(|e| AppError::General(e.message))?;
    config::remove_client(client).map_err(|e| AppError::General(e.message))?;
    Ok(config::status(
        super::ipc::discovery_exists(),
        super::ipc::desktop_reachable().await,
    ))
}

#[tauri::command]
pub async fn mcp_run_doctor(_app: AppHandle) -> Result<DoctorReport, AppError> {
    Ok(config::doctor(
        super::ipc::discovery_exists(),
        super::ipc::desktop_reachable().await,
    ))
}

use tauri::{AppHandle, Emitter, State, Window};
use tokio::sync::Mutex;

use super::active::{self, ActiveProjectContext, ActiveProjectState};
use super::config::{self, DoctorReport, ManualConfig, McpClient, McpStatus};
use crate::AppError;

const MCP_STATUS_CHANGED_EVENT: &str = "mcp:status-changed";

#[derive(Default)]
pub struct McpConfigState {
    operation_lock: Mutex<()>,
}

impl McpConfigState {
    pub fn new() -> Self {
        Self::default()
    }
}

#[tauri::command]
pub fn mcp_get_active_context(
    state: State<'_, ActiveProjectState>,
) -> Option<ActiveProjectContext> {
    state.get()
}

#[tauri::command]
pub fn mcp_clear_active_context(state: State<'_, ActiveProjectState>, window: Window) {
    state.clear_window(window.label());
}

#[tauri::command]
pub fn mcp_set_active_context(
    state: State<'_, ActiveProjectState>,
    window: Window,
    project_path: String,
    active_space_id: Option<String>,
    active_space_path: Option<String>,
) -> Result<ActiveProjectContext, AppError> {
    let context = active::build_context(project_path, active_space_id, active_space_path)?;
    state.set_for_window(window.label(), context.clone());
    Ok(context)
}

#[tauri::command]
pub async fn mcp_get_status(state: State<'_, McpConfigState>) -> Result<McpStatus, AppError> {
    let _guard = state.operation_lock.lock().await;
    Ok(canonical_status().await)
}

#[tauri::command]
pub fn mcp_print_config(client: Option<String>) -> Result<ManualConfig, AppError> {
    if let Some(client) = client {
        McpClient::parse(&client).map_err(|e| AppError::General(e.message))?;
    }
    Ok(config::manual_config_object())
}

#[tauri::command]
pub async fn mcp_install_client(
    app: AppHandle,
    state: State<'_, McpConfigState>,
    client: String,
) -> Result<McpStatus, AppError> {
    mutate_client_config(&app, &state, &client, true).await
}

#[tauri::command]
pub async fn mcp_remove_client(
    app: AppHandle,
    state: State<'_, McpConfigState>,
    client: String,
) -> Result<McpStatus, AppError> {
    mutate_client_config(&app, &state, &client, false).await
}

#[tauri::command]
pub async fn mcp_run_doctor(_app: AppHandle) -> Result<DoctorReport, AppError> {
    Ok(config::doctor(
        super::ipc::discovery_exists(),
        super::ipc::desktop_reachable().await,
    ))
}

async fn mutate_client_config(
    app: &AppHandle,
    state: &McpConfigState,
    client: &str,
    installed: bool,
) -> Result<McpStatus, AppError> {
    let client = McpClient::parse(client).map_err(|error| AppError::General(error.message))?;
    let _guard = state.operation_lock.lock().await;
    let before = canonical_status().await;
    if !client_mutation_needed(&before, client, installed)? {
        return Ok(before);
    }

    if installed {
        config::install_client(client).map_err(|error| AppError::General(error.message))?;
    } else {
        config::remove_client(client).map_err(|error| AppError::General(error.message))?;
    }

    let canonical = canonical_status().await;
    if client_installed(&canonical, client) != Some(installed) {
        return Err(AppError::General(format!(
            "MCP client {} did not reach the requested canonical state",
            client.as_str()
        )));
    }

    let _ = app.emit(MCP_STATUS_CHANGED_EVENT, ());
    Ok(canonical)
}

async fn canonical_status() -> McpStatus {
    config::status(
        super::ipc::discovery_exists(),
        super::ipc::desktop_reachable().await,
    )
}

fn client_installed(status: &McpStatus, client: McpClient) -> Option<bool> {
    status
        .clients
        .iter()
        .find(|candidate| candidate.id == client.as_str())
        .map(|candidate| candidate.installed)
}

fn client_mutation_needed(
    status: &McpStatus,
    client: McpClient,
    requested: bool,
) -> Result<bool, AppError> {
    client_installed(status, client)
        .map(|installed| installed != requested)
        .ok_or_else(|| {
            AppError::General(format!(
                "canonical MCP status did not include client {}",
                client.as_str()
            ))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_same_value_as_no_op_and_opposite_state_as_mutation() {
        let status = config::status(false, false);

        for client in [McpClient::ClaudeCode, McpClient::Codex] {
            let installed = client_installed(&status, client).expect("canonical client status");
            assert!(!client_mutation_needed(&status, client, installed).expect("same state"));
            assert!(client_mutation_needed(&status, client, !installed).expect("opposite state"));
        }
    }
}

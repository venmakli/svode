use std::path::Path;

use tauri::{AppHandle, Emitter, Manager, State, Window};
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
pub async fn mcp_get_status(
    app: AppHandle,
    state: State<'_, McpConfigState>,
) -> Result<McpStatus, AppError> {
    let _guard = state.operation_lock.lock().await;
    let canonical = canonical_status(&app).await;
    emit_if_changed(&app, canonical.changed);
    Ok(canonical.status)
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
    let before = canonical_status(app).await;
    if !client_mutation_needed(&before.status, client, installed)? {
        emit_if_changed(app, before.changed);
        return Ok(before.status);
    }

    if installed {
        let project_path = active_project_path(app);
        config::install_client_for_project(client, project_path.as_deref())
            .map_err(|error| AppError::General(error.message))?;
    } else {
        config::remove_client(client).map_err(|error| AppError::General(error.message))?;
    }

    let canonical = canonical_status(app).await;
    if client_installed(&canonical.status, client) != Some(installed) {
        return Err(AppError::General(format!(
            "MCP client {} did not reach the requested canonical state",
            client.as_str()
        )));
    }

    emit_if_changed(app, true);
    Ok(canonical.status)
}

async fn canonical_status(app: &AppHandle) -> config::ConfigMaintenanceResult {
    let project_path = active_project_path(app);
    config::maintain_and_status(
        super::ipc::discovery_exists(),
        super::ipc::desktop_reachable().await,
        project_path.as_deref(),
    )
}

fn active_project_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.state::<ActiveProjectState>()
        .get()
        .map(|context| Path::new(&context.project_path).to_path_buf())
}

fn emit_if_changed(app: &AppHandle, changed: bool) {
    if changed {
        let _ = app.emit(MCP_STATUS_CHANGED_EVENT, ());
    }
}

pub async fn maintain_clients(app: &AppHandle) {
    let state = app.state::<McpConfigState>();
    let _guard = state.operation_lock.lock().await;
    let canonical = canonical_status(app).await;
    emit_if_changed(app, canonical.changed);
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
        let status = status_with_clients(false);

        for client in [McpClient::ClaudeCode, McpClient::Codex] {
            let installed = client_installed(&status, client).expect("canonical client status");
            assert!(!client_mutation_needed(&status, client, installed).expect("same state"));
            assert!(client_mutation_needed(&status, client, !installed).expect("opposite state"));
        }
    }

    fn status_with_clients(installed: bool) -> McpStatus {
        let clients = [McpClient::ClaudeCode, McpClient::Codex]
            .into_iter()
            .map(|client| config::McpClientStatus {
                id: client.as_str().to_string(),
                name: client.as_str().to_string(),
                found: true,
                installed,
                managed: installed,
                status: if installed {
                    "installed".to_string()
                } else {
                    "mcp_not_installed".to_string()
                },
                attention_code: None,
                path: None,
                config_path: None,
                message: None,
            })
            .collect();
        McpStatus {
            server: config::McpServerInfo {
                status: "installed".to_string(),
                command: None,
                version: None,
                message: None,
            },
            clients,
            manual_config: config::ManualConfig {
                name: "svode".to_string(),
                transport: "stdio".to_string(),
                command: "svode-mcp".to_string(),
                args: vec!["--app".to_string(), "desktop".to_string()],
                env: std::collections::HashMap::new(),
            },
            doctor: config::DoctorReport {
                ok: true,
                command: None,
                discovery_file: None,
                messages: Vec::new(),
                errors: Vec::new(),
                binary_path: "svode-mcp".to_string(),
                binary_exists: true,
                binary_executable: true,
                version: "test".to_string(),
                bridge_protocol: super::super::MCP_BRIDGE_PROTOCOL.to_string(),
                discovery_present: true,
                desktop_reachable: true,
                issues: Vec::new(),
            },
        }
    }
}

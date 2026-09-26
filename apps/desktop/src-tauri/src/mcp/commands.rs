use std::path::Path;

use serde::Serialize;
use svode_connect::{Client, ConnectError, DoctorReport, Machine, Status};
use tauri::{AppHandle, Emitter, Manager, State, Window};
use tokio::sync::Mutex;

use super::active::{self, ActiveProjectContext, ActiveProjectState};
use crate::AppError;
use svode_mcp::bridge;

const MCP_STATUS_CHANGED_EVENT: &str = "mcp:status-changed";

#[derive(Default)]
pub struct McpConfigState {
    operation_lock: Mutex<()>,
    /// Version of the active runtime that this start of the app replaced
    /// with its own.
    runtime_updated_from: std::sync::Mutex<Option<String>>,
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

/// Status of the connections as Settings show them.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionsStatus {
    #[serde(flatten)]
    status: Status,
    /// Set when this start of the app switched the connected clients to its
    /// version: open agent sessions get it after a restart.
    runtime_updated_from: Option<String>,
}

/// Status of the connections after a reconcile, as Settings show it: a
/// connected client that lost part of its set is completed first.
#[tauri::command]
pub async fn mcp_get_status(
    app: AppHandle,
    state: State<'_, McpConfigState>,
) -> Result<ConnectionsStatus, AppError> {
    let _guard = state.operation_lock.lock().await;
    let machine = machine(&app)?;
    let (changed, errors) = svode_connect::reconcile(&machine);
    emit_if_changed(&app, changed);
    Ok(status(&state, &machine, &errors).await)
}

/// MCP config of the client for a user who configures it by hand.
#[tauri::command]
pub fn mcp_print_config(client: String) -> Result<String, AppError> {
    let client = Client::parse(&client).map_err(app_error)?;
    let machine = Machine::user().map_err(app_error)?;
    Ok(svode_connect::manual_config_text(&machine, client))
}

/// Connects the client completely: skill, `svode` and MCP.
#[tauri::command]
pub async fn mcp_install_client(
    app: AppHandle,
    state: State<'_, McpConfigState>,
    client: String,
) -> Result<ConnectionsStatus, AppError> {
    change_client(&app, &state, &client, svode_connect::connect).await
}

#[tauri::command]
pub async fn mcp_remove_client(
    app: AppHandle,
    state: State<'_, McpConfigState>,
    client: String,
) -> Result<ConnectionsStatus, AppError> {
    change_client(&app, &state, &client, svode_connect::disconnect).await
}

#[tauri::command]
pub async fn mcp_run_doctor(app: AppHandle) -> Result<DoctorReport, AppError> {
    let machine = machine(&app)?;
    Ok(svode_connect::doctor(
        &machine,
        Some(&bridge::probe().await),
    ))
}

async fn change_client(
    app: &AppHandle,
    state: &McpConfigState,
    client: &str,
    step: fn(&Machine, Client) -> Result<bool, ConnectError>,
) -> Result<ConnectionsStatus, AppError> {
    let client = Client::parse(client).map_err(app_error)?;
    let _guard = state.operation_lock.lock().await;
    let machine = machine(app)?;
    let changed = step(&machine, client).map_err(app_error)?;
    emit_if_changed(app, changed);
    Ok(status(state, &machine, &[]).await)
}

async fn status(
    state: &McpConfigState,
    machine: &Machine,
    failed: &[(Client, ConnectError)],
) -> ConnectionsStatus {
    ConnectionsStatus {
        status: svode_connect::status(machine, failed, Some(&bridge::probe().await)),
        runtime_updated_from: state
            .runtime_updated_from
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone(),
    }
}

/// The user of the app, checking the project and local entries of the
/// Project of the active window.
fn machine(app: &AppHandle) -> Result<Machine, AppError> {
    let project = app
        .state::<ActiveProjectState>()
        .get()
        .map(|context| Path::new(&context.project_path).to_path_buf());
    Ok(Machine::user()
        .map_err(app_error)?
        .with_project(project.as_deref()))
}

fn app_error(error: ConnectError) -> AppError {
    AppError::General(error.message)
}

fn emit_if_changed(app: &AppHandle, changed: bool) {
    if changed {
        let _ = app.emit(MCP_STATUS_CHANGED_EVENT, ());
    }
}

/// Reconcile at every start, after the app took over the stable location:
/// connected clients follow the version of this app, and a managed MCP
/// entry of a previous desktop app becomes a full connection. `updated_from`
/// is the version of the runtime the app replaced with its own.
pub async fn reconcile_clients(app: &AppHandle, updated_from: Option<String>) {
    let state = app.state::<McpConfigState>();
    let _guard = state.operation_lock.lock().await;
    *state
        .runtime_updated_from
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = updated_from;
    let machine = match machine(app) {
        Ok(machine) => machine,
        Err(error) => {
            tracing::warn!("agent client connections were not reconciled: {error}");
            return;
        }
    };
    let (changed, errors) = svode_connect::reconcile(&machine);
    for (client, error) in errors {
        tracing::warn!("{} connection was not completed: {error}", client.name());
    }
    emit_if_changed(app, changed);
}

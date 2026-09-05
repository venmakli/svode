use std::path::Path;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::AppError;
use crate::apps::environment;
use crate::apps::manifest::{ValidatedRuntime, read_and_validate_manifest, resolve_app_owner};
use crate::space::app_variables::{
    self, AppVariableContextInput, AppVariableKind, AppVariableOwnerContext, AppVariablesCatalog,
    KeyringSecretStore,
};
use crate::space::settings::AppSettingsState;
use crate::system_path;

pub(crate) const APP_VARIABLES_CHANGED_EVENT: &str = "app-settings:variables-changed";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpsertAppVariableInput {
    name: String,
    kind: AppVariableKind,
    value: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppVariableBindingInput {
    context: AppVariableContextInput,
    reference_name: String,
    entry_name: String,
}

#[tauri::command]
pub(crate) async fn get_app_variables(
    app: AppHandle,
    state: State<'_, AppSettingsState>,
    context: Option<AppVariableContextInput>,
) -> Result<AppVariablesCatalog, AppError> {
    let config_dir = config_dir(&app)?;
    let context = context.map(resolve_context).transpose()?;
    run_locked(&state, move || {
        app_variables::get_catalog(&config_dir, context.as_ref(), &KeyringSecretStore)
    })
    .await
}

#[tauri::command]
pub(crate) async fn upsert_app_variable(
    app: AppHandle,
    state: State<'_, AppSettingsState>,
    input: UpsertAppVariableInput,
) -> Result<(), AppError> {
    let config_dir = config_dir(&app)?;
    run_locked(&state, move || {
        app_variables::upsert(
            &config_dir,
            &input.name,
            input.kind,
            input.value.as_deref(),
            &KeyringSecretStore,
        )
    })
    .await?;
    let _ = app.emit(APP_VARIABLES_CHANGED_EVENT, ());
    Ok(())
}

#[tauri::command]
pub(crate) async fn remove_app_variable(
    app: AppHandle,
    state: State<'_, AppSettingsState>,
    name: String,
) -> Result<(), AppError> {
    let config_dir = config_dir(&app)?;
    run_locked(&state, move || {
        app_variables::remove(&config_dir, &name, &KeyringSecretStore)
    })
    .await?;
    let _ = app.emit(APP_VARIABLES_CHANGED_EVENT, ());
    Ok(())
}

#[tauri::command]
pub(crate) async fn set_app_variable_binding(
    app: AppHandle,
    state: State<'_, AppSettingsState>,
    input: AppVariableBindingInput,
) -> Result<(), AppError> {
    let context = resolve_context(input.context)?;
    let config_dir = config_dir(&app)?;
    run_locked(&state, move || {
        app_variables::bind(
            &config_dir,
            &context,
            &input.reference_name,
            &input.entry_name,
        )
    })
    .await?;
    let _ = app.emit(APP_VARIABLES_CHANGED_EVENT, ());
    Ok(())
}

pub(crate) fn resolve_context(
    input: AppVariableContextInput,
) -> Result<AppVariableOwnerContext, AppError> {
    let owner = resolve_app_owner(
        Path::new(&input.project_path),
        input.space_id.as_deref(),
        &input.owner_path,
    )?;
    let references = match read_and_validate_manifest(&owner.owner_path)? {
        Some(Ok(ValidatedRuntime::Process(runtime))) => {
            environment::references(&runtime.environment_declaration).map_err(|error| {
                AppError::General(format!("Invalid App environment: {}", error.message))
            })?
        }
        _ => Vec::new(),
    };
    let owner_directory = system_path::user_facing_path(&owner.owner_path);
    Ok(AppVariableOwnerContext {
        owner_key: owner_directory.clone(),
        owner_directory,
        references,
    })
}

pub(crate) async fn run_locked<T: Send + 'static>(
    state: &AppSettingsState,
    operation: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    let lock = state.operation_lock();
    tokio::task::spawn_blocking(move || {
        let _guard = lock
            .lock()
            .map_err(|_| AppError::General("app settings mutex poisoned".to_string()))?;
        operation()
    })
    .await
    .map_err(|error| AppError::General(format!("App variables task failed: {error}")))?
}

fn config_dir(app: &AppHandle) -> Result<std::path::PathBuf, AppError> {
    app.path()
        .app_config_dir()
        .map_err(|error| AppError::General(error.to_string()))
}

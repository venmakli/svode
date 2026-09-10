use crate::apps::environment;
use crate::apps::manifest::{ValidatedRuntime, read_and_validate_manifest, resolve_app_owner};
use crate::space::app_variables::{
    self, AppVariableContextInput, AppVariableOwnerContext, AppVariablesCatalog,
    KeyringSecretStore, VariableScope, storage_error,
};
use crate::space::settings::AppSettingsState;
use crate::{AppError, system_path};
use serde::Deserialize;
use std::path::Path;
use svode_core::variables::{self as core, Service, SourceOwner, SourceReference};
use tauri::{AppHandle, Emitter, Manager, State};

pub(crate) const APP_VARIABLES_CHANGED_EVENT: &str = "app-settings:variables-changed";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpsertAppVariableInput {
    scope: Option<VariableScope>,
    source: SourceReference,
    mode: core::Mode,
    kind: core::Kind,
    value: Option<String>,
    identity: Option<String>,
    revision: core::Revision,
    keep: Option<core::Mode>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoveAppVariableInput {
    scope: Option<VariableScope>,
    source: SourceReference,
    identity: String,
    revision: core::Revision,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppVariableBindingInput {
    context: AppVariableContextInput,
    reference_name: String,
    source: Option<SourceReference>,
    revision: String,
}

#[tauri::command]
pub(crate) async fn get_app_variables(
    app: AppHandle,
    state: State<'_, AppSettingsState>,
    context: Option<AppVariableContextInput>,
    scope: Option<VariableScope>,
) -> Result<AppVariablesCatalog, AppError> {
    let config = config_dir(&app)?;
    run_locked(&state, move || {
        let context = context.map(resolve_context).transpose()?;
        let scope = context.as_ref().map(|c| &c.scope).or(scope.as_ref());
        app_variables::get_catalog(&config, scope, context.as_ref(), &KeyringSecretStore)
    })
    .await
}
#[tauri::command]
pub(crate) async fn upsert_app_variable(
    app: AppHandle,
    state: State<'_, AppSettingsState>,
    input: UpsertAppVariableInput,
) -> Result<(), AppError> {
    let config = config_dir(&app)?;
    let result = run_locked(&state, move || {
        let owner = app_variables::owner(&config, input.scope.as_ref(), &input.source.owner)?;
        Service::new(&KeyringSecretStore)
            .save(
                &owner,
                core::Save {
                    name: input.source.name,
                    mode: input.mode,
                    kind: input.kind,
                    value: input.value,
                    revision: input.revision,
                    identity: input.identity,
                    keep: input.keep,
                },
            )
            .map_err(storage_error)
    })
    .await;
    // Failed multi-store publication can itself require consumers to enter recovery.
    match &result {
        Ok(change) => {
            let _ = app.emit(APP_VARIABLES_CHANGED_EVENT, change);
        }
        Err(_) => {
            let _ = app.emit(APP_VARIABLES_CHANGED_EVENT, ());
        }
    }
    result.map(|_| ())
}
#[tauri::command]
pub(crate) async fn remove_app_variable(
    app: AppHandle,
    state: State<'_, AppSettingsState>,
    input: RemoveAppVariableInput,
) -> Result<(), AppError> {
    let config = config_dir(&app)?;
    let result = run_locked(&state, move || {
        let owner = app_variables::owner(&config, input.scope.as_ref(), &input.source.owner)?;
        Service::new(&KeyringSecretStore)
            .remove(&owner, &input.source.name, &input.identity, &input.revision)
            .map_err(storage_error)
    })
    .await;
    match &result {
        Ok(change) => {
            let _ = app.emit(APP_VARIABLES_CHANGED_EVENT, change);
        }
        Err(_) => {
            let _ = app.emit(APP_VARIABLES_CHANGED_EVENT, ());
        }
    }
    result.map(|_| ())
}
#[tauri::command]
pub(crate) async fn recover_app_variables(
    app: AppHandle,
    state: State<'_, AppSettingsState>,
    scope: Option<VariableScope>,
    source: Option<SourceOwner>,
) -> Result<(), AppError> {
    let config = config_dir(&app)?;
    let result = run_locked(&state, move || {
        let sources = source.map(|s| vec![s]).unwrap_or_else(|| {
            let mut sources = vec![SourceOwner::Library];
            if let Some(scope) = &scope {
                sources.push(SourceOwner::Project);
                if scope.space_id.is_some() {
                    sources.push(scope.owner());
                }
            }
            sources
        });
        for source in sources {
            Service::new(&KeyringSecretStore)
                .recover(&app_variables::owner(&config, scope.as_ref(), &source)?)
                .map_err(storage_error)?;
        }
        Ok(())
    })
    .await;
    let _ = app.emit(APP_VARIABLES_CHANGED_EVENT, ());
    result
}
#[tauri::command]
pub(crate) async fn set_app_variable_binding(
    app: AppHandle,
    state: State<'_, AppSettingsState>,
    input: AppVariableBindingInput,
) -> Result<(), AppError> {
    let config = config_dir(&app)?;
    run_locked(&state, move || {
        let context = resolve_context(input.context)?;
        app_variables::bind(
            &config,
            &context,
            &input.reference_name,
            input.source,
            &input.revision,
            &KeyringSecretStore,
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
            environment::references(&runtime.environment_declaration)
                .map_err(|e| AppError::General(e.message))?
        }
        _ => Vec::new(),
    };
    let owner_directory = system_path::user_facing_path(&owner.owner_path);
    Ok(AppVariableOwnerContext {
        scope: VariableScope {
            project_path: owner.project_path.to_string_lossy().into(),
            space_id: input.space_id,
        },
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
            .map_err(|_| AppError::General("app settings mutex poisoned".into()))?;
        operation()
    })
    .await
    .map_err(|_| AppError::General("App variables task failed".into()))?
}
fn config_dir(app: &AppHandle) -> Result<std::path::PathBuf, AppError> {
    app.path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))
}

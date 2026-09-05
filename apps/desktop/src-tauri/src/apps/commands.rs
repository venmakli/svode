use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::ShellExt;

use super::environment;
use super::manifest::{
    AppManifestDiagnostic, AppProcessRuntime, AppRuntimeType, ValidatedRuntime,
    read_and_validate_manifest, resolve_app_owner,
};
use super::process_runtime::{
    AppProcessAction, AppProcessLogs, AppProcessPhase, AppProcessSnapshot,
};
use super::{AppProcessState, AppSourceState};
use crate::AppError;
use crate::commands::app_variables::{APP_VARIABLES_CHANGED_EVENT, run_locked};
use crate::space::app_variables::{
    AppVariableOwnerContext, KeyringSecretStore, MissingAppVariable, clear_owner_usage,
    resolve_environment,
};
use crate::space::settings::AppSettingsState;
use crate::system_path;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum AppManifestInspection {
    Missing {
        #[serde(rename = "ownerDirectory")]
        owner_directory: String,
    },
    Invalid {
        #[serde(rename = "ownerDirectory")]
        owner_directory: String,
        diagnostics: Vec<AppManifestDiagnostic>,
    },
    Ready {
        #[serde(rename = "ownerDirectory")]
        owner_directory: String,
        #[serde(rename = "runtimeType")]
        runtime_type: AppRuntimeType,
        #[serde(rename = "viewportUrl")]
        viewport_url: String,
        #[serde(rename = "capabilityToken", skip_serializing_if = "Option::is_none")]
        capability_token: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        process: Option<AppProcessDetails>,
    },
    Launching {
        #[serde(rename = "ownerDirectory")]
        owner_directory: String,
        #[serde(rename = "runtimeType")]
        runtime_type: AppRuntimeType,
        phase: AppProcessPhase,
        #[serde(rename = "browserUrl")]
        browser_url: String,
        process: AppProcessDetails,
    },
    Unavailable {
        #[serde(rename = "ownerDirectory")]
        owner_directory: String,
        #[serde(rename = "runtimeType")]
        runtime_type: AppRuntimeType,
        reason: &'static str,
        #[serde(rename = "browserUrl", skip_serializing_if = "Option::is_none")]
        browser_url: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        process: Option<AppProcessDetails>,
        #[serde(rename = "missingVariables", skip_serializing_if = "Vec::is_empty")]
        missing_variables: Vec<MissingAppVariable>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppProcessDetails {
    managed: bool,
    has_setup: bool,
    logs: AppProcessLogs,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AppProcessControlAction {
    Retry,
    Restart,
    Stop,
    RerunSetup,
}

#[tauri::command]
pub(crate) async fn app_manifest_inspect(
    app: AppHandle,
    settings_state: State<'_, AppSettingsState>,
    source_state: State<'_, AppSourceState>,
    process_state: State<'_, AppProcessState>,
    project_path: String,
    space_id: Option<String>,
    owner_path: String,
) -> Result<AppManifestInspection, AppError> {
    let owner = resolve_app_owner(Path::new(&project_path), space_id.as_deref(), &owner_path)?;
    let owner_directory = system_path::user_facing_path(&owner.owner_path);
    let Some(manifest) = read_and_validate_manifest(&owner.owner_path)? else {
        process_state.remove_owner(&owner.project_path, &owner.owner_path);
        clear_variable_usage(&app, &settings_state, &owner.owner_path).await?;
        return Ok(AppManifestInspection::Missing { owner_directory });
    };
    let runtime = match manifest {
        Ok(runtime) => runtime,
        Err(diagnostics) => {
            process_state.remove_owner(&owner.project_path, &owner.owner_path);
            clear_variable_usage(&app, &settings_state, &owner.owner_path).await?;
            return Ok(AppManifestInspection::Invalid {
                owner_directory,
                diagnostics,
            });
        }
    };

    match runtime {
        ValidatedRuntime::Url { url } => {
            process_state.remove_owner(&owner.project_path, &owner.owner_path);
            clear_variable_usage(&app, &settings_state, &owner.owner_path).await?;
            Ok(AppManifestInspection::Ready {
                owner_directory,
                runtime_type: AppRuntimeType::Url,
                viewport_url: url,
                capability_token: None,
                process: None,
            })
        }
        ValidatedRuntime::Process(mut runtime) => {
            let missing =
                resolve_runtime_environment(&app, &settings_state, &owner.owner_path, &mut runtime)
                    .await?;
            if !missing.is_empty() {
                process_state.remove_owner(&owner.project_path, &owner.owner_path);
                return Ok(AppManifestInspection::Unavailable {
                    owner_directory,
                    runtime_type: AppRuntimeType::Process,
                    reason: "missing_app_variables",
                    browser_url: Some(runtime.url),
                    process: Some(AppProcessDetails {
                        managed: false,
                        has_setup: runtime.setup.is_some(),
                        logs: AppProcessLogs::default(),
                    }),
                    missing_variables: missing,
                });
            }
            let url = runtime.url.clone();
            let snapshot =
                process_state.inspect_or_launch(&owner.project_path, &owner.owner_path, runtime);
            Ok(process_inspection(owner_directory, url, snapshot))
        }
        ValidatedRuntime::Static { public_root, entry } => {
            process_state.remove_owner(&owner.project_path, &owner.owner_path);
            clear_variable_usage(&app, &settings_state, &owner.owner_path).await?;
            let declared_root = owner.owner_path.join(&public_root);
            let root_metadata = fs::symlink_metadata(&declared_root);
            if !matches!(root_metadata, Ok(ref metadata) if metadata.is_dir() && !metadata.file_type().is_symlink())
            {
                return Ok(AppManifestInspection::Unavailable {
                    owner_directory,
                    runtime_type: AppRuntimeType::Static,
                    reason: "static_public_root_unavailable",
                    browser_url: None,
                    process: None,
                    missing_variables: Vec::new(),
                });
            }
            let canonical_root = fs::canonicalize(&declared_root)?;
            if !canonical_root.starts_with(&owner.owner_path) {
                return Ok(AppManifestInspection::Invalid {
                    owner_directory,
                    diagnostics: vec![AppManifestDiagnostic {
                        code: "path_escape",
                        path: "runtime.publicRoot".to_string(),
                        message: "publicRoot escapes the App owner directory".to_string(),
                    }],
                });
            }
            let declared_entry = canonical_root.join(&entry);
            let entry_metadata = fs::symlink_metadata(&declared_entry);
            if !matches!(entry_metadata, Ok(ref metadata) if metadata.is_file() && !metadata.file_type().is_symlink())
            {
                return Ok(AppManifestInspection::Unavailable {
                    owner_directory,
                    runtime_type: AppRuntimeType::Static,
                    reason: "static_entry_unavailable",
                    browser_url: None,
                    process: None,
                    missing_variables: Vec::new(),
                });
            }
            let canonical_entry = fs::canonicalize(&declared_entry)?;
            if !canonical_entry.starts_with(&canonical_root) {
                return Ok(AppManifestInspection::Invalid {
                    owner_directory,
                    diagnostics: vec![AppManifestDiagnostic {
                        code: "path_escape",
                        path: "runtime.entry".to_string(),
                        message: "entry escapes runtime.publicRoot".to_string(),
                    }],
                });
            }
            let (token, viewport_url) = source_state.issue(canonical_root, &entry).await?;
            Ok(AppManifestInspection::Ready {
                owner_directory,
                runtime_type: AppRuntimeType::Static,
                viewport_url,
                capability_token: Some(token),
                process: None,
            })
        }
    }
}

#[tauri::command]
pub(crate) async fn app_process_control(
    app: AppHandle,
    settings_state: State<'_, AppSettingsState>,
    process_state: State<'_, AppProcessState>,
    project_path: String,
    space_id: Option<String>,
    owner_path: String,
    action: AppProcessControlAction,
) -> Result<AppManifestInspection, AppError> {
    let owner = resolve_app_owner(Path::new(&project_path), space_id.as_deref(), &owner_path)?;
    let owner_directory = system_path::user_facing_path(&owner.owner_path);

    if matches!(action, AppProcessControlAction::Stop) {
        let snapshot = process_state
            .stop(&owner.project_path, &owner.owner_path)
            .ok_or_else(|| AppError::General("App process is not running".to_string()))?;
        let url = match &snapshot {
            AppProcessSnapshot::Launching { .. } => unreachable!("stopped snapshot is terminal"),
            AppProcessSnapshot::Ready { url, .. }
            | AppProcessSnapshot::Failed { url, .. }
            | AppProcessSnapshot::Stopped { url, .. } => url.clone(),
        };
        return Ok(process_inspection(owner_directory, url, snapshot));
    }

    let mut runtime = current_process_runtime(&owner.owner_path)?;
    let missing =
        resolve_runtime_environment(&app, &settings_state, &owner.owner_path, &mut runtime).await?;
    if !missing.is_empty() {
        return Ok(AppManifestInspection::Unavailable {
            owner_directory,
            runtime_type: AppRuntimeType::Process,
            reason: "missing_app_variables",
            browser_url: Some(runtime.url),
            process: Some(AppProcessDetails {
                managed: false,
                has_setup: runtime.setup.is_some(),
                logs: AppProcessLogs::default(),
            }),
            missing_variables: missing,
        });
    }
    let url = runtime.url.clone();
    let action = match action {
        AppProcessControlAction::Retry => AppProcessAction::Retry,
        AppProcessControlAction::Restart => AppProcessAction::Restart,
        AppProcessControlAction::RerunSetup => AppProcessAction::RerunSetup,
        AppProcessControlAction::Stop => unreachable!(),
    };
    let snapshot = process_state.control(&owner.project_path, &owner.owner_path, runtime, action);
    Ok(process_inspection(owner_directory, url, snapshot))
}

fn current_process_runtime(owner_path: &Path) -> Result<AppProcessRuntime, AppError> {
    match read_and_validate_manifest(owner_path)? {
        None => Err(AppError::FileNotFound("app.yaml".to_string())),
        Some(Err(diagnostics)) => Err(AppError::General(
            diagnostics
                .first()
                .map(|diagnostic| diagnostic.message.clone())
                .unwrap_or_else(|| "app.yaml is invalid".to_string()),
        )),
        Some(Ok(ValidatedRuntime::Process(runtime))) => Ok(runtime),
        Some(Ok(_)) => Err(AppError::General(
            "App process controls require a process runtime".to_string(),
        )),
    }
}

fn process_inspection(
    owner_directory: String,
    declared_url: String,
    snapshot: AppProcessSnapshot,
) -> AppManifestInspection {
    match snapshot {
        AppProcessSnapshot::Launching {
            phase,
            has_setup,
            logs,
        } => AppManifestInspection::Launching {
            owner_directory,
            runtime_type: AppRuntimeType::Process,
            phase,
            browser_url: declared_url,
            process: AppProcessDetails {
                managed: true,
                has_setup,
                logs,
            },
        },
        AppProcessSnapshot::Ready {
            url,
            managed,
            has_setup,
            logs,
        } => AppManifestInspection::Ready {
            owner_directory,
            runtime_type: AppRuntimeType::Process,
            viewport_url: url,
            capability_token: None,
            process: Some(AppProcessDetails {
                managed,
                has_setup,
                logs,
            }),
        },
        AppProcessSnapshot::Failed {
            reason,
            url,
            has_setup,
            logs,
        } => AppManifestInspection::Unavailable {
            owner_directory,
            runtime_type: AppRuntimeType::Process,
            reason,
            browser_url: Some(url),
            process: Some(AppProcessDetails {
                managed: false,
                has_setup,
                logs,
            }),
            missing_variables: Vec::new(),
        },
        AppProcessSnapshot::Stopped {
            url,
            has_setup,
            logs,
        } => AppManifestInspection::Unavailable {
            owner_directory,
            runtime_type: AppRuntimeType::Process,
            reason: "process_stopped",
            browser_url: Some(url),
            process: Some(AppProcessDetails {
                managed: false,
                has_setup,
                logs,
            }),
            missing_variables: Vec::new(),
        },
    }
}

async fn clear_variable_usage(
    app: &AppHandle,
    settings_state: &AppSettingsState,
    owner_path: &Path,
) -> Result<(), AppError> {
    let owner_key = system_path::user_facing_path(owner_path);
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| AppError::General(error.to_string()))?;
    let changed = run_locked(settings_state, move || {
        clear_owner_usage(&config_dir, &owner_key)
    })
    .await?;
    if changed {
        let _ = app.emit(APP_VARIABLES_CHANGED_EVENT, ());
    }
    Ok(())
}

async fn resolve_runtime_environment(
    app: &AppHandle,
    settings_state: &AppSettingsState,
    owner_path: &Path,
    runtime: &mut AppProcessRuntime,
) -> Result<Vec<MissingAppVariable>, AppError> {
    let references = environment::references(&runtime.environment_declaration)
        .map_err(|error| AppError::General(error.message))?;
    let owner_directory = system_path::user_facing_path(owner_path);
    let context = AppVariableOwnerContext {
        owner_key: owner_directory.clone(),
        owner_directory,
        references,
    };
    let declaration = runtime.environment_declaration.clone();
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| AppError::General(error.to_string()))?;
    let resolved = run_locked(settings_state, move || {
        resolve_environment(&config_dir, &context, &declaration, &KeyringSecretStore)
    })
    .await?;
    if resolved.usage_changed {
        let _ = app.emit(APP_VARIABLES_CHANGED_EVENT, ());
    }
    runtime.environment = resolved.environment;
    Ok(resolved.missing)
}

#[tauri::command]
pub(crate) fn app_source_revoke(state: State<'_, AppSourceState>, capability_token: String) {
    state.revoke(&capability_token);
}

#[tauri::command]
pub(crate) fn app_open_owner_directory(
    app: AppHandle,
    project_path: String,
    space_id: Option<String>,
    owner_path: String,
) -> Result<(), AppError> {
    let owner = resolve_app_owner(Path::new(&project_path), space_id.as_deref(), &owner_path)?;
    app.shell()
        .open(system_path::user_facing_path(&owner.owner_path), None)
        .map_err(|error| AppError::General(error.to_string()))
}

#[tauri::command]
pub(crate) fn app_open_browser(app: AppHandle, url: String) -> Result<(), AppError> {
    let parsed = tauri::Url::parse(&url)
        .map_err(|_| AppError::PathNotAccessible("invalid App URL".to_string()))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(AppError::PathNotAccessible("invalid App URL".to_string()));
    }
    app.shell()
        .open(url, None)
        .map_err(|error| AppError::General(error.to_string()))
}

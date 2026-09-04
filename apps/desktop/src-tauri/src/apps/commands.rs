use std::fs;
use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_shell::ShellExt;

use super::AppSourceState;
use super::manifest::{
    AppManifestDiagnostic, AppRuntimeType, ValidatedRuntime, read_and_validate_manifest,
    resolve_app_owner,
};
use crate::AppError;
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
    },
    Unavailable {
        #[serde(rename = "ownerDirectory")]
        owner_directory: String,
        #[serde(rename = "runtimeType")]
        runtime_type: AppRuntimeType,
        reason: &'static str,
        #[serde(rename = "browserUrl", skip_serializing_if = "Option::is_none")]
        browser_url: Option<String>,
    },
}

#[tauri::command]
pub(crate) async fn app_manifest_inspect(
    state: State<'_, AppSourceState>,
    project_path: String,
    space_id: Option<String>,
    owner_path: String,
) -> Result<AppManifestInspection, AppError> {
    let owner = resolve_app_owner(Path::new(&project_path), space_id.as_deref(), &owner_path)?;
    let owner_directory = system_path::user_facing_path(&owner.owner_path);
    let Some(manifest) = read_and_validate_manifest(&owner.owner_path)? else {
        return Ok(AppManifestInspection::Missing { owner_directory });
    };
    let runtime = match manifest {
        Ok(runtime) => runtime,
        Err(diagnostics) => {
            return Ok(AppManifestInspection::Invalid {
                owner_directory,
                diagnostics,
            });
        }
    };

    match runtime {
        ValidatedRuntime::Url { url } => Ok(AppManifestInspection::Ready {
            owner_directory,
            runtime_type: AppRuntimeType::Url,
            viewport_url: url,
            capability_token: None,
        }),
        ValidatedRuntime::Process { url } => Ok(AppManifestInspection::Unavailable {
            owner_directory,
            runtime_type: AppRuntimeType::Process,
            reason: "process_runtime_pending",
            browser_url: Some(url),
        }),
        ValidatedRuntime::Static { public_root, entry } => {
            let declared_root = owner.owner_path.join(&public_root);
            let root_metadata = fs::symlink_metadata(&declared_root);
            if !matches!(root_metadata, Ok(ref metadata) if metadata.is_dir() && !metadata.file_type().is_symlink())
            {
                return Ok(AppManifestInspection::Unavailable {
                    owner_directory,
                    runtime_type: AppRuntimeType::Static,
                    reason: "static_public_root_unavailable",
                    browser_url: None,
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
            let (token, viewport_url) = state.issue(canonical_root, &entry).await?;
            Ok(AppManifestInspection::Ready {
                owner_directory,
                runtime_type: AppRuntimeType::Static,
                viewport_url,
                capability_token: Some(token),
            })
        }
    }
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

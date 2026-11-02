use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State, ipc::Response};

use super::html::{
    HtmlDocumentInput, HtmlTheme, device_wide_roots, observe_outside, resolve_html_document,
};
use super::source::{
    DocumentSourceDescriptor, DocumentSourceError, inspect_document_source, read_document_source,
    resolve_document_source_for_external, validate_document_source_generation,
};
use crate::apps::{AppSourceState, DOCUMENT_SOURCE_CHANGED_EVENT, DocumentProfile};
use crate::external_apps::{self, ExternalAppDto};
use svode_core::system_path;

#[tauri::command]
pub(crate) fn document_inspect_source(
    project_path: String,
    space_id: Option<String>,
    target_path: String,
) -> Result<DocumentSourceDescriptor, DocumentSourceError> {
    inspect_document_source(Path::new(&project_path), space_id.as_deref(), &target_path)
        .map(|resolved| resolved.descriptor)
}

#[tauri::command]
pub(crate) fn document_read_source(
    project_path: String,
    space_id: Option<String>,
    target_path: String,
    expected_generation: String,
) -> Result<Response, DocumentSourceError> {
    read_document_source(
        Path::new(&project_path),
        space_id.as_deref(),
        &target_path,
        &expected_generation,
    )
    .map(Response::new)
}

#[tauri::command]
pub(crate) fn document_validate_source(
    project_path: String,
    space_id: Option<String>,
    target_path: String,
    expected_generation: String,
) -> Result<(), DocumentSourceError> {
    validate_document_source_generation(
        Path::new(&project_path),
        space_id.as_deref(),
        &target_path,
        &expected_generation,
    )
}

#[tauri::command]
pub(crate) fn document_list_external_apps(
    project_path: String,
    space_id: Option<String>,
    target_path: String,
) -> Result<Vec<ExternalAppDto>, DocumentSourceError> {
    let resolved = resolve_document_source_for_external(
        Path::new(&project_path),
        space_id.as_deref(),
        &target_path,
    )?;
    Ok(external_apps::file_apps(&resolved.path))
}

/// Opens the Document in `app_id`, or in the OS default application when absent.
#[tauri::command]
pub(crate) fn document_open_external(
    app: AppHandle,
    project_path: String,
    space_id: Option<String>,
    target_path: String,
    app_id: Option<String>,
) -> Result<(), DocumentSourceError> {
    let resolved = resolve_document_source_for_external(
        Path::new(&project_path),
        space_id.as_deref(),
        &target_path,
    )?;
    external_apps::open_file(&app, &resolved.path, app_id.as_deref())
        .map_err(|_| DocumentSourceError::ExternalOpenFailed)
}

#[tauri::command]
pub(crate) fn document_reveal_external(
    project_path: String,
    space_id: Option<String>,
    target_path: String,
) -> Result<(), DocumentSourceError> {
    let resolved = resolve_document_source_for_external(
        Path::new(&project_path),
        space_id.as_deref(),
        &target_path,
    )?;
    external_apps::reveal_file(Path::new(&system_path::user_facing_path(&resolved.path)))
        .map_err(|_| DocumentSourceError::ExternalOpenFailed)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HtmlDocumentServing {
    pub capability_token: String,
    pub viewport_url: String,
    pub size_bytes: u64,
    /// RFC 3339 UTC modification time of the file.
    pub modified_at: String,
}

/// Serves an HTML Document on its own loopback origin until it is revoked.
#[tauri::command]
pub(crate) async fn html_document_serve(
    app: AppHandle,
    state: State<'_, AppSourceState>,
    source: HtmlDocumentInput,
    theme: HtmlTheme,
) -> Result<HtmlDocumentServing, DocumentSourceError> {
    let document = resolve_html_document(&source, &device_wide_roots(&app))?;
    let (capability_token, viewport_url) = state
        .issue_document(
            document.root.clone(),
            DocumentProfile::new(document.entry.clone(), document.single_file, theme),
        )
        .await
        .map_err(|_| DocumentSourceError::SourceInaccessible)?;
    if document.outside_project {
        let token = capability_token.clone();
        let emitter = app.clone();
        match observe_outside(
            document.root,
            document.entry,
            document.single_file,
            move || {
                let _ = emitter.emit(
                    DOCUMENT_SOURCE_CHANGED_EVENT,
                    serde_json::json!({ "capabilityToken": token }),
                );
            },
        ) {
            Ok(observer) => state.observe_document(&capability_token, observer),
            Err(error) => {
                tracing::warn!(%error, "an HTML Document outside the project is not observed")
            }
        }
    }
    Ok(HtmlDocumentServing {
        capability_token,
        viewport_url,
        size_bytes: document.size_bytes,
        modified_at: document.modified_at,
    })
}

/// The theme the next load of the Document entry gets.
#[tauri::command]
pub(crate) fn html_document_set_theme(
    state: State<'_, AppSourceState>,
    capability_token: String,
    theme: HtmlTheme,
) {
    state.set_document_theme(&capability_token, theme);
}

#[tauri::command]
pub(crate) fn html_document_revoke(state: State<'_, AppSourceState>, capability_token: String) {
    state.revoke(&capability_token);
}

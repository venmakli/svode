use std::path::Path;

use tauri::{AppHandle, ipc::Response};

use super::source::{
    DocumentSourceDescriptor, DocumentSourceError, inspect_document_source, read_document_source,
    resolve_document_source_for_external,
};
use crate::{
    external_apps::{self, ExternalAppDto},
    system_path,
};

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

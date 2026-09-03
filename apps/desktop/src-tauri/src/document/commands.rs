use std::path::Path;

use tauri::{AppHandle, ipc::Response};
use tauri_plugin_shell::ShellExt;

use super::source::{
    DocumentSourceDescriptor, DocumentSourceError, inspect_document_source, read_document_source,
    resolve_document_source_for_external,
};
use crate::system_path;

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
pub(crate) fn document_open_external(
    app: AppHandle,
    project_path: String,
    space_id: Option<String>,
    target_path: String,
) -> Result<(), DocumentSourceError> {
    let resolved = resolve_document_source_for_external(
        Path::new(&project_path),
        space_id.as_deref(),
        &target_path,
    )?;
    app.shell()
        .open(system_path::user_facing_path(&resolved.path), None)
        .map_err(|_| DocumentSourceError::ExternalOpenFailed)
}

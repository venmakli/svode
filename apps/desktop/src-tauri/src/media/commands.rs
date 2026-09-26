use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, State};

use super::MediaSourceState;
use super::source::{
    MediaSourceDescriptor, MediaSourceError, inspect_media_source,
    resolve_media_source_for_external, validate_media_source_generation,
};
use crate::{
    external_apps::{self, ExternalAppDto},
    system_path,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaSourceSessionDescriptor {
    #[serde(flatten)]
    source: MediaSourceDescriptor,
    capability_token: String,
}

#[tauri::command]
pub(crate) fn media_create_source(
    state: State<'_, MediaSourceState>,
    project_path: String,
    space_id: Option<String>,
    target_path: String,
) -> Result<MediaSourceSessionDescriptor, MediaSourceError> {
    let source = inspect_media_source(Path::new(&project_path), space_id.as_deref(), &target_path)?;
    let capability_token = state.issue(&source);
    Ok(MediaSourceSessionDescriptor {
        source: source.descriptor,
        capability_token,
    })
}

#[tauri::command]
pub(crate) fn media_validate_source(
    project_path: String,
    space_id: Option<String>,
    target_path: String,
    expected_generation: String,
) -> Result<(), MediaSourceError> {
    validate_media_source_generation(
        Path::new(&project_path),
        space_id.as_deref(),
        &target_path,
        &expected_generation,
    )
}

#[tauri::command]
pub(crate) fn media_revoke_source(state: State<'_, MediaSourceState>, capability_token: String) {
    state.revoke(&capability_token);
}

#[tauri::command]
pub(crate) fn media_list_external_apps(
    project_path: String,
    space_id: Option<String>,
    target_path: String,
) -> Result<Vec<ExternalAppDto>, MediaSourceError> {
    let path = resolve_media_source_for_external(
        Path::new(&project_path),
        space_id.as_deref(),
        &target_path,
    )?;
    Ok(external_apps::file_apps(&path))
}

/// Opens the Media in `app_id`, or in the OS default application when absent.
#[tauri::command]
pub(crate) fn media_open_external(
    app: AppHandle,
    project_path: String,
    space_id: Option<String>,
    target_path: String,
    app_id: Option<String>,
) -> Result<(), MediaSourceError> {
    let path = resolve_media_source_for_external(
        Path::new(&project_path),
        space_id.as_deref(),
        &target_path,
    )?;
    external_apps::open_file(&app, &path, app_id.as_deref())
        .map_err(|_| MediaSourceError::ExternalOpenFailed)
}

#[tauri::command]
pub(crate) fn media_reveal_external(
    project_path: String,
    space_id: Option<String>,
    target_path: String,
) -> Result<(), MediaSourceError> {
    let path = resolve_media_source_for_external(
        Path::new(&project_path),
        space_id.as_deref(),
        &target_path,
    )?;
    external_apps::reveal_file(Path::new(&system_path::user_facing_path(&path)))
        .map_err(|_| MediaSourceError::ExternalOpenFailed)
}

use super::app_marker::{AppMarkerProbe, probe_app_target};
use super::identity::SourceShape;
use crate::AppError;

#[tauri::command]
pub(crate) async fn artifact_probe_app_marker(
    space_path: String,
    target_path: String,
    source_shape: SourceShape,
) -> Result<AppMarkerProbe, AppError> {
    probe_app_target(&space_path, &target_path, source_shape)
}

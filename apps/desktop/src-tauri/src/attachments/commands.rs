use std::path::Path;

use crate::AppError;

use super::source::{AttachmentsSnapshot, list_registered_owner, resolve_registered_owner};

#[tauri::command]
pub(crate) async fn attachments_list(
    project_path: String,
    space_id: Option<String>,
) -> Result<AttachmentsSnapshot, AppError> {
    let owner = resolve_registered_owner(Path::new(&project_path), space_id.as_deref())?;
    list_registered_owner(owner).await
}

use std::path::Path;
use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::AppError;
use crate::git::access::{require_repository_mutation_paths, scope_authorized_mutation_paths};
use crate::git::autocommit::AutocommitService;
use crate::index::IndexState;

use super::managed_import::{
    ManagedImportResult, ManagedImportSourceInfo, MutationOrigin, execute_managed_import,
    inspect_import_source, plan_managed_import,
};
use super::source::{AttachmentsSnapshot, list_registered_owner, resolve_attachment_owner};

#[tauri::command]
pub(crate) async fn attachments_list(
    project_path: String,
    space_id: Option<String>,
    owner_path: Option<String>,
) -> Result<AttachmentsSnapshot, AppError> {
    let owner = resolve_attachment_owner(
        Path::new(&project_path),
        space_id.as_deref(),
        owner_path.as_deref(),
    )?;
    list_registered_owner(owner).await
}

#[tauri::command]
pub(crate) async fn attachments_inspect_import_source(
    source_path: String,
) -> Result<ManagedImportSourceInfo, AppError> {
    inspect_import_source(&source_path)
}

#[tauri::command]
pub(crate) async fn attachments_import_file(
    app: AppHandle,
    project_path: String,
    space_id: Option<String>,
    content_path: String,
    source_path: String,
    file_name: Option<String>,
    index_state: State<'_, IndexState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<ManagedImportResult, AppError> {
    let plan = plan_managed_import(
        &index_state,
        Path::new(&project_path),
        space_id.as_deref(),
        &content_path,
        Path::new(&source_path),
        file_name.as_deref(),
    )
    .await?;
    let authorized_paths = plan.affected_paths().to_vec();
    require_repository_mutation_paths(&app, authorized_paths.clone()).await?;
    scope_authorized_mutation_paths::<_, _, AppError>(authorized_paths, async {
        execute_managed_import(
            &app,
            &index_state,
            Some(&autocommit),
            MutationOrigin::Desktop,
            plan,
        )
        .await
    })
    .await
}

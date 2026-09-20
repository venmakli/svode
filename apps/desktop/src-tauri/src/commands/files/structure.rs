//! Tauri adapters for nesting and entry-shape conversions.

use super::*;
#[tauri::command]
pub async fn nest_entry(
    app: AppHandle,
    space: String,
    path: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    index_updates: State<'_, IndexUpdateState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<String, AppError> {
    let _new_path = nested_entry_path(&path)?;
    let authorized_paths = require_entry_backlink_mutation_plan(
        &app,
        &index_state,
        &space,
        project_path.as_deref(),
        &path,
        false,
    )
    .await?;
    scope_authorized_mutation_paths(authorized_paths, async {
        crate::structure::nest(
            &space,
            &path,
            project_path.as_deref(),
            &index_state,
            &index_updates,
            Some(&autocommit),
        )
        .await
    })
    .await
}

#[tauri::command]
pub async fn unnest_entry(
    app: AppHandle,
    space: String,
    path: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    index_updates: State<'_, IndexUpdateState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<String, AppError> {
    let _new_path = leaf_entry_path(&path)?;
    let authorized_paths = require_entry_backlink_mutation_plan(
        &app,
        &index_state,
        &space,
        project_path.as_deref(),
        &path,
        false,
    )
    .await?;
    scope_authorized_mutation_paths(authorized_paths, async {
        crate::structure::unnest(
            &space,
            &path,
            project_path.as_deref(),
            &index_state,
            &index_updates,
            Some(&autocommit),
        )
        .await
    })
    .await
}

#[tauri::command]
pub async fn convert_entry_to_folder(
    app: AppHandle,
    space: String,
    file_path: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    index_updates: State<'_, IndexUpdateState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<Entry, AppError> {
    let _new_path = nested_entry_path(&file_path)?;
    let authorized_paths = require_entry_backlink_mutation_plan(
        &app,
        &index_state,
        &space,
        project_path.as_deref(),
        &file_path,
        false,
    )
    .await?;
    scope_authorized_mutation_paths(authorized_paths, async {
        crate::structure::convert_to_folder(
            &space,
            &file_path,
            project_path.as_deref(),
            &index_state,
            &index_updates,
            Some(&autocommit),
        )
        .await
    })
    .await
}

#[tauri::command]
pub async fn convert_to_collection(
    app: AppHandle,
    space: String,
    path: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    index_updates: State<'_, IndexUpdateState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<ConvertToCollectionCommandResult, AppError> {
    let authorized_paths = require_convert_to_collection_mutation_plan(
        &app,
        &index_state,
        &space,
        project_path.as_deref(),
        &path,
    )
    .await?;
    scope_authorized_mutation_paths(authorized_paths, async {
        crate::structure::convert_to_collection(
            &space,
            &path,
            project_path.as_deref(),
            &index_state,
            &index_updates,
            Some(&autocommit),
        )
        .await
    })
    .await
}

#[tauri::command]
pub async fn convert_entry_to_leaf(
    app: AppHandle,
    space: String,
    file_path: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    index_updates: State<'_, IndexUpdateState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<Entry, AppError> {
    let _new_path = leaf_entry_path(&file_path)?;
    let authorized_paths = require_entry_backlink_mutation_plan(
        &app,
        &index_state,
        &space,
        project_path.as_deref(),
        &file_path,
        false,
    )
    .await?;
    scope_authorized_mutation_paths(authorized_paths, async {
        crate::structure::convert_to_leaf(
            &space,
            &file_path,
            project_path.as_deref(),
            &index_state,
            &index_updates,
            Some(&autocommit),
        )
        .await
    })
    .await
}

#[tauri::command]
pub async fn convert_entry_to_nested_collection(
    app: AppHandle,
    space: String,
    file_path: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    index_updates: State<'_, IndexUpdateState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<(), AppError> {
    let authorized_paths = require_convert_to_collection_mutation_plan(
        &app,
        &index_state,
        &space,
        project_path.as_deref(),
        &file_path,
    )
    .await?;
    scope_authorized_mutation_paths(authorized_paths, async {
        crate::structure::convert_to_collection(
            &space,
            &file_path,
            project_path.as_deref(),
            &index_state,
            &index_updates,
            Some(&autocommit),
        )
        .await
    })
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn convert_bare_folder_to_collection(
    app: AppHandle,
    space: String,
    folder_path: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    index_updates: State<'_, IndexUpdateState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<Entry, AppError> {
    let authorized_paths = require_convert_to_collection_mutation_plan(
        &app,
        &index_state,
        &space,
        project_path.as_deref(),
        &folder_path,
    )
    .await?;
    Ok(scope_authorized_mutation_paths(authorized_paths, async {
        crate::structure::convert_to_collection(
            &space,
            &folder_path,
            project_path.as_deref(),
            &index_state,
            &index_updates,
            Some(&autocommit),
        )
        .await
    })
    .await?
    .entry)
}

#[tauri::command]
pub async fn duplicate_entry(
    app: AppHandle,
    space: String,
    file_path: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    index_updates: State<'_, IndexUpdateState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<Entry, AppError> {
    require_repository_mutation(&app, Path::new(&space)).await?;
    crate::structure::duplicate(
        &space,
        &file_path,
        project_path.as_deref(),
        &index_state,
        &index_updates,
        Some(&autocommit),
    )
    .await
}

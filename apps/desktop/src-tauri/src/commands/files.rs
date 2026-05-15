use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::error::AppError;
use crate::files::{
    BacklinkIndex, BacklinkInfo, Entry, FileWatcher, LinkValidation, ModifiedLinkSource, TreeNode,
    WriteNonceRegistry, WriteResult, entry, tree,
};
use crate::git::autocommit::{AutocommitService, StructuralOp};
use crate::git::commands::{GitState, require_cli};
use crate::index::{self, IndexKey, IndexState, ResolvedDocLink};
use crate::properties::{
    self, CollectionInfo, CollectionSchema, Column, EntrySchemaResponse, Filter, Person,
    PropertyOption, PropertyType, Sort, View,
};
use crate::space::config;

fn basename(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_string()
}

fn entry_history_name(path: &str) -> String {
    let normalized = path.trim_matches('/').replace('\\', "/");
    let path = Path::new(&normalized);
    if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("README.md"))
    {
        return path
            .parent()
            .and_then(|parent| parent.file_name())
            .and_then(|name| name.to_str())
            .unwrap_or("README.md")
            .to_string();
    }
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&normalized)
        .to_string()
}

fn maybe_autocommit_structural(
    autocommit: &AutocommitService,
    project_path: Option<&str>,
    space_path: &str,
    op: StructuralOp,
) {
    let Some(proj) = project_path.filter(|p| !p.is_empty()) else {
        return;
    };
    autocommit.schedule_structural(PathBuf::from(proj), PathBuf::from(space_path), op);
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkFixSuggestion {
    pub path: String,
    pub label: String,
    pub reason: String,
}

async fn space_id_for_dir(state: &IndexState, space: &str) -> Option<String> {
    state
        .key_for_space_dir(Path::new(space))
        .await
        .and_then(|key| IndexState::space_id_for_key(&key))
}

async fn schedule_modified_source_spaces(
    state: &IndexState,
    autocommit: &AutocommitService,
    project_path: Option<&str>,
    modified: &[ModifiedLinkSource],
    op: StructuralOp,
) {
    let Some(proj) = project_path.filter(|p| !p.is_empty()) else {
        return;
    };
    let project = Path::new(proj);
    let mut seen = std::collections::HashSet::new();
    for item in modified {
        if !seen.insert(item.space_id.clone()) {
            continue;
        }
        match state.space_path_of(project, item.space_id.as_deref()).await {
            Ok(space_path) => {
                autocommit.schedule_structural(project.to_path_buf(), space_path, op.clone())
            }
            Err(e) => tracing::warn!("schedule modified backlink source failed: {e}"),
        }
    }
}

async fn ensure_backlinks_before_structural(state: &IndexState, project_path: Option<&str>) {
    let Some(proj) = project_path.filter(|p| !p.is_empty()) else {
        return;
    };
    if let Err(e) = state.ensure_project_backlinks_built(Path::new(proj)).await {
        tracing::warn!("pre-structural backlink rebuild failed: {e}");
    }
}

/// Resolve the runtime backlink index that owns `space`. Falls back to a
/// `Root`-keyed index treating `space` as its own project — covers calls
/// that arrive before the project's `open_project` cache populates (e.g.
/// rapid-create flows in tests).
async fn backlinks_for_space(state: &IndexState, space: &str) -> Arc<BacklinkIndex> {
    let key = state
        .key_for_space_dir(Path::new(space))
        .await
        .unwrap_or_else(|| IndexKey::Root(PathBuf::from(space)));
    state.backlinks_for(&key).await
}

#[tauri::command]
pub fn list_entries(space: String) -> Result<Vec<TreeNode>, AppError> {
    tree::build_tree(&space)
}

#[tauri::command]
pub fn create_entry(
    space: String,
    parent_path: Option<String>,
    title: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<Entry, AppError> {
    let created = entry::create(&space, parent_path.as_deref(), &title)?;
    maybe_autocommit_structural(
        &autocommit,
        project_path.as_deref(),
        &space,
        StructuralOp::Create(basename(&created.path)),
    );
    Ok(created)
}

#[tauri::command]
pub fn create_folder(
    space: String,
    parent_path: Option<String>,
    name: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<String, AppError> {
    let folder_path = entry::create_folder(&space, parent_path.as_deref(), &name)?;
    maybe_autocommit_structural(
        &autocommit,
        project_path.as_deref(),
        &space,
        StructuralOp::Create(basename(&folder_path)),
    );
    Ok(folder_path)
}

#[tauri::command]
pub fn read_entry(space: String, path: String) -> Result<Entry, AppError> {
    entry::read(&space, &path)
}

#[tauri::command]
pub fn get_entry_schema(
    space: String,
    file_path: String,
) -> Result<Option<EntrySchemaResponse>, AppError> {
    properties::schema_response(&space, &file_path)
}

#[tauri::command]
pub async fn update_entry_field(
    space: String,
    file_path: String,
    field: String,
    value: serde_json::Value,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
) -> Result<Entry, AppError> {
    let updated = entry::update_field(&space, &file_path, &field, value)?;

    if let Some(proj) = project_path.as_deref().filter(|p| !p.is_empty()) {
        let project = Path::new(proj);
        let abs_target = Path::new(&space).join(&file_path);
        if let Err(e) = index::update::update_entry(&index_state, project, &abs_target).await {
            tracing::warn!("index update_entry failed for {file_path}: {e}");
        }
    }

    Ok(updated)
}

fn json_to_yaml_value(value: serde_json::Value) -> Result<serde_yml::Value, AppError> {
    serde_yml::to_value(value)
        .map_err(|e| AppError::General(format!("could not convert JSON to YAML value: {e}")))
}

async fn maybe_autocommit_schema(
    autocommit: &AutocommitService,
    project_path: Option<&str>,
    space: &str,
    paths: Vec<PathBuf>,
    message: String,
) {
    let Some(project_path) = project_path.filter(|path| !path.is_empty()) else {
        return;
    };
    if let Err(e) = autocommit
        .commit_paths_now(
            PathBuf::from(project_path),
            PathBuf::from(space),
            paths,
            message,
        )
        .await
    {
        tracing::warn!("schema autocommit failed: {e}");
    }
}

async fn pool_for_space(
    index_state: &IndexState,
    space: &str,
    project_path: Option<&str>,
) -> Result<sqlx::SqlitePool, AppError> {
    let key = if let Some(key) = index_state.key_for_space_dir(Path::new(space)).await {
        key
    } else if let Some(project_path) = project_path.filter(|path| !path.is_empty()) {
        index_state
            .resolve(Path::new(project_path), Path::new(space))
            .await?
            .0
    } else {
        IndexKey::Root(PathBuf::from(space))
    };
    index_state.get_or_create(&key).await
}

async fn reindex_space_dir(index_state: &IndexState, space: &str) {
    let key = index_state
        .key_for_space_dir(Path::new(space))
        .await
        .unwrap_or_else(|| IndexKey::Root(PathBuf::from(space)));
    if let Err(e) = index_state.run_full_reindex(&key).await {
        tracing::warn!("collection operation reindex failed for {:?}: {e}", key);
    }
}

#[tauri::command]
pub async fn add_schema_column(
    space: String,
    collection_path: String,
    column: Column,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let message = format!("Add column \"{}\"", column.name);
    let paths = properties::schema_mutation_paths(&space, &collection_path, false)?;
    let schema = properties::add_schema_column(&space, &collection_path, column)?;
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    Ok(schema)
}

#[tauri::command]
pub async fn change_schema_type(
    space: String,
    collection_path: String,
    column_name: String,
    new_type: PropertyType,
    conversion_strategy: Option<serde_json::Value>,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let message = format!("Change column \"{column_name}\" type to {new_type:?}");
    let paths = properties::schema_mutation_paths(&space, &collection_path, true)?;
    let conversion_strategy = conversion_strategy.map(json_to_yaml_value).transpose()?;
    let schema = properties::change_schema_type(
        &space,
        &collection_path,
        &column_name,
        new_type,
        conversion_strategy,
    )?;
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    Ok(schema)
}

#[tauri::command]
pub async fn rename_schema_column(
    space: String,
    collection_path: String,
    old_name: String,
    new_name: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let paths = properties::schema_mutation_paths(&space, &collection_path, true)?;
    let schema = properties::rename_schema_column(&space, &collection_path, &old_name, &new_name)?;
    maybe_autocommit_schema(
        &autocommit,
        project_path.as_deref(),
        &space,
        paths,
        format!("Rename column \"{old_name}\" to \"{new_name}\""),
    )
    .await;
    Ok(schema)
}

#[tauri::command]
pub async fn delete_schema_column(
    space: String,
    collection_path: String,
    column_name: String,
    delete_values: Option<bool>,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let delete_values = delete_values.unwrap_or(false);
    let paths = properties::schema_mutation_paths(&space, &collection_path, delete_values)?;
    let schema =
        properties::delete_schema_column(&space, &collection_path, &column_name, delete_values)?;
    let suffix = if delete_values { " and values" } else { "" };
    maybe_autocommit_schema(
        &autocommit,
        project_path.as_deref(),
        &space,
        paths,
        format!("Delete column \"{column_name}\"{suffix}"),
    )
    .await;
    Ok(schema)
}

#[tauri::command]
pub async fn add_option(
    space: String,
    collection_path: String,
    column_name: String,
    option: PropertyOption,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let message = format!("Add option \"{}\" to \"{column_name}\"", option.name);
    let paths = properties::schema_mutation_paths(&space, &collection_path, false)?;
    let schema = properties::add_option(&space, &collection_path, &column_name, option)?;
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    Ok(schema)
}

#[tauri::command]
pub async fn rename_option(
    space: String,
    collection_path: String,
    column_name: String,
    old_option_name: String,
    new_option_name: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let paths = properties::schema_mutation_paths(&space, &collection_path, true)?;
    let schema = properties::rename_option(
        &space,
        &collection_path,
        &column_name,
        &old_option_name,
        &new_option_name,
    )?;
    maybe_autocommit_schema(
        &autocommit,
        project_path.as_deref(),
        &space,
        paths,
        format!("Rename option \"{column_name}\": \"{old_option_name}\" to \"{new_option_name}\""),
    )
    .await;
    Ok(schema)
}

#[tauri::command]
pub async fn delete_option(
    space: String,
    collection_path: String,
    column_name: String,
    option_name: String,
    delete_values: Option<bool>,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let delete_values = delete_values.unwrap_or(false);
    let paths = properties::schema_mutation_paths(&space, &collection_path, delete_values)?;
    let schema = properties::delete_option(
        &space,
        &collection_path,
        &column_name,
        &option_name,
        delete_values,
    )?;
    let suffix = if delete_values { " and values" } else { "" };
    maybe_autocommit_schema(
        &autocommit,
        project_path.as_deref(),
        &space,
        paths,
        format!("Delete option \"{column_name}\": \"{option_name}\"{suffix}"),
    )
    .await;
    Ok(schema)
}

#[tauri::command]
pub async fn update_option(
    space: String,
    collection_path: String,
    column_name: String,
    option_name: String,
    option: Option<PropertyOption>,
    patch: Option<serde_json::Value>,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let paths = properties::schema_mutation_paths(&space, &collection_path, false)?;
    let patch = patch.map(json_to_yaml_value).transpose()?;
    let schema = properties::update_option(
        &space,
        &collection_path,
        &column_name,
        &option_name,
        option,
        patch,
    )?;
    maybe_autocommit_schema(
        &autocommit,
        project_path.as_deref(),
        &space,
        paths,
        format!("Update option \"{column_name}\": \"{option_name}\""),
    )
    .await;
    Ok(schema)
}

#[tauri::command]
pub async fn promote_orphan(
    space: String,
    collection_path: String,
    entry_id: String,
    field: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let paths = properties::schema_mutation_paths(&space, &collection_path, false)?;
    let schema = properties::promote_orphan(&space, &collection_path, &entry_id, &field)?;
    maybe_autocommit_schema(
        &autocommit,
        project_path.as_deref(),
        &space,
        paths,
        format!("Add column \"{field}\""),
    )
    .await;
    Ok(schema)
}

#[tauri::command]
pub async fn update_system_field_label(
    space: String,
    collection_path: String,
    field: String,
    label: Option<String>,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let paths = properties::schema_mutation_paths(&space, &collection_path, false)?;
    let schema = properties::update_system_field_label(&space, &collection_path, &field, label)?;
    maybe_autocommit_schema(
        &autocommit,
        project_path.as_deref(),
        &space,
        paths,
        format!("Update system field \"{field}\""),
    )
    .await;
    Ok(schema)
}

#[tauri::command]
pub async fn update_document_label(
    space: String,
    collection_path: String,
    label: Option<String>,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let paths = properties::schema_mutation_paths(&space, &collection_path, false)?;
    let schema = properties::update_document_label(&space, &collection_path, label)?;
    maybe_autocommit_schema(
        &autocommit,
        project_path.as_deref(),
        &space,
        paths,
        "Update document tab label".to_string(),
    )
    .await;
    Ok(schema)
}

#[tauri::command]
pub fn get_collection_schema(
    space: String,
    collection_path: String,
) -> Result<CollectionSchema, AppError> {
    properties::read_collection_schema(&space, &collection_path)
}

#[tauri::command]
pub async fn add_view(
    space: String,
    collection_path: String,
    view: View,
    position: Option<usize>,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let message = format!("Add view \"{}\"", view.name());
    let paths = properties::schema_mutation_paths(&space, &collection_path, false)?;
    let schema = properties::add_view(&space, &collection_path, view, position)?;
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    Ok(schema)
}

#[tauri::command]
pub async fn rename_view(
    space: String,
    collection_path: String,
    old_name: String,
    new_name: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let paths = properties::schema_mutation_paths(&space, &collection_path, false)?;
    let schema = properties::rename_view(&space, &collection_path, &old_name, &new_name)?;
    maybe_autocommit_schema(
        &autocommit,
        project_path.as_deref(),
        &space,
        paths,
        format!("Rename view \"{old_name}\" \u{2192} \"{new_name}\""),
    )
    .await;
    Ok(schema)
}

#[tauri::command]
pub async fn update_view(
    space: String,
    collection_path: String,
    view_name: String,
    patch: serde_json::Value,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let paths = properties::schema_mutation_paths(&space, &collection_path, false)?;
    let patch = json_to_yaml_value(patch)?;
    let schema = properties::update_view(&space, &collection_path, &view_name, patch)?;
    maybe_autocommit_schema(
        &autocommit,
        project_path.as_deref(),
        &space,
        paths,
        format!("Update view \"{view_name}\""),
    )
    .await;
    Ok(schema)
}

#[tauri::command]
pub async fn delete_view(
    space: String,
    collection_path: String,
    view_name: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let paths = properties::schema_mutation_paths(&space, &collection_path, false)?;
    let schema = properties::delete_view(&space, &collection_path, &view_name)?;
    maybe_autocommit_schema(
        &autocommit,
        project_path.as_deref(),
        &space,
        paths,
        format!("Delete view \"{view_name}\""),
    )
    .await;
    Ok(schema)
}

#[tauri::command]
pub async fn duplicate_view(
    space: String,
    collection_path: String,
    view_name: String,
    new_name: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let paths = properties::schema_mutation_paths(&space, &collection_path, false)?;
    let schema = properties::duplicate_view(&space, &collection_path, &view_name, &new_name)?;
    maybe_autocommit_schema(
        &autocommit,
        project_path.as_deref(),
        &space,
        paths,
        format!("Duplicate view \"{view_name}\" \u{2192} \"{new_name}\""),
    )
    .await;
    Ok(schema)
}

#[tauri::command]
pub async fn reorder_views(
    space: String,
    collection_path: String,
    new_order: Vec<String>,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let paths = properties::schema_mutation_paths(&space, &collection_path, false)?;
    let schema = properties::reorder_views(&space, &collection_path, new_order)?;
    maybe_autocommit_schema(
        &autocommit,
        project_path.as_deref(),
        &space,
        paths,
        "Reorder views".to_string(),
    )
    .await;
    Ok(schema)
}

#[tauri::command]
pub async fn list_entries_for_view(
    space: String,
    collection_path: String,
    view_name: String,
    include_nested: Option<bool>,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
) -> Result<Vec<Entry>, AppError> {
    let pool = pool_for_space(&index_state, &space, project_path.as_deref()).await?;
    properties::list_entries_for_view(
        &pool,
        &space,
        &collection_path,
        &view_name,
        include_nested.unwrap_or(false),
    )
    .await
}

#[tauri::command]
pub async fn query_entries(
    space: String,
    collection_path: String,
    filters: Option<Vec<Filter>>,
    sort: Option<Vec<Sort>>,
    limit: Option<i64>,
    offset: Option<i64>,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
) -> Result<Vec<Entry>, AppError> {
    let pool = pool_for_space(&index_state, &space, project_path.as_deref()).await?;
    properties::query_entries(
        &pool,
        &space,
        &collection_path,
        filters,
        sort,
        limit,
        offset,
    )
    .await
}

#[tauri::command]
pub fn list_collections(space: String) -> Result<Vec<CollectionInfo>, AppError> {
    properties::list_collections(&space)
}

#[tauri::command]
pub async fn list_persons(
    space_path: String,
    all_time: Option<bool>,
    git_state: State<'_, GitState>,
    person_cache: State<'_, properties::PersonCacheState>,
) -> Result<Vec<Person>, AppError> {
    let cli = require_cli(&git_state)?;
    properties::list_persons(
        &person_cache,
        &cli,
        Path::new(&space_path),
        all_time.unwrap_or(false),
    )
    .await
}

#[tauri::command]
pub async fn refresh_persons(
    space_path: String,
    git_state: State<'_, GitState>,
    person_cache: State<'_, properties::PersonCacheState>,
) -> Result<Vec<Person>, AppError> {
    let cli = require_cli(&git_state)?;
    properties::refresh_persons(&person_cache, &cli, Path::new(&space_path), false).await
}

#[tauri::command]
pub async fn write_entry(
    space: String,
    path: String,
    content: String,
    title: Option<String>,
    icon: Option<String>,
    extra: Option<HashMap<String, serde_yml::Value>>,
    existing_id: Option<String>,
    skip_rename: Option<bool>,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    nonces: State<'_, Arc<WriteNonceRegistry>>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<WriteResult, AppError> {
    let skip_rename = skip_rename.unwrap_or(false);
    let backlink_index = backlinks_for_space(&index_state, &space).await;
    let project = project_path.as_deref().filter(|p| !p.is_empty());
    let project_aware = project.is_some();
    if project_aware && !skip_rename {
        ensure_backlinks_before_structural(&index_state, project).await;
    }
    let mut result = entry::write(
        &space,
        &path,
        &content,
        title.as_deref(),
        icon.as_deref(),
        extra,
        existing_id.as_deref(),
        if project_aware {
            None
        } else {
            Some(&backlink_index)
        },
        skip_rename,
    )?;

    // Register the write-nonce against the canonical post-rename path so the
    // watcher can echo-guard the `file:changed` event that our own write
    // produces. Fall back to the join if canonicalize fails (e.g. path was
    // deleted between the write and here).
    let result_rel = result.new_path.as_deref().unwrap_or(&path);
    let joined = Path::new(&space).join(result_rel);
    let canonical = std::fs::canonicalize(&joined).unwrap_or(joined);
    nonces.register(canonical, result.write_nonce.clone());

    // Update SQLite index for the (possibly renamed) target path. Resolves
    // through IndexState to the owning pool (root or per-space DB).
    // On rename: delete the stale row first, then upsert the new path. The
    // reverse order would let a concurrent write to the new path get clobbered
    // by the stale-row delete.
    if let Some(proj) = project_path.as_deref().filter(|p| !p.is_empty()) {
        let project = Path::new(proj);
        let target_space_id = space_id_for_dir(&index_state, &space).await;
        if !skip_rename {
            if let Some(ref new_path) = result.new_path {
                match index_state
                    .update_links_on_rename_project(
                        project,
                        target_space_id.as_deref(),
                        &path,
                        new_path,
                        title.as_deref(),
                    )
                    .await
                {
                    Ok(modified) => {
                        result.modified_files = modified.iter().map(|m| m.path.clone()).collect();
                        result.modified_sources = modified.clone();
                        schedule_modified_source_spaces(
                            &index_state,
                            &autocommit,
                            project_path.as_deref(),
                            &modified,
                            StructuralOp::Rename {
                                old: basename(&path),
                                new: basename(new_path),
                            },
                        )
                        .await;
                    }
                    Err(e) => tracing::warn!("cross-space backlink rewrite failed: {e}"),
                }

                let is_readme = Path::new(&path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.eq_ignore_ascii_case("readme.md"));
                if is_readme {
                    let old_folder = Path::new(&path)
                        .parent()
                        .map(|p| p.to_string_lossy().to_string());
                    let new_folder = Path::new(new_path)
                        .parent()
                        .map(|p| p.to_string_lossy().to_string());
                    if let (Some(of), Some(nf)) = (old_folder, new_folder) {
                        if !of.is_empty() && of != nf {
                            match index_state
                                .update_links_on_folder_rename_project(
                                    project,
                                    target_space_id.as_deref(),
                                    &of,
                                    &nf,
                                )
                                .await
                            {
                                Ok(extra) => {
                                    schedule_modified_source_spaces(
                                        &index_state,
                                        &autocommit,
                                        project_path.as_deref(),
                                        &extra,
                                        StructuralOp::Rename {
                                            old: basename(&of),
                                            new: basename(&nf),
                                        },
                                    )
                                    .await;
                                    for item in extra {
                                        if !result.modified_sources.contains(&item) {
                                            result.modified_files.push(item.path.clone());
                                            result.modified_sources.push(item);
                                        }
                                    }
                                }
                                Err(e) => tracing::warn!(
                                    "cross-space folder backlink rewrite failed: {e}"
                                ),
                            }
                        }
                    }
                }
            }
        }

        if result.new_path.is_some() {
            if let Err(e) = index_state
                .remove_file_backlinks(project, target_space_id.as_deref(), &path)
                .await
            {
                tracing::warn!("remove stale backlinks source failed for {path}: {e}");
            }
        }
        let current = result.new_path.as_deref().unwrap_or(&path);
        if let Err(e) = index_state
            .update_file_backlinks(project, target_space_id.as_deref(), current)
            .await
        {
            tracing::warn!("update file backlinks failed for {current}: {e}");
        }

        if result.new_path.is_some() {
            let abs_old = Path::new(&space).join(&path);
            if let Err(e) = index::update::delete_entry(&index_state, project, &abs_old).await {
                tracing::warn!("index delete stale path failed for {path}: {e}");
            }
        }
        let target = result.new_path.clone().unwrap_or_else(|| path.clone());
        let abs_target = Path::new(&space).join(&target);
        if let Err(e) = index::update::update_entry(&index_state, project, &abs_target).await {
            tracing::warn!("index update_entry failed for {target}: {e}");
        }
    }

    // On ⌘S-path rename, schedule the structural commit so `git_commit_file`'s
    // flush can drain it before the user-commit (Rename before Update).
    if !skip_rename {
        if let Some(ref new_path) = result.new_path {
            maybe_autocommit_structural(
                &autocommit,
                project_path.as_deref(),
                &space,
                StructuralOp::Rename {
                    old: basename(&path),
                    new: basename(new_path),
                },
            );
        }
    }

    Ok(result)
}

#[tauri::command]
pub async fn delete_entry(
    space: String,
    path: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<(), AppError> {
    let backlink_index = backlinks_for_space(&index_state, &space).await;
    entry::delete(&space, &path, Some(&backlink_index))?;

    if let Some(proj) = project_path.as_deref().filter(|p| !p.is_empty()) {
        let project = Path::new(proj);
        let source_space_id = space_id_for_dir(&index_state, &space).await;
        if let Err(e) = index_state
            .remove_file_backlinks(project, source_space_id.as_deref(), &path)
            .await
        {
            tracing::warn!("remove backlinks for deleted entry failed: {e}");
        }
        let abs_old = Path::new(&space).join(&path);
        if let Err(e) = index::update::delete_entry(&index_state, project, &abs_old).await {
            tracing::warn!("index delete_entry failed for {path}: {e}");
        }
    }
    maybe_autocommit_structural(
        &autocommit,
        project_path.as_deref(),
        &space,
        StructuralOp::Delete(basename(&path)),
    );
    Ok(())
}

#[tauri::command]
pub async fn rename_entry(
    space: String,
    from: String,
    to: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<Vec<String>, AppError> {
    let backlink_index = backlinks_for_space(&index_state, &space).await;
    let was_dir = Path::new(&space).join(&from).is_dir();
    ensure_backlinks_before_structural(&index_state, project_path.as_deref()).await;
    entry::rename(&space, &from, &to)?;
    let modified = if let Some(proj) = project_path.as_deref().filter(|p| !p.is_empty()) {
        let project = Path::new(proj);
        let target_space_id = space_id_for_dir(&index_state, &space).await;
        let cross = if was_dir {
            index_state
                .update_links_on_folder_rename_project(
                    project,
                    target_space_id.as_deref(),
                    &from,
                    &to,
                )
                .await
        } else {
            index_state
                .update_links_on_rename_project(
                    project,
                    target_space_id.as_deref(),
                    &from,
                    &to,
                    None,
                )
                .await
        }
        .unwrap_or_else(|e| {
            tracing::warn!("cross-space rename backlink rewrite failed: {e}");
            Vec::new()
        });
        schedule_modified_source_spaces(
            &index_state,
            &autocommit,
            project_path.as_deref(),
            &cross,
            StructuralOp::Rename {
                old: basename(&from),
                new: basename(&to),
            },
        )
        .await;
        let key = index_state
            .key_for_project_space_id(project, target_space_id.as_deref())
            .await?;
        if was_dir {
            if let Err(e) = index_state.rebuild_source_backlinks(&key).await {
                tracing::warn!("rebuild backlinks after folder rename failed: {e}");
            }
        } else {
            let _ = index_state
                .remove_file_backlinks(project, target_space_id.as_deref(), &from)
                .await;
            let _ = index_state
                .update_file_backlinks(project, target_space_id.as_deref(), &to)
                .await;
        }
        cross.iter().map(|m| m.path.clone()).collect()
    } else {
        let modified = backlink_index
            .update_links_on_rename(Path::new(&space), &from, &to, None)
            .unwrap_or_default();
        let _ = backlink_index.update_file(Path::new(&space), &to);
        modified
    };
    maybe_autocommit_structural(
        &autocommit,
        project_path.as_deref(),
        &space,
        StructuralOp::Rename {
            old: basename(&from),
            new: basename(&to),
        },
    );
    Ok(modified)
}

#[tauri::command]
pub async fn move_entry(
    space: String,
    from: String,
    to_parent: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<String, AppError> {
    let backlink_index = backlinks_for_space(&index_state, &space).await;
    let was_dir = Path::new(&space).join(&from).is_dir();
    ensure_backlinks_before_structural(&index_state, project_path.as_deref()).await;
    let new_path = entry::move_entry(
        Path::new(&space),
        &from,
        &to_parent,
        if project_path.as_deref().filter(|p| !p.is_empty()).is_some() {
            None
        } else {
            Some(&backlink_index)
        },
    )?;
    if let Some(proj) = project_path.as_deref().filter(|p| !p.is_empty()) {
        let project = Path::new(proj);
        let target_space_id = space_id_for_dir(&index_state, &space).await;
        let cross = if was_dir {
            index_state
                .update_links_on_folder_rename_project(
                    project,
                    target_space_id.as_deref(),
                    &from,
                    &new_path,
                )
                .await
        } else {
            index_state
                .update_links_on_rename_project(
                    project,
                    target_space_id.as_deref(),
                    &from,
                    &new_path,
                    None,
                )
                .await
        }
        .unwrap_or_else(|e| {
            tracing::warn!("cross-space move backlink rewrite failed: {e}");
            Vec::new()
        });
        schedule_modified_source_spaces(
            &index_state,
            &autocommit,
            project_path.as_deref(),
            &cross,
            StructuralOp::Move(basename(&new_path)),
        )
        .await;
        let key = index_state
            .key_for_project_space_id(project, target_space_id.as_deref())
            .await?;
        if was_dir {
            let _ = index_state.rebuild_source_backlinks(&key).await;
        } else {
            let _ = index_state
                .remove_file_backlinks(project, target_space_id.as_deref(), &from)
                .await;
            let _ = index_state
                .update_file_backlinks(project, target_space_id.as_deref(), &new_path)
                .await;
        }
    }
    maybe_autocommit_structural(
        &autocommit,
        project_path.as_deref(),
        &space,
        StructuralOp::Move(basename(&new_path)),
    );
    Ok(new_path)
}

#[tauri::command]
pub async fn get_backlinks(
    space: String,
    target_path: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
) -> Result<Vec<BacklinkInfo>, AppError> {
    let backlink_index = backlinks_for_space(&index_state, &space).await;
    if let Some(proj) = project_path.as_deref().filter(|p| !p.is_empty()) {
        index_state
            .ensure_project_backlinks_built(Path::new(proj))
            .await?;
    } else if !backlink_index.is_built() {
        backlink_index.build(Path::new(&space))?;
    }
    Ok(backlink_index.get_backlinks(&target_path))
}

#[tauri::command]
pub async fn rebuild_backlinks(
    space: String,
    index_state: State<'_, IndexState>,
) -> Result<(), AppError> {
    let backlink_index = backlinks_for_space(&index_state, &space).await;
    backlink_index.build(Path::new(&space))
}

#[tauri::command]
pub async fn validate_links(
    space: String,
    path: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
) -> Result<Vec<LinkValidation>, AppError> {
    if let Some(proj) = project_path.as_deref().filter(|p| !p.is_empty()) {
        let source_space_id = space_id_for_dir(&index_state, &space).await;
        let abs = Path::new(&space).join(&path);
        if !abs.exists() {
            return Ok(Vec::new());
        }
        let content = std::fs::read_to_string(abs)?;
        let links = crate::files::backlinks::parse_markdown_links(&content);
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for (url, _) in links {
            if !seen.insert(url.clone()) {
                continue;
            }
            let resolved = index_state
                .resolve_doc_link(Path::new(proj), source_space_id.as_deref(), &path, &url)
                .await?;
            out.push(LinkValidation {
                url,
                exists: resolved.exists,
            });
        }
        Ok(out)
    } else {
        crate::files::backlinks::validate_links(Path::new(&space), &path)
    }
}

#[tauri::command]
pub fn watch_space(
    space: String,
    app: AppHandle,
    watcher: State<'_, FileWatcher>,
) -> Result<(), AppError> {
    watcher.watch(space, app)
}

#[tauri::command]
pub fn unwatch_space(space: String, watcher: State<'_, FileWatcher>) -> Result<(), AppError> {
    watcher.unwatch(&space)
}

#[tauri::command]
pub async fn nest_entry(
    space: String,
    path: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<String, AppError> {
    let backlink_index = backlinks_for_space(&index_state, &space).await;
    ensure_backlinks_before_structural(&index_state, project_path.as_deref()).await;
    let new_path = entry::nest_entry(
        Path::new(&space),
        &path,
        if project_path.as_deref().filter(|p| !p.is_empty()).is_some() {
            None
        } else {
            Some(&backlink_index)
        },
    )?;
    if let Some(proj) = project_path.as_deref().filter(|p| !p.is_empty()) {
        let project = Path::new(proj);
        let target_space_id = space_id_for_dir(&index_state, &space).await;
        let cross = index_state
            .update_links_on_rename_project(
                project,
                target_space_id.as_deref(),
                &path,
                &new_path,
                None,
            )
            .await
            .unwrap_or_else(|e| {
                tracing::warn!("cross-space nest backlink rewrite failed: {e}");
                Vec::new()
            });
        schedule_modified_source_spaces(
            &index_state,
            &autocommit,
            project_path.as_deref(),
            &cross,
            StructuralOp::Move(basename(&new_path)),
        )
        .await;
        let _ = index_state
            .remove_file_backlinks(project, target_space_id.as_deref(), &path)
            .await;
        let _ = index_state
            .update_file_backlinks(project, target_space_id.as_deref(), &new_path)
            .await;
    }
    maybe_autocommit_structural(
        &autocommit,
        project_path.as_deref(),
        &space,
        StructuralOp::Move(basename(&new_path)),
    );
    Ok(new_path)
}

#[tauri::command]
pub async fn unnest_entry(
    space: String,
    path: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<String, AppError> {
    let backlink_index = backlinks_for_space(&index_state, &space).await;
    ensure_backlinks_before_structural(&index_state, project_path.as_deref()).await;
    let new_path = entry::unnest_entry(
        Path::new(&space),
        &path,
        if project_path.as_deref().filter(|p| !p.is_empty()).is_some() {
            None
        } else {
            Some(&backlink_index)
        },
    )?;
    if let Some(proj) = project_path.as_deref().filter(|p| !p.is_empty()) {
        let project = Path::new(proj);
        let target_space_id = space_id_for_dir(&index_state, &space).await;
        let cross = index_state
            .update_links_on_rename_project(
                project,
                target_space_id.as_deref(),
                &path,
                &new_path,
                None,
            )
            .await
            .unwrap_or_else(|e| {
                tracing::warn!("cross-space unnest backlink rewrite failed: {e}");
                Vec::new()
            });
        schedule_modified_source_spaces(
            &index_state,
            &autocommit,
            project_path.as_deref(),
            &cross,
            StructuralOp::Move(basename(&new_path)),
        )
        .await;
        let _ = index_state
            .remove_file_backlinks(project, target_space_id.as_deref(), &path)
            .await;
        let _ = index_state
            .update_file_backlinks(project, target_space_id.as_deref(), &new_path)
            .await;
    }
    maybe_autocommit_structural(
        &autocommit,
        project_path.as_deref(),
        &space,
        StructuralOp::Move(basename(&new_path)),
    );
    Ok(new_path)
}

#[tauri::command]
pub async fn convert_entry_to_folder(
    space: String,
    entry_id: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<Entry, AppError> {
    let backlink_index = backlinks_for_space(&index_state, &space).await;
    ensure_backlinks_before_structural(&index_state, project_path.as_deref()).await;
    let entry =
        entry::convert_entry_to_folder(Path::new(&space), &entry_id, Some(&backlink_index))?;
    reindex_space_dir(&index_state, &space).await;
    maybe_autocommit_structural(
        &autocommit,
        project_path.as_deref(),
        &space,
        StructuralOp::ConvertToFolder(entry_history_name(&entry.path)),
    );
    Ok(entry)
}

#[tauri::command]
pub async fn convert_entry_to_leaf(
    space: String,
    entry_id: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<Entry, AppError> {
    let backlink_index = backlinks_for_space(&index_state, &space).await;
    ensure_backlinks_before_structural(&index_state, project_path.as_deref()).await;
    let entry = entry::convert_entry_to_leaf(Path::new(&space), &entry_id, Some(&backlink_index))?;
    reindex_space_dir(&index_state, &space).await;
    maybe_autocommit_structural(
        &autocommit,
        project_path.as_deref(),
        &space,
        StructuralOp::ConvertToLeaf(entry_history_name(&entry.path)),
    );
    Ok(entry)
}

#[tauri::command]
pub async fn convert_entry_to_nested_collection(
    space: String,
    entry_id: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<(), AppError> {
    let collection_path = entry::convert_entry_to_nested_collection(Path::new(&space), &entry_id)?;
    reindex_space_dir(&index_state, &space).await;
    maybe_autocommit_structural(
        &autocommit,
        project_path.as_deref(),
        &space,
        StructuralOp::MakeCollection(entry_history_name(&collection_path)),
    );
    Ok(())
}

#[tauri::command]
pub async fn convert_bare_folder_to_collection(
    space: String,
    folder_path: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<Entry, AppError> {
    let entry = entry::convert_bare_folder_to_collection(Path::new(&space), &folder_path)?;
    reindex_space_dir(&index_state, &space).await;
    maybe_autocommit_structural(
        &autocommit,
        project_path.as_deref(),
        &space,
        StructuralOp::MakeCollection(entry_history_name(&folder_path)),
    );
    Ok(entry)
}

#[tauri::command]
pub async fn duplicate_entry(
    space: String,
    file_path: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<Entry, AppError> {
    let old_name = entry_history_name(&file_path);
    let entry = entry::duplicate_entry(Path::new(&space), &file_path)?;
    reindex_space_dir(&index_state, &space).await;
    maybe_autocommit_structural(
        &autocommit,
        project_path.as_deref(),
        &space,
        StructuralOp::Duplicate {
            old: old_name,
            new: entry_history_name(&entry.path),
        },
    );
    Ok(entry)
}

#[tauri::command]
pub fn read_tree_order(space: String) -> Result<HashMap<String, Vec<String>>, AppError> {
    Ok(tree::read_order(Path::new(&space)))
}

#[tauri::command]
pub fn save_tree_order(
    space: String,
    order: HashMap<String, Vec<String>>,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<(), AppError> {
    tree::write_order(Path::new(&space), &order)?;
    maybe_autocommit_structural(
        &autocommit,
        project_path.as_deref(),
        &space,
        StructuralOp::Reorder,
    );
    Ok(())
}

#[tauri::command]
pub fn get_expanded_paths(space: String) -> Result<Vec<String>, AppError> {
    let local = config::read_local_config(Path::new(&space))?;
    Ok(local.expanded_paths)
}

#[tauri::command]
pub fn save_expanded_paths(space: String, paths: Vec<String>) -> Result<(), AppError> {
    let mut local = config::read_local_config(Path::new(&space))?;
    local.expanded_paths = paths;
    config::write_local_config(Path::new(&space), &local)
}

#[tauri::command]
pub async fn resolve_doc_link(
    project_path: String,
    source_space_id: Option<String>,
    source_path: String,
    url: String,
    index_state: State<'_, IndexState>,
) -> Result<ResolvedDocLink, AppError> {
    index_state
        .resolve_doc_link(
            Path::new(&project_path),
            source_space_id.as_deref(),
            &source_path,
            &url,
        )
        .await
}

#[tauri::command]
pub fn make_relative_link(
    source_doc_path: String,
    target_doc_path: String,
) -> Result<String, AppError> {
    Ok(crate::files::backlinks::make_relative_link_between(
        Path::new(&source_doc_path),
        Path::new(&target_doc_path),
    ))
}

#[tauri::command]
pub async fn suggest_link_fix(
    project_path: String,
    target_space_id: Option<String>,
    broken_path: String,
    index_state: State<'_, IndexState>,
) -> Result<Vec<LinkFixSuggestion>, AppError> {
    let project = Path::new(&project_path);
    let target_dir = index_state
        .space_path_of(project, target_space_id.as_deref())
        .await?;

    let mut suggestions = Vec::new();
    if let Some((path, reason)) = git_rename_suggestion(&target_dir, &broken_path) {
        suggestions.push(LinkFixSuggestion {
            label: label_for_path(&path),
            path,
            reason,
        });
    }

    for path in similar_path_suggestions(&target_dir, &broken_path)? {
        if suggestions.iter().any(|s| s.path == path) {
            continue;
        }
        suggestions.push(LinkFixSuggestion {
            label: label_for_path(&path),
            path,
            reason: "similar name".to_string(),
        });
        if suggestions.len() >= 3 {
            break;
        }
    }

    Ok(suggestions)
}

fn git_rename_suggestion(space_dir: &Path, broken_path: &str) -> Option<(String, String)> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(space_dir)
        .args([
            "log",
            "--diff-filter=R",
            "--name-status",
            "--pretty=format:%ct",
            "--all",
            "--",
            "*.md",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut current_ts: Option<i64> = None;
    for line in stdout.lines() {
        if let Ok(ts) = line.trim().parse::<i64>() {
            current_ts = Some(ts);
            continue;
        }
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() >= 3 && cols[0].starts_with('R') && cols[1] == broken_path {
            let days = current_ts
                .and_then(|ts| chrono::DateTime::from_timestamp(ts, 0))
                .map(|dt| (chrono::Utc::now() - dt).num_days().max(0))
                .unwrap_or(0);
            return Some((cols[2].to_string(), format!("renamed {days} days ago")));
        }
    }
    None
}

fn similar_path_suggestions(space_dir: &Path, broken_path: &str) -> Result<Vec<String>, AppError> {
    let broken_stem = Path::new(broken_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mut candidates = Vec::new();
    for file in crate::files::backlinks::collect_md_files(space_dir, &[])? {
        let rel = file
            .strip_prefix(space_dir)
            .unwrap_or(&file)
            .to_string_lossy()
            .replace('\\', "/");
        let stem = Path::new(&rel)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        let mut score = levenshtein(&broken_stem, &stem) as i64;
        if stem.starts_with(&broken_stem) || broken_stem.starts_with(&stem) {
            score -= 3;
        }
        if stem.ends_with(&broken_stem) || broken_stem.ends_with(&stem) {
            score -= 2;
        }
        candidates.push((score, rel));
    }
    candidates.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    Ok(candidates.into_iter().take(3).map(|(_, rel)| rel).collect())
}

fn label_for_path(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(path)
        .replace(['-', '_'], " ")
}

fn levenshtein(a: &str, b: &str) -> usize {
    if a.is_empty() {
        return b.chars().count();
    }
    if b.is_empty() {
        return a.chars().count();
    }
    let b_chars: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b_chars.len()).collect();
    let mut curr = vec![0; b_chars.len() + 1];
    for (i, ca) in a.chars().enumerate() {
        curr[0] = i + 1;
        for (j, cb) in b_chars.iter().enumerate() {
            let cost = usize::from(ca != *cb);
            curr[j + 1] = (curr[j] + 1).min(prev[j + 1] + 1).min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[b_chars.len()]
}

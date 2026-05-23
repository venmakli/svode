use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::error::AppError;
use crate::files::{
    BacklinkIndex, BacklinkInfo, Entry, FileWatcher, LinkValidation, ModifiedLinkSource, TreeNode,
    WriteNonceRegistry, WriteResult, entry, templates, tree,
};
use crate::files::{TemplateInfo, TemplateKind};
use crate::git::autocommit::{AutocommitService, StructuralOp};
use crate::git::commands::{GitState, require_cli};
use crate::index::{self, IndexKey, IndexState, ResolvedDocLink};
use crate::properties::{
    self, CollectionInfo, CollectionSchema, Column, EntrySchemaResponse, Filter, Person,
    PropertyOption, PropertyType, RelationBacklink, RelationTwoWayDiagnostics, ResolvedRelation,
    SchemaMutationWarning, Sort, View,
};
use crate::repo_path::{RootMode, normalize_repo_relative};
use crate::space::config;

fn basename(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_string()
}

fn abs_entry_path(space: &str, rel_path: &str) -> PathBuf {
    Path::new(space).join(rel_path)
}

fn order_path(space: &str) -> PathBuf {
    Path::new(space).join(".combai").join("order.json")
}

fn root_path_for_head(path: &str) -> &str {
    if path
        .rsplit_once('/')
        .is_some_and(|(_, name)| name.eq_ignore_ascii_case("README.md"))
    {
        return path
            .rsplit_once('/')
            .map(|(parent, _)| parent)
            .unwrap_or(path);
    }
    path
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSchemaTypeResult {
    pub schema: CollectionSchema,
    pub warnings: Vec<SchemaMutationWarning>,
}

fn entry_paths_with_order(space: &str, paths: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    let mut out = vec![order_path(space)];
    out.extend(paths);
    out
}

fn schema_path(space: &str, collection_path: &str) -> PathBuf {
    if collection_path.is_empty() || collection_path == "." {
        return Path::new(space).join("schema.yaml");
    }
    Path::new(space).join(collection_path).join("schema.yaml")
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

fn property_type_message(type_: PropertyType) -> &'static str {
    match type_ {
        PropertyType::Text => "text",
        PropertyType::Number => "number",
        PropertyType::UniqueId => "unique_id",
        PropertyType::Select => "select",
        PropertyType::MultiSelect => "multi_select",
        PropertyType::Status => "status",
        PropertyType::Date => "date",
        PropertyType::Relation => "relation",
        PropertyType::Actor => "actor",
        PropertyType::Person => "person",
        PropertyType::Checkbox => "checkbox",
        PropertyType::Url => "url",
        PropertyType::Email => "email",
        PropertyType::Phone => "phone",
    }
}

fn schema_commit_message(
    schema: &CollectionSchema,
    default: impl Into<String>,
    sensitive: &'static str,
) -> String {
    schema_commit_message_with_previous(schema, false, default, sensitive)
}

fn schema_commit_message_with_previous(
    schema: &CollectionSchema,
    was_sensitive: bool,
    default: impl Into<String>,
    sensitive: &'static str,
) -> String {
    if was_sensitive || properties::schema_has_sensitive_columns(schema) {
        sensitive.to_string()
    } else {
        default.into()
    }
}

fn collection_has_sensitive_columns(space: &str, collection_path: &str) -> bool {
    properties::read_collection_schema(space, collection_path)
        .map(|schema| properties::schema_has_sensitive_columns(&schema))
        .unwrap_or(false)
}

fn entry_in_sensitive_collection(space: &str, path: &str) -> bool {
    properties::resolve_collection_schema_result(space, path)
        .ok()
        .flatten()
        .is_some_and(|(schema, _)| properties::schema_has_sensitive_columns(&schema))
}

fn entry_commit_name(space: &str, path: &str) -> String {
    if entry_in_sensitive_collection(space, path) {
        "collection entry".to_string()
    } else {
        basename(path)
    }
}

fn entry_history_commit_name(space: &str, path: &str) -> String {
    if entry_in_sensitive_collection(space, path) {
        "collection entry".to_string()
    } else {
        entry_history_name(path)
    }
}

fn entry_rename_op(space: &str, from: &str, to: &str) -> StructuralOp {
    if entry_in_sensitive_collection(space, from) || entry_in_sensitive_collection(space, to) {
        StructuralOp::Rename {
            old: "collection entry".to_string(),
            new: "collection entry".to_string(),
        }
    } else {
        StructuralOp::Rename {
            old: basename(from),
            new: basename(to),
        }
    }
}

fn template_name_for_commit(space: &str, collection_path: &str, name: String) -> String {
    if collection_has_sensitive_columns(space, collection_path) {
        "collection template".to_string()
    } else {
        name
    }
}

fn maybe_autocommit_structural_paths(
    autocommit: &AutocommitService,
    project_path: Option<&str>,
    space_path: &str,
    op: StructuralOp,
    paths: Vec<PathBuf>,
) {
    let Some(proj) = project_path.filter(|p| !p.is_empty()) else {
        return;
    };
    autocommit.schedule_structural_paths(PathBuf::from(proj), PathBuf::from(space_path), op, paths);
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
    let mut by_space: HashMap<PathBuf, Vec<PathBuf>> = HashMap::new();
    for item in modified {
        match state.space_path_of(project, item.space_id.as_deref()).await {
            Ok(space_path) => {
                by_space
                    .entry(space_path.clone())
                    .or_default()
                    .push(space_path.join(&item.path));
            }
            Err(e) => tracing::warn!("schedule modified backlink source failed: {e}"),
        }
    }
    for (space_path, paths) in by_space {
        autocommit.schedule_structural_paths(project.to_path_buf(), space_path, op.clone(), paths);
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
pub fn get_entry_detail_state(
    space: String,
    path: String,
) -> Result<entry::EntryDetailState, AppError> {
    entry::entry_detail_state(Path::new(&space), &path)
}

#[tauri::command]
pub async fn create_entry(
    space: String,
    parent_path: Option<String>,
    title: String,
    contextual_defaults: Option<HashMap<String, serde_json::Value>>,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<Entry, AppError> {
    let contextual_defaults = contextual_defaults
        .map(|defaults| {
            defaults
                .into_iter()
                .map(|(field, value)| Ok((field, json_to_yaml_value(value)?)))
                .collect::<Result<HashMap<_, _>, AppError>>()
        })
        .transpose()?;
    let created = if let Some(contextual_defaults) = contextual_defaults {
        entry::create_with_contextual_defaults(
            &space,
            parent_path.as_deref(),
            &title,
            Some(contextual_defaults),
        )?
    } else {
        entry::create(&space, parent_path.as_deref(), &title)?
    };
    if let Some(proj) = project_path.as_deref().filter(|p| !p.is_empty()) {
        let project = Path::new(proj);
        let abs_target = Path::new(&space).join(&created.path);
        if let Err(e) = index::update::update_entry(&index_state, project, &abs_target).await {
            tracing::warn!("index update_entry failed for {}: {e}", created.path);
        }
    } else {
        reindex_space_dir(&index_state, &space).await;
    }
    if properties::unique_id_schema_path_for_entry(&space, &created.path)?.is_some() {
        let mut paths = properties::unique_id_mutation_paths_for_entry(&space, &created.path)?;
        paths.push(order_path(&space));
        let message = if entry_in_sensitive_collection(&space, &created.path) {
            "Create collection entry with unique_id".to_string()
        } else {
            format!("Create {} with unique_id", basename(&created.path))
        };
        maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    } else {
        maybe_autocommit_structural_paths(
            &autocommit,
            project_path.as_deref(),
            &space,
            StructuralOp::Create(entry_commit_name(&space, &created.path)),
            entry_paths_with_order(&space, [abs_entry_path(&space, &created.path)]),
        );
    }
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
    maybe_autocommit_structural_paths(
        &autocommit,
        project_path.as_deref(),
        &space,
        StructuralOp::Create(entry_commit_name(&space, &folder_path)),
        entry_paths_with_order(&space, [abs_entry_path(&space, &folder_path)]),
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
        reindex_space_dir(&index_state, &space).await;
    } else {
        reindex_space_dir(&index_state, &space).await;
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

fn snapshot_paths(paths: &[PathBuf]) -> Result<Vec<(PathBuf, Option<Vec<u8>>)>, AppError> {
    let mut seen = std::collections::HashSet::new();
    let mut snapshots = Vec::new();
    for path in paths {
        if !seen.insert(path.clone()) {
            continue;
        }
        let content = if path.exists() {
            Some(std::fs::read(path)?)
        } else {
            None
        };
        snapshots.push((path.clone(), content));
    }
    Ok(snapshots)
}

fn changed_paths(snapshot: Vec<(PathBuf, Option<Vec<u8>>)>) -> Result<Vec<PathBuf>, AppError> {
    let mut changed = Vec::new();
    for (path, before) in snapshot {
        let after = if path.exists() {
            Some(std::fs::read(&path)?)
        } else {
            None
        };
        if before != after {
            changed.push(path);
        }
    }
    Ok(changed)
}

fn append_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.iter().any(|existing| existing == &path) {
        paths.push(path);
    }
}

fn append_unsnapshotted_paths(
    paths: &mut Vec<PathBuf>,
    snapshotted: &[PathBuf],
    candidates: Vec<PathBuf>,
) {
    for path in candidates {
        if !snapshotted.iter().any(|existing| existing == &path) {
            append_unique_path(paths, path);
        }
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
    let materializes_unique_id = column.type_ == PropertyType::UniqueId;
    let default_message = if materializes_unique_id {
        format!("Add and materialize unique_id \"{}\"", column.name)
    } else {
        format!("Add column \"{}\"", column.name)
    };
    let paths = properties::schema_column_mutation_paths(
        &space,
        &collection_path,
        &column,
        materializes_unique_id,
    )?;
    let snapshot = snapshot_paths(&paths)?;
    let schema = properties::add_schema_column(&space, &collection_path, column)?;
    let paths = changed_paths(snapshot)?;
    let message = schema_commit_message(&schema, default_message, "Update collection field");
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
) -> Result<ChangeSchemaTypeResult, AppError> {
    let was_sensitive = collection_has_sensitive_columns(&space, &collection_path);
    let default_message = format!(
        "Change column \"{column_name}\" type to {}",
        property_type_message(new_type)
    );
    let mut paths = properties::schema_column_name_mutation_paths(
        &space,
        &collection_path,
        &column_name,
        true,
    )?;
    let snapshotted = paths.clone();
    let snapshot = snapshot_paths(&snapshotted)?;
    let conversion_strategy = conversion_strategy.map(json_to_yaml_value).transpose()?;
    let (schema, warnings) = properties::change_schema_type_with_warnings(
        &space,
        &collection_path,
        &column_name,
        new_type,
        conversion_strategy,
    )?;
    if let Some(column) = schema
        .columns
        .iter()
        .find(|column| column.name == column_name)
    {
        append_unsnapshotted_paths(
            &mut paths,
            &snapshotted,
            properties::schema_column_mutation_paths(&space, &collection_path, column, true)?,
        );
    }
    let mut changed = changed_paths(snapshot)?;
    append_unsnapshotted_paths(&mut changed, &snapshotted, paths);
    maybe_autocommit_schema(
        &autocommit,
        project_path.as_deref(),
        &space,
        changed,
        schema_commit_message_with_previous(
            &schema,
            was_sensitive,
            default_message,
            "Update collection field",
        ),
    )
    .await;
    Ok(ChangeSchemaTypeResult { schema, warnings })
}

#[tauri::command]
pub async fn assign_unique_id(
    space: String,
    file_path: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<Entry, AppError> {
    let paths = properties::unique_id_mutation_paths_for_entry(&space, &file_path)?;
    let entry = properties::assign_unique_id(&space, &file_path)?;
    if let Some(proj) = project_path.as_deref().filter(|p| !p.is_empty()) {
        let project = Path::new(proj);
        let abs_target = Path::new(&space).join(&entry.path);
        if let Err(e) = index::update::update_entry(&index_state, project, &abs_target).await {
            tracing::warn!("index update_entry failed for {}: {e}", entry.path);
        }
    } else {
        reindex_space_dir(&index_state, &space).await;
    }
    maybe_autocommit_schema(
        &autocommit,
        project_path.as_deref(),
        &space,
        paths,
        if entry_in_sensitive_collection(&space, &entry.path) {
            "Repair unique_id for collection entry".to_string()
        } else {
            format!("Repair unique_id for {}", entry_history_name(&entry.path))
        },
    )
    .await;
    Ok(entry)
}

#[tauri::command]
pub async fn normalize_unique_id_counter(
    space: String,
    collection_path: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let paths = properties::schema_mutation_paths(&space, &collection_path, false)?;
    let schema = properties::normalize_unique_id_counter(&space, &collection_path)?;
    maybe_autocommit_schema(
        &autocommit,
        project_path.as_deref(),
        &space,
        paths,
        "Normalize unique_id counter".to_string(),
    )
    .await;
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
    let was_sensitive = collection_has_sensitive_columns(&space, &collection_path);
    let paths =
        properties::schema_column_name_mutation_paths(&space, &collection_path, &old_name, true)?;
    let snapshot = snapshot_paths(&paths)?;
    let schema = properties::rename_schema_column(&space, &collection_path, &old_name, &new_name)?;
    let paths = changed_paths(snapshot)?;
    let message = schema_commit_message_with_previous(
        &schema,
        was_sensitive,
        format!("Rename column \"{old_name}\" → \"{new_name}\""),
        "Rename sensitive field",
    );
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    Ok(schema)
}

#[tauri::command]
pub async fn update_schema_column(
    space: String,
    collection_path: String,
    column_name: String,
    patch: serde_json::Value,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    let was_sensitive = collection_has_sensitive_columns(&space, &collection_path);
    let mut paths = properties::schema_column_name_mutation_paths(
        &space,
        &collection_path,
        &column_name,
        false,
    )?;
    let snapshotted = paths.clone();
    let snapshot = snapshot_paths(&snapshotted)?;
    let patch = json_to_yaml_value(patch)?;
    let schema = properties::update_schema_column(&space, &collection_path, &column_name, patch)?;
    if let Some(column) = schema
        .columns
        .iter()
        .find(|column| column.name == column_name)
    {
        append_unsnapshotted_paths(
            &mut paths,
            &snapshotted,
            properties::schema_column_mutation_paths(
                &space,
                &collection_path,
                column,
                column.type_ == PropertyType::Relation,
            )?,
        );
    }
    let mut changed = changed_paths(snapshot)?;
    append_unsnapshotted_paths(&mut changed, &snapshotted, paths);
    let message = schema_commit_message_with_previous(
        &schema,
        was_sensitive,
        format!("Update column \"{column_name}\""),
        "Update collection field",
    );
    maybe_autocommit_schema(
        &autocommit,
        project_path.as_deref(),
        &space,
        changed,
        message,
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
    let was_sensitive = collection_has_sensitive_columns(&space, &collection_path);
    let delete_values = delete_values.unwrap_or(false);
    let paths = properties::schema_mutation_paths(&space, &collection_path, delete_values)?;
    let snapshot = snapshot_paths(&paths)?;
    let schema =
        properties::delete_schema_column(&space, &collection_path, &column_name, delete_values)?;
    let paths = changed_paths(snapshot)?;
    let suffix = if delete_values { " and values" } else { "" };
    let message = schema_commit_message_with_previous(
        &schema,
        was_sensitive,
        format!("Delete column \"{column_name}\"{suffix}"),
        "Update collection field",
    );
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
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
    let default_message = format!("Add option \"{}\" to \"{column_name}\"", option.name);
    let paths = properties::schema_mutation_paths(&space, &collection_path, false)?;
    let schema = properties::add_option(&space, &collection_path, &column_name, option)?;
    let message = schema_commit_message(&schema, default_message, "Update collection field");
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
    let snapshot = snapshot_paths(&paths)?;
    let schema = properties::rename_option(
        &space,
        &collection_path,
        &column_name,
        &old_option_name,
        &new_option_name,
    )?;
    let paths = changed_paths(snapshot)?;
    let message = schema_commit_message(
        &schema,
        format!("Rename option \"{column_name}\": \"{old_option_name}\" → \"{new_option_name}\""),
        "Update collection field",
    );
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
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
    let snapshot = snapshot_paths(&paths)?;
    let schema = properties::delete_option(
        &space,
        &collection_path,
        &column_name,
        &option_name,
        delete_values,
    )?;
    let paths = changed_paths(snapshot)?;
    let suffix = if delete_values { " and values" } else { "" };
    let message = schema_commit_message(
        &schema,
        format!("Delete option \"{column_name}\": \"{option_name}\"{suffix}"),
        "Update collection field",
    );
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
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
    let message = schema_commit_message(
        &schema,
        format!("Update option \"{column_name}\": \"{option_name}\""),
        "Update collection field",
    );
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
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
    let message = schema_commit_message(
        &schema,
        format!("Add column \"{field}\""),
        "Update collection field",
    );
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    Ok(schema)
}

#[tauri::command]
pub async fn clear_field_values(
    space: String,
    collection_path: String,
    field: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<(), AppError> {
    let paths = properties::clear_field_values(&space, &collection_path, &field)?;
    let message = if collection_has_sensitive_columns(&space, &collection_path) {
        "Update collection field".to_string()
    } else {
        format!("Clear field \"{field}\" values")
    };
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    Ok(())
}

#[tauri::command]
pub async fn clear_option_values(
    space: String,
    collection_path: String,
    column_name: String,
    option_name: Option<String>,
    option_names: Option<Vec<String>>,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<(), AppError> {
    let mut names = option_names.unwrap_or_default();
    if let Some(option_name) = option_name {
        names.push(option_name);
    }
    names.sort();
    names.dedup();
    let paths = properties::clear_option_values(&space, &collection_path, &column_name, &names)?;
    let message = if collection_has_sensitive_columns(&space, &collection_path) {
        "Update collection field".to_string()
    } else if names.len() == 1 {
        format!("Clear option \"{column_name}\": \"{}\" values", names[0])
    } else {
        format!("Clear option \"{column_name}\" values")
    };
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    Ok(())
}

#[tauri::command]
pub async fn replace_option_values(
    space: String,
    collection_path: String,
    column_name: String,
    old_option_name: String,
    new_option_name: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<(), AppError> {
    let paths = properties::replace_option_values(
        &space,
        &collection_path,
        &column_name,
        &old_option_name,
        &new_option_name,
    )?;
    let message = if collection_has_sensitive_columns(&space, &collection_path) {
        "Update collection field".to_string()
    } else {
        format!("Replace option \"{column_name}\": \"{old_option_name}\" → \"{new_option_name}\"")
    };
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    Ok(())
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
    let message = schema_commit_message(
        &schema,
        format!("Update system field \"{field}\""),
        "Update collection schema",
    );
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
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
    let message = schema_commit_message(
        &schema,
        "Update document tab label",
        "Update collection schema",
    );
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
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
pub fn list_templates(
    space: String,
    collection_path: String,
) -> Result<Vec<TemplateInfo>, AppError> {
    templates::list(&space, &collection_path)
}

#[tauri::command]
pub async fn create_template(
    space: String,
    collection_path: String,
    title: String,
    kind: TemplateKind,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<String, AppError> {
    let path = templates::create(&space, &collection_path, &title, kind)?;
    let root = root_path_for_head(&path);
    maybe_autocommit_structural_paths(
        &autocommit,
        project_path.as_deref(),
        &space,
        StructuralOp::CreateTemplate(template_name_for_commit(&space, &collection_path, title)),
        vec![abs_entry_path(&space, root)],
    );
    Ok(path)
}

#[tauri::command]
pub async fn delete_template(
    space: String,
    collection_path: String,
    template_slug: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<(), AppError> {
    let deleted = templates::delete(&space, &collection_path, &template_slug)?;
    maybe_autocommit_structural_paths(
        &autocommit,
        project_path.as_deref(),
        &space,
        StructuralOp::DeleteTemplate(template_name_for_commit(
            &space,
            &collection_path,
            deleted.title,
        )),
        vec![abs_entry_path(&space, &deleted.root_path)],
    );
    Ok(())
}

#[tauri::command]
pub async fn duplicate_template(
    space: String,
    collection_path: String,
    template_slug: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<String, AppError> {
    let duplicated = templates::duplicate(&space, &collection_path, &template_slug)?;
    let root = root_path_for_head(&duplicated.head_path);
    maybe_autocommit_structural_paths(
        &autocommit,
        project_path.as_deref(),
        &space,
        StructuralOp::DuplicateTemplate {
            old: template_name_for_commit(&space, &collection_path, duplicated.old_title),
            new: template_name_for_commit(&space, &collection_path, duplicated.new_title),
        },
        vec![abs_entry_path(&space, root)],
    );
    Ok(duplicated.head_path)
}

#[tauri::command]
pub async fn instantiate_template(
    space: String,
    collection_path: String,
    template_slug: String,
    parent_dir: String,
    initial_title: Option<String>,
    force_folder: bool,
    contextual_defaults: Option<HashMap<String, serde_json::Value>>,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<Entry, AppError> {
    let contextual_defaults = contextual_defaults
        .map(|defaults| {
            defaults
                .into_iter()
                .map(|(field, value)| Ok((field, json_to_yaml_value(value)?)))
                .collect::<Result<HashMap<_, _>, AppError>>()
        })
        .transpose()?;
    let instantiated = templates::instantiate(
        &space,
        &collection_path,
        &template_slug,
        &parent_dir,
        initial_title,
        force_folder,
        contextual_defaults,
    )?;
    reindex_space_dir(&index_state, &space).await;
    let root = root_path_for_head(&instantiated.entry.path);
    maybe_autocommit_structural_paths(
        &autocommit,
        project_path.as_deref(),
        &space,
        StructuralOp::InstantiateTemplate {
            title: template_name_for_commit(&space, &collection_path, instantiated.template_title),
            parent: if collection_has_sensitive_columns(&space, &collection_path) {
                "collection".to_string()
            } else {
                parent_dir
            },
        },
        entry_paths_with_order(&space, [abs_entry_path(&space, root)]),
    );
    Ok(instantiated.entry)
}

#[tauri::command]
pub async fn set_default_template(
    space: String,
    collection_path: String,
    template_slug: Option<String>,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    if let Some(template_slug) = template_slug.as_deref() {
        templates::ensure_template_exists(&space, &collection_path, template_slug)?;
    }
    let paths = properties::schema_mutation_paths(&space, &collection_path, false)?;
    let schema =
        properties::set_default_template(&space, &collection_path, template_slug.as_deref())?;
    let message = schema_commit_message(
        &schema,
        "Update collection templates",
        "Update collection templates",
    );
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    Ok(schema)
}

#[tauri::command]
pub async fn reorder_templates(
    space: String,
    collection_path: String,
    new_order: Vec<String>,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<CollectionSchema, AppError> {
    templates::validate_template_order(&space, &collection_path, &new_order)?;
    let paths = properties::schema_mutation_paths(&space, &collection_path, false)?;
    let schema = properties::reorder_templates(&space, &collection_path, new_order)?;
    let message = schema_commit_message(
        &schema,
        "Update collection templates",
        "Update collection templates",
    );
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    Ok(schema)
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
    let default_message = format!("Add view \"{}\"", view.name());
    let paths = properties::schema_mutation_paths(&space, &collection_path, false)?;
    let schema = properties::add_view(&space, &collection_path, view, position)?;
    let message = schema_commit_message(&schema, default_message, "Update collection view");
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
    let message = schema_commit_message(
        &schema,
        format!("Rename view \"{old_name}\" \u{2192} \"{new_name}\""),
        "Update collection view",
    );
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
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
    let message = schema_commit_message(
        &schema,
        format!("Update view \"{view_name}\""),
        "Update collection view",
    );
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
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
    let message = schema_commit_message(
        &schema,
        format!("Delete view \"{view_name}\""),
        "Update collection view",
    );
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
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
    let message = schema_commit_message(
        &schema,
        format!("Duplicate view \"{view_name}\" \u{2192} \"{new_name}\""),
        "Update collection view",
    );
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
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
    let message = schema_commit_message(&schema, "Reorder views", "Update collection view");
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
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
    git_state: State<'_, GitState>,
) -> Result<Vec<Entry>, AppError> {
    let pool = pool_for_space(&index_state, &space, project_path.as_deref()).await?;
    let git_cli = git_state.cli.clone();
    properties::list_entries_for_view(
        &pool,
        git_cli.as_ref(),
        &space,
        &collection_path,
        &view_name,
        include_nested,
    )
    .await
}

#[tauri::command]
pub async fn query_entries(
    space: String,
    collection_path: String,
    filters: Option<Vec<Filter>>,
    sort: Option<Vec<Sort>>,
    include_nested: Option<bool>,
    limit: Option<i64>,
    offset: Option<i64>,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    git_state: State<'_, GitState>,
) -> Result<Vec<Entry>, AppError> {
    let pool = pool_for_space(&index_state, &space, project_path.as_deref()).await?;
    let git_cli = git_state.cli.clone();
    properties::query_entries(
        &pool,
        git_cli.as_ref(),
        &space,
        &collection_path,
        filters,
        sort,
        include_nested,
        limit,
        offset,
    )
    .await
}

#[tauri::command]
pub async fn resolve_relation(
    space: String,
    relation: String,
    value: String,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
) -> Result<Option<ResolvedRelation>, AppError> {
    let pool = pool_for_space(&index_state, &space, project_path.as_deref()).await?;
    properties::resolve_relation(&pool, &relation, &value).await
}

#[tauri::command]
pub async fn resolve_relations_batch(
    space: String,
    relation: String,
    values: Vec<String>,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
) -> Result<Vec<Option<ResolvedRelation>>, AppError> {
    let pool = pool_for_space(&index_state, &space, project_path.as_deref()).await?;
    properties::resolve_relations_batch(&pool, &relation, &values).await
}

#[tauri::command]
pub fn query_relation_backlinks(
    space: String,
    target_path: String,
    source_collection_path: Option<String>,
    source_column: Option<String>,
) -> Result<Vec<RelationBacklink>, AppError> {
    properties::query_relation_backlinks(
        &space,
        &target_path,
        source_collection_path.as_deref(),
        source_column.as_deref(),
    )
}

#[tauri::command]
pub fn diagnose_two_way_relation(
    space: String,
    collection_path: String,
    column: String,
) -> Result<RelationTwoWayDiagnostics, AppError> {
    properties::diagnose_two_way_relation(&space, &collection_path, &column)
}

#[tauri::command]
pub async fn repair_two_way_relation(
    space: String,
    collection_path: String,
    column: String,
    strategy: String,
    reverse_column: Option<String>,
    project_path: Option<String>,
    index_state: State<'_, IndexState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<(), AppError> {
    let paths = properties::relation_repair_mutation_paths(&space, &collection_path, &column)?;
    let snapshot = snapshot_paths(&paths)?;
    properties::repair_two_way_relation(
        &space,
        &collection_path,
        &column,
        &strategy,
        reverse_column.as_deref(),
    )?;
    reindex_space_dir(&index_state, &space).await;
    let paths = changed_paths(snapshot)?;
    let message = if collection_has_sensitive_columns(&space, &collection_path) {
        "Update collection field".to_string()
    } else {
        format!("Repair two-way relation \"{column}\"")
    };
    maybe_autocommit_schema(&autocommit, project_path.as_deref(), &space, paths, message).await;
    Ok(())
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
                            entry_rename_op(&space, &path, new_path),
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
                                        entry_rename_op(&space, &of, &nf),
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
            maybe_autocommit_structural_paths(
                &autocommit,
                project_path.as_deref(),
                &space,
                entry_rename_op(&space, &path, new_path),
                entry_paths_with_order(
                    &space,
                    [
                        abs_entry_path(&space, &path),
                        abs_entry_path(&space, new_path),
                    ],
                ),
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
    let cascade_touched = entry::delete(&space, &path, Some(&backlink_index))?;

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
        reindex_space_dir(&index_state, &space).await;
    } else {
        reindex_space_dir(&index_state, &space).await;
    }
    let mut paths = entry_paths_with_order(&space, [abs_entry_path(&space, &path)]);
    paths.extend(cascade_touched);
    maybe_autocommit_structural_paths(
        &autocommit,
        project_path.as_deref(),
        &space,
        StructuralOp::Delete(entry_commit_name(&space, &path)),
        paths,
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
            entry_rename_op(&space, &from, &to),
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
    maybe_autocommit_structural_paths(
        &autocommit,
        project_path.as_deref(),
        &space,
        entry_rename_op(&space, &from, &to),
        entry_paths_with_order(
            &space,
            [abs_entry_path(&space, &from), abs_entry_path(&space, &to)],
        ),
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
    let old_abs = Path::new(&space).join(&from);
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
            StructuralOp::Move(entry_commit_name(&space, &new_path)),
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
    let mut unique_id_paths =
        properties::unique_id_mutation_paths_for_entry_tree(Path::new(&space), &new_path)?;
    if unique_id_paths.is_empty() {
        maybe_autocommit_structural_paths(
            &autocommit,
            project_path.as_deref(),
            &space,
            StructuralOp::Move(entry_commit_name(&space, &new_path)),
            entry_paths_with_order(&space, [old_abs.clone(), abs_entry_path(&space, &new_path)]),
        );
    } else {
        unique_id_paths.push(old_abs);
        unique_id_paths.push(abs_entry_path(&space, &new_path));
        unique_id_paths.push(order_path(&space));
        maybe_autocommit_schema(
            &autocommit,
            project_path.as_deref(),
            &space,
            unique_id_paths,
            if entry_in_sensitive_collection(&space, &new_path) {
                "Move collection entry with unique_id".to_string()
            } else {
                format!("Move {} with unique_id", basename(&new_path))
            },
        )
        .await;
    }
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
            StructuralOp::Move(entry_commit_name(&space, &new_path)),
        )
        .await;
        let _ = index_state
            .remove_file_backlinks(project, target_space_id.as_deref(), &path)
            .await;
        let _ = index_state
            .update_file_backlinks(project, target_space_id.as_deref(), &new_path)
            .await;
    }
    maybe_autocommit_structural_paths(
        &autocommit,
        project_path.as_deref(),
        &space,
        StructuralOp::Move(entry_commit_name(&space, &new_path)),
        entry_paths_with_order(
            &space,
            [
                abs_entry_path(&space, &path),
                abs_entry_path(&space, &new_path),
            ],
        ),
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
            StructuralOp::Move(entry_commit_name(&space, &new_path)),
        )
        .await;
        let _ = index_state
            .remove_file_backlinks(project, target_space_id.as_deref(), &path)
            .await;
        let _ = index_state
            .update_file_backlinks(project, target_space_id.as_deref(), &new_path)
            .await;
    }
    maybe_autocommit_structural_paths(
        &autocommit,
        project_path.as_deref(),
        &space,
        StructuralOp::Move(entry_commit_name(&space, &new_path)),
        entry_paths_with_order(
            &space,
            [
                abs_entry_path(&space, &path),
                abs_entry_path(&space, &new_path),
            ],
        ),
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
    let folder_root = root_path_for_head(&entry.path);
    let old_leaf = format!("{folder_root}.md");
    maybe_autocommit_structural_paths(
        &autocommit,
        project_path.as_deref(),
        &space,
        StructuralOp::ConvertToFolder(entry_history_commit_name(&space, &entry.path)),
        entry_paths_with_order(
            &space,
            [
                abs_entry_path(&space, &old_leaf),
                abs_entry_path(&space, &entry.path),
            ],
        ),
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
    let old_readme = entry
        .path
        .strip_suffix(".md")
        .map(|root| format!("{root}/README.md"))
        .unwrap_or_else(|| entry.path.clone());
    maybe_autocommit_structural_paths(
        &autocommit,
        project_path.as_deref(),
        &space,
        StructuralOp::ConvertToLeaf(entry_history_commit_name(&space, &entry.path)),
        entry_paths_with_order(
            &space,
            [
                abs_entry_path(&space, &old_readme),
                abs_entry_path(&space, &entry.path),
            ],
        ),
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
    maybe_autocommit_structural_paths(
        &autocommit,
        project_path.as_deref(),
        &space,
        StructuralOp::MakeCollection(entry_history_commit_name(
            &space,
            &format!("{collection_path}/README.md"),
        )),
        vec![schema_path(&space, &collection_path)],
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
    maybe_autocommit_structural_paths(
        &autocommit,
        project_path.as_deref(),
        &space,
        StructuralOp::MakeCollection(entry_history_commit_name(
            &space,
            &format!("{}/README.md", folder_path.trim_matches('/')),
        )),
        vec![
            abs_entry_path(
                &space,
                &format!("{}/README.md", folder_path.trim_matches('/')),
            ),
            schema_path(&space, &folder_path),
        ],
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
    let old_name = entry_history_commit_name(&space, &file_path);
    let entry = entry::duplicate_entry(Path::new(&space), &file_path)?;
    reindex_space_dir(&index_state, &space).await;
    let unique_id_paths =
        properties::unique_id_mutation_paths_for_entry_tree(Path::new(&space), &entry.path)?;
    if unique_id_paths.is_empty() {
        maybe_autocommit_structural_paths(
            &autocommit,
            project_path.as_deref(),
            &space,
            StructuralOp::Duplicate {
                old: old_name,
                new: entry_history_commit_name(&space, &entry.path),
            },
            entry_paths_with_order(
                &space,
                [abs_entry_path(&space, root_path_for_head(&entry.path))],
            ),
        );
    } else {
        let mut paths = entry_paths_with_order(
            &space,
            [abs_entry_path(&space, root_path_for_head(&entry.path))],
        );
        paths.extend(unique_id_paths);
        maybe_autocommit_schema(
            &autocommit,
            project_path.as_deref(),
            &space,
            paths,
            if entry_in_sensitive_collection(&space, &file_path)
                || entry_in_sensitive_collection(&space, &entry.path)
            {
                "Duplicate collection entry".to_string()
            } else {
                format!("Duplicate {old_name} → {}", entry_history_name(&entry.path))
            },
        )
        .await;
    }
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
    maybe_autocommit_structural_paths(
        &autocommit,
        project_path.as_deref(),
        &space,
        StructuralOp::Reorder,
        vec![order_path(&space)],
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
    git_state: State<'_, GitState>,
) -> Result<Vec<LinkFixSuggestion>, AppError> {
    let project = Path::new(&project_path);
    let target_dir = index_state
        .space_path_of(project, target_space_id.as_deref())
        .await?;
    let broken_path = normalize_repo_relative(&broken_path, RootMode::Reject)?;

    let mut suggestions = Vec::new();
    if let Ok(cli) = require_cli(&git_state) {
        if let Some((path, reason)) = git_rename_suggestion(&cli, &target_dir, &broken_path).await {
            suggestions.push(LinkFixSuggestion {
                label: label_for_path(&path),
                path,
                reason,
            });
        }
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

async fn git_rename_suggestion(
    cli: &crate::git::cli::GitCli,
    space_dir: &Path,
    broken_path: &str,
) -> Option<(String, String)> {
    let output = cli
        .exec(
            space_dir,
            &[
                "log",
                "--diff-filter=R",
                "--name-status",
                "-z",
                "--pretty=format:%ct%x00",
                "--all",
                "--",
                "*.md",
            ],
        )
        .await
        .ok()?;
    if output.exit_code != 0 {
        return None;
    }
    let (path, ts) = parse_git_rename_suggestion_z(&output.stdout, broken_path)?;
    let days = chrono::DateTime::from_timestamp(ts, 0)
        .map(|dt| (chrono::Utc::now() - dt).num_days().max(0))
        .unwrap_or(0);
    Some((path, format!("renamed {days} days ago")))
}

fn parse_git_rename_suggestion_z(stdout: &str, broken_path: &str) -> Option<(String, i64)> {
    let broken_path = normalize_repo_relative(broken_path, RootMode::Reject).ok()?;
    let mut current_ts: Option<i64> = None;
    let mut tokens = stdout
        .split('\0')
        .map(|token| token.trim_matches('\n'))
        .filter(|token| !token.is_empty());

    while let Some(token) = tokens.next() {
        if let Ok(ts) = token.trim().parse::<i64>() {
            current_ts = Some(ts);
            continue;
        }
        if !token.starts_with('R') {
            continue;
        }
        let old_path = tokens.next()?;
        let new_path = tokens.next()?;
        let old_path = normalize_repo_relative(old_path, RootMode::Reject).ok()?;
        if old_path == broken_path {
            let new_path = normalize_repo_relative(new_path, RootMode::Reject).ok()?;
            return Some((new_path, current_ts.unwrap_or(0)));
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
        let rel = crate::repo_path::repo_relative_from_base(space_dir, &file, RootMode::Reject)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_git_rename_suggestion_z_with_spaces_and_cyrillic() {
        let output = concat!(
            "1710000000\0",
            "R100\0docs/старое имя.md\0docs/new name.md\0",
        );

        let parsed = parse_git_rename_suggestion_z(output, "docs/старое имя.md").unwrap();

        assert_eq!(parsed, ("docs/new name.md".to_string(), 1710000000));
    }
}

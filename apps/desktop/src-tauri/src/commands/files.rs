use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::error::AppError;
use crate::files::{FileWatcher, TreeNode, link_fix, tree};
use crate::git::access::{
    require_repository_mutation, require_repository_mutation_paths, scope_authorized_mutation_paths,
};
use crate::git::autocommit::{AutocommitService, StructuralOp};
use crate::git::{GitState, require_cli};
use crate::index::update::IndexUpdateState;
use crate::index::{self, IndexState, ResolvedDocLink};
use crate::properties::{
    self, ActorCandidate, CollectionInfo, CollectionSchema, Column, EntrySchemaResponse, Filter,
    PropertyOption, PropertyType, RelationBacklink, RelationTwoWayDiagnostics, ResolvedRelation,
    SchemaMutationWarning, Sort, View,
};
use crate::repo_path::{RootMode, normalize_repo_relative};
use crate::space::config;
use svode_core::index::backlinks::{BacklinkInfo, LinkValidation};
use svode_core::page::entry::{self, Entry, WriteResult};
use svode_core::page::nonce::WriteNonceRegistry;
use svode_core::page::templates::{self, TemplateInfo, TemplateKind};

mod collections;
mod entries;
mod schema;
mod structure;
mod tree_links;

pub use crate::files::link_fix::LinkFixSuggestion;
pub use collections::*;
pub use entries::*;
pub use schema::*;
pub use structure::*;
pub use tree_links::*;

fn basename(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_string()
}

fn abs_entry_path(space: &str, rel_path: &str) -> PathBuf {
    Path::new(space).join(rel_path)
}

fn path_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("<unknown>")
        .to_string()
}

fn count_tree_nodes(nodes: &[TreeNode]) -> usize {
    nodes
        .iter()
        .map(|node| 1 + count_tree_nodes(&node.children))
        .sum()
}

fn order_path(space: &str) -> PathBuf {
    Path::new(space).join(".svode").join("order.json")
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

async fn apply_indexed_entry_dates(
    index_state: &IndexState,
    space: &str,
    path: &str,
    entry: &mut Entry,
) {
    let Ok(normalized) = normalize_repo_relative(path, RootMode::Reject) else {
        return;
    };
    let Some(key) = index_state.key_for_space_dir(Path::new(space)).await else {
        return;
    };
    let Ok(pool) = index_state.get_or_create(&key).await else {
        return;
    };
    index::page_dates::apply_indexed_dates(&pool, &normalized, entry).await;
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSchemaTypeResult {
    pub schema: CollectionSchema,
    pub warnings: Vec<SchemaMutationWarning>,
}

pub type ConvertToCollectionCommandResult = crate::space::structural::ConvertToCollectionOutcome;

fn entry_paths_with_order(space: &str, paths: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    let mut out = vec![order_path(space)];
    out.extend(paths);
    out
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
        PropertyType::Boolean => "boolean",
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
    properties::read::collection_schema(space, collection_path)
        .map(|schema| properties::schema_has_sensitive_columns(&schema))
        .unwrap_or(false)
}

fn entry_in_sensitive_collection(space: &str, path: &str) -> bool {
    properties::read::entry_schema(space, path)
        .ok()
        .flatten()
        .is_some_and(|response| properties::schema_has_sensitive_columns(&response.schema))
}

fn entry_commit_name(space: &str, path: &str) -> String {
    if entry_in_sensitive_collection(space, path) {
        "collection entry".to_string()
    } else {
        basename(path)
    }
}

fn template_name_for_commit(space: &str, collection_path: &str, name: String) -> String {
    if collection_has_sensitive_columns(space, collection_path) {
        "collection template".to_string()
    } else {
        name
    }
}

pub(crate) fn maybe_autocommit_structural_paths(
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

async fn require_planned_mutation_paths(
    app: &AppHandle,
    space: &str,
    mut paths: Vec<PathBuf>,
) -> Result<Vec<PathBuf>, AppError> {
    paths.push(PathBuf::from(space));
    require_repository_mutation_paths(app, paths.clone()).await?;
    Ok(paths)
}

async fn apply_collection_mutation<T>(
    app: &AppHandle,
    space: &str,
    mutation: properties::PreparedCollectionMutation<T>,
) -> Result<properties::CollectionMutationOutcome<T>, AppError>
where
    T: Send + 'static,
{
    let authorized_paths =
        require_planned_mutation_paths(app, space, mutation.paths().to_vec()).await?;
    scope_authorized_mutation_paths(authorized_paths, async move {
        mutation.apply().map_err(AppError::from)
    })
    .await
}

async fn require_entry_move_mutation_plan(
    app: &AppHandle,
    index_state: &IndexState,
    space: &str,
    project_path: Option<&str>,
    from: &str,
    to: &str,
) -> Result<Vec<PathBuf>, AppError> {
    let paths =
        crate::space::structural::move_mutation_paths(index_state, space, project_path, from, to)
            .await?;
    require_planned_mutation_paths(app, space, paths).await
}

async fn require_entry_backlink_mutation_plan(
    app: &AppHandle,
    index_state: &IndexState,
    space: &str,
    project_path: Option<&str>,
    from: &str,
    folder_rename: bool,
) -> Result<Vec<PathBuf>, AppError> {
    let paths =
        entry_backlink_mutation_paths(index_state, space, project_path, from, folder_rename)
            .await?;
    require_repository_mutation_paths(app, paths.clone()).await?;
    Ok(paths)
}

pub(crate) async fn entry_backlink_mutation_paths(
    index_state: &IndexState,
    space: &str,
    project_path: Option<&str>,
    from: &str,
    folder_rename: bool,
) -> Result<Vec<PathBuf>, AppError> {
    crate::space::structural::backlink_mutation_paths(
        index_state,
        space,
        project_path,
        from,
        folder_rename,
    )
    .await
}

async fn require_convert_to_collection_mutation_plan(
    app: &AppHandle,
    index_state: &IndexState,
    space: &str,
    project_path: Option<&str>,
    path: &str,
) -> Result<Vec<PathBuf>, AppError> {
    let path = normalize_repo_relative(path, RootMode::Reject)?;
    let source = Path::new(space).join(&path);
    let needs_leaf_move = source.is_file()
        && !source
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("README.md"));
    if needs_leaf_move {
        require_entry_backlink_mutation_plan(app, index_state, space, project_path, &path, false)
            .await
    } else {
        require_planned_mutation_paths(app, space, Vec::new()).await
    }
}

fn nested_entry_path(path: &str) -> Result<String, AppError> {
    let path = normalize_repo_relative(path, RootMode::Reject)?;
    if Path::new(&path)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("README.md"))
    {
        return Ok(path);
    }
    let stem = Path::new(&path)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or_else(|| AppError::General("invalid entry filename".to_string()))?;
    let parent = Path::new(&path).parent().unwrap_or(Path::new(""));
    Ok(if parent.as_os_str().is_empty() {
        format!("{stem}/README.md")
    } else {
        format!("{}/{stem}/README.md", parent.to_string_lossy())
    })
}

fn leaf_entry_path(path: &str) -> Result<String, AppError> {
    let path = normalize_repo_relative(path, RootMode::Reject)?;
    let folder = Path::new(&path)
        .parent()
        .ok_or_else(|| AppError::General("entry has no parent folder".to_string()))?;
    let folder_name = folder
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppError::General("invalid folder name".to_string()))?;
    let parent = folder.parent().unwrap_or(Path::new(""));
    Ok(if parent.as_os_str().is_empty() {
        format!("{folder_name}.md")
    } else {
        format!("{}/{folder_name}.md", parent.to_string_lossy())
    })
}

#[cfg(test)]
mod tests;

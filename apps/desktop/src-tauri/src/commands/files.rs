use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::error::AppError;
use crate::files::{
    BacklinkIndex, BacklinkInfo, Entry, FileWatcher, LinkValidation, ModifiedLinkSource, TreeNode,
    WriteNonceRegistry, WriteResult, entry, link_fix, templates, tree,
    tree_policy::{TreeIgnorePolicy, TreePathKind},
};
use crate::files::{TemplateInfo, TemplateKind};
use crate::git::autocommit::{AutocommitService, StructuralOp};
use crate::git::commands::{GitState, require_cli};
use crate::index::{self, IndexKey, IndexState, ResolvedDocLink};
use crate::properties::{
    self, ActorCandidate, CollectionInfo, CollectionSchema, Column, EntrySchemaResponse, Filter,
    PropertyOption, PropertyType, RelationBacklink, RelationTwoWayDiagnostics, ResolvedRelation,
    SchemaMutationWarning, Sort, View,
};
use crate::repo_path::{RootMode, normalize_repo_relative};
use crate::space::config;

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

async fn indexed_entry_dates(
    index_state: &IndexState,
    space: &str,
    path: &str,
) -> Option<(String, String)> {
    let normalized = normalize_repo_relative(path, RootMode::Reject).ok()?;
    let key = index_state.key_for_space_dir(Path::new(space)).await?;
    let pool = index_state.get_or_create(&key).await.ok()?;
    sqlx::query_as::<_, (String, String)>(
        "SELECT created, updated FROM entries WHERE file_path = ?",
    )
    .bind(normalized)
    .fetch_optional(&pool)
    .await
    .ok()
    .flatten()
}

fn apply_indexed_dates(entry: &mut Entry, dates: Option<(String, String)>) {
    if let Some((created, updated)) = dates {
        entry.meta.created = created;
        entry.meta.updated = updated;
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSchemaTypeResult {
    pub schema: CollectionSchema,
    pub warnings: Vec<SchemaMutationWarning>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteEntryCommandResult {
    pub deleted_root: String,
    pub deleted_paths: Vec<String>,
    pub cascade_touched: Vec<String>,
    pub changed_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertToCollectionCommandResult {
    pub old_path: String,
    pub collection_path: String,
    pub readme_path: String,
    pub schema_path: String,
    pub entry: Entry,
}

fn entry_paths_with_order(space: &str, paths: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    let mut out = vec![order_path(space)];
    out.extend(paths);
    out
}

fn rel_changed_path(space: &str, path: &Path) -> String {
    path.strip_prefix(space)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn grouped_abs_paths_by_space(
    project_path: Option<&str>,
    fallback_space: &str,
    paths: &[PathBuf],
) -> HashMap<PathBuf, Vec<PathBuf>> {
    let mut spaces = vec![PathBuf::from(fallback_space)];
    if let Some(project) = project_path.filter(|path| !path.is_empty()) {
        let project_root = PathBuf::from(project);
        if !spaces.iter().any(|space| same_path(space, &project_root)) {
            spaces.push(project_root.clone());
        }
        match config::read_space_config(&project_root) {
            Ok(config) => {
                for space_ref in config.spaces.as_deref().unwrap_or(&[]) {
                    let child = project_root.join(&space_ref.path);
                    if !spaces.iter().any(|space| same_path(space, &child)) {
                        spaces.push(child);
                    }
                }
            }
            Err(error) => {
                tracing::warn!("could not read project config for changed paths: {error}")
            }
        }
    }
    spaces.sort_by_key(|space| std::cmp::Reverse(space.as_os_str().len()));

    let mut grouped: HashMap<PathBuf, Vec<PathBuf>> = HashMap::new();
    for path in paths {
        let owner = spaces
            .iter()
            .find(|space| path.starts_with(space))
            .cloned()
            .unwrap_or_else(|| PathBuf::from(fallback_space));
        grouped.entry(owner).or_default().push(path.clone());
    }
    grouped
}

fn same_path(left: &Path, right: &Path) -> bool {
    let normalize = |path: &Path| {
        path.canonicalize()
            .unwrap_or_else(|_| path.to_path_buf())
            .to_string_lossy()
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_string()
    };
    normalize(left) == normalize(right)
}

fn push_unique_path(paths: &mut Vec<String>, path: String) {
    if !paths.iter().any(|existing| existing == &path) {
        paths.push(path);
    }
}

fn collect_markdown_paths(
    base: &Path,
    root: &Path,
    policy: &TreeIgnorePolicy,
) -> Result<Vec<PathBuf>, AppError> {
    let Ok(meta) = fs::symlink_metadata(root) else {
        return Ok(Vec::new());
    };
    if meta.file_type().is_symlink() {
        return Ok(Vec::new());
    }

    let rel_path = root.strip_prefix(base).unwrap_or(root);
    let kind = if meta.is_dir() {
        TreePathKind::Directory
    } else if meta.is_file() {
        TreePathKind::File
    } else {
        TreePathKind::Unknown
    };
    if policy.is_ignored_rel(rel_path, kind) {
        return Ok(Vec::new());
    }

    if meta.is_file() {
        if root
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
        {
            return Ok(vec![root.to_path_buf()]);
        }
        return Ok(Vec::new());
    }

    let mut paths = Vec::new();
    if !meta.is_dir() {
        return Ok(paths);
    }

    for item in fs::read_dir(root)? {
        let item = item?;
        let path = item.path();
        paths.extend(collect_markdown_paths(base, &path, policy)?);
    }

    Ok(paths)
}

fn schema_path(space: &str, collection_path: &str) -> PathBuf {
    if collection_path.is_empty() || collection_path == "." {
        return Path::new(space).join("schema.yaml");
    }
    Path::new(space).join(collection_path).join("schema.yaml")
}

fn collection_schema_path_rel(collection_path: &str) -> String {
    if collection_path.is_empty() || collection_path == "." {
        "schema.yaml".to_string()
    } else {
        format!("{collection_path}/schema.yaml")
    }
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

fn same_parent(left: &str, right: &str) -> bool {
    Path::new(left).parent().unwrap_or(Path::new(""))
        == Path::new(right).parent().unwrap_or(Path::new(""))
}

fn normalize_rel_lossy(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn moved_child_old_path(new_child: &str, old_root: &str, new_root: &str) -> String {
    if new_child == new_root {
        return old_root.to_string();
    }
    let prefix = format!("{}/", new_root.trim_end_matches('/'));
    match new_child.strip_prefix(&prefix) {
        Some(rest) if old_root.is_empty() => rest.to_string(),
        Some(rest) => format!("{}/{}", old_root.trim_end_matches('/'), rest),
        None => old_root.to_string(),
    }
}

async fn rebase_project_source_after_move(
    index_state: &IndexState,
    project_path: Option<&str>,
    space: &str,
    source_space_id: Option<&str>,
    old_path: &str,
    new_path: &str,
    fallback_context: &str,
) -> Vec<ModifiedLinkSource> {
    let Some(proj) = project_path.filter(|p| !p.is_empty()) else {
        return Vec::new();
    };
    match index_state
        .rebase_source_links_project(Path::new(proj), source_space_id, old_path, new_path)
        .await
    {
        Ok(Some(item)) => {
            update_index_entry_or_reindex(
                index_state,
                project_path,
                space,
                new_path,
                fallback_context,
            )
            .await;
            vec![item]
        }
        Ok(None) => Vec::new(),
        Err(e) => {
            tracing::warn!("{fallback_context}: source link rebase failed for {new_path}: {e}");
            Vec::new()
        }
    }
}

async fn rebase_project_source_tree_after_move(
    index_state: &IndexState,
    project_path: Option<&str>,
    space: &str,
    source_space_id: Option<&str>,
    old_root: &str,
    new_root: &str,
    fallback_context: &str,
) -> Vec<ModifiedLinkSource> {
    let Some(proj) = project_path.filter(|p| !p.is_empty()) else {
        return Vec::new();
    };
    let space_root = Path::new(space);
    let policy = TreeIgnorePolicy::from_space_root(space_root);
    let new_abs = space_root.join(new_root);
    let files = match collect_markdown_paths(space_root, &new_abs, &policy) {
        Ok(files) => files,
        Err(e) => {
            tracing::warn!("{fallback_context}: collect moved markdown sources failed: {e}");
            return Vec::new();
        }
    };

    let project = Path::new(proj);
    let mut modified = Vec::new();
    let old_root_abs = space_root.join(old_root);
    let new_root_abs = space_root.join(new_root);
    for file in files {
        let new_rel = normalize_rel_lossy(file.strip_prefix(space_root).unwrap_or(&file));
        let old_rel = moved_child_old_path(&new_rel, old_root, new_root);
        if let Err(e) = index_state
            .remove_file_backlinks(project, source_space_id, &old_rel)
            .await
        {
            tracing::warn!("{fallback_context}: remove old source backlinks failed: {e}");
        }
        let old_abs = space_root.join(&old_rel);
        let new_abs = space_root.join(&new_rel);
        match fs::read_to_string(&new_abs) {
            Ok(content) => {
                let updated = crate::files::backlinks::rebase_source_links_between_moved_tree(
                    &content,
                    &old_abs,
                    &new_abs,
                    &old_root_abs,
                    &new_root_abs,
                );
                if updated != content {
                    if let Err(e) = fs::write(&new_abs, updated) {
                        tracing::warn!(
                            "{fallback_context}: write moved source rebase failed for {new_rel}: {e}"
                        );
                    } else {
                        update_index_entry_or_reindex(
                            index_state,
                            project_path,
                            space,
                            &new_rel,
                            fallback_context,
                        )
                        .await;
                        modified.push(ModifiedLinkSource {
                            space_id: source_space_id.map(ToString::to_string),
                            path: new_rel.clone(),
                        });
                    }
                }
            }
            Err(e) => tracing::warn!(
                "{fallback_context}: read moved source for rebase failed for {new_rel}: {e}"
            ),
        }
        if let Err(e) = index_state
            .update_file_backlinks(project, source_space_id, &new_rel)
            .await
        {
            tracing::warn!("{fallback_context}: update moved source backlinks failed: {e}");
        }
    }
    modified
}

fn rebase_legacy_source_after_move(
    space: &str,
    backlink_index: &BacklinkIndex,
    old_path: &str,
    new_path: &str,
) -> Result<bool, AppError> {
    let space_path = Path::new(space);
    let abs = space_path.join(new_path);
    if !abs.exists() {
        return Ok(false);
    }
    let content = fs::read_to_string(&abs)?;
    let updated = crate::files::backlinks::rebase_source_links(&content, old_path, new_path);
    backlink_index.remove_file(old_path);
    if updated == content {
        let _ = backlink_index.update_file(space_path, new_path);
        return Ok(false);
    }
    fs::write(&abs, updated)?;
    let _ = backlink_index.update_file(space_path, new_path);
    Ok(true)
}

fn rebase_legacy_source_tree_after_move(
    space: &str,
    backlink_index: &BacklinkIndex,
    old_root: &str,
    new_root: &str,
) {
    let space_root = Path::new(space);
    let policy = TreeIgnorePolicy::from_space_root(space_root);
    let Ok(files) = collect_markdown_paths(space_root, &space_root.join(new_root), &policy) else {
        return;
    };
    let old_root_abs = space_root.join(old_root);
    let new_root_abs = space_root.join(new_root);
    for file in files {
        let new_rel = normalize_rel_lossy(file.strip_prefix(space_root).unwrap_or(&file));
        let old_rel = moved_child_old_path(&new_rel, old_root, new_root);
        let old_abs = space_root.join(&old_rel);
        let new_abs = space_root.join(&new_rel);
        backlink_index.remove_file(&old_rel);
        let Ok(content) = fs::read_to_string(&new_abs) else {
            continue;
        };
        let updated = crate::files::backlinks::rebase_source_links_between_moved_tree(
            &content,
            &old_abs,
            &new_abs,
            &old_root_abs,
            &new_root_abs,
        );
        if updated != content {
            let _ = fs::write(&new_abs, updated);
        }
        let _ = backlink_index.update_file(space_root, &new_rel);
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
    tracing::info!(
        event = "index.reindex.repair",
        space,
        key = ?key,
        "running full index repair reindex"
    );
    if let Err(e) = index_state.run_full_reindex(&key).await {
        tracing::warn!("collection operation reindex failed for {:?}: {e}", key);
    }
}

async fn update_index_entry_or_reindex(
    index_state: &IndexState,
    project_path: Option<&str>,
    space: &str,
    rel_path: &str,
    fallback_context: &str,
) {
    let Some(proj) = project_path.filter(|p| !p.is_empty()) else {
        reindex_space_dir(index_state, space).await;
        return;
    };

    let project = Path::new(proj);
    let abs_target = Path::new(space).join(rel_path);
    if let Err(e) = index::update::update_entry(index_state, project, &abs_target).await {
        tracing::warn!("{fallback_context}: targeted index update failed for {rel_path}: {e}");
        tracing::info!("{fallback_context}: running index.reindex.repair fallback");
        reindex_space_dir(index_state, space).await;
    } else {
        tracing::debug!(
            event = "index.update.targeted",
            context = fallback_context,
            operation = "update",
            path = rel_path
        );
    }
}

async fn update_index_paths_or_reindex(
    index_state: &IndexState,
    project_path: Option<&str>,
    space: &str,
    abs_paths: Vec<PathBuf>,
    fallback_context: &str,
) {
    let Some(proj) = project_path.filter(|p| !p.is_empty()) else {
        reindex_space_dir(index_state, space).await;
        return;
    };

    let project = Path::new(proj);
    let mut needs_reindex = false;
    for abs_path in abs_paths {
        if let Err(e) = index::update::update_entry(index_state, project, &abs_path).await {
            tracing::warn!(
                "{fallback_context}: targeted index update failed for {}: {e}",
                abs_path.display()
            );
            needs_reindex = true;
        } else {
            tracing::debug!(
                event = "index.update.targeted",
                context = fallback_context,
                operation = "update",
                path = %abs_path.display()
            );
        }
    }
    if needs_reindex {
        tracing::info!("{fallback_context}: running index.reindex.repair fallback");
        reindex_space_dir(index_state, space).await;
    }
}

async fn update_index_tree_or_reindex(
    index_state: &IndexState,
    project_path: Option<&str>,
    space: &str,
    rel_root: &str,
    fallback_context: &str,
) {
    let space_root = Path::new(space);
    let policy = TreeIgnorePolicy::from_space_root(space_root);
    let abs_root = space_root.join(rel_root);
    let paths = match collect_markdown_paths(space_root, &abs_root, &policy) {
        Ok(paths) => paths,
        Err(e) => {
            tracing::warn!("{fallback_context}: collect markdown paths failed for {rel_root}: {e}");
            tracing::info!("{fallback_context}: running index.reindex.repair fallback");
            reindex_space_dir(index_state, space).await;
            return;
        }
    };
    update_index_paths_or_reindex(index_state, project_path, space, paths, fallback_context).await;
}

async fn replace_index_entries_or_reindex(
    index_state: &IndexState,
    project_path: Option<&str>,
    space: &str,
    deleted_rel_paths: &[String],
    updated_rel_paths: &[String],
    fallback_context: &str,
) {
    let Some(proj) = project_path.filter(|p| !p.is_empty()) else {
        reindex_space_dir(index_state, space).await;
        return;
    };

    let project = Path::new(proj);
    let mut needs_reindex = false;
    for rel_path in deleted_rel_paths {
        let abs_target = Path::new(space).join(rel_path);
        if let Err(e) = index::update::delete_entry(index_state, project, &abs_target).await {
            tracing::warn!("{fallback_context}: targeted index delete failed for {rel_path}: {e}");
            needs_reindex = true;
        } else {
            tracing::debug!(
                event = "index.update.targeted",
                context = fallback_context,
                operation = "delete",
                path = rel_path
            );
        }
    }
    for rel_path in updated_rel_paths {
        let abs_target = Path::new(space).join(rel_path);
        if let Err(e) = index::update::update_entry(index_state, project, &abs_target).await {
            tracing::warn!("{fallback_context}: targeted index update failed for {rel_path}: {e}");
            needs_reindex = true;
        } else {
            tracing::debug!(
                event = "index.update.targeted",
                context = fallback_context,
                operation = "update",
                path = rel_path
            );
        }
    }
    if needs_reindex {
        tracing::info!("{fallback_context}: running index.reindex.repair fallback");
        reindex_space_dir(index_state, space).await;
    }
}

#[cfg(test)]
mod tests;

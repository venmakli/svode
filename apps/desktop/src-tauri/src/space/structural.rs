use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;

use crate::error::AppError;
use crate::files::tree_policy::{TreeIgnorePolicy, TreePathKind};
use crate::files::{BacklinkIndex, Entry, ModifiedLinkSource, entry};
use crate::git::access::ensure_mutation_paths_were_authorized;
use crate::git::autocommit::{AutocommitService, StructuralOp};
use crate::index::update::IndexUpdateState;
use crate::index::{self, IndexKey, IndexState};
use crate::properties;
use crate::repo_path::{RootMode, normalize_repo_relative};

use super::config;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOutcome {
    pub deleted_root: String,
    pub deleted_paths: Vec<String>,
    pub cascade_touched: Vec<String>,
    pub changed_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertToCollectionOutcome {
    pub old_path: String,
    pub collection_path: String,
    pub readme_path: String,
    pub schema_path: String,
    pub entry: Entry,
}

pub struct CollectionCreate {
    pub space: String,
    pub parent_path: Option<String>,
    pub title: String,
    pub body: Option<String>,
    pub icon: Option<String>,
    pub description: Option<String>,
    pub cover: Option<entry::Cover>,
    pub schema: properties::CollectionSchema,
    pub allocate_unique_title: bool,
    pub project: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionCreateOutcome {
    pub collection_path: String,
    pub collection: Entry,
    pub schema: properties::CollectionSchema,
    pub changed_paths: Vec<PathBuf>,
}

fn collection_schema_path(space: &str, collection_path: &str) -> PathBuf {
    if collection_path.is_empty() || collection_path == "." {
        Path::new(space).join("schema.yaml")
    } else {
        Path::new(space).join(collection_path).join("schema.yaml")
    }
}

fn collection_schema_path_rel(collection_path: &str) -> String {
    if collection_path.is_empty() || collection_path == "." {
        "schema.yaml".to_string()
    } else {
        format!("{collection_path}/schema.yaml")
    }
}

fn root_path_for_head(path: &str) -> &str {
    if path
        .rsplit_once('/')
        .is_some_and(|(_, name)| name.eq_ignore_ascii_case("README.md"))
    {
        path.rsplit_once('/')
            .map(|(parent, _)| parent)
            .unwrap_or(path)
    } else {
        path
    }
}

pub fn abs_entry_path(space: &str, rel_path: &str) -> PathBuf {
    Path::new(space).join(rel_path)
}

pub fn order_path(space: &str) -> PathBuf {
    Path::new(space).join(".svode").join("order.json")
}

fn managed_attachment_repository_dir(space: &str, project_path: Option<&str>) -> PathBuf {
    let space_dir = PathBuf::from(space);
    if space_dir.join(".git").symlink_metadata().is_ok() {
        return space_dir;
    }
    project_path
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .unwrap_or(space_dir)
}

pub fn managed_attachment_policy_paths(space: &str, project_path: Option<&str>) -> Vec<PathBuf> {
    let repo_dir = managed_attachment_repository_dir(space, project_path);
    vec![repo_dir.join(".gitignore"), repo_dir.join(".gitattributes")]
}

pub fn rebase_managed_attachment_routes(
    space: &str,
    project_path: Option<&str>,
    from: &str,
    to: &str,
    subtree: bool,
) -> Result<Vec<PathBuf>, AppError> {
    let space_dir = PathBuf::from(space);
    let repo_dir = managed_attachment_repository_dir(space, project_path);
    let space_prefix = space_dir.strip_prefix(&repo_dir).unwrap_or(Path::new(""));
    let old_path = space_prefix.join(from).to_string_lossy().replace('\\', "/");
    let new_path = space_prefix.join(to).to_string_lossy().replace('\\', "/");
    crate::storage::strategy::rebase_managed_import_routes(&repo_dir, &old_path, &new_path, subtree)
}

pub fn entry_paths_with_order(
    space: &str,
    paths: impl IntoIterator<Item = PathBuf>,
) -> Vec<PathBuf> {
    let mut out = vec![order_path(space)];
    out.extend(paths);
    out
}

pub fn grouped_abs_paths_by_space(
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

pub fn collect_markdown_paths(
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
        return Ok(root
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
            .then(|| vec![root.to_path_buf()])
            .unwrap_or_default());
    }
    if !meta.is_dir() {
        return Ok(Vec::new());
    }
    let mut paths = Vec::new();
    for item in fs::read_dir(root)? {
        paths.extend(collect_markdown_paths(base, &item?.path(), policy)?);
    }
    Ok(paths)
}

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

fn entry_in_sensitive_collection(space: &str, path: &str) -> bool {
    properties::read::entry_schema(space, path)
        .ok()
        .flatten()
        .is_some_and(|response| properties::schema_has_sensitive_columns(&response.schema))
}

pub fn entry_commit_name(space: &str, path: &str) -> String {
    if entry_in_sensitive_collection(space, path) {
        "collection entry".to_string()
    } else {
        basename(path)
    }
}

pub fn entry_history_commit_name(space: &str, path: &str) -> String {
    if entry_in_sensitive_collection(space, path) {
        "collection entry".to_string()
    } else {
        entry_history_name(path)
    }
}

pub fn entry_rename_op(space: &str, from: &str, to: &str) -> StructuralOp {
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

pub fn maybe_autocommit_structural_paths(
    autocommit: &AutocommitService,
    project_path: Option<&str>,
    space_path: &str,
    op: StructuralOp,
    paths: Vec<PathBuf>,
) {
    let Some(project) = project_path.filter(|path| !path.is_empty()) else {
        return;
    };
    autocommit.schedule_structural_paths(
        PathBuf::from(project),
        PathBuf::from(space_path),
        op,
        paths,
    );
}

pub async fn space_id_for_dir(state: &IndexState, space: &str) -> Option<String> {
    state
        .key_for_space_dir(Path::new(space))
        .await
        .and_then(|key| IndexState::space_id_for_key(&key))
}

pub async fn backlinks_for_space(state: &IndexState, space: &str) -> Arc<BacklinkIndex> {
    let key = state
        .key_for_space_dir(Path::new(space))
        .await
        .unwrap_or_else(|| IndexKey::Root(PathBuf::from(space)));
    state.backlinks_for(&key).await
}

async fn schedule_modified_source_spaces(
    state: &IndexState,
    autocommit: &AutocommitService,
    project_path: Option<&str>,
    modified: &[ModifiedLinkSource],
    op: StructuralOp,
) {
    let Some(project) = project_path.filter(|path| !path.is_empty()) else {
        return;
    };
    let project = Path::new(project);
    let mut by_space: HashMap<PathBuf, Vec<PathBuf>> = HashMap::new();
    for item in modified {
        match state.space_path_of(project, item.space_id.as_deref()).await {
            Ok(space_path) => by_space
                .entry(space_path.clone())
                .or_default()
                .push(space_path.join(&item.path)),
            Err(error) => tracing::warn!("schedule modified backlink source failed: {error}"),
        }
    }
    for (space_path, paths) in by_space {
        autocommit.schedule_structural_paths(project.to_path_buf(), space_path, op.clone(), paths);
    }
}

async fn ensure_backlinks_before_structural(state: &IndexState, project_path: Option<&str>) {
    let Some(project) = project_path.filter(|path| !path.is_empty()) else {
        return;
    };
    if let Err(error) = state
        .ensure_project_backlinks_built(Path::new(project))
        .await
    {
        tracing::warn!("pre-structural backlink rebuild failed: {error}");
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

async fn reindex_space_dir(state: &IndexState, updates: &IndexUpdateState, space: &str) {
    let key = state
        .key_for_space_dir(Path::new(space))
        .await
        .unwrap_or_else(|| IndexKey::Root(PathBuf::from(space)));
    if let Err(error) = crate::index::service::repair_space(state, updates, &key).await {
        tracing::warn!("structural operation reindex failed for {:?}: {error}", key);
    }
}

async fn update_index_entry_or_reindex(
    state: &IndexState,
    updates: &IndexUpdateState,
    project_path: Option<&str>,
    space: &str,
    rel_path: &str,
    context: &str,
) {
    let Some(project) = project_path.filter(|path| !path.is_empty()) else {
        reindex_space_dir(state, updates, space).await;
        return;
    };
    if let Err(error) = index::update::publish_managed_path(
        state,
        updates,
        Path::new(project),
        &Path::new(space).join(rel_path),
    )
    .await
    {
        tracing::warn!("{context}: targeted index update failed for {rel_path}: {error}");
        reindex_space_dir(state, updates, space).await;
    }
}

pub async fn update_index_paths_or_reindex(
    state: &IndexState,
    updates: &IndexUpdateState,
    project_path: Option<&str>,
    space: &str,
    paths: Vec<PathBuf>,
    context: &str,
) -> Vec<String> {
    let Some(project) = project_path.filter(|path| !path.is_empty()) else {
        reindex_space_dir(state, updates, space).await;
        return Vec::new();
    };
    let mut errors = Vec::new();
    for path in paths {
        if let Err(error) =
            index::update::publish_managed_path(state, updates, Path::new(project), &path).await
        {
            tracing::warn!(
                "{context}: targeted index update failed for {}: {error}",
                path.display()
            );
            errors.push(error.to_string());
        }
    }
    if !errors.is_empty() {
        reindex_space_dir(state, updates, space).await;
    }
    errors
}

pub async fn update_index_tree_or_reindex(
    state: &IndexState,
    updates: &IndexUpdateState,
    project_path: Option<&str>,
    space: &str,
    rel_root: &str,
    context: &str,
) {
    let root = Path::new(space);
    let paths = match collect_markdown_paths(
        root,
        &root.join(rel_root),
        &TreeIgnorePolicy::from_space_root(root),
    ) {
        Ok(paths) => paths,
        Err(error) => {
            tracing::warn!("{context}: collect markdown paths failed for {rel_root}: {error}");
            reindex_space_dir(state, updates, space).await;
            return;
        }
    };
    let _ =
        update_index_paths_or_reindex(state, updates, project_path, space, paths, context).await;
}

pub(crate) async fn replace_index_entries_or_reindex(
    state: &IndexState,
    updates: &IndexUpdateState,
    project_path: Option<&str>,
    space: &str,
    deleted: &[String],
    updated: &[String],
    context: &str,
) {
    let Some(project) = project_path.filter(|path| !path.is_empty()) else {
        reindex_space_dir(state, updates, space).await;
        return;
    };
    let mut failed = false;
    for path in deleted.iter().chain(updated) {
        if let Err(error) = index::update::publish_managed_path(
            state,
            updates,
            Path::new(project),
            &Path::new(space).join(path),
        )
        .await
        {
            tracing::warn!("{context}: targeted index replacement failed for {path}: {error}");
            failed = true;
        }
    }
    if failed {
        reindex_space_dir(state, updates, space).await;
    }
}

async fn rebase_project_source_after_move(
    state: &IndexState,
    updates: &IndexUpdateState,
    project_path: Option<&str>,
    space: &str,
    space_id: Option<&str>,
    old_path: &str,
    new_path: &str,
    context: &str,
    publish_projection: bool,
) -> Vec<ModifiedLinkSource> {
    let Some(project) = project_path.filter(|path| !path.is_empty()) else {
        return Vec::new();
    };
    match state
        .rebase_source_links_project(Path::new(project), space_id, old_path, new_path)
        .await
    {
        Ok(Some(source)) => {
            if publish_projection {
                update_index_entry_or_reindex(
                    state,
                    updates,
                    project_path,
                    space,
                    new_path,
                    context,
                )
                .await;
            }
            vec![source]
        }
        Ok(None) => Vec::new(),
        Err(error) => {
            tracing::warn!("{context}: source link rebase failed for {new_path}: {error}");
            Vec::new()
        }
    }
}

pub(crate) async fn rebase_project_source_tree_after_move(
    state: &IndexState,
    updates: &IndexUpdateState,
    project_path: Option<&str>,
    space: &str,
    space_id: Option<&str>,
    old_root: &str,
    new_root: &str,
    context: &str,
) -> Vec<ModifiedLinkSource> {
    let Some(project) = project_path.filter(|path| !path.is_empty()) else {
        return Vec::new();
    };
    let root = Path::new(space);
    let files = match collect_markdown_paths(
        root,
        &root.join(new_root),
        &TreeIgnorePolicy::from_space_root(root),
    ) {
        Ok(files) => files,
        Err(error) => {
            tracing::warn!("{context}: collect moved markdown sources failed: {error}");
            return Vec::new();
        }
    };
    let mut modified = Vec::new();
    let mut deleted = Vec::new();
    let mut updated = Vec::new();
    let old_root_abs = root.join(old_root);
    let new_root_abs = root.join(new_root);
    for file in files {
        let new_rel = normalize_rel_lossy(file.strip_prefix(root).unwrap_or(&file));
        let old_rel = moved_child_old_path(&new_rel, old_root, new_root);
        deleted.push(old_rel.clone());
        updated.push(new_rel.clone());
        let _ = state
            .remove_file_backlinks(Path::new(project), space_id, &old_rel)
            .await;
        let old_abs = root.join(&old_rel);
        let new_abs = root.join(&new_rel);
        if let Ok(content) = fs::read_to_string(&new_abs) {
            let rebased = crate::files::backlinks::rebase_source_links_between_moved_tree(
                &content,
                &old_abs,
                &new_abs,
                &old_root_abs,
                &new_root_abs,
            );
            if rebased != content && fs::write(&new_abs, rebased).is_ok() {
                modified.push(ModifiedLinkSource {
                    space_id: space_id.map(ToString::to_string),
                    path: new_rel.clone(),
                });
            }
        }
        let _ = state
            .update_file_backlinks(Path::new(project), space_id, &new_rel)
            .await;
    }
    replace_index_entries_or_reindex(
        state,
        updates,
        project_path,
        space,
        &deleted,
        &updated,
        context,
    )
    .await;
    if let Err(error) =
        index::update::rebase_collection_schema_manifest(state, updates, root, old_root, new_root)
            .await
    {
        tracing::warn!("{context}: rebase collection schema manifest failed: {error}");
    }
    modified
}

pub fn rebase_legacy_source_after_move(
    space: &str,
    backlinks: &BacklinkIndex,
    old_path: &str,
    new_path: &str,
) -> Result<bool, AppError> {
    let root = Path::new(space);
    let path = root.join(new_path);
    if !path.exists() {
        return Ok(false);
    }
    let content = fs::read_to_string(&path)?;
    let updated = crate::files::backlinks::rebase_source_links(&content, old_path, new_path);
    backlinks.remove_file(old_path);
    if updated == content {
        let _ = backlinks.update_file(root, new_path);
        return Ok(false);
    }
    fs::write(path, updated)?;
    let _ = backlinks.update_file(root, new_path);
    Ok(true)
}

pub(crate) fn rebase_legacy_source_tree_after_move(
    space: &str,
    backlinks: &BacklinkIndex,
    old_root: &str,
    new_root: &str,
) {
    let root = Path::new(space);
    let Ok(files) = collect_markdown_paths(
        root,
        &root.join(new_root),
        &TreeIgnorePolicy::from_space_root(root),
    ) else {
        return;
    };
    let old_root_abs = root.join(old_root);
    let new_root_abs = root.join(new_root);
    for file in files {
        let new_rel = normalize_rel_lossy(file.strip_prefix(root).unwrap_or(&file));
        let old_rel = moved_child_old_path(&new_rel, old_root, new_root);
        let old_abs = root.join(&old_rel);
        let new_abs = root.join(&new_rel);
        backlinks.remove_file(&old_rel);
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
        let _ = backlinks.update_file(root, &new_rel);
    }
}

pub async fn move_mutation_paths(
    state: &IndexState,
    space: &str,
    project_path: Option<&str>,
    from: &str,
    to: &str,
) -> Result<Vec<PathBuf>, AppError> {
    let Some(project) = project_path.filter(|path| !path.is_empty()) else {
        let mut paths = vec![PathBuf::from(space)];
        paths.extend(managed_attachment_policy_paths(space, None));
        return Ok(paths);
    };
    let mut paths =
        properties::relation_move_mutation_paths_with_project(space, Some(project), from, to)?;
    let space_id = space_id_for_dir(state, space).await;
    let link_plan = if Path::new(space).join(from).is_dir() {
        state
            .plan_links_on_folder_rename_project(Path::new(project), space_id.as_deref(), from)
            .await?
    } else {
        state
            .plan_links_on_rename_project(Path::new(project), space_id.as_deref(), from)
            .await?
    };
    paths.extend_from_slice(link_plan.mutation_paths());
    paths.extend(managed_attachment_policy_paths(space, Some(project)));
    paths.push(PathBuf::from(space));
    paths.sort();
    paths.dedup();
    Ok(paths)
}

pub async fn backlink_mutation_paths(
    state: &IndexState,
    space: &str,
    project_path: Option<&str>,
    from: &str,
    folder_rename: bool,
) -> Result<Vec<PathBuf>, AppError> {
    let Some(project) = project_path.filter(|path| !path.is_empty()) else {
        return Ok(vec![PathBuf::from(space)]);
    };
    let space_id = space_id_for_dir(state, space).await;
    let plan = if folder_rename {
        state
            .plan_links_on_folder_rename_project(Path::new(project), space_id.as_deref(), from)
            .await?
    } else {
        state
            .plan_links_on_rename_project(Path::new(project), space_id.as_deref(), from)
            .await?
    };
    let mut paths = plan.mutation_paths().to_vec();
    paths.push(PathBuf::from(space));
    Ok(paths)
}

async fn revalidate_backlink_plan(
    state: &IndexState,
    space: &str,
    project_path: Option<&str>,
    from: &str,
    folder_rename: bool,
) -> Result<(), AppError> {
    let paths = backlink_mutation_paths(state, space, project_path, from, folder_rename).await?;
    ensure_mutation_paths_were_authorized(&paths)
}

fn rel_changed_path(space: &str, path: &Path) -> String {
    path.strip_prefix(space)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn push_unique_path(paths: &mut Vec<String>, path: String) {
    if !paths.iter().any(|existing| existing == &path) {
        paths.push(path);
    }
}

pub fn delete_mutation_paths(
    space: &str,
    project_path: Option<&str>,
    path: &str,
) -> Result<Vec<PathBuf>, AppError> {
    let deleted = entry::planned_deleted_entry_paths(space, path)?;
    let mut paths = properties::cascade_clean_deleted_entries_mutation_paths_with_project(
        space,
        project_path.filter(|path| !path.is_empty()),
        &deleted,
    )?;
    paths.push(PathBuf::from(space));
    paths.sort();
    paths.dedup();
    Ok(paths)
}

pub async fn delete(
    space: &str,
    path: &str,
    project_path: Option<&str>,
    state: &IndexState,
    updates: &IndexUpdateState,
    autocommit: Option<&AutocommitService>,
) -> Result<DeleteOutcome, AppError> {
    let planned = delete_mutation_paths(space, project_path, path)?;
    ensure_mutation_paths_were_authorized(&planned)?;
    let backlink_index = backlinks_for_space(state, space).await;
    let deleted = entry::delete_with_project(
        space,
        path,
        Some(&backlink_index),
        project_path.filter(|path| !path.is_empty()),
    )?;
    let cascade_touched_by_space =
        grouped_abs_paths_by_space(project_path, space, &deleted.cascade_touched);
    let cascade_touched = deleted
        .cascade_touched
        .iter()
        .map(|path| rel_changed_path(space, path))
        .collect::<Vec<_>>();
    let mut changed_paths = Vec::new();
    for deleted_path in &deleted.deleted_paths {
        push_unique_path(&mut changed_paths, deleted_path.clone());
    }
    push_unique_path(&mut changed_paths, deleted.deleted_root.clone());
    for touched in &cascade_touched {
        push_unique_path(&mut changed_paths, touched.clone());
    }

    if let Some(project) = project_path.filter(|path| !path.is_empty()) {
        let mut needs_reindex = false;
        for deleted_path in &deleted.deleted_paths {
            if let Err(error) = index::update::publish_managed_path(
                state,
                updates,
                Path::new(project),
                &Path::new(space).join(deleted_path),
            )
            .await
            {
                tracing::warn!("index delete failed for {deleted_path}: {error}");
                needs_reindex = true;
            }
        }
        if needs_reindex {
            reindex_space_dir(state, updates, space).await;
        } else {
            for (owner_space, paths) in &cascade_touched_by_space {
                let _ = update_index_paths_or_reindex(
                    state,
                    updates,
                    Some(project),
                    &owner_space.to_string_lossy(),
                    paths.clone(),
                    "delete_content",
                )
                .await;
            }
        }
    } else {
        reindex_space_dir(state, updates, space).await;
    }

    if let Some(autocommit) = autocommit {
        let mut paths_by_space = cascade_touched_by_space;
        paths_by_space
            .entry(PathBuf::from(space))
            .or_default()
            .extend(entry_paths_with_order(
                space,
                [abs_entry_path(space, &deleted.deleted_root)],
            ));
        let op = StructuralOp::Delete(entry_commit_name(space, path));
        for (owner_space, paths) in paths_by_space {
            maybe_autocommit_structural_paths(
                autocommit,
                project_path,
                &owner_space.to_string_lossy(),
                op.clone(),
                paths,
            );
        }
    }

    Ok(DeleteOutcome {
        deleted_root: deleted.deleted_root,
        deleted_paths: deleted.deleted_paths,
        cascade_touched,
        changed_paths,
    })
}

pub fn create_folder(
    space: &str,
    parent_path: Option<&str>,
    name: &str,
    project_path: Option<&str>,
    autocommit: Option<&AutocommitService>,
) -> Result<String, AppError> {
    let folder_path = entry::create_folder(space, parent_path, name)?;
    if let Some(autocommit) = autocommit {
        maybe_autocommit_structural_paths(
            autocommit,
            project_path,
            space,
            StructuralOp::Create(entry_commit_name(space, &folder_path)),
            entry_paths_with_order(space, [abs_entry_path(space, &folder_path)]),
        );
    }
    Ok(folder_path)
}

fn resolved_create_parent(
    space: &str,
    requested: Option<&str>,
) -> Result<(Option<String>, Option<(String, String, Vec<u8>)>), AppError> {
    let Some(requested) = requested.map(str::trim).filter(|path| !path.is_empty()) else {
        return Ok((None, None));
    };
    let root = Path::new(space);
    let direct = root.join(requested);
    if direct.is_dir() {
        return Ok((Some(requested.to_string()), None));
    }
    let leaf = if direct.is_file() {
        requested.to_string()
    } else if Path::new(requested).extension().is_none() {
        let candidate = format!("{requested}.md");
        if root.join(&candidate).is_file() {
            candidate
        } else {
            return Err(AppError::FileNotFound(requested.to_string()));
        }
    } else {
        return Err(AppError::FileNotFound(requested.to_string()));
    };
    let stem = Path::new(&leaf)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or_else(|| AppError::General("parent Page has an invalid filename".into()))?;
    let base = Path::new(&leaf).parent().unwrap_or(Path::new(""));
    let parent = if base.as_os_str().is_empty() {
        stem.to_string()
    } else {
        format!("{}/{stem}", base.to_string_lossy())
    };
    let bytes = fs::read(root.join(&leaf))?;
    Ok((Some(parent.clone()), Some((leaf, parent, bytes))))
}

fn rollback_collection_create(
    space: &str,
    planned_page: &str,
    collection_path: &str,
    parent_conversion: Option<&(String, String, Vec<u8>)>,
    order_before: Option<&[u8]>,
    cause: AppError,
) -> AppError {
    let root = Path::new(space);
    let mut failed = Vec::new();
    for path in [root.join(collection_path), root.join(planned_page)] {
        let result = if path.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
        if let Err(error) = result
            && error.kind() != std::io::ErrorKind::NotFound
        {
            failed.push(format!("{}: {error}", path.display()));
        }
    }
    if let Some((leaf, parent, bytes)) = parent_conversion {
        let converted = root.join(parent);
        if let Err(error) = fs::remove_dir_all(&converted)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            failed.push(format!("{}: {error}", converted.display()));
        }
        if let Err(error) = fs::write(root.join(leaf), bytes) {
            failed.push(format!("{}: {error}", root.join(leaf).display()));
        }
    }
    let order = order_path(space);
    let order_result = match order_before {
        Some(bytes) => fs::write(&order, bytes),
        None => match fs::remove_file(&order) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        },
    };
    if let Err(error) = order_result {
        failed.push(format!("{}: {error}", order.display()));
    }
    if failed.is_empty() {
        cause
    } else {
        AppError::PageWriteRecovery {
            cause: cause.to_string(),
            paths: failed,
        }
    }
}

pub fn collection_create_schema_paths(
    space: &str,
    parent_path: Option<&str>,
    title: &str,
    schema: properties::CollectionSchema,
    allocate_unique_title: bool,
    project_path: Option<&str>,
) -> Result<Vec<PathBuf>, AppError> {
    let (parent, _) = resolved_create_parent(space, parent_path)?;
    let planned = entry::planned_source_create(
        space,
        parent.as_deref(),
        title,
        allocate_unique_title,
        false,
    )?;
    let collection_path = planned
        .path
        .strip_suffix(".md")
        .ok_or_else(|| AppError::General("Collection Page must be Markdown".into()))?;
    Ok(
        properties::prepare_initial_collection_schema(
            space,
            collection_path,
            schema,
            project_path,
        )?
        .paths()
        .to_vec(),
    )
}

pub async fn create_collection<F, Fut>(
    request: CollectionCreate,
    state: &IndexState,
    updates: &IndexUpdateState,
    autocommit: Option<&AutocommitService>,
    authorize: F,
) -> Result<CollectionCreateOutcome, AppError>
where
    F: FnOnce(Vec<PathBuf>) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<PathBuf>, AppError>>,
{
    let (parent, parent_conversion) =
        resolved_create_parent(&request.space, request.parent_path.as_deref())?;
    let planned = entry::planned_source_create(
        &request.space,
        parent.as_deref(),
        &request.title,
        request.allocate_unique_title,
        false,
    )?;
    let collection_path = planned
        .path
        .strip_suffix(".md")
        .ok_or_else(|| AppError::General("Collection Page must be Markdown".into()))?
        .to_string();
    let prepared_schema = properties::prepare_initial_collection_schema(
        &request.space,
        &collection_path,
        request.schema,
        request.project.as_deref(),
    )?;
    let schema_paths = prepared_schema.paths().to_vec();
    let order_before = fs::read(order_path(&request.space)).ok();
    let authorization_space = request.space.clone();
    let page = crate::page::create::create(
        crate::page::create::PageCreate {
            space: request.space.clone(),
            parent_path: parent,
            title: planned.title,
            body: request.body,
            icon: request.icon,
            description: request.description,
            cover: request.cover,
            properties: None,
            contextual_defaults: false,
            allocate_unique_title: false,
            as_readme: false,
            project: request.project.clone(),
            publish_projection: false,
        },
        state,
        updates,
        |mut paths| {
            paths.extend(schema_paths);
            paths.push(PathBuf::from(&authorization_space));
            paths.sort();
            paths.dedup();
            authorize(paths)
        },
    )
    .await?;
    let actual_collection_path = page
        .page
        .path
        .strip_suffix(".md")
        .ok_or_else(|| AppError::General("created Collection Page must be Markdown".into()))?
        .to_string();
    if actual_collection_path != collection_path {
        return Err(rollback_collection_create(
            &request.space,
            &page.page.path,
            &actual_collection_path,
            parent_conversion.as_ref(),
            order_before.as_deref(),
            AppError::General("Collection create plan changed before execution".into()),
        ));
    }
    let conversion = match convert_to_collection_with_publication(
        &request.space,
        &page.page.path,
        request.project.as_deref(),
        state,
        updates,
        None,
        false,
    )
    .await
    {
        Ok(conversion) => conversion,
        Err(error) => {
            return Err(rollback_collection_create(
                &request.space,
                &page.page.path,
                &collection_path,
                parent_conversion.as_ref(),
                order_before.as_deref(),
                error,
            ));
        }
    };
    let schema_outcome = match prepared_schema.apply() {
        Ok(outcome) => outcome,
        Err(error) => {
            return Err(rollback_collection_create(
                &request.space,
                &page.page.path,
                &collection_path,
                parent_conversion.as_ref(),
                order_before.as_deref(),
                error,
            ));
        }
    };
    update_index_tree_or_reindex(
        state,
        updates,
        request.project.as_deref(),
        &request.space,
        &collection_path,
        "create_collection",
    )
    .await;
    let mut changed_paths = page.changed_paths;
    changed_paths.extend(schema_outcome.changed_paths);
    changed_paths.push(abs_entry_path(&request.space, &conversion.readme_path));
    changed_paths.push(collection_schema_path(&request.space, &collection_path));
    changed_paths.sort();
    changed_paths.dedup();
    if let Some(autocommit) = autocommit {
        maybe_autocommit_structural_paths(
            autocommit,
            request.project.as_deref(),
            &request.space,
            StructuralOp::Create(entry_history_commit_name(
                &request.space,
                &conversion.readme_path,
            )),
            changed_paths.clone(),
        );
    }
    Ok(CollectionCreateOutcome {
        collection_path,
        collection: conversion.entry,
        schema: schema_outcome.value,
        changed_paths,
    })
}

pub async fn convert_to_folder(
    space: &str,
    file_path: &str,
    project_path: Option<&str>,
    state: &IndexState,
    updates: &IndexUpdateState,
    autocommit: Option<&AutocommitService>,
) -> Result<Entry, AppError> {
    convert_to_folder_with_publication(
        space,
        file_path,
        project_path,
        state,
        updates,
        autocommit,
        true,
    )
    .await
}

async fn convert_to_folder_with_publication(
    space: &str,
    file_path: &str,
    project_path: Option<&str>,
    state: &IndexState,
    updates: &IndexUpdateState,
    autocommit: Option<&AutocommitService>,
    publish_projection: bool,
) -> Result<Entry, AppError> {
    let backlinks = backlinks_for_space(state, space).await;
    ensure_backlinks_before_structural(state, project_path).await;
    revalidate_backlink_plan(state, space, project_path, file_path, false).await?;
    let project_aware = project_path.filter(|path| !path.is_empty()).is_some();
    let converted = entry::convert_entry_to_folder(
        Path::new(space),
        file_path,
        if project_aware {
            None
        } else {
            Some(&backlinks)
        },
    )?;
    let folder_root = root_path_for_head(&converted.path);
    let old_leaf = format!("{folder_root}.md");
    if let Some(project) = project_path.filter(|path| !path.is_empty()) {
        let project = Path::new(project);
        let target_space_id = space_id_for_dir(state, space).await;
        let mut modified = state
            .update_links_on_rename_project(
                updates,
                project,
                target_space_id.as_deref(),
                &old_leaf,
                &converted.path,
                None,
            )
            .await
            .unwrap_or_else(|error| {
                tracing::warn!("cross-space convert-to-folder backlink rewrite failed: {error}");
                Vec::new()
            });
        modified.extend(
            rebase_project_source_after_move(
                state,
                updates,
                project_path,
                space,
                target_space_id.as_deref(),
                &old_leaf,
                &converted.path,
                "convert_to_folder",
                publish_projection,
            )
            .await,
        );
        let modified = crate::files::backlinks::dedupe_modified_sources(modified);
        if let Some(autocommit) = autocommit {
            schedule_modified_source_spaces(
                state,
                autocommit,
                project_path,
                &modified,
                StructuralOp::ConvertToFolder(entry_history_commit_name(space, &converted.path)),
            )
            .await;
        }
        let _ = state
            .remove_file_backlinks(project, target_space_id.as_deref(), &old_leaf)
            .await;
        let _ = state
            .update_file_backlinks(project, target_space_id.as_deref(), &converted.path)
            .await;
    } else {
        let _ = rebase_legacy_source_after_move(space, &backlinks, &old_leaf, &converted.path);
    }
    if publish_projection {
        replace_index_entries_or_reindex(
            state,
            updates,
            project_path,
            space,
            std::slice::from_ref(&old_leaf),
            std::slice::from_ref(&converted.path),
            "convert_to_folder",
        )
        .await;
    }
    if let Some(autocommit) = autocommit {
        maybe_autocommit_structural_paths(
            autocommit,
            project_path,
            space,
            StructuralOp::ConvertToFolder(entry_history_commit_name(space, &converted.path)),
            entry_paths_with_order(
                space,
                [
                    abs_entry_path(space, &old_leaf),
                    abs_entry_path(space, &converted.path),
                ],
            ),
        );
    }
    Ok(converted)
}

pub async fn convert_to_leaf(
    space: &str,
    file_path: &str,
    project_path: Option<&str>,
    state: &IndexState,
    updates: &IndexUpdateState,
    autocommit: Option<&AutocommitService>,
) -> Result<Entry, AppError> {
    let backlinks = backlinks_for_space(state, space).await;
    ensure_backlinks_before_structural(state, project_path).await;
    revalidate_backlink_plan(state, space, project_path, file_path, false).await?;
    let project_aware = project_path.filter(|path| !path.is_empty()).is_some();
    let converted = entry::convert_entry_to_leaf(
        Path::new(space),
        file_path,
        if project_aware {
            None
        } else {
            Some(&backlinks)
        },
    )?;
    let old_readme = converted
        .path
        .strip_suffix(".md")
        .map(|root| format!("{root}/README.md"))
        .unwrap_or_else(|| converted.path.clone());
    if let Some(project) = project_path.filter(|path| !path.is_empty()) {
        let project = Path::new(project);
        let target_space_id = space_id_for_dir(state, space).await;
        let mut modified = state
            .update_links_on_rename_project(
                updates,
                project,
                target_space_id.as_deref(),
                &old_readme,
                &converted.path,
                None,
            )
            .await
            .unwrap_or_else(|error| {
                tracing::warn!("cross-space convert-to-leaf backlink rewrite failed: {error}");
                Vec::new()
            });
        modified.extend(
            rebase_project_source_after_move(
                state,
                updates,
                project_path,
                space,
                target_space_id.as_deref(),
                &old_readme,
                &converted.path,
                "convert_to_leaf",
                true,
            )
            .await,
        );
        let modified = crate::files::backlinks::dedupe_modified_sources(modified);
        if let Some(autocommit) = autocommit {
            schedule_modified_source_spaces(
                state,
                autocommit,
                project_path,
                &modified,
                StructuralOp::ConvertToLeaf(entry_history_commit_name(space, &converted.path)),
            )
            .await;
        }
        let _ = state
            .remove_file_backlinks(project, target_space_id.as_deref(), &old_readme)
            .await;
        let _ = state
            .update_file_backlinks(project, target_space_id.as_deref(), &converted.path)
            .await;
    } else {
        let _ = rebase_legacy_source_after_move(space, &backlinks, &old_readme, &converted.path);
    }
    replace_index_entries_or_reindex(
        state,
        updates,
        project_path,
        space,
        std::slice::from_ref(&old_readme),
        std::slice::from_ref(&converted.path),
        "convert_to_leaf",
    )
    .await;
    if let Some(autocommit) = autocommit {
        maybe_autocommit_structural_paths(
            autocommit,
            project_path,
            space,
            StructuralOp::ConvertToLeaf(entry_history_commit_name(space, &converted.path)),
            entry_paths_with_order(
                space,
                [
                    abs_entry_path(space, &old_readme),
                    abs_entry_path(space, &converted.path),
                ],
            ),
        );
    }
    Ok(converted)
}

pub async fn convert_to_collection(
    space: &str,
    path: &str,
    project_path: Option<&str>,
    state: &IndexState,
    updates: &IndexUpdateState,
    autocommit: Option<&AutocommitService>,
) -> Result<ConvertToCollectionOutcome, AppError> {
    convert_to_collection_with_publication(
        space,
        path,
        project_path,
        state,
        updates,
        autocommit,
        true,
    )
    .await
}

async fn convert_to_collection_with_publication(
    space: &str,
    path: &str,
    project_path: Option<&str>,
    state: &IndexState,
    updates: &IndexUpdateState,
    autocommit: Option<&AutocommitService>,
    publish_projection: bool,
) -> Result<ConvertToCollectionOutcome, AppError> {
    let old_path = normalize_repo_relative(path, RootMode::Reject)?;
    let source_abs = Path::new(space).join(&old_path);
    let metadata = fs::metadata(&source_abs).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => AppError::FileNotFound(old_path.clone()),
        _ => AppError::Io(error),
    })?;

    let (collection_path, readme_path, converted, source_moved) = if metadata.is_dir() {
        let readme_path = format!("{old_path}/README.md");
        let schema_path = collection_schema_path(space, &old_path);
        if schema_path.exists() {
            return Err(AppError::FileAlreadyExists(rel_changed_path(
                space,
                &schema_path,
            )));
        }
        if source_abs.join("README.md").exists() {
            let collection_path =
                entry::convert_entry_to_nested_collection(Path::new(space), &readme_path)?;
            let converted = entry::read(space, &readme_path)?;
            (collection_path, readme_path, converted, false)
        } else {
            let converted = entry::convert_bare_folder_to_collection(Path::new(space), &old_path)?;
            (old_path.clone(), readme_path, converted, false)
        }
    } else if metadata.is_file() {
        let parent_schema = source_abs.parent().map(|parent| parent.join("schema.yaml"));
        let is_readme = source_abs
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("README.md"));
        if is_readme && parent_schema.as_ref().is_some_and(|schema| schema.exists()) {
            return Err(AppError::General(format!(
                "{old_path} is already a collection README.md; convert_to_collection cannot convert an existing collection"
            )));
        }
        if is_readme {
            let collection_path = Path::new(&old_path)
                .parent()
                .map(normalize_rel_lossy)
                .unwrap_or_default();
            entry::convert_entry_to_nested_collection(Path::new(space), &old_path)?;
            let converted = entry::read(space, &old_path)?;
            (collection_path, old_path.clone(), converted, false)
        } else {
            let converted = convert_to_folder_with_publication(
                space,
                &old_path,
                project_path,
                state,
                updates,
                autocommit,
                publish_projection,
            )
            .await?;
            let readme_path = converted.path.clone();
            let collection_path = Path::new(&readme_path)
                .parent()
                .map(normalize_rel_lossy)
                .ok_or_else(|| {
                    AppError::General("converted entry has no collection folder".to_string())
                })?;
            entry::convert_entry_to_nested_collection(Path::new(space), &readme_path)?;
            let converted = entry::read(space, &readme_path)?;
            (collection_path, readme_path, converted, true)
        }
    } else {
        return Err(AppError::General(format!(
            "path must reference a markdown document or folder: {old_path}"
        )));
    };

    if publish_projection {
        update_index_tree_or_reindex(
            state,
            updates,
            project_path,
            space,
            &collection_path,
            "convert_to_collection",
        )
        .await;
    }
    if let Some(autocommit) = autocommit {
        let mut paths = vec![
            abs_entry_path(space, &readme_path),
            collection_schema_path(space, &collection_path),
        ];
        if source_moved {
            paths = entry_paths_with_order(space, paths);
            paths.push(abs_entry_path(space, &old_path));
        }
        maybe_autocommit_structural_paths(
            autocommit,
            project_path,
            space,
            StructuralOp::MakeCollection(entry_history_commit_name(space, &readme_path)),
            paths,
        );
    }
    Ok(ConvertToCollectionOutcome {
        old_path,
        collection_path: collection_path.clone(),
        readme_path,
        schema_path: collection_schema_path_rel(&collection_path),
        entry: converted,
    })
}

pub async fn rename(
    space: &str,
    from: &str,
    to: &str,
    project_path: Option<&str>,
    state: &IndexState,
    updates: &IndexUpdateState,
    autocommit: Option<&AutocommitService>,
) -> Result<Vec<String>, AppError> {
    if !same_parent(from, to) {
        return Err(AppError::General(
            "rename_entry cannot change parent; use move_entry to move an entry".to_string(),
        ));
    }
    apply_move(
        space,
        from,
        Some(to),
        None,
        project_path,
        state,
        updates,
        autocommit,
    )
    .await
    .map(|outcome| outcome.modified_paths)
}

pub async fn move_entry(
    space: &str,
    from: &str,
    to_parent: &str,
    project_path: Option<&str>,
    state: &IndexState,
    updates: &IndexUpdateState,
    autocommit: Option<&AutocommitService>,
) -> Result<String, AppError> {
    apply_move(
        space,
        from,
        None,
        Some(to_parent),
        project_path,
        state,
        updates,
        autocommit,
    )
    .await
    .map(|outcome| outcome.new_path)
}

struct MoveOutcome {
    new_path: String,
    modified_paths: Vec<String>,
}

async fn apply_move(
    space: &str,
    from: &str,
    rename_to: Option<&str>,
    to_parent: Option<&str>,
    project_path: Option<&str>,
    state: &IndexState,
    updates: &IndexUpdateState,
    autocommit: Option<&AutocommitService>,
) -> Result<MoveOutcome, AppError> {
    let backlinks = backlinks_for_space(state, space).await;
    let was_dir = Path::new(space).join(from).is_dir();
    let old_abs = Path::new(space).join(from);
    ensure_backlinks_before_structural(state, project_path).await;
    revalidate_backlink_plan(state, space, project_path, from, was_dir).await?;
    let new_path = if let Some(to) = rename_to {
        entry::rename_with_project(space, from, to, project_path)?;
        to.to_string()
    } else {
        entry::move_entry_with_project(
            Path::new(space),
            from,
            to_parent.unwrap_or_default(),
            project_path
                .filter(|path| !path.is_empty())
                .is_none()
                .then_some(&backlinks),
            project_path,
        )?
    };
    let policy_paths =
        rebase_managed_attachment_routes(space, project_path, from, &new_path, was_dir)?;
    let mut modified_paths = Vec::new();
    if let Some(project) = project_path.filter(|path| !path.is_empty()) {
        let project = Path::new(project);
        let space_id = space_id_for_dir(state, space).await;
        let mut modified = if was_dir {
            state
                .update_links_on_folder_rename_project(
                    updates,
                    project,
                    space_id.as_deref(),
                    from,
                    &new_path,
                    None,
                )
                .await
        } else {
            state
                .update_links_on_rename_project(
                    updates,
                    project,
                    space_id.as_deref(),
                    from,
                    &new_path,
                    None,
                )
                .await
        }
        .unwrap_or_else(|error| {
            tracing::warn!("cross-space structural backlink rewrite failed: {error}");
            Vec::new()
        });
        let operation_context = if rename_to.is_some() {
            "rename_entry"
        } else {
            "move_entry"
        };
        modified.extend(if was_dir {
            rebase_project_source_tree_after_move(
                state,
                updates,
                project_path,
                space,
                space_id.as_deref(),
                from,
                &new_path,
                operation_context,
            )
            .await
        } else if rename_to.is_none() || !same_parent(from, &new_path) {
            rebase_project_source_after_move(
                state,
                updates,
                project_path,
                space,
                space_id.as_deref(),
                from,
                &new_path,
                operation_context,
                true,
            )
            .await
        } else {
            Vec::new()
        });
        let modified = crate::files::backlinks::dedupe_modified_sources(modified);
        modified_paths = modified.iter().map(|source| source.path.clone()).collect();
        if let Some(autocommit) = autocommit {
            schedule_modified_source_spaces(
                state,
                autocommit,
                project_path,
                &modified,
                if rename_to.is_some() {
                    entry_rename_op(space, from, &new_path)
                } else {
                    StructuralOp::Move(entry_commit_name(space, &new_path))
                },
            )
            .await;
        }
        if !was_dir {
            let _ = state
                .remove_file_backlinks(project, space_id.as_deref(), from)
                .await;
            let _ = state
                .update_file_backlinks(project, space_id.as_deref(), &new_path)
                .await;
        }
    } else if rename_to.is_some() {
        modified_paths = backlinks
            .update_links_on_rename(Path::new(space), from, &new_path, None)
            .unwrap_or_default();
        if was_dir {
            rebase_legacy_source_tree_after_move(space, &backlinks, from, &new_path);
        } else if !same_parent(from, &new_path)
            && rebase_legacy_source_after_move(space, &backlinks, from, &new_path)?
            && !modified_paths.iter().any(|path| path == &new_path)
        {
            modified_paths.push(new_path.clone());
        }
        let _ = backlinks.update_file(Path::new(space), &new_path);
    } else if was_dir {
        rebase_legacy_source_tree_after_move(space, &backlinks, from, &new_path);
    } else {
        let _ = rebase_legacy_source_after_move(space, &backlinks, from, &new_path);
    }
    if let Some(autocommit) = autocommit {
        let mut paths =
            entry_paths_with_order(space, [old_abs.clone(), abs_entry_path(space, &new_path)]);
        paths.extend(policy_paths);
        if rename_to.is_some() {
            maybe_autocommit_structural_paths(
                autocommit,
                project_path,
                space,
                entry_rename_op(space, from, &new_path),
                paths,
            );
        } else {
            let unique_id_paths =
                properties::unique_id_mutation_paths_for_entry_tree(Path::new(space), &new_path)?;
            if unique_id_paths.is_empty() {
                maybe_autocommit_structural_paths(
                    autocommit,
                    project_path,
                    space,
                    StructuralOp::Move(entry_commit_name(space, &new_path)),
                    paths,
                );
            } else {
                paths.extend(unique_id_paths);
                maybe_autocommit_schema(
                    autocommit,
                    project_path,
                    space,
                    paths,
                    if entry_in_sensitive_collection(space, &new_path) {
                        "Move collection entry with unique_id".to_string()
                    } else {
                        format!("Move {} with unique_id", basename(&new_path))
                    },
                )
                .await;
            }
        }
    }
    Ok(MoveOutcome {
        new_path,
        modified_paths,
    })
}

pub async fn nest(
    space: &str,
    path: &str,
    project_path: Option<&str>,
    state: &IndexState,
    updates: &IndexUpdateState,
    autocommit: Option<&AutocommitService>,
) -> Result<String, AppError> {
    reshape(space, path, true, project_path, state, updates, autocommit).await
}

pub async fn unnest(
    space: &str,
    path: &str,
    project_path: Option<&str>,
    state: &IndexState,
    updates: &IndexUpdateState,
    autocommit: Option<&AutocommitService>,
) -> Result<String, AppError> {
    reshape(space, path, false, project_path, state, updates, autocommit).await
}

async fn reshape(
    space: &str,
    path: &str,
    nesting: bool,
    project_path: Option<&str>,
    state: &IndexState,
    updates: &IndexUpdateState,
    autocommit: Option<&AutocommitService>,
) -> Result<String, AppError> {
    let backlinks = backlinks_for_space(state, space).await;
    ensure_backlinks_before_structural(state, project_path).await;
    revalidate_backlink_plan(state, space, project_path, path, false).await?;
    let new_path = if nesting {
        entry::nest_entry(
            Path::new(space),
            path,
            project_path
                .filter(|path| !path.is_empty())
                .is_none()
                .then_some(&backlinks),
        )?
    } else {
        entry::unnest_entry(
            Path::new(space),
            path,
            project_path
                .filter(|path| !path.is_empty())
                .is_none()
                .then_some(&backlinks),
        )?
    };
    if let Some(project) = project_path.filter(|path| !path.is_empty()) {
        let project = Path::new(project);
        let space_id = space_id_for_dir(state, space).await;
        let mut modified = state
            .update_links_on_rename_project(
                updates,
                project,
                space_id.as_deref(),
                path,
                &new_path,
                None,
            )
            .await
            .unwrap_or_else(|error| {
                tracing::warn!("cross-space reshape backlink rewrite failed: {error}");
                Vec::new()
            });
        modified.extend(
            rebase_project_source_after_move(
                state,
                updates,
                project_path,
                space,
                space_id.as_deref(),
                path,
                &new_path,
                if nesting {
                    "nest_entry"
                } else {
                    "unnest_entry"
                },
                true,
            )
            .await,
        );
        let modified = crate::files::backlinks::dedupe_modified_sources(modified);
        if let Some(autocommit) = autocommit {
            schedule_modified_source_spaces(
                state,
                autocommit,
                project_path,
                &modified,
                StructuralOp::Move(entry_commit_name(space, &new_path)),
            )
            .await;
        }
        let _ = state
            .remove_file_backlinks(project, space_id.as_deref(), path)
            .await;
        let _ = state
            .update_file_backlinks(project, space_id.as_deref(), &new_path)
            .await;
    } else {
        let _ = rebase_legacy_source_after_move(space, &backlinks, path, &new_path);
    }
    if let Some(autocommit) = autocommit {
        maybe_autocommit_structural_paths(
            autocommit,
            project_path,
            space,
            StructuralOp::Move(entry_commit_name(space, &new_path)),
            entry_paths_with_order(
                space,
                [
                    abs_entry_path(space, path),
                    abs_entry_path(space, &new_path),
                ],
            ),
        );
    }
    Ok(new_path)
}

pub async fn duplicate(
    space: &str,
    file_path: &str,
    project_path: Option<&str>,
    state: &IndexState,
    updates: &IndexUpdateState,
    autocommit: Option<&AutocommitService>,
) -> Result<Entry, AppError> {
    let old_name = entry_history_commit_name(space, file_path);
    let duplicated = entry::duplicate_entry(Path::new(space), file_path)?;
    let root_path = duplicated
        .path
        .rsplit_once('/')
        .filter(|(_, name)| name.eq_ignore_ascii_case("README.md"))
        .map(|(parent, _)| parent)
        .unwrap_or(&duplicated.path);
    update_index_tree_or_reindex(
        state,
        updates,
        project_path,
        space,
        root_path,
        "duplicate_entry",
    )
    .await;
    if let Some(autocommit) = autocommit {
        let mut paths = entry_paths_with_order(space, [abs_entry_path(space, root_path)]);
        let unique_id_paths = properties::unique_id_mutation_paths_for_entry_tree(
            Path::new(space),
            &duplicated.path,
        )?;
        if unique_id_paths.is_empty() {
            maybe_autocommit_structural_paths(
                autocommit,
                project_path,
                space,
                StructuralOp::Duplicate {
                    old: old_name,
                    new: entry_history_commit_name(space, &duplicated.path),
                },
                paths,
            );
        } else {
            paths.extend(unique_id_paths);
            maybe_autocommit_schema(
                autocommit,
                project_path,
                space,
                paths,
                if entry_in_sensitive_collection(space, file_path)
                    || entry_in_sensitive_collection(space, &duplicated.path)
                {
                    "Duplicate collection entry".to_string()
                } else {
                    format!(
                        "Duplicate {old_name} → {}",
                        entry_history_name(&duplicated.path)
                    )
                },
            )
            .await;
        }
    }
    Ok(duplicated)
}

async fn maybe_autocommit_schema(
    autocommit: &AutocommitService,
    project_path: Option<&str>,
    space: &str,
    paths: Vec<PathBuf>,
    message: String,
) {
    let Some(project) = project_path.filter(|path| !path.is_empty()) else {
        return;
    };
    if let Err(error) = autocommit
        .commit_paths_now(PathBuf::from(project), PathBuf::from(space), paths, message)
        .await
    {
        tracing::warn!("schema autocommit failed: {error}");
    }
}

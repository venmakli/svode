//! Structural workflows over the content tree: create, delete, move, rename,
//! nest/unnest, duplicate and the shape conversions.
//!
//! Each operation authorizes its touched-set, changes the source, rewrites the
//! links and relations it invalidates, republishes the derived projection and
//! hands the resulting history to the commit sink. Only the compound Collection
//! create rolls back; the other intents keep their existing partial outcomes.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::collections::engine::{self, CollectionSchema};
use crate::content_tree::policy::TreeIgnorePolicy;
use crate::git::access::ensure_mutation_paths_were_authorized;
use crate::git::path::{RootMode, normalize_repo_relative};
use crate::git::pending::StructuralOp;
use crate::index::backlinks::{BacklinkIndex, ModifiedLinkSource, dedupe_modified_sources};
use crate::index::state::IndexRuntimeState;
use crate::index::update::{self, IndexUpdateState};
use crate::page::PageError;
use crate::page::dates::GitDateExecutor;
use crate::page::entry::{self, Entry};

use super::commit::{StructuralCommitSink, schedule_structural_paths};
use super::naming::{
    abs_entry_path, basename, collection_schema_path, collection_schema_path_rel,
    entry_commit_name, entry_history_commit_name, entry_history_name,
    entry_in_sensitive_collection, entry_paths_with_order, entry_rename_op, normalize_rel_lossy,
    order_path, rel_changed_path, root_path_for_head, same_parent,
};
use super::plan::{delete_mutation_paths, revalidate_backlink_plan};

/// Shared runtime a structural operation publishes into.
pub struct StructureRuntime<'a, E> {
    pub index: &'a IndexRuntimeState,
    pub updates: &'a IndexUpdateState,
    pub git_dates: Option<&'a E>,
    pub commits: Option<&'a dyn StructuralCommitSink>,
}

impl<E> Clone for StructureRuntime<'_, E> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<E> Copy for StructureRuntime<'_, E> {}

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
    pub schema: CollectionSchema,
    pub allocate_unique_title: bool,
    pub project: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionCreateOutcome {
    pub collection_path: String,
    pub collection: Entry,
    pub schema: CollectionSchema,
    pub changed_paths: Vec<PathBuf>,
}

fn push_unique_path(paths: &mut Vec<String>, path: String) {
    if !paths.iter().any(|existing| existing == &path) {
        paths.push(path);
    }
}

/// Record the same structural op in every Space whose sources were rewritten.
async fn schedule_modified_source_spaces<E: GitDateExecutor>(
    runtime: StructureRuntime<'_, E>,
    project_path: Option<&str>,
    modified: &[ModifiedLinkSource],
    op: StructuralOp,
) {
    let (Some(commits), Some(project)) = (
        runtime.commits,
        project_path.filter(|path| !path.is_empty()),
    ) else {
        return;
    };
    let project = Path::new(project);
    let mut by_space: HashMap<PathBuf, Vec<PathBuf>> = HashMap::new();
    for item in modified {
        match runtime
            .index
            .space_path_of(project, item.space_id.as_deref())
            .await
        {
            Ok(space_path) => by_space
                .entry(space_path.clone())
                .or_default()
                .push(space_path.join(&item.path)),
            Err(error) => tracing::warn!("schedule modified backlink source failed: {error}"),
        }
    }
    for (space_path, paths) in by_space {
        commits.schedule(project, &space_path, op.clone(), paths);
    }
}

async fn ensure_backlinks_before_structural(state: &IndexRuntimeState, project_path: Option<&str>) {
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

/// Rewrite the links inside the single source that moved.
async fn rebase_project_source_after_move<E: GitDateExecutor>(
    runtime: StructureRuntime<'_, E>,
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
    match runtime
        .index
        .rebase_source_links_project(Path::new(project), space_id, old_path, new_path)
        .await
    {
        Ok(Some(source)) => {
            if publish_projection {
                let _ = update::publish_paths_or_repair(
                    runtime.index,
                    runtime.updates,
                    runtime.git_dates,
                    project_path,
                    space,
                    vec![Path::new(space).join(new_path)],
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

/// Rewrite the links inside every source of a moved folder.
pub(crate) async fn rebase_project_source_tree_after_move<E: GitDateExecutor>(
    runtime: StructureRuntime<'_, E>,
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
    let state = runtime.index;
    let root = Path::new(space);
    let files = match crate::content_tree::collect_markdown_paths(
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
            let rebased = crate::index::backlinks::rebase_source_links_between_moved_tree(
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
    let _ = update::publish_paths_or_repair(
        state,
        runtime.updates,
        runtime.git_dates,
        project_path,
        space,
        deleted
            .iter()
            .chain(&updated)
            .map(|path| Path::new(space).join(path))
            .collect(),
        context,
    )
    .await;
    if let Err(error) = update::rebase_space_collection_schema_manifest(
        state,
        runtime.updates,
        root,
        old_root,
        new_root,
    )
    .await
    {
        tracing::warn!("{context}: rebase collection schema manifest failed: {error}");
    }
    modified
}

/// Space without an open Project: rebase against the Space-local backlink index.
pub(crate) fn rebase_legacy_source_after_move(
    space: &str,
    backlinks: &BacklinkIndex,
    old_path: &str,
    new_path: &str,
) -> Result<bool, PageError> {
    let root = Path::new(space);
    let path = root.join(new_path);
    if !path.exists() {
        return Ok(false);
    }
    let content = fs::read_to_string(&path)?;
    let updated = crate::index::backlinks::rebase_source_links(&content, old_path, new_path);
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
    let Ok(files) = crate::content_tree::collect_markdown_paths(
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
        let updated = crate::index::backlinks::rebase_source_links_between_moved_tree(
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

pub async fn delete<E: GitDateExecutor>(
    space: &str,
    path: &str,
    project_path: Option<&str>,
    runtime: StructureRuntime<'_, E>,
) -> Result<DeleteOutcome, PageError> {
    let planned = delete_mutation_paths(space, project_path, path)?;
    ensure_mutation_paths_were_authorized(&planned)?;
    let state = runtime.index;
    let backlink_index = state.backlinks_for_space_dir(Path::new(space)).await;
    let deleted = entry::delete_with_project(
        space,
        path,
        Some(&backlink_index),
        project_path.filter(|path| !path.is_empty()),
    )?;
    let cascade_touched_by_space =
        super::naming::grouped_abs_paths_by_space(project_path, space, &deleted.cascade_touched);
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
            if let Err(error) = update::publish_managed_path(
                state,
                runtime.updates,
                runtime.git_dates,
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
            update::repair_space_dir(state, runtime.updates, runtime.git_dates, space).await;
        } else {
            for (owner_space, paths) in &cascade_touched_by_space {
                let _ = update::publish_paths_or_repair(
                    state,
                    runtime.updates,
                    runtime.git_dates,
                    Some(project),
                    &owner_space.to_string_lossy(),
                    paths.clone(),
                    "delete_content",
                )
                .await;
            }
        }
    } else {
        update::repair_space_dir(state, runtime.updates, runtime.git_dates, space).await;
    }

    if runtime.commits.is_some() {
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
            schedule_structural_paths(
                runtime.commits,
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
    commits: Option<&dyn StructuralCommitSink>,
) -> Result<String, PageError> {
    let folder_path = entry::create_folder(space, parent_path, name)?;
    schedule_structural_paths(
        commits,
        project_path,
        space,
        StructuralOp::Create(entry_commit_name(space, &folder_path)),
        entry_paths_with_order(space, [abs_entry_path(space, &folder_path)]),
    );
    Ok(folder_path)
}

/// Resolve the requested create parent. A leaf parent is reported together with
/// the bytes needed to restore it if the compound create later rolls back.
pub(crate) fn resolved_create_parent(
    space: &str,
    requested: Option<&str>,
) -> Result<(Option<String>, Option<(String, String, Vec<u8>)>), PageError> {
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
            return Err(PageError::FileNotFound(requested.to_string()));
        }
    } else {
        return Err(PageError::FileNotFound(requested.to_string()));
    };
    let stem = Path::new(&leaf)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or_else(|| PageError::General("parent Page has an invalid filename".into()))?;
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
    cause: PageError,
) -> PageError {
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
        PageError::Recovery {
            cause: cause.to_string(),
            paths: failed,
        }
    }
}

/// Compound create: Page, folder conversion and initial schema succeed together
/// or the Space is restored to its previous shape.
pub async fn create_collection<E, F, Fut, Err>(
    request: CollectionCreate,
    runtime: StructureRuntime<'_, E>,
    authorize: F,
) -> Result<CollectionCreateOutcome, Err>
where
    E: GitDateExecutor,
    F: FnOnce(Vec<PathBuf>) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<PathBuf>, Err>>,
    Err: From<PageError>,
{
    let (parent, parent_conversion) =
        resolved_create_parent(&request.space, request.parent_path.as_deref())
            .map_err(Err::from)?;
    let planned = entry::planned_source_create(
        &request.space,
        parent.as_deref(),
        &request.title,
        request.allocate_unique_title,
        false,
    )
    .map_err(Err::from)?;
    let collection_path = planned
        .path
        .strip_suffix(".md")
        .ok_or_else(|| {
            Err::from(PageError::General(
                "Collection Page must be Markdown".into(),
            ))
        })?
        .to_string();
    let prepared_schema = engine::prepare_initial_collection_schema(
        &request.space,
        &collection_path,
        request.schema,
        request.project.as_deref(),
    )
    .map_err(|error| Err::from(PageError::from(error)))?;
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
        runtime.index,
        runtime.updates,
        runtime.git_dates,
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
        .ok_or_else(|| {
            Err::from(PageError::General(
                "created Collection Page must be Markdown".into(),
            ))
        })?
        .to_string();
    if actual_collection_path != collection_path {
        return Err(Err::from(rollback_collection_create(
            &request.space,
            &page.page.path,
            &actual_collection_path,
            parent_conversion.as_ref(),
            order_before.as_deref(),
            PageError::General("Collection create plan changed before execution".into()),
        )));
    }
    let conversion = match convert_to_collection_with_publication(
        &request.space,
        &page.page.path,
        request.project.as_deref(),
        runtime,
        false,
    )
    .await
    {
        Ok(conversion) => conversion,
        Err(error) => {
            return Err(Err::from(rollback_collection_create(
                &request.space,
                &page.page.path,
                &collection_path,
                parent_conversion.as_ref(),
                order_before.as_deref(),
                error,
            )));
        }
    };
    let schema_outcome = match prepared_schema.apply() {
        Ok(outcome) => outcome,
        Err(error) => {
            return Err(Err::from(rollback_collection_create(
                &request.space,
                &page.page.path,
                &collection_path,
                parent_conversion.as_ref(),
                order_before.as_deref(),
                error.into(),
            )));
        }
    };
    update::publish_tree_or_repair(
        runtime.index,
        runtime.updates,
        runtime.git_dates,
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
    schedule_structural_paths(
        runtime.commits,
        request.project.as_deref(),
        &request.space,
        StructuralOp::Create(entry_history_commit_name(
            &request.space,
            &conversion.readme_path,
        )),
        changed_paths.clone(),
    );
    Ok(CollectionCreateOutcome {
        collection_path,
        collection: conversion.entry,
        schema: schema_outcome.value,
        changed_paths,
    })
}

pub async fn convert_to_folder<E: GitDateExecutor>(
    space: &str,
    file_path: &str,
    project_path: Option<&str>,
    runtime: StructureRuntime<'_, E>,
) -> Result<Entry, PageError> {
    convert_to_folder_with_publication(space, file_path, project_path, runtime, true).await
}

async fn convert_to_folder_with_publication<E: GitDateExecutor>(
    space: &str,
    file_path: &str,
    project_path: Option<&str>,
    runtime: StructureRuntime<'_, E>,
    publish_projection: bool,
) -> Result<Entry, PageError> {
    let state = runtime.index;
    let backlinks = state.backlinks_for_space_dir(Path::new(space)).await;
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
        let target_space_id = state.space_id_for_dir(Path::new(space)).await;
        let mut modified = state
            .update_links_on_rename_project(
                runtime.updates,
                runtime.git_dates,
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
                runtime,
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
        let modified = dedupe_modified_sources(modified);
        schedule_modified_source_spaces(
            runtime,
            project_path,
            &modified,
            StructuralOp::ConvertToFolder(entry_history_commit_name(space, &converted.path)),
        )
        .await;
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
        let _ = update::publish_paths_or_repair(
            state,
            runtime.updates,
            runtime.git_dates,
            project_path,
            space,
            std::slice::from_ref(&old_leaf)
                .iter()
                .chain(std::slice::from_ref(&converted.path))
                .map(|path| Path::new(space).join(path))
                .collect(),
            "convert_to_folder",
        )
        .await;
    }
    schedule_structural_paths(
        runtime.commits,
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
    Ok(converted)
}

pub async fn convert_to_leaf<E: GitDateExecutor>(
    space: &str,
    file_path: &str,
    project_path: Option<&str>,
    runtime: StructureRuntime<'_, E>,
) -> Result<Entry, PageError> {
    let state = runtime.index;
    let backlinks = state.backlinks_for_space_dir(Path::new(space)).await;
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
        let target_space_id = state.space_id_for_dir(Path::new(space)).await;
        let mut modified = state
            .update_links_on_rename_project(
                runtime.updates,
                runtime.git_dates,
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
                runtime,
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
        let modified = dedupe_modified_sources(modified);
        schedule_modified_source_spaces(
            runtime,
            project_path,
            &modified,
            StructuralOp::ConvertToLeaf(entry_history_commit_name(space, &converted.path)),
        )
        .await;
        let _ = state
            .remove_file_backlinks(project, target_space_id.as_deref(), &old_readme)
            .await;
        let _ = state
            .update_file_backlinks(project, target_space_id.as_deref(), &converted.path)
            .await;
    } else {
        let _ = rebase_legacy_source_after_move(space, &backlinks, &old_readme, &converted.path);
    }
    let _ = update::publish_paths_or_repair(
        state,
        runtime.updates,
        runtime.git_dates,
        project_path,
        space,
        std::slice::from_ref(&old_readme)
            .iter()
            .chain(std::slice::from_ref(&converted.path))
            .map(|path| Path::new(space).join(path))
            .collect(),
        "convert_to_leaf",
    )
    .await;
    schedule_structural_paths(
        runtime.commits,
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
    Ok(converted)
}

pub async fn convert_to_collection<E: GitDateExecutor>(
    space: &str,
    path: &str,
    project_path: Option<&str>,
    runtime: StructureRuntime<'_, E>,
) -> Result<ConvertToCollectionOutcome, PageError> {
    convert_to_collection_with_publication(space, path, project_path, runtime, true).await
}

async fn convert_to_collection_with_publication<E: GitDateExecutor>(
    space: &str,
    path: &str,
    project_path: Option<&str>,
    runtime: StructureRuntime<'_, E>,
    publish_projection: bool,
) -> Result<ConvertToCollectionOutcome, PageError> {
    let old_path = normalize_repo_relative(path, RootMode::Reject)?;
    let source_abs = Path::new(space).join(&old_path);
    let metadata = fs::metadata(&source_abs).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => PageError::FileNotFound(old_path.clone()),
        _ => PageError::Io(error),
    })?;

    let (collection_path, readme_path, converted, source_moved) = if metadata.is_dir() {
        let readme_path = format!("{old_path}/README.md");
        let schema_path = collection_schema_path(space, &old_path);
        if schema_path.exists() {
            return Err(PageError::FileAlreadyExists(rel_changed_path(
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
            return Err(PageError::General(format!(
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
                runtime,
                publish_projection,
            )
            .await?;
            let readme_path = converted.path.clone();
            let collection_path = Path::new(&readme_path)
                .parent()
                .map(normalize_rel_lossy)
                .ok_or_else(|| {
                    PageError::General("converted entry has no collection folder".to_string())
                })?;
            entry::convert_entry_to_nested_collection(Path::new(space), &readme_path)?;
            let converted = entry::read(space, &readme_path)?;
            (collection_path, readme_path, converted, true)
        }
    } else {
        return Err(PageError::General(format!(
            "path must reference a markdown document or folder: {old_path}"
        )));
    };

    if publish_projection {
        update::publish_tree_or_repair(
            runtime.index,
            runtime.updates,
            runtime.git_dates,
            project_path,
            space,
            &collection_path,
            "convert_to_collection",
        )
        .await;
    }
    if runtime.commits.is_some() {
        let mut paths = vec![
            abs_entry_path(space, &readme_path),
            collection_schema_path(space, &collection_path),
        ];
        if source_moved {
            paths = entry_paths_with_order(space, paths);
            paths.push(abs_entry_path(space, &old_path));
        }
        schedule_structural_paths(
            runtime.commits,
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

pub async fn rename<E: GitDateExecutor>(
    space: &str,
    from: &str,
    to: &str,
    project_path: Option<&str>,
    runtime: StructureRuntime<'_, E>,
) -> Result<Vec<String>, PageError> {
    if !same_parent(from, to) {
        return Err(PageError::General(
            "rename_entry cannot change parent; use move_entry to move an entry".to_string(),
        ));
    }
    apply_move(space, from, Some(to), None, project_path, runtime)
        .await
        .map(|outcome| outcome.modified_paths)
}

pub async fn move_entry<E: GitDateExecutor>(
    space: &str,
    from: &str,
    to_parent: &str,
    project_path: Option<&str>,
    runtime: StructureRuntime<'_, E>,
) -> Result<String, PageError> {
    apply_move(space, from, None, Some(to_parent), project_path, runtime)
        .await
        .map(|outcome| outcome.new_path)
}

struct MoveOutcome {
    new_path: String,
    modified_paths: Vec<String>,
}

async fn apply_move<E: GitDateExecutor>(
    space: &str,
    from: &str,
    rename_to: Option<&str>,
    to_parent: Option<&str>,
    project_path: Option<&str>,
    runtime: StructureRuntime<'_, E>,
) -> Result<MoveOutcome, PageError> {
    let state = runtime.index;
    let backlinks = state.backlinks_for_space_dir(Path::new(space)).await;
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
    let policy_paths = crate::storage::routes::rebase_managed_attachment_routes(
        space,
        project_path,
        from,
        &new_path,
        was_dir,
    )?;
    let mut modified_paths = Vec::new();
    if let Some(project) = project_path.filter(|path| !path.is_empty()) {
        let project = Path::new(project);
        let space_id = state.space_id_for_dir(Path::new(space)).await;
        let mut modified = if was_dir {
            state
                .update_links_on_folder_rename_project(
                    runtime.updates,
                    runtime.git_dates,
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
                    runtime.updates,
                    runtime.git_dates,
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
                runtime,
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
                runtime,
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
        let modified = dedupe_modified_sources(modified);
        modified_paths = modified.iter().map(|source| source.path.clone()).collect();
        schedule_modified_source_spaces(
            runtime,
            project_path,
            &modified,
            if rename_to.is_some() {
                entry_rename_op(space, from, &new_path)
            } else {
                StructuralOp::Move(entry_commit_name(space, &new_path))
            },
        )
        .await;
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
    if let Some(commits) = runtime.commits {
        let mut paths =
            entry_paths_with_order(space, [old_abs.clone(), abs_entry_path(space, &new_path)]);
        paths.extend(policy_paths);
        if rename_to.is_some() {
            schedule_structural_paths(
                Some(commits),
                project_path,
                space,
                entry_rename_op(space, from, &new_path),
                paths,
            );
        } else {
            let unique_id_paths =
                engine::unique_id_mutation_paths_for_entry_tree(Path::new(space), &new_path)?;
            if unique_id_paths.is_empty() {
                schedule_structural_paths(
                    Some(commits),
                    project_path,
                    space,
                    StructuralOp::Move(entry_commit_name(space, &new_path)),
                    paths,
                );
            } else {
                paths.extend(unique_id_paths);
                commit_schema_now(
                    commits,
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

pub async fn nest<E: GitDateExecutor>(
    space: &str,
    path: &str,
    project_path: Option<&str>,
    runtime: StructureRuntime<'_, E>,
) -> Result<String, PageError> {
    reshape(space, path, true, project_path, runtime).await
}

pub async fn unnest<E: GitDateExecutor>(
    space: &str,
    path: &str,
    project_path: Option<&str>,
    runtime: StructureRuntime<'_, E>,
) -> Result<String, PageError> {
    reshape(space, path, false, project_path, runtime).await
}

async fn reshape<E: GitDateExecutor>(
    space: &str,
    path: &str,
    nesting: bool,
    project_path: Option<&str>,
    runtime: StructureRuntime<'_, E>,
) -> Result<String, PageError> {
    let state = runtime.index;
    let backlinks = state.backlinks_for_space_dir(Path::new(space)).await;
    ensure_backlinks_before_structural(state, project_path).await;
    revalidate_backlink_plan(state, space, project_path, path, false).await?;
    let local_backlinks = project_path
        .filter(|path| !path.is_empty())
        .is_none()
        .then_some(&*backlinks);
    let new_path = if nesting {
        entry::nest_entry(Path::new(space), path, local_backlinks)?
    } else {
        entry::unnest_entry(Path::new(space), path, local_backlinks)?
    };
    if let Some(project) = project_path.filter(|path| !path.is_empty()) {
        let project = Path::new(project);
        let space_id = state.space_id_for_dir(Path::new(space)).await;
        let mut modified = state
            .update_links_on_rename_project(
                runtime.updates,
                runtime.git_dates,
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
                runtime,
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
        let modified = dedupe_modified_sources(modified);
        schedule_modified_source_spaces(
            runtime,
            project_path,
            &modified,
            StructuralOp::Move(entry_commit_name(space, &new_path)),
        )
        .await;
        let _ = state
            .remove_file_backlinks(project, space_id.as_deref(), path)
            .await;
        let _ = state
            .update_file_backlinks(project, space_id.as_deref(), &new_path)
            .await;
    } else {
        let _ = rebase_legacy_source_after_move(space, &backlinks, path, &new_path);
    }
    schedule_structural_paths(
        runtime.commits,
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
    Ok(new_path)
}

pub async fn duplicate<E: GitDateExecutor>(
    space: &str,
    file_path: &str,
    project_path: Option<&str>,
    runtime: StructureRuntime<'_, E>,
) -> Result<Entry, PageError> {
    let old_name = entry_history_commit_name(space, file_path);
    let duplicated = entry::duplicate_entry(Path::new(space), file_path)?;
    let root_path = duplicated
        .path
        .rsplit_once('/')
        .filter(|(_, name)| name.eq_ignore_ascii_case("README.md"))
        .map(|(parent, _)| parent)
        .unwrap_or(&duplicated.path);
    update::publish_tree_or_repair(
        runtime.index,
        runtime.updates,
        runtime.git_dates,
        project_path,
        space,
        root_path,
        "duplicate_entry",
    )
    .await;
    if let Some(commits) = runtime.commits {
        let mut paths = entry_paths_with_order(space, [abs_entry_path(space, root_path)]);
        let unique_id_paths =
            engine::unique_id_mutation_paths_for_entry_tree(Path::new(space), &duplicated.path)?;
        if unique_id_paths.is_empty() {
            schedule_structural_paths(
                Some(commits),
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
            commit_schema_now(
                commits,
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

/// Allocated unique ids must reach history immediately, so they are committed
/// outside the pending structural batch.
async fn commit_schema_now(
    commits: &dyn StructuralCommitSink,
    project_path: Option<&str>,
    space: &str,
    paths: Vec<PathBuf>,
    message: String,
) {
    let Some(project) = project_path.filter(|path| !path.is_empty()) else {
        return;
    };
    commits
        .commit_now(Path::new(project), Path::new(space), paths, message)
        .await;
}

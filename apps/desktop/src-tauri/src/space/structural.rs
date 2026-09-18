use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::error::AppError;
use crate::files::tree_policy::{TreeIgnorePolicy, TreePathKind};
use crate::files::{BacklinkIndex, Entry, ModifiedLinkSource, entry};
use crate::git::access::ensure_mutation_paths_were_authorized;
use crate::git::autocommit::{AutocommitService, StructuralOp};
use crate::index::update::IndexUpdateState;
use crate::index::{self, IndexKey, IndexState};
use crate::properties;

use super::config;

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

async fn replace_index_entries_or_reindex(
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
) -> Vec<ModifiedLinkSource> {
    let Some(project) = project_path.filter(|path| !path.is_empty()) else {
        return Vec::new();
    };
    match state
        .rebase_source_links_project(Path::new(project), space_id, old_path, new_path)
        .await
    {
        Ok(Some(source)) => {
            update_index_entry_or_reindex(state, updates, project_path, space, new_path, context)
                .await;
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

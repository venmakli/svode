use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::error::AppError;
use crate::files::{entry, tree, BacklinkIndex, BacklinkInfo, Entry, FileWatcher, LinkValidation, TreeNode, WriteNonceRegistry, WriteResult};
use crate::git::autocommit::{AutocommitService, StructuralOp};
use crate::index::{self, IndexKey, IndexState};
use crate::space::config;

fn basename(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_string()
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
    autocommit.schedule_structural(
        PathBuf::from(proj),
        PathBuf::from(space_path),
        op,
    );
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
    let result = entry::write(
        &space,
        &path,
        &content,
        title.as_deref(),
        icon.as_deref(),
        extra,
        existing_id.as_deref(),
        Some(&backlink_index),
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
        if result.new_path.is_some() {
            let abs_old = Path::new(&space).join(&path);
            if let Err(e) = index::update::delete_entry(&index_state, project, &abs_old).await {
                tracing::warn!("index delete stale path failed for {path}: {e}");
            }
        }
        let target = result.new_path.clone().unwrap_or_else(|| path.clone());
        let abs_target = Path::new(&space).join(&target);
        if let Err(e) =
            index::update::update_entry(&index_state, project, &abs_target).await
        {
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
    entry::rename(&space, &from, &to)?;
    let modified = backlink_index
        .update_links_on_rename(Path::new(&space), &from, &to, None)
        .unwrap_or_default();
    let _ = backlink_index.update_file(Path::new(&space), &to);
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
    let new_path = entry::move_entry(
        Path::new(&space),
        &from,
        &to_parent,
        Some(&backlink_index),
    )?;
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
    index_state: State<'_, IndexState>,
) -> Result<Vec<BacklinkInfo>, AppError> {
    let backlink_index = backlinks_for_space(&index_state, &space).await;
    if !backlink_index.is_built() {
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
pub fn validate_links(
    space: String,
    path: String,
) -> Result<Vec<LinkValidation>, AppError> {
    crate::files::backlinks::validate_links(Path::new(&space), &path)
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
pub fn unwatch_space(
    space: String,
    watcher: State<'_, FileWatcher>,
) -> Result<(), AppError> {
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
    let new_path = entry::nest_entry(
        Path::new(&space),
        &path,
        Some(&backlink_index),
    )?;
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
    let new_path = entry::unnest_entry(
        Path::new(&space),
        &path,
        Some(&backlink_index),
    )?;
    maybe_autocommit_structural(
        &autocommit,
        project_path.as_deref(),
        &space,
        StructuralOp::Move(basename(&new_path)),
    );
    Ok(new_path)
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

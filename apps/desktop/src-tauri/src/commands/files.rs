use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::error::AppError;
use crate::files::{entry, tree, BacklinkIndex, BacklinkInfo, Entry, FileWatcher, LinkValidation, TreeNode, WriteNonceRegistry, WriteResult};
use crate::git::autocommit::{AutocommitService, StructuralOp};
use crate::index::{self, IndexState};
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
    backlink_index: State<'_, Arc<BacklinkIndex>>,
    index_state: State<'_, IndexState>,
    nonces: State<'_, Arc<WriteNonceRegistry>>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<WriteResult, AppError> {
    let skip_rename = skip_rename.unwrap_or(false);
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

    // Update SQLite index for the (possibly renamed) target path.
    // On rename: delete the stale row first, then upsert the new path. The
    // reverse order would let a concurrent write to the new path get clobbered
    // by the stale-row delete.
    if let Ok(pool) = index_state.get_or_create(&space).await {
        if result.new_path.is_some() {
            if let Err(e) = index::update::delete_entry_path(&pool, &path).await {
                tracing::warn!("index delete stale path failed for {path}: {e}");
            }
        }
        let target = result.new_path.clone().unwrap_or_else(|| path.clone());
        if let Err(e) =
            index::update::update_entry(&pool, Path::new(&space), &target).await
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
    backlink_index: State<'_, Arc<BacklinkIndex>>,
    index_state: State<'_, IndexState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<(), AppError> {
    entry::delete(&space, &path, Some(&backlink_index))?;

    if let Ok(pool) = index_state.get_or_create(&space).await {
        if let Err(e) = index::update::delete_entry_path(&pool, &path).await {
            tracing::warn!("index delete_entry_path failed for {path}: {e}");
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
pub fn rename_entry(
    space: String,
    from: String,
    to: String,
    project_path: Option<String>,
    backlink_index: State<'_, Arc<BacklinkIndex>>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<Vec<String>, AppError> {
    entry::rename(&space, &from, &to)?;
    let modified = backlink_index
        .update_links_on_rename(Path::new(&space), &from, &to)
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
pub fn move_entry(
    space: String,
    from: String,
    to_parent: String,
    project_path: Option<String>,
    backlink_index: State<'_, Arc<BacklinkIndex>>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<String, AppError> {
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
pub fn get_backlinks(
    space: String,
    target_path: String,
    backlink_index: State<'_, Arc<BacklinkIndex>>,
) -> Result<Vec<BacklinkInfo>, AppError> {
    if !backlink_index.is_built() {
        backlink_index.build(Path::new(&space))?;
    }
    Ok(backlink_index.get_backlinks(&target_path))
}

#[tauri::command]
pub fn rebuild_backlinks(
    space: String,
    backlink_index: State<'_, Arc<BacklinkIndex>>,
) -> Result<(), AppError> {
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
pub fn nest_entry(
    space: String,
    path: String,
    project_path: Option<String>,
    backlink_index: State<'_, Arc<BacklinkIndex>>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<String, AppError> {
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
pub fn unnest_entry(
    space: String,
    path: String,
    project_path: Option<String>,
    backlink_index: State<'_, Arc<BacklinkIndex>>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<String, AppError> {
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

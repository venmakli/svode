use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::error::AppError;
use crate::files::{entry, tree, BacklinkIndex, BacklinkInfo, Entry, FileWatcher, TreeNode, WriteResult};
use crate::workspace::config;

#[tauri::command]
pub fn list_entries(workspace: String) -> Result<Vec<TreeNode>, AppError> {
    tree::build_tree(&workspace)
}

#[tauri::command]
pub fn create_entry(
    workspace: String,
    parent_path: Option<String>,
    title: String,
) -> Result<Entry, AppError> {
    entry::create(&workspace, parent_path.as_deref(), &title)
}

#[tauri::command]
pub fn create_folder(
    workspace: String,
    parent_path: Option<String>,
    name: String,
) -> Result<String, AppError> {
    entry::create_folder(&workspace, parent_path.as_deref(), &name)
}

#[tauri::command]
pub fn read_entry(workspace: String, path: String) -> Result<Entry, AppError> {
    entry::read(&workspace, &path)
}

#[tauri::command]
pub fn write_entry(
    workspace: String,
    path: String,
    content: String,
    title: Option<String>,
    icon: Option<String>,
    extra: Option<HashMap<String, serde_yml::Value>>,
    backlink_index: State<'_, Arc<BacklinkIndex>>,
) -> Result<WriteResult, AppError> {
    entry::write(
        &workspace,
        &path,
        &content,
        title.as_deref(),
        icon.as_deref(),
        extra,
        Some(&backlink_index),
    )
}

#[tauri::command]
pub fn delete_entry(
    workspace: String,
    path: String,
    backlink_index: State<'_, Arc<BacklinkIndex>>,
) -> Result<(), AppError> {
    entry::delete(&workspace, &path, Some(&backlink_index))
}

#[tauri::command]
pub fn rename_entry(
    workspace: String,
    from: String,
    to: String,
    backlink_index: State<'_, Arc<BacklinkIndex>>,
) -> Result<(), AppError> {
    entry::rename(&workspace, &from, &to)?;
    let _ = backlink_index.update_links_on_rename(Path::new(&workspace), &from, &to);
    let _ = backlink_index.update_file(Path::new(&workspace), &to);
    Ok(())
}

#[tauri::command]
pub fn move_entry(
    workspace: String,
    from: String,
    to_parent: String,
    backlink_index: State<'_, Arc<BacklinkIndex>>,
) -> Result<String, AppError> {
    entry::move_entry(
        Path::new(&workspace),
        &from,
        &to_parent,
        Some(&backlink_index),
    )
}

#[tauri::command]
pub fn get_backlinks(
    workspace: String,
    target_path: String,
    backlink_index: State<'_, Arc<BacklinkIndex>>,
) -> Result<Vec<BacklinkInfo>, AppError> {
    if !backlink_index.is_built() {
        backlink_index.build(Path::new(&workspace))?;
    }
    Ok(backlink_index.get_backlinks(&target_path))
}

#[tauri::command]
pub fn rebuild_backlinks(
    workspace: String,
    backlink_index: State<'_, Arc<BacklinkIndex>>,
) -> Result<(), AppError> {
    backlink_index.build(Path::new(&workspace))
}

#[tauri::command]
pub fn watch_workspace(
    workspace: String,
    app: AppHandle,
    watcher: State<'_, FileWatcher>,
) -> Result<(), AppError> {
    watcher.watch(workspace, app)
}

#[tauri::command]
pub fn unwatch_workspace(
    workspace: String,
    watcher: State<'_, FileWatcher>,
) -> Result<(), AppError> {
    watcher.unwatch(&workspace)
}

#[tauri::command]
pub fn nest_entry(
    workspace: String,
    path: String,
    backlink_index: State<'_, Arc<BacklinkIndex>>,
) -> Result<String, AppError> {
    entry::nest_entry(
        Path::new(&workspace),
        &path,
        Some(&backlink_index),
    )
}

#[tauri::command]
pub fn unnest_entry(
    workspace: String,
    path: String,
    backlink_index: State<'_, Arc<BacklinkIndex>>,
) -> Result<String, AppError> {
    entry::unnest_entry(
        Path::new(&workspace),
        &path,
        Some(&backlink_index),
    )
}

#[tauri::command]
pub fn read_tree_order(workspace: String) -> Result<HashMap<String, Vec<String>>, AppError> {
    Ok(tree::read_order(Path::new(&workspace)))
}

#[tauri::command]
pub fn save_tree_order(
    workspace: String,
    order: HashMap<String, Vec<String>>,
) -> Result<(), AppError> {
    tree::write_order(Path::new(&workspace), &order)
}

#[tauri::command]
pub fn get_expanded_paths(workspace: String) -> Result<Vec<String>, AppError> {
    let local = config::read_local_config(Path::new(&workspace))?;
    Ok(local.expanded_paths)
}

#[tauri::command]
pub fn save_expanded_paths(workspace: String, paths: Vec<String>) -> Result<(), AppError> {
    let mut local = config::read_local_config(Path::new(&workspace))?;
    local.expanded_paths = paths;
    config::write_local_config(Path::new(&workspace), &local)
}

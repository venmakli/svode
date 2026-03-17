use tauri::{AppHandle, State};

use crate::error::AppError;
use crate::files::{entry, tree, Entry, FileWatcher, TreeNode};

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
pub fn read_entry(workspace: String, path: String) -> Result<Entry, AppError> {
    entry::read(&workspace, &path)
}

#[tauri::command]
pub fn write_entry(workspace: String, path: String, content: String) -> Result<(), AppError> {
    entry::write(&workspace, &path, &content)
}

#[tauri::command]
pub fn delete_entry(workspace: String, path: String) -> Result<(), AppError> {
    entry::delete(&workspace, &path)
}

#[tauri::command]
pub fn rename_entry(workspace: String, from: String, to: String) -> Result<(), AppError> {
    entry::rename(&workspace, &from, &to)
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

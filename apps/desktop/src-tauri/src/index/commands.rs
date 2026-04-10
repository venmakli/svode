use std::path::Path;
use tauri::State;

use crate::error::AppError;
use crate::index::search::{self, SearchResult};
use crate::index::{reindex, IndexState};

const DEFAULT_LIMIT: i64 = 20;

#[tauri::command]
pub async fn reindex_workspace(
    state: State<'_, IndexState>,
    workspace_path: String,
) -> Result<(), AppError> {
    let pool = state.get_or_create(&workspace_path).await?;
    reindex::full_reindex(&pool, Path::new(&workspace_path)).await
}

#[tauri::command]
pub async fn search_entries_by_title(
    state: State<'_, IndexState>,
    workspace_path: String,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<SearchResult>, AppError> {
    let pool = state.get_or_create(&workspace_path).await?;
    search::search_by_title(&pool, &query, limit.unwrap_or(DEFAULT_LIMIT)).await
}

#[tauri::command]
pub async fn search_entries(
    state: State<'_, IndexState>,
    workspace_path: String,
    query: String,
    entry_type: Option<String>,
    table_name: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<SearchResult>, AppError> {
    let pool = state.get_or_create(&workspace_path).await?;
    search::search_fts(
        &pool,
        &query,
        entry_type.as_deref(),
        table_name.as_deref(),
        limit.unwrap_or(DEFAULT_LIMIT),
    )
    .await
}

#[tauri::command]
pub async fn recent_entries(
    state: State<'_, IndexState>,
    workspace_path: String,
    limit: Option<i64>,
) -> Result<Vec<SearchResult>, AppError> {
    let pool = state.get_or_create(&workspace_path).await?;
    search::recent(&pool, limit.unwrap_or(DEFAULT_LIMIT)).await
}

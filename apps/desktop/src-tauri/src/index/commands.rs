use std::path::PathBuf;

use tauri::{AppHandle, Manager, State};

use crate::error::AppError;
use crate::index::service::{self, SearchResponse, SearchScope};
use crate::index::update::IndexUpdateState;
use crate::index::{IndexKey, IndexState};
use svode_core::index::knowledge::{KnowledgeFilters, KnowledgeResponse, KnowledgeScope};

#[tauri::command]
pub async fn reindex_space(
    state: State<'_, IndexState>,
    updates: State<'_, IndexUpdateState>,
    project_path: String,
    space_id: Option<String>,
) -> Result<(), AppError> {
    let project = PathBuf::from(project_path);
    let key = match space_id {
        Some(space_id) => IndexKey::Space { project, space_id },
        None => IndexKey::Root(project),
    };
    service::repair_space(&state, &updates, &key).await
}

#[tauri::command]
pub async fn reindex_project(app: AppHandle, project_path: String) -> Result<(), AppError> {
    service::repair_project(
        app.state::<IndexState>().inner().clone(),
        app.state::<IndexUpdateState>().inner().clone(),
        PathBuf::from(project_path),
    )
    .await;
    Ok(())
}

#[tauri::command]
pub async fn search_project_entries_by_title(
    state: State<'_, IndexState>,
    project_path: String,
    query: String,
    scope: Option<SearchScope>,
    limit: Option<i64>,
) -> Result<SearchResponse, AppError> {
    service::search_by_title(&state, PathBuf::from(project_path), query, scope, limit).await
}

#[tauri::command]
pub async fn search_project_entries(
    state: State<'_, IndexState>,
    project_path: String,
    query: String,
    entry_type: Option<String>,
    table_name: Option<String>,
    scope: Option<SearchScope>,
    limit: Option<i64>,
) -> Result<SearchResponse, AppError> {
    service::search_content(
        &state,
        PathBuf::from(project_path),
        query,
        entry_type,
        table_name,
        scope,
        limit,
    )
    .await
}

#[tauri::command]
pub async fn recent_project_entries(
    state: State<'_, IndexState>,
    project_path: String,
    scope: Option<SearchScope>,
    limit: Option<i64>,
) -> Result<SearchResponse, AppError> {
    service::recent(&state, PathBuf::from(project_path), scope, limit).await
}

#[tauri::command]
pub async fn count_broken_links(
    state: State<'_, IndexState>,
    project_path: String,
) -> Result<i64, AppError> {
    service::count_broken_links(&state, &PathBuf::from(project_path)).await
}

#[tauri::command]
pub async fn get_knowledge_documents(
    state: State<'_, IndexState>,
    project_path: String,
    scope: Option<KnowledgeScope>,
    query: Option<String>,
    node_offset: Option<usize>,
    edge_offset: Option<usize>,
    node_limit: Option<usize>,
    edge_limit: Option<usize>,
    search_limit: Option<usize>,
    filters: Option<KnowledgeFilters>,
) -> Result<KnowledgeResponse, AppError> {
    Ok(service::read_project_knowledge(
        &state,
        &PathBuf::from(project_path),
        scope,
        query.as_deref(),
        node_offset,
        edge_offset,
        node_limit,
        edge_limit,
        search_limit,
        filters.unwrap_or_default(),
    )
    .await)
}

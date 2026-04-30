use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
use tauri::State;
use tokio::sync::Semaphore;

use crate::error::AppError;
use crate::index::search::{self, SearchResult};
use crate::index::{reindex, IndexKey, IndexState};

const DEFAULT_LIMIT: i64 = 20;
const REINDEX_PARALLELISM: usize = 4;

/// Optional scope for project-wide search/reindex IPCs.
///
/// `Project` (the default) → fan out across the root pool + every ready
/// space pool. `Space { space_id }` → restrict to one pool.
/// `Space { space_id: None }` is equivalent to root-only.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum SearchScope {
    Project,
    Space { space_id: Option<String> },
}

async fn scope_to_keys(
    state: &IndexState,
    project: &PathBuf,
    scope: Option<SearchScope>,
) -> Vec<IndexKey> {
    match scope {
        Some(SearchScope::Space { space_id: Some(id) }) => vec![IndexKey::Space {
            project: project.clone(),
            space_id: id,
        }],
        Some(SearchScope::Space { space_id: None }) => vec![IndexKey::Root(project.clone())],
        Some(SearchScope::Project) | None => state.keys_for_project(project).await,
    }
}

/// Reindex one space (`spaceId = null` → root pool).
#[tauri::command]
pub async fn reindex_space(
    state: State<'_, IndexState>,
    project_path: String,
    space_id: Option<String>,
) -> Result<(), AppError> {
    let project = PathBuf::from(&project_path);
    let key = match space_id {
        Some(id) => IndexKey::Space {
            project: project.clone(),
            space_id: id,
        },
        None => IndexKey::Root(project.clone()),
    };

    let pool = state.get_or_create(&key).await?;
    let dir = state.dir_for_key(&key).await?;
    let skip = state.skip_folders_for(&key).await;
    let lock = state.reindex_lock(&key).await;
    let _guard = lock.lock().await;
    reindex::full_reindex(&pool, &dir, &skip).await
}

/// Reindex root + every ready child space pool. Bounded parallelism (4).
#[tauri::command]
pub async fn reindex_project(
    state: State<'_, IndexState>,
    project_path: String,
) -> Result<(), AppError> {
    let project = PathBuf::from(&project_path);
    let keys = state.keys_for_project(&project).await;

    let semaphore = Arc::new(Semaphore::new(REINDEX_PARALLELISM));
    let mut handles = Vec::new();
    for key in keys {
        let pool = state.get_or_create(&key).await?;
        let dir = state.dir_for_key(&key).await?;
        let skip = state.skip_folders_for(&key).await;
        let lock = state.reindex_lock(&key).await;
        let sem = semaphore.clone();
        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire_owned().await.ok();
            let _guard = lock.lock().await;
            if let Err(e) = reindex::full_reindex(&pool, &dir, &skip).await {
                tracing::warn!(
                    "reindex_project: full_reindex failed for {}: {e}",
                    dir.display()
                );
            }
        }));
    }
    for h in handles {
        let _ = h.await;
    }
    Ok(())
}

/// Project-wide search by title prefix/substring. Fans out across pools and
/// merges results in-process.
#[tauri::command]
pub async fn search_project_entries_by_title(
    state: State<'_, IndexState>,
    project_path: String,
    query: String,
    scope: Option<SearchScope>,
    limit: Option<i64>,
) -> Result<Vec<SearchResult>, AppError> {
    let project = PathBuf::from(&project_path);
    let keys = scope_to_keys(&state, &project, scope).await;
    let lim = limit.unwrap_or(DEFAULT_LIMIT);

    let mut results: Vec<SearchResult> = Vec::new();
    for key in keys {
        let pool = state.get_or_create(&key).await?;
        let mut hits = search::search_by_title(&pool, &query, lim).await?;
        results.append(&mut hits);
    }
    results.truncate(lim as usize);
    Ok(results)
}

/// Project-wide FTS5 search. Same fan-out shape as
/// `search_project_entries_by_title`.
#[tauri::command]
pub async fn search_project_entries(
    state: State<'_, IndexState>,
    project_path: String,
    query: String,
    entry_type: Option<String>,
    table_name: Option<String>,
    scope: Option<SearchScope>,
    limit: Option<i64>,
) -> Result<Vec<SearchResult>, AppError> {
    let project = PathBuf::from(&project_path);
    let keys = scope_to_keys(&state, &project, scope).await;
    let lim = limit.unwrap_or(DEFAULT_LIMIT);

    let mut results: Vec<SearchResult> = Vec::new();
    for key in keys {
        let pool = state.get_or_create(&key).await?;
        let mut hits = search::search_fts(
            &pool,
            &query,
            entry_type.as_deref(),
            table_name.as_deref(),
            lim,
        )
        .await?;
        results.append(&mut hits);
    }
    results.truncate(lim as usize);
    Ok(results)
}

/// Project-wide "recent" listing — merges then truncates.
#[tauri::command]
pub async fn recent_project_entries(
    state: State<'_, IndexState>,
    project_path: String,
    scope: Option<SearchScope>,
    limit: Option<i64>,
) -> Result<Vec<SearchResult>, AppError> {
    let project = PathBuf::from(&project_path);
    let keys = scope_to_keys(&state, &project, scope).await;
    let lim = limit.unwrap_or(DEFAULT_LIMIT);

    let mut results: Vec<SearchResult> = Vec::new();
    for key in keys {
        let pool = state.get_or_create(&key).await?;
        let mut hits = search::recent(&pool, lim).await?;
        results.append(&mut hits);
    }
    results.truncate(lim as usize);
    Ok(results)
}

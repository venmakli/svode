use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::error::AppError;
use crate::index::search::{self, SearchResult};
use crate::index::{reindex, IndexKey, IndexState};

const DEFAULT_LIMIT: i64 = 20;
const REINDEX_PARALLELISM: usize = 4;

const ICON_PAGE: &str = "\u{1F4C4}"; // 📄
const ICON_TABLE_ROW: &str = "\u{1F4CB}"; // 📋

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

/// Per-pool search hit shape returned to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchItem {
    pub id: String,
    pub space_id: Option<String>,
    pub space_path: String,
    pub space_name: String,
    pub path: String,
    pub title: String,
    #[serde(rename = "type")]
    pub entry_type: String,
    pub table_name: Option<String>,
    pub snippet: Option<String>,
    pub icon: String,
}

/// Envelope for fan-out search responses. `indexed_spaces` / `total_spaces`
/// power the Command Palette progress hint (Phase 6 §Q3).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub items: Vec<SearchItem>,
    pub indexed_spaces: usize,
    pub total_spaces: usize,
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

fn icon_for(entry_type: &str) -> String {
    match entry_type {
        "table_row" => ICON_TABLE_ROW.to_string(),
        _ => ICON_PAGE.to_string(),
    }
}

/// Per-pool fan-out result: ordered hits + the originating key (so the merge
/// stage can attach `space_id` / `space_name` / `space_path`).
struct PoolHits {
    key: IndexKey,
    hits: Vec<SearchResult>,
}

/// Run `query_fn` against every key in parallel, skipping pools whose
/// reindex lock is currently held (full_reindex in progress). Returns the
/// per-pool results plus the count of pools that actually contributed —
/// `total_spaces` is the input length, `indexed_spaces` is the returned
/// `Vec<PoolHits>` length.
async fn fan_out<F, Fut>(
    app: &AppHandle,
    keys: Vec<IndexKey>,
    query_fn: F,
) -> (Vec<PoolHits>, usize)
where
    F: Fn(sqlx::SqlitePool) -> Fut + Send + Sync + 'static + Clone,
    Fut: std::future::Future<Output = Result<Vec<SearchResult>, AppError>> + Send,
{
    let mut set: JoinSet<Option<PoolHits>> = JoinSet::new();
    for key in keys {
        let app = app.clone();
        let q = query_fn.clone();
        set.spawn(async move {
            let state = app.state::<IndexState>();
            let lock = state.reindex_lock(&key).await;
            // Skip pools that are mid-reindex — their results will arrive in
            // a later query (Phase 6 §Q3).
            let _guard = match lock.try_lock_owned() {
                Ok(g) => g,
                Err(_) => return None,
            };
            let pool = match state.get_or_create(&key).await {
                Ok(p) => p,
                Err(e) => {
                    tracing::warn!("fan_out: get_or_create failed for {:?}: {e}", key);
                    return None;
                }
            };
            match q(pool).await {
                Ok(hits) => Some(PoolHits { key, hits }),
                Err(e) => {
                    tracing::warn!("fan_out: query failed for {:?}: {e}", key);
                    None
                }
            }
        });
    }

    let mut pools: Vec<PoolHits> = Vec::new();
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok(Some(p)) => pools.push(p),
            Ok(None) => {}
            Err(e) => tracing::warn!("fan_out: join failed: {e}"),
        }
    }
    let indexed = pools.len();
    (pools, indexed)
}

/// Build a `SearchItem` from a per-pool `SearchResult`, attaching the source
/// pool's identity. Resolves directory + display name lazily for the key.
async fn enrich(state: &IndexState, key: &IndexKey, hit: SearchResult) -> SearchItem {
    let space_path = state
        .dir_for_key(key)
        .await
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let space_name = state.space_name(key).await;
    let space_id = match key {
        IndexKey::Root(_) => None,
        IndexKey::Space { space_id, .. } => Some(space_id.clone()),
    };
    let icon = icon_for(&hit.entry_type);
    SearchItem {
        id: hit.id,
        space_id,
        space_path,
        space_name,
        path: hit.path,
        title: hit.title,
        entry_type: hit.entry_type,
        table_name: hit.table_name,
        snippet: hit.snippet,
        icon,
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
///
/// Merge: concat all per-pool top-`limit` results, sort by
/// `(prefix-match? 0 : 1, updated_at DESC)`, truncate to global `limit`.
#[tauri::command]
pub async fn search_project_entries_by_title(
    app: AppHandle,
    project_path: String,
    query: String,
    scope: Option<SearchScope>,
    limit: Option<i64>,
) -> Result<SearchResponse, AppError> {
    let project = PathBuf::from(&project_path);
    let state = app.state::<IndexState>();
    let keys = scope_to_keys(&state, &project, scope).await;
    let total = keys.len();
    let lim = limit.unwrap_or(DEFAULT_LIMIT);

    let q = query.clone();
    let (pools, indexed) = fan_out(&app, keys, move |pool| {
        let q = q.clone();
        async move { search::search_by_title(&pool, &q, lim).await }
    })
    .await;

    let q_lc = query.to_lowercase();
    // Concat with key, score prefix-match (lowercase).
    let mut merged: Vec<(IndexKey, SearchResult, u8)> = Vec::new();
    for p in pools {
        for hit in p.hits {
            let prefix = if hit.title.to_lowercase().starts_with(&q_lc) {
                0
            } else {
                1
            };
            merged.push((p.key.clone(), hit, prefix));
        }
    }
    merged.sort_by(|a, b| {
        a.2.cmp(&b.2).then_with(|| {
            // updated_at DESC — None last
            match (b.1.updated_at.as_deref(), a.1.updated_at.as_deref()) {
                (Some(x), Some(y)) => x.cmp(y),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            }
        })
    });
    merged.truncate(lim as usize);

    let mut items = Vec::with_capacity(merged.len());
    for (key, hit, _) in merged {
        items.push(enrich(&state, &key, hit).await);
    }

    Ok(SearchResponse {
        items,
        indexed_spaces: indexed,
        total_spaces: total,
    })
}

/// Project-wide FTS5 search. Fans out across pools; merges via round-robin
/// over per-pool rank position (Phase 6 §Q1) — rank-1 from every pool, then
/// rank-2 from every pool, etc. Tie-break at the same rank position is
/// `updated_at DESC`. The absolute BM25 score is not comparable across pools
/// and is never used after the per-pool fetch.
#[tauri::command]
pub async fn search_project_entries(
    app: AppHandle,
    project_path: String,
    query: String,
    entry_type: Option<String>,
    table_name: Option<String>,
    scope: Option<SearchScope>,
    limit: Option<i64>,
) -> Result<SearchResponse, AppError> {
    let project = PathBuf::from(&project_path);
    let state = app.state::<IndexState>();
    let keys = scope_to_keys(&state, &project, scope).await;
    let total = keys.len();
    let lim = limit.unwrap_or(DEFAULT_LIMIT);

    let q = query.clone();
    let et = entry_type.clone();
    let tn = table_name.clone();
    let (pools, indexed) = fan_out(&app, keys, move |pool| {
        let q = q.clone();
        let et = et.clone();
        let tn = tn.clone();
        async move { search::search_fts(&pool, &q, et.as_deref(), tn.as_deref(), lim).await }
    })
    .await;

    // Round-robin over rank position. At each position, sort the slice
    // `updated_at DESC` (tie-break) before pushing.
    let max_rank = pools.iter().map(|p| p.hits.len()).max().unwrap_or(0);
    let mut items: Vec<SearchItem> = Vec::with_capacity(lim as usize);
    'outer: for rank in 0..max_rank {
        let mut bucket: Vec<(IndexKey, SearchResult)> = Vec::new();
        for p in &pools {
            if let Some(hit) = p.hits.get(rank) {
                bucket.push((p.key.clone(), hit.clone()));
            }
        }
        bucket.sort_by(|a, b| match (b.1.updated_at.as_deref(), a.1.updated_at.as_deref()) {
            (Some(x), Some(y)) => x.cmp(y),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        });
        for (key, hit) in bucket {
            items.push(enrich(&state, &key, hit).await);
            if items.len() >= lim as usize {
                break 'outer;
            }
        }
    }

    Ok(SearchResponse {
        items,
        indexed_spaces: indexed,
        total_spaces: total,
    })
}

/// Project-wide "recent" listing — merges all per-pool results, sorts
/// `updated_at DESC`, truncates to `limit`.
#[tauri::command]
pub async fn recent_project_entries(
    app: AppHandle,
    project_path: String,
    scope: Option<SearchScope>,
    limit: Option<i64>,
) -> Result<SearchResponse, AppError> {
    let project = PathBuf::from(&project_path);
    let state = app.state::<IndexState>();
    let keys = scope_to_keys(&state, &project, scope).await;
    let total = keys.len();
    let lim = limit.unwrap_or(DEFAULT_LIMIT);

    let (pools, indexed) = fan_out(&app, keys, move |pool| async move {
        search::recent(&pool, lim).await
    })
    .await;

    let mut merged: Vec<(IndexKey, SearchResult)> = Vec::new();
    for p in pools {
        for hit in p.hits {
            merged.push((p.key.clone(), hit));
        }
    }
    merged.sort_by(|a, b| match (b.1.updated_at.as_deref(), a.1.updated_at.as_deref()) {
        (Some(x), Some(y)) => x.cmp(y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
    merged.truncate(lim as usize);

    let mut items = Vec::with_capacity(merged.len());
    for (key, hit) in merged {
        items.push(enrich(&state, &key, hit).await);
    }

    Ok(SearchResponse {
        items,
        indexed_spaces: indexed,
        total_spaces: total,
    })
}

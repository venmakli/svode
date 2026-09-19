use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::task::JoinSet;

use crate::index::IndexError as AppError;
use crate::index::knowledge::{
    KnowledgeFilters, KnowledgeRelatedContext, KnowledgeResponse, KnowledgeScope,
};
use crate::index::search::{self, SearchResult};
use crate::index::{IndexKey, state::IndexRuntimeState as IndexState};

const DEFAULT_SEARCH_LIMIT: i64 = 20;
const MAX_SEARCH_LIMIT: i64 = 1_000;
const ICON_PAGE: &str = "\u{1F4C4}";
const ICON_TABLE_ROW: &str = "\u{1F4CB}";

#[derive(Debug, Clone, Deserialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum SearchScope {
    Project,
    Space { space_id: Option<String> },
}

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub items: Vec<SearchItem>,
    pub indexed_spaces: usize,
    pub total_spaces: usize,
}

struct PoolHits {
    key: IndexKey,
    hits: Vec<SearchResult>,
}

fn search_limit(limit: Option<i64>) -> i64 {
    limit
        .unwrap_or(DEFAULT_SEARCH_LIMIT)
        .clamp(1, MAX_SEARCH_LIMIT)
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

async fn fan_out<F, Fut>(
    state: IndexState,
    keys: Vec<IndexKey>,
    query_fn: F,
) -> (Vec<PoolHits>, usize)
where
    F: Fn(sqlx::SqlitePool) -> Fut + Send + Sync + 'static + Clone,
    Fut: std::future::Future<Output = Result<Vec<SearchResult>, AppError>> + Send + 'static,
{
    let mut set: JoinSet<Option<PoolHits>> = JoinSet::new();
    for key in keys {
        let state = state.clone();
        let query = query_fn.clone();
        set.spawn(async move {
            let pool = match state.existing_pool(&key).await {
                Some(pool) => pool,
                None => {
                    tracing::debug!("search: cached pool unavailable for {:?}", key);
                    return None;
                }
            };
            match query(pool).await {
                Ok(hits) => Some(PoolHits { key, hits }),
                Err(error) => {
                    tracing::warn!("search query failed for {:?}: {error}", key);
                    None
                }
            }
        });
    }

    let mut pools = Vec::new();
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok(Some(pool)) => pools.push(pool),
            Ok(None) => {}
            Err(error) => tracing::warn!("search query task failed: {error}"),
        }
    }
    let indexed = pools.len();
    (pools, indexed)
}

async fn enrich(state: &IndexState, key: &IndexKey, hit: SearchResult) -> SearchItem {
    let space_path = state
        .dir_for_key(key)
        .await
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    SearchItem {
        id: hit.id,
        space_id: IndexState::space_id_for_key(key),
        space_path,
        space_name: state.space_name(key).await,
        path: hit.path,
        title: hit.title,
        entry_type: hit.entry_type.clone(),
        table_name: hit.table_name,
        snippet: hit.snippet,
        icon: icon_for(&hit.entry_type),
    }
}

async fn search_unique_id_exact(
    state: &IndexState,
    keys: &[IndexKey],
    query: &str,
    limit: i64,
) -> Vec<(IndexKey, SearchResult)> {
    let mut results = Vec::new();
    for key in keys {
        if results.len() >= limit as usize {
            break;
        }
        let Some(pool) = state.existing_pool(key).await else {
            continue;
        };
        let Ok(space_path) = state.dir_for_key(key).await else {
            continue;
        };
        let remaining = limit - results.len() as i64;
        match search::search_unique_id_exact(&pool, &space_path, query, remaining).await {
            Ok(hits) => results.extend(hits.into_iter().map(|hit| (key.clone(), hit))),
            Err(error) => tracing::warn!("unique_id search failed for {:?}: {error}", key),
        }
    }
    results
}

pub async fn search_by_title(
    state: &IndexState,
    project: PathBuf,
    query: String,
    scope: Option<SearchScope>,
    limit: Option<i64>,
) -> Result<SearchResponse, AppError> {
    let keys = scope_to_keys(state, &project, scope).await;
    let keys_for_unique_id = keys.clone();
    let total = keys.len();
    let limit = search_limit(limit);
    let query_for_pools = query.clone();
    let (pools, indexed) = fan_out(state.clone(), keys, move |pool| {
        let query = query_for_pools.clone();
        async move { search::search_by_title(&pool, &query, limit).await }
    })
    .await;

    let query_lower = query.to_lowercase();
    let mut merged = Vec::new();
    for (key, hit) in search_unique_id_exact(state, &keys_for_unique_id, &query, limit).await {
        merged.push((key, hit, 0));
    }
    for pool in pools {
        for hit in pool.hits {
            let prefix = u8::from(!hit.title.to_lowercase().starts_with(&query_lower));
            merged.push((pool.key.clone(), hit, prefix));
        }
    }
    merged.sort_by(|left, right| {
        left.2.cmp(&right.2).then_with(|| {
            match (right.1.updated_at.as_deref(), left.1.updated_at.as_deref()) {
                (Some(left), Some(right)) => left.cmp(right),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            }
        })
    });
    let mut seen = HashSet::new();
    merged.retain(|(key, hit, _)| seen.insert((key.clone(), hit.path.clone())));
    merged.truncate(limit as usize);

    let mut items = Vec::with_capacity(merged.len());
    for (key, hit, _) in merged {
        items.push(enrich(state, &key, hit).await);
    }
    Ok(SearchResponse {
        items,
        indexed_spaces: indexed,
        total_spaces: total,
    })
}

pub async fn search_content(
    state: &IndexState,
    project: PathBuf,
    query: String,
    entry_type: Option<String>,
    table_name: Option<String>,
    scope: Option<SearchScope>,
    limit: Option<i64>,
) -> Result<SearchResponse, AppError> {
    let keys = scope_to_keys(state, &project, scope).await;
    let total = keys.len();
    let limit = search_limit(limit);
    let (pools, indexed) = fan_out(state.clone(), keys, move |pool| {
        let query = query.clone();
        let entry_type = entry_type.clone();
        let table_name = table_name.clone();
        async move {
            search::search_fts(
                &pool,
                &query,
                entry_type.as_deref(),
                table_name.as_deref(),
                limit,
            )
            .await
        }
    })
    .await;

    let max_rank = pools.iter().map(|pool| pool.hits.len()).max().unwrap_or(0);
    let mut items = Vec::with_capacity(limit as usize);
    'outer: for rank in 0..max_rank {
        let mut bucket = Vec::new();
        for pool in &pools {
            if let Some(hit) = pool.hits.get(rank) {
                bucket.push((pool.key.clone(), hit.clone()));
            }
        }
        bucket.sort_by(|left, right| {
            match (right.1.updated_at.as_deref(), left.1.updated_at.as_deref()) {
                (Some(left), Some(right)) => left.cmp(right),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            }
        });
        for (key, hit) in bucket {
            items.push(enrich(state, &key, hit).await);
            if items.len() >= limit as usize {
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

pub async fn recent(
    state: &IndexState,
    project: PathBuf,
    scope: Option<SearchScope>,
    limit: Option<i64>,
) -> Result<SearchResponse, AppError> {
    let keys = scope_to_keys(state, &project, scope).await;
    let total = keys.len();
    let limit = search_limit(limit);
    let (pools, indexed) = fan_out(state.clone(), keys, move |pool| async move {
        search::recent(&pool, limit).await
    })
    .await;
    let mut merged = pools
        .into_iter()
        .flat_map(|pool| {
            pool.hits
                .into_iter()
                .map(move |hit| (pool.key.clone(), hit))
        })
        .collect::<Vec<_>>();
    merged.sort_by(|left, right| {
        match (right.1.updated_at.as_deref(), left.1.updated_at.as_deref()) {
            (Some(left), Some(right)) => left.cmp(right),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        }
    });
    merged.truncate(limit as usize);
    let mut items = Vec::with_capacity(merged.len());
    for (key, hit) in merged {
        items.push(enrich(state, &key, hit).await);
    }
    Ok(SearchResponse {
        items,
        indexed_spaces: indexed,
        total_spaces: total,
    })
}

#[allow(clippy::too_many_arguments)]
pub async fn read_project_knowledge(
    state: &IndexState,
    project: &Path,
    scope: Option<KnowledgeScope>,
    query: Option<&str>,
    node_offset: Option<usize>,
    edge_offset: Option<usize>,
    node_limit: Option<usize>,
    edge_limit: Option<usize>,
    search_limit: Option<usize>,
    filters: KnowledgeFilters,
) -> KnowledgeResponse {
    crate::index::knowledge::read_project_snapshot_filtered(
        state,
        project,
        scope,
        query,
        node_offset,
        edge_offset,
        node_limit,
        edge_limit,
        search_limit,
        filters,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn read_scoped_knowledge(
    state: &IndexState,
    project: &Path,
    scope: KnowledgeScope,
    query: Option<&str>,
    node_limit: usize,
    edge_limit: usize,
    search_limit: usize,
    filters: KnowledgeFilters,
) -> KnowledgeResponse {
    crate::index::knowledge::read_scoped_snapshot_filtered(
        state,
        project,
        scope,
        query,
        node_limit,
        edge_limit,
        search_limit,
        filters,
    )
    .await
}

pub async fn read_related_context(
    state: &IndexState,
    project: &Path,
    scope: KnowledgeScope,
    query: &str,
    limit: usize,
    text_budget: usize,
    node_kinds: Option<Vec<String>>,
) -> KnowledgeRelatedContext {
    crate::index::knowledge::read_related_context(
        state,
        project,
        scope,
        query,
        limit,
        text_budget,
        node_kinds,
    )
    .await
}

pub async fn count_broken_links(state: &IndexState, project: &Path) -> Result<i64, AppError> {
    let keys = state.keys_for_project(project).await;
    let mut total = 0i64;
    for key in keys {
        let pool = match state.get_or_create(&key).await {
            Ok(pool) => pool,
            Err(error) => {
                tracing::warn!("broken-link diagnostic skipped {:?}: {error}", key);
                continue;
            }
        };
        total += sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM broken_links")
            .fetch_one(&pool)
            .await?;
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::index::update::IndexUpdateState;
    use crate::page::dates::SystemGitDateExecutor;
    use crate::routines::store_state::RoutineStoreState;

    #[tokio::test]
    async fn standalone_repair_search_knowledge_and_diagnostics_share_prepared_pool() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path();
        std::fs::create_dir_all(project.join(".svode")).unwrap();
        std::fs::write(
            project.join("note.md"),
            "---\ntitle: Needle\n---\nBody token [missing](missing.md)\n",
        )
        .unwrap();
        let state = IndexState::default();
        let updates = IndexUpdateState::new(Arc::new(RoutineStoreState::new()));
        updates
            .repair_space(
                &state,
                &IndexKey::Root(project.to_path_buf()),
                None::<&SystemGitDateExecutor>,
            )
            .await
            .unwrap();

        let title = search_by_title(&state, project.to_path_buf(), "Needle".into(), None, None)
            .await
            .unwrap();
        assert_eq!(title.items.len(), 1);
        assert_eq!(title.items[0].path, "note.md");
        let content = search_content(
            &state,
            project.to_path_buf(),
            "token".into(),
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(content.items.len(), 1);
        let graph = read_project_knowledge(
            &state,
            project,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            KnowledgeFilters::default(),
        )
        .await;
        assert!(graph.nodes.iter().any(|node| node.source.path == "note.md"));
        assert_eq!(count_broken_links(&state, project).await.unwrap(), 1);
        assert_eq!(state.pools.lock().await.physical_count(), 1);
    }
}

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

/// Merges per-pool title hits by `TitleQuery` level before the limit, so a
/// more exact match from any pool is never cut by fresher weaker ones.
/// Exact `unique_id` hits rank with exact titles.
fn rank_title_hits(
    query: &str,
    unique_id_hits: Vec<(IndexKey, SearchResult)>,
    pools: Vec<PoolHits>,
    limit: i64,
) -> Vec<(IndexKey, SearchResult)> {
    let title_query = search::TitleQuery::new(query);
    let mut merged = unique_id_hits
        .into_iter()
        .map(|(key, hit)| (key, hit, 0))
        .collect::<Vec<_>>();
    for pool in pools {
        for hit in pool.hits {
            if let Some(level) = title_query.level(&hit.title, &hit.path) {
                merged.push((pool.key.clone(), hit, level));
            }
        }
    }
    merged.sort_by(|left, right| {
        left.2
            .cmp(&right.2)
            .then_with(|| right.1.updated_at.cmp(&left.1.updated_at))
    });
    let mut seen = HashSet::new();
    merged.retain(|(key, hit, _)| seen.insert((key.clone(), hit.path.clone())));
    merged.truncate(limit as usize);
    merged.into_iter().map(|(key, hit, _)| (key, hit)).collect()
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

    let unique_id_hits = search_unique_id_exact(state, &keys_for_unique_id, &query, limit).await;
    let merged = rank_title_hits(&query, unique_id_hits, pools, limit);

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
    use crate::index::knowledge::KnowledgeSource;
    use crate::index::update::IndexUpdateState;
    use crate::page::dates::SystemGitDateExecutor;
    use crate::routines::store_state::RoutineStoreState;

    fn hit(path: &str, title: &str, updated: &str) -> SearchResult {
        SearchResult {
            id: path.to_string(),
            path: path.to_string(),
            title: title.to_string(),
            entry_type: "page".to_string(),
            snippet: None,
            table_name: None,
            updated_at: Some(updated.to_string()),
        }
    }

    #[test]
    fn title_merge_ranks_levels_across_pools_before_limit() {
        let root = IndexKey::Root(PathBuf::from("/project"));
        let space = IndexKey::Space {
            project: PathBuf::from("/project"),
            space_id: "space".to_string(),
        };
        let pools = vec![
            PoolHits {
                key: root.clone(),
                hits: vec![
                    hit("Plan A.md", "Plan A", "2026-01-05"),
                    hit("Plan B.md", "Plan B", "2026-01-04"),
                ],
            },
            PoolHits {
                key: space.clone(),
                hits: vec![
                    hit("plan.md", "plan", "2026-01-01"),
                    hit("My Plan.md", "My Plan", "2026-01-09"),
                    hit("plans/other.md", "Other", "2026-01-10"),
                ],
            },
        ];
        let unique_id = vec![(root.clone(), hit("tasks/a.md", "Task", "2026-01-03"))];

        let merged = rank_title_hits("PLAN", unique_id, pools, 6);

        assert_eq!(
            merged
                .iter()
                .map(|(key, hit)| (key == &space, hit.title.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (false, "Task"),
                (true, "plan"),
                (false, "Plan A"),
                (false, "Plan B"),
                (true, "My Plan"),
                (true, "Other"),
            ]
        );
        let pools = vec![PoolHits {
            key: space,
            hits: vec![hit("plan.md", "plan", "2026-01-01")],
        }];
        let first = rank_title_hits("Plan", Vec::new(), pools, 1);
        assert_eq!(first[0].1.title, "plan");
    }

    #[tokio::test]
    async fn title_search_through_index_folds_cyrillic_case() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path();
        std::fs::create_dir_all(project.join(".svode")).unwrap();
        for (file, title) in [("plan.md", "План"), ("work.md", "План работ")] {
            std::fs::write(
                project.join(file),
                format!("---\ntitle: {title}\n---\nBody\n"),
            )
            .unwrap();
        }
        let state = IndexState::default();
        IndexUpdateState::new(Arc::new(RoutineStoreState::new()))
            .repair_space(
                &state,
                &IndexKey::Root(project.to_path_buf()),
                None::<&SystemGitDateExecutor>,
            )
            .await
            .unwrap();

        let response = search_by_title(&state, project.to_path_buf(), "план".into(), None, None)
            .await
            .unwrap();
        assert_eq!(
            response
                .items
                .iter()
                .map(|item| item.title.as_str())
                .collect::<Vec<_>>(),
            vec!["План", "План работ"]
        );
    }

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

    fn write_percent_link_project(project: &Path) {
        std::fs::create_dir_all(project.join(".svode")).unwrap();
        std::fs::write(
            project.join("Roadmap Draft.md"),
            "---\ntitle: Roadmap Draft\n---\nDraft\n",
        )
        .unwrap();
        std::fs::write(
            project.join("Index.md"),
            "---\ntitle: Index\n---\n[R](Roadmap%20Draft.md) [N](Nope%20Here.md)\n",
        )
        .unwrap();
    }

    async fn repair_root(state: &IndexState, project: &Path) {
        IndexUpdateState::new(Arc::new(RoutineStoreState::new()))
            .repair_space(
                state,
                &IndexKey::Root(project.to_path_buf()),
                None::<&SystemGitDateExecutor>,
            )
            .await
            .unwrap();
    }

    async fn index_link_edges(state: &IndexState, project: &Path) -> Vec<(String, String)> {
        let page = |path: &str| KnowledgeSource {
            space_id: None,
            path: path.to_string(),
            kind: "page".to_string(),
        };
        let graph = read_project_knowledge(
            state,
            project,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            KnowledgeFilters {
                edge_sources: Some(vec![page("Index.md")]),
                ..KnowledgeFilters::default()
            },
        )
        .await;
        let mut edges = graph
            .edges
            .into_iter()
            .filter(|edge| edge.kind == "links_to")
            .map(|edge| (edge.target_url, edge.target_status))
            .collect::<Vec<_>>();
        edges.sort();
        edges
    }

    #[tokio::test]
    async fn df_154_percent_links_are_ready_knowledge_edges_and_not_broken() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path();
        write_percent_link_project(project);
        let state = IndexState::default();
        repair_root(&state, project).await;

        assert_eq!(
            index_link_edges(&state, project).await,
            vec![
                ("Nope Here.md".to_string(), "broken".to_string()),
                ("Roadmap Draft.md".to_string(), "ready".to_string()),
            ]
        );
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
            KnowledgeFilters {
                node_kinds: Some(Vec::new()),
                neighbor: Some(KnowledgeSource {
                    space_id: None,
                    path: "Roadmap Draft.md".to_string(),
                    kind: "page".to_string(),
                }),
                ..KnowledgeFilters::default()
            },
        )
        .await;
        assert!(graph.edges.iter().any(|edge| {
            edge.source.path == "Index.md"
                && edge
                    .target
                    .as_ref()
                    .is_some_and(|target| target.path == "Roadmap Draft.md")
                && edge.target_status == "ready"
        }));
        assert_eq!(count_broken_links(&state, project).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn df_154_index_of_the_previous_schema_is_rebuilt_with_decoded_link_paths() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path();
        write_percent_link_project(project);
        let key = IndexKey::Root(project.to_path_buf());
        let state = IndexState::default();
        repair_root(&state, project).await;
        // Leave the rows the previous version wrote: undecoded link paths and
        // a broken row for the working link.
        let pool = state.get_or_create(&key).await.unwrap();
        sqlx::query("UPDATE knowledge_links SET target_url = 'Roadmap%20Draft.md' WHERE target_url = 'Roadmap Draft.md'")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO broken_links (source_rel_path, target_space_id, target_url, detected_at) VALUES ('Index.md', NULL, 'Roadmap%20Draft.md', 'then')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE schema_version SET version = ?")
            .bind(crate::index::db::SCHEMA_VERSION - 1)
            .execute(&pool)
            .await
            .unwrap();
        state.close_project(project).await;

        // Reopen as every host does: open the pool, then reconcile, which
        // rebuilds only an index without a compatible snapshot.
        let state = IndexState::default();
        let pool = state.get_or_create(&key).await.unwrap();
        IndexUpdateState::new(Arc::new(RoutineStoreState::new()))
            .reconcile_space(&state, &key, None::<&SystemGitDateExecutor>)
            .await
            .unwrap();

        assert_eq!(
            index_link_edges(&state, project).await,
            vec![
                ("Nope Here.md".to_string(), "broken".to_string()),
                ("Roadmap Draft.md".to_string(), "ready".to_string()),
            ]
        );
        let broken: Vec<String> = sqlx::query_scalar("SELECT target_url FROM broken_links")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(broken, vec!["Nope Here.md".to_string()]);
    }

    #[tokio::test]
    async fn df_205_index_of_the_previous_schema_is_rebuilt_with_direct_child_membership() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path();
        std::fs::create_dir_all(project.join(".svode")).unwrap();
        std::fs::create_dir_all(project.join("tasks/b")).unwrap();
        std::fs::write(project.join("tasks/schema.yaml"), "columns: []\n").unwrap();
        for (path, title) in [("tasks/b/README.md", "B"), ("tasks/b/note.md", "Note")] {
            std::fs::write(project.join(path), format!("---\ntitle: {title}\n---\n")).unwrap();
        }
        let key = IndexKey::Root(project.to_path_buf());
        let state = IndexState::default();
        repair_root(&state, project).await;
        // Leave the membership row the previous version wrote for the Page
        // below the item `b`.
        let pool = state.get_or_create(&key).await.unwrap();
        sqlx::query(
            "UPDATE entries SET in_collection = 1, collection_root_path = 'tasks' \
             WHERE file_path = 'tasks/b/note.md'",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("UPDATE schema_version SET version = ?")
            .bind(crate::index::db::SCHEMA_VERSION - 1)
            .execute(&pool)
            .await
            .unwrap();
        state.close_project(project).await;

        let state = IndexState::default();
        let pool = state.get_or_create(&key).await.unwrap();
        IndexUpdateState::new(Arc::new(RoutineStoreState::new()))
            .reconcile_space(&state, &key, None::<&SystemGitDateExecutor>)
            .await
            .unwrap();

        let members: Vec<String> = sqlx::query_scalar(
            "SELECT file_path FROM entries WHERE in_collection = 1 ORDER BY file_path",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(members, vec!["tasks/b/README.md".to_string()]);
    }

    /// `Index.md` reaches `Plan.md` and the missing `Nope.md` only through
    /// link reference definitions; the code block definition is no link.
    fn write_definition_link_project(project: &Path) {
        std::fs::create_dir_all(project.join(".svode")).unwrap();
        std::fs::write(project.join("Plan.md"), "---\ntitle: Plan\n---\nPlan\n").unwrap();
        std::fs::write(
            project.join("Index.md"),
            "---\ntitle: Index\n---\n[Plan][p] and [Gone][g]\n\n[p]: Plan.md \"Title\"\n[g]: <Nope.md>\n\n```\n[c]: Code.md\n```\n",
        )
        .unwrap();
    }

    #[tokio::test]
    async fn df_251_definitions_are_knowledge_edges_backlinks_and_broken_links() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path();
        write_definition_link_project(project);
        let state = IndexState::default();
        repair_root(&state, project).await;

        assert_eq!(
            index_link_edges(&state, project).await,
            vec![
                ("Nope.md".to_string(), "broken".to_string()),
                ("Plan.md".to_string(), "ready".to_string()),
            ]
        );
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
            KnowledgeFilters {
                node_kinds: Some(Vec::new()),
                neighbor: Some(KnowledgeSource {
                    space_id: None,
                    path: "Plan.md".to_string(),
                    kind: "page".to_string(),
                }),
                ..KnowledgeFilters::default()
            },
        )
        .await;
        assert!(graph.edges.iter().any(|edge| {
            edge.kind == "links_to"
                && edge.source.path == "Index.md"
                && edge.target_status == "ready"
        }));
        assert_eq!(count_broken_links(&state, project).await.unwrap(), 1);

        state.ensure_project_backlinks_built(project).await.unwrap();
        let backlinks = state
            .backlinks_for(&IndexKey::Root(project.to_path_buf()))
            .await
            .get_backlinks("Plan.md");
        assert_eq!(backlinks.len(), 1);
        assert_eq!(backlinks[0].source_path, "Index.md");
        assert_eq!(backlinks[0].link_count, 1);
    }

    #[tokio::test]
    async fn df_251_index_of_the_previous_schema_is_rebuilt_with_definition_links() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path();
        write_definition_link_project(project);
        let key = IndexKey::Root(project.to_path_buf());
        let state = IndexState::default();
        repair_root(&state, project).await;
        // Leave the rows the previous version wrote: no link rows for
        // definitions.
        let pool = state.get_or_create(&key).await.unwrap();
        sqlx::query("DELETE FROM knowledge_links WHERE source_path = 'Index.md'")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM broken_links")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE schema_version SET version = ?")
            .bind(crate::index::db::SCHEMA_VERSION - 1)
            .execute(&pool)
            .await
            .unwrap();
        state.close_project(project).await;
        let before = std::fs::read(project.join("Index.md")).unwrap();

        let state = IndexState::default();
        let pool = state.get_or_create(&key).await.unwrap();
        IndexUpdateState::new(Arc::new(RoutineStoreState::new()))
            .reconcile_space(&state, &key, None::<&SystemGitDateExecutor>)
            .await
            .unwrap();

        assert_eq!(
            index_link_edges(&state, project).await,
            vec![
                ("Nope.md".to_string(), "broken".to_string()),
                ("Plan.md".to_string(), "ready".to_string()),
            ]
        );
        let broken: Vec<String> = sqlx::query_scalar("SELECT target_url FROM broken_links")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(broken, vec!["Nope.md".to_string()]);
        assert_eq!(std::fs::read(project.join("Index.md")).unwrap(), before);
    }
}

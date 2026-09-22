use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::error::AppError;
use crate::index::update::IndexUpdateState;
use crate::index::{IndexKey, IndexState};
use svode_core::index::knowledge::{KnowledgeFilters, KnowledgeResponse, KnowledgeScope};
pub use svode_core::index::service::{SearchResponse, SearchScope};

const REINDEX_PARALLELISM: usize = 4;

pub async fn search_by_title(
    state: &IndexState,
    project: PathBuf,
    query: String,
    scope: Option<SearchScope>,
    limit: Option<i64>,
) -> Result<SearchResponse, AppError> {
    Ok(
        svode_core::index::service::search_by_title(&state.core, project, query, scope, limit)
            .await?,
    )
}

#[allow(clippy::too_many_arguments)]
pub async fn search_content(
    state: &IndexState,
    project: PathBuf,
    query: String,
    entry_type: Option<String>,
    table_name: Option<String>,
    scope: Option<SearchScope>,
    limit: Option<i64>,
) -> Result<SearchResponse, AppError> {
    Ok(svode_core::index::service::search_content(
        &state.core,
        project,
        query,
        entry_type,
        table_name,
        scope,
        limit,
    )
    .await?)
}

pub async fn recent(
    state: &IndexState,
    project: PathBuf,
    scope: Option<SearchScope>,
    limit: Option<i64>,
) -> Result<SearchResponse, AppError> {
    Ok(svode_core::index::service::recent(&state.core, project, scope, limit).await?)
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
    svode_core::index::service::read_project_knowledge(
        &state.core,
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

pub async fn repair_space(
    state: &IndexState,
    updates: &IndexUpdateState,
    key: &IndexKey,
) -> Result<(), AppError> {
    updates.run_full_reindex(state, key).await
}

pub async fn repair_project(state: IndexState, updates: IndexUpdateState, project: PathBuf) {
    let keys = state.keys_for_project(&project).await;
    let semaphore = Arc::new(Semaphore::new(REINDEX_PARALLELISM));
    let mut tasks = JoinSet::new();
    for key in keys {
        let state = state.clone();
        let updates = updates.clone();
        let semaphore = semaphore.clone();
        tasks.spawn(async move {
            let _permit = semaphore.acquire_owned().await.ok();
            if let Err(error) = repair_space(&state, &updates, &key).await {
                tracing::warn!("project index repair failed for {:?}: {error}", key);
            }
        });
    }
    while let Some(result) = tasks.join_next().await {
        if let Err(error) = result {
            tracing::warn!("project index repair task failed: {error}");
        }
    }
}

pub async fn count_broken_links(state: &IndexState, project: &Path) -> Result<i64, AppError> {
    state.core.ensure_project_backlinks_built(project).await?;
    Ok(svode_core::index::service::count_broken_links(&state.core, project).await?)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::Ordering;

    use super::*;

    #[test]
    fn search_space_scope_deserializes_frontend_space_id() {
        let scope: SearchScope = serde_json::from_value(serde_json::json!({
            "kind": "space",
            "spaceId": "space-develop"
        }))
        .expect("deserialize frontend search scope payload");
        match scope {
            SearchScope::Space { space_id } => {
                assert_eq!(space_id.as_deref(), Some("space-develop"));
            }
            SearchScope::Project => panic!("expected Space scope"),
        }
    }

    #[tokio::test]
    async fn search_uses_cached_snapshot_while_reconciling_and_hides_private_members() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join(".svode")).unwrap();
        let project = temp.path().to_path_buf();
        let key = IndexKey::Root(project.clone());
        let state = IndexState::new();
        let pool = state.get_or_create(&key).await.unwrap();
        for (path, title, discoverable) in [
            ("visible-a.md", "Needle Alpha", 1),
            ("visible-b.md", "Needle Beta", 1),
            ("hidden.md", "Needle Secret", 0),
        ] {
            sqlx::query(
                "INSERT INTO entries (file_path,parent_path,title,description,body_preview,created,updated,collection_root_path,in_collection,is_entry_head,is_discoverable,fields) VALUES (?,'',?,NULL,?,'2026-09-18T00:00:00Z','2026-09-18T00:00:00Z',NULL,0,0,?,'{}')",
            )
            .bind(path)
            .bind(title)
            .bind(format!("{title} body"))
            .bind(discoverable)
            .execute(&pool)
            .await
            .unwrap();
        }
        state
            .reconcile_active_flag(&key)
            .await
            .store(true, Ordering::SeqCst);

        let response = search_by_title(&state, project, "Needle".to_string(), None, Some(1))
            .await
            .unwrap();

        assert_eq!(response.indexed_spaces, 1);
        assert_eq!(response.total_spaces, 1);
        assert_eq!(response.items.len(), 1);
        assert_ne!(response.items[0].path, "hidden.md");
        assert!(!response.items[0].space_path.is_empty());
    }
}

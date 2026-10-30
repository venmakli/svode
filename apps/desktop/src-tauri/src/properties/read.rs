use std::path::{Path, PathBuf};

use crate::actors::{ActorCandidate, ActorCatalogState};
use crate::error::AppError;
use crate::index::{IndexKey, IndexState};
use serde::Serialize;
use svode_core::collections::engine::{Filter, ResolvedRelation, Sort};
use svode_core::collections::unique_id_duplicates::{
    UniqueIdDuplicate, unique_id_duplicates_of_entries,
};
use svode_core::git::cli::GitCli;
use svode_core::page::entry::Entry;

#[derive(Debug, Clone)]
pub struct CollectionReadTarget {
    space: String,
    index_key: IndexKey,
}

impl CollectionReadTarget {
    pub fn space(&self) -> &str {
        &self.space
    }
}

pub async fn target_for_space(
    index_state: &IndexState,
    space: String,
    project_path: Option<&str>,
) -> Result<CollectionReadTarget, AppError> {
    let index_key = if let Some(key) = index_state.key_for_space_dir(Path::new(&space)).await {
        key
    } else if let Some(project_path) = project_path.filter(|path| !path.is_empty()) {
        index_state
            .resolve(Path::new(project_path), Path::new(&space))
            .await?
            .0
    } else {
        IndexKey::Root(PathBuf::from(&space))
    };
    Ok(CollectionReadTarget { space, index_key })
}

/// A Collection item with the other item that holds its `unique_id` number.
#[derive(Debug, Serialize)]
pub struct CollectionItemRead {
    #[serde(flatten)]
    entry: Entry,
    #[serde(skip_serializing_if = "Option::is_none")]
    unique_id_duplicate: Option<UniqueIdDuplicate>,
}

async fn with_unique_id_duplicates(
    pool: &sqlx::SqlitePool,
    target: &CollectionReadTarget,
    collection_path: &str,
    entries: Vec<Entry>,
) -> Result<Vec<CollectionItemRead>, AppError> {
    let duplicates =
        unique_id_duplicates_of_entries(pool, target.space(), collection_path, &entries).await?;
    Ok(entries
        .into_iter()
        .zip(duplicates)
        .map(|(entry, unique_id_duplicate)| CollectionItemRead {
            entry,
            unique_id_duplicate,
        })
        .collect())
}

async fn pool_for_target(
    index_state: &IndexState,
    target: &CollectionReadTarget,
) -> Result<sqlx::SqlitePool, AppError> {
    index_state.get_or_create(&target.index_key).await
}

pub async fn entries_for_view(
    index_state: &IndexState,
    actor_catalog: &ActorCatalogState,
    git_cli: Option<&GitCli>,
    target: &CollectionReadTarget,
    collection_path: &str,
    view_name: &str,
    include_nested: Option<bool>,
) -> Result<Vec<CollectionItemRead>, AppError> {
    let pool = pool_for_target(index_state, target).await?;
    let entries = svode_core::collections::entries::list_entries_for_view(
        &pool,
        actor_catalog,
        git_cli,
        target.space(),
        collection_path,
        view_name,
        include_nested,
    )
    .await?;
    with_unique_id_duplicates(&pool, target, collection_path, entries).await
}

#[allow(clippy::too_many_arguments)]
pub async fn query_entries(
    index_state: &IndexState,
    actor_catalog: &ActorCatalogState,
    git_cli: Option<&GitCli>,
    target: &CollectionReadTarget,
    collection_path: &str,
    filters: Option<Vec<Filter>>,
    sort: Option<Vec<Sort>>,
    include_nested: Option<bool>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<CollectionItemRead>, AppError> {
    let pool = pool_for_target(index_state, target).await?;
    let entries = svode_core::collections::entries::query_entries(
        &pool,
        actor_catalog,
        git_cli,
        target.space(),
        collection_path,
        filters,
        sort,
        include_nested,
        limit,
        offset,
    )
    .await?;
    with_unique_id_duplicates(&pool, target, collection_path, entries).await
}

pub async fn resolve_relation(
    index_state: &IndexState,
    target: &CollectionReadTarget,
    relation: &str,
    value: &str,
) -> Result<Option<ResolvedRelation>, AppError> {
    let pool = pool_for_target(index_state, target).await?;
    Ok(svode_core::collections::relation_read::resolve_relation(&pool, relation, value).await?)
}

pub async fn resolve_relations_batch(
    index_state: &IndexState,
    target: &CollectionReadTarget,
    relation: &str,
    values: &[String],
) -> Result<Vec<Option<ResolvedRelation>>, AppError> {
    let pool = pool_for_target(index_state, target).await?;
    Ok(
        svode_core::collections::relation_read::resolve_relations_batch(&pool, relation, values)
            .await?,
    )
}

pub async fn actors(
    actor_catalog: &ActorCatalogState,
    git_cli: &GitCli,
    space: &Path,
    _all_time: bool,
) -> Result<Vec<ActorCandidate>, AppError> {
    Ok(actor_catalog.snapshot(git_cli, space).await?.candidates())
}

pub async fn refresh_actors(
    actor_catalog: &ActorCatalogState,
    git_cli: &GitCli,
    space: &Path,
    _all_time: bool,
) -> Result<Vec<ActorCandidate>, AppError> {
    Ok(actor_catalog.refresh(git_cli, space).await?.candidates())
}

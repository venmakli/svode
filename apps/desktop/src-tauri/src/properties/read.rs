use std::path::{Path, PathBuf};

use crate::error::AppError;
use crate::files::entry::Entry;
use crate::git::cli::GitCli;
use crate::index::{IndexKey, IndexState};

use super::{
    ActorCandidate, ActorCatalogState, CollectionInfo, CollectionIntegrityReport, CollectionSchema,
    EntrySchemaResponse, Filter, RelationBacklink, RelationTwoWayDiagnostics, ResolvedRelation,
    Sort,
};

#[derive(Debug, Clone)]
pub struct CollectionReadTarget {
    space: String,
    index_key: IndexKey,
}

impl CollectionReadTarget {
    pub fn from_index_key(space: String, index_key: IndexKey) -> Self {
        Self { space, index_key }
    }

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

async fn pool_for_target(
    index_state: &IndexState,
    target: &CollectionReadTarget,
) -> Result<sqlx::SqlitePool, AppError> {
    index_state.get_or_create(&target.index_key).await
}

pub fn entry_schema(space: &str, file_path: &str) -> Result<Option<EntrySchemaResponse>, AppError> {
    super::schema_response(space, file_path)
}

pub fn collection_schema(space: &str, collection_path: &str) -> Result<CollectionSchema, AppError> {
    super::read_collection_schema(space, collection_path)
}

pub fn collections(space: &str) -> Result<Vec<CollectionInfo>, AppError> {
    super::list_collections(space)
}

pub async fn entries_for_view(
    index_state: &IndexState,
    actor_catalog: &ActorCatalogState,
    git_cli: Option<&GitCli>,
    target: &CollectionReadTarget,
    collection_path: &str,
    view_name: &str,
    include_nested: Option<bool>,
) -> Result<Vec<Entry>, AppError> {
    let pool = pool_for_target(index_state, target).await?;
    super::list_entries_for_view(
        &pool,
        actor_catalog,
        git_cli,
        target.space(),
        collection_path,
        view_name,
        include_nested,
    )
    .await
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
) -> Result<Vec<Entry>, AppError> {
    let pool = pool_for_target(index_state, target).await?;
    super::query_entries(
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
    .await
}

pub async fn resolve_relation(
    index_state: &IndexState,
    target: &CollectionReadTarget,
    relation: &str,
    value: &str,
) -> Result<Option<ResolvedRelation>, AppError> {
    let pool = pool_for_target(index_state, target).await?;
    super::resolve_relation(&pool, relation, value).await
}

pub async fn resolve_relations_batch(
    index_state: &IndexState,
    target: &CollectionReadTarget,
    relation: &str,
    values: &[String],
) -> Result<Vec<Option<ResolvedRelation>>, AppError> {
    let pool = pool_for_target(index_state, target).await?;
    super::resolve_relations_batch(&pool, relation, values).await
}

pub fn relation_backlinks(
    space: &str,
    target_path: &str,
    source_collection_path: Option<&str>,
    source_column: Option<&str>,
) -> Result<Vec<RelationBacklink>, AppError> {
    super::query_relation_backlinks(space, target_path, source_collection_path, source_column)
}

pub fn relation_diagnostics(
    space: &str,
    collection_path: &str,
    column: &str,
    project_path: Option<&str>,
) -> Result<RelationTwoWayDiagnostics, AppError> {
    super::diagnose_two_way_relation_with_project(space, collection_path, column, project_path)
}

pub fn integrity(
    space: &str,
    collection_path: Option<&str>,
    project_path: Option<&str>,
) -> Result<CollectionIntegrityReport, AppError> {
    super::validate_collection_integrity_with_project(space, collection_path, project_path)
}

pub async fn actors(
    actor_catalog: &ActorCatalogState,
    git_cli: &GitCli,
    space: &Path,
    all_time: bool,
) -> Result<Vec<ActorCandidate>, AppError> {
    super::list_actors(actor_catalog, git_cli, space, all_time).await
}

pub async fn refresh_actors(
    actor_catalog: &ActorCatalogState,
    git_cli: &GitCli,
    space: &Path,
    all_time: bool,
) -> Result<Vec<ActorCandidate>, AppError> {
    super::refresh_actors(actor_catalog, git_cli, space, all_time).await
}

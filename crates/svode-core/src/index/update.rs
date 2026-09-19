use std::path::Path;
use std::sync::Arc;

use sqlx::SqlitePool;

use super::manifest::SourceManifestRecord;
use super::model::{IndexedEntry, KnowledgeArtifact};
use super::state::IndexRuntimeState;
use super::{IndexError, IndexKey};
use crate::routines::RoutineStoreError;
use crate::routines::model::{CollectionEventOrigin, ResolvedRoutineOwner};
use crate::routines::observation::{self, ObservationError};
use crate::routines::store_state::RoutineStoreState;

#[derive(Debug, thiserror::Error)]
pub enum IndexUpdateError {
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error(transparent)]
    Index(#[from] IndexError),
    #[error(transparent)]
    Routine(#[from] RoutineStoreError),
    #[error(transparent)]
    Observation(#[from] ObservationError),
}

#[derive(Clone)]
pub struct IndexUpdateState {
    routine_stores: Arc<RoutineStoreState>,
}

impl IndexUpdateState {
    pub fn new(routine_stores: Arc<RoutineStoreState>) -> Self {
        Self { routine_stores }
    }

    pub async fn routines_pool(
        &self,
        index_state: &IndexRuntimeState,
        key: &IndexKey,
    ) -> Result<SqlitePool, IndexUpdateError> {
        let dir = index_state.dir_for_key(key).await?;
        Ok(self.routine_stores.get_or_create(key, &dir).await?)
    }

    pub async fn sync_routine_projection(
        &self,
        index_state: &IndexRuntimeState,
        key: &IndexKey,
    ) -> Result<(), IndexUpdateError> {
        let index_pool = index_state.get_or_create(key).await?;
        let routines_pool = self.routines_pool(index_state, key).await?;
        let space_dir = index_state.dir_for_key(key).await?;
        observation::reconcile_projection_from_index(&routines_pool, &index_pool, &space_dir)
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn projection_uses_the_same_open_index_and_operational_store() {
        let temp = tempfile::tempdir().unwrap();
        let key = IndexKey::Root(temp.path().to_path_buf());
        let index = IndexRuntimeState::default();
        let stores = Arc::new(RoutineStoreState::new());
        let updates = IndexUpdateState::new(stores.clone());
        let index_pool = index.get_or_create(&key).await.unwrap();
        let routines_pool = updates.routines_pool(&index, &key).await.unwrap();
        sqlx::query(
            "INSERT INTO entries (file_path, parent_path, title, created, updated, collection_root_path, in_collection, is_entry_head, fields, body_preview, is_discoverable) VALUES ('tasks/item.md', 'tasks', 'Item', '2026-01-01', '2026-01-02', 'tasks', 1, 1, '{}', '', 0)",
        )
        .execute(&index_pool)
        .await
        .unwrap();
        updates.sync_routine_projection(&index, &key).await.unwrap();
        let observed: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM routine_observation_baseline WHERE entry_path = 'tasks/item.md'",
        )
        .fetch_one(&routines_pool)
        .await
        .unwrap();
        assert_eq!(observed, 1);
        assert_eq!(index.pools.lock().await.physical_count(), 1);
        stores.close_key(&key).await;
        index.close_key(&key).await;
    }
}

pub async fn apply_targeted_change(
    index_pool: &SqlitePool,
    routines_pool: &SqlitePool,
    index_key: &IndexKey,
    space_dir: &Path,
    normalized: &str,
    entry: Option<&IndexedEntry>,
    source_record: Option<&SourceManifestRecord>,
    folded_collection: Option<&KnowledgeArtifact>,
    current_frontmatter_diff_safe: bool,
    origin: &CollectionEventOrigin,
) -> Result<(), IndexUpdateError> {
    let current = entry
        .map(|entry| observation::snapshot_from_entry(space_dir, entry))
        .transpose()?
        .flatten();
    let mut routines_transaction = routines_pool.begin().await?;
    let previous = observation::read_snapshot(&mut routines_transaction, &normalized).await?;
    let collection_path = current
        .as_ref()
        .map(|entry| entry.collection_path.as_str())
        .or_else(|| {
            previous
                .as_ref()
                .map(|entry| entry.collection_path.as_str())
        });
    let automatic_authority = match collection_path {
        Some(collection_path) => {
            match crate::routines::authority::read_key(
                space_dir,
                &ResolvedRoutineOwner::indexed_collection_identity(index_key, collection_path),
            ) {
                Ok(enabled) => enabled,
                Err(error) => {
                    tracing::warn!(
                        collection_path = %collection_path,
                        "routine Collection authority read failed closed: {error}"
                    );
                    false
                }
            }
        }
        None => false,
    };
    if automatic_authority {
        observation::queue_collection_events(
            &mut routines_transaction,
            space_dir,
            previous.as_ref(),
            current.as_ref(),
            current_frontmatter_diff_safe,
            origin,
        )
        .await?;
    }
    observation::write_snapshot(&mut routines_transaction, &normalized, current.as_ref()).await?;
    routines_transaction.commit().await?;

    let mut transaction = index_pool.begin().await?;
    let mut knowledge_changed = false;
    if let Some(entry) = entry {
        super::rows::upsert_entry(&mut *transaction, entry).await?;
        if let Some(artifact) = entry.knowledge.as_ref() {
            knowledge_changed |=
                super::knowledge_rows::upsert_artifact(&mut transaction, artifact).await?;
        } else if let Some(artifact) = folded_collection {
            knowledge_changed |=
                super::knowledge_rows::delete_artifact(&mut transaction, &normalized).await?;
            knowledge_changed |=
                super::knowledge_rows::upsert_artifact(&mut transaction, artifact).await?;
        } else {
            knowledge_changed |=
                super::knowledge_rows::delete_artifact(&mut transaction, &normalized).await?;
        }
    } else {
        sqlx::query("DELETE FROM entries WHERE file_path = ?")
            .bind(&normalized)
            .execute(&mut *transaction)
            .await?;
        knowledge_changed |=
            super::knowledge_rows::delete_artifact(&mut transaction, &normalized).await?;
        if let Some(artifact) = folded_collection {
            knowledge_changed |=
                super::knowledge_rows::upsert_artifact(&mut transaction, artifact).await?;
        } else if Path::new(&normalized)
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("readme.md"))
            && let Some(parent) = Path::new(&normalized)
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
        {
            knowledge_changed |= super::knowledge_rows::delete_artifact(
                &mut transaction,
                &parent.to_string_lossy().replace('\\', "/"),
            )
            .await?;
        }
    }
    let manifest_changed = super::manifest::reconcile_source_record(
        &mut transaction,
        &normalized,
        "markdown",
        source_record,
    )
    .await?;
    let manifest_exists: i64 =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM knowledge_manifest WHERE singleton = 1)")
            .fetch_one(&mut *transaction)
            .await?;
    if manifest_exists == 0 {
        super::knowledge_rows::refresh_manifest_preserving_diagnostics(&mut transaction).await?;
    }
    let skipped_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM knowledge_source_manifest WHERE diagnostic_code IS NOT NULL",
    )
    .fetch_one(&mut *transaction)
    .await?;
    sqlx::query("UPDATE knowledge_manifest SET skipped_count = ? WHERE singleton = 1")
        .bind(skipped_count)
        .execute(&mut *transaction)
        .await?;
    super::manifest::advance_generation(
        &mut transaction,
        knowledge_changed,
        manifest_changed || knowledge_changed,
    )
    .await?;
    transaction.commit().await?;
    Ok(())
}

pub async fn refresh_agent_context_projection(
    state: &IndexRuntimeState,
    space_dir: &Path,
) -> Result<(), IndexError> {
    let key = state
        .key_for_space_dir(space_dir)
        .await
        .unwrap_or_else(|| IndexKey::Root(space_dir.to_path_buf()));
    let keys = if matches!(&key, IndexKey::Root(_)) {
        state.keys_for_project(&key.project().to_path_buf()).await
    } else {
        vec![key]
    };
    for key in keys {
        let Some(pool) = state.existing_pool(&key).await else {
            continue;
        };
        let target_dir = state.dir_for_key(&key).await?;
        let lock = state.reindex_lock(&key).await;
        let _guard = lock.lock().await;
        let projected = crate::agent_context::projection::target_knowledge_projection(
            key.project(),
            &target_dir,
        )
        .await?;
        let artifacts = projected
            .iter()
            .filter(|artifact| artifact.owner_scope == "current")
            .map(crate::index::knowledge_artifact::build_agent_artifact)
            .collect::<Vec<_>>();
        let applicability = projected
            .iter()
            .filter(|artifact| artifact.is_effectively_applicable())
            .map(crate::index::knowledge_artifact::build_agent_applicability)
            .collect::<Vec<_>>();
        let previous_manifest = crate::index::manifest::read_source_manifest(&pool).await?;
        let mut current_manifest = previous_manifest
            .iter()
            .filter(|record| record.source_kind != "agent_context")
            .cloned()
            .collect::<Vec<_>>();
        current_manifest.extend(artifacts.iter().map(|artifact| {
            crate::index::manifest::SourceManifestRecord::agent_context(
                artifact.source_path.clone(),
                artifact.content_hash.clone(),
                artifact
                    .fragments
                    .iter()
                    .map(|fragment| fragment.text.len())
                    .sum(),
            )
        }));
        let mut transaction = pool.begin().await?;
        let knowledge_changed = crate::index::knowledge_rows::replace_agent_context(
            &mut transaction,
            &artifacts,
            &applicability,
        )
        .await?;
        let manifest_changed = crate::index::manifest::reconcile_source_manifest(
            &mut transaction,
            &previous_manifest,
            &current_manifest,
        )
        .await?;
        crate::index::manifest::advance_generation(
            &mut transaction,
            knowledge_changed,
            manifest_changed || knowledge_changed,
        )
        .await?;
        transaction.commit().await?;
    }
    Ok(())
}

pub async fn rebase_collection_schema_manifest(
    pool: &SqlitePool,
    old_root: &str,
    new_root: &str,
) -> Result<(), IndexUpdateError> {
    let old_root =
        crate::git::path::normalize_repo_relative(old_root, crate::git::path::RootMode::Reject)
            .map_err(IndexError::from)?;
    let new_root =
        crate::git::path::normalize_repo_relative(new_root, crate::git::path::RootMode::Reject)
            .map_err(IndexError::from)?;
    let old_prefix = format!("{old_root}/");
    let new_prefix = format!("{new_root}/");
    let mut transaction = pool.begin().await?;
    let paths = sqlx::query_scalar::<_, String>(
        "SELECT source_path FROM knowledge_source_manifest WHERE source_kind = 'collection_schema'",
    )
    .fetch_all(&mut *transaction)
    .await?;
    let mut changed = false;
    for old_path in paths {
        let Some(remainder) = old_path.strip_prefix(&old_prefix) else {
            continue;
        };
        let new_path = format!("{new_prefix}{remainder}");
        changed |= sqlx::query(
            "UPDATE knowledge_source_manifest SET source_path = ? WHERE source_path = ? AND source_kind = 'collection_schema'",
        )
        .bind(new_path)
        .bind(old_path)
        .execute(&mut *transaction)
        .await?
        .rows_affected()
            > 0;
    }
    crate::index::manifest::advance_generation(&mut transaction, false, changed).await?;
    transaction.commit().await?;
    Ok(())
}

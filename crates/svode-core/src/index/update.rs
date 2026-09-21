use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use sqlx::SqlitePool;

use super::manifest::SourceManifestRecord;
use super::model::{IndexedEntry, KnowledgeArtifact};
use super::state::IndexRuntimeState;
use super::{IndexError, IndexKey};
use crate::page::dates::GitDateExecutor;
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

    pub async fn repair_space<E: GitDateExecutor>(
        &self,
        index_state: &IndexRuntimeState,
        key: &IndexKey,
        executor: Option<&E>,
    ) -> Result<(), IndexUpdateError> {
        let pool = index_state.get_or_create(key).await?;
        let dir = index_state.dir_for_key(key).await?;
        let skip = index_state.skip_folders_for(key).await;
        let lock = index_state.reindex_lock(key).await;
        let flag = index_state.reindex_active_flag(key).await;
        let _guard = lock.lock().await;
        flag.store(true, Ordering::SeqCst);
        let _flag_guard = ActiveRepairGuard(flag);
        let complete =
            super::reindex::full_reindex_for_target(executor, &pool, key.project(), &dir, &skip)
                .await?;
        index_state.rebuild_source_backlinks(key).await?;
        self.sync_routine_projection(index_state, key).await?;
        if complete {
            index_state.cleanup_reconciled_index(key, &pool).await;
        }
        Ok(())
    }
}

struct ActiveRepairGuard(Arc<AtomicBool>);

impl Drop for ActiveRepairGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
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
        state.keys_for_project(key.project()).await
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

/// Publish one managed source path: Routine observation and the owning index
/// pool first, then the runtime backlink registry.
pub async fn publish_managed_path<E: GitDateExecutor>(
    state: &IndexRuntimeState,
    updates: &IndexUpdateState,
    git_dates: Option<&E>,
    project: &Path,
    abs_path: &Path,
) -> Result<(), IndexUpdateError> {
    publish_path_with_origin(
        state,
        updates,
        git_dates,
        project,
        abs_path,
        CollectionEventOrigin::managed(),
    )
    .await
}

pub async fn publish_path_with_origin<E: GitDateExecutor>(
    state: &IndexRuntimeState,
    updates: &IndexUpdateState,
    git_dates: Option<&E>,
    project: &Path,
    abs_path: &Path,
    origin: CollectionEventOrigin,
) -> Result<(), IndexUpdateError> {
    update_path_with_origin(state, updates, git_dates, project, abs_path, origin).await?;
    let (key, relative) = state.resolve(project, abs_path).await?;
    let space_id = IndexRuntimeState::space_id_for_key(&key);
    if abs_path.is_file() {
        state
            .update_file_backlinks(project, space_id.as_deref(), &relative)
            .await?;
    } else {
        state
            .remove_file_backlinks(project, space_id.as_deref(), &relative)
            .await?;
    }
    Ok(())
}

/// Incrementally update the index for a single absolute path.
///
/// Resolves the path to its owning pool, then upserts or deletes relative to
/// the owning space's root.
///
/// - If the file no longer exists on disk → delete the row.
/// - If the file exists but isn't a markdown file → also delete (e.g. user
///   renamed `foo.md` → `foo.txt`, leaving a stale entry).
/// - Otherwise → upsert.
pub async fn update_path_with_origin<E: GitDateExecutor>(
    state: &IndexRuntimeState,
    updates: &IndexUpdateState,
    git_dates: Option<&E>,
    project: &Path,
    abs_path: &Path,
    origin: CollectionEventOrigin,
) -> Result<(), IndexUpdateError> {
    let (key, rel_path) = state.resolve(project, abs_path).await?;
    let dir = state.dir_for_key(&key).await?;
    let pool = state.get_or_create(&key).await?;
    let routines_pool = updates.routines_pool(state, &key).await?;

    let normalized = normalize_rel(&rel_path)?;
    let abs = dir.join(&normalized);

    // Serialize against `full_reindex` for the same pool. Without this, an
    // UPSERT can land between full_reindex's FS walk and its DELETE-then-INSERT
    // transaction, where it is silently overwritten (Stage 3.5 Phase 5 §5.3).
    let lock = state.reindex_lock(&key).await;
    let _guard = lock.lock().await;

    let remove = || {
        apply_targeted_source_change(
            &pool,
            &routines_pool,
            &key,
            &dir,
            &normalized,
            None,
            None,
            false,
            &origin,
        )
    };
    if !abs.exists() {
        return remove().await;
    }

    let metadata = std::fs::symlink_metadata(&abs).map_err(IndexError::from)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return remove().await;
    }

    ensure_inside_space(&dir, &abs)?;

    let is_md = abs
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("md"))
        .unwrap_or(false);
    if !is_md {
        tracing::debug!("non-md file in update_entry, removing any stale row: {normalized}");
        return remove().await;
    }

    let policy = crate::content_tree::policy::TreeIgnorePolicy::from_space_root(&dir);
    let Some(projection) = super::inventory::markdown_projection(&dir, &abs, &policy)? else {
        return remove().await;
    };
    let source_record = super::inventory::markdown_source_record(&dir, &abs, projection)?;
    if source_record.diagnostic_code.is_some() {
        return apply_targeted_source_change(
            &pool,
            &routines_pool,
            &key,
            &dir,
            &normalized,
            None,
            Some(projection),
            false,
            &origin,
        )
        .await;
    }
    let date_overrides = match git_dates {
        Some(executor) => {
            crate::page::dates::derive_date_overrides(
                executor,
                &dir,
                std::slice::from_ref(&normalized),
            )
            .await
        }
        None => Default::default(),
    };
    let entry = super::entry_projection::build_entry_with_dates(
        &dir,
        &abs,
        date_overrides.get(&normalized),
        projection,
    )?;
    let frontmatter_valid = markdown_frontmatter_diff_safe(&abs);
    apply_targeted_source_change(
        &pool,
        &routines_pool,
        &key,
        &dir,
        &normalized,
        Some(&entry),
        Some(projection),
        frontmatter_valid,
        &origin,
    )
    .await
}

/// Apply one source change with its manifest record and folded Collection
/// artifact; Routine observation precedes the index transaction.
pub async fn apply_targeted_source_change(
    index_pool: &SqlitePool,
    routines_pool: &SqlitePool,
    index_key: &IndexKey,
    space_dir: &Path,
    rel_path: &str,
    entry: Option<&IndexedEntry>,
    source_projection: Option<super::inventory::MarkdownProjection>,
    current_frontmatter_diff_safe: bool,
    origin: &CollectionEventOrigin,
) -> Result<(), IndexUpdateError> {
    let normalized = normalize_rel(rel_path)?;
    let source_path = space_dir.join(&normalized);
    let mut source_record = if let Some(projection) = source_projection
        && source_path.is_file()
        && source_path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
    {
        Some(super::inventory::markdown_source_record(
            space_dir,
            &source_path,
            projection,
        )?)
    } else {
        None
    };
    if let (Some(record), Some(entry)) = (source_record.as_mut(), entry) {
        record.diagnostic_code = entry.source_diagnostic.clone();
    }
    let folded_collection =
        super::knowledge_artifact::folded_collection_artifact(space_dir, &normalized);
    apply_targeted_change(
        index_pool,
        routines_pool,
        index_key,
        space_dir,
        &normalized,
        entry,
        source_record.as_ref(),
        folded_collection.as_ref(),
        current_frontmatter_diff_safe,
        origin,
    )
    .await
}

fn normalize_rel(path: &str) -> Result<String, IndexError> {
    Ok(crate::git::path::normalize_repo_relative(
        path,
        crate::git::path::RootMode::Reject,
    )?)
}

/// Verify that an absolute path resolves inside the space root, guarding
/// against `..` traversal in user-supplied relative paths. If either side
/// fails to canonicalize, the check is skipped — the caller is expected to
/// have already established that `abs_path` exists, and a non-canonicalizable
/// `space_dir` means we have bigger problems.
fn ensure_inside_space(space_dir: &Path, abs_path: &Path) -> Result<(), IndexError> {
    let (Ok(canon_abs), Ok(canon_root)) = (abs_path.canonicalize(), space_dir.canonicalize())
    else {
        return Ok(());
    };
    if !canon_abs.starts_with(&canon_root) {
        return Err(IndexError::Index(format!(
            "path escapes space root: {}",
            abs_path.display()
        )));
    }
    Ok(())
}

pub fn markdown_frontmatter_diff_safe(path: &Path) -> bool {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    if matches!(
        crate::page::frontmatter::parse_status(&raw),
        crate::page::frontmatter::ParseStatus::Malformed { .. }
    ) {
        tracing::warn!(
            "collection event field diff skipped for malformed frontmatter: {}",
            path.display()
        );
        return false;
    }
    true
}

/// Rebase Collection schema manifest rows of the pool that owns `space_dir`
/// after a Collection root moved, then refresh the Routine projection.
pub async fn rebase_space_collection_schema_manifest(
    state: &IndexRuntimeState,
    updates: &IndexUpdateState,
    space_dir: &Path,
    old_root: &str,
    new_root: &str,
) -> Result<(), IndexUpdateError> {
    let key = state
        .key_for_space_dir(space_dir)
        .await
        .unwrap_or_else(|| IndexKey::Root(space_dir.to_path_buf()));
    let pool = state.get_or_create(&key).await?;
    let lock = state.reindex_lock(&key).await;
    let _guard = lock.lock().await;
    rebase_collection_schema_manifest(&pool, old_root, new_root).await?;
    updates.sync_routine_projection(state, &key).await?;
    Ok(())
}

/// Full repair of the pool that owns `space`; failures are logged.
pub async fn repair_space_dir<E: GitDateExecutor>(
    state: &IndexRuntimeState,
    updates: &IndexUpdateState,
    git_dates: Option<&E>,
    space: &str,
) {
    let key = state
        .key_for_space_dir(Path::new(space))
        .await
        .unwrap_or_else(|| IndexKey::Root(std::path::PathBuf::from(space)));
    tracing::info!(
        event = "index.reindex.repair",
        space,
        key = ?key,
        "running full index repair reindex"
    );
    if let Err(error) = updates.repair_space(state, &key, git_dates).await {
        tracing::warn!("index repair reindex failed for {:?}: {error}", key);
    }
}

/// Publish managed paths in the Project runtime. Without a Project, or when a
/// targeted update fails, the owning Space pool is repaired instead. Returns
/// the targeted update errors.
pub async fn publish_paths_or_repair<E: GitDateExecutor>(
    state: &IndexRuntimeState,
    updates: &IndexUpdateState,
    git_dates: Option<&E>,
    project_path: Option<&str>,
    space: &str,
    paths: Vec<std::path::PathBuf>,
    context: &str,
) -> Vec<String> {
    let Some(project) = project_path.filter(|path| !path.is_empty()) else {
        repair_space_dir(state, updates, git_dates, space).await;
        return Vec::new();
    };
    let mut errors = Vec::new();
    for path in paths {
        if let Err(error) =
            publish_managed_path(state, updates, git_dates, Path::new(project), &path).await
        {
            tracing::warn!(
                "{context}: targeted index update failed for {}: {error}",
                path.display()
            );
            errors.push(error.to_string());
        }
    }
    if !errors.is_empty() {
        repair_space_dir(state, updates, git_dates, space).await;
    }
    errors
}

/// Publish every Markdown source under `rel_root`; on a walk or targeted
/// update failure the owning Space pool is repaired instead.
pub async fn publish_tree_or_repair<E: GitDateExecutor>(
    state: &IndexRuntimeState,
    updates: &IndexUpdateState,
    git_dates: Option<&E>,
    project_path: Option<&str>,
    space: &str,
    rel_root: &str,
    context: &str,
) {
    let root = Path::new(space);
    let paths = match crate::content_tree::collect_markdown_paths(
        root,
        &root.join(rel_root),
        &crate::content_tree::policy::TreeIgnorePolicy::from_space_root(root),
    ) {
        Ok(paths) => paths,
        Err(error) => {
            tracing::warn!("{context}: collect markdown paths failed for {rel_root}: {error}");
            repair_space_dir(state, updates, git_dates, space).await;
            return;
        }
    };
    let _ = publish_paths_or_repair(
        state,
        updates,
        git_dates,
        project_path,
        space,
        paths,
        context,
    )
    .await;
}

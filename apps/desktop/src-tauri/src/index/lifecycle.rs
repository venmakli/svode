use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use sqlx::SqlitePool;
use tokio::sync::{Mutex, OwnedMutexGuard};

use super::{IndexKey, open_prepared_pool};
use crate::error::AppError;

/// The registry lock covers open, schema replacement, publication and close.
/// Queries and source reconciliation use cloned pools outside this lock.
#[derive(Default)]
pub(super) struct IndexPools {
    owners: HashMap<IndexKey, PathBuf>,
    physical: HashMap<PathBuf, PhysicalPool>,
}

struct PhysicalPool {
    pool: SqlitePool,
    inspection: Arc<Mutex<()>>,
    deletion: Arc<Mutex<()>>,
}

/// A cleanup belongs to one published pool generation, including path aliases.
#[derive(Clone)]
pub(super) struct CleanupOwner {
    pool: SqlitePool,
    deletion: Arc<Mutex<()>>,
}

impl CleanupOwner {
    pub(super) fn is_closed(&self) -> bool {
        self.pool.is_closed()
    }

    pub(super) async fn authorize_deletion(&self) -> Option<OwnedMutexGuard<()>> {
        let guard = self.deletion.clone().lock_owned().await;
        if self.pool.is_closed() {
            return None;
        }
        let ready = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM knowledge_manifest WHERE singleton = 1 AND failure_count = 0
             AND NOT EXISTS (SELECT 1 FROM knowledge_source_manifest WHERE diagnostic_code NOT IN ('excluded_secret_like', 'oversized_source'))"
        ).fetch_one(&self.pool).await;
        matches!(ready, Ok(1)).then_some(guard)
    }
}

impl IndexPools {
    pub(super) fn get(&self, key: &IndexKey) -> Option<SqlitePool> {
        self.owners
            .get(key)
            .and_then(|path| self.physical.get(path))
            .map(|physical| physical.pool.clone())
    }
}

pub(super) async fn open(
    mut pools: OwnedMutexGuard<IndexPools>,
    key: IndexKey,
    dir: PathBuf,
) -> Result<SqlitePool, AppError> {
    // Keep the lock in the worker if its caller is cancelled. A close waits
    // for publication and drains that pool before allowing another open.
    tokio::spawn(async move {
        let storage = dir.join(".svode");
        std::fs::create_dir_all(&storage)?;
        let path = storage.canonicalize()?.join("index.db");
        let path = if path.exists() {
            path.canonicalize()?
        } else {
            path
        };
        let pool = match pools.physical.get(&path) {
            Some(physical) => physical.pool.clone(),
            None => {
                let pool = open_prepared_pool(&path).await?;
                pools.physical.insert(
                    path.clone(),
                    PhysicalPool {
                        pool: pool.clone(),
                        inspection: Arc::new(Mutex::new(())),
                        deletion: Arc::new(Mutex::new(())),
                    },
                );
                pool
            }
        };
        pools.owners.insert(key, path);
        Ok(pool)
    })
    .await
    .map_err(|error| AppError::Index(format!("index initializer task failed: {error}")))?
}

pub(super) async fn cleanup(pools: OwnedMutexGuard<IndexPools>, key: IndexKey, pool: SqlitePool) {
    cleanup_using(pools, key, pool, |directory, owner| async move {
        super::retention::cleanup_with_owner(&directory, Some(&owner)).await
    })
    .await;
}

async fn cleanup_using<F, Fut>(
    pools: OwnedMutexGuard<IndexPools>,
    key: IndexKey,
    pool: SqlitePool,
    inspect: F,
) where
    F: FnOnce(PathBuf, CleanupOwner) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<(), AppError>> + Send,
{
    if pool.is_closed() {
        return;
    }
    let Some(path) = pools.owners.get(&key) else {
        return;
    };
    if path.file_name().is_none_or(|name| name != "index.db") {
        return;
    }
    let physical = &pools.physical[path];
    // Coalesce repeated reconciliation requests for this physical generation.
    let Ok(inspection) = physical.inspection.clone().try_lock_owned() else {
        return;
    };
    let owner = CleanupOwner {
        pool,
        deletion: physical.deletion.clone(),
    };
    let directory = path.parent().unwrap().to_path_buf();
    drop(pools);

    // Inspection may outlive its pool. Only deletion excludes same-owner close;
    // neither phase holds the global registry during file copying or hashing.
    let task = tokio::spawn(async move {
        let Some(ready) = owner.authorize_deletion().await else {
            return;
        };
        drop(ready);
        tracing::info!(store = "index", owner = %directory.display(), "source reconciliation complete; checking incompatible families");
        if inspect(directory, owner).await.is_err() {
            tracing::warn!(
                store = "index",
                "quarantine inventory failed; cleanup will retry after reconciliation"
            );
        }
        drop(inspection);
    });
    if task.await.is_err() {
        tracing::warn!(store = "index", "quarantine cleanup worker failed");
    }
}

pub(super) async fn close(
    mut pools: OwnedMutexGuard<IndexPools>,
    key: Option<&IndexKey>,
    project: Option<&Path>,
) -> HashSet<IndexKey> {
    let registry = OwnedMutexGuard::mutex(&pools).clone();
    let key = key.cloned();
    let project = project.map(Path::to_path_buf);
    let task = tokio::spawn(async move {
        loop {
            let paths: HashSet<_> = pools
                .owners
                .iter()
                .filter(|(owner, _)| {
                    key.as_ref() == Some(*owner) || project.as_deref() == Some(owner.project())
                })
                .map(|(_, path)| path.clone())
                .collect();
            let mut deletion_guards = Vec::new();
            let mut busy = None;
            for path in &paths {
                let gate = pools.physical[path].deletion.clone();
                match gate.clone().try_lock_owned() {
                    Ok(guard) => deletion_guards.push(guard),
                    Err(_) => {
                        busy = Some(gate);
                        break;
                    }
                }
            }
            if let Some(gate) = busy {
                // Waiting for same-owner deletion must not block other owners.
                drop(deletion_guards);
                drop(pools);
                drop(gate.lock_owned().await);
                pools = registry.clone().lock_owned().await;
                continue;
            }
            let keys: HashSet<_> = pools
                .owners
                .iter()
                .filter(|(_, path)| paths.contains(*path))
                .map(|(key, _)| key.clone())
                .collect();
            for path in paths {
                if let Some(physical) = pools.physical.get(&path) {
                    tracing::info!(store = "index", "closing index pool");
                    super::db::close_pool(&physical.pool).await;
                }
                pools.physical.remove(&path);
            }
            for key in &keys {
                pools.owners.remove(key);
            }
            return keys;
        }
    });
    match task.await {
        Ok(keys) => keys,
        Err(error) => {
            tracing::error!(store = "index", %error, "index close task failed");
            HashSet::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::{IndexState, db};
    use std::sync::Arc;

    fn generations(dir: &Path) -> usize {
        std::fs::read_dir(dir.join(".svode"))
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .contains("index.db.incompatible-")
            })
            .count()
    }

    #[tokio::test]
    async fn slow_inspection_allows_other_owners_and_reopen_rejects_stale_cleanup() {
        use tokio::sync::oneshot;
        use tokio::time::{Duration, timeout};
        let temp = tempfile::TempDir::new().unwrap();
        let state = Arc::new(IndexState::new());
        let key = IndexKey::Root(temp.path().join("first"));
        let other = IndexKey::Root(temp.path().join("other"));
        let pool = state.get_or_create(&key).await.unwrap();
        state.run_full_reindex(&key).await.unwrap();
        let directory = state.dir_for_key(&key).await.unwrap().join(".svode");
        let old = directory.join("index.db.incompatible-123");
        let legacy = db::create_pool(&old).await.unwrap();
        sqlx::raw_sql(include_str!("fixtures/index-v15.sql"))
            .execute(&legacy)
            .await
            .unwrap();
        db::close_pool(&legacy).await;
        let before = std::fs::read(&old).unwrap();
        let (entered_tx, entered_rx) = oneshot::channel();
        let (resume_tx, resume_rx) = oneshot::channel();
        let task = {
            let state = state.clone();
            let key = key.clone();
            let pool = pool.clone();
            tokio::spawn(async move {
                cleanup_using(
                    state.pools.clone().lock_owned().await,
                    key,
                    pool,
                    |directory, owner| async move {
                        entered_tx.send(()).unwrap();
                        resume_rx.await.unwrap();
                        super::super::retention::cleanup_with_owner(&directory, Some(&owner)).await
                    },
                )
                .await;
            })
        };
        timeout(Duration::from_secs(5), entered_rx)
            .await
            .unwrap()
            .unwrap();
        // Ready reads and a cold open remain usable while inspection is paused.
        timeout(Duration::from_secs(5), state.get_or_create(&key))
            .await
            .unwrap()
            .unwrap();
        let other_pool = timeout(Duration::from_secs(5), state.get_or_create(&other))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT 1")
                .fetch_one(&other_pool)
                .await
                .unwrap(),
            1
        );
        // A duplicate request is coalesced rather than queued behind this scan.
        timeout(
            Duration::from_secs(5),
            state.cleanup_reconciled_index(&key, &pool),
        )
        .await
        .unwrap();
        timeout(Duration::from_secs(5), state.close_key(&key))
            .await
            .unwrap();
        let replacement = timeout(Duration::from_secs(5), state.get_or_create(&key))
            .await
            .unwrap()
            .unwrap();
        assert!(pool.is_closed());
        assert!(!replacement.is_closed());
        resume_tx.send(()).unwrap();
        timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            std::fs::read(&old).unwrap(),
            before,
            "old cleanup deleted after reopen"
        );
        state.run_full_reindex(&key).await.unwrap();
        assert!(!old.exists(), "current successful rebuild can clean up");
        state.close_key(&key).await;
        state.close_key(&other).await;
    }

    #[tokio::test]
    async fn pending_deletion_close_does_not_hold_registry_and_survives_cancellation() {
        use tokio::time::{Duration, timeout};
        let temp = tempfile::TempDir::new().unwrap();
        let state = Arc::new(IndexState::new());
        let key = IndexKey::Root(temp.path().join("first"));
        let other = IndexKey::Root(temp.path().join("other"));
        let pool = state.get_or_create(&key).await.unwrap();
        state.run_full_reindex(&key).await.unwrap();
        let owner = {
            let pools = state.pools.lock().await;
            let physical = &pools.physical[&pools.owners[&key]];
            CleanupOwner {
                pool: pool.clone(),
                deletion: physical.deletion.clone(),
            }
        };
        let deletion = owner.authorize_deletion().await.unwrap();
        let close = {
            let state = state.clone();
            let key = key.clone();
            tokio::spawn(async move { state.close_key(&key).await })
        };
        // Wait until close is queued on the owner gate, without wall-clock sleeps.
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
        assert!(!close.is_finished());
        timeout(Duration::from_secs(5), state.get_or_create(&other))
            .await
            .unwrap()
            .unwrap();
        timeout(Duration::from_secs(5), state.get_or_create(&key))
            .await
            .unwrap()
            .unwrap();
        close.abort();
        drop(deletion);
        timeout(Duration::from_secs(5), pool.close_event())
            .await
            .unwrap();
        let replacement = timeout(Duration::from_secs(5), state.get_or_create(&key))
            .await
            .unwrap()
            .unwrap();
        assert!(!replacement.is_closed());
        assert!(owner.authorize_deletion().await.is_none());
        state.close_key(&key).await;
        state.close_key(&other).await;
    }

    #[tokio::test]
    async fn cancelled_initializer_cannot_publish_after_close() {
        let temp = tempfile::TempDir::new().unwrap();
        let path = temp.path().join(".svode/index.db");
        let blocker = db::create_pool(&path).await.unwrap();
        let mut connection = blocker.acquire().await.unwrap();
        sqlx::query("BEGIN EXCLUSIVE")
            .execute(&mut *connection)
            .await
            .unwrap();
        let state = Arc::new(IndexState::new());
        let key = IndexKey::Root(temp.path().to_path_buf());
        let caller = {
            let state = state.clone();
            let key = key.clone();
            tokio::spawn(async move { state.get_or_create(&key).await })
        };
        while state.pools.try_lock().is_ok() {
            tokio::task::yield_now().await;
        }
        caller.abort();
        let close = {
            let state = state.clone();
            let project = temp.path().to_path_buf();
            tokio::spawn(async move { state.close_project(&project).await })
        };
        sqlx::query("ROLLBACK")
            .execute(&mut *connection)
            .await
            .unwrap();
        drop(connection);
        blocker.close().await;
        close.await.unwrap();
        assert!(state.existing_pool(&key).await.is_none());
        let pool = state.get_or_create(&key).await.unwrap();
        assert_eq!(
            db::schema_status(&pool).await.unwrap(),
            db::SchemaStatus::Current
        );
        assert_eq!(generations(temp.path()), 0);
        state.close_key(&key).await;
    }

    #[tokio::test]
    async fn root_inline_and_independent_owners_preserve_operational_rows() {
        let temp = tempfile::TempDir::new().unwrap();
        let project = temp.path();
        let state = IndexState::new();
        let mut cache = super::super::ProjectSpacesCache::default();
        for folder in ["inline", "independent"] {
            std::fs::create_dir_all(project.join(folder)).unwrap();
            cache.folder_by_id.insert(folder.into(), folder.into());
        }
        state
            .spaces_cache
            .lock()
            .await
            .insert(project.to_path_buf(), cache);
        let keys = [
            IndexKey::Root(project.to_path_buf()),
            IndexKey::Space {
                project: project.to_path_buf(),
                space_id: "inline".into(),
            },
            IndexKey::Space {
                project: project.to_path_buf(),
                space_id: "independent".into(),
            },
        ];
        for (i, key) in keys.iter().enumerate() {
            let routines = state.get_or_create_routines(key).await.unwrap();
            sqlx::query("INSERT INTO routine_schedule_state VALUES (?, 'routine', 'fingerprint', 'checkpoint', 'next-run')")
                .bind(format!("owner-{i}")).execute(&routines).await.unwrap();
            let dir = state.dir_for_key(key).await.unwrap();
            crate::space::config::mutate_local_config(&dir, |local| {
                if i == 0 {
                    local.agent_sessions = Some(crate::space::types::AgentSessionsLocalConfig {
                        pinned_session_ids: vec!["codex:retained-pin".into()],
                    });
                }
                local
                    .routines
                    .as_mut()
                    .unwrap()
                    .automatic_authority
                    .insert(format!("owner-{i}"), true);
                Ok(())
            })
            .unwrap();
            sqlx::query("INSERT INTO routine_owner_roots VALUES (?)")
                .bind(format!("owner-{i}"))
                .execute(&routines)
                .await
                .unwrap();
            let index = state.get_or_create(key).await.unwrap();
            sqlx::query("UPDATE schema_version SET version = 16")
                .execute(&index)
                .await
                .unwrap();
        }
        for (i, key) in keys.iter().enumerate() {
            let dir = state.dir_for_key(key).await.unwrap();
            let local_before = std::fs::read(dir.join(".svode/local.json")).unwrap();
            let old = dir.join(".svode/index.db.incompatible-1");
            let old_pool = sqlx::sqlite::SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(
                    sqlx::sqlite::SqliteConnectOptions::new()
                        .filename(&old)
                        .create_if_missing(true),
                )
                .await
                .unwrap();
            sqlx::raw_sql(include_str!("fixtures/index-v15.sql"))
                .execute(&old_pool)
                .await
                .unwrap();
            db::close_pool(&old_pool).await;
            std::fs::write(dir.join("page.md"), "# Preserved searchable content").unwrap();
            let owner = dir.join(format!("owner-{i}"));
            std::fs::create_dir_all(&owner).unwrap();
            std::fs::write(
                owner.join("schema.yaml"),
                "name: Retained owner\nproperties: []\n",
            )
            .unwrap();
            state.close_key(key).await;
            let index = state.get_or_create(key).await.unwrap();
            assert_eq!(
                db::schema_status(&index).await.unwrap(),
                db::SchemaStatus::Current
            );
            state.run_full_reindex(key).await.unwrap();
            assert!(!old.exists());
            assert_eq!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM entries WHERE file_path = 'page.md'"
                )
                .fetch_one(&index)
                .await
                .unwrap(),
                1
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM knowledge_documents WHERE source_path = 'page.md'"
                )
                .fetch_one(&index)
                .await
                .unwrap(),
                1
            );
            let routines = state.get_or_create_routines(key).await.unwrap();
            assert_eq!(sqlx::query_as::<_, (String, String, String, String, String)>(
                "SELECT owner_path, routine_id, definition_fingerprint, checkpoint_at, next_run_at FROM routine_schedule_state"
            ).fetch_all(&routines).await.unwrap(), vec![(format!("owner-{i}"), "routine".into(), "fingerprint".into(), "checkpoint".into(), "next-run".into())]);
            assert_eq!(
                sqlx::query_scalar::<_, String>("SELECT owner_path FROM routine_owner_roots")
                    .fetch_all(&routines)
                    .await
                    .unwrap(),
                vec![format!("owner-{i}")]
            );
            assert_eq!(
                std::fs::read(dir.join(".svode/local.json")).unwrap(),
                local_before
            );
            assert_eq!(generations(&dir), 1);
        }
        state.close_project(project).await;
    }

    #[tokio::test]
    async fn concurrent_cold_open_and_reopen_share_one_physical_generation() {
        let temp = tempfile::TempDir::new().unwrap();
        let state = Arc::new(IndexState::new());
        let key = IndexKey::Root(temp.path().to_path_buf());
        let old = db::create_pool(&temp.path().join(".svode/index.db"))
            .await
            .unwrap();
        sqlx::raw_sql("CREATE TABLE schema_version (version INTEGER); INSERT INTO schema_version VALUES (16);")
            .execute(&old).await.unwrap();
        db::close_pool(&old).await;
        assert_eq!(old.size(), 0, "pool close returned with live connections");
        let mut tasks = Vec::new();
        for _ in 0..24 {
            let state = state.clone();
            let key = key.clone();
            tasks.push(tokio::spawn(async move {
                state.get_or_create(&key).await.unwrap()
            }));
        }
        let mut pools = Vec::new();
        for task in tasks {
            pools.push(task.await.unwrap());
        }
        assert_eq!(generations(temp.path()), 1);
        assert_eq!(state.pools.lock().await.physical.len(), 1);
        for _ in 0..5 {
            state.close_project(temp.path()).await;
            for pool in &pools {
                assert!(pool.is_closed());
            }
            let pool = state.get_or_create(&key).await.unwrap();
            assert_eq!(
                db::schema_status(&pool).await.unwrap(),
                db::SchemaStatus::Current
            );
        }
        assert_eq!(generations(temp.path()), 1);
        state.close_project(temp.path()).await;
    }

    #[tokio::test]
    async fn cancelled_close_drains_connections_before_reopen() {
        let temp = tempfile::TempDir::new().unwrap();
        let state = Arc::new(IndexState::new());
        let key = IndexKey::Root(temp.path().to_path_buf());
        let pool = state.get_or_create(&key).await.unwrap();
        let connection = pool.acquire().await.unwrap();
        let closer = {
            let state = state.clone();
            let key = key.clone();
            tokio::spawn(async move { state.close_key(&key).await })
        };
        pool.close_event().await;
        closer.abort();
        let reopen = {
            let state = state.clone();
            let key = key.clone();
            tokio::spawn(async move { state.get_or_create(&key).await.unwrap() })
        };
        tokio::task::yield_now().await;
        assert!(!reopen.is_finished());
        drop(connection);
        let replacement = reopen.await.unwrap();
        assert!(!replacement.is_closed());
        assert!(pool.is_closed());
        assert_eq!(generations(temp.path()), 0);
        state.close_key(&key).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn path_aliases_share_pool_and_close_together() {
        let temp = tempfile::TempDir::new().unwrap();
        let dir = temp.path().join("owner");
        std::fs::create_dir(&dir).unwrap();
        let alias = temp.path().join("alias");
        std::os::unix::fs::symlink(&dir, &alias).unwrap();
        let state = IndexState::new();
        let key = IndexKey::Root(dir.clone());
        let alias_key = IndexKey::Root(alias);
        let first = state.get_or_create(&key).await.unwrap();
        let second = state.get_or_create(&alias_key).await.unwrap();
        assert_eq!(state.pools.lock().await.physical.len(), 1);
        state.close_key(&key).await;
        assert!(first.is_closed());
        assert!(second.is_closed());
        assert!(state.existing_pool(&alias_key).await.is_none());
    }

    #[tokio::test]
    async fn interrupted_legacy_bootstrap_is_preserved_and_retry_converges() {
        let temp = tempfile::TempDir::new().unwrap();
        let path = temp.path().join(".svode/index.db");
        let partial = db::create_pool(&path).await.unwrap();
        sqlx::raw_sql("CREATE TABLE schema_version (version INTEGER); CREATE TABLE unknown_evidence (value TEXT); INSERT INTO unknown_evidence VALUES ('keep');")
            .execute(&partial).await.unwrap();
        db::close_pool(&partial).await;
        let state = IndexState::new();
        let key = IndexKey::Root(temp.path().to_path_buf());
        state.get_or_create(&key).await.unwrap();
        state.close_key(&key).await;
        state.get_or_create(&key).await.unwrap();
        assert_eq!(generations(temp.path()), 1);
        let backup = std::fs::read_dir(temp.path().join(".svode"))
            .unwrap()
            .flatten()
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("index.db.incompatible-")
            })
            .unwrap()
            .path();
        let evidence = db::create_pool(&backup).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT value FROM unknown_evidence")
                .fetch_one(&evidence)
                .await
                .unwrap(),
            "keep"
        );
        evidence.close().await;
        state.close_key(&key).await;
    }
}

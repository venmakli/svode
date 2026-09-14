use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use sqlx::SqlitePool;
use tokio::sync::OwnedMutexGuard;

use super::{IndexKey, open_prepared_pool};
use crate::error::AppError;

/// The registry lock covers open, schema replacement, publication and close.
/// Queries and source reconciliation use cloned pools outside this lock.
#[derive(Default)]
pub(super) struct IndexPools {
    owners: HashMap<IndexKey, PathBuf>,
    physical: HashMap<PathBuf, SqlitePool>,
}

impl IndexPools {
    pub(super) fn get(&self, key: &IndexKey) -> Option<SqlitePool> {
        self.owners
            .get(key)
            .and_then(|path| self.physical.get(path))
            .cloned()
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
            Some(pool) => pool.clone(),
            None => {
                let pool = open_prepared_pool(&path).await?;
                pools.physical.insert(path.clone(), pool.clone());
                pool
            }
        };
        pools.owners.insert(key, path);
        Ok(pool)
    })
    .await
    .map_err(|error| AppError::Index(format!("index initializer task failed: {error}")))?
}

pub(super) async fn close(
    mut pools: OwnedMutexGuard<IndexPools>,
    key: Option<&IndexKey>,
    project: Option<&Path>,
) -> HashSet<IndexKey> {
    let paths: HashSet<_> = pools
        .owners
        .iter()
        .filter(|(owner, _)| key == Some(*owner) || project == Some(owner.project()))
        .map(|(_, path)| path.clone())
        .collect();
    let keys: HashSet<_> = pools
        .owners
        .iter()
        .filter(|(_, path)| paths.contains(*path))
        .map(|(key, _)| key.clone())
        .collect();
    let closed_keys = keys.clone();
    let task = tokio::spawn(async move {
        for path in paths {
            if let Some(pool) = pools.physical.get(&path) {
                tracing::info!(store = "index", "closing index pool");
                pool.close().await;
            }
            pools.physical.remove(&path);
        }
        for key in keys {
            pools.owners.remove(&key);
        }
    });
    if let Err(error) = task.await {
        tracing::error!(store = "index", %error, "index close task failed");
    }
    closed_keys
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
            state.close_key(key).await;
            let index = state.get_or_create(key).await.unwrap();
            assert_eq!(
                db::schema_status(&index).await.unwrap(),
                db::SchemaStatus::Current
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
        old.close().await;
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
        partial.close().await;
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

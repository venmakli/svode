use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use sqlx::SqlitePool;
use tokio::sync::Mutex;

use super::{authority, storage};
use crate::AppError;
use crate::index::{IndexKey, IndexState};

#[derive(Default)]
pub struct RoutineStoreState {
    pools: Mutex<HashMap<IndexKey, SqlitePool>>,
    open_locks: Mutex<HashMap<IndexKey, Arc<Mutex<()>>>>,
}

impl RoutineStoreState {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn get_or_create(
        &self,
        key: &IndexKey,
        space_dir: &Path,
    ) -> Result<SqlitePool, AppError> {
        if let Some(pool) = self.pools.lock().await.get(key).cloned() {
            return Ok(pool);
        }

        let lock = {
            let mut locks = self.open_locks.lock().await;
            locks
                .entry(key.clone())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _guard = lock.lock().await;
        if let Some(pool) = self.pools.lock().await.get(key).cloned() {
            return Ok(pool);
        }

        let previously_created = authority::storage_was_created(space_dir)?;
        let outcome =
            storage::open_pool(&storage::database_path(space_dir), previously_created).await?;
        if let Some(evidence) = outcome.recovery {
            if let Err(error) = authority::record_recovery(space_dir, evidence) {
                outcome.pool.close().await;
                return Err(error);
            }
        } else if !previously_created && let Err(error) = authority::mark_storage_ready(space_dir) {
            outcome.pool.close().await;
            return Err(error);
        }

        let mut pools = self.pools.lock().await;
        if let Some(existing) = pools.get(key) {
            outcome.pool.close().await;
            return Ok(existing.clone());
        }
        pools.insert(key.clone(), outcome.pool.clone());
        Ok(outcome.pool)
    }

    pub async fn get_or_create_for_index(
        &self,
        index_state: &IndexState,
        key: &IndexKey,
    ) -> Result<SqlitePool, AppError> {
        let space_dir = index_state.dir_for_key(key).await?;
        self.get_or_create(key, &space_dir).await
    }

    pub async fn owner_paths(
        &self,
        index_state: &IndexState,
        key: &IndexKey,
    ) -> Result<Vec<String>, AppError> {
        let pool = self.get_or_create_for_index(index_state, key).await?;
        Ok(sqlx::query_scalar::<_, String>(
            "SELECT owner_path FROM routine_owner_roots ORDER BY owner_path",
        )
        .fetch_all(&pool)
        .await?)
    }

    pub async fn close_key(&self, key: &IndexKey) {
        let lock = {
            let mut locks = self.open_locks.lock().await;
            locks
                .entry(key.clone())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _guard = lock.lock().await;
        if let Some(pool) = self.pools.lock().await.remove(key) {
            tracing::info!(?key, "closing routines pool");
            pool.close().await;
        }
    }

    pub async fn close_project(&self, project: &Path) {
        let mut keys = self
            .pools
            .lock()
            .await
            .keys()
            .filter(|key| key.project() == project)
            .cloned()
            .collect::<HashSet<_>>();
        keys.extend(
            self.open_locks
                .lock()
                .await
                .keys()
                .filter(|key| key.project() == project)
                .cloned(),
        );
        for key in keys {
            self.close_key(&key).await;
        }
    }

    pub async fn reconcile_project(
        &self,
        index_state: &IndexState,
        project: &Path,
    ) -> Result<(), AppError> {
        let desired = index_state
            .keys_for_project(&project.to_path_buf())
            .await
            .into_iter()
            .collect::<HashSet<_>>();
        let stale = self
            .pools
            .lock()
            .await
            .keys()
            .filter(|key| key.project() == project && !desired.contains(*key))
            .cloned()
            .collect::<Vec<_>>();
        for key in stale {
            self.close_key(&key).await;
        }
        for key in desired {
            let dir = index_state.dir_for_key(&key).await?;
            self.get_or_create(&key, &dir).await?;
        }
        Ok(())
    }

    #[cfg(test)]
    async fn keys_for_project(&self, project: &Path) -> Vec<IndexKey> {
        self.pools
            .lock()
            .await
            .keys()
            .filter(|key| key.project() == project)
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn concurrent_open_uses_one_pool_generation_and_close_drains_clones() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().to_path_buf();
        let key = IndexKey::Root(project.clone());
        let stores = Arc::new(RoutineStoreState::new());
        let mut tasks = Vec::new();
        for _ in 0..24 {
            let stores = stores.clone();
            let key = key.clone();
            let project = project.clone();
            tasks.push(tokio::spawn(async move {
                stores.get_or_create(&key, &project).await.unwrap()
            }));
        }
        let mut pools = Vec::new();
        for task in tasks {
            pools.push(task.await.unwrap());
        }

        sqlx::query("INSERT INTO routine_owner_roots VALUES ('shared-owner')")
            .execute(&pools[0])
            .await
            .unwrap();
        for pool in &pools {
            assert_eq!(
                sqlx::query_scalar::<_, String>(
                    "SELECT owner_path FROM routine_owner_roots WHERE owner_path = 'shared-owner'",
                )
                .fetch_one(pool)
                .await
                .unwrap(),
                "shared-owner"
            );
        }

        stores.close_project(&project).await;
        assert!(pools.iter().all(SqlitePool::is_closed));
    }

    #[tokio::test]
    async fn project_close_preserves_operational_store_and_reopens_it() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path();
        let root = IndexKey::Root(project.to_path_buf());
        let child_dir = project.join("child");
        std::fs::create_dir_all(&child_dir).unwrap();
        let child = IndexKey::Space {
            project: project.to_path_buf(),
            space_id: "child".into(),
        };
        let stores = RoutineStoreState::new();

        let root_pool = stores.get_or_create(&root, project).await.unwrap();
        let child_pool = stores.get_or_create(&child, &child_dir).await.unwrap();
        sqlx::query("INSERT INTO routine_owner_roots VALUES ('root-owner')")
            .execute(&root_pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO routine_owner_roots VALUES ('child-owner')")
            .execute(&child_pool)
            .await
            .unwrap();

        stores.close_project(project).await;
        assert!(root_pool.is_closed());
        assert!(child_pool.is_closed());
        assert!(stores.keys_for_project(project).await.is_empty());

        let reopened_root = stores.get_or_create(&root, project).await.unwrap();
        let reopened_child = stores.get_or_create(&child, &child_dir).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT owner_path FROM routine_owner_roots")
                .fetch_one(&reopened_root)
                .await
                .unwrap(),
            "root-owner"
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT owner_path FROM routine_owner_roots")
                .fetch_one(&reopened_child)
                .await
                .unwrap(),
            "child-owner"
        );
    }
}

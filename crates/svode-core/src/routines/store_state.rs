use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use sqlx::SqlitePool;
use tokio::sync::Mutex;

use super::{RoutineStoreError, authority, storage};
use crate::index::IndexKey;

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
    ) -> Result<SqlitePool, RoutineStoreError> {
        if let Some(pool) = self
            .pools
            .lock()
            .await
            .get(key)
            .cloned()
            .filter(|pool| !pool.is_closed())
        {
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
        if let Some(pool) = self
            .pools
            .lock()
            .await
            .get(key)
            .cloned()
            .filter(|pool| !pool.is_closed())
        {
            return Ok(pool);
        }
        self.pools.lock().await.remove(key);
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

    /// Reconnect a lifecycle sink to the current operational store without
    /// creating or recovering storage outside the shared per-owner lock.
    pub async fn reopen_current(
        &self,
        key: &IndexKey,
        space_dir: &Path,
    ) -> Result<SqlitePool, RoutineStoreError> {
        let lock = {
            let mut locks = self.open_locks.lock().await;
            locks
                .entry(key.clone())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _guard = lock.lock().await;
        if let Some(pool) = self
            .pools
            .lock()
            .await
            .get(key)
            .cloned()
            .filter(|pool| !pool.is_closed())
        {
            return Ok(pool);
        }
        self.pools.lock().await.remove(key);
        let pool = storage::reopen_current_pool(&storage::database_path(space_dir)).await?;
        self.pools.lock().await.insert(key.clone(), pool.clone());
        Ok(pool)
    }

    pub async fn owner_paths(
        &self,
        key: &IndexKey,
        space_dir: &Path,
    ) -> Result<Vec<String>, RoutineStoreError> {
        let pool = self.get_or_create(key, space_dir).await?;
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

    pub async fn open_keys_for_project(&self, project: &Path) -> Vec<IndexKey> {
        self.pools
            .lock()
            .await
            .keys()
            .filter(|key| key.project() == project)
            .cloned()
            .collect()
    }
}

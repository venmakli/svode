pub mod commands;
pub mod db;
pub mod reindex;
pub mod search;
pub mod update;

use sqlx::SqlitePool;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::error::AppError;

/// Normalize a relative path to forward slashes for cross-platform DB storage.
pub(crate) fn normalize_rel(path: &str) -> String {
    path.replace('\\', "/")
}

/// Per-space SQLite index state managed by Tauri.
///
/// Holds a pool of `SqlitePool` connections keyed by space path.
/// `SqlitePool` is cheap to clone (internally `Arc`), so `get_or_create`
/// returns a clone that callers own independently.
pub struct IndexState {
    pools: Mutex<HashMap<String, SqlitePool>>,
    /// Per-space serialization lock for `full_reindex`. Two rapid
    /// `open_project` calls would otherwise spawn two concurrent reindexes
    /// against the same DB — correct under SQLite serialization, but doubles
    /// the work and exposes a brief empty-index window twice.
    reindex_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl IndexState {
    pub fn new() -> Self {
        Self {
            pools: Mutex::new(HashMap::new()),
            reindex_locks: Mutex::new(HashMap::new()),
        }
    }

    /// Get (or create) the per-space reindex serialization lock.
    pub async fn reindex_lock(&self, space_path: &str) -> Arc<Mutex<()>> {
        let mut locks = self.reindex_locks.lock().await;
        locks
            .entry(space_path.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    /// Get an existing pool for the space, or open one (creating the DB
    /// file and schema if necessary).
    pub async fn get_or_create(&self, space_path: &str) -> Result<SqlitePool, AppError> {
        {
            let pools = self.pools.lock().await;
            if let Some(pool) = pools.get(space_path) {
                return Ok(pool.clone());
            }
        }

        let db_path = Path::new(space_path)
            .join(".combai")
            .join("index.db");
        let pool = db::create_pool(&db_path).await?;
        db::ensure_schema(&pool).await?;

        let mut pools = self.pools.lock().await;
        // Double-check insertion under the write lock.
        if let Some(existing) = pools.get(space_path) {
            return Ok(existing.clone());
        }
        pools.insert(space_path.to_string(), pool.clone());
        Ok(pool)
    }

    /// Drop the pool for a space and close its underlying connections.
    ///
    /// `SqlitePool` is internally `Arc`, so calling `close()` marks the
    /// shared pool as closed — any in-flight clones will start returning
    /// `PoolClosed`. Call this only when no other tasks hold a clone
    /// (space deletion / app shutdown).
    pub async fn close(&self, space_path: &str) {
        let pool = {
            let mut pools = self.pools.lock().await;
            pools.remove(space_path)
        };
        if let Some(pool) = pool {
            tracing::info!("closing index pool for space {space_path}");
            pool.close().await;
        }
    }
}

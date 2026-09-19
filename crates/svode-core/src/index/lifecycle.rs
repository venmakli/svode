use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use sqlx::SqlitePool;
use tokio::sync::{Mutex, OwnedMutexGuard};

use super::{IndexError, IndexKey, open_prepared_pool};

/// The registry lock covers open, schema replacement, publication and close.
/// Queries and source reconciliation use cloned pools outside this lock.
#[derive(Default)]
pub struct IndexPools {
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
pub struct CleanupOwner {
    pool: SqlitePool,
    deletion: Arc<Mutex<()>>,
}

impl CleanupOwner {
    pub fn is_closed(&self) -> bool {
        self.pool.is_closed()
    }

    pub async fn authorize_deletion(&self) -> Option<OwnedMutexGuard<()>> {
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
    pub fn physical_count(&self) -> usize {
        self.physical.len()
    }

    pub fn cleanup_owner(&self, key: &IndexKey) -> Option<CleanupOwner> {
        let path = self.owners.get(key)?;
        let physical = self.physical.get(path)?;
        Some(CleanupOwner {
            pool: physical.pool.clone(),
            deletion: physical.deletion.clone(),
        })
    }

    pub fn get(&self, key: &IndexKey) -> Option<SqlitePool> {
        self.owners
            .get(key)
            .and_then(|path| self.physical.get(path))
            .map(|physical| physical.pool.clone())
    }
}

pub async fn open(
    mut pools: OwnedMutexGuard<IndexPools>,
    key: IndexKey,
    dir: PathBuf,
) -> Result<SqlitePool, IndexError> {
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
    .map_err(|error| IndexError::Index(format!("index initializer task failed: {error}")))?
}

pub async fn cleanup_using<F, Fut, E>(
    pools: OwnedMutexGuard<IndexPools>,
    key: IndexKey,
    pool: SqlitePool,
    inspect: F,
) where
    F: FnOnce(PathBuf, CleanupOwner) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<(), E>> + Send,
    E: Send,
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

pub async fn cleanup(pools: OwnedMutexGuard<IndexPools>, key: IndexKey, pool: SqlitePool) {
    cleanup_using(pools, key, pool, |directory, owner| async move {
        super::retention::cleanup_with_owner(&directory, Some(&owner)).await
    })
    .await;
}

pub async fn close(
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

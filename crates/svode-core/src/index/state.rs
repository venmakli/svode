use std::collections::HashMap;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use sqlx::SqlitePool;
use tokio::sync::Mutex;

use super::backlinks::BacklinkIndex;
use super::lifecycle::IndexPools;
use super::resolver::{ProjectSpacesCache, SpaceStatus, resolve_index_target};
use super::{IndexError, IndexKey};

#[derive(Clone, Default)]
pub struct IndexRuntimeState {
    pub pools: Arc<Mutex<IndexPools>>,
    pub reindex_locks: Arc<Mutex<HashMap<IndexKey, Arc<Mutex<()>>>>>,
    pub reindex_active: Arc<Mutex<HashMap<IndexKey, Arc<AtomicBool>>>>,
    pub reconcile_active: Arc<Mutex<HashMap<IndexKey, Arc<AtomicBool>>>>,
    pub spaces_cache: Arc<Mutex<HashMap<PathBuf, ProjectSpacesCache>>>,
    backlinks: Arc<Mutex<HashMap<IndexKey, Arc<BacklinkIndex>>>>,
}

impl IndexRuntimeState {
    pub async fn backlinks_for(&self, key: &IndexKey) -> Arc<BacklinkIndex> {
        let skip = self.skip_folders_for(key).await;
        let mut map = self.backlinks.lock().await;
        let index = map
            .entry(key.clone())
            .or_insert_with(|| Arc::new(BacklinkIndex::new()))
            .clone();
        index.set_skip_top_level(skip);
        index
    }

    pub async fn backlinks_built_for(&self, keys: &[IndexKey]) -> bool {
        let map = self.backlinks.lock().await;
        keys.iter()
            .all(|key| map.get(key).is_some_and(|idx| idx.is_built()))
    }

    pub async fn invalidate_backlinks_for(&self, keys: &[IndexKey]) {
        let map = self.backlinks.lock().await;
        for key in keys {
            if let Some(index) = map.get(key) {
                index.mark_stale();
            }
        }
    }

    pub async fn resolve(
        &self,
        project: &Path,
        absolute_path: &Path,
    ) -> Result<(IndexKey, String), IndexError> {
        let cache = self.spaces_cache.lock().await;
        resolve_index_target(
            project,
            &cache.get(project).cloned().unwrap_or_default(),
            absolute_path,
        )
    }

    pub async fn space_name(&self, key: &IndexKey) -> String {
        let cache = self.spaces_cache.lock().await;
        match key {
            IndexKey::Root(project) => cache
                .get(project)
                .map(|item| item.root_name.clone())
                .unwrap_or_default(),
            IndexKey::Space { project, space_id } => cache
                .get(project)
                .and_then(|item| {
                    item.name_by_id
                        .get(space_id)
                        .cloned()
                        .or_else(|| item.folder_by_id.get(space_id).cloned())
                })
                .unwrap_or_default(),
        }
    }

    pub async fn dir_for_key(&self, key: &IndexKey) -> Result<PathBuf, IndexError> {
        match key {
            IndexKey::Root(project) => Ok(project.clone()),
            IndexKey::Space { project, space_id } => {
                let cache = self.spaces_cache.lock().await;
                let folder = cache
                    .get(project)
                    .and_then(|item| item.folder_by_id.get(space_id))
                    .ok_or_else(|| IndexError::SpaceNotFound(space_id.clone()))?;
                Ok(project.join(folder))
            }
        }
    }

    pub async fn key_for_project_space_id(
        &self,
        project: &Path,
        space_id: Option<&str>,
    ) -> Result<IndexKey, IndexError> {
        match space_id {
            None => Ok(IndexKey::Root(project.to_path_buf())),
            Some(id) => {
                let cache = self.spaces_cache.lock().await;
                let ready = cache
                    .get(project)
                    .and_then(|item| item.status_by_id.get(id))
                    .is_some_and(|status| *status == SpaceStatus::Ready);
                if ready {
                    Ok(IndexKey::Space {
                        project: project.to_path_buf(),
                        space_id: id.to_string(),
                    })
                } else {
                    Err(IndexError::SpaceNotFound(id.to_string()))
                }
            }
        }
    }

    pub async fn reindex_lock(&self, key: &IndexKey) -> Arc<Mutex<()>> {
        let mut locks = self.reindex_locks.lock().await;
        locks
            .entry(key.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    pub async fn reindex_active_flag(&self, key: &IndexKey) -> Arc<AtomicBool> {
        let mut flags = self.reindex_active.lock().await;
        flags
            .entry(key.clone())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone()
    }

    pub async fn reconcile_active_flag(&self, key: &IndexKey) -> Arc<AtomicBool> {
        let mut flags = self.reconcile_active.lock().await;
        flags
            .entry(key.clone())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone()
    }

    pub async fn cleanup_reconciled_index(&self, key: &IndexKey, pool: &SqlitePool) {
        super::lifecycle::cleanup(
            self.pools.clone().lock_owned().await,
            key.clone(),
            pool.clone(),
        )
        .await;
    }

    pub async fn get_or_create(&self, key: &IndexKey) -> Result<SqlitePool, IndexError> {
        let pools = self.pools.clone().lock_owned().await;
        if let Some(pool) = pools.get(key) {
            return Ok(pool);
        }
        let dir = self.dir_for_key(key).await?;
        super::lifecycle::open(pools, key.clone(), dir).await
    }

    pub async fn existing_pool(&self, key: &IndexKey) -> Option<SqlitePool> {
        self.pools.lock().await.get(key)
    }

    pub async fn close_key(&self, key: &IndexKey) {
        super::lifecycle::close(self.pools.clone().lock_owned().await, Some(key), None).await;
        self.close_key_runtime(key).await;
    }

    pub async fn close_key_runtime(&self, key: &IndexKey) {
        self.backlinks.lock().await.remove(key);
        self.reindex_locks.lock().await.remove(key);
        self.reindex_active.lock().await.remove(key);
        self.reconcile_active.lock().await.remove(key);
    }

    pub async fn close_project(&self, project: &Path) -> HashSet<IndexKey> {
        let keys =
            super::lifecycle::close(self.pools.clone().lock_owned().await, None, Some(project))
                .await;
        for key in &keys {
            self.close_key_runtime(key).await;
        }
        self.backlinks
            .lock()
            .await
            .retain(|key, _| key.project() != project);
        self.spaces_cache.lock().await.remove(project);
        keys
    }

    pub async fn skip_folders_for(&self, key: &IndexKey) -> Vec<String> {
        match key {
            IndexKey::Root(project) => self
                .spaces_cache
                .lock()
                .await
                .get(project)
                .map(|item| item.by_folder.keys().cloned().collect())
                .unwrap_or_default(),
            IndexKey::Space { .. } => Vec::new(),
        }
    }

    pub async fn replace_project_cache(&self, project: &Path, cache: ProjectSpacesCache) {
        self.spaces_cache
            .lock()
            .await
            .insert(project.to_path_buf(), cache);
    }

    pub async fn upsert_space(
        &self,
        project: &Path,
        space_id: &str,
        folder: &str,
        status: SpaceStatus,
        display_name: Option<String>,
    ) {
        let mut cache = self.spaces_cache.lock().await;
        let item = cache.entry(project.to_path_buf()).or_default();
        item.by_folder
            .insert(folder.to_string(), space_id.to_string());
        item.folder_by_id
            .insert(space_id.to_string(), folder.to_string());
        item.status_by_id.insert(space_id.to_string(), status);
        if let Some(name) = display_name {
            item.name_by_id.insert(space_id.to_string(), name);
        } else {
            item.name_by_id.remove(space_id);
        }
    }

    pub async fn remove_space(&self, project: &Path, space_id: &str) {
        let mut cache = self.spaces_cache.lock().await;
        if let Some(item) = cache.get_mut(project) {
            if let Some(folder) = item.folder_by_id.remove(space_id) {
                item.by_folder.remove(&folder);
            }
            item.status_by_id.remove(space_id);
            item.name_by_id.remove(space_id);
        }
    }

    pub async fn change_space_status(
        &self,
        project: &Path,
        space_id: &str,
        status: SpaceStatus,
        display_name: Option<String>,
    ) {
        let mut cache = self.spaces_cache.lock().await;
        if let Some(item) = cache.get_mut(project) {
            item.status_by_id.insert(space_id.to_string(), status);
            if let Some(name) = display_name {
                item.name_by_id.insert(space_id.to_string(), name);
            } else {
                item.name_by_id.remove(space_id);
            }
        }
    }

    pub async fn folder_for_space(&self, project: &Path, space_id: &str) -> Option<String> {
        self.spaces_cache
            .lock()
            .await
            .get(project)
            .and_then(|item| item.folder_by_id.get(space_id).cloned())
    }

    pub async fn status_by_id(&self, project: &Path) -> HashMap<String, SpaceStatus> {
        self.spaces_cache
            .lock()
            .await
            .get(project)
            .map(|item| item.status_by_id.clone())
            .unwrap_or_default()
    }

    pub async fn keys_for_project(&self, project: &Path) -> Vec<IndexKey> {
        let mut keys = vec![IndexKey::Root(project.to_path_buf())];
        let cache = self.spaces_cache.lock().await;
        if let Some(item) = cache.get(project) {
            for (space_id, status) in &item.status_by_id {
                if *status == SpaceStatus::Ready {
                    keys.push(IndexKey::Space {
                        project: project.to_path_buf(),
                        space_id: space_id.clone(),
                    });
                }
            }
        }
        keys
    }

    pub async fn routine_inventory_keys(
        &self,
        project: &Path,
    ) -> Result<Vec<IndexKey>, IndexError> {
        if !self.spaces_cache.lock().await.contains_key(project) {
            return Err(IndexError::Index(format!(
                "routine owner inventory is unavailable for {}",
                project.display()
            )));
        }
        Ok(self.keys_for_project(project).await)
    }

    pub async fn key_for_space_dir(&self, space_dir: &Path) -> Option<IndexKey> {
        let cache = self.spaces_cache.lock().await;
        for (project, item) in cache.iter() {
            if project == space_dir {
                return Some(IndexKey::Root(project.clone()));
            }
            for (space_id, folder) in &item.folder_by_id {
                if project.join(folder) == space_dir {
                    return Some(IndexKey::Space {
                        project: project.clone(),
                        space_id: space_id.clone(),
                    });
                }
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn project_cache_and_pool_generations_share_one_core_owner() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path();
        std::fs::create_dir(project.join("child")).unwrap();
        let state = IndexRuntimeState::default();
        let mut cache = ProjectSpacesCache::default();
        cache.by_folder.insert("child".into(), "child-id".into());
        cache.folder_by_id.insert("child-id".into(), "child".into());
        cache
            .status_by_id
            .insert("child-id".into(), SpaceStatus::Ready);
        state.replace_project_cache(project, cache).await;

        let root = IndexKey::Root(project.to_path_buf());
        let child = IndexKey::Space {
            project: project.to_path_buf(),
            space_id: "child-id".into(),
        };
        assert_eq!(state.keys_for_project(project).await.len(), 2);
        assert_eq!(
            state
                .resolve(project, &project.join("child/page.md"))
                .await
                .unwrap()
                .0,
            child
        );
        let first = state.get_or_create(&child).await.unwrap();
        let same = state.clone().get_or_create(&child).await.unwrap();
        assert_eq!(state.pools.lock().await.physical_count(), 1);
        let root_backlinks = state.backlinks_for(&root).await;
        let shared_backlinks = state.clone().backlinks_for(&root).await;
        assert!(Arc::ptr_eq(&root_backlinks, &shared_backlinks));
        assert_eq!(root_backlinks.current_skip(), vec!["child".to_string()]);
        root_backlinks.mark_built();
        assert!(state.backlinks_built_for(&[root.clone()]).await);
        state.invalidate_backlinks_for(&[root.clone()]).await;
        assert!(!state.backlinks_built_for(&[root.clone()]).await);
        state.get_or_create(&root).await.unwrap();
        state
            .change_space_status(project, "child-id", SpaceStatus::Missing, None)
            .await;
        state.close_key(&child).await;
        assert!(first.is_closed());
        assert!(same.is_closed());
        assert_eq!(state.keys_for_project(project).await, vec![root.clone()]);
        let orphan_backlinks = state.backlinks_for(&child).await;
        state.close_project(project).await;
        assert!(state.existing_pool(&root).await.is_none());
        assert!(!Arc::ptr_eq(
            &root_backlinks,
            &state.backlinks_for(&root).await
        ));
        assert!(!Arc::ptr_eq(
            &orphan_backlinks,
            &state.backlinks_for(&child).await
        ));
        assert!(state.routine_inventory_keys(project).await.is_err());
    }
}

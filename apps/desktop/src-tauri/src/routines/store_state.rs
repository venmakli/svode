use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

use sqlx::SqlitePool;

use crate::AppError;
use crate::index::{IndexKey, IndexState};

#[derive(Default)]
pub struct RoutineStoreState {
    core: Arc<svode_core::routines::store_state::RoutineStoreState>,
}

impl RoutineStoreState {
    pub(crate) fn core_handle(&self) -> Arc<svode_core::routines::store_state::RoutineStoreState> {
        self.core.clone()
    }

    pub(crate) fn core(&self) -> &svode_core::routines::store_state::RoutineStoreState {
        &self.core
    }
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn get_or_create(
        &self,
        key: &IndexKey,
        space_dir: &Path,
    ) -> Result<SqlitePool, AppError> {
        Ok(self.core.get_or_create(key, space_dir).await?)
    }

    pub async fn get_or_create_for_index(
        &self,
        index_state: &IndexState,
        key: &IndexKey,
    ) -> Result<SqlitePool, AppError> {
        let space_dir = index_state.dir_for_key(key).await?;
        self.get_or_create(key, &space_dir).await
    }

    pub async fn close_key(&self, key: &IndexKey) {
        self.core.close_key(key).await;
    }

    pub async fn close_project(&self, project: &Path) {
        self.core.close_project(project).await;
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
            .core
            .open_keys_for_project(project)
            .await
            .into_iter()
            .filter(|key| !desired.contains(key))
            .collect::<Vec<_>>();
        for key in stale {
            self.core.close_key(&key).await;
        }
        for key in desired {
            let dir = index_state.dir_for_key(&key).await?;
            self.core.get_or_create(&key, &dir).await?;
        }
        Ok(())
    }

    #[cfg(test)]
    async fn keys_for_project(&self, project: &Path) -> Vec<IndexKey> {
        self.core.open_keys_for_project(project).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use crate::routines::ResolvedRoutineOwner;
    use crate::space::config;
    use svode_core::routines::authority;

    #[tokio::test]
    async fn missing_store_after_generation_marker_forces_recovery_and_authority_off() {
        let temp = tempfile::tempdir().unwrap();
        let key = IndexKey::Root(temp.path().to_path_buf());
        let owner_key = ResolvedRoutineOwner::indexed_collection_identity(&key, ".");
        assert!(authority::set_key(temp.path(), &owner_key, true).unwrap());
        authority::mark_storage_ready(temp.path()).unwrap();

        let state = IndexState::new();
        state.get_or_create_routines(&key).await.unwrap();

        assert!(authority::recovery_required(temp.path()).unwrap());
        assert!(!authority::read_key(temp.path(), &owner_key).unwrap());
        assert!(
            config::read_local_config(temp.path())
                .unwrap()
                .routines
                .unwrap()
                .automatic_authority
                .is_empty()
        );
    }

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

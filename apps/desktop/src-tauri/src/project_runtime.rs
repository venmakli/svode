use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager};
use tokio::sync::Semaphore;

use crate::AppError;
use crate::index::update::IndexUpdateState;
use crate::index::{IndexKey, IndexState};
use crate::routines::{RoutineSchedulerState, RoutineStoreState};
use crate::space::types::SpaceStatus;

#[derive(Default)]
pub struct ProjectRuntimeState {
    index_tasks: Mutex<HashMap<IndexKey, tauri::async_runtime::JoinHandle<()>>>,
}

#[cfg(test)]
mod tests {
    use std::future::pending;

    use tokio::sync::oneshot;

    use super::*;

    struct DropSignal(Option<oneshot::Sender<()>>);

    impl Drop for DropSignal {
        fn drop(&mut self) {
            if let Some(sender) = self.0.take() {
                let _ = sender.send(());
            }
        }
    }

    fn pending_task() -> (tauri::async_runtime::JoinHandle<()>, oneshot::Receiver<()>) {
        let (sender, receiver) = oneshot::channel();
        let task = tauri::async_runtime::spawn(async move {
            let _signal = DropSignal(Some(sender));
            pending::<()>().await;
        });
        (task, receiver)
    }

    #[tokio::test]
    async fn replacing_and_closing_runtime_tasks_is_owner_scoped() {
        let runtime = ProjectRuntimeState::new();
        let first_project = PathBuf::from("/first");
        let second_project = PathBuf::from("/second");
        let first_key = IndexKey::Root(first_project.clone());
        let second_key = IndexKey::Root(second_project.clone());

        let (first, first_stopped) = pending_task();
        runtime.replace_index_task(first_key.clone(), first);
        tokio::task::yield_now().await;
        let (replacement, replacement_stopped) = pending_task();
        runtime.replace_index_task(first_key, replacement);
        tokio::task::yield_now().await;
        first_stopped.await.unwrap();

        let (other, mut other_stopped) = pending_task();
        runtime.replace_index_task(second_key, other);
        tokio::task::yield_now().await;
        runtime.stop_project_index_tasks(&first_project);
        replacement_stopped.await.unwrap();
        assert!(other_stopped.try_recv().is_err());

        runtime.stop_project_index_tasks(&second_project);
        other_stopped.await.unwrap();
    }
}

const REINDEX_PARALLELISM: usize = 4;

impl ProjectRuntimeState {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn open_project(
        &self,
        app: &AppHandle,
        project_id: String,
        project_path: PathBuf,
    ) -> Result<(), AppError> {
        self.stop_project_index_tasks(&project_path);
        crate::git::delivery::repair_project(app, &project_path).await;
        let index_state = app.state::<IndexState>();
        let prepared = index_state.open_project(&project_path).await;
        if prepared.is_ok() {
            let routine_stores = app.state::<Arc<RoutineStoreState>>();
            for key in index_state.keys_for_project(&project_path).await {
                let dir = index_state.dir_for_key(&key).await?;
                if let Err(error) = routine_stores.get_or_create(&key, &dir).await {
                    tracing::warn!(?key, "open routines pool failed: {error}");
                }
            }
        }
        app.state::<RoutineSchedulerState>()
            .start_project(app.clone(), project_id, project_path);
        let keys = prepared?;
        self.spawn_reconciliation(app, keys);
        Ok(())
    }

    pub async fn close_project(&self, app: &AppHandle, project_id: &str, project_path: &Path) {
        app.state::<RoutineSchedulerState>()
            .stop_project(project_id);
        self.stop_project_index_tasks(project_path);
        app.state::<Arc<RoutineStoreState>>()
            .close_project(project_path)
            .await;
        app.state::<IndexState>().close_project(project_path).await;
    }

    pub async fn on_space_added(
        &self,
        app: &AppHandle,
        project: &Path,
        space_id: &str,
        folder_name: &str,
        status: SpaceStatus,
    ) {
        if matches!(status, SpaceStatus::Ready) {
            crate::git::delivery::repair_scope_best_effort(
                app,
                project,
                &project.join(folder_name),
            )
            .await;
        }
        let index_state = app.state::<IndexState>();
        let prepared = index_state
            .on_space_added(project, space_id, folder_name, status)
            .await;
        if matches!(status, SpaceStatus::Ready) {
            let key = IndexKey::Space {
                project: project.to_path_buf(),
                space_id: space_id.to_string(),
            };
            if let Ok(dir) = index_state.dir_for_key(&key).await
                && let Err(error) = app
                    .state::<Arc<RoutineStoreState>>()
                    .get_or_create(&key, &dir)
                    .await
            {
                tracing::warn!(?key, "open routines pool for added space failed: {error}");
            }
        }
        if let Some(key) = prepared {
            self.spawn_full_reindex(app, key);
        }
    }

    pub async fn on_space_removed(&self, app: &AppHandle, project: &Path, space_id: &str) {
        let key = IndexKey::Space {
            project: project.to_path_buf(),
            space_id: space_id.to_string(),
        };
        self.stop_index_task(&key);
        app.state::<Arc<RoutineStoreState>>().close_key(&key).await;
        app.state::<IndexState>()
            .on_space_removed(project, space_id)
            .await;
    }

    pub async fn on_space_status_changed(
        &self,
        app: &AppHandle,
        project: &Path,
        space_id: &str,
        status: SpaceStatus,
    ) {
        let key = IndexKey::Space {
            project: project.to_path_buf(),
            space_id: space_id.to_string(),
        };
        if matches!(status, SpaceStatus::Missing | SpaceStatus::Broken) {
            self.stop_index_task(&key);
        }
        if matches!(status, SpaceStatus::Ready) {
            let dir = app
                .state::<IndexState>()
                .dir_for_key(&key)
                .await
                .unwrap_or_else(|_| project.to_path_buf());
            crate::git::delivery::repair_scope_best_effort(app, project, &dir).await;
        }
        let index_state = app.state::<IndexState>();
        let prepared = index_state
            .on_space_status_changed(project, space_id, status)
            .await;
        let routine_stores = app.state::<Arc<RoutineStoreState>>();
        match status {
            SpaceStatus::Ready => {
                if let Ok(dir) = index_state.dir_for_key(&key).await
                    && let Err(error) = routine_stores.get_or_create(&key, &dir).await
                {
                    tracing::warn!(
                        ?key,
                        "open routines pool after status change failed: {error}"
                    );
                }
            }
            SpaceStatus::Missing | SpaceStatus::Broken => {
                index_state
                    .set_lfs_state_with(app, &key, crate::storage::lfs::LfsState::NotApplicable)
                    .await;
                routine_stores.close_key(&key).await;
            }
        }
        if let Some(key) = prepared {
            self.spawn_full_reindex(app, key);
        }
    }

    pub async fn refresh_after_root_pull(
        &self,
        app: &AppHandle,
        project: &Path,
    ) -> Result<(), AppError> {
        self.stop_project_index_tasks(project);
        crate::git::delivery::repair_project(app, project).await;
        let tasks = app
            .state::<IndexState>()
            .refresh_after_root_pull(project)
            .await?;
        app.state::<Arc<RoutineStoreState>>()
            .reconcile_project(&app.state::<IndexState>(), project)
            .await?;
        for key in tasks {
            self.spawn_full_reindex(app, key);
        }
        Ok(())
    }

    fn spawn_reconciliation(&self, app: &AppHandle, keys: Vec<IndexKey>) {
        let semaphore = Arc::new(Semaphore::new(REINDEX_PARALLELISM));
        for key in keys {
            let app = app.clone();
            let semaphore = semaphore.clone();
            let task_key = key.clone();
            let task = tauri::async_runtime::spawn(async move {
                let Ok(_permit) = semaphore.acquire_owned().await else {
                    return;
                };
                let index_state = app.state::<IndexState>();
                let updates = app.state::<IndexUpdateState>();
                if let Err(error) = updates.run_reconciliation(&index_state, &key).await {
                    tracing::warn!(?key, "background reconciliation failed: {error}");
                }
            });
            self.replace_index_task(task_key, task);
        }
    }

    fn spawn_full_reindex(&self, app: &AppHandle, key: IndexKey) {
        let app = app.clone();
        let task_key = key.clone();
        let task = tauri::async_runtime::spawn(async move {
            let index_state = app.state::<IndexState>();
            let updates = app.state::<IndexUpdateState>();
            if let Err(error) =
                crate::index::service::repair_space(&index_state, &updates, &key).await
            {
                tracing::warn!(?key, "background full reindex failed: {error}");
            }
        });
        self.replace_index_task(task_key, task);
    }

    fn replace_index_task(&self, key: IndexKey, task: tauri::async_runtime::JoinHandle<()>) {
        let mut tasks = self
            .index_tasks
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(previous) = tasks.insert(key, task) {
            previous.abort();
        }
    }

    fn stop_index_task(&self, key: &IndexKey) {
        if let Some(task) = self
            .index_tasks
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(key)
        {
            task.abort();
        }
    }

    fn stop_project_index_tasks(&self, project: &Path) {
        let mut tasks = self
            .index_tasks
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let keys = tasks
            .keys()
            .filter(|key| key.project() == project)
            .cloned()
            .collect::<Vec<_>>();
        for key in keys {
            if let Some(task) = tasks.remove(&key) {
                task.abort();
            }
        }
    }
}

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Semaphore;

use crate::AppError;
use crate::index::update::IndexUpdateState;
use crate::index::{IndexKey, IndexState, SpacesChange};
use crate::project_sessions::ProjectSessions;
use crate::routines::RoutineStoreState;
use crate::space::types::SpaceStatus;
use svode_core::system_path;

#[derive(Default)]
pub struct ProjectRuntimeState {
    index_tasks: Mutex<HashMap<IndexKey, tauri::async_runtime::JoinHandle<()>>>,
    /// One reconciliation of `spaces` at a time, so a change observed twice
    /// applies once.
    spaces: tokio::sync::Mutex<()>,
}

#[cfg(test)]
#[path = "project_runtime_spaces_tests.rs"]
mod spaces_tests;

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
        // Created before spawning so an abort before the first poll still
        // signals: the task runs on the Tauri runtime, not the test's.
        let signal = DropSignal(Some(sender));
        let task = tauri::async_runtime::spawn(async move {
            let _signal = signal;
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
        project_path: PathBuf,
    ) -> Result<(), AppError> {
        self.stop_project_index_tasks(&project_path);
        crate::git::delivery::repair_project(app, &project_path).await;
        let index_state = app.state::<IndexState>();
        let prepared = index_state.open_project(&project_path).await;
        // The window runtime serves the project from now on; its bridge
        // session, if any, hands over after the requests still using it.
        app.state::<ProjectSessions>().close(&project_path).await;
        if prepared.is_ok() {
            let routine_stores = app.state::<Arc<RoutineStoreState>>();
            for key in index_state.keys_for_project(&project_path).await {
                let dir = index_state.dir_for_key(&key).await?;
                if let Err(error) = routine_stores.get_or_create(&key, &dir).await {
                    tracing::warn!(?key, "open routines pool failed: {error}");
                }
            }
        }
        let keys = prepared?;
        self.spawn_reconciliation(app, keys);
        // A Space created while the project was closed gets its creation
        // commit now (05 «Коммиты создания» n. 2).
        spawn_space_creation_commits(app, &project_path);
        Ok(())
    }

    /// Stops the runtime of a project a window no longer serves. Its Routine
    /// scheduler and operational stores keep running for every project in
    /// the list (Stage 10 `09`, Routines of every project).
    pub async fn close_project(&self, app: &AppHandle, project_path: &Path) {
        self.stop_project_index_tasks(project_path);
        app.state::<IndexState>().close_project(project_path).await;
        app.state::<ProjectSessions>().close(project_path).await;
    }

    /// Brings the runtime of an open project in line with `spaces` in its
    /// root config on disk (Stage 11 05 «Открытый Desktop следует `spaces`
    /// на диске»): the pools of the index and Routines, the local Git policy
    /// of ready Space repositories and the Space lists of the window. The
    /// same reconciliation follows the window's own Space operations, a root
    /// pull and a change by another process, so a change applies once: a
    /// second observation of it finds nothing to do. An unreadable config is
    /// an error and leaves the served Spaces as they are.
    pub async fn reconcile_spaces(
        &self,
        app: &AppHandle,
        project: &Path,
    ) -> Result<SpacesChange, AppError> {
        let _spaces = self.spaces.lock().await;
        let index_state = app.state::<IndexState>();
        let change = index_state.spaces_change(project).await?;
        if change.is_empty() {
            return Ok(change);
        }
        for dir in change_ready_dirs(project, &change) {
            crate::git::delivery::repair_scope_best_effort(app, project, &dir).await;
        }
        for key in change_departed_keys(project, &change) {
            self.stop_index_task(&key);
        }
        let rebuild = apply_spaces_change(
            &index_state,
            &app.state::<Arc<RoutineStoreState>>(),
            project,
            &change,
        )
        .await;
        for space in &change.changed {
            if matches!(space.new, SpaceStatus::Missing | SpaceStatus::Broken) {
                let key = IndexKey::Space {
                    project: project.to_path_buf(),
                    space_id: space.id.clone(),
                };
                index_state
                    .set_lfs_state_with(
                        app,
                        &key,
                        svode_core::storage::lfs::LfsState::NotApplicable,
                    )
                    .await;
            }
        }
        for key in rebuild {
            self.spawn_full_reindex(app, key);
        }
        for (event, payload) in space_events(project, &change) {
            let _ = app.emit(event, payload);
        }
        Ok(change)
    }

    /// Picks up a change of `spaces` the window did not make itself: another
    /// process, a change outside Svode or a pull. A Space it added gets its
    /// creation commit (05 «Коммиты создания» n. 2).
    pub async fn pick_up_spaces(
        &self,
        app: &AppHandle,
        project: &Path,
    ) -> Result<SpacesChange, AppError> {
        let change = self.reconcile_spaces(app, project).await?;
        if !change.added.is_empty() {
            spawn_space_creation_commits(app, project);
        }
        Ok(change)
    }

    pub async fn refresh_after_root_pull(
        &self,
        app: &AppHandle,
        project: &Path,
    ) -> Result<(), AppError> {
        self.stop_project_index_tasks(project);
        crate::git::delivery::repair_project(app, project).await;
        self.pick_up_spaces(app, project).await.map(|_| ())
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

/// The index and Routine pools of `project` follow `change`; returns the
/// pools to rebuild.
async fn apply_spaces_change(
    index_state: &IndexState,
    routine_stores: &RoutineStoreState,
    project: &Path,
    change: &SpacesChange,
) -> Vec<IndexKey> {
    let rebuild = index_state.apply_spaces_change(project, change).await;
    if let Err(error) = routine_stores.reconcile_project(index_state, project).await {
        tracing::warn!("routine pools did not follow the spaces of the project: {error}");
    }
    rebuild
}

fn spawn_space_creation_commits(app: &AppHandle, project: &Path) {
    let app = app.clone();
    let project = project.to_path_buf();
    tauri::async_runtime::spawn(async move {
        crate::git::auto_versions::commit_space_creations(&app, &project).await;
    });
}

/// Directories of the Spaces `change` makes ready.
fn change_ready_dirs(project: &Path, change: &SpacesChange) -> Vec<PathBuf> {
    let added = change
        .added
        .iter()
        .filter(|space| space.status == SpaceStatus::Ready)
        .map(|space| &space.folder);
    let ready = change
        .changed
        .iter()
        .filter(|space| space.new == SpaceStatus::Ready)
        .map(|space| &space.folder);
    added
        .chain(ready)
        .map(|folder| project.join(folder))
        .collect()
}

/// Pools whose background tasks stop: departed Spaces and Spaces that are
/// no longer ready.
fn change_departed_keys(project: &Path, change: &SpacesChange) -> Vec<IndexKey> {
    let departed = change.removed.iter().cloned();
    let unready = change
        .changed
        .iter()
        .filter(|space| space.new != SpaceStatus::Ready)
        .map(|space| space.id.clone());
    departed
        .chain(unready)
        .map(|space_id| IndexKey::Space {
            project: project.to_path_buf(),
            space_id,
        })
        .collect()
}

/// The window events of `change`; the Space lists of the window follow them.
fn space_events(project: &Path, change: &SpacesChange) -> Vec<(&'static str, serde_json::Value)> {
    let project_path = system_path::user_facing_path(project);
    let added = change.added.iter().map(|space| {
        (
            "space:added",
            serde_json::json!({
                "projectPath": project_path,
                "spaceId": space.id,
                "spacePath": system_path::user_facing_path(&project.join(&space.folder)),
                "status": space.status,
            }),
        )
    });
    let removed = change.removed.iter().map(|space_id| {
        (
            "space:removed",
            serde_json::json!({
                "projectPath": project_path,
                "spaceId": space_id,
            }),
        )
    });
    let changed = change.changed.iter().map(|space| {
        (
            "space:status_changed",
            serde_json::json!({
                "projectPath": project_path,
                "spaceId": space.id,
                "oldStatus": space.old,
                "newStatus": space.new,
            }),
        )
    });
    removed.chain(added).chain(changed).collect()
}

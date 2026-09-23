pub mod commands;
#[cfg(test)]
mod knowledge_tests;
mod lifecycle;
pub mod reconcile;
pub mod reindex;
mod retention;
pub mod service;
pub mod update;

use sqlx::SqlitePool;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use crate::error::AppError;
use crate::repo_path::{RootMode, normalize_repo_relative};
use crate::space::types::SpaceStatus;
use crate::storage::lfs::LfsState;
use crate::system_path;
#[cfg(test)]
use svode_core::index::backlinks::BacklinkIndex;
use svode_core::index::backlinks::{is_external_or_anchor_url, markdown_url_path};

/// Normalize a relative path to forward slashes for cross-platform DB storage.
pub(crate) fn normalize_rel(path: &str) -> String {
    normalize_rel_result(path).unwrap_or_else(|_| path.replace('\\', "/"))
}

pub(crate) fn normalize_rel_result(path: &str) -> Result<String, AppError> {
    normalize_repo_relative(path, RootMode::Reject)
}

pub use svode_core::index::IndexKey;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedDocLink {
    pub target_space_id: Option<String>,
    pub target_space_path: Option<String>,
    pub target_path: Option<String>,
    pub status: String,
    pub exists: bool,
    pub space_name: String,
}

pub use svode_core::index::resolver::ProjectSpacesCache;
use svode_core::index::resolver::child_space_name;

fn normalize_abs_path(path: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(p) => out.push(p.as_os_str()),
            Component::RootDir => out.push(std::path::MAIN_SEPARATOR.to_string()),
            Component::CurDir => {}
            Component::Normal(s) => out.push(s),
            Component::ParentDir => {
                if !out.pop() {
                    return None;
                }
            }
        }
    }
    Some(out)
}

/// Desktop runtime state for index orchestration and LFS notifications.
#[derive(Clone)]
pub struct IndexState {
    pub(crate) core: svode_core::index::state::IndexRuntimeState,
    /// Per-key LFS runtime state. Initial value for any key is
    /// `NotApplicable`; the actual probe is lazy (triggered by user gestures
    /// or post-clone/sync events). See `storage/lfs.rs`.
    lfs_states: Arc<Mutex<HashMap<IndexKey, LfsState>>>,
}

impl IndexState {
    pub fn new() -> Self {
        Self {
            core: svode_core::index::state::IndexRuntimeState::default(),
            lfs_states: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    #[cfg(test)]
    pub async fn get_or_create_routines(&self, key: &IndexKey) -> Result<SqlitePool, AppError> {
        update::test_update_state().routines_pool(self, key).await
    }

    #[cfg(test)]
    pub async fn run_reconciliation(&self, key: &IndexKey) -> Result<(), AppError> {
        update::test_update_state()
            .run_reconciliation(self, key)
            .await
    }

    #[cfg(test)]
    pub async fn run_full_reindex(&self, key: &IndexKey) -> Result<(), AppError> {
        update::test_update_state()
            .run_full_reindex(self, key)
            .await
    }

    /// Read the cached LFS state for `key`. Defaults to `NotApplicable` for
    /// unknown keys — callers should treat this as "not probed yet".
    pub async fn get_lfs_state(&self, key: &IndexKey) -> LfsState {
        let map = self.lfs_states.lock().await;
        map.get(key).copied().unwrap_or_default()
    }

    /// Cache the LFS state for `key` and emit `space:lfs_state_changed` via
    /// the provided `AppHandle`. All setters route through this so the
    /// frontend never misses a transition.
    pub async fn set_lfs_state_with(&self, app: &AppHandle, key: &IndexKey, state: LfsState) {
        {
            let mut map = self.lfs_states.lock().await;
            map.insert(key.clone(), state);
        }
        let project_path = system_path::user_facing_path(key.project());
        let space_id = Self::space_id_for_key(key);
        let _ = app.emit(
            "space:lfs_state_changed",
            serde_json::json!({
                "projectPath": project_path,
                "spaceId": space_id,
                "state": state,
            }),
        );
    }

    /// Resolve an absolute path into the owning `IndexKey` and rel-path.
    /// Caller must already know the project root.
    pub async fn resolve(
        &self,
        project: &Path,
        abs_path: &Path,
    ) -> Result<(IndexKey, String), AppError> {
        Ok(self.core.resolve(project, abs_path).await?)
    }

    /// Display name for this pool's source: project name for `Root`, child
    /// `SpaceConfig.name` for `Space`. Falls back to folder name if the cache
    /// has no entry (treated as a soft miss).
    pub async fn space_name(&self, key: &IndexKey) -> String {
        self.core.space_name(key).await
    }

    /// Returns the directory whose `.svode/index.db` backs this key — i.e.,
    /// the root project path or the ready child-space path.
    pub async fn dir_for_key(&self, key: &IndexKey) -> Result<PathBuf, AppError> {
        Ok(self.core.dir_for_key(key).await?)
    }

    pub fn space_id_for_key(key: &IndexKey) -> Option<String> {
        match key {
            IndexKey::Root(_) => None,
            IndexKey::Space { space_id, .. } => Some(space_id.clone()),
        }
    }

    pub async fn key_for_project_space_id(
        &self,
        project: &Path,
        space_id: Option<&str>,
    ) -> Result<IndexKey, AppError> {
        Ok(self
            .core
            .key_for_project_space_id(project, space_id)
            .await?)
    }

    pub async fn space_path_of(
        &self,
        project: &Path,
        space_id: Option<&str>,
    ) -> Result<PathBuf, AppError> {
        Ok(self.core.space_path_of(project, space_id).await?)
    }

    pub async fn invalidate_project_backlinks(&self, project: &Path) {
        let keys = self.keys_for_project(&project.to_path_buf()).await;
        self.core.invalidate_backlinks_for(&keys).await;
    }

    pub async fn resolve_doc_link(
        &self,
        project: &Path,
        source_space_id: Option<&str>,
        source_path: &str,
        url: &str,
    ) -> Result<ResolvedDocLink, AppError> {
        if is_external_or_anchor_url(url) {
            return Ok(ResolvedDocLink {
                target_space_id: source_space_id.map(ToString::to_string),
                target_space_path: None,
                target_path: None,
                status: "external".to_string(),
                exists: false,
                space_name: String::new(),
            });
        }

        let source_key = self
            .key_for_project_space_id(project, source_space_id)
            .await?;
        let source_dir = self.dir_for_key(&source_key).await?;
        let source_rel = normalize_rel_result(source_path)?;
        let target_link = markdown_url_path(url);
        let source_parent_rel = Path::new(&source_rel).parent().unwrap_or(Path::new(""));
        let source_parent_abs = source_dir.join(source_parent_rel);
        let Some(target_abs) = normalize_abs_path(&source_parent_abs.join(&target_link)) else {
            return Ok(ResolvedDocLink {
                target_space_id: None,
                target_space_path: None,
                target_path: None,
                status: "broken".to_string(),
                exists: false,
                space_name: String::new(),
            });
        };
        if !target_abs.starts_with(project) {
            return Ok(ResolvedDocLink {
                target_space_id: None,
                target_space_path: None,
                target_path: None,
                status: "broken".to_string(),
                exists: false,
                space_name: String::new(),
            });
        }

        let rel = target_abs.strip_prefix(project).map_err(|_| {
            AppError::Index(format!(
                "path outside project root: {}",
                target_abs.display()
            ))
        })?;
        let segments: Vec<String> = rel
            .components()
            .filter_map(|c| match c {
                Component::Normal(s) => s.to_str().map(ToString::to_string),
                _ => None,
            })
            .collect();
        if segments.is_empty() {
            return Ok(ResolvedDocLink {
                target_space_id: None,
                target_space_path: Some(system_path::user_facing_path(project)),
                target_path: None,
                status: "broken".to_string(),
                exists: false,
                space_name: self
                    .space_name(&IndexKey::Root(project.to_path_buf()))
                    .await,
            });
        }

        let cache_guard = self.core.spaces_cache.lock().await;
        let cache = cache_guard.get(project).cloned().unwrap_or_default();
        drop(cache_guard);

        if let Some(space_id) = cache.by_folder.get(&segments[0]) {
            let folder = &segments[0];
            let target_rel = normalize_rel(&segments[1..].join("/"));
            let status = cache
                .status_by_id
                .get(space_id)
                .copied()
                .unwrap_or(SpaceStatus::Broken);
            let target_space_path = project.join(folder);
            let space_name = cache
                .name_by_id
                .get(space_id)
                .cloned()
                .unwrap_or_else(|| folder.clone());
            let exists = matches!(status, SpaceStatus::Ready)
                && !target_rel.is_empty()
                && target_space_path.join(&target_rel).exists();
            let status = match status {
                SpaceStatus::Ready => "ready",
                SpaceStatus::Missing => "missing",
                SpaceStatus::Broken => "broken",
            };
            return Ok(ResolvedDocLink {
                target_space_id: Some(space_id.clone()),
                target_space_path: Some(system_path::user_facing_path(&target_space_path)),
                target_path: Some(target_rel),
                status: status.to_string(),
                exists,
                space_name,
            });
        }

        let target_rel = normalize_rel_result(&segments.join("/"))?;
        let exists = target_abs.exists();
        Ok(ResolvedDocLink {
            target_space_id: None,
            target_space_path: Some(system_path::user_facing_path(project)),
            target_path: Some(target_rel),
            status: "ready".to_string(),
            exists,
            space_name: cache.root_name,
        })
    }

    pub async fn update_file_backlinks(
        &self,
        project: &Path,
        source_space_id: Option<&str>,
        source_rel_path: &str,
    ) -> Result<(), AppError> {
        Ok(self
            .core
            .update_file_backlinks(project, source_space_id, source_rel_path)
            .await?)
    }

    pub async fn remove_file_backlinks(
        &self,
        project: &Path,
        source_space_id: Option<&str>,
        source_rel_path: &str,
    ) -> Result<(), AppError> {
        Ok(self
            .core
            .remove_file_backlinks(project, source_space_id, source_rel_path)
            .await?)
    }

    pub async fn ensure_project_backlinks_built(&self, project: &Path) -> Result<(), AppError> {
        Ok(self.core.ensure_project_backlinks_built(project).await?)
    }

    /// Get (or create) the per-key reindex serialization lock.
    pub async fn reindex_lock(&self, key: &IndexKey) -> Arc<Mutex<()>> {
        self.core.reindex_lock(key).await
    }

    #[cfg(test)]
    pub(crate) async fn cleanup_reconciled_index(&self, key: &IndexKey, pool: &SqlitePool) {
        self.core.cleanup_reconciled_index(key, pool).await;
    }

    /// Get an existing pool for the key, or open one (creating the DB
    /// file and schema if necessary).
    pub async fn get_or_create(&self, key: &IndexKey) -> Result<SqlitePool, AppError> {
        Ok(self.core.get_or_create(key).await?)
    }

    /// Return only an already-open pool. Read-only snapshot surfaces use this
    /// to avoid creating or migrating derived storage as a side effect of an
    /// open/search gesture.
    #[cfg(test)]
    pub(crate) async fn existing_pool(&self, key: &IndexKey) -> Option<SqlitePool> {
        self.core.existing_pool(key).await
    }

    /// Get (or create) the runtime backlink index for this key. Lazy-build:
    /// `BacklinkIndex::build` is called on first read by the caller.
    ///
    /// The returned index has `skip_top_level` set to the appropriate list
    /// for `key` (child-space folders for root, empty for spaces) so that
    /// any subsequent build/auto-build excludes nested-pool content.
    #[cfg(test)]
    pub async fn backlinks_for(&self, key: &IndexKey) -> Arc<BacklinkIndex> {
        self.core.backlinks_for(key).await
    }

    /// Drop the pool and runtime backlink index for a key.
    async fn close_key(&self, key: &IndexKey) {
        self.core.close_key(key).await;
        self.close_key_runtime(key).await;
    }

    async fn close_key_runtime(&self, key: &IndexKey) {
        self.lfs_states.lock().await.remove(key);
    }

    pub async fn open_project(&self, project: &Path) -> Result<Vec<IndexKey>, AppError> {
        let cache = ProjectSpacesCache::from_project(project)?;
        let ready_ids: Vec<String> = cache
            .status_by_id
            .iter()
            .filter(|(_, s)| matches!(s, SpaceStatus::Ready))
            .map(|(id, _)| id.clone())
            .collect();

        // Drop any pools previously associated with this project before we
        // overwrite the cache (re-open after reconfig, etc.).
        self.close_project(project).await;

        self.core.replace_project_cache(project, cache).await;
        self.invalidate_project_backlinks(project).await;

        let mut keys: Vec<IndexKey> = vec![IndexKey::Root(project.to_path_buf())];
        for space_id in &ready_ids {
            keys.push(IndexKey::Space {
                project: project.to_path_buf(),
                space_id: space_id.clone(),
            });
        }

        // Eagerly open pools so subsequent IPCs see them.
        for key in &keys {
            if let Err(e) = self.get_or_create(key).await {
                tracing::warn!("open pool failed for {:?}: {e}", key);
            }
        }

        Ok(keys)
    }

    /// Close every pool belonging to `project`.
    pub async fn close_project(&self, project: &Path) {
        let keys_to_close = self.core.close_project(project).await;
        for key in keys_to_close {
            self.close_key_runtime(&key).await;
        }
    }

    /// Folders that the walker for `key` must skip — child-space directories
    /// (each space owns its own pool, so root must not index them, and
    /// nested-space layout would have its own list per level).
    /// Handle `space:added`. Refreshes the resolver cache, opens the pool,
    /// schedules a `full_reindex`. No-op if `status != Ready` (pool stays
    /// closed, status_by_id records the ghost state for resolver errors).
    pub async fn on_space_added(
        &self,
        project: &Path,
        space_id: &str,
        folder_name: &str,
        status: SpaceStatus,
    ) -> Option<IndexKey> {
        let display = matches!(status, SpaceStatus::Ready)
            .then(|| child_space_name(&project.join(folder_name), folder_name));
        self.core
            .upsert_space(project, space_id, folder_name, status, display)
            .await;
        self.invalidate_project_backlinks(project).await;

        if !matches!(status, SpaceStatus::Ready) {
            return None;
        }

        let key = IndexKey::Space {
            project: project.to_path_buf(),
            space_id: space_id.to_string(),
        };
        if let Err(e) = self.get_or_create(&key).await {
            tracing::warn!("on_space_added: get_or_create failed: {e}");
            return None;
        }
        Some(key)
    }

    /// Handle `space:removed`. Drops cache + pool. Idempotent: ghost-state
    /// removals never had a pool open.
    pub async fn on_space_removed(&self, project: &Path, space_id: &str) {
        self.core.remove_space(project, space_id).await;
        self.invalidate_project_backlinks(project).await;
        let key = IndexKey::Space {
            project: project.to_path_buf(),
            space_id: space_id.to_string(),
        };
        self.close_key(&key).await;
    }

    /// Handle `space:status_changed`. ready ↔ missing/broken transitions
    /// open/close the pool to match.
    pub async fn on_space_status_changed(
        &self,
        project: &Path,
        space_id: &str,
        new_status: SpaceStatus,
    ) -> Option<IndexKey> {
        let display = if matches!(new_status, SpaceStatus::Ready) {
            self.core
                .folder_for_space(project, space_id)
                .await
                .map(|folder| child_space_name(&project.join(&folder), &folder))
        } else {
            None
        };
        self.core
            .change_space_status(project, space_id, new_status, display)
            .await;
        self.invalidate_project_backlinks(project).await;
        let key = IndexKey::Space {
            project: project.to_path_buf(),
            space_id: space_id.to_string(),
        };
        match new_status {
            SpaceStatus::Ready => {
                if let Err(e) = self.get_or_create(&key).await {
                    tracing::warn!("status_changed→Ready: get_or_create failed: {e}");
                    return None;
                }
                Some(key)
            }
            SpaceStatus::Missing | SpaceStatus::Broken => {
                self.close_key(&key).await;
                None
            }
        }
    }

    /// Reconcile the resolver cache against a fresh on-disk `SpaceConfig`.
    ///
    /// Called after a root-project git pull (Stage 3.5 Phase 5 §5.4): a pull
    /// may have introduced new inline spaces (or removed some); this opens
    /// pools for newcomers and closes them for departures, without disturbing
    /// the pools that survived. Existing pools whose status is unchanged are
    /// untouched (no reindex storm).
    pub async fn refresh_after_root_pull(&self, project: &Path) -> Result<Vec<IndexKey>, AppError> {
        let fresh = ProjectSpacesCache::from_project(project)?;

        let known = self.core.status_by_id(project).await;

        let mut tasks = Vec::new();
        for (id, status) in &fresh.status_by_id {
            match known.get(id) {
                None => {
                    let folder = fresh.folder_by_id.get(id).cloned().unwrap_or_default();
                    if let Some(key) = self.on_space_added(project, id, &folder, *status).await {
                        tasks.push(key);
                    }
                }
                Some(prev) if prev != status => {
                    if let Some(key) = self.on_space_status_changed(project, id, *status).await {
                        tasks.push(key);
                    }
                }
                _ => {}
            }
        }

        for id in known.keys() {
            if !fresh.status_by_id.contains_key(id) {
                self.on_space_removed(project, id).await;
            }
        }
        self.invalidate_project_backlinks(project).await;

        Ok(tasks)
    }

    /// Snapshot every `IndexKey` belonging to this project — the root key
    /// plus any ready child-space keys cached for the project. Used by
    /// fan-out IPCs (search/reindex) when scope = project.
    pub async fn keys_for_project(&self, project: &PathBuf) -> Vec<IndexKey> {
        self.core.keys_for_project(project).await
    }

    /// Reverse lookup for callers that only know the absolute space directory
    /// (e.g. `git_sync` flow). Searches every loaded project for a child whose
    /// directory matches, falling back to `Root` when the dir IS the project.
    pub async fn key_for_space_dir(&self, space_dir: &Path) -> Option<IndexKey> {
        self.core.key_for_space_dir(space_dir).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::fs;
    use tempfile::TempDir;

    async fn install_child_space_cache(state: &IndexState, project: &Path) {
        state.core.spaces_cache.lock().await.insert(
            project.to_path_buf(),
            ProjectSpacesCache {
                by_folder: HashMap::from([("child".to_string(), "child-space".to_string())]),
                folder_by_id: HashMap::from([("child-space".to_string(), "child".to_string())]),
                status_by_id: HashMap::from([("child-space".to_string(), SpaceStatus::Ready)]),
                root_name: "Root".to_string(),
                name_by_id: HashMap::from([("child-space".to_string(), "Child".to_string())]),
            },
        );
    }

    async fn broken_link_count(state: &IndexState, key: &IndexKey, source: &str) -> i64 {
        let pool = state.get_or_create(key).await.unwrap();
        sqlx::query_scalar("SELECT COUNT(*) FROM broken_links WHERE source_rel_path = ?")
            .bind(source)
            .fetch_one(&pool)
            .await
            .unwrap()
    }

    async fn entry_paths(state: &IndexState, key: &IndexKey) -> Vec<String> {
        let pool = state.core.existing_pool(key).await.unwrap();
        sqlx::query_scalar("SELECT file_path FROM entries ORDER BY file_path")
            .fetch_all(&pool)
            .await
            .unwrap()
    }

    /// The project runtime prepares its pools with the core reconciliation
    /// cycle on open, reopen and a child status change, and the freshness it
    /// reports follows that cycle.
    #[tokio::test]
    async fn open_reopen_and_child_status_change_run_the_core_reconciliation_cycle() {
        let tmp = TempDir::new().unwrap();
        let project = tmp.path().canonicalize().unwrap();
        fs::create_dir_all(project.join(".svode")).unwrap();
        fs::create_dir_all(project.join("child/.svode")).unwrap();
        fs::write(
            project.join(".svode/config.json"),
            r#"{"name":"Project","spaces":[{"id":"child","path":"child","repo":null}]}"#,
        )
        .unwrap();
        fs::write(
            project.join("child/.svode/config.json"),
            r#"{"name":"Child"}"#,
        )
        .unwrap();
        fs::write(project.join("note.md"), "# Note\n").unwrap();
        fs::write(project.join("child/inner.md"), "# Inner\n").unwrap();
        let state = IndexState::new();
        let child_key = IndexKey::Space {
            project: project.clone(),
            space_id: "child".to_string(),
        };

        let keys = state.open_project(&project).await.unwrap();
        assert_eq!(keys.len(), 2);
        for key in &keys {
            state.run_reconciliation(key).await.unwrap();
        }
        let opened = state.core.freshness(&keys).await.unwrap();
        assert!(opened.verified_at.is_some());
        assert_eq!(entry_paths(&state, &keys[0]).await, ["note.md"]);
        assert_eq!(entry_paths(&state, &child_key).await, ["inner.md"]);

        fs::write(project.join("later.md"), "# Later\n").unwrap();
        let keys = state.open_project(&project).await.unwrap();
        // A reopened pool holds its snapshot but no check of this runtime.
        assert_eq!(state.core.freshness(&keys).await.unwrap().verified_at, None);
        for key in &keys {
            state.run_reconciliation(key).await.unwrap();
        }
        assert!(
            state
                .core
                .freshness(&keys)
                .await
                .unwrap()
                .verified_at
                .is_some()
        );
        assert_eq!(entry_paths(&state, &keys[0]).await, ["later.md", "note.md"]);

        assert!(
            state
                .on_space_status_changed(&project, "child", SpaceStatus::Missing)
                .await
                .is_none()
        );
        let missing = state.core.freshness(std::slice::from_ref(&child_key)).await;
        assert_eq!(missing.unwrap_err().diagnostics[0].code, "pool_unavailable");
        let ready = state
            .on_space_status_changed(&project, "child", SpaceStatus::Ready)
            .await
            .unwrap();
        state.run_full_reindex(&ready).await.unwrap();
        let child = state.core.freshness(&[ready]).await.unwrap();
        assert!(child.verified_at.is_some());
        state.close_project(&project).await;
    }

    #[tokio::test]
    async fn targeted_index_rows_do_not_leak_between_root_and_child_space_keys() {
        let tmp = TempDir::new().unwrap();
        let project = tmp.path();
        let child = project.join("child");
        fs::create_dir_all(project.join(".svode")).unwrap();
        fs::create_dir_all(child.join(".svode")).unwrap();
        fs::write(project.join("shared.md"), "root-token").unwrap();
        fs::write(child.join("shared.md"), "child-token").unwrap();
        let state = IndexState::new();
        install_child_space_cache(&state, project).await;

        update::update_entry(&state, project, &project.join("shared.md"))
            .await
            .unwrap();
        update::update_entry(&state, project, &child.join("shared.md"))
            .await
            .unwrap();

        let root_key = IndexKey::Root(project.to_path_buf());
        let child_key = IndexKey::Space {
            project: project.to_path_buf(),
            space_id: "child-space".to_string(),
        };
        let root_pool = state.get_or_create(&root_key).await.unwrap();
        let child_pool = state.get_or_create(&child_key).await.unwrap();
        let root_paths = sqlx::query_scalar::<_, String>("SELECT file_path FROM entries")
            .fetch_all(&root_pool)
            .await
            .unwrap();
        let child_paths = sqlx::query_scalar::<_, String>("SELECT file_path FROM entries")
            .fetch_all(&child_pool)
            .await
            .unwrap();

        assert_eq!(root_paths, vec!["shared.md".to_string()]);
        assert_eq!(child_paths, vec!["shared.md".to_string()]);
        assert_eq!(
            svode_core::index::search::search_fts(&root_pool, "root-token", None, None, 10)
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(
            svode_core::index::search::search_fts(&root_pool, "child-token", None, None, 10)
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            svode_core::index::search::search_fts(&child_pool, "child-token", None, None, 10)
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(
            svode_core::index::search::search_fts(&child_pool, "root-token", None, None, 10)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn update_file_backlinks_cleans_source_side_broken_links_when_target_appears() {
        let tmp = TempDir::new().unwrap();
        let project = tmp.path();
        fs::create_dir_all(project.join(".svode")).unwrap();
        fs::write(project.join("Source.md"), "See [Missing](Missing.md).\n").unwrap();

        let state = IndexState::new();
        let root_key = IndexKey::Root(project.to_path_buf());
        state
            .update_file_backlinks(project, None, "Source.md")
            .await
            .unwrap();
        assert_eq!(broken_link_count(&state, &root_key, "Source.md").await, 1);

        fs::write(project.join("Missing.md"), "Target.\n").unwrap();
        state
            .update_file_backlinks(project, None, "Source.md")
            .await
            .unwrap();

        assert_eq!(broken_link_count(&state, &root_key, "Source.md").await, 0);
        let target_index = state.backlinks_for(&root_key).await;
        let backlinks = target_index.get_backlinks("Missing.md");
        assert_eq!(backlinks.len(), 1);
        assert_eq!(backlinks[0].source_path, "Source.md");
        assert_eq!(backlinks[0].source_space_id, None);
    }

    #[tokio::test]
    async fn update_file_backlinks_tracks_cross_space_sources_and_targets() {
        let tmp = TempDir::new().unwrap();
        let project = tmp.path();
        let child = project.join("child");
        fs::create_dir_all(project.join(".svode")).unwrap();
        fs::create_dir_all(child.join(".svode")).unwrap();
        fs::write(project.join("RootTarget.md"), "Root target.\n").unwrap();
        fs::write(
            project.join("RootSource.md"),
            "See [Child](child/ChildTarget.md).\n",
        )
        .unwrap();
        fs::write(child.join("ChildTarget.md"), "Child target.\n").unwrap();
        fs::write(
            child.join("ChildSource.md"),
            "See [Root](../RootTarget.md).\n",
        )
        .unwrap();

        let state = IndexState::new();
        install_child_space_cache(&state, project).await;
        let root_key = IndexKey::Root(project.to_path_buf());
        let child_key = IndexKey::Space {
            project: project.to_path_buf(),
            space_id: "child-space".to_string(),
        };

        state
            .update_file_backlinks(project, None, "RootSource.md")
            .await
            .unwrap();
        state
            .update_file_backlinks(project, Some("child-space"), "ChildSource.md")
            .await
            .unwrap();

        let child_index = state.backlinks_for(&child_key).await;
        let child_backlinks = child_index.get_backlinks("ChildTarget.md");
        assert_eq!(child_backlinks.len(), 1);
        assert_eq!(child_backlinks[0].source_path, "RootSource.md");
        assert_eq!(child_backlinks[0].source_space_id, None);

        let root_index = state.backlinks_for(&root_key).await;
        let root_backlinks = root_index.get_backlinks("RootTarget.md");
        assert_eq!(root_backlinks.len(), 1);
        assert_eq!(root_backlinks[0].source_path, "ChildSource.md");
        assert_eq!(
            root_backlinks[0].source_space_id,
            Some("child-space".to_string())
        );
    }
}

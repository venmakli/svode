pub mod commands;
pub mod db;
pub mod reindex;
pub mod search;
pub mod update;

use sqlx::SqlitePool;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tokio::sync::{Mutex, Semaphore};

use crate::error::AppError;
use crate::files::BacklinkIndex;
use crate::space::config;
use crate::space::types::{SpaceConfig, SpaceStatus};

const REINDEX_PARALLELISM: usize = 4;

/// Normalize a relative path to forward slashes for cross-platform DB storage.
pub(crate) fn normalize_rel(path: &str) -> String {
    path.replace('\\', "/")
}

/// Identity of an index pool inside a project.
///
/// `Root` covers files that live directly under the project (the project's
/// own inline content); `Space { space_id }` covers a child space (inline,
/// independent, or submodule — the storage shape is identical).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum IndexKey {
    Root(PathBuf),
    Space {
        project: PathBuf,
        space_id: String,
    },
}

impl IndexKey {
    pub fn project(&self) -> &Path {
        match self {
            IndexKey::Root(p) => p,
            IndexKey::Space { project, .. } => project,
        }
    }
}

/// Per-project space lookup tables maintained by `IndexState`. Read on every
/// resolver call; updated on `open_project` / `space:*` lifecycle.
#[derive(Debug, Clone, Default)]
pub struct ProjectSpacesCache {
    /// folder_name → space_id (resolver path → IndexKey)
    by_folder: HashMap<String, String>,
    /// space_id → folder_name (IndexKey → filesystem path)
    folder_by_id: HashMap<String, String>,
    /// space_id → ready/missing/broken (resolver to surface ghost-state)
    status_by_id: HashMap<String, SpaceStatus>,
    /// Display name of the root project (`SpaceConfig.name`), surfaced as
    /// `SearchItem.spaceName` for root-pool entries.
    root_name: String,
    /// space_id → display name (read from each child's `.combai/config.json`).
    /// Populated only for `Ready` spaces; falls back to `folder_name` if the
    /// child config can't be read.
    name_by_id: HashMap<String, String>,
}

impl ProjectSpacesCache {
    fn from_config(project: &Path, cfg: &SpaceConfig) -> Self {
        let mut by_folder = HashMap::new();
        let mut folder_by_id = HashMap::new();
        let mut status_by_id = HashMap::new();
        let mut name_by_id = HashMap::new();
        if let Some(spaces) = &cfg.spaces {
            for sp in spaces {
                let folder = sp.path.clone();
                let space_dir = project.join(&folder);
                let status = if space_dir.exists() {
                    SpaceStatus::Ready
                } else if sp.repo.is_some() {
                    SpaceStatus::Missing
                } else {
                    let gitmodules = project.join(".gitmodules");
                    if gitmodules.exists() {
                        let content = std::fs::read_to_string(&gitmodules).unwrap_or_default();
                        if content.contains(&format!("path = {}", folder)) {
                            SpaceStatus::Missing
                        } else {
                            SpaceStatus::Broken
                        }
                    } else {
                        SpaceStatus::Broken
                    }
                };
                if matches!(status, SpaceStatus::Ready) {
                    let display = read_child_space_name(&space_dir, &folder);
                    name_by_id.insert(sp.id.clone(), display);
                }
                by_folder.insert(folder.clone(), sp.id.clone());
                folder_by_id.insert(sp.id.clone(), folder);
                status_by_id.insert(sp.id.clone(), status);
            }
        }
        Self {
            by_folder,
            folder_by_id,
            status_by_id,
            root_name: cfg.name.clone(),
            name_by_id,
        }
    }
}

/// Read a child space's display name from its `.combai/config.json`. Falls
/// back to `folder_name` and logs a warning if the read fails — name is a
/// UI nicety, not a critical path.
fn read_child_space_name(space_dir: &Path, folder_name: &str) -> String {
    match config::read_space_config(space_dir) {
        Ok(cfg) => cfg.name,
        Err(e) => {
            tracing::warn!(
                "read child space name failed for {}: {e}",
                space_dir.display()
            );
            folder_name.to_string()
        }
    }
}

/// Resolve `abs_path` to the index pool that owns it plus the relative path
/// inside that pool.
///
/// First-segment match per the flat-space invariant: the project knows only
/// its direct children. Algorithm scales to nested spaces unchanged (each
/// level holds its own `SpaceConfig`).
pub fn resolve_index_target(
    project: &Path,
    cache: &ProjectSpacesCache,
    abs_path: &Path,
) -> Result<(IndexKey, String), AppError> {
    let rel = abs_path.strip_prefix(project).map_err(|_| {
        AppError::Index(format!(
            "path outside project root: {}",
            abs_path.display()
        ))
    })?;

    let segments: Vec<&str> = rel
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => s.to_str(),
            _ => None,
        })
        .collect();

    if segments.is_empty() {
        return Ok((IndexKey::Root(project.to_path_buf()), String::new()));
    }

    if let Some(space_id) = cache.by_folder.get(segments[0]) {
        if !matches!(
            cache.status_by_id.get(space_id),
            Some(SpaceStatus::Ready)
        ) {
            return Err(AppError::Index(format!(
                "target space unavailable: {}",
                segments[0]
            )));
        }
        let sub_rel = segments[1..].join("/");
        return Ok((
            IndexKey::Space {
                project: project.to_path_buf(),
                space_id: space_id.clone(),
            },
            sub_rel,
        ));
    }

    Ok((IndexKey::Root(project.to_path_buf()), segments.join("/")))
}

/// Per-project SQLite + backlink state managed by Tauri.
///
/// Holds one pool per `IndexKey` — root project + each ready child space —
/// plus matching reindex serialization locks and runtime backlink indices.
pub struct IndexState {
    pools: Mutex<HashMap<IndexKey, SqlitePool>>,
    /// Per-key serialization lock for `full_reindex`. Two rapid `open_project`
    /// calls would otherwise spawn two concurrent reindexes against the same
    /// DB — correct under SQLite serialization, but doubles the work and
    /// exposes a brief empty-index window twice.
    reindex_locks: Mutex<HashMap<IndexKey, Arc<Mutex<()>>>>,
    /// Per-key runtime backlink index. Mirrors `pools` lifecycle. Lazy-build:
    /// `BacklinkIndex::build` runs on first access (preserves current
    /// behaviour — not eager at `open_project`).
    backlinks: Mutex<HashMap<IndexKey, Arc<BacklinkIndex>>>,
    /// Per-project resolver cache. Refreshed on `open_project` and on every
    /// `space:*` lifecycle event.
    spaces_cache: Mutex<HashMap<PathBuf, ProjectSpacesCache>>,
}

impl IndexState {
    pub fn new() -> Self {
        Self {
            pools: Mutex::new(HashMap::new()),
            reindex_locks: Mutex::new(HashMap::new()),
            backlinks: Mutex::new(HashMap::new()),
            spaces_cache: Mutex::new(HashMap::new()),
        }
    }

    /// Resolve an absolute path into the owning `IndexKey` and rel-path.
    /// Caller must already know the project root.
    pub async fn resolve(
        &self,
        project: &Path,
        abs_path: &Path,
    ) -> Result<(IndexKey, String), AppError> {
        let cache_guard = self.spaces_cache.lock().await;
        let cache = cache_guard
            .get(project)
            .cloned()
            .unwrap_or_default();
        drop(cache_guard);
        resolve_index_target(project, &cache, abs_path)
    }

    /// Display name for this pool's source: project name for `Root`, child
    /// `SpaceConfig.name` for `Space`. Falls back to folder name if the cache
    /// has no entry (treated as a soft miss).
    pub async fn space_name(&self, key: &IndexKey) -> String {
        let cache = self.spaces_cache.lock().await;
        match key {
            IndexKey::Root(project) => cache
                .get(project)
                .map(|c| c.root_name.clone())
                .unwrap_or_default(),
            IndexKey::Space { project, space_id } => cache
                .get(project)
                .and_then(|c| {
                    c.name_by_id
                        .get(space_id)
                        .cloned()
                        .or_else(|| c.folder_by_id.get(space_id).cloned())
                })
                .unwrap_or_default(),
        }
    }

    /// Returns the directory whose `.combai/index.db` backs this key — i.e.,
    /// the root project path or the ready child-space path.
    pub async fn dir_for_key(&self, key: &IndexKey) -> Result<PathBuf, AppError> {
        match key {
            IndexKey::Root(p) => Ok(p.clone()),
            IndexKey::Space { project, space_id } => {
                let cache = self.spaces_cache.lock().await;
                let folder = cache
                    .get(project)
                    .and_then(|c| c.folder_by_id.get(space_id))
                    .ok_or_else(|| AppError::SpaceNotFound(space_id.clone()))?;
                Ok(project.join(folder))
            }
        }
    }

    /// Get (or create) the per-key reindex serialization lock.
    pub async fn reindex_lock(&self, key: &IndexKey) -> Arc<Mutex<()>> {
        let mut locks = self.reindex_locks.lock().await;
        locks
            .entry(key.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    /// Get an existing pool for the key, or open one (creating the DB
    /// file and schema if necessary).
    pub async fn get_or_create(&self, key: &IndexKey) -> Result<SqlitePool, AppError> {
        {
            let pools = self.pools.lock().await;
            if let Some(pool) = pools.get(key) {
                return Ok(pool.clone());
            }
        }

        let dir = self.dir_for_key(key).await?;
        let db_path = dir.join(".combai").join("index.db");
        let pool = db::create_pool(&db_path).await?;
        db::ensure_schema(&pool).await?;

        let mut pools = self.pools.lock().await;
        if let Some(existing) = pools.get(key) {
            return Ok(existing.clone());
        }
        pools.insert(key.clone(), pool.clone());
        Ok(pool)
    }

    /// Get (or create) the runtime backlink index for this key. Lazy-build:
    /// `BacklinkIndex::build` is called on first read by the caller.
    ///
    /// The returned index has `skip_top_level` set to the appropriate list
    /// for `key` (child-space folders for root, empty for spaces) so that
    /// any subsequent build/auto-build excludes nested-pool content.
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

    /// Drop the pool and runtime backlink index for a key.
    async fn close_key(&self, key: &IndexKey) {
        let pool = {
            let mut pools = self.pools.lock().await;
            pools.remove(key)
        };
        if let Some(pool) = pool {
            tracing::info!("closing index pool for {:?}", key);
            pool.close().await;
        }
        self.backlinks.lock().await.remove(key);
        self.reindex_locks.lock().await.remove(key);
    }

    /// Open root + all ready child-space pools for `project` and spawn a
    /// background `full_reindex` for each (under reindex lock + a Semaphore-4
    /// concurrency limit).
    ///
    /// Order: cache snapshot → open pools → spawn reindex. Watcher events
    /// arriving during reindex can be safely dropped — the full_reindex will
    /// pick up everything; events after the snapshot are handled by
    /// subsequent `update_entry` calls.
    pub async fn open_project(
        &self,
        app: &AppHandle,
        project: &Path,
    ) -> Result<(), AppError> {
        let cfg = config::read_space_config(project)?;
        let cache = ProjectSpacesCache::from_config(project, &cfg);
        let ready_ids: Vec<String> = cache
            .status_by_id
            .iter()
            .filter(|(_, s)| matches!(s, SpaceStatus::Ready))
            .map(|(id, _)| id.clone())
            .collect();

        // Drop any pools previously associated with this project before we
        // overwrite the cache (re-open after reconfig, etc.).
        self.close_project(project).await;

        self.spaces_cache
            .lock()
            .await
            .insert(project.to_path_buf(), cache);

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

        // Spawn fan-out full_reindex.
        let semaphore = Arc::new(Semaphore::new(REINDEX_PARALLELISM));
        let app_handle = app.clone();
        for key in keys {
            let sem = semaphore.clone();
            let app = app_handle.clone();
            tokio::spawn(async move {
                let _permit = match sem.acquire_owned().await {
                    Ok(p) => p,
                    Err(_) => return,
                };
                let state = app.state::<IndexState>();
                let pool = match state.get_or_create(&key).await {
                    Ok(p) => p,
                    Err(e) => {
                        tracing::warn!("background reindex: get_or_create failed for {:?}: {e}", key);
                        return;
                    }
                };
                let dir = match state.dir_for_key(&key).await {
                    Ok(d) => d,
                    Err(e) => {
                        tracing::warn!("background reindex: dir_for_key failed for {:?}: {e}", key);
                        return;
                    }
                };
                let skip = state.skip_folders_for(&key).await;
                let lock = state.reindex_lock(&key).await;
                let _guard = lock.lock().await;
                if let Err(e) = reindex::full_reindex(&pool, &dir, &skip).await {
                    tracing::warn!(
                        "background reindex failed for {}: {e}",
                        dir.display()
                    );
                }
            });
        }

        Ok(())
    }

    /// Close every pool belonging to `project`.
    pub async fn close_project(&self, project: &Path) {
        let keys_to_close: Vec<IndexKey> = {
            let pools = self.pools.lock().await;
            pools
                .keys()
                .filter(|k| k.project() == project)
                .cloned()
                .collect()
        };
        for key in keys_to_close {
            self.close_key(&key).await;
        }
        self.spaces_cache.lock().await.remove(project);
    }

    /// Folders that the walker for `key` must skip — child-space directories
    /// (each space owns its own pool, so root must not index them, and
    /// nested-space layout would have its own list per level).
    pub async fn skip_folders_for(&self, key: &IndexKey) -> Vec<String> {
        match key {
            IndexKey::Root(project) => {
                let cache = self.spaces_cache.lock().await;
                cache
                    .get(project)
                    .map(|c| c.by_folder.keys().cloned().collect())
                    .unwrap_or_default()
            }
            // Flat-space invariant: child spaces have no nested children.
            IndexKey::Space { .. } => Vec::new(),
        }
    }

    /// Handle `space:added`. Refreshes the resolver cache, opens the pool,
    /// schedules a `full_reindex`. No-op if `status != Ready` (pool stays
    /// closed, status_by_id records the ghost state for resolver errors).
    pub async fn on_space_added(
        &self,
        app: &AppHandle,
        project: &Path,
        space_id: &str,
        folder_name: &str,
        status: SpaceStatus,
    ) {
        {
            let mut cache = self.spaces_cache.lock().await;
            let entry = cache.entry(project.to_path_buf()).or_default();
            entry
                .by_folder
                .insert(folder_name.to_string(), space_id.to_string());
            entry
                .folder_by_id
                .insert(space_id.to_string(), folder_name.to_string());
            entry.status_by_id.insert(space_id.to_string(), status);
            if matches!(status, SpaceStatus::Ready) {
                let space_dir = project.join(folder_name);
                let display = read_child_space_name(&space_dir, folder_name);
                entry.name_by_id.insert(space_id.to_string(), display);
            } else {
                entry.name_by_id.remove(space_id);
            }
        }

        if !matches!(status, SpaceStatus::Ready) {
            return;
        }

        let key = IndexKey::Space {
            project: project.to_path_buf(),
            space_id: space_id.to_string(),
        };
        if let Err(e) = self.get_or_create(&key).await {
            tracing::warn!("on_space_added: get_or_create failed: {e}");
            return;
        }

        let app_handle = app.clone();
        tokio::spawn(async move {
            let state = app_handle.state::<IndexState>();
            let pool = match state.get_or_create(&key).await {
                Ok(p) => p,
                Err(e) => {
                    tracing::warn!("on_space_added reindex: get_or_create failed: {e}");
                    return;
                }
            };
            let dir = match state.dir_for_key(&key).await {
                Ok(d) => d,
                Err(e) => {
                    tracing::warn!("on_space_added reindex: dir_for_key failed: {e}");
                    return;
                }
            };
            let skip = state.skip_folders_for(&key).await;
            let lock = state.reindex_lock(&key).await;
            let _guard = lock.lock().await;
            if let Err(e) = reindex::full_reindex(&pool, &dir, &skip).await {
                tracing::warn!("on_space_added full_reindex failed: {e}");
            }
        });
    }

    /// Handle `space:removed`. Drops cache + pool. Idempotent: ghost-state
    /// removals never had a pool open.
    pub async fn on_space_removed(&self, project: &Path, space_id: &str) {
        {
            let mut cache = self.spaces_cache.lock().await;
            if let Some(entry) = cache.get_mut(project) {
                if let Some(folder) = entry.folder_by_id.remove(space_id) {
                    entry.by_folder.remove(&folder);
                }
                entry.status_by_id.remove(space_id);
                entry.name_by_id.remove(space_id);
            }
        }
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
        app: &AppHandle,
        project: &Path,
        space_id: &str,
        new_status: SpaceStatus,
    ) {
        {
            let mut cache = self.spaces_cache.lock().await;
            if let Some(entry) = cache.get_mut(project) {
                entry
                    .status_by_id
                    .insert(space_id.to_string(), new_status);
                match new_status {
                    SpaceStatus::Ready => {
                        if let Some(folder) = entry.folder_by_id.get(space_id).cloned() {
                            let space_dir = project.join(&folder);
                            let display = read_child_space_name(&space_dir, &folder);
                            entry.name_by_id.insert(space_id.to_string(), display);
                        }
                    }
                    SpaceStatus::Missing | SpaceStatus::Broken => {
                        entry.name_by_id.remove(space_id);
                    }
                }
            }
        }
        let key = IndexKey::Space {
            project: project.to_path_buf(),
            space_id: space_id.to_string(),
        };
        match new_status {
            SpaceStatus::Ready => {
                if let Err(e) = self.get_or_create(&key).await {
                    tracing::warn!("status_changed→Ready: get_or_create failed: {e}");
                    return;
                }
                let app_handle = app.clone();
                tokio::spawn(async move {
                    let state = app_handle.state::<IndexState>();
                    let pool = match state.get_or_create(&key).await {
                        Ok(p) => p,
                        Err(_) => return,
                    };
                    let dir = match state.dir_for_key(&key).await {
                        Ok(d) => d,
                        Err(_) => return,
                    };
                    let skip = state.skip_folders_for(&key).await;
                    let lock = state.reindex_lock(&key).await;
                    let _guard = lock.lock().await;
                    if let Err(e) = reindex::full_reindex(&pool, &dir, &skip).await {
                        tracing::warn!("status_changed→Ready full_reindex failed: {e}");
                    }
                });
            }
            SpaceStatus::Missing | SpaceStatus::Broken => {
                self.close_key(&key).await;
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
    pub async fn refresh_after_root_pull(
        &self,
        app: &AppHandle,
        project: &Path,
    ) -> Result<(), AppError> {
        let cfg = config::read_space_config(project)?;
        let fresh = ProjectSpacesCache::from_config(project, &cfg);

        let known: HashMap<String, SpaceStatus> = {
            let cache = self.spaces_cache.lock().await;
            cache
                .get(project)
                .map(|c| {
                    c.status_by_id
                        .iter()
                        .map(|(k, v)| (k.clone(), *v))
                        .collect()
                })
                .unwrap_or_default()
        };

        for (id, status) in &fresh.status_by_id {
            match known.get(id) {
                None => {
                    let folder = fresh
                        .folder_by_id
                        .get(id)
                        .cloned()
                        .unwrap_or_default();
                    self.on_space_added(app, project, id, &folder, *status)
                        .await;
                }
                Some(prev) if prev != status => {
                    self.on_space_status_changed(app, project, id, *status).await;
                }
                _ => {}
            }
        }

        for id in known.keys() {
            if !fresh.status_by_id.contains_key(id) {
                self.on_space_removed(project, id).await;
            }
        }

        Ok(())
    }

    /// Snapshot every `IndexKey` belonging to this project — the root key
    /// plus any ready child-space keys cached for the project. Used by
    /// fan-out IPCs (search/reindex) when scope = project.
    pub async fn keys_for_project(&self, project: &PathBuf) -> Vec<IndexKey> {
        let mut keys: Vec<IndexKey> = vec![IndexKey::Root(project.clone())];
        let cache = self.spaces_cache.lock().await;
        if let Some(c) = cache.get(project) {
            for (space_id, status) in &c.status_by_id {
                if matches!(status, SpaceStatus::Ready) {
                    keys.push(IndexKey::Space {
                        project: project.clone(),
                        space_id: space_id.clone(),
                    });
                }
            }
        }
        keys
    }

    /// Reverse lookup for callers that only know the absolute space directory
    /// (e.g. `git_sync` flow). Searches every loaded project for a child whose
    /// directory matches, falling back to `Root` when the dir IS the project.
    pub async fn key_for_space_dir(&self, space_dir: &Path) -> Option<IndexKey> {
        let cache = self.spaces_cache.lock().await;
        for (project, project_cache) in cache.iter() {
            if project == space_dir {
                return Some(IndexKey::Root(project.clone()));
            }
            for (space_id, folder) in &project_cache.folder_by_id {
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

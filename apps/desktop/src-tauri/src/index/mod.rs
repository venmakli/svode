pub mod commands;
pub mod db;
pub mod knowledge;
mod lifecycle;
pub(crate) mod page_dates;
pub mod reconcile;
pub mod reindex;
mod retention;
pub mod search;
pub mod service;
pub mod update;

use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use crate::error::AppError;
use crate::files::BacklinkIndex;
use crate::files::backlinks::{
    LinkSource, ModifiedLinkSource, collect_md_files, dedupe_modified_sources,
    is_backlink_discoverable_path, is_external_or_anchor_url, link_stem, markdown_url_path,
    rebase_source_links_between, replace_link_urls_between,
};
use crate::git::access::ensure_mutation_paths_were_authorized;
use crate::repo_path::{RootMode, normalize_repo_relative};
use crate::space::types::{SpaceConfig, SpaceStatus};
use crate::space::{config, project};
use crate::storage::lfs::LfsState;
use crate::system_path;
use svode_core::content_tree::policy::TreeIgnorePolicy;

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

#[derive(Debug, Clone, Default)]
pub struct ProjectLinkMutationPlan {
    mutation_paths: Vec<PathBuf>,
}

impl ProjectLinkMutationPlan {
    pub fn mutation_paths(&self) -> &[PathBuf] {
        &self.mutation_paths
    }
}

pub use svode_core::index::resolver::ProjectSpacesCache;

fn project_spaces_cache_from_config(project: &Path, cfg: &SpaceConfig) -> ProjectSpacesCache {
    let mut cache = ProjectSpacesCache {
        root_name: cfg.name.clone(),
        ..ProjectSpacesCache::default()
    };
    if let Some(spaces) = &cfg.spaces {
        for sp in spaces {
            let folder = sp.path.clone();
            let space_dir = project.join(&folder);
            let status = project::space_ref_status(project, sp);
            if matches!(status, SpaceStatus::Ready) {
                cache
                    .name_by_id
                    .insert(sp.id.clone(), read_child_space_name(&space_dir, &folder));
            }
            cache.by_folder.insert(folder.clone(), sp.id.clone());
            cache.folder_by_id.insert(sp.id.clone(), folder);
            cache.status_by_id.insert(sp.id.clone(), status);
        }
    }
    cache
}

/// Read a child space's display name from its `.svode/config.json`. Falls
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

pub fn resolve_index_target(
    project: &Path,
    cache: &ProjectSpacesCache,
    abs_path: &Path,
) -> Result<(IndexKey, String), AppError> {
    Ok(svode_core::index::resolver::resolve_index_target(
        project, cache, abs_path,
    )?)
}

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

/// Per-project SQLite + backlink state managed by Tauri.
///
/// Holds one pool per `IndexKey` — root project + each ready child space —
/// plus matching reindex serialization locks and runtime backlink indices.
#[derive(Clone)]
pub struct IndexState {
    pub(crate) core: svode_core::index::state::IndexRuntimeState,
    /// Per-key runtime backlink index. Mirrors `pools` lifecycle. Lazy-build:
    /// `BacklinkIndex::build` runs on first access (preserves current
    /// behaviour — not eager at `open_project`).
    backlinks: Arc<Mutex<HashMap<IndexKey, Arc<BacklinkIndex>>>>,
    /// Per-key LFS runtime state. Initial value for any key is
    /// `NotApplicable`; the actual probe is lazy (triggered by user gestures
    /// or post-clone/sync events). See `storage/lfs.rs`.
    lfs_states: Arc<Mutex<HashMap<IndexKey, LfsState>>>,
}

/// RAII guard: clears the `reindex_active` flag when dropped, even on panic.
pub(crate) struct ReindexActiveGuard(pub(crate) Arc<AtomicBool>);

impl Drop for ReindexActiveGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl IndexState {
    pub fn new() -> Self {
        Self {
            core: svode_core::index::state::IndexRuntimeState::default(),
            backlinks: Arc::new(Mutex::new(HashMap::new())),
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

    fn source_for_key(key: &IndexKey, rel_path: &str) -> LinkSource {
        LinkSource {
            source_space_id: Self::space_id_for_key(key),
            source_path: normalize_rel(rel_path),
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
        let key = self.key_for_project_space_id(project, space_id).await?;
        self.dir_for_key(&key).await
    }

    pub async fn invalidate_project_backlinks(&self, project: &Path) {
        let keys = self.keys_for_project(&project.to_path_buf()).await;
        let map = self.backlinks.lock().await;
        for key in keys {
            if let Some(index) = map.get(&key) {
                index.mark_stale();
            }
        }
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

    async fn resolve_link_target_key(
        &self,
        project: &Path,
        source_space_id: Option<&str>,
        source_path: &str,
        url: &str,
    ) -> Result<Option<(IndexKey, String)>, AppError> {
        if is_external_or_anchor_url(url) {
            return Ok(None);
        }
        let source_key = self
            .key_for_project_space_id(project, source_space_id)
            .await?;
        let source_dir = self.dir_for_key(&source_key).await?;
        let source_rel = normalize_rel_result(source_path)?;
        let target_link = markdown_url_path(url);

        let source_parent_rel = Path::new(&source_rel).parent().unwrap_or(Path::new(""));
        let source_parent_abs = source_dir.join(source_parent_rel);
        let target_abs = match normalize_abs_path(&source_parent_abs.join(&target_link)) {
            Some(p) if p.starts_with(project) => p,
            _ => return Ok(None),
        };

        let cache_guard = self.core.spaces_cache.lock().await;
        let cache = cache_guard.get(project).cloned().unwrap_or_default();
        drop(cache_guard);
        match resolve_index_target(project, &cache, &target_abs) {
            Ok((key, rel)) if !rel.is_empty() => Ok(Some((key, normalize_rel_result(&rel)?))),
            Ok(_) => Ok(None),
            Err(_) => Ok(None),
        }
    }

    async fn remove_source_from_project(&self, project: &Path, source: &LinkSource) {
        let keys = self.keys_for_project(&project.to_path_buf()).await;
        for key in keys {
            let index = self.backlinks_for(&key).await;
            index.remove_source(source);
        }
    }

    pub async fn update_file_backlinks(
        &self,
        project: &Path,
        source_space_id: Option<&str>,
        source_rel_path: &str,
    ) -> Result<(), AppError> {
        let source_key = self
            .key_for_project_space_id(project, source_space_id)
            .await?;
        let source_dir = self.dir_for_key(&source_key).await?;
        let source_rel = normalize_rel_result(source_rel_path)?;
        let source = Self::source_for_key(&source_key, &source_rel);
        self.remove_source_from_project(project, &source).await;

        let pool = self.get_or_create(&source_key).await?;
        sqlx::query("DELETE FROM broken_links WHERE source_rel_path = ?")
            .bind(&source_rel)
            .execute(&pool)
            .await?;

        let abs = source_dir.join(&source_rel);
        if !abs.exists() {
            return Ok(());
        }
        let policy = TreeIgnorePolicy::from_space_root(&source_dir);
        if !is_backlink_discoverable_path(&source_dir, &source_rel, &policy) {
            return Ok(());
        }

        let content = std::fs::read_to_string(&abs)?;
        let links = crate::files::backlinks::parse_markdown_links(&content);
        let mut grouped: HashMap<
            IndexKey,
            HashMap<String, Vec<crate::files::backlinks::LinkSpan>>,
        > = HashMap::new();

        for (url_path, span) in links {
            let raw_url = url_path;
            let target = self
                .resolve_link_target_key(project, source_space_id, &source_rel, &raw_url)
                .await?;
            let Some((target_key, target_rel)) = target else {
                let resolved = self
                    .resolve_doc_link(project, source_space_id, &source_rel, &raw_url)
                    .await?;
                self.insert_broken_link(
                    &pool,
                    &source_rel,
                    resolved.target_space_id.as_deref(),
                    &raw_url,
                )
                .await?;
                continue;
            };
            let target_dir = self.dir_for_key(&target_key).await?;
            let target_abs = target_dir.join(&target_rel);
            let target_policy = TreeIgnorePolicy::from_space_root(&target_dir);
            if !is_backlink_discoverable_path(&target_dir, &target_rel, &target_policy) {
                continue;
            }
            if !target_abs.exists() {
                let target_space_id = Self::space_id_for_key(&target_key);
                self.insert_broken_link(&pool, &source_rel, target_space_id.as_deref(), &raw_url)
                    .await?;
                continue;
            }
            grouped
                .entry(target_key)
                .or_default()
                .entry(target_rel)
                .or_default()
                .push(span);
        }

        for (target_key, by_target) in grouped {
            let target_index = self.backlinks_for(&target_key).await;
            for (target_rel, spans) in by_target {
                target_index.add_source_links(&target_rel, source.clone(), spans);
            }
        }

        Ok(())
    }

    pub async fn remove_file_backlinks(
        &self,
        project: &Path,
        source_space_id: Option<&str>,
        source_rel_path: &str,
    ) -> Result<(), AppError> {
        let source_key = self
            .key_for_project_space_id(project, source_space_id)
            .await?;
        let source_rel = normalize_rel_result(source_rel_path)?;
        let source = Self::source_for_key(&source_key, &source_rel);
        self.remove_source_from_project(project, &source).await;
        let pool = self.get_or_create(&source_key).await?;
        sqlx::query("DELETE FROM broken_links WHERE source_rel_path = ?")
            .bind(&source_rel)
            .execute(&pool)
            .await?;
        Ok(())
    }

    async fn insert_broken_link(
        &self,
        pool: &SqlitePool,
        source_rel: &str,
        target_space_id: Option<&str>,
        target_url: &str,
    ) -> Result<(), AppError> {
        sqlx::query(
            "INSERT OR REPLACE INTO broken_links \
             (source_rel_path, target_space_id, target_url, detected_at) \
             VALUES (?, ?, ?, ?)",
        )
        .bind(source_rel)
        .bind(target_space_id)
        .bind(target_url)
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn rebuild_source_backlinks(&self, key: &IndexKey) -> Result<(), AppError> {
        let dir = self.dir_for_key(key).await?;
        let skip = self.skip_folders_for(key).await;
        let files = collect_md_files(&dir, &skip)?;
        let source_space_id = Self::space_id_for_key(key);
        let keys = self.keys_for_project(&key.project().to_path_buf()).await;
        for target_key in keys {
            self.backlinks_for(&target_key)
                .await
                .remove_sources_in_space(source_space_id.as_deref());
        }
        let pool = self.get_or_create(key).await?;
        sqlx::query("DELETE FROM broken_links")
            .execute(&pool)
            .await?;

        for file in files {
            let rel = crate::repo_path::repo_relative_from_base(&dir, &file, RootMode::Reject)?;
            self.update_file_backlinks(key.project(), source_space_id.as_deref(), &rel)
                .await?;
        }
        Ok(())
    }

    pub async fn ensure_project_backlinks_built(&self, project: &Path) -> Result<(), AppError> {
        let keys = self.keys_for_project(&project.to_path_buf()).await;
        let all_built = {
            let map = self.backlinks.lock().await;
            keys.iter()
                .all(|key| map.get(key).is_some_and(|idx| idx.is_built()))
        };
        if all_built {
            return Ok(());
        }

        {
            let map = self.backlinks.lock().await;
            for key in &keys {
                if let Some(index) = map.get(key) {
                    index.mark_stale();
                }
            }
        }

        for key in &keys {
            self.rebuild_source_backlinks(key).await?;
        }
        for key in &keys {
            self.backlinks_for(key).await.mark_built();
        }
        Ok(())
    }

    pub async fn update_links_on_rename_project(
        &self,
        updates: &update::IndexUpdateState,
        project: &Path,
        target_space_id: Option<&str>,
        old_path: &str,
        new_path: &str,
        new_title: Option<&str>,
    ) -> Result<Vec<ModifiedLinkSource>, AppError> {
        self.ensure_project_backlinks_built(project).await?;
        let target_key = self
            .key_for_project_space_id(project, target_space_id)
            .await?;
        let target_dir = self.dir_for_key(&target_key).await?;
        let target_index = self.backlinks_for(&target_key).await;
        let sources = target_index.sources_for_target(old_path);
        if sources.is_empty() {
            return Ok(Vec::new());
        }

        let old_abs = target_dir.join(old_path);
        let new_abs = target_dir.join(new_path);
        let old_stem = link_stem(old_path);
        let text_replace = new_title.map(|title| (old_stem.as_str(), title));
        let mut planned = Vec::new();

        for (source, _) in sources {
            let source_dir = self
                .space_path_of(project, source.source_space_id.as_deref())
                .await?;
            let source_abs = source_dir.join(&source.source_path);
            if !source_abs.exists() {
                continue;
            }
            let content = std::fs::read_to_string(&source_abs)?;
            let updated =
                replace_link_urls_between(&content, &source_abs, &old_abs, &new_abs, text_replace);
            if updated != content {
                planned.push((
                    source_abs,
                    content,
                    updated,
                    ModifiedLinkSource {
                        space_id: source.source_space_id.clone(),
                        path: source.source_path.clone(),
                    },
                ));
            }
        }

        let mutation_paths = planned
            .iter()
            .map(|(path, _, _, _)| path.clone())
            .collect::<Vec<_>>();
        ensure_mutation_paths_were_authorized(&mutation_paths)?;
        let mut written = Vec::new();
        for (source_abs, content, updated, _) in &planned {
            if let Err(error) = std::fs::write(source_abs, updated) {
                for (written_path, original) in written {
                    let _ = std::fs::write(written_path, original);
                }
                return Err(AppError::Io(error));
            }
            written.push((source_abs, content));
        }

        let modified = planned
            .into_iter()
            .map(|(_, _, _, source)| source)
            .collect::<Vec<_>>();

        let modified = dedupe_modified_sources(modified);
        for item in &modified {
            let source_dir = self
                .space_path_of(project, item.space_id.as_deref())
                .await?;
            if let Err(error) = crate::index::update::publish_managed_path(
                self,
                updates,
                project,
                &source_dir.join(&item.path),
            )
            .await
            {
                tracing::warn!("failed to update rewritten backlink source index: {error}");
            }
        }
        Ok(modified)
    }

    pub async fn plan_links_on_rename_project(
        &self,
        project: &Path,
        target_space_id: Option<&str>,
        old_path: &str,
    ) -> Result<ProjectLinkMutationPlan, AppError> {
        self.ensure_project_backlinks_built(project).await?;
        let target_key = self
            .key_for_project_space_id(project, target_space_id)
            .await?;
        let target_index = self.backlinks_for(&target_key).await;
        let mut mutation_paths = Vec::new();
        for (source, _) in target_index.sources_for_target(old_path) {
            let source_dir = self
                .space_path_of(project, source.source_space_id.as_deref())
                .await?;
            let source_abs = source_dir.join(source.source_path);
            if source_abs.is_file() {
                mutation_paths.push(source_abs);
            }
        }
        mutation_paths.sort();
        mutation_paths.dedup();
        Ok(ProjectLinkMutationPlan { mutation_paths })
    }

    pub async fn plan_links_on_folder_rename_project(
        &self,
        project: &Path,
        target_space_id: Option<&str>,
        old_folder: &str,
    ) -> Result<ProjectLinkMutationPlan, AppError> {
        self.ensure_project_backlinks_built(project).await?;
        let target_key = self
            .key_for_project_space_id(project, target_space_id)
            .await?;
        let target_index = self.backlinks_for(&target_key).await;
        let old_norm = normalize_rel_result(old_folder)?;
        let mut mutation_paths = Vec::new();
        for old_target in target_index.target_paths_under(&old_norm) {
            mutation_paths.extend(
                self.plan_links_on_rename_project(project, target_space_id, &old_target)
                    .await?
                    .mutation_paths,
            );
        }
        mutation_paths.sort();
        mutation_paths.dedup();
        Ok(ProjectLinkMutationPlan { mutation_paths })
    }

    pub async fn update_links_on_folder_rename_project(
        &self,
        updates: &update::IndexUpdateState,
        project: &Path,
        target_space_id: Option<&str>,
        old_folder: &str,
        new_folder: &str,
        new_head_title: Option<&str>,
    ) -> Result<Vec<ModifiedLinkSource>, AppError> {
        let current_plan = self
            .plan_links_on_folder_rename_project(project, target_space_id, old_folder)
            .await?;
        ensure_mutation_paths_were_authorized(current_plan.mutation_paths())?;
        self.ensure_project_backlinks_built(project).await?;
        let target_key = self
            .key_for_project_space_id(project, target_space_id)
            .await?;
        let target_dir = self.dir_for_key(&target_key).await?;
        let target_index = self.backlinks_for(&target_key).await;
        let old_norm = normalize_rel_result(old_folder)?;
        let new_norm = normalize_rel_result(new_folder)?;
        let old_prefix = format!("{old_norm}/");
        let mut targets = target_index
            .target_paths_under(&old_norm)
            .into_iter()
            .map(|old_target| {
                let remainder = old_target.strip_prefix(&old_prefix).unwrap_or(&old_target);
                let new_target = format!("{new_norm}/{remainder}");
                (old_target, new_target)
            })
            .collect::<Vec<_>>();
        targets.sort_by(|left, right| left.0.cmp(&right.0));
        let mut sources = targets
            .iter()
            .flat_map(|(old_target, _)| {
                target_index
                    .sources_for_target(old_target)
                    .into_iter()
                    .map(|(source, _)| source)
            })
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        sources.sort_by(|left, right| {
            (&left.source_space_id, &left.source_path)
                .cmp(&(&right.source_space_id, &right.source_path))
        });
        let mut planned = Vec::new();
        for source in sources {
            let source_dir = self
                .space_path_of(project, source.source_space_id.as_deref())
                .await?;
            let source_abs = source_dir.join(&source.source_path);
            if !source_abs.exists() {
                continue;
            }
            let content = std::fs::read_to_string(&source_abs)?;
            let mut updated = content.clone();
            for (old_target, new_target) in &targets {
                let is_head = Path::new(old_target)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.eq_ignore_ascii_case("readme.md"))
                    && Path::new(old_target).parent() == Some(Path::new(&old_norm));
                let text_replace = if is_head {
                    new_head_title.map(|title| (link_stem(old_target), title))
                } else {
                    None
                };
                updated = replace_link_urls_between(
                    &updated,
                    &source_abs,
                    &target_dir.join(old_target),
                    &target_dir.join(new_target),
                    text_replace
                        .as_ref()
                        .map(|(old_stem, title)| (old_stem.as_str(), *title)),
                );
            }
            if updated != content {
                planned.push((
                    source_abs,
                    content,
                    updated,
                    ModifiedLinkSource {
                        space_id: source.source_space_id,
                        path: source.source_path,
                    },
                ));
            }
        }
        let mut written = Vec::new();
        for (source_abs, content, updated, _) in &planned {
            if let Err(error) = std::fs::write(source_abs, updated) {
                for (written_path, original) in written {
                    let _ = std::fs::write(written_path, original);
                }
                return Err(AppError::Io(error));
            }
            written.push((source_abs, content));
        }
        let modified = planned
            .into_iter()
            .map(|(_, _, _, source)| source)
            .collect::<Vec<_>>();
        for item in &modified {
            let source_dir = self
                .space_path_of(project, item.space_id.as_deref())
                .await?;
            if let Err(error) = crate::index::update::publish_managed_path(
                self,
                updates,
                project,
                &source_dir.join(&item.path),
            )
            .await
            {
                tracing::warn!("failed to update rewritten folder backlink source index: {error}");
            }
        }
        Ok(modified)
    }

    pub async fn rebase_source_links_project(
        &self,
        project: &Path,
        source_space_id: Option<&str>,
        old_path: &str,
        new_path: &str,
    ) -> Result<Option<ModifiedLinkSource>, AppError> {
        let source_dir = self.space_path_of(project, source_space_id).await?;
        let old_abs = source_dir.join(old_path);
        let new_abs = source_dir.join(new_path);
        if !new_abs.exists() {
            return Ok(None);
        }

        let content = std::fs::read_to_string(&new_abs)?;
        let updated = rebase_source_links_between(&content, &old_abs, &new_abs);
        if updated == content {
            return Ok(None);
        }

        std::fs::write(&new_abs, updated)?;
        self.update_file_backlinks(project, source_space_id, new_path)
            .await?;
        Ok(Some(ModifiedLinkSource {
            space_id: source_space_id.map(ToString::to_string),
            path: normalize_rel(new_path),
        }))
    }

    /// Get (or create) the per-key reindex serialization lock.
    pub async fn reindex_lock(&self, key: &IndexKey) -> Arc<Mutex<()>> {
        self.core.reindex_lock(key).await
    }

    /// Get (or create) the per-key `reindex_active` flag. Read-only check
    /// surface for `fan_out`; writers go through `run_full_reindex`.
    pub async fn reindex_active_flag(&self, key: &IndexKey) -> Arc<AtomicBool> {
        self.core.reindex_active_flag(key).await
    }

    pub async fn reconcile_active_flag(&self, key: &IndexKey) -> Arc<AtomicBool> {
        self.core.reconcile_active_flag(key).await
    }

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
    pub(crate) async fn existing_pool(&self, key: &IndexKey) -> Option<SqlitePool> {
        self.core.existing_pool(key).await
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
        self.core.close_key(key).await;
        self.close_key_runtime(key).await;
    }

    async fn close_key_runtime(&self, key: &IndexKey) {
        self.backlinks.lock().await.remove(key);
        self.lfs_states.lock().await.remove(key);
    }

    /// Open root + all ready child-space pools for `project` and return the
    /// prepared keys to the Desktop runtime that owns background tasks.
    pub async fn open_project(&self, project: &Path) -> Result<Vec<IndexKey>, AppError> {
        let cfg = config::read_space_config(project)?;
        let cache = project_spaces_cache_from_config(project, &cfg);
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
    pub async fn skip_folders_for(&self, key: &IndexKey) -> Vec<String> {
        self.core.skip_folders_for(key).await
    }

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
            .then(|| read_child_space_name(&project.join(folder_name), folder_name));
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
                .map(|folder| read_child_space_name(&project.join(&folder), &folder))
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
        let cfg = config::read_space_config(project)?;
        let fresh = project_spaces_cache_from_config(project, &cfg);

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

    pub(crate) async fn routine_inventory_keys(
        &self,
        project: &Path,
    ) -> Result<Vec<IndexKey>, AppError> {
        Ok(self.core.routine_inventory_keys(project).await?)
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

    #[tokio::test]
    async fn rebase_source_links_project_rewrites_content_and_backlink_source() {
        let tmp = TempDir::new().unwrap();
        let project = tmp.path();
        fs::create_dir_all(project.join(".svode")).unwrap();
        fs::write(project.join("A.md"), "See [B](B.md).\n").unwrap();
        fs::write(project.join("B.md"), "Target.\n").unwrap();

        let state = IndexState::new();
        state
            .update_file_backlinks(project, None, "A.md")
            .await
            .unwrap();
        let root_key = IndexKey::Root(project.to_path_buf());
        let target_index = state.backlinks_for(&root_key).await;
        assert_eq!(target_index.get_backlinks("B.md")[0].source_path, "A.md");

        fs::create_dir_all(project.join("Folder")).unwrap();
        fs::rename(project.join("A.md"), project.join("Folder").join("A.md")).unwrap();
        state
            .remove_file_backlinks(project, None, "A.md")
            .await
            .unwrap();

        let modified = state
            .rebase_source_links_project(project, None, "A.md", "Folder/A.md")
            .await
            .unwrap()
            .unwrap();

        assert_eq!(modified.path, "Folder/A.md");
        assert_eq!(
            fs::read_to_string(project.join("Folder").join("A.md")).unwrap(),
            "See [B](../B.md).\n"
        );
        let backlinks = target_index.get_backlinks("B.md");
        assert_eq!(backlinks.len(), 1);
        assert_eq!(backlinks[0].source_path, "Folder/A.md");
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
            search::search_fts(&root_pool, "root-token", None, None, 10)
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(
            search::search_fts(&root_pool, "child-token", None, None, 10)
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            search::search_fts(&child_pool, "child-token", None, None, 10)
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(
            search::search_fts(&child_pool, "root-token", None, None, 10)
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

    #[tokio::test]
    async fn folder_rename_project_rewrites_descendant_target_links() {
        let tmp = TempDir::new().unwrap();
        let project = tmp.path();
        fs::create_dir_all(project.join(".svode")).unwrap();
        fs::create_dir_all(project.join("Docs")).unwrap();
        fs::create_dir_all(project.join("Folder").join("Sub")).unwrap();
        fs::write(
            project.join("Docs").join("Source.md"),
            "See [Target](../Folder/Sub/Target.md).\n",
        )
        .unwrap();
        fs::write(
            project.join("Folder").join("Sub").join("Target.md"),
            "Target.\n",
        )
        .unwrap();

        let state = IndexState::new();
        let root_key = IndexKey::Root(project.to_path_buf());
        state
            .update_file_backlinks(project, None, "Docs/Source.md")
            .await
            .unwrap();
        state.backlinks_for(&root_key).await.mark_built();

        fs::rename(project.join("Folder"), project.join("Archive")).unwrap();
        let modified = state
            .update_links_on_folder_rename_project(
                update::test_update_state(),
                project,
                None,
                "Folder",
                "Archive",
                None,
            )
            .await
            .unwrap();

        assert_eq!(modified.len(), 1);
        assert_eq!(modified[0].path, "Docs/Source.md");
        assert_eq!(
            fs::read_to_string(project.join("Docs").join("Source.md")).unwrap(),
            "See [Target](../Archive/Sub/Target.md).\n"
        );
        let target_index = state.backlinks_for(&root_key).await;
        assert!(
            target_index
                .get_backlinks("Folder/Sub/Target.md")
                .is_empty()
        );
        let backlinks = target_index.get_backlinks("Archive/Sub/Target.md");
        assert_eq!(backlinks.len(), 1);
        assert_eq!(backlinks[0].source_path, "Docs/Source.md");
    }
}

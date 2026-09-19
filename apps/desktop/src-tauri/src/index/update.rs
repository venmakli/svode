use sqlx::SqlitePool;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use crate::error::AppError;
use crate::git::dates::derive_date_overrides;
use crate::index::normalize_rel_result;
use crate::index::reindex::{build_entry_with_dates, markdown_projection, markdown_source_record};
use crate::index::{IndexKey, IndexState, ReindexActiveGuard};
use crate::routines::{CollectionEventOrigin, RoutineStoreState};
use svode_core::content_tree::policy::TreeIgnorePolicy;

#[derive(Clone)]
pub struct IndexUpdateState {
    core: svode_core::index::update::IndexUpdateState,
}

#[cfg(test)]
pub(crate) fn test_update_state() -> &'static IndexUpdateState {
    use std::sync::OnceLock;

    static STATE: OnceLock<IndexUpdateState> = OnceLock::new();
    STATE.get_or_init(|| IndexUpdateState::new(Arc::new(RoutineStoreState::new())))
}

impl IndexUpdateState {
    pub fn new(routine_stores: Arc<RoutineStoreState>) -> Self {
        Self {
            core: svode_core::index::update::IndexUpdateState::new(routine_stores.core_handle()),
        }
    }

    pub(crate) fn core(&self) -> &svode_core::index::update::IndexUpdateState {
        &self.core
    }

    pub(crate) async fn routines_pool(
        &self,
        index_state: &IndexState,
        key: &IndexKey,
    ) -> Result<SqlitePool, AppError> {
        Ok(self.core.routines_pool(&index_state.core, key).await?)
    }

    pub(crate) async fn sync_routine_projection(
        &self,
        index_state: &IndexState,
        key: &IndexKey,
    ) -> Result<(), AppError> {
        Ok(self
            .core
            .sync_routine_projection(&index_state.core, key)
            .await?)
    }

    pub async fn run_reconciliation(
        &self,
        index_state: &IndexState,
        key: &IndexKey,
    ) -> Result<(), AppError> {
        let flag = index_state.reconcile_active_flag(key).await;
        flag.store(true, Ordering::SeqCst);
        let _flag_guard = ReindexActiveGuard(flag);
        for _ in 0..3 {
            match crate::index::reconcile::reconcile_pool(index_state, key).await? {
                crate::index::reconcile::ReconcileOutcome::Applied => {
                    self.sync_routine_projection(index_state, key).await?;
                    return Ok(());
                }
                crate::index::reconcile::ReconcileOutcome::Retry => continue,
                crate::index::reconcile::ReconcileOutcome::Rebuild => {
                    return self.run_full_reindex(index_state, key).await;
                }
            }
        }
        Err(AppError::Index(format!(
            "source manifest kept changing during reconciliation for {key:?}"
        )))
    }

    pub async fn run_full_reindex(
        &self,
        index_state: &IndexState,
        key: &IndexKey,
    ) -> Result<(), AppError> {
        let cli = crate::git::dates::detected_cli();
        Ok(self
            .core
            .repair_space(&index_state.core, key, cli.as_ref())
            .await?)
    }
}

#[cfg(test)]
pub async fn update_entry(
    state: &IndexState,
    project: &Path,
    abs_path: &Path,
) -> Result<(), AppError> {
    let cli = crate::git::dates::detected_cli();
    Ok(svode_core::index::update::update_path_with_origin(
        &state.core,
        test_update_state().core(),
        cli.as_ref(),
        project,
        abs_path,
        CollectionEventOrigin::managed(),
    )
    .await?)
}

pub async fn publish_managed_path(
    state: &IndexState,
    updates: &IndexUpdateState,
    project: &Path,
    abs_path: &Path,
) -> Result<(), AppError> {
    publish_path_with_origin(
        state,
        updates,
        project,
        abs_path,
        CollectionEventOrigin::managed(),
    )
    .await
}

pub(crate) async fn publish_path_with_origin(
    state: &IndexState,
    updates: &IndexUpdateState,
    project: &Path,
    abs_path: &Path,
    origin: CollectionEventOrigin,
) -> Result<(), AppError> {
    let cli = crate::git::dates::detected_cli();
    Ok(svode_core::index::update::publish_path_with_origin(
        &state.core,
        &updates.core,
        cli.as_ref(),
        project,
        abs_path,
        origin,
    )
    .await?)
}

/// Publish managed paths in the Project runtime, repairing the owning Space
/// pool when there is no Project or a targeted update fails.
pub(crate) async fn publish_paths_or_repair(
    state: &IndexState,
    updates: &IndexUpdateState,
    project_path: Option<&str>,
    space: &str,
    paths: Vec<std::path::PathBuf>,
    context: &str,
) -> Vec<String> {
    let cli = crate::git::dates::detected_cli();
    svode_core::index::update::publish_paths_or_repair(
        &state.core,
        &updates.core,
        cli.as_ref(),
        project_path,
        space,
        paths,
        context,
    )
    .await
}

pub(crate) async fn publish_tree_or_repair(
    state: &IndexState,
    updates: &IndexUpdateState,
    project_path: Option<&str>,
    space: &str,
    rel_root: &str,
    context: &str,
) {
    let cli = crate::git::dates::detected_cli();
    svode_core::index::update::publish_tree_or_repair(
        &state.core,
        &updates.core,
        cli.as_ref(),
        project_path,
        space,
        rel_root,
        context,
    )
    .await
}

pub(crate) async fn repair_space_dir(state: &IndexState, updates: &IndexUpdateState, space: &str) {
    let cli = crate::git::dates::detected_cli();
    svode_core::index::update::repair_space_dir(&state.core, &updates.core, cli.as_ref(), space)
        .await
}

/// Incrementally delete the entry for a single absolute path. Resolves to
/// the owning pool and deletes by relative path.
#[cfg(test)]
pub async fn delete_entry(
    state: &IndexState,
    project: &Path,
    abs_path: &Path,
) -> Result<(), AppError> {
    let (key, rel_path) = state.resolve(project, abs_path).await?;
    let pool = state.get_or_create(&key).await?;
    let routines_pool = test_update_state().routines_pool(state, &key).await?;
    let lock = state.reindex_lock(&key).await;
    let _guard = lock.lock().await;
    Ok(svode_core::index::update::apply_targeted_source_change(
        &pool,
        &routines_pool,
        &key,
        &state.dir_for_key(&key).await?,
        &rel_path,
        None,
        None,
        false,
        &CollectionEventOrigin::managed(),
    )
    .await?)
}

/// Refresh only the normalized project Agent Context rows for an already-open
/// owning pool. This is a write-path hook for the existing watcher invalidation
/// seam; graph/search reads never call it.
pub async fn refresh_agent_context_projection(
    state: &IndexState,
    space_dir: &Path,
) -> Result<(), AppError> {
    svode_core::index::update::refresh_agent_context_projection(&state.core, space_dir).await?;
    Ok(())
}

/// Apply a batch of file changes reported by a git pull. The `key` identifies
/// the pool that owns these files (the pool whose repo was just pulled). All
/// paths in `changed_files` are relative to that pool's root.
pub async fn reindex_after_pull(
    state: &IndexState,
    updates: &IndexUpdateState,
    key: &IndexKey,
    changed_files: Vec<String>,
) -> Result<(), AppError> {
    let pool = state.get_or_create(key).await?;
    let routines_pool = updates.routines_pool(state, key).await?;
    let dir = state.dir_for_key(key).await?;
    let lock = state.reindex_lock(key).await;
    let _guard = lock.lock().await;

    let schema_changed = changed_files.iter().any(|rel| {
        Path::new(rel)
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name == "schema.yaml")
    });
    let visibility_policy_changed = changed_files.iter().any(|rel| {
        matches!(
            rel.replace('\\', "/").as_str(),
            ".gitignore" | ".svode/config.json"
        )
    });

    let changed_md_paths = changed_files
        .iter()
        .filter_map(|rel| {
            let normalized = normalize_rel_result(rel).ok()?;
            let abs = dir.join(&normalized);
            let is_md = abs
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("md"))
                .unwrap_or(false);
            (abs.exists() && is_md).then_some(normalized)
        })
        .collect::<Vec<_>>();
    let backlink_paths = changed_files
        .iter()
        .filter_map(|path| {
            let normalized = normalize_rel_result(path).ok()?;
            Path::new(&normalized)
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
                .then_some(normalized)
        })
        .collect::<Vec<_>>();
    let date_overrides = derive_date_overrides(&dir, &changed_md_paths).await;
    let policy = TreeIgnorePolicy::from_space_root(&dir);

    for rel in changed_files {
        let normalized = normalize_rel_result(&rel)?;
        let abs = dir.join(&normalized);

        // Don't filter by extension — pull may have deleted .md files and we
        // still want to drop their rows. The branching mirrors update_entry.
        if !abs.exists() {
            if let Err(e) = svode_core::index::update::apply_targeted_source_change(
                &pool,
                &routines_pool,
                key,
                &dir,
                &normalized,
                None,
                None,
                false,
                &CollectionEventOrigin::git_sync(),
            )
            .await
            {
                tracing::warn!("failed to drop index row for {normalized}: {e}");
            }
            continue;
        }

        let metadata = match std::fs::symlink_metadata(&abs) {
            Ok(metadata) => metadata,
            Err(error) => {
                tracing::warn!("failed to inspect index source {normalized}: {error}");
                continue;
            }
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            if let Err(e) = svode_core::index::update::apply_targeted_source_change(
                &pool,
                &routines_pool,
                key,
                &dir,
                &normalized,
                None,
                None,
                false,
                &CollectionEventOrigin::git_sync(),
            )
            .await
            {
                tracing::warn!("failed to exclude unsafe index source {normalized}: {e}");
            }
            continue;
        }

        let is_md = abs
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("md"))
            .unwrap_or(false);
        if !is_md {
            if let Err(e) = svode_core::index::update::apply_targeted_source_change(
                &pool,
                &routines_pool,
                key,
                &dir,
                &normalized,
                None,
                None,
                false,
                &CollectionEventOrigin::git_sync(),
            )
            .await
            {
                tracing::warn!("failed to drop index row for {normalized}: {e}");
            }
            continue;
        }

        let projection = match markdown_projection(&dir, &abs, &policy) {
            Ok(Some(projection)) => projection,
            Ok(None) => {
                if let Err(e) = svode_core::index::update::apply_targeted_source_change(
                    &pool,
                    &routines_pool,
                    key,
                    &dir,
                    &normalized,
                    None,
                    None,
                    false,
                    &CollectionEventOrigin::git_sync(),
                )
                .await
                {
                    tracing::warn!("failed to exclude index source {normalized}: {e}");
                }
                continue;
            }
            Err(e) => {
                tracing::warn!("failed to classify index source {normalized}: {e}");
                continue;
            }
        };

        match markdown_source_record(&dir, &abs, projection) {
            Ok(record) if record.diagnostic_code.is_some() => {
                if let Err(e) = svode_core::index::update::apply_targeted_source_change(
                    &pool,
                    &routines_pool,
                    key,
                    &dir,
                    &normalized,
                    None,
                    Some(projection),
                    false,
                    &CollectionEventOrigin::git_sync(),
                )
                .await
                {
                    tracing::warn!("failed to exclude index source {normalized}: {e}");
                }
                continue;
            }
            Ok(_) => {}
            Err(e) => {
                tracing::warn!("failed to inspect index source {normalized}: {e}");
                continue;
            }
        }

        match build_entry_with_dates(&dir, &abs, date_overrides.get(&normalized), projection) {
            Ok(entry) => {
                if let Err(e) = svode_core::index::update::apply_targeted_source_change(
                    &pool,
                    &routines_pool,
                    key,
                    &dir,
                    &normalized,
                    Some(&entry),
                    Some(projection),
                    svode_core::index::update::markdown_frontmatter_diff_safe(&abs),
                    &CollectionEventOrigin::git_sync(),
                )
                .await
                {
                    tracing::warn!("failed to upsert index row for {normalized}: {e}");
                }
            }
            Err(e) => {
                tracing::warn!("failed to build index entry for {normalized}: {e}");
            }
        }
    }

    let space_id = IndexState::space_id_for_key(key);
    for relative in backlink_paths {
        let absolute = dir.join(&relative);
        let result = if absolute.is_file() {
            state
                .update_file_backlinks(key.project(), space_id.as_deref(), &relative)
                .await
        } else {
            state
                .remove_file_backlinks(key.project(), space_id.as_deref(), &relative)
                .await
        };
        if let Err(error) = result {
            tracing::warn!(path = %relative, "Git refresh backlink update failed: {error}");
        }
    }

    if schema_changed || visibility_policy_changed {
        drop(_guard);
        updates.run_full_reindex(state, key).await?;
        if visibility_policy_changed {
            state.invalidate_project_backlinks(key.project()).await;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::ProjectSpacesCache;
    use crate::space::config::write_space_config;
    use crate::space::types::{SpaceConfig, SpaceStatus, TreeSpaceConfig};
    use std::collections::HashMap;
    use svode_core::index::search::search_fts;
    use tempfile::TempDir;

    fn write_tree_config(space: &Path, exclude: &[&str], include: &[&str]) {
        write_space_config(
            space,
            &SpaceConfig {
                name: "Test".to_string(),
                description: String::new(),
                icon: "folder".to_string(),
                spaces: None,
                agent: None,
                defaults: None,
                git: None,
                assets: None,
                tree: Some(TreeSpaceConfig {
                    exclude: exclude.iter().map(|value| (*value).to_string()).collect(),
                    include: include.iter().map(|value| (*value).to_string()).collect(),
                    show_ignored_placeholders: false,
                }),
            },
        )
        .unwrap();
    }

    async fn insert_event_routine(
        pool: &SqlitePool,
        owner_path: &str,
        routine_id: &str,
        event: &str,
        matcher: Option<serde_json::Value>,
    ) {
        let mut trigger = serde_json::json!({ "type": "event", "event": event });
        if let Some(matcher) = matcher {
            trigger["match"] = matcher;
        }
        let row = serde_json::json!({
            "routineId": routine_id,
            "filename": format!("{routine_id}.md"),
            "path": format!("{owner_path}/.routines/{routine_id}.md"),
            "name": routine_id,
            "description": null,
            "enabled": true,
            "triggerType": "event",
            "triggerSummary": null,
            "actionType": "run_agent",
            "actionSummary": null,
            "executor": "agent:01arz3ndektsv4rrffq69g5fav",
            "lastRunAt": null,
            "nextRunAt": null,
            "fingerprint": format!("fingerprint:{routine_id}"),
            "executionFingerprint": format!("fingerprint:{routine_id}"),
            "definition": {
                "enabled": true,
                "trigger": trigger,
                "action": {
                    "type": "run_agent",
                    "executor": "agent:01arz3ndektsv4rrffq69g5fav"
                },
                "body": "Handle event"
            },
            "diagnostics": []
        });
        sqlx::query(
            "INSERT INTO routine_definitions (owner_path, routine_id, fingerprint, row_json, refreshed_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(owner_path)
        .bind(routine_id)
        .bind(format!("fingerprint:{routine_id}"))
        .bind(row.to_string())
        .bind("2026-08-08T00:00:00Z")
        .execute(pool)
        .await
        .unwrap();
    }

    async fn mark_routine_invalid(pool: &SqlitePool, owner_path: &str, routine_id: &str) {
        let raw: String = sqlx::query_scalar(
            "SELECT row_json FROM routine_definitions WHERE owner_path = ? AND routine_id = ?",
        )
        .bind(owner_path)
        .bind(routine_id)
        .fetch_one(pool)
        .await
        .unwrap();
        let mut row: serde_json::Value = serde_json::from_str(&raw).unwrap();
        row["diagnostics"] = serde_json::json!([{
            "code": "routine_invalid",
            "message": "invalid routine"
        }]);
        sqlx::query(
            "UPDATE routine_definitions SET row_json = ? WHERE owner_path = ? AND routine_id = ?",
        )
        .bind(row.to_string())
        .bind(owner_path)
        .bind(routine_id)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn set_automatic_events_enabled(
        _pool: &SqlitePool,
        project: &Path,
        owner_path: &str,
        enabled: bool,
    ) {
        let key = crate::routines::ResolvedRoutineOwner::indexed_collection_identity(
            &IndexKey::Root(project.to_path_buf()),
            owner_path,
        );
        crate::space::config::mutate_local_config(project, |local| {
            let routines = local.routines.get_or_insert_with(Default::default);
            if enabled {
                routines.automatic_authority.insert(key, true);
            } else {
                routines.automatic_authority.remove(&key);
            }
            Ok(())
        })
        .unwrap();
    }

    async fn indexed_pool(state: &IndexState, space: &Path) -> SqlitePool {
        state
            .get_or_create(&IndexKey::Root(space.to_path_buf()))
            .await
            .expect("index pool")
    }

    async fn routines_pool(state: &IndexState, space: &Path) -> SqlitePool {
        state
            .get_or_create_routines(&IndexKey::Root(space.to_path_buf()))
            .await
            .expect("routines pool")
    }

    async fn entry_index_flags(
        pool: &SqlitePool,
        path: &str,
    ) -> (String, Option<String>, i64, i64) {
        sqlx::query_as(
            "SELECT parent_path, collection_root_path, in_collection, is_entry_head \
             FROM entries WHERE file_path = ?",
        )
        .bind(path)
        .fetch_one(pool)
        .await
        .expect("entry flags")
    }

    #[tokio::test]
    async fn targeted_update_refreshes_fts_content() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path();
        let state = IndexState::new();
        let file = space.join("note.md");

        std::fs::write(&file, "alpha searchable body").unwrap();
        update_entry(&state, space, &file).await.unwrap();

        let pool = indexed_pool(&state, space).await;
        let alpha_rows = search_fts(&pool, "alpha", None, None, 10).await.unwrap();
        assert_eq!(alpha_rows.len(), 1);
        assert_eq!(alpha_rows[0].path, "note.md");

        std::fs::write(&file, "beta searchable body").unwrap();
        update_entry(&state, space, &file).await.unwrap();

        let alpha_rows = search_fts(&pool, "alpha", None, None, 10).await.unwrap();
        let beta_rows = search_fts(&pool, "beta", None, None, 10).await.unwrap();
        assert!(alpha_rows.is_empty());
        assert_eq!(beta_rows.len(), 1);
        assert_eq!(beta_rows[0].path, "note.md");
    }

    #[tokio::test]
    async fn targeted_delete_removes_entry_and_fts_row() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path();
        let state = IndexState::new();
        let file = space.join("obsolete.md");

        std::fs::write(&file, "stale searchable body").unwrap();
        update_entry(&state, space, &file).await.unwrap();

        let pool = indexed_pool(&state, space).await;
        let stale_rows = search_fts(&pool, "stale", None, None, 10).await.unwrap();
        assert_eq!(stale_rows.len(), 1);

        std::fs::remove_file(&file).unwrap();
        delete_entry(&state, space, &file).await.unwrap();

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM entries WHERE file_path = ?")
            .bind("obsolete.md")
            .fetch_one(&pool)
            .await
            .unwrap();
        let stale_rows = search_fts(&pool, "stale", None, None, 10).await.unwrap();
        assert_eq!(count, 0);
        assert!(stale_rows.is_empty());
    }

    #[tokio::test]
    async fn targeted_update_indexes_entry_flags_and_search_body() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path();
        let state = IndexState::new();
        let collection_dir = space.join("tasks");
        std::fs::create_dir_all(&collection_dir).unwrap();
        std::fs::write(
            collection_dir.join("schema.yaml"),
            "columns:\n  - name: Status\n    type: text\nviews: []\n",
        )
        .unwrap();
        let file = collection_dir.join("item.md");

        std::fs::write(
            &file,
            "---\ntitle: Indexed Task\nStatus: Open\n---\nneedle body",
        )
        .unwrap();
        update_entry(&state, space, &file).await.unwrap();

        let pool = indexed_pool(&state, space).await;
        assert_eq!(
            entry_index_flags(&pool, "tasks/item.md").await,
            ("tasks".to_string(), Some("tasks".to_string()), 1, 1)
        );
        let fields: String = sqlx::query_scalar("SELECT fields FROM entries WHERE file_path = ?")
            .bind("tasks/item.md")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&fields).unwrap()["Status"],
            "Open"
        );
        let hits = search_fts(&pool, "needle", None, None, 10).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "tasks/item.md");
    }

    #[tokio::test]
    async fn targeted_delete_path_removes_stale_renamed_entry_and_fts() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path();
        let state = IndexState::new();
        let old_file = space.join("Old.md");
        let new_file = space.join("New.md");

        std::fs::write(&old_file, "stale-rename-token").unwrap();
        update_entry(&state, space, &old_file).await.unwrap();
        std::fs::rename(&old_file, &new_file).unwrap();
        update_entry(&state, space, &new_file).await.unwrap();
        delete_entry(&state, space, &old_file).await.unwrap();

        let pool = indexed_pool(&state, space).await;
        let paths =
            sqlx::query_scalar::<_, String>("SELECT file_path FROM entries ORDER BY file_path")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(paths, vec!["New.md".to_string()]);
        let hits = search_fts(&pool, "stale-rename-token", None, None, 10)
            .await
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "New.md");
    }

    #[tokio::test]
    async fn targeted_replace_after_rename_removes_stale_entry_and_fts_row() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path();
        let state = IndexState::new();
        let old_file = space.join("old-name.md");
        let new_file = space.join("new-name.md");

        std::fs::write(&old_file, "oldtoken searchable body").unwrap();
        update_entry(&state, space, &old_file).await.unwrap();
        std::fs::rename(&old_file, &new_file).unwrap();
        std::fs::write(&new_file, "newtoken searchable body").unwrap();

        delete_entry(&state, space, &old_file).await.unwrap();
        update_entry(&state, space, &new_file).await.unwrap();

        let pool = indexed_pool(&state, space).await;
        let old_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM entries WHERE file_path = ?")
            .bind("old-name.md")
            .fetch_one(&pool)
            .await
            .unwrap();
        let new_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM entries WHERE file_path = ?")
            .bind("new-name.md")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(old_count, 0);
        assert_eq!(new_count, 1);
        assert!(
            search_fts(&pool, "oldtoken", None, None, 10)
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            search_fts(&pool, "newtoken", None, None, 10)
                .await
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn targeted_update_recomputes_collection_membership() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path();
        let state = IndexState::new();
        let collection_dir = space.join("tasks");
        std::fs::create_dir_all(&collection_dir).unwrap();
        let file = collection_dir.join("item.md");

        std::fs::write(&file, "task body").unwrap();
        update_entry(&state, space, &file).await.unwrap();

        let pool = indexed_pool(&state, space).await;
        let before: (Option<String>, i64, i64) = sqlx::query_as(
            "SELECT collection_root_path, in_collection, is_entry_head FROM entries WHERE file_path = ?",
        )
        .bind("tasks/item.md")
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(before, (None, 0, 1));

        std::fs::write(
            collection_dir.join("schema.yaml"),
            "columns: []\nviews: []\n",
        )
        .unwrap();
        update_entry(&state, space, &file).await.unwrap();

        let after: (Option<String>, i64, i64) = sqlx::query_as(
            "SELECT collection_root_path, in_collection, is_entry_head FROM entries WHERE file_path = ?",
        )
        .bind("tasks/item.md")
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(after, (Some("tasks".to_string()), 1, 1));
    }

    #[tokio::test]
    async fn df_088_targeted_update_changes_discoverability_without_collection_churn() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path();
        write_tree_config(space, &["hidden.md"], &[]);
        std::fs::write(
            space.join("schema.yaml"),
            "columns:\n  - { name: Status, type: text }\nviews: []\n",
        )
        .unwrap();
        let file = space.join("hidden.md");
        std::fs::write(
            &file,
            "---\ntitle: Hidden Needle\nStatus: Open\n---\nhidden-targeted-token [link](target.md)",
        )
        .unwrap();
        let state = IndexState::new();

        update_entry(&state, space, &file).await.unwrap();
        let pool = indexed_pool(&state, space).await;
        let hidden: (Option<String>, i64, i64, String, String) = sqlx::query_as(
            "SELECT collection_root_path,in_collection,is_discoverable,body_preview,fields \
             FROM entries WHERE file_path = 'hidden.md'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(hidden.0.as_deref(), Some("."));
        assert_eq!((hidden.1, hidden.2), (1, 0));
        assert!(hidden.3.is_empty());
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&hidden.4).unwrap()["Status"],
            "Open"
        );
        assert!(
            svode_core::index::search::search_by_title(&pool, "Hidden Needle", 10)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            search_fts(&pool, "hidden-targeted-token", None, None, 10)
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM knowledge_documents WHERE source_path = 'hidden.md'",
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            0
        );

        write_tree_config(space, &["hidden.md"], &["hidden.md"]);
        update_entry(&state, space, &file).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT is_discoverable FROM entries WHERE file_path = 'hidden.md'",
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            1
        );
        assert_eq!(
            svode_core::index::search::search_by_title(&pool, "Hidden Needle", 10)
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            search_fts(&pool, "hidden-targeted-token", None, None, 10)
                .await
                .unwrap()
                .len(),
            1
        );

        write_tree_config(space, &["hidden.md"], &[]);
        update_entry(&state, space, &file).await.unwrap();
        let final_row: (i64, i64, i64) = sqlx::query_as(
            "SELECT COUNT(*),MAX(in_collection),MAX(is_discoverable) FROM entries \
             WHERE file_path = 'hidden.md'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(final_row, (1, 1, 0));
        assert!(
            search_fts(&pool, "hidden-targeted-token", None, None, 10)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn df_087_targeted_update_excludes_root_owner_readme_from_direct_collection() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path();
        let state = IndexState::new();
        std::fs::write(space.join("schema.yaml"), "columns: []\nviews: []\n").unwrap();
        let owner = space.join("README.md");
        let child = space.join("child.md");
        std::fs::write(&owner, "# Owner").unwrap();
        std::fs::write(&child, "# Child").unwrap();

        update_entry(&state, space, &owner).await.unwrap();
        update_entry(&state, space, &child).await.unwrap();

        let pool = indexed_pool(&state, space).await;
        assert_eq!(
            entry_index_flags(&pool, "README.md").await,
            (".".to_string(), None, 0, 1)
        );
        assert_eq!(
            entry_index_flags(&pool, "child.md").await,
            (".".to_string(), Some(".".to_string()), 1, 1)
        );
        let routines = routines_pool(&state, space).await;
        let observed_paths = sqlx::query_scalar::<_, String>(
            "SELECT entry_path FROM routine_observation_baseline ORDER BY entry_path",
        )
        .fetch_all(&routines)
        .await
        .unwrap();
        assert_eq!(observed_paths, vec!["child.md"]);
    }

    #[tokio::test]
    async fn targeted_updates_do_not_leak_between_root_and_child_space_pools() {
        let tmp = TempDir::new().unwrap();
        let project = tmp.path();
        let child = project.join("child");
        std::fs::create_dir_all(project.join(".svode")).unwrap();
        std::fs::create_dir_all(child.join(".svode")).unwrap();
        std::fs::write(project.join("root.md"), "root searchable").unwrap();
        std::fs::write(child.join("child.md"), "child searchable").unwrap();

        let state = IndexState::new();
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

        update_entry(&state, project, &project.join("root.md"))
            .await
            .unwrap();
        update_entry(&state, project, &child.join("child.md"))
            .await
            .unwrap();

        let root_pool = state
            .get_or_create(&IndexKey::Root(project.to_path_buf()))
            .await
            .unwrap();
        let child_key = IndexKey::Space {
            project: project.to_path_buf(),
            space_id: "child-space".to_string(),
        };
        let child_pool = state.get_or_create(&child_key).await.unwrap();

        let root_paths =
            sqlx::query_scalar::<_, String>("SELECT file_path FROM entries ORDER BY file_path")
                .fetch_all(&root_pool)
                .await
                .unwrap();
        let child_paths =
            sqlx::query_scalar::<_, String>("SELECT file_path FROM entries ORDER BY file_path")
                .fetch_all(&child_pool)
                .await
                .unwrap();

        assert_eq!(root_paths, vec!["root.md".to_string()]);
        assert_eq!(child_paths, vec!["child.md".to_string()]);
        assert!(
            search_fts(&root_pool, "child", None, None, 10)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            search_fts(&child_pool, "root", None, None, 10)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn managed_publication_keeps_backlinks_in_sync_with_source_changes() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path();
        let source = space.join("Source.md");
        let target = space.join("Target.md");
        std::fs::write(&target, "# Target\n").unwrap();
        std::fs::write(&source, "See [target](Target.md).\n").unwrap();

        let state = IndexState::new();
        publish_managed_path(&state, test_update_state(), space, &target)
            .await
            .unwrap();
        publish_managed_path(&state, test_update_state(), space, &source)
            .await
            .unwrap();

        let key = IndexKey::Root(space.to_path_buf());
        let backlinks = state.backlinks_for(&key).await;
        assert_eq!(backlinks.get_backlinks("Target.md").len(), 1);
        assert_eq!(
            backlinks.get_backlinks("Target.md")[0].source_path,
            "Source.md"
        );

        std::fs::write(&source, "Link removed.\n").unwrap();
        publish_managed_path(&state, test_update_state(), space, &source)
            .await
            .unwrap();
        assert!(backlinks.get_backlinks("Target.md").is_empty());

        std::fs::remove_file(&source).unwrap();
        publish_managed_path(&state, test_update_state(), space, &source)
            .await
            .unwrap();
        assert!(backlinks.get_backlinks("Target.md").is_empty());
    }

    #[tokio::test]
    async fn targeted_collection_diff_queues_matched_events_once_and_survives_restart() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path();
        let collection = space.join("tasks");
        std::fs::create_dir_all(&collection).unwrap();
        std::fs::write(
            collection.join("schema.yaml"),
            "columns:\n  - { name: Status, type: text }\n  - { name: Priority, type: number }\nviews: []\n",
        )
        .unwrap();
        let file = collection.join("item.md");
        std::fs::write(
            &file,
            "---\ntitle: Item\nStatus: Open\nPriority: 1\n---\nBody\n",
        )
        .unwrap();

        let state = IndexState::new();
        let routines_pool = routines_pool(&state, space).await;
        state
            .run_full_reindex(&IndexKey::Root(space.to_path_buf()))
            .await
            .unwrap();
        set_automatic_events_enabled(&routines_pool, space, "tasks", true).await;
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM routine_event_queue")
                .fetch_one(&routines_pool)
                .await
                .unwrap(),
            0
        );
        insert_event_routine(
            &routines_pool,
            "tasks",
            "status-done",
            "collection.field_changed",
            Some(serde_json::json!({ "field": "Status", "from": "Open", "to": "Done" })),
        )
        .await;
        insert_event_routine(
            &routines_pool,
            "tasks",
            "invalid-status-done",
            "collection.field_changed",
            Some(serde_json::json!({ "field": "Status", "from": "Open", "to": "Done" })),
        )
        .await;
        mark_routine_invalid(&routines_pool, "tasks", "invalid-status-done").await;
        insert_event_routine(
            &routines_pool,
            "tasks",
            "priority-only",
            "collection.field_changed",
            Some(serde_json::json!({ "field": "Priority" })),
        )
        .await;

        std::fs::write(
            &file,
            "---\ntitle: Item\nStatus: Done\nPriority: 1\nUnmodeled: changed\n---\nBody\n",
        )
        .unwrap();
        svode_core::index::update::update_path_with_origin(
            &state.core,
            test_update_state().core(),
            crate::git::dates::detected_cli().as_ref(),
            space,
            &file,
            CollectionEventOrigin::watcher(),
        )
        .await
        .unwrap();
        svode_core::index::update::update_path_with_origin(
            &state.core,
            test_update_state().core(),
            crate::git::dates::detected_cli().as_ref(),
            space,
            &file,
            CollectionEventOrigin::watcher(),
        )
        .await
        .unwrap();

        let queued: (i64, String, String, String) = sqlx::query_as(
            "SELECT COUNT(*), routine_id, property_key, payload_json FROM routine_event_queue",
        )
        .fetch_one(&routines_pool)
        .await
        .unwrap();
        assert_eq!(queued.0, 1);
        assert_eq!(queued.1, "status-done");
        assert_eq!(queued.2, "Status");
        let payload: serde_json::Value = serde_json::from_str(&queued.3).unwrap();
        assert_eq!(payload["oldValue"], "Open");
        assert_eq!(payload["newValue"], "Done");
        assert_eq!(payload["sourceKind"], "watcher");

        let queue_key: String =
            sqlx::query_scalar("SELECT queue_key FROM routine_event_queue LIMIT 1")
                .fetch_one(&routines_pool)
                .await
                .unwrap();
        assert!(!queue_key.is_empty());
        let (_, _, db_path): (i64, String, String) = sqlx::query_as("PRAGMA database_list")
            .fetch_one(&routines_pool)
            .await
            .unwrap();
        routines_pool.close().await;
        let reopened = svode_core::routines::storage::reopen_current_pool(Path::new(&db_path))
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT queue_key FROM routine_event_queue LIMIT 1")
                .fetch_one(&reopened)
                .await
                .unwrap(),
            queue_key
        );
    }

    #[tokio::test]
    async fn git_sync_preserves_changed_entry_events_when_schema_also_changed() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path();
        let collection = space.join("tasks");
        std::fs::create_dir_all(&collection).unwrap();
        std::fs::write(
            collection.join("schema.yaml"),
            "columns:\n  - { name: Status, type: text }\nviews: []\n",
        )
        .unwrap();
        let file = collection.join("item.md");
        std::fs::write(&file, "---\ntitle: Item\nStatus: Open\n---\nBody\n").unwrap();

        let state = IndexState::new();
        let key = IndexKey::Root(space.to_path_buf());
        let routines_pool = routines_pool(&state, space).await;
        state.run_full_reindex(&key).await.unwrap();
        set_automatic_events_enabled(&routines_pool, space, "tasks", true).await;
        insert_event_routine(
            &routines_pool,
            "tasks",
            "status-done",
            "collection.field_changed",
            Some(serde_json::json!({ "field": "Status", "to": "Done" })),
        )
        .await;

        std::fs::write(
            collection.join("schema.yaml"),
            "columns:\n  - { name: Status, type: text }\n  - { name: Priority, type: number }\nviews: []\n",
        )
        .unwrap();
        std::fs::write(
            &file,
            "---\ntitle: Item\nStatus: Done\nPriority: 1\n---\nBody\n",
        )
        .unwrap();

        reindex_after_pull(
            &state,
            test_update_state(),
            &key,
            vec!["tasks/schema.yaml".to_string(), "tasks/item.md".to_string()],
        )
        .await
        .unwrap();

        let payload: String = sqlx::query_scalar(
            "SELECT payload_json FROM routine_event_queue WHERE routine_id = 'status-done'",
        )
        .fetch_one(&routines_pool)
        .await
        .unwrap();
        let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(payload["oldValue"], "Open");
        assert_eq!(payload["newValue"], "Done");
        assert_eq!(payload["sourceKind"], "git_sync");
    }

    #[tokio::test]
    async fn git_refresh_keeps_backlinks_in_sync_for_targeted_markdown_changes() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path();
        let source = space.join("Source.md");
        std::fs::write(space.join("Old.md"), "# Old\n").unwrap();
        std::fs::write(space.join("New.md"), "# New\n").unwrap();
        std::fs::write(&source, "See [old](Old.md).\n").unwrap();

        let state = IndexState::new();
        let key = IndexKey::Root(space.to_path_buf());
        test_update_state()
            .run_full_reindex(&state, &key)
            .await
            .unwrap();
        let backlinks = state.backlinks_for(&key).await;
        assert_eq!(backlinks.get_backlinks("Old.md").len(), 1);

        std::fs::write(&source, "See [new](New.md).\n").unwrap();
        reindex_after_pull(
            &state,
            test_update_state(),
            &key,
            vec!["Source.md".to_string()],
        )
        .await
        .unwrap();

        assert!(backlinks.get_backlinks("Old.md").is_empty());
        assert_eq!(backlinks.get_backlinks("New.md").len(), 1);
    }

    #[tokio::test]
    async fn disabled_automatic_consent_updates_index_without_queueing_events() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path();
        let collection = space.join("tasks");
        std::fs::create_dir_all(&collection).unwrap();
        std::fs::write(
            collection.join("schema.yaml"),
            "columns:\n  - { name: Status, type: text }\nviews: []\n",
        )
        .unwrap();
        let state = IndexState::new();
        let pool = indexed_pool(&state, space).await;
        let routines_pool = routines_pool(&state, space).await;
        set_automatic_events_enabled(&routines_pool, space, "tasks", false).await;
        insert_event_routine(
            &routines_pool,
            "tasks",
            "created",
            "collection.entry_created",
            None,
        )
        .await;

        let file = collection.join("item.md");
        std::fs::write(&file, "---\ntitle: Item\nStatus: Open\n---\nBody\n").unwrap();
        update_entry(&state, space, &file).await.unwrap();

        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM routine_event_queue")
                .fetch_one(&routines_pool)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM entries WHERE file_path = ?")
                .bind("tasks/item.md")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn collection_events_use_exact_owner_authority_without_sibling_fallback() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path();
        for owner_path in ["tasks", "notes"] {
            let collection = space.join(owner_path);
            std::fs::create_dir_all(&collection).unwrap();
            std::fs::write(
                collection.join("schema.yaml"),
                "columns:\n  - { name: Status, type: text }\nviews: []\n",
            )
            .unwrap();
        }
        let state = IndexState::new();
        let pool = indexed_pool(&state, space).await;
        let routines_pool = routines_pool(&state, space).await;
        set_automatic_events_enabled(&routines_pool, space, "tasks", true).await;
        insert_event_routine(
            &routines_pool,
            "tasks",
            "tasks-created",
            "collection.entry_created",
            None,
        )
        .await;
        insert_event_routine(
            &routines_pool,
            "notes",
            "notes-created",
            "collection.entry_created",
            None,
        )
        .await;

        let tasks_entry = space.join("tasks/item.md");
        let notes_entry = space.join("notes/item.md");
        std::fs::write(&tasks_entry, "---\ntitle: Task\nStatus: Open\n---\n").unwrap();
        std::fs::write(&notes_entry, "---\ntitle: Note\nStatus: Open\n---\n").unwrap();
        update_entry(&state, space, &tasks_entry).await.unwrap();
        update_entry(&state, space, &notes_entry).await.unwrap();

        let queued = sqlx::query_scalar::<_, String>(
            "SELECT routine_id FROM routine_event_queue ORDER BY routine_id",
        )
        .fetch_all(&routines_pool)
        .await
        .unwrap();
        assert_eq!(queued, vec!["tasks-created"]);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM entries")
                .fetch_one(&pool)
                .await
                .unwrap(),
            2
        );
    }

    #[tokio::test]
    async fn authority_read_failure_updates_index_without_queueing_or_deleting_pending_rows() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path();
        let collection = space.join("tasks");
        std::fs::create_dir_all(&collection).unwrap();
        std::fs::write(
            collection.join("schema.yaml"),
            "columns:\n  - { name: Status, type: text }\nviews: []\n",
        )
        .unwrap();
        let state = IndexState::new();
        let pool = indexed_pool(&state, space).await;
        let routines_pool = routines_pool(&state, space).await;
        insert_event_routine(
            &routines_pool,
            "tasks",
            "created",
            "collection.entry_created",
            None,
        )
        .await;
        sqlx::query("INSERT INTO routine_event_queue (queue_key, event_key, owner_path, routine_id, definition_fingerprint, event_type, entry_path, payload_json, observed_at, state) VALUES ('existing', 'existing', 'tasks', 'created', 'fingerprint:created', 'collection.entry_created', 'tasks/old.md', '{}', '2026-08-08T00:00:00Z', 'pending')")
            .execute(&routines_pool)
            .await
            .unwrap();
        std::fs::write(space.join(".svode/local.json"), "not-json").unwrap();

        let file = collection.join("item.md");
        std::fs::write(&file, "---\ntitle: Item\nStatus: Open\n---\n").unwrap();
        update_entry(&state, space, &file).await.unwrap();

        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM routine_event_queue")
                .fetch_one(&routines_pool)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM entries WHERE file_path = 'tasks/item.md'",
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn collection_create_delete_and_malformed_frontmatter_follow_event_contract() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path();
        let collection = space.join("tasks");
        std::fs::create_dir_all(&collection).unwrap();
        std::fs::write(
            collection.join("schema.yaml"),
            "columns:\n  - { name: Status, type: text }\nviews: []\n",
        )
        .unwrap();
        let state = IndexState::new();
        let routines_pool = routines_pool(&state, space).await;
        set_automatic_events_enabled(&routines_pool, space, "tasks", true).await;
        insert_event_routine(
            &routines_pool,
            "tasks",
            "created",
            "collection.entry_created",
            None,
        )
        .await;
        insert_event_routine(
            &routines_pool,
            "tasks",
            "changed",
            "collection.field_changed",
            Some(serde_json::json!({ "field": "Status" })),
        )
        .await;
        insert_event_routine(
            &routines_pool,
            "tasks",
            "deleted",
            "collection.entry_deleted",
            None,
        )
        .await;

        let file = collection.join("item.md");
        std::fs::write(&file, "---\ntitle: Item\nStatus: Open\n---\nBody\n").unwrap();
        update_entry(&state, space, &file).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM routine_event_queue")
                .fetch_one(&routines_pool)
                .await
                .unwrap(),
            1
        );
        let created_payload: String = sqlx::query_scalar(
            "SELECT payload_json FROM routine_event_queue WHERE event_type = 'collection.entry_created'",
        )
        .fetch_one(&routines_pool)
        .await
        .unwrap();
        let created_payload: serde_json::Value = serde_json::from_str(&created_payload).unwrap();
        assert_eq!(created_payload["sourceKind"], "managed");
        assert_eq!(created_payload["origin"], "managed");

        std::fs::write(&file, "---\ntitle: [broken\n---\nBody\n").unwrap();
        svode_core::index::update::update_path_with_origin(
            &state.core,
            test_update_state().core(),
            crate::git::dates::detected_cli().as_ref(),
            space,
            &file,
            CollectionEventOrigin::watcher(),
        )
        .await
        .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM routine_event_queue")
                .fetch_one(&routines_pool)
                .await
                .unwrap(),
            1
        );

        std::fs::remove_file(&file).unwrap();
        svode_core::index::update::update_path_with_origin(
            &state.core,
            test_update_state().core(),
            crate::git::dates::detected_cli().as_ref(),
            space,
            &file,
            CollectionEventOrigin::git_sync(),
        )
        .await
        .unwrap();
        let payload: String = sqlx::query_scalar(
            "SELECT payload_json FROM routine_event_queue WHERE event_type = 'collection.entry_deleted'",
        )
        .fetch_one(&routines_pool)
        .await
        .unwrap();
        let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(payload["oldEntry"]["entryPath"], "tasks/item.md");
        assert_eq!(payload["sourceKind"], "git_sync");
    }
}

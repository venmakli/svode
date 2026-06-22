use sqlx::SqlitePool;
use std::path::Path;

use crate::error::AppError;
use crate::git::dates::derive_date_overrides;
use crate::index::normalize_rel_result;
use crate::index::reindex::{build_entry_with_dates, full_reindex, upsert_entry};
use crate::index::{IndexKey, IndexState};

/// Verify that an absolute path resolves inside the space root, guarding
/// against `..` traversal in user-supplied relative paths. If either side
/// fails to canonicalize, the check is skipped — the caller is expected to
/// have already established that `abs_path` exists, and a non-canonicalizable
/// `space_dir` means we have bigger problems.
fn ensure_inside_space(space_dir: &Path, abs_path: &Path) -> Result<(), AppError> {
    let (Ok(canon_abs), Ok(canon_root)) = (abs_path.canonicalize(), space_dir.canonicalize())
    else {
        return Ok(());
    };
    if !canon_abs.starts_with(&canon_root) {
        return Err(AppError::Index(format!(
            "path escapes space root: {}",
            abs_path.display()
        )));
    }
    Ok(())
}

/// Incrementally update the index for a single absolute path.
///
/// Resolves the path to its owning pool through `IndexState`, then upserts or
/// deletes relative to the owning space's root.
///
/// - If the file no longer exists on disk → delete the row.
/// - If the file exists but isn't a markdown file → also delete (e.g. user
///   renamed `foo.md` → `foo.txt`, leaving a stale entry).
/// - Otherwise → upsert.
pub async fn update_entry(
    state: &IndexState,
    project: &Path,
    abs_path: &Path,
) -> Result<(), AppError> {
    let (key, rel_path) = state.resolve(project, abs_path).await?;
    let dir = state.dir_for_key(&key).await?;
    let pool = state.get_or_create(&key).await?;

    let normalized = normalize_rel_result(&rel_path)?;
    let abs = dir.join(&normalized);

    // Serialize against `full_reindex` for the same pool. Without this, an
    // UPSERT can land between full_reindex's FS walk and its DELETE-then-INSERT
    // transaction, where it is silently overwritten (Stage 3.5 Phase 5 §5.3).
    let lock = state.reindex_lock(&key).await;
    let _guard = lock.lock().await;

    if !abs.exists() {
        return delete_entry_path(&pool, &normalized).await;
    }

    ensure_inside_space(&dir, &abs)?;

    let is_md = abs
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("md"))
        .unwrap_or(false);
    if !is_md {
        tracing::debug!("non-md file in update_entry, removing any stale row: {normalized}");
        return delete_entry_path(&pool, &normalized).await;
    }

    let date_overrides = derive_date_overrides(&dir, std::slice::from_ref(&normalized)).await;
    let entry = build_entry_with_dates(&dir, &abs, date_overrides.get(&normalized))?;
    upsert_entry(&pool, &entry).await?;
    Ok(())
}

/// Incrementally delete the entry for a single absolute path. Resolves to
/// the owning pool and deletes by relative path.
pub async fn delete_entry(
    state: &IndexState,
    project: &Path,
    abs_path: &Path,
) -> Result<(), AppError> {
    let (key, rel_path) = state.resolve(project, abs_path).await?;
    let pool = state.get_or_create(&key).await?;
    let lock = state.reindex_lock(&key).await;
    let _guard = lock.lock().await;
    delete_entry_path(&pool, &rel_path).await
}

/// Delete an entry row by its relative path inside an already-resolved pool.
pub async fn delete_entry_path(pool: &SqlitePool, rel_path: &str) -> Result<(), AppError> {
    let normalized = normalize_rel_result(rel_path)?;
    sqlx::query("DELETE FROM entries WHERE file_path = ?")
        .bind(&normalized)
        .execute(pool)
        .await?;
    Ok(())
}

/// Apply a batch of file changes reported by a git pull. The `key` identifies
/// the pool that owns these files (the pool whose repo was just pulled). All
/// paths in `changed_files` are relative to that pool's root.
pub async fn reindex_after_pull(
    state: &IndexState,
    key: &IndexKey,
    changed_files: Vec<String>,
) -> Result<(), AppError> {
    let pool = state.get_or_create(key).await?;
    let dir = state.dir_for_key(key).await?;
    let lock = state.reindex_lock(key).await;
    let _guard = lock.lock().await;

    if changed_files.iter().any(|rel| {
        Path::new(rel)
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name == "schema.yaml")
    }) {
        let skip = state.skip_folders_for(key).await;
        return full_reindex(&pool, &dir, &skip).await;
    }

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
    let date_overrides = derive_date_overrides(&dir, &changed_md_paths).await;

    for rel in changed_files {
        let normalized = normalize_rel_result(&rel)?;
        let abs = dir.join(&normalized);

        // Don't filter by extension — pull may have deleted .md files and we
        // still want to drop their rows. The branching mirrors update_entry.
        if !abs.exists() {
            if let Err(e) = delete_entry_path(&pool, &normalized).await {
                tracing::warn!("failed to drop index row for {normalized}: {e}");
            }
            continue;
        }

        let is_md = abs
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("md"))
            .unwrap_or(false);
        if !is_md {
            if let Err(e) = delete_entry_path(&pool, &normalized).await {
                tracing::warn!("failed to drop index row for {normalized}: {e}");
            }
            continue;
        }

        match build_entry_with_dates(&dir, &abs, date_overrides.get(&normalized)) {
            Ok(entry) => {
                if let Err(e) = upsert_entry(&pool, &entry).await {
                    tracing::warn!("failed to upsert index row for {normalized}: {e}");
                }
            }
            Err(e) => {
                tracing::warn!("failed to build index entry for {normalized}: {e}");
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::ProjectSpacesCache;
    use crate::index::search::search_fts;
    use crate::space::types::SpaceStatus;
    use std::collections::HashMap;
    use tempfile::TempDir;

    async fn indexed_pool(state: &IndexState, space: &Path) -> SqlitePool {
        state
            .get_or_create(&IndexKey::Root(space.to_path_buf()))
            .await
            .expect("index pool")
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
    async fn targeted_updates_do_not_leak_between_root_and_child_space_pools() {
        let tmp = TempDir::new().unwrap();
        let project = tmp.path();
        let child = project.join("child");
        std::fs::create_dir_all(project.join(".svode")).unwrap();
        std::fs::create_dir_all(child.join(".svode")).unwrap();
        std::fs::write(project.join("root.md"), "root searchable").unwrap();
        std::fs::write(child.join("child.md"), "child searchable").unwrap();

        let state = IndexState::new();
        state.spaces_cache.lock().await.insert(
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
}

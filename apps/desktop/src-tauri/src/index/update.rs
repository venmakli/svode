use sqlx::SqlitePool;
use std::path::Path;

use crate::error::AppError;
use crate::index::normalize_rel;
use crate::index::reindex::{build_entry, upsert_entry};
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

    let normalized = normalize_rel(&rel_path);
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

    let entry = build_entry(&dir, &abs)?;
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
    let normalized = normalize_rel(rel_path);
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

    for rel in changed_files {
        let normalized = normalize_rel(&rel);
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

        match build_entry(&dir, &abs) {
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

use sqlx::SqlitePool;
use std::path::Path;

use crate::error::AppError;
use crate::index::normalize_rel;
use crate::index::reindex::{build_entry, upsert_entry};

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

/// Incrementally update the index for a single file.
///
/// - If the file no longer exists on disk → delete the row.
/// - If the file exists but isn't a markdown file → also delete (e.g. user
///   renamed `foo.md` → `foo.txt`, leaving a stale entry).
/// - Otherwise → upsert.
pub async fn update_entry(
    pool: &SqlitePool,
    space_dir: &Path,
    rel_path: &str,
) -> Result<(), AppError> {
    let normalized = normalize_rel(rel_path);
    let abs_path = space_dir.join(&normalized);

    if !abs_path.exists() {
        return delete_entry_path(pool, &normalized).await;
    }

    ensure_inside_space(space_dir, &abs_path)?;

    // Non-md files don't belong in the entries table. If a row exists for this
    // path (e.g. it used to be .md), drop it; otherwise no-op.
    let is_md = abs_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("md"))
        .unwrap_or(false);
    if !is_md {
        tracing::debug!("non-md file in update_entry, removing any stale row: {normalized}");
        return delete_entry_path(pool, &normalized).await;
    }

    let entry = build_entry(space_dir, &abs_path)?;
    upsert_entry(pool, &entry).await?;
    Ok(())
}

/// Delete an entry row by its relative path.
pub async fn delete_entry_path(pool: &SqlitePool, rel_path: &str) -> Result<(), AppError> {
    let normalized = normalize_rel(rel_path);
    sqlx::query("DELETE FROM entries WHERE path = ?")
        .bind(&normalized)
        .execute(pool)
        .await?;
    Ok(())
}

/// Apply a batch of file changes reported by a git pull. Filters to `.md`
/// files and calls `update_entry` for each.
pub async fn reindex_after_pull(
    pool: &SqlitePool,
    space_dir: &Path,
    changed_files: Vec<String>,
) -> Result<(), AppError> {
    for rel in changed_files {
        let normalized = normalize_rel(&rel);
        // We don't filter by extension here: a file may have been deleted on
        // pull and we still want to drop its row. update_entry handles both.
        if let Err(e) = update_entry(pool, space_dir, &normalized).await {
            tracing::warn!("failed to update index for {normalized}: {e}");
        }
    }
    Ok(())
}

use crate::git::path::{RootMode, repo_relative_from_base};
use crate::index::IndexError;
use crate::index::entry_projection::{build_entry_with_dates, file_modified_iso};
use crate::index::inventory::collect_reindex_inventory;
use crate::index::model::IndexedEntry;
use crate::index::rows::upsert_entry;
use crate::page::dates::{GitDateExecutor, derive_date_overrides};
use chrono::{DateTime, SecondsFormat, Utc};
use sqlx::{Executor, Sqlite, SqlitePool};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

fn format_system_time(time: SystemTime) -> String {
    let dt: DateTime<Utc> = time.into();
    dt.to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// Walk `.assets/` (if present) recursively, collecting all non-hidden files.
fn collect_asset_files(assets_dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), IndexError> {
    let entries = match fs::read_dir(assets_dir) {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };

    for entry in entries.filter_map(|e| e.ok()) {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }

        let path = entry.path();
        if let Ok(meta) = fs::symlink_metadata(&path) {
            if meta.file_type().is_symlink() {
                continue;
            }
        }

        if path.is_dir() {
            collect_asset_files(&path, out)?;
        } else {
            out.push(path);
        }
    }
    Ok(())
}

/// Guess a MIME type from extension. Keep simple; extend as needed.
fn mime_from_ext(ext: &str) -> Option<&'static str> {
    Some(match ext.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        "pdf" => "application/pdf",
        _ => return None,
    })
}

/// Pre-built asset row, ready to be inserted in a transaction.
struct IndexedAsset {
    id: String,
    rel_path: String,
    file_name: String,
    mime: Option<&'static str>,
    size_bytes: i64,
    created_at: String,
}

/// Build an `IndexedAsset` from an absolute file path. Synchronous; called
/// outside the transaction so blocking metadata reads don't hold the SQLite
/// write lock.
fn build_asset(space_dir: &Path, abs_path: &Path) -> Result<IndexedAsset, IndexError> {
    let rel_path = repo_relative_from_base(space_dir, abs_path, RootMode::Reject)?;

    let file_name = abs_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let ext = abs_path
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default();
    let mime = mime_from_ext(&ext);

    let meta = fs::metadata(abs_path)?;
    let size_bytes = meta.len() as i64;
    let created_at = meta.modified().map(format_system_time).unwrap_or_else(|_| {
        let now: DateTime<Utc> = SystemTime::now().into();
        now.to_rfc3339_opts(SecondsFormat::Secs, true)
    });

    Ok(IndexedAsset {
        id: ulid::Ulid::new().to_string().to_lowercase(),
        rel_path,
        file_name,
        mime,
        size_bytes,
        created_at,
    })
}

/// Full reindex of a space: wipes `entries` and `assets`, then rescans.
///
/// `skip_top_level` lists folder names directly under `space_dir` to exclude
/// — used by the root project's reindex to keep child-space directories out
/// of its index (each space owns its own pool).
///
/// Atomicity model:
/// - All filesystem I/O (walks, frontmatter parses) runs BEFORE the transaction
///   so the SQLite write lock is held only for a short, pure-SQL window.
/// - SQL-level errors (DELETE/INSERT failures) abort the tx and leave the
///   previous index intact.
/// - Per-file build failures (unreadable file, invalid repo path) are logged
///   and skipped *without* aborting the tx. Malformed frontmatter is indexed as
///   plain markdown with synthesized runtime metadata.
pub async fn full_reindex<E: GitDateExecutor>(
    executor: Option<&E>,
    pool: &SqlitePool,
    space_dir: &Path,
    skip_top_level: &[String],
) -> Result<(), IndexError> {
    full_reindex_for_target(executor, pool, space_dir, space_dir, skip_top_level)
        .await
        .map(|_| ())
}

/// Returns whether the committed projection had no source build/scan failures.
pub async fn full_reindex_for_target<E: GitDateExecutor>(
    executor: Option<&E>,
    pool: &SqlitePool,
    project_dir: &Path,
    space_dir: &Path,
    skip_top_level: &[String],
) -> Result<bool, IndexError> {
    tracing::debug!("full reindex of space: {}", space_dir.display());

    // ── Phase 1: filesystem walk + parse, no locks held ──────────────────
    let inventory_dir = space_dir.to_path_buf();
    let inventory_skip = skip_top_level.to_vec();
    let inventory = tokio::task::spawn_blocking(move || {
        collect_reindex_inventory(&inventory_dir, &inventory_skip)
    })
    .await
    .map_err(|error| IndexError::Index(format!("source inventory task failed: {error}")))??;
    let markdown_sources = inventory.markdown_sources;
    let collection_sources = inventory.collection_sources;
    let mut source_manifest = inventory.source_manifest;
    let scan_failure_count = inventory.scan_failure_count;
    let md_rel_paths = markdown_sources
        .iter()
        .filter_map(|source| {
            repo_relative_from_base(space_dir, &source.path, RootMode::Reject).ok()
        })
        .collect::<Vec<_>>();
    let entry_date_overrides = match executor {
        Some(executor) => derive_date_overrides(executor, space_dir, &md_rel_paths).await,
        None => Default::default(),
    };

    let assets_dir = space_dir.join(".assets");
    let mut asset_files: Vec<PathBuf> = Vec::new();
    if assets_dir.is_dir() {
        collect_asset_files(&assets_dir, &mut asset_files)?;
    }

    let mut entries: Vec<IndexedEntry> = Vec::with_capacity(markdown_sources.len());
    let mut entries_skipped = 0usize;
    for source in &markdown_sources {
        tokio::task::yield_now().await;
        let rel_path = repo_relative_from_base(space_dir, &source.path, RootMode::Reject).ok();
        let date_overrides = rel_path
            .as_ref()
            .and_then(|rel_path| entry_date_overrides.get(rel_path));
        match build_entry_with_dates(space_dir, &source.path, date_overrides, source.projection) {
            Ok(entry) => {
                if let Some(record) = source_manifest.iter_mut().find(|record| {
                    record.source_kind == "markdown" && record.source_path == entry.rel_path
                }) {
                    record.diagnostic_code = entry.source_diagnostic.clone();
                }
                entries.push(entry)
            }
            Err(e) => {
                entries_skipped += 1;
                if let Some(rel_path) = rel_path.as_ref() {
                    if let Some(record) = source_manifest.iter_mut().find(|record| {
                        record.source_kind == "markdown" && record.source_path == *rel_path
                    }) {
                        record.diagnostic_code = Some("unreadable_source".to_string());
                    }
                }
                tracing::warn!(
                    "failed to build index entry for {}: {e}",
                    source.path.display()
                );
            }
        }
    }

    let mut assets: Vec<IndexedAsset> = Vec::with_capacity(asset_files.len());
    let mut assets_skipped = 0usize;
    for path in &asset_files {
        match build_asset(space_dir, path) {
            Ok(a) => assets.push(a),
            Err(e) => {
                assets_skipped += 1;
                tracing::warn!("failed to build asset {}: {e}", path.display());
            }
        }
    }

    let mut knowledge_artifacts = entries
        .iter()
        .filter_map(|entry| entry.knowledge.clone())
        .collect::<Vec<_>>();
    let mut knowledge_failures = 0usize;
    for collection_source in collection_sources
        .iter()
        .filter(|source| source.discoverable)
    {
        let collection_path = &collection_source.path;
        match crate::collections::knowledge_projection::project_collection(
            space_dir,
            collection_path,
        ) {
            Ok(projection) => {
                let schema_path = if collection_path == "." {
                    space_dir.join("schema.yaml")
                } else {
                    space_dir.join(collection_path).join("schema.yaml")
                };
                knowledge_artifacts.push(
                    crate::index::knowledge_artifact::build_collection_artifact(
                        &projection,
                        &file_modified_iso(&schema_path),
                    ),
                );
            }
            Err(error) => {
                knowledge_failures += 1;
                tracing::warn!(
                    "failed to build Collection knowledge artifact {collection_path}: {error}"
                );
            }
        }
    }
    let mut agent_applicability = Vec::new();
    match crate::agent_context::projection::target_knowledge_projection(project_dir, space_dir)
        .await
    {
        Ok(projected) => {
            let agent_context_paths = projected
                .iter()
                .filter(|artifact| artifact.owner_scope == "current")
                .flat_map(|artifact| {
                    std::iter::once(&artifact.source_path).chain(artifact.aliases.iter())
                })
                .collect::<std::collections::HashSet<_>>();
            knowledge_artifacts
                .retain(|artifact| !agent_context_paths.contains(&artifact.source_path));
            knowledge_artifacts.extend(
                projected
                    .iter()
                    .filter(|artifact| artifact.owner_scope == "current")
                    .map(crate::index::knowledge_artifact::build_agent_artifact),
            );
            source_manifest.extend(
                knowledge_artifacts
                    .iter()
                    .filter(|artifact| {
                        matches!(artifact.kind.as_str(), "agent_instruction" | "skill")
                    })
                    .map(|artifact| {
                        crate::index::manifest::SourceManifestRecord::agent_context(
                            artifact.source_path.clone(),
                            artifact.content_hash.clone(),
                            artifact
                                .fragments
                                .iter()
                                .map(|fragment| fragment.text.len())
                                .sum(),
                        )
                    }),
            );
            agent_applicability = projected
                .iter()
                .filter(|artifact| artifact.is_effectively_applicable())
                .map(crate::index::knowledge_artifact::build_agent_applicability)
                .collect();
        }
        Err(error) => {
            knowledge_failures += 1;
            tracing::warn!("Agent Context knowledge projection failed: {error}");
        }
    }
    knowledge_artifacts.sort_by(|left, right| left.source_path.cmp(&right.source_path));

    // ── Phase 2: short pure-SQL transaction ──────────────────────────────
    let mut tx = pool.begin().await?;

    sqlx::query("DELETE FROM entries").execute(&mut *tx).await?;
    sqlx::query("DELETE FROM assets").execute(&mut *tx).await?;

    crate::index::knowledge_rows::replace_all(
        &mut tx,
        &knowledge_artifacts,
        &agent_applicability,
        source_manifest
            .iter()
            .filter(|record| record.diagnostic_code.is_some())
            .count(),
        entries_skipped + knowledge_failures + scan_failure_count,
    )
    .await?;
    crate::index::manifest::replace_source_manifest(&mut tx, &source_manifest).await?;
    crate::index::manifest::advance_generation(&mut tx, true, true).await?;

    for entry in &entries {
        upsert_entry(&mut *tx, entry).await?;
    }
    for asset in &assets {
        insert_asset(&mut *tx, asset).await?;
    }
    tx.commit().await?;

    tracing::debug!(
        "full reindex done: {} entries ({} skipped), {} assets ({} skipped)",
        entries.len(),
        entries_skipped,
        assets.len(),
        assets_skipped
    );
    Ok(entries_skipped + assets_skipped + knowledge_failures + scan_failure_count == 0)
}

/// Insert a pre-built asset row. Pure SQL — no FS access.
async fn insert_asset<'e, E>(executor: E, asset: &IndexedAsset) -> Result<(), IndexError>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        r#"
        INSERT INTO assets (id, rel_path, file_name, mime, size_bytes, document_id, created_at)
        VALUES (?, ?, ?, ?, ?, NULL, ?)
        ON CONFLICT(rel_path) DO UPDATE SET
            file_name = excluded.file_name,
            mime = excluded.mime,
            size_bytes = excluded.size_bytes
        "#,
    )
    .bind(&asset.id)
    .bind(&asset.rel_path)
    .bind(&asset.file_name)
    .bind(asset.mime)
    .bind(asset.size_bytes)
    .bind(&asset.created_at)
    .execute(executor)
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::page::dates::SystemGitDateExecutor;
    use crate::routines::store_state::RoutineStoreState;

    #[tokio::test]
    async fn headless_rebuild_keeps_hidden_members_and_operational_store() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join(".svode")).unwrap();
        fs::write(root.join("schema.yaml"), "columns: []\nviews: []\n").unwrap();
        fs::write(root.join(".gitignore"), "hidden.md\n").unwrap();
        fs::write(root.join("hidden.md"), "# Hidden body token").unwrap();
        fs::write(root.join("visible.md"), "# Visible body token").unwrap();
        let key = crate::index::IndexKey::Root(root.to_path_buf());
        let stores = RoutineStoreState::new();
        let routines_pool = stores.get_or_create(&key, root).await.unwrap();
        let index_pool = crate::index::open_prepared_pool(&root.join(".svode/index.db"))
            .await
            .unwrap();

        assert!(
            full_reindex_for_target(None::<&SystemGitDateExecutor>, &index_pool, root, root, &[],)
                .await
                .unwrap()
        );
        let hidden: (i64, i64, String) = sqlx::query_as(
            "SELECT in_collection, is_discoverable, body_preview FROM entries WHERE file_path = 'hidden.md'",
        )
        .fetch_one(&index_pool)
        .await
        .unwrap();
        assert_eq!((hidden.0, hidden.1), (1, 0));
        assert!(hidden.2.is_empty());
        let visible: i64 = sqlx::query_scalar(
            "SELECT is_discoverable FROM entries WHERE file_path = 'visible.md'",
        )
        .fetch_one(&index_pool)
        .await
        .unwrap();
        assert_eq!(visible, 1);
        assert!(root.join(".svode/routines.db").exists());
        assert!(!routines_pool.is_closed());
        stores.close_key(&key).await;
        index_pool.close().await;
    }
}

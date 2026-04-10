use chrono::{DateTime, SecondsFormat, Utc};
use sqlx::{Executor, Sqlite, SqlitePool};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::error::AppError;
use crate::files::frontmatter;
use crate::index::normalize_rel;

/// Format a SystemTime as RFC3339 UTC.
fn format_system_time(time: SystemTime) -> String {
    let dt: DateTime<Utc> = time.into();
    dt.to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// Walk a directory, collecting paths of `.md` files while skipping hidden
/// directories (those with names starting with `.`) such as `.combai`,
/// `.assets`, and `.git`.
fn collect_md_files(base: &Path, dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), AppError> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!("cannot read dir {}: {e}", dir.display());
            return Ok(());
        }
    };

    for entry in entries.filter_map(|e| e.ok()) {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }

        let path = entry.path();

        // Skip symlinks to avoid cycles and CLI-generated infra.
        if let Ok(meta) = fs::symlink_metadata(&path) {
            if meta.file_type().is_symlink() {
                continue;
            }
        }

        if path.is_dir() {
            collect_md_files(base, &path, out)?;
        } else if name.ends_with(".md") {
            out.push(path);
        }
    }

    Ok(())
}

/// Walk `.assets/` (if present) recursively, collecting all non-hidden files.
fn collect_asset_files(assets_dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), AppError> {
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

/// Information extracted from a markdown file ready to be upserted.
pub(crate) struct IndexedEntry {
    pub id: String,
    pub rel_path: String,
    pub entry_type: String,
    pub table_name: Option<String>,
    pub title: String,
    pub metadata_json: String,
    pub content: String,
    pub updated_at: String,
}

/// Build an `IndexedEntry` from an absolute file path. Parses frontmatter,
/// falling back to synthesized values if absent or invalid.
pub(crate) fn build_entry(
    workspace_dir: &Path,
    abs_path: &Path,
) -> Result<IndexedEntry, AppError> {
    let rel_path = abs_path
        .strip_prefix(workspace_dir)
        .unwrap_or(abs_path)
        .to_string_lossy()
        .to_string();
    let rel_path = normalize_rel(&rel_path);

    let raw = fs::read_to_string(abs_path)?;

    let (id, title, metadata_json, content, updated_at) = match frontmatter::try_parse(&raw) {
        Ok(Some((meta, body))) => {
            let metadata_json = serialize_full_metadata(&meta, &rel_path);
            let updated_at = if meta.updated.is_empty() {
                file_modified_iso(abs_path)
            } else {
                meta.updated.clone()
            };
            (meta.id, meta.title, metadata_json, body, updated_at)
        }
        _ => {
            let id = ulid::Ulid::new().to_string().to_lowercase();
            let title = abs_path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let updated_at = file_modified_iso(abs_path);
            (id, title, "{}".to_string(), raw, updated_at)
        }
    };

    // Detect table_row vs page by looking for `_schema.yaml` in the parent dir.
    let (entry_type, table_name) = match abs_path.parent() {
        Some(parent) if parent.join("_schema.yaml").is_file() => {
            let name = parent
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            ("table_row".to_string(), Some(name))
        }
        _ => ("page".to_string(), None),
    };

    Ok(IndexedEntry {
        id,
        rel_path,
        entry_type,
        table_name,
        title,
        metadata_json,
        content,
        updated_at,
    })
}

/// Serialize the full frontmatter (id/title/icon/created/updated + extra) as JSON.
///
/// Per spec `metadata` stores the *whole* frontmatter, not just custom fields.
/// `serde_yml::Value` round-trips through `serde_json::Value` for normal scalars,
/// sequences, and string-keyed mappings. YAML-only constructs (tags, non-string
/// keys) fail; we log and fall back to `{}` rather than crash a reindex.
fn serialize_full_metadata(meta: &crate::files::EntryMeta, rel_path: &str) -> String {
    let mut map = serde_json::Map::new();
    map.insert("id".into(), serde_json::Value::String(meta.id.clone()));
    map.insert("title".into(), serde_json::Value::String(meta.title.clone()));
    if let Some(icon) = &meta.icon {
        map.insert("icon".into(), serde_json::Value::String(icon.clone()));
    }
    map.insert(
        "created".into(),
        serde_json::Value::String(meta.created.clone()),
    );
    map.insert(
        "updated".into(),
        serde_json::Value::String(meta.updated.clone()),
    );

    for (key, value) in &meta.extra {
        match serde_json::to_value(value) {
            Ok(v) => {
                map.insert(key.clone(), v);
            }
            Err(e) => {
                tracing::warn!(
                    "metadata field {key:?} in {rel_path} could not be JSON-encoded: {e}"
                );
            }
        }
    }

    serde_json::to_string(&map).unwrap_or_else(|e| {
        tracing::warn!("metadata serialization failed for {rel_path}: {e}");
        "{}".to_string()
    })
}

fn file_modified_iso(path: &Path) -> String {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .map(format_system_time)
        .unwrap_or_else(|_| {
            let now: DateTime<Utc> = SystemTime::now().into();
            now.to_rfc3339_opts(SecondsFormat::Secs, true)
        })
}

/// Insert or update an indexed entry (UPSERT on path).
///
/// Generic over `Executor` so the same code path works for a connection pool,
/// a single connection, or a transaction. The `git_hash` column is preserved
/// across UPSERTs (will be populated by future git integration).
pub(crate) async fn upsert_entry<'e, E>(
    executor: E,
    entry: &IndexedEntry,
) -> Result<(), AppError>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        r#"
        INSERT INTO entries (id, path, type, table_name, title, metadata, content, updated_at, git_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(path) DO UPDATE SET
            id = excluded.id,
            type = excluded.type,
            table_name = excluded.table_name,
            title = excluded.title,
            metadata = excluded.metadata,
            content = excluded.content,
            updated_at = excluded.updated_at
        "#,
    )
    .bind(&entry.id)
    .bind(&entry.rel_path)
    .bind(&entry.entry_type)
    .bind(&entry.table_name)
    .bind(&entry.title)
    .bind(&entry.metadata_json)
    .bind(&entry.content)
    .bind(&entry.updated_at)
    .execute(executor)
    .await?;
    Ok(())
}

/// Derive an asset type bucket from file extension.
fn asset_type_from_ext(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" => "image",
        "mp4" | "mov" | "webm" => "video",
        "mp3" | "wav" | "ogg" | "m4a" => "audio",
        _ => "file",
    }
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
    original_name: String,
    asset_type: &'static str,
    mime_type: Option<&'static str>,
    size: i64,
    created_at: String,
}

/// Build an `IndexedAsset` from an absolute file path. Synchronous; called
/// outside the transaction so blocking metadata reads don't hold the SQLite
/// write lock.
fn build_asset(workspace_dir: &Path, abs_path: &Path) -> Result<IndexedAsset, AppError> {
    let rel_path = abs_path
        .strip_prefix(workspace_dir)
        .unwrap_or(abs_path)
        .to_string_lossy()
        .to_string();
    let rel_path = normalize_rel(&rel_path);

    let original_name = abs_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let ext = abs_path
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default();
    let asset_type = asset_type_from_ext(&ext);
    let mime_type = mime_from_ext(&ext);

    let meta = fs::metadata(abs_path)?;
    let size = meta.len() as i64;
    let created_at = meta
        .modified()
        .map(format_system_time)
        .unwrap_or_else(|_| {
            let now: DateTime<Utc> = SystemTime::now().into();
            now.to_rfc3339_opts(SecondsFormat::Secs, true)
        });

    Ok(IndexedAsset {
        id: ulid::Ulid::new().to_string().to_lowercase(),
        rel_path,
        original_name,
        asset_type,
        mime_type,
        size,
        created_at,
    })
}

/// Full reindex of a workspace: wipes `entries` and `assets`, then rescans.
///
/// Atomicity model:
/// - All filesystem I/O (walks, frontmatter parses) runs BEFORE the transaction
///   so the SQLite write lock is held only for a short, pure-SQL window.
/// - SQL-level errors (DELETE/INSERT failures) abort the tx and leave the
///   previous index intact.
/// - Per-file build failures (bad frontmatter, unreadable file) are logged and
///   skipped *without* aborting the tx — those entries are absent from the
///   resulting index. Skipped count is reported in the final log line.
pub async fn full_reindex(pool: &SqlitePool, workspace_dir: &Path) -> Result<(), AppError> {
    tracing::debug!("full reindex of workspace: {}", workspace_dir.display());

    // ── Phase 1: filesystem walk + parse, no locks held ──────────────────
    let mut md_files: Vec<PathBuf> = Vec::new();
    collect_md_files(workspace_dir, workspace_dir, &mut md_files)?;

    let assets_dir = workspace_dir.join(".assets");
    let mut asset_files: Vec<PathBuf> = Vec::new();
    if assets_dir.is_dir() {
        collect_asset_files(&assets_dir, &mut asset_files)?;
    }

    let mut entries: Vec<IndexedEntry> = Vec::with_capacity(md_files.len());
    let mut entries_skipped = 0usize;
    for path in &md_files {
        match build_entry(workspace_dir, path) {
            Ok(entry) => entries.push(entry),
            Err(e) => {
                entries_skipped += 1;
                tracing::warn!("failed to build index entry for {}: {e}", path.display());
            }
        }
    }

    let mut assets: Vec<IndexedAsset> = Vec::with_capacity(asset_files.len());
    let mut assets_skipped = 0usize;
    for path in &asset_files {
        match build_asset(workspace_dir, path) {
            Ok(a) => assets.push(a),
            Err(e) => {
                assets_skipped += 1;
                tracing::warn!("failed to build asset {}: {e}", path.display());
            }
        }
    }

    // ── Phase 2: short pure-SQL transaction ──────────────────────────────
    let mut tx = pool.begin().await?;

    sqlx::query("DELETE FROM entries").execute(&mut *tx).await?;
    sqlx::query("DELETE FROM assets").execute(&mut *tx).await?;

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
    Ok(())
}

/// Insert a pre-built asset row. Pure SQL — no FS access.
async fn insert_asset<'e, E>(executor: E, asset: &IndexedAsset) -> Result<(), AppError>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        r#"
        INSERT INTO assets (id, path, original_name, document_id, asset_type, mime_type, size, created_at)
        VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
            original_name = excluded.original_name,
            asset_type = excluded.asset_type,
            mime_type = excluded.mime_type,
            size = excluded.size
        "#,
    )
    .bind(&asset.id)
    .bind(&asset.rel_path)
    .bind(&asset.original_name)
    .bind(asset.asset_type)
    .bind(asset.mime_type)
    .bind(asset.size)
    .bind(&asset.created_at)
    .execute(executor)
    .await?;

    Ok(())
}

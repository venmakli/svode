use std::path::Path;

use serde::Serialize;
use sqlx::{Row, SqlitePool};

use crate::error::AppError;
use crate::repo_path::{RootMode, normalize_repo_relative, repo_relative_from_base};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadResult {
    /// ULID identifier of the asset record.
    pub id: String,
    /// Relative path of the asset inside the pool's target dir
    /// (e.g. `.assets/<prefix>-<name>`), forward slashes.
    pub rel_path: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub mime: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: String,
    pub rel_path: String,
    pub file_name: String,
    pub document_id: Option<String>,
    pub mime: Option<String>,
    pub size_bytes: Option<i64>,
    pub created_at: String,
}

/// Sanitize a filename so it can safely be joined under `.assets/`.
/// Replaces path separators, control chars, and unsafe characters with `_`.
fn sanitize_filename(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| {
            if c.is_control() {
                '_'
            } else {
                match c {
                    '/' | '\\' | ':' | '?' | '*' | '"' | '<' | '>' | '|' => '_',
                    other => other,
                }
            }
        })
        .collect();

    // Trim leading/trailing whitespace, dots, slashes.
    let trimmed = out
        .trim_matches(|c: char| c.is_whitespace() || c == '.' || c == '/' || c == '\\')
        .to_string();
    out = trimmed;

    if out.is_empty() {
        "file".to_string()
    } else {
        out
    }
}

/// Map an extension (lowercased, no dot) to the canonical MIME type. The old
/// `asset_type` bucket is gone — it can be derived from the MIME on the
/// frontend if a coarse type is needed.
pub(crate) fn mime_for(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// Upload an asset into the target dir's `.assets/` directory and register
/// it in the pool's SQLite `assets` table. Does NOT interact with git — the
/// caller is responsible for staging via autocommit.
pub async fn upload(
    pool: &SqlitePool,
    target_dir: &Path,
    bytes: &[u8],
    original_name: &str,
    document_id: Option<&str>,
) -> Result<UploadResult, AppError> {
    // Generate the ULID up-front and derive the filename prefix from its first
    // 8 characters (lowercased). ULID's leading bits encode the timestamp, so
    // this gives chronological ordering in `.assets/` and ties filename to the
    // SQLite `id` without a second random source.
    let id = ulid::Ulid::new().to_string();
    let prefix = id[..8].to_ascii_lowercase();

    let sanitized = sanitize_filename(original_name);
    let asset_name = format!("{prefix}-{sanitized}");

    // Post-sanitization, `sanitized` may still contain nothing dangerous since
    // any slash/backslash has been replaced with `_`. Enforce this as a hard
    // safety boundary to prevent path traversal.
    if asset_name.contains('/') || asset_name.contains('\\') {
        return Err(AppError::PathNotAccessible(asset_name));
    }

    let assets_dir = target_dir.join(".assets");
    tokio::fs::create_dir_all(&assets_dir).await?;

    let target = assets_dir.join(&asset_name);

    tokio::fs::write(&target, bytes).await?;

    let size = tokio::fs::metadata(&target).await?.len();

    let ext = target
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    let mime = mime_for(&ext);

    let rel_path = normalize_repo_relative(&format!(".assets/{asset_name}"), RootMode::Reject)?;
    let created_at = chrono::Utc::now().to_rfc3339();

    sqlx::query(
        r#"
        INSERT INTO assets
            (id, rel_path, file_name, mime, size_bytes, document_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&id)
    .bind(&rel_path)
    .bind(original_name)
    .bind(mime)
    .bind(size as i64)
    .bind(document_id)
    .bind(&created_at)
    .execute(pool)
    .await?;

    Ok(UploadResult {
        id,
        rel_path,
        file_name: original_name.to_string(),
        size_bytes: size,
        mime: mime.to_string(),
    })
}

/// List all assets registered in this pool, newest first.
pub async fn list(pool: &SqlitePool) -> Result<Vec<Asset>, AppError> {
    let rows = sqlx::query(
        r#"
        SELECT id, rel_path, file_name, document_id, mime, size_bytes, created_at
        FROM assets
        ORDER BY created_at DESC
        "#,
    )
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(Asset {
            id: row.try_get("id")?,
            rel_path: row.try_get("rel_path")?,
            file_name: row.try_get("file_name")?,
            document_id: row.try_get("document_id")?,
            mime: row.try_get("mime")?,
            size_bytes: row.try_get("size_bytes")?,
            created_at: row.try_get("created_at")?,
        });
    }
    Ok(out)
}

/// UPSERT or DELETE a single asset row by absolute path. Used by the file
/// watcher when something inside `.assets/` changes outside the upload IPC
/// (e.g. an LFS pull populates a previously-pointer file). Wiring from the
/// watcher debounce loop is deferred to a follow-up session — `process_events`
/// already emits `space:assets_changed` so this can be attached cleanly.
#[allow(dead_code)]
pub async fn update_asset(
    state: &crate::index::IndexState,
    project: &Path,
    abs_path: &Path,
) -> Result<(), AppError> {
    let (key, _rel_in_pool) = state.resolve(project, abs_path).await?;
    let pool = state.get_or_create(&key).await?;
    let target_dir = state.dir_for_key(&key).await?;

    let rel = repo_relative_from_base(&target_dir, abs_path, RootMode::Reject)?;

    if !abs_path.exists() {
        sqlx::query("DELETE FROM assets WHERE rel_path = ?")
            .bind(&rel)
            .execute(&pool)
            .await?;
        return Ok(());
    }

    let file_name = abs_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = abs_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    let mime = mime_for(&ext);
    let meta = std::fs::metadata(abs_path)?;
    let size = meta.len() as i64;
    let created_at = chrono::Utc::now().to_rfc3339();

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
    .bind(ulid::Ulid::new().to_string().to_lowercase())
    .bind(&rel)
    .bind(&file_name)
    .bind(mime)
    .bind(size)
    .bind(&created_at)
    .execute(&pool)
    .await?;

    Ok(())
}

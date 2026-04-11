use std::path::Path;

use serde::Serialize;
use sqlx::{Row, SqlitePool};

use crate::error::AppError;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadResult {
    /// ULID identifier of the asset record.
    pub id: String,
    /// Relative path of the asset inside the workspace
    /// (e.g. `.assets/<prefix>-<name>`), forward slashes.
    pub asset_path: String,
    pub original_name: String,
    pub size: u64,
    pub mime_type: String,
    /// One of `image` | `video` | `audio` | `file`.
    pub asset_type: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: String,
    pub path: String,
    pub original_name: Option<String>,
    pub document_id: Option<String>,
    pub asset_type: String,
    pub mime_type: Option<String>,
    pub size: Option<i64>,
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

/// Map an extension (lowercased, no dot) to `(mime_type, asset_type)`.
pub(crate) fn mime_for(ext: &str) -> (&'static str, &'static str) {
    match ext {
        "png" => ("image/png", "image"),
        "jpg" | "jpeg" => ("image/jpeg", "image"),
        "gif" => ("image/gif", "image"),
        "webp" => ("image/webp", "image"),
        "svg" => ("image/svg+xml", "image"),
        "avif" => ("image/avif", "image"),
        "ico" => ("image/x-icon", "image"),
        "mp4" => ("video/mp4", "video"),
        "mov" => ("video/quicktime", "video"),
        "webm" => ("video/webm", "video"),
        "mkv" => ("video/x-matroska", "video"),
        "mp3" => ("audio/mpeg", "audio"),
        "wav" => ("audio/wav", "audio"),
        "ogg" => ("audio/ogg", "audio"),
        "flac" => ("audio/flac", "audio"),
        "m4a" => ("audio/mp4", "audio"),
        "pdf" => ("application/pdf", "file"),
        _ => ("application/octet-stream", "file"),
    }
}

/// Upload an asset into the workspace `.assets/` directory and register it in
/// the SQLite index. Does NOT interact with git — the caller is responsible
/// for staging via `strategy::stage_new_asset` if needed.
pub async fn upload(
    pool: &SqlitePool,
    workspace_dir: &Path,
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

    let assets_dir = workspace_dir.join(".assets");
    tokio::fs::create_dir_all(&assets_dir).await?;

    let target = assets_dir.join(&asset_name);

    tokio::fs::write(&target, bytes).await?;

    let size = tokio::fs::metadata(&target).await?.len();

    let ext = target
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    let (mime_type, asset_type) = mime_for(&ext);

    let asset_path = format!(".assets/{asset_name}");
    let created_at = chrono::Utc::now().to_rfc3339();

    sqlx::query(
        r#"
        INSERT INTO assets
            (id, path, original_name, document_id, asset_type, mime_type, size, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&id)
    .bind(&asset_path)
    .bind(original_name)
    .bind(document_id)
    .bind(asset_type)
    .bind(mime_type)
    .bind(size as i64)
    .bind(&created_at)
    .execute(pool)
    .await?;

    Ok(UploadResult {
        id,
        asset_path,
        original_name: original_name.to_string(),
        size,
        mime_type: mime_type.to_string(),
        asset_type: asset_type.to_string(),
    })
}

/// List all assets registered in the workspace index, newest first.
pub async fn list(pool: &SqlitePool) -> Result<Vec<Asset>, AppError> {
    let rows = sqlx::query(
        r#"
        SELECT id, path, original_name, document_id, asset_type, mime_type, size, created_at
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
            path: row.try_get("path")?,
            original_name: row.try_get("original_name")?,
            document_id: row.try_get("document_id")?,
            asset_type: row.try_get("asset_type")?,
            mime_type: row.try_get("mime_type")?,
            size: row.try_get("size")?,
            created_at: row.try_get("created_at")?,
        });
    }
    Ok(out)
}

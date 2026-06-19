use chrono::{DateTime, SecondsFormat, Utc};
use sqlx::{Executor, Sqlite, SqlitePool};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::error::AppError;
use crate::files::frontmatter;
use crate::files::tree_policy::{TreeIgnorePolicy, TreePathKind};
use crate::git::dates::{EntryDateOverride, derive_date_overrides};
use crate::index::normalize_rel_root_result;
use crate::repo_path::{RootMode, repo_relative_from_base};

/// Format a SystemTime as RFC3339 UTC.
fn format_system_time(time: SystemTime) -> String {
    let dt: DateTime<Utc> = time.into();
    dt.to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// Walk a directory, collecting paths of `.md` files while applying the same
/// layered content-tree ignore policy as the sidebar tree.
///
/// `skip_top_level` lists folder names directly under `base` to skip — used
/// to keep the root walker out of child-space directories (each space owns
/// its own pool).
fn collect_md_files(
    base: &Path,
    dir: &Path,
    skip_top_level: &[String],
    policy: &TreeIgnorePolicy,
    out: &mut Vec<PathBuf>,
) -> Result<(), AppError> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!("cannot read dir {}: {e}", dir.display());
            return Ok(());
        }
    };

    let at_base = dir == base;

    for entry in entries.filter_map(|e| e.ok()) {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();

        if at_base && skip_top_level.iter().any(|s| s == &name) {
            continue;
        }

        // Skip symlinks to avoid cycles and CLI-generated infra.
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }

        let rel_path = path.strip_prefix(base).unwrap_or(&path);
        let kind = if meta.is_dir() {
            TreePathKind::Directory
        } else if meta.is_file() {
            TreePathKind::File
        } else {
            TreePathKind::Unknown
        };
        if policy.is_ignored_rel(rel_path, kind) {
            continue;
        }

        if meta.is_dir() {
            collect_md_files(base, &path, skip_top_level, policy, out)?;
        } else if meta.is_file() && name.ends_with(".md") {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::config::write_space_config;
    use crate::space::types::{SpaceConfig, TreeSpaceConfig};
    use tempfile::TempDir;

    fn write_tree_config(tmp: &TempDir, exclude: Vec<&str>, include: Vec<&str>) {
        write_space_config(
            tmp.path(),
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
                    exclude: exclude.into_iter().map(ToString::to_string).collect(),
                    include: include.into_iter().map(ToString::to_string).collect(),
                    show_ignored_placeholders: false,
                }),
            },
        )
        .expect("write config");
    }

    fn collect_rel_paths(tmp: &TempDir) -> Vec<String> {
        let policy = TreeIgnorePolicy::from_space_root(tmp.path());
        let mut files = Vec::new();
        collect_md_files(tmp.path(), tmp.path(), &[], &policy, &mut files).expect("collect files");
        let mut rels = files
            .iter()
            .map(|path| {
                path.strip_prefix(tmp.path())
                    .expect("relative")
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect::<Vec<_>>();
        rels.sort();
        rels
    }

    #[test]
    fn build_entry_indexes_legacy_keys_as_fields() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("note.md");
        std::fs::write(
            &file,
            "---\ntitle: Note\nid: imported\ncreated: yaml-created\nupdated: yaml-updated\n---\nBody\n",
        )
        .unwrap();

        let entry = build_entry_with_dates(tmp.path(), &file, None).expect("build entry");
        let fields: serde_json::Value =
            serde_json::from_str(&entry.fields_json).expect("fields json");

        assert_eq!(entry.rel_path, "note.md");
        assert_eq!(entry.title, "Note");
        assert_eq!(fields["id"], "imported");
        assert_eq!(fields["created"], "yaml-created");
        assert_eq!(fields["updated"], "yaml-updated");
        assert_ne!(entry.created, "yaml-created");
        assert_ne!(entry.updated, "yaml-updated");
    }

    #[test]
    fn build_entry_indexes_malformed_frontmatter_as_plain_markdown() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("broken.md");
        let raw = "---\ntitle: [broken\n---\nBody\n";
        std::fs::write(&file, raw).unwrap();

        let entry = build_entry_with_dates(tmp.path(), &file, None).expect("build entry");

        assert_eq!(entry.rel_path, "broken.md");
        assert_eq!(entry.title, "Broken");
        assert_eq!(entry.fields_json, "{}");
        assert_eq!(entry.body_preview, raw);
    }

    #[test]
    fn reindex_markdown_walk_applies_tree_excludes() {
        let tmp = TempDir::new().unwrap();
        write_tree_config(&tmp, vec!["node_modules"], vec![]);
        std::fs::create_dir_all(tmp.path().join("node_modules").join("pkg")).unwrap();
        std::fs::write(
            tmp.path()
                .join("node_modules")
                .join("pkg")
                .join("README.md"),
            "ignored",
        )
        .unwrap();
        std::fs::write(tmp.path().join("visible.md"), "visible").unwrap();

        assert_eq!(collect_rel_paths(&tmp), vec!["visible.md".to_string()]);
    }

    #[test]
    fn reindex_markdown_walk_descends_to_user_included_paths() {
        let tmp = TempDir::new().unwrap();
        write_tree_config(&tmp, vec!["docs"], vec!["docs/guides/keep.md"]);
        std::fs::create_dir_all(tmp.path().join("docs").join("guides")).unwrap();
        std::fs::write(tmp.path().join("docs").join("drop.md"), "drop").unwrap();
        std::fs::write(
            tmp.path().join("docs").join("guides").join("drop.md"),
            "drop",
        )
        .unwrap();
        std::fs::write(
            tmp.path().join("docs").join("guides").join("keep.md"),
            "keep",
        )
        .unwrap();

        assert_eq!(
            collect_rel_paths(&tmp),
            vec!["docs/guides/keep.md".to_string()]
        );
    }
}

/// Information extracted from a markdown file ready to be upserted.
pub(crate) struct IndexedEntry {
    pub rel_path: String,
    pub parent_path: String,
    pub title: String,
    pub icon: Option<String>,
    pub description: Option<String>,
    pub cover_json: Option<String>,
    pub created: String,
    pub updated: String,
    pub collection_root_path: Option<String>,
    pub in_collection: bool,
    pub is_entry_head: bool,
    pub fields_json: String,
    pub body_preview: String,
}

/// Build an `IndexedEntry` using precomputed runtime date overrides when
/// available. The filesystem remains the fallback for untracked, dirty, or
/// unavailable Git history cases.
pub(crate) fn build_entry_with_dates(
    space_dir: &Path,
    abs_path: &Path,
    date_override: Option<&EntryDateOverride>,
) -> Result<IndexedEntry, AppError> {
    let rel_path = repo_relative_from_base(space_dir, abs_path, RootMode::Reject)?;

    let raw = fs::read_to_string(abs_path)?;

    let fs_created = file_created_iso(abs_path);
    let fs_updated = file_modified_iso(abs_path);
    let created = date_override
        .and_then(|dates| dates.created.clone())
        .unwrap_or(fs_created);
    let updated = date_override
        .and_then(|dates| dates.updated.clone())
        .unwrap_or(fs_updated);
    let (title, icon, description, cover_json, fields_json, body_preview) =
        match frontmatter::parse_status(&raw) {
            frontmatter::ParseStatus::Valid { meta, body } => {
                let fields_json = serialize_fields(&meta, &rel_path);
                let cover_json = meta.cover.as_ref().and_then(|cover| {
                    serde_json::to_string(cover)
                        .map_err(|e| {
                            tracing::warn!(
                                "cover field in {rel_path} could not be JSON-encoded: {e}"
                            );
                            e
                        })
                        .ok()
                });
                let title = if meta.frontmatter_keys.title {
                    meta.title
                } else {
                    title_for_path(abs_path)
                };
                (
                    title,
                    meta.icon,
                    meta.description,
                    cover_json,
                    fields_json,
                    body,
                )
            }
            _ => (
                title_for_path(abs_path),
                None,
                None,
                None,
                "{}".to_string(),
                raw,
            ),
        };

    let collection_root_path = match crate::properties::resolve_collection_schema_result(
        &space_dir.to_string_lossy(),
        &rel_path,
    ) {
        Ok(Some((_, root))) => Some(root_path_for_index(&root)),
        Ok(None) => None,
        Err(e) => {
            tracing::warn!("schema resolver failed for {rel_path}; indexing as standalone: {e}");
            None
        }
    };
    let in_collection = collection_root_path.is_some();

    Ok(IndexedEntry {
        parent_path: parent_path_for(&rel_path)?,
        rel_path,
        title,
        icon,
        description,
        cover_json,
        created,
        updated,
        collection_root_path,
        in_collection,
        is_entry_head: true,
        fields_json,
        body_preview,
    })
}

fn root_path_for_index(path: &Path) -> String {
    let rel = normalize_rel_root_result(&path.to_string_lossy())
        .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"));
    if rel.is_empty() { ".".to_string() } else { rel }
}

fn parent_path_for(rel_path: &str) -> Result<String, AppError> {
    let parent = Path::new(rel_path)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| normalize_rel_root_result(&p.to_string_lossy()))
        .transpose()?;
    Ok(parent.unwrap_or_else(|| ".".to_string()))
}

fn title_for_path(path: &Path) -> String {
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("untitled");
    crate::files::entry::title_from_stem(stem)
}

/// Serialize custom frontmatter fields as JSON for the `fields` column.
/// System fields are stored in dedicated columns.
/// `serde_yml::Value` round-trips through `serde_json::Value` for normal scalars,
/// sequences, and string-keyed mappings. YAML-only constructs (tags, non-string
/// keys) fail; we log and fall back to `{}` rather than crash a reindex.
fn serialize_fields(meta: &crate::files::EntryMeta, rel_path: &str) -> String {
    let mut map = serde_json::Map::new();
    for (key, value) in &meta.extra {
        match serde_json::to_value(value) {
            Ok(v) => {
                map.insert(key.clone(), v);
            }
            Err(e) => {
                tracing::warn!("fields field {key:?} in {rel_path} could not be JSON-encoded: {e}");
            }
        }
    }

    serde_json::to_string(&map).unwrap_or_else(|e| {
        tracing::warn!("fields serialization failed for {rel_path}: {e}");
        "{}".to_string()
    })
}

fn file_created_iso(path: &Path) -> String {
    fs::metadata(path)
        .and_then(|m| m.created())
        .map(format_system_time)
        .unwrap_or_else(|_| file_modified_iso(path))
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

/// Insert or update an indexed entry (UPSERT on file_path).
///
/// Generic over `Executor` so the same code path works for a connection pool,
/// a single connection, or a transaction.
pub(crate) async fn upsert_entry<'e, E>(executor: E, entry: &IndexedEntry) -> Result<(), AppError>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        r#"
        INSERT INTO entries (
            file_path, parent_path, title, icon, description, cover, created, updated,
            collection_root_path, in_collection, is_entry_head, fields, body_preview
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_path) DO UPDATE SET
            parent_path = excluded.parent_path,
            title = excluded.title,
            icon = excluded.icon,
            description = excluded.description,
            cover = excluded.cover,
            created = excluded.created,
            updated = excluded.updated,
            collection_root_path = excluded.collection_root_path,
            in_collection = excluded.in_collection,
            is_entry_head = excluded.is_entry_head,
            fields = excluded.fields,
            body_preview = excluded.body_preview
        "#,
    )
    .bind(&entry.rel_path)
    .bind(&entry.parent_path)
    .bind(&entry.title)
    .bind(&entry.icon)
    .bind(&entry.description)
    .bind(&entry.cover_json)
    .bind(&entry.created)
    .bind(&entry.updated)
    .bind(&entry.collection_root_path)
    .bind(if entry.in_collection { 1_i64 } else { 0_i64 })
    .bind(if entry.is_entry_head { 1_i64 } else { 0_i64 })
    .bind(&entry.fields_json)
    .bind(&entry.body_preview)
    .execute(executor)
    .await?;
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
fn build_asset(space_dir: &Path, abs_path: &Path) -> Result<IndexedAsset, AppError> {
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
pub async fn full_reindex(
    pool: &SqlitePool,
    space_dir: &Path,
    skip_top_level: &[String],
) -> Result<(), AppError> {
    tracing::debug!("full reindex of space: {}", space_dir.display());

    // ── Phase 1: filesystem walk + parse, no locks held ──────────────────
    let mut md_files: Vec<PathBuf> = Vec::new();
    let policy = TreeIgnorePolicy::from_space_root(space_dir);
    collect_md_files(space_dir, space_dir, skip_top_level, &policy, &mut md_files)?;
    let md_rel_paths = md_files
        .iter()
        .filter_map(|path| repo_relative_from_base(space_dir, path, RootMode::Reject).ok())
        .collect::<Vec<_>>();
    let entry_date_overrides = derive_date_overrides(space_dir, &md_rel_paths).await;

    let assets_dir = space_dir.join(".assets");
    let mut asset_files: Vec<PathBuf> = Vec::new();
    if assets_dir.is_dir() {
        collect_asset_files(&assets_dir, &mut asset_files)?;
    }

    let mut entries: Vec<IndexedEntry> = Vec::with_capacity(md_files.len());
    let mut entries_skipped = 0usize;
    for path in &md_files {
        let rel_path = repo_relative_from_base(space_dir, path, RootMode::Reject).ok();
        let date_overrides = rel_path
            .as_ref()
            .and_then(|rel_path| entry_date_overrides.get(rel_path));
        match build_entry_with_dates(space_dir, path, date_overrides) {
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
        match build_asset(space_dir, path) {
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

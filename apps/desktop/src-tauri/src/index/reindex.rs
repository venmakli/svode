use chrono::{DateTime, SecondsFormat, Utc};
use sqlx::{Executor, Sqlite, SqlitePool};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::AppError;
use crate::files::frontmatter;
use crate::files::tree_policy::{TreeIgnorePolicy, TreePathKind};
use crate::git::dates::{EntryDateOverride, derive_date_overrides};
use crate::index::normalize_rel_root_result;
use crate::index::reconcile::{MAX_INDEXED_MARKDOWN_BYTES, SourceManifestRecord};
use crate::repo_path::{RootMode, repo_relative_from_base};

/// Format a SystemTime as RFC3339 UTC.
fn format_system_time(time: SystemTime) -> String {
    let dt: DateTime<Utc> = time.into();
    dt.to_rfc3339_opts(SecondsFormat::Secs, true)
}

#[derive(Debug)]
pub(crate) struct ReindexInventory {
    pub markdown_sources: Vec<MarkdownInventorySource>,
    pub collection_sources: Vec<CollectionInventorySource>,
    pub source_manifest: Vec<SourceManifestRecord>,
    pub scan_failure_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MarkdownProjection {
    Discoverable,
    CollectionMemberOnly,
}

impl MarkdownProjection {
    fn manifest_label(self) -> &'static str {
        match self {
            Self::Discoverable => "discoverable",
            Self::CollectionMemberOnly => "collection-member-only",
        }
    }

    pub(crate) fn is_discoverable(self) -> bool {
        self == Self::Discoverable
    }
}

#[derive(Debug)]
pub(crate) struct MarkdownInventorySource {
    pub path: PathBuf,
    pub projection: MarkdownProjection,
}

#[derive(Debug)]
pub(crate) struct CollectionInventorySource {
    pub path: String,
    pub discoverable: bool,
}

pub(crate) fn collect_reindex_inventory(
    space_dir: &Path,
    skip_top_level: &[String],
) -> Result<ReindexInventory, AppError> {
    let mut discovered_markdown = Vec::new();
    let mut collection_sources = Vec::new();
    let mut scan_failure_count = 0usize;
    let policy = TreeIgnorePolicy::from_space_root(space_dir);
    collect_md_files(
        space_dir,
        space_dir,
        skip_top_level,
        &policy,
        &mut discovered_markdown,
        &mut collection_sources,
        &mut scan_failure_count,
    )?;

    let mut markdown_sources = Vec::new();
    let mut source_manifest = Vec::new();
    for source in discovered_markdown {
        let record = markdown_source_record(space_dir, &source.path, source.projection)?;
        if record.diagnostic_code.is_none() {
            markdown_sources.push(source);
        }
        source_manifest.push(record);
    }
    let mut safe_collection_sources = Vec::new();
    for source in collection_sources {
        let schema_path = if source.path == "." {
            space_dir.join("schema.yaml")
        } else {
            space_dir.join(&source.path).join("schema.yaml")
        };
        let diagnostic_code = (fs::metadata(&schema_path)?.len() > MAX_INDEXED_MARKDOWN_BYTES)
            .then(|| "oversized_source".to_string());
        let record = source_record(
            space_dir,
            &schema_path,
            "collection_schema",
            diagnostic_code,
            Some(if source.discoverable {
                "discoverable"
            } else {
                "owner-only"
            }),
        )?;
        if record.diagnostic_code.is_none() {
            safe_collection_sources.push(source);
        }
        source_manifest.push(record);
    }
    source_manifest.sort_by(|left, right| {
        left.source_kind
            .cmp(&right.source_kind)
            .then_with(|| left.source_path.cmp(&right.source_path))
    });
    safe_collection_sources.sort_by(|left, right| left.path.cmp(&right.path));

    Ok(ReindexInventory {
        markdown_sources,
        collection_sources: safe_collection_sources,
        source_manifest,
        scan_failure_count,
    })
}

pub(crate) fn markdown_source_record(
    space_dir: &Path,
    path: &Path,
    projection: MarkdownProjection,
) -> Result<SourceManifestRecord, AppError> {
    let rel_path = repo_relative_from_base(space_dir, path, RootMode::Reject)?;
    let diagnostic_code = if crate::index::knowledge::is_secret_like_source(&rel_path) {
        Some("excluded_secret_like".to_string())
    } else {
        let size = fs::metadata(path)?.len();
        (size > MAX_INDEXED_MARKDOWN_BYTES).then(|| "oversized_source".to_string())
    };
    source_record(
        space_dir,
        path,
        "markdown",
        diagnostic_code,
        Some(projection.manifest_label()),
    )
}

fn source_record(
    space_dir: &Path,
    path: &Path,
    source_kind: &str,
    diagnostic_code: Option<String>,
    projection_label: Option<&str>,
) -> Result<SourceManifestRecord, AppError> {
    let source_path = repo_relative_from_base(space_dir, path, RootMode::Reject)?;
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Err(AppError::Index(format!(
            "source manifest rejected symlink: {source_path}"
        )));
    }
    let size_bytes = metadata.len().min(i64::MAX as u64) as i64;
    let modified_ns = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos().min(i64::MAX as u128) as i64)
        .unwrap_or(0);
    let (mut fingerprint, diagnostic_code) = if diagnostic_code.is_some() {
        (
            format!("excluded-v1:{size_bytes}:{modified_ns}"),
            diagnostic_code,
        )
    } else {
        match source_content_fingerprint(path) {
            Ok(fingerprint) => (fingerprint, None),
            Err(error) => {
                tracing::warn!("source fingerprint failed for {source_path}: {error}");
                (
                    format!("unreadable-v1:{size_bytes}:{modified_ns}"),
                    Some("unreadable_source".to_string()),
                )
            }
        }
    };
    if let Some(label) = projection_label {
        fingerprint = format!("{label}:{fingerprint}");
    }
    Ok(SourceManifestRecord {
        fingerprint,
        source_path,
        source_kind: source_kind.to_string(),
        size_bytes,
        modified_ns,
        checked_at: crate::index::reconcile::now(),
        diagnostic_code,
    })
}

fn source_content_fingerprint(path: &Path) -> Result<String, AppError> {
    let mut file = fs::File::open(path)?;
    let mut hash = 0xcbf29ce484222325_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        for byte in &buffer[..read] {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    Ok(format!("fnv1a64:{hash:016x}"))
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
    out: &mut Vec<MarkdownInventorySource>,
    collection_sources: &mut Vec<CollectionInventorySource>,
    scan_failure_count: &mut usize,
) -> Result<(), AppError> {
    let schema_path = dir.join("schema.yaml");
    if fs::symlink_metadata(&schema_path)
        .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
    {
        let collection_path = if dir == base {
            ".".to_string()
        } else {
            repo_relative_from_base(base, dir, RootMode::Reject)?
        };
        let schema_rel = schema_path.strip_prefix(base).unwrap_or(&schema_path);
        collection_sources.push(CollectionInventorySource {
            path: collection_path,
            discoverable: !policy.is_ignored_rel(schema_rel, TreePathKind::File),
        });
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!("cannot read dir {}: {e}", dir.display());
            *scan_failure_count += 1;
            return Ok(());
        }
    };

    let at_base = dir == base;

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                tracing::warn!("cannot read an entry under {}: {error}", dir.display());
                *scan_failure_count += 1;
                continue;
            }
        };
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
        if policy.is_system_ignored_rel(rel_path, kind) {
            continue;
        }

        if meta.is_dir() {
            collect_md_files(
                base,
                &path,
                skip_top_level,
                policy,
                out,
                collection_sources,
                scan_failure_count,
            )?;
        } else if meta.is_file() && name.ends_with(".md") {
            if let Some(projection) = markdown_projection(base, &path, policy)? {
                out.push(MarkdownInventorySource { path, projection });
            }
        }
    }

    Ok(())
}

pub(crate) fn markdown_projection(
    space_dir: &Path,
    path: &Path,
    policy: &TreeIgnorePolicy,
) -> Result<Option<MarkdownProjection>, AppError> {
    let rel_path = path.strip_prefix(space_dir).unwrap_or(path);
    if policy.is_system_ignored_rel(rel_path, TreePathKind::File) {
        return Ok(None);
    }
    if !policy.is_ignored_rel(rel_path, TreePathKind::File) {
        return Ok(Some(MarkdownProjection::Discoverable));
    }
    let rel_path = repo_relative_from_base(space_dir, path, RootMode::Reject)?;
    match crate::properties::resolve_collection_schema_result(
        &space_dir.to_string_lossy(),
        &rel_path,
    ) {
        Ok(Some(_)) => Ok(Some(MarkdownProjection::CollectionMemberOnly)),
        Ok(None) => Ok(None),
        Err(error) => {
            tracing::warn!("hidden source {rel_path} has no valid Collection membership: {error}");
            Ok(None)
        }
    }
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
        let mut collection_sources = Vec::new();
        let mut scan_failure_count = 0;
        collect_md_files(
            tmp.path(),
            tmp.path(),
            &[],
            &policy,
            &mut files,
            &mut collection_sources,
            &mut scan_failure_count,
        )
        .expect("collect files");
        let mut rels = files
            .iter()
            .map(|source| {
                source
                    .path
                    .strip_prefix(tmp.path())
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

        let entry =
            build_entry_with_dates(tmp.path(), &file, None, MarkdownProjection::Discoverable)
                .expect("build entry");
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

        let entry =
            build_entry_with_dates(tmp.path(), &file, None, MarkdownProjection::Discoverable)
                .expect("build entry");

        assert_eq!(entry.rel_path, "broken.md");
        assert_eq!(entry.title, "Broken");
        assert_eq!(entry.fields_json, "{}");
        assert_eq!(entry.body_preview, raw);
    }

    #[test]
    fn df_087_build_entry_uses_ancestor_only_membership_for_owner_readmes() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join("notes")).unwrap();
        std::fs::create_dir_all(tmp.path().join("archive")).unwrap();
        std::fs::write(tmp.path().join("schema.yaml"), "columns: []\nviews: []\n").unwrap();
        std::fs::write(tmp.path().join("README.md"), "# Owner").unwrap();
        std::fs::write(tmp.path().join("child.md"), "# Child").unwrap();
        std::fs::write(tmp.path().join("notes/README.md"), "# Notes").unwrap();
        std::fs::write(
            tmp.path().join("archive/schema.yaml"),
            "columns: []\nviews: []\n",
        )
        .unwrap();
        std::fs::write(tmp.path().join("archive/README.md"), "# Archive").unwrap();
        std::fs::write(tmp.path().join("archive/item.md"), "# Archived item").unwrap();

        let owner = build_entry_with_dates(
            tmp.path(),
            &tmp.path().join("README.md"),
            None,
            MarkdownProjection::Discoverable,
        )
        .expect("build owner");
        assert_eq!(owner.collection_root_path, None);
        assert!(!owner.in_collection);

        for path in ["child.md", "notes/README.md", "archive/README.md"] {
            let entry = build_entry_with_dates(
                tmp.path(),
                &tmp.path().join(path),
                None,
                MarkdownProjection::Discoverable,
            )
            .expect("build root member");
            assert_eq!(entry.collection_root_path.as_deref(), Some("."));
            assert!(entry.in_collection);
        }

        let nested = build_entry_with_dates(
            tmp.path(),
            &tmp.path().join("archive/item.md"),
            None,
            MarkdownProjection::Discoverable,
        )
        .expect("build nested member");
        assert_eq!(nested.collection_root_path.as_deref(), Some("archive"));
        assert!(nested.in_collection);
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

    #[test]
    fn df_088_inventory_keeps_hidden_collection_members_but_not_hidden_standalone_pages() {
        let collection = TempDir::new().unwrap();
        write_tree_config(&collection, vec!["hidden.md", "notes"], vec![]);
        std::fs::write(
            collection.path().join("schema.yaml"),
            "columns: []\nviews: []\n",
        )
        .unwrap();
        std::fs::create_dir_all(collection.path().join("notes")).unwrap();
        std::fs::write(collection.path().join("hidden.md"), "hidden").unwrap();
        std::fs::write(collection.path().join("notes/README.md"), "notes").unwrap();
        std::fs::write(collection.path().join("visible.md"), "visible").unwrap();
        std::fs::write(collection.path().join(".gitignore"), "git-hidden.md\n").unwrap();
        std::fs::write(collection.path().join("git-hidden.md"), "git hidden").unwrap();

        let inventory = collect_reindex_inventory(collection.path(), &[]).unwrap();
        let mut sources = inventory
            .markdown_sources
            .iter()
            .map(|source| {
                (
                    source
                        .path
                        .strip_prefix(collection.path())
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/"),
                    source.projection,
                )
            })
            .collect::<Vec<_>>();
        sources.sort_by(|left, right| left.0.cmp(&right.0));
        assert_eq!(
            sources,
            vec![
                (
                    "git-hidden.md".to_string(),
                    MarkdownProjection::CollectionMemberOnly,
                ),
                (
                    "hidden.md".to_string(),
                    MarkdownProjection::CollectionMemberOnly,
                ),
                (
                    "notes/README.md".to_string(),
                    MarkdownProjection::CollectionMemberOnly,
                ),
                ("visible.md".to_string(), MarkdownProjection::Discoverable,),
            ]
        );

        let standalone = TempDir::new().unwrap();
        write_tree_config(&standalone, vec!["hidden.md"], vec![]);
        std::fs::write(standalone.path().join("hidden.md"), "hidden").unwrap();
        let inventory = collect_reindex_inventory(standalone.path(), &[]).unwrap();
        assert!(inventory.markdown_sources.is_empty());
    }

    #[tokio::test]
    async fn df_088_full_reindex_keeps_hidden_member_out_of_global_projections() {
        let tmp = TempDir::new().unwrap();
        write_tree_config(&tmp, vec!["hidden.md"], vec![]);
        std::fs::create_dir_all(tmp.path().join(".svode")).unwrap();
        std::fs::write(
            tmp.path().join("schema.yaml"),
            "columns:\n  - { name: Key, type: unique_id, prefix: HID, next: 8 }\nviews: []\n",
        )
        .unwrap();
        std::fs::write(
            tmp.path().join("hidden.md"),
            "---\ntitle: Hidden Needle\nKey: 7\n---\nhidden-body-token [private](visible.md)",
        )
        .unwrap();
        std::fs::write(tmp.path().join("visible.md"), "# Visible").unwrap();
        let pool = crate::index::db::create_pool(&tmp.path().join(".svode/index.db"))
            .await
            .unwrap();
        crate::index::db::ensure_schema(&pool).await.unwrap();

        full_reindex(&pool, tmp.path(), &[]).await.unwrap();

        let row: (Option<String>, i64, i64, String, String) = sqlx::query_as(
            "SELECT collection_root_path,in_collection,is_discoverable,body_preview,fields \
             FROM entries WHERE file_path = 'hidden.md'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.0.as_deref(), Some("."));
        assert_eq!((row.1, row.2), (1, 0));
        assert!(row.3.is_empty());
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&row.4).unwrap()["Key"],
            7
        );
        let collection_rows = crate::properties::query_entries(
            &pool,
            &crate::properties::ActorCatalogState::new(),
            None,
            &tmp.path().to_string_lossy(),
            ".",
            None,
            None,
            Some(false),
            None,
            None,
        )
        .await
        .unwrap();
        assert!(
            collection_rows
                .iter()
                .any(|entry| entry.path == "hidden.md")
        );

        assert!(
            crate::index::search::search_by_title(&pool, "Hidden Needle", 10)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            crate::index::search::search_fts(&pool, "hidden-body-token", None, None, 10)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            crate::index::search::search_unique_id_exact(&pool, tmp.path(), "HID-7", 10)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            crate::index::search::recent(&pool, 10)
                .await
                .unwrap()
                .iter()
                .all(|result| result.path != "hidden.md")
        );
        for table in [
            "knowledge_documents",
            "knowledge_fragments",
            "knowledge_links",
        ] {
            let count: i64 = sqlx::query_scalar(&format!(
                "SELECT COUNT(*) FROM {table} WHERE source_path = 'hidden.md'"
            ))
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(count, 0, "{table}");
        }
        std::fs::remove_file(tmp.path().join("schema.yaml")).unwrap();
        full_reindex(&pool, tmp.path(), &[]).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM entries WHERE file_path = 'hidden.md'",
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            0
        );
        std::fs::write(tmp.path().join("schema.yaml"), "columns: [\n").unwrap();
        full_reindex(&pool, tmp.path(), &[]).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM entries WHERE file_path = 'hidden.md'",
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            0
        );
        std::fs::write(
            tmp.path().join("schema.yaml"),
            "columns:\n  - { name: Key, type: unique_id, prefix: HID, next: 8 }\nviews: []\n",
        )
        .unwrap();
        full_reindex(&pool, tmp.path(), &[]).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM entries WHERE file_path = 'hidden.md' \
                 AND in_collection = 1 AND is_discoverable = 0",
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn df_088_root_and_registered_space_fixture_preserves_hidden_page_shapes() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write_tree_config(
            &tmp,
            vec!["roadmap.md", "notes", "archive", "nested"],
            vec![],
        );
        std::fs::write(root.join("schema.yaml"), "columns: []\nviews: []\n").unwrap();
        std::fs::write(root.join("README.md"), "# Root owner").unwrap();
        std::fs::write(root.join("roadmap.md"), "# Roadmap").unwrap();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(root.join("notes/README.md"), "# Notes").unwrap();
        std::fs::create_dir_all(root.join("archive")).unwrap();
        std::fs::write(root.join("archive/schema.yaml"), "columns: []\nviews: []\n").unwrap();
        std::fs::write(root.join("archive/README.md"), "# Archive").unwrap();
        std::fs::create_dir_all(root.join("nested")).unwrap();
        std::fs::write(root.join("nested/README.md"), "# Nested").unwrap();
        std::fs::write(root.join("nested/deep.md"), "# Deep").unwrap();

        let child = root.join("team");
        std::fs::create_dir_all(child.join(".svode")).unwrap();
        std::fs::write(child.join("schema.yaml"), "columns: []\nviews: []\n").unwrap();
        std::fs::write(child.join("README.md"), "# Team owner").unwrap();
        std::fs::write(child.join("item.md"), "# Team item").unwrap();
        std::fs::write(child.join(".gitignore"), "item.md\n").unwrap();

        let root_pool = crate::index::db::create_pool(&root.join(".svode/index.db"))
            .await
            .unwrap();
        crate::index::db::ensure_schema(&root_pool).await.unwrap();
        full_reindex(&root_pool, root, &["team".to_string()])
            .await
            .unwrap();

        let direct = crate::properties::query_entries(
            &root_pool,
            &crate::properties::ActorCatalogState::new(),
            None,
            &root.to_string_lossy(),
            ".",
            None,
            None,
            Some(false),
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            direct
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            vec![
                "archive/README.md",
                "nested/README.md",
                "notes/README.md",
                "roadmap.md",
            ]
        );

        let nested = crate::properties::query_entries(
            &root_pool,
            &crate::properties::ActorCatalogState::new(),
            None,
            &root.to_string_lossy(),
            ".",
            None,
            None,
            Some(true),
            None,
            None,
        )
        .await
        .unwrap();
        let mut nested_paths = nested
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();
        nested_paths.sort_unstable();
        assert_eq!(
            nested_paths,
            vec![
                "archive/README.md",
                "nested/README.md",
                "nested/deep.md",
                "notes/README.md",
                "roadmap.md",
            ]
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM entries WHERE in_collection = 1 AND is_discoverable = 0",
            )
            .fetch_one(&root_pool)
            .await
            .unwrap(),
            5
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM entries WHERE file_path LIKE 'team/%'",
            )
            .fetch_one(&root_pool)
            .await
            .unwrap(),
            0
        );

        let child_pool = crate::index::db::create_pool(&child.join(".svode/index.db"))
            .await
            .unwrap();
        crate::index::db::ensure_schema(&child_pool).await.unwrap();
        full_reindex(&child_pool, &child, &[]).await.unwrap();
        assert_eq!(
            sqlx::query_as::<_, (i64, i64, i64)>(
                "SELECT COUNT(*),MAX(in_collection),MAX(is_discoverable) FROM entries \
                 WHERE file_path = 'item.md'",
            )
            .fetch_one(&child_pool)
            .await
            .unwrap(),
            (1, 1, 0)
        );

        write_tree_config(
            &tmp,
            vec!["roadmap.md", "notes", "archive", "nested"],
            vec!["roadmap.md"],
        );
        full_reindex(&root_pool, root, &["team".to_string()])
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_as::<_, (i64, i64)>(
                "SELECT COUNT(*),MAX(is_discoverable) FROM entries WHERE file_path = 'roadmap.md'",
            )
            .fetch_one(&root_pool)
            .await
            .unwrap(),
            (1, 1)
        );

        std::fs::write(child.join(".gitignore"), "item.md\n!item.md\n").unwrap();
        full_reindex(&child_pool, &child, &[]).await.unwrap();
        assert_eq!(
            sqlx::query_as::<_, (i64, i64)>(
                "SELECT COUNT(*),MAX(is_discoverable) FROM entries WHERE file_path = 'item.md'",
            )
            .fetch_one(&child_pool)
            .await
            .unwrap(),
            (1, 1)
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
    pub is_discoverable: bool,
    pub knowledge: Option<crate::index::knowledge::KnowledgeArtifact>,
    pub source_diagnostic: Option<String>,
}

/// Build an `IndexedEntry` using precomputed runtime date overrides when
/// available. The filesystem remains the fallback for untracked, dirty, or
/// unavailable Git history cases.
pub(crate) fn build_entry_with_dates(
    space_dir: &Path,
    abs_path: &Path,
    date_override: Option<&EntryDateOverride>,
    projection: MarkdownProjection,
) -> Result<IndexedEntry, AppError> {
    let rel_path = repo_relative_from_base(space_dir, abs_path, RootMode::Reject)?;

    let source_record = markdown_source_record(space_dir, abs_path, projection)?;
    if let Some(code) = source_record.diagnostic_code {
        return Err(AppError::Index(format!(
            "knowledge source {rel_path} was skipped: {code}"
        )));
    }

    let raw = fs::read_to_string(abs_path)?;

    let fs_created = file_created_iso(abs_path);
    let fs_updated = file_modified_iso(abs_path);
    let created = date_override
        .and_then(|dates| dates.created.clone())
        .unwrap_or(fs_created);
    let updated = date_override
        .and_then(|dates| dates.updated.clone())
        .unwrap_or(fs_updated);
    let (title, icon, description, cover_json, fields_json, body_preview, source_diagnostic) =
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
                    None,
                )
            }
            frontmatter::ParseStatus::Missing { body } => (
                title_for_path(abs_path),
                None,
                None,
                None,
                "{}".to_string(),
                body,
                None,
            ),
            frontmatter::ParseStatus::Malformed { body, .. } => (
                title_for_path(abs_path),
                None,
                None,
                None,
                "{}".to_string(),
                body,
                Some("invalid_frontmatter".to_string()),
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

    let knowledge_collection_root = collection_root_path.clone().or_else(|| {
        abs_path
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| name.eq_ignore_ascii_case("README.md"))
            .and_then(|_| abs_path.parent())
            .filter(|parent| parent.join("schema.yaml").is_file())
            .and_then(|parent| {
                if parent == space_dir {
                    Some(".".to_string())
                } else {
                    repo_relative_from_base(space_dir, parent, RootMode::Reject).ok()
                }
            })
    });
    let knowledge = if projection.is_discoverable() {
        let relations = crate::properties::knowledge_projection::project_entry_relations(
            space_dir,
            &rel_path,
            &fields_json,
        )
        .unwrap_or_else(|error| {
            tracing::warn!("knowledge relation projection failed for {rel_path}: {error}");
            Vec::new()
        });
        crate::index::knowledge::build_file_artifact(
            &rel_path,
            &title,
            &updated,
            &raw,
            &body_preview,
            knowledge_collection_root.as_deref(),
            &relations,
        )
    } else {
        None
    };

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
        body_preview: if projection.is_discoverable() {
            body_preview
        } else {
            String::new()
        },
        is_discoverable: projection.is_discoverable(),
        knowledge,
        source_diagnostic,
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

pub(crate) fn file_modified_iso(path: &Path) -> String {
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
            collection_root_path, in_collection, is_entry_head, fields, body_preview,
            is_discoverable
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            body_preview = excluded.body_preview,
            is_discoverable = excluded.is_discoverable
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
    .bind(if entry.is_discoverable { 1_i64 } else { 0_i64 })
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
#[cfg(test)]
pub async fn full_reindex(
    pool: &SqlitePool,
    space_dir: &Path,
    skip_top_level: &[String],
) -> Result<(), AppError> {
    full_reindex_for_target(pool, space_dir, space_dir, skip_top_level).await
}

pub async fn full_reindex_for_target(
    pool: &SqlitePool,
    project_dir: &Path,
    space_dir: &Path,
    skip_top_level: &[String],
) -> Result<(), AppError> {
    tracing::debug!("full reindex of space: {}", space_dir.display());

    // ── Phase 1: filesystem walk + parse, no locks held ──────────────────
    let inventory_dir = space_dir.to_path_buf();
    let inventory_skip = skip_top_level.to_vec();
    let inventory = tokio::task::spawn_blocking(move || {
        collect_reindex_inventory(&inventory_dir, &inventory_skip)
    })
    .await
    .map_err(|error| AppError::Index(format!("source inventory task failed: {error}")))??;
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
    let entry_date_overrides = derive_date_overrides(space_dir, &md_rel_paths).await;

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
        match crate::properties::knowledge_projection::project_collection(
            space_dir,
            collection_path,
        ) {
            Ok(projection) => {
                let schema_path = if collection_path == "." {
                    space_dir.join("schema.yaml")
                } else {
                    space_dir.join(collection_path).join("schema.yaml")
                };
                knowledge_artifacts.push(crate::index::knowledge::build_collection_artifact(
                    &projection,
                    &file_modified_iso(&schema_path),
                ));
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
                    .map(crate::index::knowledge::build_agent_artifact),
            );
            source_manifest.extend(
                knowledge_artifacts
                    .iter()
                    .filter(|artifact| {
                        matches!(artifact.kind.as_str(), "agent_instruction" | "skill")
                    })
                    .map(|artifact| {
                        crate::index::reconcile::SourceManifestRecord::agent_context(
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
                .map(crate::index::knowledge::build_agent_applicability)
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

    crate::index::knowledge::replace_all(
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
    crate::index::reconcile::replace_source_manifest(&mut tx, &source_manifest).await?;
    crate::index::reconcile::advance_generation(&mut tx, true, true).await?;

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

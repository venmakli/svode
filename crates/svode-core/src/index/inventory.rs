use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::content_tree::policy::{TreeIgnorePolicy, TreePathKind};
use crate::git::path::{RootMode, repo_relative_from_base};
use crate::index::IndexError;
use crate::index::manifest::SourceManifestRecord;

pub const MAX_INDEXED_MARKDOWN_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug)]
pub struct ReindexInventory {
    pub markdown_sources: Vec<MarkdownInventorySource>,
    pub collection_sources: Vec<CollectionInventorySource>,
    pub source_manifest: Vec<SourceManifestRecord>,
    pub scan_failure_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarkdownProjection {
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

    pub fn is_discoverable(self) -> bool {
        self == Self::Discoverable
    }
}

#[derive(Debug)]
pub struct MarkdownInventorySource {
    pub path: PathBuf,
    pub projection: MarkdownProjection,
}

#[derive(Debug)]
pub struct CollectionInventorySource {
    pub path: String,
    pub discoverable: bool,
}

pub fn collect_reindex_inventory(
    space_dir: &Path,
    skip_top_level: &[String],
) -> Result<ReindexInventory, IndexError> {
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

pub fn markdown_source_record(
    space_dir: &Path,
    path: &Path,
    projection: MarkdownProjection,
) -> Result<SourceManifestRecord, IndexError> {
    let rel_path = repo_relative_from_base(space_dir, path, RootMode::Reject)?;
    let diagnostic_code = if crate::index::knowledge_artifact::is_secret_like_source(&rel_path) {
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
) -> Result<SourceManifestRecord, IndexError> {
    let source_path = repo_relative_from_base(space_dir, path, RootMode::Reject)?;
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Err(IndexError::Index(format!(
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
        checked_at: crate::index::manifest::now(),
        diagnostic_code,
    })
}

fn source_content_fingerprint(path: &Path) -> Result<String, IndexError> {
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
pub fn collect_md_files(
    base: &Path,
    dir: &Path,
    skip_top_level: &[String],
    policy: &TreeIgnorePolicy,
    out: &mut Vec<MarkdownInventorySource>,
    collection_sources: &mut Vec<CollectionInventorySource>,
    scan_failure_count: &mut usize,
) -> Result<(), IndexError> {
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

pub fn markdown_projection(
    space_dir: &Path,
    path: &Path,
    policy: &TreeIgnorePolicy,
) -> Result<Option<MarkdownProjection>, IndexError> {
    let rel_path = path.strip_prefix(space_dir).unwrap_or(path);
    if policy.is_system_ignored_rel(rel_path, TreePathKind::File) {
        return Ok(None);
    }
    if !policy.is_ignored_rel(rel_path, TreePathKind::File) {
        return Ok(Some(MarkdownProjection::Discoverable));
    }
    let rel_path = repo_relative_from_base(space_dir, path, RootMode::Reject)?;
    match crate::collections::schema::resolve_collection_schema_result(space_dir, &rel_path) {
        Ok(Some(_)) => Ok(Some(MarkdownProjection::CollectionMemberOnly)),
        Ok(None) => Ok(None),
        Err(error) => {
            tracing::warn!("hidden source {rel_path} has no valid Collection membership: {error}");
            Ok(None)
        }
    }
}

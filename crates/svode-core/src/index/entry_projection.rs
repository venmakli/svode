use crate::git::path::{RootMode, normalize_repo_relative, repo_relative_from_base};
use crate::index::IndexError;
use crate::index::inventory::{MarkdownProjection, markdown_source_record};
use crate::index::model::IndexedEntry;
use crate::page::dates::EntryDateOverride;
use chrono::{DateTime, SecondsFormat, Utc};
use std::fs;
use std::path::Path;
use std::time::SystemTime;

fn format_system_time(time: SystemTime) -> String {
    let dt: DateTime<Utc> = time.into();
    dt.to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// Build an `IndexedEntry` using precomputed runtime date overrides when
/// available. The filesystem remains the fallback for untracked, dirty, or
/// unavailable Git history cases.
pub fn build_entry_with_dates(
    space_dir: &Path,
    abs_path: &Path,
    date_override: Option<&EntryDateOverride>,
    projection: MarkdownProjection,
) -> Result<IndexedEntry, IndexError> {
    let rel_path = repo_relative_from_base(space_dir, abs_path, RootMode::Reject)?;

    let source_record = markdown_source_record(space_dir, abs_path, projection)?;
    if let Some(code) = source_record.diagnostic_code {
        return Err(IndexError::Index(format!(
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
        match crate::page::parse_markdown(&raw, &rel_path) {
            crate::page::ParsedMarkdown::Valid(meta, body) => {
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
                let title = if meta.title_present {
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
            crate::page::ParsedMarkdown::Missing(body) => (
                title_for_path(abs_path),
                None,
                None,
                None,
                "{}".to_string(),
                body,
                None,
            ),
            crate::page::ParsedMarkdown::Malformed(_, body) => (
                title_for_path(abs_path),
                None,
                None,
                None,
                "{}".to_string(),
                body,
                Some("invalid_frontmatter".to_string()),
            ),
        };

    let collection_root_path =
        match crate::collections::schema::resolve_collection_schema_result(space_dir, &rel_path) {
            Ok(Some((_, root))) => Some(root_path_for_index(&root)),
            Ok(None) => None,
            Err(e) => {
                tracing::warn!(
                    "schema resolver failed for {rel_path}; indexing as standalone: {e}"
                );
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
        let relations = crate::collections::knowledge_projection::project_entry_relations(
            space_dir,
            &rel_path,
            &fields_json,
        )
        .unwrap_or_else(|error| {
            tracing::warn!("knowledge relation projection failed for {rel_path}: {error}");
            Vec::new()
        });
        crate::index::knowledge_artifact::build_file_artifact(
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
    let rel = normalize_repo_relative(&path.to_string_lossy(), RootMode::Allow)
        .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"));
    if rel.is_empty() { ".".to_string() } else { rel }
}

fn parent_path_for(rel_path: &str) -> Result<String, IndexError> {
    let parent = Path::new(rel_path)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| normalize_repo_relative(&p.to_string_lossy(), RootMode::Allow))
        .transpose()?;
    Ok(parent.unwrap_or_else(|| ".".to_string()))
}

fn title_for_path(path: &Path) -> String {
    crate::page::fallback_title(&path.to_string_lossy())
}

/// Serialize custom frontmatter fields as JSON for the `fields` column.
/// System fields are stored in dedicated columns.
/// `serde_yml::Value` round-trips through `serde_json::Value` for normal scalars,
/// sequences, and string-keyed mappings. YAML-only constructs (tags, non-string
/// keys) fail; we log and fall back to `{}` rather than crash a reindex.
fn serialize_fields(meta: &crate::page::PageSourceMeta, rel_path: &str) -> String {
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

pub fn file_modified_iso(path: &Path) -> String {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .map(format_system_time)
        .unwrap_or_else(|_| {
            let now: DateTime<Utc> = SystemTime::now().into();
            now.to_rfc3339_opts(SecondsFormat::Secs, true)
        })
}

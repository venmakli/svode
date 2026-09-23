mod model;
mod persistence;

pub use model::{
    Cover, DeleteResult, Entry, EntryDetailForm, EntryDetailState, EntryMeta, EntryWarning,
    WriteResult,
};
pub use persistence::{entry_from_source, read, read_with_git_dates, replaced_by_staged_copy};

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::content_tree;
use crate::index::backlinks::{BacklinkIndex, ModifiedLinkSource};
use crate::page::PageError;
use crate::page::filename::{self, FilenameProjection};
use crate::page::frontmatter;

use persistence::{
    apply_runtime_metadata, fallback_title_for_path, meta_for_file_without_frontmatter,
    refresh_markdown_copy_metadata,
};

/// Resolve an absolute path from space root + relative path.
fn resolve(space: &str, rel: &str) -> PathBuf {
    Path::new(space).join(rel)
}

pub use crate::page::naming::slugify;

pub use crate::page::frontmatter::{apply_entry_field_update, title_from_stem};

/// Append a filename to order.json for a given directory key.
fn order_append(space: &Path, dir_key: &str, name: &str) {
    let mut order = content_tree::read_order(space);
    order
        .entry(dir_key.to_string())
        .or_default()
        .push(name.to_string());
    let _ = content_tree::write_order(space, &order);
}

/// Rename an entry in order.json (replace old_name with new_name in the given directory).
fn order_rename(space: &Path, dir_key: &str, old_name: &str, new_name: &str) {
    let _ = order_rename_checked(space, dir_key, old_name, new_name);
}

fn order_rename_checked(
    space: &Path,
    dir_key: &str,
    old_name: &str,
    new_name: &str,
) -> Result<(), PageError> {
    let mut order = content_tree::read_order(space);
    if let Some(list) = order.get_mut(dir_key) {
        if let Some(pos) = list.iter().position(|name| name == old_name) {
            list[pos] = new_name.to_string();
            content_tree::write_order(space, &order)?;
        }
    }
    Ok(())
}

fn order_insert_after(space: &Path, dir_key: &str, after_name: &str, name: &str) {
    let mut order = content_tree::read_order(space);
    let list = order.entry(dir_key.to_string()).or_default();
    if list.iter().any(|item| item == name) {
        return;
    }
    if let Some(pos) = list.iter().position(|item| item == after_name) {
        list.insert(pos + 1, name.to_string());
    } else {
        list.push(name.to_string());
    }
    let _ = content_tree::write_order(space, &order);
}

fn order_remove_key(space: &Path, dir_key: &str) {
    let mut order = content_tree::read_order(space);
    if order.remove(dir_key).is_some() {
        let _ = content_tree::write_order(space, &order);
    }
}

fn dir_key_for(parent: &Path) -> String {
    if parent.as_os_str().is_empty() {
        ".".to_string()
    } else {
        parent.to_string_lossy().replace('\\', "/")
    }
}

fn rel_from_abs(space: &Path, path: &Path) -> String {
    path.strip_prefix(space)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn humanize_slug(name: &str) -> String {
    let mut chars = name.replace(['-', '_'], " ").chars().collect::<Vec<_>>();
    if let Some(first) = chars.first_mut() {
        first.make_ascii_uppercase();
    }
    chars.into_iter().collect()
}

fn unique_child_path(parent: &Path, stem: &str, extension: Option<&str>) -> PathBuf {
    let make = |candidate: &str| match extension {
        Some(ext) => parent.join(format!("{candidate}.{ext}")),
        None => parent.join(candidate),
    };
    let first = make(stem);
    if !first.exists() {
        return first;
    }
    for i in 1..=1000 {
        let candidate = make(&format!("{stem}-{i}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    make(&format!(
        "{stem}-{}",
        ulid::Ulid::new().to_string().to_lowercase()
    ))
}

pub fn filename_projection_warning(
    projection: &FilenameProjection,
    actual_path: &str,
) -> Option<EntryWarning> {
    projection
        .is_lossy()
        .then(|| EntryWarning::filename_projection(actual_path, &projection.reason_codes()))
}

pub fn filename_allocation_warnings(
    requested: &FilenameProjection,
    actual: &FilenameProjection,
    actual_path: &str,
) -> Vec<EntryWarning> {
    let mut warnings = filename_projection_warning(actual, actual_path)
        .into_iter()
        .collect::<Vec<_>>();
    if actual.stem != requested.stem {
        warnings.push(EntryWarning::filename_collision_allocated(actual_path));
    }
    warnings
}

fn rewrite_relations_after_fs_move(
    space: &Path,
    old_rel: &str,
    new_rel: &str,
    old_abs: &Path,
    new_abs: &Path,
) -> Result<(), PageError> {
    rewrite_relations_after_fs_move_with_project(
        space, None, old_rel, new_rel, old_abs, new_abs, None,
    )
}

fn rewrite_relations_after_fs_move_with_project(
    space: &Path,
    project_path: Option<&str>,
    old_rel: &str,
    new_rel: &str,
    old_abs: &Path,
    new_abs: &Path,
    authorized_paths: Option<&[PathBuf]>,
) -> Result<(), PageError> {
    let result = if let Some(authorized_paths) = authorized_paths {
        crate::collections::engine::rewrite_relation_paths_for_move_with_authorized_plan(
            &space.to_string_lossy(),
            project_path,
            old_rel,
            new_rel,
            authorized_paths,
        )
    } else {
        crate::collections::engine::rewrite_relation_paths_for_move_with_project(
            &space.to_string_lossy(),
            project_path,
            old_rel,
            new_rel,
        )
    };
    if let Err(error) = result {
        let _ = fs::rename(new_abs, old_abs);
        return Err(error.into());
    }
    Ok(())
}

fn collect_entry_md_files(root: &Path, out: &mut Vec<PathBuf>) -> Result<(), PageError> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            collect_entry_md_files(&path, out)?;
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("md") {
            out.push(path);
        }
    }
    Ok(())
}

fn normalize_entry_path_arg(space: &Path, path: &str) -> Result<String, PageError> {
    let rel = path.trim_matches('/').replace('\\', "/");
    if rel.is_empty() {
        return Err(PageError::FileNotFound(path.to_string()));
    }
    if !space.join(&rel).exists() {
        return Err(PageError::FileNotFound(rel));
    }
    Ok(rel)
}

/// Create a new entry on disk. Returns the created Entry.
#[allow(dead_code)]
#[cfg(test)]
pub fn create(space: &str, parent_path: Option<&str>, title: &str) -> Result<Entry, PageError> {
    create_with_contextual_defaults(space, parent_path, title, None)
}

/// Create a new entry on disk with optional schema-validated contextual defaults.
#[cfg(test)]
pub fn create_with_contextual_defaults(
    space: &str,
    parent_path: Option<&str>,
    title: &str,
    contextual_defaults: Option<HashMap<String, serde_yml::Value>>,
) -> Result<Entry, PageError> {
    create_with_options(space, parent_path, title, contextual_defaults, false, false)
}

#[cfg(test)]
pub fn create_with_options(
    space: &str,
    parent_path: Option<&str>,
    title: &str,
    contextual_defaults: Option<HashMap<String, serde_yml::Value>>,
    allocate_unique_title: bool,
    as_readme: bool,
) -> Result<Entry, PageError> {
    let created =
        create_source_with_options(space, parent_path, title, allocate_unique_title, as_readme)?;
    let mut metadata = created.meta.clone();
    crate::collections::engine::apply_schema_defaults_for_path(
        space,
        &created.path,
        &mut metadata,
    )?;
    if let Some(contextual_defaults) = contextual_defaults.as_ref() {
        crate::collections::engine::apply_contextual_defaults_for_path(
            space,
            &created.path,
            &mut metadata,
            contextual_defaults,
        )?;
    }
    crate::collections::engine::assign_unique_id_to_meta_for_path(
        space,
        &created.path,
        &mut metadata,
    )?;
    write_under_name_lock(
        space,
        &created.path,
        &created.body,
        None,
        None,
        None,
        Some(metadata),
        None,
        None,
        true,
        None,
        None,
    )?;
    read(space, &created.path)
}

pub fn create_source_with_options(
    space: &str,
    parent_path: Option<&str>,
    title: &str,
    allocate_unique_title: bool,
    as_readme: bool,
) -> Result<Entry, PageError> {
    crate::page::naming::with_document_name_lock(space, || {
        create_source_with_options_inner(
            space,
            parent_path,
            title,
            allocate_unique_title,
            as_readme,
        )
    })
}

#[derive(Debug, Clone)]
pub struct PlannedSourceCreate {
    pub title: String,
    pub path: String,
}

pub fn planned_source_create(
    space: &str,
    parent_path: Option<&str>,
    title: &str,
    allocate_unique_title: bool,
    as_readme: bool,
) -> Result<PlannedSourceCreate, PageError> {
    let parent_path = parent_path
        .map(str::trim)
        .filter(|parent| !parent.is_empty());
    let initial_scope_path = if as_readme {
        parent_path
            .map(|parent| format!("{parent}/README.md"))
            .unwrap_or_else(|| "README.md".to_string())
    } else {
        parent_path
            .map(|parent| format!("{parent}/.svode-name-probe.md"))
            .unwrap_or_else(|| ".svode-name-probe.md".to_string())
    };
    let title = if allocate_unique_title {
        crate::page::naming::allocate_document_title(Path::new(space), &initial_scope_path, title)?
    } else {
        crate::page::naming::ensure_document_name_available(
            Path::new(space),
            &initial_scope_path,
            title,
        )?;
        title.to_string()
    };
    let projection = filename::project(&title);
    let path = if as_readme {
        parent_path
            .map(|parent| format!("{parent}/README.md"))
            .unwrap_or_else(|| "README.md".to_string())
    } else {
        let parent_abs = parent_path
            .map(|parent| resolve(space, parent))
            .unwrap_or_else(|| PathBuf::from(space));
        let (abs_path, _) =
            filename::allocate_available_path(&parent_abs, &projection, Some("md"))?;
        rel_from_abs(Path::new(space), &abs_path)
    };
    Ok(PlannedSourceCreate { title, path })
}

fn create_source_with_options_inner(
    space: &str,
    parent_path: Option<&str>,
    title: &str,
    allocate_unique_title: bool,
    as_readme: bool,
) -> Result<Entry, PageError> {
    let parent_path = parent_path
        .map(str::trim)
        .filter(|parent| !parent.is_empty());
    let initial_scope_path = if as_readme {
        parent_path
            .map(|parent| format!("{parent}/README.md"))
            .unwrap_or_else(|| "README.md".to_string())
    } else {
        parent_path
            .map(|parent| format!("{parent}/.svode-name-probe-{}.md", ulid::Ulid::new()))
            .unwrap_or_else(|| format!(".svode-name-probe-{}.md", ulid::Ulid::new()))
    };
    let title = if allocate_unique_title {
        crate::page::naming::allocate_document_title(Path::new(space), &initial_scope_path, title)?
    } else {
        crate::page::naming::ensure_document_name_available(
            Path::new(space),
            &initial_scope_path,
            title,
        )?;
        title.to_string()
    };
    let projection = filename::project(&title);

    let (rel_path, abs_path, applied_projection) = if as_readme {
        let rel_path = parent_path
            .map(|parent| format!("{parent}/README.md"))
            .unwrap_or_else(|| "README.md".to_string());
        let abs_path = resolve(space, &rel_path);
        if abs_path.exists() {
            return Err(PageError::FileAlreadyExists(rel_path));
        }
        (rel_path, abs_path, None)
    } else {
        let parent_abs = parent_path
            .map(|parent| resolve(space, parent))
            .unwrap_or_else(|| PathBuf::from(space));
        let (abs_path, applied_projection) =
            filename::allocate_available_path(&parent_abs, &projection, Some("md"))?;
        let rel_path = rel_from_abs(Path::new(space), &abs_path);
        (rel_path, abs_path, Some(applied_projection))
    };

    // Ensure parent directory exists
    if let Some(parent_dir) = abs_path.parent() {
        fs::create_dir_all(parent_dir)?;
    }

    let mut meta = EntryMeta::new_persisted(title);
    let body = "";
    persistence::write_serialized(&abs_path, &meta, body)?;
    apply_runtime_metadata(&mut meta, &abs_path, &rel_path)?;

    // Append to order.json so the new file appears at the end
    let filename = Path::new(&rel_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    if !as_readme {
        let dir_key = parent_path.unwrap_or(".");
        order_append(Path::new(space), dir_key, &filename);
    }

    let warnings = applied_projection
        .as_ref()
        .map(|actual| filename_allocation_warnings(&projection, actual, &rel_path))
        .unwrap_or_default();
    Ok(Entry {
        meta,
        body: body.to_string(),
        path: rel_path,
        warnings,
        name_conflict: None,
        source_version: None,
    })
}

/// Create a bare folder (directory without readme.md).
/// The folder name is the title as-is (no slugify, no transliteration).
/// Returns the relative path of the created folder.
pub fn create_folder(
    space: &str,
    parent_path: Option<&str>,
    name: &str,
) -> Result<String, PageError> {
    let rel_path = match parent_path {
        Some(parent) => format!("{parent}/{name}"),
        None => name.to_string(),
    };

    let abs_path = resolve(space, &rel_path);

    if abs_path.exists() {
        return Err(PageError::FileAlreadyExists(rel_path));
    }

    fs::create_dir_all(&abs_path)?;

    // Git doesn't track empty directories — drop a `.gitkeep` placeholder so
    // `Create <folder>` auto-commit has a tracked file to stage. We keep the
    // file after real children appear (harmless, preserves the structural
    // commit history).
    fs::write(abs_path.join(".gitkeep"), "")?;

    // Append to order.json
    let dir_key = parent_path.unwrap_or(".");
    order_append(Path::new(space), dir_key, name);

    Ok(rel_path)
}

/// Write body content and, when explicitly requested, metadata.
/// Body-only writes preserve existing frontmatter bytes and never materialize
/// runtime fallback metadata. If title changes, the file may be renamed from
/// the shared Unicode-safe filename projection.
/// Returns WriteResult with new_path if a rename occurred.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedWriteRename {
    pub new_path: String,
    pub folder_rename_old: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum EntryFilenamePlan {
    Unchanged(FilenameProjection),
    Rename {
        projection: FilenameProjection,
        rename: PlannedWriteRename,
    },
    Collision(FilenameProjection),
}

fn entry_filename_plan(
    space: &str,
    path: &str,
    title: &str,
) -> Result<EntryFilenamePlan, PageError> {
    let projection = filename::project(title);
    if !crate::page::naming::is_user_document(path) {
        return Ok(EntryFilenamePlan::Unchanged(projection));
    }

    let current = Path::new(path);
    let is_readme = current
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("README.md"));
    if is_readme {
        let Some(parent) = current
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        else {
            return Ok(EntryFilenamePlan::Unchanged(projection));
        };
        let grandparent = parent.parent().unwrap_or(Path::new(""));
        let current_component = parent
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if projection.stem == current_component {
            return Ok(EntryFilenamePlan::Unchanged(projection));
        }
        let target_parent = resolve(space, &grandparent.to_string_lossy());
        if filename::component_conflicts_portably(
            &target_parent,
            &projection.stem,
            Some(current_component),
        )? {
            return Ok(EntryFilenamePlan::Collision(projection));
        }
        let new_dir = if grandparent.as_os_str().is_empty() {
            projection.stem.clone()
        } else {
            format!("{}/{}", grandparent.to_string_lossy(), projection.stem)
        };
        let readme = current.file_name().unwrap_or_default().to_string_lossy();
        return Ok(EntryFilenamePlan::Rename {
            projection,
            rename: PlannedWriteRename {
                new_path: format!("{new_dir}/{readme}"),
                folder_rename_old: Some(parent.to_string_lossy().to_string()),
            },
        });
    }

    let current_component = current
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let target_component = filename::component_name(&projection.stem, Some("md"));
    if target_component == current_component {
        return Ok(EntryFilenamePlan::Unchanged(projection));
    }
    let parent = current.parent().unwrap_or(Path::new(""));
    let target_parent = resolve(space, &parent.to_string_lossy());
    if filename::component_conflicts_portably(
        &target_parent,
        &target_component,
        Some(current_component),
    )? {
        return Ok(EntryFilenamePlan::Collision(projection));
    }
    let new_path = if parent.as_os_str().is_empty() {
        target_component
    } else {
        format!("{}/{target_component}", parent.to_string_lossy())
    };
    Ok(EntryFilenamePlan::Rename {
        projection,
        rename: PlannedWriteRename {
            new_path,
            folder_rename_old: None,
        },
    })
}

pub fn planned_write_rename(
    space: &str,
    path: &str,
    title: Option<&str>,
    skip_rename: bool,
) -> Result<Option<PlannedWriteRename>, PageError> {
    let has_naming_intent = title.is_some() || filename::has_managed_naming_intent(space, path);
    if skip_rename || !has_naming_intent {
        return Ok(None);
    }
    let abs_path = resolve(space, path);
    if !abs_path.exists() {
        return Err(PageError::FileNotFound(path.to_string()));
    }
    let (_, parsed_existing) = persistence::read_existing(&abs_path)?;
    let materialized_title = match &parsed_existing {
        frontmatter::ParseStatus::Valid { meta, .. } => {
            title.or_else(|| meta.frontmatter_keys.title.then_some(meta.title.as_str()))
        }
        frontmatter::ParseStatus::Missing { .. } | frontmatter::ParseStatus::Malformed { .. } => {
            title
        }
    };
    let Some(title) = materialized_title else {
        return Ok(None);
    };
    match entry_filename_plan(space, path, title)? {
        EntryFilenamePlan::Rename { rename, .. } => Ok(Some(rename)),
        EntryFilenamePlan::Unchanged(_) | EntryFilenamePlan::Collision(_) => Ok(None),
    }
}

#[cfg(test)]
pub fn write(
    space: &str,
    path: &str,
    content: &str,
    title: Option<&str>,
    icon: Option<&str>,
    extra: Option<HashMap<String, serde_yml::Value>>,
    _existing_id: Option<&str>,
    backlink_index: Option<&BacklinkIndex>,
    skip_rename: bool,
) -> Result<WriteResult, PageError> {
    write_with_relation_plan(
        space,
        path,
        content,
        title,
        icon,
        extra,
        _existing_id,
        backlink_index,
        skip_rename,
        None,
        None,
    )
}

#[cfg(test)]
pub fn write_with_relation_plan(
    space: &str,
    path: &str,
    content: &str,
    title: Option<&str>,
    icon: Option<&str>,
    extra: Option<HashMap<String, serde_yml::Value>>,
    _existing_id: Option<&str>,
    backlink_index: Option<&BacklinkIndex>,
    skip_rename: bool,
    project_path: Option<&str>,
    relation_paths: Option<&[PathBuf]>,
) -> Result<WriteResult, PageError> {
    if title.is_some() || !skip_rename {
        return crate::page::naming::with_document_name_lock(space, || {
            write_under_name_lock(
                space,
                path,
                content,
                title,
                icon,
                extra,
                None,
                _existing_id,
                backlink_index,
                skip_rename,
                project_path,
                relation_paths,
            )
        });
    }
    write_under_name_lock(
        space,
        path,
        content,
        title,
        icon,
        extra,
        None,
        _existing_id,
        backlink_index,
        skip_rename,
        project_path,
        relation_paths,
    )
}

pub fn write_under_name_lock(
    space: &str,
    path: &str,
    content: &str,
    title: Option<&str>,
    icon: Option<&str>,
    extra: Option<HashMap<String, serde_yml::Value>>,
    metadata: Option<EntryMeta>,
    _existing_id: Option<&str>,
    backlink_index: Option<&BacklinkIndex>,
    skip_rename: bool,
    project_path: Option<&str>,
    relation_paths: Option<&[PathBuf]>,
) -> Result<WriteResult, PageError> {
    let abs_path = resolve(space, path);

    if !abs_path.exists() {
        return Err(PageError::FileNotFound(path.to_string()));
    }

    // Fresh nonce attached to every WriteResult (including no-op early returns)
    // so the watcher can associate its `file:changed` event with the caller's
    // write and the frontend can filter own-write echoes.
    let write_nonce = ulid::Ulid::new().to_string().to_lowercase();

    // Read existing frontmatter to preserve metadata
    let (existing, parsed_existing) = persistence::read_existing(&abs_path)?;
    let fallback_meta = || meta_for_file_without_frontmatter(&abs_path, path);
    let title_changes_fallback = |t: &str| t != fallback_title_for_path(path);
    let extra_changes_empty = |incoming: &HashMap<String, serde_yml::Value>| !incoming.is_empty();
    let materialized_title = match &parsed_existing {
        frontmatter::ParseStatus::Valid { meta, .. } => {
            title.or_else(|| meta.frontmatter_keys.title.then_some(meta.title.as_str()))
        }
        frontmatter::ParseStatus::Missing { .. } | frontmatter::ParseStatus::Malformed { .. } => {
            title
        }
    }
    .map(str::to_string);
    let has_naming_intent =
        !skip_rename && (title.is_some() || filename::has_managed_naming_intent(space, path));
    if has_naming_intent && let Some(materialized_title) = materialized_title.as_deref() {
        crate::page::naming::ensure_document_name_available(
            Path::new(space),
            path,
            materialized_title,
        )?;
    }
    let filename_plan = if has_naming_intent {
        materialized_title
            .as_deref()
            .map(|materialized_title| entry_filename_plan(space, path, materialized_title))
            .transpose()?
    } else {
        None
    };
    let metadata_requested = metadata.is_some()
        || match &parsed_existing {
            frontmatter::ParseStatus::Valid { meta, .. } => {
                has_naming_intent
                    || title.is_some_and(|t| meta.title != t)
                    || icon.is_some_and(|i| meta.icon.as_deref() != Some(i))
                    || extra
                        .as_ref()
                        .is_some_and(|incoming| incoming != &meta.extra)
            }
            frontmatter::ParseStatus::Missing { .. } => {
                has_naming_intent
                    || title.is_some_and(title_changes_fallback)
                    || icon.is_some()
                    || extra.as_ref().is_some_and(extra_changes_empty)
            }
            frontmatter::ParseStatus::Malformed { .. } => {
                title.is_some_and(title_changes_fallback)
                    || icon.is_some()
                    || extra.as_ref().is_some_and(extra_changes_empty)
            }
        };

    if !metadata_requested {
        persistence::write_body_preserving_frontmatter(
            &abs_path,
            &existing,
            parsed_existing,
            content,
        )?;
        return Ok(WriteResult {
            new_path: None,
            modified_files: Vec::new(),
            modified_sources: Vec::new(),
            write_nonce,
            warnings: Vec::new(),
            source_version: None,
        });
    }

    let (mut meta, old_body) = match parsed_existing {
        frontmatter::ParseStatus::Valid { meta, body } => (meta, Some(body)),
        frontmatter::ParseStatus::Missing { .. } => (fallback_meta()?, None),
        frontmatter::ParseStatus::Malformed { message, .. } => {
            return Err(PageError::FrontmatterParse(format!(
                "cannot update metadata while frontmatter is malformed: {message}"
            )));
        }
    };

    if let Some(candidate) = metadata {
        meta = candidate;
    }

    // Update title and icon if provided
    if let Some(t) = title {
        meta.title = t.to_string();
        meta.mark_title_present();
    }
    if let Some(i) = icon {
        meta.icon = Some(i.to_string());
        meta.mark_icon_present();
    }

    // Update custom fields if provided
    if let Some(e) = extra {
        meta.extra = e;
    }

    // Skip the write entirely if neither body nor persisted meta changed AND no
    // rename is pending.
    if let frontmatter::ParseStatus::Valid { meta: old_meta, .. } =
        frontmatter::parse_status(&existing)
    {
        if !has_naming_intent
            && old_body.as_deref() == Some(content)
            && old_meta.title == meta.title
            && old_meta.icon == meta.icon
            && old_meta.description == meta.description
            && old_meta.cover == meta.cover
            && old_meta.extra == meta.extra
            && old_meta.frontmatter_keys == meta.frontmatter_keys
        {
            return Ok(WriteResult {
                new_path: None,
                modified_files: Vec::new(),
                modified_sources: Vec::new(),
                write_nonce,
                warnings: Vec::new(),
                source_version: None,
            });
        }
    }

    persistence::write_serialized(&abs_path, &meta, content)?;
    #[cfg(test)]
    crate::page::write::checkpoint("body")?;

    // Auto-save path: frontmatter + body are already on disk above. Don't
    // rename, don't touch order.json, don't update backlinks in other files.
    // Still re-index the current file so link targets stay fresh.
    if skip_rename {
        if let Some(index) = backlink_index {
            let _ = index.update_file(Path::new(space), path);
        }
        return Ok(WriteResult {
            new_path: None,
            modified_files: Vec::new(),
            modified_sources: Vec::new(),
            write_nonce,
            warnings: Vec::new(),
            source_version: None,
        });
    }

    // Materialize a filename projection only for an explicit naming intent.
    // This preserves legacy and externally-created filenames during ordinary
    // body or metadata saves while still completing a title edit after the
    // debounced field write has already persisted the new title.
    let mut new_path: Option<String> = None;
    let mut warnings = Vec::new();
    match filename_plan {
        Some(EntryFilenamePlan::Unchanged(projection)) => {
            if let Some(warning) = filename_projection_warning(&projection, path) {
                warnings.push(warning);
            }
            filename::clear_managed_naming_intent(space, path);
        }
        Some(EntryFilenamePlan::Collision(projection)) => {
            if let Some(warning) = filename_projection_warning(&projection, path) {
                warnings.push(warning);
            }
            warnings.push(EntryWarning::filename_rename_collision(path));
        }
        Some(EntryFilenamePlan::Rename { projection, rename }) => {
            let target_abs = resolve(space, &rename.new_path);
            if let Some(old_folder) = rename.folder_rename_old.as_deref() {
                let old_folder_abs = resolve(space, old_folder);
                let new_folder_rel = Path::new(&rename.new_path)
                    .parent()
                    .unwrap_or(Path::new(""))
                    .to_string_lossy()
                    .to_string();
                let new_folder_abs = resolve(space, &new_folder_rel);
                fs::rename(&old_folder_abs, &new_folder_abs)?;
                rewrite_relations_after_fs_move_with_project(
                    Path::new(space),
                    project_path,
                    old_folder,
                    &new_folder_rel,
                    &old_folder_abs,
                    &new_folder_abs,
                    relation_paths,
                )?;
            } else {
                fs::rename(&abs_path, &target_abs)?;
                rewrite_relations_after_fs_move_with_project(
                    Path::new(space),
                    project_path,
                    path,
                    &rename.new_path,
                    &abs_path,
                    &target_abs,
                    relation_paths,
                )?;
            }
            if let Some(warning) = filename_projection_warning(&projection, &rename.new_path) {
                warnings.push(warning);
            }
            filename::clear_managed_naming_intent(space, path);
            new_path = Some(rename.new_path);
        }
        None => {}
    }

    // Update order.json if file/folder was renamed
    if let Some(ref np) = new_path {
        let sp_path = Path::new(space);
        let old_name = Path::new(path)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let new_name = Path::new(np.as_str())
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        // For readme.md renames, the "name" in order is the folder name, not "readme.md"
        let is_readme = old_name.eq_ignore_ascii_case("readme.md");
        if is_readme {
            let old_dir_name = Path::new(path)
                .parent()
                .and_then(|p| p.file_name())
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let new_dir_name = Path::new(np.as_str())
                .parent()
                .and_then(|p| p.file_name())
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let grandparent = Path::new(path)
                .parent()
                .and_then(|p| p.parent())
                .unwrap_or(Path::new(""));
            let dir_key = if grandparent.as_os_str().is_empty() {
                ".".to_string()
            } else {
                grandparent.to_string_lossy().to_string()
            };
            // Rename folder entry in parent's order list
            order_rename_checked(sp_path, &dir_key, &old_dir_name, &new_dir_name)?;
            // Rename the key itself (children order moves to new dir name)
            let mut order = content_tree::read_order(sp_path);
            let old_key = if dir_key == "." {
                old_dir_name.clone()
            } else {
                format!("{}/{}", dir_key, old_dir_name)
            };
            if let Some(children) = order.remove(&old_key) {
                let new_key = if dir_key == "." {
                    new_dir_name
                } else {
                    format!("{}/{}", dir_key, new_dir_name)
                };
                order.insert(new_key, children);
                content_tree::write_order(sp_path, &order)?;
            }
        } else {
            // Regular file: dir_key is the parent directory
            let parent_dir = Path::new(path).parent().unwrap_or(Path::new(""));
            let dir_key = if parent_dir.as_os_str().is_empty() {
                ".".to_string()
            } else {
                parent_dir.to_string_lossy().to_string()
            };
            order_rename_checked(sp_path, &dir_key, &old_name, &new_name)?;
        }
    }

    // Update backlink index
    let current_path = new_path.as_deref().unwrap_or(path);
    let mut modified_files = Vec::new();
    if let Some(index) = backlink_index {
        // If renamed, update links in other files. Pass the new title so
        // display text gets refreshed too when it was derived from the old
        // filename stem.
        if let Some(ref np) = new_path {
            modified_files = index
                .update_links_on_rename(Path::new(space), path, np, Some(&meta.title))
                .unwrap_or_default();

            // Readme rename renames the parent folder — every descendant now
            // sits under a new path, so backlinks to those descendants must be
            // rewritten too (URL only, their own titles didn't change).
            let is_readme = Path::new(path)
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.eq_ignore_ascii_case("readme.md"));
            if is_readme {
                let old_folder = Path::new(path)
                    .parent()
                    .map(|p| p.to_string_lossy().to_string());
                let new_folder = Path::new(np)
                    .parent()
                    .map(|p| p.to_string_lossy().to_string());
                if let (Some(of), Some(nf)) = (old_folder, new_folder) {
                    if !of.is_empty() && of != nf {
                        let descendants = index
                            .update_links_on_folder_rename(Path::new(space), &of, &nf)
                            .unwrap_or_default();
                        for m in descendants {
                            if !modified_files.contains(&m) {
                                modified_files.push(m);
                            }
                        }
                    }
                }
            }
        }
        // Re-index the written file
        let _ = index.update_file(Path::new(space), current_path);
    }

    Ok(WriteResult {
        new_path,
        modified_sources: modified_files
            .iter()
            .map(|path| ModifiedLinkSource {
                space_id: None,
                path: path.clone(),
            })
            .collect(),
        modified_files,
        write_nonce,
        warnings,
        source_version: None,
    })
}

#[cfg(test)]
pub fn update_field(
    space: &str,
    project_path: Option<&str>,
    path: &str,
    field: &str,
    value: serde_json::Value,
) -> Result<Entry, PageError> {
    if field == "title" {
        return crate::page::naming::with_document_name_lock(space, || {
            update_field_inner(space, project_path, path, field, value)
        });
    }
    update_field_inner(space, project_path, path, field, value)
}

pub fn replace_created_body(space: &str, path: &str, body: &str) -> Result<Entry, PageError> {
    let abs_path = resolve(space, path);
    let (_, parsed) = persistence::read_existing(&abs_path)?;
    let mut meta = match parsed {
        frontmatter::ParseStatus::Valid { meta, .. } => meta,
        frontmatter::ParseStatus::Missing { .. } => {
            meta_for_file_without_frontmatter(&abs_path, path)?
        }
        frontmatter::ParseStatus::Malformed { message, .. } => {
            return Err(PageError::FrontmatterParse(format!(
                "cannot set initial body while frontmatter is malformed: {message}"
            )));
        }
    };
    persistence::write_serialized(&abs_path, &meta, body)?;
    apply_runtime_metadata(&mut meta, &abs_path, path)?;
    Ok(Entry {
        meta,
        body: body.to_string(),
        path: path.to_string(),
        warnings: Vec::new(),
        name_conflict: None,
        source_version: None,
    })
}

#[cfg(test)]
fn update_field_inner(
    space: &str,
    project_path: Option<&str>,
    path: &str,
    field: &str,
    value: serde_json::Value,
) -> Result<Entry, PageError> {
    let is_custom = !matches!(
        field,
        "created" | "updated" | "title" | "icon" | "description" | "cover"
    );
    if is_custom {
        crate::collections::engine::ensure_entry_field_writable(space, path, field)?;
        let yaml_value = serde_yml::to_value(value.clone()).map_err(|e| {
            PageError::from(crate::page::frontmatter::FrontmatterError::InvalidField(
                format!("{field}: {e}"),
            ))
        })?;
        if let Some((meta, body)) = crate::collections::engine::update_relation_entry_field(
            space,
            project_path,
            path,
            field,
            yaml_value,
        )? {
            let path = crate::collections::schema::normalize_rel_path(path);
            let name_conflict =
                crate::page::naming::document_name_conflict(Path::new(space), &path, &meta.title)?;
            return Ok(Entry {
                meta,
                body,
                path,
                warnings: Vec::new(),
                name_conflict,
                source_version: None,
            });
        }
    }

    let abs_path = resolve(space, path);

    if !abs_path.exists() {
        return Err(PageError::FileNotFound(path.to_string()));
    }

    let (_, parsed) = persistence::read_existing(&abs_path)?;
    let (mut meta, body) = match parsed {
        frontmatter::ParseStatus::Valid { meta, body } => (meta, body),
        frontmatter::ParseStatus::Missing { body } => {
            (meta_for_file_without_frontmatter(&abs_path, path)?, body)
        }
        frontmatter::ParseStatus::Malformed { message, .. } => {
            return Err(PageError::FrontmatterParse(format!(
                "cannot update metadata while frontmatter is malformed: {message}"
            )));
        }
    };
    let previous_title = (field == "title").then(|| meta.title.clone());

    if is_custom && !value.is_null() {
        let yaml_value = serde_yml::to_value(value.clone()).map_err(|e| {
            PageError::from(crate::page::frontmatter::FrontmatterError::InvalidField(
                format!("{field}: {e}"),
            ))
        })?;
        let yaml_value = crate::collections::engine::normalize_entry_field_value(
            space, path, field, yaml_value,
        )?;
        crate::collections::engine::validate_entry_field_value(space, path, field, &yaml_value)?;
        meta.extra.insert(field.to_string(), yaml_value);
    } else if is_custom {
        meta.extra.remove(field);
    } else {
        apply_entry_field_update(&mut meta, field, value)?;
    }
    if field == "title" {
        crate::page::naming::ensure_document_name_available(Path::new(space), path, &meta.title)?;
    }
    persistence::write_serialized(&abs_path, &meta, &body)?;
    if previous_title
        .as_deref()
        .is_some_and(|previous_title| previous_title != meta.title)
        && crate::page::naming::is_user_document(path)
    {
        filename::mark_managed_naming_intent(space, path);
    }
    apply_runtime_metadata(&mut meta, &abs_path, path)?;
    let name_conflict =
        crate::page::naming::document_name_conflict(Path::new(space), path, &meta.title)?;

    Ok(Entry {
        meta,
        body,
        path: path.to_string(),
        warnings: Vec::new(),
        name_conflict,
        source_version: None,
    })
}

/// Move a file or directory to a new parent directory.
/// Updates backlinks. Returns the new relative path.
#[allow(dead_code)]
pub fn move_entry(
    space: &Path,
    from: &str,
    to_parent: &str,
    backlink_index: Option<&BacklinkIndex>,
) -> Result<String, PageError> {
    move_entry_with_project(space, from, to_parent, backlink_index, None)
}

pub fn move_entry_with_project(
    space: &Path,
    from: &str,
    to_parent: &str,
    backlink_index: Option<&BacklinkIndex>,
    project_path: Option<&str>,
) -> Result<String, PageError> {
    let abs_from = space.join(from);

    if !abs_from.exists() {
        return Err(PageError::FileNotFound(from.to_string()));
    }

    let filename = Path::new(from)
        .file_name()
        .ok_or_else(|| PageError::General("invalid source path".to_string()))?;

    let new_rel = if to_parent.is_empty() {
        filename.to_string_lossy().to_string()
    } else {
        format!("{}/{}", to_parent, filename.to_string_lossy())
    };

    let abs_to = space.join(&new_rel);

    if abs_to.exists() {
        return Err(PageError::FileAlreadyExists(new_rel));
    }
    let relation_plan = crate::collections::engine::relation_move_mutation_paths_with_project(
        &space.to_string_lossy(),
        project_path,
        from,
        &new_rel,
    )?;

    let from_is_dir = abs_from.is_dir();
    let is_md = from_is_dir || Path::new(from).extension().and_then(|e| e.to_str()) == Some("md");
    let target_sibling_order =
        content_tree::list_tree_children(space.to_string_lossy().as_ref(), Some(to_parent))
            .map(|children| {
                children
                    .into_iter()
                    .map(|child| child.name)
                    .collect::<Vec<String>>()
            })
            .unwrap_or_default();

    // Ensure target parent directory exists
    if let Some(parent_dir) = abs_to.parent() {
        fs::create_dir_all(parent_dir)?;
    }

    fs::rename(&abs_from, &abs_to)?;
    update_order_after_move(space, from, &new_rel, from_is_dir, &target_sibling_order)?;
    crate::collections::engine::apply_schema_defaults_to_entry_tree(space, &new_rel)?;
    rewrite_relations_after_fs_move_with_project(
        space,
        project_path,
        from,
        &new_rel,
        &abs_from,
        &abs_to,
        Some(&relation_plan),
    )?;

    // Update backlinks. For folder moves, every .md descendant sits under a
    // new path now — rewrite their inbound links too, not just the folder itself
    // (which isn't even a .md target).
    if let Some(index) = backlink_index {
        if from_is_dir {
            let _ = index.update_links_on_folder_rename(space, from, &new_rel);
        } else if is_md {
            let _ = index.update_links_on_rename(space, from, &new_rel, None);
            let _ = index.update_file(space, &new_rel);
        }
    }

    Ok(new_rel)
}

/// Keep the sidebar order coherent after moving an entry between parents.
/// Directory keys belong to the physical directory path, so a moved directory
/// also carries its nested order keys to its new path.
fn update_order_after_move(
    space: &Path,
    from: &str,
    to: &str,
    moved_directory: bool,
    target_sibling_order: &[String],
) -> Result<(), PageError> {
    let source = Path::new(from);
    let target = Path::new(to);
    let source_parent = dir_key_for(source.parent().unwrap_or(Path::new("")));
    let target_parent = dir_key_for(target.parent().unwrap_or(Path::new("")));
    let source_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| PageError::General("invalid source path".to_string()))?;
    let target_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| PageError::General("invalid destination path".to_string()))?;

    let mut order = content_tree::read_order(space);
    if let Some(items) = order.get_mut(&source_parent) {
        items.retain(|item| item != source_name);
    }
    let target_items = order.entry(target_parent).or_default();
    *target_items = target_sibling_order.to_vec();
    target_items.push(target_name.to_string());

    if moved_directory {
        let source_key = from.trim_matches('/');
        let target_key = to.trim_matches('/');
        let prefix = format!("{source_key}/");
        let moved_keys: Vec<(String, Vec<String>)> = order
            .iter()
            .filter(|(key, _)| *key == source_key || key.starts_with(&prefix))
            .map(|(key, children)| {
                let suffix = key.strip_prefix(source_key).unwrap_or_default();
                (format!("{target_key}{suffix}"), children.clone())
            })
            .collect();
        order.retain(|key, _| key != source_key && !key.starts_with(&prefix));
        order.extend(moved_keys);
    }

    Ok(content_tree::write_order(space, &order)?)
}

/// Nest an entry: convert `foo.md` → `foo/readme.md`, making it a category.
/// Returns the new relative path (e.g. "foo/readme.md").
pub fn nest_entry(
    space: &Path,
    path: &str,
    backlink_index: Option<&BacklinkIndex>,
) -> Result<String, PageError> {
    let abs_path = space.join(path);

    if !abs_path.exists() {
        return Err(PageError::FileNotFound(path.to_string()));
    }

    // Only works on .md files, not directories
    if abs_path.is_dir() {
        return Err(PageError::General(
            "Path is already a directory".to_string(),
        ));
    }

    // Already a readme.md inside a folder — nothing to do
    let filename = abs_path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if filename.eq_ignore_ascii_case("readme.md") {
        return Ok(path.to_string());
    }

    // Determine the folder name: foo.md → foo/
    let stem = abs_path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| PageError::General("invalid filename".to_string()))?;

    let parent = abs_path.parent().unwrap_or(space);
    let folder = parent.join(stem);

    if folder.exists() {
        return Err(PageError::FileAlreadyExists(
            folder.to_string_lossy().to_string(),
        ));
    }

    // Create the folder and move the file into it as README.md
    fs::create_dir_all(&folder)?;
    let new_abs = folder.join("README.md");
    fs::rename(&abs_path, &new_abs)?;

    // Compute new relative path
    let new_rel = new_abs
        .strip_prefix(space)
        .unwrap_or(&new_abs)
        .to_string_lossy()
        .to_string();
    if let Err(error) = rewrite_relations_after_fs_move(space, path, &new_rel, &abs_path, &new_abs)
    {
        let _ = fs::remove_dir(&folder);
        return Err(error);
    }

    // Update backlinks
    if let Some(index) = backlink_index {
        let _ = index.update_links_on_rename(space, path, &new_rel, None);
        let _ = index.update_file(space, &new_rel);
    }

    Ok(new_rel)
}

/// Unnest an entry: convert `foo/readme.md` → `foo.md` when the folder has no
/// other children. Returns the new relative path (e.g. "foo.md").
/// If the folder still has children, returns an error.
pub fn unnest_entry(
    space: &Path,
    path: &str,
    backlink_index: Option<&BacklinkIndex>,
) -> Result<String, PageError> {
    let abs_path = space.join(path);

    if !abs_path.exists() {
        return Err(PageError::FileNotFound(path.to_string()));
    }

    // Must be a readme.md inside a folder
    let filename = abs_path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if !filename.eq_ignore_ascii_case("readme.md") {
        return Err(PageError::General(
            "Only readme.md inside a folder can be unnested".to_string(),
        ));
    }

    let folder = abs_path
        .parent()
        .ok_or_else(|| PageError::General("no parent directory".to_string()))?;

    // Check that the folder has no other children
    let siblings: Vec<_> = fs::read_dir(folder)?
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name();
            let s = name.to_string_lossy();
            !s.eq_ignore_ascii_case("readme.md") && !s.starts_with('.')
        })
        .collect();

    if !siblings.is_empty() {
        return Err(PageError::General(
            "Folder still has children, cannot unnest".to_string(),
        ));
    }

    // Move readme.md → folder_name.md at the parent level
    let folder_name = folder
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| PageError::General("invalid folder name".to_string()))?;
    let parent_dir = folder
        .parent()
        .ok_or_else(|| PageError::General("no parent for folder".to_string()))?;
    let new_abs = parent_dir.join(format!("{}.md", folder_name));

    if new_abs.exists() {
        return Err(PageError::FileAlreadyExists(
            new_abs.to_string_lossy().to_string(),
        ));
    }

    // Move the file out, then remove the empty folder
    fs::rename(&abs_path, &new_abs)?;
    let _ = fs::remove_dir(folder); // remove empty dir

    let new_rel = new_abs
        .strip_prefix(space)
        .unwrap_or(&new_abs)
        .to_string_lossy()
        .to_string();
    if let Err(error) = crate::collections::engine::rewrite_relation_paths_for_move(
        &space.to_string_lossy(),
        path,
        &new_rel,
    ) {
        let _ = fs::create_dir_all(folder);
        let _ = fs::rename(&new_abs, &abs_path);
        return Err(error.into());
    }

    // Update backlinks
    if let Some(index) = backlink_index {
        let _ = index.update_links_on_rename(space, path, &new_rel, None);
        let _ = index.update_file(space, &new_rel);
    }

    Ok(new_rel)
}

pub fn convert_entry_to_folder(
    space: &Path,
    entry_path: &str,
    backlink_index: Option<&BacklinkIndex>,
) -> Result<Entry, PageError> {
    let path = normalize_entry_path_arg(space, entry_path)?;
    let abs_path = space.join(&path);
    if abs_path.is_dir()
        || path
            .rsplit('/')
            .next()
            .is_some_and(|name| name.eq_ignore_ascii_case("README.md"))
    {
        return Err(PageError::General("entry is already a folder".to_string()));
    }
    if abs_path.extension().and_then(|ext| ext.to_str()) != Some("md") {
        return Err(PageError::General(
            "entry must be a markdown leaf".to_string(),
        ));
    }

    let stem = abs_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or_else(|| PageError::General("invalid entry filename".to_string()))?;
    let parent_abs = abs_path.parent().unwrap_or(space);
    let folder_abs = parent_abs.join(stem);
    if folder_abs.exists() {
        return Err(PageError::FileAlreadyExists(rel_from_abs(
            space,
            &folder_abs,
        )));
    }
    fs::create_dir_all(&folder_abs)?;
    let new_abs = folder_abs.join("README.md");
    fs::rename(&abs_path, &new_abs)?;
    let new_rel = rel_from_abs(space, &new_abs);
    if let Err(error) = rewrite_relations_after_fs_move(space, &path, &new_rel, &abs_path, &new_abs)
    {
        let _ = fs::remove_dir(&folder_abs);
        return Err(error);
    }

    let parent_rel = Path::new(&path).parent().unwrap_or(Path::new(""));
    let dir_key = dir_key_for(parent_rel);
    let old_name = Path::new(&path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    order_rename(space, &dir_key, &old_name, stem);

    if let Some(index) = backlink_index {
        let _ = index.update_links_on_rename(space, &path, &new_rel, None);
        let _ = index.update_file(space, &new_rel);
    }
    read(&space.to_string_lossy(), &new_rel)
}

pub fn entry_detail_state(space: &Path, path: &str) -> Result<EntryDetailState, PageError> {
    let rel = path.trim_matches('/').replace('\\', "/");
    let abs = space.join(&rel);
    if abs.is_dir() {
        if !dir_has_readme(&abs) {
            return Err(PageError::FileNotFound(rel));
        }
        let (subpage_count, other_file_count) = folder_child_counts(&abs)?;
        return Ok(EntryDetailState {
            form: if abs.join("schema.yaml").exists() {
                EntryDetailForm::NestedCollection
            } else {
                EntryDetailForm::Folder
            },
            subpage_count,
            other_file_count,
        });
    }

    if !abs.exists() {
        return Err(PageError::FileNotFound(rel));
    }

    let is_readme = abs
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("README.md"));
    if !is_readme {
        return Ok(EntryDetailState {
            form: EntryDetailForm::Leaf,
            subpage_count: 0,
            other_file_count: 0,
        });
    }

    let folder = abs
        .parent()
        .ok_or_else(|| PageError::General("README.md has no parent folder".to_string()))?;
    let (subpage_count, other_file_count) = folder_child_counts(folder)?;
    Ok(EntryDetailState {
        form: if folder.join("schema.yaml").exists() {
            EntryDetailForm::NestedCollection
        } else {
            EntryDetailForm::Folder
        },
        subpage_count,
        other_file_count,
    })
}

fn folder_child_counts(folder: &Path) -> Result<(usize, usize), PageError> {
    let mut subpage_count = 0;
    let mut other_file_count = 0;

    for item in fs::read_dir(folder)? {
        let item = item?;
        let name = item.file_name().to_string_lossy().to_string();
        if name.starts_with('.')
            || name.eq_ignore_ascii_case("README.md")
            || name.eq_ignore_ascii_case("schema.yaml")
        {
            continue;
        }

        let path = item.path();
        if path.is_dir() {
            if dir_has_readme(&path) {
                subpage_count += 1;
            } else {
                other_file_count += 1;
            }
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("md") {
            subpage_count += 1;
        } else {
            other_file_count += 1;
        }
    }

    Ok((subpage_count, other_file_count))
}

fn dir_has_readme(dir: &Path) -> bool {
    fs::read_dir(dir)
        .ok()
        .into_iter()
        .flat_map(|items| items.filter_map(Result::ok))
        .any(|item| {
            item.path().is_file()
                && item
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.eq_ignore_ascii_case("README.md"))
        })
}

pub fn convert_entry_to_leaf(
    space: &Path,
    entry_path: &str,
    backlink_index: Option<&BacklinkIndex>,
) -> Result<Entry, PageError> {
    let path = normalize_entry_path_arg(space, entry_path)?;
    let readme_abs = space.join(&path);
    if !readme_abs
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("README.md"))
    {
        return Err(PageError::General(
            "only folder README.md can be converted to leaf".to_string(),
        ));
    }
    let folder_abs = readme_abs
        .parent()
        .ok_or_else(|| PageError::General("README.md has no parent folder".to_string()))?;
    if folder_abs.join("schema.yaml").exists() {
        return Err(PageError::General(
            "EntryNotEmpty { entries: [], folders: [], other: [\"schema.yaml\"] }".to_string(),
        ));
    }

    let mut entries = Vec::new();
    let mut folders = Vec::new();
    let mut other = Vec::new();
    for item in fs::read_dir(folder_abs)? {
        let item = item?;
        let name = item.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name.eq_ignore_ascii_case("README.md") {
            continue;
        }
        let item_path = item.path();
        if item_path.is_dir() {
            folders.push(name);
        } else if item_path.extension().and_then(|ext| ext.to_str()) == Some("md") {
            entries.push(name);
        } else {
            other.push(name);
        }
    }
    if !entries.is_empty() || !folders.is_empty() || !other.is_empty() {
        return Err(PageError::General(format!(
            "EntryNotEmpty {{ entries: {:?}, folders: {:?}, other: {:?} }}",
            entries, folders, other
        )));
    }

    let folder_name = folder_abs
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| PageError::General("invalid folder name".to_string()))?;
    let parent_abs = folder_abs
        .parent()
        .ok_or_else(|| PageError::General("folder has no parent".to_string()))?;
    let leaf_abs = parent_abs.join(format!("{folder_name}.md"));
    if leaf_abs.exists() {
        return Err(PageError::FileAlreadyExists(rel_from_abs(space, &leaf_abs)));
    }
    fs::rename(&readme_abs, &leaf_abs)?;
    let _ = fs::remove_dir_all(folder_abs);
    let new_rel = rel_from_abs(space, &leaf_abs);
    if let Err(error) = crate::collections::engine::rewrite_relation_paths_for_move(
        &space.to_string_lossy(),
        &path,
        &new_rel,
    ) {
        let _ = fs::create_dir_all(folder_abs);
        let _ = fs::rename(&leaf_abs, &readme_abs);
        return Err(error.into());
    }

    let parent_rel = Path::new(&path)
        .parent()
        .and_then(Path::parent)
        .unwrap_or(Path::new(""));
    let dir_key = dir_key_for(parent_rel);
    order_rename(space, &dir_key, folder_name, &format!("{folder_name}.md"));
    let child_key = if dir_key == "." {
        folder_name.to_string()
    } else {
        format!("{}/{}", dir_key, folder_name)
    };
    order_remove_key(space, &child_key);

    if let Some(index) = backlink_index {
        let _ = index.update_links_on_rename(space, &path, &new_rel, None);
        let _ = index.update_file(space, &new_rel);
    }
    read(&space.to_string_lossy(), &new_rel)
}

pub fn convert_entry_to_nested_collection(
    space: &Path,
    entry_path: &str,
) -> Result<String, PageError> {
    let path = normalize_entry_path_arg(space, entry_path)?;
    let readme_abs = space.join(&path);
    if !readme_abs
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("README.md"))
    {
        return Err(PageError::General(
            "entry must be converted to folder before making a collection".to_string(),
        ));
    }
    let folder_rel = Path::new(&path)
        .parent()
        .map(|parent| parent.to_string_lossy().replace('\\', "/"))
        .ok_or_else(|| PageError::General("README.md has no parent folder".to_string()))?;
    let schema_abs = space.join(&folder_rel).join("schema.yaml");
    if schema_abs.exists() {
        return Err(PageError::FileAlreadyExists(rel_from_abs(
            space,
            &schema_abs,
        )));
    }
    crate::collections::engine::write_default_collection_schema(
        &space.to_string_lossy(),
        &folder_rel,
    )?;
    Ok(folder_rel)
}

pub fn convert_bare_folder_to_collection(
    space: &Path,
    folder_path: &str,
) -> Result<Entry, PageError> {
    crate::page::naming::with_document_name_lock(&space.to_string_lossy(), || {
        convert_bare_folder_to_collection_inner(space, folder_path)
    })
}

fn convert_bare_folder_to_collection_inner(
    space: &Path,
    folder_path: &str,
) -> Result<Entry, PageError> {
    let rel = folder_path.trim_matches('/').replace('\\', "/");
    let folder_abs = space.join(&rel);
    if !folder_abs.is_dir() {
        return Err(PageError::FileNotFound(rel));
    }
    let readme_abs = folder_abs.join("README.md");
    let schema_abs = folder_abs.join("schema.yaml");
    if readme_abs.exists() {
        return Err(PageError::FileAlreadyExists(rel_from_abs(
            space,
            &readme_abs,
        )));
    }
    if schema_abs.exists() {
        return Err(PageError::FileAlreadyExists(rel_from_abs(
            space,
            &schema_abs,
        )));
    }

    let folder_name = folder_abs
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Collection");
    let mut meta = EntryMeta::new_persisted(humanize_slug(folder_name));
    crate::page::naming::ensure_document_name_available(
        space,
        &format!("{rel}/README.md"),
        &meta.title,
    )?;
    crate::collections::engine::apply_schema_defaults_for_path(
        &space.to_string_lossy(),
        &format!("{rel}/README.md"),
        &mut meta,
    )?;
    persistence::write_serialized(&readme_abs, &meta, "")?;
    crate::collections::engine::write_default_collection_schema(&space.to_string_lossy(), &rel)?;
    read(&space.to_string_lossy(), &format!("{rel}/README.md"))
}

pub fn duplicate_entry(space: &Path, file_path: &str) -> Result<Entry, PageError> {
    crate::page::naming::with_document_name_lock(&space.to_string_lossy(), || {
        duplicate_entry_inner(space, file_path)
    })
}

fn duplicate_entry_inner(space: &Path, file_path: &str) -> Result<Entry, PageError> {
    let rel = file_path.trim_matches('/').replace('\\', "/");
    let source_abs = space.join(&rel);
    if !source_abs.exists() {
        return Err(PageError::FileNotFound(rel));
    }

    let (root_source_abs, source_order_name, parent_abs, root_head_rel) = if source_abs.is_dir() {
        let parent = source_abs.parent().unwrap_or(space).to_path_buf();
        let order_name = source_abs
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let head = source_abs.join("README.md");
        let head_rel = rel_from_abs(space, &head);
        (source_abs.clone(), order_name, parent, head_rel)
    } else if source_abs
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("README.md"))
    {
        let folder = source_abs
            .parent()
            .ok_or_else(|| PageError::General("README.md has no parent folder".to_string()))?;
        let parent = folder.parent().unwrap_or(space).to_path_buf();
        let order_name = folder
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        (folder.to_path_buf(), order_name, parent, rel.clone())
    } else {
        let parent = source_abs.parent().unwrap_or(space).to_path_buf();
        let order_name = source_abs
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        (source_abs.clone(), order_name, parent, rel.clone())
    };

    let requested_copy_title = read(&space.to_string_lossy(), &root_head_rel)
        .map(|entry| format!("{} (copy)", entry.meta.title))
        .unwrap_or_else(|_| format!("{} (copy)", source_order_name));
    let copy_title =
        crate::page::naming::allocate_document_title(space, &root_head_rel, &requested_copy_title)?;
    let projection = filename::project(&copy_title);
    let (dest_abs, actual_projection) = filename::allocate_available_path(
        &parent_abs,
        &projection,
        (!root_source_abs.is_dir()).then_some("md"),
    )?;

    if root_source_abs.is_dir() {
        copy_dir_recursive(&root_source_abs, &dest_abs)?;
        let head = dest_abs.join("README.md");
        if head.exists() {
            refresh_markdown_copy_metadata(&head, Some(&copy_title))?;
        }
        let mut files = Vec::new();
        collect_entry_md_files(&dest_abs, &mut files)?;
        for file in files {
            if file != head {
                refresh_markdown_copy_metadata(&file, None)?;
            }
        }
    } else {
        fs::copy(&root_source_abs, &dest_abs)?;
        refresh_markdown_copy_metadata(&dest_abs, Some(&copy_title))?;
    }

    crate::collections::engine::rewrite_internal_relation_refs_for_copy(
        &space.to_string_lossy(),
        &rel_from_abs(space, &root_source_abs),
        &rel_from_abs(space, &dest_abs),
    )?;
    crate::collections::engine::assign_unique_ids_to_entry_tree(
        space,
        &rel_from_abs(space, &dest_abs),
        true,
    )?;

    let dir_key = rel_from_abs(space, &parent_abs);
    let dir_key = if dir_key.is_empty() {
        ".".to_string()
    } else {
        dir_key
    };
    let dest_order_name = dest_abs
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    order_insert_after(space, &dir_key, &source_order_name, &dest_order_name);

    let entry_rel = if dest_abs.is_dir() {
        rel_from_abs(space, &dest_abs.join("README.md"))
    } else {
        rel_from_abs(space, &dest_abs)
    };
    let mut entry = read(&space.to_string_lossy(), &entry_rel)?;
    entry.warnings.extend(filename_allocation_warnings(
        &projection,
        &actual_projection,
        &entry_rel,
    ));
    Ok(entry)
}

fn copy_dir_recursive(source: &Path, dest: &Path) -> Result<(), PageError> {
    fs::create_dir_all(dest)?;
    for item in fs::read_dir(source)? {
        let item = item?;
        if item.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let source_path = item.path();
        let dest_path = dest.join(item.file_name());
        if source_path.is_dir() {
            copy_dir_recursive(&source_path, &dest_path)?;
        } else {
            fs::copy(&source_path, &dest_path)?;
        }
    }
    Ok(())
}

/// Delete an entry from disk. Removes from backlink index if provided.
#[allow(dead_code)]
pub fn delete(
    space: &str,
    path: &str,
    backlink_index: Option<&BacklinkIndex>,
) -> Result<DeleteResult, PageError> {
    delete_with_project(space, path, backlink_index, None)
}

pub fn delete_with_project(
    space: &str,
    path: &str,
    backlink_index: Option<&BacklinkIndex>,
    project_path: Option<&str>,
) -> Result<DeleteResult, PageError> {
    let requested_abs_path = resolve(space, path);
    let space_path = Path::new(space);
    let abs_path = delete_root_for_path(space_path, &requested_abs_path);

    if !abs_path.exists() {
        return Err(PageError::FileNotFound(path.to_string()));
    }

    let deleted_root = rel_from_abs(space_path, &abs_path);
    let deleted_paths = collect_deleted_entry_paths(space_path, &abs_path)?;
    let cascade_touched =
        match crate::collections::engine::cascade_clean_deleted_entries_with_project(
            space,
            project_path,
            &deleted_paths,
        ) {
            Ok(paths) => paths,
            Err(error) => return Err(error.into()),
        };

    let delete_parent = abs_path.parent().unwrap_or(Path::new(space));
    let tombstone = unique_child_path(delete_parent, ".svode-delete", None);
    fs::rename(&abs_path, &tombstone)?;

    if let Err(error) = cascade_remove_tombstone(&tombstone) {
        let _ = fs::rename(&tombstone, &abs_path);
        return Err(error);
    }

    if let Some(index) = backlink_index {
        for deleted_path in &deleted_paths {
            index.remove_file(deleted_path);
        }
    }

    cleanup_deleted_order(space_path, &deleted_root);

    Ok(DeleteResult {
        deleted_root,
        deleted_paths,
        cascade_touched,
    })
}

fn cascade_remove_tombstone(tombstone: &Path) -> Result<(), PageError> {
    if tombstone.is_dir() {
        fs::remove_dir_all(tombstone)?;
    } else {
        fs::remove_file(tombstone)?;
    }
    Ok(())
}

fn delete_root_for_path(space: &Path, abs_path: &Path) -> PathBuf {
    if abs_path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("README.md"))
    {
        if let Some(parent) = abs_path.parent() {
            if parent != space {
                return parent.to_path_buf();
            }
        }
    }
    abs_path.to_path_buf()
}

fn collect_deleted_entry_paths(space: &Path, abs_path: &Path) -> Result<Vec<String>, PageError> {
    if abs_path.is_dir() {
        let mut files = Vec::new();
        collect_entry_md_files(abs_path, &mut files)?;
        Ok(files
            .into_iter()
            .map(|file| rel_from_abs(space, &file))
            .collect())
    } else {
        Ok(vec![rel_from_abs(space, abs_path)])
    }
}

pub fn planned_deleted_entry_paths(space: &str, path: &str) -> Result<Vec<String>, PageError> {
    let space_path = Path::new(space);
    let requested = resolve(space, path);
    let root = delete_root_for_path(space_path, &requested);
    if !root.exists() {
        return Err(PageError::FileNotFound(path.to_string()));
    }
    collect_deleted_entry_paths(space_path, &root)
}

fn cleanup_deleted_order(space: &Path, deleted_root: &str) {
    let root = Path::new(deleted_root);
    let deleted_name = root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(deleted_root);
    let deleted_parent = root.parent().unwrap_or(Path::new(""));
    let deleted_parent_key = dir_key_for(deleted_parent);

    let mut order = content_tree::read_order(space);
    if let Some(items) = order.get_mut(&deleted_parent_key) {
        items.retain(|item| item != deleted_name);
    }

    let deleted_key = deleted_root.trim_matches('/');
    order.remove(deleted_key);
    let child_prefix = format!("{deleted_key}/");
    order.retain(|key, _| key == "." || key != deleted_key && !key.starts_with(&child_prefix));
    let _ = content_tree::write_order(space, &order);
}

/// Rename/move an entry on disk.
#[allow(dead_code)]
pub fn rename(space: &str, from: &str, to: &str) -> Result<(), PageError> {
    rename_with_project(space, from, to, None)
}

pub fn rename_with_project(
    space: &str,
    from: &str,
    to: &str,
    project_path: Option<&str>,
) -> Result<(), PageError> {
    let abs_from = resolve(space, from);
    let abs_to = resolve(space, to);

    if !abs_from.exists() {
        return Err(PageError::FileNotFound(from.to_string()));
    }

    if abs_to.exists() {
        return Err(PageError::FileAlreadyExists(to.to_string()));
    }
    let relation_plan = crate::collections::engine::relation_move_mutation_paths_with_project(
        space,
        project_path,
        from,
        to,
    )?;

    // Ensure target parent directory exists
    if let Some(parent_dir) = abs_to.parent() {
        fs::create_dir_all(parent_dir)?;
    }

    fs::rename(&abs_from, &abs_to)?;
    rewrite_relations_after_fs_move_with_project(
        Path::new(space),
        project_path,
        from,
        to,
        &abs_from,
        &abs_to,
        Some(&relation_plan),
    )?;

    // Update order.json: rename entry in parent's order list
    let old_name = Path::new(from)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let new_name = Path::new(to)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let parent_dir = Path::new(from).parent().unwrap_or(Path::new(""));
    let dir_key = if parent_dir.as_os_str().is_empty() {
        ".".to_string()
    } else {
        parent_dir.to_string_lossy().to_string()
    };
    let sp_path = Path::new(space);
    order_rename(sp_path, &dir_key, &old_name, &new_name);

    // If it's a directory, also rename the key in order.json
    if abs_to.is_dir() {
        let mut order = content_tree::read_order(sp_path);
        let old_key = if dir_key == "." {
            old_name
        } else {
            format!("{}/{}", dir_key, old_name)
        };
        if let Some(children) = order.remove(&old_key) {
            let new_key = if dir_key == "." {
                new_name
            } else {
                format!("{}/{}", dir_key, new_name)
            };
            order.insert(new_key, children);
            let _ = content_tree::write_order(sp_path, &order);
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::page::ColorName;
    use tempfile::TempDir;

    #[test]
    fn test_slugify_basic() {
        assert_eq!(slugify("Hello World"), "hello-world");
        assert_eq!(slugify("My Cool Page!"), "my-cool-page");
        assert_eq!(slugify("  Spaced  Out  "), "spaced-out");
        assert_eq!(slugify("CamelCase"), "camelcase");
    }

    #[test]
    fn test_slugify_cyrillic() {
        assert_eq!(slugify("Архитектура"), "arhitektura");
        assert_eq!(slugify("Привет мир"), "privet-mir");
        assert_eq!(slugify("Ёжик в тумане"), "yozhik-v-tumane");
        assert_eq!(slugify("Щука"), "shchuka");
    }

    #[test]
    fn test_slugify_mixed() {
        assert_eq!(slugify("My Документ"), "my-dokument");
        assert_eq!(slugify("Stage 1 Обзор"), "stage-1-obzor");
    }

    #[test]
    fn test_slugify_empty_and_fallback() {
        assert_eq!(slugify(""), "untitled");
        assert_eq!(slugify("!!!"), "untitled");
        // CJK characters are not transliterated → fallback
        assert_eq!(slugify("你好世界"), "untitled");
    }

    #[test]
    fn test_slugify_max_length() {
        // 70-char slug should be truncated at word boundary
        let long_title =
            "this is a very long title that should be truncated at a word boundary somewhere";
        let slug = slugify(long_title);
        assert!(slug.len() <= 60);
        assert!(!slug.ends_with('-'));
        assert_eq!(
            slug,
            "this-is-a-very-long-title-that-should-be-truncated-at-a"
        );
    }

    #[test]
    fn test_slugify_max_length_no_hyphen() {
        // A single very long word with no hyphens → hard truncate at 60
        let long_word = "a".repeat(80);
        let slug = slugify(&long_word);
        assert_eq!(slug.len(), 60);
    }

    fn test_meta() -> EntryMeta {
        let mut meta = EntryMeta::new_persisted("Title");
        meta.created = "2026-03-17T00:00:00Z".into();
        meta.updated = "2026-03-17T00:00:00Z".into();
        meta
    }

    #[test]
    fn test_update_field_validates_description() {
        let mut meta = test_meta();
        apply_entry_field_update(
            &mut meta,
            "description",
            serde_json::Value::String("Summary".into()),
        )
        .unwrap();
        assert_eq!(meta.description.as_deref(), Some("Summary"));

        apply_entry_field_update(
            &mut meta,
            "description",
            serde_json::Value::String(String::new()),
        )
        .unwrap();
        assert_eq!(meta.description, None);

        let err = apply_entry_field_update(
            &mut meta,
            "description",
            serde_json::Value::String("x".repeat(501)),
        )
        .unwrap_err();
        assert!(err.to_string().contains("500"));
    }

    #[test]
    fn test_update_field_validates_cover() {
        let mut meta = test_meta();
        apply_entry_field_update(
            &mut meta,
            "cover",
            serde_json::json!({ "type": "color", "value": "blue" }),
        )
        .unwrap();
        assert_eq!(
            meta.cover,
            Some(Cover::Color {
                value: ColorName::Blue,
            })
        );

        apply_entry_field_update(
            &mut meta,
            "cover",
            serde_json::json!({ "type": "image", "path": ".assets/cover.jpg", "position": 100 }),
        )
        .unwrap();
        assert_eq!(
            meta.cover,
            Some(Cover::Image {
                path: ".assets/cover.jpg".into(),
                position: Some(100),
            })
        );

        let err = apply_entry_field_update(
            &mut meta,
            "cover",
            serde_json::json!({ "type": "image", "path": ".assets/cover.jpg", "position": 101 }),
        )
        .unwrap_err();
        assert!(err.to_string().contains("0..=100"));
    }

    #[test]
    fn test_explicit_create_rejects_duplicate_visible_title() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path().to_str().unwrap();

        // Create first entry
        let e1 = create(ws, None, "Test Doc").unwrap();
        assert_eq!(e1.path, "Test Doc.md");

        let error = create(ws, None, "Test Doc").unwrap_err();
        assert!(matches!(error, PageError::DocumentNameConflict(_)));
        assert!(!resolve(ws, "Test Doc-1.md").exists());
    }

    #[test]
    fn managed_entry_and_collection_flows_preserve_readable_unicode_paths() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path().to_str().unwrap();

        let leaf = create(ws, None, "Привет 世界 🚀").unwrap();
        assert_eq!(leaf.path, "Привет 世界 🚀.md");
        assert!(leaf.warnings.is_empty());

        let head = create(ws, None, "Καλημέρα κόσμε").unwrap();
        let head = convert_entry_to_folder(tmp.path(), &head.path, None).unwrap();
        convert_entry_to_nested_collection(tmp.path(), &head.path).unwrap();
        assert_eq!(head.path, "Καλημέρα κόσμε/README.md");

        let row = create(ws, Some("Καλημέρα κόσμε"), "مرحبا بالعالم").unwrap();
        assert_eq!(row.path, "Καλημέρα κόσμε/مرحبا بالعالم.md");
        assert!(row.warnings.is_empty());
    }

    #[test]
    fn test_create_does_not_write_legacy_system_keys() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path().to_str().unwrap();

        let entry = create(ws, None, "Clean Doc").unwrap();
        let raw = fs::read_to_string(resolve(ws, &entry.path)).unwrap();

        assert!(raw.contains("\ntitle: Clean Doc\n"));
        assert!(!raw.contains("\nid:"));
        assert!(!raw.contains("\ncreated:"));
        assert!(!raw.contains("\nupdated:"));
    }

    #[test]
    fn test_create_collision_with_parent() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path().to_str().unwrap();

        let e1 = create(ws, Some("docs"), "readme").unwrap();
        assert_eq!(e1.path, "docs/readme.md");

        let e2 = create(ws, Some("docs"), "readme").unwrap();
        assert_eq!(e2.path, "docs/readme-1.md");
    }

    #[test]
    fn test_delete_readme_deletes_document_folder_tree() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path().to_str().unwrap();

        let readme = create(ws, Some("docs"), "README").unwrap();
        let child = create(ws, Some("docs/sub"), "Child").unwrap();

        let result = delete(ws, &readme.path, None).unwrap();

        assert_eq!(result.deleted_root, "docs");
        assert!(result.deleted_paths.contains(&readme.path));
        assert!(result.deleted_paths.contains(&child.path));
        assert!(!resolve(ws, "docs").exists());
    }

    #[test]
    fn test_delete_collection_readme_deletes_collection_folder() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path().to_str().unwrap();

        let folder = create_folder(ws, None, "Tasks").unwrap();
        let collection = convert_bare_folder_to_collection(Path::new(ws), &folder).unwrap();
        let entry = create(ws, Some("Tasks"), "Task A").unwrap();

        let result = delete(ws, &collection.path, None).unwrap();

        assert_eq!(result.deleted_root, "Tasks");
        assert!(result.deleted_paths.contains(&collection.path));
        assert!(result.deleted_paths.contains(&entry.path));
        assert!(!resolve(ws, "Tasks").exists());
        assert!(
            !content_tree::read_order(Path::new(ws))
                .get(".")
                .is_some_and(|items| items.iter().any(|item| item == "Tasks"))
        );
    }

    #[test]
    fn test_write_title_change_renames_file() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path().to_str().unwrap();

        let entry = create(ws, None, "Original Title").unwrap();
        assert_eq!(entry.path, "Original Title.md");

        let result = write(
            ws,
            &entry.path,
            "body content",
            Some("New Title"),
            None,
            None,
            None,
            None,
            false,
        )
        .unwrap();

        assert_eq!(result.new_path, Some("New Title.md".to_string()));
        assert!(!resolve(ws, "Original Title.md").exists());
        assert!(resolve(ws, "New Title.md").exists());
    }

    #[test]
    fn test_write_title_change_collision_is_rejected_before_content_write() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path().to_str().unwrap();

        let e1 = create(ws, None, "Doc A").unwrap();
        let _e2 = create(ws, None, "Doc B").unwrap();

        let before = fs::read_to_string(resolve(ws, &e1.path)).unwrap();
        let error = write(
            ws,
            &e1.path,
            "updated body",
            Some("Doc B"),
            None,
            None,
            None,
            None,
            false,
        )
        .unwrap_err();

        assert!(matches!(error, PageError::DocumentNameConflict(_)));
        assert!(resolve(ws, "Doc A.md").exists());
        assert_eq!(fs::read_to_string(resolve(ws, &e1.path)).unwrap(), before);
    }

    #[test]
    fn test_write_same_title_no_rename() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path().to_str().unwrap();

        let entry = create(ws, None, "Keep Same").unwrap();

        let result = write(
            ws,
            &entry.path,
            "new body",
            Some("Keep Same"),
            None,
            None,
            None,
            None,
            false,
        )
        .unwrap();

        assert_eq!(result.new_path, None);
        assert!(resolve(ws, "Keep Same.md").exists());
    }

    #[test]
    fn explicit_body_save_does_not_migrate_an_existing_legacy_path() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path().to_str().unwrap();
        fs::write(
            resolve(ws, "legacy-slug.md"),
            "---\ntitle: Привет мир\n---\nOld body\n",
        )
        .unwrap();

        let result = write(
            ws,
            "legacy-slug.md",
            "New body\n",
            None,
            None,
            None,
            None,
            None,
            false,
        )
        .unwrap();

        assert_eq!(result.new_path, None);
        assert!(resolve(ws, "legacy-slug.md").is_file());
        assert!(!resolve(ws, "Привет мир.md").exists());
    }

    #[test]
    fn unsafe_title_rename_collision_keeps_current_path_and_reports_it() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path().to_str().unwrap();
        let source = create(ws, None, "Source").unwrap();
        let occupied = create(ws, None, "A-B").unwrap();

        let result = write(
            ws,
            &source.path,
            "Saved body",
            Some("A/B"),
            None,
            None,
            None,
            None,
            false,
        )
        .unwrap();

        assert_eq!(result.new_path, None);
        assert!(resolve(ws, &source.path).is_file());
        assert!(resolve(ws, &occupied.path).is_file());
        assert!(result.warnings.iter().any(|warning| {
            warning.kind == "filename_rename_collision"
                && warning.path.as_deref() == Some(source.path.as_str())
        }));
        assert!(result.warnings.iter().any(|warning| {
            warning.kind == "filename_projection"
                && warning.path.as_deref() == Some(source.path.as_str())
        }));
    }

    #[test]
    fn body_only_save_preserves_boundary_and_metadata_bytes_on_disk() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path().to_str().unwrap();
        let path = resolve(ws, "note.md");
        for eol in ["\n", "\r\n"] {
            let metadata =
                format!("---{eol}title: 'Note'{eol}# Keep comment{eol}custom: [a, b]{eol}---");
            for closing_eol in ["", eol] {
                let initial = format!("{metadata}{closing_eol}");
                let original_body = if closing_eol.is_empty() {
                    String::new()
                } else {
                    format!("## Original{eol}")
                };
                fs::write(&path, format!("{initial}{original_body}")).unwrap();
                assert_eq!(read(ws, "note.md").unwrap().body, original_body);
                let mut prefix = initial;
                for body in [
                    "",
                    "## Контекст\n",
                    "Paragraph\n",
                    "- Item\n",
                    "```rust\nlet x = 1;\n```\n",
                    "",
                ] {
                    if !body.is_empty() && !prefix.ends_with('\n') {
                        prefix.push('\n');
                    }
                    for _ in 0..2 {
                        write(ws, "note.md", body, None, None, None, None, None, true).unwrap();
                        let bytes = fs::read(&path).unwrap();
                        assert_eq!(&bytes[..prefix.len()], prefix.as_bytes());
                        assert_eq!(&bytes[prefix.len()..], body.as_bytes());
                        let reopened = read(ws, "note.md").unwrap();
                        assert_eq!(reopened.body, body);
                        assert_eq!(reopened.meta.title, "Note");
                        assert!(reopened.warnings.is_empty());
                    }
                }
            }
        }
    }

    #[test]
    fn test_write_body_only_preserves_malformed_frontmatter_as_content() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path().to_str().unwrap();
        let raw = "---\ntitle: [broken\n---\nBody\n";
        fs::write(resolve(ws, "broken.md"), raw).unwrap();

        let entry = read(ws, "broken.md").unwrap();
        assert_eq!(entry.body, raw);
        assert_eq!(
            entry.warnings.first().map(|warning| warning.kind.as_str()),
            Some("malformed_frontmatter")
        );
        write(
            ws,
            "broken.md",
            &(entry.body + "More\n"),
            None,
            None,
            None,
            None,
            None,
            true,
        )
        .unwrap();

        let updated = fs::read_to_string(resolve(ws, "broken.md")).unwrap();
        assert_eq!(updated, "---\ntitle: [broken\n---\nBody\nMore\n");
    }

    #[test]
    fn test_update_field_treats_id_as_custom_property() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path().to_str().unwrap();
        let entry = create(ws, None, "Imported").unwrap();

        let updated = update_field(
            ws,
            None,
            &entry.path,
            "id",
            serde_json::Value::String("obsidian-id".into()),
        )
        .unwrap();

        assert_eq!(
            updated
                .meta
                .extra
                .get("id")
                .and_then(serde_yml::Value::as_str),
            Some("obsidian-id")
        );
        let raw = fs::read_to_string(resolve(ws, &entry.path)).unwrap();
        assert!(raw.contains("\nid: obsidian-id\n"));
    }

    #[test]
    fn test_convert_entry_to_folder_accepts_path_without_legacy_id() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path();
        fs::write(ws.join("note.md"), "---\ntitle: Note\n---\nBody\n").unwrap();

        let converted = convert_entry_to_folder(ws, "note.md", None).unwrap();

        assert_eq!(converted.path, "note/README.md");
        assert!(ws.join("note").join("README.md").is_file());
        assert!(!ws.join("note.md").exists());
    }

    #[test]
    fn move_entry_updates_source_target_and_nested_order_keys() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path();
        fs::create_dir_all(ws.join("source/child")).unwrap();
        fs::create_dir_all(ws.join("target")).unwrap();
        fs::write(ws.join("source/README.md"), "source").unwrap();
        fs::write(ws.join("source/child/note.md"), "note").unwrap();
        fs::write(ws.join("target/README.md"), "target").unwrap();
        fs::write(ws.join("target/a.md"), "a").unwrap();
        fs::write(ws.join("target/z.md"), "z").unwrap();
        let mut order = HashMap::new();
        order.insert(
            ".".to_string(),
            vec!["source".to_string(), "target".to_string()],
        );
        order.insert("source".to_string(), vec!["child".to_string()]);
        order.insert("source/child".to_string(), vec!["note.md".to_string()]);
        content_tree::write_order(ws, &order).unwrap();

        let moved = move_entry_with_project(ws, "source", "target", None, None).unwrap();

        assert_eq!(moved, "target/source");
        let order = content_tree::read_order(ws);
        assert_eq!(order.get(".").unwrap(), &vec!["target".to_string()]);
        assert_eq!(
            order.get("target").unwrap(),
            &vec!["a.md".to_string(), "z.md".to_string(), "source".to_string()]
        );
        assert_eq!(
            order.get("target/source").unwrap(),
            &vec!["child".to_string()]
        );
        assert_eq!(
            order.get("target/source/child").unwrap(),
            &vec!["note.md".to_string()]
        );
        assert!(!order.contains_key("source"));
    }

    #[test]
    fn test_write_materializes_rename_from_persisted_title_without_metadata_args() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path().to_str().unwrap();
        fs::write(
            resolve(ws, "old-title.md"),
            "---\ntitle: Old title\n---\nBody\n",
        )
        .unwrap();
        update_field(
            ws,
            None,
            "old-title.md",
            "title",
            serde_json::Value::String("New title".into()),
        )
        .unwrap();

        let result = write(
            ws,
            "old-title.md",
            "Body\n",
            None,
            None,
            None,
            None,
            None,
            false,
        )
        .unwrap();

        assert_eq!(result.new_path.as_deref(), Some("New title.md"));
        assert!(resolve(ws, "New title.md").is_file());
        assert!(!resolve(ws, "old-title.md").exists());
    }

    #[test]
    fn test_title_write_renames_readme_backed_collection_directory() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path().to_str().unwrap();
        let head = create(ws, None, "Без названия").unwrap();
        let head = convert_entry_to_folder(tmp.path(), &head.path, None).unwrap();
        convert_entry_to_nested_collection(tmp.path(), &head.path).unwrap();

        let result = write(
            ws,
            &head.path,
            &head.body,
            Some("Проекты команды"),
            None,
            None,
            None,
            None,
            false,
        )
        .unwrap();

        assert_eq!(
            result.new_path.as_deref(),
            Some("Проекты команды/README.md")
        );
        assert!(resolve(ws, "Проекты команды/README.md").is_file());
        assert!(resolve(ws, "Проекты команды/schema.yaml").is_file());
        assert!(!resolve(ws, "Без названия").exists());
    }

    #[test]
    fn quick_create_allocates_visible_titles_and_explicit_create_is_non_destructive() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path().to_string_lossy();

        let first = create_with_options(&space, None, "Untitled", None, true, false).unwrap();
        let second = create_with_options(&space, None, "Untitled", None, true, false).unwrap();
        assert_eq!(first.meta.title, "Untitled");
        assert_eq!(second.meta.title, "Untitled 2");

        let error = create_with_options(&space, None, "untitled", None, false, false).unwrap_err();
        assert!(matches!(error, PageError::DocumentNameConflict(_)));
        assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 3);
    }

    #[test]
    fn folder_document_and_leaf_share_a_logical_parent_name_scope() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path().to_string_lossy();
        create_with_options(&space, None, "Shared", None, false, false).unwrap();
        fs::create_dir(tmp.path().join("folder")).unwrap();

        let error = create_with_options(
            &space,
            Some("folder"),
            "  ＳＨＡＲＥＤ  ",
            None,
            false,
            true,
        )
        .unwrap_err();
        assert!(matches!(error, PageError::DocumentNameConflict(_)));
        assert!(!tmp.path().join("folder/README.md").exists());
    }

    #[test]
    fn collection_rows_use_the_same_name_scope_and_unique_allocators() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path().to_string_lossy();
        fs::create_dir(tmp.path().join("collection")).unwrap();
        fs::write(tmp.path().join("collection/schema.yaml"), "name: Test\n").unwrap();

        let first =
            create_with_options(&space, Some("collection"), "Shared", None, false, false).unwrap();
        let conflict = create_with_options(
            &space,
            Some("collection"),
            "  ＳＨＡＲＥＤ  ",
            None,
            false,
            false,
        )
        .unwrap_err();
        assert!(matches!(conflict, PageError::DocumentNameConflict(_)));

        let quick =
            create_with_options(&space, Some("collection"), "Shared", None, true, false).unwrap();
        let copy = duplicate_entry(tmp.path(), &first.path).unwrap();
        assert_eq!(quick.meta.title, "Shared 2");
        assert_eq!(copy.meta.title, "Shared (copy)");
    }

    #[test]
    fn converting_a_bare_folder_cannot_create_a_collection_head_name_conflict() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path().to_string_lossy();
        create_with_options(&space, None, "Shared", None, false, false).unwrap();
        create_folder(&space, None, "shared").unwrap();

        let error = convert_bare_folder_to_collection(tmp.path(), "shared").unwrap_err();
        assert!(matches!(error, PageError::DocumentNameConflict(_)));
        assert!(!tmp.path().join("shared/README.md").exists());
        assert!(!tmp.path().join("shared/schema.yaml").exists());
    }

    #[test]
    fn distinct_safe_names_keep_distinct_readable_filenames() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path().to_string_lossy();
        let first = create_with_options(&space, None, "A+B", None, false, false).unwrap();
        let second = create_with_options(&space, None, "AB", None, false, false).unwrap();

        assert_eq!(first.path, "A+B.md");
        assert_eq!(second.path, "AB.md");
        assert_eq!(read(&space, &first.path).unwrap().meta.title, "A+B");
        assert_eq!(read(&space, &second.path).unwrap().meta.title, "AB");
    }

    #[test]
    fn managed_create_allocates_suffix_and_reports_actual_lossy_path() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path().to_string_lossy();
        create_with_options(&space, None, "A-B", None, false, false).unwrap();

        // Filename warnings are produced while the source name is allocated, so the
        // assertion uses the source create that returns them instead of a fresh read.
        let created = create_source_with_options(&space, None, "A/B", false, false).unwrap();

        assert_eq!(created.path, "A-B-1.md");
        assert!(created.warnings.iter().any(|warning| {
            warning.kind == "filename_projection" && warning.path.as_deref() == Some("A-B-1.md")
        }));
        assert!(created.warnings.iter().any(|warning| {
            warning.kind == "filename_collision_allocated"
                && warning.path.as_deref() == Some("A-B-1.md")
        }));
    }

    #[test]
    fn repeated_duplicate_allocates_a_unique_visible_copy_title() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path().to_string_lossy();
        let source = create_with_options(&space, None, "Source", None, false, false).unwrap();

        let first = duplicate_entry(tmp.path(), &source.path).unwrap();
        let second = duplicate_entry(tmp.path(), &source.path).unwrap();

        assert_eq!(first.meta.title, "Source (copy)");
        assert_eq!(second.meta.title, "Source (copy) 2");
        assert_ne!(first.path, second.path);
    }

    #[test]
    fn concurrent_quick_creates_allocate_distinct_visible_titles() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path().to_string_lossy().to_string();
        let first_space = space.clone();
        let second_space = space.clone();
        let first = std::thread::spawn(move || {
            create_with_options(&first_space, None, "Untitled", None, true, false).unwrap()
        });
        let second = std::thread::spawn(move || {
            create_with_options(&second_space, None, "Untitled", None, true, false).unwrap()
        });
        let mut titles = [
            first.join().unwrap().meta.title,
            second.join().unwrap().meta.title,
        ];
        titles.sort();
        assert_eq!(titles, ["Untitled", "Untitled 2"]);
    }

    #[test]
    fn unrelated_body_save_stays_available_for_existing_external_duplicates() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path().to_string_lossy();
        fs::write(
            tmp.path().join("one.md"),
            "---\ntitle: Shared\n---\nOld one\n",
        )
        .unwrap();
        fs::write(
            tmp.path().join("two.md"),
            "---\ntitle: shared\n---\nOld two\n",
        )
        .unwrap();

        write(
            &space,
            "one.md",
            "Updated one\n",
            None,
            None,
            None,
            None,
            None,
            true,
        )
        .unwrap();
        assert!(
            fs::read_to_string(tmp.path().join("one.md"))
                .unwrap()
                .ends_with("Updated one\n")
        );

        let result = write(
            &space,
            "one.md",
            "Explicit save\n",
            None,
            None,
            None,
            None,
            None,
            false,
        )
        .unwrap();
        assert_eq!(result.new_path, None);
        assert!(tmp.path().join("one.md").is_file());
        assert!(tmp.path().join("two.md").is_file());
        assert!(
            fs::read_to_string(tmp.path().join("one.md"))
                .unwrap()
                .ends_with("Explicit save\n")
        );
    }

    #[test]
    fn unique_id_create_delete_duplicate_and_repair_do_not_reuse_numbers() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path();
        fs::create_dir_all(space.join("tasks")).unwrap();
        fs::write(
            space.join("tasks/schema.yaml"),
            "columns:\n  - name: Key\n    type: unique_id\n    prefix: ISSUE\n    next: 1\nviews: []\n",
        )
        .unwrap();

        let first = create(space.to_str().unwrap(), Some("tasks"), "First").unwrap();
        assert_eq!(
            first
                .meta
                .extra
                .get("Key")
                .and_then(serde_yml::Value::as_u64),
            Some(1)
        );
        fs::remove_file(space.join(&first.path)).unwrap();
        let second = create(space.to_str().unwrap(), Some("tasks"), "Second").unwrap();
        assert_eq!(
            second
                .meta
                .extra
                .get("Key")
                .and_then(serde_yml::Value::as_u64),
            Some(2)
        );

        let duplicated = duplicate_entry(space, &second.path).unwrap();
        assert_eq!(
            duplicated
                .meta
                .extra
                .get("Key")
                .and_then(serde_yml::Value::as_u64),
            Some(3)
        );

        let schema =
            crate::collections::engine::read_collection_schema(space.to_str().unwrap(), "tasks")
                .unwrap();
        assert_eq!(schema.columns[0].next, Some(4));

        let duplicated_path = space.join(&duplicated.path);
        let raw = fs::read_to_string(&duplicated_path).unwrap();
        let (mut meta, body) = frontmatter::try_parse(&raw).unwrap().unwrap();
        meta.extra
            .insert("Key".into(), serde_yml::Value::from(2_u64));
        fs::write(&duplicated_path, frontmatter::serialize(&meta, &body)).unwrap();
        crate::collections::engine::assign_unique_id(space.to_str().unwrap(), &duplicated.path)
            .unwrap();
        let repaired = read(space.to_str().unwrap(), &duplicated.path).unwrap();
        assert_eq!(
            repaired
                .meta
                .extra
                .get("Key")
                .and_then(serde_yml::Value::as_u64),
            Some(4)
        );
        let schema = crate::collections::engine::normalize_unique_id_counter(
            space.to_str().unwrap(),
            "tasks",
        )
        .unwrap();
        assert_eq!(schema.columns[0].next, Some(5));
    }

    #[test]
    fn unique_id_update_is_readonly_and_actor_values_are_normalized() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path();
        fs::create_dir_all(space.join("tasks")).unwrap();
        fs::write(
                space.join("tasks/schema.yaml"),
                "columns:\n  - { name: Key, type: unique_id, next: 1 }\n  - { name: Owner, type: actor, multiple: false }\n  - { name: Reviewers, type: actor, multiple: true }\nviews: []\n",
            )
            .unwrap();
        let created = create(space.to_str().unwrap(), Some("tasks"), "Task").unwrap();

        assert!(
            update_field(
                space.to_str().unwrap(),
                None,
                &created.path,
                "Key",
                serde_json::json!(99),
            )
            .is_err()
        );

        let updated = update_field(
            space.to_str().unwrap(),
            None,
            &created.path,
            "Owner",
            serde_json::json!(" ME@EXAMPLE.COM "),
        )
        .unwrap();
        assert_eq!(
            updated
                .meta
                .extra
                .get("Owner")
                .and_then(serde_yml::Value::as_str),
            Some("me@example.com")
        );

        let updated = update_field(
            space.to_str().unwrap(),
            None,
            &created.path,
            "Reviewers",
            serde_json::json!(["A@Example.com", "a@example.com", "bad value"]),
        )
        .unwrap();
        let reviewers: Vec<_> = updated
            .meta
            .extra
            .get("Reviewers")
            .unwrap()
            .as_sequence()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect();
        assert_eq!(reviewers, vec!["a@example.com", "bad value"]);
    }
}

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use super::CollectionError;
use super::schema::{normalize_rel_path, resolve_collection_schema_result};
use crate::content_tree::child_folder_names;
use crate::content_tree::policy::{TreeIgnorePolicy, TreePathKind};

fn rel_path_string(path: &Path) -> String {
    if path.as_os_str().is_empty() {
        ".".into()
    } else {
        path.to_string_lossy().replace('\\', "/")
    }
}

fn collection_rel(path: &str) -> PathBuf {
    let rel = normalize_rel_path(path);
    if rel.is_empty() || rel == "." {
        PathBuf::new()
    } else {
        PathBuf::from(rel)
    }
}

fn collection_dir(space: &str, collection_path: &str) -> PathBuf {
    Path::new(space).join(collection_rel(collection_path))
}

pub fn is_registered_child_space_rel(rel: &str, skip_dirs: &HashSet<String>) -> bool {
    if rel.is_empty() || rel == "." {
        return false;
    }
    skip_dirs.iter().any(|child| {
        rel == child
            || rel
                .strip_prefix(child)
                .is_some_and(|suffix| suffix.starts_with('/'))
    })
}

pub fn is_collection_traversal_ignored(
    space: &Path,
    path: &Path,
    meta: &fs::Metadata,
    skip_dirs: &HashSet<String>,
    policy: &TreeIgnorePolicy,
) -> bool {
    let rel_path = path.strip_prefix(space).unwrap_or(path);
    let rel = rel_path_string(rel_path);
    if meta.is_dir() && is_registered_child_space_rel(&rel, skip_dirs) {
        return true;
    }
    let kind = if meta.is_dir() {
        TreePathKind::Directory
    } else if meta.is_file() {
        TreePathKind::File
    } else {
        TreePathKind::Unknown
    };
    policy.is_ignored_rel(rel_path, kind)
}

pub fn collection_markdown_files(
    space: &str,
    collection_path: &str,
) -> Result<Vec<PathBuf>, CollectionError> {
    let space_root = Path::new(space);
    let collection_root = collection_rel(collection_path);
    let collection_root_rel = rel_path_string(&collection_root);
    let skip_dirs = child_folder_names(space_root);
    if is_registered_child_space_rel(&collection_root_rel, &skip_dirs) {
        return Ok(Vec::new());
    }

    let root = collection_dir(space, collection_path);
    if !root.exists() {
        return Ok(Vec::new());
    }

    let policy = TreeIgnorePolicy::from_space_root(space_root);
    let mut files = Vec::new();
    for file in collect_md_files(space_root, &root, &skip_dirs, &policy)? {
        let rel = file
            .strip_prefix(space)
            .unwrap_or(&file)
            .to_string_lossy()
            .replace('\\', "/");
        let belongs = resolve_collection_schema_result(Path::new(space), &rel)
            .ok()
            .flatten()
            .map(|(_, root)| root == collection_root)
            .unwrap_or(false);
        if belongs {
            files.push(file);
        }
    }
    Ok(files)
}

pub fn collect_md_files_in_space(
    space: &Path,
    root: &Path,
) -> Result<Vec<PathBuf>, CollectionError> {
    // Collection-side scans must honor the same scope boundaries as tree/index.
    // Root project collections must not recurse into registered child spaces.
    let root_rel = root
        .strip_prefix(space)
        .map(rel_path_string)
        .unwrap_or_else(|_| rel_path_string(root));
    let skip_dirs = child_folder_names(space);
    if is_registered_child_space_rel(&root_rel, &skip_dirs) {
        return Ok(Vec::new());
    }

    let policy = TreeIgnorePolicy::from_space_root(space);
    collect_md_files(space, root, &skip_dirs, &policy)
}

fn collect_md_files(
    space: &Path,
    root: &Path,
    skip_dirs: &HashSet<String>,
    policy: &TreeIgnorePolicy,
) -> Result<Vec<PathBuf>, CollectionError> {
    let mut files = Vec::new();
    collect_md_files_inner(space, root, skip_dirs, policy, &mut files)?;
    Ok(files)
}

fn collect_md_files_inner(
    space: &Path,
    dir: &Path,
    skip_dirs: &HashSet<String>,
    policy: &TreeIgnorePolicy,
    out: &mut Vec<PathBuf>,
) -> Result<(), CollectionError> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();

        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink()
            || is_collection_traversal_ignored(space, &path, &meta, skip_dirs, policy)
        {
            continue;
        }

        if meta.is_dir() {
            collect_md_files_inner(space, &path, skip_dirs, policy, out)?;
        } else if meta.is_file() && path.extension().and_then(|ext| ext.to_str()) == Some("md") {
            out.push(path);
        }
    }
    Ok(())
}

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::collections::engine;
use crate::git::pending::StructuralOp;
use crate::page::registered_space_dirs;

pub fn abs_entry_path(space: &str, rel_path: &str) -> PathBuf {
    Path::new(space).join(rel_path)
}

pub fn order_path(space: &str) -> PathBuf {
    Path::new(space).join(".svode").join("order.json")
}

/// Sidebar order is rewritten by every structural change, so it travels with
/// the entry paths of that change.
pub fn entry_paths_with_order(
    space: &str,
    paths: impl IntoIterator<Item = PathBuf>,
) -> Vec<PathBuf> {
    let mut out = vec![order_path(space)];
    out.extend(paths);
    out
}

/// Attribute each changed path to the Space that owns it, so history is
/// recorded in the right repository. Falls back to `fallback_space`.
pub fn grouped_abs_paths_by_space(
    project_path: Option<&str>,
    fallback_space: &str,
    paths: &[PathBuf],
) -> HashMap<PathBuf, Vec<PathBuf>> {
    let mut spaces = vec![PathBuf::from(fallback_space)];
    if let Some(project) = project_path.filter(|path| !path.is_empty()) {
        let project_root = PathBuf::from(project);
        if !spaces.iter().any(|space| same_path(space, &project_root)) {
            spaces.push(project_root.clone());
        }
        match registered_space_dirs(&project_root) {
            Ok(children) => {
                for child in children {
                    if !spaces.iter().any(|space| same_path(space, &child)) {
                        spaces.push(child);
                    }
                }
            }
            Err(error) => {
                tracing::warn!("could not read project config for changed paths: {error}")
            }
        }
    }
    spaces.sort_by_key(|space| std::cmp::Reverse(space.as_os_str().len()));

    let mut grouped: HashMap<PathBuf, Vec<PathBuf>> = HashMap::new();
    for path in paths {
        let owner = spaces
            .iter()
            .find(|space| path.starts_with(space))
            .cloned()
            .unwrap_or_else(|| PathBuf::from(fallback_space));
        grouped.entry(owner).or_default().push(path.clone());
    }
    grouped
}

fn same_path(left: &Path, right: &Path) -> bool {
    let normalize = |path: &Path| {
        path.canonicalize()
            .unwrap_or_else(|_| path.to_path_buf())
            .to_string_lossy()
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_string()
    };
    normalize(left) == normalize(right)
}

pub fn basename(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_string()
}

/// Commit-message name of an entry: a README stands for its folder.
pub fn entry_history_name(path: &str) -> String {
    let normalized = path.trim_matches('/').replace('\\', "/");
    let path = Path::new(&normalized);
    if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("README.md"))
    {
        return path
            .parent()
            .and_then(|parent| parent.file_name())
            .and_then(|name| name.to_str())
            .unwrap_or("README.md")
            .to_string();
    }
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&normalized)
        .to_string()
}

/// Entries of a Collection with sensitive columns never expose their filename
/// in history.
pub fn entry_in_sensitive_collection(space: &str, path: &str) -> bool {
    engine::schema_response(space, path)
        .ok()
        .flatten()
        .is_some_and(|response| engine::schema_has_sensitive_columns(&response.schema))
}

pub fn entry_commit_name(space: &str, path: &str) -> String {
    if entry_in_sensitive_collection(space, path) {
        "collection entry".to_string()
    } else {
        basename(path)
    }
}

pub fn entry_history_commit_name(space: &str, path: &str) -> String {
    if entry_in_sensitive_collection(space, path) {
        "collection entry".to_string()
    } else {
        entry_history_name(path)
    }
}

pub fn entry_rename_op(space: &str, from: &str, to: &str) -> StructuralOp {
    if entry_in_sensitive_collection(space, from) || entry_in_sensitive_collection(space, to) {
        StructuralOp::Rename {
            old: "collection entry".to_string(),
            new: "collection entry".to_string(),
        }
    } else {
        StructuralOp::Rename {
            old: basename(from),
            new: basename(to),
        }
    }
}

pub(crate) fn collection_schema_path(space: &str, collection_path: &str) -> PathBuf {
    if collection_path.is_empty() || collection_path == "." {
        Path::new(space).join("schema.yaml")
    } else {
        Path::new(space).join(collection_path).join("schema.yaml")
    }
}

pub(crate) fn collection_schema_path_rel(collection_path: &str) -> String {
    if collection_path.is_empty() || collection_path == "." {
        "schema.yaml".to_string()
    } else {
        format!("{collection_path}/schema.yaml")
    }
}

pub fn root_path_for_head(path: &str) -> &str {
    if path
        .rsplit_once('/')
        .is_some_and(|(_, name)| name.eq_ignore_ascii_case("README.md"))
    {
        path.rsplit_once('/')
            .map(|(parent, _)| parent)
            .unwrap_or(path)
    } else {
        path
    }
}

pub(crate) fn same_parent(left: &str, right: &str) -> bool {
    Path::new(left).parent().unwrap_or(Path::new(""))
        == Path::new(right).parent().unwrap_or(Path::new(""))
}

pub(crate) fn normalize_rel_lossy(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

pub(crate) fn rel_changed_path(space: &str, path: &Path) -> String {
    path.strip_prefix(space)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

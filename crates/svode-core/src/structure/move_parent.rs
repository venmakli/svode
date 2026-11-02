//! Parent rule of a move under a new parent. The requested parent resolves
//! by the parent rule of Page create, and a folder `README.md` names its
//! folder; a leaf Page parent becomes a folder Page first, and the folder
//! Page the source leaves becomes a leaf again when nothing else keeps it a
//! folder. Every refusal comes before the first write.

use std::path::Path;

use super::naming::normalize_rel_lossy;
use crate::collections::traversal::is_registered_child_space_rel;
use crate::content_tree::child_folder_names;
use crate::page::PageError;
use crate::page::create::{PageParent, resolve_page_parent};
use crate::page::store;

/// What a move of a source under a requested parent does, resolved before
/// its first write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MovePlan {
    /// The directory the source lands in; empty for the Space root.
    pub(crate) parent: String,
    /// The path the source lands on.
    pub(crate) planned: String,
    /// The leaf Page that becomes the folder Page `parent` before the move.
    pub(crate) target_leaf: Option<String>,
    /// The `README.md` of the folder Page the source leaves, which becomes a
    /// leaf after the move when nothing else keeps it a folder.
    pub(crate) old_parent: Option<String>,
}

impl MovePlan {
    /// The `README.md` the leaf target becomes.
    pub(crate) fn target_readme(&self) -> Option<String> {
        self.target_leaf
            .as_ref()
            .map(|_| format!("{}/README.md", self.parent))
    }

    /// The directory of the folder Page the source leaves.
    pub(crate) fn old_parent_dir(&self) -> Option<&str> {
        self.old_parent
            .as_deref()
            .and_then(|readme| readme.rsplit_once('/'))
            .map(|(dir, _)| dir)
    }

    /// The leaf the folder Page the source leaves becomes.
    pub(crate) fn old_parent_leaf(&self) -> Option<String> {
        self.old_parent_dir().map(|dir| format!("{dir}.md"))
    }

    /// The relocations of the parent conversions this move may make, each
    /// as (old path, new path).
    pub(crate) fn conversions(&self) -> Vec<(String, String)> {
        let target = self.target_leaf.clone().zip(self.target_readme());
        let old_parent = self.old_parent.clone().zip(self.old_parent_leaf());
        target.into_iter().chain(old_parent).collect()
    }
}

/// Resolve a move of `from` under `to_parent`, refusing a missing source or
/// parent with `FileNotFound`, a parent that cannot hold the source with
/// `UnsupportedMoveParent` and a taken name with `FileAlreadyExists`.
pub(crate) fn plan_move(space: &str, from: &str, to_parent: &str) -> Result<MovePlan, PageError> {
    let root = Path::new(space);
    let source = root.join(from);
    if !source.exists() {
        return Err(PageError::FileNotFound(from.to_string()));
    }
    let unsupported = || PageError::UnsupportedMoveParent {
        path: to_parent.to_string(),
    };
    let (parent, target_leaf) = match folder_of_readme(root, to_parent) {
        Some(folder) => (folder, None),
        None => match resolve_page_parent(space, to_parent)? {
            PageParent::Directory(directory) => (directory, None),
            PageParent::Leaf { leaf, folder } => (folder, Some(leaf)),
            PageParent::NotPage(_) => return Err(unsupported()),
        },
    };
    // The source cannot hold itself: the resolved parent is neither the
    // source nor inside the moved tree.
    let holder = target_leaf.as_deref().unwrap_or(&parent);
    if !holder.is_empty() && Path::new(holder).starts_with(from) {
        return Err(unsupported());
    }
    let name = Path::new(from)
        .file_name()
        .ok_or_else(|| PageError::General("invalid source path".to_string()))?
        .to_string_lossy()
        .to_string();
    let planned = if parent.is_empty() {
        name.clone()
    } else {
        format!("{parent}/{name}")
    };
    let taken = if target_leaf.is_some() {
        // The folder the leaf becomes holds only its README.md.
        name.eq_ignore_ascii_case("README.md")
    } else {
        store::name_taken_portably(&root.join(&planned), None)?
    };
    if taken {
        return Err(PageError::FileAlreadyExists(planned));
    }
    Ok(MovePlan {
        parent,
        planned,
        target_leaf,
        old_parent: folder_page_left(root, from),
    })
}

/// The folder a requested `<folder>/README.md` names, in any case; the
/// Space root for its own `README.md`.
fn folder_of_readme(root: &Path, requested: &str) -> Option<String> {
    let path = Path::new(requested);
    if !path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("README.md"))
    {
        return None;
    }
    let folder = path.parent().map(normalize_rel_lossy).unwrap_or_default();
    let folder_abs = root.join(&folder);
    (folder_abs.is_dir() && store::dir_readme_name(&folder_abs).is_some()).then_some(folder)
}

/// The `README.md` of the folder Page that holds `from`: a directory with a
/// `README.md` and without `schema.yaml` that is neither the Space root nor
/// a child Space. A moved `README.md` leaves no folder Page behind.
fn folder_page_left(root: &Path, from: &str) -> Option<String> {
    let path = Path::new(from);
    if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("README.md"))
    {
        return None;
    }
    let folder = path.parent().map(normalize_rel_lossy)?;
    if folder.is_empty() || is_registered_child_space_rel(&folder, &child_folder_names(root)) {
        return None;
    }
    let folder_abs = root.join(&folder);
    if folder_abs.join("schema.yaml").exists() {
        return None;
    }
    store::dir_readme_name(&folder_abs).map(|readme| format!("{folder}/{readme}"))
}

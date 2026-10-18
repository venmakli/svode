//! Target rule of a rename by path: only a folder without a title is renamed
//! this way. A Page, Collection item or Collection is named by its title and
//! renamed by a title change; every other path is refused.

use std::path::Path;

use super::naming::same_parent;
use crate::collections::traversal::is_registered_child_space_rel;
use crate::content_tree::children::DirectoryKind;
use crate::content_tree::policy::{TreeIgnorePolicy, TreePathKind};
use crate::content_tree::{child_folder_names, source_directory_kind};
use crate::page::identity::{
    ContentOwnerKind, is_agent_context_source, resolve_markdown_identity_for_path,
};
use crate::page::{PageError, TitledContent};

/// Refuse a rename by path of anything but an existing folder without a
/// title, before any planning or write.
pub(crate) fn ensure_renamable_folder(space: &str, from: &str, to: &str) -> Result<(), PageError> {
    if !same_parent(from, to) {
        return Err(PageError::General(
            "rename_entry cannot change parent; use move_entry to move an entry".to_string(),
        ));
    }
    let unsupported = || PageError::UnsupportedRenameTarget {
        path: from.to_string(),
    };
    let rel = from.trim_matches('/');
    if rel.is_empty() || rel == "." {
        return Err(unsupported());
    }
    let space_path = Path::new(space);
    let abs = space_path.join(rel);
    if !abs.exists() {
        return Err(PageError::FileNotFound(from.to_string()));
    }
    let is_dir = abs.is_dir();
    let path_kind = if is_dir {
        TreePathKind::Directory
    } else {
        TreePathKind::File
    };
    if TreeIgnorePolicy::system_only(space_path).is_system_ignored_rel(Path::new(rel), path_kind)
        || is_registered_child_space_rel(rel, &child_folder_names(space_path))
    {
        return Err(unsupported());
    }
    let titled = if is_dir {
        match source_directory_kind(&abs)? {
            DirectoryKind::Collection => TitledContent::Collection,
            DirectoryKind::Page => {
                markdown_kind(space_path, &format!("{rel}/README.md"))?.ok_or_else(unsupported)?
            }
            DirectoryKind::App | DirectoryKind::Directory => return Ok(()),
        }
    } else if rel.to_ascii_lowercase().ends_with(".md") {
        markdown_kind(space_path, rel)?.ok_or_else(unsupported)?
    } else {
        return Err(unsupported());
    };
    Err(PageError::TitleRenameRequired {
        path: from.to_string(),
        kind: titled,
    })
}

/// Titled content a Markdown source stands for; `None` for an owner source
/// that is not renamed by its title, such as a Space README.
fn markdown_kind(space: &Path, rel: &str) -> Result<Option<TitledContent>, PageError> {
    let identity = resolve_markdown_identity_for_path(space, rel, is_agent_context_source(rel))?;
    Ok(match identity.owner_kind {
        Some(ContentOwnerKind::Collection) => Some(TitledContent::Collection),
        Some(_) => None,
        None if identity.is_collection_item() => Some(TitledContent::CollectionItem),
        None => Some(TitledContent::Page),
    })
}

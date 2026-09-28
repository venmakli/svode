use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::git::access::RepositoryAccessBlocker;
use crate::index::backlinks::ModifiedLinkSource;

/// `reason` of a filename deferred because rename repositories refuse writes.
pub const REPOSITORY_ACCESS_DENIED_REASON: &str = "repository_access_denied";

pub use crate::page::Cover;
pub use crate::page::frontmatter::EntryMeta;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WriteResult {
    /// New relative path if file was renamed, None if path unchanged.
    pub new_path: Option<String>,
    /// Files whose backlinks were updated due to rename.
    pub modified_files: Vec<String>,
    /// Files whose backlinks were updated, including cross-space source
    /// identity when project-aware rewrites are available.
    #[serde(default)]
    pub modified_sources: Vec<ModifiedLinkSource>,
    /// Short-TTL nonce associated with this write; attached to the watcher
    /// `file:changed` payload so the editor can drop its own echo.
    pub write_nonce: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<EntryWarning>,
    /// Version of the resulting source, the precondition of the next write.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_version: Option<String>,
}

pub struct DeleteResult {
    pub deleted_root: String,
    pub deleted_paths: Vec<String>,
    pub cascade_touched: Vec<PathBuf>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryWarning {
    pub kind: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Machine-readable cause of a deferred filename, when it is not the
    /// technical detail of `message`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Repositories of the rename that refused the write.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blockers: Vec<RepositoryAccessBlocker>,
}

impl EntryWarning {
    pub fn filename_projection(path: &str, reasons: &str) -> Self {
        Self {
            kind: "filename_projection".to_string(),
            message: format!("filename was safely projected ({reasons})"),
            path: Some(path.to_string()),
            ..Self::default()
        }
    }

    pub fn filename_rename_collision(current_path: &str) -> Self {
        Self {
            kind: "filename_rename_collision".to_string(),
            message: "display name was saved, but the current filename was kept because the target is occupied".to_string(),
            path: Some(current_path.to_string()),
            ..Self::default()
        }
    }

    pub fn filename_rename_deferred(current_path: &str, reason: &str) -> Self {
        Self {
            kind: "filename_rename_deferred".to_string(),
            message: format!(
                "display name was saved, but the current filename was kept because dependent metadata could not be updated safely: {reason}"
            ),
            path: Some(current_path.to_string()),
            ..Self::default()
        }
    }

    /// The Page repository accepted the title, but other repositories of
    /// the rename refuse writes; the same title renames once they accept.
    pub fn filename_rename_access_deferred(
        current_path: &str,
        blockers: &[RepositoryAccessBlocker],
    ) -> Self {
        let repositories = blockers
            .iter()
            .map(|blocker| {
                format!(
                    "{} ({}, {})",
                    blocker.repository_path, blocker.status, blocker.reason
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        Self {
            kind: "filename_rename_deferred".to_string(),
            message: format!(
                "display name was saved, but the current filename was kept because repositories referenced by the rename refuse writes: {repositories}; verify their access, then save the same title again"
            ),
            path: Some(current_path.to_string()),
            reason: Some(REPOSITORY_ACCESS_DENIED_REASON.to_string()),
            blockers: blockers.to_vec(),
        }
    }

    pub fn filename_collision_allocated(actual_path: &str) -> Self {
        Self {
            kind: "filename_collision_allocated".to_string(),
            message:
                "the desired filename was occupied, so the first available numeric suffix was used"
                    .to_string(),
            path: Some(actual_path.to_string()),
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub meta: EntryMeta,
    pub body: String,
    /// Relative path from space root.
    pub path: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<EntryWarning>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_conflict: Option<crate::page::naming::DocumentNameConflict>,
    /// Version of the bytes this entry was read from. Results publish it
    /// next to the entry, never inside it.
    #[serde(skip)]
    pub source_version: Option<crate::page::SourceVersion>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryDetailForm {
    Leaf,
    Folder,
    NestedCollection,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryDetailState {
    pub form: EntryDetailForm,
    pub subpage_count: usize,
    pub other_file_count: usize,
}

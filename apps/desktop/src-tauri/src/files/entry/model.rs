use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use svode_core::index::backlinks::ModifiedLinkSource;

pub use svode_core::page::Cover;
pub use svode_core::page::frontmatter::EntryMeta;

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
}

pub struct DeleteResult {
    pub deleted_root: String,
    pub deleted_paths: Vec<String>,
    pub cascade_touched: Vec<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryWarning {
    pub kind: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl EntryWarning {
    pub(super) fn filename_projection(path: &str, reasons: &str) -> Self {
        Self {
            kind: "filename_projection".to_string(),
            message: format!("filename was safely projected ({reasons})"),
            path: Some(path.to_string()),
        }
    }

    pub(super) fn filename_rename_collision(current_path: &str) -> Self {
        Self {
            kind: "filename_rename_collision".to_string(),
            message: "display name was saved, but the current filename was kept because the target is occupied".to_string(),
            path: Some(current_path.to_string()),
        }
    }

    pub(crate) fn filename_rename_deferred(current_path: &str, reason: &str) -> Self {
        Self {
            kind: "filename_rename_deferred".to_string(),
            message: format!(
                "display name was saved, but the current filename was kept because dependent metadata could not be updated safely: {reason}"
            ),
            path: Some(current_path.to_string()),
        }
    }

    pub(super) fn filename_collision_allocated(actual_path: &str) -> Self {
        Self {
            kind: "filename_collision_allocated".to_string(),
            message:
                "the desired filename was occupied, so the first available numeric suffix was used"
                    .to_string(),
            path: Some(actual_path.to_string()),
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
    pub name_conflict: Option<crate::files::naming::DocumentNameConflict>,
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

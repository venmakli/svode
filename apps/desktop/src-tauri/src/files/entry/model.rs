use serde::{
    Deserialize, Serialize,
    ser::{SerializeStruct, Serializer},
};
use std::collections::HashMap;
use std::path::PathBuf;

use crate::files::backlinks::ModifiedLinkSource;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ColorName {
    Neutral,
    Gray,
    Red,
    Orange,
    Yellow,
    Green,
    Blue,
    Purple,
    Pink,
    Brown,
}

impl ColorName {
    pub(super) fn from_name(value: &str) -> Option<Self> {
        match value {
            "neutral" => Some(Self::Neutral),
            "gray" => Some(Self::Gray),
            "red" => Some(Self::Red),
            "orange" => Some(Self::Orange),
            "yellow" => Some(Self::Yellow),
            "green" => Some(Self::Green),
            "blue" => Some(Self::Blue),
            "purple" => Some(Self::Purple),
            "pink" => Some(Self::Pink),
            "brown" => Some(Self::Brown),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Cover {
    Color {
        value: ColorName,
    },
    Image {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        position: Option<u8>,
    },
}

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
}

pub struct DeleteResult {
    pub deleted_root: String,
    pub deleted_paths: Vec<String>,
    pub cascade_touched: Vec<PathBuf>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub(crate) struct FrontmatterKeys {
    pub title: bool,
    pub icon: bool,
    pub description: bool,
    pub cover: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EntryMeta {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover: Option<Cover>,
    pub created: String,
    pub updated: String,
    /// User-defined custom fields from frontmatter YAML.
    #[serde(flatten)]
    pub extra: HashMap<String, serde_yml::Value>,
    #[serde(skip)]
    pub(crate) frontmatter_keys: FrontmatterKeys,
}

impl EntryMeta {
    pub(crate) fn new_persisted(title: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            icon: None,
            description: None,
            cover: None,
            created: String::new(),
            updated: String::new(),
            extra: HashMap::new(),
            frontmatter_keys: FrontmatterKeys {
                title: true,
                ..FrontmatterKeys::default()
            },
        }
    }

    pub(crate) fn synthesized(
        title: impl Into<String>,
        created: impl Into<String>,
        updated: impl Into<String>,
    ) -> Self {
        Self {
            title: title.into(),
            icon: None,
            description: None,
            cover: None,
            created: created.into(),
            updated: updated.into(),
            extra: HashMap::new(),
            frontmatter_keys: FrontmatterKeys::default(),
        }
    }

    pub(crate) fn from_frontmatter(
        title: String,
        icon: Option<String>,
        description: Option<String>,
        cover: Option<Cover>,
        extra: HashMap<String, serde_yml::Value>,
        frontmatter_keys: FrontmatterKeys,
    ) -> Self {
        Self {
            title,
            icon,
            description,
            cover,
            created: String::new(),
            updated: String::new(),
            extra,
            frontmatter_keys,
        }
    }

    pub(crate) fn mark_title_present(&mut self) {
        self.frontmatter_keys.title = true;
    }

    pub(crate) fn mark_icon_present(&mut self) {
        self.frontmatter_keys.icon = true;
    }

    pub(crate) fn mark_description_present(&mut self) {
        self.frontmatter_keys.description = true;
    }

    pub(crate) fn mark_cover_present(&mut self) {
        self.frontmatter_keys.cover = true;
    }
}

impl Serialize for EntryMeta {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut state = serializer.serialize_struct("EntryMeta", 7)?;
        state.serialize_field("title", &self.title)?;
        state.serialize_field("icon", &self.icon)?;
        state.serialize_field("description", &self.description)?;
        state.serialize_field("cover", &self.cover)?;
        state.serialize_field("created", &self.created)?;
        state.serialize_field("updated", &self.updated)?;
        state.serialize_field("extra", &self.extra)?;
        state.end()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryWarning {
    pub kind: String,
    pub message: String,
}

impl EntryWarning {
    pub(super) fn malformed_frontmatter(message: String) -> Self {
        Self {
            kind: "malformed_frontmatter".to_string(),
            message,
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

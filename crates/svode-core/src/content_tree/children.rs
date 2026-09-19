use std::fs;
use std::path::Path;

/// Surface adapters supply visible, structurally safe direct source facts.
#[derive(Clone, Copy, Debug, Default)]
pub struct DirectoryFacts {
    pub has_head: bool,
    pub has_schema: bool,
    pub has_app: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DirectoryKind {
    Collection,
    Page,
    App,
    Directory,
}

impl DirectoryFacts {
    pub fn kind(self) -> DirectoryKind {
        if self.has_schema {
            DirectoryKind::Collection
        } else if self.has_head {
            DirectoryKind::Page
        } else if self.has_app {
            DirectoryKind::App
        } else {
            DirectoryKind::Directory
        }
    }

    pub fn is_child_of(self, parent_has_app: bool) -> bool {
        !parent_has_app || self.has_head || self.has_schema || self.has_app
    }
}

pub fn is_regular_source(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file())
}

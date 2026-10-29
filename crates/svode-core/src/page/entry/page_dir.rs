//! The directory of a folder Page that becomes a leaf: what belongs to the
//! Page and may go with the directory, and its non-recursive removal.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::page::PageError;

use super::{dir_has_readme, rel_from_abs};

/// An item of a folder Page's directory that blocks turning the Page into a
/// leaf.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Blocking {
    /// A visible Markdown file.
    PageFile,
    /// A visible directory with a `README.md`.
    PageFolder,
    Schema,
    Folder,
    File,
}

/// What a folder Page's directory holds besides its `README.md`. Only the
/// service files belong to the Page: they are removed with the directory.
/// Every other item, hidden or not, blocks turning the Page into a leaf.
#[derive(Debug, Default)]
pub(super) struct PageDirContents {
    pub(super) service_files: Vec<String>,
    blocking: Vec<(String, Blocking)>,
}

impl PageDirContents {
    pub(super) fn read(dir: &Path) -> Result<Self, PageError> {
        let mut contents = Self::default();
        for item in fs::read_dir(dir)? {
            let item = item?;
            let name = item.file_name().to_string_lossy().to_string();
            if name.eq_ignore_ascii_case("README.md") {
                continue;
            }
            if is_service_file(&name, &item)? {
                contents.service_files.push(name);
                continue;
            }
            let path = item.path();
            let kind = if name.eq_ignore_ascii_case("schema.yaml") {
                Blocking::Schema
            } else if name.starts_with('.') {
                if item.file_type()?.is_dir() {
                    Blocking::Folder
                } else {
                    Blocking::File
                }
            } else if path.is_dir() {
                if dir_has_readme(&path) {
                    Blocking::PageFolder
                } else {
                    Blocking::Folder
                }
            } else if path.extension().and_then(|ext| ext.to_str()) == Some("md") {
                Blocking::PageFile
            } else {
                Blocking::File
            };
            contents.blocking.push((name, kind));
        }
        Ok(contents)
    }

    pub(super) fn is_blocked(&self) -> bool {
        !self.blocking.is_empty()
    }

    /// The refusal of turning the Page into a leaf, naming what blocks it.
    pub(super) fn not_empty_error(&self) -> PageError {
        let names = |kinds: &[Blocking]| {
            self.blocking
                .iter()
                .filter(|(_, kind)| kinds.contains(kind))
                .map(|(name, _)| name.clone())
                .collect::<Vec<_>>()
        };
        PageError::General(format!(
            "EntryNotEmpty {{ entries: {:?}, folders: {:?}, other: {:?} }}",
            names(&[Blocking::PageFile]),
            names(&[Blocking::PageFolder, Blocking::Folder]),
            names(&[Blocking::Schema, Blocking::File]),
        ))
    }

    /// Subpages and other blocking items shown by the Page detail; the
    /// `schema.yaml` of a nested Collection is neither.
    pub(super) fn counts(&self) -> (usize, usize) {
        self.blocking
            .iter()
            .fold((0, 0), |(subpages, other), (_, kind)| match kind {
                Blocking::PageFile | Blocking::PageFolder => (subpages + 1, other),
                Blocking::Schema => (subpages, other),
                Blocking::Folder | Blocking::File => (subpages, other + 1),
            })
    }
}

/// A service file of a folder Page: the empty `.gitkeep` Svode writes to keep
/// an empty folder in Git.
fn is_service_file(name: &str, item: &fs::DirEntry) -> Result<bool, PageError> {
    if !item.file_type()?.is_file() {
        return Ok(false);
    }
    Ok(match name {
        ".gitkeep" => item.metadata()?.len() == 0,
        _ => false,
    })
}

/// A removed folder Page directory with the service files it held, kept to
/// restore it when the operation rolls back.
pub(super) struct RemovedPageDir<'a> {
    folder: &'a Path,
    files: Vec<(PathBuf, Vec<u8>)>,
}

impl<'a> RemovedPageDir<'a> {
    /// Removes the directory of a folder Page whose `README.md` has moved
    /// out: its service files, then the directory itself, never recursively.
    /// An item that appeared in the meantime fails the removal; what was
    /// removed is returned either way to restore it.
    pub(super) fn remove(
        folder: &'a Path,
        service_files: &[String],
    ) -> (Self, Result<(), PageError>) {
        let mut removed = Self {
            folder,
            files: Vec::new(),
        };
        for name in service_files {
            let path = folder.join(name);
            let step = fs::read(&path).and_then(|bytes| {
                fs::remove_file(&path)?;
                Ok(bytes)
            });
            match step {
                Ok(bytes) => removed.files.push((path, bytes)),
                Err(error) => return (removed, Err(error.into())),
            }
        }
        #[cfg(test)]
        if let Err(error) = crate::page::write::checkpoint("page_dir_remove") {
            return (removed, Err(error));
        }
        let result = fs::remove_dir(folder).map_err(PageError::from);
        (removed, result)
    }

    /// Space-relative paths of the removed service files.
    pub(super) fn removed_files(&self, space: &Path) -> Vec<String> {
        self.files
            .iter()
            .map(|(path, _)| rel_from_abs(space, path))
            .collect()
    }

    /// Recreates the directory with its service files and moves the Page file
    /// back to `readme`. Returns `cause`, or the recovery failure naming the
    /// paths left changed.
    pub(super) fn restore(
        self,
        space: &Path,
        page_file: &Path,
        readme: &Path,
        cause: PageError,
    ) -> PageError {
        let mut failed = Vec::new();
        if fs::create_dir_all(self.folder).is_err() {
            failed.push(rel_from_abs(space, self.folder));
        }
        for (path, bytes) in &self.files {
            let restored = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .and_then(|mut file| file.write_all(bytes));
            if restored.is_err() {
                failed.push(rel_from_abs(space, path));
            }
        }
        if fs::rename(page_file, readme).is_err() {
            failed.push(rel_from_abs(space, readme));
        }
        if failed.is_empty() {
            cause
        } else {
            PageError::Recovery {
                cause: cause.to_string(),
                paths: failed,
            }
        }
    }
}

#[cfg(test)]
mod tests;

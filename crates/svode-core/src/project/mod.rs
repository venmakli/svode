//! Creation and registration of Projects and Spaces, shared by every host
//! (Stage 11 05): the `.svode/` scaffold and home README of a scope, the
//! registration of a child Space in its Project config and the creation of
//! a Space with its Git effects. Creating never commits; the creation commit
//! belongs to [`crate::git::space_creation`].

pub mod scaffold;
pub mod space;
#[cfg(test)]
mod space_tests;

use crate::git::GitError;
use crate::routines::local::LocalConfigError;
use crate::space_config::SpaceConfigError;

#[derive(Debug, thiserror::Error)]
pub enum ProjectError {
    #[error("Space name is required")]
    NameRequired,
    /// The folder of a Space is not one ASCII segment of letters, digits,
    /// `-` and `_`.
    #[error("Path not accessible: {0}")]
    InvalidFolder(String),
    #[error("File already exists: {0}")]
    FileAlreadyExists(String),
    #[error("Path not accessible: {0}")]
    PathNotAccessible(String),
    /// A Submodule Space is registered in the Project repository.
    #[error("A submodule space needs a Project with a Git repository")]
    NoProjectRepository,
    #[error(transparent)]
    Config(#[from] SpaceConfigError),
    #[error(transparent)]
    LocalConfig(#[from] LocalConfigError),
    #[error(transparent)]
    Git(#[from] GitError),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    /// A creation failed after its first write and its rollback could not
    /// remove everything it created.
    #[error("{cause}; rollback left {}", remaining.join(", "))]
    RollbackIncomplete {
        cause: Box<ProjectError>,
        remaining: Vec<String>,
    },
}

pub mod mailmap;
pub mod resolver;

#[derive(Debug, thiserror::Error)]
pub enum ActorError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Git error: {0}")]
    Git(#[from] crate::git::GitError),
    #[error("Git command failed: {0}")]
    GitCommandFailed(String),
    #[error("File not found: {0}")]
    FileNotFound(String),
    #[error("{0}")]
    General(String),
}

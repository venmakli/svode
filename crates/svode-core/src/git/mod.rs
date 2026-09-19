pub mod access;
pub mod cli;
pub mod path;
pub mod pending;
pub mod policy;
pub mod state;
pub mod status;

#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error("Git not found")]
    GitNotFound,
    #[error("Git command failed: {0}")]
    GitCommandFailed(String),
    #[error("Path not accessible: {0}")]
    PathNotAccessible(String),
    #[error(
        "Repository access denied: repository={repository_id}, status={status}, reason={reason}"
    )]
    RepositoryAccessDenied {
        repository_id: String,
        status: String,
        reason: String,
    },
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("{0}")]
    General(String),
}

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Serialization error: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("File not found: {0}")]
    FileNotFound(String),

    #[error("File already exists: {0}")]
    FileAlreadyExists(String),

    #[error("Frontmatter parse error: {0}")]
    FrontmatterParse(String),

    #[error("File watcher error: {0}")]
    Watcher(String),

    #[error("Workspace not found: {0}")]
    WorkspaceNotFound(String),

    #[error("Path not accessible: {0}")]
    PathNotAccessible(String),

    #[error("Agent CLI not found: {0}")]
    AgentCliNotFound(String),

    #[error("Agent spawn failed: {0}")]
    AgentSpawnFailed(String),

    #[error("Git not found")]
    GitNotFound,

    #[error("Git command failed: {0}")]
    GitCommandFailed(String),

    #[error("Git conflict: {0}")]
    GitConflict(String),

    #[error("Git auth required: {0}")]
    GitAuthRequired(String),

    #[error("Git no remote configured")]
    GitNoRemote,

    #[error("{0}")]
    General(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

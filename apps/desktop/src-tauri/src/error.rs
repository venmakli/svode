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

    #[error("Space not found: {0}")]
    SpaceNotFound(String),

    #[error("Path not accessible: {0}")]
    PathNotAccessible(String),

    #[error("Project already exists at: {0}")]
    ProjectAlreadyExists(String),

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

    #[error("Remote repository is not empty")]
    GitRemoteNotEmpty,

    #[error("Invalid URL: {0}")]
    InvalidUrl(String),

    #[error("Index error: {0}")]
    Index(String),

    #[error("Database error: {0}")]
    Db(#[from] sqlx::Error),

    #[error("Storage: {0}")]
    Storage(String),

    #[error("strategy is inherited from project")]
    StrategyInherited,

    #[error("Git identity not configured")]
    IdentityMissing,

    #[error("Invalid identity field: {0}")]
    IdentityInvalid(&'static str),

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

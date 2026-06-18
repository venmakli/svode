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

impl AppError {
    pub fn kind(&self) -> &'static str {
        match self {
            AppError::Io(_) => "io",
            AppError::Serde(_) => "serde",
            AppError::FileNotFound(_) => "file_not_found",
            AppError::FileAlreadyExists(_) => "file_already_exists",
            AppError::FrontmatterParse(_) => "frontmatter_parse",
            AppError::Watcher(_) => "watcher",
            AppError::SpaceNotFound(_) => "space_not_found",
            AppError::PathNotAccessible(_) => "path_not_accessible",
            AppError::ProjectAlreadyExists(_) => "project_already_exists",
            AppError::AgentCliNotFound(_) => "agent_cli_not_found",
            AppError::AgentSpawnFailed(_) => "agent_spawn_failed",
            AppError::GitNotFound => "git_not_found",
            AppError::GitCommandFailed(_) => "git_command_failed",
            AppError::GitConflict(_) => "git_conflict",
            AppError::GitAuthRequired(_) => "git_auth_required",
            AppError::GitNoRemote => "git_no_remote",
            AppError::GitRemoteNotEmpty => "git_remote_not_empty",
            AppError::InvalidUrl(_) => "invalid_url",
            AppError::Index(_) => "index",
            AppError::Db(_) => "db",
            AppError::Storage(_) => "storage",
            AppError::StrategyInherited => "strategy_inherited",
            AppError::IdentityMissing => "identity_missing",
            AppError::IdentityInvalid(_) => "identity_invalid",
            AppError::General(_) => "general",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

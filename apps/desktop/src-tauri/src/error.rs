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

    #[error("Project not found: {0}")]
    ProjectNotFound(String),

    #[error("Workspace not found: {0}")]
    WorkspaceNotFound(String),

    #[error("Path not accessible: {0}")]
    PathNotAccessible(String),

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

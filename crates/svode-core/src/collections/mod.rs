pub mod engine;
pub mod knowledge_projection;
pub mod list;
pub mod model;
pub mod query;
pub mod relation_read;
pub mod schema;
mod schema_support;
pub mod schema_validation;
pub mod traversal;

#[derive(Debug, thiserror::Error)]
pub enum CollectionError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("schema error: {0}")]
    Schema(String),
    #[error("index error: {0}")]
    Index(String),
    #[error("database error: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("frontmatter parse error: {0}")]
    FrontmatterParse(String),
    #[error("file not found: {0}")]
    FileNotFound(String),
    #[error("serialization error: {0}")]
    SerdeJson(#[from] serde_json::Error),
    #[error("{0}")]
    General(String),
    #[error(transparent)]
    Git(#[from] crate::git::GitError),
    #[error(transparent)]
    Actor(#[from] crate::actors::ActorError),
    #[error(transparent)]
    PageSource(#[from] crate::page::PageSourceError),
    #[error("Page name is already used in this container")]
    DocumentNameConflict(crate::page::naming::DocumentNameConflict),
    #[error("Page write recovery failed after {cause}; unrestored paths: {paths:?}")]
    Recovery { cause: String, paths: Vec<String> },
}

impl From<crate::page::frontmatter::FrontmatterError> for CollectionError {
    fn from(error: crate::page::frontmatter::FrontmatterError) -> Self {
        use crate::page::frontmatter::FrontmatterError;
        match error {
            FrontmatterError::Parse(message) => Self::FrontmatterParse(message),
            FrontmatterError::InvalidField(_) => Self::General(error.to_string()),
        }
    }
}

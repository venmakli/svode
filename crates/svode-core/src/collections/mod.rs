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
}

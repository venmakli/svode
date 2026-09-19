pub mod knowledge_projection;
pub mod model;
pub mod schema;
mod schema_support;
pub mod schema_validation;

#[derive(Debug, thiserror::Error)]
pub enum CollectionError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("schema error: {0}")]
    Schema(String),
}

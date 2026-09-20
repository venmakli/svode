pub mod authority;
pub mod local;
pub mod model;
pub mod observation;
pub mod operational;
pub mod parser;
pub mod schedule;
pub mod service;
pub mod storage;
pub mod store_state;

#[derive(Debug, thiserror::Error)]
pub enum RoutineStoreError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Database error: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("Index error: {0}")]
    Index(#[from] crate::index::IndexError),
    #[error("Local config error: {0}")]
    Local(#[from] local::LocalConfigError),
    #[error("{0}")]
    General(String),
}

pub mod model;
pub mod projection;
pub mod scanner;

#[derive(Debug, thiserror::Error)]
pub enum AgentContextError {
    #[error("Path not accessible: {0}")]
    PathNotAccessible(String),
    #[error("{0}")]
    General(String),
    #[error("Source registry error: {0}")]
    SourceRegistry(#[from] crate::agent_adapters::SourceRegistryError),
}

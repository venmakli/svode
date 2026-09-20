use crate::collections::CollectionError;
use crate::content_tree::ContentTreeError;
use crate::git::GitError;
use crate::index::IndexError;
use crate::index::update::IndexUpdateError;
use crate::page::PageSourceError;
use crate::page::frontmatter::FrontmatterError;
use crate::page::naming::DocumentNameConflict;
use crate::storage::routes::ManagedRouteError;

/// Failure of a Page mutation. Variants and messages mirror the Desktop error
/// categories so rollback causes and applied warnings keep their wording.
#[derive(Debug, thiserror::Error)]
pub enum PageError {
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
    #[error("Space not found: {0}")]
    SpaceNotFound(String),
    #[error("Path not accessible: {0}")]
    PathNotAccessible(String),
    #[error("Index error: {0}")]
    Index(String),
    #[error("Database error: {0}")]
    Db(#[from] sqlx::Error),
    #[error("Storage: {0}")]
    Storage(String),
    #[error("Page name is already used in this container")]
    DocumentNameConflict(DocumentNameConflict),
    #[error("Page write recovery failed after {cause}; unrestored paths: {paths:?}")]
    Recovery { cause: String, paths: Vec<String> },
    #[error("{0}")]
    General(String),
    #[error(transparent)]
    Git(#[from] GitError),
    #[error(transparent)]
    Actor(#[from] crate::actors::ActorError),
    #[error(transparent)]
    AgentContext(#[from] crate::agent_context::AgentContextError),
    #[error(transparent)]
    Routine(#[from] crate::routines::RoutineStoreError),
    #[error(transparent)]
    Observation(#[from] crate::routines::observation::ObservationError),
}

impl From<CollectionError> for PageError {
    fn from(error: CollectionError) -> Self {
        match error {
            CollectionError::Io(error) => Self::Io(error),
            CollectionError::Schema(message) => Self::General(format!("schema error: {message}")),
            CollectionError::Index(message) => Self::Index(message),
            CollectionError::Sqlx(error) => Self::Db(error),
            CollectionError::FrontmatterParse(message) => Self::FrontmatterParse(message),
            CollectionError::FileNotFound(path) => Self::FileNotFound(path),
            CollectionError::SerdeJson(error) => Self::Serde(error),
            CollectionError::General(message) => Self::General(message),
            CollectionError::Git(error) => Self::Git(error),
            CollectionError::Actor(error) => Self::Actor(error),
            CollectionError::PageSource(error) => error.into(),
            CollectionError::DocumentNameConflict(conflict) => Self::DocumentNameConflict(conflict),
            CollectionError::Recovery { cause, paths } => Self::Recovery { cause, paths },
        }
    }
}

impl From<PageSourceError> for PageError {
    fn from(error: PageSourceError) -> Self {
        match error {
            PageSourceError::Missing(path) => Self::FileNotFound(path),
            PageSourceError::SpaceNotFound(id) => Self::SpaceNotFound(id),
            PageSourceError::InvalidConfig(error) => Self::Serde(error),
            PageSourceError::InvalidPath(path) | PageSourceError::InvalidOwner(path) => {
                Self::PathNotAccessible(path)
            }
            PageSourceError::InvalidEncoding(path) => Self::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("invalid UTF-8: {path}"),
            )),
            PageSourceError::Access(path) => Self::Io(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                path,
            )),
            PageSourceError::Io(error) => Self::Io(error),
        }
    }
}

impl From<IndexError> for PageError {
    fn from(error: IndexError) -> Self {
        match error {
            IndexError::Io(error) => Self::Io(error),
            IndexError::Sqlx(error) => Self::Db(error),
            IndexError::Git(error) => Self::Git(error),
            IndexError::AgentContext(error) => Self::AgentContext(error),
            IndexError::SpaceNotFound(id) => Self::SpaceNotFound(id),
            IndexError::Index(message) => Self::Index(message),
        }
    }
}

impl From<IndexUpdateError> for PageError {
    fn from(error: IndexUpdateError) -> Self {
        match error {
            IndexUpdateError::Sqlx(error) => Self::Db(error),
            IndexUpdateError::Index(error) => error.into(),
            IndexUpdateError::Routine(error) => Self::Routine(error),
            IndexUpdateError::Observation(error) => Self::Observation(error),
        }
    }
}

impl From<ContentTreeError> for PageError {
    fn from(error: ContentTreeError) -> Self {
        match error {
            ContentTreeError::Io(error) => Self::Io(error),
            ContentTreeError::Serde(error) => Self::Serde(error),
            ContentTreeError::FileNotFound(path) => Self::FileNotFound(path),
            ContentTreeError::PathNotAccessible(path) => Self::PathNotAccessible(path),
            ContentTreeError::Source(error) => error.into(),
            ContentTreeError::Invalid(message) => Self::General(message),
        }
    }
}

impl From<FrontmatterError> for PageError {
    fn from(error: FrontmatterError) -> Self {
        match error {
            FrontmatterError::Parse(message) => Self::FrontmatterParse(message),
            FrontmatterError::InvalidField(_) => Self::General(error.to_string()),
        }
    }
}

impl From<ManagedRouteError> for PageError {
    fn from(error: ManagedRouteError) -> Self {
        match error {
            ManagedRouteError::Io(error) => Self::Io(error),
            ManagedRouteError::Malformed(message) => Self::Storage(message),
        }
    }
}

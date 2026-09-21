//! Business-error mapping of `svode-core` domain errors.
//!
//! Codes and messages keep the established public contract: the listed
//! stable codes are distinguished and every other domain failure is
//! `SVODE_ERROR` with a readable message.

use svode_core::actors::ActorError;
use svode_core::agent_adapters::SourceRegistryError;
use svode_core::agent_context::AgentContextError;
use svode_core::collections::CollectionError;
use svode_core::content_tree::ContentTreeError;
use svode_core::git::GitError;
use svode_core::index::IndexError;
use svode_core::page::{PageError, PageSourceError};
use svode_core::routines::RoutineStoreError;
use svode_core::routines::local::LocalConfigError;
use svode_core::routines::observation::ObservationError;

use crate::error::McpBusinessError;

const SVODE_ERROR: &str = "SVODE_ERROR";

fn file_not_found(path: String) -> McpBusinessError {
    McpBusinessError::new("FILE_NOT_FOUND", format!("File not found: {path}"))
}

fn path_not_accessible(path: String) -> McpBusinessError {
    McpBusinessError::new(
        "PATH_NOT_ACCESSIBLE",
        format!("Path not accessible: {path}"),
    )
}

fn space_not_found(id: String) -> McpBusinessError {
    McpBusinessError::new("SPACE_NOT_FOUND", format!("Space not found: {id}"))
}

fn index(message: String) -> McpBusinessError {
    McpBusinessError::new("INDEX_ERROR", format!("Index error: {message}"))
}

fn database(error: sqlx::Error) -> McpBusinessError {
    McpBusinessError::new("DATABASE_ERROR", format!("Database error: {error}"))
}

fn io(error: std::io::Error) -> McpBusinessError {
    McpBusinessError::new(SVODE_ERROR, format!("IO error: {error}"))
}

fn serde(error: serde_json::Error) -> McpBusinessError {
    McpBusinessError::new(SVODE_ERROR, format!("Serialization error: {error}"))
}

fn frontmatter(message: String) -> McpBusinessError {
    McpBusinessError::new(SVODE_ERROR, format!("Frontmatter parse error: {message}"))
}

fn general(message: impl Into<String>) -> McpBusinessError {
    McpBusinessError::new(SVODE_ERROR, message)
}

fn recovery(cause: String, paths: Vec<String>) -> McpBusinessError {
    McpBusinessError::new(
        "PAGE_WRITE_RECOVERY_FAILED",
        format!("Page write recovery failed after {cause}; unrestored paths: {paths:?}"),
    )
}

fn name_conflict() -> McpBusinessError {
    McpBusinessError::new(
        "PAGE_NAME_CONFLICT",
        "Page name is already used in this container",
    )
}

impl From<GitError> for McpBusinessError {
    fn from(error: GitError) -> Self {
        let code = match &error {
            GitError::GitNotFound => "GIT_NOT_FOUND",
            GitError::GitCommandFailed(_) => "GIT_COMMAND_FAILED",
            GitError::PathNotAccessible(_) => "PATH_NOT_ACCESSIBLE",
            GitError::RepositoryAccessDenied { .. } => "REPOSITORY_ACCESS_DENIED",
            GitError::Conflict(_) => "GIT_CONFLICT",
            GitError::AuthRequired(_) => "GIT_AUTH_REQUIRED",
            GitError::NoRemote => "GIT_NO_REMOTE",
            _ => SVODE_ERROR,
        };
        // Git error wording already matches the public messages.
        McpBusinessError::new(code, error.to_string())
    }
}

impl From<PageSourceError> for McpBusinessError {
    fn from(error: PageSourceError) -> Self {
        match error {
            PageSourceError::Missing(path) => file_not_found(path),
            PageSourceError::SpaceNotFound(id) => space_not_found(id),
            PageSourceError::InvalidConfig(error) => serde(error),
            PageSourceError::InvalidPath(path) | PageSourceError::InvalidOwner(path) => {
                path_not_accessible(path)
            }
            PageSourceError::InvalidEncoding(path) => io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("invalid UTF-8: {path}"),
            )),
            PageSourceError::Access(path) => io(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                path,
            )),
            PageSourceError::Io(error) => io(error),
        }
    }
}

impl From<ContentTreeError> for McpBusinessError {
    fn from(error: ContentTreeError) -> Self {
        match error {
            ContentTreeError::Io(error) => io(error),
            ContentTreeError::Serde(error) => serde(error),
            ContentTreeError::FileNotFound(path) => file_not_found(path),
            ContentTreeError::PathNotAccessible(path) => path_not_accessible(path),
            ContentTreeError::Source(error) => error.into(),
            ContentTreeError::Invalid(message) => general(message),
        }
    }
}

impl From<ActorError> for McpBusinessError {
    fn from(error: ActorError) -> Self {
        match error {
            ActorError::Io(error) => io(error),
            ActorError::Git(error) => error.into(),
            ActorError::GitCommandFailed(message) => GitError::GitCommandFailed(message).into(),
            ActorError::FileNotFound(path) => file_not_found(path),
            ActorError::General(message) => general(message),
        }
    }
}

impl From<AgentContextError> for McpBusinessError {
    fn from(error: AgentContextError) -> Self {
        match error {
            AgentContextError::PathNotAccessible(path)
            | AgentContextError::SourceRegistry(SourceRegistryError::PathNotAccessible(path)) => {
                path_not_accessible(path)
            }
            AgentContextError::General(message) => general(message),
        }
    }
}

impl From<IndexError> for McpBusinessError {
    fn from(error: IndexError) -> Self {
        match error {
            IndexError::Io(error) => io(error),
            IndexError::Sqlx(error) => database(error),
            IndexError::Git(error) => error.into(),
            IndexError::AgentContext(error) => error.into(),
            IndexError::SpaceNotFound(id) => space_not_found(id),
            IndexError::Index(message) => index(message),
        }
    }
}

impl From<LocalConfigError> for McpBusinessError {
    fn from(error: LocalConfigError) -> Self {
        match error {
            LocalConfigError::Io(error) => io(error),
            LocalConfigError::Serde(error) => serde(error),
            LocalConfigError::Storage(error) => general(format!("Storage: {error}")),
        }
    }
}

impl From<RoutineStoreError> for McpBusinessError {
    fn from(error: RoutineStoreError) -> Self {
        match error {
            RoutineStoreError::Io(error) => io(error),
            RoutineStoreError::Sqlx(error) => database(error),
            RoutineStoreError::Index(error) => error.into(),
            RoutineStoreError::Local(error) => error.into(),
            RoutineStoreError::General(message) => general(message),
        }
    }
}

impl From<ObservationError> for McpBusinessError {
    fn from(error: ObservationError) -> Self {
        match error {
            ObservationError::Sqlx(error) => database(error),
            ObservationError::Serde(error) => serde(error),
        }
    }
}

impl From<PageError> for McpBusinessError {
    fn from(error: PageError) -> Self {
        match error {
            PageError::Io(error) => io(error),
            PageError::Serde(error) => serde(error),
            PageError::FileNotFound(path) => file_not_found(path),
            PageError::FileAlreadyExists(path) => McpBusinessError::new(
                "FILE_ALREADY_EXISTS",
                format!("File already exists: {path}"),
            ),
            PageError::FrontmatterParse(message) => frontmatter(message),
            PageError::SpaceNotFound(id) => space_not_found(id),
            PageError::PathNotAccessible(path) => path_not_accessible(path),
            PageError::Index(message) => index(message),
            PageError::Db(error) => database(error),
            PageError::Storage(message) => general(format!("Storage: {message}")),
            PageError::DocumentNameConflict(_) => name_conflict(),
            PageError::Recovery { cause, paths } => recovery(cause, paths),
            PageError::General(message) => general(message),
            PageError::Git(error) => error.into(),
            PageError::Actor(error) => error.into(),
            PageError::AgentContext(error) => error.into(),
            PageError::Routine(error) => error.into(),
            PageError::Observation(error) => error.into(),
        }
    }
}

impl From<CollectionError> for McpBusinessError {
    fn from(error: CollectionError) -> Self {
        match error {
            CollectionError::Io(error) => io(error),
            CollectionError::Schema(message) => general(format!("schema error: {message}")),
            CollectionError::Index(message) => index(message),
            CollectionError::Sqlx(error) => database(error),
            CollectionError::FrontmatterParse(message) => frontmatter(message),
            CollectionError::FileNotFound(path) => file_not_found(path),
            CollectionError::SerdeJson(error) => serde(error),
            CollectionError::General(message) => general(message),
            CollectionError::Git(error) => error.into(),
            CollectionError::Actor(error) => error.into(),
            CollectionError::PageSource(error) => error.into(),
            CollectionError::DocumentNameConflict(_) => name_conflict(),
            CollectionError::Recovery { cause, paths } => recovery(cause, paths),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_codes_survive_core_mapping() {
        let cases: Vec<(McpBusinessError, &str)> = vec![
            (
                GitError::RepositoryAccessDenied {
                    repository_id: "repo".to_string(),
                    status: "read_only".to_string(),
                    reason: "none".to_string(),
                }
                .into(),
                "REPOSITORY_ACCESS_DENIED",
            ),
            (
                PageError::DocumentNameConflict(svode_core::page::naming::DocumentNameConflict {
                    parent_path: None,
                    conflicts: Vec::new(),
                })
                .into(),
                "PAGE_NAME_CONFLICT",
            ),
            (
                PageError::Recovery {
                    cause: "rename".to_string(),
                    paths: vec!["a.md".to_string()],
                }
                .into(),
                "PAGE_WRITE_RECOVERY_FAILED",
            ),
            (
                PageError::FileNotFound("a.md".into()).into(),
                "FILE_NOT_FOUND",
            ),
            (
                PageSourceError::SpaceNotFound("child".into()).into(),
                "SPACE_NOT_FOUND",
            ),
            (
                PageSourceError::InvalidPath("../x".into()).into(),
                "PATH_NOT_ACCESSIBLE",
            ),
            (
                ContentTreeError::FileNotFound("missing".into()).into(),
                "FILE_NOT_FOUND",
            ),
            (CollectionError::Index("stale".into()).into(), "INDEX_ERROR"),
            (CollectionError::Schema("bad".into()).into(), SVODE_ERROR),
        ];
        for (error, code) in cases {
            assert_eq!(error.code, code, "{}", error.message);
        }
    }

    #[test]
    fn messages_keep_the_established_wording() {
        let denied: McpBusinessError = GitError::RepositoryAccessDenied {
            repository_id: "repo".to_string(),
            status: "read_only".to_string(),
            reason: "none".to_string(),
        }
        .into();
        assert!(denied.message.contains("status=read_only"));
        let missing: McpBusinessError = PageError::FileNotFound("a.md".into()).into();
        assert_eq!(missing.message, "File not found: a.md");
    }
}

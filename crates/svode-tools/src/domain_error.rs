//! Business-error mapping of `svode-core` domain errors.
//!
//! Codes and messages keep the established public contract: the listed
//! stable codes are distinguished and every other domain failure is
//! `SVODE_ERROR` with a readable message.

use svode_core::actors::ActorError;
use svode_core::agent_adapters::SourceRegistryError;
use svode_core::agent_context::AgentContextError;
use svode_core::apps::catalog::AppCatalogError;
use svode_core::apps::manifest::AppManifestError;
use svode_core::collections::CollectionError;
use svode_core::content_tree::ContentTreeError;
use svode_core::git::GitError;
use svode_core::index::IndexError;
use svode_core::index::freshness::IndexUnavailable;
use svode_core::page::{PageError, PageSourceError, TitledContent};
use svode_core::project::ProjectError;
use svode_core::project::registry::RegistryError;
use svode_core::routines::RoutineStoreError;
use svode_core::routines::local::LocalConfigError;
use svode_core::routines::observation::ObservationError;
use svode_core::routines::service::RoutineServiceError;
use svode_core::space_config::SpaceConfigError;

use crate::error::ToolError;

const SVODE_ERROR: &str = "SVODE_ERROR";

fn file_not_found(path: String) -> ToolError {
    ToolError::new("FILE_NOT_FOUND", format!("File not found: {path}"))
}

fn path_not_accessible(path: String) -> ToolError {
    ToolError::new(
        "PATH_NOT_ACCESSIBLE",
        format!("Path not accessible: {path}"),
    )
}

fn file_already_exists(path: String) -> ToolError {
    ToolError::new(
        "FILE_ALREADY_EXISTS",
        format!("File already exists: {path}"),
    )
}

fn space_not_found(id: String) -> ToolError {
    ToolError::new("SPACE_NOT_FOUND", format!("Space not found: {id}"))
}

fn index(message: String) -> ToolError {
    ToolError::new("INDEX_ERROR", format!("Index error: {message}"))
}

fn database(error: sqlx::Error) -> ToolError {
    ToolError::new("DATABASE_ERROR", format!("Database error: {error}"))
}

fn io(error: std::io::Error) -> ToolError {
    ToolError::new(SVODE_ERROR, format!("IO error: {error}"))
}

fn serde(error: serde_json::Error) -> ToolError {
    ToolError::new(SVODE_ERROR, format!("Serialization error: {error}"))
}

fn frontmatter(message: String) -> ToolError {
    ToolError::new(SVODE_ERROR, format!("Frontmatter parse error: {message}"))
}

fn general(message: impl Into<String>) -> ToolError {
    ToolError::new(SVODE_ERROR, message)
}

fn recovery(cause: String, paths: Vec<String>) -> ToolError {
    ToolError::new(
        "PAGE_WRITE_RECOVERY_FAILED",
        format!("Page write recovery failed after {cause}; unrestored paths: {paths:?}"),
    )
}

fn invalid_encoding(path: String) -> ToolError {
    ToolError::new(
        "INVALID_SOURCE_ENCODING",
        format!("Page source is not UTF-8: {path}"),
    )
}

/// Busy or stale target of a source write, before any effect.
fn source_refused(code: &str, message: String, path: String) -> ToolError {
    ToolError::new(code, message).with_evidence("path", serde_json::Value::String(path))
}

/// A rename by path of content named by its title; the message names the
/// title change that renames it.
fn title_rename_required(path: String, kind: TitledContent) -> ToolError {
    let how = match kind {
        TitledContent::Page => {
            "update_page_metadata with a new title (CLI: svode page meta set --title)"
        }
        TitledContent::CollectionItem => {
            "update_collection_item_metadata or update_collection_item_fields with a new title (CLI: svode item meta set --title or a title in svode item fields set)"
        }
        TitledContent::Collection => {
            "update_collection_metadata with a new title (CLI: svode collection meta set --title)"
        }
    };
    ToolError::new(
        "TITLE_RENAME_REQUIRED",
        format!(
            "{path} is a {kind}: rename_content renames only folders without a title and changed nothing. Rename the {kind} by changing its title with {how}."
        ),
    )
}

fn unsupported_rename_target(path: String) -> ToolError {
    ToolError::new(
        "UNSUPPORTED_RENAME_TARGET",
        format!(
            "{path} cannot be renamed: rename_content renames only folders without a title, not files, child Space directories or system paths, and changed nothing."
        ),
    )
}

fn unsupported_move_parent(path: String) -> ToolError {
    ToolError::new(
        "UNSUPPORTED_MOVE_PARENT",
        format!(
            "{path} cannot be the parent of this move and nothing changed: move_content moves under a folder, Collection or folder Page (or its README.md), under a leaf Page, which becomes a folder Page first, or to the Space root with an empty toParent; not under a file that is not a Markdown Page, the moved content itself or a path inside it."
        ),
    )
}

/// A write addressed through one Space at a path that a registered child
/// Space owns; the message names that Space for the retry.
fn path_in_other_space(path: String, space_id: String) -> ToolError {
    ToolError::new(
        "PATH_IN_OTHER_SPACE",
        format!(
            "{path} belongs to Space {space_id}, not to the Space this operation addressed, and nothing changed; run the operation in Space {space_id} (spaceId \"{space_id}\", CLI --space {space_id}) with the path relative to it."
        ),
    )
    .with_evidence("path", serde_json::Value::String(path))
    .with_evidence("spaceId", serde_json::Value::String(space_id))
}

fn name_conflict() -> ToolError {
    ToolError::new(
        "PAGE_NAME_CONFLICT",
        "Page name is already used in this container",
    )
}

/// Next step of a mutation refused by the repository access gate: access is
/// verified explicitly, never by the refused write itself.
const ACCESS_HINT: &str = "Verify repository access with `svode git access verify` for this Space or in Svode Desktop, then retry.";

impl From<GitError> for ToolError {
    fn from(error: GitError) -> Self {
        if let GitError::SourceBusy { path } = &error {
            return source_refused("SOURCE_BUSY", error.to_string(), path.clone());
        }
        if let GitError::RepositoryAccessDenied {
            repository_id,
            status,
            reason,
        } = &error
        {
            return ToolError::new("REPOSITORY_ACCESS_DENIED", error.to_string())
                .with_evidence("repositoryId", repository_id.as_str().into())
                .with_evidence("status", status.as_str().into())
                .with_evidence("reason", reason.as_str().into())
                .with_evidence("hint", ACCESS_HINT.into());
        }
        let code = match &error {
            GitError::GitNotFound => "GIT_NOT_FOUND",
            GitError::GitCommandFailed(_)
            | GitError::StatusTimedOut { .. }
            | GitError::SyncFailed(_) => "GIT_COMMAND_FAILED",
            GitError::PathNotAccessible(_) => "PATH_NOT_ACCESSIBLE",
            GitError::RepositoryAccessDenied { .. } => "REPOSITORY_ACCESS_DENIED",
            GitError::Conflict(_) | GitError::ConflictMarkers { .. } => "GIT_CONFLICT",
            GitError::AuthRequired(_) => "GIT_AUTH_REQUIRED",
            GitError::NoRemote => "GIT_NO_REMOTE",
            _ => SVODE_ERROR,
        };
        // Git error wording already matches the public messages.
        ToolError::new(code, error.to_string())
    }
}

impl From<PageSourceError> for ToolError {
    fn from(error: PageSourceError) -> Self {
        match error {
            PageSourceError::Missing(path) => file_not_found(path),
            PageSourceError::SpaceNotFound(id) => space_not_found(id),
            PageSourceError::InvalidConfig(error) => serde(error),
            PageSourceError::InvalidPath(path)
            | PageSourceError::Forbidden(path)
            | PageSourceError::InvalidOwner(path) => path_not_accessible(path),
            PageSourceError::InvalidEncoding(path) => invalid_encoding(path),
            PageSourceError::Access(path) => io(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                path,
            )),
            PageSourceError::Io(error) => io(error),
        }
    }
}

impl From<ContentTreeError> for ToolError {
    fn from(error: ContentTreeError) -> Self {
        match error {
            ContentTreeError::Io(error) => io(error),
            ContentTreeError::Serde(error) => serde(error),
            ContentTreeError::FileNotFound(path) => file_not_found(path),
            ContentTreeError::PathNotAccessible(path) => path_not_accessible(path),
            ContentTreeError::Source(error) => error.into(),
            ContentTreeError::Invalid(message) => general(message),
            error @ ContentTreeError::UnreadableOrder(_) => general(error.to_string()),
        }
    }
}

impl From<AppCatalogError> for ToolError {
    fn from(error: AppCatalogError) -> Self {
        match error {
            error @ AppCatalogError::NotAnApp(_) => ToolError::new("NOT_AN_APP", error.to_string()),
            AppCatalogError::OwnerNotFound(path) => file_not_found(path),
            AppCatalogError::Manifest(AppManifestError::Io(error)) => io(error),
            AppCatalogError::Manifest(AppManifestError::PageSource(error)) => error.into(),
            AppCatalogError::Manifest(AppManifestError::Git(error)) => error.into(),
            AppCatalogError::Manifest(AppManifestError::PathNotAccessible(path)) => {
                path_not_accessible(path)
            }
            AppCatalogError::Tree(error) => error.into(),
        }
    }
}

impl From<ActorError> for ToolError {
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

impl From<AgentContextError> for ToolError {
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

/// An index-backed read without a prepared index: the caller gets the
/// diagnostics instead of an empty result.
impl From<IndexUnavailable> for ToolError {
    fn from(error: IndexUnavailable) -> Self {
        ToolError::new("INDEX_UNAVAILABLE", error.message).with_evidence(
            "diagnostics",
            serde_json::to_value(error.diagnostics).unwrap_or_default(),
        )
    }
}

impl From<IndexError> for ToolError {
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

impl From<LocalConfigError> for ToolError {
    fn from(error: LocalConfigError) -> Self {
        match error {
            LocalConfigError::Io(error) => io(error),
            LocalConfigError::Serde(error) => serde(error),
            LocalConfigError::Storage(error) => general(format!("Storage: {error}")),
        }
    }
}

impl From<RoutineStoreError> for ToolError {
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

impl From<RoutineServiceError> for ToolError {
    fn from(error: RoutineServiceError) -> Self {
        match error {
            RoutineServiceError::Io(error) => io(error),
            RoutineServiceError::Serde(error) => serde(error),
            RoutineServiceError::FileNotFound(path) => file_not_found(path),
            RoutineServiceError::FileAlreadyExists(path) => file_already_exists(path),
            RoutineServiceError::SpaceNotFound(id) => space_not_found(id),
            RoutineServiceError::PathNotAccessible(path) => path_not_accessible(path),
            RoutineServiceError::Db(error) => database(error),
            RoutineServiceError::General(message) => general(message),
            RoutineServiceError::Git(error) => error.into(),
            RoutineServiceError::Index(error) => error.into(),
            RoutineServiceError::Store(error) => error.into(),
        }
    }
}

impl From<ObservationError> for ToolError {
    fn from(error: ObservationError) -> Self {
        match error {
            ObservationError::Sqlx(error) => database(error),
            ObservationError::Serde(error) => serde(error),
        }
    }
}

impl From<PageError> for ToolError {
    fn from(error: PageError) -> Self {
        let message = error.to_string();
        match error {
            PageError::Io(error) => io(error),
            PageError::Serde(error) => serde(error),
            PageError::FileNotFound(path) => file_not_found(path),
            PageError::FileAlreadyExists(path) => file_already_exists(path),
            PageError::FrontmatterParse(message) => frontmatter(message),
            PageError::SpaceNotFound(id) => space_not_found(id),
            PageError::PathNotAccessible(path) => path_not_accessible(path),
            PageError::Index(message) => index(message),
            PageError::Db(error) => database(error),
            PageError::Storage(message) => general(format!("Storage: {message}")),
            PageError::DocumentNameConflict(_) => name_conflict(),
            PageError::Recovery { cause, paths } => recovery(cause, paths),
            PageError::InvalidEncoding(path) => invalid_encoding(path),
            PageError::SourceBusy { path } => source_refused("SOURCE_BUSY", message, path),
            PageError::SourceStale { path } => source_refused("SOURCE_STALE", message, path),
            PageError::TitleRenameRequired { path, kind } => title_rename_required(path, kind),
            PageError::UnsupportedRenameTarget { path } => unsupported_rename_target(path),
            PageError::UnsupportedMoveParent { path } => unsupported_move_parent(path),
            PageError::PathInOtherSpace { path, space_id } => path_in_other_space(path, space_id),
            PageError::General(message) => general(message),
            PageError::Git(error) => error.into(),
            PageError::Actor(error) => error.into(),
            PageError::AgentContext(error) => error.into(),
            PageError::Routine(error) => error.into(),
            PageError::Observation(error) => error.into(),
        }
    }
}

impl From<SpaceConfigError> for ToolError {
    fn from(error: SpaceConfigError) -> Self {
        match error {
            error @ SpaceConfigError::Unreadable(_) => {
                ToolError::new("INVALID_PROJECT_CONFIG", error.to_string())
            }
            SpaceConfigError::Missing(path) => {
                ToolError::new("PROJECT_UNAVAILABLE", format!("File not found: {path}"))
            }
            SpaceConfigError::Io(error) => io(error),
            SpaceConfigError::Serde(error) => serde(error),
            SpaceConfigError::Storage(error) => general(format!("Storage: {error}")),
            error @ SpaceConfigError::Exists => general(error.to_string()),
        }
    }
}

/// The project list of the device: another process holding it past the
/// bounded wait is busy like a held source.
impl From<RegistryError> for ToolError {
    fn from(error: RegistryError) -> Self {
        match error {
            RegistryError::Busy(path) => source_refused(
                "SOURCE_BUSY",
                format!("The project list is busy in another Svode process: {path}"),
                path,
            ),
            RegistryError::Io(error) => io(error),
            RegistryError::Json(error) => serde(error),
            error @ (RegistryError::NotRegistered | RegistryError::Ambiguous) => {
                general(error.to_string())
            }
        }
    }
}

/// A refused or failed creation of a Project or Space (Stage 11 05 «Ошибки
/// и stable codes»). A rollback that left paths keeps the code of its cause
/// and names the paths in `remaining`.
impl From<ProjectError> for ToolError {
    fn from(error: ProjectError) -> Self {
        match error {
            ProjectError::InvalidFolder(folder) => ToolError::new(
                "INVALID_PATH",
                format!(
                    "The space folder must be one segment of ASCII letters, digits, '-' and '_': {folder}"
                ),
            ),
            ProjectError::FileAlreadyExists(path) => file_already_exists(path),
            ProjectError::PathNotAccessible(path) => path_not_accessible(path),
            error @ ProjectError::ProjectAlreadyExists(_) => {
                ToolError::new("PROJECT_ALREADY_EXISTS", error.to_string())
            }
            ProjectError::ProjectNested { path, project } => ToolError::new(
                "PROJECT_NESTED",
                format!("{path} is inside the Svode project {project}"),
            )
            .with_evidence("path", path.into())
            .with_evidence("project", project.into())
            .with_evidence(
                "hint",
                "Create a space in that project with create_space (CLI: svode space create) instead of a new project.".into(),
            ),
            ProjectError::Registry(error) => error.into(),
            error @ ProjectError::NoProjectRepository => general(format!(
                "{error}: create an inline or independent space, or initialize Git in the project first"
            )),
            error @ ProjectError::NameRequired => general(error.to_string()),
            ProjectError::Config(error) => error.into(),
            ProjectError::LocalConfig(error) => error.into(),
            ProjectError::Git(error) => error.into(),
            ProjectError::Io(error) => io(error),
            ProjectError::RollbackIncomplete { cause, remaining } => {
                let cause = ToolError::from(*cause);
                let message = format!(
                    "{}; the rollback left {}",
                    cause.message,
                    remaining.join(", ")
                );
                ToolError { message, ..cause }.with_evidence("remaining", remaining.into())
            }
        }
    }
}

impl From<CollectionError> for ToolError {
    fn from(error: CollectionError) -> Self {
        match error {
            CollectionError::Io(error) => io(error),
            CollectionError::Schema(message) => general(format!("schema error: {message}")),
            CollectionError::NewerVersion(message) => general(message),
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
        let cases: Vec<(ToolError, &str)> = vec![
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
            (
                AppCatalogError::NotAnApp("notes".into()).into(),
                "NOT_AN_APP",
            ),
            (
                AppCatalogError::OwnerNotFound("missing".into()).into(),
                "FILE_NOT_FOUND",
            ),
            (
                AppCatalogError::Manifest(AppManifestError::PathNotAccessible("child".into()))
                    .into(),
                "PATH_NOT_ACCESSIBLE",
            ),
            (CollectionError::Index("stale".into()).into(), "INDEX_ERROR"),
            (CollectionError::Schema("bad".into()).into(), SVODE_ERROR),
            (
                RoutineServiceError::PathNotAccessible("tasks".into()).into(),
                "PATH_NOT_ACCESSIBLE",
            ),
            (
                RoutineServiceError::Git(GitError::GitNotFound).into(),
                "GIT_NOT_FOUND",
            ),
            (
                GitError::ConflictMarkers {
                    path: "plan.md".to_string(),
                }
                .into(),
                "GIT_CONFLICT",
            ),
            (
                ProjectError::InvalidFolder("Клиенты".into()).into(),
                "INVALID_PATH",
            ),
            (
                ProjectError::FileAlreadyExists("/p/clients".into()).into(),
                "FILE_ALREADY_EXISTS",
            ),
            (
                ProjectError::PathNotAccessible("/p".into()).into(),
                "PATH_NOT_ACCESSIBLE",
            ),
            (
                ProjectError::Git(GitError::GitNotFound).into(),
                "GIT_NOT_FOUND",
            ),
            (
                ProjectError::Git(GitError::SourceBusy {
                    path: "/p/.svode/config.json".into(),
                })
                .into(),
                "SOURCE_BUSY",
            ),
            (
                ProjectError::Git(GitError::RepositoryAccessDenied {
                    repository_id: "repo".into(),
                    status: "read_only".into(),
                    reason: "none".into(),
                })
                .into(),
                "REPOSITORY_ACCESS_DENIED",
            ),
            (
                ProjectError::Config(SpaceConfigError::Unreadable(
                    svode_core::space_config::Unreadable::Conflict,
                ))
                .into(),
                "INVALID_PROJECT_CONFIG",
            ),
            (
                ProjectError::ProjectAlreadyExists("/p".into()).into(),
                "PROJECT_ALREADY_EXISTS",
            ),
            (
                ProjectError::Registry(RegistryError::Busy("/c/spaces.json".into())).into(),
                "SOURCE_BUSY",
            ),
            (ProjectError::NoProjectRepository.into(), SVODE_ERROR),
            (ProjectError::NameRequired.into(), SVODE_ERROR),
        ];
        for (error, code) in cases {
            assert_eq!(error.code, code, "{}", error.message);
        }
    }

    #[test]
    fn a_nested_project_names_the_enclosing_project_and_the_next_step() {
        let nested: ToolError = ProjectError::ProjectNested {
            path: "/work/acme/docs".into(),
            project: "/work/acme".into(),
        }
        .into();
        assert_eq!(nested.code, "PROJECT_NESTED");
        assert_eq!(nested.evidence["path"], "/work/acme/docs");
        assert_eq!(nested.evidence["project"], "/work/acme");
        assert!(
            nested.evidence["hint"]
                .as_str()
                .unwrap()
                .contains("create_space")
        );
        let busy: ToolError =
            ProjectError::Registry(RegistryError::Busy("/c/spaces.json".into())).into();
        assert_eq!(busy.evidence["path"], "/c/spaces.json");
    }

    #[test]
    fn messages_keep_the_established_wording() {
        let denied: ToolError = GitError::RepositoryAccessDenied {
            repository_id: "repo".to_string(),
            status: "read_only".to_string(),
            reason: "none".to_string(),
        }
        .into();
        assert!(denied.message.contains("status=read_only"));
        // The refusal is typed and names the next step.
        assert_eq!(denied.evidence["status"], "read_only");
        assert_eq!(denied.evidence["reason"], "none");
        assert_eq!(denied.evidence["repositoryId"], "repo");
        assert!(
            denied.evidence["hint"]
                .as_str()
                .unwrap()
                .contains("svode git access verify")
        );
        let missing: ToolError = PageError::FileNotFound("a.md".into()).into();
        assert_eq!(missing.message, "File not found: a.md");
        let markers: ToolError = GitError::ConflictMarkers {
            path: "plan.md".to_string(),
        }
        .into();
        assert_eq!(
            markers.message,
            "Git conflict: Conflict markers remain in plan.md"
        );
    }
}

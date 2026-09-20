use serde::Serialize;

impl From<svode_core::actors::ActorError> for AppError {
    fn from(error: svode_core::actors::ActorError) -> Self {
        match error {
            svode_core::actors::ActorError::Io(error) => Self::Io(error),
            svode_core::actors::ActorError::Git(error) => error.into(),
            svode_core::actors::ActorError::GitCommandFailed(message) => {
                Self::GitCommandFailed(message)
            }
            svode_core::actors::ActorError::FileNotFound(message) => Self::FileNotFound(message),
            svode_core::actors::ActorError::General(message) => Self::General(message),
        }
    }
}

impl From<svode_core::collections::CollectionError> for AppError {
    fn from(error: svode_core::collections::CollectionError) -> Self {
        match error {
            svode_core::collections::CollectionError::Io(error) => Self::Io(error),
            svode_core::collections::CollectionError::Schema(message) => {
                Self::General(format!("schema error: {message}"))
            }
            svode_core::collections::CollectionError::Index(message) => Self::Index(message),
            svode_core::collections::CollectionError::Sqlx(error) => Self::Db(error),
            svode_core::collections::CollectionError::FrontmatterParse(message) => {
                Self::FrontmatterParse(message)
            }
            svode_core::collections::CollectionError::FileNotFound(path) => {
                Self::FileNotFound(path)
            }
            svode_core::collections::CollectionError::SerdeJson(error) => Self::Serde(error),
            svode_core::collections::CollectionError::General(message) => Self::General(message),
            svode_core::collections::CollectionError::Git(error) => error.into(),
            svode_core::collections::CollectionError::Actor(error) => error.into(),
            svode_core::collections::CollectionError::PageSource(error) => error.into(),
            svode_core::collections::CollectionError::DocumentNameConflict(conflict) => {
                Self::DocumentNameConflict(conflict)
            }
            svode_core::collections::CollectionError::Recovery { cause, paths } => {
                Self::PageWriteRecovery { cause, paths }
            }
        }
    }
}

impl From<svode_core::agent_context::AgentContextError> for AppError {
    fn from(error: svode_core::agent_context::AgentContextError) -> Self {
        match error {
            svode_core::agent_context::AgentContextError::PathNotAccessible(message) => {
                Self::PathNotAccessible(message)
            }
            svode_core::agent_context::AgentContextError::General(message) => {
                Self::General(message)
            }
            svode_core::agent_context::AgentContextError::SourceRegistry(
                svode_core::agent_adapters::SourceRegistryError::PathNotAccessible(message),
            ) => Self::PathNotAccessible(message),
        }
    }
}

impl From<svode_core::routines::local::LocalConfigError> for AppError {
    fn from(error: svode_core::routines::local::LocalConfigError) -> Self {
        match error {
            svode_core::routines::local::LocalConfigError::Io(error) => Self::Io(error),
            svode_core::routines::local::LocalConfigError::Serde(error) => Self::Serde(error),
            svode_core::routines::local::LocalConfigError::Storage(error) => {
                Self::Storage(error.to_string())
            }
        }
    }
}

impl From<svode_core::index::IndexError> for AppError {
    fn from(error: svode_core::index::IndexError) -> Self {
        match error {
            svode_core::index::IndexError::Io(error) => Self::Io(error),
            svode_core::index::IndexError::Sqlx(error) => Self::Db(error),
            svode_core::index::IndexError::Git(error) => error.into(),
            svode_core::index::IndexError::AgentContext(error) => error.into(),
            svode_core::index::IndexError::SpaceNotFound(id) => Self::SpaceNotFound(id),
            svode_core::index::IndexError::Index(message) => Self::Index(message),
        }
    }
}

impl From<svode_core::index::update::IndexUpdateError> for AppError {
    fn from(error: svode_core::index::update::IndexUpdateError) -> Self {
        match error {
            svode_core::index::update::IndexUpdateError::Sqlx(error) => Self::Db(error),
            svode_core::index::update::IndexUpdateError::Index(error) => error.into(),
            svode_core::index::update::IndexUpdateError::Routine(error) => error.into(),
            svode_core::index::update::IndexUpdateError::Observation(error) => error.into(),
        }
    }
}

impl From<svode_core::routines::RoutineStoreError> for AppError {
    fn from(error: svode_core::routines::RoutineStoreError) -> Self {
        match error {
            svode_core::routines::RoutineStoreError::Io(error) => Self::Io(error),
            svode_core::routines::RoutineStoreError::Sqlx(error) => Self::Db(error),
            svode_core::routines::RoutineStoreError::Index(error) => error.into(),
            svode_core::routines::RoutineStoreError::Local(error) => error.into(),
            svode_core::routines::RoutineStoreError::General(message) => Self::General(message),
        }
    }
}

impl From<svode_core::routines::service::RoutineServiceError> for AppError {
    fn from(error: svode_core::routines::service::RoutineServiceError) -> Self {
        use svode_core::routines::service::RoutineServiceError;
        match error {
            RoutineServiceError::Io(error) => Self::Io(error),
            RoutineServiceError::Serde(error) => Self::Serde(error),
            RoutineServiceError::FileNotFound(path) => Self::FileNotFound(path),
            RoutineServiceError::FileAlreadyExists(path) => Self::FileAlreadyExists(path),
            RoutineServiceError::SpaceNotFound(id) => Self::SpaceNotFound(id),
            RoutineServiceError::PathNotAccessible(path) => Self::PathNotAccessible(path),
            RoutineServiceError::Db(error) => Self::Db(error),
            RoutineServiceError::General(message) => Self::General(message),
            RoutineServiceError::Git(error) => error.into(),
            RoutineServiceError::Index(error) => error.into(),
            RoutineServiceError::Store(error) => error.into(),
        }
    }
}

impl From<svode_core::routines::observation::ObservationError> for AppError {
    fn from(error: svode_core::routines::observation::ObservationError) -> Self {
        match error {
            svode_core::routines::observation::ObservationError::Sqlx(error) => Self::Db(error),
            svode_core::routines::observation::ObservationError::Serde(error) => Self::Serde(error),
        }
    }
}

impl From<svode_core::apps::manifest::AppManifestError> for AppError {
    fn from(error: svode_core::apps::manifest::AppManifestError) -> Self {
        use svode_core::apps::manifest::AppManifestError;
        match error {
            AppManifestError::Io(error) => Self::Io(error),
            AppManifestError::PageSource(error) => error.into(),
            AppManifestError::Git(error) => error.into(),
            AppManifestError::PathNotAccessible(path) => Self::PathNotAccessible(path),
        }
    }
}

impl From<svode_core::git::GitError> for AppError {
    fn from(error: svode_core::git::GitError) -> Self {
        use svode_core::git::GitError;
        match error {
            GitError::GitNotFound => Self::GitNotFound,
            GitError::GitCommandFailed(message) => Self::GitCommandFailed(message),
            GitError::PathNotAccessible(path) => Self::PathNotAccessible(path),
            GitError::RepositoryAccessDenied {
                repository_id,
                status,
                reason,
            } => Self::RepositoryAccessDenied {
                repository_id,
                status,
                reason,
            },
            GitError::Io(error) => Self::Io(error),
            GitError::Serde(error) => Self::Serde(error),
            GitError::General(message) => Self::General(message),
        }
    }
}

impl From<svode_core::content_tree::ContentTreeError> for AppError {
    fn from(error: svode_core::content_tree::ContentTreeError) -> Self {
        use svode_core::content_tree::ContentTreeError;
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

impl From<svode_core::page::frontmatter::FrontmatterError> for AppError {
    fn from(error: svode_core::page::frontmatter::FrontmatterError) -> Self {
        use svode_core::page::frontmatter::FrontmatterError;
        match error {
            FrontmatterError::Parse(message) => Self::FrontmatterParse(message),
            FrontmatterError::InvalidField(_) => Self::General(error.to_string()),
        }
    }
}

impl From<svode_core::page::PageSourceError> for AppError {
    fn from(error: svode_core::page::PageSourceError) -> Self {
        use svode_core::page::PageSourceError;
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

impl From<svode_core::page::PageError> for AppError {
    fn from(error: svode_core::page::PageError) -> Self {
        use svode_core::page::PageError;
        match error {
            PageError::Io(error) => Self::Io(error),
            PageError::Serde(error) => Self::Serde(error),
            PageError::FileNotFound(path) => Self::FileNotFound(path),
            PageError::FileAlreadyExists(path) => Self::FileAlreadyExists(path),
            PageError::FrontmatterParse(message) => Self::FrontmatterParse(message),
            PageError::SpaceNotFound(id) => Self::SpaceNotFound(id),
            PageError::PathNotAccessible(path) => Self::PathNotAccessible(path),
            PageError::Index(message) => Self::Index(message),
            PageError::Db(error) => Self::Db(error),
            PageError::Storage(message) => Self::Storage(message),
            PageError::DocumentNameConflict(conflict) => Self::DocumentNameConflict(conflict),
            PageError::Recovery { cause, paths } => Self::PageWriteRecovery { cause, paths },
            PageError::General(message) => Self::General(message),
            PageError::Git(error) => error.into(),
            PageError::Actor(error) => error.into(),
            PageError::AgentContext(error) => error.into(),
            PageError::Routine(error) => error.into(),
            PageError::Observation(error) => error.into(),
        }
    }
}

impl From<svode_core::storage::config::StorageConfigError> for AppError {
    fn from(error: svode_core::storage::config::StorageConfigError) -> Self {
        use svode_core::storage::config::StorageConfigError;
        match error {
            StorageConfigError::Missing(path) => Self::FileNotFound(path),
            StorageConfigError::Io(error) => Self::Io(error),
            StorageConfigError::Serde(error) => Self::Serde(error),
        }
    }
}

impl From<svode_core::storage::scope::AssetsScopeError> for AppError {
    fn from(error: svode_core::storage::scope::AssetsScopeError) -> Self {
        use svode_core::storage::scope::AssetsScopeError;
        match error {
            AssetsScopeError::Config(error) => error.into(),
            AssetsScopeError::Index(error) => error.into(),
        }
    }
}

impl From<svode_core::storage::policy::StoragePolicyError> for AppError {
    fn from(error: svode_core::storage::policy::StoragePolicyError) -> Self {
        use svode_core::storage::policy::StoragePolicyError;
        match error {
            StoragePolicyError::Io(error) => Self::Io(error),
            StoragePolicyError::Storage(message) => Self::Storage(message),
            StoragePolicyError::Git(error) => error.into(),
        }
    }
}

impl From<svode_core::storage::routes::ManagedRouteError> for AppError {
    fn from(error: svode_core::storage::routes::ManagedRouteError) -> Self {
        use svode_core::storage::routes::ManagedRouteError;
        match error {
            ManagedRouteError::Io(error) => Self::Io(error),
            ManagedRouteError::Malformed(message) => Self::Storage(message),
        }
    }
}

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
    #[error("Project publication blocked: {reason:?}")]
    GitPublicationBlocked {
        repository: String,
        child: Option<String>,
        reason: crate::git::publication::PublicationBlockReason,
    },

    #[error(
        "Git branch preparation blocked: {reason:?}. Restore the branch and local work in Git, then retry."
    )]
    GitBranchBlocked {
        reason: crate::git::branch::BranchBlockReason,
    },

    #[error("Git save failed during {stage}: {reason} ({path_count} paths)")]
    GitSaveFailed {
        stage: &'static str,
        reason: &'static str,
        exit_code: Option<i32>,
        path_count: usize,
        path_sample: Option<String>,
    },

    #[error("Git conflict: {0}")]
    GitConflict(String),

    #[error("Git auth required: {0}")]
    GitAuthRequired(String),

    #[error(
        "Repository access denied: repository={repository_id}, status={status}, reason={reason}"
    )]
    RepositoryAccessDenied {
        repository_id: String,
        status: String,
        reason: String,
    },

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

    #[error("Page name is already used in this container")]
    DocumentNameConflict(svode_core::page::naming::DocumentNameConflict),

    #[error("Page write recovery failed after {cause}; unrestored paths: {paths:?}")]
    PageWriteRecovery { cause: String, paths: Vec<String> },

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
            AppError::GitPublicationBlocked { .. } => "git_publication_blocked",
            AppError::GitBranchBlocked { .. } => "git_branch_blocked",
            AppError::GitSaveFailed { .. } => "git_save_failed",
            AppError::GitConflict(_) => "git_conflict",
            AppError::GitAuthRequired(_) => "git_auth_required",
            AppError::RepositoryAccessDenied { .. } => "repository_access_denied",
            AppError::GitNoRemote => "git_no_remote",
            AppError::GitRemoteNotEmpty => "git_remote_not_empty",
            AppError::InvalidUrl(_) => "invalid_url",
            AppError::Index(_) => "index",
            AppError::Db(_) => "db",
            AppError::Storage(_) => "storage",
            AppError::StrategyInherited => "strategy_inherited",
            AppError::IdentityMissing => "identity_missing",
            AppError::IdentityInvalid(_) => "identity_invalid",
            AppError::DocumentNameConflict(_) => "page_name_conflict",
            AppError::PageWriteRecovery { .. } => "page_write_recovery",
            AppError::General(_) => "general",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            AppError::PageWriteRecovery { cause, paths } => {
                serde_json::json!({ "kind": self.kind(), "message": self.to_string(), "cause": cause, "paths": paths }).serialize(serializer)
            }
            AppError::GitPublicationBlocked { repository, child, reason } => {
                serde_json::json!({ "kind": self.kind(), "repository": repository, "child": child, "reason": reason }).serialize(serializer)
            }
            AppError::GitBranchBlocked { reason } => {
                serde_json::json!({ "kind": self.kind(), "reason": reason }).serialize(serializer)
            }
            AppError::GitSaveFailed { stage, reason, exit_code, path_count, path_sample } => {
                serde_json::json!({ "kind": self.kind(), "stage": stage, "reason": reason, "exitCode": exit_code, "pathCount": path_count, "pathSample": path_sample }).serialize(serializer)
            }
            AppError::RepositoryAccessDenied {
                repository_id,
                status,
                reason,
            } => {
                #[derive(Serialize)]
                #[serde(rename_all = "camelCase")]
                struct StructuredError<'a> {
                    kind: &'static str,
                    repository_id: &'a str,
                    status: &'a str,
                    reason: &'a str,
                }
                StructuredError {
                    kind: self.kind(),
                    repository_id,
                    status,
                    reason,
                }
                .serialize(serializer)
            }
            AppError::DocumentNameConflict(conflict) => {
                #[derive(Serialize)]
                #[serde(rename_all = "camelCase")]
                struct StructuredError<'a> {
                    kind: &'static str,
                    conflict: &'a svode_core::page::naming::DocumentNameConflict,
                }
                StructuredError {
                    kind: self.kind(),
                    conflict,
                }
                .serialize(serializer)
            }
            _ => serializer.serialize_str(&self.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_name_conflict_serializes_as_structured_tauri_error() {
        let value = serde_json::to_value(AppError::DocumentNameConflict(
            svode_core::page::naming::DocumentNameConflict {
                parent_path: Some("docs".to_string()),
                conflicts: vec![svode_core::page::naming::DocumentNameConflictEvidence {
                    path: "docs/existing.md".to_string(),
                    title: "Existing".to_string(),
                }],
            },
        ))
        .unwrap();

        assert_eq!(value["kind"], "page_name_conflict");
        assert_eq!(value["conflict"]["parentPath"], "docs");
        assert_eq!(
            value["conflict"]["conflicts"][0]["path"],
            "docs/existing.md"
        );
    }

    #[test]
    fn repository_access_denial_serializes_as_structured_tauri_error() {
        let value = serde_json::to_value(AppError::RepositoryAccessDenied {
            repository_id: "repo-opaque".to_string(),
            status: "unknown".to_string(),
            reason: "mutation_plan_changed".to_string(),
        })
        .unwrap();

        assert_eq!(value["kind"], "repository_access_denied");
        assert_eq!(value["repositoryId"], "repo-opaque");
        assert_eq!(value["status"], "unknown");
        assert_eq!(value["reason"], "mutation_plan_changed");
    }
}

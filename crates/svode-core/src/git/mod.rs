pub mod access;
pub mod actor_sources;
pub mod auth;
pub mod autocommit;
pub mod branch;
pub mod cli;
pub mod flow;
pub mod host;
#[cfg(test)]
mod local_policy_tests;
pub mod local_repair;
pub mod operations;
pub mod ops;
pub mod path;
pub mod pending;
pub mod policy;
pub mod publication;
pub mod published_pointer;
pub mod push_rejection;
pub mod readers;
pub mod save;
#[cfg(test)]
mod save_tests;
pub mod staging;
#[cfg(test)]
pub(crate) mod staging_tests;
pub mod state;
pub mod status;
pub mod sync;

#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error("Git not found")]
    GitNotFound,
    #[error("Git command failed: {0}")]
    GitCommandFailed(String),
    #[error("Path not accessible: {0}")]
    PathNotAccessible(String),
    #[error(
        "Repository access denied: repository={repository_id}, status={status}, reason={reason}"
    )]
    RepositoryAccessDenied {
        repository_id: String,
        status: String,
        reason: String,
    },
    #[error("Project publication blocked: {reason:?}")]
    PublicationBlocked {
        repository: String,
        child: Option<String>,
        reason: publication::PublicationBlockReason,
    },
    #[error(
        "Git branch preparation blocked: {reason:?}. Restore the branch and local work in Git, then retry."
    )]
    BranchBlocked { reason: branch::BranchBlockReason },
    #[error("Git push rejected: {reason:?}")]
    PushRejected {
        reason: push_rejection::PushRejectionReason,
        object_count: Option<usize>,
        lfs_declaration: Option<crate::storage::lfs_declaration::LfsDeclarationState>,
    },
    #[error("Git save failed during {stage}: {reason} ({path_count} paths)")]
    SaveFailed {
        stage: &'static str,
        reason: &'static str,
        exit_code: Option<i32>,
        path_count: usize,
        path_sample: Option<String>,
    },
    #[error("Git conflict: {0}")]
    Conflict(String),
    #[error("Git auth required: {0}")]
    AuthRequired(String),
    #[error("Git no remote configured")]
    NoRemote,
    #[error("Remote repository is not empty")]
    RemoteNotEmpty,
    #[error("Invalid URL: {0}")]
    InvalidUrl(String),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("{0}")]
    General(String),
}

impl GitError {
    /// Stable machine-readable error kind of the existing IPC contract.
    pub fn kind(&self) -> &'static str {
        match self {
            GitError::GitNotFound => "git_not_found",
            GitError::GitCommandFailed(_) => "git_command_failed",
            GitError::PathNotAccessible(_) => "path_not_accessible",
            GitError::RepositoryAccessDenied { .. } => "repository_access_denied",
            GitError::PublicationBlocked { .. } => "git_publication_blocked",
            GitError::BranchBlocked { .. } => "git_branch_blocked",
            GitError::PushRejected { .. } => "git_push_rejected",
            GitError::SaveFailed { .. } => "git_save_failed",
            GitError::Conflict(_) => "git_conflict",
            GitError::AuthRequired(_) => "git_auth_required",
            GitError::NoRemote => "git_no_remote",
            GitError::RemoteNotEmpty => "git_remote_not_empty",
            GitError::InvalidUrl(_) => "invalid_url",
            GitError::Io(_) => "io",
            GitError::Serde(_) => "serde",
            GitError::General(_) => "general",
        }
    }
}

/// The transport shape the desktop app already publishes for these failures.
/// A structured variant keeps its fields; everything else stays a message.
impl serde::Serialize for GitError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            GitError::PublicationBlocked {
                repository,
                child,
                reason,
            } => serde_json::json!({
                "kind": self.kind(),
                "repository": repository,
                "child": child,
                "reason": reason,
            })
            .serialize(serializer),
            GitError::BranchBlocked { reason } => {
                serde_json::json!({ "kind": self.kind(), "reason": reason }).serialize(serializer)
            }
            GitError::PushRejected {
                reason,
                object_count,
                lfs_declaration,
            } => serde_json::json!({
                "kind": self.kind(),
                "reason": reason,
                "objectCount": object_count,
                "lfsDeclaration": lfs_declaration,
            })
            .serialize(serializer),
            GitError::SaveFailed {
                stage,
                reason,
                exit_code,
                path_count,
                path_sample,
            } => serde_json::json!({
                "kind": self.kind(),
                "stage": stage,
                "reason": reason,
                "exitCode": exit_code,
                "pathCount": path_count,
                "pathSample": path_sample,
            })
            .serialize(serializer),
            GitError::RepositoryAccessDenied {
                repository_id,
                status,
                reason,
            } => serde_json::json!({
                "kind": self.kind(),
                "repositoryId": repository_id,
                "status": status,
                "reason": reason,
            })
            .serialize(serializer),
            _ => serializer.serialize_str(&self.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structured_failures_keep_their_existing_transport_shape() {
        let blocked = serde_json::to_value(GitError::PublicationBlocked {
            repository: "/repo".to_string(),
            child: Some("child".to_string()),
            reason: publication::PublicationBlockReason::TargetChanged,
        })
        .unwrap();
        assert_eq!(blocked["kind"], "git_publication_blocked");
        assert_eq!(blocked["repository"], "/repo");
        assert_eq!(blocked["child"], "child");
        assert_eq!(blocked["reason"], "target_changed");

        let branch = serde_json::to_value(GitError::BranchBlocked {
            reason: branch::BranchBlockReason::RootDetached,
        })
        .unwrap();
        assert_eq!(branch["kind"], "git_branch_blocked");
        assert_eq!(branch["reason"], "root_detached");

        let save = serde_json::to_value(GitError::SaveFailed {
            stage: "prepare",
            reason: "target_unavailable",
            exit_code: Some(1),
            path_count: 2,
            path_sample: Some("docs/a.md".to_string()),
        })
        .unwrap();
        assert_eq!(save["kind"], "git_save_failed");
        assert_eq!(save["stage"], "prepare");
        assert_eq!(save["reason"], "target_unavailable");
        assert_eq!(save["exitCode"], 1);
        assert_eq!(save["pathCount"], 2);
        assert_eq!(save["pathSample"], "docs/a.md");

        let denied = serde_json::to_value(GitError::RepositoryAccessDenied {
            repository_id: "repo-parent".to_string(),
            status: "unknown".to_string(),
            reason: "mutation_plan_changed".to_string(),
        })
        .unwrap();
        assert_eq!(denied["kind"], "repository_access_denied");
        assert_eq!(denied["repositoryId"], "repo-parent");
        assert_eq!(denied["status"], "unknown");
        assert_eq!(denied["reason"], "mutation_plan_changed");

        // Everything else keeps the plain message of the existing contract.
        assert_eq!(
            serde_json::to_value(GitError::NoRemote).unwrap(),
            serde_json::json!("Git no remote configured")
        );
        assert_eq!(
            serde_json::to_value(GitError::Conflict("merge".to_string())).unwrap(),
            serde_json::json!("Git conflict: merge")
        );
    }
}

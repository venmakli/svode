pub mod access;
pub mod actor_sources;
pub mod auth;
pub mod autocommit;
pub mod branch;
pub mod cli;
pub mod conflict_base;
pub mod conflict_file;
pub mod conflict_kind;
pub mod conflict_properties;
pub mod diagnostics;
pub mod flow;
pub mod host;
#[cfg(test)]
mod init_tests;
pub mod last_sync;
#[cfg(test)]
mod local_policy_tests;
pub mod local_repair;
pub mod markers;
pub mod merge_preflight;
#[cfg(test)]
mod operation_recognition_tests;
pub mod operation_stop;
pub mod operations;
pub mod ops;
pub mod page_merge;
pub mod path;
#[cfg(test)]
mod path_set_tests;
pub mod pending;
pub mod policy;
pub mod publication;
pub mod published_pointer;
pub mod push_rejection;
pub mod readers;
#[cfg(test)]
mod resolve_tests;
pub mod rhythm;
pub mod save;
#[cfg(test)]
pub(crate) mod save_chain_tests;
#[cfg(test)]
mod save_tests;
pub mod service_merge;
pub mod stage_merge;
pub mod staging;
#[cfg(test)]
pub(crate) mod staging_tests;
pub mod state;
pub mod status;
pub mod sync;
pub mod upstream;
pub mod version;
pub mod versions;
pub mod write_guard;

#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error("Git not found")]
    GitNotFound,
    #[error(
        "Git {version} is older than {}, the oldest Git Svode supports. Update Git, then retry.",
        version::GitVersion::MINIMUM
    )]
    GitUnsupported { version: String },
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
    #[error("Source is busy: another Svode operation is writing {path}; retry later")]
    SourceBusy { path: String },
    #[error("Project publication blocked: {reason:?}")]
    PublicationBlocked {
        repository: String,
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
    #[error("Git pull blocked by uncommitted or untracked files in {repository}: {}", files.join(", "))]
    PullBlocked {
        repository: String,
        files: Vec<String>,
    },
    #[error("Git save of {failure}: {reason} ({path_count} paths)")]
    SaveFailed {
        failure: diagnostics::GitFailure,
        reason: &'static str,
        exit_code: Option<i32>,
        path_count: usize,
        path_sample: Option<String>,
    },
    #[error("Git sync of {0} failed")]
    SyncFailed(diagnostics::GitFailure),
    #[error("Git did not return the status of {repository} within {seconds} seconds")]
    StatusTimedOut { repository: String, seconds: u64 },
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
            GitError::GitUnsupported { .. } => "git_unsupported",
            GitError::GitCommandFailed(_) => "git_command_failed",
            GitError::PathNotAccessible(_) => "path_not_accessible",
            GitError::RepositoryAccessDenied { .. } => "repository_access_denied",
            GitError::SourceBusy { .. } => "source_busy",
            GitError::PublicationBlocked { .. } => "git_publication_blocked",
            GitError::BranchBlocked { .. } => "git_branch_blocked",
            GitError::PushRejected { .. } => "git_push_rejected",
            GitError::PullBlocked { .. } => "git_pull_blocked",
            GitError::SaveFailed { .. } => "git_save_failed",
            GitError::SyncFailed(_) => "git_sync_failed",
            GitError::StatusTimedOut { .. } => "git_status_timed_out",
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

    /// The repository, stage and cause of a failed save or sync step.
    pub fn failure(&self) -> Option<&diagnostics::GitFailure> {
        match self {
            GitError::SaveFailed { failure, .. } | GitError::SyncFailed(failure) => Some(failure),
            _ => None,
        }
    }

    /// A failure of this device, such as the file system refusing a file,
    /// which says nothing about access to the remote.
    pub fn is_local_failure(&self) -> bool {
        self.failure()
            .and_then(|failure| failure.cause)
            .is_some_and(diagnostics::GitFailureCause::is_local)
    }
}

/// The transport shape the desktop app already publishes for these failures.
/// A structured variant keeps its fields; everything else stays a message.
impl serde::Serialize for GitError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            GitError::PublicationBlocked { repository, reason } => publication::BlockedTransport {
                kind: self.kind(),
                repository,
                reason,
            }
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
            GitError::PullBlocked { repository, files } => serde_json::json!({
                "kind": self.kind(),
                "repository": repository,
                "files": files,
            })
            .serialize(serializer),
            GitError::SaveFailed {
                failure,
                reason,
                exit_code,
                path_count,
                path_sample,
            } => serde_json::json!({
                "kind": self.kind(),
                "repository": failure.repository,
                "stage": failure.stage,
                "cause": failure.cause,
                "reason": reason,
                "exitCode": exit_code,
                "pathCount": path_count,
                "pathSample": path_sample,
            })
            .serialize(serializer),
            GitError::SyncFailed(failure) => serde_json::json!({
                "kind": self.kind(),
                "repository": failure.repository,
                "stage": failure.stage,
                "cause": failure.cause,
            })
            .serialize(serializer),
            GitError::SourceBusy { path } => {
                serde_json::json!({ "kind": self.kind(), "path": path }).serialize(serializer)
            }
            GitError::GitUnsupported { version } => serde_json::json!({
                "kind": self.kind(),
                "message": self.to_string(),
                "version": version,
                "minimumVersion": version::GitVersion::MINIMUM.to_string(),
            })
            .serialize(serializer),
            GitError::StatusTimedOut {
                repository,
                seconds,
            } => serde_json::json!({
                "kind": self.kind(),
                "message": self.to_string(),
                "repository": repository,
                "seconds": seconds,
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
            reason: publication::PublicationBlockReason::TargetChanged,
        })
        .unwrap();
        assert_eq!(
            blocked,
            serde_json::json!({
                "kind": "git_publication_blocked",
                "repository": "/repo",
                "reason": "target_changed",
            })
        );
        let spaces = serde_json::to_value(GitError::PublicationBlocked {
            repository: "/repo".to_string(),
            reason: publication::PublicationBlockReason::Spaces {
                spaces: vec![publication::BlockedSpace {
                    path: "spaces/one".to_string(),
                    class: publication::SpaceBlockClass::LocalCommits,
                }],
            },
        })
        .unwrap();
        assert_eq!(
            spaces,
            serde_json::json!({
                "kind": "git_publication_blocked",
                "repository": "/repo",
                "reason": "spaces",
                "spaces": [{ "path": "spaces/one", "class": "local_commits" }],
            })
        );

        let content = serde_json::to_value(GitError::PublicationBlocked {
            repository: "/repo".to_string(),
            reason: publication::PublicationBlockReason::Content {
                path: "notes/plan.md".to_string(),
                commit: "abc".to_string(),
                finding: publication::ContentFinding::ConflictMarkers,
            },
        })
        .unwrap();
        assert_eq!(
            content,
            serde_json::json!({
                "kind": "git_publication_blocked",
                "repository": "/repo",
                "reason": "content",
                "path": "notes/plan.md",
                "commit": "abc",
                "finding": "conflict_markers",
            })
        );

        let branch = serde_json::to_value(GitError::BranchBlocked {
            reason: branch::BranchBlockReason::RootDetached,
        })
        .unwrap();
        assert_eq!(branch["kind"], "git_branch_blocked");
        assert_eq!(branch["reason"], "root_detached");

        let save = serde_json::to_value(GitError::SaveFailed {
            failure: diagnostics::GitFailure {
                repository: "Research".to_string(),
                stage: diagnostics::GitStage::Prepare,
                cause: Some(diagnostics::GitFailureCause::IndexLocked),
            },
            reason: "target_unavailable",
            exit_code: Some(1),
            path_count: 2,
            path_sample: Some("docs/a.md".to_string()),
        })
        .unwrap();
        assert_eq!(save["kind"], "git_save_failed");
        assert_eq!(save["repository"], "Research");
        assert_eq!(save["stage"], "prepare");
        assert_eq!(save["cause"], "index_locked");
        assert_eq!(save["reason"], "target_unavailable");
        assert_eq!(save["exitCode"], 1);
        assert_eq!(save["pathCount"], 2);
        assert_eq!(save["pathSample"], "docs/a.md");

        let sync = serde_json::to_value(GitError::SyncFailed(diagnostics::GitFailure {
            repository: "Research".to_string(),
            stage: diagnostics::GitStage::Fetch,
            cause: None,
        }))
        .unwrap();
        assert_eq!(
            sync,
            serde_json::json!({
                "kind": "git_sync_failed",
                "repository": "Research",
                "stage": "fetch",
                "cause": null,
            })
        );

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

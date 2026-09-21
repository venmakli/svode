//! Push rejections with a known recovery, recognized from `git push` stderr.
//!
//! The typed reason replaces the raw stderr in user-facing errors; stderr,
//! object ids and URLs stay out of the transport and go only to the log.

use std::path::Path;

use serde::Serialize;

use super::GitError;
use super::cli::GitCli;
use crate::storage::config::{AssetsStrategy, read_space_assets_config};
use crate::storage::lfs_declaration::{LFS_DECLARATION_URL, lfs_declaration_state};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PushRejectionReason {
    /// The provider declined refs referencing LFS objects it does not store
    /// (GitHub `GH008`).
    LfsObjectsMissing,
    /// git-lfs reached the reserved host of Svode's declaration: this device
    /// has no S3 transfer wiring for the repository.
    LfsTransferUnconfigured,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Classified {
    pub reason: PushRejectionReason,
    pub object_count: Option<usize>,
}

/// Pure stderr classification. Authentication failures keep their own path.
pub(crate) fn classify(stderr: &str) -> Option<Classified> {
    if super::ops::is_git_auth_error(stderr) {
        return None;
    }
    if stderr.contains(declaration_host()) {
        return Some(Classified {
            reason: PushRejectionReason::LfsTransferUnconfigured,
            object_count: None,
        });
    }
    if stderr.contains("GH008") && stderr.contains("unknown Git LFS object") {
        return Some(Classified {
            reason: PushRejectionReason::LfsObjectsMissing,
            object_count: Some(missing_object_count(stderr)),
        });
    }
    None
}

/// Typed rejection for a failed push of `repo`, or `None` for any other
/// failure, which keeps its existing handling. For missing LFS objects in an
/// `lfs-s3` repository the declaration state selects the recovery.
pub(crate) async fn push_rejection(cli: &GitCli, repo: &Path, stderr: &str) -> Option<GitError> {
    let classified = classify(stderr)?;
    tracing::warn!(
        "git push rejected ({:?}): {}",
        classified.reason,
        super::auth::redact_url_credentials(stderr.trim())
    );
    let lfs_declaration = if classified.reason == PushRejectionReason::LfsObjectsMissing
        && repository_strategy(repo) == AssetsStrategy::LfsS3
    {
        lfs_declaration_state(cli, repo).await.ok()
    } else {
        None
    };
    Some(GitError::PushRejected {
        reason: classified.reason,
        object_count: classified.object_count,
        lfs_declaration,
    })
}

fn repository_strategy(repo: &Path) -> AssetsStrategy {
    read_space_assets_config(repo)
        .ok()
        .and_then(|config| config.assets)
        .unwrap_or_default()
        .strategy
}

fn declaration_host() -> &'static str {
    LFS_DECLARATION_URL
        .trim_start_matches("https://")
        .trim_end_matches('/')
}

/// GitHub states the count ("referenced at least 3 unknown Git LFS objects");
/// otherwise count the listed object ids.
fn missing_object_count(stderr: &str) -> usize {
    let stated = stderr
        .split_once("referenced at least ")
        .and_then(|(_, rest)| rest.split_whitespace().next())
        .and_then(|count| count.parse().ok());
    stated.unwrap_or_else(|| {
        stderr
            .split_whitespace()
            .filter(|word| word.len() == 64 && word.bytes().all(|b| b.is_ascii_hexdigit()))
            .count()
            .max(1)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::lfs_declaration::LfsDeclarationState;

    const GH008: &str = "remote: error: GH008: Your push referenced at least 3 unknown Git LFS objects:\n\
remote:     0966c80e8f42ed27d36e0152a2df5d4631fdebe4b68159c379fb4c05e15d413c\n\
remote: Try to push them with 'git lfs push --all'.\n\
To https://user:secret@github.com/org/repo.git\n \
! [remote rejected] c553f88 -> main (pre-receive hook declined)\n\
error: failed to push some refs to 'https://user:secret@github.com/org/repo.git'\n";

    #[test]
    fn recognizes_provider_rejection_of_missing_lfs_objects() {
        assert_eq!(
            classify(GH008),
            Some(Classified {
                reason: PushRejectionReason::LfsObjectsMissing,
                object_count: Some(3),
            })
        );
        let unstated = "remote: error: GH008: unknown Git LFS object\n\
remote:     0966c80e8f42ed27d36e0152a2df5d4631fdebe4b68159c379fb4c05e15d413c\n\
remote:     967ea99b8f42ed27d36e0152a2df5d4631fdebe4b68159c379fb4c05e15d413c\n";
        assert_eq!(classify(unstated).unwrap().object_count, Some(2));
    }

    #[test]
    fn recognizes_push_without_s3_transfer_wiring() {
        let stderr = "batch response: Post \"https://lfs-s3.svode.invalid/objects/batch\": \
dial tcp: lookup lfs-s3.svode.invalid: no such host\n\
error: failed to push some refs to 'origin'\n";
        assert_eq!(
            classify(stderr),
            Some(Classified {
                reason: PushRejectionReason::LfsTransferUnconfigured,
                object_count: None,
            })
        );
    }

    #[test]
    fn other_failures_keep_their_existing_handling() {
        for stderr in [
            "fatal: Authentication failed for 'https://github.com/org/repo.git/'",
            "remote: Permission denied. GH008 unknown Git LFS object",
            " ! [rejected] main -> main (fetch first)\nUpdates were rejected",
            "fatal: unable to access 'https://github.com/': Could not resolve host",
            "",
        ] {
            assert_eq!(classify(stderr), None, "{stderr}");
        }
    }

    #[test]
    fn transport_carries_no_stderr_object_ids_or_urls() {
        let error = GitError::PushRejected {
            reason: PushRejectionReason::LfsObjectsMissing,
            object_count: Some(3),
            lfs_declaration: Some(LfsDeclarationState::Missing),
        };
        let json = serde_json::to_value(&error).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "kind": "git_push_rejected",
                "reason": "lfs_objects_missing",
                "objectCount": 3,
                "lfsDeclaration": "missing",
            })
        );
        let text = format!("{error} {json}");
        for secret in ["secret", "github.com", "0966c80e", "GH008"] {
            assert!(!text.contains(secret), "{secret} leaked into {text}");
        }
    }
}

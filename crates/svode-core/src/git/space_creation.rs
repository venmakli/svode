//! The creation commit of a Space (Stage 11 05 «Коммиты создания»).
//!
//! Creating a Space never commits. A Space whose `SpaceRef` the working
//! config of its Project registers but the committed config does not waits
//! for its creation commit: Desktop makes it where structural commits are on
//! for the Project repository, with exactly the creation paths the type and
//! folder of the `SpaceRef` give and the message `Add <type> space <folder>`.
//! Until it lands, no version takes those paths, nor any path inside the
//! folder of an Inline Space: a closing of the Project groups makes the
//! creation commit first.

use std::collections::BTreeSet;
use std::path::Path;

use super::GitError;
use super::cli::GitCli;
use super::host::GitHost;
use super::path::normalize_space_folder;
use super::state::GitRuntime;
use super::{access, autocommit, ops, policy, staging, versions, write_guard};
use crate::space_config;
use crate::storage::config::SpaceGitType;

const CONFIG: &str = ".svode/config.json";

/// A Space of a Project whose creation is not committed yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingCreation {
    pub id: String,
    pub folder: String,
    pub git_type: SpaceGitType,
    paths: Vec<String>,
}

impl PendingCreation {
    /// The Project-relative paths of the creation commit.
    pub fn paths(&self) -> &[String] {
        &self.paths
    }

    /// The message of the creation commit, as Desktop always wrote it.
    pub fn message(&self) -> String {
        creation_message(self.git_type, &self.folder)
    }

    /// Whether a version must leave the Project-relative `path` to this
    /// creation: one of its paths, or any path inside an Inline Space.
    pub fn holds(&self, path: &str) -> bool {
        let path = path.trim_end_matches('/');
        self.paths.iter().any(|own| own == path)
            || (self.git_type == SpaceGitType::Inline
                && (path == self.folder
                    || path
                        .strip_prefix(&self.folder)
                        .is_some_and(|rest| rest.starts_with('/'))))
    }
}

/// `Add <type> space <folder>`.
pub fn creation_message(git_type: SpaceGitType, folder: &str) -> String {
    let label = match git_type {
        SpaceGitType::Inline => "inline",
        SpaceGitType::Independent => "independent",
        SpaceGitType::Submodule => "submodule",
    };
    format!("Add {label} space {folder}")
}

/// The Project-relative creation paths of a Space by its type and folder
/// (05 «Git-эффекты по типу»): the Project config with its `SpaceRef` and the
/// ignore or submodule file of its type; an Inline Space adds its shared
/// scaffold files, never the device-local ones.
pub fn creation_paths(git_type: SpaceGitType, folder: &str) -> Vec<String> {
    match git_type {
        SpaceGitType::Inline => vec![
            CONFIG.to_string(),
            ".gitignore".to_string(),
            format!("{folder}/{CONFIG}"),
            format!("{folder}/README.md"),
        ],
        SpaceGitType::Independent => vec![CONFIG.to_string(), ".gitignore".to_string()],
        SpaceGitType::Submodule => vec![CONFIG.to_string(), ".gitmodules".to_string()],
    }
}

/// The Spaces of `project` whose `SpaceRef` its working config registers
/// but its committed config does not. Nothing is pending in a Project
/// without a repository, with a config that cannot be read or with a
/// committed config that cannot be read: what was committed is unknown.
pub async fn pending(cli: &GitCli, project: &Path) -> Result<Vec<PendingCreation>, GitError> {
    if project.join(".git").symlink_metadata().is_err() {
        return Ok(Vec::new());
    }
    let Ok(working) = space_config::read(project) else {
        return Ok(Vec::new());
    };
    let refs = working.spaces.unwrap_or_default();
    if refs.is_empty() {
        return Ok(Vec::new());
    }
    let committed = cli
        .exec_redacted(project, &["show", &format!("HEAD:{CONFIG}")])
        .await?;
    let committed_ids = if committed.exit_code == 0 {
        match space_config::parse(committed.stdout.as_bytes()) {
            Ok(config) => config
                .spaces
                .unwrap_or_default()
                .into_iter()
                .map(|entry| entry.id)
                .collect::<BTreeSet<_>>(),
            Err(_) => return Ok(Vec::new()),
        }
    } else {
        BTreeSet::new()
    };
    let mut pending = Vec::new();
    for entry in refs {
        if committed_ids.contains(&entry.id) {
            continue;
        }
        let Ok(folder) = normalize_space_folder(&entry.path) else {
            continue;
        };
        let git_type = ops::detect_space_git_type(cli, project, &project.join(&folder)).await?;
        pending.push(PendingCreation {
            id: entry.id,
            paths: creation_paths(git_type, &folder),
            folder,
            git_type,
        });
    }
    Ok(pending)
}

/// Make the pending creation commits of `project` where structural commits
/// are on for it: one commit per Space, with only its creation paths, in the
/// order of its config. Other staged and unstaged changes stay as they are.
/// A refused commit leaves the created files for the next attempt.
pub async fn commit_pending(
    runtime: &GitRuntime,
    host: &dyn GitHost,
    project: &Path,
) -> Result<usize, GitError> {
    if project.join(".git").symlink_metadata().is_err()
        || !policy::effective_user_policy(project).auto_commit_structural
    {
        return Ok(0);
    }
    let cli = runtime.require_cli()?;
    let lock = runtime.get_lock(project).await;
    let _guard = lock.lock().await;
    let repository = access::local_repository_root(project)?;
    // A writer of another process may be creating a Space right now.
    let _writes = write_guard::acquire(&BTreeSet::from([repository]), &[]).await?;
    commit_pending_locked(&cli, host, project).await
}

/// [`commit_pending`] for a caller that holds the repository lock and its
/// write guard.
pub(crate) async fn commit_pending_locked(
    cli: &GitCli,
    host: &dyn GitHost,
    project: &Path,
) -> Result<usize, GitError> {
    if !policy::effective_user_policy(project).auto_commit_structural {
        return Ok(0);
    }
    let pending = pending(cli, project).await?;
    if pending.is_empty() {
        return Ok(0);
    }
    host.authorize_repository(project).await?;
    let mut commits = 0;
    for creation in &pending {
        let paths = staging::recorded(cli, project, creation.paths.clone()).await?;
        if versions::commit_exact(cli, project, &paths, &creation.message()).await? {
            commits += 1;
            host.publish_commit(project, project);
        }
    }
    if commits > 0 {
        autocommit::schedule_auto_sync(host, project);
    }
    Ok(commits)
}

use std::path::{Path, PathBuf};

use super::GitError;
use super::{
    cli::GitCli,
    flow::{PublicationStatus, SyncReport},
    operations::{Completion, Snapshot},
    ops::{self, GitStatus},
    sync::SyncResult,
};

#[derive(Debug, Clone)]
pub struct PublicationRead {
    pub(crate) status: Option<PublicationStatus>,
    pub(crate) parent: Option<(PathBuf, Snapshot)>,
}

impl PublicationRead {
    pub(crate) async fn is_current(&self, cli: &GitCli) -> Result<bool, GitError> {
        match &self.parent {
            Some((repo, snapshot)) => Ok(Snapshot::read(cli, repo).await? == *snapshot),
            None => Ok(true),
        }
    }
}

/// A successful ordinary sync observed precisely the origin/current branch
/// used by counters and inspection. Custom mapping keeps the fresh read path.
pub async fn origin_observed(cli: &GitCli, repo: &Path) -> Result<bool, GitError> {
    let (branch, config) = tokio::join!(
        ops::current_branch(cli, repo),
        cli.exec_redacted(repo, &["config", "--null", "--list"]),
    );
    let branch = branch?;
    if branch.is_empty() || branch == "HEAD" {
        return Ok(false);
    }
    let config = config?;
    if config.exit_code != 0 {
        return Ok(false);
    }
    let entries = config
        .stdout
        .split('\0')
        .filter_map(|entry| entry.split_once('\n'))
        .collect::<Vec<_>>();
    let values = |name: &str| {
        entries
            .iter()
            .filter(|(key, _)| *key == name)
            .map(|(_, value)| *value)
            .collect::<Vec<_>>()
    };
    if values(&format!("branch.{branch}.remote")) != ["origin"]
        || values(&format!("branch.{branch}.merge")) != [format!("refs/heads/{branch}").as_str()]
        || values("remote.origin.fetch") != ["+refs/heads/*:refs/remotes/origin/*"]
        || entries.iter().any(|(key, value)| {
            key.starts_with("url.")
                || key.starts_with("remotes.")
                || (key.starts_with("remote.")
                    && (key.ends_with(".push")
                        || key.ends_with(".mirror")
                        || key.ends_with(".vcs")))
                || key.ends_with(".pushremote")
                || *key == "remote.pushdefault"
                || *key == "push.followtags"
                || (*key == "push.default" && !matches!(*value, "simple" | "current"))
        })
    {
        return Ok(false);
    }
    let (fetch, push) = tokio::join!(
        cli.exec_redacted(repo, &["remote", "get-url", "--all", "origin"]),
        cli.exec_redacted(repo, &["remote", "get-url", "--push", "--all", "origin"]),
    );
    let (fetch, push) = (fetch?, push?);
    Ok(fetch.exit_code == 0
        && push.exit_code == 0
        && fetch.stdout.lines().count() == 1
        && fetch.stdout == push.stdout
        && !fetch.stdout.contains("::"))
}

pub async fn sync_status(cli: &GitCli, repo: &Path, result: &SyncResult) -> Option<GitStatus> {
    if matches!(result, SyncResult::Success { .. })
        && origin_observed(cli, repo).await.unwrap_or(false)
    {
        ops::status_with_remote_counts(cli, repo)
            .await
            .ok()
            .map(|mut status| {
                status.repository = Some(repo.to_string_lossy().into_owned());
                status
            })
    } else {
        None
    }
}

pub fn covered_sync<'a>(
    previous: Option<&'a Completion>,
    current: &Snapshot,
) -> Option<&'a SyncReport> {
    let previous = previous.filter(|done| done.after == *current)?;
    previous
        .sync_report()
        .filter(|report| report.remote_status.is_some())
}

pub async fn fetch_status(
    cli: &GitCli,
    repo: &Path,
    previous: Option<&Completion>,
    current: &Snapshot,
) -> Result<(GitStatus, bool), GitError> {
    // A new local commit invalidates publication proof, not the remote facts
    // already observed by the operation this reader was waiting for. Recompute
    // counts against the current HEAD; inspection keeps its exact snapshot gate.
    let observed = previous
        .filter(|done| current.same_remote_observation(&done.after))
        .and_then(Completion::sync_report)
        .is_some_and(|report| report.remote_status.is_some());
    let fetched = if observed {
        false
    } else {
        ops::fetch_remote(cli, repo).await?
    };
    Ok((ops::status_with_remote_counts(cli, repo).await?, fetched))
}

pub async fn inspect(
    cli: &GitCli,
    repo: &Path,
    parent: &Path,
    previous: Option<&Completion>,
    current: &Snapshot,
    permission: Result<(), GitError>,
) -> Result<PublicationRead, GitError> {
    use super::flow::{ParentPublication, PointerState, publication_target};
    let parent_snapshot = Snapshot::read(cli, parent).await?;
    let mut inspection_error = None;
    let child = if covered_sync(previous, current).is_some() {
        "published"
    } else {
        match super::publication::head_is_published(cli, repo, &current.head).await {
            Ok(true) => "published",
            Ok(false) => "unpublished",
            Err(error) => {
                inspection_error = Some(error.into());
                "unknown"
            }
        }
    };
    let path = crate::git::path::repo_relative_from_base(
        parent,
        repo,
        crate::git::path::RootMode::Reject,
    )?;
    let pointer = cli
        .exec(parent, &["rev-parse", &format!("HEAD:{path}")])
        .await?;
    let matches = pointer.exit_code == 0 && pointer.stdout.trim() == current.head;
    let parent_covered = previous
        .and_then(|done| done.parent.as_ref())
        .is_some_and(|e| {
            e.repo == parent && e.after == parent_snapshot && e.remote_status.is_some()
        });
    let published = if matches && permission.is_ok() {
        if parent_covered {
            true
        } else {
            match super::publication::head_is_published(cli, parent, &parent_snapshot.head).await {
                Ok(published) => published,
                Err(error) => {
                    if inspection_error.is_none() {
                        inspection_error = Some(error.into());
                    }
                    false
                }
            }
        }
    } else {
        false
    };
    let status = PublicationStatus {
        inspection_error,
        child_head: current.head.clone(),
        child,
        parent: ParentPublication {
            repository: parent.to_string_lossy().into_owned(),
            target: publication_target(cli, repo, parent).await?,
            pointer: if published {
                PointerState::Published
            } else if matches {
                PointerState::Local
            } else {
                PointerState::Pending
            },
            result: if cli
                .exec(parent, &["rev-parse", "--verify", "MERGE_HEAD"])
                .await?
                .exit_code
                == 0
            {
                Some(SyncResult::Conflict {
                    files: super::sync::conflict_files(cli, parent).await?,
                })
            } else {
                None
            },
            error: permission.err().map(Into::into),
            policy_skipped: None,
        },
    };
    if Snapshot::read(cli, parent).await? != parent_snapshot {
        return Err(super::operations::target_changed(parent));
    }
    Ok(PublicationRead {
        status: Some(status),
        parent: Some((parent.to_owned(), parent_snapshot)),
    })
}

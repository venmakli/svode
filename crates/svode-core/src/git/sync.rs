use std::path::Path;

use serde::Serialize;

use super::GitError;
use super::auth::{GitAuthChallenge, GitRemoteOperation};
use super::branch::GitOperation;
use super::cli::{GitCli, literal_pathspec_input, nul_paths_input, stdin_paths_input};
use super::conflict_file::ResolutionFinding;
use super::conflict_kind::{self, PathConflict};
use super::diagnostics::{GitStage, HookTrace};
use super::merge_preflight::{self, Checked, Preflight};
use super::path::{RootMode, normalize_repo_relative};
use super::renumber::{self, Landing};
use super::service_merge::{self, ServiceFile};
use crate::collections::unique_id_renumber::RenumberedItem;

/// Who started a sync. Background sync never starts a merge that can stop
/// with a conflict (1.B); an explicit sync enters the ordinary merge state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncMode {
    Explicit,
    Background,
    /// A background sync of the revision the fetch for the counters
    /// observed less than the rhythm's gap ago (DF-285): it integrates and
    /// publishes without reaching the remote for the upstream revision.
    Observed,
}

impl SyncMode {
    pub fn of(background: bool) -> Self {
        if background {
            Self::Background
        } else {
            Self::Explicit
        }
    }
}

/// What the integration step did when it did not stop sync.
#[derive(Debug, Clone)]
pub enum Integration {
    /// The branch contains the observed revision. `merged` names the Svode
    /// service files the merge merged, `renumbered` the items that got a new
    /// `unique_id` number after it (DF-237 R3).
    Integrated {
        merged: Vec<String>,
        renumbered: Vec<RenumberedItem>,
    },
    /// The state that stops sync before push.
    Stopped(SyncResult),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum SyncResult {
    Success {
        #[serde(rename = "publishedHead")]
        published_head: String,
        /// Svode service files this sync merged (1.C).
        #[serde(skip_serializing_if = "Vec::is_empty")]
        merged: Vec<String>,
        /// Items this sync gave a new `unique_id` number (DF-237 R5).
        #[serde(skip_serializing_if = "Vec::is_empty")]
        renumbered: Vec<RenumberedItem>,
    },
    Conflict {
        files: Vec<String>,
        /// The kind of each unresolved path of `files` (1.F).
        kinds: Vec<PathConflict>,
        /// Svode service files this sync merged; the others stay in `files`.
        #[serde(skip_serializing_if = "Vec::is_empty")]
        merged: Vec<String>,
        /// Conflicted service files and what the rule set says about them.
        #[serde(skip_serializing_if = "Vec::is_empty")]
        service: Vec<ServiceFile>,
        /// Items this sync gave a new `unique_id` number before the stop
        /// (DF-237 R3, R5).
        #[serde(skip_serializing_if = "Vec::is_empty")]
        renumbered: Vec<RenumberedItem>,
    },
    NoRemote,
    AuthRequired {
        challenge: GitAuthChallenge,
    },
    /// The last conflicted file was resolved while no merge was in progress.
    Resolved,
    /// Sync stopped before integration and push: the operation is finished
    /// or aborted in Git (1.F). `step` is where Git reports it stopped,
    /// `files` its paths in conflict with their `kinds`; `sequence` the
    /// commits the abort of a sequence of cherry-picks or reverts drops.
    OperationInProgress {
        operation: GitOperation,
        #[serde(skip_serializing_if = "Option::is_none")]
        step: Option<super::operation_stop::OperationStep>,
        #[serde(skip_serializing_if = "Option::is_none")]
        sequence: Option<super::operation_stop::SequenceCommits>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        files: Vec<String>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        kinds: Vec<PathConflict>,
    },
    /// Files left in conflict while no Git operation runs, as an autostash
    /// that failed to apply leaves them; sync stops before push.
    UnmergedFiles {
        files: Vec<String>,
        /// The kind of each path of `files` (1.F).
        kinds: Vec<PathConflict>,
    },
    /// «Конфликт с правками коллег» (1.B): the preflight of a background
    /// sync found incoming changes that conflict with local ones beyond what
    /// the rule set of service files merges. Nothing was merged or
    /// published; the working copy, the index and HEAD are as they were.
    /// `files` are the conflicted paths with their kinds, `service` the
    /// claimed service files the rule set leaves in conflict.
    IncomingConflict {
        files: Vec<PathConflict>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        service: Vec<ServiceFile>,
    },
    /// The result the person chose for a conflicted file has marker lines
    /// or does not read (1.F, item 3): nothing was written and the path
    /// stays in conflict. `path` is relative to the repository.
    Unresolved {
        path: String,
        finding: ResolutionFinding,
    },
    /// Local and incoming commits diverged and this Git (older than 2.38)
    /// cannot check the merge in memory: background sync only fast-forwards,
    /// so only an explicit sync merges the incoming changes (1.A).
    ExplicitSyncRequired,
    /// An agent turn or a Routine run is in progress in the repository
    /// (1.E «Ходы агентов»): the incoming changes were fetched, the step
    /// that changes the working copy waits for the end of the turn, and
    /// nothing was published.
    IntegrationAfterTurn,
}

#[cfg(test)]
pub async fn sync_if_enabled(
    cli: &GitCli,
    repo: &Path,
    requested: bool,
) -> Result<Option<SyncResult>, GitError> {
    if !requested || !super::policy::effective_user_policy(repo).auto_sync {
        return Ok(None);
    }
    sync(cli, repo).await.map(Some)
}

/// Explicit sync: fetch, integrate the observed revision, then push.
/// Handle conflicts, no-remote, and auth errors.
pub async fn sync(cli: &GitCli, space_dir: &Path) -> Result<SyncResult, GitError> {
    sync_with(cli, space_dir, SyncMode::Explicit).await
}

/// [`sync`] started by `mode`: a background sync integrates only what its
/// in-memory preflight admits and otherwise stops before integration and
/// push.
pub async fn sync_with(
    cli: &GitCli,
    space_dir: &Path,
    mode: SyncMode,
) -> Result<SyncResult, GitError> {
    if let Some(stopped) = preflight(cli, space_dir).await? {
        return Ok(stopped);
    }
    super::branch::prepare_existing(cli, space_dir).await?;
    // Check if remote is configured
    let remote_out = cli.exec(space_dir, &["remote"]).await?;
    if remote_out.stdout.trim().is_empty() {
        return Ok(SyncResult::NoRemote);
    }
    let target = super::operations::read_transport(cli, space_dir).await?;

    let upstream = match super::upstream::of_current_branch(cli, space_dir).await? {
        Some(upstream) if upstream.configured => upstream,
        upstream => {
            return sync_without_upstream(cli, space_dir, &target, upstream, mode).await;
        }
    };
    // A background sync starts with the light check (1.E): the fetch runs
    // only for a revision of the remote other than the one already fetched.
    let fetched = match mode {
        SyncMode::Explicit => super::upstream::fetch(cli, space_dir, upstream).await,
        SyncMode::Background => super::upstream::fetch_if_changed(cli, space_dir, upstream)
            .await
            .map(|probed| probed.observed),
        SyncMode::Observed => super::upstream::observed(cli, space_dir, upstream).await,
    };
    let observed = match fetched {
        Ok(observed) => observed,
        Err(error) => {
            return remote_error_to_sync_result(cli, space_dir, GitRemoteOperation::Sync, error)
                .await;
        }
    };
    let Some(revision) = observed.revision.as_deref() else {
        return Err(GitError::GitCommandFailed(format!(
            "git fetch failed: {} has no {}",
            observed.upstream.remote, observed.upstream.remote_ref
        )));
    };
    let (merged, renumbered) =
        if mode != SyncMode::Explicit && head_contains(cli, space_dir, revision).await? {
            (Vec::new(), Vec::new())
        } else {
            match integration_step(cli, space_dir, &observed.upstream, revision, mode).await? {
                Integration::Integrated { merged, renumbered } => (merged, renumbered),
                Integration::Stopped(stopped) => return Ok(stopped),
            }
        };
    // A background sync publishes only outgoing commits, checked locally.
    if mode != SyncMode::Explicit && !has_outgoing(cli, space_dir, revision).await? {
        let head = self::revision(
            cli,
            space_dir,
            &["rev-parse", "--verify", "-q", "HEAD^{commit}"],
        )
        .await?;
        tracing::info!("Space {} is in sync", space_dir.display());
        return Ok(SyncResult::Success {
            published_head: head.unwrap_or_default(),
            merged,
            renumbered,
        });
    }

    // Push
    validate_transport(cli, space_dir, &target).await?;
    let (push_out, published_head) =
        super::publication::push_snapshot(cli, space_dir, false).await?;
    if push_out.exit_code != 0 {
        let stderr = push_out.stderr.trim();

        if super::ops::is_git_auth_error(stderr) {
            return auth_required(cli, space_dir, GitRemoteOperation::Sync, Some(stderr)).await;
        }

        let error = super::ops::git_remote_command_error(space_dir, GitStage::Push, stderr);
        return remote_error_to_sync_result(cli, space_dir, GitRemoteOperation::Sync, error).await;
    }

    tracing::info!("Synced space {}", space_dir.display());
    Ok(SyncResult::Success {
        published_head: published_head.unwrap_or_default(),
        merged,
        renumbered,
    })
}

/// The state that stops sync before branch preparation, integration and push.
/// A merge in progress is the sync conflict with its files; any other
/// operation is named and left to Git; conflicted files without an operation
/// are left to the user, with no stash applied or dropped.
pub async fn preflight(cli: &GitCli, repo: &Path) -> Result<Option<SyncResult>, GitError> {
    Ok(
        match super::branch::operation_in_progress(cli, repo).await? {
            None => {
                let files = conflict_files(cli, repo).await?;
                if files.is_empty() {
                    None
                } else {
                    let kinds = conflict_kinds(cli, repo).await;
                    Some(SyncResult::UnmergedFiles { files, kinds })
                }
            }
            Some(GitOperation::Merge) => Some(merge_conflict(cli, repo, Vec::new()).await?),
            Some(operation) => Some(operation_stopped(cli, repo, operation).await?),
        },
    )
}

async fn sync_without_upstream(
    cli: &GitCli,
    space_dir: &Path,
    target: &str,
    upstream: Option<super::upstream::Upstream>,
    mode: SyncMode,
) -> Result<SyncResult, GitError> {
    let Some(upstream) = upstream else {
        if super::ops::get_remote(cli, space_dir).await?.is_none() {
            return Ok(SyncResult::NoRemote);
        }
        return Err(GitError::GitCommandFailed(
            "Cannot sync detached HEAD without an upstream".to_string(),
        ));
    };
    let fetched = if mode == SyncMode::Observed {
        super::upstream::observed(cli, space_dir, upstream).await
    } else {
        super::upstream::fetch(cli, space_dir, upstream).await
    };
    let observed = match fetched {
        Ok(observed) => observed,
        Err(error) => {
            return remote_error_to_sync_result(
                cli,
                space_dir,
                GitRemoteOperation::FirstPush,
                error,
            )
            .await;
        }
    };
    let (mut merged, mut renumbered) = (Vec::new(), Vec::new());
    if let Some(revision) = observed.revision.as_deref() {
        match integration_step(cli, space_dir, &observed.upstream, revision, mode).await? {
            Integration::Integrated {
                merged: files,
                renumbered: items,
            } => (merged, renumbered) = (files, items),
            Integration::Stopped(stopped) => return Ok(stopped),
        }
    }

    validate_transport(cli, space_dir, target).await?;
    let (out, published_head) = super::publication::push_snapshot(cli, space_dir, true).await?;
    if out.exit_code != 0 {
        return remote_error_to_sync_result(
            cli,
            space_dir,
            GitRemoteOperation::FirstPush,
            super::ops::git_remote_command_error(space_dir, GitStage::Push, &out.stderr),
        )
        .await;
    }
    Ok(SyncResult::Success {
        published_head: published_head.unwrap_or_default(),
        merged,
        renumbered,
    })
}

pub async fn validate_transport(cli: &GitCli, repo: &Path, expected: &str) -> Result<(), GitError> {
    if super::operations::read_transport(cli, repo).await? != expected {
        return Err(super::operations::target_changed(repo));
    }
    Ok(())
}

/// The step of sync that changes the working copy (1.B): it holds the write
/// guard of the repository, so a source write of Svode that comes meanwhile
/// waits for it or gets «источник занят» (invariant 9), and never starts
/// while one runs. An explicit sync merges `revision`, the one the fetch
/// step observed for `upstream`, entering the ordinary merge state on a
/// conflict; a background sync first merges in memory and integrates only a
/// fast-forward, a clean merge or one with service conflicts only, else it
/// stops with nothing changed and nothing to publish.
///
/// After a fast-forward or merge, and before a merge stopped for the person
/// is handed over, the step renumbers items that repeat a `unique_id`
/// number published in `revision` (DF-237 R3) under the same guard.
///
/// While an agent turn or a Routine run is in progress in the repository
/// the step does not run in either mode: the fetch already happened, and
/// the turn's end syncs again (1.E «Ходы агентов»).
pub async fn integration_step(
    cli: &GitCli,
    space_dir: &Path,
    upstream: &super::upstream::Upstream,
    revision: &str,
    mode: SyncMode,
) -> Result<Integration, GitError> {
    let repository = super::access::local_repository_root(space_dir)?;
    if super::versions::turns::defer_integration(&repository) {
        return Ok(Integration::Stopped(SyncResult::IntegrationAfterTurn));
    }
    let _guard =
        super::write_guard::acquire(&std::collections::BTreeSet::from([repository.clone()]), &[])
            .await?;
    if mode == SyncMode::Explicit {
        let before = head_commit(cli, space_dir).await?;
        let integration = integrate(cli, space_dir, upstream, revision).await?;
        return with_renumbering(cli, &repository, revision, before, integration).await;
    }
    // HEAD moved by a Git process outside Svode between the preflight and
    // the merge is checked again rather than merged unchecked.
    for _ in 0..3 {
        let checked = merge_preflight::check(cli, space_dir, revision).await?;
        if let Some(stopped) = background_stop(&checked.outcome) {
            return Ok(Integration::Stopped(stopped));
        }
        if let Some(integration) =
            integrate_checked(cli, space_dir, upstream, revision, &checked).await?
        {
            return with_renumbering(cli, &repository, revision, checked.head, integration).await;
        }
    }
    Err(GitError::GitCommandFailed(
        "the branch kept changing during the integration step".to_owned(),
    ))
}

/// `integration` with the renumbering of repeated `unique_id` after it: in
/// the working copy after a fast-forward, in the merge commit the step made
/// or staged in the merge stopped for the person. `before` is HEAD before
/// the step; a branch that already contained `revision` renumbers nothing.
async fn with_renumbering(
    cli: &GitCli,
    repository: &Path,
    revision: &str,
    before: Option<String>,
    integration: Integration,
) -> Result<Integration, GitError> {
    match integration {
        Integration::Integrated { merged, .. } => {
            let head = head_commit(cli, repository).await?;
            if head == before {
                return Ok(Integration::Integrated {
                    merged,
                    renumbered: Vec::new(),
                });
            }
            let landing = if head.as_deref() == Some(revision) {
                Landing::WorkingCopy
            } else {
                Landing::MergeCommit
            };
            let renumbered =
                renumber::renumber_repeated(cli, repository, revision, landing).await?;
            Ok(Integration::Integrated { merged, renumbered })
        }
        Integration::Stopped(SyncResult::Conflict {
            files,
            kinds,
            merged,
            service,
            ..
        }) => {
            let renumbered =
                renumber::renumber_repeated(cli, repository, revision, Landing::Merge).await?;
            Ok(Integration::Stopped(SyncResult::Conflict {
                files,
                kinds,
                merged,
                service,
                renumbered,
            }))
        }
        stopped => Ok(stopped),
    }
}

async fn head_commit(cli: &GitCli, repo: &Path) -> Result<Option<String>, GitError> {
    revision(cli, repo, &["rev-parse", "--verify", "-q", "HEAD^{commit}"]).await
}

/// The stop of a background sync for a preflight that does not integrate.
fn background_stop(outcome: &Preflight) -> Option<SyncResult> {
    match outcome {
        Preflight::Conflicts { files, service } => Some(SyncResult::IncomingConflict {
            files: files.clone(),
            service: service.clone(),
        }),
        Preflight::Unchecked => Some(SyncResult::ExplicitSyncRequired),
        _ => None,
    }
}

/// Integrates `revision` after `checked` admitted it in the background.
/// The working copy changed since the preflight makes Git refuse to
/// overwrite files: that is the refusal of DF-190, not a merge state.
/// `None` when HEAD moved since the preflight or the merge stopped with a
/// conflict the preflight did not see; that merge is aborted, leaving the
/// repository as it was, and the caller checks again.
pub(crate) async fn integrate_checked(
    cli: &GitCli,
    space_dir: &Path,
    upstream: &super::upstream::Upstream,
    revision: &str,
    checked: &Checked,
) -> Result<Option<Integration>, GitError> {
    let head = self::revision(
        cli,
        space_dir,
        &["rev-parse", "--verify", "-q", "HEAD^{commit}"],
    )
    .await?;
    if head != checked.head {
        return Ok(None);
    }
    match integrate(cli, space_dir, upstream, revision).await? {
        Integration::Stopped(SyncResult::Conflict { .. }) => {
            merge_abort(cli, space_dir).await?;
            Ok(None)
        }
        integration => Ok(Some(integration)),
    }
}

/// Merges `revision`, the one the fetch step observed
/// for `upstream`, into the current branch. A merge whose conflicts are only
/// in Svode service files merges them by the rule set and is committed;
/// otherwise the merge stops with the service files merged and the rest left
/// to the person.
async fn integrate(
    cli: &GitCli,
    space_dir: &Path,
    upstream: &super::upstream::Upstream,
    revision: &str,
) -> Result<Integration, GitError> {
    let mut retried = false;
    loop {
        let trace = HookTrace::new();
        let merge = super::upstream::merge(cli, space_dir, upstream, revision, &trace).await?;
        if merge.exit_code == 0 {
            // A merge that succeeds, or the merge retried after setting
            // matching edits aside, may still leave files in conflict.
            return Ok(match preflight(cli, space_dir).await? {
                Some(stopped) => Integration::Stopped(stopped),
                None => Integration::Integrated {
                    merged: Vec::new(),
                    renumbered: Vec::new(),
                },
            });
        }
        if blocked_by_local_files(&merge.stderr) {
            match set_aside_matching_edits(cli, space_dir, revision).await {
                Ok(files) if !files.is_empty() => {
                    return Err(GitError::PullBlocked {
                        repository: space_dir.to_string_lossy().into_owned(),
                        files,
                    });
                }
                Ok(_) if !retried => {
                    retried = true;
                    continue;
                }
                Ok(_) => {}
                Err(error) => tracing::warn!("interfering local files unavailable: {error}"),
            }
        }
        return merge_failure(
            cli,
            space_dir,
            &merge.stderr,
            &merge.stdout,
            trace.hook_failed(),
        )
        .await;
    }
}

async fn merge_failure(
    cli: &GitCli,
    space_dir: &Path,
    stderr: &str,
    stdout: &str,
    hook_failed: bool,
) -> Result<Integration, GitError> {
    let stderr = stderr.trim();

    if super::ops::is_git_auth_error(stderr) {
        return auth_required(cli, space_dir, GitRemoteOperation::Sync, Some(stderr))
            .await
            .map(Integration::Stopped);
    }

    if stderr.contains("CONFLICT")
        || stderr.contains("Automatic merge failed")
        || stdout.contains("CONFLICT")
        || stdout.contains("Automatic merge failed")
    {
        // Svode started this merge: its service files are merged without
        // the person (1.C).
        let service = service_merge::merge_in_index(cli, space_dir, None).await?;
        if !conflict_files(cli, space_dir).await?.is_empty() {
            return merge_conflict(cli, space_dir, service.merged)
                .await
                .map(Integration::Stopped);
        }
        commit_service_merge(cli, space_dir).await?;
        return Ok(Integration::Integrated {
            merged: service.merged,
            renumbered: Vec::new(),
        });
    }

    // The merge commit of the step runs the hooks of the repository.
    let error = if hook_failed {
        super::ops::sync_failure(space_dir, GitStage::Integrate, stderr, true)
    } else {
        super::ops::git_remote_command_error(space_dir, GitStage::Integrate, stderr)
    };
    remote_error_to_sync_result(cli, space_dir, GitRemoteOperation::Sync, error)
        .await
        .map(Integration::Stopped)
}

/// Concludes the merge of the integration step once Svode merged every
/// conflicted path, with the message of the merge and without the list of
/// conflicts Git adds to it. Hooks and signing of the user apply.
async fn commit_service_merge(cli: &GitCli, repo: &Path) -> Result<(), GitError> {
    let trace = HookTrace::new();
    let out = cli
        .exec_with_env(
            repo,
            &[
                "-c",
                "rerere.enabled=false",
                "commit",
                "--no-edit",
                "--cleanup=strip",
            ],
            &trace.env(&[]),
        )
        .await?;
    if out.exit_code != 0 {
        return Err(super::ops::sync_failure(
            repo,
            GitStage::Integrate,
            &out.stderr,
            trace.hook_failed(),
        ));
    }
    Ok(())
}

/// The stop of a merge in progress: the paths left in conflict, the service
/// files this step merged and what the rule set says about the conflicted
/// service files now, from local objects only.
pub(crate) async fn merge_conflict(
    cli: &GitCli,
    repo: &Path,
    merged: Vec<String>,
) -> Result<SyncResult, GitError> {
    let files = conflict_files(cli, repo).await?;
    let (service, kinds) = if files.is_empty() {
        (Vec::new(), Vec::new())
    } else {
        let service = service_merge::inspect_in_index(cli, repo)
            .await
            .unwrap_or_else(|error| {
                tracing::warn!("conflicted service files unavailable: {error}");
                Vec::new()
            });
        (service, conflict_kinds(cli, repo).await)
    };
    Ok(SyncResult::Conflict {
        files,
        kinds,
        merged,
        service,
        renumbered: Vec::new(),
    })
}

/// The stop of a rebase, cherry-pick, revert or sequencer: the operation,
/// the step Git reports, the commits the abort of a sequence drops and its
/// paths in conflict with their kinds.
pub(crate) async fn operation_stopped(
    cli: &GitCli,
    repo: &Path,
    operation: GitOperation,
) -> Result<SyncResult, GitError> {
    let step = super::operation_stop::step(cli, repo, operation)
        .await
        .unwrap_or_else(|error| {
            tracing::warn!("step of the Git operation unavailable: {error}");
            None
        });
    // Without the list the abort of a sequence is refused as a changed
    // state, so the stop still shows.
    let sequence = match operation {
        GitOperation::Merge | GitOperation::Rebase => None,
        GitOperation::CherryPick | GitOperation::Revert | GitOperation::Sequencer => {
            super::operation_stop::sequence_commits(cli, repo)
                .await
                .unwrap_or_else(|error| {
                    tracing::warn!("commits of the Git sequence unavailable: {error}");
                    None
                })
        }
    };
    let files = conflict_files(cli, repo).await?;
    let kinds = if files.is_empty() {
        Vec::new()
    } else {
        conflict_kinds(cli, repo).await
    };
    Ok(SyncResult::OperationInProgress {
        operation,
        step,
        sequence,
        files,
        kinds,
    })
}

/// The kinds of the unresolved paths of `repo`; a stop still names its
/// files when they cannot be read.
async fn conflict_kinds(cli: &GitCli, repo: &Path) -> Vec<PathConflict> {
    conflict_kind::unresolved(cli, repo)
        .await
        .unwrap_or_else(|error| {
            tracing::warn!("kinds of conflicted paths unavailable: {error}");
            Vec::new()
        })
}

/// Interim measure of the integration step (DF-190 R2), removed once a merge
/// engine replaces it.
///
/// Returns the paths that keep `incoming`, the observed revision, from
/// merging. A path whose edit is no user work does not: the blob Git would
/// store for the working file (with the filters and eol of the path) equals
/// the incoming one, local commits left the path as in the merge base, and
/// the index holds HEAD or the incoming version. Only when every interfering path is such,
/// they are brought back to HEAD and the merge writes the same content;
/// otherwise nothing changes.
async fn set_aside_matching_edits(
    cli: &GitCli,
    repo: &Path,
    incoming: &str,
) -> Result<Vec<String>, GitError> {
    let paths = interfering_paths(cli, repo, incoming).await?;
    if paths.is_empty() {
        return Err(GitError::GitCommandFailed(
            "git merge refused without interfering local files".into(),
        ));
    }
    let Some(base) = revision(cli, repo, &["merge-base", "HEAD", incoming]).await? else {
        return Ok(paths);
    };
    let mut committed = Vec::new();
    for args in with_paths(
        cli,
        &["diff", "--name-only", "-z", "--no-renames", &base, "HEAD"],
        &paths,
    ) {
        committed.extend(path_list(cli, repo, &args).await?);
    }
    let incoming_blobs = entries(cli, repo, &["ls-tree", "-z", incoming], &paths).await?;
    let head_blobs = entries(cli, repo, &["ls-tree", "-z", "HEAD"], &paths).await?;
    let index_blobs = entries(cli, repo, &["ls-files", "-z", "--stage"], &paths).await?;
    let candidates: Vec<&str> = paths
        .iter()
        .map(String::as_str)
        .filter(|path| {
            !committed.iter().any(|changed| changed == path)
                && incoming_blobs
                    .get(*path)
                    .is_some_and(|(mode, _)| mode == "100644" || mode == "100755")
                && std::fs::symlink_metadata(repo.join(path)).is_ok_and(|meta| meta.is_file())
        })
        .collect();
    let mut matching = Vec::new();
    if !candidates.is_empty() {
        let out = cli
            .exec_with_input(
                repo,
                &["hash-object", "--stdin-paths"],
                &[],
                &stdin_paths_input(candidates.iter().copied()),
            )
            .await?;
        if out.exit_code != 0 {
            return Err(GitError::GitCommandFailed(format!(
                "git hash-object failed: {}",
                out.stderr.trim()
            )));
        }
        for (path, worktree) in candidates.into_iter().zip(out.stdout.lines()) {
            let blob = |entries: &'_ Entries| entries.get(path).map(|(_, oid)| oid.clone());
            let incoming = blob(&incoming_blobs);
            let index = blob(&index_blobs);
            if incoming.as_deref() == Some(worktree)
                && (index == blob(&head_blobs) || index == incoming)
            {
                matching.push(path.to_string());
            }
        }
    }
    if matching.len() < paths.len() {
        return Ok(paths
            .into_iter()
            .filter(|path| !matching.contains(path))
            .collect());
    }
    let (tracked, untracked): (Vec<String>, Vec<String>) = matching
        .into_iter()
        .partition(|path| head_blobs.contains_key(path));
    for (command, options, paths) in [
        (
            "restore",
            &["--source=HEAD", "--staged", "--worktree"][..],
            &tracked,
        ),
        (
            "rm",
            &["--cached", "-q", "--ignore-unmatch"][..],
            &untracked,
        ),
    ] {
        if paths.is_empty() {
            continue;
        }
        let mut args = vec!["--literal-pathspecs", command];
        args.extend_from_slice(options);
        args.extend(["--pathspec-from-file=-", "--pathspec-file-nul"]);
        let out = cli
            .exec_with_input(repo, &args, &[], &nul_paths_input(paths))
            .await?;
        if out.exit_code != 0 {
            return Err(GitError::GitCommandFailed(format!(
                "git {command} failed: {}",
                out.stderr.trim()
            )));
        }
    }
    for path in &untracked {
        std::fs::remove_file(repo.join(path))?;
    }
    tracing::info!(
        "Set aside {} local edits equal to incoming changes in {}",
        tracked.len() + untracked.len(),
        repo.display()
    );
    Ok(Vec::new())
}

/// Argument lists of `args` limited to exactly `paths`, without pathspec
/// magic, each within the command line budget.
fn with_paths<'a>(cli: &GitCli, args: &[&'a str], paths: &'a [String]) -> Vec<Vec<&'a str>> {
    let mut all = vec!["--literal-pathspecs"];
    all.extend_from_slice(args);
    all.push("--");
    cli.path_batches(&all, paths)
}

/// Path → (mode, object id) of tree or stage 0 index entries.
type Entries = std::collections::HashMap<String, (String, String)>;

/// Reads `ls-tree -z` or `ls-files -z --stage` records of `paths`.
async fn entries(
    cli: &GitCli,
    repo: &Path,
    args: &[&str],
    paths: &[String],
) -> Result<Entries, GitError> {
    let command = args[0];
    let mut entries = Entries::new();
    for args in with_paths(cli, args, paths) {
        let out = cli.exec(repo, &args).await?;
        if out.exit_code != 0 {
            return Err(GitError::GitCommandFailed(format!(
                "git {command} failed: {}",
                out.stderr.trim()
            )));
        }
        entries.extend(out.stdout.split('\0').filter_map(|record| {
            let (meta, path) = record.split_once('\t')?;
            let fields: Vec<&str> = meta.split(' ').collect();
            let (mode, oid) = match (command, fields.as_slice()) {
                ("ls-tree", [mode, _, oid]) => (mode, oid),
                ("ls-files", [mode, oid, "0"]) => (mode, oid),
                _ => return None,
            };
            Some((path.to_string(), (mode.to_string(), oid.to_string())))
        }));
    }
    Ok(entries)
}

async fn remote_error_to_sync_result(
    cli: &GitCli,
    space_dir: &Path,
    operation: GitRemoteOperation,
    error: GitError,
) -> Result<SyncResult, GitError> {
    match error {
        GitError::AuthRequired(detail) => {
            auth_required(cli, space_dir, operation, Some(detail.as_str())).await
        }
        GitError::NoRemote => Ok(SyncResult::NoRemote),
        other => Err(other),
    }
}

async fn auth_required(
    cli: &GitCli,
    space_dir: &Path,
    operation: GitRemoteOperation,
    detail: Option<&str>,
) -> Result<SyncResult, GitError> {
    Ok(SyncResult::AuthRequired {
        challenge: super::auth::build_auth_challenge(cli, space_dir, operation, detail).await,
    })
}

/// Git refused to start the merge because it would overwrite uncommitted or
/// untracked files.
fn blocked_by_local_files(stderr: &str) -> bool {
    [
        "would be overwritten by merge",
        "would be removed by merge",
        "would lose untracked files",
    ]
    .iter()
    .any(|marker| stderr.contains(marker))
}

/// Uncommitted and untracked paths of `repo` that merging `incoming` into
/// HEAD would overwrite: local edits overlapping paths the incoming side
/// changed since the merge base. A merge that is not a fast-forward also
/// requires the index to equal HEAD, so every staged path interferes then.
/// Read-only: neither the index nor the working tree is refreshed.
pub(crate) async fn interfering_paths(
    cli: &GitCli,
    repo: &Path,
    incoming: &str,
) -> Result<Vec<String>, GitError> {
    let head = revision(cli, repo, &["rev-parse", "--verify", "-q", "HEAD"]).await?;
    let (incoming_paths, staged, merge) = match head {
        Some(head) => {
            let base = revision(cli, repo, &["merge-base", "HEAD", incoming]).await?;
            let from = base.as_deref().unwrap_or("HEAD");
            let incoming_paths = path_list(
                cli,
                repo,
                &["diff", "--name-only", "-z", "--no-renames", from, incoming],
            )
            .await?;
            let staged = path_list(
                cli,
                repo,
                &[
                    "diff",
                    "--cached",
                    "--name-only",
                    "-z",
                    "--no-renames",
                    "HEAD",
                ],
            )
            .await?;
            (
                incoming_paths,
                staged,
                base.as_deref() != Some(head.as_str()),
            )
        }
        None => {
            let incoming_paths = path_list(
                cli,
                repo,
                &[
                    "ls-tree",
                    "-r",
                    "-z",
                    "--name-only",
                    "--full-tree",
                    incoming,
                ],
            )
            .await?;
            let staged =
                path_list(cli, repo, &["ls-files", "-z", "--full-name", "--", ":/"]).await?;
            (incoming_paths, staged, false)
        }
    };
    // Git leaves a submodule checkout alone when merging its gitlink.
    let unstaged = path_list(
        cli,
        repo,
        &[
            "diff",
            "--name-only",
            "-z",
            "--no-renames",
            "--ignore-submodules=all",
        ],
    )
    .await?;
    let untracked = path_list(
        cli,
        repo,
        &[
            "ls-files",
            "-z",
            "--others",
            "--exclude-standard",
            "--full-name",
            "--",
            ":/",
        ],
    )
    .await?;
    let mut files: std::collections::BTreeSet<String> = staged
        .iter()
        .chain(&unstaged)
        .chain(&untracked)
        .filter(|path| {
            incoming_paths
                .iter()
                .any(|changed| paths_overlap(path, changed))
        })
        .cloned()
        .collect();
    if merge {
        files.extend(staged);
    }
    Ok(files.into_iter().collect())
}

/// The same path, or one is a directory containing the other.
fn paths_overlap(local: &str, incoming: &str) -> bool {
    let nested = |outer: &str, inner: &str| {
        inner
            .strip_prefix(outer)
            .is_some_and(|rest| rest.starts_with('/'))
    };
    local == incoming || nested(local, incoming) || nested(incoming, local)
}

/// HEAD already contains `revision`: nothing to integrate.
async fn head_contains(cli: &GitCli, repo: &Path, revision: &str) -> Result<bool, GitError> {
    let out = cli
        .exec(repo, &["merge-base", "--is-ancestor", revision, "HEAD"])
        .await?;
    Ok(out.exit_code == 0)
}

/// HEAD has commits `revision` lacks; unreadable history counts as outgoing,
/// so the publication still decides.
async fn has_outgoing(cli: &GitCli, repo: &Path, revision: &str) -> Result<bool, GitError> {
    let out = cli
        .exec(repo, &["rev-list", "--count", &format!("{revision}..HEAD")])
        .await?;
    Ok(out.exit_code != 0 || out.stdout.trim() != "0")
}

async fn revision(cli: &GitCli, repo: &Path, args: &[&str]) -> Result<Option<String>, GitError> {
    let out = cli.exec(repo, args).await?;
    let oid = out.stdout.trim();
    Ok((out.exit_code == 0 && !oid.is_empty()).then(|| oid.to_string()))
}

async fn path_list(cli: &GitCli, repo: &Path, args: &[&str]) -> Result<Vec<String>, GitError> {
    let out = cli.exec(repo, args).await?;
    if out.exit_code != 0 {
        return Err(GitError::GitCommandFailed(format!(
            "git {} failed: {}",
            args[0],
            out.stderr.trim()
        )));
    }
    out.stdout
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(|path| {
            // `ls-files --others` names an untracked nested repository as a directory.
            crate::git::path::normalize_repo_relative(
                path.trim_end_matches('/'),
                crate::git::path::RootMode::Reject,
            )
        })
        .collect()
}

/// Get list of conflicted files.
pub async fn conflict_files(cli: &GitCli, space_dir: &Path) -> Result<Vec<String>, GitError> {
    let out = cli
        .exec(space_dir, &["diff", "--name-only", "-z", "--diff-filter=U"])
        .await?;

    out.stdout
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(|path| {
            crate::git::path::normalize_repo_relative(path, crate::git::path::RootMode::Reject)
        })
        .collect()
}

/// Continue a sync merge with the conflicted `paths` (relative to `space_dir`)
/// the user resolved. Only those without Git conflict markers are staged; the
/// merge commit and push run once no file is left in conflict.
pub async fn resolve_and_continue(
    cli: &GitCli,
    space_dir: &Path,
    paths: &[String],
) -> Result<SyncResult, GitError> {
    let target = super::operations::read_transport(cli, space_dir).await?;
    let paths = paths
        .iter()
        .map(|path| normalize_repo_relative(path, RootMode::Reject))
        .collect::<Result<Vec<_>, _>>()?;
    // One read of every unmerged entry instead of a call per path.
    let unmerged = if paths.is_empty() {
        Vec::new()
    } else {
        unmerged_paths(cli, space_dir).await?
    };
    // A path names its own entry or, as a pathspec, the entries under it.
    let paths: Vec<String> = paths
        .into_iter()
        .filter(|path| {
            unmerged
                .iter()
                .any(|entry| entry == path || is_under(entry, path))
        })
        .collect();
    let mut contents = Vec::with_capacity(paths.len());
    for path in &paths {
        match std::fs::read(space_dir.join(path)) {
            Ok(content) => contents.push(Some(content)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => contents.push(None),
            Err(error) => return Err(error.into()),
        }
    }
    let present: Vec<String> = paths
        .iter()
        .zip(&contents)
        .filter(|(_, content)| content.is_some())
        .map(|(path, _)| path.clone())
        .collect();
    let sizes = super::markers::marker_sizes(cli, space_dir, &present).await?;
    for (path, content) in paths.iter().zip(&contents) {
        let Some(content) = content else {
            continue;
        };
        let size = sizes
            .get(path)
            .copied()
            .unwrap_or(super::markers::DEFAULT_MARKER_SIZE);
        if super::markers::has_marker_lines(content, size) {
            return Err(GitError::Conflict(format!(
                "Conflict markers remain in {path}"
            )));
        }
    }
    if !paths.is_empty() {
        let add_out = cli
            .exec_with_input(
                space_dir,
                &["add", "--pathspec-from-file=-", "--pathspec-file-nul"],
                &[],
                &literal_pathspec_input(&paths),
            )
            .await?;
        if add_out.exit_code != 0 {
            return Err(super::ops::sync_failure(
                space_dir,
                GitStage::Commit,
                &add_out.stderr,
                false,
            ));
        }
    }

    continue_merge(cli, space_dir, &target, Vec::new()).await
}

/// «Слить служебные файлы Svode» for a merge started outside Svode: merges
/// the conflicted service files (all, or the repository-relative `only`) by
/// the rule set Svode's own merge applies, then continues the merge as
/// resolving its last path does.
pub async fn merge_service_files(
    cli: &GitCli,
    space_dir: &Path,
    only: Option<&[String]>,
) -> Result<SyncResult, GitError> {
    // Another operation gives its index stages other sides.
    if let Some(operation) = super::branch::operation_in_progress(cli, space_dir)
        .await?
        .filter(|operation| *operation != GitOperation::Merge)
    {
        return operation_stopped(cli, space_dir, operation).await;
    }
    let target = super::operations::read_transport(cli, space_dir).await?;
    let service = service_merge::merge_in_index(cli, space_dir, only).await?;
    continue_merge(cli, space_dir, &target, service.merged).await
}

/// With no path left in conflict, commit the merge and push; `merged` names
/// the service files Svode merged on the way.
pub(crate) async fn continue_merge(
    cli: &GitCli,
    space_dir: &Path,
    target: &str,
    merged: Vec<String>,
) -> Result<SyncResult, GitError> {
    if !conflict_files(cli, space_dir).await?.is_empty() {
        return merge_conflict(cli, space_dir, merged).await;
    }
    let merge_head = cli
        .exec(space_dir, &["rev-parse", "-q", "--verify", "MERGE_HEAD"])
        .await?;
    if merge_head.exit_code != 0 {
        // Conflicted files without a merge leave ordinary changes for an ordinary save.
        return Ok(SyncResult::Resolved);
    }

    // The index holds the merge result and the resolved paths only.
    let trace = HookTrace::new();
    let commit_out = cli
        .exec_with_env(space_dir, &["commit", "--no-edit"], &trace.env(&[]))
        .await?;
    if commit_out.exit_code != 0 {
        return Err(super::ops::sync_failure(
            space_dir,
            GitStage::Commit,
            &commit_out.stderr,
            trace.hook_failed(),
        ));
    }

    // Push
    validate_transport(cli, space_dir, target).await?;
    let (push_out, published_head) =
        super::publication::push_snapshot(cli, space_dir, false).await?;
    if push_out.exit_code != 0 {
        let stderr = push_out.stderr.trim();
        if super::ops::is_git_auth_error(stderr) {
            return auth_required(cli, space_dir, GitRemoteOperation::Sync, Some(stderr)).await;
        }
        return Err(super::ops::git_remote_command_error(
            space_dir,
            GitStage::Push,
            stderr,
        ));
    }

    tracing::info!("Resolved conflicts and pushed in {}", space_dir.display());
    Ok(SyncResult::Success {
        published_head: published_head.unwrap_or_default(),
        merged,
        renumbered: Vec::new(),
    })
}

/// Paths of the unmerged index entries of `repo`.
async fn unmerged_paths(cli: &GitCli, repo: &Path) -> Result<Vec<String>, GitError> {
    let out = cli.exec(repo, &["ls-files", "--unmerged", "-z"]).await?;
    if out.exit_code != 0 {
        return Err(GitError::GitCommandFailed(format!(
            "git ls-files failed: {}",
            out.stderr
        )));
    }
    Ok(out
        .stdout
        .split('\0')
        .filter_map(|record| record.split_once('\t'))
        .map(|(_, path)| path.to_string())
        .collect())
}

fn is_under(entry: &str, path: &str) -> bool {
    entry
        .strip_prefix(path)
        .is_some_and(|rest| rest.starts_with('/'))
}

/// Abort current merge.
pub async fn merge_abort(cli: &GitCli, space_dir: &Path) -> Result<(), GitError> {
    let out = cli.exec(space_dir, &["merge", "--abort"]).await?;
    if out.exit_code != 0 {
        return Err(GitError::GitCommandFailed(format!(
            "git merge --abort failed: {}",
            out.stderr
        )));
    }
    tracing::info!("Aborted merge in {}", space_dir.display());
    Ok(())
}

#[cfg(test)]
#[path = "pull_block_tests.rs"]
mod pull_block_tests;

#[cfg(test)]
#[path = "sync_autostash_tests.rs"]
mod autostash_tests;
#[cfg(test)]
#[path = "light_sync_tests.rs"]
mod light_sync_tests;
#[cfg(test)]
#[path = "sync_preflight_tests.rs"]
mod preflight_tests;

use std::path::Path;

use serde::Serialize;

use super::GitError;
use super::auth::{GitAuthChallenge, GitRemoteOperation};
use super::branch::GitOperation;
use super::cli::{GitCli, literal_pathspec_input, nul_paths_input, stdin_paths_input};
use super::diagnostics::{GitStage, HookTrace};
use super::path::{RootMode, normalize_repo_relative};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum SyncResult {
    Success {
        #[serde(rename = "publishedHead")]
        published_head: String,
    },
    Conflict {
        files: Vec<String>,
    },
    NoRemote,
    AuthRequired {
        challenge: GitAuthChallenge,
    },
    /// The last conflicted file was resolved while no merge was in progress.
    Resolved,
    /// Sync stopped before integration and push: the operation is finished in Git.
    OperationInProgress {
        operation: GitOperation,
    },
    /// Files left in conflict while no Git operation runs, as an autostash
    /// that failed to apply leaves them; sync stops before push.
    UnmergedFiles {
        files: Vec<String>,
    },
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

/// Fetch, integrate the observed revision, then push. Handle conflicts,
/// no-remote, and auth errors.
pub async fn sync(cli: &GitCli, space_dir: &Path) -> Result<SyncResult, GitError> {
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
        upstream => return sync_without_upstream(cli, space_dir, &target, upstream).await,
    };
    let observed = match super::upstream::fetch(cli, space_dir, upstream).await {
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
    if let Some(stopped) = integrate(cli, space_dir, &observed.upstream, revision).await? {
        return Ok(stopped);
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
                (!files.is_empty()).then_some(SyncResult::UnmergedFiles { files })
            }
            Some(GitOperation::Merge) => Some(SyncResult::Conflict {
                files: conflict_files(cli, repo).await?,
            }),
            Some(operation) => Some(SyncResult::OperationInProgress { operation }),
        },
    )
}

async fn sync_without_upstream(
    cli: &GitCli,
    space_dir: &Path,
    target: &str,
    upstream: Option<super::upstream::Upstream>,
) -> Result<SyncResult, GitError> {
    let Some(upstream) = upstream else {
        if super::ops::get_remote(cli, space_dir).await?.is_none() {
            return Ok(SyncResult::NoRemote);
        }
        return Err(GitError::GitCommandFailed(
            "Cannot sync detached HEAD without an upstream".to_string(),
        ));
    };
    let observed = match super::upstream::fetch(cli, space_dir, upstream).await {
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
    if let Some(revision) = observed.revision.as_deref()
        && let Some(stopped) = integrate(cli, space_dir, &observed.upstream, revision).await?
    {
        return Ok(stopped);
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
    })
}

pub async fn validate_transport(cli: &GitCli, repo: &Path, expected: &str) -> Result<(), GitError> {
    if super::operations::read_transport(cli, repo).await? != expected {
        return Err(super::operations::target_changed(repo));
    }
    Ok(())
}

/// The integration step: merges `revision`, the one the fetch step observed
/// for `upstream`, into the current branch. `None` when the branch now
/// contains it and no file is left in conflict; otherwise the state that stops
/// sync before push.
pub async fn integrate(
    cli: &GitCli,
    space_dir: &Path,
    upstream: &super::upstream::Upstream,
    revision: &str,
) -> Result<Option<SyncResult>, GitError> {
    let mut retried = false;
    loop {
        let trace = HookTrace::new();
        let merge = super::upstream::merge(cli, space_dir, upstream, revision, &trace).await?;
        if merge.exit_code == 0 {
            // A merge that succeeds, or the merge retried after setting
            // matching edits aside, may still leave files in conflict.
            return preflight(cli, space_dir).await;
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
        .await
        .map(Some);
    }
}

async fn merge_failure(
    cli: &GitCli,
    space_dir: &Path,
    stderr: &str,
    stdout: &str,
    hook_failed: bool,
) -> Result<SyncResult, GitError> {
    let stderr = stderr.trim();

    if super::ops::is_git_auth_error(stderr) {
        return auth_required(cli, space_dir, GitRemoteOperation::Sync, Some(stderr)).await;
    }

    if stderr.contains("CONFLICT")
        || stderr.contains("Automatic merge failed")
        || stdout.contains("CONFLICT")
        || stdout.contains("Automatic merge failed")
    {
        let files = conflict_files(cli, space_dir).await?;
        return Ok(SyncResult::Conflict { files });
    }

    // The merge commit of the step runs the hooks of the repository.
    let error = if hook_failed {
        super::ops::sync_failure(space_dir, GitStage::Integrate, stderr, true)
    } else {
        super::ops::git_remote_command_error(space_dir, GitStage::Integrate, stderr)
    };
    remote_error_to_sync_result(cli, space_dir, GitRemoteOperation::Sync, error).await
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

    let files = conflict_files(cli, space_dir).await?;
    if !files.is_empty() {
        return Ok(SyncResult::Conflict { files });
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
    validate_transport(cli, space_dir, &target).await?;
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
#[path = "sync_preflight_tests.rs"]
mod preflight_tests;

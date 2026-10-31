//! Fetch and integration steps of sync, the pair that replaces `git pull`.
//!
//! Fetch takes only the upstream branch of the current branch into its
//! remote-tracking ref, without recursion into submodules and without writing
//! `FETCH_HEAD`, and returns the revision it observed. Integration merges
//! exactly that revision with explicit parameters, so user settings that change
//! fetch and merge semantics (`pull.*`, `merge.ff`, `merge.autoStash`,
//! `rebase.*`, `rerere.*`, `submodule.recurse`, `fetch.recurseSubmodules`,
//! `branch.<name>.mergeOptions`) do not change the result. Hooks and commit
//! signing of the user still apply.

use std::path::Path;

use super::GitError;
use super::cli::{GitCli, GitOutput};

/// A remote branch the fetch step takes for the current branch: for sync its
/// configured upstream, or for a branch without one the same-named branch of
/// `origin`, where its first publication goes; for the remote counters that
/// same-named branch of `origin`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Upstream {
    pub branch: String,
    /// Remote name, or `.` for an upstream branch of the same repository.
    pub remote: String,
    /// The branch on the remote, e.g. `refs/heads/main`.
    pub remote_ref: String,
    /// Where the fetch stores it, e.g. `refs/remotes/origin/main`.
    pub tracking_ref: String,
    /// Whether this is the upstream configured for the branch.
    pub configured: bool,
}

/// The revision of [`Upstream`] that one fetch observed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Observed {
    pub upstream: Upstream,
    /// `None` when the remote has no such branch.
    pub revision: Option<String>,
}

/// The fetch target of sync for the current branch. `None` on a detached or
/// unnamed HEAD, and for a branch without upstream when `origin` is not
/// configured.
pub async fn of_current_branch(cli: &GitCli, repo: &Path) -> Result<Option<Upstream>, GitError> {
    let head = cli.exec(repo, &["symbolic-ref", "-q", "HEAD"]).await?;
    let Some(branch) = head
        .stdout
        .trim()
        .strip_prefix("refs/heads/")
        .filter(|branch| head.exit_code == 0 && !branch.is_empty())
        .map(str::to_owned)
    else {
        return Ok(None);
    };
    let configured = cli
        .exec(
            repo,
            &[
                "for-each-ref",
                "--format=%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)",
                &format!("refs/heads/{branch}"),
            ],
        )
        .await?;
    if configured.exit_code != 0 {
        return Err(GitError::GitCommandFailed(format!(
            "git for-each-ref failed: {}",
            configured.stderr.trim()
        )));
    }
    let fields: Vec<&str> = configured.stdout.trim_end().split('\0').collect();
    if let [tracking_ref, remote, remote_ref] = fields.as_slice()
        && !tracking_ref.is_empty()
        && !remote.is_empty()
        && !remote_ref.is_empty()
    {
        return Ok(Some(Upstream {
            remote: (*remote).to_owned(),
            remote_ref: (*remote_ref).to_owned(),
            tracking_ref: (*tracking_ref).to_owned(),
            branch,
            configured: true,
        }));
    }
    if super::ops::get_remote(cli, repo).await?.is_none() {
        return Ok(None);
    }
    Ok(Some(origin_branch(branch)))
}

/// The fetch step for the remote counters and the focus refresh: the
/// same-named branch of `origin`, which the counters compare HEAD with.
/// `None` when the current branch has no such target.
pub async fn fetch_counted(cli: &GitCli, repo: &Path) -> Result<Option<Observed>, GitError> {
    let Some(upstream) = of_current_branch(cli, repo).await? else {
        return Ok(None);
    };
    let origin = origin_branch(upstream.branch.clone());
    let key = |target: &Upstream| {
        (
            target.remote.clone(),
            target.remote_ref.clone(),
            target.tracking_ref.clone(),
        )
    };
    let target = if key(&upstream) == key(&origin) {
        upstream
    } else if upstream.remote == "origin" || super::ops::get_remote(cli, repo).await?.is_some() {
        origin
    } else {
        return Ok(None);
    };
    fetch(cli, repo, target).await.map(Some)
}

fn origin_branch(branch: String) -> Upstream {
    Upstream {
        remote: "origin".to_owned(),
        remote_ref: format!("refs/heads/{branch}"),
        tracking_ref: format!("refs/remotes/origin/{branch}"),
        branch,
        configured: false,
    }
}

/// Fetches `upstream` alone into its tracking ref and reads the revision the
/// fetch stored there. Submodules, tags, other refs and `FETCH_HEAD` stay as
/// they are. A branch the remote no longer has drops its stale tracking ref,
/// as a pruning fetch would.
pub async fn fetch(cli: &GitCli, repo: &Path, upstream: Upstream) -> Result<Observed, GitError> {
    if upstream.remote != "." {
        let refspec = format!("+{}:{}", upstream.remote_ref, upstream.tracking_ref);
        let out = cli
            .exec(
                repo,
                &[
                    "fetch",
                    "--no-tags",
                    "--no-recurse-submodules",
                    "--no-write-fetch-head",
                    "--no-prune",
                    "--refmap=",
                    &upstream.remote,
                    &refspec,
                ],
            )
            .await?;
        if out.exit_code != 0 {
            let stderr = out.stderr.trim();
            if !stderr.contains("couldn't find remote ref") {
                return Err(super::ops::git_remote_command_error("git fetch", stderr));
            }
            let dropped = cli
                .exec(repo, &["update-ref", "-d", &upstream.tracking_ref])
                .await?;
            if dropped.exit_code != 0 {
                return Err(GitError::GitCommandFailed(format!(
                    "git update-ref failed: {}",
                    dropped.stderr.trim()
                )));
            }
            return Ok(Observed {
                upstream,
                revision: None,
            });
        }
    }
    let read = cli
        .exec(
            repo,
            &[
                "rev-parse",
                "--verify",
                "-q",
                &format!("{}^{{commit}}", upstream.tracking_ref),
            ],
        )
        .await?;
    let revision = read.stdout.trim();
    Ok(Observed {
        revision: (read.exit_code == 0 && !revision.is_empty()).then(|| revision.to_owned()),
        upstream,
    })
}

/// Merges `revision`, observed for `upstream`, into the current branch: a
/// fast-forward when possible, otherwise a merge commit, never a rebase,
/// autostash or recorded resolution. The output is the raw `git merge` result.
pub async fn merge(
    cli: &GitCli,
    repo: &Path,
    upstream: &Upstream,
    revision: &str,
) -> Result<GitOutput, GitError> {
    // `pull.twohead` picks the strategy of `git merge` too; an explicit one
    // overrides it. Without that setting the default strategy of this Git
    // applies, so Git older than 2.33, which lacks `ort`, keeps working.
    let twohead = cli
        .exec(repo, &["config", "--get-all", "pull.twohead"])
        .await?;
    let no_branch_options = format!("branch.{}.mergeOptions=", upstream.branch);
    let message = merge_message(upstream);
    let mut args = vec![
        "-c",
        "submodule.recurse=false",
        "-c",
        "merge.autoStash=false",
        "-c",
        "rerere.enabled=false",
        "-c",
        "rerere.autoUpdate=false",
        "-c",
        &no_branch_options,
        "merge",
        "--no-edit",
        "--ff",
        "--commit",
        "--no-squash",
        "--no-autostash",
        "--no-rerere-autoupdate",
        "-m",
        &message,
    ];
    if twohead.exit_code == 0 {
        args.extend(["-s", "ort"]);
    }
    args.push(revision);
    cli.exec(repo, &args).await
}

fn merge_message(upstream: &Upstream) -> String {
    let tracking = &upstream.tracking_ref;
    match (
        tracking.strip_prefix("refs/remotes/"),
        tracking.strip_prefix("refs/heads/"),
    ) {
        (Some(name), _) => format!("Merge remote-tracking branch '{name}'"),
        (_, Some(name)) => format!("Merge branch '{name}'"),
        _ => format!("Merge '{tracking}'"),
    }
}

#[cfg(test)]
#[path = "upstream_tests.rs"]
mod tests;

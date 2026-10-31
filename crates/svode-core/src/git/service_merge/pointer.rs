//! The value rule of a Space pointer (gitlink) in the project root, owned by
//! Git: the pointer moves only forward.
//!
//! When the incoming revision contains the local one the pointer takes it,
//! when the local revision contains the incoming one it stays. Otherwise the
//! Space checkout decides: after a merge in the Space its revision contains
//! both, and the pointer takes it. Missing revisions are fetched into the
//! object store of the Space alone, as the publication proof does (DF-189):
//! its checkout, branches, tracking refs, index, config and `FETCH_HEAD`
//! stay as they are.

use std::path::Path;

use super::{
    ConflictedPath, Objects, Resolution, RuleContext, RuleFuture, RuleOutcome, ServiceRule,
    UnresolvedReason,
};
use crate::git::GitError;
use crate::git::cli::GitCli;

/// Local reads never contact a promisor remote for a missing object.
const LOCAL: &[(&str, &str)] = &[("GIT_NO_LAZY_FETCH", "1")];

pub struct PointerRule;

impl ServiceRule for PointerRule {
    fn claims(&self, conflict: &ConflictedPath) -> bool {
        // A Space removed by one side is a conflict of the person (1.F).
        conflict.ours.as_ref().is_some_and(|side| side.is_gitlink())
            && conflict
                .theirs
                .as_ref()
                .is_some_and(|side| side.is_gitlink())
    }

    fn resolve<'a>(
        &'a self,
        ctx: &'a RuleContext<'a>,
        conflict: &'a ConflictedPath,
    ) -> RuleFuture<'a> {
        Box::pin(async move {
            let (Some(ours), Some(theirs)) = (&conflict.ours, &conflict.theirs) else {
                return Ok(RuleOutcome::Declined);
            };
            resolve(ctx, &conflict.path, &ours.oid, &theirs.oid).await
        })
    }
}

async fn resolve(
    ctx: &RuleContext<'_>,
    path: &str,
    ours: &str,
    theirs: &str,
) -> Result<RuleOutcome, GitError> {
    let unavailable = Ok(RuleOutcome::Unresolved(UnresolvedReason::SpaceUnavailable));
    let Ok(relative) =
        crate::git::path::normalize_repo_relative(path, crate::git::path::RootMode::Reject)
    else {
        return unavailable;
    };
    let space = ctx.repo.join(relative);
    if !is_checkout(ctx.cli, &space).await? {
        return unavailable;
    }
    let missing = missing_commits(ctx.cli, &space, &[ours, theirs]).await?;
    if !missing.is_empty()
        && (ctx.objects == Objects::Local
            || !fetch_objects(ctx.cli, &space, &missing).await?
            || !missing_commits(ctx.cli, &space, &missing).await?.is_empty())
    {
        return unavailable;
    }
    let gitlink = |oid: &str| Ok(RuleOutcome::Resolved(Resolution::Gitlink(oid.to_owned())));
    if contains(ctx.cli, &space, ours, theirs).await? {
        return gitlink(theirs);
    }
    if contains(ctx.cli, &space, theirs, ours).await? {
        return gitlink(ours);
    }
    let head = ctx
        .cli
        .exec_with_env(&space, &["rev-parse", "--verify", "-q", "HEAD"], LOCAL)
        .await?;
    let head = head.stdout.trim();
    if !head.is_empty()
        && contains(ctx.cli, &space, ours, head).await?
        && contains(ctx.cli, &space, theirs, head).await?
    {
        return gitlink(head);
    }
    Ok(RuleOutcome::Unresolved(UnresolvedReason::SpaceDiverged))
}

/// Whether `dir` is the top of a Git checkout of its own.
async fn is_checkout(cli: &GitCli, dir: &Path) -> Result<bool, GitError> {
    if dir.join(".git").symlink_metadata().is_err() {
        return Ok(false);
    }
    let top = cli.exec(dir, &["rev-parse", "--show-toplevel"]).await?;
    Ok(top.exit_code == 0
        && std::fs::canonicalize(top.stdout.trim()).ok() == std::fs::canonicalize(dir).ok())
}

/// The revisions among `oids` whose commit the object store of `space` lacks.
async fn missing_commits<'o>(
    cli: &GitCli,
    space: &Path,
    oids: &[&'o str],
) -> Result<Vec<&'o str>, GitError> {
    let mut missing = Vec::new();
    for oid in oids {
        let object = format!("{oid}^{{commit}}");
        let out = cli
            .exec_with_env(space, &["cat-file", "-e", &object], LOCAL)
            .await?;
        if out.exit_code != 0 && !missing.contains(oid) {
            missing.push(*oid);
        }
    }
    Ok(missing)
}

/// Whether the history of `revision` contains `ancestor`.
async fn contains(
    cli: &GitCli,
    space: &Path,
    ancestor: &str,
    revision: &str,
) -> Result<bool, GitError> {
    if ancestor == revision {
        return Ok(true);
    }
    let out = cli
        .exec_with_env(
            space,
            &["merge-base", "--is-ancestor", ancestor, revision],
            LOCAL,
        )
        .await?;
    match out.exit_code {
        0 => Ok(true),
        1 => Ok(false),
        _ => Err(GitError::GitCommandFailed(format!(
            "Cannot compare Space revisions: {}",
            out.stderr.trim()
        ))),
    }
}

/// Fetch the history of `oids` from the remote the Space syncs with into its
/// object store. No ref, `FETCH_HEAD` or submodule of the Space changes:
/// an empty `--refmap` keeps the configured refspecs from mapping anything,
/// and protocol v2 accepts the unadvertised revisions. `false` when the
/// Space has no remote or the fetch failed.
async fn fetch_objects(cli: &GitCli, space: &Path, oids: &[&str]) -> Result<bool, GitError> {
    let remote = match crate::git::upstream::of_current_branch(cli, space).await {
        Ok(Some(upstream)) if upstream.remote != "." => upstream.remote,
        Ok(_) | Err(_) => match crate::git::ops::get_remote(cli, space).await {
            Ok(Some(_)) => "origin".to_owned(),
            Ok(None) | Err(_) => return Ok(false),
        },
    };
    let mut args = vec![
        "-c",
        "protocol.version=2",
        "fetch",
        "--no-tags",
        "--no-recurse-submodules",
        "--no-write-fetch-head",
        "--no-prune",
        "--no-auto-maintenance",
        "--refmap=",
        &remote,
    ];
    args.extend_from_slice(oids);
    let out = cli.exec(space, &args).await?;
    if out.exit_code != 0 {
        tracing::warn!(
            "fetching Space revisions for a pointer merge failed in {}: {}",
            space.display(),
            out.stderr.trim()
        );
    }
    Ok(out.exit_code == 0)
}

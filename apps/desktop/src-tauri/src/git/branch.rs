use std::path::{Path, PathBuf};

use serde::Serialize;

use super::cli::GitCli;
use crate::AppError;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BranchBlockReason {
    Configuration,
    RootDetached,
    RemoteUnavailable,
    MissingBranch,
    LocalChanges,
    OperationInProgress,
    LocalHistory,
    IncompatibleBranch,
    CheckoutFailed,
}

fn blocked(reason: BranchBlockReason) -> AppError {
    AppError::GitBranchBlocked { reason }
}

async fn checked(cli: &GitCli, repo: &Path, args: &[&str]) -> Result<String, AppError> {
    let out = cli.exec(repo, args).await?;
    if out.exit_code != 0 {
        return Err(blocked(BranchBlockReason::Configuration));
    }
    Ok(out.stdout.trim_end_matches(['\n', '\r']).to_string())
}

async fn config(cli: &GitCli, repo: &Path, key: &str) -> Result<Option<String>, AppError> {
    let out = cli.exec(repo, &["config", "--get", key]).await?;
    match out.exit_code {
        0 => Ok(Some(out.stdout.trim_end().to_string())),
        1 => Ok(None),
        _ => Err(blocked(BranchBlockReason::Configuration)),
    }
}

async fn module_branch(
    cli: &GitCli,
    root: &Path,
    child: &Path,
) -> Result<Option<String>, AppError> {
    let path =
        crate::repo_path::repo_relative_from_base(root, child, crate::repo_path::RootMode::Reject)?;
    let out = cli
        .exec(
            root,
            &[
                "config",
                "-z",
                "-f",
                ".gitmodules",
                "--get-regexp",
                "^submodule\\..*\\.path$",
            ],
        )
        .await?;
    if out.exit_code != 0 {
        return Err(blocked(BranchBlockReason::Configuration));
    }
    let names: Vec<_> = out
        .stdout
        .split('\0')
        .filter_map(|record| {
            let (key, value) = record.split_once('\n')?;
            (value == path).then(|| key.strip_suffix(".path")).flatten()
        })
        .collect();
    if names.len() != 1 {
        return Err(blocked(BranchBlockReason::Configuration));
    }
    let out = cli
        .exec(
            root,
            &[
                "config",
                "-f",
                ".gitmodules",
                "--get",
                &format!("{}.branch", names[0]),
            ],
        )
        .await?;
    match out.exit_code {
        0 => Ok(Some(out.stdout.trim_end().to_string())),
        1 => Ok(None),
        _ => Err(blocked(BranchBlockReason::Configuration)),
    }
}

/// Discover old-form and absorbed direct submodules through Git and exact paths.
pub(crate) async fn parent(cli: &GitCli, repo: &Path) -> Result<Option<PathBuf>, AppError> {
    let Some(directory) = repo.parent() else {
        return Ok(None);
    };
    let out = cli
        .exec(directory, &["rev-parse", "--show-toplevel"])
        .await?;
    if out.exit_code != 0 {
        return Ok(None);
    }
    let root = PathBuf::from(out.stdout.trim_end());
    let root = std::fs::canonicalize(root)?;
    let repo = std::fs::canonicalize(repo)?;
    if root == repo || !repo.starts_with(&root) {
        return Ok(None);
    }
    let relative = crate::repo_path::repo_relative_from_base(
        &root,
        &repo,
        crate::repo_path::RootMode::Reject,
    )?;
    if super::ops::list_submodules(cli, &root)
        .await?
        .iter()
        .any(|item| item.path == relative)
    {
        Ok(Some(root))
    } else {
        Ok(None)
    }
}

pub(crate) async fn prepare_existing(cli: &GitCli, repo: &Path) -> Result<(), AppError> {
    if let Some(root) = parent(cli, repo).await? {
        prepare(cli, &root, &std::fs::canonicalize(repo)?, false).await?;
    }
    Ok(())
}

/// Caller holds the child repository lock. Refuse before any index/worktree write.
pub(crate) async fn prepare(
    cli: &GitCli,
    root: &Path,
    child: &Path,
    materializing: bool,
) -> Result<(), AppError> {
    let attached = cli
        .exec(child, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .await?;
    let branch = (attached.exit_code == 0).then(|| attached.stdout.trim_end().to_string());
    let origin = super::ops::get_remote(cli, child).await?;
    if let Some(branch) = &branch {
        // Locally created submodules retain their existing offline save workflow.
        if !materializing && origin.is_none() {
            return Ok(());
        }
        let remote = config(cli, child, &format!("branch.{branch}.remote")).await?;
        let merge = config(cli, child, &format!("branch.{branch}.merge")).await?;
        if !materializing
            && remote.as_deref() == Some("origin")
            && merge
                .as_deref()
                .is_some_and(|value| value.starts_with("refs/heads/"))
        {
            let upstream = cli
                .exec(child, &["rev-parse", "--verify", "@{upstream}"])
                .await?;
            if upstream.exit_code == 0 {
                return Ok(());
            }
        }
    }
    if branch.is_none() {
        ensure_no_operation(cli, child).await?;
        let status = checked(
            cli,
            child,
            &[
                "--no-optional-locks",
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
                "--ignore-submodules=none",
            ],
        )
        .await?;
        if !status.is_empty() {
            return Err(blocked(BranchBlockReason::LocalChanges));
        }
    }
    let configured = module_branch(cli, root, child).await?;
    let expected = match configured.as_deref() {
        Some(".") => {
            let out = cli
                .exec(root, &["symbolic-ref", "--quiet", "--short", "HEAD"])
                .await?;
            if out.exit_code != 0 {
                return Err(blocked(BranchBlockReason::RootDetached));
            }
            out.stdout.trim_end().to_string()
        }
        Some(name) => name.to_string(),
        None => {
            let out = cli
                .exec(child, &["ls-remote", "--symref", "origin", "HEAD"])
                .await?;
            if out.exit_code != 0 {
                return Err(blocked(BranchBlockReason::RemoteUnavailable));
            }
            out.stdout
                .lines()
                .find_map(|line| {
                    line.strip_prefix("ref: refs/heads/")
                        .and_then(|s| s.strip_suffix("\tHEAD"))
                })
                .ok_or_else(|| blocked(BranchBlockReason::MissingBranch))?
                .to_string()
        }
    };
    if cli
        .exec(child, &["check-ref-format", "--branch", &expected])
        .await?
        .exit_code
        != 0
    {
        return Err(blocked(BranchBlockReason::Configuration));
    }
    if branch.as_ref().is_some_and(|branch| branch != &expected) {
        return Err(blocked(BranchBlockReason::IncompatibleBranch));
    }
    if let Some(branch) = &branch {
        let remote = config(cli, child, &format!("branch.{branch}.remote")).await?;
        let merge = config(cli, child, &format!("branch.{branch}.merge")).await?;
        if remote.as_deref().is_some_and(|remote| remote != "origin")
            || merge
                .as_deref()
                .is_some_and(|merge| merge != format!("refs/heads/{expected}"))
        {
            return Err(blocked(BranchBlockReason::IncompatibleBranch));
        }
    }
    if origin.is_none() {
        return Err(blocked(BranchBlockReason::RemoteUnavailable));
    }
    let remote_ref = format!("refs/heads/{expected}");
    let refspec = cli
        .exec(child, &["config", "--get-all", "remote.origin.fetch"])
        .await?;
    let expected_refspec = format!("refs/heads/{expected}:refs/remotes/origin/{expected}");
    let mappings: Vec<_> = refspec
        .stdout
        .lines()
        .map(|line| line.strip_prefix('+').unwrap_or(line))
        .collect();
    if refspec.exit_code != 0
        || mappings.len() != 1
        || (mappings[0] != "refs/heads/*:refs/remotes/origin/*" && mappings[0] != expected_refspec)
    {
        return Err(blocked(BranchBlockReason::Configuration));
    }

    let advertised = cli
        .exec(child, &["ls-remote", "--refs", "origin", &remote_ref])
        .await?;
    if advertised.exit_code != 0 {
        return Err(blocked(BranchBlockReason::RemoteUnavailable));
    }
    let oid = advertised
        .stdout
        .lines()
        .find_map(|line| {
            let (oid, name) = line.split_once('\t')?;
            (name == remote_ref).then_some(oid)
        })
        .ok_or_else(|| blocked(BranchBlockReason::MissingBranch))?;
    // Fetch objects only: refusal must preserve all local refs and FETCH_HEAD.
    let fetched = cli
        .exec(
            child,
            &[
                "fetch",
                "--no-recurse-submodules",
                "--no-tags",
                "--no-write-fetch-head",
                "--refmap=",
                "origin",
                &remote_ref,
            ],
        )
        .await?;
    if fetched.exit_code != 0 {
        return Err(blocked(BranchBlockReason::RemoteUnavailable));
    }
    if cli
        .exec(child, &["cat-file", "-e", &format!("{oid}^{{commit}}")])
        .await?
        .exit_code
        != 0
    {
        return Err(blocked(BranchBlockReason::RemoteUnavailable));
    }
    if branch.is_none() {
        if !ancestor(cli, child, "HEAD", oid).await? {
            return Err(blocked(BranchBlockReason::LocalHistory));
        }
        let local_ref = format!("refs/heads/{expected}");
        let local = cli
            .exec(child, &["rev-parse", "--verify", &local_ref])
            .await?;
        let args = if local.exit_code == 0 {
            if !ancestor(cli, child, "HEAD", &local_ref).await?
                || !(ancestor(cli, child, &local_ref, oid).await?
                    || ancestor(cli, child, oid, &local_ref).await?)
            {
                return Err(blocked(BranchBlockReason::IncompatibleBranch));
            }
            vec![
                "checkout",
                "--no-recurse-submodules",
                "--no-overwrite-ignore",
                expected.as_str(),
            ]
        } else {
            vec![
                "checkout",
                "--no-recurse-submodules",
                "--no-overwrite-ignore",
                "-b",
                expected.as_str(),
                oid,
            ]
        };
        let out = cli
            .exec_with_env(child, &args, &[("GIT_LFS_SKIP_SMUDGE", "1")])
            .await?;
        if out.exit_code != 0 {
            return Err(blocked(BranchBlockReason::CheckoutFailed));
        }
    }
    let tracking = format!("refs/remotes/origin/{expected}");
    checked(cli, child, &["update-ref", &tracking, oid]).await?;
    checked(
        cli,
        child,
        &[
            "branch",
            &format!("--set-upstream-to=origin/{expected}"),
            &expected,
        ],
    )
    .await?;
    let actual = checked(cli, child, &["symbolic-ref", "--short", "HEAD"]).await?;
    if actual != expected {
        return Err(blocked(BranchBlockReason::CheckoutFailed));
    }
    Ok(())
}

async fn ancestor(cli: &GitCli, repo: &Path, older: &str, newer: &str) -> Result<bool, AppError> {
    let out = cli
        .exec(repo, &["merge-base", "--is-ancestor", older, newer])
        .await?;
    match out.exit_code {
        0 => Ok(true),
        1 => Ok(false),
        _ => Err(blocked(BranchBlockReason::LocalHistory)),
    }
}

pub(crate) async fn ensure_no_operation(cli: &GitCli, repo: &Path) -> Result<(), AppError> {
    let path = |name| async move {
        checked(
            cli,
            repo,
            &["rev-parse", "--path-format=absolute", "--git-path", name],
        )
        .await
    };
    let paths = tokio::join!(
        path("MERGE_HEAD"),
        path("CHERRY_PICK_HEAD"),
        path("REVERT_HEAD"),
        path("rebase-merge"),
        path("rebase-apply"),
        path("sequencer"),
    );
    for result in [paths.0, paths.1, paths.2, paths.3, paths.4, paths.5] {
        let path = result?;
        if Path::new(&path).exists() {
            return Err(blocked(BranchBlockReason::OperationInProgress));
        }
    }
    Ok(())
}

/// Never repeat `submodule update` over an existing checkout, even after a partial clone.
pub(crate) async fn materialize(
    cli: &GitCli,
    root: &Path,
    child: &Path,
    path: &str,
) -> Result<(), AppError> {
    module_branch(cli, root, child).await?;
    let initialized = if child.is_dir() {
        let out = cli.exec(child, &["rev-parse", "--show-toplevel"]).await?;
        out.exit_code == 0
            && std::fs::canonicalize(out.stdout.trim_end()).ok()
                == std::fs::canonicalize(child).ok()
    } else {
        false
    };
    if !initialized {
        let out = cli
            .exec_with_env(
                root,
                &[
                    "-c",
                    "submodule.recurse=false",
                    "submodule",
                    "update",
                    "--init",
                    "--checkout",
                    "--",
                    path,
                ],
                &[("GIT_LFS_SKIP_SMUDGE", "1")],
            )
            .await?;
        if out.exit_code != 0 {
            return Err(blocked(BranchBlockReason::RemoteUnavailable));
        }
    }
    prepare(cli, root, child, !initialized).await
}

#[cfg(test)]
#[path = "branch_tests.rs"]
mod tests;

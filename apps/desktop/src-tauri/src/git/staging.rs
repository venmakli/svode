use std::{collections::BTreeSet, path::Path};

use super::cli::{GitCli, GitOutput};
use crate::{
    AppError,
    repo_path::{RootMode, normalize_repo_relative},
};

pub(super) fn failure(
    stage: &'static str,
    reason: &'static str,
    exit_code: Option<i32>,
    paths: &[String],
) -> AppError {
    AppError::GitSaveFailed {
        stage,
        reason,
        exit_code,
        path_count: paths.len(),
        path_sample: paths
            .first()
            .and_then(|path| normalize_repo_relative(path, RootMode::Reject).ok())
            .map(|path| path.chars().filter(|c| !c.is_control()).take(160).collect()),
    }
}

pub(super) async fn exec(
    cli: &GitCli,
    repo: &Path,
    args: &[&str],
    stage: &'static str,
    paths: &[String],
) -> Result<GitOutput, AppError> {
    cli.exec_redacted(repo, args)
        .await
        .map_err(|_| failure(stage, "command_unavailable", None, paths))
}

async fn read_paths(
    cli: &GitCli,
    repo: &Path,
    args: &[&str],
) -> Result<BTreeSet<String>, AppError> {
    let out = exec(cli, repo, args, "prepare", &[]).await?;
    if out.exit_code != 0 {
        return Err(failure(
            "prepare",
            "inventory_failed",
            Some(out.exit_code),
            &[],
        ));
    }
    out.stdout
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(|p| {
            normalize_repo_relative(p.trim_end_matches('/'), RootMode::Reject)
                .map_err(|_| failure("prepare", "invalid_path", None, &[]))
        })
        .collect()
}

fn within(path: &str, scope: &str) -> bool {
    scope == "."
        || scope.is_empty()
        || path == scope
        || path
            .strip_prefix(scope)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// Enumerate through Git, which owns ignore rules, tracked deletions and repository boundaries.
pub(super) async fn resolve(
    cli: &GitCli,
    repo: &Path,
    requested: &[String],
) -> Result<Vec<String>, AppError> {
    let scopes = requested
        .iter()
        .map(|path| {
            normalize_repo_relative(path, RootMode::Allow)
                .map_err(|_| failure("prepare", "invalid_path", None, &[]))
        })
        .collect::<Result<Vec<_>, _>>()?;
    for scope in &scopes {
        if super::local_policy::contains(scope) {
            return Err(failure(
                "prepare",
                "local_file_excluded",
                None,
                std::slice::from_ref(scope),
            ));
        }
    }
    let mut entries = read_paths(
        cli,
        repo,
        &[
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ],
    )
    .await?;
    // HEAD also contains paths already removed from the index by an earlier save attempt.
    let head = exec(
        cli,
        repo,
        &["rev-parse", "--verify", "HEAD"],
        "prepare",
        &[],
    )
    .await?;
    if head.exit_code == 0 {
        entries
            .extend(read_paths(cli, repo, &["ls-tree", "-r", "--name-only", "-z", "HEAD"]).await?);
    }
    let mut selected = BTreeSet::new();
    for scope in scopes {
        let matches = entries
            .iter()
            .filter(|path| within(path, &scope))
            .collect::<Vec<_>>();
        if matches.is_empty() && scope != "." && !scope.is_empty() && !repo.join(&scope).is_dir() {
            return Err(failure("prepare", "target_unavailable", None, &[scope]));
        }
        for path in matches {
            if !super::local_policy::contains(path) {
                selected.insert(path.clone());
            }
        }
    }
    Ok(selected.into_iter().collect())
}

pub(super) async fn prepare(
    cli: &GitCli,
    repo: &Path,
    paths: &[String],
) -> Result<BTreeSet<String>, AppError> {
    let present = paths
        .iter()
        .filter(|p| repo.join(p).symlink_metadata().is_ok())
        .cloned()
        .collect::<BTreeSet<_>>();
    let indexed = read_paths(cli, repo, &["ls-files", "--cached", "-z"]).await?;
    for path in paths {
        // A tracked deletion already staged has nothing left for `git add` to match.
        if !indexed.contains(path) && repo.join(path).symlink_metadata().is_err() {
            let head = exec(
                cli,
                repo,
                &[
                    "ls-tree",
                    "-r",
                    "--name-only",
                    "-z",
                    "HEAD",
                    "--",
                    &format!(":(literal){path}"),
                ],
                "prepare",
                std::slice::from_ref(path),
            )
            .await?;
            if head.exit_code != 0 || !head.stdout.split('\0').any(|p| p == path) {
                return Err(failure(
                    "prepare",
                    "target_unavailable",
                    None,
                    std::slice::from_ref(path),
                ));
            }
            continue;
        }
        let literal = format!(":(literal){path}");
        let out = exec(
            cli,
            repo,
            &["add", "--", &literal],
            "prepare",
            std::slice::from_ref(path),
        )
        .await?;
        if out.exit_code != 0 {
            return Err(failure(
                "prepare",
                "command_failed",
                Some(out.exit_code),
                std::slice::from_ref(path),
            ));
        }
    }
    verify(cli, repo, paths, &present).await?;
    Ok(present)
}

pub(super) async fn verify(
    cli: &GitCli,
    repo: &Path,
    paths: &[String],
    present: &BTreeSet<String>,
) -> Result<(), AppError> {
    if paths.is_empty() {
        return Ok(());
    }
    let indexed = read_paths(cli, repo, &["ls-files", "--cached", "-z"]).await?;
    let missing = paths
        .iter()
        .filter(|p| {
            repo.join(p).symlink_metadata().is_ok() != present.contains(*p)
                || present.contains(*p) != indexed.contains(*p)
        })
        .cloned()
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(failure("verify", "paths_not_prepared", None, &missing));
    }
    let literals = paths
        .iter()
        .map(|p| format!(":(literal){p}"))
        .collect::<Vec<_>>();
    let mut args = vec![
        "diff",
        "--no-ext-diff",
        "--name-only",
        "-z",
        "--ignore-submodules=dirty",
        "--",
    ];
    args.extend(literals.iter().map(String::as_str));
    let out = exec(cli, repo, &args, "verify", paths).await?;
    if out.exit_code != 0 {
        return Err(failure(
            "verify",
            "verification_failed",
            Some(out.exit_code),
            paths,
        ));
    }
    let dirty = out
        .stdout
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    if !dirty.is_empty() {
        return Err(failure("verify", "paths_not_prepared", None, &dirty));
    }
    Ok(())
}

pub(super) async fn has_changes(
    cli: &GitCli,
    repo: &Path,
    paths: &[String],
) -> Result<bool, AppError> {
    let literals = paths
        .iter()
        .map(|p| format!(":(literal){p}"))
        .collect::<Vec<_>>();
    let mut args = vec!["diff", "--cached", "--quiet", "--no-ext-diff", "--"];
    args.extend(literals.iter().map(String::as_str));
    let out = exec(cli, repo, &args, "verify", paths).await?;
    match out.exit_code {
        0 => Ok(false),
        1 => Ok(true),
        code => Err(failure("verify", "verification_failed", Some(code), paths)),
    }
}

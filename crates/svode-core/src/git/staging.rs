use std::{
    collections::{BTreeSet, HashMap},
    path::{Path, PathBuf},
    time::Duration,
};

use unicode_normalization::UnicodeNormalization;

use super::GitError;
use super::cli::{GitCli, GitOutput};
use crate::git::path::{RootMode, normalize_repo_relative};

/// Presence of repository paths by their exact spelling. A case-insensitive
/// file system also resolves the old spelling of a case-only relocation, so a
/// path counts as present only when every component is listed with this name
/// (up to Unicode normalization, which Git precomposes).
pub(crate) struct Presence<'a> {
    root: &'a Path,
    listings: HashMap<PathBuf, Option<BTreeSet<String>>>,
}

impl<'a> Presence<'a> {
    pub(crate) fn new(root: &'a Path) -> Self {
        Self {
            root,
            listings: HashMap::new(),
        }
    }

    pub(crate) fn exact(&mut self, path: &str) -> bool {
        if self.root.join(path).symlink_metadata().is_err() {
            return false;
        }
        let mut dir = self.root.to_path_buf();
        for part in path.split('/') {
            let names = self.listings.entry(dir.clone()).or_insert_with(|| {
                std::fs::read_dir(&dir).ok().map(|entries| {
                    entries
                        .flatten()
                        .map(|entry| entry.file_name().to_string_lossy().nfc().collect())
                        .collect()
                })
            });
            let name: String = part.nfc().collect();
            if !names.as_ref().is_some_and(|names| names.contains(&name)) {
                return false;
            }
            dir.push(part);
        }
        true
    }

    /// The file system resolves `path`, but only under another spelling.
    pub(crate) fn shadowed(&mut self, path: &str) -> bool {
        self.root.join(path).symlink_metadata().is_ok() && !self.exact(path)
    }
}

pub fn failure(
    stage: &'static str,
    reason: &'static str,
    exit_code: Option<i32>,
    paths: &[String],
) -> GitError {
    GitError::SaveFailed {
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

pub async fn exec(
    cli: &GitCli,
    repo: &Path,
    args: &[&str],
    stage: &'static str,
    paths: &[String],
) -> Result<GitOutput, GitError> {
    cli.exec_redacted(repo, args)
        .await
        .map_err(|_| failure(stage, "command_unavailable", None, paths))
}

async fn read_paths(
    cli: &GitCli,
    repo: &Path,
    args: &[&str],
) -> Result<BTreeSet<String>, GitError> {
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
pub async fn resolve(
    cli: &GitCli,
    repo: &Path,
    requested: &[String],
) -> Result<Vec<String>, GitError> {
    let scopes = requested
        .iter()
        .map(|path| {
            normalize_repo_relative(path, RootMode::Allow)
                .map_err(|_| failure("prepare", "invalid_path", None, &[]))
        })
        .collect::<Result<Vec<_>, _>>()?;
    for scope in &scopes {
        if super::policy::contains(scope) {
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
    let mut presence = Presence::new(repo);
    let mut selected = BTreeSet::new();
    for scope in scopes {
        let mut matches = entries
            .iter()
            .filter(|path| within(path, &scope))
            .cloned()
            .collect::<Vec<_>>();
        if matches.is_empty() && scope != "." && !scope.is_empty() && presence.exact(&scope) {
            // Git folding names on a case-insensitive file system counts the new
            // spelling of a case-only relocation as its tracked old one.
            matches = read_paths(
                cli,
                repo,
                &[
                    "-c",
                    "core.ignorecase=false",
                    "ls-files",
                    "--others",
                    "--exclude-standard",
                    "-z",
                    "--",
                    &format!(":(literal){scope}"),
                ],
            )
            .await?
            .into_iter()
            .filter(|path| presence.exact(path))
            .collect();
        }
        if matches.is_empty() && scope != "." && !scope.is_empty() && !repo.join(&scope).is_dir() {
            return Err(failure("prepare", "target_unavailable", None, &[scope]));
        }
        for path in matches {
            if !super::policy::contains(&path) {
                selected.insert(path);
            }
        }
    }
    let selected = selected.into_iter().collect::<Vec<_>>();
    // A Space checkout behind the project pointer is never staged over it.
    let backward = super::published_pointer::backward(cli, repo, &selected).await?;
    Ok(selected
        .into_iter()
        .filter(|path| !backward.contains(path))
        .collect())
}

/// Keep the paths that still carry a change: present on disk, or with an index
/// or HEAD entry at or under them. A path a later managed relocation moved
/// away before it was ever recorded by Git has nothing to commit.
pub async fn recorded(
    cli: &GitCli,
    repo: &Path,
    paths: Vec<String>,
) -> Result<Vec<String>, GitError> {
    let mut presence = Presence::new(repo);
    if paths.iter().all(|path| presence.exact(path)) {
        return Ok(paths);
    }
    let mut entries = read_paths(cli, repo, &["ls-files", "--cached", "-z"]).await?;
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
    Ok(paths
        .into_iter()
        .filter(|path| presence.exact(path) || entries.iter().any(|entry| within(entry, path)))
        .collect())
}

pub async fn prepare(
    cli: &GitCli,
    repo: &Path,
    paths: &[String],
) -> Result<BTreeSet<String>, GitError> {
    let mut presence = Presence::new(repo);
    let present = paths
        .iter()
        .filter(|p| presence.exact(p))
        .cloned()
        .collect::<BTreeSet<_>>();
    let indexed = read_paths(cli, repo, &["ls-files", "--cached", "-z"]).await?;
    // Removals come first: a new spelling added while its old one is still
    // indexed keeps the old spelling on a case-insensitive file system, and
    // `git add` of that old spelling would find the new file.
    for path in paths.iter().filter(|path| !present.contains(*path)) {
        if indexed.contains(path) {
            let out = exec(
                cli,
                repo,
                &["update-index", "--force-remove", "--", path],
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
            continue;
        }
        // A tracked deletion already staged has nothing left to stage.
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
    }
    for path in paths.iter().filter(|path| present.contains(*path)) {
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

pub async fn verify(
    cli: &GitCli,
    repo: &Path,
    paths: &[String],
    present: &BTreeSet<String>,
) -> Result<(), GitError> {
    if paths.is_empty() {
        return Ok(());
    }
    let indexed = read_paths(cli, repo, &["ls-files", "--cached", "-z"]).await?;
    let mut presence = Presence::new(repo);
    let missing = paths
        .iter()
        .filter(|p| {
            presence.exact(p) != present.contains(*p)
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

/// Commit `paths` as they are prepared in the index. `commit --only` re-reads
/// each path from the work tree, and a case-insensitive file system resolves
/// the old spelling of a case-only relocation to the new file, so that commit
/// records no relocation. A temporary index with HEAD plus the prepared
/// entries of `paths` commits them as staged; other staged paths stay staged.
pub async fn commit_prepared(
    cli: &GitCli,
    repo: &Path,
    paths: &[String],
    message: &str,
) -> Result<GitOutput, GitError> {
    let locations = exec(
        cli,
        repo,
        &[
            "rev-parse",
            "--git-path",
            "svode-save.index",
            "--git-path",
            "MERGE_HEAD",
            "--git-path",
            "CHERRY_PICK_HEAD",
            "--git-path",
            "REVERT_HEAD",
        ],
        "commit",
        paths,
    )
    .await?;
    let locations = locations
        .stdout
        .lines()
        .map(|line| repo.join(line.trim()))
        .collect::<Vec<_>>();
    let [index, sequencer @ ..] = locations.as_slice() else {
        return Err(failure("commit", "command_unavailable", None, paths));
    };
    // Like `commit --only`, a partial commit never concludes a merge or a pick.
    if sequencer.len() != 3 || sequencer.iter().any(|path| path.exists()) {
        return Err(failure("commit", "command_failed", None, paths));
    }
    let _ = std::fs::remove_file(index);
    let outcome = commit_through(cli, repo, index, paths, message).await;
    let _ = std::fs::remove_file(index);
    outcome
}

async fn commit_through(
    cli: &GitCli,
    repo: &Path,
    index: &Path,
    paths: &[String],
    message: &str,
) -> Result<GitOutput, GitError> {
    let index = index.to_string_lossy();
    let env = [("GIT_INDEX_FILE", index.as_ref())];
    let literals = paths
        .iter()
        .map(|path| format!(":(literal){path}"))
        .collect::<Vec<_>>();
    let head = exec(
        cli,
        repo,
        &["rev-parse", "--verify", "HEAD"],
        "commit",
        paths,
    )
    .await?;
    let base: &[&str] = if head.exit_code == 0 {
        &["read-tree", "HEAD"]
    } else {
        &["read-tree", "--empty"]
    };
    let mut steps = vec![
        cli.exec_redacted_with_env(repo, base, &env)
            .await
            .map_err(|_| failure("commit", "command_unavailable", None, paths))?,
    ];
    let mut args = vec!["ls-files", "--stage", "-z", "--"];
    args.extend(literals.iter().map(String::as_str));
    let staged = exec(cli, repo, &args, "commit", paths).await?;
    let mut kept = BTreeSet::new();
    for record in staged
        .stdout
        .split('\0')
        .filter(|record| !record.is_empty())
    {
        if let Some((_, path)) = record.split_once('\t') {
            kept.insert(path.to_string());
        }
    }
    if !staged.stdout.is_empty() {
        steps.push(
            cli.exec_sensitive_with_stdin(
                repo,
                &[
                    "-c",
                    "core.ignorecase=false",
                    "update-index",
                    "-z",
                    "--index-info",
                ],
                &env,
                Some(&staged.stdout),
                Duration::from_secs(60),
            )
            .await
            .map_err(|_| failure("commit", "command_unavailable", None, paths))?,
        );
    }
    for path in paths.iter().filter(|path| !kept.contains(*path)) {
        steps.push(
            cli.exec_redacted_with_env(
                repo,
                &[
                    "-c",
                    "core.ignorecase=false",
                    "update-index",
                    "--force-remove",
                    "--",
                    path,
                ],
                &env,
            )
            .await
            .map_err(|_| failure("commit", "command_unavailable", None, paths))?,
        );
    }
    if let Some(step) = steps.iter().find(|step| step.exit_code != 0) {
        return Err(failure(
            "commit",
            "command_failed",
            Some(step.exit_code),
            paths,
        ));
    }
    cli.exec_redacted_with_env(repo, &["commit", "-m", message], &env)
        .await
        .map_err(|_| failure("commit", "command_unavailable", None, paths))
}

pub async fn has_changes(cli: &GitCli, repo: &Path, paths: &[String]) -> Result<bool, GitError> {
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

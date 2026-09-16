use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::cli::{GitCli, GitOutput};
use crate::AppError;

#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PublicationBlockReason {
    TargetChanged,
    Configuration,
    UninitializedChild,
    SourceUnavailable,
    RevisionUnavailable,
}

fn blocked(repo: &Path, child: Option<&str>, reason: PublicationBlockReason) -> AppError {
    AppError::GitPublicationBlocked {
        repository: repo.to_string_lossy().into_owned(),
        child: child.map(str::to_owned),
        reason,
    }
}

async fn checked(cli: &GitCli, repo: &Path, args: &[&str]) -> Result<String, AppError> {
    let out = cli.exec_redacted(repo, args).await?;
    if out.exit_code != 0 {
        return Err(blocked(repo, None, PublicationBlockReason::Configuration));
    }
    Ok(out.stdout.trim_end_matches(['\r', '\n']).into())
}

async fn sensitive(cli: &GitCli, repo: &Path, args: &[&str]) -> Result<GitOutput, AppError> {
    cli.exec_sensitive_with_stdin(repo, args, &[], None, Duration::from_secs(120))
        .await
}

#[derive(Debug, PartialEq, Eq)]
struct Snapshot {
    destination: String,
    updates: BTreeMap<String, String>,
    config: String,
    head: String,
    remote: String,
    remote_refs: String,
}

async fn snapshot(
    cli: &GitCli,
    repo: &Path,
    first: bool,
) -> Result<Result<Snapshot, GitOutput>, AppError> {
    let branch = super::ops::current_branch(cli, repo).await?;
    let mut args = vec![
        "push",
        "--dry-run",
        "--porcelain",
        "--recurse-submodules=no",
    ];
    if first {
        args.extend(["origin", &branch]);
    }
    let out = sensitive(cli, repo, &args).await?;
    if out.exit_code != 0 {
        return Ok(Err(out));
    }
    let head = checked(cli, repo, &["rev-parse", "HEAD"]).await?;
    let mut includes_head = false;
    let mut destination = None;
    let mut updates = BTreeMap::new();
    for line in out.stdout.lines() {
        if let Some(url) = line.strip_prefix("To ") {
            if destination.replace(url.to_owned()).is_some() {
                return Err(blocked(repo, None, PublicationBlockReason::Configuration));
            }
        } else if let Some((flag, rest)) = line.split_once('\t') {
            let mapping = rest.split('\t').next().unwrap_or_default();
            let (source, target) = mapping
                .split_once(':')
                .ok_or_else(|| blocked(repo, None, PublicationBlockReason::Configuration))?;
            if source.is_empty() || !target.starts_with("refs/") || flag == "+" || flag == "-" {
                return Err(blocked(repo, None, PublicationBlockReason::Configuration));
            }
            let oid = checked(cli, repo, &["rev-parse", "--verify", source]).await?;
            includes_head |= oid == head;
            if flag != "=" {
                updates.insert(target.into(), oid);
            }
        }
    }
    if !includes_head {
        return Err(blocked(repo, None, PublicationBlockReason::Configuration));
    }
    let destination =
        destination.ok_or_else(|| blocked(repo, None, PublicationBlockReason::Configuration))?;
    let mut remote = "origin".to_owned();
    if !first {
        for key in [
            format!("branch.{branch}.remote"),
            "remote.pushDefault".into(),
            format!("branch.{branch}.pushRemote"),
        ] {
            let value = cli.exec(repo, &["config", "--get", &key]).await?;
            if value.exit_code == 0 {
                remote = value.stdout.trim_end().into();
            }
        }
    }
    let urls = sensitive(
        cli,
        repo,
        &["remote", "get-url", "--push", "--all", &remote],
    )
    .await?;
    if urls.exit_code != 0 || urls.stdout.lines().collect::<Vec<_>>() != [destination.as_str()] {
        return Err(blocked(repo, None, PublicationBlockReason::Configuration));
    }
    let advertised = sensitive(
        cli,
        repo,
        &[
            "ls-remote",
            "--refs",
            "--heads",
            "--tags",
            "--",
            &destination,
        ],
    )
    .await?;
    if advertised.exit_code != 0 {
        return Ok(Err(advertised));
    }
    let mut refs: Vec<_> = advertised.stdout.lines().collect();
    refs.sort_unstable();
    Ok(Ok(Snapshot {
        destination,
        remote,
        remote_refs: refs.join("\n"),
        updates,
        config: checked(cli, repo, &["config", "--null", "--list", "--show-origin"]).await?,
        head,
    }))
}

struct NativeEvidence {
    git: PathBuf,
    refs: Vec<(PathBuf, String, String)>,
    sources: Vec<(String, String)>,
}

impl Drop for NativeEvidence {
    fn drop(&mut self) {
        for (repo, reference, oid) in &self.refs {
            let mut command = std::process::Command::new(&self.git);
            crate::process::hide_window(&mut command);
            match command
                .current_dir(repo)
                .args(["update-ref", "-d", reference, oid])
                .output()
            {
                Ok(output) if output.status.success() => {}
                _ => tracing::warn!("could not remove temporary Git publication evidence"),
            }
        }
    }
}

/// Every user-history publisher enters here while holding its repository lock.
/// Temporary repositories isolate proof refs, config and index from user state.
pub(crate) async fn push_snapshot(
    cli: &GitCli,
    repo: &Path,
    first: bool,
) -> Result<(GitOutput, Option<String>), AppError> {
    let repository = super::access::resolve_repository(cli, repo).await?;
    let repo = repository.as_path();
    let fixed = match snapshot(cli, repo, first).await? {
        Ok(value) => value,
        Err(out) => return Ok((out, None)),
    };
    let evidence = if !fixed.updates.is_empty() {
        Some(prove(cli, repo, &fixed).await?)
    } else {
        None
    };
    if snapshot(cli, repo, first).await?.ok().as_ref() != Some(&fixed) {
        return Err(blocked(repo, None, PublicationBlockReason::TargetChanged));
    }
    if let Some(evidence) = &evidence {
        for (source, expected) in &evidence.sources {
            let current = sensitive(
                cli,
                repo,
                &["ls-remote", "--refs", "--heads", "--tags", "--", source],
            )
            .await?;
            let mut refs: Vec<_> = current.stdout.lines().collect();
            refs.sort_unstable();
            if current.exit_code != 0 || refs.join("\n") != *expected {
                return Err(blocked(repo, None, PublicationBlockReason::TargetChanged));
            }
        }
    }
    // Explicit immutable revisions prevent a concurrent external commit from
    // publishing history that was not included in the proof.
    let mappings: Vec<_> = fixed
        .updates
        .iter()
        .map(|(target, oid)| format!("{oid}:{target}"))
        .collect();
    if mappings.is_empty() {
        if first {
            set_upstream(cli, repo).await?;
        }
        return Ok((
            GitOutput {
                stdout: String::new(),
                stderr: String::new(),
                exit_code: 0,
            },
            Some(fixed.head),
        ));
    }
    let frozen_url = format!("remote.{}.pushurl={}", fixed.remote, fixed.destination);
    let mut args = vec![
        "-c",
        "push.followTags=false",
        "-c",
        &frozen_url,
        "push",
        "--recurse-submodules=check",
        "--",
        &fixed.remote,
    ];
    args.extend(mappings.iter().map(String::as_str));
    let out = sensitive(cli, repo, &args).await?;
    if out.exit_code == 0 && first {
        set_upstream(cli, repo).await?;
    }
    Ok((out, Some(fixed.head)))
}

pub(crate) async fn push(cli: &GitCli, repo: &Path, first: bool) -> Result<GitOutput, AppError> {
    Ok(push_snapshot(cli, repo, first).await?.0)
}

async fn set_upstream(cli: &GitCli, repo: &Path) -> Result<(), AppError> {
    let branch = super::ops::current_branch(cli, repo).await?;
    checked(
        cli,
        repo,
        &["config", &format!("branch.{branch}.remote"), "origin"],
    )
    .await?;
    checked(
        cli,
        repo,
        &[
            "config",
            &format!("branch.{branch}.merge"),
            &format!("refs/heads/{branch}"),
        ],
    )
    .await?;
    Ok(())
}

async fn prove(cli: &GitCli, repo: &Path, snapshot: &Snapshot) -> Result<NativeEvidence, AppError> {
    let temp = tempfile::Builder::new()
        .prefix("svode-publication-")
        .tempdir()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o700))?;
    }
    let namespace = temp.path().file_name().unwrap().to_string_lossy();
    let mut evidence = NativeEvidence {
        git: cli.git_path().to_path_buf(),
        refs: Vec::new(),
        sources: Vec::new(),
    };
    let proof = temp.path().join("project");
    let out = sensitive(
        cli,
        temp.path(),
        &[
            "clone",
            "--shared",
            "--no-checkout",
            "--",
            &repo.to_string_lossy(),
            &proof.to_string_lossy(),
        ],
    )
    .await?;
    if out.exit_code != 0 {
        return Err(blocked(repo, None, PublicationBlockReason::Configuration));
    }
    checked(cli, &proof, &["remote", "remove", "origin"]).await?;
    // This is the URL a fresh clone uses, never a local submodule override.
    let destination =
        if !snapshot.destination.contains(':') && Path::new(&snapshot.destination).is_relative() {
            repo.join(&snapshot.destination)
                .to_string_lossy()
                .into_owned()
        } else {
            snapshot.destination.clone()
        };
    let out = sensitive(cli, &proof, &["remote", "add", "origin", &destination]).await?;
    if out.exit_code != 0 {
        return Err(blocked(repo, None, PublicationBlockReason::Configuration));
    }
    let out = sensitive(
        cli,
        &proof,
        &[
            "fetch",
            "--no-tags",
            "--no-recurse-submodules",
            "origin",
            "+refs/heads/*:refs/remotes/origin/*",
        ],
    )
    .await?;
    if out.exit_code != 0 {
        return Err(blocked(
            repo,
            None,
            PublicationBlockReason::SourceUnavailable,
        ));
    }
    let tips: Vec<_> = snapshot.updates.values().map(String::as_str).collect();
    let mut args = vec!["rev-list"];
    args.extend(tips);
    args.extend(["--not", "--remotes=origin"]);
    let commits = checked(cli, &proof, &args).await?;
    let mut sources = BTreeMap::new();
    let mut proven = BTreeSet::new();
    for commit in commits.lines() {
        let (modules_changed, changed_links) = changed_gitlinks(cli, &proof, commit).await?;
        if !modules_changed && changed_links.is_empty() {
            continue;
        }
        let tree = checked(cli, &proof, &["ls-tree", "-r", "-z", commit]).await?;
        let links: Vec<_> = tree
            .split('\0')
            .filter_map(|record| {
                let (meta, path) = record.split_once('\t')?;
                let oid = meta.strip_prefix("160000 commit ")?;
                (modules_changed || changed_links.contains(path)).then_some((path, oid))
            })
            .collect();
        if links.is_empty() {
            continue;
        }
        checked(cli, &proof, &["read-tree", commit]).await?;
        checked(
            cli,
            &proof,
            &["checkout-index", "--force", "--", ".gitmodules"],
        )
        .await?;
        let modules = checked(
            cli,
            &proof,
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
        for (path, oid) in links {
            let relative = crate::repo_path::normalize_repo_relative(
                path,
                crate::repo_path::RootMode::Reject,
            )?;
            let child = repo.join(&relative);
            let actual = cli
                .exec(&child, &["rev-parse", "--show-toplevel"])
                .await
                .map_err(|_| {
                    blocked(repo, Some(path), PublicationBlockReason::UninitializedChild)
                })?;
            if actual.exit_code != 0
                || std::fs::canonicalize(actual.stdout.trim()).ok()
                    != std::fs::canonicalize(&child).ok()
            {
                return Err(blocked(
                    repo,
                    Some(path),
                    PublicationBlockReason::UninitializedChild,
                ));
            }
            let names: Vec<_> = modules
                .split('\0')
                .filter_map(|entry| {
                    let (key, value) = entry.split_once('\n')?;
                    (value == path).then(|| key.strip_suffix(".path")).flatten()
                })
                .collect();
            if names.len() != 1 {
                return Err(blocked(
                    repo,
                    Some(path),
                    PublicationBlockReason::Configuration,
                ));
            }
            let key = format!("{}.url", names[0]);
            // Clear any prior historical registration, then let Git resolve
            // relative URLs against this project's publication destination.
            cli.exec(&proof, &["config", "--unset-all", &key]).await?;
            checked(cli, &proof, &["submodule", "init", "--", path]).await?;
            let source = checked(cli, &proof, &["config", "--get", &key]).await?;
            if !proven.insert((source.clone(), oid.to_owned(), child.clone())) {
                continue;
            }
            if !sources.contains_key(&source) {
                let source_repo = temp.path().join(format!("source-{}", sources.len()));
                // Borrow existing objects for negotiation, without trusting the
                // copied refs as publication evidence. Pruning the explicit
                // refspecs below replaces them with this source's current refs.
                let cloned = sensitive(
                    cli,
                    temp.path(),
                    &[
                        "clone",
                        "--shared",
                        "--bare",
                        "--",
                        &child.to_string_lossy(),
                        &source_repo.to_string_lossy(),
                    ],
                )
                .await?;
                if cloned.exit_code != 0 {
                    return Err(blocked(repo, Some(path), PublicationBlockReason::RevisionUnavailable));
                }
                let out = sensitive(
                    cli,
                    &source_repo,
                    &[
                        "fetch",
                        "--prune",
                        "--no-tags",
                        "--no-recurse-submodules",
                        "--",
                        &source,
                        "+refs/heads/*:refs/heads/*",
                        "+refs/tags/*:refs/tags/*",
                    ],
                )
                .await?;
                if out.exit_code != 0 {
                    return Err(blocked(
                        repo,
                        Some(path),
                        PublicationBlockReason::SourceUnavailable,
                    ));
                }
                let refs = checked(
                    cli,
                    &source_repo,
                    &[
                        "for-each-ref",
                        "--format=%(objectname)%09%(refname)",
                        "refs/heads",
                        "refs/tags",
                    ],
                )
                .await?;
                let mut refs: Vec<_> = refs.lines().collect();
                refs.sort_unstable();
                evidence.sources.push((source.clone(), refs.join("\n")));
                sources.insert(source.clone(), source_repo);
            }
            let source_repo = &sources[&source];
            let reachable = cli
                .exec(
                    source_repo,
                    &[
                        "for-each-ref",
                        &format!("--contains={oid}"),
                        "--format=%(objectname)",
                        "refs/heads",
                        "refs/tags",
                    ],
                )
                .await?;
            if reachable.exit_code != 0 || reachable.stdout.trim().is_empty() {
                return Err(blocked(
                    repo,
                    Some(path),
                    PublicationBlockReason::RevisionUnavailable,
                ));
            }
            let object = cli
                .exec(&child, &["cat-file", "-e", &format!("{oid}^{{commit}}")])
                .await?;
            if object.exit_code != 0 {
                return Err(blocked(
                    repo,
                    Some(path),
                    PublicationBlockReason::RevisionUnavailable,
                ));
            }
            // Native --check reads local remote refs. These unique, disposable
            // refs convey the fresh source proof without replacing origin/*.
            let reference = format!("refs/remotes/{namespace}/{oid}");
            evidence
                .refs
                .push((child.clone(), reference.clone(), oid.into()));
            checked(cli, &child, &["update-ref", &reference, oid, ""]).await?;
        }
    }
    Ok(evidence)
}

/// Inspect every parent of a merge, and the empty tree for an initial commit.
/// A source edit revalidates the links in that historical .gitmodules context.
async fn changed_gitlinks(
    cli: &GitCli,
    repo: &Path,
    commit: &str,
) -> Result<(bool, BTreeSet<String>), AppError> {
    let diff = checked(
        cli,
        repo,
        &[
            "diff-tree",
            "--root",
            "-m",
            "-r",
            "--raw",
            "-z",
            "--no-commit-id",
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
            "--ignore-submodules=none",
            commit,
        ],
    )
    .await?;
    let mut records = diff.split_terminator('\0');
    let mut modules_changed = false;
    let mut links = BTreeSet::new();
    while let Some(meta) = records.next() {
        let path = records
            .next()
            .ok_or_else(|| blocked(repo, None, PublicationBlockReason::Configuration))?;
        modules_changed |= path == ".gitmodules";
        if meta.split_whitespace().nth(1) == Some("160000") {
            links.insert(path.to_owned());
        }
    }
    Ok((modules_changed, links))
}

#[cfg(test)]
#[path = "publication_tests.rs"]
mod tests;

/// Read fresh remote history without pushing, probing capability or changing user refs.
pub(crate) async fn head_is_published(
    cli: &GitCli,
    repo: &Path,
    expected: &str,
) -> Result<bool, AppError> {
    let branch = super::ops::current_branch(cli, repo).await?;
    if branch == "HEAD" {
        return Ok(false);
    }
    let configured = cli
        .exec(
            repo,
            &["config", "--get", &format!("branch.{branch}.remote")],
        )
        .await?;
    let remote = if configured.exit_code == 0 {
        configured.stdout.trim()
    } else {
        "origin"
    };
    if remote == "." {
        return Ok(false);
    }
    let merge = cli
        .exec(
            repo,
            &["config", "--get", &format!("branch.{branch}.merge")],
        )
        .await?;
    let reference = if merge.exit_code == 0 {
        merge.stdout.trim().to_owned()
    } else {
        format!("refs/heads/{branch}")
    };
    let urls = sensitive(cli, repo, &["remote", "get-url", "--all", remote]).await?;
    if urls.exit_code != 0 || urls.stdout.lines().count() != 1 {
        return Ok(false);
    }
    let url = urls.stdout.trim();
    let url = if !url.contains(':') && Path::new(url).is_relative() {
        repo.join(url).to_string_lossy().into_owned()
    } else {
        url.to_owned()
    };
    let temp = tempfile::tempdir()?;
    let proof = temp.path().join("proof");
    let clone = sensitive(
        cli,
        repo,
        &[
            "clone",
            "--shared",
            "--no-checkout",
            "--",
            &repo.to_string_lossy(),
            &proof.to_string_lossy(),
        ],
    )
    .await?;
    if clone.exit_code != 0 {
        return Err(blocked(
            repo,
            None,
            PublicationBlockReason::SourceUnavailable,
        ));
    }
    let fetched = sensitive(
        cli,
        &proof,
        &[
            "fetch",
            "--no-tags",
            "--no-recurse-submodules",
            "--",
            &url,
            &reference,
        ],
    )
    .await?;
    if fetched.exit_code != 0 {
        return Err(blocked(
            repo,
            None,
            PublicationBlockReason::SourceUnavailable,
        ));
    }
    let out = cli
        .exec(
            &proof,
            &["merge-base", "--is-ancestor", expected, "FETCH_HEAD"],
        )
        .await?;
    if out.exit_code > 1 {
        return Err(blocked(
            repo,
            None,
            PublicationBlockReason::RevisionUnavailable,
        ));
    }
    Ok(out.exit_code == 0 && super::ops::repository_head_oid(cli, repo).await? == expected)
}

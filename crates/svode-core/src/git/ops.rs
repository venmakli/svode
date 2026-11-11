use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::Path;

use serde::Serialize;
use std::collections::BTreeMap;

use super::GitError;
use super::cli::GitCli;
use super::diagnostics::{GitStage, HookTrace};
#[cfg(test)]
use super::status::FileGitStatus;
use crate::git::path::{RootMode, normalize_repo_relative};
use crate::storage::config::SpaceGitType;
// Status reads have one owner; the operations surface re-exports it so callers
// keep their existing `ops::…` path without a second implementation.
pub use super::status::{
    GitStatus, current_branch, full_status, get_remote, normalize_git_path, ref_exists, status,
    status_with_remote_counts,
};
#[cfg(test)]
pub use super::status::{parse_status_porcelain_v2_z, strip_status_path_prefix};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubmoduleConfig {
    pub path: String,
    pub url: Option<String>,
}

/// Only a refusal of authorization: a file system "permission denied" of the
/// repository is a local failure, not a missing credential.
pub fn is_git_auth_error(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    lower.contains("authentication")
        || lower.contains("could not read username")
        || lower.contains("terminal prompts disabled")
        || super::diagnostics::is_authorization_denial(stderr)
        || lower.contains("missing credentials")
        || lower.contains("missing or invalid credentials")
}

pub fn is_git_no_remote_error(stderr: &str) -> bool {
    stderr.contains("No configured push destination")
}

/// The error of a remote step of a sync or publish in `repo` that failed
/// with `stderr`: a missing credential or remote keeps its own outcome,
/// anything else names the repository, the stage and the recognized cause.
pub fn git_remote_command_error(repo: &Path, stage: GitStage, stderr: &str) -> GitError {
    if is_git_auth_error(stderr) {
        return GitError::AuthRequired(stderr.to_string());
    }
    if is_git_no_remote_error(stderr) {
        return GitError::NoRemote;
    }
    sync_failure(repo, stage, stderr, false)
}

/// A failed sync step of `repo`. Stderr goes only to the log, redacted.
pub fn sync_failure(repo: &Path, stage: GitStage, stderr: &str, hook_failed: bool) -> GitError {
    tracing::warn!(
        "git {stage} failed: {}",
        super::auth::redact_url_credentials(stderr.trim())
    );
    GitError::SyncFailed(super::diagnostics::GitFailure::from_output(
        repo,
        stage,
        stderr,
        hook_failed,
    ))
}

/// List submodules declared in `.gitmodules`.
pub async fn list_submodules(
    cli: &GitCli,
    project_path: &Path,
) -> Result<Vec<SubmoduleConfig>, GitError> {
    if !project_path.join(".gitmodules").exists() {
        return Ok(Vec::new());
    }

    let out = cli
        .exec(
            project_path,
            &[
                "config",
                "-z",
                "-f",
                ".gitmodules",
                "--get-regexp",
                "^submodule\\..*\\.",
            ],
        )
        .await?;

    if out.exit_code == 1 {
        return Ok(Vec::new());
    }
    if out.exit_code != 0 {
        return Err(GitError::GitCommandFailed("Cannot read .gitmodules".into()));
    }

    Ok(parse_submodule_config_output(&out.stdout))
}

fn parse_submodule_config_output(stdout: &str) -> Vec<SubmoduleConfig> {
    #[derive(Default)]
    struct PartialSubmodule {
        path: Option<String>,
        url: Option<String>,
    }

    let mut by_name: BTreeMap<String, PartialSubmodule> = BTreeMap::new();

    for line in stdout.split('\0') {
        let Some((key, value)) = line.split_once('\n') else {
            continue;
        };
        let Some(rest) = key.strip_prefix("submodule.") else {
            continue;
        };

        let value = value.to_string();
        if let Some(name) = rest.strip_suffix(".path") {
            by_name.entry(name.to_string()).or_default().path = Some(value);
        } else if let Some(name) = rest.strip_suffix(".url") {
            by_name.entry(name.to_string()).or_default().url = Some(value);
        }
    }

    by_name
        .into_values()
        .filter_map(|partial| {
            partial.path.map(|path| SubmoduleConfig {
                path,
                url: partial.url,
            })
        })
        .collect()
}

/// Set or add the `origin` remote URL.
pub async fn set_remote(cli: &GitCli, space_dir: &Path, url: &str) -> Result<(), GitError> {
    // Check if origin exists
    let exists = cli
        .exec(space_dir, &["remote", "get-url", "origin"])
        .await?;
    let args: Vec<&str> = if exists.exit_code == 0 {
        vec!["remote", "set-url", "origin", url]
    } else {
        vec!["remote", "add", "origin", url]
    };
    let out = cli.exec(space_dir, &args).await?;
    if out.exit_code != 0 {
        return Err(GitError::GitCommandFailed(format!(
            "git remote failed: {}",
            out.stderr
        )));
    }
    Ok(())
}

/// Push current branch silently. Used by explicit publish and policy-gated focus push.
pub async fn push(cli: &GitCli, space_dir: &Path) -> Result<(), GitError> {
    let out = super::publication::push(cli, space_dir, false).await?;
    if out.exit_code != 0 {
        let stderr = out.stderr.trim();
        return Err(git_remote_command_error(space_dir, GitStage::Push, stderr));
    }
    Ok(())
}

/// Initialize a new git repo and optionally create the first scaffold commit.
///
/// Submodule creation uses the `false` path when structural autocommit is
/// disabled: Git cannot create a gitlink without a child commit, so Svode keeps
/// the child repo unborn and records submodule metadata in the parent instead
/// of silently committing the scaffold.
pub async fn init_with_optional_scaffold_commit(
    cli: &GitCli,
    space_dir: &Path,
    commit_scaffold: bool,
) -> Result<(), GitError> {
    let created = space_dir.join(".git").symlink_metadata().is_err();
    let out = init_repository(cli, space_dir).await?;
    if out.exit_code != 0 {
        return Err(GitError::GitCommandFailed(format!(
            "git init failed: {}",
            out.stderr
        )));
    }

    // config core.quotePath false (for unicode filenames)
    cli.exec(space_dir, &["config", "core.quotePath", "false"])
        .await?;

    // Only a repository Svode creates gets the rules, once: an existing one
    // keeps its `.gitignore`.
    if created {
        add_system_file_rules(space_dir)?;
    }
    ensure_svode_gitignore(space_dir)?;

    if commit_scaffold {
        add_all(cli, space_dir).await?;

        let _ = commit(cli, space_dir, "Scaffold .svode").await?;
    }

    tracing::info!("Initialized git repo at {}", space_dir.display());
    Ok(())
}

/// `git init` of a repository Svode creates: SHA-1 objects while forges do not
/// support SHA-256 everywhere, and the user's `init.defaultBranch` or `main`.
/// Reinitializing an existing repository keeps its format and branch.
async fn init_repository(
    cli: &GitCli,
    space_dir: &Path,
) -> Result<super::cli::GitOutput, GitError> {
    let git_dir = space_dir.join(".git");
    if git_dir.symlink_metadata().is_ok() {
        return cli.exec(space_dir, &["init"]).await;
    }
    // `git init` reads only system and global config, never the config of a
    // repository around a Space folder; an explicit GIT_DIR reads the same.
    let configured = cli
        .exec_with_env(
            space_dir,
            &["config", "--get", "init.defaultBranch"],
            &[("GIT_DIR", &git_dir.to_string_lossy())],
        )
        .await?;
    let branch = match configured.stdout.trim() {
        branch if configured.exit_code == 0 && !branch.is_empty() => branch,
        _ => "main",
    };
    cli.exec(
        space_dir,
        &[
            "init",
            "--object-format=sha1",
            &format!("--initial-branch={branch}"),
        ],
    )
    .await
}

fn is_local_variable_path(path: &str) -> bool {
    super::policy::contains(&path.replace('\\', "/"))
}

fn reject_local_variable_path(path: &str) -> Result<(), GitError> {
    if is_local_variable_path(path) {
        return Err(GitError::GitCommandFailed(
            "Local Variables and agent files cannot be committed".into(),
        ));
    }
    Ok(())
}

async fn reject_staged_local_variables(cli: &GitCli, repo: &Path) -> Result<(), GitError> {
    let staged = cli
        .exec_redacted(repo, &["diff", "--cached", "--name-only", "-z"])
        .await?;
    if staged.exit_code != 0 {
        return Err(GitError::GitCommandFailed(
            "Cannot verify local file exclusions".into(),
        ));
    }
    if staged.stdout.split('\0').any(is_local_variable_path) {
        return Err(GitError::GitCommandFailed(
            "Unstage local Variables or agent files before committing".into(),
        ));
    }
    Ok(())
}

/// Stage the allowed concrete entries in a file or directory selection.
pub async fn add(cli: &GitCli, space_dir: &Path, path: &str) -> Result<(), GitError> {
    super::branch::prepare_existing(cli, space_dir).await?;
    let paths = super::staging::resolve(cli, space_dir, &[path.to_string()]).await?;
    super::staging::prepare(cli, space_dir, &paths)
        .await
        .map(|_| ())
}

/// Stage all allowed changes without changing already staged local entries.
pub async fn add_all(cli: &GitCli, space_dir: &Path) -> Result<(), GitError> {
    add(cli, space_dir, ".").await
}

/// Commit the index. A no-op is established before invoking hooks.
pub async fn commit(cli: &GitCli, space_dir: &Path, message: &str) -> Result<bool, GitError> {
    super::branch::prepare_existing(cli, space_dir).await?;
    reject_staged_local_variables(cli, space_dir).await?;
    if !super::staging::has_changes(cli, space_dir, &[]).await? {
        return Ok(false);
    }
    let trace = HookTrace::new();
    let out = cli
        .exec_redacted_with_env(space_dir, &["commit", "-m", message], &trace.env(&[]))
        .await
        .map_err(|_| {
            super::staging::failure(
                space_dir,
                GitStage::Commit,
                "command_unavailable",
                None,
                &[],
            )
        })?;
    if out.exit_code != 0 {
        return Err(super::staging::command_failure(
            space_dir,
            GitStage::Commit,
            &out,
            Some(&trace),
            &[],
        ));
    }
    Ok(true)
}

/// Commit one working-tree path without consuming any other staged entries.
///
/// `git commit --only` reads the selected path from the working tree and keeps
/// unrelated index entries staged. A new path must first be made known to Git;
/// intent-to-add is used so no file content is staged in the shared index.
pub async fn commit_exact_path(
    cli: &GitCli,
    repo: &Path,
    path: &str,
    message: &str,
) -> Result<bool, GitError> {
    Ok(commit_exact_path_receipt(cli, repo, path, message)
        .await?
        .is_some())
}

pub struct ExactPathCommitReceipt {
    pub oid: Option<String>,
}

pub async fn commit_exact_path_receipt(
    cli: &GitCli,
    repo: &Path,
    path: &str,
    message: &str,
) -> Result<Option<ExactPathCommitReceipt>, GitError> {
    super::branch::prepare_existing(cli, repo).await?;
    let path = normalize_git_path(path)?;
    reject_local_variable_path(&path)?;
    let literal = format!(":(literal){path}");
    let paths = std::slice::from_ref(&path);
    if !super::published_pointer::backward(cli, repo, paths)
        .await?
        .is_empty()
    {
        return Ok(None);
    }
    let known = cli
        .exec_redacted(repo, &["ls-files", "--error-unmatch", "--", &literal])
        .await?;
    let prepared_intent_to_add = known.exit_code != 0;

    if !prepared_intent_to_add {
        let head = super::staging::exec(
            cli,
            repo,
            &["rev-parse", "--verify", "HEAD"],
            GitStage::Verify,
            paths,
        )
        .await?;
        if head.exit_code == 0 {
            let diff = super::staging::exec(
                cli,
                repo,
                &[
                    "diff",
                    "--quiet",
                    "--no-ext-diff",
                    "--ignore-submodules=dirty",
                    "HEAD",
                    "--",
                    &literal,
                ],
                GitStage::Verify,
                paths,
            )
            .await?;
            match diff.exit_code {
                0 => return Ok(None),
                1 => {}
                code => {
                    return Err(super::staging::failure(
                        repo,
                        GitStage::Verify,
                        "verification_failed",
                        Some(code),
                        paths,
                    ));
                }
            }
        }
    }
    if prepared_intent_to_add {
        let prepared = cli
            .exec_redacted(repo, &["add", "--intent-to-add", "--", &literal])
            .await?;
        if prepared.exit_code != 0 {
            return Err(super::staging::command_failure(
                repo,
                GitStage::Prepare,
                &prepared,
                None,
                paths,
            ));
        }
    }

    let trace = HookTrace::new();
    let out = cli
        .exec_redacted_with_env(
            repo,
            &[
                "-c",
                "core.abbrev=40",
                "commit",
                "--no-quiet",
                "--only",
                "-m",
                message,
                "--",
                &format!(":(literal){path}"),
            ],
            &trace.env(&[]),
        )
        .await?;
    if out.exit_code == 0 {
        // Read the OID printed by this commit, not a later (possibly foreign) HEAD.
        let oid = out.stdout.lines().rev().find_map(|line| {
            let header = line.strip_prefix('[')?.split_once(']')?.0;
            let oid = header.split_whitespace().last()?;
            (oid.len() >= 40 && oid.bytes().all(|b| b.is_ascii_hexdigit())).then(|| oid.to_string())
        });
        let oid = if let Some(oid) = oid {
            cli.exec_redacted(
                repo,
                &["rev-parse", "--verify", &format!("{oid}^{{commit}}")],
            )
            .await
            .ok()
            .filter(|out| out.exit_code == 0)
            .map(|out| out.stdout.trim().to_string())
        } else {
            None
        };
        return Ok(Some(ExactPathCommitReceipt { oid }));
    }

    if prepared_intent_to_add {
        let cleanup = cli.exec_redacted(repo, &["reset", "--", &literal]).await?;
        if cleanup.exit_code != 0 {
            return Err(super::staging::failure(
                repo,
                GitStage::Commit,
                "target_cleanup_failed",
                Some(cleanup.exit_code),
                paths,
            ));
        }
    }

    Err(super::staging::command_failure(
        repo,
        GitStage::Commit,
        &out,
        Some(&trace),
        paths,
    ))
}

/// Whether the repository index contains any changes relative to `HEAD`.
pub async fn has_staged_changes(cli: &GitCli, repo: &Path) -> Result<bool, GitError> {
    let out = cli.exec(repo, &["diff", "--cached", "--quiet"]).await?;
    match out.exit_code {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(GitError::GitCommandFailed(format!(
            "git diff --cached failed: {}",
            out.stderr
        ))),
    }
}

/// Whether one path differs from `HEAD` or the index, including untracked state.
pub async fn exact_path_has_changes(
    cli: &GitCli,
    repo: &Path,
    path: &str,
) -> Result<bool, GitError> {
    let path = normalize_git_path(path)?;
    let out = cli
        .exec(
            repo,
            &[
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
                "--",
                &path,
            ],
        )
        .await?;
    if out.exit_code != 0 {
        return Err(GitError::GitCommandFailed(format!(
            "git status for exact path failed: {}",
            out.stderr
        )));
    }
    Ok(!out.stdout.is_empty())
}

/// Opaque fingerprint of one repository-relative target across HEAD, index,
/// worktree status, and (for nested repositories) the target repository HEAD.
/// This is used to stale-check explicit exact-path reviews without making
/// unrelated staged paths part of the review contract.
pub async fn exact_path_state_fingerprint(
    cli: &GitCli,
    repo: &Path,
    path: &str,
) -> Result<String, GitError> {
    let path = normalize_git_path(path)?;
    let status = cli
        .exec(
            repo,
            &[
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
                "--",
                &path,
            ],
        )
        .await?;
    if status.exit_code != 0 {
        return Err(GitError::GitCommandFailed(format!(
            "git status for exact-path fingerprint failed: {}",
            status.stderr
        )));
    }

    let index = cli
        .exec(repo, &["ls-files", "--stage", "--", &path])
        .await?;
    if index.exit_code != 0 {
        return Err(GitError::GitCommandFailed(format!(
            "git ls-files for exact-path fingerprint failed: {}",
            index.stderr
        )));
    }

    // `ls-tree HEAD` is expected to fail for an unborn root repository. Its
    // exit code is still part of the fingerprint and does not make the review
    // unavailable.
    let head = cli.exec(repo, &["ls-tree", "HEAD", "--", &path]).await?;
    let nested_head = if repo.join(&path).join(".git").symlink_metadata().is_ok() {
        cli.exec(&repo.join(&path), &["rev-parse", "--verify", "HEAD"])
            .await?
    } else {
        super::cli::GitOutput {
            stdout: String::new(),
            stderr: String::new(),
            exit_code: 1,
        }
    };

    let mut hasher = DefaultHasher::new();
    for (exit_code, stdout) in [
        (status.exit_code, status.stdout.as_str()),
        (index.exit_code, index.stdout.as_str()),
        (head.exit_code, head.stdout.as_str()),
        (nested_head.exit_code, nested_head.stdout.as_str()),
    ] {
        exit_code.hash(&mut hasher);
        stdout.hash(&mut hasher);
    }
    Ok(format!("{:016x}", hasher.finish()))
}

/// Whether an exact root target is the expected metadata-only form of a local
/// submodule: registered by a clean tracked `.gitmodules`, not yet represented
/// in the root index, and with an unborn child repository. This state is safe
/// before the first child commit even though root `git status` reports the
/// directory as untracked.
pub async fn is_registered_unborn_submodule_target(
    cli: &GitCli,
    root: &Path,
    path: &str,
) -> Result<bool, GitError> {
    let path = normalize_git_path(path)?;
    if path.contains('/')
        || !list_submodules(cli, root)
            .await?
            .iter()
            .any(|submodule| submodule.path == path)
        || exact_path_has_changes(cli, root, ".gitmodules").await?
    {
        return Ok(false);
    }

    let known = cli
        .exec(root, &["ls-files", "--error-unmatch", "--", &path])
        .await?;
    if known.exit_code == 0 || root.join(&path).join(".git").symlink_metadata().is_err() {
        return Ok(false);
    }

    let child = root.join(&path);
    let repository = cli.exec(&child, &["rev-parse", "--show-toplevel"]).await?;
    if repository.exit_code != 0 {
        return Ok(false);
    }
    let head = cli.exec(&child, &["rev-parse", "--verify", "HEAD"]).await?;
    Ok(head.exit_code != 0)
}

/// Read the repository HEAD expected to become a root gitlink target.
pub async fn repository_head_oid(cli: &GitCli, repository: &Path) -> Result<String, GitError> {
    let head = cli
        .exec(repository, &["rev-parse", "--verify", "HEAD"])
        .await?;
    if head.exit_code != 0 {
        return Err(GitError::GitCommandFailed(format!(
            "git rev-parse HEAD failed: {}",
            head.stderr
        )));
    }
    Ok(head.stdout.trim().to_string())
}

/// Validate that a configured direct-child submodule still resolves to the
/// expected child repository and commit. The root worktree gitlink is derived
/// from this child HEAD, so this protects the final exact-path commit from path
/// replacement, routing drift, and a stale child target.
pub async fn submodule_target_matches_expected_head(
    cli: &GitCli,
    root: &Path,
    path: &str,
    repository: &Path,
    expected_head: &str,
) -> Result<bool, GitError> {
    let path = normalize_git_path(path)?;
    if path.contains('/')
        || !list_submodules(cli, root)
            .await?
            .iter()
            .any(|submodule| submodule.path == path)
    {
        return Ok(false);
    }

    let target = match std::fs::canonicalize(root.join(&path)) {
        Ok(target) => target,
        Err(_) => return Ok(false),
    };
    let repository = match std::fs::canonicalize(repository) {
        Ok(repository) => repository,
        Err(_) => return Ok(false),
    };
    if target != repository {
        return Ok(false);
    }

    let target_head = cli
        .exec(&target, &["rev-parse", "--verify", "HEAD"])
        .await?;
    Ok(target_head.exit_code == 0
        && !expected_head.is_empty()
        && target_head.stdout.trim() == expected_head)
}

/// Commit `paths` (a scope Git expands) as one version with an English
/// message of its facts.
pub async fn commit_paths(
    cli: &GitCli,
    space_dir: &Path,
    file_paths: &[String],
) -> Result<bool, GitError> {
    super::versions::commit_single(
        cli,
        space_dir,
        file_paths,
        super::versions::MessageLanguage::En,
    )
    .await
}

fn parse_nul_paths(stdout: &str) -> Result<Vec<String>, GitError> {
    stdout
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(normalize_git_path)
        .collect()
}

/// Get list of files changed since last pull.
pub async fn diff_after_pull(cli: &GitCli, space_dir: &Path) -> Result<Vec<String>, GitError> {
    let out = cli
        .exec(
            space_dir,
            &["diff", "--name-only", "-z", "HEAD@{1}", "HEAD"],
        )
        .await?;

    if out.exit_code != 0 {
        // HEAD@{1} may not exist if no reflog yet
        return Ok(Vec::new());
    }

    parse_nul_paths(&out.stdout)
}

// --- Per-space git type ---

/// Detect the git type of a space relative to its project.
///
/// Assumes a space is a direct child of the project (no nested spaces) —
/// `.gitmodules` submodule paths and staged relative paths elsewhere rely on
/// that topology too.
pub async fn detect_space_git_type(
    cli: &GitCli,
    project_path: &Path,
    space_path: &Path,
) -> Result<SpaceGitType, GitError> {
    // Inline = no own git entry at the space root. We deliberately do NOT
    // use `git rev-parse --git-dir` here: for a subfolder of a parent repo,
    // it walks up and succeeds with the parent's `.git`, which would
    // misclassify inline as independent. `symlink_metadata` returns Ok for
    // both `.git` directories (regular repos) and `.git` files (submodule
    // worktrees), and Err when no `.git` entry exists at all.
    if space_path.join(".git").symlink_metadata().is_err() {
        return Ok(SpaceGitType::Inline);
    }

    // Has own `.git` — either independent or submodule. Submodule is
    // identified by the parent repo listing this folder in `.gitmodules`.
    let gitmodules = project_path.join(".gitmodules");
    if !gitmodules.exists() {
        return Ok(SpaceGitType::Independent);
    }

    // The project root owns its own repository; `.gitmodules` lists children only.
    let relative =
        crate::git::path::repo_relative_from_base(project_path, space_path, RootMode::Allow)?;
    if relative == "." {
        return Ok(SpaceGitType::Independent);
    }
    if list_submodules(cli, project_path)
        .await?
        .iter()
        .any(|module| module.path == relative)
    {
        return Ok(SpaceGitType::Submodule);
    }

    Ok(SpaceGitType::Independent)
}

/// The Project repository of a submodule Space records a path change of
/// its sources through the gitlink the structural commit updates, so a plan
/// that renames or moves them authorizes it too. Without Git CLI no Space
/// counts as a submodule.
pub async fn submodule_parent(
    project: Option<&str>,
    space: &str,
) -> Result<Option<std::path::PathBuf>, GitError> {
    let (Some(project), Some(cli)) = (project, crate::git::state::detected_cli()) else {
        return Ok(None);
    };
    let kind = detect_space_git_type(&cli, Path::new(project), Path::new(space)).await?;
    Ok((kind == SpaceGitType::Submodule).then(|| std::path::PathBuf::from(project)))
}

/// Detect git type and resolve which repo should be the commit target.
/// Inline → project repo, Independent/Submodule → the space's own repo.
pub async fn resolve_target_repo(
    cli: &GitCli,
    project_path: &Path,
    space_path: &Path,
) -> Result<(SpaceGitType, std::path::PathBuf), GitError> {
    let git_type = detect_space_git_type(cli, project_path, space_path).await?;
    let target = match git_type {
        SpaceGitType::Inline => project_path.to_path_buf(),
        SpaceGitType::Independent | SpaceGitType::Submodule => space_path.to_path_buf(),
    };
    Ok((git_type, target))
}

/// Get the configured URL for a submodule from .gitmodules.
pub async fn get_submodule_url(
    cli: &GitCli,
    root_path: &Path,
    space_folder: &str,
) -> Result<Option<String>, GitError> {
    Ok(list_submodules(cli, root_path)
        .await?
        .into_iter()
        .find(|module| module.path == space_folder)
        .and_then(|module| module.url))
}

/// Record a direct child as a submodule without running `git submodule add`.
///
/// This is used only when structural autocommit is disabled for a newly-created
/// local submodule space. The child repo has no commit yet, so native
/// `submodule add` would fail. The portable tracked source of truth is still
/// `.gitmodules`; the gitlink appears later after an explicit user commit.
pub async fn register_local_submodule_metadata(
    cli: &GitCli,
    root_path: &Path,
    space_folder: &str,
) -> Result<(), GitError> {
    let normalized = normalize_repo_relative(space_folder, RootMode::Reject)?;
    if normalized.contains('/') {
        return Err(GitError::PathNotAccessible(space_folder.to_string()));
    }

    let path_key = format!("submodule.{}.path", normalized);
    let url_key = format!("submodule.{}.url", normalized);
    let url = format!("./{}", normalized);

    for (key, value) in [
        (path_key.as_str(), normalized.as_str()),
        (url_key.as_str(), url.as_str()),
    ] {
        let out = cli
            .exec(root_path, &["config", "-f", ".gitmodules", key, value])
            .await?;
        if out.exit_code != 0 {
            return Err(GitError::GitCommandFailed(format!(
                "git config .gitmodules failed: {}",
                out.stderr
            )));
        }
    }

    let local_url = root_path.join(&normalized).to_string_lossy().to_string();
    for (key, value) in [
        (format!("submodule.{}.url", normalized), local_url),
        (
            format!("submodule.{}.active", normalized),
            "true".to_string(),
        ),
    ] {
        let out = cli.exec(root_path, &["config", &key, &value]).await?;
        if out.exit_code != 0 {
            return Err(GitError::GitCommandFailed(format!(
                "git config submodule failed: {}",
                out.stderr
            )));
        }
    }

    Ok(())
}

/// Copy the local identity of `root` into the repository `repo`: a new,
/// cloned or materialized Space repository commits as the Project does. A
/// root without a complete local identity leaves `repo` to the global one.
pub async fn copy_local_identity(cli: &GitCli, root: &Path, repo: &Path) -> Result<(), GitError> {
    let mut identity = Vec::new();
    for key in ["user.name", "user.email"] {
        let out = cli.exec(root, &["config", "--local", "--get", key]).await?;
        let value = out.stdout.trim();
        if out.exit_code != 0 || value.is_empty() {
            return Ok(());
        }
        identity.push((key, value.to_string()));
    }
    for (key, value) in identity {
        let out = cli.exec(repo, &["config", "--local", key, &value]).await?;
        if out.exit_code != 0 {
            return Err(GitError::GitCommandFailed(format!(
                "git config --local {key} failed: {}",
                out.stderr.trim()
            )));
        }
    }
    Ok(())
}

/// Validate a clone URL (HTTPS or SSH).
pub fn validate_clone_url(url: &str) -> Result<(), GitError> {
    let trimmed = url.trim();
    let valid = trimmed.starts_with("https://")
        || trimmed.starts_with("http://")
        || (trimmed.contains('@')
            && trimmed.contains(':')
            && !trimmed.starts_with("ssh://")
            && !trimmed.starts_with("git://")
            && !trimmed.starts_with("file://"));
    if !valid {
        return Err(GitError::InvalidUrl(trimmed.to_string()));
    }
    Ok(())
}

// --- .gitignore managed blocks ---

/// Ensure root-level Svode local runtime files are ignored in this repo.
///
/// This is used both for newly initialized spaces and for existing git repos
/// that Svode scaffolds later. The latter path must update `.gitignore` before
/// staging `.svode/`, otherwise `.svode/local.json` can be committed.
///
/// The rules live in one `# svode:local` block. Records earlier versions
/// wrote (`# Svode local files` runs, the S3 agent block, extra blocks) are
/// merged into it at the position of the last one; a record above a negation
/// stays in place, since moving it below would change what Git ignores.
pub fn ensure_svode_gitignore(space_dir: &Path) -> Result<bool, GitError> {
    let gitignore = space_dir.join(".gitignore");
    let content = read_gitignore(&gitignore)?;
    let (lines, eol) = gitignore_lines(&content);
    let records = local_records(&lines);
    let updated = match records.last() {
        None => append_block(&content, &managed_block("", [], LOCAL_BLOCK, eol), eol),
        Some(last) => {
            let merged = records
                .iter()
                .filter(|record| {
                    !lines[record.start..last.start]
                        .iter()
                        .any(|line| line_text(line).trim_start().starts_with('!'))
                })
                .collect::<Vec<_>>();
            let user = merged
                .iter()
                .flat_map(|record| record.user.iter().map(|&index| line_text(lines[index])));
            let block = managed_block("", user, LOCAL_BLOCK, eol);
            let mut updated = String::with_capacity(content.len() + block.len());
            let mut index = 0;
            for record in &merged {
                updated.push_str(&lines[index..record.start].concat());
                if record.start == last.start {
                    updated.push_str(&block);
                }
                index = record.end;
            }
            updated.push_str(&lines[index..].concat());
            updated
        }
    };
    if updated == content {
        return Ok(false);
    }
    std::fs::write(&gitignore, updated)?;
    Ok(true)
}

/// Append the rules of `system_files::RULES` that `.gitignore` lacks, as
/// plain lines under a comment outside every Svode block. A rule the file
/// already negates is left out, so the user's `!rule` keeps the file in Git.
/// Svode writes them once, when it creates the repository, and never
/// restores them.
fn add_system_file_rules(space_dir: &Path) -> Result<(), GitError> {
    let gitignore = space_dir.join(".gitignore");
    let content = read_gitignore(&gitignore)?;
    let (lines, eol) = gitignore_lines(&content);
    let present = lines
        .iter()
        .map(|line| line_text(line).trim())
        .collect::<std::collections::HashSet<_>>();
    let missing = super::system_files::RULES
        .iter()
        .filter(|rule| !present.contains(*rule) && !present.contains(format!("!{rule}").as_str()))
        .collect::<Vec<_>>();
    if missing.is_empty() {
        return Ok(());
    }
    let mut section = String::new();
    if !content.is_empty() {
        section.push_str(eol);
    }
    section.push_str(super::system_files::GITIGNORE_COMMENT);
    section.push_str(eol);
    for rule in missing {
        section.push_str(rule);
        section.push_str(eol);
    }
    section.push_str(eol);
    std::fs::write(&gitignore, append_block(&content, &section, eol))?;
    Ok(())
}

const LOCAL_BLOCK: (&str, &str) = ("# svode:local:start", "# svode:local:end");
const INLINE_BLOCK: (&str, &str) = ("# svode:inline:start", "# svode:inline:end");
const SPACES_BLOCK_START: &str = "# svode:spaces:start";
const SPACES_BLOCK_END: &str = "# svode:spaces:end";

/// A Svode-owned record of local rules: lines `start..end` of `.gitignore`
/// and the user lines inside it.
struct LocalRecord {
    start: usize,
    end: usize,
    user: Vec<usize>,
}

/// Recognize Svode-owned records: `# svode:local` blocks, `# Svode local
/// files` runs of lines Svode wrote and S3 agent blocks holding only its path.
fn local_records(lines: &[&str]) -> Vec<LocalRecord> {
    let mut records = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let text = line_text(lines[index]).trim();
        let start = index;
        index += 1;
        if text == LOCAL_BLOCK.0 {
            if let Some(end) = block_end(lines, start, LOCAL_BLOCK) {
                let user = (start + 1..end)
                    .filter(|&line| {
                        let text = line_text(lines[line]);
                        !text.trim().is_empty() && !super::policy::written(text, "")
                    })
                    .collect();
                records.push(LocalRecord {
                    start,
                    end: end + 1,
                    user,
                });
                index = end + 1;
            }
        } else if text == super::policy::LEGACY_S3_START {
            let markers = (super::policy::LEGACY_S3_START, super::policy::LEGACY_S3_END);
            if let Some(end) = block_end(lines, start, markers) {
                if lines[start + 1..end]
                    .iter()
                    .all(|line| matches!(line_text(line).trim(), "" | super::policy::S3_AGENT))
                {
                    records.push(LocalRecord {
                        start,
                        end: end + 1,
                        user: Vec::new(),
                    });
                }
                index = end + 1;
            }
        } else if text == super::policy::LEGACY_HEADER {
            let end = (index..lines.len())
                .find(|&line| !super::policy::written(line_text(lines[line]), ""))
                .unwrap_or(lines.len());
            if end > index {
                records.push(LocalRecord {
                    start,
                    end,
                    user: Vec::new(),
                });
                index = end;
            }
        }
    }
    records
}

fn read_gitignore(path: &Path) -> Result<String, GitError> {
    match std::fs::read_to_string(path) {
        Ok(content) => Ok(content),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error.into()),
    }
}

/// Lines of `.gitignore` with their own endings, so untouched lines keep their
/// bytes, and the line ending the file uses.
fn gitignore_lines(content: &str) -> (Vec<&str>, &'static str) {
    let eol = match content.split_once('\n') {
        Some((first, _)) if first.ends_with('\r') => "\r\n",
        _ => "\n",
    };
    (content.split_inclusive('\n').collect(), eol)
}

fn line_text(line: &str) -> &str {
    let line = line.strip_suffix('\n').unwrap_or(line);
    line.strip_suffix('\r').unwrap_or(line)
}

/// Line of the end marker closing the block opened at `start`, unless another
/// start marker comes first.
fn block_end(lines: &[&str], start: usize, (open, close): (&str, &str)) -> Option<usize> {
    let end = start
        + 1
        + lines[start + 1..].iter().position(|line| {
            let text = line_text(line).trim();
            text == open || text == close
        })?;
    (line_text(lines[end]).trim() == close).then_some(end)
}

/// Managed block with every `ENTRIES` rule under `prefix`, then `user` lines.
fn managed_block<'a>(
    prefix: &str,
    user: impl IntoIterator<Item = &'a str>,
    (open, close): (&str, &str),
    eol: &str,
) -> String {
    let mut block = format!("{open}{eol}");
    for entry in super::policy::ENTRIES {
        block.push_str(&format!("{prefix}{entry}{eol}"));
    }
    for line in user {
        block.push_str(&format!("{line}{eol}"));
    }
    block.push_str(&format!("{close}{eol}"));
    block
}

fn append_block(content: &str, block: &str, eol: &str) -> String {
    let mut updated = content.to_owned();
    if !updated.is_empty() && !updated.ends_with('\n') {
        updated.push_str(eol);
    }
    updated.push_str(block);
    updated
}

/// Ensure the inline wildcard block exists in root .gitignore with every
/// `ENTRIES` rule; lines earlier versions wrote are replaced, other lines of
/// the block are kept after them.
pub fn ensure_inline_gitignore(project_path: &Path) -> Result<(), GitError> {
    let gitignore = project_path.join(".gitignore");
    let content = read_gitignore(&gitignore)?;
    let (lines, eol) = gitignore_lines(&content);
    let block = lines
        .iter()
        .position(|line| line_text(line).trim() == INLINE_BLOCK.0)
        .and_then(|start| block_end(&lines, start, INLINE_BLOCK).map(|end| (start, end)));
    let updated = match block {
        Some((start, end)) => {
            let user = lines[start + 1..end]
                .iter()
                .map(|line| line_text(line))
                .filter(|text| !text.trim().is_empty() && !super::policy::written(text, "*/"));
            format!(
                "{}{}{}",
                lines[..start].concat(),
                managed_block("*/", user, INLINE_BLOCK, eol),
                lines[end + 1..].concat()
            )
        }
        None => append_block(&content, &managed_block("*/", [], INLINE_BLOCK, eol), eol),
    };
    if updated != content {
        std::fs::write(&gitignore, updated)?;
    }
    Ok(())
}

/// Add an independent space path to the managed block in root .gitignore.
pub fn add_independent_gitignore(project_path: &Path, space_folder: &str) -> Result<(), GitError> {
    let gitignore = project_path.join(".gitignore");
    let content = if gitignore.exists() {
        std::fs::read_to_string(&gitignore)?
    } else {
        String::new()
    };

    let entry = format!("{}/", space_folder);

    if let Some((before, block, after)) =
        extract_block(&content, SPACES_BLOCK_START, SPACES_BLOCK_END)
    {
        if block.lines().any(|l| l.trim() == entry) {
            return Ok(());
        }
        let mut new_block = block.to_string();
        if !new_block.is_empty() && !new_block.ends_with('\n') {
            new_block.push('\n');
        }
        new_block.push_str(&entry);
        new_block.push('\n');
        let new_content = format!(
            "{}{}\n{}{}\n{}",
            before, SPACES_BLOCK_START, new_block, SPACES_BLOCK_END, after
        );
        std::fs::write(&gitignore, new_content)?;
    } else {
        let mut new_content = content;
        if !new_content.is_empty() && !new_content.ends_with('\n') {
            new_content.push('\n');
        }
        new_content.push_str(&format!(
            "{}\n{}\n{}\n",
            SPACES_BLOCK_START, entry, SPACES_BLOCK_END
        ));
        std::fs::write(&gitignore, new_content)?;
    }
    Ok(())
}

/// Remove an independent space path from the managed block.
pub fn remove_independent_gitignore(
    project_path: &Path,
    space_folder: &str,
) -> Result<(), GitError> {
    let gitignore = project_path.join(".gitignore");
    if !gitignore.exists() {
        return Ok(());
    }
    let content = std::fs::read_to_string(&gitignore)?;
    let entry = format!("{}/", space_folder);

    if let Some((before, block, after)) =
        extract_block(&content, SPACES_BLOCK_START, SPACES_BLOCK_END)
    {
        let new_block: String = block
            .lines()
            .filter(|l| l.trim() != entry)
            .map(|l| format!("{}\n", l))
            .collect();
        let new_content = format!(
            "{}{}\n{}{}\n{}",
            before, SPACES_BLOCK_START, new_block, SPACES_BLOCK_END, after
        );
        std::fs::write(&gitignore, new_content)?;
    }
    Ok(())
}

/// Extract content between start/end markers. Returns (before, block_content, after).
fn extract_block<'a>(
    content: &'a str,
    start: &str,
    end: &str,
) -> Option<(&'a str, &'a str, &'a str)> {
    let start_idx = content.find(start)?;
    let block_start = start_idx + start.len();
    // Skip the newline after the start marker
    let block_start = if content[block_start..].starts_with('\n') {
        block_start + 1
    } else {
        block_start
    };
    let end_idx = content[block_start..].find(end)?;
    let block_end = block_start + end_idx;
    let after_end = block_end + end.len();
    // Skip the newline after end marker
    let after_end = if content[after_end..].starts_with('\n') {
        after_end + 1
    } else {
        after_end
    };
    Some((
        &content[..start_idx],
        &content[block_start..block_end],
        &content[after_end..],
    ))
}

// --- Routed commit ---

/// Push with --set-upstream origin <current-branch>.
pub async fn push_set_upstream(cli: &GitCli, space_dir: &Path) -> Result<(), GitError> {
    let out = match super::publication::push(cli, space_dir, true).await {
        Err(GitError::PushRejected {
            reason: super::push_rejection::PushRejectionReason::NonFastForward,
            ..
        }) => return Err(GitError::RemoteNotEmpty),
        result => result?,
    };
    if out.exit_code != 0 {
        let stderr = out.stderr.trim();
        if (stderr.contains("rejected")
            && (stderr.contains("fetch first")
                || stderr.contains("non-fast-forward")
                || stderr.contains("Updates were rejected")))
            || stderr.contains("Updates were rejected")
        {
            return Err(GitError::RemoteNotEmpty);
        }
        return Err(git_remote_command_error(space_dir, GitStage::Push, stderr));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnpushedCommit {
    pub sha: String,
    pub message: String,
    pub author: String,
    pub timestamp: String,
}

/// Most outgoing commits one list reads; the remote counter still counts all.
const UNPUSHED_COMMITS_LIMIT: usize = 50;

/// List the newest commits on the current branch that are not in
/// origin/<branch>, at most `UNPUSHED_COMMITS_LIMIT`.
pub async fn unpushed_commits(
    cli: &GitCli,
    space_dir: &Path,
) -> Result<Vec<UnpushedCommit>, GitError> {
    let branch = match current_branch(cli, space_dir).await {
        Ok(b) => b,
        Err(_) => return Ok(Vec::new()),
    };

    // No origin at all → nothing can be "unpushed" (no push destination exists).
    let origin_check = cli
        .exec(space_dir, &["remote", "get-url", "origin"])
        .await?;
    if origin_check.exit_code != 0 {
        return Ok(Vec::new());
    }

    let upstream_ref = format!("refs/remotes/origin/{}", branch);
    let upstream_check = cli
        .exec(space_dir, &["rev-parse", "--verify", &upstream_ref])
        .await?;

    let format_arg = "--format=%h%x00%s%x00%an%x00%aI";
    let limit_arg = format!("--max-count={UNPUSHED_COMMITS_LIMIT}");

    let range_arg = if upstream_check.exit_code == 0 {
        format!("origin/{}..HEAD", branch)
    } else {
        // Origin exists but upstream branch not fetched yet (pre-first-push).
        // All local commits on the current branch are unpushed.
        "HEAD".to_string()
    };
    let args = ["log", format_arg, limit_arg.as_str(), range_arg.as_str()];

    let out = cli.exec(space_dir, &args).await?;
    if out.exit_code != 0 {
        return Ok(Vec::new());
    }

    let mut result = Vec::new();
    for line in out.stdout.lines() {
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('\u{0}').collect();
        if parts.len() >= 4 {
            result.push(UnpushedCommit {
                sha: parts[0].to_string(),
                message: parts[1].to_string(),
                author: parts[2].to_string(),
                timestamp: parts[3].to_string(),
            });
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    async fn init_test_repo(cli: &GitCli) -> TempDir {
        let repo = TempDir::new().unwrap();
        assert_eq!(cli.exec(repo.path(), &["init"]).await.unwrap().exit_code, 0);
        assert_eq!(
            cli.exec(repo.path(), &["config", "user.name", "Svode Test"])
                .await
                .unwrap()
                .exit_code,
            0
        );
        assert_eq!(
            cli.exec(repo.path(), &["config", "user.email", "svode@example.test"],)
                .await
                .unwrap()
                .exit_code,
            0
        );
        std::fs::write(repo.path().join("base.txt"), "base\n").unwrap();
        assert_eq!(
            cli.exec(repo.path(), &["add", "--", "base.txt"])
                .await
                .unwrap()
                .exit_code,
            0
        );
        assert_eq!(
            cli.exec(repo.path(), &["commit", "-m", "Initial"])
                .await
                .unwrap()
                .exit_code,
            0
        );
        repo
    }

    async fn empty_commits(cli: &GitCli, repo: &Path, prefix: &str, count: usize) {
        for index in 1..=count {
            let message = format!("{prefix} {index}");
            let out = cli
                .exec(repo, &["commit", "--allow-empty", "-m", &message])
                .await
                .unwrap();
            assert_eq!(out.exit_code, 0, "{}", out.stderr);
        }
    }

    async fn unpushed_messages(cli: &GitCli, repo: &Path) -> Vec<String> {
        unpushed_commits(cli, repo)
            .await
            .unwrap()
            .into_iter()
            .map(|commit| commit.message)
            .collect()
    }

    fn newest_first(prefix: &str, from: usize, to: usize) -> Vec<String> {
        (from..=to)
            .rev()
            .map(|index| format!("{prefix} {index}"))
            .collect()
    }

    #[tokio::test]
    async fn unpushed_commits_read_at_most_the_newest_fifty_of_the_counter_range() {
        let Ok(cli) = GitCli::detect() else {
            return;
        };
        let repo = init_test_repo(&cli).await;
        let path = repo.path();
        empty_commits(&cli, path, "local", 60).await;
        assert!(unpushed_messages(&cli, path).await.is_empty());

        let remote = TempDir::new().unwrap();
        let init = cli.exec(remote.path(), &["init", "--bare"]).await.unwrap();
        assert_eq!(init.exit_code, 0, "{}", init.stderr);
        let add = cli
            .exec(
                path,
                &["remote", "add", "origin", remote.path().to_str().unwrap()],
            )
            .await
            .unwrap();
        assert_eq!(add.exit_code, 0, "{}", add.stderr);
        assert_eq!(
            unpushed_messages(&cli, path).await,
            newest_first("local", 11, 60)
        );

        let push = cli.exec(path, &["push", "origin", "HEAD"]).await.unwrap();
        assert_eq!(push.exit_code, 0, "{}", push.stderr);
        assert!(unpushed_messages(&cli, path).await.is_empty());
        empty_commits(&cli, path, "offline", 60).await;
        assert_eq!(
            unpushed_messages(&cli, path).await,
            newest_first("offline", 11, 60)
        );

        let push = cli.exec(path, &["push", "origin", "HEAD"]).await.unwrap();
        assert_eq!(push.exit_code, 0, "{}", push.stderr);
        empty_commits(&cli, path, "few", 3).await;
        assert_eq!(
            unpushed_messages(&cli, path).await,
            newest_first("few", 1, 3)
        );
    }

    async fn init_metadata_only_submodule(cli: &GitCli, root: &Path) -> std::path::PathBuf {
        let child = root.join("space");
        std::fs::create_dir(&child).unwrap();
        assert_eq!(cli.exec(&child, &["init"]).await.unwrap().exit_code, 0);
        assert_eq!(
            cli.exec(&child, &["config", "user.name", "Svode Test"])
                .await
                .unwrap()
                .exit_code,
            0
        );
        assert_eq!(
            cli.exec(&child, &["config", "user.email", "svode@example.test"],)
                .await
                .unwrap()
                .exit_code,
            0
        );
        std::fs::write(
            root.join(".gitmodules"),
            "[submodule \"space\"]\n\tpath = space\n\turl = ./space\n",
        )
        .unwrap();
        child
    }

    #[test]
    fn parses_status_z_with_spaces_cyrillic_untracked_modified_conflict_and_rename() {
        let output = concat!(
            "# branch.head main\0",
            "# branch.upstream origin/main\0",
            "# branch.ab +2 -1\0",
            "1 .M N... 100644 100644 100644 abc abc docs/space file.md\0",
            "u UU N... 100644 100644 100644 100644 a b c конфликт.md\0",
            "2 R. N... 100644 100644 100644 abc abc R100 renamed file.md\0old file.md\0",
            "? новый файл.md\0",
            "? .assets/\0",
        );

        let status = parse_status_porcelain_v2_z(output).unwrap();

        assert_eq!(status.branch, "main");
        assert_eq!(status.tracking.as_deref(), Some("origin/main"));
        assert_eq!(status.ahead, 2);
        assert_eq!(status.behind, 1);
        assert!(status.has_staged);
        assert!(status.has_unstaged);
        assert!(status.has_conflicts);
        assert_eq!(status.files.len(), 6);
        assert!(
            status
                .files
                .iter()
                .any(|file| { file.path == "docs/space file.md" && file.state == "modified" })
        );
        assert!(
            status
                .files
                .iter()
                .any(|file| { file.path == "конфликт.md" && file.state == "conflict" })
        );
        assert!(
            status
                .files
                .iter()
                .any(|file| { file.path == "renamed file.md" && file.state == "modified" })
        );
        assert!(
            status
                .files
                .iter()
                .any(|file| { file.path == "old file.md" && file.state == "deleted" })
        );
        assert!(
            status
                .files
                .iter()
                .any(|file| { file.path == "новый файл.md" && file.state == "untracked" })
        );
        assert!(
            status
                .files
                .iter()
                .any(|file| { file.path == ".assets" && file.state == "untracked" })
        );
    }

    #[tokio::test]
    async fn exact_path_commit_preserves_unrelated_staged_changes() {
        let Ok(cli) = GitCli::detect() else {
            return;
        };
        let repo = init_test_repo(&cli).await;
        std::fs::write(repo.path().join(".mailmap"), "Actor <actor@example.test>\n").unwrap();
        std::fs::write(repo.path().join("unrelated.txt"), "keep staged\n").unwrap();
        assert_eq!(
            cli.exec(repo.path(), &["add", "--", "unrelated.txt"])
                .await
                .unwrap()
                .exit_code,
            0
        );

        assert!(
            commit_exact_path(
                &cli,
                repo.path(),
                ".mailmap",
                "Update contributor identities",
            )
            .await
            .unwrap()
        );

        let committed = cli
            .exec(
                repo.path(),
                &["show", "--pretty=format:", "--name-only", "HEAD"],
            )
            .await
            .unwrap();
        assert_eq!(committed.stdout.trim(), ".mailmap");
        let staged = cli
            .exec(repo.path(), &["diff", "--cached", "--name-only"])
            .await
            .unwrap();
        assert_eq!(staged.stdout.trim(), "unrelated.txt");
        let committed_mailmap = cli
            .exec(repo.path(), &["show", "HEAD:.mailmap"])
            .await
            .unwrap();
        assert_eq!(committed_mailmap.stdout, "Actor <actor@example.test>\n");
    }

    #[tokio::test]
    async fn exact_path_gitlink_commit_preserves_unrelated_root_index() {
        let Ok(cli) = GitCli::detect() else {
            return;
        };
        let root = init_test_repo(&cli).await;
        let child = root.path().join("space");
        std::fs::create_dir(&child).unwrap();
        assert_eq!(cli.exec(&child, &["init"]).await.unwrap().exit_code, 0);
        assert_eq!(
            cli.exec(&child, &["config", "user.name", "Svode Test"])
                .await
                .unwrap()
                .exit_code,
            0
        );
        assert_eq!(
            cli.exec(&child, &["config", "user.email", "svode@example.test"],)
                .await
                .unwrap()
                .exit_code,
            0
        );
        std::fs::write(
            root.path().join(".gitmodules"),
            "[submodule \"space\"]\n\tpath = space\n\turl = ./space\n",
        )
        .unwrap();
        assert!(
            !is_registered_unborn_submodule_target(&cli, root.path(), "space")
                .await
                .unwrap()
        );
        assert_eq!(
            cli.exec(root.path(), &["add", "--", ".gitmodules"])
                .await
                .unwrap()
                .exit_code,
            0
        );
        assert_eq!(
            cli.exec(root.path(), &["commit", "-m", "Register space"])
                .await
                .unwrap()
                .exit_code,
            0
        );
        assert!(
            is_registered_unborn_submodule_target(&cli, root.path(), "space")
                .await
                .unwrap()
        );

        std::fs::write(child.join(".mailmap"), "Actor <actor@example.test>\n").unwrap();
        assert!(
            commit_exact_path(&cli, &child, ".mailmap", "Update contributor identities",)
                .await
                .unwrap()
        );
        let child_head = repository_head_oid(&cli, &child).await.unwrap();
        assert!(
            submodule_target_matches_expected_head(
                &cli,
                root.path(),
                "space",
                &child,
                &child_head,
            )
            .await
            .unwrap()
        );
        std::fs::write(root.path().join("unrelated.txt"), "keep staged\n").unwrap();
        assert_eq!(
            cli.exec(root.path(), &["add", "--", "unrelated.txt"])
                .await
                .unwrap()
                .exit_code,
            0
        );

        assert!(
            commit_exact_path(&cli, root.path(), "space", "Update space pointer")
                .await
                .unwrap()
        );

        let tree = cli
            .exec(root.path(), &["ls-tree", "HEAD", "--", "space"])
            .await
            .unwrap();
        assert!(tree.stdout.starts_with("160000 commit "));
        let staged = cli
            .exec(root.path(), &["diff", "--cached", "--name-only"])
            .await
            .unwrap();
        assert_eq!(staged.stdout.trim(), "unrelated.txt");
        let committed = cli
            .exec(
                root.path(),
                &["show", "--pretty=format:", "--name-only", "HEAD"],
            )
            .await
            .unwrap();
        assert_eq!(committed.stdout.trim(), "space");
        assert!(
            !exact_path_has_changes(&cli, root.path(), ".gitmodules")
                .await
                .unwrap()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn child_commit_failure_does_not_create_root_gitlink() {
        let Ok(cli) = GitCli::detect() else {
            return;
        };
        let root = init_test_repo(&cli).await;
        let child = init_metadata_only_submodule(&cli, root.path()).await;
        std::fs::write(child.join(".mailmap"), "Actor <actor@example.test>\n").unwrap();
        let hook = child.join(".git/hooks/pre-commit");
        svode_testkit::write_executable(&hook, "#!/bin/sh\nexit 1\n").unwrap();

        let child_commit =
            commit_exact_path(&cli, &child, ".mailmap", "Update contributor identities").await;
        assert!(child_commit.is_err());
        let root_tree = cli
            .exec(root.path(), &["ls-tree", "HEAD", "--", "space"])
            .await
            .unwrap();
        assert!(root_tree.stdout.is_empty());
        let child_head = cli
            .exec(&child, &["rev-parse", "--verify", "HEAD"])
            .await
            .unwrap();
        assert_ne!(child_head.exit_code, 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn root_gitlink_failure_keeps_child_commit_and_allows_pointer_only_recovery() {
        let Ok(cli) = GitCli::detect() else {
            return;
        };
        let root = init_test_repo(&cli).await;
        let child = init_metadata_only_submodule(&cli, root.path()).await;
        std::fs::write(child.join(".mailmap"), "Actor <actor@example.test>\n").unwrap();
        assert!(
            commit_exact_path(&cli, &child, ".mailmap", "Update contributor identities",)
                .await
                .unwrap()
        );
        let child_head = cli
            .exec(&child, &["rev-parse", "--verify", "HEAD"])
            .await
            .unwrap()
            .stdout;
        let pointer_fingerprint = exact_path_state_fingerprint(&cli, root.path(), "space")
            .await
            .unwrap();

        let hook = root.path().join(".git/hooks/pre-commit");
        svode_testkit::write_executable(&hook, "#!/bin/sh\nexit 1\n").unwrap();
        assert!(
            commit_exact_path(&cli, root.path(), "space", "Update space pointer")
                .await
                .is_err()
        );

        let committed_mailmap = cli.exec(&child, &["show", "HEAD:.mailmap"]).await.unwrap();
        assert_eq!(committed_mailmap.stdout, "Actor <actor@example.test>\n");
        assert_eq!(
            cli.exec(&child, &["rev-parse", "--verify", "HEAD"])
                .await
                .unwrap()
                .stdout,
            child_head
        );
        assert!(
            exact_path_has_changes(&cli, root.path(), "space")
                .await
                .unwrap()
        );
        assert_eq!(
            exact_path_state_fingerprint(&cli, root.path(), "space")
                .await
                .unwrap(),
            pointer_fingerprint
        );

        std::fs::remove_file(&hook).unwrap();
        assert!(
            commit_exact_path(&cli, root.path(), "space", "Update space pointer")
                .await
                .unwrap()
        );
        let root_pointer = cli
            .exec(root.path(), &["ls-tree", "HEAD", "--", "space"])
            .await
            .unwrap();
        assert!(root_pointer.stdout.contains(child_head.trim()));
        assert!(
            !exact_path_has_changes(&cli, root.path(), "space")
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn cloned_submodule_child_and_root_pointer_commit_in_sequence() {
        let Ok(cli) = GitCli::detect() else {
            return;
        };
        let source = init_test_repo(&cli).await;
        let root = init_test_repo(&cli).await;
        let source_path = source.path().to_string_lossy().into_owned();
        let added = cli
            .exec(
                root.path(),
                &[
                    "-c",
                    "protocol.file.allow=always",
                    "submodule",
                    "add",
                    "--",
                    &source_path,
                    "space",
                ],
            )
            .await
            .unwrap();
        assert_eq!(added.exit_code, 0, "{}", added.stderr);
        assert_eq!(
            cli.exec(root.path(), &["commit", "-m", "Add space"])
                .await
                .unwrap()
                .exit_code,
            0
        );
        let child = root.path().join("space");
        assert_eq!(
            cli.exec(&child, &["config", "user.name", "Svode Test"])
                .await
                .unwrap()
                .exit_code,
            0
        );
        assert_eq!(
            cli.exec(&child, &["config", "user.email", "svode@example.test"],)
                .await
                .unwrap()
                .exit_code,
            0
        );
        assert!(child.join(".git").is_file());
        assert!(
            !is_registered_unborn_submodule_target(&cli, root.path(), "space")
                .await
                .unwrap()
        );

        std::fs::write(child.join(".mailmap"), "Actor <actor@example.test>\n").unwrap();
        assert!(
            commit_exact_path(&cli, &child, ".mailmap", "Update contributor identities",)
                .await
                .unwrap()
        );
        let child_head = repository_head_oid(&cli, &child).await.unwrap();
        assert!(
            submodule_target_matches_expected_head(
                &cli,
                root.path(),
                "space",
                &child,
                &child_head,
            )
            .await
            .unwrap()
        );
        assert!(
            commit_exact_path(&cli, root.path(), "space", "Update space pointer")
                .await
                .unwrap()
        );
        assert!(
            !exact_path_has_changes(&cli, root.path(), "space")
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn exact_path_commit_captures_full_current_target_after_multiple_updates() {
        let Ok(cli) = GitCli::detect() else {
            return;
        };
        let repo = init_test_repo(&cli).await;
        std::fs::write(repo.path().join(".mailmap"), "First <first@example.test>\n").unwrap();
        std::fs::write(
            repo.path().join(".mailmap"),
            "First <first@example.test>\nSecond <second@example.test>\n",
        )
        .unwrap();

        assert!(
            commit_exact_path(
                &cli,
                repo.path(),
                ".mailmap",
                "Update contributor identities",
            )
            .await
            .unwrap()
        );
        let committed_mailmap = cli
            .exec(repo.path(), &["show", "HEAD:.mailmap"])
            .await
            .unwrap();
        assert_eq!(
            committed_mailmap.stdout,
            "First <first@example.test>\nSecond <second@example.test>\n"
        );
        assert!(
            !commit_exact_path(
                &cli,
                repo.path(),
                ".mailmap",
                "Update contributor identities",
            )
            .await
            .unwrap()
        );
    }

    #[tokio::test]
    async fn exact_path_commit_uses_current_worktree_target_not_its_staged_snapshot() {
        let Ok(cli) = GitCli::detect() else {
            return;
        };
        let repo = init_test_repo(&cli).await;
        std::fs::write(
            repo.path().join(".mailmap"),
            "Original <old@example.test>\n",
        )
        .unwrap();
        assert!(
            commit_exact_path(&cli, repo.path(), ".mailmap", "Add identities")
                .await
                .unwrap()
        );

        std::fs::write(
            repo.path().join(".mailmap"),
            "Staged <staged@example.test>\n",
        )
        .unwrap();
        std::fs::write(repo.path().join("unrelated.txt"), "keep staged\n").unwrap();
        assert_eq!(
            cli.exec(repo.path(), &["add", "--", ".mailmap", "unrelated.txt"],)
                .await
                .unwrap()
                .exit_code,
            0
        );
        std::fs::write(
            repo.path().join(".mailmap"),
            "Current <current@example.test>\n",
        )
        .unwrap();

        assert!(
            commit_exact_path(
                &cli,
                repo.path(),
                ".mailmap",
                "Update contributor identities",
            )
            .await
            .unwrap()
        );
        let committed_mailmap = cli
            .exec(repo.path(), &["show", "HEAD:.mailmap"])
            .await
            .unwrap();
        assert_eq!(committed_mailmap.stdout, "Current <current@example.test>\n");
        let staged = cli
            .exec(repo.path(), &["diff", "--cached", "--name-only"])
            .await
            .unwrap();
        assert_eq!(staged.stdout.trim(), "unrelated.txt");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn failed_new_exact_path_commit_restores_its_index_state() {
        let Ok(cli) = GitCli::detect() else {
            return;
        };
        let repo = init_test_repo(&cli).await;
        std::fs::write(repo.path().join(".mailmap"), "Actor <actor@example.test>\n").unwrap();
        std::fs::write(repo.path().join("unrelated.txt"), "keep staged\n").unwrap();
        assert_eq!(
            cli.exec(repo.path(), &["add", "--", "unrelated.txt"])
                .await
                .unwrap()
                .exit_code,
            0
        );
        let hook = repo.path().join(".git/hooks/pre-commit");
        svode_testkit::write_executable(&hook, "#!/bin/sh\nexit 1\n").unwrap();

        assert!(
            commit_exact_path(
                &cli,
                repo.path(),
                ".mailmap",
                "Update contributor identities",
            )
            .await
            .is_err()
        );
        let target_status = cli
            .exec(repo.path(), &["status", "--short", "--", ".mailmap"])
            .await
            .unwrap();
        assert_eq!(target_status.stdout.trim(), "?? .mailmap");
        let staged = cli
            .exec(repo.path(), &["diff", "--cached", "--name-only"])
            .await
            .unwrap();
        assert_eq!(staged.stdout.trim(), "unrelated.txt");
    }

    #[test]
    fn strips_status_paths_to_space_relative_paths() {
        let mut status = GitStatus {
            repository: None,
            branch: "main".to_string(),
            ahead: 0,
            behind: 0,
            has_staged: false,
            has_unstaged: true,
            has_conflicts: false,
            tracking: None,
            files: vec![
                FileGitStatus {
                    path: "spaces/docs/a.md".to_string(),
                    state: "modified".to_string(),
                },
                FileGitStatus {
                    path: "spaces/docs/folder/new.md".to_string(),
                    state: "untracked".to_string(),
                },
            ],
            total_files: 2,
            omitted_files: 0,
        };

        strip_status_path_prefix(&mut status, "spaces/docs/").unwrap();

        assert_eq!(
            status.files,
            vec![
                FileGitStatus {
                    path: "a.md".to_string(),
                    state: "modified".to_string(),
                },
                FileGitStatus {
                    path: "folder/new.md".to_string(),
                    state: "untracked".to_string(),
                },
            ]
        );
    }

    #[test]
    fn parses_nul_path_output() {
        let paths = parse_nul_paths("docs/a file.md\0кириллица.md\0").unwrap();

        assert_eq!(paths, vec!["docs/a file.md", "кириллица.md"]);
    }

    #[test]
    fn classifies_remote_auth_errors_before_no_remote_errors() {
        let err = git_remote_command_error(
            Path::new("/missing/Research"),
            GitStage::Fetch,
            "Permission denied (publickey).\nfatal: Could not read from remote repository.",
        );

        assert!(matches!(err, GitError::AuthRequired(_)));
    }

    #[test]
    fn classifies_missing_credentials_as_auth_required() {
        let err = git_remote_command_error(
            Path::new("/missing/Research"),
            GitStage::Push,
            "Missing or invalid credentials.\nfatal: Authentication failed",
        );

        assert!(matches!(err, GitError::AuthRequired(_)));
    }

    #[test]
    fn transport_failure_does_not_prove_missing_remote() {
        let err = git_remote_command_error(
            Path::new("/missing/Research"),
            GitStage::Fetch,
            "fatal: 'origin' does not appear to be a git repository",
        );

        assert!(matches!(err, GitError::SyncFailed(_)));
        for message in [
            "ssh: Could not resolve hostname fixture.invalid: nodename nor servname provided\nfatal: Could not read from remote repository.",
            "fatal: Repository not found",
            "fatal: unable to access remote: Could not resolve host",
        ] {
            assert!(matches!(
                git_remote_command_error(Path::new("/missing/Research"), GitStage::Fetch, message),
                GitError::SyncFailed(_)
            ));
        }
        assert!(matches!(
            git_remote_command_error(
                Path::new("/missing/Research"),
                GitStage::Push,
                "fatal: No configured push destination."
            ),
            GitError::NoRemote
        ));
    }

    #[test]
    fn file_system_permission_denied_is_a_local_failure_not_authorization() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path().join("Research");
        std::fs::create_dir(&repo).unwrap();
        for stderr in [
            "error: cannot open .git/FETCH_HEAD: Permission denied",
            "fatal: Unable to create '/home/user/project/.git/index.lock': Permission denied",
            "error: insufficient permission for adding an object to repository database .git/objects\nfatal: failed to write object",
        ] {
            assert!(!is_git_auth_error(stderr), "{stderr}");
            let error = git_remote_command_error(&repo, GitStage::Fetch, stderr);
            assert!(
                matches!(
                    &error,
                    GitError::SyncFailed(failure)
                        if failure.repository == "Research"
                            && failure.stage == GitStage::Fetch
                            && failure.cause == Some(super::super::diagnostics::GitFailureCause::FileSystemDenied)
                ),
                "{stderr}: {error:?}"
            );
            assert!(error.is_local_failure());
            let text = format!("{error} {}", serde_json::to_string(&error).unwrap());
            assert!(!text.contains("/home/user"), "{text}");
        }
        for stderr in [
            "git@github.com: Permission denied (publickey).",
            "Permission denied, please try again.",
            "remote: Permission denied.",
            "fatal: Authentication failed for 'https://github.com/org/repo.git/'",
        ] {
            assert!(is_git_auth_error(stderr), "{stderr}");
        }
    }

    #[test]
    fn ensure_svode_gitignore_creates_root_local_rules() {
        let tmp = TempDir::new().unwrap();

        let changed = ensure_svode_gitignore(tmp.path()).unwrap();
        let content = std::fs::read_to_string(tmp.path().join(".gitignore")).unwrap();

        assert!(changed);
        assert_eq!(
            content,
            "# svode:local:start\n.svode/local.json\n.svode/navigation.*\n.svode/write.lock\n.svode/lfs-s3-agent.json\n.svode/variables.*\n.svode/*.db*\n# svode:local:end\n"
        );

        let changed_again = ensure_svode_gitignore(tmp.path()).unwrap();
        let content_again = std::fs::read_to_string(tmp.path().join(".gitignore")).unwrap();

        assert!(!changed_again);
        assert_eq!(content, content_again);
    }

    #[test]
    fn ensure_svode_gitignore_appends_missing_rules_without_rewriting_user_rules() {
        let tmp = TempDir::new().unwrap();
        std::fs::write(
            tmp.path().join(".gitignore"),
            "target/\n/.svode/local.json\n",
        )
        .unwrap();

        let changed = ensure_svode_gitignore(tmp.path()).unwrap();
        let content = std::fs::read_to_string(tmp.path().join(".gitignore")).unwrap();

        assert!(changed);
        assert!(content.starts_with("target/\n/.svode/local.json\n# svode:local:start\n"));
        assert!(content.contains("\n.svode/local.json\n"));
        assert!(content.ends_with(".svode/*.db*\n# svode:local:end\n"));
    }

    #[tokio::test]
    async fn managed_staging_excludes_tracked_root_and_inline_sqlite_families() {
        let Ok(cli) = GitCli::detect() else {
            return;
        };
        let tmp = TempDir::new().unwrap();
        cli.exec(tmp.path(), &["init"]).await.unwrap();
        cli.exec(tmp.path(), &["config", "user.email", "svode@example.test"])
            .await
            .unwrap();
        cli.exec(tmp.path(), &["config", "user.name", "Svode Test"])
            .await
            .unwrap();
        ensure_svode_gitignore(tmp.path()).unwrap();
        ensure_inline_gitignore(tmp.path()).unwrap();
        std::fs::create_dir_all(tmp.path().join(".svode")).unwrap();
        std::fs::create_dir_all(tmp.path().join("child/.svode")).unwrap();
        std::fs::write(tmp.path().join(".svode/routines.db"), "legacy root").unwrap();
        std::fs::write(
            tmp.path().join("child/.svode/index.db-wal"),
            "legacy inline",
        )
        .unwrap();
        std::fs::write(tmp.path().join("note.md"), "before").unwrap();
        cli.exec(
            tmp.path(),
            &[
                "add",
                "-f",
                ".gitignore",
                ".svode/routines.db",
                "child/.svode/index.db-wal",
                "note.md",
            ],
        )
        .await
        .unwrap();
        cli.exec(tmp.path(), &["commit", "-m", "fixture"])
            .await
            .unwrap();

        std::fs::write(tmp.path().join(".svode/routines.db"), "changed root").unwrap();
        std::fs::write(
            tmp.path().join("child/.svode/index.db-wal"),
            "changed inline",
        )
        .unwrap();
        std::fs::write(tmp.path().join("note.md"), "after").unwrap();
        add_all(&cli, tmp.path()).await.unwrap();

        let staged = cli
            .exec(tmp.path(), &["diff", "--cached", "--name-only"])
            .await
            .unwrap();
        assert_eq!(staged.stdout.trim(), "note.md");
        let unstaged = cli
            .exec(tmp.path(), &["diff", "--name-only"])
            .await
            .unwrap();
        assert!(unstaged.stdout.contains(".svode/routines.db"));
        assert!(unstaged.stdout.contains("child/.svode/index.db-wal"));
    }

    #[tokio::test]
    async fn variables_staging_and_commit_exclude_tracked_local_and_agent_files() {
        let cli = GitCli::detect().expect("Git required for Variables acceptance");
        for prefix in ["", "child/"] {
            let tmp = TempDir::new().unwrap();
            cli.exec(tmp.path(), &["init"]).await.unwrap();
            cli.exec(
                tmp.path(),
                &["config", "user.email", "variables@example.test"],
            )
            .await
            .unwrap();
            cli.exec(tmp.path(), &["config", "user.name", "Variables Test"])
                .await
                .unwrap();
            let directory = tmp.path().join(format!("{prefix}.svode"));
            std::fs::create_dir_all(&directory).unwrap();
            for name in [
                "config.json",
                "local.json",
                "lfs-s3-agent.json",
                "variables.lock",
                "variables.pending.json",
            ] {
                std::fs::write(directory.join(name), "before").unwrap();
            }
            assert_eq!(
                cli.exec(tmp.path(), &["add", "."]).await.unwrap().exit_code,
                0
            );
            assert_eq!(
                cli.exec(tmp.path(), &["commit", "-m", "Legacy tracked fixture"])
                    .await
                    .unwrap()
                    .exit_code,
                0
            );
            ensure_svode_gitignore(tmp.path()).unwrap();
            ensure_inline_gitignore(tmp.path()).unwrap();
            for name in [
                "config.json",
                "local.json",
                "lfs-s3-agent.json",
                "variables.lock",
                "variables.pending.json",
            ] {
                std::fs::write(directory.join(name), "after").unwrap();
            }
            add_all(&cli, tmp.path()).await.unwrap();
            let staged = cli
                .exec(tmp.path(), &["diff", "--cached", "--name-only"])
                .await
                .unwrap();
            assert!(staged.stdout.contains("config.json"));
            for name in [
                "local.json",
                "lfs-s3-agent.json",
                "variables.lock",
                "variables.pending.json",
            ] {
                assert!(!staged.stdout.contains(name));
            }
            assert!(
                commit_paths(&cli, tmp.path(), &[format!("{prefix}.svode")])
                    .await
                    .unwrap()
            );
            let committed = cli
                .exec(tmp.path(), &["show", "--format=", "--name-only", "HEAD"])
                .await
                .unwrap();
            assert_eq!(
                committed.stdout.trim(),
                format!("{prefix}.svode/config.json")
            );
            let local = format!("{prefix}.svode/local.json");
            assert!(
                commit_exact_path(&cli, tmp.path(), &local, "Forbidden")
                    .await
                    .is_err()
            );
            assert_eq!(
                cli.exec(tmp.path(), &["add", "-f", "--", &local])
                    .await
                    .unwrap()
                    .exit_code,
                0
            );
            assert!(
                commit(&cli, tmp.path(), "Forbidden staged file")
                    .await
                    .is_err()
            );
        }
    }

    #[test]
    fn variables_ignore_upgrade_preserves_existing_inline_block_and_user_rules() {
        let tmp = TempDir::new().unwrap();
        let previous = "user-rule\n# svode:inline:start\n*/.svode/local.json\ncustom-local-rule\n# svode:inline:end\nafter-rule\n";
        std::fs::write(tmp.path().join(".gitignore"), previous).unwrap();
        ensure_inline_gitignore(tmp.path()).unwrap();
        let updated = std::fs::read_to_string(tmp.path().join(".gitignore")).unwrap();
        assert!(updated.contains("custom-local-rule\n"));
        assert!(updated.ends_with("after-rule\n"));
        assert!(updated.contains("*/.svode/lfs-s3-agent.json\n"));
        assert!(updated.contains("*/.svode/variables.*\n"));
        ensure_inline_gitignore(tmp.path()).unwrap();
        assert_eq!(
            updated,
            std::fs::read_to_string(tmp.path().join(".gitignore")).unwrap()
        );
    }

    #[tokio::test]
    async fn init_without_scaffold_commit_leaves_repo_unborn_and_dirty() {
        let Ok(cli) = GitCli::detect() else {
            return;
        };
        let tmp = TempDir::new().unwrap();
        crate::git::staging_tests::scaffold(tmp.path(), "Space");

        init_with_optional_scaffold_commit(&cli, tmp.path(), false)
            .await
            .unwrap();

        let head = cli
            .exec(tmp.path(), &["rev-parse", "--verify", "HEAD"])
            .await
            .unwrap();
        assert_ne!(head.exit_code, 0);

        let status = cli
            .exec(tmp.path(), &["status", "--short", "--untracked-files=all"])
            .await
            .unwrap();
        assert!(status.stdout.contains("?? .gitignore"));
        assert!(status.stdout.contains("?? .svode/config.json"));
        assert!(status.stdout.contains("?? README.md"));
    }

    #[tokio::test]
    async fn manual_policy_submodule_metadata_does_not_create_commits() {
        let Ok(cli) = GitCli::detect() else {
            return;
        };
        let tmp = TempDir::new().unwrap();
        let project = tmp.path().join("project");
        let child = project.join("docs");
        std::fs::create_dir_all(&child).unwrap();

        let init_parent = cli.exec(&project, &["init"]).await.unwrap();
        assert_eq!(init_parent.exit_code, 0);

        crate::git::staging_tests::scaffold(&child, "Docs");
        init_with_optional_scaffold_commit(&cli, &child, false)
            .await
            .unwrap();
        register_local_submodule_metadata(&cli, &project, "docs")
            .await
            .unwrap();

        let child_head = cli
            .exec(&child, &["rev-parse", "--verify", "HEAD"])
            .await
            .unwrap();
        let parent_head = cli
            .exec(&project, &["rev-parse", "--verify", "HEAD"])
            .await
            .unwrap();
        assert_ne!(child_head.exit_code, 0);
        assert_ne!(parent_head.exit_code, 0);

        assert_eq!(
            get_submodule_url(&cli, &project, "docs").await.unwrap(),
            Some("./docs".to_string())
        );
        assert_eq!(
            detect_space_git_type(&cli, &project, &child).await.unwrap(),
            SpaceGitType::Submodule
        );

        let parent_status = cli
            .exec(&project, &["status", "--short", "--untracked-files=all"])
            .await
            .unwrap();
        assert!(parent_status.stdout.contains("?? .gitmodules"));
        assert!(parent_status.stdout.contains("?? docs/"));
    }

    #[tokio::test]
    async fn project_root_with_submodule_spaces_is_its_own_independent_owner() {
        use crate::git::staging_tests::{cli, git, submodule_project, write};
        let cli = cli();
        let (tmp, submodule) = submodule_project(&cli).await;
        let root = tmp.path();
        let independent = root.join("independent");
        std::fs::create_dir(&independent).unwrap();
        git(&cli, &independent, &["init"]).await;
        write(root, "inline/README.md", "inline\n");

        for space in [root.to_path_buf(), root.join(".")] {
            assert_eq!(
                detect_space_git_type(&cli, root, &space).await.unwrap(),
                SpaceGitType::Independent
            );
            assert_eq!(
                resolve_target_repo(&cli, root, &space).await.unwrap(),
                (SpaceGitType::Independent, space.clone())
            );
        }
        assert_eq!(
            detect_space_git_type(&cli, root, &submodule).await.unwrap(),
            SpaceGitType::Submodule
        );
        assert_eq!(
            detect_space_git_type(&cli, root, &independent)
                .await
                .unwrap(),
            SpaceGitType::Independent
        );
        assert_eq!(
            detect_space_git_type(&cli, root, &root.join("inline"))
                .await
                .unwrap(),
            SpaceGitType::Inline
        );

        let outside = TempDir::new().unwrap();
        git(&cli, outside.path(), &["init"]).await;
        assert!(matches!(
            detect_space_git_type(&cli, root, outside.path()).await,
            Err(GitError::PathNotAccessible(_))
        ));
    }
}

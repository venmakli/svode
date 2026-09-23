//! Git LFS readiness of the assets strategy of a repository and Svode's
//! managed custom-transfer registration of the `svode-lfs` agent.
//!
//! Readiness is the live evidence a managed import needs before it routes a
//! file to Git LFS, and every host asks the same probe:
//! - Local / InGit → `NotApplicable` (no LFS in play).
//! - LfsS3 → `Ready` iff the saved agent config matches the S3 target, its
//!   credentials resolve from the OS keychain and the managed `svode-lfs`
//!   registration is current (repaired when needed), else `MissingCreds`.
//! - LfsRemote → `git lfs fetch --dry-run origin` succeeds, else
//!   `MissingCreds` (conservative: the repair affordance wins over pretending
//!   everything is fine).

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Command;

use serde::{Deserialize, Serialize};

use super::config::{AssetsSpaceConfig, AssetsStrategy};
use super::s3::AgentConfig;
use crate::attachments::import::LfsReadiness;
use crate::git::GitError;
use crate::git::cli::{GitCli, hide_window};
use crate::git::state::GitRuntime;

/// Remote readiness probe of the LfsRemote strategy; it transfers nothing.
pub const REMOTE_PROBE_ARGS: &[&str] = &["lfs", "fetch", "--dry-run", "origin"];

/// Git LFS custom-transfer agent identifier Svode registers for the LfsS3
/// strategy. Git spawns the sidecar registered under this name on push/pull.
const TRANSFER_AGENT: &str = "svode-lfs";
/// Historical agent identifier used before the `lfs-dal → svode-lfs` rename.
/// Recognized only to migrate Svode's own registration; never claimed from a
/// third-party standalone agent.
const LEGACY_TRANSFER_AGENT: &str = "lfs-dal";
/// Base names of the sidecar binary Svode has shipped. A legacy `lfs-dal`
/// registration whose path points at one of these (or at the current sidecar
/// name) is recognized as Svode's own; any other target is treated as a
/// conflicting custom configuration and left untouched.
const OWNED_BINARY_NAMES: [&str; 4] = ["lfs-dal", "lfs-dal.exe", "svode-lfs", "svode-lfs.exe"];

#[derive(Debug, thiserror::Error)]
pub enum LfsError {
    #[error(transparent)]
    Git(#[from] GitError),
    #[error("{0}")]
    Storage(String),
}

/// LFS runtime state of a storage scope. Serialized in kebab-case (`n/a`
/// for `NotApplicable`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LfsState {
    #[default]
    #[serde(rename = "n/a")]
    NotApplicable,
    Ready,
    MissingCreds,
    Pulling,
}

/// Current LFS readiness of the assets strategy `config` of `repo_dir`.
pub async fn probe_readiness(
    git: &GitRuntime,
    repo_dir: &Path,
    config: &AssetsSpaceConfig,
) -> LfsState {
    match config.strategy {
        AssetsStrategy::Local | AssetsStrategy::InGit => LfsState::NotApplicable,
        AssetsStrategy::LfsS3 => {
            let Some(target) = config.s3.clone() else {
                return LfsState::MissingCreds;
            };
            let repo = repo_dir.to_path_buf();
            let present = tokio::task::spawn_blocking(move || {
                AgentConfig::read_for_target(&repo, &target)
                    .and_then(|config| config.resolve())
                    .is_ok()
            })
            .await
            .unwrap_or(false);
            if !present {
                return LfsState::MissingCreds;
            }
            // Managed readiness before transfer: ensure Git spawns the current
            // svode-lfs sidecar, migrating a previous install's lfs-dal
            // registration. A repair failure must not be reported as a ready
            // S3 strategy, so surface the repair affordance instead.
            match repair_managed_registration(git, repo_dir).await {
                Ok(_) => LfsState::Ready,
                Err(error) => {
                    tracing::warn!("svode-lfs registration repair failed: {error}");
                    LfsState::MissingCreds
                }
            }
        }
        AssetsStrategy::LfsRemote => {
            let Some(cli) = git.detected() else {
                return LfsState::MissingCreds;
            };
            match cli.exec(repo_dir, REMOTE_PROBE_ARGS).await {
                Ok(out) if out.exit_code == 0 => LfsState::Ready,
                _ => LfsState::MissingCreds,
            }
        }
    }
}

/// A managed import of every host answers its Git LFS route with the live
/// readiness probe.
impl LfsReadiness for GitRuntime {
    fn lfs_ready<'a>(
        &'a self,
        repo_dir: &'a Path,
        config: &'a AssetsSpaceConfig,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
        Box::pin(async move { probe_readiness(self, repo_dir, config).await == LfsState::Ready })
    }
}

/// Outcome of [`repair_managed_registration`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegistrationOutcome {
    /// Registration already targets the current sidecar; Git config untouched.
    Current,
    /// Legacy/missing/stale/partial wiring was migrated to `svode-lfs`.
    Repaired,
    /// A third-party or conflicting custom transfer config was left unchanged.
    Foreign,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RepairAction {
    None,
    Foreign,
    Migrate,
}

/// Read a single local Git config value. Returns `None` when the key is unset
/// (`git config --get` exit code 1); any other non-zero exit is an error.
async fn read_local_config(
    cli: &GitCli,
    repo_dir: &Path,
    key: &str,
) -> Result<Option<String>, LfsError> {
    let out = cli
        .exec(repo_dir, &["config", "--local", "--get", key])
        .await?;
    match out.exit_code {
        0 => Ok(Some(out.stdout.trim().to_string())),
        1 => Ok(None),
        _ => Err(LfsError::Storage(format!(
            "git config --get {key} failed: {}",
            out.stderr.trim()
        ))),
    }
}

async fn set_local_config(
    cli: &GitCli,
    repo_dir: &Path,
    key: &str,
    value: &str,
) -> Result<(), LfsError> {
    let out = cli
        .exec(repo_dir, &["config", "--local", key, value])
        .await?;
    if out.exit_code != 0 {
        return Err(LfsError::Storage(format!(
            "git config {key} failed: {}",
            out.stderr.trim()
        )));
    }
    Ok(())
}

/// Unset a single local Git config key. A missing key (`--unset` exit code 5)
/// is treated as a no-op rather than an error.
async fn unset_local_config(cli: &GitCli, repo_dir: &Path, key: &str) -> Result<(), LfsError> {
    let out = cli
        .exec(repo_dir, &["config", "--local", "--unset", key])
        .await?;
    if out.exit_code != 0 && out.exit_code != 5 {
        return Err(LfsError::Storage(format!(
            "git config --unset {key} failed: {}",
            out.stderr.trim()
        )));
    }
    Ok(())
}

/// A recorded legacy `lfs-dal` transfer path is Svode's own when it is absent
/// (a broken registration we rewrite) or points at a binary Svode ships. Any
/// other target is a conflicting custom configuration. A basename alone is not
/// sufficient on its own — the caller only reaches here after confirming the
/// managed Svode agent identifier is registered.
fn legacy_path_is_ours(path: Option<&str>) -> bool {
    match path {
        None => true,
        Some(path) => Path::new(path)
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| OWNED_BINARY_NAMES.contains(&name)),
    }
}

/// Decide what the managed registration needs, given the current local Git
/// config. Pure so the legacy/missing/stale/current/partial/foreign matrix is
/// unit-testable without Git or a resolved sidecar binary.
fn classify_registration(
    agent: Option<&str>,
    current_path_is_file: bool,
    legacy_path: Option<&str>,
) -> RepairAction {
    match agent {
        Some(a) if a != TRANSFER_AGENT && a != LEGACY_TRANSFER_AGENT => RepairAction::Foreign,
        Some(a) if a == LEGACY_TRANSFER_AGENT && !legacy_path_is_ours(legacy_path) => {
            RepairAction::Foreign
        }
        Some(a) if a == TRANSFER_AGENT && current_path_is_file && legacy_path.is_none() => {
            RepairAction::None
        }
        _ => RepairAction::Migrate,
    }
}

/// Write Svode's managed LFS S3 custom-transfer registration, pointing Git at
/// `bin`, then remove any superseded legacy `lfs-dal` keys. The caller holds the
/// repository lock. The sidecar path is written and verified *before* the active
/// transfer agent is switched, so a failure never leaves Git pointing at an
/// unverified agent. Only the recognized managed legacy keys are removed; user
/// additions under the legacy agent are left untouched.
pub async fn write_managed_registration(
    cli: &GitCli,
    repo_dir: &Path,
    bin: &Path,
) -> Result<(), LfsError> {
    let bin = bin.canonicalize().unwrap_or_else(|_| bin.to_path_buf());
    if !bin.is_absolute() {
        return Err(LfsError::Storage(format!(
            "svode-lfs path must be absolute: {}",
            bin.display()
        )));
    }
    let bin_str = bin
        .to_str()
        .ok_or_else(|| LfsError::Storage("svode-lfs path must be valid UTF-8".into()))?;

    let path_key = format!("lfs.customtransfer.{TRANSFER_AGENT}.path");
    let concurrent_key = format!("lfs.customtransfer.{TRANSFER_AGENT}.concurrent");
    set_local_config(cli, repo_dir, &path_key, bin_str).await?;
    set_local_config(cli, repo_dir, &concurrent_key, "true").await?;

    // Verify the sidecar path persisted before making it the active agent.
    if read_local_config(cli, repo_dir, &path_key)
        .await?
        .as_deref()
        != Some(bin_str)
    {
        return Err(LfsError::Storage(
            "svode-lfs transfer agent path did not persist".into(),
        ));
    }
    set_local_config(cli, repo_dir, "lfs.standalonetransferagent", TRANSFER_AGENT).await?;

    unset_local_config(
        cli,
        repo_dir,
        &format!("lfs.customtransfer.{LEGACY_TRANSFER_AGENT}.path"),
    )
    .await?;
    unset_local_config(
        cli,
        repo_dir,
        &format!("lfs.customtransfer.{LEGACY_TRANSFER_AGENT}.concurrent"),
    )
    .await?;
    Ok(())
}

/// Remove Svode's managed transfer wiring (current and legacy) without
/// disturbing a third-party standalone agent. The caller holds the repository
/// lock.
pub async fn teardown_managed_registration(cli: &GitCli, repo_dir: &Path) -> Result<(), LfsError> {
    // Only clear the active agent when it is one Svode owns; a foreign
    // standalonetransferagent stays untouched.
    if let Some(agent) = read_local_config(cli, repo_dir, "lfs.standalonetransferagent").await?
        && (agent == TRANSFER_AGENT || agent == LEGACY_TRANSFER_AGENT)
    {
        unset_local_config(cli, repo_dir, "lfs.standalonetransferagent").await?;
    }
    for agent in [TRANSFER_AGENT, LEGACY_TRANSFER_AGENT] {
        unset_local_config(cli, repo_dir, &format!("lfs.customtransfer.{agent}.path")).await?;
        unset_local_config(
            cli,
            repo_dir,
            &format!("lfs.customtransfer.{agent}.concurrent"),
        )
        .await?;
    }
    Ok(())
}

/// Repair Svode's managed LFS S3 transfer registration for an existing
/// repository so Git spawns the current `svode-lfs` sidecar, migrating a
/// previous install's `lfs-dal` registration. Idempotent: a repository already
/// on the current wiring returns [`RegistrationOutcome::Current`] without
/// touching Git config, so a repeat after success is a no-op. A third-party
/// standalone agent or a legacy id pointing at a non-Svode binary is left intact
/// and reported as [`RegistrationOutcome::Foreign`]. The caller must NOT hold
/// the repository lock.
pub async fn repair_managed_registration(
    git: &GitRuntime,
    repo_dir: &Path,
) -> Result<RegistrationOutcome, LfsError> {
    repair_managed_registration_with(git, repo_dir, resolve_agent_binary).await
}

async fn repair_managed_registration_with(
    git: &GitRuntime,
    repo_dir: &Path,
    resolve_bin: impl Fn() -> Result<PathBuf, LfsError>,
) -> Result<RegistrationOutcome, LfsError> {
    let cli = git.require_cli()?;

    // Cheap lock-free read on the common already-current path.
    if inspect_registration(&cli, repo_dir).await? == RepairAction::None {
        return Ok(RegistrationOutcome::Current);
    }

    // A change may be required: serialize with other repository operations and
    // re-classify under the lock to avoid racing a concurrent apply.
    let lock = git.get_lock(repo_dir).await;
    let _guard = lock.lock().await;
    match inspect_registration(&cli, repo_dir).await? {
        RepairAction::None => Ok(RegistrationOutcome::Current),
        RepairAction::Foreign => Ok(RegistrationOutcome::Foreign),
        RepairAction::Migrate => {
            let bin = resolve_bin()?;
            write_managed_registration(&cli, repo_dir, &bin).await?;
            Ok(RegistrationOutcome::Repaired)
        }
    }
}

async fn inspect_registration(cli: &GitCli, repo_dir: &Path) -> Result<RepairAction, LfsError> {
    let agent = read_local_config(cli, repo_dir, "lfs.standalonetransferagent").await?;
    let current_path = read_local_config(
        cli,
        repo_dir,
        &format!("lfs.customtransfer.{TRANSFER_AGENT}.path"),
    )
    .await?;
    let legacy_path = read_local_config(
        cli,
        repo_dir,
        &format!("lfs.customtransfer.{LEGACY_TRANSFER_AGENT}.path"),
    )
    .await?;
    let current_path_is_file = current_path
        .as_deref()
        .is_some_and(|path| Path::new(path).is_file());
    Ok(classify_registration(
        agent.as_deref(),
        current_path_is_file,
        legacy_path.as_deref(),
    ))
}

/// Resolve the `svode-lfs` sidecar binary on disk. Looks first next to the
/// running executable (the Desktop bundle and the standalone `svode` and
/// `svode-mcp` binaries ship it side by side), then falls back to the
/// `apps/desktop/src-tauri/binaries/svode-lfs-<triple>` artifact written by
/// `scripts/build-svode-lfs.mjs` (dev mode), and finally to the shared Cargo
/// workspace output. Returns an absolute path so git's
/// `lfs.customtransfer.svode-lfs.path` config never relies on cwd.
pub fn resolve_agent_binary() -> Result<PathBuf, LfsError> {
    let workspace_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut candidates = Vec::new();

    // 1. Bundled sidecar — Tauri places externalBin next to the host binary
    //    after stripping the target-triple suffix, so a plain `svode-lfs[.exe]`
    //    in the same directory wins for production builds.
    if let Ok(exe) = std::env::current_exe()
        && let Some(parent) = exe.parent()
    {
        for name in plain_names() {
            candidates.push(parent.join(name));
        }
    }

    // 2. Dev mode — the build script copies a triple-suffixed artifact to the
    //    Desktop `binaries/` directory.
    let triple = std::env::var("TARGET").ok().or_else(rustc_host_triple);
    if let Some(triple) = triple.as_deref() {
        for name in suffixed_names(triple) {
            candidates.push(
                workspace_dir
                    .join("apps/desktop/src-tauri/binaries")
                    .join(name),
            );
        }
    }

    // 3. Last-ditch dev fallback for direct Cargo builds in the shared workspace.
    let target_dir = std::env::var_os("CARGO_TARGET_DIR")
        .filter(|value| PathBuf::from(value).is_absolute())
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace_dir.join("target"));
    for profile in ["lfs-release", "release", "debug"] {
        for name in plain_names() {
            candidates.push(target_dir.join(profile).join(&name));
            if let Some(triple) = triple.as_deref() {
                candidates.push(target_dir.join(triple).join(profile).join(&name));
            }
        }
    }

    for candidate in candidates {
        if !candidate.exists() {
            continue;
        }
        let absolute = candidate.canonicalize().map_err(|e| {
            LfsError::Storage(format!(
                "svode-lfs binary path could not be canonicalized ({}): {e}",
                candidate.display()
            ))
        })?;
        validate_agent_binary(&absolute)?;
        return Ok(absolute);
    }

    Err(LfsError::Storage(
        "svode-lfs binary not found — run `bun run build:svode-lfs` or rebuild the app bundle"
            .into(),
    ))
}

fn plain_names() -> Vec<String> {
    plain_names_for(cfg!(windows))
}

fn plain_names_for(windows: bool) -> Vec<String> {
    if windows {
        vec!["svode-lfs.exe".to_string(), "svode-lfs".to_string()]
    } else {
        vec!["svode-lfs".to_string()]
    }
}

fn suffixed_names(triple: &str) -> Vec<String> {
    suffixed_names_for(triple, cfg!(windows))
}

fn suffixed_names_for(triple: &str, windows: bool) -> Vec<String> {
    if windows {
        vec![
            format!("svode-lfs-{triple}.exe"),
            format!("svode-lfs-{triple}"),
        ]
    } else {
        vec![format!("svode-lfs-{triple}")]
    }
}

fn validate_agent_binary(path: &Path) -> Result<(), LfsError> {
    if !path.is_absolute() {
        return Err(LfsError::Storage(format!(
            "svode-lfs binary path must be absolute: {}",
            path.display()
        )));
    }
    if !path.is_file() {
        return Err(LfsError::Storage(format!(
            "svode-lfs binary is not a file: {}",
            path.display()
        )));
    }
    validate_agent_binary_executable(path)
}

#[cfg(target_os = "linux")]
fn validate_agent_binary_executable(path: &Path) -> Result<(), LfsError> {
    use std::os::unix::fs::PermissionsExt;

    let mode = std::fs::metadata(path)
        .map_err(|error| LfsError::Storage(error.to_string()))?
        .permissions()
        .mode();
    if mode & 0o111 == 0 {
        return Err(LfsError::Storage(format!(
            "svode-lfs binary is not executable: {}",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn validate_agent_binary_executable(_path: &Path) -> Result<(), LfsError> {
    Ok(())
}

/// Cheap shell-out to ask rustc for the host triple. The resolver runs only
/// for managed readiness/setup, so the process is spawned each time.
fn rustc_host_triple() -> Option<String> {
    let mut cmd = Command::new("rustc");
    hide_window(&mut cmd);
    let out = cmd.arg("-vV").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8(out.stdout).ok()?;
    s.lines()
        .find_map(|l| l.strip_prefix("host:").map(|v| v.trim().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::config::AssetsS3Config;

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    #[test]
    fn remote_probe_uses_supported_fetch_dry_run_command() {
        assert_eq!(REMOTE_PROBE_ARGS, &["lfs", "fetch", "--dry-run", "origin"]);
    }

    #[test]
    fn svode_lfs_names_include_windows_exe_fallbacks() {
        assert_eq!(
            plain_names_for(true),
            vec!["svode-lfs.exe".to_string(), "svode-lfs".to_string()]
        );
        assert_eq!(
            suffixed_names_for("x86_64-pc-windows-msvc", true),
            vec![
                "svode-lfs-x86_64-pc-windows-msvc.exe".to_string(),
                "svode-lfs-x86_64-pc-windows-msvc".to_string(),
            ]
        );
    }

    #[test]
    fn svode_lfs_names_use_plain_unix_binary_names() {
        assert_eq!(plain_names_for(false), vec!["svode-lfs".to_string()]);
        assert_eq!(
            suffixed_names_for("aarch64-apple-darwin", false),
            vec!["svode-lfs-aarch64-apple-darwin".to_string()]
        );
    }

    #[test]
    fn classify_registration_covers_wiring_matrix() {
        // Current wiring: svode-lfs agent, its binary on disk, no legacy keys.
        assert_eq!(
            classify_registration(Some("svode-lfs"), true, None),
            RepairAction::None
        );
        // Stale path: svode-lfs agent but its recorded binary is gone.
        assert_eq!(
            classify_registration(Some("svode-lfs"), false, None),
            RepairAction::Migrate
        );
        // Partially repaired: current agent/path but a legacy key still lingers.
        assert_eq!(
            classify_registration(Some("svode-lfs"), true, Some("/old/lfs-dal")),
            RepairAction::Migrate
        );
        // Legacy Svode registration (path is our own binary, or absent).
        assert_eq!(
            classify_registration(Some("lfs-dal"), false, Some("/old/Svode.app/lfs-dal")),
            RepairAction::Migrate
        );
        assert_eq!(
            classify_registration(Some("lfs-dal"), false, None),
            RepairAction::Migrate
        );
        // No registration at all.
        assert_eq!(
            classify_registration(None, false, None),
            RepairAction::Migrate
        );
        // Foreign standalone agent, or a legacy id pointing at a foreign binary.
        assert_eq!(
            classify_registration(Some("vendor-agent"), false, None),
            RepairAction::Foreign
        );
        assert_eq!(
            classify_registration(Some("lfs-dal"), false, Some("/opt/vendor/transfer")),
            RepairAction::Foreign
        );
    }

    #[test]
    fn legacy_path_ownership_requires_svode_binary_name() {
        assert!(legacy_path_is_ours(None));
        assert!(legacy_path_is_ours(Some(
            "/Applications/Svode.app/Contents/MacOS/lfs-dal"
        )));
        assert!(legacy_path_is_ours(Some("/dev/target/debug/svode-lfs")));
        assert!(!legacy_path_is_ours(Some("/opt/vendor/transfer")));
        assert!(!legacy_path_is_ours(Some("/usr/local/bin/git-lfs")));
    }

    fn make_fake_binary(dir: &Path, name: &str) -> Result<PathBuf, std::io::Error> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join(name);
        std::fs::write(&path, b"#!/bin/sh\n")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&path)?.permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&path, perms)?;
        }
        Ok(path)
    }

    async fn git_ok(cli: &GitCli, repo: &Path, args: &[&str]) -> TestResult {
        let out = cli.exec(repo, args).await?;
        assert_eq!(out.exit_code, 0, "git {args:?}: {}", out.stderr);
        Ok(())
    }

    async fn git_stdout(cli: &GitCli, repo: &Path, args: &[&str]) -> Result<String, GitError> {
        let out = cli.exec(repo, args).await?;
        assert_eq!(out.exit_code, 0, "git {args:?}: {}", out.stderr);
        Ok(out.stdout.trim().to_string())
    }

    async fn config_exit(cli: &GitCli, repo: &Path, key: &str) -> Result<i32, GitError> {
        Ok(cli
            .exec(repo, &["config", "--local", "--get", key])
            .await?
            .exit_code)
    }

    async fn init_repo(cli: &GitCli, repo: &Path) -> TestResult {
        std::fs::create_dir_all(repo)?;
        git_ok(cli, repo, &["init", "-q"]).await
    }

    #[tokio::test]
    async fn repair_migrates_legacy_registration_and_is_idempotent() -> TestResult {
        let git = GitRuntime::new();
        let Some(cli) = git.detected() else {
            return Ok(());
        };
        let temp = tempfile::tempdir()?;
        let repo = temp.path().join("repo");
        init_repo(cli, &repo).await?;
        let bin = make_fake_binary(&temp.path().join("bin"), "svode-lfs")?;
        let legacy_bin = make_fake_binary(&temp.path().join("old"), "lfs-dal")?;

        for (key, value) in [
            ("lfs.standalonetransferagent", "lfs-dal"),
            (
                "lfs.customtransfer.lfs-dal.path",
                legacy_bin.to_str().unwrap(),
            ),
            ("lfs.customtransfer.lfs-dal.concurrent", "true"),
            // A user addition under the legacy agent must survive migration.
            ("lfs.customtransfer.lfs-dal.args", "--keep"),
        ] {
            git_ok(cli, &repo, &["config", "--local", key, value]).await?;
        }

        let resolved = bin.clone();
        let outcome =
            repair_managed_registration_with(&git, &repo, || Ok(resolved.clone())).await?;
        assert_eq!(outcome, RegistrationOutcome::Repaired);

        let expected = bin.canonicalize()?;
        assert_eq!(
            git_stdout(
                cli,
                &repo,
                &["config", "--local", "--get", "lfs.standalonetransferagent"]
            )
            .await?,
            "svode-lfs"
        );
        assert_eq!(
            git_stdout(
                cli,
                &repo,
                &[
                    "config",
                    "--local",
                    "--get",
                    "lfs.customtransfer.svode-lfs.path"
                ]
            )
            .await?,
            expected.to_str().unwrap()
        );
        assert_eq!(
            config_exit(cli, &repo, "lfs.customtransfer.lfs-dal.path").await?,
            1
        );
        // User-added extra key under the legacy agent is preserved.
        assert_eq!(
            git_stdout(
                cli,
                &repo,
                &[
                    "config",
                    "--local",
                    "--get",
                    "lfs.customtransfer.lfs-dal.args"
                ]
            )
            .await?,
            "--keep"
        );

        // Repeat after success must not touch config or resolve a binary again.
        let again = repair_managed_registration_with(&git, &repo, || {
            panic!("resolver must not run on the already-current path")
        })
        .await?;
        assert_eq!(again, RegistrationOutcome::Current);
        Ok(())
    }

    #[tokio::test]
    async fn repair_rewrites_stale_current_path() -> TestResult {
        let git = GitRuntime::new();
        let Some(cli) = git.detected() else {
            return Ok(());
        };
        let temp = tempfile::tempdir()?;
        let repo = temp.path().join("repo");
        init_repo(cli, &repo).await?;
        let bin = make_fake_binary(&temp.path().join("bin"), "svode-lfs")?;

        for (key, value) in [
            ("lfs.standalonetransferagent", "svode-lfs"),
            (
                "lfs.customtransfer.svode-lfs.path",
                "/nonexistent/previous/svode-lfs",
            ),
        ] {
            git_ok(cli, &repo, &["config", "--local", key, value]).await?;
        }

        let resolved = bin.clone();
        let outcome =
            repair_managed_registration_with(&git, &repo, || Ok(resolved.clone())).await?;
        assert_eq!(outcome, RegistrationOutcome::Repaired);
        assert_eq!(
            git_stdout(
                cli,
                &repo,
                &[
                    "config",
                    "--local",
                    "--get",
                    "lfs.customtransfer.svode-lfs.path"
                ]
            )
            .await?,
            bin.canonicalize()?.to_str().unwrap()
        );
        Ok(())
    }

    #[tokio::test]
    async fn repair_leaves_foreign_configuration_untouched() -> TestResult {
        let git = GitRuntime::new();
        let Some(cli) = git.detected() else {
            return Ok(());
        };
        let temp = tempfile::tempdir()?;
        let repo = temp.path().join("repo");
        init_repo(cli, &repo).await?;

        for (key, value) in [
            ("lfs.standalonetransferagent", "vendor-agent"),
            (
                "lfs.customtransfer.vendor-agent.path",
                "/opt/vendor/transfer",
            ),
        ] {
            git_ok(cli, &repo, &["config", "--local", key, value]).await?;
        }

        let outcome = repair_managed_registration_with(&git, &repo, || {
            panic!("resolver must not run for a foreign configuration")
        })
        .await?;
        assert_eq!(outcome, RegistrationOutcome::Foreign);

        assert_eq!(
            git_stdout(
                cli,
                &repo,
                &["config", "--local", "--get", "lfs.standalonetransferagent"]
            )
            .await?,
            "vendor-agent"
        );
        assert_eq!(
            config_exit(cli, &repo, "lfs.customtransfer.svode-lfs.path").await?,
            1
        );
        Ok(())
    }

    #[tokio::test]
    async fn teardown_removes_own_wiring_but_keeps_foreign_agent() -> TestResult {
        let git = GitRuntime::new();
        let Some(cli) = git.detected() else {
            return Ok(());
        };
        let temp = tempfile::tempdir()?;
        let repo = temp.path().join("repo");
        init_repo(cli, &repo).await?;

        for (key, value) in [
            ("lfs.standalonetransferagent", "vendor-agent"),
            (
                "lfs.customtransfer.vendor-agent.path",
                "/opt/vendor/transfer",
            ),
            ("lfs.customtransfer.svode-lfs.path", "/dev/svode-lfs"),
            ("lfs.customtransfer.lfs-dal.path", "/old/lfs-dal"),
        ] {
            git_ok(cli, &repo, &["config", "--local", key, value]).await?;
        }

        {
            let lock = git.get_lock(&repo).await;
            let _guard = lock.lock().await;
            teardown_managed_registration(cli, &repo).await?;
        }

        // Foreign active agent and its config remain.
        assert_eq!(
            git_stdout(
                cli,
                &repo,
                &["config", "--local", "--get", "lfs.standalonetransferagent"]
            )
            .await?,
            "vendor-agent"
        );
        assert_eq!(
            git_stdout(
                cli,
                &repo,
                &[
                    "config",
                    "--local",
                    "--get",
                    "lfs.customtransfer.vendor-agent.path"
                ]
            )
            .await?,
            "/opt/vendor/transfer"
        );
        // Svode's own keys are gone.
        for key in [
            "lfs.customtransfer.svode-lfs.path",
            "lfs.customtransfer.lfs-dal.path",
        ] {
            assert_eq!(config_exit(cli, &repo, key).await?, 1);
        }
        Ok(())
    }

    #[tokio::test]
    async fn repair_does_not_declare_or_commit_for_existing_lfs_s3_owner() -> TestResult {
        let git = GitRuntime::new();
        let Some(cli) = git.detected() else {
            return Ok(());
        };
        let temp = tempfile::tempdir()?;
        let repo = temp.path().join("repo");
        init_repo(cli, &repo).await?;
        git_ok(cli, &repo, &["config", "user.email", "test@example.com"]).await?;
        git_ok(cli, &repo, &["config", "user.name", "Svode Test"]).await?;
        std::fs::write(repo.join("README.md"), "# Project\n")?;
        git_ok(cli, &repo, &["add", "README.md"]).await?;
        git_ok(cli, &repo, &["commit", "-q", "-m", "Initial commit"]).await?;
        let head = git_stdout(cli, &repo, &["rev-parse", "HEAD"]).await?;
        let bin = make_fake_binary(&temp.path().join("bin"), "svode-lfs")?;

        let outcome = repair_managed_registration_with(&git, &repo, || Ok(bin.clone())).await?;
        assert_eq!(outcome, RegistrationOutcome::Repaired);
        assert!(!repo.join(".lfsconfig").exists());
        assert_eq!(git_stdout(cli, &repo, &["rev-parse", "HEAD"]).await?, head);
        Ok(())
    }

    fn s3_config() -> AssetsSpaceConfig {
        AssetsSpaceConfig {
            strategy: AssetsStrategy::LfsS3,
            s3: Some(AssetsS3Config {
                endpoint: "https://s3.example.test".into(),
                bucket: "bucket".into(),
                region: "us-east-1".into(),
                prefix: "project".into(),
            }),
            ..AssetsSpaceConfig::default()
        }
    }

    #[tokio::test]
    async fn readiness_needs_no_lfs_for_local_routes_and_evidence_for_lfs_routes() -> TestResult {
        let git = GitRuntime::new();
        let temp = tempfile::tempdir()?;
        let repo = temp.path();
        for strategy in [AssetsStrategy::Local, AssetsStrategy::InGit] {
            let config = AssetsSpaceConfig {
                strategy,
                ..AssetsSpaceConfig::default()
            };
            assert_eq!(
                probe_readiness(&git, repo, &config).await,
                LfsState::NotApplicable
            );
            assert!(!git.lfs_ready(repo, &config).await);
        }

        // S3 without a saved agent config for this target is not ready and
        // touches no Git config.
        assert_eq!(
            probe_readiness(&git, repo, &s3_config()).await,
            LfsState::MissingCreds
        );
        let mut without_target = s3_config();
        without_target.s3 = None;
        assert_eq!(
            probe_readiness(&git, repo, &without_target).await,
            LfsState::MissingCreds
        );

        // A remote route without Git, or without a reachable origin, is not ready.
        let remote = AssetsSpaceConfig {
            strategy: AssetsStrategy::LfsRemote,
            ..AssetsSpaceConfig::default()
        };
        assert_eq!(
            probe_readiness(&GitRuntime::without_cli(), repo, &remote).await,
            LfsState::MissingCreds
        );
        if let Some(cli) = git.detected() {
            init_repo(cli, repo).await?;
            assert_eq!(
                probe_readiness(&git, repo, &remote).await,
                LfsState::MissingCreds
            );
        }
        Ok(())
    }

    #[test]
    fn a_saved_agent_config_serves_only_its_s3_target() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path();
        let Some(target) = s3_config().s3 else {
            unreachable!()
        };
        assert!(AgentConfig::read_for_target(repo, &target).is_err());
    }
}

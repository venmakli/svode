//! Connection of this device to the S3 storage of a storage scope that uses
//! the `lfs-s3` strategy, and the reasons a Git LFS route is not ready.
//!
//! The S3 address of the scope comes with the repository; the local agent
//! config (`.svode/lfs-s3-agent.json`), the Secrets it binds and the
//! `svode-lfs` registration in Git belong to the device. Every host reads
//! the same diagnosis: the CLI shows it as `svode storage status`, a managed
//! import refuses with it and the sidecar answers its `init` with it.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::config::{AssetsS3Config, AssetsSpaceConfig, AssetsStrategy};
use super::lfs::{
    LfsState, REMOTE_PROBE_ARGS, RepairAction, inspect_registration, repair_managed_registration,
    resolve_agent_binary, write_managed_registration,
};
use super::s3::{AgentConfig, CONFIG_REL, SecretBindings, SecretFailure, check_connection};
use super::strategy::{
    self, StrategyError, StrategyRequest, StrategyScope, StrategyWarning, shown_binary_routing,
};
use crate::git::GitError;
use crate::git::autocommit::SystemCommitKind;
use crate::git::cli::GitCli;
use crate::git::state::GitRuntime;
use crate::variables::DeviceSecretStore;

pub const S3_NOT_CONNECTED: &str = "S3_NOT_CONNECTED";
pub const STORAGE_STRATEGY_MISMATCH: &str = "STORAGE_STRATEGY_MISMATCH";
pub const S3_CHECK_FAILED: &str = "S3_CHECK_FAILED";
pub const LFS_TOOLING_UNAVAILABLE: &str = "LFS_TOOLING_UNAVAILABLE";

const CONNECT_STEP: &str = "run `svode storage s3 connect --access-key <NAME> --secret-key <NAME>`";
const ENABLE_STEP: &str = "run `svode storage s3 enable --endpoint <URL> --bucket <NAME> --region <NAME> --access-key <NAME> --secret-key <NAME>`";

/// Git LFS hooks `git lfs install --local` writes.
const LFS_HOOKS: [&str; 4] = ["pre-push", "post-checkout", "post-commit", "post-merge"];

/// Why the Git LFS route of a storage scope cannot transfer files on this
/// device. Messages and next steps never contain a Secret value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LfsNotReady {
    /// The scope uses another strategy than `lfs-s3`.
    StrategyMismatch { strategy: String },
    /// The scope uses `lfs-s3` without an S3 address.
    S3AddressMissing,
    /// This device has no agent config for the S3 address of the scope, or
    /// `svode-lfs` is not registered in Git.
    S3NotConnected { detail: Option<String> },
    /// A Secret of the S3 bindings cannot be read.
    Secret(SecretFailure),
    /// The S3 check with the bound credentials failed.
    S3CheckFailed { detail: String },
    /// `git-lfs` or `svode-lfs` is missing.
    LfsToolingUnavailable { detail: String },
    /// The Git LFS server of `origin` is not reachable (`lfs-remote`).
    RemoteUnreachable,
}

impl LfsNotReady {
    /// Stable code of the refusal; `None` for a reason without one.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            Self::StrategyMismatch { .. } | Self::S3AddressMissing => {
                Some(STORAGE_STRATEGY_MISMATCH)
            }
            Self::S3NotConnected { .. } => Some(S3_NOT_CONNECTED),
            Self::Secret(failure) => failure.error.secret_code(),
            Self::S3CheckFailed { .. } => Some(S3_CHECK_FAILED),
            Self::LfsToolingUnavailable { .. } => Some(LFS_TOOLING_UNAVAILABLE),
            Self::RemoteUnreachable => None,
        }
    }

    /// Next step of the refusal.
    pub fn hint(&self) -> Option<String> {
        match self {
            Self::StrategyMismatch { strategy } => Some(format!(
                "{ENABLE_STEP}, or keep the strategy `{strategy}` the project chose"
            )),
            Self::S3AddressMissing => Some(ENABLE_STEP.to_string()),
            Self::S3NotConnected { .. } => Some(CONNECT_STEP.to_string()),
            Self::Secret(failure) => failure
                .error
                .secret_hint(&failure.file, Some(&failure.name)),
            Self::S3CheckFailed { .. } => Some(
                "check the endpoint, bucket and region of the project and that the key may write, read and delete objects in the bucket"
                    .to_string(),
            ),
            Self::LfsToolingUnavailable { .. } => {
                Some("install git-lfs, or reinstall Svode to restore svode-lfs".to_string())
            }
            Self::RemoteUnreachable => None,
        }
    }

    /// Refusal text of a managed import, which keeps `Git LFS route is not
    /// ready` and adds the reason.
    pub fn import_message(&self) -> String {
        match self {
            Self::RemoteUnreachable => {
                "Git LFS route is not ready; repair the configured backend before importing"
                    .to_string()
            }
            reason => format!("Git LFS route is not ready: {reason}"),
        }
    }
}

impl std::fmt::Display for LfsNotReady {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::StrategyMismatch { strategy } => write!(
                f,
                "the storage strategy of the project is `{strategy}`, not `lfs-s3`"
            ),
            Self::S3AddressMissing => {
                f.write_str("the project uses `lfs-s3` without an S3 address")
            }
            Self::S3NotConnected { detail: None } => {
                f.write_str("this device is not connected to the S3 storage of the project")
            }
            Self::S3NotConnected {
                detail: Some(detail),
            } => write!(
                f,
                "this device is not connected to the S3 storage of the project: {detail}"
            ),
            Self::Secret(failure) => write!(f, "Secret {}: {}", failure.name, failure.error),
            Self::S3CheckFailed { detail } => write!(f, "the S3 check failed: {detail}"),
            Self::LfsToolingUnavailable { detail } => f.write_str(detail),
            Self::RemoteUnreachable => {
                f.write_str("the Git LFS server of `origin` is not reachable")
            }
        }
    }
}

impl std::error::Error for LfsNotReady {}

fn tooling(detail: impl std::fmt::Display) -> LfsNotReady {
    LfsNotReady::LfsToolingUnavailable {
        detail: detail.to_string(),
    }
}

/// Git with Git LFS, or the refusal that names the missing tool.
fn lfs_cli(git: &GitRuntime) -> Result<&GitCli, LfsNotReady> {
    let cli = git
        .detected()
        .ok_or_else(|| tooling("Git is not installed"))?;
    if !cli.lfs_available() {
        return Err(tooling("git-lfs is not installed"));
    }
    Ok(cli)
}

/// The agent config of `repo` for `target` and its credentials resolve.
async fn connected_config(repo: &Path, target: &AssetsS3Config) -> Result<(), LfsNotReady> {
    let repo = repo.to_path_buf();
    let target = target.clone();
    tokio::task::spawn_blocking(move || {
        let config = AgentConfig::read_for_target(&repo, &target)
            .map_err(|_| LfsNotReady::S3NotConnected { detail: None })?;
        config.resolve_or_refuse().map_err(LfsNotReady::Secret)?;
        Ok(())
    })
    .await
    .unwrap_or_else(|error| {
        Err(LfsNotReady::S3NotConnected {
            detail: Some(format!("the check did not finish: {error}")),
        })
    })
}

/// Git LFS readiness of the assets strategy `config` of `repo_dir`:
/// `NotApplicable` without Git LFS, `Ready`, or the reason it is not ready.
/// With `repair` a missing or stale `svode-lfs` registration of a connected
/// `lfs-s3` scope is repaired, as a managed import does before routing a
/// file; without it the check writes nothing.
pub async fn check_readiness(
    git: &GitRuntime,
    repo_dir: &Path,
    config: &AssetsSpaceConfig,
    repair: bool,
) -> Result<LfsState, LfsNotReady> {
    match config.strategy {
        // An unknown strategy gets no LFS readiness check or repair.
        AssetsStrategy::Local | AssetsStrategy::InGit | AssetsStrategy::Unknown(_) => {
            Ok(LfsState::NotApplicable)
        }
        AssetsStrategy::LfsS3 => {
            let target = config.s3.as_ref().ok_or(LfsNotReady::S3AddressMissing)?;
            let cli = lfs_cli(git)?;
            connected_config(repo_dir, target).await?;
            if repair {
                // A repair failure must not be reported as a ready S3
                // strategy.
                return match repair_managed_registration(git, repo_dir).await {
                    Ok(_) => Ok(LfsState::Ready),
                    Err(error) => {
                        tracing::warn!("svode-lfs registration repair failed: {error}");
                        Err(match resolve_agent_binary() {
                            Err(missing) => tooling(missing),
                            Ok(_) => LfsNotReady::S3NotConnected {
                                detail: Some(format!(
                                    "svode-lfs cannot be registered in Git: {error}"
                                )),
                            },
                        })
                    }
                };
            }
            match inspect_registration(cli, repo_dir).await {
                Ok(RepairAction::None | RepairAction::Foreign) => Ok(LfsState::Ready),
                Ok(RepairAction::Migrate) => Err(match resolve_agent_binary() {
                    Err(missing) => tooling(missing),
                    Ok(_) => LfsNotReady::S3NotConnected {
                        detail: Some("svode-lfs is not registered in Git".to_string()),
                    },
                }),
                Err(error) => Err(LfsNotReady::S3NotConnected {
                    detail: Some(error.to_string()),
                }),
            }
        }
        AssetsStrategy::LfsRemote => {
            let cli = lfs_cli(git)?;
            match cli.exec(repo_dir, REMOTE_PROBE_ARGS).await {
                Ok(out) if out.exit_code == 0 => Ok(LfsState::Ready),
                _ => Err(LfsNotReady::RemoteUnreachable),
            }
        }
    }
}

/// Storage state of a scope on this device, read without writing anything.
#[derive(Debug, Clone)]
pub struct StorageStatus {
    pub strategy: AssetsStrategy,
    /// S3 address of the scope, from its `.svode/config.json`.
    pub s3: Option<AssetsS3Config>,
    /// Secret names the agent config of this device binds for that address.
    pub bindings: Option<SecretBindings>,
    pub lfs: LfsState,
    /// Why the Git LFS route is not ready, with the next step.
    pub problem: Option<LfsNotReady>,
}

pub async fn status(
    git: &GitRuntime,
    repo_dir: &Path,
    config: &AssetsSpaceConfig,
) -> StorageStatus {
    let bindings = match (&config.strategy, &config.s3) {
        (AssetsStrategy::LfsS3, Some(target)) => {
            let repo = repo_dir.to_path_buf();
            let target = target.clone();
            tokio::task::spawn_blocking(move || {
                AgentConfig::read_for_target(&repo, &target)
                    .ok()
                    .map(|config| config.bindings)
            })
            .await
            .ok()
            .flatten()
        }
        _ => None,
    };
    let (lfs, problem) = match check_readiness(git, repo_dir, config, false).await {
        Ok(state) => (state, None),
        Err(problem) => (LfsState::MissingCreds, Some(problem)),
    };
    StorageStatus {
        strategy: config.strategy.clone(),
        s3: config.s3.clone(),
        bindings,
        lfs,
        problem,
    }
}

/// Connection of this device to the S3 storage of one scope.
pub struct ConnectRequest<'a> {
    /// Device config directory: the Variables catalog and the device store
    /// the agent config names as its `globalDirectory`.
    pub catalog_dir: &'a Path,
    /// Variables context of the bindings.
    pub project_path: &'a Path,
    pub space_id: Option<&'a str>,
    /// Repository of the storage scope.
    pub repo_dir: &'a Path,
    /// Assets configuration of the storage scope.
    pub config: &'a AssetsSpaceConfig,
    pub bindings: SecretBindings,
}

#[derive(Debug)]
pub struct Connected {
    pub config: AgentConfig,
    /// Absolute paths of the files the connection changed, in path order.
    pub changed: Vec<PathBuf>,
}

#[derive(Debug, thiserror::Error)]
pub enum ConnectError {
    #[error("{0}")]
    NotReady(LfsNotReady),
    #[error(transparent)]
    Git(#[from] GitError),
    /// The strategy change is refused or its apply failed.
    #[error(transparent)]
    Strategy(#[from] StrategyError),
    #[error("{0}")]
    Storage(String),
}

impl From<LfsNotReady> for ConnectError {
    fn from(reason: LfsNotReady) -> Self {
        Self::NotReady(reason)
    }
}

/// A connection whose checks passed; nothing is written yet.
struct PreparedConnection {
    cli: GitCli,
    agent: AgentConfig,
    agent_binary: PathBuf,
    catalog_dir: PathBuf,
    repo_dir: PathBuf,
}

/// Every check of a connection, before its first write: the strategy and
/// S3 address of the scope, `git-lfs` and `svode-lfs`, both bound Secrets
/// and a probe object written, read and deleted with them.
async fn prepare(
    git: &GitRuntime,
    request: ConnectRequest<'_>,
) -> Result<PreparedConnection, ConnectError> {
    let ConnectRequest {
        catalog_dir,
        project_path,
        space_id,
        repo_dir,
        config,
        bindings,
    } = request;
    if config.strategy != AssetsStrategy::LfsS3 {
        return Err(LfsNotReady::StrategyMismatch {
            strategy: config.strategy.as_str().to_string(),
        }
        .into());
    }
    let target = config.s3.as_ref().ok_or(LfsNotReady::S3AddressMissing)?;
    let cli = lfs_cli(git)?.clone();
    let agent_binary = resolve_agent_binary().map_err(tooling)?;

    let agent = AgentConfig::for_target(catalog_dir, project_path, space_id, target, bindings);
    let credentials = {
        let agent = agent.clone();
        tokio::task::spawn_blocking(move || agent.resolve_or_refuse())
            .await
            .map_err(|error| ConnectError::Storage(format!("S3 Secrets task failed: {error}")))?
            .map_err(LfsNotReady::Secret)?
    };
    check_connection(
        &target.endpoint,
        &target.bucket,
        &target.region,
        &credentials,
    )
    .await
    .map_err(|detail| LfsNotReady::S3CheckFailed { detail })?;
    drop(credentials);
    Ok(PreparedConnection {
        cli,
        agent,
        agent_binary,
        catalog_dir: catalog_dir.to_path_buf(),
        repo_dir: repo_dir.to_path_buf(),
    })
}

impl PreparedConnection {
    /// Register `svode-lfs` in Git and publish the agent config.
    async fn finish(self, git: &GitRuntime) -> Result<AgentConfig, ConnectError> {
        let Self {
            cli,
            agent,
            agent_binary,
            catalog_dir,
            repo_dir,
        } = self;
        {
            let lock = git.get_lock(&repo_dir).await;
            let _guard = lock.lock().await;
            crate::git::ops::ensure_svode_gitignore(&repo_dir)?;
            let installed = cli.exec(&repo_dir, &["lfs", "install", "--local"]).await?;
            if installed.exit_code != 0 {
                return Err(tooling(format!(
                    "git lfs install failed: {}",
                    installed.stderr.trim()
                ))
                .into());
            }
            if inspect_registration(&cli, &repo_dir)
                .await
                .map_err(|error| ConnectError::Storage(error.to_string()))?
                != RepairAction::None
            {
                write_managed_registration(&cli, &repo_dir, &agent_binary)
                    .await
                    .map_err(|error| ConnectError::Storage(error.to_string()))?;
            }
        }
        let published = agent.clone();
        tokio::task::spawn_blocking(move || {
            published.publish(
                &catalog_dir,
                &repo_dir,
                &DeviceSecretStore::new(&catalog_dir),
            )
        })
        .await
        .map_err(|error| ConnectError::Storage(format!("S3 config task failed: {error}")))?
        .map_err(ConnectError::Storage)?;
        Ok(agent)
    }
}

/// Connect this device to the S3 storage of a scope that already uses
/// `lfs-s3`: both bound Secrets resolve, a probe object is written, read and
/// deleted with them, then `svode-lfs` is registered in Git and the agent
/// config is published. Every check runs before the first write, so a
/// refusal leaves the previous setup as it was; a repeat with the same data
/// changes no file. Nothing is committed.
pub async fn connect(
    git: &GitRuntime,
    request: ConnectRequest<'_>,
) -> Result<Connected, ConnectError> {
    let (repo_dir, catalog_dir) = (request.repo_dir, request.catalog_dir);
    let prepared = prepare(git, request).await?;
    let watched = watched_files(&prepared.cli, repo_dir, catalog_dir, &[]).await?;
    let before = snapshot(&watched);
    let config = prepared.finish(git).await?;
    Ok(Connected {
        config,
        changed: changed(watched, &before),
    })
}

/// Enabling of `lfs-s3` in a storage scope from this device.
pub struct EnableRequest<'a> {
    /// Device config directory, as in [`ConnectRequest`].
    pub catalog_dir: &'a Path,
    /// Variables context of the bindings.
    pub project_path: &'a Path,
    pub space_id: Option<&'a str>,
    /// Repository of the storage scope.
    pub repo_dir: &'a Path,
    pub scope: StrategyScope<'a>,
    /// Current assets configuration of the scope; its binary routing is
    /// kept as the storage settings show it.
    pub current: &'a AssetsSpaceConfig,
    /// S3 address; an empty prefix takes the default of the scope.
    pub target: AssetsS3Config,
    pub bindings: SecretBindings,
}

#[derive(Debug)]
pub struct Enabled {
    /// The assets section written to `.svode/config.json`.
    pub assets: AssetsSpaceConfig,
    pub config: AgentConfig,
    /// Warnings of the strategy apply, as the desktop app reports them.
    pub warnings: Vec<StrategyWarning>,
    /// Absolute paths of the files the change wrote, in path order.
    pub changed: Vec<PathBuf>,
}

/// Enable `lfs-s3` in a storage scope and connect this device to it. The
/// strategy change passes the transition rule of the desktop app and the
/// connection passes every check of [`connect`] before the first write; the
/// strategy is then applied as the desktop app applies it (managed files,
/// then `.svode/config.json`) and the device is connected. Nothing is
/// committed; a repeat with the same data changes no file.
pub async fn enable(git: &GitRuntime, request: EnableRequest<'_>) -> Result<Enabled, ConnectError> {
    let EnableRequest {
        catalog_dir,
        project_path,
        space_id,
        repo_dir,
        scope,
        current,
        target,
        bindings,
    } = request;
    let planned = strategy::plan(
        scope,
        StrategyRequest {
            strategy: AssetsStrategy::LfsS3,
            binary_routing: shown_binary_routing(current),
            s3: Some(target),
        },
    )?;
    let assets = planned.assets().clone();
    let prepared = prepare(
        git,
        ConnectRequest {
            catalog_dir,
            project_path,
            space_id,
            repo_dir,
            config: &assets,
            bindings,
        },
    )
    .await?;
    let strategy_files = SystemCommitKind::AssetsStrategy
        .paths()
        .iter()
        .map(|path| repo_dir.join(path))
        .collect::<Vec<_>>();
    let watched = watched_files(&prepared.cli, repo_dir, catalog_dir, &strategy_files).await?;
    let before = snapshot(&watched);
    let applied = planned
        .apply(git, repo_dir, Some(&prepared.agent_binary))
        .await?;
    let config = prepared.finish(git).await?;
    Ok(Enabled {
        assets,
        config,
        warnings: applied.warnings,
        changed: changed(watched, &before),
    })
}

/// Files a connection may change: the agent config and `.gitignore` of the
/// repository, its Git config and Git LFS hooks, and the device settings
/// that list S3 owners, with the `extra` files of the caller.
async fn watched_files(
    cli: &GitCli,
    repo_dir: &Path,
    catalog_dir: &Path,
    extra: &[PathBuf],
) -> Result<Vec<PathBuf>, GitError> {
    let mut files = vec![
        repo_dir.join(CONFIG_REL),
        repo_dir.join(".gitignore"),
        catalog_dir.join("settings.json"),
    ];
    files.extend_from_slice(extra);
    if let Some(config) = git_path(cli, repo_dir, "config").await? {
        files.push(config);
    }
    if let Some(hooks) = git_path(cli, repo_dir, "hooks").await? {
        files.extend(LFS_HOOKS.iter().map(|hook| hooks.join(hook)));
    }
    files.sort();
    files.dedup();
    Ok(files)
}

async fn git_path(cli: &GitCli, repo_dir: &Path, name: &str) -> Result<Option<PathBuf>, GitError> {
    let out = cli
        .exec(repo_dir, &["rev-parse", "--git-path", name])
        .await?;
    if out.exit_code != 0 {
        return Ok(None);
    }
    let path = PathBuf::from(out.stdout.trim());
    Ok(Some(if path.is_absolute() {
        path
    } else {
        repo_dir.join(path)
    }))
}

fn snapshot(files: &[PathBuf]) -> BTreeMap<PathBuf, Option<Vec<u8>>> {
    files
        .iter()
        .map(|path| (path.clone(), std::fs::read(path).ok()))
        .collect()
}

/// The `watched` files whose bytes differ from `before`.
fn changed(watched: Vec<PathBuf>, before: &BTreeMap<PathBuf, Option<Vec<u8>>>) -> Vec<PathBuf> {
    let after = snapshot(&watched);
    watched
        .into_iter()
        .filter(|path| before.get(path) != after.get(path))
        .collect()
}

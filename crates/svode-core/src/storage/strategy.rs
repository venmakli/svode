//! Change of the assets strategy of a storage scope: the transition rule, the
//! managed repository files a strategy owns (`.gitignore`, `.gitattributes`,
//! `.lfsconfig`, the Git LFS hooks and transfer agent registration) and the
//! `assets` section of `.svode/config.json`.
//!
//! The desktop app and the CLI call this one implementation; committing the
//! change and notifying windows stay with the host.

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::config::{AssetsS3Config, AssetsSpaceConfig, AssetsStrategy, BinaryRoutingConfig};
use super::lfs::{teardown_managed_registration, write_managed_registration};
use super::lfs_declaration::{self, LfsDeclarationWrite};
use super::local_release::{files_held_by_local_rules, with_released_lfs_paths};
use super::local_rules::{
    LEGACY_ASSETS_IGNORE_BODY, LEGACY_ASSETS_IGNORE_END, LEGACY_ASSETS_IGNORE_START,
    rewrite_local_extensions_block,
};
use super::policy::{self, StoragePolicyError};
use super::routes::{
    LFS_PATHS_END, LFS_PATHS_START, LOCAL_PATHS_END, LOCAL_PATHS_START, append_block,
    normalize_trailing_newline, read_or_empty, repaired_lfs_path_block, strip_block,
    write_or_remove,
};
use super::s3::CONFIG_REL as AGENT_CONFIG_REL;
use crate::git::cli::{GitCli, GitOutput};
use crate::git::state::GitRuntime;
use crate::space_config::{self, SpaceConfig, SpaceConfigError};

const ACTIVE_STRATEGY_CHANGE: &str = "Changing an active assets storage strategy is not supported yet. Use the future migration flow to move existing assets between storage strategies.";

/// Non-fatal diagnostics produced by `apply_strategy` — surfaced to the UI so
/// the user sees setup warnings instead of a misleading "Settings saved" toast.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyStrategyResult {
    pub warnings: Vec<StrategyWarning>,
}

/// One strategy warning. The UI words it by `code`; `detail` carries the
/// technical cause when there is one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategyWarning {
    pub code: StrategyWarningCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StrategyWarningCode {
    ForeignLfsConfig,
    LfsPolicyMismatch,
    LfsPolicyCheckFailed,
    LfsInstallFailed,
    LfsAgentSetupFailed,
    LfsAgentTeardownFailed,
    LfsAgentConfigCleanupFailed,
    CommitSkippedChangedFiles,
}

impl StrategyWarning {
    pub fn new(code: StrategyWarningCode) -> Self {
        Self { code, detail: None }
    }

    fn with_detail(code: StrategyWarningCode, detail: String) -> Self {
        tracing::warn!("assets strategy apply: {code:?}: {detail}");
        Self {
            code,
            detail: Some(detail),
        }
    }
}

/// Why a strategy change is refused before anything is written.
#[derive(Debug, thiserror::Error)]
pub enum StrategyError {
    /// An inline Space uses the strategy of the Project.
    #[error("strategy is inherited from project")]
    Inherited,
    /// The current or the requested strategy was set by a newer Svode
    /// version.
    #[error("{0}")]
    Unsupported(String),
    /// The scope already uses another strategy that keeps files in sync.
    #[error("{ACTIVE_STRATEGY_CHANGE}")]
    ActiveStrategy { current: AssetsStrategy },
    #[error(transparent)]
    Config(#[from] SpaceConfigError),
    #[error(transparent)]
    Policy(#[from] StoragePolicyError),
}

/// Code of the refusal to change the strategy of an inline Space.
pub const STORAGE_STRATEGY_INHERITED: &str = "STORAGE_STRATEGY_INHERITED";

impl StrategyError {
    /// Stable code of a refusal; `None` for a failure without one.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            Self::Inherited => Some(STORAGE_STRATEGY_INHERITED),
            Self::Unsupported(_) | Self::ActiveStrategy { .. } => {
                Some(super::connection::STORAGE_STRATEGY_MISMATCH)
            }
            Self::Config(_) | Self::Policy(_) => None,
        }
    }

    /// Next step of a refusal.
    pub fn hint(&self) -> Option<String> {
        match self {
            Self::Inherited => Some(
                "an inline Space uses the storage of the Project: run the command for the Project (`--space root`)"
                    .to_string(),
            ),
            Self::Unsupported(_) => {
                Some("update Svode, or keep the strategy the Project chose".to_string())
            }
            Self::ActiveStrategy { current } => Some(format!(
                "keep the strategy `{}` the Project chose: `lfs-s3` is enabled only from the `local` strategy or again over `lfs-s3`",
                current.as_str()
            )),
            Self::Config(_) | Self::Policy(_) => None,
        }
    }
}

fn is_sync_strategy(strategy: &AssetsStrategy) -> bool {
    !matches!(strategy, AssetsStrategy::Local)
}

/// `local` may move to any strategy and a strategy may be applied again; an
/// active strategy that keeps files in sync is not changed, since moving the
/// files between strategies is not supported.
pub fn ensure_supported_strategy_transition(
    current: &AssetsStrategy,
    next: &AssetsStrategy,
) -> Result<(), StrategyError> {
    for strategy in [current, next] {
        policy::supported_strategy(strategy)
            .map_err(|error| StrategyError::Unsupported(error.to_string()))?;
    }
    if current == next || !is_sync_strategy(current) {
        return Ok(());
    }
    Err(StrategyError::ActiveStrategy {
        current: current.clone(),
    })
}

/// The storage scope whose strategy changes.
#[derive(Debug, Clone, Copy)]
pub struct StrategyScope<'a> {
    /// Directory whose `.svode/config.json` owns the assets section.
    pub config_dir: &'a Path,
    pub inherited_from_project: bool,
    /// S3 prefix used when the requested one is empty.
    pub default_s3_prefix: &'a str,
}

/// The requested strategy with the whole binary routing that replaces the
/// saved one.
#[derive(Debug, Clone)]
pub struct StrategyRequest {
    pub strategy: AssetsStrategy,
    pub binary_routing: BinaryRoutingConfig,
    pub s3: Option<AssetsS3Config>,
}

/// A strategy change that passed its checks and has not written anything.
#[derive(Debug, Clone)]
pub struct PlannedStrategy {
    config_dir: PathBuf,
    config: SpaceConfig,
    assets: AssetsSpaceConfig,
}

/// Check a strategy change of `scope` and resolve what it writes: the
/// transition rule, the saved and requested binary routing and the S3 prefix.
pub fn plan(
    scope: StrategyScope<'_>,
    request: StrategyRequest,
) -> Result<PlannedStrategy, StrategyError> {
    // Inline spaces inherit their assets strategy from the root project —
    // we refuse to write a child-space override that would silently be ignored.
    if scope.inherited_from_project {
        return Err(StrategyError::Inherited);
    }
    let config = space_config::read(scope.config_dir)?;
    let current_strategy = config
        .assets
        .as_ref()
        .map(|assets| assets.strategy.clone())
        .unwrap_or_default();
    ensure_supported_strategy_transition(&current_strategy, &request.strategy)?;
    if let Some(current_assets) = config.assets.as_ref() {
        policy::supported_binary_routing(current_assets)?;
    }
    let binary_routing = policy::normalize_binary_routing(request.binary_routing)?;
    let s3 = request.s3.map(|mut target| {
        target.prefix = normalize_prefix_path(&target.prefix, scope.default_s3_prefix);
        target
    });
    Ok(PlannedStrategy {
        config_dir: scope.config_dir.to_path_buf(),
        config,
        assets: AssetsSpaceConfig {
            strategy: request.strategy,
            binary_routing: Some(binary_routing),
            s3,
            extensions: Default::default(),
        },
    })
}

impl PlannedStrategy {
    /// The assets section the change writes.
    pub fn assets(&self) -> &AssetsSpaceConfig {
        &self.assets
    }

    /// Apply the strategy to the repository of the scope, then replace the
    /// assets section of its `.svode/config.json`; the shared write keeps the
    /// keys of the file this version does not know. Nothing is committed.
    pub async fn apply(
        self,
        git: &GitRuntime,
        repo_dir: &Path,
        svode_lfs_path: Option<&Path>,
    ) -> Result<ApplyStrategyResult, StrategyError> {
        let assets = &self.assets;
        let result = apply_strategy(
            git,
            repo_dir,
            assets.strategy.clone(),
            assets
                .binary_routing
                .as_ref()
                .expect("planned binary routing"),
            assets.s3.as_ref(),
            svode_lfs_path,
        )
        .await?;
        store_assets(&self.config_dir, self.config, self.assets)?;
        Ok(result)
    }
}

/// Replace the assets section of a storage scope's config; the shared write
/// keeps the keys of the file this version does not know.
pub(super) fn store_assets(
    config_dir: &Path,
    mut config: SpaceConfig,
    assets: AssetsSpaceConfig,
) -> Result<(), SpaceConfigError> {
    config.assets = Some(assets);
    space_config::write(config_dir, &config)
}

/// The binary routing the storage settings send when the user keeps the
/// rules they show: the effective routing of `config`, with the `local` list
/// always written.
pub fn shown_binary_routing(config: &AssetsSpaceConfig) -> BinaryRoutingConfig {
    let effective = policy::effective_binary_routing(config);
    BinaryRoutingConfig {
        version: super::config::BINARY_ROUTING_VERSION,
        lfs_extensions: effective.lfs_extensions,
        lfs_threshold_bytes: effective.lfs_threshold_bytes,
        local_extensions: Some(effective.local_extensions),
        extensions: Default::default(),
    }
}

pub(super) fn rewrite_managed_lfs_attributes(
    contents: &str,
    enabled: bool,
    routing: &BinaryRoutingConfig,
) -> String {
    // Re-applying an LFS policy also rebuilds exact-path rules that no longer
    // match their metadata, even when no path is added.
    let repaired = enabled.then(|| repaired_lfs_path_block(contents)).flatten();
    let contents = repaired.as_deref().unwrap_or(contents);
    let stripped = strip_block(contents, policy::LFS_START, policy::LFS_END);
    // Builds before managed markers were introduced could leave this exact
    // Svode rule at top level. Keep the existing one-time legacy cleanup while
    // preserving every other user-owned attribute line.
    let without_legacy_rule = stripped
        .lines()
        .filter(|line| line.trim() != policy::LEGACY_ASSETS_ONLY_LFS_RULE)
        .collect::<Vec<_>>()
        .join("\n");
    let without_exact_paths = if enabled {
        without_legacy_rule
    } else {
        strip_block(&without_legacy_rule, LFS_PATHS_START, LFS_PATHS_END)
    };
    let next = if enabled {
        let body = policy::managed_lfs_attributes_body(routing);
        append_block(
            &without_exact_paths,
            policy::LFS_START,
            &body,
            policy::LFS_END,
        )
    } else {
        without_exact_paths
    };
    normalize_trailing_newline(next)
}

pub(super) fn ensure_storage_strategy_git_args_safe(
    args: &[&str],
) -> Result<(), StoragePolicyError> {
    let Some(command) = args.first().copied() else {
        return Ok(());
    };

    let rewrites_history = match command {
        "lfs" => args
            .get(1)
            .is_some_and(|subcommand| *subcommand == "migrate"),
        "filter-branch" | "filter-repo" | "rebase" | "reset" | "checkout" | "switch" => true,
        "commit" => args.iter().any(|arg| *arg == "--amend"),
        _ => false,
    };

    if rewrites_history {
        return Err(StoragePolicyError::Storage(format!(
            "history-rewriting git command is forbidden while applying assets strategy: git {}",
            args.join(" ")
        )));
    }

    Ok(())
}

async fn exec_storage_strategy_git(
    cli: &GitCli,
    space_dir: &Path,
    args: &[&str],
) -> Result<GitOutput, StoragePolicyError> {
    ensure_storage_strategy_git_args_safe(args)?;
    Ok(cli.exec(space_dir, args).await?)
}

/// Delete the local agent config. A missing file is fine.
fn delete_agent_config(space_dir: &Path) -> Result<(), StoragePolicyError> {
    let path = space_dir.join(AGENT_CONFIG_REL);
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    Ok(())
}

/// Apply a new assets strategy: update `.gitignore` / `.gitattributes`,
/// install LFS hooks if needed, and wire S3 transfer-agent config.
/// Does NOT mutate `SpaceConfig` — [`PlannedStrategy::apply`] owns that.
///
/// LFS setup is best-effort: failures are collected into
/// `ApplyStrategyResult.warnings` so the UI can surface them rather than
/// swallowed into `tracing::warn!` while the user sees a success toast.
pub async fn apply_strategy(
    git: &GitRuntime,
    space_dir: &Path,
    new: AssetsStrategy,
    binary_routing: &BinaryRoutingConfig,
    s3_config: Option<&AssetsS3Config>,
    svode_lfs_path: Option<&Path>,
) -> Result<ApplyStrategyResult, StoragePolicyError> {
    let cli = git.require_cli()?;
    let mut result = ApplyStrategyResult::default();

    // Pre-flight: LFS strategies require git-lfs to be installed.
    if matches!(new, AssetsStrategy::LfsRemote | AssetsStrategy::LfsS3) && !cli.lfs_available() {
        return Err(StoragePolicyError::Storage("git-lfs not installed".into()));
    }
    // LfsS3 also needs an S3 config and a resolved sidecar binary path —
    // the host prepares the Secret bindings *before* invoking apply_strategy
    // and resolves the binary.
    if matches!(new, AssetsStrategy::LfsS3) {
        if s3_config.is_none() {
            return Err(StoragePolicyError::Storage(
                "lfs-s3 strategy requires an S3 configuration".into(),
            ));
        }
        if svode_lfs_path.is_none() {
            return Err(StoragePolicyError::Storage(
                "svode-lfs sidecar binary not available".into(),
            ));
        }
    }

    let lock = git.get_lock(space_dir).await;
    let _guard = lock.lock().await;

    let gitignore_path = space_dir.join(".gitignore");
    let gitattributes_path = space_dir.join(".gitattributes");

    // Files the `local` blocks keep out of Git, read before those blocks go:
    // under Git LFS the large ones of another format need exact rules.
    let released_to_lfs = if policy::strategy_uses_lfs_policy(&new) {
        files_held_by_local_rules(&cli, space_dir).await?
    } else {
        Vec::new()
    };

    // --- .gitignore: managed `.assets/` and extension blocks only when Local. ---
    {
        let local = matches!(new, AssetsStrategy::Local);
        let current = read_or_empty(&gitignore_path)?;
        let stripped = strip_block(
            &current,
            LEGACY_ASSETS_IGNORE_START,
            LEGACY_ASSETS_IGNORE_END,
        );
        let stripped = if local {
            stripped
        } else {
            strip_block(&stripped, LOCAL_PATHS_START, LOCAL_PATHS_END)
        };
        let next = if local {
            append_block(
                &stripped,
                LEGACY_ASSETS_IGNORE_START,
                LEGACY_ASSETS_IGNORE_BODY,
                LEGACY_ASSETS_IGNORE_END,
            )
        } else {
            stripped
        };
        let local_extensions = policy::effective_local_extensions(binary_routing);
        let next = rewrite_local_extensions_block(
            &normalize_trailing_newline(next),
            local.then_some(local_extensions.as_slice()),
        );
        write_or_remove(&gitignore_path, &next)?;
    }

    // --- .gitattributes: managed LFS block only for Lfs* strategies. ---
    {
        let current = read_or_empty(&gitattributes_path)?;
        let next = rewrite_managed_lfs_attributes(
            &current,
            policy::strategy_uses_lfs_policy(&new),
            binary_routing,
        );
        let next = with_released_lfs_paths(&next, space_dir, &released_to_lfs, binary_routing)?;
        write_or_remove(&gitattributes_path, &next)?;
    }

    // --- .lfsconfig: portable lfs-s3 declaration, committed with the strategy. ---
    if lfs_declaration::apply_lfs_declaration(space_dir, new.clone())?
        == LfsDeclarationWrite::Foreign
    {
        result
            .warnings
            .push(StrategyWarning::new(StrategyWarningCode::ForeignLfsConfig));
    }

    // Verify positive representative paths against Git's effective attribute
    // resolution. Nested/user `.gitattributes` files can override root rules;
    // report that as a non-fatal warning without rewriting user configuration.
    if policy::strategy_uses_lfs_policy(&new) {
        let paths = policy::representative_lfs_paths(binary_routing);
        match policy::check_lfs_filters(&cli, space_dir, &paths).await {
            Ok(checks) => {
                for check in checks.into_iter().filter(|check| check.value != "lfs") {
                    result.warnings.push(StrategyWarning::with_detail(
                        StrategyWarningCode::LfsPolicyMismatch,
                        format!("{}: filter={}", check.path, check.value),
                    ));
                }
            }
            Err(error) => result.warnings.push(StrategyWarning::with_detail(
                StrategyWarningCode::LfsPolicyCheckFailed,
                error.to_string(),
            )),
        }
    }

    // --- LFS setup (best-effort, no history migration). ---
    if matches!(new, AssetsStrategy::LfsRemote | AssetsStrategy::LfsS3) {
        // Install LFS hooks in this repo.
        match exec_storage_strategy_git(&cli, space_dir, &["lfs", "install", "--local"]).await {
            Ok(o) if o.exit_code != 0 => result.warnings.push(StrategyWarning::with_detail(
                StrategyWarningCode::LfsInstallFailed,
                o.stderr.trim().to_string(),
            )),
            Err(e) => result.warnings.push(StrategyWarning::with_detail(
                StrategyWarningCode::LfsInstallFailed,
                e.to_string(),
            )),
            _ => {}
        }
    }

    // --- LFS S3 custom transfer agent (svode-lfs) wiring/teardown. ---
    // For LfsS3 we ensure the local agent config is ignored by the repository's
    // `# svode:local` block and register the svode-lfs sidecar as the
    // standalone transfer agent, replacing any legacy lfs-dal registration.
    // The caller publishes credentials after strategy apply and portable
    // config persistence succeed. For any other strategy we tear our own git
    // config back down — without disturbing a foreign active agent — so a
    // stale agent doesn't fire on push.
    if matches!(new, AssetsStrategy::LfsS3) {
        let bin = svode_lfs_path.expect("checked above");
        crate::git::ops::ensure_svode_gitignore(space_dir)?;
        if let Err(e) = write_managed_registration(&cli, space_dir, bin).await {
            result.warnings.push(StrategyWarning::with_detail(
                StrategyWarningCode::LfsAgentSetupFailed,
                e.to_string(),
            ));
        }
    } else {
        if let Err(e) = teardown_managed_registration(&cli, space_dir).await {
            result.warnings.push(StrategyWarning::with_detail(
                StrategyWarningCode::LfsAgentTeardownFailed,
                e.to_string(),
            ));
        }
        if let Err(e) = delete_agent_config(space_dir) {
            result.warnings.push(StrategyWarning::with_detail(
                StrategyWarningCode::LfsAgentConfigCleanupFailed,
                e.to_string(),
            ));
        }
    }

    // Staging of `.gitignore`/`.gitattributes`/`.lfsconfig`/`.svode/config.json`
    // belongs to the host: the desktop app commits them with
    // `SystemCommitKind::AssetsStrategy`, the CLI commits nothing.
    Ok(result)
}

fn slug_source(source: &str) -> String {
    let mut out = String::new();
    let mut pending_separator = false;

    for ch in source.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_separator && !out.is_empty() {
                out.push('-');
            }
            out.push(ch.to_ascii_lowercase());
            pending_separator = false;
        } else if ch.is_whitespace() || matches!(ch, '-' | '_' | '.' | '/' | '\\' | ':' | '+' | '&')
        {
            pending_separator = !out.is_empty();
        }
    }

    out.trim_matches('-').to_string()
}

pub fn normalize_prefix_part(source: &str, fallback: &str) -> String {
    let normalized = slug_source(source);
    if !normalized.is_empty() {
        return normalized;
    }

    let fallback = slug_source(fallback);
    if fallback.is_empty() {
        "project".to_string()
    } else {
        fallback
    }
}

fn project_prefix(project: &Path, project_name: Option<&str>) -> String {
    let path_name = project
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let from_path = slug_source(path_name);
    if !from_path.is_empty() {
        return from_path;
    }

    project_name
        .map(|name| normalize_prefix_part(name, "project"))
        .unwrap_or_else(|| "project".to_string())
}

pub fn default_root_prefix(project: &Path, project_name: Option<&str>) -> String {
    format!("{}/root", project_prefix(project, project_name))
}

pub fn default_repo_space_prefix(
    project: &Path,
    project_name: Option<&str>,
    space_dir: &Path,
) -> String {
    let raw_space = space_dir
        .strip_prefix(project)
        .ok()
        .and_then(|path| path.to_str())
        .or_else(|| space_dir.file_name().and_then(|name| name.to_str()))
        .unwrap_or("");
    let space_prefix = normalize_prefix_part(raw_space, "space");
    format!("{}/{}", project_prefix(project, project_name), space_prefix)
}

/// Default S3 prefix of a storage scope: `<project>/root` for the Project
/// and the Spaces that inherit its storage, `<project>/<space>` for a
/// repository Space.
pub fn default_s3_prefix(project: &Path, scope: &super::scope::AssetsScope) -> String {
    let project_name = space_config::read(project).ok().map(|config| config.name);
    if matches!(&scope.pool_key, crate::index::IndexKey::Root(_)) || scope.inherited_from_project {
        default_root_prefix(project, project_name.as_deref())
    } else {
        default_repo_space_prefix(project, project_name.as_deref(), &scope.repo_dir)
    }
}

pub fn normalize_prefix_path(prefix: &str, fallback: &str) -> String {
    let segments = prefix
        .trim()
        .trim_matches('/')
        .split(['/', '\\'])
        .map(slug_source)
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();

    if segments.is_empty() {
        fallback.trim_matches('/').to_string()
    } else {
        segments.join("/")
    }
}

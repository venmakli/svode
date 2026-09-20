use std::path::{Path, PathBuf};

use serde::Serialize;

use super::s3;
use crate::error::AppError;
use crate::git::GitState;
use crate::git::require_cli;
use crate::space::types::{AssetsS3Config, AssetsStrategy, BinaryRoutingConfig};
use svode_core::git::cli::{GitCli, GitOutput};
use svode_core::storage::policy;
use svode_core::storage::routes::{
    LFS_PATHS_END, LFS_PATHS_START, LOCAL_PATHS_END, LOCAL_PATHS_START, append_block,
    normalize_trailing_newline, read_or_empty, strip_block, write_or_remove,
};

/// Non-fatal diagnostics produced by `apply_strategy` — surfaced to the UI so
/// the user sees setup warnings instead of a misleading "Settings saved" toast.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyStrategyResult {
    pub warnings: Vec<String>,
}

const IGNORE_START: &str = "# svode:assets-ignore:start";
const IGNORE_END: &str = "# svode:assets-ignore:end";

const IGNORE_BODY: &str = ".assets/";

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

/// Outcome of [`repair_managed_registration`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RegistrationOutcome {
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

fn rewrite_managed_lfs_attributes(
    contents: &str,
    enabled: bool,
    routing: &BinaryRoutingConfig,
) -> String {
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

fn ensure_storage_strategy_git_args_safe(args: &[&str]) -> Result<(), AppError> {
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
        return Err(AppError::Storage(format!(
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
) -> Result<GitOutput, AppError> {
    ensure_storage_strategy_git_args_safe(args)?;
    Ok(cli.exec(space_dir, args).await?)
}

/// Read a single local Git config value. Returns `None` when the key is unset
/// (`git config --get` exit code 1); any other non-zero exit is an error.
async fn read_local_config(
    cli: &GitCli,
    repo_dir: &Path,
    key: &str,
) -> Result<Option<String>, AppError> {
    let out = cli
        .exec(repo_dir, &["config", "--local", "--get", key])
        .await?;
    match out.exit_code {
        0 => Ok(Some(out.stdout.trim().to_string())),
        1 => Ok(None),
        _ => Err(AppError::Storage(format!(
            "git config --get {key} failed: {}",
            out.stderr.trim()
        ))),
    }
}

/// Set a single local Git config value, going through the history-rewrite guard.
async fn set_local_config(
    cli: &GitCli,
    repo_dir: &Path,
    key: &str,
    value: &str,
) -> Result<(), AppError> {
    let out = exec_storage_strategy_git(cli, repo_dir, &["config", "--local", key, value]).await?;
    if out.exit_code != 0 {
        return Err(AppError::Storage(format!(
            "git config {key} failed: {}",
            out.stderr.trim()
        )));
    }
    Ok(())
}

/// Unset a single local Git config key. A missing key (`--unset` exit code 5)
/// is treated as a no-op rather than an error.
async fn unset_local_config(cli: &GitCli, repo_dir: &Path, key: &str) -> Result<(), AppError> {
    let out =
        exec_storage_strategy_git(cli, repo_dir, &["config", "--local", "--unset", key]).await?;
    if out.exit_code != 0 && out.exit_code != 5 {
        return Err(AppError::Storage(format!(
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
async fn write_managed_registration(
    cli: &GitCli,
    repo_dir: &Path,
    bin: &Path,
) -> Result<(), AppError> {
    let bin = bin.canonicalize().unwrap_or_else(|_| bin.to_path_buf());
    if !bin.is_absolute() {
        return Err(AppError::Storage(format!(
            "svode-lfs path must be absolute: {}",
            bin.display()
        )));
    }
    let bin_str = bin
        .to_str()
        .ok_or_else(|| AppError::Storage("svode-lfs path must be valid UTF-8".into()))?;

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
        return Err(AppError::Storage(
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
async fn teardown_managed_registration(cli: &GitCli, repo_dir: &Path) -> Result<(), AppError> {
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
pub(crate) async fn repair_managed_registration(
    git_state: &GitState,
    repo_dir: &Path,
) -> Result<RegistrationOutcome, AppError> {
    repair_managed_registration_with(git_state, repo_dir, s3::resolve_agent_binary).await
}

async fn repair_managed_registration_with(
    git_state: &GitState,
    repo_dir: &Path,
    resolve_bin: impl Fn() -> Result<PathBuf, AppError>,
) -> Result<RegistrationOutcome, AppError> {
    let cli = require_cli(git_state)?;

    // Cheap lock-free read on the common already-current path.
    if inspect_registration(&cli, repo_dir).await? == RepairAction::None {
        return Ok(RegistrationOutcome::Current);
    }

    // A change may be required: serialize with other repository operations and
    // re-classify under the lock to avoid racing a concurrent apply.
    let lock = git_state.get_lock(repo_dir).await;
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

async fn inspect_registration(cli: &GitCli, repo_dir: &Path) -> Result<RepairAction, AppError> {
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

/// Apply a new assets strategy: update `.gitignore` / `.gitattributes`,
/// install LFS hooks if needed, and wire S3 transfer-agent config.
/// Does NOT mutate `SpaceConfig` — the caller owns that.
///
/// LFS setup is best-effort: failures are collected into
/// `ApplyStrategyResult.warnings` so the UI can surface them rather than
/// swallowed into `tracing::warn!` while the user sees a success toast.
pub async fn apply_strategy(
    git_state: &GitState,
    space_dir: &Path,
    new: AssetsStrategy,
    binary_routing: &BinaryRoutingConfig,
    s3_config: Option<&AssetsS3Config>,
    svode_lfs_path: Option<&Path>,
) -> Result<ApplyStrategyResult, AppError> {
    let cli = require_cli(git_state)?;
    let mut result = ApplyStrategyResult::default();

    // Pre-flight: LFS strategies require git-lfs to be installed.
    if matches!(new, AssetsStrategy::LfsRemote | AssetsStrategy::LfsS3) && !cli.lfs_available() {
        return Err(AppError::Storage("git-lfs not installed".into()));
    }
    // LfsS3 also needs an S3 config and a resolved sidecar binary path —
    // commands::set_assets_strategy is responsible for stashing credentials
    // in the keychain *before* invoking apply_strategy and for resolving the
    // binary via the Tauri AppHandle.
    if matches!(new, AssetsStrategy::LfsS3) {
        if s3_config.is_none() {
            return Err(AppError::Storage(
                "lfs-s3 strategy requires an S3 configuration".into(),
            ));
        }
        if svode_lfs_path.is_none() {
            return Err(AppError::Storage(
                "svode-lfs sidecar binary not available".into(),
            ));
        }
    }

    let lock = git_state.get_lock(space_dir).await;
    let _guard = lock.lock().await;

    let gitignore_path = space_dir.join(".gitignore");
    let gitattributes_path = space_dir.join(".gitattributes");

    // --- .gitignore: managed `.assets/` block only when Local. ---
    {
        let current = read_or_empty(&gitignore_path)?;
        let stripped = strip_block(&current, IGNORE_START, IGNORE_END);
        let stripped = if matches!(new, AssetsStrategy::Local) {
            stripped
        } else {
            strip_block(&stripped, LOCAL_PATHS_START, LOCAL_PATHS_END)
        };
        let next = if matches!(new, AssetsStrategy::Local) {
            append_block(&stripped, IGNORE_START, IGNORE_BODY, IGNORE_END)
        } else {
            stripped
        };
        let next = normalize_trailing_newline(next);
        write_or_remove(&gitignore_path, &next)?;
    }

    // --- .gitattributes: managed LFS block only for Lfs* strategies. ---
    {
        let current = read_or_empty(&gitattributes_path)?;
        let next = rewrite_managed_lfs_attributes(
            &current,
            policy::strategy_uses_lfs_policy(new),
            binary_routing,
        );
        write_or_remove(&gitattributes_path, &next)?;
    }

    // Verify positive representative paths against Git's effective attribute
    // resolution. Nested/user `.gitattributes` files can override root rules;
    // report that as a non-fatal warning without rewriting user configuration.
    if policy::strategy_uses_lfs_policy(new) {
        let paths = policy::representative_lfs_paths(binary_routing);
        match policy::check_lfs_filters(&cli, space_dir, &paths).await {
            Ok(checks) => {
                for check in checks.into_iter().filter(|check| check.value != "lfs") {
                    result.warnings.push(format!(
                        "Git LFS policy verification failed for `{}`: expected filter=lfs, got {}",
                        check.path, check.value
                    ));
                }
            }
            Err(error) => result
                .warnings
                .push(format!("Git LFS policy verification errored: {error}")),
        }
    }

    // --- LFS setup (best-effort, no history migration). ---
    if matches!(new, AssetsStrategy::LfsRemote | AssetsStrategy::LfsS3) {
        // Install LFS hooks in this repo.
        match exec_storage_strategy_git(&cli, space_dir, &["lfs", "install", "--local"]).await {
            Ok(o) if o.exit_code != 0 => {
                let msg = format!("git lfs install --local failed: {}", o.stderr.trim());
                tracing::warn!("{msg}");
                result.warnings.push(msg);
            }
            Err(e) => {
                let msg = format!("git lfs install --local errored: {e}");
                tracing::warn!("{msg}");
                result.warnings.push(msg);
            }
            _ => {}
        }
    }

    // --- LFS S3 custom transfer agent (svode-lfs) wiring/teardown. ---
    // For LfsS3 we ensure the local agent config is ignored and register the
    // svode-lfs sidecar as the standalone transfer agent, replacing any legacy
    // lfs-dal registration. The caller publishes credentials after strategy
    // apply and portable config persistence succeed. For any other strategy we
    // tear our own git config back down — without disturbing a foreign active
    // agent — so a stale agent doesn't fire on push.
    if matches!(new, AssetsStrategy::LfsS3) {
        let bin = svode_lfs_path.expect("checked above");
        svode_core::storage::s3::ensure_agent_gitignore(space_dir)?;
        if let Err(e) = write_managed_registration(&cli, space_dir, bin).await {
            let msg = format!("configuring the svode-lfs transfer agent failed: {e}");
            tracing::warn!("{msg}");
            result.warnings.push(msg);
        }
    } else {
        if let Err(e) = teardown_managed_registration(&cli, space_dir).await {
            let msg = format!("removing the svode-lfs transfer agent failed: {e}");
            tracing::warn!("{msg}");
            result.warnings.push(msg);
        }
        if let Err(e) = s3::delete_agent_config(space_dir) {
            let msg = format!("delete lfs-s3-agent.json failed: {e}");
            tracing::warn!("{msg}");
            result.warnings.push(msg);
        }
    }

    // Staging of `.gitignore`/`.gitattributes`/`.svode/config.json` is now
    // done by the caller via `AutocommitService::commit_system_now` with
    // `SystemCommitKind::AssetsStrategy` — see `storage::commands`.
    Ok(result)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::path::{Path, PathBuf};

    use super::{
        RegistrationOutcome, RepairAction, apply_strategy, classify_registration,
        ensure_storage_strategy_git_args_safe, legacy_path_is_ours,
        repair_managed_registration_with, rewrite_managed_lfs_attributes,
        teardown_managed_registration,
    };
    use crate::AppError;
    use crate::git::GitState;
    use crate::space::types::{AssetsSpaceConfig, AssetsStrategy, BinaryRoutingConfig};
    use svode_core::git::cli::GitCli;
    use svode_core::storage::policy::{
        LEGACY_ASSETS_ONLY_LFS_RULE, LFS_END, LFS_START, managed_lfs_attributes_body,
        supported_binary_routing,
    };
    use svode_core::storage::routes::{
        LFS_PATHS_END, LFS_PATHS_START, rebase_managed_import_routes, rewrite_managed_path_block,
    };

    fn legacy_routing() -> BinaryRoutingConfig {
        supported_binary_routing(&AssetsSpaceConfig::default()).expect("legacy routing")
    }

    #[test]
    fn managed_lfs_rewrite_is_idempotent_and_preserves_user_attributes() {
        let existing = format!(
            "*.bin binary\n{LFS_START}\n{LEGACY_ASSETS_ONLY_LFS_RULE}\n{LFS_END}\n*.custom merge=ours\n"
        );

        let routing = legacy_routing();
        let first = rewrite_managed_lfs_attributes(&existing, true, &routing);
        let second = rewrite_managed_lfs_attributes(&first, true, &routing);

        assert_eq!(second, first);
        assert!(first.contains("*.bin binary\n"));
        assert!(first.contains("*.custom merge=ours\n"));
        assert_eq!(first.matches(LFS_START).count(), 1);
        assert_eq!(first.matches(LFS_END).count(), 1);
        assert!(first.contains(&managed_lfs_attributes_body(&routing)));

        let removed = rewrite_managed_lfs_attributes(&first, false, &routing);
        assert_eq!(removed, "*.bin binary\n*.custom merge=ours\n");
    }

    #[test]
    fn storage_strategy_git_guard_blocks_history_rewrites() {
        for args in [
            &["lfs", "migrate", "import"][..],
            &["filter-branch"][..],
            &["filter-repo"][..],
            &["rebase"][..],
            &["reset", "--hard"][..],
            &["checkout", "main"][..],
            &["switch", "main"][..],
            &["commit", "--amend"][..],
        ] {
            assert!(ensure_storage_strategy_git_args_safe(args).is_err());
        }
    }

    #[test]
    fn storage_strategy_git_guard_allows_setup_commands() {
        for args in [
            &["lfs", "install", "--local"][..],
            &[
                "config",
                "--local",
                "lfs.standalonetransferagent",
                "lfs-dal",
            ][..],
            &[
                "config",
                "--local",
                "--unset",
                "lfs.standalonetransferagent",
            ][..],
        ] {
            assert!(ensure_storage_strategy_git_args_safe(args).is_ok());
        }
    }

    #[test]
    fn exact_path_rules_rebase_a_managed_subtree_and_preserve_user_content() {
        let paths = BTreeSet::from([
            "docs/Topic/archive.bin".to_string(),
            "other/keep.bin".to_string(),
        ]);
        let contents = rewrite_managed_path_block(
            "*.custom merge=ours\n",
            LFS_PATHS_START,
            LFS_PATHS_END,
            &paths,
            true,
        );
        let temp = tempfile::tempdir().expect("temp dir");
        std::fs::write(temp.path().join(".gitattributes"), contents).expect("attributes");

        let changed = rebase_managed_import_routes(temp.path(), "docs/Topic", "docs/Renamed", true)
            .expect("rebase exact rules");
        let next = std::fs::read_to_string(temp.path().join(".gitattributes")).expect("attributes");

        assert_eq!(changed, vec![temp.path().join(".gitattributes")]);
        assert!(next.contains("*.custom merge=ours"));
        assert!(next.contains("docs/Renamed/archive.bin"));
        assert!(next.contains("other/keep.bin"));
        assert!(!next.contains("docs/Topic/archive.bin"));
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

    fn make_fake_binary(dir: &Path, name: &str) -> Result<PathBuf, AppError> {
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

    async fn init_repo(cli: &GitCli, repo: &Path) -> Result<(), AppError> {
        std::fs::create_dir_all(repo)?;
        git_ok(cli, repo, &["init"]).await?;
        Ok(())
    }

    #[tokio::test]
    async fn repair_migrates_legacy_registration_and_is_idempotent() -> Result<(), AppError> {
        let git_state = GitState::new();
        let Some(cli) = git_state.detected() else {
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
            repair_managed_registration_with(&git_state, &repo, || Ok(resolved.clone())).await?;
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
            cli.exec(
                &repo,
                &[
                    "config",
                    "--local",
                    "--get",
                    "lfs.customtransfer.lfs-dal.path"
                ]
            )
            .await?
            .exit_code,
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
        let again = repair_managed_registration_with(&git_state, &repo, || {
            panic!("resolver must not run on the already-current path")
        })
        .await?;
        assert_eq!(again, RegistrationOutcome::Current);
        Ok(())
    }

    #[tokio::test]
    async fn repair_rewrites_stale_current_path() -> Result<(), AppError> {
        let git_state = GitState::new();
        let Some(cli) = git_state.detected() else {
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
            repair_managed_registration_with(&git_state, &repo, || Ok(resolved.clone())).await?;
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
    async fn repair_leaves_foreign_configuration_untouched() -> Result<(), AppError> {
        let git_state = GitState::new();
        let Some(cli) = git_state.detected() else {
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

        let outcome = repair_managed_registration_with(&git_state, &repo, || {
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
            cli.exec(
                &repo,
                &[
                    "config",
                    "--local",
                    "--get",
                    "lfs.customtransfer.svode-lfs.path"
                ]
            )
            .await?
            .exit_code,
            1
        );
        Ok(())
    }

    #[tokio::test]
    async fn teardown_removes_own_wiring_but_keeps_foreign_agent() -> Result<(), AppError> {
        let git_state = GitState::new();
        let Some(cli) = git_state.detected() else {
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
            let lock = git_state.get_lock(&repo).await;
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
            assert_eq!(
                cli.exec(&repo, &["config", "--local", "--get", key])
                    .await?
                    .exit_code,
                1
            );
        }
        Ok(())
    }

    #[tokio::test]
    async fn in_git_apply_keeps_head_on_remote_tracking_history() -> Result<(), AppError> {
        let Some((git_state, _temp, repo)) = setup_remote_tracking_repo().await? else {
            return Ok(());
        };

        let cli = git_state.detected().expect("checked above");
        let head_before = git_stdout(cli, &repo, &["rev-parse", "HEAD"]).await?;
        let origin_head = git_stdout(cli, &repo, &["rev-parse", "origin/main"]).await?;

        apply_strategy(
            &git_state,
            &repo,
            AssetsStrategy::InGit,
            &legacy_routing(),
            None,
            None,
        )
        .await?;

        let head_after = git_stdout(cli, &repo, &["rev-parse", "HEAD"]).await?;
        let merge_base = git_stdout(cli, &repo, &["merge-base", "HEAD", "origin/main"]).await?;
        assert_eq!(head_after, head_before);
        assert_eq!(merge_base, origin_head);
        Ok(())
    }

    #[tokio::test]
    async fn in_git_apply_removes_raw_svode_lfs_rule_without_moving_head() -> Result<(), AppError> {
        let Some((git_state, _temp, repo)) = setup_remote_tracking_repo().await? else {
            return Ok(());
        };

        let cli = git_state.detected().expect("checked above");
        let head_before = git_stdout(cli, &repo, &["rev-parse", "HEAD"]).await?;
        std::fs::write(
            repo.join(".gitattributes"),
            ".assets/** filter=lfs diff=lfs merge=lfs -text\n",
        )?;

        apply_strategy(
            &git_state,
            &repo,
            AssetsStrategy::InGit,
            &legacy_routing(),
            None,
            None,
        )
        .await?;

        let head_after = git_stdout(cli, &repo, &["rev-parse", "HEAD"]).await?;
        assert_eq!(head_after, head_before);
        assert!(!repo.join(".gitattributes").exists());
        Ok(())
    }

    #[tokio::test]
    async fn lfs_remote_apply_keeps_head_on_remote_tracking_history_when_lfs_available()
    -> Result<(), AppError> {
        let Some((git_state, _temp, repo)) = setup_remote_tracking_repo().await? else {
            return Ok(());
        };
        let cli = git_state.detected().expect("checked above");
        if !cli.lfs_available() {
            return Ok(());
        }

        let head_before = git_stdout(cli, &repo, &["rev-parse", "HEAD"]).await?;
        let origin_head = git_stdout(cli, &repo, &["rev-parse", "origin/main"]).await?;

        apply_strategy(
            &git_state,
            &repo,
            AssetsStrategy::LfsRemote,
            &legacy_routing(),
            None,
            None,
        )
        .await?;

        let head_after = git_stdout(cli, &repo, &["rev-parse", "HEAD"]).await?;
        let merge_base = git_stdout(cli, &repo, &["merge-base", "HEAD", "origin/main"]).await?;
        assert_eq!(head_after, head_before);
        assert_eq!(merge_base, origin_head);
        Ok(())
    }

    async fn setup_remote_tracking_repo()
    -> Result<Option<(GitState, tempfile::TempDir, PathBuf)>, AppError> {
        let git_state = GitState::new();
        let Some(cli) = git_state.detected() else {
            return Ok(None);
        };

        let temp = tempfile::tempdir()?;
        let root = temp.path();
        let remote = root.join("remote.git");
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo)?;

        git_ok_no_dir(cli, &["init", "--bare", path_str(&remote)?]).await?;
        git_ok(cli, &repo, &["init"]).await?;
        git_ok(cli, &repo, &["config", "user.email", "test@example.com"]).await?;
        git_ok(cli, &repo, &["config", "user.name", "Svode Test"]).await?;
        git_ok(cli, &repo, &["branch", "-M", "main"]).await?;

        std::fs::write(repo.join("README.md"), "# Project\n")?;
        git_ok(cli, &repo, &["add", "README.md"]).await?;
        git_ok(cli, &repo, &["commit", "-m", "Initial commit"]).await?;
        git_ok(cli, &repo, &["remote", "add", "origin", path_str(&remote)?]).await?;
        git_ok(cli, &repo, &["push", "-u", "origin", "main"]).await?;

        std::fs::write(repo.join("local.md"), "local\n")?;
        git_ok(cli, &repo, &["add", "local.md"]).await?;
        git_ok(cli, &repo, &["commit", "-m", "Local work"]).await?;

        Ok(Some((git_state, temp, repo)))
    }

    async fn git_ok(cli: &GitCli, repo: &Path, args: &[&str]) -> Result<(), AppError> {
        let out = cli.exec(repo, args).await?;
        if out.exit_code != 0 {
            return Err(AppError::GitCommandFailed(format!(
                "git {} failed: {}",
                args.join(" "),
                out.stderr
            )));
        }
        Ok(())
    }

    async fn git_ok_no_dir(cli: &GitCli, args: &[&str]) -> Result<(), AppError> {
        let out = cli.exec_no_dir(args).await?;
        if out.exit_code != 0 {
            return Err(AppError::GitCommandFailed(format!(
                "git {} failed: {}",
                args.join(" "),
                out.stderr
            )));
        }
        Ok(())
    }

    async fn git_stdout(cli: &GitCli, repo: &Path, args: &[&str]) -> Result<String, AppError> {
        let out = cli.exec(repo, args).await?;
        if out.exit_code != 0 {
            return Err(AppError::GitCommandFailed(format!(
                "git {} failed: {}",
                args.join(" "),
                out.stderr
            )));
        }
        Ok(out.stdout.trim().to_string())
    }

    fn path_str(path: &Path) -> Result<&str, AppError> {
        path.to_str()
            .ok_or_else(|| AppError::PathNotAccessible(path.display().to_string()))
    }
}

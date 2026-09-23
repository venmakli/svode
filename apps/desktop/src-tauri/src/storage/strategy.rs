use std::path::Path;

use serde::Serialize;

use super::s3;
use crate::error::AppError;
use crate::git::GitState;
use crate::git::require_cli;
use crate::space::types::{AssetsS3Config, AssetsStrategy, BinaryRoutingConfig};
use svode_core::git::cli::{GitCli, GitOutput};
use svode_core::storage::lfs::{teardown_managed_registration, write_managed_registration};
use svode_core::storage::lfs_declaration::{self, LfsDeclarationWrite};
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

    // --- .lfsconfig: portable lfs-s3 declaration, committed with the strategy. ---
    if lfs_declaration::apply_lfs_declaration(space_dir, new)? == LfsDeclarationWrite::Foreign {
        result.warnings.push(
            ".lfsconfig already sets lfs.url to another value, so Svode left it unchanged; clients without the Svode LFS agent may upload objects to the Git provider.".into(),
        );
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

    // Staging of `.gitignore`/`.gitattributes`/`.lfsconfig`/`.svode/config.json` is now
    // done by the caller via `AutocommitService::commit_system_now` with
    // `SystemCommitKind::AssetsStrategy` — see `storage::commands`.
    Ok(result)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::path::{Path, PathBuf};

    use super::{
        apply_strategy, ensure_storage_strategy_git_args_safe, rewrite_managed_lfs_attributes,
    };
    use crate::AppError;
    use crate::git::GitState;
    use crate::space::types::{
        AssetsS3Config, AssetsSpaceConfig, AssetsStrategy, BinaryRoutingConfig,
    };
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

    #[tokio::test]
    async fn lfs_s3_apply_declares_once_and_other_strategy_removes_only_own_value()
    -> Result<(), AppError> {
        let Some((git_state, temp, repo)) = setup_remote_tracking_repo().await? else {
            return Ok(());
        };
        let cli = git_state.detected().expect("checked above");
        if !cli.lfs_available() {
            return Ok(());
        }
        let bin = make_fake_binary(&temp.path().join("bin"), "svode-lfs")?;
        let s3 = AssetsS3Config {
            endpoint: "https://s3.example.test".into(),
            bucket: "bucket".into(),
            region: "us-east-1".into(),
            prefix: "project".into(),
        };
        let user = "# team\n[lfs]\n\tfetchexclude = archive/**\n";
        std::fs::write(repo.join(".lfsconfig"), user)?;
        let declared = format!("{user}[lfs]\n\turl = https://lfs-s3.svode.invalid/\n");

        for _ in 0..2 {
            let result = apply_strategy(
                &git_state,
                &repo,
                AssetsStrategy::LfsS3,
                &legacy_routing(),
                Some(&s3),
                Some(&bin),
            )
            .await?;
            assert!(result.warnings.iter().all(|w| !w.contains(".lfsconfig")));
            assert_eq!(std::fs::read_to_string(repo.join(".lfsconfig"))?, declared);
        }

        apply_strategy(
            &git_state,
            &repo,
            AssetsStrategy::InGit,
            &legacy_routing(),
            None,
            None,
        )
        .await?;
        assert_eq!(std::fs::read_to_string(repo.join(".lfsconfig"))?, user);

        std::fs::write(
            repo.join(".lfsconfig"),
            "[lfs]\n\turl = https://lfs.example.test/\n",
        )?;
        let result = apply_strategy(
            &git_state,
            &repo,
            AssetsStrategy::LfsS3,
            &legacy_routing(),
            Some(&s3),
            Some(&bin),
        )
        .await?;
        assert!(result.warnings.iter().any(|w| w.contains(".lfsconfig")));
        assert_eq!(
            std::fs::read_to_string(repo.join(".lfsconfig"))?,
            "[lfs]\n\turl = https://lfs.example.test/\n"
        );
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

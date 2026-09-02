use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::{policy, s3};
use crate::error::AppError;
use crate::git::GitState;
use crate::git::cli::{GitCli, GitOutput};
use crate::git::commands::require_cli;
use crate::space::types::{AssetsS3Config, AssetsStrategy, BinaryRoutingConfig};

/// Non-fatal diagnostics produced by `apply_strategy` — surfaced to the UI so
/// the user sees setup warnings instead of a misleading "Settings saved" toast.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyStrategyResult {
    pub warnings: Vec<String>,
}

const IGNORE_START: &str = "# svode:assets-ignore:start";
const IGNORE_END: &str = "# svode:assets-ignore:end";
const LOCAL_PATHS_START: &str = "# svode:assets-local-paths:start";
const LOCAL_PATHS_END: &str = "# svode:assets-local-paths:end";
const LFS_PATHS_START: &str = "# svode:assets-lfs-paths:start";
const LFS_PATHS_END: &str = "# svode:assets-lfs-paths:end";
const MANAGED_PATH_PREFIX: &str = "# svode:path ";

const IGNORE_BODY: &str = ".assets/";

/// Read a file to a string, returning an empty string if the file does not
/// exist. Any other IO error is propagated.
fn read_or_empty(path: &Path) -> Result<String, AppError> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.into()),
    }
}

/// Strip a managed block between the given start/end markers (inclusive),
/// returning the remainder. Robust to missing blocks **and** to a dangling
/// start marker with no matching end: in that case we buffer lines inside the
/// would-be block and flush them back unchanged, so we never truncate the
/// file to whatever happened to follow a malformed marker.
fn strip_block(contents: &str, start_marker: &str, end_marker: &str) -> String {
    let lines: Vec<&str> = contents.lines().collect();
    let mut out: Vec<&str> = Vec::with_capacity(lines.len());
    let mut buffered: Vec<&str> = Vec::new();
    let mut inside = false;
    for line in &lines {
        if !inside && line.trim() == start_marker {
            inside = true;
            buffered.push(line);
            continue;
        }
        if inside && line.trim() == end_marker {
            inside = false;
            buffered.clear();
            continue;
        }
        if inside {
            buffered.push(line);
            continue;
        }
        out.push(line);
    }
    // Dangling start with no end — preserve the buffered lines so we don't
    // silently drop user content after a broken marker.
    if inside {
        out.extend(buffered);
    }
    out.join("\n")
}

/// Append a managed block to `contents`, ensuring a single blank line between
/// the prior content and the block, and a single trailing newline.
fn append_block(contents: &str, start_marker: &str, body: &str, end_marker: &str) -> String {
    let mut base = contents.trim_end_matches('\n').to_string();
    if !base.is_empty() {
        base.push('\n');
    }
    base.push_str(start_marker);
    base.push('\n');
    base.push_str(body);
    base.push('\n');
    base.push_str(end_marker);
    base.push('\n');
    base
}

/// Ensure `contents` ends with exactly one trailing newline (or is empty).
fn normalize_trailing_newline(mut s: String) -> String {
    while s.ends_with("\n\n") {
        s.pop();
    }
    if !s.is_empty() && !s.ends_with('\n') {
        s.push('\n');
    }
    s
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

fn parse_managed_paths(
    contents: &str,
    start_marker: &str,
    end_marker: &str,
) -> Result<BTreeSet<String>, AppError> {
    let mut paths = BTreeSet::new();
    let mut inside = false;
    let mut blocks = 0_u8;
    for line in contents.lines() {
        match line.trim() {
            value if value == start_marker => {
                if inside || blocks > 0 {
                    return Err(AppError::Storage(format!(
                        "managed Git policy block `{start_marker}` is malformed"
                    )));
                }
                inside = true;
                blocks += 1;
            }
            value if value == end_marker => {
                if !inside {
                    return Err(AppError::Storage(format!(
                        "managed Git policy block `{start_marker}` is malformed"
                    )));
                }
                inside = false;
            }
            _ if inside => {
                if let Some(encoded) = line.trim().strip_prefix(MANAGED_PATH_PREFIX) {
                    let path: String = serde_json::from_str(encoded).map_err(|_| {
                        AppError::Storage(format!(
                            "managed Git policy path in `{start_marker}` is malformed"
                        ))
                    })?;
                    paths.insert(path);
                }
            }
            _ => {}
        }
    }
    if inside {
        return Err(AppError::Storage(format!(
            "managed Git policy block `{start_marker}` is malformed"
        )));
    }
    Ok(paths)
}

fn render_managed_path_body(paths: &BTreeSet<String>, lfs: bool) -> String {
    paths
        .iter()
        .flat_map(|path| {
            let metadata = format!(
                "{MANAGED_PATH_PREFIX}{}",
                serde_json::to_string(path).expect("serializing a String cannot fail")
            );
            let pattern = escape_git_pattern(path, !lfs);
            let rule = if lfs {
                format!("{pattern} filter=lfs diff=lfs merge=lfs -text")
            } else {
                pattern
            };
            [metadata, rule]
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn rewrite_managed_path_block(
    contents: &str,
    start_marker: &str,
    end_marker: &str,
    paths: &BTreeSet<String>,
    lfs: bool,
) -> String {
    let stripped = strip_block(contents, start_marker, end_marker);
    if paths.is_empty() {
        return normalize_trailing_newline(stripped);
    }
    normalize_trailing_newline(append_block(
        &stripped,
        start_marker,
        &render_managed_path_body(paths, lfs),
        end_marker,
    ))
}

fn escape_git_pattern(path: &str, root_anchored: bool) -> String {
    let mut output = String::with_capacity(path.len() + usize::from(root_anchored));
    if root_anchored {
        output.push('/');
    }
    for character in path.chars() {
        if matches!(
            character,
            '\\' | ' ' | '\t' | '!' | '#' | '[' | ']' | '*' | '?'
        ) {
            output.push('\\');
        }
        output.push(character);
    }
    output
}

/// Write `contents` to `path`, creating or replacing the file. If contents is
/// empty, the file is removed (we don't want to leave an empty .gitattributes
/// lying around).
fn write_or_remove(path: &Path, contents: &str) -> Result<(), AppError> {
    let trimmed = contents.trim();
    if trimmed.is_empty() {
        if path.exists() {
            std::fs::remove_file(path)?;
        }
        return Ok(());
    }
    std::fs::write(path, contents)?;
    Ok(())
}

fn restore_file(path: &Path, contents: Option<&str>) {
    match contents {
        Some(contents) => {
            let _ = std::fs::write(path, contents);
        }
        None => {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Materialize only the exact rule required by one Svode-managed import.
/// Extension-wide rules are owned by `apply_strategy`; external file-system
/// activity never calls this function.
pub(crate) async fn apply_managed_import_route(
    git_state: &GitState,
    repo_dir: &Path,
    route: policy::ManagedBinaryRoute,
    repo_relative_path: &str,
) -> Result<Vec<PathBuf>, AppError> {
    let cli = require_cli(git_state)?;
    if matches!(
        route,
        policy::ManagedBinaryRoute::LfsExtension | policy::ManagedBinaryRoute::LfsThreshold
    ) && !cli.lfs_available()
    {
        return Err(AppError::Storage(
            "Git LFS route is not ready: git-lfs is not installed".to_string(),
        ));
    }

    let lock = git_state.get_lock(repo_dir).await;
    let _guard = lock.lock().await;
    let mut changed = Vec::new();
    let policy_path = match route {
        policy::ManagedBinaryRoute::Local => Some((
            repo_dir.join(".gitignore"),
            LOCAL_PATHS_START,
            LOCAL_PATHS_END,
            false,
        )),
        policy::ManagedBinaryRoute::LfsThreshold => Some((
            repo_dir.join(".gitattributes"),
            LFS_PATHS_START,
            LFS_PATHS_END,
            true,
        )),
        policy::ManagedBinaryRoute::LfsExtension | policy::ManagedBinaryRoute::DirectGit => None,
    };

    let original = if let Some((path, start, end, lfs)) = policy_path.as_ref() {
        let original = if path.exists() {
            Some(read_or_empty(path)?)
        } else {
            None
        };
        let current = original.as_deref().unwrap_or_default();
        let mut paths = parse_managed_paths(current, start, end)?;
        paths.insert(repo_relative_path.to_string());
        let next = rewrite_managed_path_block(current, start, end, &paths, *lfs);
        if next != current {
            write_or_remove(path, &next)?;
            changed.push(path.clone());
        }
        original.map(|contents| (path.clone(), contents))
    } else {
        None
    };

    let verification = match route {
        policy::ManagedBinaryRoute::Local => cli
            .exec(
                repo_dir,
                &["check-ignore", "--quiet", "--", repo_relative_path],
            )
            .await
            .and_then(|output| {
                (output.exit_code == 0).then_some(()).ok_or_else(|| {
                    AppError::Storage(format!(
                        "managed local route is not effective for `{repo_relative_path}`"
                    ))
                })
            }),
        policy::ManagedBinaryRoute::LfsExtension | policy::ManagedBinaryRoute::LfsThreshold => {
            policy::check_lfs_filters(&cli, repo_dir, &[repo_relative_path.to_string()])
                .await
                .and_then(|checks| {
                    checks
                        .first()
                        .is_some_and(|check| check.value == "lfs")
                        .then_some(())
                        .ok_or_else(|| {
                            AppError::Storage(format!(
                                "Git LFS route is not effective for `{repo_relative_path}`"
                            ))
                        })
                })
        }
        policy::ManagedBinaryRoute::DirectGit => Ok(()),
    };

    if let Err(error) = verification {
        if let Some((path, contents)) = original.as_ref() {
            restore_file(path, Some(contents));
        } else if let Some((path, ..)) = policy_path.as_ref() {
            restore_file(path, None);
        }
        return Err(error);
    }
    Ok(changed)
}

/// Rebase Svode-owned exact rules after a managed Page/folder move. User
/// blocks remain byte-for-byte outside the generated sections.
pub(crate) fn rebase_managed_import_routes(
    repo_dir: &Path,
    old_path: &str,
    new_path: &str,
    subtree: bool,
) -> Result<Vec<PathBuf>, AppError> {
    let mut changed = Vec::new();
    for (file_name, start, end, lfs) in [
        (".gitignore", LOCAL_PATHS_START, LOCAL_PATHS_END, false),
        (".gitattributes", LFS_PATHS_START, LFS_PATHS_END, true),
    ] {
        let path = repo_dir.join(file_name);
        if !path.exists() {
            continue;
        }
        let current = read_or_empty(&path)?;
        let paths = parse_managed_paths(&current, start, end)?;
        let rebased = paths
            .into_iter()
            .map(|path| rebase_managed_path(&path, old_path, new_path, subtree))
            .collect::<BTreeSet<_>>();
        let next = rewrite_managed_path_block(&current, start, end, &rebased, lfs);
        if next != current {
            write_or_remove(&path, &next)?;
            changed.push(path);
        }
    }
    Ok(changed)
}

fn rebase_managed_path(path: &str, old_path: &str, new_path: &str, subtree: bool) -> String {
    if path == old_path {
        return new_path.to_string();
    }
    if subtree
        && let Some(suffix) = path.strip_prefix(old_path)
        && suffix.starts_with('/')
    {
        return format!("{new_path}{suffix}");
    }
    path.to_string()
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
    cli.exec(space_dir, args).await
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
    lfs_dal_path: Option<&Path>,
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
        if lfs_dal_path.is_none() {
            return Err(AppError::Storage(
                "lfs-dal sidecar binary not available".into(),
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

    // --- LFS S3 custom transfer agent (lfs-dal) wiring/teardown. ---
    // For LfsS3 we (a) write `.svode/lfs-s3-agent.json`, (b) ensure the
    // agent config file is gitignored, and (c) configure git to use lfs-dal
    // as the standalone transfer agent. For any other strategy we tear the
    // git config back down so a stale agent doesn't fire on push.
    if matches!(new, AssetsStrategy::LfsS3) {
        let cfg = s3_config.expect("checked above");
        let bin = lfs_dal_path.expect("checked above");

        s3::ensure_agent_gitignore(space_dir)?;
        let agent_cfg = s3::AgentConfigFile {
            endpoint: cfg.endpoint.clone(),
            bucket: cfg.bucket.clone(),
            region: cfg.region.clone(),
            keychain_account: s3::keychain_account(cfg),
            prefix: Some(cfg.prefix.clone()),
        };
        s3::write_agent_config(space_dir, &agent_cfg)?;

        let bin = bin.canonicalize().unwrap_or_else(|_| bin.to_path_buf());
        if !bin.is_absolute() {
            return Err(AppError::Storage(format!(
                "lfs-dal path must be absolute: {}",
                bin.display()
            )));
        }
        let bin_str = bin
            .to_str()
            .ok_or_else(|| AppError::Storage("lfs-dal path must be valid UTF-8".into()))?;
        let pairs: [(&str, &str); 3] = [
            ("lfs.customtransfer.lfs-dal.path", bin_str),
            ("lfs.customtransfer.lfs-dal.concurrent", "true"),
            ("lfs.standalonetransferagent", "lfs-dal"),
        ];
        for (key, value) in pairs {
            match exec_storage_strategy_git(&cli, space_dir, &["config", "--local", key, value])
                .await
            {
                Ok(o) if o.exit_code != 0 => {
                    let msg = format!("git config {key} failed: {}", o.stderr.trim());
                    tracing::warn!("{msg}");
                    result.warnings.push(msg);
                }
                Err(e) => {
                    let msg = format!("git config {key} errored: {e}");
                    tracing::warn!("{msg}");
                    result.warnings.push(msg);
                }
                _ => {}
            }
        }
    } else {
        // Tear down lfs-dal git config and the agent config file. Missing
        // values are fine — `git config --unset` returns 5, which we treat
        // as no-op rather than warning.
        let unset_keys = [
            "lfs.standalonetransferagent",
            "lfs.customtransfer.lfs-dal.path",
            "lfs.customtransfer.lfs-dal.concurrent",
        ];
        for key in unset_keys {
            match exec_storage_strategy_git(&cli, space_dir, &["config", "--local", "--unset", key])
                .await
            {
                Ok(o) if o.exit_code != 0 && o.exit_code != 5 => {
                    let msg = format!("git config --unset {key} failed: {}", o.stderr.trim());
                    tracing::warn!("{msg}");
                    result.warnings.push(msg);
                }
                Err(e) => {
                    let msg = format!("git config --unset {key} errored: {e}");
                    tracing::warn!("{msg}");
                    result.warnings.push(msg);
                }
                _ => {}
            }
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
        LFS_PATHS_END, LFS_PATHS_START, apply_managed_import_route, apply_strategy,
        ensure_storage_strategy_git_args_safe, rebase_managed_import_routes,
        rewrite_managed_lfs_attributes, rewrite_managed_path_block,
    };
    use crate::AppError;
    use crate::git::GitState;
    use crate::git::cli::GitCli;
    use crate::space::types::{AssetsSpaceConfig, AssetsStrategy, BinaryRoutingConfig};
    use crate::storage::policy::ManagedBinaryRoute;
    use crate::storage::policy::{
        LEGACY_ASSETS_ONLY_LFS_RULE, LFS_END, LFS_START, managed_lfs_attributes_body,
        supported_binary_routing,
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

    #[tokio::test]
    async fn exact_rules_use_git_effective_resolution_and_fail_on_nested_override()
    -> Result<(), AppError> {
        let git_state = GitState::new();
        let Some(cli) = git_state.cli.as_ref() else {
            return Ok(());
        };
        let temp = tempfile::tempdir()?;
        let repo = temp.path();
        git_ok(cli, repo, &["init"]).await?;

        apply_managed_import_route(
            &git_state,
            repo,
            ManagedBinaryRoute::Local,
            "Topic/file [1].bin",
        )
        .await?;
        let ignored = cli
            .exec(
                repo,
                &["check-ignore", "--quiet", "--", "Topic/file [1].bin"],
            )
            .await?;
        assert_eq!(ignored.exit_code, 0);

        if !cli.lfs_available() {
            return Ok(());
        }
        std::fs::create_dir_all(repo.join("Topic"))?;
        std::fs::write(repo.join("Topic/.gitattributes"), "file.bin -filter\n")?;
        let error = apply_managed_import_route(
            &git_state,
            repo,
            ManagedBinaryRoute::LfsThreshold,
            "Topic/file.bin",
        )
        .await
        .expect_err("nested override must block LFS route");
        assert!(error.to_string().contains("not effective"));
        let attributes = std::fs::read_to_string(repo.join(".gitattributes")).unwrap_or_default();
        assert!(!attributes.contains("Topic/file.bin"));
        Ok(())
    }

    #[tokio::test]
    async fn in_git_apply_keeps_head_on_remote_tracking_history() -> Result<(), AppError> {
        let Some((git_state, _temp, repo)) = setup_remote_tracking_repo().await? else {
            return Ok(());
        };

        let cli = git_state.cli.as_ref().expect("checked above");
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

        let cli = git_state.cli.as_ref().expect("checked above");
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
        let cli = git_state.cli.as_ref().expect("checked above");
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
        let Some(cli) = git_state.cli.as_ref() else {
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

use std::path::Path;

use serde::Serialize;

use super::s3;
use crate::error::AppError;
use crate::git::GitState;
use crate::git::commands::require_cli;
use crate::space::types::{AssetsS3Config, AssetsStrategy};

/// Non-fatal diagnostics produced by `apply_strategy` — surfaced to the UI so
/// the user sees e.g. a silent `git lfs migrate import` failure instead of a
/// misleading "Settings saved" toast.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyStrategyResult {
    pub warnings: Vec<String>,
}

const IGNORE_START: &str = "# combai:assets-ignore:start";
const IGNORE_END: &str = "# combai:assets-ignore:end";
const LFS_START: &str = "# combai:assets-lfs:start";
const LFS_END: &str = "# combai:assets-lfs:end";

const IGNORE_BODY: &str = ".assets/";
const LFS_BODY: &str = ".assets/** filter=lfs diff=lfs merge=lfs -text";

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

/// Apply a new assets strategy: update `.gitignore` / `.gitattributes`,
/// install/track LFS if needed, and best-effort migrate existing history.
/// Does NOT mutate `SpaceConfig` — the caller owns that.
///
/// LFS setup and history migration are best-effort: failures are collected
/// into `ApplyStrategyResult.warnings` so the UI can surface them, rather
/// than swallowed into `tracing::warn!` while the user sees a success toast.
pub async fn apply_strategy(
    git_state: &GitState,
    space_dir: &Path,
    new: AssetsStrategy,
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
        let stripped = strip_block(&current, LFS_START, LFS_END);
        let next = if matches!(new, AssetsStrategy::LfsRemote | AssetsStrategy::LfsS3) {
            append_block(&stripped, LFS_START, LFS_BODY, LFS_END)
        } else {
            stripped
        };
        let next = normalize_trailing_newline(next);
        write_or_remove(&gitattributes_path, &next)?;
    }

    // --- LFS setup + history migration (best-effort). ---
    if matches!(new, AssetsStrategy::LfsRemote | AssetsStrategy::LfsS3) {
        // Install LFS hooks in this repo.
        match cli.exec(space_dir, &["lfs", "install", "--local"]).await {
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

        // `git lfs track` will rewrite .gitattributes itself — after it runs,
        // dedupe and re-apply our managed block as the canonical form.
        match cli.exec(space_dir, &["lfs", "track", ".assets/**"]).await {
            Ok(o) if o.exit_code != 0 => {
                let msg = format!("git lfs track failed: {}", o.stderr.trim());
                tracing::warn!("{msg}");
                result.warnings.push(msg);
            }
            Err(e) => {
                let msg = format!("git lfs track errored: {e}");
                tracing::warn!("{msg}");
                result.warnings.push(msg);
            }
            _ => {}
        }

        // Re-canonicalize .gitattributes: strip any raw LFS_BODY lines that
        // `git lfs track` added outside our managed block, then re-append.
        {
            let current = read_or_empty(&gitattributes_path)?;
            let stripped = strip_block(&current, LFS_START, LFS_END);
            let without_raw: String = stripped
                .lines()
                .filter(|l| l.trim() != LFS_BODY)
                .collect::<Vec<_>>()
                .join("\n");
            let next = append_block(&without_raw, LFS_START, LFS_BODY, LFS_END);
            let next = normalize_trailing_newline(next);
            write_or_remove(&gitattributes_path, &next)?;
        }

        // Best-effort history migration. If the repo has no commits yet or
        // migration fails for any reason (dirty tree, etc.), log and continue.
        match cli
            .exec(
                space_dir,
                &[
                    "lfs",
                    "migrate",
                    "import",
                    "--include=.assets/**",
                    "--everything",
                    "--yes",
                ],
            )
            .await
        {
            Ok(o) if o.exit_code != 0 => {
                let msg = format!(
                    "git lfs migrate import failed (continuing): {}",
                    o.stderr.trim()
                );
                tracing::warn!("{msg}");
                result.warnings.push(msg);
            }
            Err(e) => {
                let msg = format!("git lfs migrate import errored (continuing): {e}");
                tracing::warn!("{msg}");
                result.warnings.push(msg);
            }
            _ => {}
        }
    } else {
        // TODO: lfs migrate export — when switching FROM an LFS strategy TO
        // InGit, we could run `git lfs migrate export` to inline pointers back
        // into the tree. Not attempted in this phase.
    }

    // --- LFS S3 custom transfer agent (lfs-dal) wiring/teardown. ---
    // For LfsS3 we (a) write `.combai/lfs-s3-agent.json`, (b) ensure the
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
            prefix: None,
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
            match cli
                .exec(space_dir, &["config", "--local", key, value])
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
            match cli
                .exec(space_dir, &["config", "--local", "--unset", key])
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

    // Staging of `.gitignore`/`.gitattributes`/`.combai/config.json` is now
    // done by the caller via `AutocommitService::commit_system_now` with
    // `SystemCommitKind::AssetsStrategy` — see `storage::commands`.
    Ok(result)
}

use std::path::Path;

use serde::Serialize;

use crate::error::AppError;
use crate::git::GitState;
use crate::git::commands::require_cli;
use crate::workspace::types::{AssetsStrategy, AssetsWorkspaceConfig};

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

/// Stage a newly uploaded asset via `git add` when the active strategy needs
/// it to be tracked. For `Local`, assets live outside git entirely and this
/// is a no-op. For `InGit`/`LfsRemote`/`LfsS3` the asset must end up in the
/// index — if git is unavailable, we surface an error so the caller can warn
/// the user (strategy promises tracking, the upload broke that promise).
pub async fn stage_new_asset(
    git_state: &GitState,
    workspace_dir: &Path,
    cfg: Option<&AssetsWorkspaceConfig>,
    asset_rel_path: &str,
) -> Result<(), AppError> {
    let strategy = cfg.map(|c| c.strategy).unwrap_or_default();
    if matches!(strategy, AssetsStrategy::Local) {
        return Ok(());
    }

    let cli = require_cli(git_state).map_err(|_| {
        AppError::Storage(format!(
            "assets strategy requires git, but git is not available; cannot stage {asset_rel_path}"
        ))
    })?;

    let lock = git_state.get_lock(workspace_dir).await;
    let _guard = lock.lock().await;

    let output = cli
        .exec(workspace_dir, &["add", asset_rel_path])
        .await
        .map_err(|e| AppError::Storage(format!("git add {asset_rel_path} errored: {e}")))?;
    if output.exit_code != 0 {
        return Err(AppError::Storage(format!(
            "git add {asset_rel_path} failed ({}): {}",
            output.exit_code,
            output.stderr.trim()
        )));
    }
    Ok(())
}

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
/// Does NOT mutate `WorkspaceConfig` — the caller owns that.
///
/// LFS setup and history migration are best-effort: failures are collected
/// into `ApplyStrategyResult.warnings` so the UI can surface them, rather
/// than swallowed into `tracing::warn!` while the user sees a success toast.
pub async fn apply_strategy(
    git_state: &GitState,
    workspace_dir: &Path,
    new: AssetsStrategy,
) -> Result<ApplyStrategyResult, AppError> {
    let cli = require_cli(git_state)?;
    let mut result = ApplyStrategyResult::default();

    // Pre-flight: LFS strategies require git-lfs to be installed.
    if matches!(new, AssetsStrategy::LfsRemote | AssetsStrategy::LfsS3) && !cli.lfs_available() {
        return Err(AppError::Storage("git-lfs not installed".into()));
    }

    let lock = git_state.get_lock(workspace_dir).await;
    let _guard = lock.lock().await;

    let gitignore_path = workspace_dir.join(".gitignore");
    let gitattributes_path = workspace_dir.join(".gitattributes");

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
        match cli.exec(workspace_dir, &["lfs", "install", "--local"]).await {
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
        match cli
            .exec(workspace_dir, &["lfs", "track", ".assets/**"])
            .await
        {
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
                workspace_dir,
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

    // Stage the updated meta files so the user sees them in "Changes".
    // Only add files that actually exist on disk now.
    let mut to_add: Vec<&str> = Vec::new();
    if gitignore_path.exists() {
        to_add.push(".gitignore");
    }
    if gitattributes_path.exists() {
        to_add.push(".gitattributes");
    }
    if !to_add.is_empty() {
        let mut args: Vec<&str> = vec!["add"];
        args.extend(to_add);
        match cli.exec(workspace_dir, &args).await {
            Ok(o) if o.exit_code != 0 => {
                let msg = format!("git add meta files failed: {}", o.stderr.trim());
                tracing::warn!("{msg}");
                result.warnings.push(msg);
            }
            Err(e) => {
                let msg = format!("git add meta files errored: {e}");
                tracing::warn!("{msg}");
                result.warnings.push(msg);
            }
            _ => {}
        }
    }

    Ok(result)
}

/// Stub — real S3 connection check lives in Phase 4.3 (lfs-dal crate).
pub async fn check_s3_connection(
    _endpoint: String,
    _bucket: String,
    _region: String,
    _access_key: String,
    _secret_key: String,
) -> Result<bool, AppError> {
    Err(AppError::Storage(
        "S3 support will be added in Phase 4.3".into(),
    ))
}

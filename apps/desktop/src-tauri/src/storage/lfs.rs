//! LFS-side runtime state and helpers for the assets pipeline.
//!
//! - `LfsState` is the per-pool runtime indicator the frontend uses to show
//!   whether the assets in this pool are loadable right now.
//! - `is_lfs_pointer` is a cheap inspector for `.assets/` files that lets
//!   sync/watcher code detect a pointer file (LFS placeholder) without
//!   shelling out to git.
//! - `probe_lfs` runs the strategy-appropriate probe to compute the state.
//! - `repair_lfs` is the user-gesture IPC: probe + `git lfs pull` under the
//!   git lock, transitioning `Pulling → Ready` on success.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::error::AppError;
use crate::git::{GitState, ops};
use crate::index::{IndexKey, IndexState};
use crate::repo_path::{RootMode, normalize_repo_relative};
use crate::space::types::{AssetsSpaceConfig, AssetsStrategy};

use super::s3;
use super::scope::{
    AssetsStorageScope, resolve_effective_storage_scope, resolve_effective_storage_scope_for_key,
};

const LFS_POINTER_PREFIX: &str = "version https://git-lfs.github.com/spec/v1";
const LFS_POINTER_MAX_BYTES: u64 = 200;

/// Per-pool LFS runtime state. Serialized in kebab-case (`n/a` for
/// `NotApplicable`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LfsState {
    #[serde(rename = "n/a")]
    NotApplicable,
    Ready,
    MissingCreds,
    Pulling,
}

fn strategy_uses_lfs_runtime(strategy: AssetsStrategy) -> bool {
    matches!(strategy, AssetsStrategy::LfsRemote | AssetsStrategy::LfsS3)
}

fn strategy_supports_lfs_remote_diagnostic(strategy: AssetsStrategy) -> bool {
    matches!(strategy, AssetsStrategy::LfsRemote)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LfsRemoteDiagnosticReason {
    Ready,
    GitLfsMissing,
    RemoteMissing,
    AuthRequired,
    LfsUnavailable,
    ProbeFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LfsRemoteAuthMethod {
    Https,
    Ssh,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsRemoteDiagnostic {
    pub state: LfsState,
    pub reason: LfsRemoteDiagnosticReason,
    pub auth_method: LfsRemoteAuthMethod,
    pub remote_url: Option<String>,
    pub terminal_command: Option<String>,
    pub detail: Option<String>,
}

impl Default for LfsState {
    fn default() -> Self {
        LfsState::NotApplicable
    }
}

/// Detect whether `path` is an LFS pointer file. Reads up to 256 bytes; the
/// file must be under 200 bytes total AND start with the canonical pointer
/// version header. Read errors fall back to `false` (conservative — non-LFS
/// behaviour wins).
pub fn is_lfs_pointer(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() || meta.len() >= LFS_POINTER_MAX_BYTES {
        return false;
    }
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    use std::io::Read;
    let mut buf = [0u8; 256];
    let n = match file.read(&mut buf) {
        Ok(n) => n,
        Err(_) => return false,
    };
    let head = String::from_utf8_lossy(&buf[..n]);
    let first_line = head.lines().next().unwrap_or("");
    first_line == LFS_POINTER_PREFIX
}

/// Probe the LFS state of the effective storage scope for `key`:
/// - Local / InGit → NotApplicable (no LFS in play).
/// - LfsS3 → Ready iff the keychain entry exists, else MissingCreds.
/// - LfsRemote → run `git lfs pull --dry-run`; success → Ready,
///   any failure → MissingCreds (conservative: we surface the repair
///   affordance instead of pretending everything is fine).
pub async fn probe_lfs(
    app: &AppHandle,
    project: &Path,
    key: &IndexKey,
    _target_dir: &Path,
) -> LfsState {
    let index_state = app.state::<IndexState>();
    let scope =
        match resolve_effective_storage_scope_for_key(&index_state, project, key.clone()).await {
            Ok(scope) => scope,
            Err(e) => {
                tracing::warn!("probe_lfs: effective storage scope resolution failed: {e}");
                return LfsState::NotApplicable;
            }
        };
    probe_lfs_scope(app, &scope).await
}

async fn probe_lfs_scope(app: &AppHandle, scope: &AssetsStorageScope) -> LfsState {
    probe_lfs_config(app, &scope.repo_dir, &scope.config).await
}

async fn probe_lfs_config(
    app: &AppHandle,
    repo_dir: &Path,
    config: &AssetsSpaceConfig,
) -> LfsState {
    match config.strategy {
        AssetsStrategy::Local | AssetsStrategy::InGit => LfsState::NotApplicable,
        AssetsStrategy::LfsS3 => {
            let Some(s3_cfg) = config.s3.as_ref() else {
                return LfsState::MissingCreds;
            };
            let account = s3::keychain_account(s3_cfg);
            let present = tokio::task::spawn_blocking(move || {
                let Ok(entry) = keyring::Entry::new(s3::KEYCHAIN_SERVICE, &account) else {
                    return false;
                };
                entry.get_password().is_ok()
            })
            .await
            .unwrap_or(false);
            if present {
                LfsState::Ready
            } else {
                LfsState::MissingCreds
            }
        }
        AssetsStrategy::LfsRemote => {
            let git_state = app.state::<GitState>();
            let Some(cli) = git_state.cli.clone() else {
                return LfsState::MissingCreds;
            };
            match cli.exec(repo_dir, &["lfs", "pull", "--dry-run"]).await {
                Ok(out) if out.exit_code == 0 => LfsState::Ready,
                _ => LfsState::MissingCreds,
            }
        }
    }
}

/// IPC: diagnostics-only Git LFS remote probe for Settings. It does not pull
/// objects and does not mutate storage config; it only returns actionable
/// details and refreshes the coarse cached LFS state.
#[tauri::command]
pub async fn diagnose_lfs_remote(
    app: AppHandle,
    project_path: String,
    space_id: Option<String>,
    git_state: State<'_, GitState>,
    index_state: State<'_, IndexState>,
) -> Result<LfsRemoteDiagnostic, AppError> {
    let project = PathBuf::from(&project_path);
    let scope =
        resolve_effective_storage_scope(&index_state, &project, space_id.as_deref()).await?;
    if !strategy_supports_lfs_remote_diagnostic(scope.config.strategy) {
        reset_lfs_state_if_needed(&app, &index_state, &scope.pool_key).await;
        return Ok(LfsRemoteDiagnostic {
            state: LfsState::NotApplicable,
            reason: LfsRemoteDiagnosticReason::Ready,
            auth_method: LfsRemoteAuthMethod::Unknown,
            remote_url: None,
            terminal_command: None,
            detail: None,
        });
    }

    let cli = git_state.cli.clone().ok_or(AppError::GitNotFound)?;
    let diagnostic = if !cli.lfs_available() {
        LfsRemoteDiagnostic {
            state: LfsState::MissingCreds,
            reason: LfsRemoteDiagnosticReason::GitLfsMissing,
            auth_method: LfsRemoteAuthMethod::Unknown,
            remote_url: None,
            terminal_command: Some("git lfs install".to_string()),
            detail: None,
        }
    } else {
        diagnose_lfs_remote_with_cli(&cli, &scope.repo_dir).await?
    };

    index_state
        .set_lfs_state_with(&app, &scope.pool_key, diagnostic.state)
        .await;
    Ok(diagnostic)
}

async fn diagnose_lfs_remote_with_cli(
    cli: &crate::git::cli::GitCli,
    repo_dir: &Path,
) -> Result<LfsRemoteDiagnostic, AppError> {
    let Some(remote_url) = ops::get_remote(cli, repo_dir).await? else {
        return Ok(LfsRemoteDiagnostic {
            state: LfsState::MissingCreds,
            reason: LfsRemoteDiagnosticReason::RemoteMissing,
            auth_method: LfsRemoteAuthMethod::Unknown,
            remote_url: None,
            terminal_command: None,
            detail: None,
        });
    };

    let auth_method = lfs_remote_auth_method(&remote_url);
    let safe_remote_url = redact_url_credentials(&remote_url);
    let out = cli.exec(repo_dir, &["lfs", "pull", "--dry-run"]).await?;
    if out.exit_code == 0 {
        return Ok(LfsRemoteDiagnostic {
            state: LfsState::Ready,
            reason: LfsRemoteDiagnosticReason::Ready,
            auth_method,
            remote_url: Some(safe_remote_url),
            terminal_command: None,
            detail: None,
        });
    }

    let raw_detail = command_detail(&out.stdout, &out.stderr);
    let reason = classify_lfs_remote_failure(&raw_detail);
    Ok(LfsRemoteDiagnostic {
        state: LfsState::MissingCreds,
        reason,
        auth_method,
        remote_url: Some(safe_remote_url),
        terminal_command: terminal_command_for(auth_method, &remote_url, reason),
        detail: trim_diagnostic_detail(&redact_url_credentials(&raw_detail)),
    })
}

fn classify_lfs_remote_failure(detail: &str) -> LfsRemoteDiagnosticReason {
    if ops::is_git_auth_error(detail) {
        return LfsRemoteDiagnosticReason::AuthRequired;
    }
    let lower = detail.to_ascii_lowercase();
    if lower.contains("repository or object not found")
        || lower.contains("lfs is disabled")
        || lower.contains("git lfs is disabled")
        || lower.contains("lfs is not enabled")
        || lower.contains("git-lfs is not enabled")
        || lower.contains("not found")
        || lower.contains("404")
    {
        return LfsRemoteDiagnosticReason::LfsUnavailable;
    }
    if ops::is_git_no_remote_error(detail) {
        return LfsRemoteDiagnosticReason::RemoteMissing;
    }
    LfsRemoteDiagnosticReason::ProbeFailed
}

fn lfs_remote_auth_method(remote_url: &str) -> LfsRemoteAuthMethod {
    let lower = remote_url.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        LfsRemoteAuthMethod::Https
    } else if lower.starts_with("ssh://") || looks_like_scp_remote(remote_url) {
        LfsRemoteAuthMethod::Ssh
    } else {
        LfsRemoteAuthMethod::Unknown
    }
}

fn terminal_command_for(
    auth_method: LfsRemoteAuthMethod,
    remote_url: &str,
    reason: LfsRemoteDiagnosticReason,
) -> Option<String> {
    match reason {
        LfsRemoteDiagnosticReason::Ready | LfsRemoteDiagnosticReason::RemoteMissing => None,
        LfsRemoteDiagnosticReason::GitLfsMissing => Some("git lfs install".to_string()),
        LfsRemoteDiagnosticReason::AuthRequired
            if matches!(auth_method, LfsRemoteAuthMethod::Ssh) =>
        {
            Some(ssh_probe_command(remote_url).unwrap_or_else(|| "ssh -T <git-host>".to_string()))
        }
        LfsRemoteDiagnosticReason::AuthRequired
        | LfsRemoteDiagnosticReason::LfsUnavailable
        | LfsRemoteDiagnosticReason::ProbeFailed => Some("git lfs fetch origin".to_string()),
    }
}

fn command_detail(stdout: &str, stderr: &str) -> String {
    let stdout = stdout.trim();
    let stderr = stderr.trim();
    match (stdout.is_empty(), stderr.is_empty()) {
        (true, true) => String::new(),
        (false, true) => stdout.to_string(),
        (true, false) => stderr.to_string(),
        (false, false) => format!("{stdout}\n{stderr}"),
    }
}

fn trim_diagnostic_detail(detail: &str) -> Option<String> {
    let trimmed = detail.trim();
    if trimmed.is_empty() {
        return None;
    }
    const MAX_CHARS: usize = 1200;
    if trimmed.chars().count() <= MAX_CHARS {
        Some(trimmed.to_string())
    } else {
        let mut out: String = trimmed.chars().take(MAX_CHARS).collect();
        out.push_str("\n...");
        Some(out)
    }
}

fn redact_url_credentials(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(scheme_idx) = rest.find("://") {
        let (before, after_before) = rest.split_at(scheme_idx + 3);
        out.push_str(before);
        rest = after_before;

        let authority_end = rest
            .find(|c: char| c == '/' || c.is_whitespace())
            .unwrap_or(rest.len());
        let (authority, after_authority) = rest.split_at(authority_end);
        if let Some(at_idx) = authority.rfind('@') {
            out.push_str("***@");
            out.push_str(&authority[at_idx + 1..]);
        } else {
            out.push_str(authority);
        }
        rest = after_authority;
    }
    out.push_str(rest);
    out
}

fn looks_like_scp_remote(remote_url: &str) -> bool {
    if remote_url.contains("://") {
        return false;
    }
    let Some(colon_idx) = remote_url.find(':') else {
        return false;
    };
    let host_part = &remote_url[..colon_idx];
    !host_part.is_empty() && !host_part.contains('/')
}

fn ssh_probe_command(remote_url: &str) -> Option<String> {
    if let Some(rest) = remote_url.strip_prefix("ssh://") {
        let authority_end = rest.find('/').unwrap_or(rest.len());
        let authority = &rest[..authority_end];
        if authority.is_empty() {
            return None;
        }
        return Some(format!("ssh -T {authority}"));
    }

    if looks_like_scp_remote(remote_url) {
        let authority = remote_url.split(':').next()?;
        if authority.is_empty() {
            None
        } else {
            Some(format!("ssh -T {authority}"))
        }
    } else {
        None
    }
}

/// Called after `git_sync` completes successfully. If any file inside
/// `target_dir/.assets/` from `changed_rel_paths` is currently an LFS pointer
/// AND the strategy is LFS-flavoured, probe credentials and — on success —
/// spawn `git lfs pull` in the background, with state transitioning
/// `Pulling → Ready` (or `MissingCreds` on probe/pull failure).
///
/// Returns immediately; the actual pull runs on a tokio task so it does
/// not block the sync IPC response.
pub fn maybe_auto_pull_after_sync(
    app: &AppHandle,
    key: &IndexKey,
    target_dir: &Path,
    changed_rel_paths: &[String],
) {
    let has_pointer = changed_rel_paths
        .iter()
        .filter_map(|p| normalize_repo_relative(p, RootMode::Reject).ok())
        .filter(|p| p.starts_with(".assets/"))
        .any(|p| is_lfs_pointer(&target_dir.join(p)));
    if !has_pointer {
        return;
    }

    let app = app.clone();
    let key = key.clone();
    let project = key.project().to_path_buf();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<IndexState>();
        let scope =
            match resolve_effective_storage_scope_for_key(&state, &project, key.clone()).await {
                Ok(scope) => scope,
                Err(e) => {
                    tracing::warn!("auto-pull (post-sync): effective storage scope failed: {e}");
                    return;
                }
            };
        if !strategy_uses_lfs_runtime(scope.config.strategy) {
            reset_lfs_state_if_needed(&app, &state, &scope.pool_key).await;
            return;
        }

        let probed = probe_lfs_scope(&app, &scope).await;
        if !matches!(probed, LfsState::Ready) {
            state
                .set_lfs_state_with(&app, &scope.pool_key, probed)
                .await;
            return;
        }
        let git_state = app.state::<GitState>();
        let Some(cli) = git_state.cli.clone() else {
            state
                .set_lfs_state_with(&app, &scope.pool_key, LfsState::MissingCreds)
                .await;
            return;
        };
        state
            .set_lfs_state_with(&app, &scope.pool_key, LfsState::Pulling)
            .await;
        let lock = git_state.get_lock(&scope.repo_dir).await;
        let _guard = lock.lock().await;
        let result = cli.exec(&scope.repo_dir, &["lfs", "pull"]).await;
        drop(_guard);
        let next = match result {
            Ok(out) if out.exit_code == 0 => LfsState::Ready,
            Ok(out) => {
                tracing::warn!(
                    "auto-pull (post-sync): git lfs pull failed ({}): {}",
                    out.exit_code,
                    out.stderr.trim()
                );
                LfsState::MissingCreds
            }
            Err(e) => {
                tracing::warn!("auto-pull (post-sync): git lfs pull errored: {e}");
                LfsState::MissingCreds
            }
        };
        state.set_lfs_state_with(&app, &scope.pool_key, next).await;
    });
}

/// IPC: user-triggered "Repair LFS" — probe, then run `git lfs pull` under
/// the target_dir's git lock. Emits `lfs_state_changed` for `Pulling` →
/// `Ready` (or back to `MissingCreds` on failure).
#[tauri::command]
pub async fn repair_lfs(
    app: AppHandle,
    project_path: String,
    space_id: Option<String>,
    git_state: State<'_, GitState>,
    index_state: State<'_, IndexState>,
) -> Result<LfsState, AppError> {
    let project = PathBuf::from(&project_path);
    let scope =
        resolve_effective_storage_scope(&index_state, &project, space_id.as_deref()).await?;
    if !strategy_uses_lfs_runtime(scope.config.strategy) {
        reset_lfs_state_if_needed(&app, &index_state, &scope.pool_key).await;
        return Ok(LfsState::NotApplicable);
    }

    let cli = git_state.cli.clone().ok_or(AppError::GitNotFound)?;

    index_state
        .set_lfs_state_with(&app, &scope.pool_key, LfsState::Pulling)
        .await;

    let lock = git_state.get_lock(&scope.repo_dir).await;
    let _guard = lock.lock().await;
    let out = cli
        .exec(&scope.repo_dir, &["lfs", "pull"])
        .await
        .map_err(|e| AppError::Storage(format!("git lfs pull errored: {e}")))?;
    drop(_guard);

    let new_state = if out.exit_code == 0 {
        // Re-probe to confirm — pull may have succeeded but the underlying
        // strategy could still be in a degraded state (e.g. partial fetch).
        probe_lfs_scope(&app, &scope).await
    } else {
        tracing::warn!(
            "repair_lfs: git lfs pull failed ({}): {}",
            out.exit_code,
            out.stderr.trim()
        );
        LfsState::MissingCreds
    };
    index_state
        .set_lfs_state_with(&app, &scope.pool_key, new_state)
        .await;
    Ok(new_state)
}

/// IPC: lazily probe the LFS state for a pool. If the cached state is
/// `NotApplicable` and the strategy actually requires LFS, this triggers a
/// probe and caches the result; otherwise it returns the cached value.
#[tauri::command]
pub async fn get_lfs_state(
    app: AppHandle,
    project_path: String,
    space_id: Option<String>,
    index_state: State<'_, IndexState>,
) -> Result<LfsState, AppError> {
    let project = PathBuf::from(&project_path);
    let scope =
        resolve_effective_storage_scope(&index_state, &project, space_id.as_deref()).await?;

    // Only probe if the strategy is LFS-flavoured — otherwise NotApplicable
    // is correct and re-probing would be wasted work.
    if !strategy_uses_lfs_runtime(scope.config.strategy) {
        reset_lfs_state_if_needed(&app, &index_state, &scope.pool_key).await;
        return Ok(LfsState::NotApplicable);
    }

    let cached = index_state.get_lfs_state(&scope.pool_key).await;
    if !matches!(cached, LfsState::NotApplicable) {
        return Ok(cached);
    }

    let probed = probe_lfs_scope(&app, &scope).await;
    index_state
        .set_lfs_state_with(&app, &scope.pool_key, probed)
        .await;
    Ok(probed)
}

async fn reset_lfs_state_if_needed(app: &AppHandle, index_state: &IndexState, key: &IndexKey) {
    let cached = index_state.get_lfs_state(key).await;
    if !matches!(cached, LfsState::NotApplicable) {
        index_state
            .set_lfs_state_with(app, key, LfsState::NotApplicable)
            .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lfs_runtime_is_used_only_by_lfs_strategies() {
        assert!(!strategy_uses_lfs_runtime(AssetsStrategy::Local));
        assert!(!strategy_uses_lfs_runtime(AssetsStrategy::InGit));
        assert!(strategy_uses_lfs_runtime(AssetsStrategy::LfsRemote));
        assert!(strategy_uses_lfs_runtime(AssetsStrategy::LfsS3));
    }

    #[test]
    fn lfs_remote_diagnostic_is_only_for_lfs_remote_strategy() {
        assert!(!strategy_supports_lfs_remote_diagnostic(
            AssetsStrategy::Local
        ));
        assert!(!strategy_supports_lfs_remote_diagnostic(
            AssetsStrategy::InGit
        ));
        assert!(strategy_supports_lfs_remote_diagnostic(
            AssetsStrategy::LfsRemote
        ));
        assert!(!strategy_supports_lfs_remote_diagnostic(
            AssetsStrategy::LfsS3
        ));
    }

    #[test]
    fn classifies_auth_errors_before_remote_errors() {
        let reason = classify_lfs_remote_failure(
            "Permission denied (publickey).\nfatal: Could not read from remote repository.",
        );

        assert_eq!(reason, LfsRemoteDiagnosticReason::AuthRequired);
    }

    #[test]
    fn classifies_lfs_unavailable_errors() {
        let reason = classify_lfs_remote_failure(
            "batch response: Repository or object not found: https://github.com/org/repo.git/info/lfs/objects/batch",
        );

        assert_eq!(reason, LfsRemoteDiagnosticReason::LfsUnavailable);
    }

    #[test]
    fn redacts_https_credentials_in_details() {
        let redacted = redact_url_credentials(
            "fatal: Authentication failed for 'https://token:secret@example.com/org/repo.git/'",
        );

        assert_eq!(
            redacted,
            "fatal: Authentication failed for 'https://***@example.com/org/repo.git/'"
        );
    }

    #[test]
    fn builds_ssh_probe_commands_for_remote_shapes() {
        assert_eq!(
            ssh_probe_command("git@github.com:org/repo.git").as_deref(),
            Some("ssh -T git@github.com")
        );
        assert_eq!(
            ssh_probe_command("ssh://git@example.com/org/repo.git").as_deref(),
            Some("ssh -T git@example.com")
        );
    }
}

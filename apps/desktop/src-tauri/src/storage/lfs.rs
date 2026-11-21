//! LFS-side runtime state and helpers for repository storage.
//!
//! - `LfsStatus` (core) is the per-pool runtime indicator the frontend uses to
//!   show whether LFS-backed files in this storage scope are loadable and on
//!   this device.
//! - `download_in_background` runs the core download of the missing LFS files
//!   after a clone or a sync (DF-368 R1), one per repository (R5).
//! - `repair_lfs` is the "Download files" gesture: the same download.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use svode_core::git::cli::GitOutput;
use svode_core::storage::lfs::{
    LfsState, is_offline_probe_failure, probe_readiness, run_remote_probe,
};
use svode_core::storage::lfs_download::{
    DownloadPlan, LfsStatus, MissingFiles, download, plan_download,
};
use tauri::{AppHandle, Manager, State};

use crate::error::AppError;
use crate::git::GitState;
use crate::index::{IndexKey, IndexState};
use crate::space::types::AssetsStrategy;
use svode_core::git::ops;

use super::scope::{
    AssetsStorageScope, resolve_effective_storage_scope, resolve_effective_storage_scope_for_key,
};

fn strategy_uses_lfs_runtime(strategy: &AssetsStrategy) -> bool {
    matches!(strategy, AssetsStrategy::LfsRemote | AssetsStrategy::LfsS3)
}

fn strategy_supports_lfs_remote_diagnostic(strategy: &AssetsStrategy) -> bool {
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
    /// The server is out of reach of the network: no refusal of access
    /// (DF-368 R6).
    Unreachable,
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

async fn probe_lfs_scope(app: &AppHandle, scope: &AssetsStorageScope) -> LfsState {
    probe_readiness(
        app.state::<GitState>().runtime(),
        &scope.repo_dir,
        &scope.config,
    )
    .await
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
    if !strategy_supports_lfs_remote_diagnostic(&scope.config.strategy) {
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

    let cli = git_state.detected().cloned().ok_or(AppError::GitNotFound)?;
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
    cli: &svode_core::git::cli::GitCli,
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
    let out = run_remote_probe(cli, repo_dir).await?;
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
    let reason = probe_failure_reason(&out, &raw_detail);
    // A server out of reach is not a refusal of access (DF-368 R6).
    let state = if reason == LfsRemoteDiagnosticReason::Unreachable {
        LfsState::Ready
    } else {
        LfsState::MissingCreds
    };
    Ok(LfsRemoteDiagnostic {
        state,
        reason,
        auth_method,
        remote_url: Some(safe_remote_url),
        terminal_command: terminal_command_for(auth_method, &remote_url, reason),
        detail: trim_diagnostic_detail(&redact_url_credentials(&raw_detail)),
    })
}

/// Why the failed probe `out` with output `detail` failed: a probe past its
/// deadline did not reach the server (DF-378 R3).
fn probe_failure_reason(out: &GitOutput, detail: &str) -> LfsRemoteDiagnosticReason {
    if out.is_timed_out() {
        return LfsRemoteDiagnosticReason::Unreachable;
    }
    classify_lfs_remote_failure(detail)
}

fn classify_lfs_remote_failure(detail: &str) -> LfsRemoteDiagnosticReason {
    if ops::is_git_auth_error(detail) {
        return LfsRemoteDiagnosticReason::AuthRequired;
    }
    if is_offline_probe_failure(detail) {
        return LfsRemoteDiagnosticReason::Unreachable;
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
        LfsRemoteDiagnosticReason::Ready
        | LfsRemoteDiagnosticReason::RemoteMissing
        | LfsRemoteDiagnosticReason::Unreachable => None,
        LfsRemoteDiagnosticReason::GitLfsMissing => Some("git lfs install".to_string()),
        LfsRemoteDiagnosticReason::AuthRequired
            if matches!(auth_method, LfsRemoteAuthMethod::Ssh) =>
        {
            Some(ssh_probe_command(remote_url).unwrap_or_else(|| "ssh -T <git-host>".to_string()))
        }
        LfsRemoteDiagnosticReason::AuthRequired => None,
        LfsRemoteDiagnosticReason::LfsUnavailable | LfsRemoteDiagnosticReason::ProbeFailed => {
            Some("git lfs fetch origin".to_string())
        }
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

/// The repositories with a running LFS download (DF-368 R5): a reason to
/// download during a download marks it to run again once it ends.
#[derive(Default)]
pub struct LfsDownloads(Mutex<HashMap<PathBuf, bool>>);

/// The right to run the download of one repository; dropping it releases
/// the repository.
struct DownloadSlot<'a> {
    downloads: &'a LfsDownloads,
    repo_dir: PathBuf,
    released: bool,
}

impl LfsDownloads {
    /// The slot of `repo_dir` when no download of it runs; otherwise the
    /// running one is marked to run again.
    fn begin(&self, repo_dir: &Path) -> Option<DownloadSlot<'_>> {
        let mut running = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(again) = running.get_mut(repo_dir) {
            *again = true;
            return None;
        }
        running.insert(repo_dir.to_path_buf(), false);
        Some(DownloadSlot {
            downloads: self,
            repo_dir: repo_dir.to_path_buf(),
            released: false,
        })
    }
}

impl DownloadSlot<'_> {
    /// Whether a reason to download came during the run; otherwise the
    /// repository is released in the same step, so no reason is lost.
    fn again(&mut self) -> bool {
        let mut running = self
            .downloads
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if running.get(&self.repo_dir) == Some(&true) {
            running.insert(self.repo_dir.clone(), false);
            return true;
        }
        running.remove(&self.repo_dir);
        self.released = true;
        false
    }
}

impl Drop for DownloadSlot<'_> {
    fn drop(&mut self) {
        if !self.released {
            self.downloads
                .0
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&self.repo_dir);
        }
    }
}

/// Download the missing LFS files of the effective storage scope of `key` in
/// the background (DF-368 R1): after a clone through Svode and after every
/// successful sync.
pub fn download_in_background(app: &AppHandle, key: IndexKey) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        download_missing(&app, key).await;
    });
}

/// The download of the missing LFS files of the scope of `key`, unless one
/// of its repository runs: then that one runs again after it, downloading
/// only when files went missing meanwhile (R5). The LFS status of the scope
/// follows the plan and the outcome.
async fn download_missing(app: &AppHandle, key: IndexKey) {
    let index = app.state::<IndexState>();
    let project = key.project().to_path_buf();
    let scope = match resolve_effective_storage_scope_for_key(&index, &project, key).await {
        Ok(scope) => scope,
        Err(error) => {
            tracing::warn!("LFS download: effective storage scope failed: {error}");
            return;
        }
    };
    let repository = std::fs::canonicalize(&scope.repo_dir).unwrap_or(scope.repo_dir.clone());
    let Some(mut slot) = index.lfs_downloads().begin(&repository) else {
        return;
    };
    let git = app.state::<GitState>().runtime().clone();
    let Some(cli) = git.detected().cloned() else {
        return;
    };
    let cli = cli.reporting_transfers_to(crate::git::delivery::host(app));
    let mut previous: Option<MissingFiles> = None;
    loop {
        match plan_download(&git, &scope.repo_dir, &scope.config).await {
            Err(error) => tracing::warn!("LFS download: planning failed: {error}"),
            Ok(DownloadPlan::Download(missing))
                if previous
                    .as_ref()
                    .is_some_and(|known| !missing.adds_to(known)) => {}
            Ok(plan) => {
                let status = index.get_lfs_status(&scope.pool_key).await.planned(&plan);
                index.set_lfs_status(app, &scope.pool_key, status).await;
                if let DownloadPlan::Download(missing) = plan {
                    let outcome = download(&git, &cli, &scope.repo_dir, &missing).await;
                    if let Some(stop) = &outcome.stop {
                        tracing::warn!(
                            "LFS download stopped with {} files missing: {stop:?}",
                            outcome.missing.files().len()
                        );
                    }
                    index
                        .set_lfs_status(app, &scope.pool_key, LfsStatus::downloaded(&outcome))
                        .await;
                    previous = Some(missing);
                }
            }
        }
        if !slot.again() {
            break;
        }
    }
}

/// IPC: the "Download files" gesture of Settings → Storage — the download of
/// the missing LFS files of the scope (DF-368 R1). While one runs, it runs
/// again after it. Returns the LFS state the download left.
#[tauri::command]
pub async fn repair_lfs(
    app: AppHandle,
    project_path: String,
    space_id: Option<String>,
    index_state: State<'_, IndexState>,
) -> Result<LfsState, AppError> {
    let project = PathBuf::from(&project_path);
    let scope =
        resolve_effective_storage_scope(&index_state, &project, space_id.as_deref()).await?;
    if !strategy_uses_lfs_runtime(&scope.config.strategy) {
        reset_lfs_state_if_needed(&app, &index_state, &scope.pool_key).await;
        return Ok(LfsState::NotApplicable);
    }
    app.state::<GitState>().require_cli()?;
    download_missing(&app, scope.pool_key.clone()).await;
    Ok(index_state.get_lfs_state(&scope.pool_key).await)
}

/// IPC: the LFS state of the scope with the files the last download left
/// without content and why it stopped (DF-368 R6). S3 readiness resolves the
/// current Variables snapshot on every read; active transfers keep their
/// state; remote-provider probes remain cached.
#[tauri::command]
pub async fn get_lfs_status(
    app: AppHandle,
    project_path: String,
    space_id: Option<String>,
    index_state: State<'_, IndexState>,
) -> Result<LfsStatus, AppError> {
    lfs_status(&app, &index_state, &project_path, space_id).await
}

async fn lfs_status(
    app: &AppHandle,
    index_state: &IndexState,
    project_path: &str,
    space_id: Option<String>,
) -> Result<LfsStatus, AppError> {
    let project = PathBuf::from(project_path);
    let scope = resolve_effective_storage_scope(index_state, &project, space_id.as_deref()).await?;

    // Only probe if the strategy is LFS-flavoured — otherwise NotApplicable
    // is correct and re-probing would be wasted work.
    if !strategy_uses_lfs_runtime(&scope.config.strategy) {
        reset_lfs_state_if_needed(app, index_state, &scope.pool_key).await;
        return Ok(LfsStatus::default());
    }

    let cached = index_state.get_lfs_status(&scope.pool_key).await;
    if matches!(cached.state, LfsState::Pulling)
        || (!matches!(scope.config.strategy, AssetsStrategy::LfsS3)
            && !matches!(cached.state, LfsState::NotApplicable))
    {
        return Ok(cached);
    }

    let probed = probe_lfs_scope(app, &scope).await;
    index_state
        .set_lfs_state_with(app, &scope.pool_key, probed)
        .await;
    Ok(index_state.get_lfs_status(&scope.pool_key).await)
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
    fn a_reason_to_download_during_a_download_runs_it_once_more() {
        let downloads = LfsDownloads::default();
        let repo = Path::new("/projects/a");
        let other = Path::new("/projects/b");
        let mut slot = downloads.begin(repo).expect("the first download runs");
        // Another repository downloads on its own.
        assert!(downloads.begin(other).is_some());
        // Two reasons during the run: no second download, one more run.
        assert!(downloads.begin(repo).is_none());
        assert!(downloads.begin(repo).is_none());
        assert!(slot.again());
        assert!(!slot.again());
        drop(slot);
        // Released: the next reason runs a download again.
        let slot = downloads.begin(repo).expect("released");
        drop(slot);
        // A run that ended without `again` (a panic) releases as well.
        assert!(downloads.begin(repo).is_some());
    }

    #[test]
    fn lfs_runtime_is_used_only_by_lfs_strategies() {
        assert!(!strategy_uses_lfs_runtime(&AssetsStrategy::Local));
        assert!(!strategy_uses_lfs_runtime(&AssetsStrategy::InGit));
        assert!(strategy_uses_lfs_runtime(&AssetsStrategy::LfsRemote));
        assert!(strategy_uses_lfs_runtime(&AssetsStrategy::LfsS3));
    }

    #[test]
    fn lfs_remote_diagnostic_is_only_for_lfs_remote_strategy() {
        assert!(!strategy_supports_lfs_remote_diagnostic(
            &AssetsStrategy::Local
        ));
        assert!(!strategy_supports_lfs_remote_diagnostic(
            &AssetsStrategy::InGit
        ));
        assert!(strategy_supports_lfs_remote_diagnostic(
            &AssetsStrategy::LfsRemote
        ));
        assert!(!strategy_supports_lfs_remote_diagnostic(
            &AssetsStrategy::LfsS3
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

    /// DF-368 R6: a server out of network reach is told from a refusal.
    #[test]
    fn classifies_a_server_out_of_network_reach_apart_from_a_refusal() {
        let reason = classify_lfs_remote_failure(
            "Fetching reference refs/heads/main\nbatch request: ssh: connect to host 213.0.113.5 port 2222: Network is unreachable\nerror: failed to fetch some objects",
        );

        assert_eq!(reason, LfsRemoteDiagnosticReason::Unreachable);
        assert_eq!(
            terminal_command_for(
                LfsRemoteAuthMethod::Https,
                "https://example.com/r.git",
                reason
            ),
            None
        );
    }

    /// DF-378 R3: a probe stopped at its deadline did not reach the server,
    /// which is no refusal of access.
    #[test]
    fn a_probe_past_its_deadline_is_a_server_out_of_reach() {
        let out = GitOutput::timed_out(std::time::Duration::from_secs(60));
        let detail = command_detail(&out.stdout, &out.stderr);

        assert_eq!(
            probe_failure_reason(&out, &detail),
            LfsRemoteDiagnosticReason::Unreachable
        );
        let refused = GitOutput {
            stdout: String::new(),
            stderr: "git@lfs.example: Permission denied (publickey).".to_string(),
            exit_code: 2,
        };
        assert_eq!(
            probe_failure_reason(&refused, &refused.stderr),
            LfsRemoteDiagnosticReason::AuthRequired
        );
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

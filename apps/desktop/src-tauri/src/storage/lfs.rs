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
use crate::git::GitState;
use crate::index::{IndexKey, IndexState};
use crate::repo_path::{RootMode, normalize_repo_relative};
use crate::space::config::read_space_config;
use crate::space::types::AssetsStrategy;

use super::s3;
use super::scope::resolve_effective_storage_scope;

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

/// Probe the LFS state of the pool whose data lives in `target_dir`. The
/// strategy is read from `target_dir`'s `.svode/config.json`:
/// - Local / InGit → NotApplicable (no LFS in play).
/// - LfsS3 → Ready iff the keychain entry exists, else MissingCreds.
/// - LfsRemote → run `git lfs pull --dry-run`; success → Ready,
///   any failure → MissingCreds (conservative: we surface the repair
///   affordance instead of pretending everything is fine).
pub async fn probe_lfs(
    app: &AppHandle,
    _project: &Path,
    _key: &IndexKey,
    target_dir: &Path,
) -> LfsState {
    let cfg = match read_space_config(target_dir) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(
                "probe_lfs: read_space_config failed for {}: {e}",
                target_dir.display()
            );
            return LfsState::NotApplicable;
        }
    };
    let strategy = cfg.assets.as_ref().map(|a| a.strategy).unwrap_or_default();

    match strategy {
        AssetsStrategy::Local | AssetsStrategy::InGit => LfsState::NotApplicable,
        AssetsStrategy::LfsS3 => {
            let Some(s3_cfg) = cfg.assets.as_ref().and_then(|a| a.s3.as_ref()) else {
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
            match cli.exec(target_dir, &["lfs", "pull", "--dry-run"]).await {
                Ok(out) if out.exit_code == 0 => LfsState::Ready,
                _ => LfsState::MissingCreds,
            }
        }
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
    let target_dir = target_dir.to_path_buf();
    let project = key.project().to_path_buf();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<IndexState>();
        let probed = probe_lfs(&app, &project, &key, &target_dir).await;
        if !matches!(probed, LfsState::Ready) {
            state.set_lfs_state_with(&app, &key, probed).await;
            return;
        }
        let git_state = app.state::<GitState>();
        let Some(cli) = git_state.cli.clone() else {
            state
                .set_lfs_state_with(&app, &key, LfsState::MissingCreds)
                .await;
            return;
        };
        state
            .set_lfs_state_with(&app, &key, LfsState::Pulling)
            .await;
        let lock = git_state.get_lock(&target_dir).await;
        let _guard = lock.lock().await;
        let result = cli.exec(&target_dir, &["lfs", "pull"]).await;
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
        state.set_lfs_state_with(&app, &key, next).await;
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
        probe_lfs(&app, &project, &scope.pool_key, &scope.repo_dir).await
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

    let cached = index_state.get_lfs_state(&scope.pool_key).await;
    if !matches!(cached, LfsState::NotApplicable) {
        return Ok(cached);
    }

    // Only probe if the strategy is LFS-flavoured — otherwise NotApplicable
    // is correct and re-probing would be wasted work.
    if !matches!(
        scope.config.strategy,
        AssetsStrategy::LfsRemote | AssetsStrategy::LfsS3
    ) {
        return Ok(LfsState::NotApplicable);
    }

    let probed = probe_lfs(&app, &project, &scope.pool_key, &scope.repo_dir).await;
    index_state
        .set_lfs_state_with(&app, &scope.pool_key, probed)
        .await;
    Ok(probed)
}

use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

const EVENT_COMMITTED: &str = "git:committed";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CommittedPayload {
    space_path: String,
    repo_path: String,
}

pub(crate) fn publish_commit(app: &AppHandle, space: &Path, repo: &Path) {
    dispatch_commit(
        space,
        repo,
        |space, repo| emit_committed(app, space, repo),
        |repo| schedule_auto_sync(app, repo),
    );
}

pub(crate) fn emit_committed(app: &AppHandle, space_path: &Path, repo_path: &Path) {
    if let Err(error) = crate::actors::invalidate_repository(app, repo_path) {
        tracing::warn!(
            repository = %repo_path.display(),
            "failed to invalidate actor catalog after commit: {error}"
        );
    }
    let payload = CommittedPayload {
        space_path: space_path.to_string_lossy().to_string(),
        repo_path: repo_path.to_string_lossy().to_string(),
    };
    if let Err(error) = app.emit(EVENT_COMMITTED, payload) {
        tracing::warn!("failed to emit {EVENT_COMMITTED}: {error}");
    }
}

pub(crate) fn schedule_auto_sync(app: &AppHandle, repo: &Path) {
    if !auto_sync_enabled(repo) {
        return;
    }
    let app = app.clone();
    let repo = repo.to_path_buf();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = super::publication_flow::sync(&app, &repo, true, false).await {
            tracing::warn!(kind = error.kind(), "auto-sync after commit failed");
        }
    });
}

pub(crate) fn dispatch_commit(
    space: &Path,
    repo: &Path,
    emit: impl FnOnce(&Path, &Path),
    sync: impl FnOnce(&Path),
) {
    emit(space, repo);
    if auto_sync_enabled(repo) {
        sync(repo);
    }
}

pub(crate) fn auto_sync_enabled(repo_path: &Path) -> bool {
    crate::space::config::effective_git_user_policy(repo_path).auto_sync
}

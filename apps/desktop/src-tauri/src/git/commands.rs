use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use super::autocommit::{AutocommitService, SystemCommitKind};
use super::cli::{GitAvailability, GitCli};
use super::ops::{GitStatus, UnpushedCommit};
use super::sync::SyncResult;
use crate::AppError;
use crate::index::{IndexKey, IndexState};
use crate::space::types::SpaceGitType;
use crate::system_path;

/// Emit `space:synced` after a successful `git_sync(space)` finishes (and any
/// reindex/post-sync work is done). Consumers — file watcher reindex,
/// cross-space link re-validation — see a fresh index.
fn emit_space_synced(app: &AppHandle, key: &IndexKey) {
    let (project_path, space_id) = match key {
        IndexKey::Root(p) => (system_path::user_facing_path(p), None),
        IndexKey::Space { project, space_id } => (
            system_path::user_facing_path(project),
            Some(space_id.clone()),
        ),
    };
    let _ = app.emit(
        "space:synced",
        serde_json::json!({
            "projectPath": project_path,
            "spaceId": space_id,
        }),
    );
}

/// Helper: read the GitCli reference (clone is cheap — PathBuf only) outside the
/// per-space lock, so async work that needs `&AppHandle` doesn't borrow
/// `state`.
pub(crate) fn require_cli(state: &GitState) -> Result<GitCli, AppError> {
    state.cli.clone().ok_or(AppError::GitNotFound)
}

async fn stage_pending_paths(cli: &GitCli, repo: &Path, paths: &[PathBuf]) {
    for abs_path in paths {
        let rel = abs_path
            .strip_prefix(repo)
            .unwrap_or(abs_path)
            .to_string_lossy()
            .replace('\\', "/");
        let _ = super::ops::add(cli, repo, &rel).await;
    }
}

pub(crate) fn auto_commit_structural_enabled(space_path: &Path) -> bool {
    crate::space::config::read_space_config(space_path)
        .ok()
        .and_then(|config| config.git)
        .and_then(|git| git.auto_commit_structural)
        .unwrap_or(false)
}

pub(crate) async fn init_repo_with_policy(cli: &GitCli, path: &Path) -> Result<(), AppError> {
    let out = cli.exec(path, &["init"]).await?;
    if out.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "git init failed: {}",
            out.stderr
        )));
    }

    cli.exec(path, &["config", "core.quotePath", "false"])
        .await?;
    super::ops::ensure_svode_gitignore(path)?;

    if auto_commit_structural_enabled(path) {
        super::ops::add_all(cli, path).await?;
        let _ = super::ops::commit(cli, path, "Scaffold .svode").await?;
    }

    tracing::info!("Initialized git repo at {}", path.display());
    Ok(())
}

pub struct GitState {
    pub(crate) cli: Option<GitCli>,
    locks: tokio::sync::Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>,
}

impl GitState {
    pub fn new() -> Self {
        let cli = match GitCli::detect() {
            Ok(cli) => Some(cli),
            Err(e) => {
                tracing::warn!("Git not available: {e}");
                None
            }
        };
        Self {
            cli,
            locks: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    /// Get the GitCli instance, returning GitNotFound if git is not available.
    fn cli(&self) -> Result<&GitCli, AppError> {
        self.cli.as_ref().ok_or(AppError::GitNotFound)
    }

    /// Get or create a per-space lock. Public so other modules
    /// (like the space creation flow) can serialize git work too.
    pub(crate) async fn get_lock(&self, path: &Path) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.locks.lock().await;
        locks
            .entry(path.to_path_buf())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }
}

#[tauri::command]
pub async fn git_check_availability(
    state: State<'_, GitState>,
) -> Result<GitAvailability, AppError> {
    match &state.cli {
        Some(cli) => Ok(cli.check_availability().await),
        None => Ok(GitAvailability {
            git: false,
            git_lfs: false,
            git_version: None,
        }),
    }
}

#[tauri::command]
pub async fn git_init_space(
    state: State<'_, GitState>,
    space_path: String,
) -> Result<(), AppError> {
    let path = PathBuf::from(&space_path);
    let lock = state.get_lock(&path).await;
    let _guard = lock.lock().await;
    init_repo_with_policy(state.cli()?, &path).await
}

#[tauri::command]
pub async fn git_clone_space(
    state: State<'_, GitState>,
    autocommit: State<'_, Arc<AutocommitService>>,
    app: AppHandle,
    url: String,
    target_path: String,
    project_path: String,
    git_type: String,
) -> Result<(), AppError> {
    super::ops::validate_clone_url(&url)?;

    if git_type == "submodule" {
        let project = PathBuf::from(&project_path);
        let cli = require_cli(&state)?;
        let target = PathBuf::from(&target_path);
        let space_folder = target
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let lock = state.get_lock(&project).await;
        let _guard = lock.lock().await;
        super::clone::submodule_add_with_progress(&cli, &app, &project, &url, &space_folder)
            .await?;
        // Scaffold .svode/ and README.md if not present
        let svode_dir = target.join(".svode");
        let svode_existed_before = svode_dir.exists();
        let readme_existed_before = target.join("README.md").exists();
        if svode_existed_before {
            crate::space::project::ensure_scope_readme(&target, &space_folder)?;
        } else {
            crate::space::scaffold::scaffold_space(&target, &space_folder, "", "")?;
        }
        drop(_guard);
        if !svode_existed_before || !readme_existed_before {
            let commit_result = if !svode_existed_before && readme_existed_before {
                autocommit.commit_scaffold(project, target).await
            } else if !svode_existed_before {
                autocommit
                    .commit_scaffold_with_readme(project, target)
                    .await
            } else {
                autocommit.commit_scope_readme(project, target).await
            };
            if let Err(e) = commit_result {
                tracing::warn!("commit_scaffold failed after submodule clone: {e}");
            }
        }
    } else {
        // independent
        let path = PathBuf::from(&target_path);
        let cli = require_cli(&state)?;
        let lock = state.get_lock(&path).await;
        let _guard = lock.lock().await;
        super::clone::clone_with_progress(&cli, &app, &url, &path).await?;
        let project = PathBuf::from(&project_path);
        let space_folder = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        super::ops::add_independent_gitignore(&project, &space_folder)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn git_get_remote(
    state: State<'_, GitState>,
    space_path: String,
) -> Result<Option<String>, AppError> {
    let path = PathBuf::from(&space_path);
    let lock = state.get_lock(&path).await;
    let _guard = lock.lock().await;
    super::ops::get_remote(state.cli()?, &path).await
}

#[tauri::command]
pub async fn git_set_remote(
    state: State<'_, GitState>,
    autocommit: State<'_, Arc<AutocommitService>>,
    space_path: String,
    url: String,
    project_path: Option<String>,
    space_id: Option<String>,
) -> Result<(), AppError> {
    let path = PathBuf::from(&space_path);
    {
        let lock = state.get_lock(&path).await;
        let _guard = lock.lock().await;
        super::ops::set_remote(state.cli()?, &path, &url).await?;
    }

    if let (Some(proj_path), Some(sid)) = (project_path.as_deref(), space_id) {
        let parent = Path::new(proj_path);
        crate::space::project::reconcile_space_url(parent, &sid, Some(&url))?;
    }

    // Commit the config change (reconcile_space_url may have updated parent
    // .svode/config.json). Routes per space git type.
    if let Some(proj_path) = project_path {
        if !proj_path.is_empty() {
            if let Err(e) = autocommit
                .commit_system_now(
                    PathBuf::from(&proj_path),
                    path,
                    SystemCommitKind::SpaceConfig,
                )
                .await
            {
                tracing::warn!("commit_system_now (set_remote) failed: {e}");
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn git_push(
    state: State<'_, GitState>,
    space_path: String,
) -> Result<GitStatus, AppError> {
    let path = PathBuf::from(&space_path);
    let lock = state.get_lock(&path).await;
    let _guard = lock.lock().await;
    let cli = state.cli()?;
    super::ops::push(cli, &path).await?;
    super::ops::status(cli, &path).await
}

#[tauri::command]
pub async fn git_status(
    state: State<'_, GitState>,
    space_path: String,
) -> Result<GitStatus, AppError> {
    let path = PathBuf::from(&space_path);
    let lock = state.get_lock(&path).await;
    let _guard = lock.lock().await;
    super::ops::status(state.cli()?, &path).await
}

#[tauri::command]
pub async fn git_commit_file(
    state: State<'_, GitState>,
    autocommit: State<'_, Arc<AutocommitService>>,
    project_path: Option<String>,
    space_path: String,
    file_path: String,
) -> Result<GitStatus, AppError> {
    let path = PathBuf::from(&space_path);
    let cli = state.cli()?;

    if let Some(proj_path) = project_path.filter(|p| !p.is_empty()) {
        let project = PathBuf::from(&proj_path);
        // `.svode/AGENTS.md` is classified as a System change (stage 3.5
        // temporary rule — see 03-autocommit.md). Route through the system
        // commit path so the message is `Update agent instructions` and the
        // commit is isolated from user content.
        if file_path == ".svode/AGENTS.md" {
            autocommit
                .commit_system_manual_now(
                    project,
                    path.clone(),
                    SystemCommitKind::AgentInstructions,
                )
                .await?;
            return super::ops::status(cli, &path).await;
        }
        let (_, target_repo) = super::ops::resolve_target_repo(cli, &project, &path).await?;
        let pending_paths = autocommit.take_pending_paths_for_space(&project, &path);
        let lock = state.get_lock(&target_repo).await;
        let _guard = lock.lock().await;
        stage_pending_paths(cli, &target_repo, &pending_paths).await;
        super::ops::commit_file_routed(cli, &project, &path, &file_path).await?;
        // Return status of the space itself
        super::ops::status(cli, &path).await
    } else {
        let lock = state.get_lock(&path).await;
        let _guard = lock.lock().await;
        super::ops::commit_file(cli, &path, &file_path).await?;
        super::ops::status(cli, &path).await
    }
}

#[tauri::command]
pub async fn git_commit_all(
    state: State<'_, GitState>,
    autocommit: State<'_, Arc<AutocommitService>>,
    project_path: Option<String>,
    space_path: String,
) -> Result<GitStatus, AppError> {
    let path = PathBuf::from(&space_path);
    let cli = state.cli()?;

    if let Some(proj_path) = project_path.filter(|p| !p.is_empty()) {
        let project = PathBuf::from(&proj_path);
        let (_, target_repo) = super::ops::resolve_target_repo(cli, &project, &path).await?;
        autocommit.drop_pending_paths_for_space(&project, &path);
        let lock = state.get_lock(&target_repo).await;
        let _guard = lock.lock().await;
        super::ops::commit_all_routed(cli, &project, &path).await?;
        super::ops::status(cli, &path).await
    } else {
        let lock = state.get_lock(&path).await;
        let _guard = lock.lock().await;
        super::ops::commit_all(cli, &path).await?;
        super::ops::status(cli, &path).await
    }
}

#[tauri::command]
pub async fn git_sync(
    app: AppHandle,
    state: State<'_, GitState>,
    index_state: State<'_, IndexState>,
    space_path: String,
) -> Result<SyncResult, AppError> {
    let path = PathBuf::from(&space_path);
    let lock = state.get_lock(&path).await;
    let _guard = lock.lock().await;
    let cli = state.cli()?;
    let result = super::sync::sync(cli, &path).await?;

    // On a successful pull (Success means pull+push completed), refresh the
    // SQLite index for any files that the merge brought in or modified, then
    // emit `space:synced`. The canonical source of `space:synced` is the
    // git-sync flow — emit AFTER reindex so consumers see a fresh index.
    if matches!(result, SyncResult::Success) {
        let key = index_state
            .key_for_space_dir(&path)
            .await
            .unwrap_or_else(|| IndexKey::Root(path.clone()));
        let changed = super::ops::diff_after_pull(cli, &path).await.ok();
        if let Some(changed) = &changed {
            if !changed.is_empty() {
                if let Err(e) =
                    crate::index::update::reindex_after_pull(&index_state, &key, changed.clone())
                        .await
                {
                    tracing::warn!("reindex_after_pull failed: {e}");
                }
            }
        }
        // Root pulls may introduce new inline spaces in `SpaceConfig.spaces`
        // — open pools for newcomers (5.4). For non-root keys, this is a
        // no-op since child spaces don't carry their own `spaces` list under
        // the flat-space invariant.
        if let IndexKey::Root(ref project) = key {
            if let Err(e) = index_state.refresh_after_root_pull(&app, project).await {
                tracing::warn!("refresh_after_root_pull failed: {e}");
            }
        }
        index_state
            .invalidate_project_backlinks(key.project())
            .await;
        emit_space_synced(&app, &key);
        // Explicit-trigger LFS auto-pull: if the merge brought in pointer
        // files under `.assets/` and credentials are present, fetch the
        // bytes in the background (Stage 3.5 Phase 8 §8.5 / Q8c).
        if let Some(changed) = changed {
            crate::storage::lfs::maybe_auto_pull_after_sync(&app, &key, &path, &changed);
        }
    }

    Ok(result)
}

#[tauri::command]
pub async fn git_conflict_files(
    state: State<'_, GitState>,
    space_path: String,
) -> Result<Vec<String>, AppError> {
    let path = PathBuf::from(&space_path);
    let lock = state.get_lock(&path).await;
    let _guard = lock.lock().await;
    super::sync::conflict_files(state.cli()?, &path).await
}

#[tauri::command]
pub async fn git_resolve_continue(
    app: AppHandle,
    state: State<'_, GitState>,
    index_state: State<'_, IndexState>,
    space_path: String,
) -> Result<SyncResult, AppError> {
    let path = PathBuf::from(&space_path);
    let lock = state.get_lock(&path).await;
    let _guard = lock.lock().await;
    let cli = state.cli()?;
    let result = super::sync::resolve_and_continue(cli, &path).await?;

    // After conflict resolution + merge commit + push, the space tree
    // has changed; refresh the index for the diff against the previous HEAD,
    // then emit `space:synced`.
    if matches!(result, SyncResult::Success) {
        let key = index_state
            .key_for_space_dir(&path)
            .await
            .unwrap_or_else(|| IndexKey::Root(path.clone()));
        let changed = super::ops::diff_after_pull(cli, &path).await.ok();
        if let Some(changed) = &changed {
            if !changed.is_empty() {
                if let Err(e) =
                    crate::index::update::reindex_after_pull(&index_state, &key, changed.clone())
                        .await
                {
                    tracing::warn!("reindex_after_pull failed: {e}");
                }
            }
        }
        if let IndexKey::Root(ref project) = key {
            if let Err(e) = index_state.refresh_after_root_pull(&app, project).await {
                tracing::warn!("refresh_after_root_pull failed: {e}");
            }
        }
        index_state
            .invalidate_project_backlinks(key.project())
            .await;
        emit_space_synced(&app, &key);
        if let Some(changed) = changed {
            crate::storage::lfs::maybe_auto_pull_after_sync(&app, &key, &path, &changed);
        }
    }

    Ok(result)
}

#[tauri::command]
pub async fn git_merge_abort(
    state: State<'_, GitState>,
    space_path: String,
) -> Result<(), AppError> {
    let path = PathBuf::from(&space_path);
    let lock = state.get_lock(&path).await;
    let _guard = lock.lock().await;
    super::sync::merge_abort(state.cli()?, &path).await
}

#[tauri::command]
pub async fn get_space_git_type(
    state: State<'_, GitState>,
    project_path: String,
    space_path: String,
) -> Result<SpaceGitType, AppError> {
    let project = PathBuf::from(&project_path);
    let space = PathBuf::from(&space_path);
    let cli = state.cli()?;
    super::ops::detect_space_git_type(cli, &project, &space).await
}

#[tauri::command]
pub async fn git_get_submodule_url(
    state: State<'_, GitState>,
    project_path: String,
    space_folder: String,
) -> Result<Option<String>, AppError> {
    let project = PathBuf::from(&project_path);
    let cli = state.cli()?;
    super::ops::get_submodule_url(cli, &project, &space_folder).await
}

#[tauri::command]
pub async fn git_unpushed_commits(
    state: State<'_, GitState>,
    space_path: String,
) -> Result<Vec<UnpushedCommit>, AppError> {
    let path = PathBuf::from(&space_path);
    let lock = state.get_lock(&path).await;
    let _guard = lock.lock().await;
    super::ops::unpushed_commits(state.cli()?, &path).await
}

#[tauri::command]
pub async fn git_publish(
    state: State<'_, GitState>,
    space_path: String,
) -> Result<GitStatus, AppError> {
    let path = PathBuf::from(&space_path);
    let lock = state.get_lock(&path).await;
    let _guard = lock.lock().await;
    let cli = state.cli()?;
    super::ops::push_set_upstream(cli, &path).await?;
    super::ops::status(cli, &path).await
}

#[tauri::command]
pub async fn git_enable_auto_sync(
    state: State<'_, GitState>,
    autocommit: State<'_, Arc<AutocommitService>>,
    space_path: String,
    project_path: Option<String>,
) -> Result<(), AppError> {
    let space = PathBuf::from(&space_path);

    // For inline spaces autoSync lives in the root project config (inline has
    // no repo of its own). For independent/submodule — the space's own config.
    let config_target: PathBuf = match project_path.as_deref() {
        Some(proj) if !proj.is_empty() => {
            let project = PathBuf::from(proj);
            let cli = state.cli()?;
            let git_type = super::ops::detect_space_git_type(cli, &project, &space).await?;
            match git_type {
                crate::space::types::SpaceGitType::Inline => project,
                _ => space.clone(),
            }
        }
        _ => space.clone(),
    };

    let mut cfg = crate::space::config::read_space_config(&config_target)?;
    let mut git_cfg = cfg.git.clone().unwrap_or_default();
    git_cfg.auto_sync = Some(true);
    cfg.git = Some(git_cfg);
    crate::space::config::write_space_config(&config_target, &cfg)?;

    if let Some(proj_path) = project_path.filter(|p| !p.is_empty()) {
        if let Err(e) = autocommit
            .commit_system_now(
                PathBuf::from(&proj_path),
                space,
                SystemCommitKind::SpaceConfig,
            )
            .await
        {
            tracing::warn!("commit_system_now (enable_auto_sync) failed: {e}");
        }
    }

    Ok(())
}

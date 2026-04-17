use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{AppHandle, State};

use super::autocommit::AutocommitService;
use super::cli::{GitAvailability, GitCli};
use super::ops::{GitStatus, UnpushedCommit};
use super::sync::SyncResult;
use crate::index::IndexState;
use crate::space::types::SpaceGitType;
use crate::AppError;

/// Helper: read the GitCli reference (clone is cheap — PathBuf only) outside the
/// per-space lock, so async work that needs `&AppHandle` doesn't borrow
/// `state`.
pub(crate) fn require_cli(state: &GitState) -> Result<GitCli, AppError> {
    state.cli.clone().ok_or(AppError::GitNotFound)
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
    super::ops::init(state.cli()?, &path).await
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
        // Scaffold .combai/ if not present
        let combai_dir = target.join(".combai");
        let combai_existed_before = combai_dir.exists();
        if !combai_existed_before {
            crate::space::scaffold::scaffold_space(&target, &space_folder, "", "")?;
        }
        drop(_guard);
        if !combai_existed_before {
            if let Err(e) = autocommit.commit_scaffold(project, target).await {
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
    space_path: String,
    url: String,
    project_path: Option<String>,
    space_id: Option<String>,
) -> Result<(), AppError> {
    let path = PathBuf::from(&space_path);
    let lock = state.get_lock(&path).await;
    let _guard = lock.lock().await;
    super::ops::set_remote(state.cli()?, &path, &url).await?;

    if let (Some(proj_path), Some(sid)) = (project_path, space_id) {
        let parent = Path::new(&proj_path);
        crate::space::project::reconcile_space_url(parent, &sid, Some(&url))?;
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
    project_path: Option<String>,
    space_path: String,
    file_path: String,
) -> Result<GitStatus, AppError> {
    let path = PathBuf::from(&space_path);
    let cli = state.cli()?;

    if let Some(proj_path) = project_path.filter(|p| !p.is_empty()) {
        let project = PathBuf::from(&proj_path);
        let lock = state.get_lock(&path).await;
        let _guard = lock.lock().await;
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
    project_path: Option<String>,
    space_path: String,
) -> Result<GitStatus, AppError> {
    let path = PathBuf::from(&space_path);
    let cli = state.cli()?;

    if let Some(proj_path) = project_path.filter(|p| !p.is_empty()) {
        let project = PathBuf::from(&proj_path);
        let lock = state.get_lock(&path).await;
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
    // SQLite index for any files that the merge brought in or modified.
    if matches!(result, SyncResult::Success) {
        if let Ok(changed) = super::ops::diff_after_pull(cli, &path).await {
            if !changed.is_empty() {
                if let Ok(pool) = index_state.get_or_create(&space_path).await {
                    if let Err(e) =
                        crate::index::update::reindex_after_pull(&pool, &path, changed).await
                    {
                        tracing::warn!("reindex_after_pull failed: {e}");
                    }
                }
            }
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
    // has changed; refresh the index for the diff against the previous HEAD.
    if matches!(result, SyncResult::Success) {
        if let Ok(changed) = super::ops::diff_after_pull(cli, &path).await {
            if !changed.is_empty() {
                if let Ok(pool) = index_state.get_or_create(&space_path).await {
                    if let Err(e) =
                        crate::index::update::reindex_after_pull(&pool, &path, changed).await
                    {
                        tracing::warn!("reindex_after_pull failed: {e}");
                    }
                }
            }
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
pub fn git_enable_auto_sync(space_path: String) -> Result<(), AppError> {
    let path = PathBuf::from(&space_path);
    let mut cfg = crate::space::config::read_space_config(&path)?;
    let mut git_cfg = cfg.git.clone().unwrap_or_default();
    git_cfg.auto_sync = Some(true);
    cfg.git = Some(git_cfg);
    crate::space::config::write_space_config(&path, &cfg)
}

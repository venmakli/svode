use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::AppError;
use crate::git::autocommit::{AutocommitService, SystemCommitKind};
use crate::git::commands::{
    GitState, auto_commit_structural_enabled, init_repo_with_policy, require_cli,
};
use crate::git::ops;
use crate::index::IndexState;
use crate::space::{config, project, registry, settings, symlinks, types::*};
use crate::storage::lfs::LfsState;
use crate::system_path;

fn detect_status_for_ref(parent: &Path, sp_ref: &SpaceRef) -> SpaceStatus {
    project::space_ref_status(parent, sp_ref)
}

async fn import_existing_submodules_if_possible(
    git_state: &GitState,
    project_path: &Path,
) -> usize {
    let Some(cli) = &git_state.cli else {
        return 0;
    };

    match ops::list_submodules(cli, project_path).await {
        Ok(submodules) => {
            match project::import_existing_submodule_spaces(project_path, &submodules) {
                Ok(imported) => imported,
                Err(e) => {
                    tracing::warn!(
                        "import existing submodules failed for {}: {e}",
                        project_path.display()
                    );
                    0
                }
            }
        }
        Err(e) => {
            tracing::warn!("list submodules failed for {}: {e}", project_path.display());
            0
        }
    }
}

fn emit_space_added(app: &AppHandle, project: &Path, info: &SpaceInfo, folder: &str) {
    let _ = app.emit(
        "space:added",
        serde_json::json!({
            "projectPath": system_path::user_facing_path(project),
            "spaceId": info.id,
            "spacePath": system_path::user_facing_path(&project.join(folder)),
            "status": info.status,
        }),
    );
}

fn emit_space_removed(app: &AppHandle, project: &Path, space_id: &str) {
    let _ = app.emit(
        "space:removed",
        serde_json::json!({
            "projectPath": system_path::user_facing_path(project),
            "spaceId": space_id,
        }),
    );
}

fn emit_space_status_changed(
    app: &AppHandle,
    project: &Path,
    space_id: &str,
    old: SpaceStatus,
    new: SpaceStatus,
) {
    let _ = app.emit(
        "space:status_changed",
        serde_json::json!({
            "projectPath": system_path::user_facing_path(project),
            "spaceId": space_id,
            "oldStatus": old,
            "newStatus": new,
        }),
    );
}

// --- App Settings ---

#[tauri::command]
pub fn get_app_settings(app: AppHandle) -> Result<AppSettings, AppError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;
    settings::read_app_settings(&config_dir)
}

#[tauri::command]
pub fn save_app_settings(app: AppHandle, settings_data: AppSettings) -> Result<(), AppError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;
    settings::write_app_settings(&config_dir, &settings_data)
}

// --- Projects ---

#[tauri::command]
pub fn list_projects(app: AppHandle) -> Result<Vec<SpaceInfo>, AppError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;
    let reg = registry::read_registry(&config_dir)?;
    let mut projects = Vec::new();
    for sp_ref in &reg.spaces {
        let sp_path = Path::new(&sp_ref.path);
        match config::read_space_config(sp_path) {
            Ok(cfg) => {
                projects.push(SpaceInfo {
                    id: sp_ref.id.clone(),
                    name: cfg.name,
                    icon: cfg.icon,
                    description: cfg.description,
                    path: sp_ref.path.clone(),
                    has_spaces: cfg.spaces.as_ref().map(|s| !s.is_empty()).unwrap_or(false),
                    last_opened: sp_ref.last_opened.clone(),
                    status: SpaceStatus::Ready,
                    lfs_state: LfsState::NotApplicable,
                });
            }
            Err(_) => continue,
        }
    }
    Ok(projects)
}

#[tauri::command]
pub async fn create_project(
    app: AppHandle,
    git_state: State<'_, GitState>,
    name: String,
    icon: String,
    description: Option<String>,
    path: String,
) -> Result<SpaceInfo, AppError> {
    let sp_path = Path::new(&path);

    // Check if project already exists at this path
    if sp_path.join(".svode").join("config.json").exists() {
        return Err(AppError::ProjectAlreadyExists(path.clone()));
    }

    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;
    let (id, cfg) = project::create_project(
        &config_dir,
        &name,
        &icon,
        description.as_deref().unwrap_or(""),
        sp_path,
    )?;

    if let Some(cli) = &git_state.cli {
        let lock = git_state.get_lock(sp_path).await;
        let _guard = lock.lock().await;
        if let Err(e) = init_repo_with_policy(cli, sp_path).await {
            tracing::warn!("git init failed for new project: {e}");
        }
    }

    Ok(SpaceInfo {
        id,
        name: cfg.name,
        icon: cfg.icon,
        description: cfg.description,
        path: system_path::user_facing_path(sp_path),
        has_spaces: false,
        last_opened: None,
        status: SpaceStatus::Ready,
        lfs_state: LfsState::NotApplicable,
    })
}

#[tauri::command]
pub async fn open_project_folder(
    app: AppHandle,
    git_state: State<'_, GitState>,
    autocommit: State<'_, Arc<AutocommitService>>,
    path: String,
) -> Result<SpaceInfo, AppError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;
    let sp_path = Path::new(&path);

    // Track whether `.svode/` was present before we touched the folder —
    // only commit scaffold when we created it or added the scope README.
    let svode_existed_before = sp_path.join(".svode").join("config.json").exists();
    let readme_existed_before = sp_path.join("README.md").exists();

    let had_git_before = sp_path.join(".git").exists();
    let (id, mut cfg) = project::open_project_folder(&config_dir, sp_path)?;
    let gitignore_changed = if had_git_before {
        ops::ensure_svode_gitignore(sp_path)?
    } else {
        false
    };
    let imported_submodules = import_existing_submodules_if_possible(&git_state, sp_path).await;
    if imported_submodules > 0 {
        cfg = config::read_space_config(sp_path)?;
    }

    if !had_git_before {
        if let Some(cli) = &git_state.cli {
            let lock = git_state.get_lock(sp_path).await;
            let _guard = lock.lock().await;
            if let Err(e) = init_repo_with_policy(cli, sp_path).await {
                tracing::warn!("git init failed for opened folder: {e}");
            }
        }
    }

    // If the folder was already a git repo but we just scaffolded .svode/
    // or README.md into it, commit the scaffold on top of HEAD.
    if had_git_before && (!svode_existed_before || !readme_existed_before) {
        let commit_result = if !svode_existed_before && readme_existed_before {
            autocommit
                .commit_scaffold(sp_path.to_path_buf(), sp_path.to_path_buf())
                .await
        } else if !svode_existed_before {
            autocommit
                .commit_scaffold_with_readme(sp_path.to_path_buf(), sp_path.to_path_buf())
                .await
        } else {
            autocommit
                .commit_scope_readme(sp_path.to_path_buf(), sp_path.to_path_buf())
                .await
        };
        if let Err(e) = commit_result {
            tracing::warn!("commit_scaffold failed for opened folder: {e}");
        }
    } else if had_git_before {
        if gitignore_changed {
            if let Err(e) = autocommit
                .commit_system_now(
                    sp_path.to_path_buf(),
                    sp_path.to_path_buf(),
                    SystemCommitKind::Gitignore,
                )
                .await
            {
                tracing::warn!("commit .gitignore repair failed for opened folder: {e}");
            }
        }
        if imported_submodules > 0 {
            if let Err(e) = autocommit
                .commit_structural_paths_now(
                    sp_path.to_path_buf(),
                    sp_path.to_path_buf(),
                    vec![sp_path.join(".svode").join("config.json")],
                    "Register submodule spaces",
                )
                .await
            {
                tracing::warn!("commit imported submodules failed for opened folder: {e}");
            }
        }
    }

    Ok(SpaceInfo {
        id,
        name: cfg.name,
        icon: cfg.icon,
        description: cfg.description,
        path: system_path::user_facing_path(sp_path),
        has_spaces: cfg.spaces.as_ref().map(|s| !s.is_empty()).unwrap_or(false),
        last_opened: None,
        status: SpaceStatus::Ready,
        lfs_state: LfsState::NotApplicable,
    })
}

#[tauri::command]
pub async fn delete_project(
    app: AppHandle,
    index_state: State<'_, IndexState>,
    id: String,
    delete_files: Option<bool>,
) -> Result<(), AppError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;

    // Close the project's pools before any filesystem operations so SQLite
    // releases file handles (Windows would otherwise refuse to remove the
    // directory).
    if let Some(sp_ref) = registry::find_space(&config_dir, &id)? {
        index_state.close_project(Path::new(&sp_ref.path)).await;
    }

    project::delete_project(&config_dir, &id, delete_files.unwrap_or(false))
}

#[tauri::command]
pub fn get_last_active_project(app: AppHandle) -> Result<Option<String>, AppError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;
    let reg = registry::read_registry(&config_dir)?;
    Ok(reg.last_active)
}

#[tauri::command]
pub async fn open_project(
    app: AppHandle,
    git_state: State<'_, GitState>,
    autocommit: State<'_, Arc<AutocommitService>>,
    index_state: State<'_, IndexState>,
    id: String,
) -> Result<SpaceConfig, AppError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;

    let sp_ref = registry::find_space(&config_dir, &id)?
        .ok_or_else(|| AppError::SpaceNotFound(id.clone()))?;
    let project_path = PathBuf::from(&sp_ref.path);

    let readme_existed_before = project_path.join("README.md").exists();
    let gitignore_changed = if project_path.join(".git").exists() {
        ops::ensure_svode_gitignore(&project_path)?
    } else {
        false
    };
    let imported_submodules =
        import_existing_submodules_if_possible(&git_state, &project_path).await;
    if gitignore_changed {
        if let Err(e) = autocommit
            .commit_system_now(
                project_path.clone(),
                project_path.clone(),
                SystemCommitKind::Gitignore,
            )
            .await
        {
            tracing::warn!("commit .gitignore repair failed for project open: {e}");
        }
    }
    if imported_submodules > 0 {
        if let Err(e) = autocommit
            .commit_structural_paths_now(
                project_path.clone(),
                project_path.clone(),
                vec![project_path.join(".svode").join("config.json")],
                "Register submodule spaces",
            )
            .await
        {
            tracing::warn!("commit imported submodules failed for project open: {e}");
        }
    }

    let cfg = config::read_space_config(&project_path)?;
    let readme_created = project::ensure_scope_readme(&project_path, &cfg.name)?;
    if readme_created && project_path.join(".git").exists() && !readme_existed_before {
        if let Err(e) = autocommit
            .commit_scope_readme(project_path.clone(), project_path.clone())
            .await
        {
            tracing::warn!("commit README scaffold failed for project open: {e}");
        }
    }
    registry::update_last_active(&config_dir, &id)?;
    registry::update_last_opened(&config_dir, &id)?;

    // Open root + every ready child-space pool, spawn full_reindex per pool
    // (under reindex lock + bounded concurrency). Failure is logged but does
    // not block project open — the user can always trigger a manual reindex
    // later. Initial state is not a transit, so no `space:status_changed`
    // emit is needed: the cache snapshot during open_project covers it.
    if let Err(e) = index_state.open_project(&app, &project_path).await {
        tracing::warn!(
            "index_state.open_project failed for {}: {e}",
            project_path.display()
        );
    }

    Ok(cfg)
}

// --- Spaces ---

#[tauri::command]
pub fn list_spaces(space_path: String) -> Result<Vec<SpaceInfo>, AppError> {
    let path = Path::new(&space_path);
    project::list_spaces(path)
}

#[tauri::command]
pub async fn reorder_spaces(
    project_path: String,
    ordered_space_ids: Vec<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<Vec<SpaceInfo>, AppError> {
    let parent = PathBuf::from(&project_path);
    let spaces = project::reorder_spaces(&parent, ordered_space_ids)?;

    if let Err(e) = autocommit
        .commit_system_now(parent.clone(), parent, SystemCommitKind::ReorderSpaces)
        .await
    {
        tracing::warn!("commit reorder spaces failed: {e}");
    }

    Ok(spaces)
}

#[tauri::command]
pub async fn create_space(
    app: AppHandle,
    git_state: State<'_, GitState>,
    index_state: State<'_, IndexState>,
    parent_path: String,
    name: String,
    icon: String,
    folder_name: String,
    git_type: SpaceGitType,
) -> Result<SpaceInfo, AppError> {
    let parent = Path::new(&parent_path);
    let folder_name = project::normalize_space_folder(&folder_name)?;
    let info = project::create_space(parent, &name, &icon, &folder_name)?;
    let space_dir = parent.join(&folder_name);
    let structural_autocommit = auto_commit_structural_enabled(parent);

    // Unified root-commit message — `Add <type> space <folder>`. Type is
    // visible in history without reading the diff.
    let type_label = match git_type {
        SpaceGitType::Inline => "inline",
        SpaceGitType::Independent => "independent",
        SpaceGitType::Submodule => "submodule",
    };
    let root_message = format!("Add {} space {}", type_label, folder_name);

    match git_type {
        SpaceGitType::Inline => {
            ops::ensure_inline_gitignore(parent)?;
            if structural_autocommit {
                if let Some(cli) = &git_state.cli {
                    let lock = git_state.get_lock(parent).await;
                    let _guard = lock.lock().await;
                    ops::add_all(cli, parent).await?;
                    let _ = ops::commit(cli, parent, &root_message).await?;
                }
            }
        }
        SpaceGitType::Independent => {
            let cli = require_cli(&git_state)?;
            {
                let lock = git_state.get_lock(&space_dir).await;
                let _guard = lock.lock().await;
                ops::init_with_optional_scaffold_commit(&cli, &space_dir, false).await?;
                if let Err(e) =
                    crate::identity::scaffold_space_git_identity(&cli, &space_dir, parent).await
                {
                    tracing::warn!(
                        "scaffold_space_git_identity failed for new independent space: {e}"
                    );
                }
                if structural_autocommit {
                    ops::add_all(&cli, &space_dir).await?;
                    let _ = ops::commit(&cli, &space_dir, "Scaffold .svode").await?;
                }
            }
            ops::add_independent_gitignore(parent, &folder_name)?;
            if structural_autocommit {
                let root_lock = git_state.get_lock(parent).await;
                let _root_guard = root_lock.lock().await;
                ops::add_all(&cli, parent).await?;
                let _ = ops::commit(&cli, parent, &root_message).await?;
            }
        }
        SpaceGitType::Submodule => {
            let cli = require_cli(&git_state)?;
            {
                let lock = git_state.get_lock(&space_dir).await;
                let _guard = lock.lock().await;
                ops::init_with_optional_scaffold_commit(&cli, &space_dir, false).await?;
                if let Err(e) =
                    crate::identity::scaffold_space_git_identity(&cli, &space_dir, parent).await
                {
                    tracing::warn!(
                        "scaffold_space_git_identity failed for new submodule space: {e}"
                    );
                }
                if structural_autocommit {
                    ops::add_all(&cli, &space_dir).await?;
                    let _ = ops::commit(&cli, &space_dir, "Scaffold .svode").await?;
                }
            }
            {
                let parent_lock = git_state.get_lock(parent).await;
                let _parent_guard = parent_lock.lock().await;
                if structural_autocommit {
                    let out = cli
                        .exec(parent, &["submodule", "add", &format!("./{folder_name}")])
                        .await?;
                    if out.exit_code != 0 {
                        return Err(AppError::GitCommandFailed(format!(
                            "git submodule add failed: {}",
                            out.stderr
                        )));
                    }
                    ops::add_all(&cli, parent).await?;
                    let _ = ops::commit(&cli, parent, &root_message).await?;
                } else {
                    ops::register_local_submodule_metadata(&cli, parent, &folder_name).await?;
                }
            }
        }
    }

    index_state
        .on_space_added(&app, parent, &info.id, &folder_name, info.status)
        .await;
    emit_space_added(&app, parent, &info, &folder_name);

    Ok(info)
}

#[tauri::command]
pub async fn delete_space(
    app: AppHandle,
    git_state: State<'_, GitState>,
    index_state: State<'_, IndexState>,
    parent_path: String,
    space_id: String,
    delete_files: Option<bool>,
) -> Result<(), AppError> {
    let parent = Path::new(&parent_path);

    // Look up folder name + detect git type before deletion so we know which
    // commit message to use in the root repo.
    let (folder_name, git_type) = {
        let parent_cfg = config::read_space_config(parent)?;
        let folder = parent_cfg
            .spaces
            .as_ref()
            .and_then(|spaces| spaces.iter().find(|s| s.id == space_id))
            .map(|s| s.path.clone());
        let Some(folder) = folder else {
            // Nothing to delete — still call through to remove the registry entry.
            project::delete_space(parent, &space_id, delete_files.unwrap_or(false))?;
            return Ok(());
        };
        let space_dir = parent.join(&folder);
        let gt = if let Some(cli) = &git_state.cli {
            match ops::detect_space_git_type(cli, parent, &space_dir).await {
                Ok(gt) => gt,
                Err(_) => SpaceGitType::Inline,
            }
        } else {
            SpaceGitType::Inline
        };
        (folder, gt)
    };

    project::delete_space(parent, &space_id, delete_files.unwrap_or(false))?;

    let type_label = match git_type {
        SpaceGitType::Inline => "inline",
        SpaceGitType::Independent => "independent",
        SpaceGitType::Submodule => "submodule",
    };
    let message = format!("Remove {} space {}", type_label, folder_name);

    if auto_commit_structural_enabled(parent) {
        if let Some(cli) = &git_state.cli {
            let lock = git_state.get_lock(parent).await;
            let _guard = lock.lock().await;
            ops::add_all(cli, parent).await?;
            let _ = ops::commit(cli, parent, &message).await?;
        }
    }

    index_state.on_space_removed(parent, &space_id).await;
    emit_space_removed(&app, parent, &space_id);

    Ok(())
}

#[tauri::command]
pub async fn register_cloned_space(
    app: AppHandle,
    autocommit: State<'_, Arc<AutocommitService>>,
    index_state: State<'_, IndexState>,
    parent_path: String,
    folder_name: String,
    fallback_name: String,
    fallback_icon: String,
    url: String,
    git_type: String,
) -> Result<SpaceInfo, AppError> {
    let path = Path::new(&parent_path);
    let folder_name = project::normalize_space_folder(&folder_name)?;
    let repo = if git_type == "independent" {
        Some(url)
    } else {
        None
    };

    let space_dir = path.join(&folder_name);
    let svode_existed_before = space_dir.join(".svode").join("config.json").exists();
    let readme_existed_before = space_dir.join("README.md").exists();

    let info =
        project::register_cloned_space(path, &folder_name, &fallback_name, &fallback_icon, repo)?;

    if !svode_existed_before || !readme_existed_before {
        let commit_result = if !svode_existed_before && readme_existed_before {
            autocommit
                .commit_scaffold(PathBuf::from(&parent_path), space_dir.clone())
                .await
        } else if !svode_existed_before {
            autocommit
                .commit_scaffold_with_readme(PathBuf::from(&parent_path), space_dir.clone())
                .await
        } else {
            autocommit
                .commit_scope_readme(PathBuf::from(&parent_path), space_dir.clone())
                .await
        };
        if let Err(e) = commit_result {
            tracing::warn!("commit_scaffold failed after register_cloned_space: {e}");
        }
    }

    index_state
        .on_space_added(&app, path, &info.id, &folder_name, info.status)
        .await;
    emit_space_added(&app, path, &info, &folder_name);

    Ok(info)
}

// --- Clone project ---

#[tauri::command]
pub async fn project_clone(
    app: AppHandle,
    git_state: State<'_, GitState>,
    autocommit: State<'_, Arc<AutocommitService>>,
    url: String,
    target_path: String,
) -> Result<SpaceInfo, AppError> {
    let path = PathBuf::from(&target_path);
    let cli = crate::git::commands::require_cli(&git_state)?;
    let lock = git_state.get_lock(&path).await;
    let _guard = lock.lock().await;
    crate::git::clone::clone_with_progress(&cli, &app, &url, &path).await?;
    drop(_guard);

    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;

    // Check if .svode/ existed in the clone before we scaffold it.
    let svode_existed_before = path.join(".svode").join("config.json").exists();
    let readme_existed_before = path.join("README.md").exists();

    let (id, mut cfg) = project::open_project_folder(&config_dir, &path)?;
    let gitignore_changed = ops::ensure_svode_gitignore(&path)?;
    let imported_submodules = import_existing_submodules_if_possible(&git_state, &path).await;
    if imported_submodules > 0 {
        cfg = config::read_space_config(&path)?;
    }

    // If we just scaffolded .svode/ or README.md, commit it.
    if !svode_existed_before || !readme_existed_before {
        let commit_result = if !svode_existed_before && readme_existed_before {
            autocommit.commit_scaffold(path.clone(), path.clone()).await
        } else if !svode_existed_before {
            autocommit
                .commit_scaffold_with_readme(path.clone(), path.clone())
                .await
        } else {
            autocommit
                .commit_scope_readme(path.clone(), path.clone())
                .await
        };
        if let Err(e) = commit_result {
            tracing::warn!("commit_scaffold failed after project clone: {e}");
        }
    } else {
        if gitignore_changed {
            if let Err(e) = autocommit
                .commit_system_now(path.clone(), path.clone(), SystemCommitKind::Gitignore)
                .await
            {
                tracing::warn!("commit .gitignore repair failed after project clone: {e}");
            }
        }
        if imported_submodules > 0 {
            if let Err(e) = autocommit
                .commit_structural_paths_now(
                    path.clone(),
                    path.clone(),
                    vec![path.join(".svode").join("config.json")],
                    "Register submodule spaces",
                )
                .await
            {
                tracing::warn!("commit imported submodules failed after project clone: {e}");
            }
        }
    }

    Ok(SpaceInfo {
        id,
        name: cfg.name,
        icon: cfg.icon,
        description: cfg.description,
        path: system_path::user_facing_path(&path),
        has_spaces: cfg.spaces.as_ref().map(|s| !s.is_empty()).unwrap_or(false),
        last_opened: None,
        status: SpaceStatus::Ready,
        lfs_state: LfsState::NotApplicable,
    })
}

#[tauri::command]
pub fn path_exists(path: String) -> Result<bool, AppError> {
    Ok(Path::new(&path).exists())
}

/// Register the `<space_path>/.assets` directory with the Tauri asset
/// protocol scope so the webview can render images/videos/audio uploaded
/// to that space.
#[tauri::command]
pub fn ensure_assets_scope(app: AppHandle, space_path: String) -> Result<(), AppError> {
    let assets_dir = Path::new(&space_path).join(".assets");
    app.asset_protocol_scope()
        .allow_directory(&assets_dir, true)
        .map_err(|e| AppError::General(e.to_string()))
}

#[tauri::command]
pub async fn ensure_space_scaffold(
    project_path: String,
    space_path: String,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<(), AppError> {
    let path = Path::new(&space_path);
    if !path.is_dir() {
        return Err(AppError::PathNotAccessible(space_path));
    }

    let svode_existed_before = path.join(".svode").join("config.json").exists();
    let readme_existed_before = path.join("README.md").exists();
    let fallback_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "Space".to_string());
    if svode_existed_before {
        project::ensure_scope_readme(path, &fallback_name)?;
    } else {
        crate::space::scaffold::scaffold_space(path, &fallback_name, "", "")?;
    }

    if !svode_existed_before || !readme_existed_before {
        let commit_result = if !svode_existed_before && readme_existed_before {
            autocommit
                .commit_scaffold(PathBuf::from(project_path), path.to_path_buf())
                .await
        } else if !svode_existed_before {
            autocommit
                .commit_scaffold_with_readme(PathBuf::from(project_path), path.to_path_buf())
                .await
        } else {
            autocommit
                .commit_scope_readme(PathBuf::from(project_path), path.to_path_buf())
                .await
        };
        if let Err(e) = commit_result {
            tracing::warn!("commit_scaffold failed in ensure_space_scaffold: {e}");
        }
    }

    Ok(())
}

// --- Config ---

#[tauri::command]
pub fn get_space_config(space_path: String) -> Result<SpaceConfig, AppError> {
    let path = Path::new(&space_path);
    config::read_space_config(path)
}

#[tauri::command]
pub async fn save_space_config(
    space_path: String,
    config_data: SpaceConfig,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<(), AppError> {
    let path = Path::new(&space_path);
    config::write_space_config(path, &config_data)?;
    if let Some(proj) = project_path.filter(|p| !p.is_empty()) {
        if let Err(e) = autocommit
            .commit_system_now(
                PathBuf::from(proj),
                PathBuf::from(&space_path),
                SystemCommitKind::SpaceConfig,
            )
            .await
        {
            tracing::warn!("commit_system_now (SpaceConfig) failed: {e}");
        }
    }
    Ok(())
}

// --- CLI Symlinks ---

#[tauri::command]
pub async fn setup_cli_symlinks_cmd(
    space_path: String,
    cli_name: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<Vec<String>, AppError> {
    let path = Path::new(&space_path);
    let created = symlinks::setup_cli_symlinks(path, &cli_name)?;
    if let Some(proj) = project_path.filter(|p| !p.is_empty()) {
        if let Err(e) = autocommit
            .commit_system_now(
                PathBuf::from(proj),
                PathBuf::from(&space_path),
                SystemCommitKind::CliIntegration,
            )
            .await
        {
            tracing::warn!("commit_system_now (CliIntegration setup) failed: {e}");
        }
    }
    Ok(created)
}

#[tauri::command]
pub async fn teardown_cli_symlinks_cmd(
    space_path: String,
    cli_name: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<(), AppError> {
    let path = Path::new(&space_path);
    symlinks::teardown_cli_symlinks(path, &cli_name)?;
    if let Some(proj) = project_path.filter(|p| !p.is_empty()) {
        if let Err(e) = autocommit
            .commit_system_now(
                PathBuf::from(proj),
                PathBuf::from(&space_path),
                SystemCommitKind::CliIntegration,
            )
            .await
        {
            tracing::warn!("commit_system_now (CliIntegration teardown) failed: {e}");
        }
    }
    Ok(())
}

#[tauri::command]
pub fn check_symlink_health(
    space_path: String,
    cli_name: String,
) -> Result<symlinks::SymlinkHealthReport, AppError> {
    let path = Path::new(&space_path);
    symlinks::health_check_symlinks(path, &cli_name)
}

#[tauri::command]
pub fn read_agents_md(space_path: String) -> Result<Option<String>, AppError> {
    let path = Path::new(&space_path).join(".svode").join("AGENTS.md");
    if path.exists() {
        Ok(Some(std::fs::read_to_string(&path)?))
    } else {
        Ok(None)
    }
}

/// Write `.svode/AGENTS.md` and immediately commit it as a System change
/// (`Update agent instructions`). Stage-3.5 classifies AI-instruction files
/// as System; a future AI stage may promote them to their own category.
#[tauri::command]
pub async fn write_agents_md(
    space_path: String,
    content: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<(), AppError> {
    let svode_dir = Path::new(&space_path).join(".svode");
    std::fs::create_dir_all(&svode_dir)?;
    std::fs::write(svode_dir.join("AGENTS.md"), content)?;

    if let Some(proj) = project_path.filter(|p| !p.is_empty()) {
        if let Err(e) = autocommit
            .commit_system_now(
                PathBuf::from(proj),
                PathBuf::from(&space_path),
                SystemCommitKind::AgentInstructions,
            )
            .await
        {
            tracing::warn!("commit_system_now (AgentInstructions) failed: {e}");
        }
    }
    Ok(())
}

// --- Ghost-state space operations ---

#[tauri::command]
pub async fn clone_missing_space(
    app: AppHandle,
    git_state: State<'_, GitState>,
    autocommit: State<'_, Arc<AutocommitService>>,
    index_state: State<'_, IndexState>,
    project_path: String,
    space_id: String,
) -> Result<(), AppError> {
    let parent = PathBuf::from(&project_path);
    let parent_config = config::read_space_config(&parent)?;
    let space_ref = parent_config
        .spaces
        .as_ref()
        .and_then(|spaces| spaces.iter().find(|s| s.id == space_id))
        .ok_or_else(|| AppError::SpaceNotFound(space_id.clone()))?
        .clone();

    let old_status = detect_status_for_ref(&parent, &space_ref);
    let space_dir = parent.join(&space_ref.path);

    if let Some(url) = &space_ref.repo {
        // Independent: clone + gitignore
        let cli = require_cli(&git_state)?;
        let lock = git_state.get_lock(&space_dir).await;
        let _guard = lock.lock().await;
        crate::git::clone::clone_with_progress(&cli, &app, url, &space_dir).await?;
        if let Err(e) =
            crate::identity::scaffold_space_git_identity(&cli, &space_dir, &parent).await
        {
            tracing::warn!("scaffold_space_git_identity failed after clone: {e}");
        }
        ops::add_independent_gitignore(&parent, &space_ref.path)?;
    } else {
        // Check .gitmodules for submodule
        let gitmodules = parent.join(".gitmodules");
        if gitmodules.exists() {
            let content = std::fs::read_to_string(&gitmodules)?;
            if content.contains(&format!("path = {}", space_ref.path)) {
                let cli = require_cli(&git_state)?;
                let lock = git_state.get_lock(&parent).await;
                let _guard = lock.lock().await;
                let out = cli
                    .exec_with_env(
                        &parent,
                        &["submodule", "update", "--init", &space_ref.path],
                        &[("GIT_LFS_SKIP_SMUDGE", "1")],
                    )
                    .await?;
                if out.exit_code != 0 {
                    return Err(AppError::GitCommandFailed(format!(
                        "git submodule update --init failed: {}",
                        out.stderr
                    )));
                }
                // Checkout default branch in the submodule
                let space_lock = git_state.get_lock(&space_dir).await;
                let _space_guard = space_lock.lock().await;
                let branch_out = cli
                    .exec(&space_dir, &["symbolic-ref", "refs/remotes/origin/HEAD"])
                    .await?;
                if branch_out.exit_code == 0 {
                    let branch = branch_out
                        .stdout
                        .trim()
                        .strip_prefix("refs/remotes/origin/")
                        .unwrap_or("main");
                    let _ = cli.exec(&space_dir, &["checkout", branch]).await;
                }
                if let Err(e) =
                    crate::identity::scaffold_space_git_identity(&cli, &space_dir, &parent).await
                {
                    tracing::warn!(
                        "scaffold_space_git_identity failed after submodule update: {e}"
                    );
                }
            } else {
                return Err(AppError::SpaceNotFound(space_id));
            }
        } else {
            return Err(AppError::SpaceNotFound(space_id));
        }
    }

    // Scaffold .svode/ and README.md if not present
    let svode_dir = space_dir.join(".svode");
    let svode_existed_before = svode_dir.exists();
    let readme_existed_before = space_dir.join("README.md").exists();
    if svode_existed_before {
        project::ensure_scope_readme(&space_dir, &space_ref.path)?;
    } else {
        crate::space::scaffold::scaffold_space(&space_dir, &space_ref.path, "", "")?;
    }
    if !svode_existed_before || !readme_existed_before {
        let commit_result = if !svode_existed_before && readme_existed_before {
            autocommit
                .commit_scaffold(parent.clone(), space_dir.clone())
                .await
        } else if !svode_existed_before {
            autocommit
                .commit_scaffold_with_readme(parent.clone(), space_dir.clone())
                .await
        } else {
            autocommit
                .commit_scope_readme(parent.clone(), space_dir.clone())
                .await
        };
        if let Err(e) = commit_result {
            tracing::warn!("commit_scaffold failed after clone_missing_space: {e}");
        }
    }

    index_state
        .on_space_status_changed(&app, &parent, &space_id, SpaceStatus::Ready)
        .await;
    emit_space_status_changed(&app, &parent, &space_id, old_status, SpaceStatus::Ready);

    // Spawn a background LFS probe — if the cloned space uses an LFS-flavoured
    // strategy, the frontend will see the right CTA without polling. We
    // deliberately do NOT run `git lfs pull` here; that's the user gesture
    // wired up via `storage::lfs::repair_lfs`.
    let app_handle = app.clone();
    let project_for_probe = parent.clone();
    let space_id_for_probe = space_id.clone();
    let target_dir = space_dir.clone();
    tauri::async_runtime::spawn(async move {
        let state = app_handle.state::<IndexState>();
        let key = match state
            .key_for_project_space_id(&project_for_probe, Some(&space_id_for_probe))
            .await
        {
            Ok(k) => k,
            Err(e) => {
                tracing::warn!("post-clone probe: key resolution failed: {e}");
                return;
            }
        };
        let probed =
            crate::storage::lfs::probe_lfs(&app_handle, &project_for_probe, &key, &target_dir)
                .await;
        state.set_lfs_state_with(&app_handle, &key, probed).await;
    });

    Ok(())
}

#[tauri::command]
pub async fn remove_missing_space(
    app: AppHandle,
    index_state: State<'_, IndexState>,
    project_path: String,
    space_id: String,
) -> Result<(), AppError> {
    let parent = Path::new(&project_path);
    project::remove_missing_space(parent, &space_id)?;
    index_state.on_space_removed(parent, &space_id).await;
    emit_space_removed(&app, parent, &space_id);
    Ok(())
}

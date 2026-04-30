use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::AppError;
use crate::git::autocommit::{AutocommitService, SystemCommitKind};
use crate::git::commands::{require_cli, GitState};
use crate::git::ops;
use crate::index::IndexState;
use crate::space::{config, project, registry, settings, symlinks, types::*};

fn detect_status_for_ref(parent: &Path, sp_ref: &SpaceRef) -> SpaceStatus {
    let space_dir = parent.join(&sp_ref.path);
    if space_dir.exists() {
        SpaceStatus::Ready
    } else if sp_ref.repo.is_some() {
        SpaceStatus::Missing
    } else {
        let gitmodules = parent.join(".gitmodules");
        if gitmodules.exists() {
            let content = std::fs::read_to_string(&gitmodules).unwrap_or_default();
            if content.contains(&format!("path = {}", sp_ref.path)) {
                SpaceStatus::Missing
            } else {
                SpaceStatus::Broken
            }
        } else {
            SpaceStatus::Broken
        }
    }
}

fn emit_space_added(app: &AppHandle, project: &Path, info: &SpaceInfo, folder: &str) {
    let _ = app.emit(
        "space:added",
        serde_json::json!({
            "projectPath": project.to_string_lossy(),
            "spaceId": info.id,
            "spacePath": project.join(folder).to_string_lossy(),
            "status": info.status,
        }),
    );
}

fn emit_space_removed(app: &AppHandle, project: &Path, space_id: &str) {
    let _ = app.emit(
        "space:removed",
        serde_json::json!({
            "projectPath": project.to_string_lossy(),
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
            "projectPath": project.to_string_lossy(),
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
                    has_spaces: cfg
                        .spaces
                        .as_ref()
                        .map(|s| !s.is_empty())
                        .unwrap_or(false),
                    last_opened: sp_ref.last_opened.clone(),
                    status: SpaceStatus::Ready,
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
    if sp_path.join(".combai").join("config.json").exists() {
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

    // `ops::init` stages everything (including the fresh `.combai/`) and
    // makes the initial `Scaffold .combai` commit — no follow-up commit
    // needed here.
    if let Some(cli) = &git_state.cli {
        let lock = git_state.get_lock(sp_path).await;
        let _guard = lock.lock().await;
        if let Err(e) = crate::git::ops::init(cli, sp_path).await {
            tracing::warn!("git init failed for new project: {e}");
        }
    }

    Ok(SpaceInfo {
        id,
        name: cfg.name,
        icon: cfg.icon,
        description: cfg.description,
        path,
        has_spaces: false,
        last_opened: None,
        status: SpaceStatus::Ready,
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

    // Track whether `.combai/` was present before we touched the folder —
    // only commit scaffold when we created it (not when opening an existing
    // combai project).
    let combai_existed_before = sp_path.join(".combai").join("config.json").exists();

    let (id, cfg) = project::open_project_folder(&config_dir, sp_path)?;

    // Auto git init if no .git/ exists. `ops::init` stages everything
    // (including the fresh .combai/) under a `Scaffold .combai` commit.
    let had_git_before = sp_path.join(".git").exists();
    if !had_git_before {
        if let Some(cli) = &git_state.cli {
            let lock = git_state.get_lock(sp_path).await;
            let _guard = lock.lock().await;
            if let Err(e) = crate::git::ops::init(cli, sp_path).await {
                tracing::warn!("git init failed for opened folder: {e}");
            }
        }
    }

    // If the folder was already a git repo but we just scaffolded .combai/
    // into it, commit the scaffold on top of HEAD.
    if had_git_before && !combai_existed_before {
        if let Err(e) = autocommit
            .commit_scaffold(sp_path.to_path_buf(), sp_path.to_path_buf())
            .await
        {
            tracing::warn!("commit_scaffold failed for opened folder: {e}");
        }
    }

    Ok(SpaceInfo {
        id,
        name: cfg.name,
        icon: cfg.icon,
        description: cfg.description,
        path,
        has_spaces: cfg
            .spaces
            .as_ref()
            .map(|s| !s.is_empty())
            .unwrap_or(false),
        last_opened: None,
        status: SpaceStatus::Ready,
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
    index_state: State<'_, IndexState>,
    id: String,
) -> Result<SpaceConfig, AppError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;
    registry::update_last_active(&config_dir, &id)?;
    registry::update_last_opened(&config_dir, &id)?;

    let sp_ref = registry::find_space(&config_dir, &id)?
        .ok_or_else(|| AppError::SpaceNotFound(id.clone()))?;

    let cfg = config::read_space_config(Path::new(&sp_ref.path))?;

    // Open root + every ready child-space pool, spawn full_reindex per pool
    // (under reindex lock + bounded concurrency). Failure is logged but does
    // not block project open — the user can always trigger a manual reindex
    // later. Initial state is not a transit, so no `space:status_changed`
    // emit is needed: the cache snapshot during open_project covers it.
    let project_path = PathBuf::from(&sp_ref.path);
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
pub async fn create_space(
    app: AppHandle,
    git_state: State<'_, GitState>,
    autocommit: State<'_, Arc<AutocommitService>>,
    index_state: State<'_, IndexState>,
    parent_path: String,
    name: String,
    icon: String,
    folder_name: String,
    git_type: SpaceGitType,
) -> Result<SpaceInfo, AppError> {
    let parent = Path::new(&parent_path);
    let info = project::create_space(parent, &name, &icon, &folder_name)?;
    let space_dir = parent.join(&folder_name);

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
            // Drain pending structural batches in the root repo so they
            // commit under their own per-space messages instead of being
            // swept into `Add inline space ...` by `add_all`.
            autocommit.flush_target_repo(parent).await;
            if let Some(cli) = &git_state.cli {
                let lock = git_state.get_lock(parent).await;
                let _guard = lock.lock().await;
                ops::add_all(cli, parent).await?;
                let _ = ops::commit(cli, parent, &root_message).await?;
            }
        }
        SpaceGitType::Independent => {
            let cli = require_cli(&git_state)?;
            {
                let lock = git_state.get_lock(&space_dir).await;
                let _guard = lock.lock().await;
                // ops::init scaffolds the initial commit as `Scaffold .combai`
                // inside the child repo (auto-sync OFF — the repo has no remote).
                ops::init(&cli, &space_dir).await?;
                if let Err(e) =
                    crate::identity::scaffold_space_git_identity(&cli, &space_dir, parent).await
                {
                    tracing::warn!("scaffold_space_git_identity failed for new independent space: {e}");
                }
            }
            ops::add_independent_gitignore(parent, &folder_name)?;
            autocommit.flush_target_repo(parent).await;
            {
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
                // Scaffold commit in the child (auto-sync OFF).
                ops::init(&cli, &space_dir).await?;
                if let Err(e) =
                    crate::identity::scaffold_space_git_identity(&cli, &space_dir, parent).await
                {
                    tracing::warn!("scaffold_space_git_identity failed for new submodule space: {e}");
                }
            }
            autocommit.flush_target_repo(parent).await;
            {
                let parent_lock = git_state.get_lock(parent).await;
                let _parent_guard = parent_lock.lock().await;
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
    autocommit: State<'_, Arc<AutocommitService>>,
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

    if let Some(cli) = &git_state.cli {
        // Drain pending structural batches in the root repo so they commit
        // under their own per-space messages instead of being swept into
        // `Remove ... space ...` by `add_all`.
        autocommit.flush_target_repo(parent).await;
        let lock = git_state.get_lock(parent).await;
        let _guard = lock.lock().await;
        ops::add_all(cli, parent).await?;
        let _ = ops::commit(cli, parent, &message).await?;
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
    let repo = if git_type == "independent" {
        Some(url)
    } else {
        None
    };

    let space_dir = path.join(&folder_name);
    let combai_existed_before = space_dir.join(".combai").join("config.json").exists();

    let info = project::register_cloned_space(path, &folder_name, &fallback_name, &fallback_icon, repo)?;

    if !combai_existed_before {
        if let Err(e) = autocommit
            .commit_scaffold(PathBuf::from(&parent_path), space_dir.clone())
            .await
        {
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

    // Check if .combai/ existed in the clone before we scaffold it.
    let combai_existed_before = path.join(".combai").join("config.json").exists();

    let (id, cfg) = project::open_project_folder(&config_dir, &path)?;

    // If we just scaffolded .combai/, commit it.
    if !combai_existed_before {
        if let Err(e) = autocommit.commit_scaffold(path.clone(), path.clone()).await {
            tracing::warn!("commit_scaffold failed after project clone: {e}");
        }
    }

    Ok(SpaceInfo {
        id,
        name: cfg.name,
        icon: cfg.icon,
        description: cfg.description,
        path: target_path,
        has_spaces: cfg
            .spaces
            .as_ref()
            .map(|s| !s.is_empty())
            .unwrap_or(false),
        last_opened: None,
        status: SpaceStatus::Ready,
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
    let path = Path::new(&space_path).join(".combai").join("AGENTS.md");
    if path.exists() {
        Ok(Some(std::fs::read_to_string(&path)?))
    } else {
        Ok(None)
    }
}

/// Write `.combai/AGENTS.md` and immediately commit it as a System change
/// (`Update agent instructions`). Stage-3.5 classifies AI-instruction files
/// as System; a future AI stage may promote them to their own category.
#[tauri::command]
pub async fn write_agents_md(
    space_path: String,
    content: String,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<(), AppError> {
    let combai_dir = Path::new(&space_path).join(".combai");
    std::fs::create_dir_all(&combai_dir)?;
    std::fs::write(combai_dir.join("AGENTS.md"), content)?;

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
                    .exec(&parent, &["submodule", "update", "--init", &space_ref.path])
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

    // Scaffold .combai/ if not present
    let combai_dir = space_dir.join(".combai");
    let combai_existed_before = combai_dir.exists();
    if !combai_existed_before {
        crate::space::scaffold::scaffold_space(&space_dir, &space_ref.path, "", "")?;
        if let Err(e) = autocommit
            .commit_scaffold(parent.clone(), space_dir.clone())
            .await
        {
            tracing::warn!("commit_scaffold failed after clone_missing_space: {e}");
        }
    }

    index_state
        .on_space_status_changed(&app, &parent, &space_id, SpaceStatus::Ready)
        .await;
    emit_space_status_changed(&app, &parent, &space_id, old_status, SpaceStatus::Ready);

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

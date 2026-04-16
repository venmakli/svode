use std::path::Path;
use std::path::PathBuf;

use tauri::{AppHandle, Manager, State};

use crate::error::AppError;
use crate::git::commands::{require_cli, GitState};
use crate::git::ops;
use crate::index::IndexState;
use crate::space::{config, project, registry, settings, symlinks, types::*};

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

    // Auto git init
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
    path: String,
) -> Result<SpaceInfo, AppError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;
    let sp_path = Path::new(&path);
    let (id, cfg) = project::open_project_folder(&config_dir, sp_path)?;

    // Auto git init if no .git/ exists
    if !sp_path.join(".git").exists() {
        if let Some(cli) = &git_state.cli {
            let lock = git_state.get_lock(sp_path).await;
            let _guard = lock.lock().await;
            if let Err(e) = crate::git::ops::init(cli, sp_path).await {
                tracing::warn!("git init failed for opened folder: {e}");
            }
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

    // Close the index pool before any filesystem operations so SQLite releases
    // file handles (Windows would otherwise refuse to remove the directory).
    if let Some(sp_ref) = registry::find_space(&config_dir, &id)? {
        index_state.close(&sp_ref.path).await;
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

    // Build/refresh the SQLite index in the background so the UI doesn't wait
    // on filesystem walk + N upserts. Failure is logged but does not block
    // project open — the user can always trigger a manual reindex later.
    let pool = index_state.get_or_create(&sp_ref.path).await?;
    let reindex_lock = index_state.reindex_lock(&sp_ref.path).await;
    let space_dir: PathBuf = PathBuf::from(&sp_ref.path);
    tokio::spawn(async move {
        let _guard = reindex_lock.lock().await;
        if let Err(e) = crate::index::reindex::full_reindex(&pool, &space_dir).await {
            tracing::warn!(
                "background reindex failed for {}: {e}",
                space_dir.display()
            );
        }
    });

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
    git_state: State<'_, GitState>,
    parent_path: String,
    name: String,
    icon: String,
    folder_name: String,
    git_type: SpaceGitType,
) -> Result<SpaceInfo, AppError> {
    let parent = Path::new(&parent_path);
    let info = project::create_space(parent, &name, &icon, &folder_name)?;
    let space_dir = parent.join(&folder_name);

    match git_type {
        SpaceGitType::Inline => {
            ops::ensure_inline_gitignore(parent)?;
        }
        SpaceGitType::Independent => {
            let cli = require_cli(&git_state)?;
            let lock = git_state.get_lock(&space_dir).await;
            let _guard = lock.lock().await;
            ops::init(&cli, &space_dir).await?;
            ops::add_independent_gitignore(parent, &folder_name)?;
        }
        SpaceGitType::Submodule => {
            let cli = require_cli(&git_state)?;
            let lock = git_state.get_lock(&space_dir).await;
            let _guard = lock.lock().await;
            ops::init(&cli, &space_dir).await?;
            drop(_guard);
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
        }
    }

    Ok(info)
}

#[tauri::command]
pub fn delete_space(
    parent_path: String,
    space_id: String,
    delete_files: Option<bool>,
) -> Result<(), AppError> {
    let path = Path::new(&parent_path);
    project::delete_space(path, &space_id, delete_files.unwrap_or(false))
}

#[tauri::command]
pub fn register_cloned_space(
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
    project::register_cloned_space(path, &folder_name, &fallback_name, &fallback_icon, repo)
}

// --- Clone project ---

#[tauri::command]
pub async fn project_clone(
    app: AppHandle,
    git_state: State<'_, GitState>,
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
    let (id, cfg) = project::open_project_folder(&config_dir, &path)?;

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
pub fn save_space_config(
    space_path: String,
    config_data: SpaceConfig,
) -> Result<(), AppError> {
    let path = Path::new(&space_path);
    config::write_space_config(path, &config_data)
}

// --- CLI Symlinks ---

#[tauri::command]
pub fn setup_cli_symlinks_cmd(
    space_path: String,
    cli_name: String,
) -> Result<Vec<String>, AppError> {
    let path = Path::new(&space_path);
    symlinks::setup_cli_symlinks(path, &cli_name)
}

#[tauri::command]
pub fn teardown_cli_symlinks_cmd(
    space_path: String,
    cli_name: String,
) -> Result<(), AppError> {
    let path = Path::new(&space_path);
    symlinks::teardown_cli_symlinks(path, &cli_name)
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

// --- Ghost-state space operations ---

#[tauri::command]
pub async fn clone_missing_space(
    app: AppHandle,
    git_state: State<'_, GitState>,
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

    let space_dir = parent.join(&space_ref.path);

    if let Some(url) = &space_ref.repo {
        // Independent: clone + gitignore
        let cli = require_cli(&git_state)?;
        let lock = git_state.get_lock(&space_dir).await;
        let _guard = lock.lock().await;
        crate::git::clone::clone_with_progress(&cli, &app, url, &space_dir).await?;
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
            } else {
                return Err(AppError::SpaceNotFound(space_id));
            }
        } else {
            return Err(AppError::SpaceNotFound(space_id));
        }
    }

    // Scaffold .combai/ if not present
    let combai_dir = space_dir.join(".combai");
    if !combai_dir.exists() {
        crate::space::scaffold::scaffold_space(&space_dir, &space_ref.path, "", "")?;
    }

    Ok(())
}

#[tauri::command]
pub fn remove_missing_space(
    project_path: String,
    space_id: String,
) -> Result<(), AppError> {
    let parent = Path::new(&project_path);
    project::remove_missing_space(parent, &space_id)
}

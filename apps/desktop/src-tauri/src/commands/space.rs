use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State, Window};

use crate::app_windows::{ProjectWindowRequest, WindowBinding, WindowView};
use crate::error::AppError;
use crate::git::access::{RepositoryAccessSnapshot, require_repository_mutation};
use crate::git::commands::{auto_commit_structural_enabled, init_repo_with_policy};
use crate::git::{GitState, require_cli};
use crate::index::IndexState;
use crate::project_runtime::ProjectRuntimeState;
use crate::routines::RoutineSchedulerState;
use crate::space::{config, content_tree, project, registry, settings, types::*};
use svode_core::git::autocommit::{AutocommitService, SystemCommitKind};
use svode_core::git::{local_repair, ops};
use svode_core::storage::lfs::LfsState;
use svode_core::system_path;

/// The window either serves the project now, or the project has another
/// window, which came forward and took the action.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EnterProjectResult {
    Opened {
        config: Box<SpaceConfig>,
        project: SpaceInfo,
    },
    OtherWindow,
}

/// How a window enters a project. Opening shows its Space and records the
/// project as last opened; Home activation keeps the window on Home and leaves
/// the registry as is. Both prepare the project and bind the window the same way.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProjectEntry {
    Open,
    HomeActivation,
}

impl ProjectEntry {
    fn view(self) -> WindowView {
        match self {
            Self::Open => WindowView::Project,
            Self::HomeActivation => WindowView::Home,
        }
    }

    fn records_open(self) -> bool {
        self == Self::Open
    }
}

fn detect_status_for_ref(parent: &Path, sp_ref: &SpaceRef) -> SpaceStatus {
    project::space_ref_status(parent, sp_ref)
}

async fn import_existing_submodules_if_possible(
    git_state: &GitState,
    project_path: &Path,
) -> usize {
    let Some(cli) = git_state.detected() else {
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

fn automatic_repairs_allowed(
    result: Result<RepositoryAccessSnapshot, AppError>,
    repository: &Path,
) -> bool {
    match result {
        Ok(_) => true,
        Err(error) => {
            tracing::info!(
                repository = %repository.display(),
                error_kind = error.kind(),
                "skipping automatic tracked repository repairs"
            );
            false
        }
    }
}

async fn allow_automatic_repository_repairs(app: &AppHandle, repository: &Path) -> bool {
    automatic_repairs_allowed(
        require_repository_mutation(app, repository).await,
        repository,
    )
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

fn refresh_recent_projects_menu(app: &AppHandle) {
    if let Err(error) = crate::app_windows::rebuild_app_menu(app) {
        tracing::warn!("failed to rebuild recent projects menu: {error}");
    }
}

fn root_project_info(
    id: String,
    path: &Path,
    cfg: &SpaceConfig,
    last_opened: Option<String>,
) -> SpaceInfo {
    SpaceInfo {
        id,
        name: cfg.name.clone(),
        icon: cfg.icon.clone(),
        description: cfg.description.clone(),
        path: system_path::user_facing_path(path),
        has_spaces: cfg.spaces.as_ref().map(|s| !s.is_empty()).unwrap_or(false),
        has_schema: project::has_schema_capability(path, SpaceStatus::Ready),
        has_app: project::has_app_capability(path, SpaceStatus::Ready),
        last_opened,
        status: SpaceStatus::Ready,
        lfs_state: LfsState::NotApplicable,
    }
}

// --- App Settings ---

const APP_PREFERENCES_CHANGED_EVENT: &str = "app-settings:preferences-changed";

#[tauri::command]
pub fn get_app_preferences(
    app: AppHandle,
    settings_state: State<'_, settings::AppSettingsState>,
) -> Result<AppPreferences, AppError> {
    let _guard = settings_state.lock()?;
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;
    settings::read_app_preferences(&config_dir)
}

#[tauri::command]
pub fn set_app_locale(
    app: AppHandle,
    settings_state: State<'_, settings::AppSettingsState>,
    locale: String,
) -> Result<String, AppError> {
    let _guard = settings_state.lock()?;
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;
    let mutation = settings::set_app_locale(&config_dir, &locale)?;
    if mutation.changed {
        let _ = app.emit(APP_PREFERENCES_CHANGED_EVENT, ());
    }
    Ok(mutation.value)
}

#[tauri::command]
pub fn set_app_theme(
    app: AppHandle,
    settings_state: State<'_, settings::AppSettingsState>,
    theme: String,
) -> Result<String, AppError> {
    let _guard = settings_state.lock()?;
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;
    let mutation = settings::set_app_theme(&config_dir, &theme)?;
    if mutation.changed {
        let _ = app.emit(APP_PREFERENCES_CHANGED_EVENT, ());
    }
    Ok(mutation.value)
}

// --- Projects ---

#[tauri::command]
pub fn list_projects(app: AppHandle) -> Result<Vec<SpaceInfo>, AppError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;
    let reg = registry::read_registry(&config_dir)?;
    Ok(reg.spaces.iter().map(listed_project_info).collect())
}

/// A project of the list; one whose folder is gone or whose config cannot be
/// read stays in the list as missing or broken, named after its folder.
fn listed_project_info(entry: &RegistryEntry) -> SpaceInfo {
    let path = Path::new(&entry.path);
    if let Ok(cfg) = config::read_space_config(path) {
        return root_project_info(entry.id.clone(), path, &cfg, entry.last_opened.clone());
    }
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| entry.path.clone());
    SpaceInfo {
        id: entry.id.clone(),
        name,
        icon: String::new(),
        description: String::new(),
        path: system_path::user_facing_path(path),
        has_spaces: false,
        has_schema: false,
        has_app: false,
        last_opened: entry.last_opened.clone(),
        status: if path.is_dir() {
            SpaceStatus::Broken
        } else {
            SpaceStatus::Missing
        },
        lfs_state: LfsState::NotApplicable,
    }
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

    if sp_path.join(".git").symlink_metadata().is_ok() {
        require_repository_mutation(&app, sp_path).await?;
        crate::git::delivery::require_scope_repair(&app, sp_path, sp_path).await?;
    }

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
    refresh_recent_projects_menu(&app);
    app.state::<RoutineSchedulerState>().sync(&app);

    if let Some(cli) = git_state.detected() {
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
        has_schema: project::has_schema_capability(sp_path, SpaceStatus::Ready),
        has_app: project::has_app_capability(sp_path, SpaceStatus::Ready),
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
    let preauthorized_readme_repair =
        had_git_before && svode_existed_before && !readme_existed_before;
    if preauthorized_readme_repair {
        require_repository_mutation(&app, sp_path).await?;
    }
    let (id, mut cfg) = project::open_project_folder(&config_dir, sp_path)?;
    refresh_recent_projects_menu(&app);
    app.state::<RoutineSchedulerState>().sync(&app);
    let repairs_allowed = !had_git_before
        || !svode_existed_before
        || preauthorized_readme_repair
        || allow_automatic_repository_repairs(&app, sp_path).await;
    let gitignore_changed = if had_git_before && repairs_allowed {
        crate::git::delivery::repair_scope(&app, sp_path, sp_path).await?
            == local_repair::RepairOutcome::Changed
    } else {
        false
    };
    let imported_submodules = if repairs_allowed {
        import_existing_submodules_if_possible(&git_state, sp_path).await
    } else {
        0
    };
    if imported_submodules > 0 {
        cfg = config::read_space_config(sp_path)?;
    }

    if !had_git_before {
        if let Some(cli) = git_state.detected() {
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

    crate::git::delivery::repair_project(&app, sp_path).await;

    Ok(SpaceInfo {
        id,
        name: cfg.name,
        icon: cfg.icon,
        description: cfg.description,
        path: system_path::user_facing_path(sp_path),
        has_spaces: cfg.spaces.as_ref().map(|s| !s.is_empty()).unwrap_or(false),
        has_schema: project::has_schema_capability(sp_path, SpaceStatus::Ready),
        has_app: project::has_app_capability(sp_path, SpaceStatus::Ready),
        last_opened: None,
        status: SpaceStatus::Ready,
        lfs_state: LfsState::NotApplicable,
    })
}

#[tauri::command]
pub async fn delete_project(
    app: AppHandle,
    project_runtime: State<'_, ProjectRuntimeState>,
    app_process_state: State<'_, crate::apps::AppProcessState>,
    id: String,
    delete_files: Option<bool>,
) -> Result<(), AppError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;

    let project_ref = registry::find_space(&config_dir, &id)?;
    if delete_files.unwrap_or(false)
        && let Some(sp_ref) = project_ref.as_ref()
    {
        require_repository_mutation(&app, Path::new(&sp_ref.path)).await?;
    }

    // Close the project's pools before any filesystem operations so SQLite
    // releases file handles (Windows would otherwise refuse to remove the
    // directory).
    let routine_schedulers = app.state::<RoutineSchedulerState>();
    if let Some(sp_ref) = project_ref {
        app_process_state.stop_project(Path::new(&sp_ref.path));
        project_runtime
            .close_project(&app, Path::new(&sp_ref.path))
            .await;
        routine_schedulers
            .remove_project(&app, &id, Path::new(&sp_ref.path))
            .await;
    }

    let deleted = project::delete_project(&config_dir, &id, delete_files.unwrap_or(false));
    routine_schedulers.sync(&app);
    deleted?;
    crate::app_windows::release_project_window(&app, &id);
    refresh_recent_projects_menu(&app);
    Ok(())
}

#[tauri::command]
pub async fn open_project(
    app: AppHandle,
    window: Window,
    git_state: State<'_, GitState>,
    autocommit: State<'_, Arc<AutocommitService>>,
    project_runtime: State<'_, ProjectRuntimeState>,
    id: String,
) -> Result<EnterProjectResult, AppError> {
    enter_project(
        &app,
        window.label(),
        &git_state,
        &autocommit,
        &project_runtime,
        id,
        ProjectEntry::Open,
        ProjectWindowRequest::Focus,
    )
    .await
}

/// Makes the project the active project of the Home window; a project bound to
/// another window gets `request` there instead.
#[tauri::command]
pub async fn activate_home_project(
    app: AppHandle,
    window: Window,
    git_state: State<'_, GitState>,
    autocommit: State<'_, Arc<AutocommitService>>,
    project_runtime: State<'_, ProjectRuntimeState>,
    id: String,
    request: ProjectWindowRequest,
) -> Result<EnterProjectResult, AppError> {
    enter_project(
        &app,
        window.label(),
        &git_state,
        &autocommit,
        &project_runtime,
        id,
        ProjectEntry::HomeActivation,
        request,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn enter_project(
    app: &AppHandle,
    window_label: &str,
    git_state: &GitState,
    autocommit: &AutocommitService,
    project_runtime: &ProjectRuntimeState,
    id: String,
    entry: ProjectEntry,
    request: ProjectWindowRequest,
) -> Result<EnterProjectResult, AppError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::General(e.to_string()))?;

    let sp_ref = registry::find_space(&config_dir, &id)?
        .ok_or_else(|| AppError::SpaceNotFound(id.clone()))?;
    let project_path = PathBuf::from(&sp_ref.path);
    // A missing or unreadable project fails before it is prepared or bound.
    config::read_space_config(&project_path)?;

    let binding = match crate::app_windows::window_binding(app, window_label, &id) {
        WindowBinding::OtherWindow(owner) => {
            crate::app_windows::hand_off_to_project_window(app, &owner, &request)?;
            return Ok(EnterProjectResult::OtherWindow);
        }
        WindowBinding::Unchanged => {
            crate::app_windows::bind_window_project(app, window_label, &id, entry.view())
        }
        WindowBinding::Bound { .. } => {
            prepare_project(app, git_state, autocommit, &project_path).await?;
            crate::app_windows::bind_window_project(app, window_label, &id, entry.view())
        }
    };
    if let WindowBinding::OtherWindow(owner) = binding {
        crate::app_windows::hand_off_to_project_window(app, &owner, &request)?;
        return Ok(EnterProjectResult::OtherWindow);
    }

    if entry.records_open() {
        registry::update_last_active(&config_dir, &id)?;
        registry::update_last_opened(&config_dir, &id)?;
        refresh_recent_projects_menu(app);
    }

    // Open root + every ready child-space pool, spawn full_reindex per pool
    // (under reindex lock + bounded concurrency). Failure is logged but does
    // not block project open — the user can always trigger a manual reindex
    // later. Initial state is not a transit, so no `space:status_changed`
    // emit is needed: the cache snapshot during open_project covers it.
    // A window that already serves the project keeps its runtime running.
    if matches!(binding, WindowBinding::Bound { .. }) {
        if let Err(e) = project_runtime
            .open_project(app, project_path.clone())
            .await
        {
            tracing::warn!(
                "project runtime open failed for {}: {e}",
                project_path.display()
            );
        }
        crate::app_windows::stop_runtime_unless_served(app, &id);
    }

    let cfg = config::read_space_config(&project_path)?;
    let project = root_project_info(id, &project_path, &cfg, sp_ref.last_opened);
    Ok(EnterProjectResult::Opened {
        config: Box::new(cfg),
        project,
    })
}

/// Repairs a project before a window serves it, under the repository repair
/// policy: `.gitignore`, existing submodules and the root README, each with its
/// system commit.
async fn prepare_project(
    app: &AppHandle,
    git_state: &GitState,
    autocommit: &AutocommitService,
    project_path: &Path,
) -> Result<(), AppError> {
    let project_path = project_path.to_path_buf();
    let readme_existed_before = project_path.join("README.md").exists();
    let has_git = project_path.join(".git").exists();
    let repairs_allowed = !has_git || allow_automatic_repository_repairs(app, &project_path).await;
    let gitignore_changed = if repairs_allowed {
        crate::git::delivery::repair_scope(app, &project_path, &project_path).await?
            == local_repair::RepairOutcome::Changed
    } else {
        false
    };
    let imported_submodules = if repairs_allowed {
        import_existing_submodules_if_possible(git_state, &project_path).await
    } else {
        0
    };
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
    let readme_created = if repairs_allowed {
        project::ensure_scope_readme(&project_path, &cfg.name)?
    } else {
        false
    };
    if readme_created && project_path.join(".git").exists() && !readme_existed_before {
        if let Err(e) = autocommit
            .commit_scope_readme(project_path.clone(), project_path.clone())
            .await
        {
            tracing::warn!("commit README scaffold failed for project open: {e}");
        }
    }
    Ok(())
}

// --- Spaces ---

#[tauri::command]
pub fn list_spaces(space_path: String) -> Result<Vec<SpaceInfo>, AppError> {
    let path = Path::new(&space_path);
    content_tree::list_child_spaces(path)
}

#[tauri::command]
pub async fn reorder_spaces(
    app: AppHandle,
    project_path: String,
    ordered_space_ids: Vec<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<Vec<SpaceInfo>, AppError> {
    let parent = PathBuf::from(&project_path);
    require_repository_mutation(&app, &parent).await?;
    let outcome =
        crate::git::access::scope_authorized_mutation_paths(vec![parent.clone()], async {
            Ok::<_, AppError>(svode_core::structure::reorder_child_spaces(
                &parent,
                ordered_space_ids,
            )?)
        })
        .await?;

    if outcome.changed {
        if let Err(e) = autocommit
            .commit_system_now(
                parent.clone(),
                parent.clone(),
                SystemCommitKind::ReorderSpaces,
            )
            .await
        {
            tracing::warn!("commit reorder spaces failed: {e}");
        }
    }

    content_tree::list_child_spaces(&parent)
}

#[tauri::command]
pub async fn create_space(
    app: AppHandle,
    git_state: State<'_, GitState>,
    project_runtime: State<'_, ProjectRuntimeState>,
    parent_path: String,
    name: String,
    icon: String,
    folder_name: String,
    git_type: SpaceGitType,
) -> Result<SpaceInfo, AppError> {
    let parent = Path::new(&parent_path);
    require_repository_mutation(&app, parent).await?;
    crate::git::delivery::require_scope_repair(&app, parent, parent).await?;
    let folder_name = project::normalize_space_folder(&folder_name)?;
    let info = project::create_space(parent, &name, &icon, &folder_name)?;
    let space_dir = parent.join(&folder_name);
    let root_structural_autocommit = auto_commit_structural_enabled(parent);
    let space_structural_autocommit = auto_commit_structural_enabled(&space_dir);

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
            if root_structural_autocommit {
                if let Some(cli) = git_state.detected() {
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
                if space_structural_autocommit {
                    ops::add_all(&cli, &space_dir).await?;
                    let _ = ops::commit(&cli, &space_dir, "Scaffold .svode").await?;
                }
            }
            ops::add_independent_gitignore(parent, &folder_name)?;
            if root_structural_autocommit {
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
                if space_structural_autocommit {
                    ops::add_all(&cli, &space_dir).await?;
                    let _ = ops::commit(&cli, &space_dir, "Scaffold .svode").await?;
                }
            }
            {
                let parent_lock = git_state.get_lock(parent).await;
                let _parent_guard = parent_lock.lock().await;
                if root_structural_autocommit && space_structural_autocommit {
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
                    if root_structural_autocommit {
                        ops::add(&cli, parent, ".svode/config.json").await?;
                        ops::add(&cli, parent, ".gitmodules").await?;
                        let _ = ops::commit(&cli, parent, &root_message).await?;
                    }
                }
            }
        }
    }

    project_runtime
        .on_space_added(&app, parent, &info.id, &folder_name, info.status)
        .await;
    emit_space_added(&app, parent, &info, &folder_name);

    Ok(info)
}

#[tauri::command]
pub async fn delete_space(
    app: AppHandle,
    git_state: State<'_, GitState>,
    project_runtime: State<'_, ProjectRuntimeState>,
    parent_path: String,
    space_id: String,
    delete_files: Option<bool>,
) -> Result<(), AppError> {
    let parent = Path::new(&parent_path);
    require_repository_mutation(&app, parent).await?;
    crate::git::delivery::repair_scope_best_effort(&app, parent, parent).await;

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
        let gt = if let Some(cli) = git_state.detected() {
            match ops::detect_space_git_type(cli, parent, &space_dir).await {
                Ok(gt) => gt,
                Err(_) => SpaceGitType::Inline,
            }
        } else {
            SpaceGitType::Inline
        };
        (folder, gt)
    };

    if delete_files.unwrap_or(false) && !matches!(git_type, SpaceGitType::Inline) {
        require_repository_mutation(&app, &parent.join(&folder_name)).await?;
    }

    project::delete_space(parent, &space_id, delete_files.unwrap_or(false))?;

    let type_label = match git_type {
        SpaceGitType::Inline => "inline",
        SpaceGitType::Independent => "independent",
        SpaceGitType::Submodule => "submodule",
    };
    let message = format!("Remove {} space {}", type_label, folder_name);

    if auto_commit_structural_enabled(parent) {
        if let Some(cli) = git_state.detected() {
            let lock = git_state.get_lock(parent).await;
            let _guard = lock.lock().await;
            ops::add_all(cli, parent).await?;
            let _ = ops::commit(cli, parent, &message).await?;
        }
    }

    project_runtime
        .on_space_removed(&app, parent, &space_id)
        .await;
    emit_space_removed(&app, parent, &space_id);

    Ok(())
}

#[tauri::command]
pub async fn register_cloned_space(
    app: AppHandle,
    autocommit: State<'_, Arc<AutocommitService>>,
    project_runtime: State<'_, ProjectRuntimeState>,
    parent_path: String,
    folder_name: String,
    fallback_name: String,
    fallback_icon: String,
    url: String,
    git_type: String,
) -> Result<SpaceInfo, AppError> {
    let path = Path::new(&parent_path);
    require_repository_mutation(&app, path).await?;
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

    crate::git::delivery::repair_project(&app, path).await;
    crate::git::delivery::repair_scope_best_effort(&app, path, &space_dir).await;

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

    project_runtime
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
    let cli = crate::git::require_cli(&git_state)?;
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
    refresh_recent_projects_menu(&app);
    app.state::<RoutineSchedulerState>().sync(&app);
    let gitignore_changed = crate::git::delivery::repair_scope(&app, &path, &path).await?
        == local_repair::RepairOutcome::Changed;
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

    crate::git::delivery::repair_project(&app, &path).await;

    Ok(SpaceInfo {
        id,
        name: cfg.name,
        icon: cfg.icon,
        description: cfg.description,
        path: system_path::user_facing_path(&path),
        has_spaces: cfg.spaces.as_ref().map(|s| !s.is_empty()).unwrap_or(false),
        has_schema: project::has_schema_capability(&path, SpaceStatus::Ready),
        has_app: project::has_app_capability(&path, SpaceStatus::Ready),
        last_opened: None,
        status: SpaceStatus::Ready,
        lfs_state: LfsState::NotApplicable,
    })
}

#[tauri::command]
pub fn path_exists(path: String) -> Result<bool, AppError> {
    Ok(Path::new(&path).exists())
}

/// What a local path names, for a link to it in the chat.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PathKind {
    File,
    Directory,
}

/// What is at a local path: a link to it opens it, a drop into the composer
/// attaches it only when it can be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPath {
    pub kind: PathKind,
    /// A file opens for reading, a folder lists its entries.
    pub readable: bool,
}

/// Whether `path` names a file or a folder and can be read; none when
/// nothing is there.
#[tauri::command]
pub fn path_kind(path: String) -> Result<Option<LocalPath>, AppError> {
    Ok(local_path_kind(Path::new(&path)))
}

fn local_path_kind(path: &Path) -> Option<LocalPath> {
    let metadata = std::fs::metadata(path).ok()?;
    Some(if metadata.is_dir() {
        LocalPath {
            kind: PathKind::Directory,
            readable: std::fs::read_dir(path).is_ok(),
        }
    } else {
        LocalPath {
            kind: PathKind::File,
            readable: std::fs::File::open(path).is_ok(),
        }
    })
}

/// Files of the project whose name contains `query`, nearest first, as
/// absolute paths; pages are found by the title search.
#[tauri::command]
pub async fn search_project_files(
    project_path: String,
    query: String,
    limit: usize,
) -> Result<Vec<String>, AppError> {
    let root = PathBuf::from(&project_path);
    if !root.is_absolute() || !root.is_dir() {
        return Err(AppError::PathNotAccessible(project_path));
    }
    let found = tauri::async_runtime::spawn_blocking(move || {
        svode_core::content_tree::find_project_files(&root, &query, limit.min(50))
    })
    .await
    .map_err(|error| AppError::General(format!("File search failed: {error}")))?;
    Ok(found
        .into_iter()
        .filter_map(|path| path.into_os_string().into_string().ok())
        .collect())
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
    app: AppHandle,
    project_path: String,
    space_path: String,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<(), AppError> {
    let path = Path::new(&space_path);
    if !path.is_dir() {
        return Err(AppError::PathNotAccessible(space_path));
    }
    require_repository_mutation(&app, path).await?;

    let svode_existed_before = path.join(".svode").join("config.json").exists();
    let readme_existed_before = path.join("README.md").exists();
    let fallback_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "Space".to_string());
    if svode_existed_before {
        project::ensure_scope_readme(path, &fallback_name)?;
    } else {
        if path.join(".git").symlink_metadata().is_ok() {
            crate::space::scaffold::scaffold_repository_space(path, &fallback_name, "", "")?;
        } else {
            crate::space::scaffold::scaffold_space(path, &fallback_name, "", "")?;
        }
    }

    crate::git::delivery::repair_project(&app, Path::new(&project_path)).await;
    crate::git::delivery::repair_scope_best_effort(&app, Path::new(&project_path), path).await;

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
    app: AppHandle,
    space_path: String,
    config_data: SpaceConfig,
    project_path: Option<String>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<(), AppError> {
    let path = Path::new(&space_path);
    require_repository_mutation(&app, path).await?;
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

// --- Ghost-state space operations ---

#[tauri::command]
pub async fn clone_missing_space(
    app: AppHandle,
    git_state: State<'_, GitState>,
    autocommit: State<'_, Arc<AutocommitService>>,
    project_runtime: State<'_, ProjectRuntimeState>,
    project_path: String,
    space_id: String,
) -> Result<(), AppError> {
    let parent = PathBuf::from(&project_path);
    let root_mutation_allowed = require_repository_mutation(&app, &parent).await.is_ok();
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
        if root_mutation_allowed
            && crate::git::delivery::repair_scope(&app, &parent, &parent).await?
                != local_repair::RepairOutcome::Skipped
        {
            ops::add_independent_gitignore(&parent, &space_ref.path)?;
        } else {
            tracing::warn!(
                "clone_missing_space: skipped root .gitignore update because repository access is not writable"
            );
        }
    } else {
        let cli = require_cli(&git_state)?;
        let space_lock = git_state.get_lock(&space_dir).await;
        let _space_guard = space_lock.lock().await;
        let root_lock = git_state.get_lock(&parent).await;
        let _root_guard = root_lock.lock().await;
        svode_core::git::branch::materialize(&cli, &parent, &space_dir, &space_ref.path).await?;
        if let Err(e) =
            crate::identity::scaffold_space_git_identity(&cli, &space_dir, &parent).await
        {
            tracing::warn!("scaffold_space_git_identity failed after submodule update: {e}");
        }
    }

    crate::git::delivery::repair_scope_best_effort(&app, &parent, &space_dir).await;

    // Scaffold .svode/ and README.md if not present
    let svode_dir = space_dir.join(".svode");
    let svode_existed_before = svode_dir.exists();
    let readme_existed_before = space_dir.join("README.md").exists();
    if svode_existed_before {
        project::ensure_scope_readme(&space_dir, &space_ref.path)?;
    } else {
        crate::space::scaffold::scaffold_repository_space(&space_dir, &space_ref.path, "", "")?;
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

    project_runtime
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
    project_runtime: State<'_, ProjectRuntimeState>,
    project_path: String,
    space_id: String,
) -> Result<(), AppError> {
    let parent = Path::new(&project_path);
    require_repository_mutation(&app, parent).await?;
    project::remove_missing_space(parent, &space_id)?;
    project_runtime
        .on_space_removed(&app, parent, &space_id)
        .await;
    emit_space_removed(&app, parent, &space_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::access::RepositoryAccessStatus;

    #[test]
    fn path_kind_tells_a_file_from_a_folder_and_nothing() {
        let temp = tempfile::tempdir().expect("temp dir");
        let file = temp.path().join("notes.md");
        std::fs::write(&file, "notes").expect("write file");
        let readable = |kind| {
            Some(LocalPath {
                kind,
                readable: true,
            })
        };
        assert_eq!(local_path_kind(&file), readable(PathKind::File));
        assert_eq!(local_path_kind(temp.path()), readable(PathKind::Directory));
        assert_eq!(local_path_kind(&temp.path().join("gone.md")), None);
    }

    #[cfg(unix)]
    #[test]
    fn path_kind_tells_an_unreadable_file_or_folder_from_a_missing_one() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().expect("temp dir");
        let file = temp.path().join("secret.md");
        let folder = temp.path().join("private");
        std::fs::write(&file, "secret").expect("write file");
        std::fs::create_dir(&folder).expect("create folder");
        let closed = std::fs::Permissions::from_mode(0o000);
        std::fs::set_permissions(&file, closed.clone()).expect("close file");
        std::fs::set_permissions(&folder, closed).expect("close folder");
        let file_kind = local_path_kind(&file);
        let folder_kind = local_path_kind(&folder);
        let open = std::fs::Permissions::from_mode(0o755);
        std::fs::set_permissions(&file, open.clone()).expect("open file");
        std::fs::set_permissions(&folder, open).expect("open folder");
        let unreadable = |kind| {
            Some(LocalPath {
                kind,
                readable: false,
            })
        };
        assert_eq!(file_kind, unreadable(PathKind::File));
        assert_eq!(folder_kind, unreadable(PathKind::Directory));
    }

    #[test]
    fn automatic_open_repairs_are_skipped_when_access_gate_denies() {
        let repository = Path::new("/project");
        assert!(!automatic_repairs_allowed(
            Err(AppError::RepositoryAccessDenied {
                repository_id: "repo".to_string(),
                status: "read_only".to_string(),
                reason: "auth_required".to_string(),
                blockers: Vec::new(),
            }),
            repository,
        ));
        assert!(automatic_repairs_allowed(
            Ok(RepositoryAccessSnapshot {
                repository_id: "repo".to_string(),
                generation: 1,
                status: RepositoryAccessStatus::Local,
                reason: None,
                checked_at: None,
                expires_at: None,
                last_known_status: None,
            }),
            repository,
        ));
    }

    #[test]
    fn home_activation_keeps_home_and_the_registry_unlike_open() {
        assert_eq!(ProjectEntry::Open.view(), WindowView::Project);
        assert!(ProjectEntry::Open.records_open());
        assert_eq!(ProjectEntry::HomeActivation.view(), WindowView::Home);
        assert!(!ProjectEntry::HomeActivation.records_open());
    }

    #[test]
    fn unavailable_projects_stay_in_the_list_as_missing_or_broken() {
        let temp = tempfile::tempdir().expect("temp dir");
        let ready = temp.path().join("ready");
        std::fs::create_dir_all(ready.join(".svode")).expect("svode dir");
        std::fs::write(
            ready.join(".svode/config.json"),
            r#"{"name":"Ready","icon":"🚀"}"#,
        )
        .expect("config");
        let broken = temp.path().join("broken");
        std::fs::create_dir_all(broken.join(".svode")).expect("svode dir");
        std::fs::write(broken.join(".svode/config.json"), "{").expect("config");
        let entry = |id: &str, path: &Path| RegistryEntry {
            id: id.to_string(),
            last_opened: Some("2026-10-01T00:00:00Z".to_string()),
            path: path.to_string_lossy().into_owned(),
        };

        let ready = listed_project_info(&entry("ready", &ready));
        let broken = listed_project_info(&entry("broken", &broken));
        let missing = listed_project_info(&entry("missing", &temp.path().join("gone")));

        assert_eq!(
            (ready.name.as_str(), ready.status),
            ("Ready", SpaceStatus::Ready)
        );
        assert_eq!(
            (broken.name.as_str(), broken.status),
            ("broken", SpaceStatus::Broken)
        );
        assert_eq!(
            (missing.name.as_str(), missing.status),
            ("gone", SpaceStatus::Missing)
        );
        assert_eq!(missing.last_opened.as_deref(), Some("2026-10-01T00:00:00Z"));
    }

    #[test]
    fn entry_results_tell_the_window_whether_it_serves_the_project() {
        assert_eq!(
            serde_json::to_value(EnterProjectResult::OtherWindow).expect("encode"),
            serde_json::json!({ "kind": "otherWindow" })
        );
    }
}

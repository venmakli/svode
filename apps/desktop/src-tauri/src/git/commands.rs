use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::autocommit::{AutocommitService, SystemCommitKind};
use super::cli::{GitAvailability, GitCli};
use super::ops::{GitStatus, UnpushedCommit};
use crate::AppError;
use crate::index::{IndexKey, IndexState};
use crate::repo_path::{RootMode, normalize_repo_relative, repo_relative_from_base};
use crate::space::project;
use crate::space::types::{GitUserPolicy, SpaceGitType};
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

async fn invalidate_actor_space(app: &AppHandle, space: &Path) {
    if let Err(error) = crate::actors::invalidate_space(app, space).await {
        tracing::warn!(
            space = %space.display(),
            "failed to invalidate actor catalog after successful Git operation: {error}"
        );
    }
}

pub(crate) async fn invalidate_repository_access(
    app: &AppHandle,
    access_state: &super::access::RepositoryAccessState,
    cli: &GitCli,
    path: &Path,
) {
    match access_state.invalidate(cli, path).await {
        Ok(repository_id) => {
            super::access::emit_repository_access_changed(app, &repository_id);
        }
        Err(error) => {
            tracing::warn!(
                repository = %path.display(),
                "failed to invalidate repository access: {error}"
            );
        }
    }
}

fn publish_repository_access(app: &AppHandle, snapshot: &super::access::RepositoryAccessSnapshot) {
    super::access::emit_repository_access_changed(app, &snapshot.repository_id);
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitTrackedRemoteReconciliationStatus {
    NotRequired,
    Updated,
    PendingRepositoryAccess,
    Failed,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitTrackedRemoteReconciliation {
    status: GitTrackedRemoteReconciliationStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    repository_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    access_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    access_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSetRemoteResult {
    local_remote_updated: bool,
    tracked_reconciliation: GitTrackedRemoteReconciliation,
}

impl GitTrackedRemoteReconciliation {
    fn not_required() -> Self {
        Self {
            status: GitTrackedRemoteReconciliationStatus::NotRequired,
            repository_id: None,
            access_status: None,
            access_reason: None,
            message: None,
        }
    }

    fn updated() -> Self {
        Self {
            status: GitTrackedRemoteReconciliationStatus::Updated,
            ..Self::not_required()
        }
    }

    fn from_error(error: AppError) -> Self {
        match error {
            AppError::RepositoryAccessDenied {
                repository_id,
                status,
                reason,
            } => Self {
                status: GitTrackedRemoteReconciliationStatus::PendingRepositoryAccess,
                repository_id: Some(repository_id),
                access_status: Some(status),
                access_reason: Some(reason),
                message: None,
            },
            error => Self {
                status: GitTrackedRemoteReconciliationStatus::Failed,
                repository_id: None,
                access_status: None,
                access_reason: None,
                message: Some(error.to_string()),
            },
        }
    }
}

/// Helper: read the GitCli reference (clone is cheap — PathBuf only) outside the
/// per-space lock, so async work that needs `&AppHandle` doesn't borrow
/// `state`.
pub(crate) fn require_cli(state: &GitState) -> Result<GitCli, AppError> {
    state.cli.clone().ok_or(AppError::GitNotFound)
}

pub(crate) fn auto_commit_structural_enabled(space_path: &Path) -> bool {
    crate::space::config::effective_git_user_policy(space_path).auto_commit_structural
}

pub(crate) async fn init_repo_with_policy(cli: &GitCli, path: &Path) -> Result<(), AppError> {
    super::ops::init_with_optional_scaffold_commit(cli, path, auto_commit_structural_enabled(path))
        .await
}

async fn resolve_git_user_policy_target(
    state: &GitState,
    space: &Path,
    project_path: Option<&str>,
) -> Result<PathBuf, AppError> {
    let Some(proj) = project_path.filter(|proj| !proj.is_empty()) else {
        return Ok(space.to_path_buf());
    };

    let project = PathBuf::from(proj);
    if project == space {
        return Ok(project);
    }

    let cli = state.cli()?;
    let git_type = super::ops::detect_space_git_type(cli, &project, space).await?;
    Ok(match git_type {
        SpaceGitType::Inline => project,
        SpaceGitType::Independent | SpaceGitType::Submodule => space.to_path_buf(),
    })
}

fn drop_legacy_shared_git_policy(config_target: &Path) {
    if !config_target.join(".svode").join("config.json").exists() {
        return;
    }

    match crate::space::config::read_space_config(config_target) {
        Ok(config) if config.git.is_some() => {
            if let Err(e) = crate::space::config::write_space_config(config_target, &config) {
                tracing::warn!("failed to drop legacy shared git policy: {e}");
            }
        }
        Ok(_) => {}
        Err(e) => tracing::warn!("failed to read shared config for policy migration: {e}"),
    }
}

pub struct GitState {
    pub(crate) cli: Option<GitCli>,
    pub(crate) operations: Arc<super::operations::Operations>,
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
            operations: Arc::default(),
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
        let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| {
            path.parent().and_then(|parent| std::fs::canonicalize(parent).ok())
                .zip(path.file_name()).map(|(parent, name)| parent.join(name))
                .unwrap_or_else(|| path.to_path_buf())
        });
        let mut locks = self.locks.lock().await;
        locks
            .entry(canonical)
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
            git_lfs_version: None,
        }),
    }
}

#[tauri::command]
pub async fn git_init_space(
    app: AppHandle,
    state: State<'_, GitState>,
    space_path: String,
) -> Result<(), AppError> {
    let path = PathBuf::from(&space_path);
    if path.join(".git").symlink_metadata().is_ok() {
        super::access::require_repository_mutation(&app, &path).await?;
        super::local_repair::require_scope_repair(&app, &path, &path).await?;
    }
    let lock = state.get_lock(&path).await;
    let _guard = lock.lock().await;
    init_repo_with_policy(state.cli()?, &path).await?;
    drop(_guard);
    super::local_repair::repair_project(&app, &path).await;
    Ok(())
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
    let project_dir = PathBuf::from(&project_path);
    let target = PathBuf::from(&target_path);
    let target_folder = repo_relative_from_base(&project_dir, &target, RootMode::Reject)?;
    let space_folder = project::normalize_space_folder(&target_folder)?;
    if let Some(parent_dir) = target.parent() {
        std::fs::create_dir_all(parent_dir)?;
    }

    super::local_repair::require_scope_repair(&app, &project_dir, &project_dir).await?;

    if git_type == "submodule" {
        let cli = require_cli(&state)?;
        let child_lock = state.get_lock(&target).await;
        let child_guard = child_lock.lock().await;
        let lock = state.get_lock(&project_dir).await;
        let _guard = lock.lock().await;
        super::clone::submodule_add_with_progress(&cli, &app, &project_dir, &url, &space_folder)
            .await?;
        // Scaffold .svode/ and README.md if not present
        let svode_dir = target.join(".svode");
        let svode_existed_before = svode_dir.exists();
        let readme_existed_before = target.join("README.md").exists();
        if svode_existed_before {
            crate::space::project::ensure_scope_readme(&target, &space_folder)?;
        } else {
            crate::space::scaffold::scaffold_repository_space(&target, &space_folder, "", "")?;
        }
        drop(_guard);
        drop(child_guard);
        super::local_repair::repair_scope_best_effort(&app, &project_dir, &target).await;
        if !svode_existed_before || !readme_existed_before {
            let commit_result = if !svode_existed_before && readme_existed_before {
                autocommit.commit_scaffold(project_dir, target).await
            } else if !svode_existed_before {
                autocommit
                    .commit_scaffold_with_readme(project_dir, target)
                    .await
            } else {
                autocommit.commit_scope_readme(project_dir, target).await
            };
            if let Err(e) = commit_result {
                tracing::warn!("commit_scaffold failed after submodule clone: {e}");
            }
        }
    } else {
        // independent
        let cli = require_cli(&state)?;
        let lock = state.get_lock(&target).await;
        let _guard = lock.lock().await;
        super::clone::clone_with_progress(&cli, &app, &url, &target).await?;
        super::ops::add_independent_gitignore(&project_dir, &space_folder)?;
        drop(_guard);
        super::local_repair::repair_scope_best_effort(&app, &project_dir, &target).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn git_get_remote(
    state: State<'_, GitState>,
    space_path: String,
) -> Result<Option<String>, AppError> {
    let path = PathBuf::from(&space_path);
    let repository = super::access::resolve_repository(state.cli()?, &path).await?;
    let lock = state.get_lock(&repository).await;
    let _guard = lock.lock().await;
    super::ops::get_remote(state.cli()?, &path).await
}

#[tauri::command]
pub async fn git_set_remote(
    app: AppHandle,
    state: State<'_, GitState>,
    access_state: State<'_, super::access::RepositoryAccessState>,
    autocommit: State<'_, Arc<AutocommitService>>,
    space_path: String,
    url: String,
    project_path: Option<String>,
    space_id: Option<String>,
) -> Result<GitSetRemoteResult, AppError> {
    let path = PathBuf::from(&space_path);
    let reconcile_target = project_path
        .as_deref()
        .filter(|path| !path.is_empty())
        .zip(space_id.as_deref())
        .map(|(project, space_id)| (PathBuf::from(project), space_id.to_string()));

    let cli = require_cli(&state)?;
    let repository = super::access::resolve_repository(state.cli()?, &path).await?;
    let lock = state.get_lock(&repository).await;
    let _guard = lock.lock().await;
    super::ops::set_remote(&cli, &path, &url).await?;
    drop(_guard);
    invalidate_repository_access(&app, &access_state, &cli, &path).await;

    let tracked_reconciliation = if let Some((project, space_id)) = &reconcile_target {
        match super::access::require_repository_mutation_paths(
            &app,
            vec![project.join(".svode").join("config.json")],
        )
        .await
        {
            Ok(_) => {
                match crate::space::project::reconcile_space_url(project, space_id, Some(&url)) {
                    Ok(()) => GitTrackedRemoteReconciliation::updated(),
                    Err(error) => GitTrackedRemoteReconciliation::from_error(error),
                }
            }
            Err(error) => GitTrackedRemoteReconciliation::from_error(error),
        }
    } else {
        GitTrackedRemoteReconciliation::not_required()
    };

    // Commit the config change (reconcile_space_url may have updated parent
    // .svode/config.json). Routes per space git type.
    if matches!(
        tracked_reconciliation.status,
        GitTrackedRemoteReconciliationStatus::Updated
    ) && let Some(proj_path) = project_path
    {
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

    Ok(GitSetRemoteResult {
        local_remote_updated: true,
        tracked_reconciliation,
    })
}

#[tauri::command]
pub async fn git_push(
    app: AppHandle,
    space_path: String,
) -> Result<GitStatus, super::operations::SharedError> {
    super::publication_flow::push(&app, Path::new(&space_path), false).await
}

#[tauri::command]
pub async fn git_status(
    state: State<'_, GitState>,
    space_path: String,
) -> Result<GitStatus, AppError> {
    let path = PathBuf::from(&space_path);
    let repository = super::access::resolve_repository(state.cli()?, &path).await?;
    let lock = state.get_lock(&repository).await;
    let _guard = lock.lock().await;
    super::ops::status(state.cli()?, &path).await
}

#[tauri::command]
pub async fn git_fetch_status(
    app: AppHandle,
    state: State<'_, GitState>,
    access_state: State<'_, super::access::RepositoryAccessState>,
    space_path: String,
) -> Result<GitStatus, AppError> {
    let path = PathBuf::from(&space_path);
    let repository = super::access::resolve_repository(state.cli()?, &path).await?;
    let lock = state.get_lock(&repository).await;
    let _guard = lock.lock().await;
    let cli = state.cli()?;
    if let Err(error) = super::ops::fetch_remote(cli, &path).await {
        invalidate_repository_access(&app, &access_state, cli, &path).await;
        return Err(error);
    }
    invalidate_actor_space(&app, &path).await;
    super::ops::status_with_remote_counts(cli, &path).await
}

#[tauri::command]
pub async fn git_commit_file(
    app: AppHandle,
    state: State<'_, GitState>,
    autocommit: State<'_, Arc<AutocommitService>>,
    project_path: Option<String>,
    space_path: String,
    file_path: String,
) -> Result<super::publication_flow::SaveReport, AppError> {
    let path = PathBuf::from(&space_path);
    let project = project_path
        .filter(|path| !path.is_empty())
        .map(PathBuf::from);
    if file_path == ".svode/AGENTS.md"
        && let Some(project) = &project
    {
        super::access::require_repository_mutation(&app, &path).await?;
        autocommit
            .commit_system_manual_now(
                project.clone(),
                path.clone(),
                SystemCommitKind::AgentInstructions,
            )
            .await?;
        return Ok(super::publication_flow::SaveReport {
            status: super::ops::status(state.cli()?, &path).await?,
            parent: None,
        });
    }
    let result = super::manual_save::save(
        &app,
        &state,
        &autocommit,
        project.as_deref(),
        &path,
        Some(normalize_commit_paths(vec![file_path])?),
    )
    .await;
    invalidate_actor_space(&app, &path).await;
    result
}

#[tauri::command]
pub async fn git_commit_all(
    app: AppHandle,
    state: State<'_, GitState>,
    autocommit: State<'_, Arc<AutocommitService>>,
    project_path: Option<String>,
    space_path: String,
) -> Result<super::publication_flow::SaveReport, AppError> {
    let path = PathBuf::from(&space_path);
    let project = project_path
        .filter(|path| !path.is_empty())
        .map(PathBuf::from);
    let result =
        super::manual_save::save(&app, &state, &autocommit, project.as_deref(), &path, None).await;
    invalidate_actor_space(&app, &path).await;
    result
}

#[tauri::command]
pub async fn git_commit_paths(
    app: AppHandle,
    state: State<'_, GitState>,
    autocommit: State<'_, Arc<AutocommitService>>,
    project_path: Option<String>,
    space_path: String,
    file_paths: Vec<String>,
) -> Result<super::publication_flow::SaveReport, AppError> {
    let path = PathBuf::from(&space_path);
    let project = project_path
        .filter(|path| !path.is_empty())
        .map(PathBuf::from);
    let result = super::manual_save::save(
        &app,
        &state,
        &autocommit,
        project.as_deref(),
        &path,
        Some(normalize_commit_paths(file_paths)?),
    )
    .await;
    invalidate_actor_space(&app, &path).await;
    result
}

#[tauri::command]
pub async fn git_sync(
    app: AppHandle,
    space_path: String,
    background: Option<bool>,
) -> Result<super::publication_flow::SyncReport, super::operations::SharedError> {
    super::publication_flow::sync(&app, Path::new(&space_path), background.unwrap_or(false), false).await
}

pub(crate) async fn refresh_synced_repository(app: &AppHandle, cli: &GitCli, path: &Path) {
    let access_state = app.state::<super::access::RepositoryAccessState>();
    let index_state = app.state::<IndexState>();
    let evidence = async {
        let store_path = super::access::access_store_path(app)?;
        access_state
            .record_writable_evidence(cli, path, &store_path)
            .await
    }
    .await;
    match evidence {
        Ok(snapshot) => publish_repository_access(&app, &snapshot),
        Err(error) => {
            tracing::warn!("failed to record repository write evidence after sync: {error}");
        }
    }
    let key = index_state
        .key_for_space_dir(&path)
        .await
        .unwrap_or_else(|| IndexKey::Root(path.to_path_buf()));
    let changed = super::ops::diff_after_pull(cli, &path).await.ok();
    if let Some(changed) = &changed {
        if !changed.is_empty() {
            if let Err(e) =
                crate::index::update::reindex_after_pull(&index_state, &key, changed.clone()).await
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
    invalidate_actor_space(&app, &path).await;
    if let Some(changed) = &changed {
        emit_sync_domain_invalidations(&app, &index_state, &key, &path, changed).await;
    }
    emit_space_synced(&app, &key);
    // Explicit-trigger LFS auto-pull: if the merge brought in pointer
    // files under `.assets/` and credentials are present, fetch the
    // bytes in the background (Stage 3.5 Phase 8 §8.5 / Q8c).
    if let Some(changed) = changed {
        crate::storage::lfs::maybe_auto_pull_after_sync(&app, &key, &path, &changed);
    }
}

#[tauri::command]
pub async fn git_save_http_credentials(
    state: State<'_, GitState>,
    remote_url: String,
    username: String,
    password: String,
) -> Result<(), AppError> {
    let cli = state.cli()?;
    super::auth::approve_http_credentials(cli, &remote_url, &username, &password).await
}

fn normalize_commit_paths(file_paths: Vec<String>) -> Result<Vec<String>, AppError> {
    let mut paths = Vec::new();
    for file_path in file_paths {
        let normalized = normalize_repo_relative(&file_path, RootMode::Reject)?;
        if !paths.iter().any(|path| path == &normalized) {
            paths.push(normalized);
        }
    }
    Ok(paths)
}

#[tauri::command]
pub async fn git_conflict_files(
    state: State<'_, GitState>,
    space_path: String,
) -> Result<Vec<String>, AppError> {
    let path = PathBuf::from(&space_path);
    let repository = super::access::resolve_repository(state.cli()?, &path).await?;
    let lock = state.get_lock(&repository).await;
    let _guard = lock.lock().await;
    super::sync::conflict_files(state.cli()?, &path).await
}

#[tauri::command]
pub async fn git_resolve_continue(
    app: AppHandle,
    space_path: String,
) -> Result<super::publication_flow::SyncReport, super::operations::SharedError> {
    super::publication_flow::sync(&app, Path::new(&space_path), false, true).await
}

async fn emit_sync_domain_invalidations(
    app: &AppHandle,
    index_state: &IndexState,
    key: &IndexKey,
    synced_space: &Path,
    changed: &[String],
) {
    let repository = match require_cli(&app.state::<GitState>()) {
        Ok(cli) => super::ops::resolve_target_repo(&cli, key.project(), synced_space)
            .await
            .map(|(_, repository)| repository)
            .unwrap_or_else(|_| synced_space.to_path_buf()),
        Err(_) => synced_space.to_path_buf(),
    };
    for relative in changed {
        let normalized = relative.replace('\\', "/");
        for suffix in ["/.svode/agent-actors.json", "/.svode/local.json"] {
            if let Some(owner) = normalized.strip_suffix(suffix) {
                crate::agent_actors::commands::emit_catalog_invalidation(
                    app,
                    &repository.join(owner),
                );
            }
        }
        if matches!(
            normalized.as_str(),
            ".svode/agent-actors.json" | ".svode/local.json"
        ) {
            crate::agent_actors::commands::emit_catalog_invalidation(app, &repository);
        }
    }

    let project = key.project().to_path_buf();
    for owner_key in index_state.keys_for_project(&project).await {
        let Ok(space_path) = index_state.dir_for_key(&owner_key).await else {
            continue;
        };
        let Ok(relative_space) = space_path.strip_prefix(&repository) else {
            continue;
        };
        let prefix = relative_space.to_string_lossy().replace('\\', "/");
        for relative in changed {
            let relative = relative.replace('\\', "/");
            let within_space = if prefix.is_empty() {
                relative.as_str()
            } else if let Some(within) = relative.strip_prefix(&format!("{prefix}/")) {
                within
            } else {
                continue;
            };
            let parts = within_space.split('/').collect::<Vec<_>>();
            let Some(routines_index) = parts.iter().position(|part| *part == ".routines") else {
                continue;
            };
            if parts.len() != routines_index + 2
                || Path::new(parts.last().unwrap_or(&""))
                    .extension()
                    .and_then(|value| value.to_str())
                    != Some("md")
            {
                continue;
            }
            let owner_path = if routines_index == 0 {
                ".".to_string()
            } else {
                parts[..routines_index].join("/")
            };
            let owner_kind = if owner_path != "." {
                crate::routines::RoutineOwnerKind::Collection
            } else if matches!(owner_key, IndexKey::Root(_)) {
                crate::routines::RoutineOwnerKind::Project
            } else {
                crate::routines::RoutineOwnerKind::Space
            };
            crate::routines::emit_invalidation(
                app,
                crate::routines::RoutineInvalidationPayload {
                    project_path: key.project().to_string_lossy().into_owned(),
                    space_path: space_path.to_string_lossy().into_owned(),
                    owner_kind,
                    owner_path,
                },
            );
        }
    }
}

#[tauri::command]
pub async fn git_merge_abort(
    state: State<'_, GitState>,
    space_path: String,
) -> Result<(), AppError> {
    let path = PathBuf::from(&space_path);
    let repository = super::access::resolve_repository(state.cli()?, &path).await?;
    let lock = state.get_lock(&repository).await;
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
    let repository = super::access::resolve_repository(state.cli()?, &path).await?;
    let lock = state.get_lock(&repository).await;
    let _guard = lock.lock().await;
    super::ops::unpushed_commits(state.cli()?, &path).await
}

#[tauri::command]
pub async fn git_publish(
    app: AppHandle,
    space_path: String,
) -> Result<GitStatus, super::operations::SharedError> {
    super::publication_flow::push(&app, Path::new(&space_path), true).await
}

#[tauri::command]
pub async fn git_enable_auto_sync(
    state: State<'_, GitState>,
    space_path: String,
    project_path: Option<String>,
) -> Result<(), AppError> {
    git_set_auto_sync(state, space_path, project_path, true).await
}

#[tauri::command]
pub async fn git_set_auto_sync(
    state: State<'_, GitState>,
    space_path: String,
    project_path: Option<String>,
    enabled: bool,
) -> Result<(), AppError> {
    let space = PathBuf::from(&space_path);
    let config_target =
        resolve_git_user_policy_target(&state, &space, project_path.as_deref()).await?;
    let mut policy = crate::space::config::read_git_user_policy(&config_target)?;
    policy.auto_sync = enabled;
    crate::space::config::write_git_user_policy(&config_target, &policy)?;
    drop_legacy_shared_git_policy(&config_target);
    Ok(())
}

#[tauri::command]
pub async fn git_get_user_policy(
    state: State<'_, GitState>,
    space_path: String,
    project_path: Option<String>,
) -> Result<GitUserPolicy, AppError> {
    let space = PathBuf::from(&space_path);
    let config_target =
        resolve_git_user_policy_target(&state, &space, project_path.as_deref()).await?;
    crate::space::config::read_git_user_policy(&config_target)
}

#[tauri::command]
pub async fn git_set_user_policy(
    state: State<'_, GitState>,
    space_path: String,
    project_path: Option<String>,
    policy: GitUserPolicy,
) -> Result<(), AppError> {
    let space = PathBuf::from(&space_path);
    let config_target =
        resolve_git_user_policy_target(&state, &space, project_path.as_deref()).await?;
    crate::space::config::write_git_user_policy(&config_target, &policy)?;
    drop_legacy_shared_git_policy(&config_target);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracked_remote_reconciliation_preserves_typed_parent_denial() {
        let result = GitTrackedRemoteReconciliation::from_error(AppError::RepositoryAccessDenied {
            repository_id: "repo-parent".to_string(),
            status: "unknown".to_string(),
            reason: "mutation_plan_changed".to_string(),
        });
        let value = serde_json::to_value(result).unwrap();

        assert_eq!(value["status"], "pending_repository_access");
        assert_eq!(value["repositoryId"], "repo-parent");
        assert_eq!(value["accessStatus"], "unknown");
        assert_eq!(value["accessReason"], "mutation_plan_changed");
        assert!(value.get("message").is_none());
    }
}

#[tauri::command]
pub async fn git_publication_status(
    app: AppHandle,
    space_path: String,
) -> Result<Option<super::publication_flow::PublicationStatus>, AppError> {
    super::publication_flow::inspect(&app, Path::new(&space_path)).await
}

#[tauri::command]
pub async fn git_retry_parent(
    app: AppHandle,
    space_path: String,
    expected_head: String,
    expected_parent: String,
    expected_target: String,
) -> Result<super::publication_flow::PublicationStatus, super::operations::SharedError> {
    super::publication_flow::retry_parent(
        &app,
        Path::new(&space_path),
        &expected_head,
        Path::new(&expected_parent),
        &expected_target,
    )
    .await
}

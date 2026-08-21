use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, State};

use super::{
    FanoutPreviewEntry, GitIdentity, GlobalIdentityMutationPlan, GlobalIdentityMutationResult,
    GlobalIdentityResult, IdentityState, RepoIdentityResult, apply_identity_to_project,
    get_effective_identity, get_global_identity_result, plan_global_identity_mutation,
    set_global_identity, set_local_identity, validate_email, validate_name,
};
use crate::AppError;
use crate::git::commands::{GitState, require_cli};
use crate::git::ops;
use crate::space::config;
use crate::space::types::SpaceGitType;

const GLOBAL_IDENTITY_CHANGED_EVENT: &str = "git-identity:global-changed";

#[tauri::command]
pub async fn get_git_identity(
    state: State<'_, GitState>,
) -> Result<GlobalIdentityResult, AppError> {
    let cli = require_cli(&state)?;
    get_global_identity_result(&cli).await
}

#[tauri::command]
pub async fn set_git_identity(
    app: AppHandle,
    git_state: State<'_, GitState>,
    identity_state: State<'_, IdentityState>,
    name: String,
    email: String,
    expected_fingerprint: String,
) -> Result<GlobalIdentityMutationResult, AppError> {
    let cli = require_cli(&git_state)?;
    let _guard = identity_state.lock().await;
    let current = get_global_identity_result(&cli).await?;
    let target = GitIdentity {
        name: validate_name(&name)?,
        email: validate_email(&email)?,
    };

    match plan_global_identity_mutation(&current, &expected_fingerprint, &target) {
        GlobalIdentityMutationPlan::Conflict => Ok(GlobalIdentityMutationResult {
            status: "conflict",
            canonical: current,
        }),
        GlobalIdentityMutationPlan::Unchanged => Ok(GlobalIdentityMutationResult {
            status: "unchanged",
            canonical: current,
        }),
        GlobalIdentityMutationPlan::Update => {
            set_global_identity(&cli, &target.name, &target.email).await?;
            let canonical = get_global_identity_result(&cli).await?;
            if canonical.global.as_ref() != Some(&target) {
                return Err(AppError::General(
                    "global Git identity did not match the requested value after save".to_string(),
                ));
            }
            let _ = app.emit(GLOBAL_IDENTITY_CHANGED_EVENT, ());
            Ok(GlobalIdentityMutationResult {
                status: "updated",
                canonical,
            })
        }
    }
}

#[tauri::command]
pub async fn get_repo_identity(
    state: State<'_, GitState>,
    repo_path: String,
) -> Result<RepoIdentityResult, AppError> {
    let cli = require_cli(&state)?;
    let path = PathBuf::from(&repo_path);
    get_effective_identity(&cli, &path).await
}

#[tauri::command]
pub async fn set_repo_identity(
    state: State<'_, GitState>,
    repo_path: String,
    name: Option<String>,
    email: Option<String>,
) -> Result<(), AppError> {
    let cli = require_cli(&state)?;
    let path = PathBuf::from(&repo_path);
    set_local_identity(&cli, &path, name.as_deref(), email.as_deref()).await
}

#[tauri::command]
pub async fn get_project_fanout_preview(
    state: State<'_, GitState>,
    root_path: String,
) -> Result<Vec<FanoutPreviewEntry>, AppError> {
    let cli = require_cli(&state)?;
    let root = PathBuf::from(&root_path);
    let cfg = config::read_space_config(&root)?;

    let mut out: Vec<FanoutPreviewEntry> = Vec::new();
    if let Some(spaces) = cfg.spaces.as_ref() {
        for sp in spaces {
            let space_dir = root.join(&sp.path);
            // Skip non-existent (ghost / missing) spaces — nothing to write to.
            if !space_dir.exists() {
                continue;
            }
            // Only non-inline spaces have their own repo to receive identity.
            let git_type = match ops::detect_space_git_type(&cli, &root, &space_dir).await {
                Ok(gt) => gt,
                Err(_) => continue,
            };
            if matches!(git_type, SpaceGitType::Inline) {
                continue;
            }

            let space_name = config::read_space_config(&space_dir)
                .map(|c| c.name)
                .unwrap_or_else(|_| {
                    space_dir
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| sp.path.clone())
                });

            let identity = match get_effective_identity(&cli, &space_dir).await {
                Ok(identity) => identity,
                Err(_) => continue,
            };
            let will_replace = identity.local.is_some() || identity.source == "partial";

            out.push(FanoutPreviewEntry {
                space_path: space_dir.to_string_lossy().to_string(),
                space_name,
                current_local: identity.local,
                current_effective: identity.effective,
                source: identity.source,
                field_sources: identity.field_sources,
                will_replace,
            });
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn set_project_identity(
    state: State<'_, GitState>,
    root_path: String,
    name: Option<String>,
    email: Option<String>,
    target_spaces: Vec<String>,
) -> Result<(), AppError> {
    let cli = require_cli(&state)?;
    let root: &Path = Path::new(&root_path);
    apply_identity_to_project(
        &cli,
        root,
        name.as_deref(),
        email.as_deref(),
        &target_spaces,
    )
    .await
}

use std::path::Path;
use std::sync::Arc;

use tauri::{AppHandle, State};

use super::mutations::{
    ActorMailmapSaveResult, ActorMailmapSaveReview, ActorMailmapSaveReviewResult,
    ActorMutationAction, ActorMutationApplyResult, ActorMutationPreviewResult, ActorMutationReview,
};
use super::{ActorActivity, ActorCatalog, ActorCatalogState};
use crate::AppError;
use crate::git::GitState;
use crate::git::access::RepositoryAccessState;
use crate::git::autocommit::AutocommitService;
use crate::git::commands::require_cli;

#[tauri::command]
pub async fn actors_get_catalog(
    space_path: String,
    git_state: State<'_, GitState>,
    actor_catalog: State<'_, ActorCatalogState>,
) -> Result<ActorCatalog, AppError> {
    let cli = require_cli(&git_state)?;
    Ok(actor_catalog
        .snapshot(&cli, Path::new(&space_path))
        .await?
        .catalog())
}

#[tauri::command]
pub async fn actors_refresh_catalog(
    space_path: String,
    git_state: State<'_, GitState>,
    actor_catalog: State<'_, ActorCatalogState>,
) -> Result<ActorCatalog, AppError> {
    let cli = require_cli(&git_state)?;
    Ok(actor_catalog
        .refresh(&cli, Path::new(&space_path))
        .await?
        .catalog())
}

#[tauri::command]
pub async fn actors_get_activity(
    space_path: String,
    canonical_email: String,
    git_state: State<'_, GitState>,
    actor_catalog: State<'_, ActorCatalogState>,
) -> Result<ActorActivity, AppError> {
    let cli = require_cli(&git_state)?;
    Ok(actor_catalog
        .activity(&cli, Path::new(&space_path), &canonical_email)
        .await?
        .as_ref()
        .clone())
}

#[tauri::command]
pub async fn actors_preview_mutation(
    app: AppHandle,
    space_path: String,
    action: ActorMutationAction,
    git_state: State<'_, GitState>,
    access_state: State<'_, RepositoryAccessState>,
    actor_catalog: State<'_, ActorCatalogState>,
) -> Result<ActorMutationPreviewResult, AppError> {
    let cli = require_cli(&git_state)?;
    super::mutations::preview(
        &cli,
        Path::new(&space_path),
        action,
        &app,
        &access_state,
        &actor_catalog,
    )
    .await
}

#[tauri::command]
pub async fn actors_apply_mutation(
    app: AppHandle,
    project_path: String,
    space_path: String,
    review: ActorMutationReview,
    git_state: State<'_, GitState>,
    autocommit: State<'_, Arc<AutocommitService>>,
    access_state: State<'_, RepositoryAccessState>,
    actor_catalog: State<'_, ActorCatalogState>,
) -> Result<ActorMutationApplyResult, AppError> {
    let cli = require_cli(&git_state)?;
    super::mutations::apply(
        &cli,
        Path::new(&project_path),
        Path::new(&space_path),
        review,
        &app,
        &git_state,
        &autocommit,
        &access_state,
        &actor_catalog,
    )
    .await
}

#[tauri::command]
pub async fn actors_get_mailmap_save_review(
    project_path: String,
    space_path: String,
    git_state: State<'_, GitState>,
    actor_catalog: State<'_, ActorCatalogState>,
) -> Result<ActorMailmapSaveReviewResult, AppError> {
    let cli = require_cli(&git_state)?;
    super::mutations::get_mailmap_save_review(
        &cli,
        Path::new(&project_path),
        Path::new(&space_path),
        &git_state,
        &actor_catalog,
    )
    .await
}

#[tauri::command]
pub async fn actors_save_mailmap(
    project_path: String,
    space_path: String,
    review: ActorMailmapSaveReview,
    git_state: State<'_, GitState>,
    autocommit: State<'_, Arc<AutocommitService>>,
    actor_catalog: State<'_, ActorCatalogState>,
) -> Result<ActorMailmapSaveResult, AppError> {
    let cli = require_cli(&git_state)?;
    super::mutations::save_mailmap(
        &cli,
        Path::new(&project_path),
        Path::new(&space_path),
        review,
        &git_state,
        &autocommit,
        &actor_catalog,
    )
    .await
}

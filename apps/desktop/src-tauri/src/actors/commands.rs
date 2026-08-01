use std::path::Path;

use tauri::State;

use super::{ActorActivity, ActorCatalog, ActorCatalogState};
use crate::AppError;
use crate::git::GitState;
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

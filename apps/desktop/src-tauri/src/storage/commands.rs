use std::path::Path;

use serde::Serialize;
use sqlx::Row;
use tauri::State;

use super::assets::{self, Asset, UploadResult};
use super::strategy::{self, ApplyStrategyResult};
use crate::error::AppError;
use crate::git::GitState;
use crate::index::IndexState;
use crate::workspace::config::{read_workspace_config, write_workspace_config};
use crate::workspace::types::{AssetsS3Config, AssetsStrategy, AssetsWorkspaceConfig};

/// File data returned to the frontend after reading a user-selected path.
/// Used to construct a `File` object on the JS side so Plate's media
/// placeholder flow can consume it like a browser-picked file.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFileData {
    pub name: String,
    /// Raw file bytes. Serialized as a JSON number array — for realistic
    /// asset sizes (images ~MB) this is fine; very large videos hit the
    /// same 3.5x overhead as `upload_asset`.
    pub bytes: Vec<u8>,
    pub mime_type: String,
}

/// Read a local file selected via the native Tauri dialog plugin and hand
/// it to the frontend so Plate can wrap it in a `File` and flow through the
/// normal upload placeholder pipeline. This is the macOS workaround for
/// WKWebView silently ignoring the `<input accept>` attribute — see
/// `src/lib/native-file-picker.ts`.
#[tauri::command]
pub async fn read_file_for_upload(path: String) -> Result<LocalFileData, AppError> {
    let p = Path::new(&path);

    let name = p
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| AppError::PathNotAccessible(path.clone()))?
        .to_string();

    let bytes = tokio::fs::read(&p).await?;

    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    let (mime_type, _) = assets::mime_for(&ext);

    Ok(LocalFileData {
        name,
        bytes,
        mime_type: mime_type.to_string(),
    })
}

#[tauri::command]
pub async fn upload_asset(
    workspace_path: String,
    file_name: String,
    bytes: Vec<u8>,
    document_id: Option<String>,
    git_state: State<'_, GitState>,
    index_state: State<'_, IndexState>,
) -> Result<UploadResult, AppError> {
    let workspace_dir = Path::new(&workspace_path);

    let config = read_workspace_config(workspace_dir)?;
    let pool = index_state.get_or_create(&workspace_path).await?;

    let result = assets::upload(
        &pool,
        workspace_dir,
        &bytes,
        &file_name,
        document_id.as_deref(),
    )
    .await?;

    strategy::stage_new_asset(
        &git_state,
        workspace_dir,
        config.assets.as_ref(),
        &result.asset_path,
    )
    .await?;

    Ok(result)
}

#[tauri::command]
pub async fn list_assets(
    workspace_path: String,
    index_state: State<'_, IndexState>,
) -> Result<Vec<Asset>, AppError> {
    let pool = index_state.get_or_create(&workspace_path).await?;
    assets::list(&pool).await
}

#[tauri::command]
pub async fn get_assets_config(
    workspace_path: String,
) -> Result<AssetsWorkspaceConfig, AppError> {
    let workspace_dir = Path::new(&workspace_path);
    let config = read_workspace_config(workspace_dir)?;
    Ok(config.assets.unwrap_or_default())
}

#[tauri::command]
pub async fn set_assets_strategy(
    workspace_path: String,
    strategy: AssetsStrategy,
    s3_config: Option<AssetsS3Config>,
    git_state: State<'_, GitState>,
) -> Result<ApplyStrategyResult, AppError> {
    let workspace_dir = Path::new(&workspace_path);

    let mut config = read_workspace_config(workspace_dir)?;

    let result = super::strategy::apply_strategy(&git_state, workspace_dir, strategy).await?;

    config.assets = Some(AssetsWorkspaceConfig {
        strategy,
        s3: s3_config,
    });
    write_workspace_config(workspace_dir, &config)?;
    Ok(result)
}

/// Count the assets registered in this workspace's SQLite index. Used by the
/// storage confirmation dialog to warn users that existing assets will NOT be
/// automatically migrated on strategy switch.
#[tauri::command]
pub async fn count_assets(
    workspace_path: String,
    index_state: State<'_, IndexState>,
) -> Result<i64, AppError> {
    let pool = index_state.get_or_create(&workspace_path).await?;
    let row = sqlx::query("SELECT COUNT(*) as n FROM assets")
        .fetch_one(&pool)
        .await?;
    Ok(row.try_get::<i64, _>("n")?)
}

#[tauri::command]
pub async fn check_s3_connection(
    endpoint: String,
    bucket: String,
    region: String,
    access_key: String,
    secret_key: String,
) -> Result<bool, AppError> {
    strategy::check_s3_connection(endpoint, bucket, region, access_key, secret_key).await
}

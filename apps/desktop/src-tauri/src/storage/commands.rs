use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sqlx::Row;
use tauri::{AppHandle, State};

use super::assets::{self, Asset, UploadResult};
use super::s3::{self, AgentSecrets};
use super::strategy::{self, ApplyStrategyResult};
use crate::error::AppError;
use crate::git::GitState;
use crate::index::{IndexKey, IndexState};
use crate::space::config::{read_space_config, write_space_config};
use crate::space::types::{AssetsS3Config, AssetsSpaceConfig, AssetsStrategy};

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
    space_path: String,
    file_name: String,
    bytes: Vec<u8>,
    document_id: Option<String>,
    git_state: State<'_, GitState>,
    index_state: State<'_, IndexState>,
) -> Result<UploadResult, AppError> {
    let space_dir = Path::new(&space_path);

    let config = read_space_config(space_dir)?;
    let key = index_state
        .key_for_space_dir(space_dir)
        .await
        .unwrap_or_else(|| IndexKey::Root(PathBuf::from(&space_path)));
    let pool = index_state.get_or_create(&key).await?;

    let result = assets::upload(
        &pool,
        space_dir,
        &bytes,
        &file_name,
        document_id.as_deref(),
    )
    .await?;

    strategy::stage_new_asset(
        &git_state,
        space_dir,
        config.assets.as_ref(),
        &result.asset_path,
    )
    .await?;

    Ok(result)
}

#[tauri::command]
pub async fn list_assets(
    space_path: String,
    index_state: State<'_, IndexState>,
) -> Result<Vec<Asset>, AppError> {
    let key = index_state
        .key_for_space_dir(Path::new(&space_path))
        .await
        .unwrap_or_else(|| IndexKey::Root(PathBuf::from(&space_path)));
    let pool = index_state.get_or_create(&key).await?;
    assets::list(&pool).await
}

#[tauri::command]
pub async fn get_assets_config(
    space_path: String,
) -> Result<AssetsSpaceConfig, AppError> {
    let space_dir = Path::new(&space_path);
    let config = read_space_config(space_dir)?;
    Ok(config.assets.unwrap_or_default())
}

/// Optional S3 credentials supplied alongside `set_assets_strategy` when the
/// user picks LfsS3 for the first time. We persist these to the OS keychain
/// (never to disk) and only when both keys are present — passing `None` lets
/// the existing keychain entry stand untouched.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3CredentialInput {
    pub access_key: String,
    pub secret_key: String,
}

#[tauri::command]
pub async fn set_assets_strategy(
    app: AppHandle,
    space_path: String,
    strategy: AssetsStrategy,
    s3_config: Option<AssetsS3Config>,
    s3_credentials: Option<S3CredentialInput>,
    git_state: State<'_, GitState>,
) -> Result<ApplyStrategyResult, AppError> {
    let space_dir = Path::new(&space_path);

    let mut config = read_space_config(space_dir)?;

    // For LfsS3 we need to (1) stash credentials in keychain and (2) resolve
    // the bundled lfs-dal binary. Both happen *before* apply_strategy so any
    // failure rolls back cleanly without leaving half-written git config.
    let lfs_dal_path = if matches!(strategy, AssetsStrategy::LfsS3) {
        let cfg = s3_config
            .as_ref()
            .ok_or_else(|| AppError::Storage("lfs-s3 requires endpoint/bucket/region".into()))?;
        if let Some(creds) = s3_credentials {
            let account = s3::keychain_account(cfg);
            s3::save_credentials(
                account,
                AgentSecrets {
                    access_key: creds.access_key,
                    secret_key: creds.secret_key,
                },
            )
            .await?;
        }
        Some(s3::resolve_agent_binary(&app)?)
    } else {
        None
    };

    let result = super::strategy::apply_strategy(
        &git_state,
        space_dir,
        strategy,
        s3_config.as_ref(),
        lfs_dal_path.as_deref(),
    )
    .await?;

    // Tearing down LfsS3 — drop the keychain entry that the previous config
    // referenced, if any. We read the previous config (not the new one) to
    // know which account to delete.
    if !matches!(strategy, AssetsStrategy::LfsS3) {
        if let Some(prev) = config.assets.as_ref().and_then(|a| a.s3.as_ref()) {
            let account = s3::keychain_account(prev);
            if let Err(e) = s3::clear_credentials(account).await {
                tracing::warn!("clear_credentials failed: {e}");
            }
        }
    }

    config.assets = Some(AssetsSpaceConfig {
        strategy,
        s3: s3_config,
    });
    write_space_config(space_dir, &config)?;
    Ok(result)
}

/// Count the assets registered in this space's SQLite index. Used by the
/// storage confirmation dialog to warn users that existing assets will NOT be
/// automatically migrated on strategy switch.
#[tauri::command]
pub async fn count_assets(
    space_path: String,
    index_state: State<'_, IndexState>,
) -> Result<i64, AppError> {
    let key = index_state
        .key_for_space_dir(Path::new(&space_path))
        .await
        .unwrap_or_else(|| IndexKey::Root(PathBuf::from(&space_path)));
    let pool = index_state.get_or_create(&key).await?;
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
    s3::check_connection(endpoint, bucket, region, access_key, secret_key).await
}

/// Tell the frontend whether the keychain currently holds credentials for
/// the space's saved S3 config — used to render a "credentials saved"
/// badge instead of leaving the secret fields looking blank.
#[tauri::command]
pub async fn has_s3_credentials(space_path: String) -> Result<bool, AppError> {
    let space_dir = Path::new(&space_path);
    let cfg = read_space_config(space_dir)?;
    let Some(s3_cfg) = cfg.assets.and_then(|a| a.s3) else {
        return Ok(false);
    };
    let account = s3::keychain_account(&s3_cfg);
    let present = tokio::task::spawn_blocking(move || {
        let Ok(entry) = keyring::Entry::new(s3::KEYCHAIN_SERVICE, &account) else {
            return false;
        };
        entry.get_password().is_ok()
    })
    .await
    .unwrap_or(false);
    Ok(present)
}

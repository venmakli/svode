use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sqlx::Row;
use tauri::{AppHandle, Manager, State};

use super::assets::{self, Asset};
use super::s3::{self, AgentSecrets};
use super::strategy::ApplyStrategyResult;
use crate::error::AppError;
use crate::git::GitState;
use crate::git::autocommit::{AutocommitService, StructuralOp, SystemCommitKind};
use crate::git::commands::require_cli;
use crate::index::IndexState;
use crate::space::config::{read_space_config, write_space_config};
use crate::space::types::{AssetsS3Config, AssetsSpaceConfig, AssetsStrategy, SpaceGitType};

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
    let mime_type = assets::mime_for(&ext);

    Ok(LocalFileData {
        name,
        bytes,
        mime_type: mime_type.to_string(),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadResponse {
    pub space_id: Option<String>,
    pub rel_path: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub mime: String,
}

#[tauri::command]
pub async fn upload_asset(
    _app: AppHandle,
    project_path: String,
    document_abs_path: String,
    file_name: String,
    bytes: Vec<u8>,
    document_id: Option<String>,
    _git_state: State<'_, GitState>,
    autocommit: State<'_, Arc<AutocommitService>>,
    index_state: State<'_, IndexState>,
) -> Result<UploadResponse, AppError> {
    let project = PathBuf::from(&project_path);
    let doc_abs = PathBuf::from(&document_abs_path);

    // Resolve the owning pool (root or child space) for the document path.
    // We only use the IndexKey from this — the asset path is computed below.
    let (key, _rel_doc) = index_state.resolve(&project, &doc_abs).await?;
    let target_dir = index_state.dir_for_key(&key).await?;
    let pool = index_state.get_or_create(&key).await?;

    let result = assets::upload(
        &pool,
        &target_dir,
        &bytes,
        &file_name,
        document_id.as_deref(),
    )
    .await?;

    // Stage via autocommit unless the active strategy keeps assets out of git
    // entirely (Local strategy). All other strategies need the file tracked
    // so it shows up in `Changes` and ends up in the next commit.
    let cfg = read_space_config(&target_dir)?;
    let strategy = cfg.assets.as_ref().map(|a| a.strategy).unwrap_or_default();
    if !matches!(strategy, AssetsStrategy::Local) {
        autocommit.schedule_structural(
            project.clone(),
            target_dir.clone(),
            StructuralOp::Create(result.rel_path.clone()),
        );
    }

    let space_id = IndexState::space_id_for_key(&key);
    Ok(UploadResponse {
        space_id,
        rel_path: result.rel_path,
        file_name: result.file_name,
        size_bytes: result.size_bytes,
        mime: result.mime,
    })
}

#[tauri::command]
pub async fn list_assets(
    project_path: String,
    space_id: Option<String>,
    index_state: State<'_, IndexState>,
) -> Result<Vec<Asset>, AppError> {
    let project = PathBuf::from(&project_path);
    let key = index_state
        .key_for_project_space_id(&project, space_id.as_deref())
        .await?;
    let pool = index_state.get_or_create(&key).await?;
    assets::list(&pool).await
}

#[tauri::command]
pub async fn get_assets_config(
    project_path: String,
    space_id: Option<String>,
    index_state: State<'_, IndexState>,
) -> Result<AssetsSpaceConfig, AppError> {
    let project = PathBuf::from(&project_path);
    let key = index_state
        .key_for_project_space_id(&project, space_id.as_deref())
        .await?;
    let target_dir = index_state.dir_for_key(&key).await?;
    let config = read_space_config(&target_dir)?;
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
    project_path: String,
    space_id: Option<String>,
    strategy: AssetsStrategy,
    s3_config: Option<AssetsS3Config>,
    s3_credentials: Option<S3CredentialInput>,
    git_state: State<'_, GitState>,
    index_state: State<'_, IndexState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<ApplyStrategyResult, AppError> {
    let project = PathBuf::from(&project_path);
    let key = index_state
        .key_for_project_space_id(&project, space_id.as_deref())
        .await?;
    let target_dir = index_state.dir_for_key(&key).await?;

    // Inline spaces inherit their assets strategy from the root project —
    // we refuse to write a child-space override that would silently be ignored.
    if space_id.is_some() {
        let cli = require_cli(&git_state)?;
        let git_type = crate::git::ops::detect_space_git_type(&cli, &project, &target_dir).await?;
        if matches!(git_type, SpaceGitType::Inline) {
            return Err(AppError::StrategyInherited);
        }
    }

    let mut config = read_space_config(&target_dir)?;

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
        &target_dir,
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
    write_space_config(&target_dir, &config)?;

    // Commit `.gitattributes` + `.gitignore` + `.combai/config.json` via the
    // system-commit pipeline so it routes to the correct repo (inline → root,
    // independent/submodule → space) under a single "Update assets strategy"
    // commit. This replaces the bare `git add` that previously lived inside
    // `apply_strategy`.
    if let Err(e) = autocommit
        .commit_system_now(
            project.clone(),
            target_dir.clone(),
            SystemCommitKind::AssetsStrategy,
        )
        .await
    {
        tracing::warn!("commit_system_now (AssetsStrategy) failed: {e}");
    }
    Ok(result)
}

/// Count the assets registered in this pool's SQLite index. Used by the
/// storage confirmation dialog to warn users that existing assets will NOT be
/// automatically migrated on strategy switch.
#[tauri::command]
pub async fn count_assets(
    project_path: String,
    space_id: Option<String>,
    index_state: State<'_, IndexState>,
) -> Result<i64, AppError> {
    let project = PathBuf::from(&project_path);
    let key = index_state
        .key_for_project_space_id(&project, space_id.as_deref())
        .await?;
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
/// the target pool's saved S3 config — used to render a "credentials saved"
/// badge instead of leaving the secret fields looking blank.
#[tauri::command]
pub async fn has_s3_credentials(
    project_path: String,
    space_id: Option<String>,
    index_state: State<'_, IndexState>,
) -> Result<bool, AppError> {
    let project = PathBuf::from(&project_path);
    let key = index_state
        .key_for_project_space_id(&project, space_id.as_deref())
        .await?;
    let target_dir = index_state.dir_for_key(&key).await?;
    let cfg = read_space_config(&target_dir)?;
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

/// Resolve a markdown-embedded asset URL (relative to `document_abs_path`)
/// to an absolute filesystem path the webview can load via
/// `convertFileSrc()`. Validates that the asset lives inside the project
/// boundary and routes through the same pool resolver as `upload_asset` so
/// out-of-pool / ghost references error out cleanly.
#[tauri::command]
pub async fn resolve_asset_url(
    app: AppHandle,
    project_path: String,
    document_abs_path: String,
    asset_path: String,
    index_state: State<'_, IndexState>,
) -> Result<String, AppError> {
    let project = PathBuf::from(&project_path);
    let doc_abs = PathBuf::from(&document_abs_path);
    let doc_parent = doc_abs
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| doc_abs.clone());
    let raw_target = doc_parent.join(&asset_path);

    let abs = normalize_abs_path(&raw_target).ok_or_else(|| {
        AppError::Storage(format!("asset path traverses out of root: {asset_path}"))
    })?;
    if !abs.starts_with(&project) {
        return Err(AppError::Storage("asset out of project".into()));
    }

    // Routes through the resolver to validate ghost/missing/broken spaces.
    let (key, _rel) = index_state.resolve(&project, &abs).await?;
    let target_dir = index_state.dir_for_key(&key).await?;

    // Whitelist the pool's `.assets/` directory in the webview's asset
    // protocol scope so `convertFileSrc(absPath)` can load it. The call is
    // idempotent — Tauri's allow_directory is set-add.
    if let Err(e) = app
        .asset_protocol_scope()
        .allow_directory(target_dir.join(".assets"), true)
    {
        tracing::warn!("allow_directory failed for assets scope: {e}");
    }

    Ok(abs.to_string_lossy().to_string())
}

/// Normalize a path by collapsing `.` and `..` components without touching
/// the filesystem. Mirrors the private helper in `index::mod`. Returns
/// `None` if `..` escapes the path root.
fn normalize_abs_path(path: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Prefix(p) => out.push(p.as_os_str()),
            std::path::Component::RootDir => out.push(std::path::MAIN_SEPARATOR.to_string()),
            std::path::Component::CurDir => {}
            std::path::Component::Normal(s) => out.push(s),
            std::path::Component::ParentDir => {
                if !out.pop() {
                    return None;
                }
            }
        }
    }
    Some(out)
}

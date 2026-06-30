use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use super::assets::{self, Asset};
use super::s3::{self, AgentSecrets};
use super::scope::{resolve_effective_storage_scope, resolve_effective_storage_scope_for_key};
use super::strategy::ApplyStrategyResult;
use crate::error::AppError;
use crate::git::GitState;
use crate::git::autocommit::{AutocommitService, StructuralOp, SystemCommitKind};
use crate::git::cli::GitCli;
use crate::git::commands::require_cli;
use crate::index::IndexState;
use crate::repo_path::{RootMode, repo_relative_from_base};
use crate::space::config::{read_space_config, write_space_config};
use crate::space::types::{
    AssetsS3Config, AssetsSpaceConfig, AssetsStrategy, SpaceConfig, SpaceGitType,
};

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
    let scope = resolve_effective_storage_scope_for_key(&index_state, &project, key).await?;
    let pool = index_state.get_or_create(&scope.pool_key).await?;
    let scoped_document_id =
        document_id_for_scope(&doc_abs, &scope.pool_dir, document_id.as_deref());

    let result = assets::upload(
        &pool,
        &scope.pool_dir,
        &bytes,
        &file_name,
        scoped_document_id.as_deref(),
    )
    .await?;

    // Stage via autocommit unless the active strategy keeps assets out of git
    // entirely (Local strategy). All other strategies need the file tracked
    // so it shows up in `Changes` and ends up in the next commit.
    if !matches!(scope.config.strategy, AssetsStrategy::Local) {
        autocommit.schedule_structural_paths(
            project.clone(),
            scope.repo_dir.clone(),
            StructuralOp::Create(result.rel_path.clone()),
            vec![scope.pool_dir.join(&result.rel_path)],
        );
    }

    let space_id = IndexState::space_id_for_key(&scope.pool_key);
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
    let scope =
        resolve_effective_storage_scope(&index_state, &project, space_id.as_deref()).await?;
    let pool = index_state.get_or_create(&scope.pool_key).await?;
    assets::list(&pool).await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveAssetsConfig {
    pub strategy: AssetsStrategy,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub s3: Option<AssetsS3Config>,
    pub default_s3_prefix: String,
    pub inherited_from_project: bool,
    pub owner_space_id: Option<String>,
    pub git_type: Option<SpaceGitType>,
}

#[tauri::command]
pub async fn get_assets_config(
    project_path: String,
    space_id: Option<String>,
    index_state: State<'_, IndexState>,
) -> Result<EffectiveAssetsConfig, AppError> {
    let project = PathBuf::from(&project_path);
    let scope =
        resolve_effective_storage_scope(&index_state, &project, space_id.as_deref()).await?;
    Ok(EffectiveAssetsConfig {
        strategy: scope.config.strategy,
        s3: scope.config.s3,
        default_s3_prefix: scope.default_s3_prefix,
        inherited_from_project: scope.inherited_from_project,
        owner_space_id: IndexState::space_id_for_key(&scope.pool_key),
        git_type: scope.git_type,
    })
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

fn is_sync_strategy(strategy: AssetsStrategy) -> bool {
    !matches!(strategy, AssetsStrategy::Local)
}

fn ensure_supported_strategy_transition(
    current: AssetsStrategy,
    next: AssetsStrategy,
) -> Result<(), AppError> {
    if current == next || !is_sync_strategy(current) {
        return Ok(());
    }

    Err(AppError::Storage(
        "Changing an active assets storage strategy is not supported yet. Use the future migration flow to move existing assets between storage strategies.".into(),
    ))
}

fn system_autocommit_enabled(config: &SpaceConfig) -> bool {
    config
        .git
        .as_ref()
        .and_then(|git| git.auto_commit_system)
        .unwrap_or(false)
}

fn document_id_for_scope(
    document_abs_path: &Path,
    pool_dir: &Path,
    fallback: Option<&str>,
) -> Option<String> {
    repo_relative_from_base(pool_dir, document_abs_path, RootMode::Reject)
        .ok()
        .or_else(|| fallback.map(ToString::to_string))
}

async fn system_paths_dirty_before_strategy_apply(
    cli: &GitCli,
    repo: &Path,
    paths: &[&str],
) -> Result<bool, AppError> {
    let mut args = vec!["status", "--porcelain=v1", "-z", "--"];
    args.extend_from_slice(paths);
    let out = cli.exec(repo, &args).await?;
    if out.exit_code != 0 {
        return Err(AppError::GitCommandFailed(format!(
            "git status failed: {}",
            out.stderr
        )));
    }
    Ok(!out.stdout.is_empty())
}

async fn has_staged_changes(cli: &GitCli, repo: &Path) -> Result<bool, AppError> {
    let out = cli.exec(repo, &["diff", "--cached", "--quiet"]).await?;
    match out.exit_code {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(AppError::GitCommandFailed(format!(
            "git diff --cached failed: {}",
            out.stderr
        ))),
    }
}

async fn strategy_autocommit_blocker(
    cli: &GitCli,
    repo: &Path,
    paths: &[&str],
) -> Result<Option<&'static str>, AppError> {
    if system_paths_dirty_before_strategy_apply(cli, repo, paths).await? {
        return Ok(Some(
            "Storage strategy files were already dirty, so Svode left the strategy changes pending instead of creating a background commit.",
        ));
    }
    if has_staged_changes(cli, repo).await? {
        return Ok(Some(
            "The repository already had staged changes, so Svode left the strategy changes pending instead of creating a background commit.",
        ));
    }
    Ok(None)
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
    let scope =
        resolve_effective_storage_scope(&index_state, &project, space_id.as_deref()).await?;
    let cli = require_cli(&git_state)?;

    // Inline spaces inherit their assets strategy from the root project —
    // we refuse to write a child-space override that would silently be ignored.
    if scope.inherited_from_project {
        return Err(AppError::StrategyInherited);
    }

    let mut config = read_space_config(&scope.config_dir)?;
    let current_strategy = config
        .assets
        .as_ref()
        .map(|assets| assets.strategy)
        .unwrap_or_default();
    ensure_supported_strategy_transition(current_strategy, strategy)?;

    let s3_config = s3_config.map(|mut config| {
        config.prefix = s3::normalize_prefix_path(&config.prefix, &scope.default_s3_prefix);
        config
    });

    let should_autocommit_strategy = system_autocommit_enabled(&config);
    let autocommit_blocker = if should_autocommit_strategy {
        strategy_autocommit_blocker(
            &cli,
            &scope.repo_dir,
            SystemCommitKind::AssetsStrategy.paths(),
        )
        .await?
    } else {
        None
    };

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

    let mut result = super::strategy::apply_strategy(
        &git_state,
        &scope.repo_dir,
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
    write_space_config(&scope.config_dir, &config)?;

    // Commit `.gitattributes` + `.gitignore` + `.svode/config.json` via the
    // system-commit pipeline so it routes to the correct repo (inline → root,
    // independent/submodule → space) under a single "Update assets strategy"
    // commit. This replaces the bare `git add` that previously lived inside
    // `apply_strategy`.
    if should_autocommit_strategy {
        if let Some(message) = autocommit_blocker {
            result.warnings.push(message.to_string());
        } else if has_staged_changes(&cli, &scope.repo_dir).await? {
            result.warnings.push(
                "The repository gained staged changes during storage strategy apply, so Svode left the strategy changes pending instead of creating a background commit.".to_string(),
            );
        } else if let Err(e) = autocommit
            .commit_system_now(
                project.clone(),
                scope.repo_dir.clone(),
                SystemCommitKind::AssetsStrategy,
            )
            .await
        {
            tracing::warn!("commit_system_now (AssetsStrategy) failed: {e}");
        }
    }
    Ok(result)
}

/// Count real files under this pool's `.assets/` directory. Used by the
/// storage confirmation dialog before turning existing local bytes into
/// syncable pending changes.
#[tauri::command]
pub async fn count_assets(
    project_path: String,
    space_id: Option<String>,
    index_state: State<'_, IndexState>,
) -> Result<i64, AppError> {
    let project = PathBuf::from(&project_path);
    let scope =
        resolve_effective_storage_scope(&index_state, &project, space_id.as_deref()).await?;
    assets::count_existing_asset_files(&scope.pool_dir)
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
    let scope =
        resolve_effective_storage_scope(&index_state, &project, space_id.as_deref()).await?;
    let Some(s3_cfg) = scope.config.s3 else {
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
    let started = Instant::now();
    let project_name = Path::new(&project_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("<unknown>")
        .to_string();
    let asset_extension = Path::new(&asset_path)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("<none>")
        .to_ascii_lowercase();

    let result = async {
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
    .await;
    let duration_ms = started.elapsed().as_millis() as u64;

    match &result {
        Ok(_) => tracing::info!(
            target: "svode::perf",
            event = "asset.resolve",
            project = %project_name,
            asset_extension = %asset_extension,
            duration_ms,
            "asset.resolve completed"
        ),
        Err(error) => tracing::info!(
            target: "svode::perf",
            event = "asset.resolve",
            project = %project_name,
            asset_extension = %asset_extension,
            duration_ms,
            error_kind = error.kind(),
            "asset.resolve failed"
        ),
    }

    result
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

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        document_id_for_scope, ensure_supported_strategy_transition, strategy_autocommit_blocker,
    };
    use crate::AppError;
    use crate::git::autocommit::SystemCommitKind;
    use crate::git::cli::GitCli;
    use crate::space::types::AssetsStrategy;

    #[test]
    fn strategy_transition_guard_allows_only_local_enrollment_or_same_strategy() {
        for next in [
            AssetsStrategy::Local,
            AssetsStrategy::InGit,
            AssetsStrategy::LfsRemote,
            AssetsStrategy::LfsS3,
        ] {
            assert!(ensure_supported_strategy_transition(AssetsStrategy::Local, next).is_ok());
        }

        assert!(
            ensure_supported_strategy_transition(AssetsStrategy::LfsS3, AssetsStrategy::LfsS3)
                .is_ok()
        );
        assert!(
            ensure_supported_strategy_transition(AssetsStrategy::InGit, AssetsStrategy::LfsRemote)
                .is_err()
        );
        assert!(
            ensure_supported_strategy_transition(AssetsStrategy::LfsRemote, AssetsStrategy::Local)
                .is_err()
        );
        assert!(
            ensure_supported_strategy_transition(AssetsStrategy::LfsRemote, AssetsStrategy::LfsS3)
                .is_err()
        );
    }

    #[test]
    fn document_id_for_scope_uses_effective_pool_relative_path() {
        let pool = Path::new("/project");
        let document = Path::new("/project/child/README.md");

        assert_eq!(
            document_id_for_scope(document, pool, Some("README.md")),
            Some("child/README.md".to_string())
        );
    }

    #[test]
    fn document_id_for_scope_falls_back_when_document_is_outside_pool() {
        let pool = Path::new("/project");
        let document = Path::new("/other/README.md");

        assert_eq!(
            document_id_for_scope(document, pool, Some("README.md")),
            Some("README.md".to_string())
        );
    }

    #[tokio::test]
    async fn strategy_autocommit_blocker_detects_dirty_strategy_files() -> Result<(), AppError> {
        let Some((cli, _temp, repo)) = setup_clean_repo().await? else {
            return Ok(());
        };

        std::fs::write(repo.join(".gitignore"), "dirty\n")?;

        let blocker =
            strategy_autocommit_blocker(&cli, &repo, SystemCommitKind::AssetsStrategy.paths())
                .await?;
        assert!(blocker.is_some_and(|message| message.contains("already dirty")));
        Ok(())
    }

    #[tokio::test]
    async fn strategy_autocommit_blocker_detects_preexisting_staged_changes() -> Result<(), AppError>
    {
        let Some((cli, _temp, repo)) = setup_clean_repo().await? else {
            return Ok(());
        };

        std::fs::write(repo.join("README.md"), "# Project\n\nstaged\n")?;
        git_ok(&cli, &repo, &["add", "README.md"]).await?;

        let blocker =
            strategy_autocommit_blocker(&cli, &repo, SystemCommitKind::AssetsStrategy.paths())
                .await?;
        assert!(blocker.is_some_and(|message| message.contains("staged changes")));
        Ok(())
    }

    #[tokio::test]
    async fn strategy_autocommit_blocker_allows_clean_repo() -> Result<(), AppError> {
        let Some((cli, _temp, repo)) = setup_clean_repo().await? else {
            return Ok(());
        };

        let blocker =
            strategy_autocommit_blocker(&cli, &repo, SystemCommitKind::AssetsStrategy.paths())
                .await?;
        assert!(blocker.is_none());
        Ok(())
    }

    async fn setup_clean_repo()
    -> Result<Option<(GitCli, tempfile::TempDir, std::path::PathBuf)>, AppError> {
        let cli = match GitCli::detect() {
            Ok(cli) => cli,
            Err(_) => return Ok(None),
        };
        let temp = tempfile::tempdir()?;
        let repo = temp.path().join("repo");
        std::fs::create_dir_all(repo.join(".svode"))?;

        git_ok(&cli, &repo, &["init"]).await?;
        git_ok(&cli, &repo, &["config", "user.email", "test@example.com"]).await?;
        git_ok(&cli, &repo, &["config", "user.name", "Svode Test"]).await?;

        std::fs::write(repo.join(".gitignore"), "# ignore\n")?;
        std::fs::write(
            repo.join(".svode").join("config.json"),
            r#"{"name":"Project"}"#,
        )?;
        std::fs::write(repo.join("README.md"), "# Project\n")?;
        git_ok(
            &cli,
            &repo,
            &["add", ".gitignore", ".svode/config.json", "README.md"],
        )
        .await?;
        git_ok(&cli, &repo, &["commit", "-m", "Initial commit"]).await?;

        Ok(Some((cli, temp, repo)))
    }

    async fn git_ok(cli: &GitCli, repo: &Path, args: &[&str]) -> Result<(), AppError> {
        let out = cli.exec(repo, args).await?;
        if out.exit_code != 0 {
            return Err(AppError::GitCommandFailed(format!(
                "git {} failed: {}",
                args.join(" "),
                out.stderr
            )));
        }
        Ok(())
    }
}

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::error::AppError;
use crate::git::cli::GitCli;
use crate::git::{GitState, ops};
use crate::index::IndexState;
use crate::space::types::{
    AssetsSpaceConfig, AssetsStrategy, BINARY_ROUTING_VERSION, BinaryRoutingConfig,
};

use super::scope::resolve_effective_storage_scope;

pub(crate) const LFS_START: &str = "# svode:assets-lfs:start";
pub(crate) const LFS_END: &str = "# svode:assets-lfs:end";
pub(crate) const LEGACY_ASSETS_ONLY_LFS_RULE: &str =
    ".assets/** filter=lfs diff=lfs merge=lfs -text";

/// Repo-wide media preset owned by the backend storage policy. Keep this as
/// the single source for both generated `.gitattributes` rules and dirty-file
/// diagnostics.
pub(crate) const REPOSITORY_LFS_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "tif", "tiff", "psd", "ai", "sketch",
    "mp3", "wav", "flac", "m4a", "ogg", "mp4", "mov", "m4v", "webm", "avi", "mkv", "pdf", "doc",
    "docx", "ppt", "pptx", "xls", "xlsx", "zip", "7z", "rar",
];

const PROTECTED_EXTENSIONS: &[&str] = &["md", "markdown", "yaml", "yml", "json", "csv", "svg"];
const PROTECTED_FILE_NAMES: &[&str] = &["AGENTS.md", "CLAUDE.md"];

const CHECK_ATTR_BATCH_SIZE: usize = 128;
const MAX_UNCOVERED_PATHS: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsPolicyDiagnostic {
    pub managed_policy_current: bool,
    pub uncovered_paths: Vec<String>,
    pub truncated_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BinaryRoutingStatus {
    LegacyPreset,
    V1,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveBinaryRouting {
    pub status: BinaryRoutingStatus,
    pub version: Option<u32>,
    pub lfs_extensions: Vec<String>,
    pub lfs_threshold_bytes: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ManagedBinaryRoute {
    Local,
    LfsExtension,
    LfsThreshold,
    DirectGit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LfsFilterCheck {
    pub path: String,
    pub value: String,
}

pub(crate) fn strategy_uses_lfs_policy(strategy: AssetsStrategy) -> bool {
    matches!(strategy, AssetsStrategy::LfsRemote | AssetsStrategy::LfsS3)
}

pub(crate) fn effective_binary_routing(config: &AssetsSpaceConfig) -> EffectiveBinaryRouting {
    match config.binary_routing.as_ref() {
        None => EffectiveBinaryRouting {
            status: BinaryRoutingStatus::LegacyPreset,
            version: None,
            lfs_extensions: REPOSITORY_LFS_EXTENSIONS
                .iter()
                .map(|extension| (*extension).to_string())
                .collect(),
            lfs_threshold_bytes: None,
        },
        Some(routing) if routing.version == BINARY_ROUTING_VERSION => EffectiveBinaryRouting {
            status: BinaryRoutingStatus::V1,
            version: Some(routing.version),
            lfs_extensions: routing.lfs_extensions.clone(),
            lfs_threshold_bytes: routing.lfs_threshold_bytes,
        },
        Some(routing) => EffectiveBinaryRouting {
            status: BinaryRoutingStatus::Unsupported,
            version: Some(routing.version),
            lfs_extensions: Vec::new(),
            lfs_threshold_bytes: None,
        },
    }
}

pub(crate) fn supported_binary_routing(
    config: &AssetsSpaceConfig,
) -> Result<BinaryRoutingConfig, AppError> {
    match config.binary_routing.as_ref() {
        None => normalize_binary_routing(BinaryRoutingConfig {
            version: BINARY_ROUTING_VERSION,
            lfs_extensions: REPOSITORY_LFS_EXTENSIONS
                .iter()
                .map(|extension| (*extension).to_string())
                .collect(),
            lfs_threshold_bytes: None,
            extensions: Default::default(),
        }),
        Some(routing) if routing.version == BINARY_ROUTING_VERSION => {
            normalize_binary_routing(routing.clone())
        }
        Some(routing) => Err(AppError::Storage(format!(
            "assets.binaryRouting version {} is not supported; update Svode before changing storage policy or importing files",
            routing.version
        ))),
    }
}

pub(crate) fn normalize_binary_routing(
    mut routing: BinaryRoutingConfig,
) -> Result<BinaryRoutingConfig, AppError> {
    if routing.version != BINARY_ROUTING_VERSION {
        return Err(AppError::Storage(format!(
            "assets.binaryRouting version {} is not supported",
            routing.version
        )));
    }
    if routing.lfs_threshold_bytes == Some(0) {
        return Err(AppError::Storage(
            "LFS threshold must be a positive byte count".to_string(),
        ));
    }

    let mut normalized = BTreeSet::new();
    for extension in routing.lfs_extensions {
        let extension = extension.trim();
        if extension.is_empty() {
            continue;
        }
        let extension = extension.trim_start_matches('.').to_ascii_lowercase();
        if !valid_extension(&extension) {
            return Err(AppError::Storage(format!(
                "invalid LFS extension `{extension}`"
            )));
        }
        if PROTECTED_EXTENSIONS.contains(&extension.as_str()) {
            return Err(AppError::Storage(format!(
                "protected text extension `{extension}` cannot be routed to Git LFS"
            )));
        }
        normalized.insert(extension);
    }
    routing.lfs_extensions = normalized.into_iter().collect();
    Ok(routing)
}

pub(crate) fn evaluate_managed_binary_route(
    config: &AssetsSpaceConfig,
    path: &str,
    size_bytes: u64,
) -> Result<ManagedBinaryRoute, AppError> {
    let routing = supported_binary_routing(config)?;
    match config.strategy {
        AssetsStrategy::Local => return Ok(ManagedBinaryRoute::Local),
        AssetsStrategy::InGit => return Ok(ManagedBinaryRoute::DirectGit),
        AssetsStrategy::LfsRemote | AssetsStrategy::LfsS3 => {}
    }
    if is_protected_source(path) {
        return Ok(ManagedBinaryRoute::DirectGit);
    }
    let extension = Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase);
    if extension
        .as_ref()
        .is_some_and(|extension| routing.lfs_extensions.contains(extension))
    {
        return Ok(ManagedBinaryRoute::LfsExtension);
    }
    if routing
        .lfs_threshold_bytes
        .is_some_and(|threshold| size_bytes >= threshold)
    {
        return Ok(ManagedBinaryRoute::LfsThreshold);
    }
    Ok(ManagedBinaryRoute::DirectGit)
}

pub(crate) fn managed_lfs_attributes_body(routing: &BinaryRoutingConfig) -> String {
    let mut lines = Vec::with_capacity(routing.lfs_extensions.len() + 1);
    lines.push(LEGACY_ASSETS_ONLY_LFS_RULE.to_string());
    lines.extend(routing.lfs_extensions.iter().map(|extension| {
        format!(
            "{} filter=lfs diff=lfs merge=lfs -text",
            case_insensitive_extension_pattern(extension)
        )
    }));
    lines.join("\n")
}

pub(crate) fn is_repository_lfs_candidate(path: &str, routing: &BinaryRoutingConfig) -> bool {
    let normalized = path.replace('\\', "/");
    if normalized.starts_with(".assets/") {
        return true;
    }

    if is_protected_source(&normalized) {
        return false;
    }

    let Some(file_name) = normalized.rsplit('/').next() else {
        return false;
    };
    let Some((_, extension)) = file_name.rsplit_once('.') else {
        return false;
    };
    if extension.is_empty() {
        return false;
    }

    routing
        .lfs_extensions
        .iter()
        .any(|candidate| extension.eq_ignore_ascii_case(candidate))
}

pub(crate) fn managed_policy_current(
    contents: &str,
    strategy: AssetsStrategy,
    routing: &BinaryRoutingConfig,
) -> bool {
    if !strategy_uses_lfs_policy(strategy) {
        return !contents
            .lines()
            .any(|line| matches!(line.trim(), LFS_START | LFS_END));
    }

    managed_lfs_policy_is_current(contents, routing)
}

fn managed_lfs_policy_is_current(contents: &str, routing: &BinaryRoutingConfig) -> bool {
    let expected: Vec<String> = managed_lfs_attributes_body(routing)
        .lines()
        .map(ToString::to_string)
        .collect();
    let mut blocks: Vec<Vec<String>> = Vec::new();
    let mut current: Option<Vec<String>> = None;
    let mut malformed = false;

    for line in contents.lines() {
        match line.trim() {
            LFS_START => {
                if current.is_some() {
                    malformed = true;
                }
                current = Some(Vec::new());
            }
            LFS_END => match current.take() {
                Some(block) => blocks.push(block),
                None => malformed = true,
            },
            _ => {
                if let Some(block) = current.as_mut() {
                    block.push(line.trim().to_string());
                }
            }
        }
    }

    if current.is_some() {
        malformed = true;
    }

    !malformed && blocks.len() == 1 && blocks[0] == expected
}

pub(crate) fn representative_lfs_paths(routing: &BinaryRoutingConfig) -> Vec<String> {
    std::iter::once(".assets/legacy.bin".to_string())
        .chain(
            routing
                .lfs_extensions
                .iter()
                .map(|extension| format!(".svode-policy/probe.{extension}")),
        )
        .collect()
}

fn valid_extension(extension: &str) -> bool {
    let mut chars = extension.chars();
    chars
        .next()
        .is_some_and(|character| character.is_ascii_alphanumeric())
        && chars.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '+' | '_' | '-')
        })
}

fn is_protected_source(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    if normalized == ".svode" || normalized.starts_with(".svode/") {
        return true;
    }
    let Some(file_name) = normalized.rsplit('/').next() else {
        return true;
    };
    if PROTECTED_FILE_NAMES
        .iter()
        .any(|candidate| file_name.eq_ignore_ascii_case(candidate))
    {
        return true;
    }
    Path::new(file_name)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            PROTECTED_EXTENSIONS
                .iter()
                .any(|candidate| extension.eq_ignore_ascii_case(candidate))
        })
}

pub(crate) async fn check_lfs_filters(
    cli: &GitCli,
    repo_dir: &Path,
    paths: &[String],
) -> Result<Vec<LfsFilterCheck>, AppError> {
    let mut checks = Vec::with_capacity(paths.len());

    for batch in paths.chunks(CHECK_ATTR_BATCH_SIZE) {
        let mut args = vec![
            "check-attr".to_string(),
            "-z".to_string(),
            "filter".to_string(),
            "--".to_string(),
        ];
        args.extend(batch.iter().cloned());
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let output = cli.exec(repo_dir, &arg_refs).await?;
        if output.exit_code != 0 {
            return Err(AppError::GitCommandFailed(format!(
                "git check-attr failed: {}",
                output.stderr.trim()
            )));
        }

        let parsed = parse_check_attr_z(&output.stdout)?;
        if parsed.len() != batch.len() {
            return Err(AppError::GitCommandFailed(format!(
                "git check-attr returned {} result(s) for {} path(s)",
                parsed.len(),
                batch.len()
            )));
        }
        checks.extend(parsed);
    }

    Ok(checks)
}

fn parse_check_attr_z(stdout: &str) -> Result<Vec<LfsFilterCheck>, AppError> {
    let fields: Vec<&str> = stdout.split_terminator('\0').collect();
    if !fields.len().is_multiple_of(3) {
        return Err(AppError::GitCommandFailed(
            "git check-attr returned malformed NUL-delimited output".to_string(),
        ));
    }

    fields
        .chunks_exact(3)
        .map(|record| {
            if record[1] != "filter" {
                return Err(AppError::GitCommandFailed(format!(
                    "git check-attr returned unexpected attribute `{}`",
                    record[1]
                )));
            }
            Ok(LfsFilterCheck {
                path: record[0].to_string(),
                value: record[2].to_string(),
            })
        })
        .collect()
}

async fn diagnose_repo_lfs_policy(
    cli: &GitCli,
    repo_dir: &Path,
    config: &AssetsSpaceConfig,
) -> Result<LfsPolicyDiagnostic, AppError> {
    let routing = supported_binary_routing(config)?;
    let attributes = read_or_empty(&repo_dir.join(".gitattributes"))?;
    let managed_policy_current = managed_policy_current(&attributes, config.strategy, &routing);

    if !strategy_uses_lfs_policy(config.strategy) {
        return Ok(LfsPolicyDiagnostic {
            managed_policy_current,
            uncovered_paths: Vec::new(),
            truncated_count: 0,
        });
    }

    let status = ops::status(cli, repo_dir).await?;
    let candidates: Vec<String> = status
        .files
        .into_iter()
        .filter(|file| matches!(file.state.as_str(), "modified" | "untracked"))
        .filter(|file| is_repository_lfs_candidate(&file.path, &routing))
        .map(|file| file.path)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();

    let uncovered_paths: Vec<String> = check_lfs_filters(cli, repo_dir, &candidates)
        .await?
        .into_iter()
        .filter(|check| check.value != "lfs")
        .map(|check| check.path)
        .collect();
    let (uncovered_paths, truncated_count) = limit_uncovered_paths(uncovered_paths);

    Ok(LfsPolicyDiagnostic {
        managed_policy_current,
        uncovered_paths,
        truncated_count,
    })
}

#[tauri::command]
pub async fn diagnose_lfs_policy(
    project_path: String,
    space_id: Option<String>,
    git_state: State<'_, GitState>,
    index_state: State<'_, IndexState>,
) -> Result<LfsPolicyDiagnostic, AppError> {
    let project = PathBuf::from(&project_path);
    let scope =
        resolve_effective_storage_scope(&index_state, &project, space_id.as_deref()).await?;
    let cli = git_state.cli.clone().ok_or(AppError::GitNotFound)?;
    let lock = git_state.get_lock(&scope.repo_dir).await;
    let _guard = lock.lock().await;

    diagnose_repo_lfs_policy(&cli, &scope.repo_dir, &scope.config).await
}

fn limit_uncovered_paths(mut paths: Vec<String>) -> (Vec<String>, usize) {
    let truncated_count = paths.len().saturating_sub(MAX_UNCOVERED_PATHS);
    paths.truncate(MAX_UNCOVERED_PATHS);
    (paths, truncated_count)
}

fn case_insensitive_extension_pattern(extension: &str) -> String {
    let mut pattern = String::from("*.");
    for character in extension.chars() {
        if character.is_ascii_alphabetic() {
            pattern.push('[');
            pattern.push(character.to_ascii_lowercase());
            pattern.push(character.to_ascii_uppercase());
            pattern.push(']');
        } else {
            pattern.push(character);
        }
    }
    pattern
}

fn read_or_empty(path: &Path) -> Result<String, AppError> {
    match std::fs::read_to_string(path) {
        Ok(contents) => Ok(contents),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        LEGACY_ASSETS_ONLY_LFS_RULE, LFS_END, LFS_START, ManagedBinaryRoute,
        REPOSITORY_LFS_EXTENSIONS, check_lfs_filters, diagnose_repo_lfs_policy,
        evaluate_managed_binary_route, is_repository_lfs_candidate, limit_uncovered_paths,
        managed_lfs_attributes_body, managed_policy_current, normalize_binary_routing,
        supported_binary_routing,
    };
    use crate::AppError;
    use crate::git::cli::GitCli;
    use crate::space::types::{
        AssetsSpaceConfig, AssetsStrategy, BINARY_ROUTING_VERSION, BinaryRoutingConfig,
    };

    fn legacy_routing() -> BinaryRoutingConfig {
        supported_binary_routing(&AssetsSpaceConfig::default()).expect("legacy routing")
    }

    fn lfs_config(routing: BinaryRoutingConfig) -> AssetsSpaceConfig {
        AssetsSpaceConfig {
            strategy: AssetsStrategy::LfsRemote,
            binary_routing: Some(routing),
            s3: None,
        }
    }

    #[test]
    fn repository_lfs_preset_is_exact_unique_and_excludes_text_formats() {
        assert_eq!(REPOSITORY_LFS_EXTENSIONS.len(), 33);
        let unique: std::collections::BTreeSet<_> =
            REPOSITORY_LFS_EXTENSIONS.iter().copied().collect();
        assert_eq!(unique.len(), REPOSITORY_LFS_EXTENSIONS.len());

        for extension in ["png", "psd", "mp4", "pdf", "docx", "7z"] {
            assert!(REPOSITORY_LFS_EXTENSIONS.contains(&extension));
        }
        for extension in ["md", "yaml", "json", "csv", "svg"] {
            assert!(!REPOSITORY_LFS_EXTENSIONS.contains(&extension));
            let routing = legacy_routing();
            assert!(!is_repository_lfs_candidate(
                &format!("docs/file.{extension}"),
                &routing
            ));
        }
    }

    #[test]
    fn repository_lfs_candidate_matching_is_case_insensitive_and_repo_scoped() {
        let routing = legacy_routing();
        assert!(is_repository_lfs_candidate(
            "campaigns/summer/banner.PsD",
            &routing
        ));
        assert!(is_repository_lfs_candidate(
            "presentations/demo.MP4",
            &routing
        ));
        assert!(is_repository_lfs_candidate(
            ".assets/no-extension",
            &routing
        ));
        assert!(!is_repository_lfs_candidate(
            "campaigns/.assets/no-extension",
            &routing
        ));
        assert!(!is_repository_lfs_candidate("icons/logo.svg", &routing));
        assert!(!is_repository_lfs_candidate("archive.bin", &routing));
    }

    #[test]
    fn generated_lfs_body_is_deterministic_and_marks_old_block_as_stale() {
        let routing = legacy_routing();
        let body = managed_lfs_attributes_body(&routing);
        assert_eq!(body, managed_lfs_attributes_body(&routing));
        assert_eq!(body.lines().count(), REPOSITORY_LFS_EXTENSIONS.len() + 1);
        assert_eq!(
            body.lines()
                .filter(|line| *line == LEGACY_ASSETS_ONLY_LFS_RULE)
                .count(),
            1
        );
        assert!(body.contains("*.[pP][sS][dD] filter=lfs"));
        assert!(body.contains("*.7[zZ] filter=lfs"));
        assert!(!body.contains("[mM][dD] filter=lfs"));
        assert!(!body.contains("[sS][vV][gG] filter=lfs"));

        let old = format!("{LFS_START}\n{LEGACY_ASSETS_ONLY_LFS_RULE}\n{LFS_END}\n");
        assert!(!managed_policy_current(
            &old,
            AssetsStrategy::LfsRemote,
            &routing
        ));

        let current = format!("{LFS_START}\n{body}\n{LFS_END}\n");
        assert!(managed_policy_current(
            &current,
            AssetsStrategy::LfsRemote,
            &routing
        ));
        assert!(managed_policy_current(
            &current,
            AssetsStrategy::LfsS3,
            &routing
        ));
        assert!(!managed_policy_current(
            &current,
            AssetsStrategy::InGit,
            &routing
        ));
    }

    #[test]
    fn diagnostics_limit_uncovered_paths_and_report_truncation() {
        let paths: Vec<String> = (0..103).map(|index| format!("media/{index}.psd")).collect();

        let (visible, truncated_count) = limit_uncovered_paths(paths);

        assert_eq!(visible.len(), 100);
        assert_eq!(truncated_count, 3);
    }

    #[tokio::test]
    async fn generated_rules_are_effective_for_nested_and_mixed_case_paths() -> Result<(), AppError>
    {
        let Some(cli) = detected_git() else {
            return Ok(());
        };
        let temp = tempfile::tempdir()?;
        init_repo(&cli, temp.path()).await?;
        std::fs::write(
            temp.path().join(".gitattributes"),
            managed_lfs_attributes_body(&legacy_routing()),
        )?;

        let paths: Vec<String> = [
            ".assets/photo.unknown",
            "root.PNG",
            "campaigns/summer/banner.PsD",
            "presentations/demo.MP4",
            "docs/brief.md",
            "icons/logo.svg",
        ]
        .into_iter()
        .map(ToString::to_string)
        .collect();
        let checks = check_lfs_filters(&cli, temp.path(), &paths).await?;

        assert_eq!(
            checks
                .iter()
                .map(|check| check.value.as_str())
                .collect::<Vec<_>>(),
            vec!["lfs", "lfs", "lfs", "lfs", "unspecified", "unspecified"]
        );
        Ok(())
    }

    #[tokio::test]
    async fn diagnostics_report_only_dirty_uncovered_policy_candidates() -> Result<(), AppError> {
        let Some(cli) = detected_git() else {
            return Ok(());
        };
        let temp = tempfile::tempdir()?;
        let repo = temp.path();
        init_repo(&cli, repo).await?;

        std::fs::write(
            repo.join(".gitattributes"),
            "*.[pP][nN][gG] filter=lfs diff=lfs merge=lfs -text\n",
        )?;
        write_file(repo, "covered/photo.PNG")?;
        write_file(repo, "campaigns/banner.psd")?;
        write_file(repo, ".assets/raw.bin")?;
        write_file(repo, "docs/brief.md")?;
        write_file(repo, "staged/manual.pdf")?;
        git_ok(&cli, repo, &["add", "staged/manual.pdf"]).await?;
        write_file(repo, "deleted/video.mp4")?;
        git_ok(&cli, repo, &["add", "deleted/video.mp4"]).await?;
        std::fs::remove_file(repo.join("deleted/video.mp4"))?;

        let diagnostic =
            diagnose_repo_lfs_policy(&cli, repo, &lfs_config(legacy_routing())).await?;

        assert!(!diagnostic.managed_policy_current);
        assert_eq!(
            diagnostic.uncovered_paths,
            vec![
                ".assets/raw.bin",
                "campaigns/banner.psd",
                "staged/manual.pdf"
            ]
        );
        assert_eq!(diagnostic.truncated_count, 0);
        Ok(())
    }

    #[test]
    fn routing_normalizes_and_applies_extension_before_threshold() {
        let routing = normalize_binary_routing(BinaryRoutingConfig {
            version: BINARY_ROUTING_VERSION,
            lfs_extensions: vec![" ZIP ".into(), ".psd".into(), "zip".into()],
            lfs_threshold_bytes: Some(10),
            extensions: Default::default(),
        })
        .expect("routing");
        assert_eq!(routing.lfs_extensions, vec!["psd", "zip"]);
        let config = lfs_config(routing);
        assert_eq!(
            evaluate_managed_binary_route(&config, "art.PSD", 1).unwrap(),
            ManagedBinaryRoute::LfsExtension
        );
        assert_eq!(
            evaluate_managed_binary_route(&config, "archive.bin", 10).unwrap(),
            ManagedBinaryRoute::LfsThreshold
        );
        assert_eq!(
            evaluate_managed_binary_route(&config, "data.json", 100).unwrap(),
            ManagedBinaryRoute::DirectGit
        );
        assert!(
            normalize_binary_routing(BinaryRoutingConfig {
                version: BINARY_ROUTING_VERSION,
                lfs_extensions: vec![".".into()],
                lfs_threshold_bytes: None,
                extensions: Default::default(),
            })
            .is_err()
        );
    }

    #[test]
    fn unknown_routing_version_fails_closed_for_mutation() {
        let routing = BinaryRoutingConfig {
            version: 2,
            lfs_extensions: vec!["psd".into()],
            lfs_threshold_bytes: None,
            extensions: Default::default(),
        };
        for strategy in [
            AssetsStrategy::Local,
            AssetsStrategy::InGit,
            AssetsStrategy::LfsRemote,
            AssetsStrategy::LfsS3,
        ] {
            let config = AssetsSpaceConfig {
                strategy,
                binary_routing: Some(routing.clone()),
                s3: None,
            };
            assert!(evaluate_managed_binary_route(&config, "art.psd", 1).is_err());
        }
    }

    fn detected_git() -> Option<GitCli> {
        GitCli::detect().ok()
    }

    async fn init_repo(cli: &GitCli, repo: &Path) -> Result<(), AppError> {
        git_ok(cli, repo, &["init"]).await
    }

    async fn git_ok(cli: &GitCli, repo: &Path, args: &[&str]) -> Result<(), AppError> {
        let output = cli.exec(repo, args).await?;
        if output.exit_code != 0 {
            return Err(AppError::GitCommandFailed(format!(
                "git {} failed: {}",
                args.join(" "),
                output.stderr.trim()
            )));
        }
        Ok(())
    }

    fn write_file(repo: &Path, relative: &str) -> Result<(), AppError> {
        let path = repo.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, b"binary-ish test content")?;
        Ok(())
    }
}

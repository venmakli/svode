//! Binary routing policy: which managed file goes to Git LFS, stays out of
//! Git on this device or goes straight into Git, and whether the repository
//! attributes still match the configured routing.
//!
//! The rules are portable: they read the assets config and repository policy
//! files, and use the Git CLI only to verify effective attributes.

use std::collections::BTreeSet;
use std::path::Path;

use serde::Serialize;

use crate::git::GitError;
use crate::git::cli::{GitCli, nul_paths_input};
use crate::git::status;

use super::config::{
    AssetsSpaceConfig, AssetsStrategy, BINARY_ROUTING_VERSION, BinaryRoutingConfig,
};
use super::lfs_declaration::{LfsDeclarationState, lfs_declaration_state};
use super::routes::read_or_empty;

pub const LFS_START: &str = "# svode:assets-lfs:start";
pub const LFS_END: &str = "# svode:assets-lfs:end";
pub const LEGACY_ASSETS_ONLY_LFS_RULE: &str = ".assets/** filter=lfs diff=lfs merge=lfs -text";

/// Repo-wide media preset owned by the storage policy. Keep this as the single
/// source for both generated `.gitattributes` rules and dirty-file diagnostics.
pub const REPOSITORY_LFS_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "tif", "tiff", "psd", "ai", "sketch",
    "mp3", "wav", "flac", "m4a", "ogg", "mp4", "mov", "m4v", "webm", "avi", "mkv", "pdf", "doc",
    "docx", "ppt", "pptx", "xls", "xlsx", "zip", "7z", "rar",
];

/// Extensions the `local` strategy keeps out of Git when its config names no
/// list of its own: the same media, document and archive set.
pub const DEFAULT_LOCAL_EXTENSIONS: &[&str] = REPOSITORY_LFS_EXTENSIONS;

const PROTECTED_EXTENSIONS: &[&str] = &["md", "markdown", "yaml", "yml", "json", "csv", "svg"];
const PROTECTED_FILE_NAMES: &[&str] = &["AGENTS.md", "CLAUDE.md"];

const MAX_UNCOVERED_PATHS: usize = 100;

#[derive(Debug, thiserror::Error)]
pub enum StoragePolicyError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Storage(String),
    #[error(transparent)]
    Git(#[from] GitError),
}

impl From<super::routes::ManagedRouteError> for StoragePolicyError {
    fn from(error: super::routes::ManagedRouteError) -> Self {
        match error {
            super::routes::ManagedRouteError::Io(error) => Self::Io(error),
            super::routes::ManagedRouteError::Malformed(message) => Self::Storage(message),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsPolicyDiagnostic {
    pub managed_policy_current: bool,
    pub uncovered_paths: Vec<String>,
    pub truncated_count: usize,
    /// Portable `.lfsconfig` declaration state; only reported for `lfs-s3`.
    pub lfs_declaration: Option<LfsDeclarationState>,
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
    /// The effective list of the `local` strategy: the configured one or the
    /// default set when the config names none.
    pub local_extensions: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagedBinaryRoute {
    /// `local`: the repository-wide extension block keeps the file out of Git.
    LocalExtension,
    /// `local`: an exact rule keeps a large file of another format out of Git.
    LocalThreshold,
    LfsExtension,
    LfsThreshold,
    DirectGit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LfsFilterCheck {
    pub path: String,
    pub value: String,
}

pub fn strategy_uses_lfs_policy(strategy: &AssetsStrategy) -> bool {
    matches!(strategy, AssetsStrategy::LfsRemote | AssetsStrategy::LfsS3)
}

/// A strategy written by a newer Svode version fails closed: the config still
/// reads and writes it back as is, but importing files and changing the
/// storage strategy or its LFS rules are refused, since their outcome depends
/// on what the strategy means.
pub fn supported_strategy(strategy: &AssetsStrategy) -> Result<(), StoragePolicyError> {
    match strategy {
        AssetsStrategy::Unknown(value) => Err(StoragePolicyError::Storage(format!(
            "assets strategy `{value}` was set by a newer Svode version; update Svode before importing files or changing storage settings"
        ))),
        _ => Ok(()),
    }
}

pub fn effective_binary_routing(config: &AssetsSpaceConfig) -> EffectiveBinaryRouting {
    match config.binary_routing.as_ref() {
        None => EffectiveBinaryRouting {
            status: BinaryRoutingStatus::LegacyPreset,
            version: None,
            lfs_extensions: REPOSITORY_LFS_EXTENSIONS
                .iter()
                .map(|extension| (*extension).to_string())
                .collect(),
            lfs_threshold_bytes: None,
            local_extensions: default_local_extensions(),
        },
        Some(routing) if routing.version == BINARY_ROUTING_VERSION => EffectiveBinaryRouting {
            status: BinaryRoutingStatus::V1,
            version: Some(routing.version),
            lfs_extensions: routing.lfs_extensions.clone(),
            lfs_threshold_bytes: routing.lfs_threshold_bytes,
            local_extensions: effective_local_extensions(routing),
        },
        Some(routing) => EffectiveBinaryRouting {
            status: BinaryRoutingStatus::Unsupported,
            version: Some(routing.version),
            lfs_extensions: Vec::new(),
            lfs_threshold_bytes: None,
            local_extensions: Vec::new(),
        },
    }
}

pub fn supported_binary_routing(
    config: &AssetsSpaceConfig,
) -> Result<BinaryRoutingConfig, StoragePolicyError> {
    supported_strategy(&config.strategy)?;
    match config.binary_routing.as_ref() {
        None => normalize_binary_routing(BinaryRoutingConfig {
            version: BINARY_ROUTING_VERSION,
            lfs_extensions: REPOSITORY_LFS_EXTENSIONS
                .iter()
                .map(|extension| (*extension).to_string())
                .collect(),
            lfs_threshold_bytes: None,
            local_extensions: None,
            extensions: Default::default(),
        }),
        Some(routing) if routing.version == BINARY_ROUTING_VERSION => {
            normalize_binary_routing(routing.clone())
        }
        Some(routing) => Err(StoragePolicyError::Storage(format!(
            "assets.binaryRouting version {} is not supported; update Svode before changing storage policy or importing files",
            routing.version
        ))),
    }
}

pub fn normalize_binary_routing(
    mut routing: BinaryRoutingConfig,
) -> Result<BinaryRoutingConfig, StoragePolicyError> {
    if routing.version != BINARY_ROUTING_VERSION {
        return Err(StoragePolicyError::Storage(format!(
            "assets.binaryRouting version {} is not supported",
            routing.version
        )));
    }
    if routing.lfs_threshold_bytes == Some(0) {
        return Err(StoragePolicyError::Storage(
            "LFS threshold must be a positive byte count".to_string(),
        ));
    }

    routing.lfs_extensions =
        normalize_extensions(routing.lfs_extensions, "LFS", "routed to Git LFS")?;
    routing.local_extensions = routing
        .local_extensions
        .map(|extensions| normalize_extensions(extensions, "local", "kept out of Git"))
        .transpose()?;
    Ok(routing)
}

/// Lowercase without the dot, sorted and unique; masks, paths and protected
/// text formats are refused.
fn normalize_extensions(
    extensions: Vec<String>,
    list: &str,
    protected_action: &str,
) -> Result<Vec<String>, StoragePolicyError> {
    let mut normalized = BTreeSet::new();
    for extension in extensions {
        let extension = extension.trim();
        if extension.is_empty() {
            continue;
        }
        let extension = extension.trim_start_matches('.').to_ascii_lowercase();
        if !valid_extension(&extension) {
            return Err(StoragePolicyError::Storage(format!(
                "invalid {list} extension `{extension}`"
            )));
        }
        if PROTECTED_EXTENSIONS.contains(&extension.as_str()) {
            return Err(StoragePolicyError::Storage(format!(
                "protected text extension `{extension}` cannot be {protected_action}"
            )));
        }
        normalized.insert(extension);
    }
    Ok(normalized.into_iter().collect())
}

fn default_local_extensions() -> Vec<String> {
    DEFAULT_LOCAL_EXTENSIONS
        .iter()
        .map(|extension| (*extension).to_string())
        .collect()
}

/// The extensions the `local` strategy keeps out of Git for `routing`.
pub fn effective_local_extensions(routing: &BinaryRoutingConfig) -> Vec<String> {
    routing
        .local_extensions
        .clone()
        .unwrap_or_else(default_local_extensions)
}

pub fn evaluate_managed_binary_route(
    config: &AssetsSpaceConfig,
    path: &str,
    size_bytes: u64,
) -> Result<ManagedBinaryRoute, StoragePolicyError> {
    let routing = supported_binary_routing(config)?;
    let (extensions, by_extension, by_threshold) = match config.strategy {
        AssetsStrategy::Local => (
            effective_local_extensions(&routing),
            ManagedBinaryRoute::LocalExtension,
            ManagedBinaryRoute::LocalThreshold,
        ),
        AssetsStrategy::InGit => return Ok(ManagedBinaryRoute::DirectGit),
        AssetsStrategy::LfsRemote | AssetsStrategy::LfsS3 => (
            routing.lfs_extensions.clone(),
            ManagedBinaryRoute::LfsExtension,
            ManagedBinaryRoute::LfsThreshold,
        ),
        AssetsStrategy::Unknown(_) => unreachable!("supported_binary_routing refuses it"),
    };
    if is_protected_source(path) {
        return Ok(ManagedBinaryRoute::DirectGit);
    }
    let extension = Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase);
    if extension
        .as_ref()
        .is_some_and(|extension| extensions.contains(extension))
    {
        return Ok(by_extension);
    }
    if routing
        .lfs_threshold_bytes
        .is_some_and(|threshold| size_bytes >= threshold)
    {
        return Ok(by_threshold);
    }
    Ok(ManagedBinaryRoute::DirectGit)
}

pub fn managed_lfs_attributes_body(routing: &BinaryRoutingConfig) -> String {
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

pub fn is_repository_lfs_candidate(path: &str, routing: &BinaryRoutingConfig) -> bool {
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

/// Whether a file of `size_bytes` at `path` needs an exact LFS rule under
/// `routing`: the repository rules leave it out (not `.assets/`, not a listed
/// format), it is not protected and it is at least the threshold.
pub fn needs_exact_lfs_rule(path: &str, size_bytes: u64, routing: &BinaryRoutingConfig) -> bool {
    routing
        .lfs_threshold_bytes
        .is_some_and(|threshold| size_bytes >= threshold)
        && !is_repository_lfs_candidate(path, routing)
        && !is_protected_source(path)
}

pub fn managed_policy_current(
    contents: &str,
    strategy: AssetsStrategy,
    routing: &BinaryRoutingConfig,
) -> bool {
    if !strategy_uses_lfs_policy(&strategy) {
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

pub fn representative_lfs_paths(routing: &BinaryRoutingConfig) -> Vec<String> {
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

pub async fn check_lfs_filters(
    cli: &GitCli,
    repo_dir: &Path,
    paths: &[String],
) -> Result<Vec<LfsFilterCheck>, StoragePolicyError> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    // The paths go through stdin: a set of any size is one call.
    let output = cli
        .exec_with_input(
            repo_dir,
            &["check-attr", "-z", "--stdin", "filter"],
            &[],
            &nul_paths_input(paths),
        )
        .await?;
    if output.exit_code != 0 {
        return Err(GitError::GitCommandFailed(format!(
            "git check-attr failed: {}",
            output.stderr.trim()
        ))
        .into());
    }

    let checks = parse_check_attr_z(&output.stdout)?;
    if checks.len() != paths.len() {
        return Err(GitError::GitCommandFailed(format!(
            "git check-attr returned {} result(s) for {} path(s)",
            checks.len(),
            paths.len()
        ))
        .into());
    }
    Ok(checks)
}

fn parse_check_attr_z(stdout: &str) -> Result<Vec<LfsFilterCheck>, StoragePolicyError> {
    let fields: Vec<&str> = stdout.split_terminator('\0').collect();
    if !fields.len().is_multiple_of(3) {
        return Err(GitError::GitCommandFailed(
            "git check-attr returned malformed NUL-delimited output".to_string(),
        )
        .into());
    }

    fields
        .chunks_exact(3)
        .map(|record| {
            if record[1] != "filter" {
                return Err(GitError::GitCommandFailed(format!(
                    "git check-attr returned unexpected attribute `{}`",
                    record[1]
                ))
                .into());
            }
            Ok(LfsFilterCheck {
                path: record[0].to_string(),
                value: record[2].to_string(),
            })
        })
        .collect()
}

/// Managed routing diagnostic for one repository: whether the generated block
/// matches the configured routing, and which dirty candidates are not covered
/// by an effective LFS filter.
pub async fn diagnose_repo_lfs_policy(
    cli: &GitCli,
    repo_dir: &Path,
    config: &AssetsSpaceConfig,
) -> Result<LfsPolicyDiagnostic, StoragePolicyError> {
    let routing = supported_binary_routing(config)?;
    let attributes = read_or_empty(&repo_dir.join(".gitattributes"))?;
    let managed_policy_current =
        managed_policy_current(&attributes, config.strategy.clone(), &routing);

    if !strategy_uses_lfs_policy(&config.strategy) {
        return Ok(LfsPolicyDiagnostic {
            managed_policy_current,
            uncovered_paths: Vec::new(),
            truncated_count: 0,
            lfs_declaration: None,
        });
    }
    let lfs_declaration = if config.strategy == AssetsStrategy::LfsS3 {
        Some(lfs_declaration_state(cli, repo_dir).await?)
    } else {
        None
    };

    let status = status::full_status(cli, repo_dir).await?;
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
        lfs_declaration,
    })
}

fn limit_uncovered_paths(mut paths: Vec<String>) -> (Vec<String>, usize) {
    let truncated_count = paths.len().saturating_sub(MAX_UNCOVERED_PATHS);
    paths.truncate(MAX_UNCOVERED_PATHS);
    (paths, truncated_count)
}

pub(super) fn case_insensitive_extension_pattern(extension: &str) -> String {
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

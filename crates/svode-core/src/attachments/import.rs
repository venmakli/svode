//! Managed attachment import: stage the source next to its owner, convert a
//! leaf Page into a folder when the owner has to exist, publish the copy under
//! a portable name, and materialize the repository routing rule for it.
//!
//! The operation owns validation, the planned touched-set, the canonical
//! content handoff and the staged cleanup. The host supplies the shared
//! runtime handles, the live Git LFS readiness evidence and the delivery of
//! the resulting invalidation.

use std::collections::{BTreeSet, HashMap};
use std::fs::{self, File, OpenOptions};
use std::future::Future;
use std::io::{self, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::pin::Pin;

use serde::Serialize;

use crate::collections::engine::relation_move_mutation_paths_with_project;
use crate::git::access::ensure_mutation_paths_were_authorized;
use crate::git::cli::GitCli;
use crate::git::path::{RootMode, normalize_repo_relative, repo_relative_from_base};
use crate::git::pending::StructuralOp;
use crate::git::state::GitRepositoryState;
use crate::index::backlinks;
use crate::index::state::IndexRuntimeState;
use crate::index::update::IndexUpdateState;
use crate::page::PageError;
use crate::page::filename;
use crate::page::identity::{
    ContentOwnerKind, SemanticIdentity, SourceShape, resolve_markdown_identity_for_path,
};
use crate::storage::config::{AssetsSpaceConfig, AssetsStrategy};
use crate::storage::managed_route::apply_managed_import_route;
use crate::storage::policy::{self, ManagedBinaryRoute};
use crate::storage::scope::resolve_assets_scope_for_key;
use crate::structure::{self, StructuralCommitSink, StructureRuntime};

use super::format::{classify_binary_path, mime_for};

/// Which surface requested the mutation. Desktop records structural history,
/// MCP explicitly commits nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MutationOrigin {
    Desktop,
    Mcp,
}

/// Live Git LFS readiness evidence. Keychain-backed credentials and the
/// installed transfer agent belong to the host, so the operation asks instead
/// of probing them itself.
pub trait LfsReadiness: Sync {
    fn lfs_ready<'a>(
        &'a self,
        repo_dir: &'a Path,
        config: &'a AssetsSpaceConfig,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>>;
}

/// Shared runtime a managed import publishes into.
pub struct ImportRuntime<'a> {
    pub index: &'a IndexRuntimeState,
    pub updates: &'a IndexUpdateState,
    pub repository: &'a GitRepositoryState,
    pub cli: Option<&'a GitCli>,
    pub commits: Option<&'a dyn StructuralCommitSink>,
    pub lfs: Option<&'a dyn LfsReadiness>,
}

impl Clone for ImportRuntime<'_> {
    fn clone(&self) -> Self {
        *self
    }
}

impl Copy for ImportRuntime<'_> {}

impl<'a> ImportRuntime<'a> {
    fn structure(&self) -> StructureRuntime<'a, GitCli> {
        StructureRuntime {
            index: self.index,
            updates: self.updates,
            git_dates: self.cli,
            commits: self.commits,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedImportSourceInfo {
    pub name: String,
    pub size_bytes: u64,
    pub mime: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedImportResult {
    pub content_path: String,
    pub attachment_path: String,
    pub markdown_url: String,
    pub cover_path: String,
    pub file_name: String,
    pub mime: String,
    pub size_bytes: u64,
    pub changed_paths: Vec<String>,
    #[serde(skip)]
    pub delivery: ManagedImportDelivery,
}

/// What the host has to invalidate after a successful import.
#[derive(Debug, Clone)]
pub struct ManagedImportDelivery {
    pub space_path: PathBuf,
    pub owner_paths: Vec<String>,
    pub attachment_path: String,
    pub canonical_content_path: String,
    pub converted_page: bool,
}

#[derive(Debug, Clone)]
pub struct ManagedImportPlan {
    project_path: PathBuf,
    repository_path: PathBuf,
    space_path: PathBuf,
    space_id: Option<String>,
    content_path: String,
    canonical_content_path: String,
    owner_path: String,
    parent_owner_path: String,
    source_path: PathBuf,
    requested_file_name: String,
    requires_conversion: bool,
    storage_strategy: AssetsStrategy,
    storage_config: AssetsSpaceConfig,
    binary_route: ManagedBinaryRoute,
    affected_paths: Vec<PathBuf>,
}

impl ManagedImportPlan {
    pub fn affected_paths(&self) -> &[PathBuf] {
        &self.affected_paths
    }
}

pub fn inspect_import_source(source_path: &str) -> Result<ManagedImportSourceInfo, PageError> {
    let source = validate_regular_source(Path::new(source_path))?;
    let metadata = fs::metadata(&source)?;
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| PageError::PathNotAccessible(source.display().to_string()))?
        .to_string();
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    Ok(ManagedImportSourceInfo {
        name,
        size_bytes: metadata.len(),
        mime: mime_for(&extension).to_string(),
    })
}

pub async fn plan_managed_import(
    index: &IndexRuntimeState,
    project_path: &Path,
    space_id: Option<&str>,
    content_path: &str,
    source_path: &Path,
    file_name: Option<&str>,
) -> Result<ManagedImportPlan, PageError> {
    let project_path = fs::canonicalize(project_path)?;
    let key = index
        .key_for_project_space_id(&project_path, space_id)
        .await?;
    let space_path = fs::canonicalize(index.dir_for_key(&key).await?)?;
    if !space_path.starts_with(&project_path) {
        return Err(PageError::PathNotAccessible(format!(
            "Space escapes Project boundary: {}",
            space_path.display()
        )));
    }

    let content_path = normalize_repo_relative(content_path, RootMode::Reject)?;
    ensure_no_symlink_components(&space_path, Path::new(&content_path))?;
    let content_abs = space_path.join(&content_path);
    let content_metadata = fs::symlink_metadata(&content_abs).map_err(|error| {
        PageError::PathNotAccessible(format!(
            "contentPath must be existing Markdown content: {error}"
        ))
    })?;
    if content_metadata.file_type().is_symlink() || !content_metadata.is_file() {
        return Err(PageError::PathNotAccessible(
            "contentPath must reference a regular Markdown Page, Collection item, or owner README"
                .to_string(),
        ));
    }
    if content_abs
        .extension()
        .and_then(|value| value.to_str())
        .is_none_or(|value| !value.eq_ignore_ascii_case("md"))
    {
        return Err(PageError::PathNotAccessible(
            "contentPath must reference Markdown content".to_string(),
        ));
    }
    let canonical_content_abs = fs::canonicalize(&content_abs)?;
    if !canonical_content_abs.starts_with(&space_path) {
        return Err(PageError::PathNotAccessible(format!(
            "contentPath escapes selected Space: {content_path}"
        )));
    }

    let identity = semantic_identity_for_path(&space_path, &content_path)?;
    if !eligible_import_identity(identity) {
        return Err(PageError::PathNotAccessible(
            "contentPath must belong to a Page, Collection item, Space README, or Collection README"
                .to_string(),
        ));
    }
    let requires_conversion = identity.is_page() && identity.source_shape == SourceShape::File;
    let (canonical_content_path, owner_path) = if requires_conversion {
        let nested = nested_content_path(&content_path)?;
        let owner = Path::new(&nested)
            .parent()
            .map(normalize_relative_display)
            .unwrap_or_else(|| ".".to_string());
        (nested, owner)
    } else {
        let owner = Path::new(&content_path)
            .parent()
            .map(normalize_relative_display)
            .unwrap_or_else(|| ".".to_string());
        (content_path.clone(), owner)
    };
    let parent_owner_path = Path::new(&content_path)
        .parent()
        .map(normalize_relative_display)
        .unwrap_or_else(|| ".".to_string());

    if requires_conversion {
        let prospective_owner = space_path.join(&owner_path);
        if fs::symlink_metadata(&prospective_owner).is_ok() {
            return Err(PageError::FileAlreadyExists(owner_path.clone()));
        }
    } else {
        ensure_no_symlink_components(&space_path, Path::new(&owner_path))?;
    }

    let source_path = validate_regular_source(source_path)?;
    let source_size = fs::metadata(&source_path)?.len();
    let requested_file_name = normalize_requested_file_name(file_name.unwrap_or_else(|| {
        source_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("file")
    }))?;
    if classify_binary_path(Path::new(&requested_file_name)).is_none() {
        return Err(PageError::Storage(format!(
            "unsupported attachment format: {requested_file_name}"
        )));
    }

    let scope = resolve_assets_scope_for_key(index, &project_path, key).await?;
    let binary_route =
        policy::evaluate_managed_binary_route(&scope.config, &requested_file_name, source_size)?;
    let mut affected_paths = if requires_conversion {
        structure::backlink_mutation_paths(
            index,
            &space_path.to_string_lossy(),
            Some(&project_path.to_string_lossy()),
            &content_path,
            false,
        )
        .await?
    } else {
        vec![space_path.join(&owner_path)]
    };
    if requires_conversion {
        affected_paths.extend(relation_move_mutation_paths_with_project(
            &space_path.to_string_lossy(),
            Some(&project_path.to_string_lossy()),
            &content_path,
            &canonical_content_path,
        )?);
        affected_paths.push(space_path.join(&content_path));
        affected_paths.push(space_path.join(&canonical_content_path));
        affected_paths.push(space_path.join(".svode/order.json"));
    }
    affected_paths.push(scope.repo_dir.clone());
    match binary_route {
        ManagedBinaryRoute::Local => {
            affected_paths.push(scope.repo_dir.join(".gitignore"));
        }
        ManagedBinaryRoute::LfsThreshold => {
            affected_paths.push(scope.repo_dir.join(".gitattributes"));
        }
        ManagedBinaryRoute::LfsExtension | ManagedBinaryRoute::DirectGit => {}
    }
    affected_paths.sort();
    affected_paths.dedup();

    Ok(ManagedImportPlan {
        project_path,
        repository_path: scope.repo_dir,
        space_path,
        space_id: space_id.map(ToString::to_string),
        content_path,
        canonical_content_path,
        owner_path,
        parent_owner_path,
        source_path,
        requested_file_name,
        requires_conversion,
        storage_strategy: scope.config.strategy,
        storage_config: scope.config,
        binary_route,
        affected_paths,
    })
}

pub async fn execute_managed_import(
    runtime: ImportRuntime<'_>,
    origin: MutationOrigin,
    plan: ManagedImportPlan,
) -> Result<ManagedImportResult, PageError> {
    debug_assert!(origin != MutationOrigin::Mcp || runtime.commits.is_none());
    let revalidated = plan_managed_import(
        runtime.index,
        &plan.project_path,
        plan.space_id.as_deref(),
        &plan.content_path,
        &plan.source_path,
        Some(&plan.requested_file_name),
    )
    .await?;
    ensure_mutation_paths_were_authorized(revalidated.affected_paths())?;

    if matches!(
        revalidated.binary_route,
        ManagedBinaryRoute::LfsExtension | ManagedBinaryRoute::LfsThreshold
    ) {
        let ready = match runtime.lfs {
            Some(probe) => {
                probe
                    .lfs_ready(&revalidated.repository_path, &revalidated.storage_config)
                    .await
            }
            None => false,
        };
        if !ready {
            return Err(PageError::Storage(
                "Git LFS route is not ready; repair the configured backend before importing"
                    .to_string(),
            ));
        }
    }

    let before = fingerprint_candidates(revalidated.affected_paths());
    let temp_parent = if revalidated.requires_conversion {
        revalidated
            .space_path
            .join(&revalidated.content_path)
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| PageError::PathNotAccessible(revalidated.content_path.clone()))?
    } else {
        revalidated.space_path.join(&revalidated.owner_path)
    };
    let staged_source = revalidated.source_path.clone();
    let temp_path = tokio::task::spawn_blocking(move || staged_copy(&staged_source, &temp_parent))
        .await
        .map_err(|error| {
            PageError::Storage(format!("managed import copy task failed: {error}"))
        })??;

    let mutation = async {
        if revalidated.requires_conversion {
            structure::convert_to_folder(
                &revalidated.space_path.to_string_lossy(),
                &revalidated.content_path,
                Some(&revalidated.project_path.to_string_lossy()),
                runtime.structure(),
            )
            .await?;
        }

        let owner_abs = revalidated.space_path.join(&revalidated.owner_path);
        let (attachment_abs, file_name) =
            publish_staged_copy(&temp_path, &owner_abs, &revalidated.requested_file_name)?;
        let repository_attachment_path = repo_relative_from_base(
            &revalidated.repository_path,
            &attachment_abs,
            RootMode::Reject,
        )?;
        let policy_paths = match apply_managed_import_route(
            runtime.repository,
            runtime.cli,
            &revalidated.repository_path,
            revalidated.binary_route,
            &repository_attachment_path,
        )
        .await
        {
            Ok(paths) => paths,
            Err(error) => {
                let _ = fs::remove_file(&attachment_abs);
                return Err(error.into());
            }
        };
        let metadata = fs::metadata(&attachment_abs)?;
        let attachment_path =
            repo_relative_from_base(&revalidated.space_path, &attachment_abs, RootMode::Reject)?;
        let markdown_url = backlinks::make_relative_link_between(
            &revalidated
                .space_path
                .join(&revalidated.canonical_content_path),
            &attachment_abs,
        );
        let cover_path = backlinks::make_relative_path(&revalidated.space_path, &attachment_abs);
        let extension = attachment_abs
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();

        if let Some(commits) = runtime.commits {
            let mut commit_paths = policy_paths.clone();
            if revalidated.storage_strategy != AssetsStrategy::Local {
                commit_paths.push(attachment_abs.clone());
            }
            if !commit_paths.is_empty() {
                commits.schedule(
                    &revalidated.project_path,
                    &revalidated.repository_path,
                    StructuralOp::Create(file_name.clone()),
                    commit_paths,
                );
            }
        }

        let mut candidates = revalidated.affected_paths.clone();
        candidates.push(attachment_abs.clone());
        candidates.extend(policy_paths);
        let changed_paths = changed_project_paths(&before, &candidates, &revalidated.project_path);
        let mut owner_paths = BTreeSet::from([revalidated.owner_path.clone()]);
        if revalidated.requires_conversion {
            owner_paths.insert(revalidated.parent_owner_path.clone());
        }

        Ok(ManagedImportResult {
            content_path: revalidated.canonical_content_path.clone(),
            attachment_path: attachment_path.clone(),
            markdown_url,
            cover_path,
            file_name,
            mime: mime_for(&extension).to_string(),
            size_bytes: metadata.len(),
            changed_paths,
            delivery: ManagedImportDelivery {
                space_path: revalidated.space_path.clone(),
                owner_paths: owner_paths.into_iter().collect(),
                attachment_path,
                canonical_content_path: revalidated.canonical_content_path.clone(),
                converted_page: revalidated.requires_conversion,
            },
        })
    }
    .await;

    if temp_path.exists() {
        let _ = fs::remove_file(&temp_path);
    }
    mutation
}

fn eligible_import_identity(identity: SemanticIdentity) -> bool {
    identity.is_page()
        || matches!(
            identity.owner_kind,
            Some(ContentOwnerKind::Space | ContentOwnerKind::Collection)
        )
}

fn semantic_identity_for_path(space: &Path, path: &str) -> Result<SemanticIdentity, PageError> {
    Ok(resolve_markdown_identity_for_path(
        space,
        path,
        crate::index::knowledge::is_agent_context_source(path),
    )?)
}

fn nested_content_path(path: &str) -> Result<String, PageError> {
    let path = normalize_repo_relative(path, RootMode::Reject)?;
    let stem = Path::new(&path)
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| PageError::PathNotAccessible(path.clone()))?;
    let parent = Path::new(&path).parent().unwrap_or(Path::new(""));
    Ok(if parent.as_os_str().is_empty() {
        format!("{stem}/README.md")
    } else {
        format!("{}/{stem}/README.md", normalize_relative_display(parent))
    })
}

fn validate_regular_source(path: &Path) -> Result<PathBuf, PageError> {
    if !path.is_absolute() {
        return Err(PageError::PathNotAccessible(
            "sourcePath must be an absolute path to a readable local regular file".to_string(),
        ));
    }
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        PageError::PathNotAccessible(format!(
            "sourcePath could not be inspected ({}): {error}",
            path.display()
        ))
    })?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err(PageError::PathNotAccessible(
            "sourcePath must point to a regular file, not a directory or symbolic link".to_string(),
        ));
    }
    fs::canonicalize(path).map_err(PageError::Io)
}

fn normalize_requested_file_name(value: &str) -> Result<String, PageError> {
    let candidate = value.rsplit(['/', '\\']).next().unwrap_or_default().trim();
    if candidate.is_empty() || matches!(candidate, "." | "..") {
        return Err(PageError::PathNotAccessible(
            "attachment file name is invalid".to_string(),
        ));
    }
    Ok(candidate.to_string())
}

fn ensure_no_symlink_components(root: &Path, relative: &Path) -> Result<(), PageError> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(PageError::PathNotAccessible(format!(
                    "managed import path contains a symbolic link: {}",
                    current.display()
                )));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => break,
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn staged_copy(source: &Path, parent: &Path) -> Result<PathBuf, PageError> {
    if !parent.is_dir() {
        return Err(PageError::PathNotAccessible(parent.display().to_string()));
    }
    let temp = parent.join(format!(".svode-import-{}.tmp", ulid::Ulid::new()));
    let result = (|| {
        let source_file = File::open(source)?;
        let mut target = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        {
            let mut writer = BufWriter::new(&mut target);
            io::copy(&mut BufReader::new(source_file), &mut writer)?;
            writer.flush()?;
        }
        target.sync_all()?;
        Ok::<_, io::Error>(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temp);
        return Err(PageError::Io(error));
    }
    Ok(temp)
}

fn publish_staged_copy(
    temp: &Path,
    owner: &Path,
    requested_name: &str,
) -> Result<(PathBuf, String), PageError> {
    let requested = Path::new(requested_name);
    let extension = requested.extension().and_then(|value| value.to_str());
    let stem = requested
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("file");
    let projection = filename::project(stem);

    for _ in 0..=10_000 {
        let (target, _) = filename::allocate_available_path(owner, &projection, extension)?;
        match fs::hard_link(temp, &target) {
            Ok(()) => {
                let file_name = target
                    .file_name()
                    .and_then(|value| value.to_str())
                    .ok_or_else(|| PageError::PathNotAccessible(target.display().to_string()))?
                    .to_string();
                if let Err(error) = fs::remove_file(temp) {
                    tracing::warn!(
                        temp = %temp.display(),
                        "managed import published but temp cleanup failed: {error}"
                    );
                }
                sync_directory(owner);
                return Ok((target, file_name));
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Err(PageError::FileAlreadyExists(
        "could not allocate a portable attachment filename".to_string(),
    ))
}

fn sync_directory(path: &Path) {
    #[cfg(unix)]
    if let Err(error) = File::open(path).and_then(|directory| directory.sync_all()) {
        tracing::warn!(directory = %path.display(), "managed import directory sync failed: {error}");
    }
}

fn fingerprint_candidates(paths: &[PathBuf]) -> HashMap<PathBuf, Option<FileFingerprint>> {
    paths
        .iter()
        .map(|path| (path.clone(), file_fingerprint(path)))
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum FileFingerprint {
    Content(Vec<u8>),
    Metadata { len: u64, modified_nanos: u128 },
}

fn file_fingerprint(path: &Path) -> Option<FileFingerprint> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return None;
    }
    let should_hash_content = path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "md" | "yaml" | "yml" | "json"
            )
        });
    if should_hash_content {
        return fs::read(path).ok().map(|bytes| {
            use sha2::{Digest, Sha256};
            FileFingerprint::Content(Sha256::digest(bytes).to_vec())
        });
    }
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    Some(FileFingerprint::Metadata {
        len: metadata.len(),
        modified_nanos,
    })
}

fn changed_project_paths(
    before: &HashMap<PathBuf, Option<FileFingerprint>>,
    candidates: &[PathBuf],
    project: &Path,
) -> Vec<String> {
    let mut paths = BTreeSet::new();
    for path in candidates {
        let after = file_fingerprint(path);
        if before.get(path).is_some_and(|value| *value == after)
            || before.get(path).is_none() && after.is_none()
        {
            continue;
        }
        if let Ok(relative) = repo_relative_from_base(project, path, RootMode::Reject) {
            paths.insert(relative);
        }
    }
    paths.into_iter().collect()
}

fn normalize_relative_display(path: &Path) -> String {
    if path.as_os_str().is_empty() {
        ".".to_string()
    } else {
        path.to_string_lossy().replace('\\', "/")
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

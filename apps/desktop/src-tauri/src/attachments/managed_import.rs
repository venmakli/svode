use std::collections::{BTreeSet, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::artifact::identity::{
    ContentOwnerKind, MarkdownIdentityFacts, SemanticIdentity, SourceShape,
    resolve_markdown_identity,
};
use crate::commands::files as file_commands;
use crate::files::{backlinks, filename};
use crate::git::access::ensure_mutation_paths_were_authorized;
use crate::git::autocommit::{AutocommitService, StructuralOp};
use crate::index::IndexState;
use crate::properties;
use crate::repo_path::{RootMode, normalize_repo_relative, repo_relative_from_base};
use crate::space::types::{AssetsSpaceConfig, AssetsStrategy};
use crate::storage::{
    assets, policy, scope::resolve_effective_storage_scope_for_key,
    strategy::apply_managed_import_route,
};
use crate::{AppError, system_path};

use super::source::classify_binary_path;

static MANAGED_IMPORT_GENERATION: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MutationOrigin {
    Desktop,
    Mcp,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagedImportSourceInfo {
    pub name: String,
    pub size_bytes: u64,
    pub mime: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagedImportResult {
    pub content_path: String,
    pub attachment_path: String,
    pub markdown_url: String,
    pub cover_path: String,
    pub file_name: String,
    pub mime: String,
    pub size_bytes: u64,
    pub changed_paths: Vec<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ManagedImportPlan {
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
    binary_route: policy::ManagedBinaryRoute,
    affected_paths: Vec<PathBuf>,
}

impl ManagedImportPlan {
    pub(crate) fn affected_paths(&self) -> &[PathBuf] {
        &self.affected_paths
    }
}

pub(crate) fn inspect_import_source(
    source_path: &str,
) -> Result<ManagedImportSourceInfo, AppError> {
    let source = validate_regular_source(Path::new(source_path))?;
    let metadata = fs::metadata(&source)?;
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| AppError::PathNotAccessible(source.display().to_string()))?
        .to_string();
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    Ok(ManagedImportSourceInfo {
        name,
        size_bytes: metadata.len(),
        mime: assets::mime_for(&extension).to_string(),
    })
}

pub(crate) async fn plan_managed_import(
    index_state: &IndexState,
    project_path: &Path,
    space_id: Option<&str>,
    content_path: &str,
    source_path: &Path,
    file_name: Option<&str>,
) -> Result<ManagedImportPlan, AppError> {
    let project_path = fs::canonicalize(project_path)?;
    let key = index_state
        .key_for_project_space_id(&project_path, space_id)
        .await?;
    let space_path = fs::canonicalize(index_state.dir_for_key(&key).await?)?;
    if !space_path.starts_with(&project_path) {
        return Err(AppError::PathNotAccessible(format!(
            "Space escapes Project boundary: {}",
            space_path.display()
        )));
    }

    let content_path = normalize_repo_relative(content_path, RootMode::Reject)?;
    ensure_no_symlink_components(&space_path, Path::new(&content_path))?;
    let content_abs = space_path.join(&content_path);
    let content_metadata = fs::symlink_metadata(&content_abs).map_err(|error| {
        AppError::PathNotAccessible(format!(
            "contentPath must be existing Markdown content: {error}"
        ))
    })?;
    if content_metadata.file_type().is_symlink() || !content_metadata.is_file() {
        return Err(AppError::PathNotAccessible(
            "contentPath must reference a regular Markdown Page, Collection item, or owner README"
                .to_string(),
        ));
    }
    if content_abs
        .extension()
        .and_then(|value| value.to_str())
        .is_none_or(|value| !value.eq_ignore_ascii_case("md"))
    {
        return Err(AppError::PathNotAccessible(
            "contentPath must reference Markdown content".to_string(),
        ));
    }
    let canonical_content_abs = fs::canonicalize(&content_abs)?;
    if !canonical_content_abs.starts_with(&space_path) {
        return Err(AppError::PathNotAccessible(format!(
            "contentPath escapes selected Space: {content_path}"
        )));
    }

    let identity = semantic_identity_for_path(&space_path, &content_path)?;
    if !eligible_import_identity(identity) {
        return Err(AppError::PathNotAccessible(
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
            return Err(AppError::FileAlreadyExists(owner_path.clone()));
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
        return Err(AppError::Storage(format!(
            "unsupported attachment format: {requested_file_name}"
        )));
    }

    let scope = resolve_effective_storage_scope_for_key(index_state, &project_path, key).await?;
    let binary_route =
        policy::evaluate_managed_binary_route(&scope.config, &requested_file_name, source_size)?;
    let mut affected_paths = if requires_conversion {
        file_commands::entry_backlink_mutation_paths(
            index_state,
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
        affected_paths.extend(properties::relation_move_mutation_paths_with_project(
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
        policy::ManagedBinaryRoute::Local => {
            affected_paths.push(scope.repo_dir.join(".gitignore"));
        }
        policy::ManagedBinaryRoute::LfsThreshold => {
            affected_paths.push(scope.repo_dir.join(".gitattributes"));
        }
        policy::ManagedBinaryRoute::LfsExtension | policy::ManagedBinaryRoute::DirectGit => {}
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

pub(crate) async fn execute_managed_import(
    app: &AppHandle,
    index_state: &IndexState,
    autocommit: Option<&Arc<AutocommitService>>,
    origin: MutationOrigin,
    plan: ManagedImportPlan,
) -> Result<ManagedImportResult, AppError> {
    debug_assert!(origin != MutationOrigin::Mcp || autocommit.is_none());
    let revalidated = plan_managed_import(
        index_state,
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
        policy::ManagedBinaryRoute::LfsExtension | policy::ManagedBinaryRoute::LfsThreshold
    ) {
        let state = crate::storage::lfs::probe_lfs_config(
            app,
            &revalidated.repository_path,
            &revalidated.storage_config,
        )
        .await;
        if state != crate::storage::lfs::LfsState::Ready {
            return Err(AppError::Storage(
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
            .ok_or_else(|| AppError::PathNotAccessible(revalidated.content_path.clone()))?
    } else {
        revalidated.space_path.join(&revalidated.owner_path)
    };
    let staged_source = revalidated.source_path.clone();
    let temp_path = tokio::task::spawn_blocking(move || staged_copy(&staged_source, &temp_parent))
        .await
        .map_err(|error| {
            AppError::Storage(format!("managed import copy task failed: {error}"))
        })??;

    let mutation = async {
        if revalidated.requires_conversion {
            file_commands::convert_entry_to_folder_shared(
                &revalidated.space_path.to_string_lossy(),
                &revalidated.content_path,
                Some(&revalidated.project_path.to_string_lossy()),
                index_state,
                autocommit.map(AsRef::as_ref),
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
        let git_state = app.state::<crate::git::GitState>();
        let policy_paths = match apply_managed_import_route(
            &git_state,
            &revalidated.repository_path,
            revalidated.binary_route,
            &repository_attachment_path,
        )
        .await
        {
            Ok(paths) => paths,
            Err(error) => {
                let _ = fs::remove_file(&attachment_abs);
                return Err(error);
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

        if let Some(autocommit) = autocommit {
            let mut commit_paths = policy_paths.clone();
            if revalidated.storage_strategy != AssetsStrategy::Local {
                commit_paths.push(attachment_abs.clone());
            }
            if !commit_paths.is_empty() {
                autocommit.schedule_structural_paths(
                    revalidated.project_path.clone(),
                    revalidated.repository_path.clone(),
                    StructuralOp::Create(file_name.clone()),
                    commit_paths,
                );
            }
        }

        let mut candidates = revalidated.affected_paths.clone();
        candidates.push(attachment_abs.clone());
        candidates.extend(policy_paths);
        let changed_paths = changed_project_paths(&before, &candidates, &revalidated.project_path);
        emit_import_invalidations(app, &revalidated, &attachment_path);

        Ok(ManagedImportResult {
            content_path: revalidated.canonical_content_path.clone(),
            attachment_path,
            markdown_url,
            cover_path,
            file_name,
            mime: assets::mime_for(&extension).to_string(),
            size_bytes: metadata.len(),
            changed_paths,
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

fn semantic_identity_for_path(space: &Path, path: &str) -> Result<SemanticIdentity, AppError> {
    let direct_collection_root = Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| name.eq_ignore_ascii_case("README.md"))
        .and_then(|_| Path::new(path).parent())
        .filter(|parent| space.join(parent).join("schema.yaml").is_file())
        .map(normalize_relative_display);
    let collection_root = match direct_collection_root {
        Some(root) => Some(root),
        None => properties::resolve_collection_schema_result(&space.to_string_lossy(), path)?
            .map(|(_, root)| normalize_relative_display(&root)),
    };
    let source_shape = if Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("README.md"))
    {
        SourceShape::Directory
    } else {
        SourceShape::File
    };
    Ok(resolve_markdown_identity(MarkdownIdentityFacts {
        path,
        source_shape,
        collection_root: collection_root.as_deref(),
        agent_context: crate::index::knowledge::is_agent_context_source(path),
    }))
}

fn nested_content_path(path: &str) -> Result<String, AppError> {
    let path = normalize_repo_relative(path, RootMode::Reject)?;
    let stem = Path::new(&path)
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| AppError::PathNotAccessible(path.clone()))?;
    let parent = Path::new(&path).parent().unwrap_or(Path::new(""));
    Ok(if parent.as_os_str().is_empty() {
        format!("{stem}/README.md")
    } else {
        format!("{}/{stem}/README.md", normalize_relative_display(parent))
    })
}

fn validate_regular_source(path: &Path) -> Result<PathBuf, AppError> {
    if !path.is_absolute() {
        return Err(AppError::PathNotAccessible(
            "sourcePath must be an absolute path to a readable local regular file".to_string(),
        ));
    }
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        AppError::PathNotAccessible(format!(
            "sourcePath could not be inspected ({}): {error}",
            path.display()
        ))
    })?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err(AppError::PathNotAccessible(
            "sourcePath must point to a regular file, not a directory or symbolic link".to_string(),
        ));
    }
    fs::canonicalize(path).map_err(AppError::Io)
}

fn normalize_requested_file_name(value: &str) -> Result<String, AppError> {
    let candidate = value.rsplit(['/', '\\']).next().unwrap_or_default().trim();
    if candidate.is_empty() || matches!(candidate, "." | "..") {
        return Err(AppError::PathNotAccessible(
            "attachment file name is invalid".to_string(),
        ));
    }
    Ok(candidate.to_string())
}

fn ensure_no_symlink_components(root: &Path, relative: &Path) -> Result<(), AppError> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(AppError::PathNotAccessible(format!(
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

fn staged_copy(source: &Path, parent: &Path) -> Result<PathBuf, AppError> {
    if !parent.is_dir() {
        return Err(AppError::PathNotAccessible(parent.display().to_string()));
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
        return Err(AppError::Io(error));
    }
    Ok(temp)
}

fn publish_staged_copy(
    temp: &Path,
    owner: &Path,
    requested_name: &str,
) -> Result<(PathBuf, String), AppError> {
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
                    .ok_or_else(|| AppError::PathNotAccessible(target.display().to_string()))?
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
    Err(AppError::FileAlreadyExists(
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

fn emit_import_invalidations(app: &AppHandle, plan: &ManagedImportPlan, attachment_path: &str) {
    let generation = MANAGED_IMPORT_GENERATION.fetch_add(1, Ordering::Relaxed);
    let mut owners = BTreeSet::from([plan.owner_path.clone()]);
    if plan.requires_conversion {
        owners.insert(plan.parent_owner_path.clone());
    }
    for owner_path in owners {
        let mut changes = vec![serde_json::json!({
            "path": attachment_path,
            "kind": "binary",
        })];
        if plan.requires_conversion {
            changes.push(serde_json::json!({
                "path": plan.canonical_content_path,
                "kind": "page",
            }));
        }
        if let Err(error) = app.emit(
            "attachments:invalidated",
            serde_json::json!({
                "spacePath": system_path::user_facing_path(&plan.space_path),
                "ownerPath": owner_path,
                "generation": generation,
                "changes": changes,
            }),
        ) {
            tracing::warn!("managed import invalidation failed: {error}");
        }
    }
}

fn normalize_relative_display(path: &Path) -> String {
    if path.as_os_str().is_empty() {
        ".".to_string()
    } else {
        path.to_string_lossy().replace('\\', "/")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::config::write_space_config;
    use crate::space::types::{
        AssetsSpaceConfig, AssetsStrategy, BinaryRoutingConfig, SpaceConfig,
    };

    #[test]
    fn source_validation_rejects_symlinks_and_directories() {
        let temp = tempfile::tempdir().unwrap();
        assert!(validate_regular_source(temp.path()).is_err());

        let source = temp.path().join("photo.png");
        fs::write(&source, b"image").unwrap();
        assert_eq!(
            inspect_import_source(source.to_string_lossy().as_ref())
                .unwrap()
                .size_bytes,
            5
        );

        #[cfg(unix)]
        {
            let link = temp.path().join("photo-link.png");
            std::os::unix::fs::symlink(&source, &link).unwrap();
            assert!(validate_regular_source(&link).is_err());
        }
    }

    #[test]
    fn staged_publish_is_complete_and_allocates_collision() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.png");
        let owner = temp.path().join("owner");
        fs::create_dir(&owner).unwrap();
        fs::write(&source, b"complete-image").unwrap();
        fs::write(owner.join("photo.png"), b"existing").unwrap();

        let staged = staged_copy(&source, temp.path()).unwrap();
        let (published, name) = publish_staged_copy(&staged, &owner, "photo.png").unwrap();

        assert_eq!(name, "photo-1.png");
        assert_eq!(fs::read(published).unwrap(), b"complete-image");
        assert!(!staged.exists());
    }

    #[test]
    fn canonical_leaf_handoff_keeps_parent_and_readme_shape() {
        assert_eq!(nested_content_path("note.md").unwrap(), "note/README.md");
        assert_eq!(
            nested_content_path("docs/note.md").unwrap(),
            "docs/note/README.md"
        );
    }

    #[test]
    fn requested_name_is_reprojected_from_a_basename() {
        assert_eq!(
            normalize_requested_file_name("../../Quarterly Report.PDF").unwrap(),
            "Quarterly Report.PDF"
        );
        assert!(normalize_requested_file_name("..").is_err());
        assert!(normalize_requested_file_name("/").is_err());
    }

    #[tokio::test]
    async fn leaf_plan_names_the_canonical_handoff_and_structural_paths() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        fs::create_dir_all(&project).unwrap();
        write_space_config(
            &project,
            &SpaceConfig {
                name: "Project".into(),
                description: String::new(),
                icon: "folder".into(),
                spaces: None,
                agent: None,
                defaults: None,
                git: None,
                assets: None,
                tree: None,
            },
        )
        .unwrap();
        fs::write(project.join("note.md"), "---\ntitle: Note\n---\n").unwrap();
        let source = temp.path().join("photo.png");
        fs::write(&source, b"image").unwrap();

        let plan =
            plan_managed_import(&IndexState::new(), &project, None, "note.md", &source, None)
                .await
                .unwrap();

        assert!(plan.requires_conversion);
        assert_eq!(plan.canonical_content_path, "note/README.md");
        assert_eq!(plan.owner_path, "note");
        assert!(
            plan.affected_paths
                .contains(&plan.project_path.join("note.md"))
        );
        assert!(
            plan.affected_paths
                .contains(&plan.project_path.join("note/README.md"))
        );
        assert!(
            plan.affected_paths
                .contains(&plan.project_path.join(".svode/order.json"))
        );
    }

    #[tokio::test]
    async fn managed_import_plan_uses_threshold_and_protects_svg_from_lfs() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        fs::create_dir_all(&project).unwrap();
        write_space_config(
            &project,
            &SpaceConfig {
                name: "Project".into(),
                description: String::new(),
                icon: "folder".into(),
                spaces: None,
                agent: None,
                defaults: None,
                git: None,
                assets: Some(AssetsSpaceConfig {
                    strategy: AssetsStrategy::LfsRemote,
                    binary_routing: Some(BinaryRoutingConfig {
                        version: 1,
                        lfs_extensions: vec!["psd".into()],
                        lfs_threshold_bytes: Some(4),
                        extensions: Default::default(),
                    }),
                    s3: None,
                }),
                tree: None,
            },
        )
        .unwrap();
        fs::write(project.join("README.md"), "---\ntitle: Project\n---\n").unwrap();
        let archive = temp.path().join("archive.pdf");
        fs::write(&archive, b"large").unwrap();
        let svg = temp.path().join("diagram.svg");
        fs::write(&svg, b"<svg/>").unwrap();

        let threshold = plan_managed_import(
            &IndexState::new(),
            &project,
            None,
            "README.md",
            &archive,
            None,
        )
        .await
        .unwrap();
        let protected =
            plan_managed_import(&IndexState::new(), &project, None, "README.md", &svg, None)
                .await
                .unwrap();

        assert_eq!(
            threshold.binary_route,
            policy::ManagedBinaryRoute::LfsThreshold
        );
        assert_eq!(
            protected.binary_route,
            policy::ManagedBinaryRoute::DirectGit
        );
    }

    #[tokio::test]
    async fn managed_import_plan_rejects_unknown_binary_routing_version() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        fs::create_dir_all(&project).unwrap();
        write_space_config(
            &project,
            &SpaceConfig {
                name: "Project".into(),
                description: String::new(),
                icon: "folder".into(),
                spaces: None,
                agent: None,
                defaults: None,
                git: None,
                assets: Some(AssetsSpaceConfig {
                    strategy: AssetsStrategy::LfsRemote,
                    binary_routing: Some(BinaryRoutingConfig {
                        version: 2,
                        lfs_extensions: vec!["png".into()],
                        lfs_threshold_bytes: None,
                        extensions: Default::default(),
                    }),
                    s3: None,
                }),
                tree: None,
            },
        )
        .unwrap();
        fs::write(project.join("README.md"), "---\ntitle: Project\n---\n").unwrap();
        let source = temp.path().join("photo.png");
        fs::write(&source, b"image").unwrap();

        let error = plan_managed_import(
            &IndexState::new(),
            &project,
            None,
            "README.md",
            &source,
            None,
        )
        .await
        .expect_err("unknown routing must fail closed");

        assert!(error.to_string().contains("version 2 is not supported"));
    }
}

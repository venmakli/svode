use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::AppError;
use crate::artifact::identity::{
    ArtifactKind, MarkdownIdentityFacts, SourceShape, resolve_markdown_identity,
};
use crate::files::tree::{
    child_folder_names, has_direct_schema, read_frontmatter_meta_head,
    read_frontmatter_meta_head_with_fallback,
};
use crate::git::dates::derive_date_overrides;
use crate::repo_path::{RootMode, normalize_repo_relative};
use crate::space::config::read_space_config;
use crate::space::project::{normalize_space_folder, space_ref_status};
use crate::space::types::SpaceStatus;
use crate::system_path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AttachmentAvailability {
    Available,
    Limited,
    ExternalOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AttachmentKind {
    Page,
    Collection,
    App,
    Directory,
    Document,
    Media,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentItem {
    pub key: String,
    pub path: String,
    pub source_shape: SourceShape,
    pub kind: AttachmentKind,
    pub content_path: Option<String>,
    pub owner_path: Option<String>,
    pub source_path: String,
    pub has_app: bool,
    pub has_children: bool,
    pub icon: Option<String>,
    pub format: String,
    pub availability: AttachmentAvailability,
    pub display_name: String,
    pub modified: String,
    pub size_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentSourceDiagnostic {
    pub code: &'static str,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentOwnerIdentity {
    pub project_path: String,
    pub space_id: Option<String>,
    pub space_path: String,
    pub owner_path: String,
    pub repository_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentsSnapshot {
    pub owner: AttachmentOwnerIdentity,
    pub generation: String,
    pub items: Vec<AttachmentItem>,
    pub diagnostics: Vec<AttachmentSourceDiagnostic>,
}

#[derive(Debug, Clone)]
pub(crate) struct ResolvedRegisteredOwner {
    pub project_path: PathBuf,
    pub space_id: Option<String>,
    pub space_path: PathBuf,
    pub repository_path: PathBuf,
    pub owner_path: PathBuf,
    pub owner_relative_path: String,
}

pub(crate) fn resolve_registered_owner(
    project_path: &Path,
    space_id: Option<&str>,
) -> Result<ResolvedRegisteredOwner, AppError> {
    let project_metadata = fs::symlink_metadata(project_path).map_err(|error| {
        AppError::PathNotAccessible(format!(
            "cannot inspect registered Project {}: {error}",
            project_path.display()
        ))
    })?;
    if !project_metadata.is_dir() || project_metadata.file_type().is_symlink() {
        return Err(AppError::PathNotAccessible(format!(
            "registered Project is not a regular directory: {}",
            project_path.display()
        )));
    }

    let project_path = fs::canonicalize(project_path)?;
    let config = read_space_config(&project_path)?;
    let (resolved_space_id, space_path) = match space_id {
        None => (None, project_path.clone()),
        Some(requested_id) => {
            let reference = config
                .spaces
                .as_deref()
                .unwrap_or_default()
                .iter()
                .find(|reference| reference.id == requested_id)
                .ok_or_else(|| AppError::SpaceNotFound(requested_id.to_string()))?;
            if space_ref_status(&project_path, reference) != SpaceStatus::Ready {
                return Err(AppError::SpaceNotFound(requested_id.to_string()));
            }
            let folder = normalize_space_folder(&reference.path)?;
            (Some(requested_id.to_string()), project_path.join(folder))
        }
    };

    let space_metadata = fs::symlink_metadata(&space_path).map_err(|error| {
        AppError::PathNotAccessible(format!(
            "cannot inspect registered owner {}: {error}",
            space_path.display()
        ))
    })?;
    if !space_metadata.is_dir() || space_metadata.file_type().is_symlink() {
        return Err(AppError::PathNotAccessible(format!(
            "registered owner is not a regular directory: {}",
            space_path.display()
        )));
    }
    let space_path = fs::canonicalize(&space_path)?;
    if !space_path.starts_with(&project_path) {
        return Err(AppError::PathNotAccessible(format!(
            "registered owner escapes Project boundary: {}",
            space_path.display()
        )));
    }

    let repository_path =
        if resolved_space_id.is_some() && fs::symlink_metadata(space_path.join(".git")).is_ok() {
            space_path.clone()
        } else {
            project_path.clone()
        };

    Ok(ResolvedRegisteredOwner {
        project_path,
        space_id: resolved_space_id,
        owner_path: space_path.clone(),
        owner_relative_path: ".".to_string(),
        space_path,
        repository_path,
    })
}

pub(crate) fn resolve_attachment_owner(
    project_path: &Path,
    space_id: Option<&str>,
    owner_path: Option<&str>,
) -> Result<ResolvedRegisteredOwner, AppError> {
    let mut owner = resolve_registered_owner(project_path, space_id)?;
    let requested = owner_path.unwrap_or(".");
    if requested == "." {
        return Ok(owner);
    }

    let normalized = normalize_repo_relative(requested, RootMode::Reject)?;
    ensure_owner_path_components(&owner.space_path, Path::new(&normalized))?;
    let candidate = owner.space_path.join(&normalized);
    let metadata = fs::symlink_metadata(&candidate).map_err(|error| {
        AppError::PathNotAccessible(format!(
            "cannot inspect attachment owner {}: {error}",
            candidate.display()
        ))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(AppError::PathNotAccessible(format!(
            "attachment owner is not a regular directory: {}",
            candidate.display()
        )));
    }
    if has_direct_schema(&candidate) {
        return Err(AppError::PathNotAccessible(format!(
            "path is not a directory-backed Page owner: {normalized}"
        )));
    }
    let readme = direct_readme(&candidate)?.ok_or_else(|| {
        AppError::PathNotAccessible(format!(
            "directory-backed Page owner has no README.md: {normalized}"
        ))
    })?;
    let readme_metadata = fs::symlink_metadata(&readme)?;
    if readme_metadata.file_type().is_symlink() || !readme_metadata.is_file() {
        return Err(AppError::PathNotAccessible(format!(
            "directory-backed Page README.md is not a regular file: {normalized}"
        )));
    }
    let canonical = fs::canonicalize(&candidate)?;
    if !canonical.starts_with(&owner.space_path) {
        return Err(AppError::PathNotAccessible(format!(
            "attachment owner escapes Space boundary: {normalized}"
        )));
    }
    owner.owner_path = canonical;
    owner.owner_relative_path = normalized;
    Ok(owner)
}

fn ensure_owner_path_components(space_path: &Path, relative: &Path) -> Result<(), AppError> {
    let mut current = space_path.to_path_buf();
    for component in relative.components() {
        let name = component.as_os_str().to_string_lossy();
        if is_system_source(&name)
            || is_agent_context_source(&name)
            || child_folder_names(&current).contains(name.as_ref())
        {
            return Err(AppError::PathNotAccessible(
                "attachment owner crosses an excluded boundary".into(),
            ));
        }
        current.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&current)?;
        if metadata.file_type().is_symlink() {
            return Err(AppError::PathNotAccessible(format!(
                "attachment owner path contains a symbolic link: {}",
                current.display()
            )));
        }
    }
    Ok(())
}

pub(crate) async fn list_registered_owner(
    owner: ResolvedRegisteredOwner,
) -> Result<AttachmentsSnapshot, AppError> {
    list_owner_snapshot(owner, true).await
}

pub(crate) async fn list_attachment_branch(
    owner: ResolvedRegisteredOwner,
    branch_path: &str,
) -> Result<AttachmentsSnapshot, AppError> {
    let normalized = normalize_repo_relative(branch_path, RootMode::Reject)?;
    let relative = Path::new(&normalized)
        .strip_prefix(if owner.owner_relative_path == "." {
            Path::new("")
        } else {
            Path::new(&owner.owner_relative_path)
        })
        .map_err(|_| AppError::PathNotAccessible("attachment branch escapes owner".into()))?;
    if relative.as_os_str().is_empty() {
        return Err(AppError::PathNotAccessible(
            "attachment branch must be a descendant".into(),
        ));
    }
    let mut current = owner.owner_path.clone();
    for component in relative.components() {
        let name = component.as_os_str().to_string_lossy();
        if is_system_source(&name)
            || is_agent_context_source(&name)
            || child_folder_names(&current).contains(name.as_ref())
        {
            return Err(AppError::PathNotAccessible(
                "attachment branch crosses an excluded boundary".into(),
            ));
        }
        current.push(component);
        let metadata = fs::symlink_metadata(&current)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(AppError::PathNotAccessible(
                "attachment branch is not a regular directory".into(),
            ));
        }
        let readme = direct_readme(&current)?;
        for marker in [current.join("schema.yaml"), current.join("app.yaml")]
            .iter()
            .chain(readme.iter())
        {
            if fs::symlink_metadata(marker).is_ok_and(|meta| meta.file_type().is_symlink()) {
                return Err(AppError::PathNotAccessible(
                    "attachment branch has a linked marker".into(),
                ));
            }
        }
    }
    let root_relative = owner.owner_relative_path.clone();
    let mut branch = owner;
    branch.owner_path = current;
    branch.owner_relative_path = normalized;
    let mut snapshot = list_owner_snapshot(branch, false).await?;
    snapshot.owner.owner_path = root_relative;
    Ok(snapshot)
}

async fn list_owner_snapshot(
    owner: ResolvedRegisteredOwner,
    root_schema_routing: bool,
) -> Result<AttachmentsSnapshot, AppError> {
    let (mut items, diagnostics) = scan_mixed_children(
        &owner.owner_path,
        &owner.owner_relative_path,
        root_schema_routing,
    )?;
    let source_paths = items
        .iter()
        .filter(|item| item.kind != AttachmentKind::Directory)
        .map(|item| item.source_path.clone())
        .collect::<Vec<_>>();
    let overrides = derive_date_overrides(&owner.space_path, &source_paths).await;
    for item in &mut items {
        if let Some(updated) = overrides
            .get(&item.source_path)
            .and_then(|override_value| override_value.updated.as_ref())
        {
            item.modified.clone_from(updated);
        }
    }
    items.sort_by(|left, right| {
        left.display_name
            .to_lowercase()
            .cmp(&right.display_name.to_lowercase())
            .then_with(|| left.path.cmp(&right.path))
    });
    let generation = snapshot_generation(&items, &diagnostics)?;

    Ok(AttachmentsSnapshot {
        owner: AttachmentOwnerIdentity {
            project_path: system_path::user_facing_path(&owner.project_path),
            space_id: owner.space_id,
            space_path: system_path::user_facing_path(&owner.space_path),
            owner_path: owner.owner_relative_path,
            repository_path: system_path::user_facing_path(&owner.repository_path),
        },
        generation,
        items,
        diagnostics,
    })
}

#[cfg(test)]
fn scan_direct_children(
    owner_path: &Path,
    owner_relative_path: &str,
) -> Result<(Vec<AttachmentItem>, Vec<AttachmentSourceDiagnostic>), AppError> {
    scan_mixed_children(owner_path, owner_relative_path, true)
}

fn scan_mixed_children(
    owner_path: &Path,
    owner_relative_path: &str,
    root_schema_routing: bool,
) -> Result<(Vec<AttachmentItem>, Vec<AttachmentSourceDiagnostic>), AppError> {
    let owner_has_schema = root_schema_routing && has_direct_schema(owner_path);
    let registered_spaces = child_folder_names(owner_path);
    let mut entries = fs::read_dir(owner_path)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_lowercase());
    let mut items = Vec::new();
    let mut diagnostics = Vec::new();

    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_system_source(&name) || is_agent_context_source(&name) {
            continue;
        }
        let path = entry.path();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => {
                diagnostics.push(AttachmentSourceDiagnostic {
                    code: "metadata_unavailable",
                    path: name,
                });
                continue;
            }
        };
        if metadata.file_type().is_symlink() {
            continue;
        }

        if metadata.is_dir() {
            if registered_spaces.contains(&name) {
                continue;
            }
            let schema = path.join("schema.yaml");
            let app = path.join("app.yaml");
            let readme = match direct_readme(&path) {
                Ok(readme) => readme,
                Err(_) => {
                    diagnostics.push(AttachmentSourceDiagnostic {
                        code: "metadata_unavailable",
                        path: name,
                    });
                    continue;
                }
            };
            // A linked marker/head must not project an owner outside this source.
            if [&schema, &app]
                .into_iter()
                .chain(readme.iter())
                .any(|source| {
                    fs::symlink_metadata(source).is_ok_and(|meta| meta.file_type().is_symlink())
                })
            {
                continue;
            }
            let has_schema = schema.is_file();
            let has_app = app.is_file();
            let readme = readme.filter(|source| source.is_file());
            if owner_has_schema && readme.is_some() {
                continue;
            }
            let kind = if has_schema {
                AttachmentKind::Collection
            } else if readme.is_some() {
                AttachmentKind::Page
            } else if has_app {
                AttachmentKind::App
            } else {
                AttachmentKind::Directory
            };
            let owner_path = normalized_direct_path(owner_relative_path, &name, None)?;
            let content_path = readme
                .as_ref()
                .map(|source| {
                    normalized_direct_path(
                        owner_relative_path,
                        &name,
                        source.file_name().and_then(|name| name.to_str()),
                    )
                })
                .transpose()?;
            let source = readme.as_ref().unwrap_or(if has_schema {
                &schema
            } else if has_app {
                &app
            } else {
                &path
            });
            let source_metadata = match fs::symlink_metadata(source) {
                Ok(metadata)
                    if (metadata.is_file() || kind == AttachmentKind::Directory)
                        && !metadata.file_type().is_symlink() =>
                {
                    metadata
                }
                _ => {
                    diagnostics.push(AttachmentSourceDiagnostic {
                        code: "metadata_unavailable",
                        path: owner_path,
                    });
                    continue;
                }
            };
            let source_path = if kind == AttachmentKind::Directory {
                owner_path.clone()
            } else {
                normalized_direct_path(
                    owner_relative_path,
                    &name,
                    source.file_name().and_then(|name| name.to_str()),
                )?
            };
            let (display_name, icon) = readme.as_ref().map_or_else(
                || (name.clone(), None),
                |source| {
                    let (title, icon, _) =
                        read_frontmatter_meta_head_with_fallback(source, name.clone());
                    (title, icon)
                },
            );
            let item_path = content_path.clone().unwrap_or_else(|| owner_path.clone());
            let kind_key = match kind {
                AttachmentKind::Page => "page",
                AttachmentKind::Collection => "collection",
                AttachmentKind::Directory => "directory",
                _ => "app",
            };
            items.push(AttachmentItem {
                key: format!("{kind_key}:{item_path}"),
                path: item_path,
                content_path,
                owner_path: Some(owner_path),
                source_path,
                has_app,
                has_children: has_mixed_child_hint(&path),
                icon,
                source_shape: SourceShape::Directory,
                kind,
                format: if readme.is_some() { "markdown" } else { "" }.to_string(),
                availability: AttachmentAvailability::Available,
                display_name,
                modified: modified_time(&source_metadata),
                size_bytes: None,
            });
            continue;
        }

        if !metadata.is_file() {
            continue;
        }
        let source_path = normalized_direct_path(owner_relative_path, &name, None)?;
        let extension = path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();

        if extension == "md" {
            if owner_has_schema || is_agent_context_source(&name) {
                continue;
            }
            let identity = resolve_markdown_identity(MarkdownIdentityFacts {
                path: &source_path,
                source_shape: SourceShape::File,
                collection_root: None,
                agent_context: false,
            });
            if !identity.is_page() {
                continue;
            }
            let (display_name, icon, _) = read_frontmatter_meta_head(&path);
            items.push(AttachmentItem {
                key: format!("page:{source_path}"),
                content_path: Some(source_path.clone()),
                owner_path: None,
                source_path: source_path.clone(),
                has_app: false,
                has_children: false,
                icon,
                path: source_path,
                source_shape: SourceShape::File,
                kind: AttachmentKind::Page,
                format: "markdown".to_string(),
                availability: AttachmentAvailability::Available,
                display_name,
                modified: modified_time(&metadata),
                size_bytes: None,
            });
            continue;
        }

        let Some((kind, availability)) = classify_binary_extension(&extension) else {
            continue;
        };
        items.push(AttachmentItem {
            key: format!("{}:{source_path}", kind.as_str()),
            content_path: Some(source_path.clone()),
            owner_path: None,
            source_path: source_path.clone(),
            has_app: false,
            has_children: false,
            icon: None,
            path: source_path,
            source_shape: SourceShape::File,
            kind: if kind == ArtifactKind::Document {
                AttachmentKind::Document
            } else {
                AttachmentKind::Media
            },
            format: extension,
            availability,
            display_name: name,
            modified: modified_time(&metadata),
            size_bytes: Some(metadata.len()),
        });
    }

    Ok((items, diagnostics))
}

pub(crate) fn classify_binary_path(path: &Path) -> Option<ArtifactKind> {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())?
        .to_ascii_lowercase();
    classify_binary_extension(&extension).map(|(kind, _)| kind)
}

fn classify_binary_extension(extension: &str) -> Option<(ArtifactKind, AttachmentAvailability)> {
    let document = match extension {
        "pdf" | "docx" | "xlsx" | "pptx" => Some(AttachmentAvailability::Limited),
        "doc" | "xls" | "ppt" | "docm" | "xlsm" | "pptm" | "odt" | "ods" | "odp" => {
            Some(AttachmentAvailability::ExternalOnly)
        }
        _ => None,
    };
    if let Some(availability) = document {
        return Some((ArtifactKind::Document, availability));
    }

    matches!(
        extension,
        "png"
            | "jpg"
            | "jpeg"
            | "webp"
            | "gif"
            | "svg"
            | "mp3"
            | "wav"
            | "m4a"
            | "aac"
            | "flac"
            | "ogg"
            | "opus"
            | "mp4"
            | "m4v"
            | "mov"
            | "webm"
            | "mkv"
            | "avi"
            | "wmv"
            | "mpg"
            | "mpeg"
            | "3gp"
            | "wma"
            | "aiff"
            | "avif"
            | "ico"
    )
    .then_some((ArtifactKind::Media, AttachmentAvailability::Limited))
}

fn has_mixed_child_hint(directory: &Path) -> bool {
    let Ok(entries) = fs::read_dir(directory) else {
        return true;
    };
    let registered = child_folder_names(directory);
    entries.into_iter().any(|entry| {
        let Ok(entry) = entry else {
            return true;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_system_source(&name) || is_agent_context_source(&name) || registered.contains(&name) {
            return false;
        }
        let Ok(kind) = entry.file_type() else {
            return true;
        };
        if kind.is_symlink() {
            return false;
        }
        kind.is_dir()
            || (kind.is_file()
                && (entry
                    .path()
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
                    || classify_binary_path(&entry.path()).is_some()))
    })
}

fn direct_readme(directory: &Path) -> Result<Option<PathBuf>, std::io::Error> {
    let mut entries = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    Ok(entries.into_iter().find_map(|entry| {
        entry
            .file_name()
            .to_string_lossy()
            .eq_ignore_ascii_case("README.md")
            .then_some(entry.path())
    }))
}

fn normalized_direct_path(
    owner_relative_path: &str,
    name: &str,
    child: Option<&str>,
) -> Result<String, AppError> {
    let direct = child.map_or_else(|| name.to_string(), |child| format!("{name}/{child}"));
    let path = if owner_relative_path == "." {
        direct
    } else {
        format!("{owner_relative_path}/{direct}")
    };
    normalize_repo_relative(&path, RootMode::Reject)
}

fn modified_time(metadata: &fs::Metadata) -> String {
    metadata
        .modified()
        .map(DateTime::<Utc>::from)
        .map(|date| date.to_rfc3339_opts(SecondsFormat::Secs, true))
        .unwrap_or_default()
}

fn is_system_source(name: &str) -> bool {
    let lowercase = name.to_ascii_lowercase();
    name.starts_with('.')
        || name.starts_with("~$")
        || name.starts_with('#') && name.ends_with('#')
        || name.ends_with('~')
        || matches!(
            lowercase.as_str(),
            "readme.md" | "schema.yaml" | "thumbs.db" | "desktop.ini"
        )
        || matches!(
            Path::new(&lowercase)
                .extension()
                .and_then(|value| value.to_str()),
            Some("tmp" | "temp" | "lock" | "swp" | "swo")
        )
}

fn is_agent_context_source(name: &str) -> bool {
    matches!(
        name,
        "AGENTS.md"
            | "AGENTS.override.md"
            | "CLAUDE.md"
            | "CLAUDE.local.md"
            | "GEMINI.md"
            | "SOUL.md"
            | "USER.md"
            | "MEMORY.md"
    )
}

fn snapshot_generation(
    items: &[AttachmentItem],
    diagnostics: &[AttachmentSourceDiagnostic],
) -> Result<String, AppError> {
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(&(items, diagnostics))?);
    let digest = hasher.finalize();
    Ok(digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::config::write_space_config;
    use crate::space::types::{SpaceConfig, SpaceRef};

    fn write_config(path: &Path, spaces: Option<Vec<SpaceRef>>) {
        fs::create_dir_all(path).expect("owner directory");
        write_space_config(
            path,
            &SpaceConfig {
                name: "Owner".into(),
                description: String::new(),
                icon: "folder".into(),
                spaces,
                agent: None,
                defaults: None,
                git: None,
                assets: None,
                tree: None,
            },
        )
        .expect("space config");
    }

    #[tokio::test]
    async fn source_projects_only_eligible_direct_children() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path();
        write_config(
            root,
            Some(vec![SpaceRef {
                id: "child-id".into(),
                path: "child-space".into(),
                repo: None,
            }]),
        );
        fs::create_dir_all(root.join("child-space")).unwrap();
        fs::write(root.join("README.md"), "owner").unwrap();
        fs::write(root.join("AGENTS.md"), "instructions").unwrap();
        fs::write(root.join("roadmap.md"), "---\ntitle: Roadmap\n---\n").unwrap();
        fs::write(root.join("guide.pdf"), b"pdf").unwrap();
        fs::write(root.join("photo.PNG"), b"image").unwrap();
        fs::write(root.join("unknown.bin"), b"unknown").unwrap();
        fs::create_dir_all(root.join("folder-page")).unwrap();
        fs::write(
            root.join("folder-page/README.md"),
            "---\ntitle: Folder Page\n---\n",
        )
        .unwrap();
        fs::write(root.join("folder-page/app.yaml"), "invalid").unwrap();
        fs::create_dir_all(root.join("collection")).unwrap();
        fs::write(root.join("collection/README.md"), "collection").unwrap();
        fs::write(root.join("collection/schema.yaml"), "columns: []").unwrap();
        fs::create_dir_all(root.join("bare")).unwrap();
        fs::create_dir_all(root.join("app")).unwrap();
        fs::write(
            root.join("app/app.yaml"),
            "runtime: { type: url, url: https://example.com }",
        )
        .unwrap();

        let snapshot = list_registered_owner(resolve_registered_owner(root, None).unwrap())
            .await
            .unwrap();
        let paths = snapshot
            .items
            .iter()
            .map(|item| item.path.as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            paths,
            vec![
                "app",
                "bare",
                "collection/README.md",
                "folder-page/README.md",
                "guide.pdf",
                "photo.PNG",
                "roadmap.md"
            ]
        );
        assert_eq!(snapshot.items[3].display_name, "Folder Page");
        assert_eq!(snapshot.items[4].kind, AttachmentKind::Document);
        assert_eq!(snapshot.items[5].kind, AttachmentKind::Media);
        assert!(snapshot.items[6].size_bytes.is_none());
    }

    #[tokio::test]
    async fn owner_schema_excludes_pages_but_keeps_binary_items() {
        let temp = tempfile::tempdir().expect("temp dir");
        write_config(temp.path(), None);
        fs::write(temp.path().join("schema.yaml"), "not: [valid").unwrap();
        fs::write(temp.path().join("page.md"), "page").unwrap();
        fs::write(temp.path().join("deck.pptx"), b"deck").unwrap();

        let snapshot = list_registered_owner(resolve_registered_owner(temp.path(), None).unwrap())
            .await
            .unwrap();

        assert_eq!(snapshot.items.len(), 1);
        assert_eq!(snapshot.items[0].path, "deck.pptx");
    }

    #[test]
    fn mixed_owner_matrix_preserves_identity_metadata_and_parent_schema_routing() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        for (name, head, schema, app) in [
            ("page", true, false, false),
            ("page-app", true, false, true),
            ("collection", true, true, false),
            ("collection-app", true, true, true),
            ("missing-head", false, true, false),
            ("missing-head-app", false, true, true),
            ("app", false, false, true),
        ] {
            let dir = root.join(name);
            fs::create_dir(&dir).unwrap();
            if head {
                fs::write(dir.join("readme.md"), "---\ntitle: Custom\nicon: 🌱\n---\n").unwrap();
            }
            if schema {
                fs::write(dir.join("schema.yaml"), "invalid: [").unwrap();
            }
            if app {
                fs::write(dir.join("app.yaml"), "invalid: [").unwrap();
            }
        }
        fs::write(root.join("leaf.md"), "---\nicon: '  '\n---\n").unwrap();
        let (rows, diagnostics) = scan_direct_children(root, ".").unwrap();
        assert!(diagnostics.is_empty());
        assert_eq!(rows.len(), 8);
        let page = rows
            .iter()
            .find(|row| row.path == "page-app/readme.md")
            .unwrap();
        assert_eq!(page.kind, AttachmentKind::Page);
        assert!(page.has_app);
        assert_eq!(page.content_path.as_deref(), Some("page-app/readme.md"));
        assert_eq!(page.owner_path.as_deref(), Some("page-app"));
        assert_eq!(page.icon.as_deref(), Some("🌱"));
        let collection = rows
            .iter()
            .find(|row| row.path == "collection-app/readme.md")
            .unwrap();
        assert_eq!(collection.kind, AttachmentKind::Collection);
        assert!(collection.has_app);
        let missing = rows.iter().find(|row| row.path == "missing-head").unwrap();
        assert_eq!(missing.kind, AttachmentKind::Collection);
        assert!(missing.content_path.is_none());
        assert_eq!(missing.source_path, "missing-head/schema.yaml");
        let app = rows.iter().find(|row| row.path == "app").unwrap();
        assert_eq!(app.kind, AttachmentKind::App);
        assert!(app.content_path.is_none());
        assert_eq!(app.source_path, "app/app.yaml");
        assert!(rows.iter().all(|row| row.size_bytes.is_none()));
        let generation = snapshot_generation(&rows, &diagnostics).unwrap();
        let mut changed = rows.clone();
        changed[0].icon = Some("✨".into());
        assert_ne!(
            generation,
            snapshot_generation(&changed, &diagnostics).unwrap()
        );
        changed = rows.clone();
        changed[0].has_app = !changed[0].has_app;
        assert_ne!(
            generation,
            snapshot_generation(&changed, &diagnostics).unwrap()
        );
        assert_ne!(
            generation,
            snapshot_generation(
                &rows,
                &[AttachmentSourceDiagnostic {
                    code: "metadata_unavailable",
                    path: "gone".into()
                }]
            )
            .unwrap()
        );
        for schema in ["columns: []", "invalid: ["] {
            fs::write(root.join("schema.yaml"), schema).unwrap();
            let (rows, _) = scan_direct_children(root, ".").unwrap();
            assert_eq!(rows.len(), 3);
            assert!(rows.iter().all(|row| row.content_path.is_none()));
        }
        fs::remove_file(root.join("schema.yaml")).unwrap();
        assert_eq!(scan_direct_children(root, ".").unwrap().0.len(), 8);
        fs::write(root.join("app/readme.md"), "---\ninvalid: [\n---\n").unwrap();
        let (rows, _) = scan_direct_children(root, ".").unwrap();
        let app = rows
            .iter()
            .find(|row| row.owner_path.as_deref() == Some("app"))
            .unwrap();
        assert_eq!(app.kind, AttachmentKind::Page);
        assert_eq!(app.display_name, "app");
        assert!(app.icon.is_none());
        assert!(app.has_app);
    }

    #[cfg(unix)]
    #[test]
    fn linked_markers_heads_and_directories_never_become_rows() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("source"), "outside").unwrap();
        for marker in ["README.md", "schema.yaml", "app.yaml"] {
            let dir = temp.path().join(marker);
            fs::create_dir(&dir).unwrap();
            symlink(outside.path().join("source"), dir.join(marker)).unwrap();
        }
        symlink(outside.path(), temp.path().join("linked")).unwrap();
        assert!(scan_direct_children(temp.path(), ".").unwrap().0.is_empty());
    }

    #[tokio::test]
    async fn directory_hint_and_metadata_follow_first_child_without_recursive_membership() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write_config(root, None);
        fs::create_dir(root.join("bare")).unwrap();
        fs::write(root.join("schema.yaml"), "invalid: [").unwrap();
        let owner = resolve_registered_owner(root, None).unwrap();
        let empty = list_registered_owner(owner.clone()).await.unwrap();
        assert_eq!(empty.items.len(), 1);
        let directory = &empty.items[0];
        assert_eq!(directory.kind, AttachmentKind::Directory);
        assert_eq!(directory.source_path, "bare");
        assert_eq!(
            directory.modified,
            modified_time(&fs::metadata(root.join("bare")).unwrap())
        );
        assert!(!directory.has_children);
        assert!(directory.size_bytes.is_none());
        fs::write(root.join("bare/README.md"), "---\nicon: 📁\n---\n").unwrap();
        fs::write(root.join("bare/child.pdf"), "pdf").unwrap();
        // Root schema routes the new Page away; branch projection still includes it.
        assert!(
            list_registered_owner(owner.clone())
                .await
                .unwrap()
                .items
                .is_empty()
        );
        fs::remove_file(root.join("bare/README.md")).unwrap();
        let changed = list_registered_owner(owner.clone()).await.unwrap();
        assert_eq!(changed.items.len(), 1);
        assert!(changed.items[0].has_children);
        assert_ne!(changed.generation, empty.generation);
        let branch = list_attachment_branch(owner, "bare").await.unwrap();
        assert_eq!(branch.items.len(), 1);
        assert_eq!(branch.items[0].kind, AttachmentKind::Document);
    }

    #[test]
    fn resolver_requires_an_exact_ready_registered_space() {
        let temp = tempfile::tempdir().expect("temp dir");
        write_config(
            temp.path(),
            Some(vec![SpaceRef {
                id: "ready-id".into(),
                path: "ready-space".into(),
                repo: None,
            }]),
        );
        fs::create_dir_all(temp.path().join("ready-space")).unwrap();

        let resolved = resolve_registered_owner(temp.path(), Some("ready-id")).unwrap();
        assert_eq!(resolved.space_id.as_deref(), Some("ready-id"));
        assert!(resolved.space_path.ends_with("ready-space"));
        assert!(resolve_registered_owner(temp.path(), Some("missing-id")).is_err());
    }

    #[test]
    fn resolver_reports_effective_repository_for_root_inline_and_owned_spaces() {
        let temp = tempfile::tempdir().expect("temp dir");
        write_config(
            temp.path(),
            Some(vec![
                SpaceRef {
                    id: "inline-id".into(),
                    path: "inline".into(),
                    repo: None,
                },
                SpaceRef {
                    id: "independent-id".into(),
                    path: "independent".into(),
                    repo: None,
                },
                SpaceRef {
                    id: "submodule-id".into(),
                    path: "submodule".into(),
                    repo: Some("https://example.com/submodule.git".into()),
                },
            ]),
        );
        fs::create_dir_all(temp.path().join("inline")).unwrap();
        fs::create_dir_all(temp.path().join("independent/.git")).unwrap();
        fs::create_dir_all(temp.path().join("submodule")).unwrap();
        fs::write(
            temp.path().join("submodule/.git"),
            "gitdir: ../modules/submodule",
        )
        .unwrap();

        let root = resolve_registered_owner(temp.path(), None).unwrap();
        let inline = resolve_registered_owner(temp.path(), Some("inline-id")).unwrap();
        let independent = resolve_registered_owner(temp.path(), Some("independent-id")).unwrap();
        let submodule = resolve_registered_owner(temp.path(), Some("submodule-id")).unwrap();

        assert_eq!(root.repository_path, root.project_path);
        assert_eq!(inline.repository_path, inline.project_path);
        assert_eq!(independent.repository_path, independent.space_path);
        assert_eq!(submodule.repository_path, submodule.space_path);
    }

    #[tokio::test]
    async fn directory_page_owner_is_exact_and_keeps_space_relative_paths() {
        let temp = tempfile::tempdir().expect("temp dir");
        write_config(
            temp.path(),
            Some(vec![SpaceRef {
                id: "child-id".into(),
                path: "child-space".into(),
                repo: None,
            }]),
        );
        fs::create_dir_all(temp.path().join("roadmap/nested-collection")).unwrap();
        fs::write(temp.path().join("roadmap/README.md"), "roadmap").unwrap();
        fs::write(temp.path().join("roadmap/brief.pdf"), b"brief").unwrap();
        fs::write(temp.path().join("roadmap/task.md"), "task").unwrap();
        fs::write(
            temp.path().join("roadmap/nested-collection/README.md"),
            "collection",
        )
        .unwrap();
        fs::write(
            temp.path().join("roadmap/nested-collection/schema.yaml"),
            "columns: []",
        )
        .unwrap();
        fs::create_dir_all(temp.path().join("child-space")).unwrap();

        let owner = resolve_attachment_owner(temp.path(), None, Some("roadmap")).unwrap();
        let snapshot = list_registered_owner(owner).await.unwrap();
        let paths = snapshot
            .items
            .iter()
            .map(|item| item.path.as_str())
            .collect::<Vec<_>>();

        assert_eq!(snapshot.owner.owner_path, "roadmap");
        assert_eq!(
            paths,
            vec![
                "roadmap/brief.pdf",
                "roadmap/nested-collection/README.md",
                "roadmap/task.md"
            ]
        );
        assert!(resolve_attachment_owner(temp.path(), None, Some("child-space")).is_err());
        fs::create_dir_all(temp.path().join(".hidden")).unwrap();
        fs::write(temp.path().join(".hidden/README.md"), "hidden").unwrap();
        assert!(resolve_attachment_owner(temp.path(), None, Some(".hidden")).is_err());
        assert!(
            resolve_attachment_owner(temp.path(), None, Some("roadmap/nested-collection")).is_err()
        );
    }

    #[tokio::test]
    async fn branches_keep_mixed_children_and_enforce_original_owner() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write_config(
            root,
            Some(vec![SpaceRef {
                id: "child".into(),
                path: "child-space".into(),
                repo: None,
            }]),
        );
        for path in [
            "page/collection/directory/app",
            "child-space",
            "sibling",
            "page/.hidden",
        ] {
            fs::create_dir_all(root.join(path)).unwrap();
        }
        for (path, body) in [
            ("page/README.md", "page"),
            ("page/collection/README.md", "collection"),
            ("page/collection/schema.yaml", "invalid: ["),
            ("page/collection/child.md", "child"),
            ("page/collection/directory/app/app.yaml", "invalid: ["),
            ("page/collection/directory/file.pdf", "pdf"),
            ("page/collection/directory/image.png", "png"),
            ("page/collection/directory/sound.mp3", "mp3"),
            ("page/collection/directory/movie.mp4", "mp4"),
            ("page/collection/directory/AGENTS.md", "system"),
        ] {
            fs::write(root.join(path), body).unwrap();
        }
        let owner = resolve_attachment_owner(root, None, Some("page")).unwrap();
        let root_rows = list_registered_owner(owner.clone()).await.unwrap();
        assert_eq!(root_rows.items.len(), 1);
        let collection = list_attachment_branch(owner.clone(), "page/collection")
            .await
            .unwrap();
        assert_eq!(collection.owner.owner_path, "page");
        assert_eq!(collection.items.len(), 2);
        assert!(
            collection
                .items
                .iter()
                .any(|row| row.kind == AttachmentKind::Page)
        );
        assert!(
            collection
                .items
                .iter()
                .any(|row| row.kind == AttachmentKind::Directory)
        );
        let directory = list_attachment_branch(owner.clone(), "page/collection/directory")
            .await
            .unwrap();
        assert_eq!(directory.items.len(), 5);
        assert!(
            directory
                .items
                .iter()
                .any(|row| row.kind == AttachmentKind::App)
        );
        assert!(
            directory
                .items
                .iter()
                .all(|row| !row.path.ends_with("AGENTS.md"))
        );
        assert!(
            list_attachment_branch(owner.clone(), "sibling")
                .await
                .is_err()
        );
        assert!(
            list_attachment_branch(owner.clone(), "page/.hidden")
                .await
                .is_err()
        );
        assert!(
            list_attachment_branch(owner.clone(), "page/../sibling")
                .await
                .is_err()
        );
        let root_owner = resolve_registered_owner(root, None).unwrap();
        assert!(
            list_attachment_branch(root_owner, "child-space")
                .await
                .is_err()
        );
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("sibling"), root.join("page/linked")).unwrap();
            assert!(
                list_attachment_branch(owner.clone(), "page/linked")
                    .await
                    .is_err()
            );
            std::os::unix::fs::symlink(
                root.join("page/README.md"),
                root.join("page/collection/directory/README.md"),
            )
            .unwrap();
            assert!(
                list_attachment_branch(owner, "page/collection/directory")
                    .await
                    .is_err()
            );
        }
    }

    #[test]
    fn binary_classification_preserves_typed_fallback_availability() {
        assert_eq!(
            classify_binary_extension("docx"),
            Some((ArtifactKind::Document, AttachmentAvailability::Limited))
        );
        assert_eq!(
            classify_binary_extension("doc"),
            Some((ArtifactKind::Document, AttachmentAvailability::ExternalOnly))
        );
        assert_eq!(
            classify_binary_extension("webm"),
            Some((ArtifactKind::Media, AttachmentAvailability::Limited))
        );
        assert_eq!(classify_binary_extension("zip"), None);
    }
}

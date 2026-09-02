use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::AppError;
use crate::artifact::app_marker::{AppMarkerProbe, probe_app_directory};
use crate::artifact::identity::{
    ArtifactKind, MarkdownIdentityFacts, SourceShape, resolve_markdown_identity,
};
use crate::files::tree::{child_folder_names, has_direct_schema, read_frontmatter_meta_head};
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentItem {
    pub key: String,
    pub path: String,
    pub source_shape: SourceShape,
    pub kind: ArtifactKind,
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
    ensure_owner_path_has_no_symlink_components(&owner.space_path, Path::new(&normalized))?;
    let first_component = Path::new(&normalized)
        .components()
        .next()
        .map(|component| component.as_os_str().to_string_lossy().to_string());
    if first_component
        .as_ref()
        .is_some_and(|component| child_folder_names(&owner.space_path).contains(component))
    {
        return Err(AppError::PathNotAccessible(format!(
            "attachment owner crosses a registered Space boundary: {normalized}"
        )));
    }

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
    if has_direct_schema(&candidate)
        || !matches!(
            probe_app_directory(&candidate, &owner.space_path),
            Ok(AppMarkerProbe::NoMatch)
        )
    {
        return Err(AppError::PathNotAccessible(format!(
            "path is not a directory-backed Page owner: {normalized}"
        )));
    }
    let readme = direct_readme(&candidate).ok_or_else(|| {
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

fn ensure_owner_path_has_no_symlink_components(
    space_path: &Path,
    relative: &Path,
) -> Result<(), AppError> {
    let mut current = space_path.to_path_buf();
    for component in relative.components() {
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
    let (mut items, diagnostics) =
        scan_direct_children(&owner.owner_path, &owner.owner_relative_path)?;
    let source_paths = items
        .iter()
        .map(|item| item.path.clone())
        .collect::<Vec<_>>();
    let overrides = derive_date_overrides(&owner.space_path, &source_paths).await;
    for item in &mut items {
        if let Some(updated) = overrides
            .get(&item.path)
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
    let generation = snapshot_generation(&items);

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

fn scan_direct_children(
    owner_path: &Path,
    owner_relative_path: &str,
) -> Result<(Vec<AttachmentItem>, Vec<AttachmentSourceDiagnostic>), AppError> {
    let owner_has_schema = has_direct_schema(owner_path);
    let registered_spaces = child_folder_names(owner_path);
    let mut entries = fs::read_dir(owner_path)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_lowercase());
    let mut items = Vec::new();
    let mut diagnostics = Vec::new();

    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_system_source(&name) {
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
            if owner_has_schema || registered_spaces.contains(&name) || has_direct_schema(&path) {
                continue;
            }
            if !matches!(
                probe_app_directory(&path, owner_path),
                Ok(AppMarkerProbe::NoMatch)
            ) {
                continue;
            }
            let Some(readme_path) = direct_readme(&path) else {
                continue;
            };
            let readme_metadata = match fs::symlink_metadata(&readme_path) {
                Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                    metadata
                }
                _ => continue,
            };
            let source_path =
                normalized_direct_path(owner_relative_path, &name, Some("README.md"))?;
            let identity = resolve_markdown_identity(MarkdownIdentityFacts {
                path: &source_path,
                source_shape: SourceShape::Directory,
                collection_root: None,
                agent_context: false,
            });
            if !identity.is_page() {
                continue;
            }
            let (display_name, _, _) = read_frontmatter_meta_head(&readme_path);
            items.push(AttachmentItem {
                key: format!("page:{source_path}"),
                path: source_path,
                source_shape: SourceShape::Directory,
                kind: ArtifactKind::Page,
                format: "markdown".to_string(),
                availability: AttachmentAvailability::Available,
                display_name,
                modified: modified_time(&readme_metadata),
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
            let (display_name, _, _) = read_frontmatter_meta_head(&path);
            items.push(AttachmentItem {
                key: format!("page:{source_path}"),
                path: source_path,
                source_shape: SourceShape::File,
                kind: ArtifactKind::Page,
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
            path: source_path,
            source_shape: SourceShape::File,
            kind,
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

fn direct_readme(directory: &Path) -> Option<PathBuf> {
    fs::read_dir(directory)
        .ok()?
        .filter_map(Result::ok)
        .find_map(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case("README.md")
                .then_some(entry.path())
        })
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

fn snapshot_generation(items: &[AttachmentItem]) -> String {
    let mut hasher = Sha256::new();
    for item in items {
        hasher.update(item.key.as_bytes());
        hasher.update([0]);
        hasher.update(item.modified.as_bytes());
        hasher.update([0]);
        hasher.update(item.size_bytes.unwrap_or_default().to_le_bytes());
    }
    let digest = hasher.finalize();
    digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
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
        fs::create_dir_all(root.join("collection")).unwrap();
        fs::write(root.join("collection/README.md"), "collection").unwrap();
        fs::write(root.join("collection/schema.yaml"), "columns: []").unwrap();
        fs::create_dir_all(root.join("bare")).unwrap();
        fs::create_dir_all(root.join("app")).unwrap();
        fs::write(
            root.join("app/index.html"),
            "<head><meta name=\"svode-app\" content=\"1\"></head>",
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
                "folder-page/README.md",
                "guide.pdf",
                "photo.PNG",
                "roadmap.md"
            ]
        );
        assert_eq!(snapshot.items[0].display_name, "Folder Page");
        assert_eq!(snapshot.items[1].kind, ArtifactKind::Document);
        assert_eq!(snapshot.items[2].kind, ArtifactKind::Media);
        assert!(snapshot.items[3].size_bytes.is_none());
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
        assert_eq!(paths, vec!["roadmap/brief.pdf", "roadmap/task.md"]);
        assert!(resolve_attachment_owner(temp.path(), None, Some("child-space")).is_err());
        assert!(
            resolve_attachment_owner(temp.path(), None, Some("roadmap/nested-collection")).is_err()
        );
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

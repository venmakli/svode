use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::dates::enrich_source_git_dates;
use super::identity::{
    ContentOwnerKind, PageRole, is_agent_context_source, resolve_markdown_identity_for_path,
};
use super::source::{PageSource, PageSourceError, read_page_source, resolve_page_target};

#[derive(Debug, Clone)]
pub struct ResolvedSpaceTarget {
    pub project_path: PathBuf,
    pub space_id: Option<String>,
    pub space_path: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpaceReadiness {
    Ready,
    Missing,
    Broken,
}

#[derive(Deserialize)]
struct ProjectConfig {
    #[serde(rename = "name")]
    _name: String,
    #[serde(default)]
    spaces: Option<Vec<SpaceReference>>,
}

#[derive(Deserialize)]
struct SpaceReference {
    id: String,
    path: String,
    repo: Option<String>,
}

pub fn space_reference_status(
    project: &Path,
    child_path: &str,
    repo: Option<&str>,
) -> SpaceReadiness {
    let child = project.join(child_path);
    let is_submodule = gitmodules_contains_path(project, child_path);
    if child.exists() {
        if is_submodule && fs::symlink_metadata(child.join(".git")).is_err() {
            SpaceReadiness::Missing
        } else {
            SpaceReadiness::Ready
        }
    } else if repo.is_some() || is_submodule {
        SpaceReadiness::Missing
    } else {
        SpaceReadiness::Broken
    }
}

fn project_config(project: &Path) -> Result<ProjectConfig, PageSourceError> {
    let path = project.join(".svode/config.json");
    let bytes = fs::read(&path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => PageSourceError::Missing(path.display().to_string()),
        std::io::ErrorKind::PermissionDenied => PageSourceError::Access(path.display().to_string()),
        _ => PageSourceError::Io(error),
    })?;
    serde_json::from_slice(&bytes).map_err(PageSourceError::InvalidConfig)
}

/// Directories of every registered Space of `project`, in config order.
/// Used to attribute changed paths to their owning Space.
pub fn registered_space_dirs(project: &Path) -> Result<Vec<PathBuf>, PageSourceError> {
    Ok(project_config(project)?
        .spaces
        .unwrap_or_default()
        .iter()
        .map(|reference| project.join(&reference.path))
        .collect())
}

pub fn resolve_space_target(
    project: &Path,
    space_id: Option<&str>,
) -> Result<ResolvedSpaceTarget, PageSourceError> {
    let project_path = fs::canonicalize(project).map_err(|error| {
        PageSourceError::InvalidPath(format!("Project {}: {error}", project.display()))
    })?;
    if !project_path.is_dir() {
        return Err(PageSourceError::InvalidPath(project.display().to_string()));
    }
    let config = project_config(&project_path)?;
    let space_path = match space_id {
        None => project_path.clone(),
        Some(id) => {
            let reference = config
                .spaces
                .as_deref()
                .unwrap_or_default()
                .iter()
                .find(|reference| reference.id == id)
                .ok_or_else(|| PageSourceError::SpaceNotFound(id.to_string()))?;
            if reference.path.is_empty()
                || reference.path == "."
                || reference.path == ".."
                || reference.path.contains('/')
                || reference.path.contains('\\')
            {
                return Err(PageSourceError::SpaceNotFound(id.to_string()));
            }
            let candidate = project_path.join(&reference.path);
            if space_reference_status(&project_path, &reference.path, reference.repo.as_deref())
                != SpaceReadiness::Ready
            {
                return Err(PageSourceError::SpaceNotFound(id.to_string()));
            }
            let path = fs::canonicalize(&candidate)
                .map_err(|_| PageSourceError::SpaceNotFound(id.to_string()))?;
            if !path.is_dir() {
                return Err(PageSourceError::InvalidPath(format!(
                    "registered Space is not a regular directory: {}",
                    candidate.display()
                )));
            }
            if !path.starts_with(&project_path) || path.parent() != Some(project_path.as_path()) {
                return Err(PageSourceError::InvalidPath(format!(
                    "registered Space escapes Project boundary: {}",
                    path.display()
                )));
            }
            path
        }
    };
    Ok(ResolvedSpaceTarget {
        project_path,
        space_id: space_id.map(str::to_string),
        space_path,
    })
}

fn gitmodules_contains_path(project: &Path, child_path: &str) -> bool {
    let Ok(content) = fs::read_to_string(project.join(".gitmodules")) else {
        return false;
    };
    content.lines().any(|line| {
        let Some(rest) = line.trim().strip_prefix("path") else {
            return false;
        };
        rest.split_once('=')
            .is_some_and(|(_, value)| value.trim() == child_path)
    })
}

pub async fn read_standalone_page(
    project: &Path,
    space_id: Option<&str>,
    path: &str,
) -> Result<PageSource, PageSourceError> {
    let space = resolve_space_target(project, space_id)?;
    let target = resolve_page_target(&space.space_path, path)?;
    let config = project_config(&space.project_path)?;
    if space.space_id.is_none()
        && config
            .spaces
            .as_deref()
            .unwrap_or_default()
            .iter()
            .any(|reference| {
                let child = space.project_path.join(&reference.path);
                let child = fs::canonicalize(&child).unwrap_or(child);
                target.absolute.starts_with(&child)
            })
    {
        return Err(PageSourceError::InvalidOwner(path.to_string()));
    }
    if Path::new(&target.path)
        .components()
        .any(|component| component.as_os_str().to_string_lossy().starts_with('.'))
    {
        return Err(PageSourceError::InvalidOwner(path.to_string()));
    }
    let identity = resolve_markdown_identity_for_path(
        &space.space_path,
        &target.path,
        is_agent_context_source(&target.path),
    )?;
    if identity.owner_kind.is_some() || identity.page_role != Some(PageRole::Standalone) {
        return Err(PageSourceError::InvalidOwner(format!(
            "{}: {:?}",
            path,
            identity.owner_kind.unwrap_or(ContentOwnerKind::Collection)
        )));
    }
    let mut source = read_page_source(target)?;
    enrich_source_git_dates(&mut source).await;
    Ok(source)
}

use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::dates::enrich_source_git_dates;
use super::identity::{
    ContentOwnerKind, PageRole, is_agent_context_source, resolve_markdown_identity_for_path,
};
use super::source::{
    PageSource, PageSourceError, normalize_page_path, read_page_source, resolve_page_target,
};

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

/// Portable config of a Project or Space: its display name and registered
/// child Spaces.
#[derive(Deserialize)]
pub struct ProjectConfig {
    pub name: String,
    #[serde(default)]
    pub spaces: Option<Vec<SpaceReference>>,
}

/// One registered child Space reference of a Project config.
#[derive(Debug, Clone, Deserialize)]
pub struct SpaceReference {
    pub id: String,
    pub path: String,
    pub repo: Option<String>,
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

/// Reads `.svode/config.json` of a Project or Space directory.
pub fn read_project_config(project: &Path) -> Result<ProjectConfig, PageSourceError> {
    let path = project.join(".svode/config.json");
    let bytes = fs::read(&path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => PageSourceError::Missing(path.display().to_string()),
        std::io::ErrorKind::PermissionDenied => PageSourceError::Access(path.display().to_string()),
        _ => PageSourceError::Io(error),
    })?;
    serde_json::from_slice(&bytes).map_err(PageSourceError::InvalidConfig)
}

/// Registered Space references of `project`, in config order. Reading them
/// also proves that the directory has a readable Space config.
pub fn registered_spaces(project: &Path) -> Result<Vec<SpaceReference>, PageSourceError> {
    Ok(read_project_config(project)?.spaces.unwrap_or_default())
}

/// Directories of every registered Space of `project`, in config order.
/// Used to attribute changed paths to their owning Space.
pub fn registered_space_dirs(project: &Path) -> Result<Vec<PathBuf>, PageSourceError> {
    Ok(registered_spaces(project)?
        .iter()
        .map(|reference| project.join(&reference.path))
        .collect())
}

/// Project that owns `dir`: the nearest ancestor holding a Space config,
/// or its parent Project when that ancestor is a registered child Space of
/// it. The config is not parsed here; an invalid one surfaces when the
/// target is resolved.
pub fn project_for_directory(dir: &Path) -> Option<PathBuf> {
    let nearest = dir
        .ancestors()
        .find(|candidate| candidate.join(".svode/config.json").is_file())?;
    let parent_project = nearest.parent().filter(|parent| {
        let name = nearest.file_name().map(|name| name.to_string_lossy());
        registered_spaces(parent).is_ok_and(|spaces| {
            spaces
                .iter()
                .any(|space| Some(space.path.as_str()) == name.as_deref())
        })
    });
    Some(parent_project.unwrap_or(nearest).to_path_buf())
}

/// Most specific ready child Space of `project` that contains `dir`, with
/// its canonical directory. `dir` must be canonical.
pub fn ready_child_space_for_directory(project: &Path, dir: &Path) -> Option<(String, PathBuf)> {
    registered_spaces(project)
        .ok()?
        .into_iter()
        .filter(|space| {
            space_reference_status(project, &space.path, space.repo.as_deref())
                == SpaceReadiness::Ready
        })
        .filter_map(|space| {
            let path = project.join(&space.path).canonicalize().ok()?;
            dir.starts_with(&path).then_some((space.id, path))
        })
        .max_by_key(|(_, path)| path.components().count())
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
    let config = read_project_config(&project_path)?;
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

/// Source-only read of one standalone Page inside an already resolved Space.
pub async fn read_standalone_page(
    space: &ResolvedSpaceTarget,
    path: &str,
) -> Result<PageSource, PageSourceError> {
    let normalized = normalize_page_path(path)?;
    if normalized.split('/').next().is_some_and(|first| {
        first.eq_ignore_ascii_case(".git") || first.eq_ignore_ascii_case(".svode")
    }) {
        return Err(PageSourceError::Forbidden(path.to_string()));
    }
    let target = resolve_page_target(&space.space_path, path)?;
    let config = read_project_config(&space.project_path)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn project(root: &Path, spaces: &str) {
        fs::create_dir_all(root.join(".svode")).unwrap();
        fs::write(
            root.join(".svode/config.json"),
            format!(r#"{{"name":"Project","spaces":{spaces}}}"#),
        )
        .unwrap();
    }

    #[test]
    fn project_for_directory_prefers_the_parent_of_a_registered_child() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap().join("project");
        project(&root, r#"[{"id":"child","path":"child","repo":null}]"#);
        project(&root.join("child"), "[]");
        project(&root.join("nested"), "[]");
        fs::create_dir_all(root.join("child/deep")).unwrap();
        fs::create_dir_all(root.join("notes")).unwrap();

        assert_eq!(
            project_for_directory(&root.join("notes")),
            Some(root.clone())
        );
        assert_eq!(
            project_for_directory(&root.join("child/deep")),
            Some(root.clone())
        );
        // An unregistered Project inside another one is its own Project.
        assert_eq!(
            project_for_directory(&root.join("nested")),
            Some(root.join("nested"))
        );
        assert_eq!(project_for_directory(temp.path()), None);
    }

    #[test]
    fn ready_child_space_for_directory_skips_unready_children() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        project(
            &root,
            r#"[{"id":"child","path":"child","repo":null},{"id":"gone","path":"gone","repo":"https://example.invalid/gone.git"}]"#,
        );
        fs::create_dir_all(root.join("child/deep")).unwrap();
        fs::create_dir_all(root.join("notes")).unwrap();

        assert_eq!(
            ready_child_space_for_directory(&root, &root.join("child/deep")),
            Some(("child".to_string(), root.join("child")))
        );
        assert_eq!(
            ready_child_space_for_directory(&root, &root.join("notes")),
            None
        );
        assert_eq!(
            ready_child_space_for_directory(&root, &root.join("gone")),
            None
        );
    }
}

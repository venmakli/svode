//! Public Space addressing inside a frozen request target, and the rule a
//! standalone process freezes that target with.

use std::path::{Path, PathBuf};

use svode_core::index::IndexKey;
use svode_core::page::{
    PageSourceError, ResolvedSpaceTarget, project_for_directory, ready_child_space_for_directory,
    resolve_space_target,
};
use svode_core::runtime::session::SessionError;

use crate::error::ToolError;
use crate::host::RequestTarget;

/// Public `spaceId` of the project root Space.
pub const ROOT_SPACE_ID: &str = "root";

pub fn is_root_space_id(space_id: &str) -> bool {
    space_id == ROOT_SPACE_ID
}

/// Public id of the target's default Space.
pub fn default_space_id(target: &RequestTarget) -> String {
    target
        .default_space_id
        .clone()
        .unwrap_or_else(|| ROOT_SPACE_ID.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SpaceSelection<'a> {
    FrozenDefault,
    Root,
    Child(&'a str),
}

fn space_selection(requested_space_id: Option<&str>) -> SpaceSelection<'_> {
    match requested_space_id {
        Some(space_id) if is_root_space_id(space_id) => SpaceSelection::Root,
        Some(space_id) => SpaceSelection::Child(space_id),
        None => SpaceSelection::FrozenDefault,
    }
}

/// Directory of the Space selected by a public `spaceId`; `None` keeps the
/// frozen default Space of the request.
pub fn resolve_space(
    target: &RequestTarget,
    requested_space_id: Option<&str>,
) -> Result<String, ToolError> {
    Ok(match space_selection(requested_space_id) {
        SpaceSelection::FrozenDefault => target.default_space_path.clone(),
        SpaceSelection::Root => target.project_path.clone(),
        SpaceSelection::Child(space_id) => {
            svode_core::page::resolve_space_target(Path::new(&target.project_path), Some(space_id))?
                .space_path
                .to_string_lossy()
                .to_string()
        }
    })
}

/// Project of a standalone process from an explicit or discovered
/// directory; its root Space is the returned target.
pub fn resolve_project(project: &Path) -> Result<ResolvedSpaceTarget, ToolError> {
    resolve_space_target(project, None).map_err(|error| context_error(error, "PROJECT_UNAVAILABLE"))
}

/// Project directory a standalone process discovers from `cwd` when no
/// Project is given: the nearest one containing it.
pub fn project_for_cwd(cwd: &Path) -> Result<PathBuf, ToolError> {
    let cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
    project_for_directory(&cwd).ok_or_else(|| {
        ToolError::new(
            "PROJECT_UNAVAILABLE",
            format!("no Svode project contains {}", cwd.display()),
        )
    })
}

/// Default Space of a standalone process: an explicit selector wins (`root`
/// or a registered child id); otherwise the most specific ready child Space
/// containing `cwd`, else the root. `project` is the root target from
/// [`resolve_project`].
pub fn resolve_default_space(
    project: ResolvedSpaceTarget,
    space: Option<&str>,
    cwd: &Path,
) -> Result<ResolvedSpaceTarget, ToolError> {
    Ok(match space {
        Some(ROOT_SPACE_ID) => project,
        Some(space_id) => resolve_space_target(&project.project_path, Some(space_id))
            .map_err(|error| context_error(error, "SPACE_UNAVAILABLE"))?,
        None => {
            let cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
            match ready_child_space_for_directory(&project.project_path, &cwd) {
                Some((space_id, space_path)) => ResolvedSpaceTarget {
                    project_path: project.project_path,
                    space_id: Some(space_id),
                    space_path,
                },
                None => project,
            }
        }
    })
}

pub(crate) fn context_error(error: PageSourceError, fallback: &str) -> ToolError {
    let code = match error {
        PageSourceError::InvalidConfig(_) => "INVALID_PROJECT_CONFIG",
        _ => fallback,
    };
    ToolError::new(code, error.to_string())
}

/// A runtime session that cannot bind the target Project.
impl From<SessionError> for ToolError {
    fn from(error: SessionError) -> Self {
        match error {
            SessionError::Project(error) => context_error(error, "PROJECT_UNAVAILABLE"),
            error @ SessionError::OtherProject { .. } => {
                ToolError::new("PROJECT_UNAVAILABLE", error.to_string())
            }
        }
    }
}

/// Index key of the Space selected by a public `spaceId`.
pub fn index_key(target: &RequestTarget, requested_space_id: Option<&str>) -> IndexKey {
    let project = PathBuf::from(&target.project_path);
    let space_id = match space_selection(requested_space_id) {
        SpaceSelection::Root => None,
        SpaceSelection::Child(space_id) => Some(space_id),
        SpaceSelection::FrozenDefault => target.default_space_id.as_deref(),
    };
    match space_id {
        Some(space_id) => IndexKey::Space {
            project,
            space_id: space_id.to_string(),
        },
        None => IndexKey::Root(project),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(default_space_id: Option<&str>) -> RequestTarget {
        RequestTarget {
            project_path: "/project".to_string(),
            default_space_id: default_space_id.map(ToString::to_string),
            default_space_path: default_space_id
                .map(|id| format!("/project/{id}"))
                .unwrap_or_else(|| "/project".to_string()),
            routine_caller: None,
        }
    }

    #[test]
    fn root_space_id_targets_root_even_when_child_space_is_default() {
        assert_eq!(
            index_key(&target(Some("child")), Some(ROOT_SPACE_ID)),
            IndexKey::Root(PathBuf::from("/project"))
        );
        assert_eq!(
            resolve_space(&target(Some("child")), Some(ROOT_SPACE_ID)).unwrap(),
            "/project"
        );
    }

    #[test]
    fn null_space_id_targets_frozen_default_space() {
        assert_eq!(
            index_key(&target(Some("child")), None),
            IndexKey::Space {
                project: PathBuf::from("/project"),
                space_id: "child".to_string()
            }
        );
        assert_eq!(
            index_key(&target(None), None),
            IndexKey::Root(PathBuf::from("/project"))
        );
        assert_eq!(
            resolve_space(&target(Some("child")), None).unwrap(),
            "/project/child"
        );
        assert_eq!(default_space_id(&target(None)), ROOT_SPACE_ID);
    }

    #[test]
    fn explicit_child_selection_is_distinct_from_root_and_default() {
        assert_eq!(space_selection(Some("root")), SpaceSelection::Root);
        assert_eq!(
            space_selection(Some("other")),
            SpaceSelection::Child("other")
        );
        assert_eq!(space_selection(None), SpaceSelection::FrozenDefault);
    }
}

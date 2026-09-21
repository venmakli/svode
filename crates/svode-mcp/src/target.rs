//! Public Space addressing inside a frozen request target.

use std::path::{Path, PathBuf};

use svode_core::index::IndexKey;

use crate::error::McpBusinessError;
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
) -> Result<String, McpBusinessError> {
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

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{IndexError, IndexKey};
use crate::git::path::{RootMode, repo_relative_from_path};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SpaceStatus {
    Ready,
    Missing,
    Broken,
}

#[derive(Debug, Clone, Default)]
pub struct ProjectSpacesCache {
    pub by_folder: HashMap<String, String>,
    pub folder_by_id: HashMap<String, String>,
    pub status_by_id: HashMap<String, SpaceStatus>,
    pub root_name: String,
    pub name_by_id: HashMap<String, String>,
}

pub fn resolve_index_target(
    project: &Path,
    cache: &ProjectSpacesCache,
    abs_path: &Path,
) -> Result<(IndexKey, String), IndexError> {
    let rel = abs_path.strip_prefix(project).map_err(|_| {
        IndexError::Index(format!("path outside project root: {}", abs_path.display()))
    })?;

    let rel = repo_relative_from_path(rel, RootMode::Allow)?;
    if rel == "." {
        return Ok((IndexKey::Root(project.to_path_buf()), String::new()));
    }

    let segments: Vec<&str> = rel.split('/').collect();
    if let Some(space_id) = cache.by_folder.get(segments[0]) {
        if !matches!(cache.status_by_id.get(space_id), Some(SpaceStatus::Ready)) {
            return Err(IndexError::Index(format!(
                "target space unavailable: {}",
                segments[0]
            )));
        }
        return Ok((
            IndexKey::Space {
                project: project.to_path_buf(),
                space_id: space_id.clone(),
            },
            segments[1..].join("/"),
        ));
    }

    Ok((IndexKey::Root(PathBuf::from(project)), segments.join("/")))
}

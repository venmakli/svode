use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{IndexError, IndexKey};
use crate::git::path::{RootMode, repo_relative_from_path};
use crate::page::{PageSourceError, SpaceReadiness, read_project_config, space_reference_status};

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

impl ProjectSpacesCache {
    /// Space cache of `project` from its portable config: every registered
    /// child Space with its readiness, and the display names of ready ones.
    pub fn from_project(project: &Path) -> Result<Self, PageSourceError> {
        let config = read_project_config(project)?;
        let mut cache = Self {
            root_name: config.name,
            ..Self::default()
        };
        for space in config.spaces.unwrap_or_default() {
            let status = match space_reference_status(project, &space.path, space.repo.as_deref()) {
                SpaceReadiness::Ready => SpaceStatus::Ready,
                SpaceReadiness::Missing => SpaceStatus::Missing,
                SpaceReadiness::Broken => SpaceStatus::Broken,
            };
            if status == SpaceStatus::Ready {
                cache.name_by_id.insert(
                    space.id.clone(),
                    child_space_name(&project.join(&space.path), &space.path),
                );
            }
            cache.by_folder.insert(space.path.clone(), space.id.clone());
            cache.folder_by_id.insert(space.id.clone(), space.path);
            cache.status_by_id.insert(space.id, status);
        }
        Ok(cache)
    }
}

/// Display name of a child Space from its own config. Falls back to
/// `folder_name`: the name is presentation, not a critical path.
pub fn child_space_name(space_dir: &Path, folder_name: &str) -> String {
    match read_project_config(space_dir) {
        Ok(config) => config.name,
        Err(error) => {
            tracing::warn!(
                "read child space name failed for {}: {error}",
                space_dir.display()
            );
            folder_name.to_string()
        }
    }
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

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn cache_from_portable_config_names_ready_spaces_and_keeps_ghosts() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path();
        write(
            &project.join(".svode/config.json"),
            r#"{"name":"Project","spaces":[
                {"id":"a","path":"alpha","repo":null},
                {"id":"b","path":"beta","repo":null},
                {"id":"c","path":"gamma","repo":"https://example.com/c.git"}
            ]}"#,
        );
        write(
            &project.join("alpha/.svode/config.json"),
            r#"{"name":"Alpha"}"#,
        );

        let cache = ProjectSpacesCache::from_project(project).unwrap();

        assert_eq!(cache.root_name, "Project");
        assert_eq!(cache.by_folder.get("alpha").map(String::as_str), Some("a"));
        assert_eq!(
            cache.folder_by_id.get("c").map(String::as_str),
            Some("gamma")
        );
        assert_eq!(cache.status_by_id.get("a"), Some(&SpaceStatus::Ready));
        assert_eq!(cache.status_by_id.get("b"), Some(&SpaceStatus::Broken));
        assert_eq!(cache.status_by_id.get("c"), Some(&SpaceStatus::Missing));
        assert_eq!(cache.name_by_id.get("a").map(String::as_str), Some("Alpha"));
        assert!(!cache.name_by_id.contains_key("b"));
    }

    #[test]
    fn missing_or_invalid_config_is_a_typed_error() {
        let temp = tempfile::tempdir().unwrap();
        assert!(matches!(
            ProjectSpacesCache::from_project(temp.path()),
            Err(PageSourceError::Missing(_))
        ));
        write(&temp.path().join(".svode/config.json"), "{");
        assert!(matches!(
            ProjectSpacesCache::from_project(temp.path()),
            Err(PageSourceError::InvalidConfig(_))
        ));
    }

    #[test]
    fn child_name_falls_back_to_folder() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(child_space_name(temp.path(), "folder"), "folder");
    }
}

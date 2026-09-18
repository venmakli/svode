use std::fs;
use std::path::{Path, PathBuf};

use crate::error::AppError;

use super::config;
use super::project;
use super::types::SpaceStatus;

#[derive(Debug, Clone)]
pub struct ResolvedSpaceTarget {
    pub project_path: PathBuf,
    pub space_id: Option<String>,
    pub space_path: PathBuf,
}

pub fn resolve_space_target(
    project_path: &Path,
    space_id: Option<&str>,
) -> Result<ResolvedSpaceTarget, AppError> {
    let project_path = canonical_regular_directory(project_path, "Project")?;
    let project_config = config::read_space_config(&project_path)?;

    let (space_id, space_path) = match space_id {
        None => (None, project_path.clone()),
        Some(space_id) => {
            let reference = project_config
                .spaces
                .as_deref()
                .unwrap_or_default()
                .iter()
                .find(|reference| reference.id == space_id)
                .ok_or_else(|| AppError::SpaceNotFound(space_id.to_string()))?;
            if project::space_ref_status(&project_path, reference) != SpaceStatus::Ready {
                return Err(AppError::SpaceNotFound(space_id.to_string()));
            }
            let path = canonical_regular_directory(&project_path.join(&reference.path), "Space")?;
            if !path.starts_with(&project_path) {
                return Err(AppError::PathNotAccessible(format!(
                    "registered Space escapes Project boundary: {}",
                    path.display()
                )));
            }
            (Some(space_id.to_string()), path)
        }
    };

    Ok(ResolvedSpaceTarget {
        project_path,
        space_id,
        space_path,
    })
}

fn canonical_regular_directory(path: &Path, label: &str) -> Result<PathBuf, AppError> {
    let canonical = fs::canonicalize(path).map_err(|error| {
        AppError::PathNotAccessible(format!(
            "cannot inspect registered {label} {}: {error}",
            path.display()
        ))
    })?;
    if !canonical.is_dir() {
        return Err(AppError::PathNotAccessible(format!(
            "registered {label} is not a regular directory: {}",
            path.display()
        )));
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn write_project(project: &Path) {
        fs::create_dir_all(project.join(".svode")).unwrap();
        fs::write(
            project.join(".svode/config.json"),
            serde_json::to_vec(&serde_json::json!({
                "name": "Project",
                "spaces": [
                    { "id": "ready", "path": "ready", "repo": null },
                    { "id": "missing", "path": "missing", "repo": "https://example.invalid/missing.git" },
                    { "id": "broken", "path": "broken", "repo": null }
                ]
            }))
            .unwrap(),
        )
        .unwrap();
        fs::create_dir_all(project.join("ready")).unwrap();
    }

    #[test]
    fn resolves_root_and_registered_ready_child_without_bootstrap_writes() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        write_project(&project);

        let root = resolve_space_target(&project, None).unwrap();
        assert_eq!(root.space_path, project.canonicalize().unwrap());
        assert_eq!(root.space_id, None);

        let child = resolve_space_target(&project, Some("ready")).unwrap();
        assert_eq!(
            child.space_path,
            project.join("ready").canonicalize().unwrap()
        );
        assert_eq!(child.space_id.as_deref(), Some("ready"));
        assert!(!project.join("ready/.svode").exists());
        assert!(!project.join("README.md").exists());
    }

    #[test]
    fn rejects_missing_broken_and_unknown_children() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        write_project(&project);

        for id in ["missing", "broken", "unknown"] {
            assert!(matches!(
                resolve_space_target(&project, Some(id)),
                Err(AppError::SpaceNotFound(found)) if found == id
            ));
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_registered_child_symlink_that_escapes_project() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        write_project(&project);
        let outside = temp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::remove_dir(project.join("ready")).unwrap();
        symlink(&outside, project.join("ready")).unwrap();

        assert!(matches!(
            resolve_space_target(&project, Some("ready")),
            Err(AppError::PathNotAccessible(_))
        ));
    }
}

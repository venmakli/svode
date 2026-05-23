use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::AppError;
use crate::space::config;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveProjectContext {
    pub project_path: String,
    pub active_space_id: Option<String>,
    pub active_space_path: String,
}

#[derive(Default)]
pub struct ActiveProjectState {
    inner: Mutex<Option<ActiveProjectContext>>,
}

impl ActiveProjectState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(&self, context: ActiveProjectContext) {
        *self.inner.lock().expect("active project mutex poisoned") = Some(context);
    }

    pub fn clear(&self) {
        *self.inner.lock().expect("active project mutex poisoned") = None;
    }

    pub fn get(&self) -> Option<ActiveProjectContext> {
        self.inner
            .lock()
            .expect("active project mutex poisoned")
            .clone()
    }
}

pub fn build_context(
    project_path: String,
    active_space_id: Option<String>,
    active_space_path: Option<String>,
) -> Result<ActiveProjectContext, AppError> {
    let project = canonicalize_context_path("project", PathBuf::from(project_path))?;
    let space_path = match (active_space_id.as_deref(), active_space_path) {
        (_, Some(path)) if !path.trim().is_empty() => PathBuf::from(path),
        (Some(space_id), _) => child_space_path(&project, space_id)?,
        (None, _) => project.clone(),
    };
    let space_path = canonicalize_context_path("active space", space_path)?;
    if !space_path.starts_with(&project) {
        return Err(AppError::PathNotAccessible(format!(
            "active space '{}' is outside project '{}'",
            space_path.display(),
            project.display()
        )));
    }
    Ok(ActiveProjectContext {
        project_path: project.to_string_lossy().to_string(),
        active_space_id,
        active_space_path: space_path.to_string_lossy().to_string(),
    })
}

fn child_space_path(project: &Path, space_id: &str) -> Result<PathBuf, AppError> {
    let cfg = config::read_space_config(project)?;
    let Some(space_ref) = cfg
        .spaces
        .as_ref()
        .and_then(|spaces| spaces.iter().find(|space| space.id == space_id))
    else {
        return Err(AppError::SpaceNotFound(space_id.to_string()));
    };
    Ok(project.join(&space_ref.path))
}

fn canonicalize_context_path(label: &str, path: PathBuf) -> Result<PathBuf, AppError> {
    path.canonicalize().map_err(|error| {
        AppError::PathNotAccessible(format!(
            "{label} path '{}' could not be canonicalized: {error}",
            path.display()
        ))
    })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn write_project_config(project: &Path, space_path: &str) {
        fs::create_dir_all(project.join(".combai")).unwrap();
        fs::write(
            project.join(".combai").join("config.json"),
            format!(
                r#"{{
  "name": "Test",
  "spaces": [{{ "id": "child", "path": "{space_path}", "repo": null }}]
}}"#
            ),
        )
        .unwrap();
    }

    #[test]
    fn resolves_child_space_to_canonical_path() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        let child = project.join("spaces").join("child");
        fs::create_dir_all(&child).unwrap();
        write_project_config(&project, "spaces/child");

        let context = build_context(
            project.to_string_lossy().to_string(),
            Some("child".to_string()),
            None,
        )
        .unwrap();

        assert_eq!(
            context.project_path,
            project.canonicalize().unwrap().display().to_string()
        );
        assert_eq!(
            context.active_space_path,
            child.canonicalize().unwrap().display().to_string()
        );
    }

    #[test]
    fn rejects_active_space_outside_project_after_canonicalization() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        let outside = dir.path().join("outside");
        fs::create_dir_all(project.join(".combai")).unwrap();
        fs::create_dir_all(&outside).unwrap();

        let result = build_context(
            project.to_string_lossy().to_string(),
            None,
            Some(outside.to_string_lossy().to_string()),
        );

        assert!(result.is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_child_space_outside_project() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        let outside = dir.path().join("outside");
        let link = project.join("spaces").join("escape");
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, &link).unwrap();
        write_project_config(&project, "spaces/escape");

        let result = build_context(
            project.to_string_lossy().to_string(),
            Some("child".to_string()),
            None,
        );

        assert!(result.is_err());
    }
}

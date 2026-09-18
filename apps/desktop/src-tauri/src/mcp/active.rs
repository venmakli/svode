use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::space::read::resolve_space_target;
use crate::{AppError, system_path};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveProjectContext {
    pub project_path: String,
    pub active_space_id: Option<String>,
    pub active_space_path: String,
}

#[derive(Default)]
pub struct ActiveProjectState {
    inner: Mutex<ActiveProjectStateInner>,
}

#[derive(Default)]
struct ActiveProjectStateInner {
    contexts_by_window: HashMap<String, ActiveProjectContext>,
    last_focused_window: Option<String>,
    fallback_context: Option<ActiveProjectContext>,
}

impl ActiveProjectState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(&self, context: ActiveProjectContext) {
        let mut inner = self.inner.lock().expect("active project mutex poisoned");
        inner.fallback_context = Some(context);
    }

    pub fn set_for_window(&self, window_label: impl Into<String>, context: ActiveProjectContext) {
        let window_label = window_label.into();
        let mut inner = self.inner.lock().expect("active project mutex poisoned");
        inner
            .contexts_by_window
            .insert(window_label.clone(), context.clone());
        inner.last_focused_window = Some(window_label);
        inner.fallback_context = Some(context);
    }

    pub fn clear(&self) {
        let mut inner = self.inner.lock().expect("active project mutex poisoned");
        inner.fallback_context = None;
        if let Some(window_label) = inner.last_focused_window.clone() {
            inner.contexts_by_window.remove(&window_label);
        }
    }

    pub fn clear_window(&self, window_label: &str) {
        let mut inner = self.inner.lock().expect("active project mutex poisoned");
        inner.contexts_by_window.remove(window_label);
        if inner.last_focused_window.as_deref() == Some(window_label) {
            inner.last_focused_window = None;
        }
        inner.fallback_context = inner.contexts_by_window.values().next().cloned();
    }

    pub fn focus_window(&self, window_label: impl Into<String>) {
        let mut inner = self.inner.lock().expect("active project mutex poisoned");
        inner.last_focused_window = Some(window_label.into());
    }

    pub fn remove_window(&self, window_label: &str) {
        self.clear_window(window_label);
    }

    pub fn get(&self) -> Option<ActiveProjectContext> {
        let inner = self.inner.lock().expect("active project mutex poisoned");
        if let Some(window_label) = inner.last_focused_window.as_deref() {
            return inner.contexts_by_window.get(window_label).cloned();
        }
        inner
            .contexts_by_window
            .values()
            .next()
            .cloned()
            .or_else(|| inner.fallback_context.clone())
    }
}

pub fn build_context(
    project_path: String,
    active_space_id: Option<String>,
    active_space_path: Option<String>,
) -> Result<ActiveProjectContext, AppError> {
    let target = resolve_space_target(Path::new(&project_path), active_space_id.as_deref())?;
    if let Some(provided_path) = active_space_path.filter(|path| !path.trim().is_empty()) {
        let provided_path =
            canonicalize_context_path("active space", PathBuf::from(provided_path))?;
        if provided_path != target.space_path {
            return Err(AppError::PathNotAccessible(format!(
                "active space '{}' does not match registered target '{}'",
                provided_path.display(),
                target.space_path.display()
            )));
        }
    }
    if !target.space_path.starts_with(&target.project_path) {
        return Err(AppError::PathNotAccessible(format!(
            "active space '{}' is outside project '{}'",
            target.space_path.display(),
            target.project_path.display()
        )));
    }
    Ok(ActiveProjectContext {
        project_path: system_path::user_facing_path(&target.project_path),
        active_space_id: target.space_id,
        active_space_path: system_path::user_facing_path(&target.space_path),
    })
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
        fs::create_dir_all(project.join(".svode")).unwrap();
        fs::write(
            project.join(".svode").join("config.json"),
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
        fs::create_dir_all(project.join(".svode")).unwrap();
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

    #[test]
    fn rejects_active_space_path_that_does_not_match_registered_id() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        let child = project.join("spaces/child");
        let other = project.join("other");
        fs::create_dir_all(&child).unwrap();
        fs::create_dir_all(&other).unwrap();
        write_project_config(&project, "spaces/child");

        let result = build_context(
            project.to_string_lossy().to_string(),
            Some("child".to_string()),
            Some(other.to_string_lossy().to_string()),
        );

        assert!(matches!(result, Err(AppError::PathNotAccessible(_))));
    }
}

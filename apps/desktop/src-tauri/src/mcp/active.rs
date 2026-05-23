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
    let project = PathBuf::from(project_path);
    let space_path = match (active_space_id.as_deref(), active_space_path) {
        (_, Some(path)) if !path.trim().is_empty() => PathBuf::from(path),
        (Some(space_id), _) => child_space_path(&project, space_id)?,
        (None, _) => project.clone(),
    };
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

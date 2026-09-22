//! Project/Space target of one command, frozen before it runs. Explicit
//! selectors win; otherwise the current directory selects the nearest
//! Project and the most specific ready child Space containing it.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};
use svode_core::page::{
    PageSourceError, ResolvedSpaceTarget, project_for_directory, ready_child_space_for_directory,
    resolve_space_target,
};
use svode_tools::host::RequestTarget;
use svode_tools::target::ROOT_SPACE_ID;

use crate::error::CliError;

const SELECTOR_HINT: &str =
    "pass --project and --space, or run inside a Svode project; see `svode --help`";

/// Project and Space selectors as the caller passed them, with the
/// directory the command runs in.
pub struct Selectors<'a> {
    pub project: Option<&'a str>,
    pub space: Option<&'a str>,
    pub cwd: &'a Path,
}

/// Resolved target of one command.
pub struct Target {
    pub space: ResolvedSpaceTarget,
    /// Whether `--space` selected the Space explicitly.
    pub explicit_space: bool,
}

impl Selectors<'_> {
    fn project_dir(&self) -> Option<PathBuf> {
        self.project.map(|project| self.cwd.join(project))
    }

    /// Selectors known before resolution; an explicit Project path is only
    /// joined with the current directory, never resolved.
    pub fn known(&self) -> Map<String, Value> {
        let mut target = Map::new();
        if let Some(project) = self.project_dir() {
            target.insert("projectPath".into(), json!(project.display().to_string()));
        }
        if let Some(space) = self.space {
            target.insert("spaceId".into(), json!(space));
        }
        target
    }

    pub fn resolve(&self) -> Result<Target, CliError> {
        let context_error = |error: PageSourceError, fallback: &'static str| {
            let code = match error {
                PageSourceError::InvalidConfig(_) => "INVALID_PROJECT_CONFIG",
                _ => fallback,
            };
            CliError::operation(code, error.to_string())
                .with_target(self.known())
                .with_hint(SELECTOR_HINT)
        };
        let cwd = self
            .cwd
            .canonicalize()
            .unwrap_or_else(|_| self.cwd.to_path_buf());
        let project_dir = match self.project_dir() {
            Some(project) => project,
            None => project_for_directory(&cwd).ok_or_else(|| {
                CliError::operation(
                    "PROJECT_UNAVAILABLE",
                    format!("no Svode project contains {}", cwd.display()),
                )
                .with_target(self.known())
                .with_hint(SELECTOR_HINT)
            })?,
        };
        let project = resolve_space_target(&project_dir, None)
            .map_err(|error| context_error(error, "PROJECT_UNAVAILABLE"))?;
        let space = match self.space {
            Some(ROOT_SPACE_ID) => project,
            Some(space_id) => {
                resolve_space_target(&project.project_path, Some(space_id)).map_err(|error| {
                    let mut error = context_error(error, "SPACE_UNAVAILABLE");
                    error.target.insert(
                        "projectPath".into(),
                        json!(project.project_path.display().to_string()),
                    );
                    error
                })?
            }
            None => match ready_child_space_for_directory(&project.project_path, &cwd) {
                Some((space_id, space_path)) => ResolvedSpaceTarget {
                    project_path: project.project_path,
                    space_id: Some(space_id),
                    space_path,
                },
                None => project,
            },
        };
        Ok(Target {
            space,
            explicit_space: self.space.is_some(),
        })
    }
}

impl Target {
    /// Resolved target keys of the JSON envelope.
    pub fn envelope(&self) -> Map<String, Value> {
        let mut target = Map::new();
        target.insert(
            "projectPath".into(),
            json!(self.space.project_path.display().to_string()),
        );
        target.insert("spaceId".into(), json!(self.space_id()));
        target.insert(
            "spacePath".into(),
            json!(self.space.space_path.display().to_string()),
        );
        target
    }

    pub fn space_id(&self) -> &str {
        self.space.space_id.as_deref().unwrap_or(ROOT_SPACE_ID)
    }

    /// Request target of the shared tool surface: the resolved Space is the
    /// frozen default of the call.
    pub fn request(&self) -> RequestTarget {
        RequestTarget {
            project_path: self.space.project_path.to_string_lossy().to_string(),
            default_space_id: self.space.space_id.clone(),
            default_space_path: self.space.space_path.to_string_lossy().to_string(),
            routine_caller: None,
        }
    }
}

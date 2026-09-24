//! Project/Space target of one command, frozen before it runs. Explicit
//! selectors win; otherwise the current directory selects the nearest
//! Project and the most specific ready child Space containing it.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};
use svode_core::page::{ResolvedSpaceTarget, project_for_directory};
use svode_tools::error::ToolError;
use svode_tools::host::{RequestTarget, ToolHost};
use svode_tools::standalone::request_target;
use svode_tools::target::{ROOT_SPACE_ID, resolve_default_space, resolve_project};

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
        let context_error = |error: ToolError| {
            CliError::operation(error.code, error.message)
                .with_target(self.known())
                .with_hint(SELECTOR_HINT)
        };
        let project_dir = match self.project_dir() {
            Some(project) => project,
            None => {
                let cwd = self
                    .cwd
                    .canonicalize()
                    .unwrap_or_else(|_| self.cwd.to_path_buf());
                project_for_directory(&cwd).ok_or_else(|| {
                    CliError::operation(
                        "PROJECT_UNAVAILABLE",
                        format!("no Svode project contains {}", cwd.display()),
                    )
                    .with_target(self.known())
                    .with_hint(SELECTOR_HINT)
                })?
            }
        };
        let project = resolve_project(&project_dir).map_err(context_error)?;
        let project_path = project.project_path.display().to_string();
        let space = resolve_default_space(project, self.space, self.cwd).map_err(|error| {
            let mut error = context_error(error);
            error
                .target
                .insert("projectPath".into(), json!(project_path));
            error
        })?;
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

    /// Binds the runtime of `host` to the resolved Project before the
    /// command runs, so its operations resolve Spaces and pools of this
    /// Project.
    pub async fn open(&self, host: &impl ToolHost) -> Result<(), CliError> {
        host.open_project(&self.space.project_path)
            .await
            .map_err(|error| {
                CliError::operation(error.code, error.message).with_target(self.envelope())
            })
    }

    /// Request target of the shared tool surface: the resolved Space is the
    /// frozen default of the call.
    pub fn request(&self) -> RequestTarget {
        request_target(&self.space)
    }
}

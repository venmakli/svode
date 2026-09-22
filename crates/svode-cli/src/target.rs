//! Explicit Project/Space target of one command, frozen before it runs.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};
use svode_core::page::{PageSourceError, ResolvedSpaceTarget, resolve_space_target};

use crate::error::CliError;
use crate::grammar::ROOT_SPACE_ID;

const SELECTOR_HINT: &str =
    "check --project and --space; run `svode page read --help` for the selectors";

/// Project and Space selectors as the caller passed them.
pub struct Selectors<'a> {
    pub project: &'a str,
    pub space: &'a str,
}

impl Selectors<'_> {
    /// Selectors known before resolution; the Project path is only joined
    /// with the current directory, never resolved.
    pub fn known(&self) -> Map<String, Value> {
        let project = Path::new(self.project);
        let project = if project.is_absolute() {
            project.to_path_buf()
        } else {
            std::env::current_dir()
                .map(|cwd| cwd.join(project))
                .unwrap_or_else(|_| PathBuf::from(project))
        };
        let mut target = Map::new();
        target.insert("projectPath".into(), json!(project.display().to_string()));
        target.insert("spaceId".into(), json!(self.space));
        target
    }

    pub fn resolve(&self) -> Result<ResolvedSpaceTarget, CliError> {
        let context_error = |error: PageSourceError, fallback: &'static str| {
            let code = match error {
                PageSourceError::InvalidConfig(_) => "INVALID_PROJECT_CONFIG",
                _ => fallback,
            };
            CliError::operation(code, error.to_string())
                .with_target(self.known())
                .with_hint(SELECTOR_HINT)
        };
        let project = resolve_space_target(Path::new(self.project), None)
            .map_err(|error| context_error(error, "PROJECT_UNAVAILABLE"))?;
        if self.space == ROOT_SPACE_ID {
            return Ok(project);
        }
        resolve_space_target(&project.project_path, Some(self.space)).map_err(|error| {
            let mut error = context_error(error, "SPACE_UNAVAILABLE");
            error.target.insert(
                "projectPath".into(),
                json!(project.project_path.display().to_string()),
            );
            error
        })
    }
}

/// Resolved target keys of the JSON envelope.
pub fn resolved(space: &ResolvedSpaceTarget) -> Map<String, Value> {
    let mut target = Map::new();
    target.insert(
        "projectPath".into(),
        json!(space.project_path.display().to_string()),
    );
    target.insert(
        "spaceId".into(),
        json!(space.space_id.as_deref().unwrap_or(ROOT_SPACE_ID)),
    );
    target.insert(
        "spacePath".into(),
        json!(space.space_path.display().to_string()),
    );
    target
}

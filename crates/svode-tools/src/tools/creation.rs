//! Creation of Spaces and Projects through the shared core operations
//! (Stage 11 05): the host only gives its Git host and takes the result into
//! its runtime; the tool projects the settings the creation applied.
//! Creating never commits: the result names, per repository, who commits the
//! creation.

use std::path::{Component, Path, PathBuf};

use serde::Deserialize;
use serde_json::{Value, json};
use svode_core::project::root::{self, ProjectCreate, ProjectRepository, Registration};
use svode_core::project::space::{
    self, AppliedStorage, CreationCommit, RepositoryOutcome, SpaceCreate,
};
use svode_core::storage::config::SpaceGitType;

use crate::error::ToolError;
use crate::host::{NextRequests, RequestTarget, ToolHost};
use crate::result::ToolCallResult;

/// Where the settings a creation leaves at their defaults are changed.
pub(crate) const SETTINGS_LOCATION: &str = "Svode Desktop → Settings → Git / Storage";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateSpaceArgs {
    name: String,
    folder: String,
    #[serde(default = "inline")]
    git_type: SpaceGitType,
    #[serde(default)]
    icon: Option<String>,
    #[serde(default)]
    description: Option<String>,
}

fn inline() -> SpaceGitType {
    SpaceGitType::Inline
}

/// Creates a child Space of the target Project: always of the root, never
/// of the default Space of the request.
pub(crate) async fn create_space(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: CreateSpaceArgs,
) -> Result<ToolCallResult, ToolError> {
    let git_host = host
        .git_host()
        .ok_or_else(|| ToolError::new("UNKNOWN_TOOL", "unknown Svode MCP tool: create_space"))?;
    let project = PathBuf::from(&target.project_path);
    let created = space::create(
        host.read_runtime().git,
        git_host,
        SpaceCreate {
            project: project.clone(),
            name: args.name,
            folder: args.folder,
            git_type: args.git_type,
            icon: args.icon,
            description: args.description,
        },
    )
    .await?;
    host.space_created(&project, &created).await;

    let git_type = git_type_name(created.git_type);
    let summary = format!(
        "Created {git_type} space {} ({}). {}",
        created.folder,
        created.name,
        commit_summary(&created.repositories)
    );
    Ok(ToolCallResult::ok(
        summary,
        json!({
            "space": {
                "id": created.id,
                "name": created.name,
                "folder": created.folder,
                "gitType": git_type,
                "icon": created.icon,
                "description": created.description,
            },
            "repositories": created.repositories.iter().map(repository).collect::<Vec<_>>(),
            "storage": storage(&created.storage),
            "settings": SETTINGS_LOCATION,
            "changedPaths": relative_paths(&project, &created.changed_paths),
        }),
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateProjectArgs {
    path: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    icon: Option<String>,
    #[serde(default)]
    description: Option<String>,
}

/// Next step after an existing repository of a new Project was refused for
/// missing write access evidence.
const PROJECT_ACCESS_HINT: &str = "Write access to this Git repository is not verified on this device. Create the project in Svode Desktop with Open folder, which creates and registers it there, or ask the user.";

/// Next step of a caller whose next requests do not address the created
/// Project.
fn other_session_hint(project: &str) -> String {
    format!(
        "Work with the new project through `svode --project {project}` or a new agent session started in its folder."
    )
}

/// Creates a Project outside any Project: in a new folder or an existing
/// one without `.svode/config.json`, Git repositories included. The path is
/// absolute; a request needs no target, and the host reports which Project
/// its next requests address.
pub(crate) async fn create_project(
    host: &impl ToolHost,
    target: Option<&RequestTarget>,
    args: CreateProjectArgs,
) -> Result<ToolCallResult, ToolError> {
    let git_host = host
        .git_host()
        .ok_or_else(|| ToolError::new("UNKNOWN_TOOL", "unknown Svode MCP tool: create_project"))?;
    let path = absolute_project_path(&args.path)?;
    let list = host.project_list_dir();
    let created = root::create(
        host.read_runtime().git,
        git_host,
        list.as_deref(),
        ProjectCreate {
            path,
            name: args.name,
            icon: args.icon,
            description: args.description,
        },
    )
    .await
    .map_err(|error| match ToolError::from(error) {
        // Access is verified for a Space of a Project; the folder is not
        // one yet.
        denied if denied.code == "REPOSITORY_ACCESS_DENIED" => {
            denied.with_evidence("hint", PROJECT_ACCESS_HINT.into())
        }
        error => error,
    })?;
    let next = host.project_created(target, &created).await;

    let path = created.path.to_string_lossy().to_string();
    let (id, registration) = match &created.registration {
        Registration::Registered { id } => (Some(id.clone()), json!({ "registered": true })),
        Registration::NoDeviceDirectory => (
            None,
            json!({
                "registered": false,
                "reason": "no_device_directory",
                "hint": "This device has no Svode config directory: open the folder in Svode Desktop to add the project to its project list.",
            }),
        ),
    };
    let repositories = match &created.repository {
        ProjectRepository::Repository(outcome) => vec![repository(outcome)],
        ProjectRepository::GitNotFound => Vec::new(),
    };
    let summary = format!(
        "Created project {} at {path}. {} {} {}",
        created.name,
        project_repository_summary(&created.repository),
        match &created.registration {
            Registration::Registered { .. } => "It is in the project list of this device.",
            Registration::NoDeviceDirectory => {
                "It is not in a project list: open the folder in Svode Desktop to add it."
            }
        },
        next_requests_summary(&next, &path),
    );
    Ok(ToolCallResult::ok(
        summary,
        json!({
            "project": {
                "id": id,
                "name": created.name,
                "path": path,
                "icon": created.icon,
                "description": created.description,
            },
            "registration": registration,
            "repositories": repositories,
            "gitNotFound": created.repository == ProjectRepository::GitNotFound,
            "storage": storage(&created.storage),
            "session": session(&next, &path),
            "settings": SETTINGS_LOCATION,
            "changedPaths": relative_paths(&created.path, &created.changed_paths),
        }),
    ))
}

/// The folder of a new Project: an absolute path, `.` and `..` resolved
/// without following links.
fn absolute_project_path(path: &str) -> Result<PathBuf, ToolError> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err(ToolError::new(
            "INVALID_PATH",
            format!("The project path must be absolute: {}", path.display()),
        ));
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    Ok(normalized)
}

fn project_repository_summary(repository: &ProjectRepository) -> &'static str {
    match repository {
        ProjectRepository::Repository(outcome) if outcome.created => {
            "Its new Git repository has no commit: a new project commits manually until its commit settings change in Svode Desktop."
        }
        ProjectRepository::Repository(_) => {
            "It is in the existing Git repository of the folder; nothing was committed: a new project commits manually until its commit settings change in Svode Desktop."
        }
        ProjectRepository::GitNotFound => {
            "Git was not found, so the project has no Git repository."
        }
    }
}

fn next_requests_summary(next: &NextRequests, project: &str) -> String {
    match next {
        NextRequests::BoundToCreated
        | NextRequests::ByCallerDirectory {
            addresses_created: true,
        } => "The next calls of this session address the new project.".to_string(),
        NextRequests::KeptProject(Some(previous)) => format!(
            "This session keeps working with {}. {}",
            previous.display(),
            other_session_hint(project)
        ),
        NextRequests::KeptProject(None)
        | NextRequests::ByCallerDirectory {
            addresses_created: false,
        } => format!(
            "The next calls of this session do not address the new project. {}",
            other_session_hint(project)
        ),
        NextRequests::PerCommand => {
            format!("Run the next svode commands in its folder or pass --project {project}.")
        }
    }
}

/// Which Project the next requests of the caller address.
fn session(next: &NextRequests, project: &str) -> Value {
    match next {
        NextRequests::BoundToCreated => json!({
            "addressing": "session",
            "addressesCreatedProject": true,
        }),
        NextRequests::KeptProject(previous) => json!({
            "addressing": "session",
            "addressesCreatedProject": false,
            "project": previous.as_ref().map(|previous| previous.to_string_lossy()),
            "hint": other_session_hint(project),
        }),
        NextRequests::ByCallerDirectory {
            addresses_created: true,
        } => json!({
            "addressing": "caller_directory",
            "addressesCreatedProject": true,
        }),
        NextRequests::ByCallerDirectory {
            addresses_created: false,
        } => json!({
            "addressing": "caller_directory",
            "addressesCreatedProject": false,
            "hint": other_session_hint(project),
        }),
        NextRequests::PerCommand => json!({
            "addressing": "per_command",
            "addressesCreatedProject": false,
            "hint": format!("Each svode command addresses the project of its directory: run the next commands in {project} or pass --project {project}."),
        }),
    }
}

fn git_type_name(git_type: SpaceGitType) -> &'static str {
    match git_type {
        SpaceGitType::Inline => "inline",
        SpaceGitType::Independent => "independent",
        SpaceGitType::Submodule => "submodule",
    }
}

/// One repository a creation touched and who commits the creation there.
pub(crate) fn repository(outcome: &RepositoryOutcome) -> Value {
    let commit = match &outcome.commit {
        CreationCommit::Desktop { message } => json!({ "by": "desktop", "message": message }),
        CreationCommit::Manual => json!({
            "by": "manual",
            "reason": if outcome.created { "new_repository" } else { "structural_commits_off" },
        }),
    };
    json!({
        "path": outcome.path,
        "created": outcome.created,
        "initialBranch": outcome.initial_branch,
        "upstream": outcome.upstream,
        "commit": commit,
    })
}

/// The storage policy in effect: the strategy, binary routing and whether
/// it is inherited from the Project.
pub(crate) fn storage(applied: &AppliedStorage) -> Value {
    let assets = applied.assets.clone().unwrap_or_default();
    json!({
        "inherited": applied.inherited,
        "strategy": assets.strategy,
        "binaryRouting": assets.binary_routing.map(|routing| json!({
            "lfsExtensions": routing.lfs_extensions,
            "lfsThresholdBytes": routing.lfs_threshold_bytes,
        })),
    })
}

fn commit_summary(repositories: &[RepositoryOutcome]) -> String {
    let desktop = repositories
        .iter()
        .find_map(|outcome| match &outcome.commit {
            CreationCommit::Desktop { message } => Some(message.as_str()),
            CreationCommit::Manual => None,
        });
    if repositories.is_empty() {
        return "The project has no Git repository, so there is nothing to commit.".to_string();
    }
    match desktop {
        Some(message) => format!(
            "Svode Desktop commits the creation in the project repository (\"{message}\"); this call made no commit."
        ),
        None => "Nothing was committed: the changes wait for a manual commit.".to_string(),
    }
}

/// Changed files relative to the Project, without repeats, in the order
/// the creation wrote them.
pub(crate) fn relative_paths(project: &Path, paths: &[PathBuf]) -> Vec<String> {
    let mut relative = Vec::<String>::new();
    for path in paths {
        let path = path
            .strip_prefix(project)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        if !relative.contains(&path) {
            relative.push(path);
        }
    }
    relative
}

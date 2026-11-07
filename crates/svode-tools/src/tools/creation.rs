//! Creation of Spaces through the shared core operation (Stage 11 05): the
//! host only gives its Git host and takes the result into its runtime; the
//! tool projects the settings the creation applied. Creating never commits:
//! the result names, per repository, who commits the creation.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{Value, json};
use svode_core::project::space::{
    self, AppliedStorage, CreationCommit, RepositoryOutcome, SpaceCreate,
};
use svode_core::storage::config::SpaceGitType;

use crate::error::ToolError;
use crate::host::{RequestTarget, ToolHost};
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

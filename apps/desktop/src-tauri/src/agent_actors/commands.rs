use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{AppHandle, State};

use super::{
    AgentActorMutationInput, AgentActorResolution, CatalogError, catalog_path,
    mutate_catalog_compound, read_catalog, resolve_catalogs, set_local_approval,
};
use crate::AppError;
use crate::git::GitState;
use crate::git::access::{RepositoryAccessState, access_store_path};
use crate::git::autocommit::{
    AutocommitService, ExactPathPersistenceOutcome, GuardedExactPathPlan,
};
use crate::git::commands::require_cli;
use crate::git::ops;
use crate::space::types::SpaceGitType;

const COMMIT_MESSAGE: &str = "Update agent actors";
const SUBMODULE_POINTER_COMMIT_MESSAGE: &str = "Update space pointer";

enum RootPointerPlan {
    Guarded(GuardedExactPathPlan),
    Failed(String),
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentActorsReadResult {
    pub resolution: AgentActorResolution,
    pub own_fingerprint: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AgentActorMutationResult {
    Applied {
        fingerprint: String,
        persistence: ExactPathPersistenceOutcome,
        #[serde(skip_serializing_if = "Option::is_none")]
        root_pointer: Option<ExactPathPersistenceOutcome>,
    },
    Stale {
        fingerprint: Option<String>,
    },
    Blocked {
        message: String,
    },
}

#[tauri::command]
pub async fn agent_actors_get(
    project_path: Option<String>,
    space_path: String,
    standalone: Option<bool>,
) -> Result<AgentActorsReadResult, AppError> {
    let own = canonical_space_path(Path::new(&space_path))?;
    let inherited_root = if standalone.unwrap_or(false) {
        crate::space::config::read_space_config(&own)?;
        None
    } else if let Some(project_path) = project_path {
        let (project, own) = validate_registered_owner(Path::new(&project_path), &own)?;
        (project != own).then_some(project)
    } else {
        crate::space::config::read_space_config(&own)?;
        None
    };
    let own_fingerprint = read_catalog(&own).ok().map(|(_, fingerprint)| fingerprint);
    Ok(AgentActorsReadResult {
        resolution: resolve_catalogs(&own, inherited_root.as_deref()),
        own_fingerprint,
    })
}

/// One owner-targeted mutation. Access and exact-path safety are captured
/// before any write while the target repository lock remains held.
#[tauri::command]
pub async fn agent_actors_mutate(
    app: AppHandle,
    project_path: String,
    owner_path: String,
    expected_fingerprint: String,
    mutation: AgentActorMutationInput,
    git_state: State<'_, GitState>,
    access_state: State<'_, RepositoryAccessState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<AgentActorMutationResult, AppError> {
    let (project, owner) =
        validate_registered_owner(Path::new(&project_path), Path::new(&owner_path))?;
    let cli = require_cli(&git_state)?;
    let (git_type, repository) = ops::resolve_target_repo(&cli, &project, &owner).await?;
    let lock = git_state.get_lock(&repository).await;
    let _guard = lock.lock().await;

    access_state
        .require_mutation(&cli, &repository, &access_store_path(&app)?)
        .await?;
    // A readable root catalog is part of the effective child domain. Reject a
    // new collision before any local/portable write; an unreadable root stays
    // diagnostic-only and must not block a child owner mutation.
    if owner != project {
        if let Some(actor_id) = mutation.create_actor_id() {
            let root_lock = (repository != project).then(|| git_state.get_lock(&project));
            let root_lock = match root_lock {
                Some(lock) => Some(lock.await),
                None => None,
            };
            let _root_guard = match root_lock.as_ref() {
                Some(lock) => Some(lock.lock().await),
                None => None,
            };
            if let Ok((root_catalog, _)) = read_catalog(&project) {
                if root_catalog.actors.iter().any(|actor| actor.id == actor_id) {
                    return Ok(AgentActorMutationResult::Blocked {
                        message: format!(
                            "ambiguous_actor_id: agent:{actor_id} already exists in root catalog"
                        ),
                    });
                }
            }
        }
    }
    let mutation = match mutation {
        AgentActorMutationInput::SetApproval {
            actor_id,
            approval_mode,
        } => {
            let fingerprint =
                match set_local_approval(&owner, &expected_fingerprint, &actor_id, approval_mode) {
                    Ok(fingerprint) => fingerprint,
                    Err(CatalogError::Stale) => {
                        return Ok(AgentActorMutationResult::Stale {
                            fingerprint: read_catalog(&owner)
                                .ok()
                                .map(|(_, fingerprint)| fingerprint),
                        });
                    }
                    Err(error) => {
                        return Ok(AgentActorMutationResult::Blocked {
                            message: error.to_string(),
                        });
                    }
                };
            return Ok(AgentActorMutationResult::Applied {
                fingerprint,
                persistence: ExactPathPersistenceOutcome::Clean,
                root_pointer: None,
            });
        }
        mutation => mutation,
    };
    let catalog_target = catalog_relative_path(&repository, &owner)?;
    let plan = autocommit
        .plan_guarded_system_exact_path(&cli, &repository, &catalog_target)
        .await?;
    let root_pointer_plan = if git_type == SpaceGitType::Submodule {
        let target = direct_child_target(&project, &owner)?;
        let root_lock = git_state.get_lock(&project).await;
        let _root_guard = root_lock.lock().await;
        let plan = match autocommit
            .plan_guarded_structural_exact_path(&cli, &project, &target, true)
            .await
        {
            Ok(plan) => RootPointerPlan::Guarded(plan),
            Err(error) => RootPointerPlan::Failed(error.to_string()),
        };
        Some((target, plan))
    } else {
        None
    };
    let next =
        match mutate_catalog_compound(&owner, &expected_fingerprint, mutation.into_compound()) {
            Ok(catalog) => catalog,
            Err(CatalogError::Stale) => {
                return Ok(AgentActorMutationResult::Stale {
                    fingerprint: read_catalog(&owner)
                        .ok()
                        .map(|(_, fingerprint)| fingerprint),
                });
            }
            Err(error) => {
                return Ok(AgentActorMutationResult::Blocked {
                    message: error.to_string(),
                });
            }
        };
    let target_matches_expected = read_catalog(&owner)
        .map(|(current, _)| current == next)
        .unwrap_or(false);
    let persistence = autocommit
        .finish_guarded_exact_path_commit(
            &cli,
            &owner,
            &repository,
            &catalog_target,
            COMMIT_MESSAGE,
            plan,
            target_matches_expected,
        )
        .await;
    let fingerprint = read_catalog(&owner)
        .map(|(_, fingerprint)| fingerprint)
        .unwrap_or_default();
    let root_pointer = if persistence == ExactPathPersistenceOutcome::Committed {
        if let Some((target, root_plan)) = root_pointer_plan {
            let root_lock = git_state.get_lock(&project).await;
            let _root_guard = root_lock.lock().await;
            Some(
                finish_root_pointer(
                    &cli,
                    &project,
                    &owner,
                    &repository,
                    &target,
                    root_plan,
                    &autocommit,
                )
                .await,
            )
        } else {
            None
        }
    } else {
        None
    };
    Ok(AgentActorMutationResult::Applied {
        fingerprint,
        persistence,
        root_pointer,
    })
}

fn validate_registered_owner(project: &Path, owner: &Path) -> Result<(PathBuf, PathBuf), AppError> {
    let project = canonical_space_path(project)?;
    let owner = canonical_space_path(owner)?;
    crate::space::config::read_space_config(&owner)?;
    if project == owner {
        return Ok((project, owner));
    }

    let project_config = crate::space::config::read_space_config(&project)?;
    let registered = project_config
        .spaces
        .unwrap_or_default()
        .into_iter()
        .any(|space| {
            std::fs::canonicalize(project.join(space.path))
                .map(|path| path == owner)
                .unwrap_or(false)
        });
    if !registered {
        return Err(AppError::PathNotAccessible(owner.display().to_string()));
    }
    Ok((project, owner))
}

fn canonical_space_path(path: &Path) -> Result<PathBuf, AppError> {
    std::fs::canonicalize(path).map_err(|error| {
        AppError::General(format!(
            "failed to resolve agent actor Space {}: {error}",
            path.display()
        ))
    })
}

async fn finish_root_pointer(
    cli: &crate::git::cli::GitCli,
    project: &Path,
    owner: &Path,
    repository: &Path,
    target: &str,
    plan: RootPointerPlan,
    autocommit: &AutocommitService,
) -> ExactPathPersistenceOutcome {
    let plan = match plan {
        RootPointerPlan::Guarded(plan) => plan,
        RootPointerPlan::Failed(message) => {
            return ExactPathPersistenceOutcome::Failed { message };
        }
    };
    let expected_head = match ops::repository_head_oid(cli, repository).await {
        Ok(head) => head,
        Err(error) => {
            return ExactPathPersistenceOutcome::Failed {
                message: error.to_string(),
            };
        }
    };
    let matches = match ops::submodule_target_matches_expected_head(
        cli,
        project,
        target,
        repository,
        &expected_head,
    )
    .await
    {
        Ok(matches) => matches,
        Err(error) => {
            return ExactPathPersistenceOutcome::Failed {
                message: error.to_string(),
            };
        }
    };
    autocommit
        .finish_guarded_exact_path_commit(
            cli,
            owner,
            project,
            target,
            SUBMODULE_POINTER_COMMIT_MESSAGE,
            plan,
            matches,
        )
        .await
}

fn direct_child_target(project: &Path, owner: &Path) -> Result<String, AppError> {
    let project = std::fs::canonicalize(project)?;
    let owner = std::fs::canonicalize(owner)?;
    if owner.parent() != Some(project.as_path()) {
        return Err(AppError::General(format!(
            "submodule actor owner {} is not a direct child of project {}",
            owner.display(),
            project.display()
        )));
    }
    owner
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_owned)
        .ok_or_else(|| AppError::General("submodule actor owner name is not UTF-8".into()))
}

fn catalog_relative_path(repository: &Path, owner: &Path) -> Result<String, AppError> {
    let path = catalog_path(owner);
    path.strip_prefix(repository)
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .map_err(|_| {
            AppError::General(format!(
                "actor owner {} is outside its repository {}",
                owner.display(),
                repository.display()
            ))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn inline_catalog_uses_owner_relative_exact_path() {
        let project = tempdir().unwrap();
        let owner = project.path().join("docs");
        std::fs::create_dir_all(&owner).unwrap();

        assert_eq!(
            catalog_relative_path(project.path(), &owner).unwrap(),
            "docs/.svode/agent-actors.json"
        );
        assert_eq!(
            catalog_relative_path(&owner, &owner).unwrap(),
            ".svode/agent-actors.json"
        );
    }

    #[test]
    fn owner_must_be_project_or_registered_child_space() {
        let project = tempdir().unwrap();
        let registered = project.path().join("docs");
        let unregistered = project.path().join("scratch");
        std::fs::create_dir_all(registered.join(".svode")).unwrap();
        std::fs::create_dir_all(unregistered.join(".svode")).unwrap();
        std::fs::create_dir_all(project.path().join(".svode")).unwrap();
        std::fs::write(
            project.path().join(".svode/config.json"),
            r#"{"name":"Root","spaces":[{"id":"docs","path":"docs","repo":null}]}"#,
        )
        .unwrap();
        std::fs::write(registered.join(".svode/config.json"), r#"{"name":"Docs"}"#).unwrap();
        std::fs::write(
            unregistered.join(".svode/config.json"),
            r#"{"name":"Scratch"}"#,
        )
        .unwrap();

        assert!(validate_registered_owner(project.path(), project.path()).is_ok());
        assert!(validate_registered_owner(project.path(), &registered).is_ok());
        assert!(matches!(
            validate_registered_owner(project.path(), &unregistered),
            Err(AppError::PathNotAccessible(_))
        ));
    }
}

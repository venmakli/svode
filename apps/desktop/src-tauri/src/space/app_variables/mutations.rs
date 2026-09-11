use crate::git::autocommit::{
    ExactPathPendingReason, ExactPathPersistenceOutcome, GuardedExactPathPlan,
};
use crate::git::{GitState, autocommit, commands::require_cli, ops};
use crate::{AppError, space::types::SpaceGitType};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    future::Future,
    path::{Path, PathBuf},
};
use svode_core::variables::{Change, Owner};

const CONFIG_MESSAGE: &str = "Update variables";
const POINTER_MESSAGE: &str = "Update space pointer";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VariableGitOutcome {
    pub owner_path: PathBuf,
    pub config: ExactPathPersistenceOutcome,
    pub root_pointer: Option<ExactPathPersistenceOutcome>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VariableMutationResult {
    pub effects: Vec<VariableGitOutcome>,
    pub recovery_error: Option<String>,
}

pub(crate) struct Mutation {
    pub change: Option<Change>,
    pub effect: Option<VariableGitOutcome>,
}

pub(crate) async fn recover_in_order<F, Fut>(
    sources: Vec<svode_core::variables::SourceOwner>,
    mut recover: F,
) -> VariableMutationResult
where
    F: FnMut(svode_core::variables::SourceOwner) -> Fut,
    Fut: Future<Output = Result<Mutation, AppError>>,
{
    let mut result = VariableMutationResult::default();
    for source in sources {
        match recover(source).await {
            Ok(mutation) => result.effects.extend(mutation.effect),
            Err(error) => {
                result.recovery_error = Some(error.to_string());
                break;
            }
        }
    }
    result
}

struct Target {
    owner: PathBuf,
    repo: PathBuf,
    config: String,
    pointer: Option<String>,
    root: PathBuf,
}

fn failed() -> ExactPathPersistenceOutcome {
    // Git hooks/filters may print config values. Never forward their output to Variables consumers.
    ExactPathPersistenceOutcome::Failed {
        message: "Variables saved; Git commit failed".into(),
    }
}
fn sanitize(outcome: ExactPathPersistenceOutcome) -> ExactPathPersistenceOutcome {
    match outcome {
        ExactPathPersistenceOutcome::Failed { .. } => failed(),
        other => other,
    }
}
fn pending() -> ExactPathPersistenceOutcome {
    ExactPathPersistenceOutcome::Pending {
        reason: ExactPathPendingReason::TargetChanged,
    }
}

/// Git locks precede AppSettingsState and the core config writer lock. No write
/// is polled until preflight completes; Git failures never prevent publication.
pub(crate) async fn apply(
    owner: &Owner,
    project: Option<&Path>,
    git: &GitState,
    write: impl Future<Output = Result<Option<Change>, AppError>>,
    committed: impl Fn(&crate::git::cli::GitCli, &Path, &Path),
) -> Result<Mutation, AppError> {
    let Ok(owner_path) = owner.scope_path() else {
        return Ok(Mutation {
            change: write.await?,
            effect: None,
        });
    };
    let target = async {
        let cli = require_cli(git)?;
        let root = project
            .ok_or(AppError::General("Missing Variables project".into()))?
            .canonicalize()?;
        let (kind, repo) = if root == owner_path {
            (SpaceGitType::Inline, root.clone())
        } else {
            ops::resolve_target_repo(&cli, &root, owner_path).await?
        };
        let config = owner_path
            .join(".svode/config.json")
            .strip_prefix(&repo)
            .map_err(|_| AppError::General("Invalid Variables Git target".into()))?
            .to_string_lossy()
            .replace('\\', "/");
        let pointer = if kind == SpaceGitType::Submodule {
            Some(
                owner_path
                    .strip_prefix(&root)
                    .map_err(|_| AppError::General("Invalid Variables pointer".into()))?
                    .to_string_lossy()
                    .replace('\\', "/"),
            )
        } else {
            None
        };
        Ok::<_, AppError>((
            cli,
            Target {
                owner: owner_path.to_path_buf(),
                root,
                repo,
                config,
                pointer,
            },
        ))
    }
    .await;
    let (cli, target) = match target {
        Ok(target) => target,
        Err(_) => {
            // Effective config policy is local even when the Git executable is unavailable.
            let policy_repo = if owner_path.join(".git").symlink_metadata().is_ok() {
                Some(owner_path.to_path_buf())
            } else {
                project.and_then(|path| path.canonicalize().ok())
            };
            let policy_off = policy_repo.as_ref().is_some_and(|repo| {
                !crate::space::config::effective_git_user_policy(repo).auto_commit_system
            });
            let change = write.await?;
            let effect =
                change
                    .as_ref()
                    .filter(|c| c.portable_changed)
                    .map(|_| VariableGitOutcome {
                        owner_path: owner_path.to_path_buf(),
                        config: if policy_off {
                            ExactPathPersistenceOutcome::Pending {
                                reason: ExactPathPendingReason::PolicyOff,
                            }
                        } else {
                            failed()
                        },
                        root_pointer: None,
                    });
            return Ok(Mutation { change, effect });
        }
    };
    let lock = git.get_lock(&target.repo).await;
    let _guard = lock.lock().await;
    let root_lock = if target.pointer.is_some() {
        Some(git.get_lock(&target.root).await)
    } else {
        None
    };
    let _root_guard = match &root_lock {
        Some(lock) => Some(lock.lock().await),
        None => None,
    };
    let config_plan =
        autocommit::plan_guarded_system_exact_path(&cli, &target.repo, &target.config).await;
    let head_before = ops::repository_head_oid(&cli, &target.repo).await.ok();
    let root_plan = if let Some(pointer) = &target.pointer {
        Some(
            autocommit::plan_guarded_structural_exact_path(&cli, &target.root, pointer, true).await,
        )
    } else {
        None
    };
    let root_before = target
        .pointer
        .as_ref()
        .and_then(|_| std::fs::read(target.root.join(".gitmodules")).ok());
    let root_head = if target.pointer.is_some() {
        ops::repository_head_oid(&cli, &target.root).await.ok()
    } else {
        None
    };

    let change = write.await?;
    let Some(published) = change.as_ref().filter(|c| c.portable_changed) else {
        return Ok(Mutation {
            change,
            effect: None,
        });
    };
    let matches = published.portable_digest.as_ref().is_some_and(|expected| {
        std::fs::read(target.repo.join(&target.config))
            .ok()
            .is_some_and(|bytes| format!("{:x}", Sha256::digest(bytes)) == *expected)
    }) && ops::repository_head_oid(&cli, &target.repo).await.ok() == head_before;
    let receipt = match config_plan {
        Ok(plan) => {
            autocommit::finish_guarded_exact_path_receipt(
                &cli,
                &target.repo,
                &target.config,
                CONFIG_MESSAGE,
                plan,
                matches,
            )
            .await
        }
        Err(_) => failed().into(),
    };
    let mut root_pointer = None;
    if receipt.outcome == ExactPathPersistenceOutcome::Committed {
        committed(&cli, &target.owner, &target.repo);
        if let (Some(pointer), Some(plan)) = (&target.pointer, root_plan) {
            root_pointer = Some(match plan {
                Err(_) => failed(),
                Ok(GuardedExactPathPlan::Pending(reason)) => {
                    ExactPathPersistenceOutcome::Pending { reason }
                }
                Ok(plan) => {
                    let root_unchanged = ops::repository_head_oid(&cli, &target.root).await.ok()
                        == root_head
                        && root_before.is_some()
                        && std::fs::read(target.root.join(".gitmodules")).ok() == root_before;
                    match receipt.oid {
                        Some(oid) if root_unchanged => {
                            let matches = ops::submodule_target_matches_expected_head(
                                &cli,
                                &target.root,
                                pointer,
                                &target.repo,
                                &oid,
                            )
                            .await
                            .unwrap_or(false);
                            let result = autocommit::finish_guarded_exact_path_receipt(
                                &cli,
                                &target.root,
                                pointer,
                                POINTER_MESSAGE,
                                plan,
                                matches,
                            )
                            .await;
                            if result.outcome == ExactPathPersistenceOutcome::Committed {
                                committed(&cli, &target.owner, &target.root);
                            }
                            sanitize(result.outcome)
                        }
                        Some(_) => pending(),
                        None => failed(),
                    }
                }
            });
        }
    }
    Ok(Mutation {
        change,
        effect: Some(VariableGitOutcome {
            owner_path: target.owner,
            config: sanitize(receipt.outcome),
            root_pointer,
        }),
    })
}

#[cfg(test)]
mod tests;

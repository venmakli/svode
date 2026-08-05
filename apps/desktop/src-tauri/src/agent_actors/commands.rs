use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{AppHandle, State};

use super::{
    AgentActorMutationInput, AgentActorResolution, AgentAdapter, ApprovalMode, CatalogError,
    catalog_path, mutate_catalog_compound, read_catalog, resolve_catalogs, set_local_approval,
};
use crate::AppError;
use crate::agent_adapters::runtime::{
    AdapterDiagnostic, AdapterRuntimeDescriptor, AdapterSelectOption, AdapterTarget,
    ApprovalMapping, BindingValidation, SystemRuntimeCommandRunner,
};
use crate::agent_adapters::{AgentAdapterKind, AgentAdapterRegistry};
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
    pub owner_fingerprints: HashMap<String, String>,
    pub adapter_descriptors: Vec<AdapterRuntimeDescriptor>,
    pub bindings: Vec<AgentActorBindingRuntime>,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentActorBindingRuntime {
    pub actor_id: String,
    pub owner_path: String,
    pub binding_index: usize,
    pub validation: BindingValidation,
    pub effort_options: Vec<AdapterSelectOption>,
    pub approval: ApprovalMapping,
    pub readiness: AgentActorBindingReadiness,
}

#[derive(Debug, Clone, Copy, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentActorBindingReadiness {
    Unchecked,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentActorBindingInspection {
    pub validation: BindingValidation,
    pub effort_options: Vec<AdapterSelectOption>,
    pub approval: ApprovalMapping,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentActorCatalogSaveReview {
    pub owner_path: String,
    pub repository_id: String,
    pub catalog_fingerprint: String,
    pub target_state_fingerprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_pointer_fingerprint: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AgentActorCatalogSaveReviewResult {
    Clean,
    Ready {
        review: AgentActorCatalogSaveReview,
        requires_consent: bool,
    },
    Blocked {
        message: String,
    },
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AgentActorCatalogSaveResult {
    Saved {
        catalog: ExactPathPersistenceOutcome,
        #[serde(skip_serializing_if = "Option::is_none")]
        root_pointer: Option<ExactPathPersistenceOutcome>,
    },
    Stale,
    Blocked {
        message: String,
    },
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentActorRoutineReference {
    pub routine_id: String,
    pub path: String,
    pub title: String,
    pub owner_path: String,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentActorReferenceDiagnostic {
    pub owner_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentActorDeleteReferencePreview {
    pub actor_id: String,
    pub references: Vec<AgentActorRoutineReference>,
    pub diagnostics: Vec<AgentActorReferenceDiagnostic>,
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
    let registry = AgentAdapterRegistry;
    let resolution = resolve_catalogs(&own, inherited_root.as_deref());
    let owner_fingerprints = std::iter::once(own.as_path())
        .chain(
            inherited_root
                .as_deref()
                .into_iter()
                .filter(|root| *root != own),
        )
        .filter_map(|owner| {
            read_catalog(owner)
                .ok()
                .map(|(_, fingerprint)| (owner.to_string_lossy().into_owned(), fingerprint))
        })
        .collect();
    let bindings = binding_runtime_projection(&registry, &resolution);
    Ok(AgentActorsReadResult {
        resolution,
        owner_fingerprints,
        adapter_descriptors: registry.descriptors(),
        bindings,
    })
}

fn binding_runtime_projection(
    registry: &AgentAdapterRegistry,
    resolution: &AgentActorResolution,
) -> Vec<AgentActorBindingRuntime> {
    resolution
        .actors
        .iter()
        .flat_map(|resolved| {
            resolved
                .actor
                .adapters
                .iter()
                .enumerate()
                .map(|(binding_index, binding)| AgentActorBindingRuntime {
                    actor_id: resolved.actor.id.clone(),
                    owner_path: resolved.owner_path.clone(),
                    binding_index,
                    validation: registry.validate_binding(binding),
                    effort_options: registry
                        .effort_options(binding.adapter, binding.model.as_deref()),
                    approval: registry.approval_mapping(binding.adapter, resolved.approval_mode),
                    readiness: AgentActorBindingReadiness::Unchecked,
                })
        })
        .collect()
}

#[tauri::command]
pub async fn agent_actors_diagnose_adapter(
    target_space_path: String,
    adapter: AgentAdapterKind,
) -> Result<AdapterDiagnostic, AppError> {
    let target = canonical_space_path(Path::new(&target_space_path))?;
    crate::space::config::read_space_config(&target)?;
    Ok(AgentAdapterRegistry
        .diagnose(
            adapter,
            &AdapterTarget { cwd: target },
            &SystemRuntimeCommandRunner,
        )
        .await)
}

#[tauri::command]
pub fn agent_actors_generate_id() -> String {
    ulid::Ulid::new().to_string().to_ascii_lowercase()
}

#[tauri::command]
pub fn agent_actors_inspect_binding(
    binding: AgentAdapter,
    approval_mode: ApprovalMode,
) -> AgentActorBindingInspection {
    let registry = AgentAdapterRegistry;
    AgentActorBindingInspection {
        validation: registry.validate_binding(&binding),
        effort_options: registry.effort_options(binding.adapter, binding.model.as_deref()),
        approval: registry.approval_mapping(binding.adapter, approval_mode),
    }
}

#[tauri::command]
pub async fn agent_actors_preview_delete_references(
    project_path: String,
    owner_path: String,
    actor_id: String,
) -> Result<AgentActorDeleteReferencePreview, AppError> {
    let (project, owner) =
        validate_registered_owner(Path::new(&project_path), Path::new(&owner_path))?;
    let (catalog, _) =
        read_catalog(&owner).map_err(|error| AppError::General(error.to_string()))?;
    if !catalog.actors.iter().any(|actor| actor.id == actor_id) {
        return Err(AppError::General(format!(
            "missing_actor_id: agent:{actor_id}"
        )));
    }
    let mut owners = vec![project.clone()];
    let mut diagnostics = Vec::new();
    let project_config = crate::space::config::read_space_config(&project)?;
    for registered in project_config.spaces.unwrap_or_default() {
        match fs::canonicalize(project.join(&registered.path)) {
            Ok(path) if crate::space::config::read_space_config(&path).is_ok() => owners.push(path),
            Ok(path) => diagnostics.push(AgentActorReferenceDiagnostic {
                owner_path: path.to_string_lossy().into_owned(),
                path: None,
                code: "routine_owner_unavailable".into(),
                message: "registered Space config is unavailable".into(),
            }),
            Err(error) => diagnostics.push(AgentActorReferenceDiagnostic {
                owner_path: project
                    .join(&registered.path)
                    .to_string_lossy()
                    .into_owned(),
                path: None,
                code: "routine_owner_unavailable".into(),
                message: error.to_string(),
            }),
        }
    }
    owners.sort();
    owners.dedup();
    let (references, mut scan_diagnostics) = scan_routine_references(&owners, &actor_id);
    diagnostics.append(&mut scan_diagnostics);
    Ok(AgentActorDeleteReferencePreview {
        actor_id,
        references,
        diagnostics,
    })
}

fn scan_routine_references(
    owners: &[PathBuf],
    actor_id: &str,
) -> (
    Vec<AgentActorRoutineReference>,
    Vec<AgentActorReferenceDiagnostic>,
) {
    const MAX_ROUTINE_BYTES: u64 = 1024 * 1024;
    let expected = format!("agent:{actor_id}");
    let mut references = Vec::new();
    let mut diagnostics = Vec::new();
    for owner in owners {
        let directory = owner.join(".routines");
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                diagnostics.push(reference_diagnostic(
                    owner,
                    None,
                    "routine_catalog_unavailable",
                    error,
                ));
                continue;
            }
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("md") {
                continue;
            }
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata)
                    if metadata.file_type().is_file() && metadata.len() <= MAX_ROUTINE_BYTES =>
                {
                    metadata
                }
                Ok(_) => {
                    diagnostics.push(reference_diagnostic(
                        owner,
                        Some(&path),
                        "routine_file_unsafe",
                        "routine must be a bounded regular file",
                    ));
                    continue;
                }
                Err(error) => {
                    diagnostics.push(reference_diagnostic(
                        owner,
                        Some(&path),
                        "routine_file_unavailable",
                        error,
                    ));
                    continue;
                }
            };
            let _ = metadata;
            let raw = match fs::read_to_string(&path) {
                Ok(raw) => raw,
                Err(error) => {
                    diagnostics.push(reference_diagnostic(
                        owner,
                        Some(&path),
                        "routine_file_unavailable",
                        error,
                    ));
                    continue;
                }
            };
            let meta = match crate::files::frontmatter::parse_status(&raw) {
                crate::files::frontmatter::ParseStatus::Valid { meta, .. } => meta,
                crate::files::frontmatter::ParseStatus::Missing { .. } => {
                    diagnostics.push(reference_diagnostic(
                        owner,
                        Some(&path),
                        "routine_frontmatter_missing",
                        "routine has no YAML frontmatter",
                    ));
                    continue;
                }
                crate::files::frontmatter::ParseStatus::Malformed { message, .. } => {
                    diagnostics.push(reference_diagnostic(
                        owner,
                        Some(&path),
                        "routine_frontmatter_malformed",
                        message,
                    ));
                    continue;
                }
            };
            let action = meta
                .extra
                .get("action")
                .and_then(serde_yml::Value::as_mapping);
            let action_type = action
                .and_then(|value| value.get("type"))
                .and_then(serde_yml::Value::as_str);
            if action_type != Some("run_agent") {
                continue;
            }
            let executor = action
                .and_then(|value| value.get("executor"))
                .and_then(serde_yml::Value::as_str);
            if executor == Some(expected.as_str()) {
                let filename = path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default();
                references.push(AgentActorRoutineReference {
                    routine_id: format!("{}:{filename}", owner.to_string_lossy()),
                    path: path.to_string_lossy().into_owned(),
                    title: if meta.title.trim().is_empty() {
                        filename.to_string()
                    } else {
                        meta.title
                    },
                    owner_path: owner.to_string_lossy().into_owned(),
                });
            }
        }
    }
    references.sort_by(|left, right| left.path.cmp(&right.path));
    diagnostics.sort_by(|left, right| left.path.cmp(&right.path));
    (references, diagnostics)
}

fn reference_diagnostic(
    owner: &Path,
    path: Option<&Path>,
    code: &str,
    message: impl ToString,
) -> AgentActorReferenceDiagnostic {
    AgentActorReferenceDiagnostic {
        owner_path: owner.to_string_lossy().into_owned(),
        path: path.map(|path| path.to_string_lossy().into_owned()),
        code: code.into(),
        message: message.to_string(),
    }
}

#[tauri::command]
pub async fn agent_actors_get_catalog_save_review(
    project_path: String,
    owner_path: String,
    git_state: State<'_, GitState>,
) -> Result<AgentActorCatalogSaveReviewResult, AppError> {
    let (project, owner) =
        validate_registered_owner(Path::new(&project_path), Path::new(&owner_path))?;
    let cli = require_cli(&git_state)?;
    let (git_type, repository) = ops::resolve_target_repo(&cli, &project, &owner).await?;
    let repository_lock = git_state.get_lock(&repository).await;
    let _repository_guard = repository_lock.lock().await;
    let root_pointer_target = if git_type == SpaceGitType::Submodule {
        Some(direct_child_target(&project, &owner)?)
    } else {
        None
    };
    let root_lock = if root_pointer_target.is_some() {
        Some(git_state.get_lock(&project).await)
    } else {
        None
    };
    let _root_guard = if let Some(root_lock) = root_lock.as_ref() {
        Some(root_lock.lock().await)
    } else {
        None
    };
    let catalog_fingerprint = match read_catalog(&owner) {
        Ok((_, fingerprint)) => fingerprint,
        Err(error) => {
            return Ok(AgentActorCatalogSaveReviewResult::Blocked {
                message: error.to_string(),
            });
        }
    };
    let target = catalog_relative_path(&repository, &owner)?;
    let catalog_dirty = ops::exact_path_has_changes(&cli, &repository, &target).await?;
    let target_state_fingerprint =
        ops::exact_path_state_fingerprint(&cli, &repository, &target).await?;
    let root_pointer_fingerprint = if let Some(target) = root_pointer_target.as_deref() {
        Some(ops::exact_path_state_fingerprint(&cli, &project, target).await?)
    } else {
        None
    };
    let root_pointer_recoverable = if let Some(target) = root_pointer_target.as_deref() {
        let expected_head = ops::repository_head_oid(&cli, &repository).await.ok();
        ops::exact_path_has_changes(&cli, &project, target).await?
            && if let Some(expected_head) = expected_head {
                ops::submodule_target_matches_expected_head(
                    &cli,
                    &project,
                    target,
                    &repository,
                    &expected_head,
                )
                .await?
            } else {
                false
            }
    } else {
        false
    };
    if !catalog_dirty && !root_pointer_recoverable {
        return Ok(AgentActorCatalogSaveReviewResult::Clean);
    }
    Ok(AgentActorCatalogSaveReviewResult::Ready {
        review: AgentActorCatalogSaveReview {
            owner_path: owner.to_string_lossy().into_owned(),
            repository_id: repository.to_string_lossy().into_owned(),
            catalog_fingerprint,
            target_state_fingerprint,
            root_pointer_fingerprint,
        },
        requires_consent: true,
    })
}

#[tauri::command]
pub async fn agent_actors_save_catalog(
    app: AppHandle,
    project_path: String,
    owner_path: String,
    review: AgentActorCatalogSaveReview,
    git_state: State<'_, GitState>,
    access_state: State<'_, RepositoryAccessState>,
    autocommit: State<'_, Arc<AutocommitService>>,
) -> Result<AgentActorCatalogSaveResult, AppError> {
    let (project, owner) =
        validate_registered_owner(Path::new(&project_path), Path::new(&owner_path))?;
    let cli = require_cli(&git_state)?;
    let (git_type, repository) = ops::resolve_target_repo(&cli, &project, &owner).await?;
    let repository_lock = git_state.get_lock(&repository).await;
    let _repository_guard = repository_lock.lock().await;
    let root_pointer_target = if git_type == SpaceGitType::Submodule {
        Some(direct_child_target(&project, &owner)?)
    } else {
        None
    };
    let root_lock = if root_pointer_target.is_some() {
        Some(git_state.get_lock(&project).await)
    } else {
        None
    };
    let _root_guard = if let Some(root_lock) = root_lock.as_ref() {
        Some(root_lock.lock().await)
    } else {
        None
    };
    access_state
        .require_mutation(&cli, &repository, &access_store_path(&app)?)
        .await?;
    let catalog_fingerprint = match read_catalog(&owner) {
        Ok((_, fingerprint)) => fingerprint,
        Err(error) => {
            return Ok(AgentActorCatalogSaveResult::Blocked {
                message: error.to_string(),
            });
        }
    };
    let target = catalog_relative_path(&repository, &owner)?;
    let target_state_fingerprint =
        ops::exact_path_state_fingerprint(&cli, &repository, &target).await?;
    let root_pointer_fingerprint = if let Some(target) = root_pointer_target.as_deref() {
        Some(ops::exact_path_state_fingerprint(&cli, &project, target).await?)
    } else {
        None
    };
    if !save_review_matches(
        &review,
        &owner,
        &repository,
        &catalog_fingerprint,
        &target_state_fingerprint,
        root_pointer_fingerprint.as_deref(),
    ) {
        return Ok(AgentActorCatalogSaveResult::Stale);
    }
    let catalog = if ops::exact_path_has_changes(&cli, &repository, &target).await? {
        autocommit
            .commit_exact_path_manual(&cli, &owner, &repository, &target, COMMIT_MESSAGE)
            .await
    } else {
        ExactPathPersistenceOutcome::Clean
    };
    let root_pointer = if matches!(
        catalog,
        ExactPathPersistenceOutcome::Committed | ExactPathPersistenceOutcome::Clean
    ) {
        if let Some(target) = root_pointer_target.as_deref() {
            if ops::exact_path_has_changes(&cli, &project, target).await? {
                Some(
                    commit_manual_root_pointer(
                        &cli,
                        &project,
                        &owner,
                        &repository,
                        target,
                        &autocommit,
                    )
                    .await,
                )
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    };
    Ok(AgentActorCatalogSaveResult::Saved {
        catalog,
        root_pointer,
    })
}

fn save_review_matches(
    review: &AgentActorCatalogSaveReview,
    owner: &Path,
    repository: &Path,
    catalog_fingerprint: &str,
    target_state_fingerprint: &str,
    root_pointer_fingerprint: Option<&str>,
) -> bool {
    review.owner_path == owner.to_string_lossy()
        && review.repository_id == repository.to_string_lossy()
        && review.catalog_fingerprint == catalog_fingerprint
        && review.target_state_fingerprint == target_state_fingerprint
        && review.root_pointer_fingerprint.as_deref() == root_pointer_fingerprint
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

async fn commit_manual_root_pointer(
    cli: &crate::git::cli::GitCli,
    project: &Path,
    owner: &Path,
    repository: &Path,
    target: &str,
    autocommit: &AutocommitService,
) -> ExactPathPersistenceOutcome {
    let expected_head = match ops::repository_head_oid(cli, repository).await {
        Ok(head) => head,
        Err(error) => {
            return ExactPathPersistenceOutcome::Failed {
                message: error.to_string(),
            };
        }
    };
    match ops::submodule_target_matches_expected_head(
        cli,
        project,
        target,
        repository,
        &expected_head,
    )
    .await
    {
        Ok(true) => {}
        Ok(false) => {
            return ExactPathPersistenceOutcome::Failed {
                message: "submodule pointer target no longer matches the child repository HEAD"
                    .into(),
            };
        }
        Err(error) => {
            return ExactPathPersistenceOutcome::Failed {
                message: error.to_string(),
            };
        }
    }
    autocommit
        .commit_exact_path_manual(
            cli,
            owner,
            project,
            target,
            SUBMODULE_POINTER_COMMIT_MESSAGE,
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
    fn generated_actor_id_is_a_lowercase_ulid() {
        let id = agent_actors_generate_id();
        assert_eq!(id, id.to_ascii_lowercase());
        assert_eq!(id.len(), 26);
        assert!(ulid::Ulid::from_string(&id.to_ascii_uppercase()).is_ok());
    }

    #[test]
    fn binding_inspection_is_process_free_and_adapter_owned() {
        let inspection = agent_actors_inspect_binding(
            AgentAdapter {
                adapter: AgentAdapterKind::ClaudeCode,
                model: Some("haiku".into()),
                effort: None,
            },
            ApprovalMode::Full,
        );
        assert!(inspection.validation.issues.is_empty());
        assert_eq!(inspection.effort_options.len(), 1);
        assert!(inspection.approval.danger);
    }

    #[test]
    fn binding_projection_preserves_owner_and_stays_unchecked() {
        let resolution = AgentActorResolution {
            actors: vec![super::super::ResolvedAgentActor {
                actor: super::super::AgentActor {
                    id: "01arz3ndektsv4rrffq69g5fav".into(),
                    name: "Docs".into(),
                    description: None,
                    adapters: vec![AgentAdapter {
                        adapter: AgentAdapterKind::Codex,
                        model: None,
                        effort: None,
                    }],
                },
                owner_path: "/project".into(),
                approval_mode: ApprovalMode::Ask,
            }],
            diagnostics: vec![],
        };
        let rows = binding_runtime_projection(&AgentAdapterRegistry, &resolution);
        assert_eq!(rows[0].owner_path, "/project");
        assert_eq!(rows[0].readiness, AgentActorBindingReadiness::Unchecked);
    }

    #[test]
    fn manual_save_review_is_pinned_to_owner_repository_and_exact_path_state() {
        let review = AgentActorCatalogSaveReview {
            owner_path: "/project/docs".into(),
            repository_id: "/repo".into(),
            catalog_fingerprint: "catalog".into(),
            target_state_fingerprint: "state".into(),
            root_pointer_fingerprint: Some("root".into()),
        };
        assert!(save_review_matches(
            &review,
            Path::new("/project/docs"),
            Path::new("/repo"),
            "catalog",
            "state",
            Some("root")
        ));
        assert!(!save_review_matches(
            &review,
            Path::new("/project"),
            Path::new("/repo"),
            "catalog",
            "state",
            Some("root")
        ));
        assert!(!save_review_matches(
            &review,
            Path::new("/project/docs"),
            Path::new("/repo"),
            "catalog",
            "changed",
            Some("root")
        ));
    }

    #[test]
    fn routine_reference_scan_is_bounded_and_reports_malformed_files() {
        let owner = tempdir().unwrap();
        let routines = owner.path().join(".routines");
        fs::create_dir_all(routines.join("nested")).unwrap();
        fs::write(routines.join("daily.md"), "---\ntitle: Daily\naction:\n  type: run_agent\n  executor: agent:01arz3ndektsv4rrffq69g5fav\n---\nTask").unwrap();
        fs::write(
            routines.join("notify.md"),
            "---\naction:\n  type: notify\n---\nHi",
        )
        .unwrap();
        fs::write(routines.join("broken.md"), "---\naction: [\n---\n").unwrap();
        fs::write(routines.join("ignored.txt"), "not yaml").unwrap();
        fs::write(
            routines.join("nested/hidden.md"),
            "---\naction:\n  type: run_agent\n  executor: agent:01arz3ndektsv4rrffq69g5fav\n---\n",
        )
        .unwrap();

        let (references, diagnostics) =
            scan_routine_references(&[owner.path().to_path_buf()], "01arz3ndektsv4rrffq69g5fav");
        assert_eq!(references.len(), 1);
        assert_eq!(references[0].title, "Daily");
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].code, "routine_frontmatter_malformed");
    }

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

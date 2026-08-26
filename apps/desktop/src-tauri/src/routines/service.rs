use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::{SecondsFormat, Utc};
use tauri::AppHandle;

use super::model::{
    ResolvedRoutineOwner, RoutineCatalogSnapshot, RoutineDefinition, RoutineDiagnostic,
    RoutineNameConflict, RoutineNameConflictEvidence, RoutineOwnerDescriptor,
    RoutineOwnerInputKind, RoutineOwnerKind, RoutineRow, RoutineRunOrigin, RoutineTrigger,
};
use super::{authority, cache, parser};
use crate::AppError;
use crate::agent_actors;
use crate::files::filename::{self, FilenameProjection};
use crate::git;
use crate::git::access::{
    RepositoryAccessState, access_store_path, ensure_mutation_paths_were_authorized,
};
use crate::git::commands::{GitState, require_cli};
use crate::index::{IndexKey, IndexState};
use crate::repo_path::{RootMode, normalize_repo_relative};
use crate::space::config;
use crate::terminal::TerminalManager;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RoutineMutationCaller {
    Desktop,
    ExternalMcp,
    RoutineMcp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RoutineMutationPolicy {
    caller: RoutineMutationCaller,
    confirm_automatic_execution: bool,
    materialize_filename: bool,
    require_valid_definition: bool,
}

impl RoutineMutationPolicy {
    pub(crate) fn desktop_create() -> Self {
        Self {
            caller: RoutineMutationCaller::Desktop,
            confirm_automatic_execution: true,
            materialize_filename: true,
            require_valid_definition: true,
        }
    }

    pub(crate) fn desktop(materialize_filename: bool) -> Self {
        Self {
            caller: RoutineMutationCaller::Desktop,
            confirm_automatic_execution: true,
            materialize_filename,
            require_valid_definition: false,
        }
    }

    pub(crate) fn external_mcp(confirm_automatic_execution: bool) -> Self {
        Self {
            caller: RoutineMutationCaller::ExternalMcp,
            confirm_automatic_execution,
            materialize_filename: true,
            require_valid_definition: true,
        }
    }

    // DF-062C wires opaque routine caller provenance into this policy seam.
    #[allow(dead_code)]
    pub(crate) fn routine_mcp(confirm_automatic_execution: bool) -> Self {
        Self {
            caller: RoutineMutationCaller::RoutineMcp,
            confirm_automatic_execution,
            materialize_filename: true,
            require_valid_definition: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RoutineMutationBlockedCode {
    Invalid,
    AutomaticConfirmationRequired,
    RecursionGuard,
}

impl RoutineMutationBlockedCode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Invalid => "ROUTINE_INVALID",
            Self::AutomaticConfirmationRequired => "ROUTINE_AUTOMATIC_CONFIRMATION_REQUIRED",
            Self::RecursionGuard => "ROUTINE_RECURSION_GUARD",
        }
    }
}

#[derive(Debug)]
pub(crate) enum ManagedRoutineMutationResult {
    Applied {
        routine_id: String,
        snapshot: RoutineCatalogSnapshot,
        changed_paths: Vec<String>,
        warnings: Vec<RoutineDiagnostic>,
    },
    Conflict {
        current_fingerprint: Option<String>,
    },
    NameConflict {
        conflict: RoutineNameConflict,
    },
    Blocked {
        code: RoutineMutationBlockedCode,
        message: String,
        diagnostics: Vec<RoutineDiagnostic>,
    },
}

#[derive(Debug, PartialEq, Eq)]
enum FileCasOutcome {
    Applied,
    Stale(Option<String>),
}

#[derive(Debug, PartialEq, Eq)]
enum DefinitionUpdateOutcome {
    Applied {
        filename: String,
        renamed: bool,
    },
    Collision {
        filename: String,
        target_filename: String,
    },
    Stale(Option<String>),
}

pub(crate) fn resolve_owner(
    project_path: &Path,
    space_path: &Path,
    space_id: &str,
    owner_path: &str,
    owner_kind: RoutineOwnerInputKind,
) -> Result<ResolvedRoutineOwner, AppError> {
    if space_id.trim().is_empty() {
        return Err(AppError::PathNotAccessible("missing Space id".into()));
    }
    let project = canonical_space_path(project_path)?;
    let space = canonical_space_path(space_path)?;
    config::read_space_config(&space)?;
    if project != space {
        let registered = config::read_space_config(&project)?
            .spaces
            .unwrap_or_default()
            .into_iter()
            .any(|candidate| {
                candidate.id == space_id
                    && fs::canonicalize(project.join(candidate.path))
                        .is_ok_and(|candidate| candidate == space)
            });
        if !registered {
            return Err(AppError::PathNotAccessible(space.display().to_string()));
        }
    }
    let index_key = if project == space {
        IndexKey::Root(project.clone())
    } else {
        IndexKey::Space {
            project: project.clone(),
            space_id: space_id.to_string(),
        }
    };
    let (kind, normalized_owner_path, owner_root) = match owner_kind {
        RoutineOwnerInputKind::RegisteredSpace => {
            if owner_path != "." {
                return Err(AppError::PathNotAccessible(owner_path.to_string()));
            }
            let kind = if project == space {
                RoutineOwnerKind::Project
            } else {
                RoutineOwnerKind::Space
            };
            (kind, ".".to_string(), space.clone())
        }
        RoutineOwnerInputKind::CollectionDirectory => {
            let normalized = normalize_repo_relative(owner_path, RootMode::Reject)?;
            let collection = fs::canonicalize(space.join(&normalized)).map_err(|error| {
                AppError::General(format!(
                    "failed to resolve routine collection owner {normalized}: {error}"
                ))
            })?;
            if !collection.starts_with(&space) || !collection.is_dir() {
                return Err(AppError::PathNotAccessible(owner_path.to_string()));
            }
            ensure_collection_schema(&collection)?;
            (RoutineOwnerKind::Collection, normalized, collection)
        }
    };
    Ok(ResolvedRoutineOwner {
        descriptor: RoutineOwnerDescriptor {
            kind,
            space_id: space_id.to_string(),
            owner_path: normalized_owner_path,
        },
        project_path: project,
        space_path: space,
        owner_root,
        index_key,
    })
}

pub(crate) async fn read_catalog(
    index_state: &IndexState,
    terminal_manager: &TerminalManager,
    owner: &ResolvedRoutineOwner,
) -> Result<RoutineCatalogSnapshot, AppError> {
    let mut snapshot = discover_owner(owner).await?;
    match index_state.get_or_create(&owner.index_key).await {
        Ok(pool) => {
            if let Err(error) = cache::replace_owner_snapshot(&pool, &snapshot).await {
                tracing::warn!(
                    owner = %owner.descriptor.owner_path,
                    "failed to refresh routine definition cache: {error}"
                );
                snapshot.diagnostics.push(RoutineDiagnostic::new(
                    "routine_cache_unavailable",
                    "routine files were read, but the local definition cache could not be refreshed",
                ));
            }
            let live_pty_ids = live_agent_pty_ids(terminal_manager)?;
            let now = Utc::now();
            for row in &mut snapshot.routines {
                let Some(routine_id) = row.routine_id.as_deref() else {
                    continue;
                };
                if row.diagnostics.is_empty()
                    && let Some(RoutineDefinition {
                        trigger: RoutineTrigger::Schedule { cron, timezone, .. },
                        ..
                    }) = row.definition.as_ref()
                {
                    let current =
                        cache::schedule_state(&pool, &owner.descriptor.owner_path, routine_id)
                            .await?;
                    if let Some(current) = current
                        .filter(|state| state.definition_fingerprint == row.execution_fingerprint)
                    {
                        row.next_run_at = Some(current.next_run_at);
                    } else if let Ok(next) = super::schedule::next_after(cron, timezone, now) {
                        let checkpoint = now.to_rfc3339_opts(SecondsFormat::Secs, true);
                        let next = next.to_rfc3339_opts(SecondsFormat::Secs, true);
                        cache::write_schedule_state(
                            &pool,
                            &owner.descriptor.owner_path,
                            routine_id,
                            &row.execution_fingerprint,
                            &checkpoint,
                            &next,
                        )
                        .await?;
                        row.next_run_at = Some(next);
                    }
                }

                let local = match cache::latest_run(&pool, &owner.descriptor.owner_path, routine_id)
                    .await
                {
                    Ok(run) => run,
                    Err(error) => {
                        tracing::warn!(routine_id, "failed to load latest routine run: {error}");
                        snapshot.diagnostics.push(RoutineDiagnostic::new(
                            "routine_run_cache_unavailable",
                            "routine definitions were read, but latest local run references are unavailable",
                        ));
                        break;
                    }
                };
                let remote =
                    cache::latest_remote_claim(&pool, &owner.descriptor.owner_path, routine_id)
                        .await?;
                if remote.as_ref().is_some_and(|claim| {
                    local
                        .as_ref()
                        .is_none_or(|run| claim.claimed_at > run.created_at)
                }) {
                    let claim = remote.expect("checked remote claim");
                    row.last_run_at = Some(claim.claimed_at);
                    row.last_run_origin = Some(RoutineRunOrigin::Remote);
                    row.last_run = None;
                } else if let Some(run) = local {
                    row.last_run_at = Some(run.created_at.clone());
                    row.last_run_origin = Some(RoutineRunOrigin::Local);
                    row.last_run = Some(run.to_ref(&live_pty_ids));
                }
            }
        }
        Err(error) => {
            tracing::warn!(
                owner = %owner.descriptor.owner_path,
                "failed to open routine definition cache: {error}"
            );
            snapshot.diagnostics.push(RoutineDiagnostic::new(
                "routine_cache_unavailable",
                "routine files were read, but the local definition cache is unavailable",
            ));
        }
    }
    snapshot.catalog_fingerprint = publication_fingerprint(&snapshot);
    Ok(snapshot)
}

pub(crate) async fn read_automatic_authority(
    index_state: &IndexState,
    owner: &ResolvedRoutineOwner,
) -> Result<bool, AppError> {
    let pool = index_state
        .get_or_create(&IndexKey::Root(owner.project_path.clone()))
        .await?;
    authority::migrate_legacy_for_project(&pool, index_state, &owner.project_path).await?;
    authority::read(&pool, owner).await
}

pub(crate) async fn discover_owner(
    owner: &ResolvedRoutineOwner,
) -> Result<RoutineCatalogSnapshot, AppError> {
    let owner = owner.clone();
    tauri::async_runtime::spawn_blocking(move || snapshot_with_executor_diagnostics(&owner))
        .await
        .map_err(blocking_task_error)
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn create_managed(
    app: &AppHandle,
    owner: ResolvedRoutineOwner,
    definition: RoutineDefinition,
    policy: RoutineMutationPolicy,
    git_state: &GitState,
    access_state: &RepositoryAccessState,
    index_state: &IndexState,
    terminal_manager: &TerminalManager,
) -> Result<ManagedRoutineMutationResult, AppError> {
    if let Err(result) = validate_candidate(&owner, &definition, policy) {
        return Ok(result);
    }
    let name = managed_name(&definition).expect("validated managed Routine name");
    let repository = mutation_repository(git_state, &owner).await?;
    let lock = git_state.get_lock(&repository).await;
    let _guard = lock.lock().await;
    let owner = revalidate_owner(git_state, &owner, &repository).await?;
    authorize_mutation(app, git_state, access_state, &repository).await?;

    let current = discover_owner(&owner).await?;
    if let Some(conflict) = routine_name_conflict(&current, name, None) {
        return Ok(ManagedRoutineMutationResult::NameConflict { conflict });
    }

    let portable_id = ulid::Ulid::new().to_string().to_ascii_lowercase();
    let content = match serialize_candidate(&definition, &portable_id) {
        Ok(content) => content,
        Err(result) => return Ok(result),
    };

    let write_owner = owner.clone();
    let write_name = name.to_string();
    let (filename, filename_projection, allocated_suffix) =
        tauri::async_runtime::spawn_blocking(move || {
            create_definition_file(&write_owner, &write_name, &content)
        })
        .await
        .map_err(blocking_task_error)??;
    let changed_path = definition_path(&owner, &filename);
    let (snapshot, mut warnings) =
        projection_after_write(index_state, terminal_manager, &owner, &changed_path).await?;
    if filename_projection.is_lossy() {
        warnings.push(
            RoutineDiagnostic::new(
                "routine_filename_projection",
                format!(
                    "the Routine filename was safely projected ({})",
                    filename_projection.reason_codes()
                ),
            )
            .path(changed_path.clone()),
        );
    }
    if allocated_suffix {
        warnings.push(
            RoutineDiagnostic::new(
                "routine_filename_collision",
                "the desired Routine filename was occupied, so the first available numeric suffix was used",
            )
            .path(changed_path.clone()),
        );
    }
    let Some(row) = snapshot
        .routines
        .iter()
        .find(|row| row.filename == filename)
    else {
        return Err(AppError::General(
            "created routine was not discoverable after its atomic write".into(),
        ));
    };
    let routine_id = row
        .routine_id
        .clone()
        .ok_or_else(|| AppError::General("created Routine has no portable identity".into()))?;
    super::emit_owner_invalidation(app, &owner);
    Ok(ManagedRoutineMutationResult::Applied {
        routine_id,
        snapshot,
        changed_paths: vec![changed_path],
        warnings,
    })
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn update_managed(
    app: &AppHandle,
    owner: ResolvedRoutineOwner,
    routine_id: String,
    expected_fingerprint: String,
    definition: RoutineDefinition,
    policy: RoutineMutationPolicy,
    git_state: &GitState,
    access_state: &RepositoryAccessState,
    index_state: &IndexState,
    terminal_manager: &TerminalManager,
) -> Result<ManagedRoutineMutationResult, AppError> {
    if let Err(result) = validate_candidate(&owner, &definition, policy) {
        return Ok(result);
    }
    let name = managed_name(&definition)
        .expect("validated managed Routine name")
        .to_string();
    let repository = mutation_repository(git_state, &owner).await?;
    let lock = git_state.get_lock(&repository).await;
    let _guard = lock.lock().await;
    let owner = revalidate_owner(git_state, &owner, &repository).await?;
    authorize_mutation(app, git_state, access_state, &repository).await?;

    let current = discover_owner(&owner).await?;
    let Some(row) = current
        .routines
        .iter()
        .find(|row| row.routine_id.as_deref() == Some(routine_id.as_str()))
    else {
        return Ok(ManagedRoutineMutationResult::Conflict {
            current_fingerprint: None,
        });
    };
    if row.fingerprint != expected_fingerprint {
        return Ok(ManagedRoutineMutationResult::Conflict {
            current_fingerprint: Some(row.fingerprint.clone()),
        });
    }
    if update_requires_name_check(row, &name, policy)
        && let Some(conflict) = routine_name_conflict(&current, &name, Some(&routine_id))
    {
        return Ok(ManagedRoutineMutationResult::NameConflict { conflict });
    }
    let Some(portable_id) = row.portable_id.clone() else {
        return Ok(ManagedRoutineMutationResult::Conflict {
            current_fingerprint: None,
        });
    };
    let content = match serialize_candidate(&definition, &portable_id) {
        Ok(content) => content,
        Err(result) => return Ok(result),
    };
    let old_filename = row.filename.clone();
    let old_path = row.path.clone();
    let (target_filename, filename_projection) =
        update_target_filename(&old_filename, &name, policy);
    let directory = owner.routines_dir();
    let write_fingerprint = expected_fingerprint.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        update_definition_file_cas(
            &directory,
            &old_filename,
            &target_filename,
            &write_fingerprint,
            &content,
        )
    })
    .await
    .map_err(blocking_task_error)??;
    let (current_filename, mut changed_paths, collision_target) = match outcome {
        DefinitionUpdateOutcome::Applied { filename, renamed } => {
            let current_path = definition_path(&owner, &filename);
            let changed_paths = if renamed {
                vec![old_path.clone(), current_path]
            } else {
                vec![old_path.clone()]
            };
            (filename, changed_paths, None)
        }
        DefinitionUpdateOutcome::Collision {
            filename,
            target_filename,
        } => (
            filename,
            vec![old_path.clone()],
            Some(definition_path(&owner, &target_filename)),
        ),
        DefinitionUpdateOutcome::Stale(current_fingerprint) => {
            return Ok(ManagedRoutineMutationResult::Conflict {
                current_fingerprint,
            });
        }
    };
    let current_path = definition_path(&owner, &current_filename);
    let (snapshot, mut warnings) =
        projection_after_write(index_state, terminal_manager, &owner, &current_path).await?;
    if let Some(projection) = filename_projection
        && projection.is_lossy()
    {
        warnings.push(
            RoutineDiagnostic::new(
                "routine_filename_projection",
                format!(
                    "the Routine filename was safely projected ({})",
                    projection.reason_codes()
                ),
            )
            .path(current_path.clone()),
        );
    }
    if collision_target.is_some() {
        warnings.push(
            RoutineDiagnostic::new(
                "routine_rename_collision",
                "the Routine was saved, but its desired filename is already used by another Routine",
            )
            .path(current_path.clone()),
        );
    }
    changed_paths.dedup();
    if !snapshot
        .routines
        .iter()
        .any(|row| row.routine_id.as_deref() == Some(routine_id.as_str()))
    {
        warnings.push(RoutineDiagnostic::new(
            "routine_projection_identity_missing",
            "the Routine source was saved, but its stable identity is temporarily unavailable; automatic dispatch remains fail-closed until reconciliation",
        ));
    }
    super::emit_owner_invalidation(app, &owner);
    Ok(ManagedRoutineMutationResult::Applied {
        routine_id,
        snapshot,
        changed_paths,
        warnings,
    })
}

fn update_target_filename(
    current_filename: &str,
    definition_name: &str,
    policy: RoutineMutationPolicy,
) -> (String, Option<FilenameProjection>) {
    if policy.materialize_filename {
        let projection = filename::project(definition_name);
        (
            filename::component_name(&projection.stem, Some("md")),
            Some(projection),
        )
    } else {
        (current_filename.to_string(), None)
    }
}

fn update_requires_name_check(
    current: &RoutineRow,
    candidate_name: &str,
    policy: RoutineMutationPolicy,
) -> bool {
    policy.materialize_filename
        || crate::files::naming::display_name_key(&current.name)
            != crate::files::naming::display_name_key(candidate_name)
}

fn routine_name_conflict(
    snapshot: &RoutineCatalogSnapshot,
    candidate_name: &str,
    exclude_routine_id: Option<&str>,
) -> Option<RoutineNameConflict> {
    let candidate_key = crate::files::naming::display_name_key(candidate_name);
    let conflicts = snapshot
        .routines
        .iter()
        .filter(|row| {
            exclude_routine_id
                .is_none_or(|routine_id| row.routine_id.as_deref() != Some(routine_id))
                && crate::files::naming::display_name_key(&row.name) == candidate_key
        })
        .map(|row| RoutineNameConflictEvidence {
            routine_id: row.routine_id.clone(),
            name: row.name.clone(),
            filename: row.filename.clone(),
            path: row.path.clone(),
        })
        .collect::<Vec<_>>();
    (!conflicts.is_empty()).then(|| RoutineNameConflict {
        owner: snapshot.owner.clone(),
        conflicts,
    })
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn delete_managed(
    app: &AppHandle,
    owner: ResolvedRoutineOwner,
    routine_id: String,
    expected_fingerprint: String,
    git_state: &GitState,
    access_state: &RepositoryAccessState,
    index_state: &IndexState,
    terminal_manager: &TerminalManager,
) -> Result<ManagedRoutineMutationResult, AppError> {
    let repository = mutation_repository(git_state, &owner).await?;
    let lock = git_state.get_lock(&repository).await;
    let _guard = lock.lock().await;
    let owner = revalidate_owner(git_state, &owner, &repository).await?;
    authorize_mutation(app, git_state, access_state, &repository).await?;

    let current = discover_owner(&owner).await?;
    let Some(row) = current
        .routines
        .iter()
        .find(|row| row.routine_id.as_deref() == Some(routine_id.as_str()))
    else {
        return Ok(ManagedRoutineMutationResult::Conflict {
            current_fingerprint: None,
        });
    };
    if row.fingerprint != expected_fingerprint {
        return Ok(ManagedRoutineMutationResult::Conflict {
            current_fingerprint: Some(row.fingerprint.clone()),
        });
    }
    let path = owner.routines_dir().join(&row.filename);
    let directory = owner.routines_dir();
    let changed_path = row.path.clone();
    let delete_fingerprint = expected_fingerprint.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        delete_definition_file_cas(&directory, &path, &delete_fingerprint)
    })
    .await
    .map_err(blocking_task_error)??;
    if let FileCasOutcome::Stale(current_fingerprint) = outcome {
        return Ok(ManagedRoutineMutationResult::Conflict {
            current_fingerprint,
        });
    }
    let (snapshot, warnings) =
        projection_after_write(index_state, terminal_manager, &owner, &changed_path).await?;
    super::emit_owner_invalidation(app, &owner);
    Ok(ManagedRoutineMutationResult::Applied {
        routine_id,
        snapshot,
        changed_paths: vec![changed_path],
        warnings,
    })
}

pub(crate) async fn mutation_repository(
    git_state: &GitState,
    owner: &ResolvedRoutineOwner,
) -> Result<PathBuf, AppError> {
    let cli = require_cli(git_state)?;
    let (_, repository) =
        git::ops::resolve_target_repo(&cli, &owner.project_path, &owner.space_path).await?;
    Ok(repository)
}

pub(crate) async fn authorize_mutation(
    app: &AppHandle,
    git_state: &GitState,
    access_state: &RepositoryAccessState,
    repository: &Path,
) -> Result<(), AppError> {
    ensure_mutation_paths_were_authorized(&[repository.to_path_buf()])?;
    let cli = require_cli(git_state)?;
    access_state
        .require_mutation(&cli, repository, &access_store_path(app)?)
        .await?;
    Ok(())
}

fn validate_candidate(
    owner: &ResolvedRoutineOwner,
    definition: &RoutineDefinition,
    policy: RoutineMutationPolicy,
) -> Result<(), ManagedRoutineMutationResult> {
    if managed_name(definition).is_none() {
        return Err(ManagedRoutineMutationResult::Blocked {
            code: RoutineMutationBlockedCode::Invalid,
            message: "routine name must contain 1 to 240 characters".into(),
            diagnostics: vec![
                RoutineDiagnostic::new(
                    "routine_name_required",
                    "managed Routine mutations require a non-empty name",
                )
                .field("name"),
            ],
        });
    }
    let diagnostics = candidate_diagnostics(owner, definition);
    if policy.require_valid_definition && !diagnostics.is_empty() {
        return Err(ManagedRoutineMutationResult::Blocked {
            code: RoutineMutationBlockedCode::Invalid,
            message: diagnostics
                .first()
                .map(|diagnostic| diagnostic.message.clone())
                .unwrap_or_else(|| "routine definition is invalid".into()),
            diagnostics,
        });
    }
    if automatic_execution_enabled(definition) {
        if policy.caller == RoutineMutationCaller::RoutineMcp {
            return Err(ManagedRoutineMutationResult::Blocked {
                code: RoutineMutationBlockedCode::RecursionGuard,
                message: "a routine-launched MCP caller cannot save enabled automation".into(),
                diagnostics: Vec::new(),
            });
        }
        if policy.caller != RoutineMutationCaller::Desktop && !policy.confirm_automatic_execution {
            return Err(ManagedRoutineMutationResult::Blocked {
                code: RoutineMutationBlockedCode::AutomaticConfirmationRequired,
                message:
                    "enabled schedule or event routines require confirmAutomaticExecution=true"
                        .into(),
                diagnostics: Vec::new(),
            });
        }
    }
    Ok(())
}

fn serialize_candidate(
    definition: &RoutineDefinition,
    portable_id: &str,
) -> Result<Vec<u8>, ManagedRoutineMutationResult> {
    let content = parser::serialize_definition(definition, portable_id).map_err(|message| {
        ManagedRoutineMutationResult::Blocked {
            code: RoutineMutationBlockedCode::Invalid,
            message,
            diagnostics: Vec::new(),
        }
    })?;
    if content.len() as u64 > parser::MAX_ROUTINE_BYTES {
        return Err(ManagedRoutineMutationResult::Blocked {
            code: RoutineMutationBlockedCode::Invalid,
            message: "routine definition exceeds the 1 MiB limit".into(),
            diagnostics: vec![RoutineDiagnostic::new(
                "routine_definition_too_large",
                "serialized routine definition exceeds the 1 MiB limit",
            )],
        });
    }
    Ok(content.into_bytes())
}

fn managed_name(definition: &RoutineDefinition) -> Option<&str> {
    definition
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty() && name.chars().count() <= 240)
}

fn candidate_diagnostics(
    owner: &ResolvedRoutineOwner,
    definition: &RoutineDefinition,
) -> Vec<RoutineDiagnostic> {
    let mut diagnostics = parser::validate_definition(definition, owner.descriptor.kind);
    if let Some(diagnostic) = executor_availability_diagnostic(owner, definition) {
        diagnostics.push(diagnostic);
    }
    diagnostics
}

fn automatic_execution_enabled(definition: &RoutineDefinition) -> bool {
    definition.enabled == Some(true)
        && matches!(
            definition.trigger,
            RoutineTrigger::Schedule { .. } | RoutineTrigger::Event { .. }
        )
}

pub(crate) async fn revalidate_owner(
    git_state: &GitState,
    owner: &ResolvedRoutineOwner,
    expected_repository: &Path,
) -> Result<ResolvedRoutineOwner, AppError> {
    let input_kind = match owner.descriptor.kind {
        RoutineOwnerKind::Project | RoutineOwnerKind::Space => {
            RoutineOwnerInputKind::RegisteredSpace
        }
        RoutineOwnerKind::Collection => RoutineOwnerInputKind::CollectionDirectory,
    };
    let revalidated = resolve_owner(
        &owner.project_path,
        &owner.space_path,
        &owner.descriptor.space_id,
        &owner.descriptor.owner_path,
        input_kind,
    )?;
    let repository = mutation_repository(git_state, &revalidated).await?;
    if repository != expected_repository {
        return Err(AppError::PathNotAccessible(
            "routine owner repository changed during mutation planning".into(),
        ));
    }
    Ok(revalidated)
}

async fn projection_after_write(
    index_state: &IndexState,
    terminal_manager: &TerminalManager,
    owner: &ResolvedRoutineOwner,
    changed_path: &str,
) -> Result<(RoutineCatalogSnapshot, Vec<RoutineDiagnostic>), AppError> {
    match read_catalog(index_state, terminal_manager, owner).await {
        Ok(snapshot) => {
            let warnings = snapshot
                .diagnostics
                .iter()
                .filter(|diagnostic| {
                    matches!(
                        diagnostic.code.as_str(),
                        "routine_cache_unavailable" | "routine_run_cache_unavailable"
                    )
                })
                .cloned()
                .collect();
            Ok((snapshot, warnings))
        }
        Err(error) => {
            tracing::warn!(
                owner = %owner.descriptor.owner_path,
                "routine source write applied, but derived projection refresh failed: {error}"
            );
            let snapshot = discover_owner(owner).await?;
            Ok((
                snapshot,
                vec![RoutineDiagnostic::new(
                    "routine_projection_refresh_failed",
                    "routine source change was applied, but derived runtime projection refresh failed; retry the read",
                )
                .path(changed_path.to_string())],
            ))
        }
    }
}

fn definition_path(owner: &ResolvedRoutineOwner, filename: &str) -> String {
    if owner.descriptor.owner_path == "." {
        format!(".routines/{filename}")
    } else {
        format!("{}/.routines/{filename}", owner.descriptor.owner_path)
    }
}

fn create_definition_file(
    owner: &ResolvedRoutineOwner,
    name: &str,
    content: &[u8],
) -> Result<(String, FilenameProjection, bool), AppError> {
    let directory = owner.routines_dir();
    ensure_routines_directory(&directory)?;
    let projection = filename::project(name);
    for suffix in 0..=10_000 {
        let candidate = projection.with_numeric_suffix(suffix);
        let filename = filename::component_name(&candidate.stem, Some("md"));
        if filename::component_conflicts_portably(&directory, &filename, None)? {
            continue;
        }
        let path = directory.join(&filename);
        match write_new_file(&path, content) {
            Ok(()) => {
                sync_directory(&directory)?;
                return Ok((filename, candidate, suffix > 0));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(AppError::Io(error)),
        }
    }
    Err(AppError::FileAlreadyExists(
        "failed to allocate a unique routine filename".into(),
    ))
}

fn ensure_routines_directory(directory: &Path) -> Result<(), AppError> {
    match fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            Err(AppError::PathNotAccessible(directory.display().to_string()))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(directory)?;
            let parent = directory
                .parent()
                .ok_or_else(|| AppError::PathNotAccessible(directory.display().to_string()))?;
            sync_directory(parent)
        }
        Err(error) => Err(AppError::Io(error)),
    }
}

fn write_new_file(path: &Path, bytes: &[u8]) -> Result<(), std::io::Error> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

fn atomic_replace_cas(
    path: &Path,
    expected_fingerprint: &str,
    bytes: &[u8],
) -> Result<FileCasOutcome, AppError> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::PathNotAccessible(path.display().to_string()))?;
    ensure_routines_directory(parent)?;
    let Some(current_fingerprint) = definition_file_fingerprint(path)? else {
        return Ok(FileCasOutcome::Stale(None));
    };
    if current_fingerprint != expected_fingerprint {
        return Ok(FileCasOutcome::Stale(Some(current_fingerprint)));
    }
    let temp = parent.join(format!(".routine-{}.tmp", ulid::Ulid::new()));
    write_new_file(&temp, bytes)?;
    let current_fingerprint = definition_file_fingerprint(path)?;
    if current_fingerprint.as_deref() != Some(expected_fingerprint) {
        let _ = fs::remove_file(&temp);
        return Ok(FileCasOutcome::Stale(current_fingerprint));
    }
    if let Err(error) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(AppError::Io(error));
    }
    sync_directory(parent)?;
    Ok(FileCasOutcome::Applied)
}

fn update_definition_file_cas(
    directory: &Path,
    current_filename: &str,
    target_filename: &str,
    expected_fingerprint: &str,
    bytes: &[u8],
) -> Result<DefinitionUpdateOutcome, AppError> {
    ensure_routines_directory(directory)?;
    let current_path = directory.join(current_filename);
    let Some(current_fingerprint) = definition_file_fingerprint(&current_path)? else {
        return Ok(DefinitionUpdateOutcome::Stale(None));
    };
    if current_fingerprint != expected_fingerprint {
        return Ok(DefinitionUpdateOutcome::Stale(Some(current_fingerprint)));
    }
    if current_filename == target_filename {
        return match atomic_replace_cas(&current_path, expected_fingerprint, bytes)? {
            FileCasOutcome::Applied => Ok(DefinitionUpdateOutcome::Applied {
                filename: current_filename.to_string(),
                renamed: false,
            }),
            FileCasOutcome::Stale(current) => Ok(DefinitionUpdateOutcome::Stale(current)),
        };
    }

    if filename::portable_component_key(current_filename)
        == filename::portable_component_key(target_filename)
    {
        return match atomic_replace_cas(&current_path, expected_fingerprint, bytes)? {
            FileCasOutcome::Applied => {
                let intermediate = directory.join(format!(".routine-{}.rename", ulid::Ulid::new()));
                fs::rename(&current_path, &intermediate)?;
                let target_path = directory.join(target_filename);
                if let Err(error) = fs::rename(&intermediate, &target_path) {
                    let _ = fs::rename(&intermediate, &current_path);
                    return Err(AppError::Io(error));
                }
                sync_directory(directory)?;
                Ok(DefinitionUpdateOutcome::Applied {
                    filename: target_filename.to_string(),
                    renamed: true,
                })
            }
            FileCasOutcome::Stale(current) => Ok(DefinitionUpdateOutcome::Stale(current)),
        };
    }

    let target_path = directory.join(target_filename);
    if filename::component_conflicts_portably(directory, target_filename, Some(current_filename))? {
        return match atomic_replace_cas(&current_path, expected_fingerprint, bytes)? {
            FileCasOutcome::Applied => Ok(DefinitionUpdateOutcome::Collision {
                filename: current_filename.to_string(),
                target_filename: target_filename.to_string(),
            }),
            FileCasOutcome::Stale(current) => Ok(DefinitionUpdateOutcome::Stale(current)),
        };
    }

    let current_fingerprint = definition_file_fingerprint(&current_path)?;
    if current_fingerprint.as_deref() != Some(expected_fingerprint) {
        return Ok(DefinitionUpdateOutcome::Stale(current_fingerprint));
    }
    match write_new_file(&target_path, bytes) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return match atomic_replace_cas(&current_path, expected_fingerprint, bytes)? {
                FileCasOutcome::Applied => Ok(DefinitionUpdateOutcome::Collision {
                    filename: current_filename.to_string(),
                    target_filename: target_filename.to_string(),
                }),
                FileCasOutcome::Stale(current) => Ok(DefinitionUpdateOutcome::Stale(current)),
            };
        }
        Err(error) => return Err(AppError::Io(error)),
    }
    if let Err(error) = fs::remove_file(&current_path) {
        let _ = fs::remove_file(&target_path);
        return Err(AppError::Io(error));
    }
    sync_directory(directory)?;
    Ok(DefinitionUpdateOutcome::Applied {
        filename: target_filename.to_string(),
        renamed: true,
    })
}

fn delete_definition_file_cas(
    directory: &Path,
    path: &Path,
    expected_fingerprint: &str,
) -> Result<FileCasOutcome, AppError> {
    ensure_routines_directory(directory)?;
    let Some(current_fingerprint) = definition_file_fingerprint(path)? else {
        return Ok(FileCasOutcome::Stale(None));
    };
    if current_fingerprint != expected_fingerprint {
        return Ok(FileCasOutcome::Stale(Some(current_fingerprint)));
    }
    fs::remove_file(path)?;
    sync_directory(directory)?;
    Ok(FileCasOutcome::Applied)
}

fn definition_file_fingerprint(path: &Path) -> Result<Option<String>, AppError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(AppError::Io(error)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(AppError::PathNotAccessible(path.display().to_string()));
    }
    let bytes = fs::read(path)?;
    if bytes.len() as u64 > parser::MAX_ROUTINE_BYTES {
        return Err(AppError::PathNotAccessible(format!(
            "routine definition exceeds the 1 MiB limit: {}",
            path.display()
        )));
    }
    Ok(Some(parser::fingerprint(&bytes)))
}

fn sync_directory(path: &Path) -> Result<(), AppError> {
    File::open(path)?.sync_all()?;
    Ok(())
}

pub(crate) fn live_agent_pty_ids(
    terminal_manager: &TerminalManager,
) -> Result<HashSet<String>, AppError> {
    Ok(terminal_manager
        .list_agent_surfaces()?
        .into_iter()
        .filter(|surface| surface.live)
        .map(|surface| surface.pty_id)
        .collect())
}

fn publication_fingerprint(snapshot: &RoutineCatalogSnapshot) -> String {
    let mut value = String::new();
    for row in &snapshot.routines {
        for field in [
            row.routine_id.as_deref().unwrap_or_default(),
            row.fingerprint.as_str(),
            row.execution_fingerprint.as_str(),
            row.last_run_at.as_deref().unwrap_or_default(),
            row.next_run_at.as_deref().unwrap_or_default(),
        ] {
            value.push_str(field);
            value.push('\0');
        }
        value.push_str(match row.last_run_origin {
            Some(RoutineRunOrigin::Local) => "local",
            Some(RoutineRunOrigin::Remote) => "remote",
            None => "",
        });
        value.push('\0');
        if let Some(last_run) = &row.last_run {
            value.push_str(&serde_json::to_string(last_run).unwrap_or_default());
        }
        value.push('\0');
        for diagnostic in &row.diagnostics {
            value.push_str(&diagnostic.code);
            value.push('\0');
            value.push_str(&diagnostic.message);
            value.push('\0');
            value.push_str(diagnostic.field.as_deref().unwrap_or_default());
            value.push('\0');
            value.push_str(diagnostic.path.as_deref().unwrap_or_default());
            value.push('\0');
        }
    }
    for diagnostic in &snapshot.diagnostics {
        value.push_str(&diagnostic.code);
        value.push('\0');
        value.push_str(&diagnostic.message);
        value.push('\0');
        value.push_str(diagnostic.path.as_deref().unwrap_or_default());
        value.push('\0');
    }
    parser::fingerprint(value.as_bytes())
}

fn snapshot_with_executor_diagnostics(owner: &ResolvedRoutineOwner) -> RoutineCatalogSnapshot {
    let mut snapshot = parser::discover_owner(owner);
    for row in &mut snapshot.routines {
        if !row
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "routine_executor_invalid")
            && let Some(definition) = row.definition.as_ref()
            && let Some(diagnostic) = executor_availability_diagnostic(owner, definition)
        {
            row.diagnostics.push(diagnostic.path(row.path.clone()));
        }
    }
    snapshot.catalog_fingerprint =
        parser::catalog_fingerprint(&snapshot.routines, &snapshot.diagnostics);
    snapshot
}

fn executor_availability_diagnostic(
    owner: &ResolvedRoutineOwner,
    definition: &RoutineDefinition,
) -> Option<RoutineDiagnostic> {
    let executor = definition.action.executor()?;
    if executor.is_empty() {
        return None;
    }
    let inherited =
        (owner.space_path != owner.project_path).then_some(owner.project_path.as_path());
    let actors = agent_actors::resolve_catalogs(&owner.space_path, inherited)
        .actors
        .into_iter()
        .map(|resolved| format!("agent:{}", resolved.actor.id))
        .collect::<HashSet<_>>();
    (!actors.contains(executor)).then(|| {
        RoutineDiagnostic::new(
            "routine_executor_unavailable",
            format!("executor {executor} is not available in the effective Agent Actors catalog"),
        )
        .field("action.executor")
    })
}

fn canonical_space_path(path: &Path) -> Result<PathBuf, AppError> {
    fs::canonicalize(path).map_err(|error| {
        AppError::General(format!(
            "failed to resolve routine Space {}: {error}",
            path.display()
        ))
    })
}

fn ensure_collection_schema(collection: &Path) -> Result<(), AppError> {
    let schema = collection.join("schema.yaml");
    let metadata = fs::symlink_metadata(&schema).map_err(|_| {
        AppError::PathNotAccessible(format!(
            "routine collection owner has no direct schema.yaml: {}",
            collection.display()
        ))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(AppError::PathNotAccessible(schema.display().to_string()));
    }
    Ok(())
}

fn blocking_task_error(error: impl std::fmt::Display) -> AppError {
    AppError::General(format!("routine filesystem task failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    use crate::routines::model::{
        CollectionEvent, RoutineAction, RoutineActionTarget, RoutineTrigger,
    };
    use crate::space::config::write_space_config;
    use crate::space::types::{SpaceConfig, SpaceRef};

    fn space_config(name: &str, spaces: Option<Vec<SpaceRef>>) -> SpaceConfig {
        SpaceConfig {
            name: name.into(),
            description: String::new(),
            icon: "folder".into(),
            spaces,
            agent: None,
            defaults: None,
            git: None,
            assets: None,
            tree: None,
        }
    }

    fn project_owner(root: &Path) -> ResolvedRoutineOwner {
        ResolvedRoutineOwner {
            descriptor: RoutineOwnerDescriptor {
                kind: RoutineOwnerKind::Project,
                space_id: "root".into(),
                owner_path: ".".into(),
            },
            project_path: root.into(),
            space_path: root.into(),
            owner_root: root.into(),
            index_key: IndexKey::Root(root.into()),
        }
    }

    fn collection_owner(root: &Path) -> ResolvedRoutineOwner {
        ResolvedRoutineOwner {
            descriptor: RoutineOwnerDescriptor {
                kind: RoutineOwnerKind::Collection,
                space_id: "root".into(),
                owner_path: "tasks".into(),
            },
            project_path: root.into(),
            space_path: root.into(),
            owner_root: root.join("tasks"),
            index_key: IndexKey::Root(root.into()),
        }
    }

    fn event_definition(enabled: bool) -> RoutineDefinition {
        RoutineDefinition {
            name: Some("Keep review state".into()),
            description: None,
            enabled: Some(enabled),
            trigger: RoutineTrigger::Event {
                event: CollectionEvent::EntryCreated,
                match_: None,
            },
            action: RoutineAction::UpdateProperties {
                target: RoutineActionTarget::TriggerEntry,
                set: BTreeMap::from([("reviewed".into(), serde_json::Value::Bool(true))]),
            },
            body: "Managed by Svode.".into(),
        }
    }

    fn manual_definition(name: &str) -> RoutineDefinition {
        RoutineDefinition {
            name: Some(name.into()),
            description: None,
            enabled: None,
            trigger: RoutineTrigger::Manual,
            action: RoutineAction::RunAgent {
                executor: "agent:01arz3ndektsv4rrffq69g5fav".into(),
            },
            body: String::new(),
        }
    }

    #[test]
    fn resolves_project_space_and_collection_owners_without_ambiguity() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path();
        let child = project.join("child");
        let collection = child.join("tasks");
        fs::create_dir_all(&collection).unwrap();
        fs::write(collection.join("schema.yaml"), "name: Tasks\n").unwrap();
        write_space_config(&child, &space_config("Child", None)).unwrap();
        write_space_config(
            project,
            &space_config(
                "Project",
                Some(vec![SpaceRef {
                    id: "child-id".into(),
                    path: "child".into(),
                    repo: None,
                }]),
            ),
        )
        .unwrap();

        let root = resolve_owner(
            project,
            project,
            "root",
            ".",
            RoutineOwnerInputKind::RegisteredSpace,
        )
        .unwrap();
        assert_eq!(root.descriptor.kind, RoutineOwnerKind::Project);

        let space = resolve_owner(
            project,
            &child,
            "child-id",
            ".",
            RoutineOwnerInputKind::RegisteredSpace,
        )
        .unwrap();
        assert_eq!(space.descriptor.kind, RoutineOwnerKind::Space);

        let collection = resolve_owner(
            project,
            &child,
            "child-id",
            "tasks",
            RoutineOwnerInputKind::CollectionDirectory,
        )
        .unwrap();
        assert_eq!(collection.descriptor.kind, RoutineOwnerKind::Collection);
        assert_eq!(collection.descriptor.owner_path, "tasks");

        assert!(
            resolve_owner(
                project,
                &child,
                "wrong-child-id",
                "tasks",
                RoutineOwnerInputKind::CollectionDirectory,
            )
            .is_err()
        );
        assert!(
            resolve_owner(
                project,
                &child,
                "child-id",
                "tasks",
                RoutineOwnerInputKind::RegisteredSpace,
            )
            .is_err()
        );
        for unsafe_path in ["/tasks", "../tasks", "tasks/../other"] {
            assert!(
                resolve_owner(
                    project,
                    &child,
                    "child-id",
                    unsafe_path,
                    RoutineOwnerInputKind::CollectionDirectory,
                )
                .is_err(),
                "{unsafe_path}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn collection_owner_rejects_symlink_escape() {
        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("schema.yaml"), "name: Outside\n").unwrap();
        write_space_config(project.path(), &space_config("Project", None)).unwrap();
        std::os::unix::fs::symlink(outside.path(), project.path().join("linked")).unwrap();

        assert!(
            resolve_owner(
                project.path(),
                project.path(),
                "root",
                "linked",
                RoutineOwnerInputKind::CollectionDirectory,
            )
            .is_err()
        );
    }

    #[test]
    fn publication_fingerprint_tracks_runtime_but_not_authority() {
        let row = super::super::model::RoutineRow {
            routine_id: Some("routine:one".into()),
            portable_id: Some("01arz3ndektsv4rrffq69g5fav".into()),
            filename: "one.md".into(),
            path: ".routines/one.md".into(),
            name: "One".into(),
            name_conflict: None,
            description: None,
            enabled: Some(true),
            trigger_type: Some(super::super::model::RoutineTriggerType::Manual),
            trigger_summary: None,
            action_type: None,
            action_summary: None,
            executor: None,
            last_run_at: Some("2026-08-19T10:00:00Z".into()),
            last_run_origin: Some(RoutineRunOrigin::Local),
            next_run_at: None,
            last_run: None,
            fingerprint: "definition".into(),
            execution_fingerprint: "execution".into(),
            definition: None,
            diagnostics: Vec::new(),
        };
        let snapshot = RoutineCatalogSnapshot {
            owner: RoutineOwnerDescriptor {
                kind: RoutineOwnerKind::Project,
                space_id: "root".into(),
                owner_path: ".".into(),
            },
            routines: vec![row],
            diagnostics: Vec::new(),
            catalog_fingerprint: String::new(),
            refreshed_at: "2026-08-19T10:00:00Z".into(),
        };
        let initial = publication_fingerprint(&snapshot);
        let mut changed = snapshot.clone();
        changed.routines[0].last_run_origin = Some(RoutineRunOrigin::Remote);
        assert_ne!(publication_fingerprint(&changed), initial);
        changed.routines[0].last_run_origin = Some(RoutineRunOrigin::Local);
        assert_eq!(publication_fingerprint(&changed), initial);
        changed.routines[0].next_run_at = Some("2026-08-20T10:00:00Z".into());
        assert_ne!(publication_fingerprint(&changed), initial);
    }

    #[test]
    fn managed_policy_validates_before_write_and_requires_automatic_acknowledgement() {
        let temp = tempfile::tempdir().unwrap();
        let owner = collection_owner(temp.path());

        let blocked = validate_candidate(
            &owner,
            &event_definition(true),
            RoutineMutationPolicy::external_mcp(false),
        )
        .unwrap_err();
        assert!(matches!(
            blocked,
            ManagedRoutineMutationResult::Blocked {
                code: RoutineMutationBlockedCode::AutomaticConfirmationRequired,
                ..
            }
        ));
        assert!(!owner.routines_dir().exists());

        assert!(
            validate_candidate(
                &owner,
                &event_definition(true),
                RoutineMutationPolicy::external_mcp(true),
            )
            .is_ok()
        );
        assert!(
            validate_candidate(
                &owner,
                &event_definition(false),
                RoutineMutationPolicy::external_mcp(false),
            )
            .is_ok()
        );
    }

    #[test]
    fn routine_mcp_cannot_save_enabled_automation() {
        let temp = tempfile::tempdir().unwrap();
        let blocked = validate_candidate(
            &collection_owner(temp.path()),
            &event_definition(true),
            RoutineMutationPolicy::routine_mcp(true),
        )
        .unwrap_err();
        assert!(matches!(
            blocked,
            ManagedRoutineMutationResult::Blocked {
                code: RoutineMutationBlockedCode::RecursionGuard,
                ..
            }
        ));
    }

    #[test]
    fn desktop_inline_update_preserves_the_current_filename() {
        assert_eq!(
            update_target_filename(
                "current-name.md",
                "Another Routine",
                RoutineMutationPolicy::desktop(false),
            )
            .0,
            "current-name.md"
        );
        assert_eq!(
            update_target_filename(
                "current-name.md",
                "Another Routine",
                RoutineMutationPolicy::desktop(true),
            )
            .0,
            "Another Routine.md"
        );
    }

    #[test]
    fn serialized_create_and_update_rechecks_allow_only_one_equivalent_name() {
        let temp = tempfile::tempdir().unwrap();
        let owner = project_owner(temp.path());
        let first_id = "01arz3ndektsv4rrffq69g5fav";
        let second_id = "01arz3ndektsv4rrffq69g5faw";

        let empty = parser::discover_owner(&owner);
        assert!(routine_name_conflict(&empty, "Quarterly Review", None).is_none());
        let first_definition = manual_definition("Quarterly Review");
        let first = parser::serialize_definition(&first_definition, first_id).unwrap();
        create_definition_file(&owner, "Quarterly Review", first.as_bytes()).unwrap();

        let after_first = parser::discover_owner(&owner);
        let create_conflict =
            routine_name_conflict(&after_first, "  ＱＵＡＲＴＥＲＬＹ\u{2003}review ", None)
                .expect("second serialized create must observe the winner");
        assert_eq!(create_conflict.conflicts.len(), 1);
        assert_eq!(fs::read_dir(owner.routines_dir()).unwrap().count(), 1);
        assert!(
            routine_name_conflict(
                &parser::discover_owner(&collection_owner(temp.path())),
                "Quarterly Review",
                None,
            )
            .is_none(),
            "the same display name remains available in another exact owner"
        );

        let second_definition = manual_definition("Other");
        let second = parser::serialize_definition(&second_definition, second_id).unwrap();
        create_definition_file(&owner, "Other", second.as_bytes()).unwrap();
        let before_updates = parser::discover_owner(&owner);
        let first_row = before_updates
            .routines
            .iter()
            .find(|row| row.name == "Quarterly Review")
            .unwrap();
        let second_row = before_updates
            .routines
            .iter()
            .find(|row| row.name == "Other")
            .unwrap();
        let second_routine_id = second_row.routine_id.clone().unwrap();

        let shared_definition = manual_definition("Shared");
        let shared = parser::serialize_definition(&shared_definition, first_id).unwrap();
        assert!(matches!(
            update_definition_file_cas(
                &owner.routines_dir(),
                &first_row.filename,
                "shared.md",
                &first_row.fingerprint,
                shared.as_bytes(),
            )
            .unwrap(),
            DefinitionUpdateOutcome::Applied { .. }
        ));
        let after_winner = parser::discover_owner(&owner);
        let update_conflict =
            routine_name_conflict(&after_winner, "SHARED", Some(second_routine_id.as_str()))
                .expect("second serialized update must observe the winner");
        assert_eq!(update_conflict.conflicts[0].name, "Shared");
        assert_eq!(
            parser::discover_owner(&owner)
                .routines
                .iter()
                .find(|row| row.routine_id.as_deref() == Some(&second_routine_id))
                .unwrap()
                .name,
            "Other"
        );
    }

    #[test]
    fn explicit_name_intent_checks_conflicts_but_unrelated_inline_save_does_not() {
        let temp = tempfile::tempdir().unwrap();
        let owner = project_owner(temp.path());
        let content = parser::serialize_definition(
            &manual_definition("Existing duplicate"),
            "01arz3ndektsv4rrffq69g5fav",
        )
        .unwrap();
        create_definition_file(&owner, "Existing duplicate", content.as_bytes()).unwrap();
        let row = parser::discover_owner(&owner).routines.remove(0);

        assert!(update_requires_name_check(
            &row,
            "Existing duplicate",
            RoutineMutationPolicy::desktop(true),
        ));
        assert!(!update_requires_name_check(
            &row,
            "  EXISTING\u{2003}DUPLICATE ",
            RoutineMutationPolicy::desktop(false),
        ));
        assert!(update_requires_name_check(
            &row,
            "Different",
            RoutineMutationPolicy::desktop(false),
        ));
    }

    #[test]
    fn invalid_owner_candidate_is_blocked_without_creating_source() {
        let temp = tempfile::tempdir().unwrap();
        let owner = project_owner(temp.path());
        let blocked = validate_candidate(
            &owner,
            &event_definition(false),
            RoutineMutationPolicy::external_mcp(false),
        )
        .unwrap_err();
        assert!(matches!(
            blocked,
            ManagedRoutineMutationResult::Blocked {
                code: RoutineMutationBlockedCode::Invalid,
                diagnostics,
                ..
            } if diagnostics.iter().any(|diagnostic| diagnostic.code == "routine_event_owner_invalid")
        ));
        assert!(!owner.routines_dir().exists());
    }

    #[test]
    fn definition_file_crud_is_owner_local_stable_and_conflict_safe() {
        let temp = tempfile::tempdir().unwrap();
        let owner = project_owner(temp.path());
        let mut definition = RoutineDefinition {
            name: Some("Initial title".into()),
            description: None,
            enabled: None,
            trigger: RoutineTrigger::Manual,
            action: RoutineAction::RunAgent {
                executor: "agent:01arz3ndektsv4rrffq69g5fav".into(),
            },
            body: String::new(),
        };
        let portable_id = "01arz3ndektsv4rrffq69g5fav";
        let content = parser::serialize_definition(&definition, portable_id).unwrap();
        let filename = create_definition_file(&owner, "Initial title", content.as_bytes())
            .unwrap()
            .0;
        assert_eq!(filename, "Initial title.md");
        assert!(!owner.routines_dir().join("schema.yaml").exists());
        let first = parser::discover_owner(&owner);
        let first_row = first
            .routines
            .iter()
            .find(|row| row.filename == filename)
            .unwrap();
        let routine_id = first_row.routine_id.clone();
        let fingerprint = first_row.fingerprint.clone();

        definition.name = Some("Changed title".into());
        let content = parser::serialize_definition(&definition, portable_id).unwrap();
        assert_eq!(
            atomic_replace_cas(
                &owner.routines_dir().join(&filename),
                &fingerprint,
                content.as_bytes(),
            )
            .unwrap(),
            FileCasOutcome::Applied
        );
        let second = parser::discover_owner(&owner);
        let second_row = second
            .routines
            .iter()
            .find(|row| row.filename == filename)
            .unwrap();
        assert_eq!(second_row.routine_id, routine_id);
        assert_ne!(second_row.fingerprint, fingerprint);
        assert_eq!(second_row.name, "Changed title");

        assert_eq!(
            atomic_replace_cas(
                &owner.routines_dir().join(&filename),
                &fingerprint,
                b"must not replace the current definition",
            )
            .unwrap(),
            FileCasOutcome::Stale(Some(second_row.fingerprint.clone()))
        );
        assert_eq!(
            fs::read_to_string(owner.routines_dir().join(&filename)).unwrap(),
            content
        );
        assert!(fs::read_dir(owner.routines_dir()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".routine-")
        }));

        assert_eq!(
            delete_definition_file_cas(
                &owner.routines_dir(),
                &owner.routines_dir().join(&filename),
                &second_row.fingerprint,
            )
            .unwrap(),
            FileCasOutcome::Applied
        );
        assert!(parser::discover_owner(&owner).routines.is_empty());
        assert_eq!(
            delete_definition_file_cas(
                &owner.routines_dir(),
                &owner.routines_dir().join(&filename),
                &second_row.fingerprint,
            )
            .unwrap(),
            FileCasOutcome::Stale(None)
        );
    }

    #[test]
    fn managed_filename_allocation_rename_and_collision_are_deterministic() {
        let temp = tempfile::tempdir().unwrap();
        let owner = project_owner(temp.path());
        let first_id = "01arz3ndektsv4rrffq69g5fav";
        let second_id = "01arz3ndektsv4rrffq69g5faw";
        let mut definition = RoutineDefinition {
            name: Some("Same name".into()),
            description: None,
            enabled: None,
            trigger: RoutineTrigger::Manual,
            action: RoutineAction::RunAgent {
                executor: "agent:01arz3ndektsv4rrffq69g5fav".into(),
            },
            body: String::new(),
        };
        let first = parser::serialize_definition(&definition, first_id).unwrap();
        definition.name = Some("Same-name".into());
        let second = parser::serialize_definition(&definition, second_id).unwrap();
        assert_eq!(
            create_definition_file(&owner, "Same name", first.as_bytes())
                .unwrap()
                .0,
            "Same name.md"
        );
        assert_eq!(
            create_definition_file(&owner, "Same name", second.as_bytes())
                .unwrap()
                .0,
            "Same name-1.md"
        );

        let before = parser::discover_owner(&owner);
        let row = before
            .routines
            .iter()
            .find(|row| row.filename == "Same name.md")
            .unwrap();
        let stable_id = row.routine_id.clone();
        definition.name = Some("Renamed".into());
        let renamed = parser::serialize_definition(&definition, first_id).unwrap();
        let outcome = update_definition_file_cas(
            &owner.routines_dir(),
            "Same name.md",
            "Renamed.md",
            &row.fingerprint,
            renamed.as_bytes(),
        )
        .unwrap();
        assert!(matches!(
            outcome,
            DefinitionUpdateOutcome::Applied {
                filename,
                renamed: true,
            } if filename == "Renamed.md"
        ));
        let renamed_snapshot = parser::discover_owner(&owner);
        let renamed_row = renamed_snapshot
            .routines
            .iter()
            .find(|row| row.filename == "Renamed.md")
            .unwrap();
        assert_eq!(renamed_row.routine_id, stable_id);

        definition.name = Some("Same name".into());
        let collision_content = parser::serialize_definition(&definition, first_id).unwrap();
        let collision = update_definition_file_cas(
            &owner.routines_dir(),
            "Renamed.md",
            "Same name-1.md",
            &renamed_row.fingerprint,
            collision_content.as_bytes(),
        )
        .unwrap();
        assert!(matches!(
            collision,
            DefinitionUpdateOutcome::Collision {
                filename,
                target_filename,
            } if filename == "Renamed.md" && target_filename == "Same name-1.md"
        ));
        assert!(owner.routines_dir().join("Renamed.md").is_file());
        assert!(owner.routines_dir().join("Same name-1.md").is_file());
        let after_collision = parser::discover_owner(&owner);
        assert_eq!(after_collision.routines.len(), 2);
        assert_eq!(
            after_collision
                .routines
                .iter()
                .find(|row| row.filename == "Renamed.md")
                .unwrap()
                .routine_id,
            stable_id
        );
    }

    #[test]
    fn invalid_source_can_be_repaired_with_its_current_fingerprint() {
        let temp = tempfile::tempdir().unwrap();
        let owner = project_owner(temp.path());
        fs::create_dir_all(owner.routines_dir()).unwrap();
        let path = owner.routines_dir().join("repair.md");
        fs::write(&path, "---\ntrigger: [\n---\nBroken\n").unwrap();
        let invalid = parser::discover_owner(&owner).routines.remove(0);
        assert!(invalid.definition.is_none());
        let routine_id = invalid.routine_id;

        let definition = RoutineDefinition {
            name: Some("Repaired".into()),
            description: None,
            enabled: None,
            trigger: RoutineTrigger::Manual,
            action: RoutineAction::RunAgent {
                executor: "agent:01arz3ndektsv4rrffq69g5fav".into(),
            },
            body: "Valid replacement.".into(),
        };
        let content =
            parser::serialize_definition(&definition, "01arz3ndektsv4rrffq69g5fav").unwrap();
        assert_eq!(
            atomic_replace_cas(&path, &invalid.fingerprint, content.as_bytes()).unwrap(),
            FileCasOutcome::Applied
        );

        let repaired = parser::discover_owner(&owner).routines.remove(0);
        assert!(routine_id.is_none());
        assert!(repaired.routine_id.is_some());
        assert_eq!(repaired.name, "Repaired");
        assert!(repaired.definition.is_some());
        assert!(repaired.diagnostics.is_empty());
    }

    #[test]
    fn routine_filename_projection_preserves_safe_unicode_and_punctuation() {
        assert_eq!(filename::project("  Привет, мир!  ").stem, "Привет, мир!");
        assert_eq!(filename::project("Ёжик и щука").stem, "Ёжик и щука");
        assert_eq!(filename::project("日本語").stem, "日本語");
        assert_eq!(
            filename::project("Quarterly Review!").stem,
            "Quarterly Review!"
        );

        let temp = tempfile::tempdir().unwrap();
        let owner = project_owner(temp.path());
        let (created, projection, suffixed) =
            create_definition_file(&owner, "日本語 Routine 🚀", b"managed").unwrap();
        assert_eq!(created, "日本語 Routine 🚀.md");
        assert!(projection.reasons.is_empty());
        assert!(!suffixed);
    }

    #[tokio::test]
    async fn post_write_projection_failure_keeps_source_snapshot_and_warning() {
        let temp = tempfile::tempdir().unwrap();
        let owner = project_owner(temp.path());
        fs::create_dir_all(owner.routines_dir()).unwrap();
        fs::write(
            owner.routines_dir().join("kept.md"),
            "---\ntrigger:\n  type: manual\naction:\n  type: run_agent\n  executor: agent:01arz3ndektsv4rrffq69g5fav\n---\nKept\n",
        )
        .unwrap();
        let index_state = IndexState::new();
        let pool = index_state.get_or_create(&owner.index_key).await.unwrap();
        pool.close().await;

        let (snapshot, warnings) = projection_after_write(
            &index_state,
            &TerminalManager::new(),
            &owner,
            ".routines/kept.md",
        )
        .await
        .unwrap();

        assert_eq!(snapshot.routines.len(), 1);
        assert!(warnings.iter().any(|diagnostic| {
            matches!(
                diagnostic.code.as_str(),
                "routine_cache_unavailable" | "routine_run_cache_unavailable"
            )
        }));
        assert!(owner.routines_dir().join("kept.md").is_file());
    }

    #[tokio::test]
    async fn shared_read_keeps_valid_and_malformed_rows_and_exact_owner_authority() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path();
        let collection = project.join("tasks");
        let routines = collection.join(".routines");
        fs::create_dir_all(&routines).unwrap();
        fs::write(collection.join("schema.yaml"), "name: Tasks\n").unwrap();
        fs::write(
            routines.join("valid.md"),
            "---\nid: 01arz3ndektsv4rrffq69g5fav\nname: Valid\ntrigger:\n  type: event\n  event: collection.entry_created\naction:\n  type: update_properties\n  target: trigger.entry\n  set:\n    reviewed: true\n---\nBody\n",
        )
        .unwrap();
        fs::write(routines.join("invalid.md"), "---\ntrigger: [\n---\n").unwrap();
        write_space_config(project, &space_config("Project", None)).unwrap();
        let owner = resolve_owner(
            project,
            project,
            "root",
            "tasks",
            RoutineOwnerInputKind::CollectionDirectory,
        )
        .unwrap();
        let index_state = IndexState::new();
        let terminal_manager = TerminalManager::new();

        let snapshot = read_catalog(&index_state, &terminal_manager, &owner)
            .await
            .unwrap();

        assert_eq!(snapshot.routines.len(), 2);
        let valid = snapshot
            .routines
            .iter()
            .find(|row| row.filename == "valid.md")
            .unwrap();
        assert!(valid.definition.is_some());
        assert!(valid.diagnostics.is_empty());
        let invalid = snapshot
            .routines
            .iter()
            .find(|row| row.filename == "invalid.md")
            .unwrap();
        assert!(invalid.definition.is_none());
        assert_eq!(invalid.diagnostics[0].code, "routine_frontmatter_invalid");

        assert!(
            !read_automatic_authority(&index_state, &owner)
                .await
                .unwrap()
        );
        let pool = index_state
            .get_or_create(&IndexKey::Root(owner.project_path.clone()))
            .await
            .unwrap();
        authority::set(&pool, &owner, true).await.unwrap();
        assert!(
            read_automatic_authority(&index_state, &owner)
                .await
                .unwrap()
        );
    }
}

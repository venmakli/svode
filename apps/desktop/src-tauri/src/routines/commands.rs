use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{SecondsFormat, Utc};
use tauri::{AppHandle, Manager, State};

use super::model::{
    CollectionEvent, MissedRuns, ResolvedRoutineOwner, RoutineAction, RoutineAutomaticConsent,
    RoutineCatalogSnapshot, RoutineDefinition, RoutineDispatchBlockedCode,
    RoutineManualDispatchResult, RoutineMutationResult, RoutineOwnerInputKind, RoutineOwnerKind,
    RoutineTrigger, RoutineTriggerType,
};
#[cfg(test)]
use super::parser;
use super::{authority, cache, service};
use crate::AppError;
use crate::agent_actors;
use crate::agent_actors::launch::{AgentLaunchResolution, AgentLaunchValidationCode};
use crate::agent_adapters::runtime::{
    AdapterDiagnostic, AdapterTarget, ManualRoutineLaunchInput, SystemRuntimeCommandRunner,
};
use crate::agent_adapters::{AgentAdapterKind, AgentAdapterRegistry};
use crate::agent_sessions::types::{AgentSessionResumeCommand, AgentSessionSource};
use crate::files::WriteNonceRegistry;
use crate::git::access::{
    RepositoryAccessState, require_repository_mutation_paths, scope_authorized_mutation_paths,
};
use crate::git::commands::GitState;
use crate::index::{IndexKey, IndexState};
use crate::terminal::{AgentTerminalSpawn, TerminalManager, quote_agent_shell_command};

const DEFAULT_SCHEDULE_CRON: &str = "0 9 * * 1-5";

#[derive(Debug)]
struct RoutineOwnerInput {
    project_path: String,
    space_path: String,
    space_id: String,
    owner_path: String,
    owner_kind: RoutineOwnerInputKind,
}

impl RoutineOwnerInput {
    fn resolve(self) -> Result<ResolvedRoutineOwner, AppError> {
        service::resolve_owner(
            Path::new(&self.project_path),
            Path::new(&self.space_path),
            &self.space_id,
            &self.owner_path,
            self.owner_kind,
        )
    }
}

#[tauri::command]
pub async fn routines_list(
    project_path: String,
    space_path: String,
    space_id: String,
    owner_path: String,
    owner_kind: RoutineOwnerInputKind,
    index_state: State<'_, IndexState>,
    terminal_manager: State<'_, TerminalManager>,
) -> Result<RoutineCatalogSnapshot, AppError> {
    let owner = RoutineOwnerInput {
        project_path,
        space_path,
        space_id,
        owner_path,
        owner_kind,
    }
    .resolve()?;
    service::read_catalog(&index_state, &terminal_manager, &owner).await
}

#[tauri::command]
pub async fn routines_refresh(
    project_path: String,
    space_path: String,
    space_id: String,
    owner_path: String,
    owner_kind: RoutineOwnerInputKind,
    index_state: State<'_, IndexState>,
    terminal_manager: State<'_, TerminalManager>,
) -> Result<RoutineCatalogSnapshot, AppError> {
    routines_list(
        project_path,
        space_path,
        space_id,
        owner_path,
        owner_kind,
        index_state,
        terminal_manager,
    )
    .await
}

#[tauri::command]
pub async fn routines_get_automatic_consent(
    project_path: String,
    space_path: String,
    space_id: String,
    owner_path: String,
    owner_kind: RoutineOwnerInputKind,
    index_state: State<'_, IndexState>,
) -> Result<RoutineAutomaticConsent, AppError> {
    let owner = RoutineOwnerInput {
        project_path,
        space_path,
        space_id,
        owner_path,
        owner_kind,
    }
    .resolve()?;
    Ok(RoutineAutomaticConsent {
        enabled: service::read_automatic_authority(&index_state, &owner).await?,
    })
}

#[tauri::command]
pub async fn routines_set_automatic_consent(
    project_path: String,
    space_path: String,
    space_id: String,
    owner_path: String,
    owner_kind: RoutineOwnerInputKind,
    enabled: bool,
    index_state: State<'_, IndexState>,
) -> Result<RoutineAutomaticConsent, AppError> {
    let owner = RoutineOwnerInput {
        project_path,
        space_path,
        space_id,
        owner_path,
        owner_kind,
    }
    .resolve()?;
    let pool = index_state
        .get_or_create(&IndexKey::Root(owner.project_path.clone()))
        .await?;
    authority::migrate_legacy_for_project(&pool, &index_state, &owner.project_path).await?;
    Ok(RoutineAutomaticConsent {
        enabled: authority::set(&pool, &owner, enabled).await?,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn routines_create(
    app: AppHandle,
    project_path: String,
    space_path: String,
    space_id: String,
    owner_path: String,
    owner_kind: RoutineOwnerInputKind,
    title: String,
    description: Option<String>,
    trigger_type: RoutineTriggerType,
    timezone: Option<String>,
    git_state: State<'_, GitState>,
    access_state: State<'_, RepositoryAccessState>,
    index_state: State<'_, IndexState>,
    terminal_manager: State<'_, TerminalManager>,
) -> Result<RoutineMutationResult, AppError> {
    let owner = RoutineOwnerInput {
        project_path,
        space_path,
        space_id,
        owner_path,
        owner_kind,
    }
    .resolve()?;
    let definition = match create_definition(
        &title,
        description.as_deref(),
        trigger_type,
        timezone.as_deref(),
        owner.descriptor.kind,
    ) {
        Ok(definition) => definition,
        Err(message) => return Ok(RoutineMutationResult::Blocked { message }),
    };
    Ok(desktop_mutation_result(
        service::create_managed(
            &app,
            owner,
            definition,
            service::RoutineMutationPolicy::desktop(),
            &git_state,
            &access_state,
            &index_state,
            &terminal_manager,
        )
        .await?,
    ))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn routines_update(
    app: AppHandle,
    project_path: String,
    space_path: String,
    space_id: String,
    owner_path: String,
    owner_kind: RoutineOwnerInputKind,
    routine_id: String,
    expected_fingerprint: String,
    definition: RoutineDefinition,
    git_state: State<'_, GitState>,
    access_state: State<'_, RepositoryAccessState>,
    index_state: State<'_, IndexState>,
    terminal_manager: State<'_, TerminalManager>,
) -> Result<RoutineMutationResult, AppError> {
    let owner = RoutineOwnerInput {
        project_path,
        space_path,
        space_id,
        owner_path,
        owner_kind,
    }
    .resolve()?;
    Ok(desktop_mutation_result(
        service::update_managed(
            &app,
            owner,
            routine_id,
            expected_fingerprint,
            definition,
            service::RoutineMutationPolicy::desktop(),
            &git_state,
            &access_state,
            &index_state,
            &terminal_manager,
        )
        .await?,
    ))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn routines_delete(
    app: AppHandle,
    project_path: String,
    space_path: String,
    space_id: String,
    owner_path: String,
    owner_kind: RoutineOwnerInputKind,
    routine_id: String,
    expected_fingerprint: String,
    git_state: State<'_, GitState>,
    access_state: State<'_, RepositoryAccessState>,
    index_state: State<'_, IndexState>,
    terminal_manager: State<'_, TerminalManager>,
) -> Result<RoutineMutationResult, AppError> {
    let owner = RoutineOwnerInput {
        project_path,
        space_path,
        space_id,
        owner_path,
        owner_kind,
    }
    .resolve()?;
    Ok(desktop_mutation_result(
        service::delete_managed(
            &app,
            owner,
            routine_id,
            expected_fingerprint,
            &git_state,
            &access_state,
            &index_state,
            &terminal_manager,
        )
        .await?,
    ))
}

fn desktop_mutation_result(result: service::ManagedRoutineMutationResult) -> RoutineMutationResult {
    match result {
        service::ManagedRoutineMutationResult::Applied {
            routine_id,
            snapshot,
            ..
        } => RoutineMutationResult::Applied {
            routine_id,
            snapshot,
        },
        service::ManagedRoutineMutationResult::Conflict {
            current_fingerprint,
        } => RoutineMutationResult::Stale {
            current_fingerprint,
        },
        service::ManagedRoutineMutationResult::Blocked { message, .. } => {
            RoutineMutationResult::Blocked { message }
        }
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn routines_dispatch_manual(
    app: AppHandle,
    project_path: String,
    space_path: String,
    space_id: String,
    owner_path: String,
    owner_kind: RoutineOwnerInputKind,
    routine_id: String,
    git_state: State<'_, GitState>,
    access_state: State<'_, RepositoryAccessState>,
    index_state: State<'_, IndexState>,
    terminal_manager: State<'_, TerminalManager>,
) -> Result<RoutineManualDispatchResult, AppError> {
    let owner = RoutineOwnerInput {
        project_path,
        space_path,
        space_id,
        owner_path,
        owner_kind,
    }
    .resolve()?;
    dispatch_routine(
        &app,
        owner,
        routine_id,
        DispatchKind::Manual,
        &git_state,
        &access_state,
        &index_state,
        &terminal_manager,
    )
    .await
}

#[derive(Debug, Clone)]
enum DispatchKind {
    Manual,
    Scheduled,
    Event {
        payload: Box<super::events::CollectionEventPayload>,
        execution_run_id: String,
        definition_fingerprint: String,
    },
}

pub(crate) async fn dispatch_event(
    app: &AppHandle,
    owner: ResolvedRoutineOwner,
    event: cache::QueuedRoutineEvent,
    execution_run_id: String,
) -> Result<RoutineManualDispatchResult, AppError> {
    let payload = serde_json::from_str(&event.payload_json)?;
    let git_state = app.state::<GitState>();
    let access_state = app.state::<RepositoryAccessState>();
    let index_state = app.state::<IndexState>();
    let terminal_manager = app.state::<TerminalManager>();
    dispatch_routine(
        app,
        owner,
        event.routine_id,
        DispatchKind::Event {
            payload: Box::new(payload),
            execution_run_id,
            definition_fingerprint: event.definition_fingerprint,
        },
        &git_state,
        &access_state,
        &index_state,
        &terminal_manager,
    )
    .await
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum EventDispatchPreflight {
    RunAgent,
    UpdateProperties { mutation_paths: Vec<PathBuf> },
}

pub(crate) async fn event_dispatch_preflight(
    owner: &ResolvedRoutineOwner,
    event: &cache::QueuedRoutineEvent,
) -> Option<EventDispatchPreflight> {
    let Ok(snapshot) = service::discover_owner(owner).await else {
        return None;
    };
    let Some(row) = snapshot.routines.iter().find(|row| {
        row.routine_id == event.routine_id
            && row.fingerprint == event.definition_fingerprint
            && row.diagnostics.is_empty()
    }) else {
        return None;
    };
    let Some(definition) = row.definition.as_ref().filter(|definition| {
        definition.enabled == Some(true)
            && matches!(definition.trigger, RoutineTrigger::Event { .. })
    }) else {
        return None;
    };
    match &definition.action {
        RoutineAction::RunAgent { .. } => scheduled_dispatch_ready(owner, definition)
            .await
            .then_some(EventDispatchPreflight::RunAgent),
        RoutineAction::UpdateProperties { set, .. } => {
            let Ok(payload) =
                serde_json::from_str::<super::events::CollectionEventPayload>(&event.payload_json)
            else {
                return None;
            };
            if payload.event_type == CollectionEvent::EntryDeleted.as_str()
                || payload.new_entry.is_none()
            {
                return None;
            }
            crate::properties::entry_property_batch_mutation_paths_with_project(
                &owner.space_path.to_string_lossy(),
                Some(&owner.project_path.to_string_lossy()),
                &payload.entry_path,
                set,
            )
            .ok()
            .map(|mutation_paths| EventDispatchPreflight::UpdateProperties { mutation_paths })
        }
    }
}

pub(crate) async fn dispatch_scheduled(
    app: &AppHandle,
    owner: ResolvedRoutineOwner,
    routine_id: String,
) -> Result<RoutineManualDispatchResult, AppError> {
    let git_state = app.state::<GitState>();
    let access_state = app.state::<RepositoryAccessState>();
    let index_state = app.state::<IndexState>();
    let terminal_manager = app.state::<TerminalManager>();
    dispatch_routine(
        app,
        owner,
        routine_id,
        DispatchKind::Scheduled,
        &git_state,
        &access_state,
        &index_state,
        &terminal_manager,
    )
    .await
}

pub(crate) async fn scheduled_dispatch_ready(
    owner: &ResolvedRoutineOwner,
    definition: &RoutineDefinition,
) -> bool {
    let RoutineAction::RunAgent { executor } = &definition.action else {
        return false;
    };
    let diagnostics = collect_adapter_diagnostics(&owner.space_path).await;
    let inherited_root =
        (owner.space_path != owner.project_path).then_some(owner.project_path.as_path());
    let AgentLaunchResolution::Ready {
        request,
        selected_binding_index,
        attempts,
    } = agent_actors::launch::resolve_agent_launch_request(
        &owner.space_path,
        inherited_root,
        Some(executor),
        &diagnostics,
    )
    else {
        return false;
    };
    let Some(executable_path) = attempts
        .iter()
        .find(|attempt| attempt.binding_index == selected_binding_index)
        .and_then(|attempt| attempt.diagnostic.as_ref())
        .and_then(|diagnostic| diagnostic.executable_path.as_deref())
    else {
        return false;
    };
    AgentAdapterRegistry
        .build_manual_routine_launch(
            &request,
            Path::new(executable_path),
            &ManualRoutineLaunchInput {
                instruction: definition.body.clone(),
                launch_id: "schedule-preflight".into(),
                owner_kind: routine_owner_kind_name(owner.descriptor.kind).into(),
                owner_path: owner.descriptor.owner_path.clone(),
                event_context: None,
            },
        )
        .is_ok()
}

#[allow(clippy::too_many_arguments)]
async fn dispatch_routine(
    app: &AppHandle,
    owner: ResolvedRoutineOwner,
    routine_id: String,
    dispatch_kind: DispatchKind,
    git_state: &GitState,
    access_state: &RepositoryAccessState,
    index_state: &IndexState,
    terminal_manager: &TerminalManager,
) -> Result<RoutineManualDispatchResult, AppError> {
    let snapshot = service::discover_owner(&owner).await?;
    let Some(row) = snapshot
        .routines
        .iter()
        .find(|row| row.routine_id == routine_id)
    else {
        return Ok(dispatch_blocked(
            routine_id,
            RoutineDispatchBlockedCode::InvalidRoutine,
            "routine definition was not found for this owner",
        ));
    };
    let Some(definition) = row.definition.clone() else {
        return Ok(dispatch_blocked(
            routine_id,
            RoutineDispatchBlockedCode::InvalidRoutine,
            "routine definition is invalid and cannot be launched",
        ));
    };
    if !row.diagnostics.is_empty() {
        return Ok(dispatch_blocked(
            routine_id,
            RoutineDispatchBlockedCode::InvalidRoutine,
            row.diagnostics
                .first()
                .map(|diagnostic| diagnostic.message.as_str())
                .unwrap_or("routine definition is invalid"),
        ));
    }
    let trigger_allowed = match &dispatch_kind {
        DispatchKind::Manual => !matches!(definition.trigger, RoutineTrigger::Event { .. }),
        DispatchKind::Scheduled => {
            matches!(definition.trigger, RoutineTrigger::Schedule { .. })
                && definition.enabled == Some(true)
        }
        DispatchKind::Event { .. } => {
            matches!(definition.trigger, RoutineTrigger::Event { .. })
                && definition.enabled == Some(true)
        }
    };
    if !trigger_allowed {
        return Ok(dispatch_blocked(
            routine_id,
            RoutineDispatchBlockedCode::NonManualTrigger,
            match &dispatch_kind {
                DispatchKind::Manual => "event routines require a concrete Collection event",
                DispatchKind::Scheduled => "routine is not an enabled schedule",
                DispatchKind::Event { .. } => "routine is not an enabled event routine",
            },
        ));
    }
    let executor = match &definition.action {
        RoutineAction::RunAgent { executor } => Some(executor.as_str()),
        RoutineAction::UpdateProperties { .. }
            if matches!(dispatch_kind, DispatchKind::Event { .. }) =>
        {
            None
        }
        RoutineAction::UpdateProperties { .. } => {
            return Ok(dispatch_blocked(
                routine_id,
                RoutineDispatchBlockedCode::UnsupportedAction,
                "manual update_properties routines are not supported",
            ));
        }
    };

    let repository = service::mutation_repository(git_state, &owner).await?;
    let lock = git_state.get_lock(&repository).await;
    let _guard = lock.lock().await;
    let pool = index_state.get_or_create(&owner.index_key).await?;
    if let DispatchKind::Event {
        definition_fingerprint,
        ..
    } = &dispatch_kind
        && definition_fingerprint != &row.fingerprint
    {
        return Ok(dispatch_blocked(
            routine_id,
            RoutineDispatchBlockedCode::InvalidRoutine,
            "queued event definition is stale",
        ));
    }
    let live_pty_ids = service::live_agent_pty_ids(terminal_manager)?;
    if let Some(run) = cache::latest_run(&pool, &owner.descriptor.owner_path, &routine_id).await?
        && run.blocks_relaunch(&live_pty_ids)
    {
        return Ok(RoutineManualDispatchResult::Focused {
            routine_id,
            routine_run_id: run.routine_run_id,
            launch_id: run.launch_id,
            agent_session_id: run.agent_session_id,
            source_session_id: run.source_session_id,
            pty_id: run.pty_id,
        });
    }

    if let Err(error) = service::authorize_mutation(app, git_state, access_state, &repository).await
    {
        return Ok(dispatch_blocked(
            routine_id,
            RoutineDispatchBlockedCode::RepositoryAccessDenied,
            error.to_string(),
        ));
    }

    if let (
        RoutineAction::UpdateProperties { set, .. },
        DispatchKind::Event {
            payload,
            execution_run_id,
            ..
        },
    ) = (&definition.action, &dispatch_kind)
    {
        if payload.event_type == CollectionEvent::EntryDeleted.as_str()
            || payload.new_entry.is_none()
        {
            return Ok(dispatch_blocked(
                routine_id,
                RoutineDispatchBlockedCode::UnsupportedAction,
                "update_properties requires a live trigger entry",
            ));
        }
        let space = owner.space_path.to_string_lossy().into_owned();
        let project = owner.project_path.to_string_lossy().into_owned();
        let paths = crate::properties::entry_property_batch_mutation_paths_with_project(
            &space,
            Some(&project),
            &payload.entry_path,
            set,
        )?;
        require_repository_mutation_paths(app, paths.clone()).await?;
        let mutation = scope_authorized_mutation_paths(paths, async {
            crate::properties::update_entry_properties_atomic(
                &space,
                Some(&project),
                &payload.entry_path,
                set,
            )
        })
        .await;
        return match mutation {
            Ok(_) => {
                let joined = owner.space_path.join(&payload.entry_path);
                let canonical = std::fs::canonicalize(&joined).unwrap_or(joined);
                app.state::<WriteNonceRegistry>().register_with_origin(
                    canonical,
                    new_runtime_id(),
                    Some(execution_run_id.clone()),
                    "routine_update_properties",
                );
                Ok(RoutineManualDispatchResult::Focused {
                    routine_id,
                    routine_run_id: execution_run_id.clone(),
                    launch_id: execution_run_id.clone(),
                    agent_session_id: String::new(),
                    source_session_id: None,
                    pty_id: None,
                })
            }
            Err(error) => Ok(RoutineManualDispatchResult::Failed {
                routine_id,
                routine_run_id: execution_run_id.clone(),
                launch_id: execution_run_id.clone(),
                agent_session_id: String::new(),
                message: error.to_string(),
            }),
        };
    }

    let diagnostics = collect_adapter_diagnostics(&owner.space_path).await;
    let inherited_root =
        (owner.space_path != owner.project_path).then_some(owner.project_path.as_path());
    let resolution = agent_actors::launch::resolve_agent_launch_request(
        &owner.space_path,
        inherited_root,
        executor,
        &diagnostics,
    );
    let (request, selected_binding_index, attempts) = match resolution {
        AgentLaunchResolution::Ready {
            request,
            selected_binding_index,
            attempts,
        } => (request, selected_binding_index, attempts),
        AgentLaunchResolution::MissingExecutor { code }
        | AgentLaunchResolution::MissingActorId { code, .. }
        | AgentLaunchResolution::AmbiguousActorId { code, .. }
        | AgentLaunchResolution::UnavailableExecutor { code, .. } => {
            let (blocked_code, message) = launch_resolution_block(code);
            return Ok(dispatch_blocked(routine_id, blocked_code, message));
        }
    };
    let executable_path = attempts
        .iter()
        .find(|attempt| attempt.binding_index == selected_binding_index)
        .and_then(|attempt| attempt.diagnostic.as_ref())
        .and_then(|diagnostic| diagnostic.executable_path.as_deref())
        .ok_or_else(|| {
            AppError::General("resolved Agent Actor binding has no executable path".into())
        })?;
    let routine_run_id = match &dispatch_kind {
        DispatchKind::Event {
            execution_run_id, ..
        } => execution_run_id.clone(),
        _ => new_runtime_id(),
    };
    let launch_id = new_runtime_id();
    let registry = AgentAdapterRegistry;
    let launch = match registry.build_manual_routine_launch(
        &request,
        Path::new(executable_path),
        &ManualRoutineLaunchInput {
            instruction: definition.body.clone(),
            launch_id: launch_id.clone(),
            owner_kind: routine_owner_kind_name(owner.descriptor.kind).to_string(),
            owner_path: owner.descriptor.owner_path.clone(),
            event_context: match &dispatch_kind {
                DispatchKind::Event { payload, .. } => Some(serde_json::to_string(payload)?),
                _ => None,
            },
        },
    ) {
        Ok(launch) => launch,
        Err(validation) => {
            let message = validation
                .issues
                .first()
                .map(|issue| issue.message.clone())
                .unwrap_or_else(|| "Agent Actor binding is unavailable".to_string());
            return Ok(dispatch_blocked(
                routine_id,
                RoutineDispatchBlockedCode::UnavailableExecutor,
                message,
            ));
        }
    };
    let source = adapter_session_source(launch.adapter);
    let source_session_id = launch
        .source_session_id
        .clone()
        .unwrap_or_else(|| format!("launch:{launch_id}"));
    let agent_session_id = format!("{}:{source_session_id}", source.as_str());
    let created_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);

    cache::create_run(
        &pool,
        cache::NewRoutineRun {
            routine_run_id: &routine_run_id,
            routine_id: &routine_id,
            owner_path: &owner.descriptor.owner_path,
            trigger_type: match &dispatch_kind {
                DispatchKind::Manual => "manual",
                DispatchKind::Scheduled => "schedule",
                DispatchKind::Event { .. } => "event",
            },
            definition_fingerprint: &row.fingerprint,
            definition: &definition,
            launch_id: &launch_id,
            source: source.as_str(),
            source_session_id: launch.source_session_id.as_deref(),
            agent_session_id: &agent_session_id,
            created_at: &created_at,
        },
    )
    .await?;

    let command_display = quote_agent_shell_command(&launch.program, &launch.argv);
    let spawn = AgentTerminalSpawn {
        agent_session_id: agent_session_id.clone(),
        title: Some(row.title.clone()),
        source,
        source_session_id: source_session_id.clone(),
        command: AgentSessionResumeCommand {
            display: command_display,
            program: launch.program.clone(),
            args: launch.argv.clone(),
            cwd: Some(launch.cwd.clone()),
        },
        cwd: launch.cwd,
        mcp_project_path: Some(owner.project_path.to_string_lossy().into_owned()),
        launch_id: Some(launch_id.clone()),
        routine_run_id: Some(routine_run_id.clone()),
        lifecycle_sink: Some(Arc::new(cache::RoutineRunLifecycleSink::with_invalidation(
            pool.clone(),
            owner.space_path.join(".svode").join("index.db"),
            routine_run_id.clone(),
            app.clone(),
            &owner,
        ))),
    };
    let terminal = match terminal_manager.spawn_agent_shell_session(app.clone(), spawn) {
        Ok(terminal) => terminal,
        Err(error) => {
            let message = format!("failed to start agent CLI: {error}");
            cache::record_terminal_outcome(
                &pool,
                &routine_run_id,
                super::model::RoutineRunTerminalStatus::Failed,
                None,
                &message,
                &Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
            )
            .await?;
            super::emit_owner_invalidation(app, &owner);
            return Ok(RoutineManualDispatchResult::Failed {
                routine_id,
                routine_run_id,
                launch_id,
                agent_session_id,
                message,
            });
        }
    };
    if let Err(error) = cache::attach_pty(
        &pool,
        &routine_run_id,
        &terminal.pty_id,
        &Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
    )
    .await
    {
        let _ = terminal_manager.kill(&terminal.pty_id);
        return Ok(RoutineManualDispatchResult::Failed {
            routine_id,
            routine_run_id,
            launch_id,
            agent_session_id,
            message: format!("failed to persist managed PTY mapping: {error}"),
        });
    }
    super::emit_owner_invalidation(app, &owner);

    Ok(RoutineManualDispatchResult::Started {
        routine_id,
        routine_run_id,
        launch_id,
        agent_session_id,
        source_session_id: launch.source_session_id,
        pty_id: terminal.pty_id,
    })
}

fn dispatch_blocked(
    routine_id: String,
    code: RoutineDispatchBlockedCode,
    message: impl Into<String>,
) -> RoutineManualDispatchResult {
    RoutineManualDispatchResult::Blocked {
        routine_id,
        code,
        message: message.into(),
    }
}

fn launch_resolution_block(
    code: AgentLaunchValidationCode,
) -> (RoutineDispatchBlockedCode, &'static str) {
    match code {
        AgentLaunchValidationCode::MissingExecutor => (
            RoutineDispatchBlockedCode::MissingExecutor,
            "routine has no Agent Actor executor",
        ),
        AgentLaunchValidationCode::MissingActorId => (
            RoutineDispatchBlockedCode::MissingActorId,
            "routine Agent Actor no longer exists",
        ),
        AgentLaunchValidationCode::AmbiguousActorId => (
            RoutineDispatchBlockedCode::AmbiguousActorId,
            "routine Agent Actor reference is ambiguous between owner catalogs",
        ),
        AgentLaunchValidationCode::UnavailableExecutor => (
            RoutineDispatchBlockedCode::UnavailableExecutor,
            "routine Agent Actor has no eligible local CLI binding",
        ),
    }
}

async fn collect_adapter_diagnostics(
    launch_space: &Path,
) -> BTreeMap<AgentAdapterKind, AdapterDiagnostic> {
    let registry = AgentAdapterRegistry;
    let target = AdapterTarget {
        cwd: launch_space.to_path_buf(),
    };
    let (codex, claude) = tokio::join!(
        registry.diagnose(
            AgentAdapterKind::Codex,
            &target,
            &SystemRuntimeCommandRunner,
        ),
        registry.diagnose(
            AgentAdapterKind::ClaudeCode,
            &target,
            &SystemRuntimeCommandRunner,
        ),
    );
    BTreeMap::from([
        (AgentAdapterKind::Codex, codex),
        (AgentAdapterKind::ClaudeCode, claude),
    ])
}

fn adapter_session_source(adapter: AgentAdapterKind) -> AgentSessionSource {
    match adapter {
        AgentAdapterKind::Codex => AgentSessionSource::Codex,
        AgentAdapterKind::ClaudeCode => AgentSessionSource::ClaudeCode,
    }
}

fn routine_owner_kind_name(kind: RoutineOwnerKind) -> &'static str {
    match kind {
        RoutineOwnerKind::Project => "project",
        RoutineOwnerKind::Space => "space",
        RoutineOwnerKind::Collection => "collection",
    }
}

fn new_runtime_id() -> String {
    ulid::Ulid::new().to_string().to_ascii_lowercase()
}

fn create_definition(
    title: &str,
    description: Option<&str>,
    trigger_type: RoutineTriggerType,
    timezone: Option<&str>,
    owner_kind: RoutineOwnerKind,
) -> Result<RoutineDefinition, String> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 240 {
        return Err("routine title must contain 1 to 240 characters".into());
    }
    let description = description.map(str::trim).filter(|value| !value.is_empty());
    if description.is_some_and(|value| value.chars().count() > 2_000) {
        return Err("routine description must contain at most 2000 characters".into());
    }
    let (enabled, trigger) = match trigger_type {
        RoutineTriggerType::Manual => (None, RoutineTrigger::Manual),
        RoutineTriggerType::Schedule => {
            let timezone = timezone
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "schedule routines require an explicit IANA timezone".to_string())?;
            (
                Some(false),
                RoutineTrigger::Schedule {
                    cron: DEFAULT_SCHEDULE_CRON.into(),
                    timezone: timezone.into(),
                    missed_runs: MissedRuns::Skip,
                },
            )
        }
        RoutineTriggerType::Event if owner_kind == RoutineOwnerKind::Collection => (
            Some(false),
            RoutineTrigger::Event {
                event: CollectionEvent::EntryCreated,
                match_: None,
            },
        ),
        RoutineTriggerType::Event => {
            return Err("event routines require a Collection owner".into());
        }
    };
    Ok(RoutineDefinition {
        title: Some(title.into()),
        description: description.map(str::to_owned),
        enabled,
        trigger,
        action: RoutineAction::RunAgent {
            executor: String::new(),
        },
        body: String::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

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

    #[test]
    fn create_defaults_are_disabled_until_an_executor_is_chosen() {
        let definition = create_definition(
            "Weekly review",
            Some("  Summarizes weekly changes.  "),
            RoutineTriggerType::Schedule,
            Some("Europe/Paris"),
            RoutineOwnerKind::Space,
        )
        .unwrap();
        assert_eq!(definition.enabled, Some(false));
        assert_eq!(
            definition.description.as_deref(),
            Some("Summarizes weekly changes.")
        );
        assert!(matches!(
            definition.trigger,
            RoutineTrigger::Schedule {
                missed_runs: MissedRuns::Skip,
                ..
            }
        ));
        assert_eq!(definition.action.executor(), Some(""));
    }

    #[test]
    fn event_create_is_collection_only() {
        assert!(
            create_definition(
                "Event",
                None,
                RoutineTriggerType::Event,
                None,
                RoutineOwnerKind::Project,
            )
            .is_err()
        );
    }

    #[tokio::test]
    async fn event_property_preflight_carries_the_exact_mutation_plan() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path();
        let collection = project.join("tasks");
        fs::create_dir_all(&collection).unwrap();
        write_space_config(project, &space_config("Project", None)).unwrap();
        fs::write(
            collection.join("schema.yaml"),
            "columns:\n  - { name: reviewed, type: checkbox }\nviews: []\n",
        )
        .unwrap();
        fs::write(
            collection.join("item.md"),
            "---\ntitle: Item\nreviewed: false\n---\n",
        )
        .unwrap();
        let owner = service::resolve_owner(
            project,
            project,
            "root-id",
            "tasks",
            RoutineOwnerInputKind::CollectionDirectory,
        )
        .unwrap();
        let definition = RoutineDefinition {
            title: Some("Review item".into()),
            description: None,
            enabled: Some(true),
            trigger: RoutineTrigger::Event {
                event: CollectionEvent::FieldChanged,
                match_: Some(super::super::model::EventMatch {
                    field: "reviewed".into(),
                    from: Some(serde_json::Value::Bool(false)),
                    to: Some(serde_json::Value::Bool(true)),
                }),
            },
            action: RoutineAction::UpdateProperties {
                target: super::super::model::RoutineActionTarget::TriggerEntry,
                set: BTreeMap::from([("reviewed".into(), serde_json::Value::Bool(true))]),
            },
            body: String::new(),
        };
        fs::create_dir_all(owner.routines_dir()).unwrap();
        fs::write(
            owner.routines_dir().join("review-item.md"),
            parser::serialize_definition(&definition).unwrap(),
        )
        .unwrap();
        let row = parser::discover_owner(&owner).routines.remove(0);
        let snapshot = super::super::events::IndexedEntrySnapshot {
            repository_path: project.to_string_lossy().into_owned(),
            collection_path: "tasks".into(),
            entry_path: "tasks/item.md".into(),
            title: "Item".into(),
            fields: BTreeMap::from([("reviewed".into(), serde_json::Value::Bool(false))]),
            created: "2026-08-08T00:00:00Z".into(),
            updated: "2026-08-08T00:00:00Z".into(),
        };
        let payload = super::super::events::CollectionEventPayload {
            repository_path: snapshot.repository_path.clone(),
            collection_path: snapshot.collection_path.clone(),
            entry_path: snapshot.entry_path.clone(),
            event_type: CollectionEvent::FieldChanged.as_str().into(),
            property_key: Some("reviewed".into()),
            old_value: Some(serde_json::Value::Bool(false)),
            new_value: Some(serde_json::Value::Bool(true)),
            old_entry: Some(snapshot.clone()),
            new_entry: Some(snapshot),
            observed_at: "2026-08-08T00:00:01Z".into(),
            source_kind: "watcher".into(),
            origin: None,
            routine_run_id: None,
            lineage_depth: 0,
            execution_run_id: None,
        };
        let event = cache::QueuedRoutineEvent {
            queue_key: "queue".into(),
            event_key: "event".into(),
            owner_path: "tasks".into(),
            routine_id: row.routine_id,
            definition_fingerprint: row.fingerprint,
            payload_json: serde_json::to_string(&payload).unwrap(),
        };

        let Some(EventDispatchPreflight::UpdateProperties { mutation_paths }) =
            event_dispatch_preflight(&owner, &event).await
        else {
            panic!("expected update_properties preflight");
        };
        assert_eq!(
            mutation_paths,
            vec![collection.join("item.md").canonicalize().unwrap()]
        );
    }
}

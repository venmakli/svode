use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{SecondsFormat, Utc};
use tauri::{AppHandle, Manager};

use super::model::{
    CollectionEvent, ResolvedRoutineOwner, RoutineAction, RoutineDefinition,
    RoutineDispatchBlockedCode, RoutineDispatchResult, RoutineOwnerKind, RoutineTrigger,
};
use super::{cache, service};
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
use crate::index::IndexState;
use crate::terminal::{AgentTerminalSpawn, TerminalManager, quote_agent_shell_command};

#[derive(Debug, Clone)]
pub(super) enum DispatchKind {
    Manual,
    Scheduled,
    Event {
        payload: Box<super::events::CollectionEventPayload>,
        execution_run_id: String,
        definition_fingerprint: String,
    },
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn dispatch_explicit(
    app: &AppHandle,
    owner: ResolvedRoutineOwner,
    routine_id: String,
    expected_fingerprint: Option<String>,
    git_state: &GitState,
    access_state: &RepositoryAccessState,
    index_state: &IndexState,
    terminal_manager: &TerminalManager,
) -> Result<RoutineDispatchResult, AppError> {
    dispatch_routine(
        app,
        owner,
        routine_id,
        expected_fingerprint,
        DispatchKind::Manual,
        git_state,
        access_state,
        index_state,
        terminal_manager,
    )
    .await
}

pub(crate) async fn dispatch_event(
    app: &AppHandle,
    owner: ResolvedRoutineOwner,
    event: cache::QueuedRoutineEvent,
    execution_run_id: String,
) -> Result<RoutineDispatchResult, AppError> {
    let payload = serde_json::from_str(&event.payload_json)?;
    let git_state = app.state::<GitState>();
    let access_state = app.state::<RepositoryAccessState>();
    let index_state = app.state::<IndexState>();
    let terminal_manager = app.state::<TerminalManager>();
    dispatch_routine(
        app,
        owner,
        event.routine_id,
        None,
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
        row.routine_id.as_deref() == Some(event.routine_id.as_str())
            && row.execution_fingerprint == event.definition_fingerprint
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
) -> Result<RoutineDispatchResult, AppError> {
    let git_state = app.state::<GitState>();
    let access_state = app.state::<RepositoryAccessState>();
    let index_state = app.state::<IndexState>();
    let terminal_manager = app.state::<TerminalManager>();
    dispatch_routine(
        app,
        owner,
        routine_id,
        None,
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
pub(super) async fn dispatch_routine(
    app: &AppHandle,
    owner: ResolvedRoutineOwner,
    routine_id: String,
    expected_fingerprint: Option<String>,
    dispatch_kind: DispatchKind,
    git_state: &GitState,
    access_state: &RepositoryAccessState,
    index_state: &IndexState,
    terminal_manager: &TerminalManager,
) -> Result<RoutineDispatchResult, AppError> {
    let repository = service::mutation_repository(git_state, &owner).await?;
    let lock = git_state.get_lock(&repository).await;
    let _guard = lock.lock().await;
    let owner = service::revalidate_owner(git_state, &owner, &repository).await?;
    let snapshot = service::discover_owner(&owner).await?;
    let Some(row) = snapshot
        .routines
        .iter()
        .find(|row| row.routine_id.as_deref() == Some(routine_id.as_str()))
    else {
        return Ok(dispatch_blocked(
            routine_id,
            if expected_fingerprint.is_some() {
                RoutineDispatchBlockedCode::RoutineNotFound
            } else {
                RoutineDispatchBlockedCode::InvalidRoutine
            },
            "routine definition was not found for this owner",
        ));
    };
    if let Some(expected_fingerprint) = expected_fingerprint.as_deref()
        && expected_fingerprint != row.fingerprint
    {
        return Ok(RoutineDispatchResult::Blocked {
            routine_id,
            code: RoutineDispatchBlockedCode::FingerprintConflict,
            message: "routine definition changed after it was read".to_string(),
            current_fingerprint: Some(row.fingerprint.clone()),
        });
    }
    if let DispatchKind::Event {
        definition_fingerprint,
        ..
    } = &dispatch_kind
        && definition_fingerprint != &row.execution_fingerprint
    {
        return Ok(dispatch_blocked(
            routine_id,
            RoutineDispatchBlockedCode::InvalidRoutine,
            "queued event definition is stale",
        ));
    }
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

    let pool = index_state.get_or_create_routines(&owner.index_key).await?;
    let live_pty_ids = service::live_agent_pty_ids(terminal_manager)?;
    if let Some(run) = cache::latest_run(&pool, &owner.descriptor.owner_path, &routine_id).await?
        && run.blocks_relaunch(&live_pty_ids)
    {
        return Ok(RoutineDispatchResult::AlreadyRunning {
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
                Ok(RoutineDispatchResult::Completed)
            }
            Err(error) => Ok(RoutineDispatchResult::Failed {
                routine_id,
                routine_run_id: execution_run_id.clone(),
                launch_id: execution_run_id.clone(),
                agent_session_id: String::new(),
                source_session_id: None,
                pty_id: None,
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
            definition_fingerprint: &row.execution_fingerprint,
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
        title: Some(row.name.clone()),
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
            super::storage::database_path(&owner.space_path),
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
            return Ok(RoutineDispatchResult::Failed {
                routine_id,
                routine_run_id,
                launch_id,
                agent_session_id,
                source_session_id: launch.source_session_id,
                pty_id: None,
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
        return Ok(RoutineDispatchResult::Failed {
            routine_id,
            routine_run_id,
            launch_id,
            agent_session_id,
            source_session_id: launch.source_session_id,
            pty_id: Some(terminal.pty_id),
            message: format!("failed to persist managed PTY mapping: {error}"),
        });
    }
    super::emit_owner_invalidation(app, &owner);

    Ok(RoutineDispatchResult::Started {
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
) -> RoutineDispatchResult {
    RoutineDispatchResult::Blocked {
        routine_id,
        code,
        message: message.into(),
        current_fingerprint: None,
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

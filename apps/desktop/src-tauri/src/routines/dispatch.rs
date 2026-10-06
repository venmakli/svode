use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{SecondsFormat, Utc};
use sqlx::SqlitePool;
use tauri::{AppHandle, Manager};

use super::acp_launch::{AcpRun, AcpStartFailure, RoutineAcpLaunches};
use super::host::{self, RoutineGitTarget};
use super::{RoutineStoreState, lifecycle};
use crate::AppError;
use crate::agent_actors;
use crate::agent_actors::launch::{AgentLaunchResolution, AgentLaunchValidationCode};
use crate::agent_sessions::types::{AgentSessionResumeCommand, native_writer_key};
use crate::agent_setup::AgentSetupState;
use crate::git::GitState;
use crate::git::access::{RepositoryAccessState, require_repository_mutation_paths};
use crate::index::IndexState;
use crate::index::update::IndexUpdateState;
use crate::mcp::project_sessions::ProjectSessions;
use crate::process::path_env::ProcessPath;
use crate::terminal::{AgentTerminalSpawn, TerminalManager, quote_agent_shell_command};
use svode_agents::adapters::{ChatOffer, LaunchUnavailable};
use svode_agents::registry::{
    AdapterDiagnostic, AdapterRuntimeRegistry, AdapterTarget, AgentLaunchRequest, LaunchTransport,
    ManualRoutineLaunchInput, SystemRuntimeCommandRunner, TerminalChoice, TerminalReason,
};
use svode_agents::writer::{ExternalLiveness, UnknownLiveness, Writer};
use svode_core::agent_adapters::AgentAdapterKind;
use svode_core::collections::engine::EntryFieldBatchIntent;
use svode_core::page::fields::PageFieldUpdate;
use svode_core::page::nonce::WriteNonceRegistry;
use svode_core::page::write::PageRuntime;
use svode_core::routines::dispatch::{
    RoutineDispatchRequest, RoutineDispatchSelection, select_dispatch_candidate,
};
use svode_core::routines::model::{
    CollectionEvent, ResolvedRoutineOwner, RoutineAction, RoutineDefinition,
    RoutineDispatchBlockedCode, RoutineDispatchResult, RoutineOwnerKind, RoutineRunLaunch,
    RoutineTerminalChoice,
};
use svode_core::routines::operational::{
    self, NewRoutineRun, QueuedRoutineEvent, attach_pty, latest_run_record, record_terminal_outcome,
};
use svode_core::routines::service;

#[derive(Debug, Clone)]
pub(super) enum DispatchKind {
    Manual {
        expected_fingerprint: Option<String>,
    },
    Scheduled,
    Event {
        payload: Box<svode_core::routines::observation::CollectionEventPayload>,
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
    routine_stores: &RoutineStoreState,
    index_state: &IndexState,
    terminal_manager: &TerminalManager,
) -> Result<RoutineDispatchResult, AppError> {
    dispatch_routine(
        app,
        owner,
        routine_id,
        DispatchKind::Manual {
            expected_fingerprint,
        },
        git_state,
        access_state,
        routine_stores,
        index_state,
        terminal_manager,
    )
    .await
}

pub(crate) async fn dispatch_event(
    app: &AppHandle,
    owner: ResolvedRoutineOwner,
    event: QueuedRoutineEvent,
    execution_run_id: String,
) -> Result<RoutineDispatchResult, AppError> {
    let payload = serde_json::from_str(&event.payload_json)?;
    let git_state = app.state::<GitState>();
    let access_state = app.state::<RepositoryAccessState>();
    let routine_stores = app.state::<Arc<RoutineStoreState>>();
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
        &routine_stores,
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
    event: &QueuedRoutineEvent,
) -> Option<EventDispatchPreflight> {
    let Ok(snapshot) = service::discover_owner(owner).await else {
        return None;
    };
    let RoutineDispatchSelection::Ready(candidate) = select_dispatch_candidate(
        &snapshot,
        &RoutineDispatchRequest::Event {
            routine_id: &event.routine_id,
            definition_fingerprint: &event.definition_fingerprint,
        },
    ) else {
        return None;
    };
    let definition = &candidate.definition;
    match &definition.action {
        RoutineAction::RunAgent { .. } => scheduled_dispatch_ready(owner, definition)
            .await
            .then_some(EventDispatchPreflight::RunAgent),
        RoutineAction::UpdateProperties { set, .. } => {
            let Ok(payload) = serde_json::from_str::<
                svode_core::routines::observation::CollectionEventPayload,
            >(&event.payload_json) else {
                return None;
            };
            if payload.event_type == CollectionEvent::EntryDeleted.as_str()
                || payload.new_entry.is_none()
            {
                return None;
            }
            svode_core::collections::engine::entry_property_batch_mutation_paths_with_project(
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
    let routine_stores = app.state::<Arc<RoutineStoreState>>();
    let index_state = app.state::<IndexState>();
    let terminal_manager = app.state::<TerminalManager>();
    dispatch_routine(
        app,
        owner,
        routine_id,
        DispatchKind::Scheduled,
        &git_state,
        &access_state,
        &routine_stores,
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
    let registry = AdapterRuntimeRegistry;
    if !registry.has_terminal_launch(&request.binding.adapter, request.approval_mode) {
        // An agent without a terminal launch runs the Routine over ACP only.
        return registry
            .acp_launch_settings(&request.binding, request.approval_mode)
            .is_ok();
    }
    let Some(executable_path) = attempts
        .iter()
        .find(|attempt| attempt.binding_index == selected_binding_index)
        .and_then(|attempt| attempt.diagnostic.as_ref())
        .and_then(|diagnostic| diagnostic.executable_path.as_deref())
    else {
        return false;
    };
    registry
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
    dispatch_kind: DispatchKind,
    git_state: &GitState,
    access_state: &RepositoryAccessState,
    routine_stores: &RoutineStoreState,
    index_state: &IndexState,
    terminal_manager: &TerminalManager,
) -> Result<RoutineDispatchResult, AppError> {
    let repository = host::mutation_repository(git_state, &owner).await?;
    let lock = git_state.get_lock(&repository).await;
    let _guard = lock.lock().await;
    let owner =
        service::revalidate_owner(&RoutineGitTarget::new(git_state), &owner, &repository).await?;
    let snapshot = service::discover_owner(&owner).await?;
    let request = match &dispatch_kind {
        DispatchKind::Manual {
            expected_fingerprint,
        } => RoutineDispatchRequest::Manual {
            routine_id: &routine_id,
            expected_fingerprint: expected_fingerprint.as_deref(),
        },
        DispatchKind::Scheduled => RoutineDispatchRequest::Scheduled {
            routine_id: &routine_id,
        },
        DispatchKind::Event {
            definition_fingerprint,
            ..
        } => RoutineDispatchRequest::Event {
            routine_id: &routine_id,
            definition_fingerprint,
        },
    };
    let candidate = match select_dispatch_candidate(&snapshot, &request) {
        RoutineDispatchSelection::Ready(candidate) => *candidate,
        RoutineDispatchSelection::Blocked {
            code,
            message,
            current_fingerprint,
        } => {
            return Ok(RoutineDispatchResult::Blocked {
                routine_id,
                code,
                message,
                current_fingerprint,
            });
        }
    };
    let definition = candidate.definition;
    let executor = candidate.executor.as_deref();

    let pool = routine_stores
        .get_or_create(&owner.index_key, &owner.space_path)
        .await?;
    let live = super::runtime::live_evidence(terminal_manager, &app.state::<RoutineAcpLaunches>())?;
    if let Some(run) = latest_run_record(&pool, &owner.descriptor.owner_path, &routine_id).await?
        && run.blocks_relaunch(&live)
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

    let access_store_path = crate::git::access::access_store_path(app)?;
    if let Err(error) =
        host::authorize_mutation(git_state, access_state, &access_store_path, &repository).await
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
        let index_updates = app.state::<IndexUpdateState>();
        let nonces = app.state::<Arc<WriteNonceRegistry>>();
        let cli = crate::git::dates::detected_cli();
        // The shared index runtime holds no Spaces of a project no window has
        // open: its write publishes into the session that serves the project
        // without a window, as a write of Svode MCP does (Stage 10 `09`).
        let session = app
            .state::<ProjectSessions>()
            .get_or_create(&owner.project_path, &index_state.core)
            .await;
        let runtime = match &session {
            Some(session) => {
                session
                    .open_project(&owner.project_path)
                    .await
                    .map_err(|error| AppError::General(error.to_string()))?;
                PageRuntime {
                    index: session.index(),
                    updates: session.index_updates(),
                    nonces: session.nonces(),
                    git_dates: cli.as_ref(),
                }
            }
            None => PageRuntime {
                index: &index_state.core,
                updates: index_updates.core(),
                nonces: &nonces,
                git_dates: cli.as_ref(),
            },
        };
        let session = session.as_deref();
        let mutation = svode_core::page::fields::update(
            PageFieldUpdate {
                space: &space,
                path: &payload.entry_path,
                project: Some(&project),
                values: set,
                intent: EntryFieldBatchIntent::Routine,
            },
            runtime,
            |paths| async move {
                require_repository_mutation_paths(app, paths.clone()).await?;
                if let Some(session) = session
                    && let Err(error) = session.prepare_mutation(&paths).await
                {
                    tracing::warn!(
                        "the index a Routine write publishes into could not be prepared: {error}"
                    );
                }
                Ok::<_, AppError>(paths)
            },
        )
        .await;
        return match mutation {
            Ok(outcome) => {
                let joined = owner.space_path.join(&outcome.page.path);
                let canonical = std::fs::canonicalize(&joined).unwrap_or(joined);
                nonces.register_with_origin(
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
    let routine_run_id = match &dispatch_kind {
        DispatchKind::Event {
            execution_run_id, ..
        } => execution_run_id.clone(),
        _ => new_runtime_id(),
    };
    let launch_id = new_runtime_id();
    let input = ManualRoutineLaunchInput {
        instruction: definition.body.clone(),
        launch_id: launch_id.clone(),
        owner_kind: routine_owner_kind_name(owner.descriptor.kind).to_string(),
        owner_path: owner.descriptor.owner_path.clone(),
        event_context: match &dispatch_kind {
            DispatchKind::Event { payload, .. } => Some(serde_json::to_string(payload)?),
            _ => None,
        },
    };
    let run = RunContext {
        app,
        owner: &owner,
        pool: &pool,
        terminal_manager,
        routine_id: &routine_id,
        routine_run_id: &routine_run_id,
        launch_id: &launch_id,
        trigger_type: match &dispatch_kind {
            DispatchKind::Manual { .. } => "manual",
            DispatchKind::Scheduled => "schedule",
            DispatchKind::Event { .. } => "event",
        },
        fingerprint: &candidate.execution_fingerprint,
        definition_json: &serde_json::to_string(&definition)?,
        name: &candidate.name,
        created_at: now_rfc3339(),
        sink: Arc::new(lifecycle::RoutineRunLifecycleSink::with_invalidation(
            pool.clone(),
            routine_stores.core_handle(),
            owner.index_key.clone(),
            owner.space_path.clone(),
            routine_run_id.clone(),
            app.clone(),
            &owner,
        )),
    };
    let registry = AdapterRuntimeRegistry;
    let agent_setup = app.state::<AgentSetupState>();
    let acp_launches = app.state::<RoutineAcpLaunches>();
    let mut unavailable = None;
    let mut acp_failure = None;
    // The transport is a step of the pre-start policy for each binding it
    // allows, from its selection on; a binding the agent cannot run in
    // either transport passes to the next one without a downgrade.
    for attempt in attempts
        .iter()
        .filter(|attempt| attempt.eligible && attempt.binding_index >= selected_binding_index)
    {
        let Some(agent) = attempt.binding.adapter.builtin() else {
            continue;
        };
        let request = AgentLaunchRequest {
            binding: attempt.binding.clone(),
            ..request.clone()
        };
        let diagnostic = attempt.diagnostic.as_ref();
        let token = new_runtime_id();
        let (plan, offer) = agent_setup
            .launch_offer(
                agent,
                &owner.space_path,
                routine_mcp_env(app, &owner.project_path),
                diagnostic.and_then(|diagnostic| diagnostic.authenticated),
            )
            .await;
        let chat = chat_availability(&plan, offer);
        let choice = match registry.launch_transport(&request.binding, request.approval_mode, chat)
        {
            LaunchTransport::Acp { settings } => {
                let Ok(launch) = plan else {
                    unreachable!("the chat is available only with a launch plan")
                };
                let started = acp_launches
                    .start(AcpRun {
                        pool: &pool,
                        new_run: run.new_run(agent.id().as_str(), None, "", &RoutineRunLaunch::Acp),
                        source: agent.id(),
                        launch,
                        cwd: Path::new(&request.launch_space_path),
                        settings,
                        prompt: registry.acp_routine_prompt(&input),
                        token,
                        project_path: &owner.project_path,
                        sink: run.sink.clone(),
                    })
                    .await;
                match started {
                    Ok(result) => {
                        super::emit_owner_invalidation(app, &owner);
                        return Ok(result);
                    }
                    Err(AcpStartFailure::Failed(error)) => return Err(error),
                    Err(AcpStartFailure::BeforePrompt(detail)) => {
                        let choice =
                            TerminalChoice::new(TerminalReason::AcpFailedBeforePrompt, &detail);
                        if !registry
                            .has_terminal_launch(&request.binding.adapter, request.approval_mode)
                        {
                            acp_failure = Some(choice.detail);
                            continue;
                        }
                        choice
                    }
                }
            }
            LaunchTransport::Terminal(choice) => choice,
            LaunchTransport::Unavailable { detail } => {
                unavailable = Some(detail);
                continue;
            }
        };
        let executable_path = diagnostic
            .and_then(|diagnostic| diagnostic.executable_path.as_deref())
            .ok_or_else(|| {
                AppError::General("resolved Agent Actor binding has no executable path".into())
            })?;
        return start_terminal(&run, &request, Path::new(executable_path), &input, choice).await;
    }
    // Every binding failed before its first prompt or has no transport.
    match acp_failure {
        Some(message) => {
            let source = request.binding.adapter.clone();
            let agent_session_id = format!("{}:launch:{launch_id}", source.as_str());
            operational::create_run(
                &pool,
                run.new_run(
                    source.as_str(),
                    None,
                    &agent_session_id,
                    &RoutineRunLaunch::Acp,
                ),
            )
            .await?;
            record_terminal_outcome(
                &pool,
                &routine_run_id,
                svode_core::routines::model::RoutineRunTerminalStatus::Failed,
                None,
                &message,
                &now_rfc3339(),
            )
            .await?;
            super::emit_owner_invalidation(app, &owner);
            Ok(RoutineDispatchResult::Failed {
                routine_id,
                routine_run_id,
                launch_id,
                agent_session_id,
                source_session_id: None,
                pty_id: None,
                message,
            })
        }
        None => Ok(dispatch_blocked(
            routine_id,
            RoutineDispatchBlockedCode::UnavailableExecutor,
            unavailable.unwrap_or_else(|| "Agent Actor binding is unavailable".to_string()),
        )),
    }
}

/// One run of a Routine whose launch is decided.
struct RunContext<'a> {
    app: &'a AppHandle,
    owner: &'a ResolvedRoutineOwner,
    pool: &'a SqlitePool,
    terminal_manager: &'a TerminalManager,
    routine_id: &'a str,
    routine_run_id: &'a str,
    launch_id: &'a str,
    trigger_type: &'a str,
    fingerprint: &'a str,
    definition_json: &'a str,
    name: &'a str,
    created_at: String,
    sink: Arc<lifecycle::RoutineRunLifecycleSink>,
}

impl RunContext<'_> {
    fn new_run<'b>(
        &'b self,
        source: &'b str,
        source_session_id: Option<&'b str>,
        agent_session_id: &'b str,
        launch: &'b RoutineRunLaunch,
    ) -> NewRoutineRun<'b> {
        NewRoutineRun {
            routine_run_id: self.routine_run_id,
            routine_id: self.routine_id,
            owner_path: &self.owner.descriptor.owner_path,
            trigger_type: self.trigger_type,
            definition_fingerprint: self.fingerprint,
            definition_json: self.definition_json,
            launch_id: self.launch_id,
            source,
            source_session_id,
            agent_session_id,
            created_at: &self.created_at,
            launch,
        }
    }
}

/// The agent CLI of the binding in a managed terminal, with why the launch
/// is not over ACP.
async fn start_terminal(
    run: &RunContext<'_>,
    request: &AgentLaunchRequest,
    executable_path: &Path,
    input: &ManualRoutineLaunchInput,
    choice: TerminalChoice,
) -> Result<RoutineDispatchResult, AppError> {
    let (app, owner, pool) = (run.app, run.owner, run.pool);
    let terminal_manager = run.terminal_manager;
    let routine_id = run.routine_id.to_string();
    let routine_run_id = run.routine_run_id.to_string();
    let launch_id = run.launch_id.to_string();
    let launch =
        match AdapterRuntimeRegistry.build_manual_routine_launch(request, executable_path, input) {
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
    let source = launch.adapter.id();
    let source_session_id = launch
        .source_session_id
        .clone()
        .unwrap_or_else(|| format!("launch:{launch_id}"));
    let agent_session_id = format!("{}:{source_session_id}", source.as_str());
    let terminal_launch = RoutineRunLaunch::Terminal {
        reason: Some(match choice.reason {
            TerminalReason::ChatUnavailable => RoutineTerminalChoice::ChatUnavailable,
            TerminalReason::BindingNotAcp => RoutineTerminalChoice::BindingNotAcp,
            TerminalReason::AcpFailedBeforePrompt => RoutineTerminalChoice::AcpFailedBeforePrompt,
        }),
        detail: Some(choice.detail).filter(|detail| !detail.is_empty()),
    };

    operational::create_run(
        pool,
        run.new_run(
            source.as_str(),
            launch.source_session_id.as_deref(),
            &agent_session_id,
            &terminal_launch,
        ),
    )
    .await?;

    let command_display = quote_agent_shell_command(&launch.program, &launch.argv);
    let spawn = AgentTerminalSpawn {
        agent_session_id: agent_session_id.clone(),
        title: Some(run.name.to_string()),
        source: source.clone(),
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
        lifecycle_sink: Some(run.sink.clone()),
    };
    // A new launch: the pre-assigned session id or, until the source reports
    // it, the launch id holds the writer slot from before the agent starts.
    let writers = terminal_manager.writers();
    let claim = match launch.source_session_id.as_deref() {
        Some(session_id) => writers.claim(
            &native_writer_key(&launch.adapter.id(), session_id),
            Writer::Pty,
            ExternalLiveness::Free,
            UnknownLiveness::NotConfirmed,
        ),
        None => writers.claim_launch(&launch_id, Writer::Pty),
    }
    .map_err(|refusal| AppError::from(svode_agents::AgentRuntimeError::WriterRefused { refusal }));
    let spawned = claim
        .and_then(|claim| terminal_manager.spawn_agent_shell_session(app.clone(), spawn, claim));
    let terminal = match spawned {
        Ok(terminal) => terminal,
        Err(error) => {
            let message = format!("failed to start agent CLI: {error}");
            record_terminal_outcome(
                pool,
                &routine_run_id,
                svode_core::routines::model::RoutineRunTerminalStatus::Failed,
                None,
                &message,
                &now_rfc3339(),
            )
            .await?;
            super::emit_owner_invalidation(app, owner);
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
    if let Err(error) = attach_pty(pool, &routine_run_id, &terminal.pty_id, &now_rfc3339()).await {
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
    super::emit_owner_invalidation(app, owner);

    Ok(RoutineDispatchResult::Started {
        routine_id,
        routine_run_id,
        launch_id,
        agent_session_id,
        source_session_id: launch.source_session_id,
        pty_id: Some(terminal.pty_id),
    })
}

/// Whether the chat is available to the agent by the rule of a new session
/// (Stage 10 `04`), with why not.
fn chat_availability(
    plan: &Result<svode_agents::AcpLaunch, LaunchUnavailable>,
    offer: Option<ChatOffer>,
) -> Result<(), String> {
    match (offer, plan) {
        (Some(ChatOffer::Available | ChatOffer::SignInRequired), _) => Ok(()),
        (Some(ChatOffer::Unavailable { reason }), _) => Err(reason.to_string()),
        (None, Err(reason)) => Err(reason.to_string()),
        (None, Ok(_)) => Err("the agent's chat is deferred".into()),
    }
}

/// The Svode MCP context a Routine agent process gets, as in its terminal:
/// the Desktop discovery file and the Project; the ACP launch adds its
/// caller token.
fn routine_mcp_env(app: &AppHandle, project_path: &Path) -> BTreeMap<String, String> {
    let mut env = BTreeMap::from([(
        svode_mcp::MCP_PROJECT_PATH_ENV.to_string(),
        svode_core::system_path::user_facing_path(project_path),
    )]);
    if let Ok(discovery_path) = crate::mcp::ipc::discovery_path_for_app(app) {
        env.insert(
            svode_mcp::MCP_DISCOVERY_ENV.to_string(),
            svode_core::system_path::user_facing_path(&discovery_path),
        );
    }
    env
}

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
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
    let search_path = ProcessPath::session();
    let target = AdapterTarget {
        cwd: launch_space.to_path_buf(),
        search_path: search_path.get().await.map(ToOwned::to_owned),
    };
    // Every agent an Actor binding can use, checked concurrently.
    let mut checks = tokio::task::JoinSet::new();
    for descriptor in AdapterRuntimeRegistry.descriptors() {
        let target = target.clone();
        checks.spawn(async move {
            AdapterRuntimeRegistry
                .diagnose(descriptor.id, &target, &SystemRuntimeCommandRunner)
                .await
        });
    }
    let mut diagnostics = BTreeMap::new();
    while let Some(checked) = checks.join_next().await {
        // A check that did not finish leaves its agent unchecked.
        if let Ok(diagnostic) = checked {
            diagnostics.insert(diagnostic.adapter, diagnostic);
        }
    }
    diagnostics
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

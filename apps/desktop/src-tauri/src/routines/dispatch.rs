use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{SecondsFormat, Utc};
use tauri::{AppHandle, Manager};

use super::acp_launch::{AcpRun, AcpStartFailure, RoutineAcpLaunches};
use super::host::{self, RoutineGitTarget};
use super::{RoutineStoreState, lifecycle};
use crate::AppError;
use crate::agent_sessions::types::catalog_session_id;
use crate::agent_setup::AgentSetupState;
use crate::git::GitState;
use crate::git::access::{RepositoryAccessState, require_repository_mutation_paths};
use crate::index::IndexState;
use crate::index::update::IndexUpdateState;
use crate::navigation::{self, NavigationItem, NavigationKey, NavigationRoutine};
use crate::project_sessions::ProjectSessions;
use crate::terminal::TerminalManager;
use svode_agents::adapters::ChatOffer;
use svode_agents::registry::{AdapterRuntimeRegistry, ManualRoutineLaunchInput};
use svode_agents::{AcpLaunch, AgentRuntimeError, LaunchValues, SettingRefusal, SettingValue};
use svode_core::agent_actors::executor::{
    ExecutorResolution, ExecutorSource, ResolvedExecutor, resolve_executor,
};
use svode_core::agent_actors::{AgentSettingValue, inherited_root};
use svode_core::agent_adapters::AgentId;
use svode_core::collections::engine::EntryFieldBatchIntent;
use svode_core::page::fields::PageFieldUpdate;
use svode_core::page::nonce::WriteNonceRegistry;
use svode_core::page::write::PageRuntime;
use svode_core::routines::dispatch::{
    RoutineDispatchRequest, RoutineDispatchSelection, select_dispatch_candidate,
};
use svode_core::routines::model::{
    CollectionEvent, ResolvedRoutineOwner, RoutineAction, RoutineDefinition,
    RoutineDispatchBlockedCode, RoutineDispatchResult, RoutineLaunchRefusal,
    RoutineLaunchRefusalReason, RoutineOwnerKind, RoutineRunLaunch,
};
use svode_core::routines::operational::{
    self, NewRoutineRun, QueuedRoutineEvent, latest_run_record,
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
    setup: &AgentSetupState,
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
        RoutineAction::RunAgent { .. } => scheduled_dispatch_ready(setup, owner, definition)
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

/// Whether this device may claim an automatic launch of the Routine (Stage
/// 11 `03`, «Готовность до claim»): its Actor resolves, the agent is known,
/// enabled and ready here, and the participant's agent has a default agent.
/// A device that is not ready leaves the slot or event to another device;
/// values are checked only by the agent when the launch creates its session.
pub(crate) async fn scheduled_dispatch_ready(
    setup: &AgentSetupState,
    owner: &ResolvedRoutineOwner,
    definition: &RoutineDefinition,
) -> bool {
    let RoutineAction::RunAgent { executor } = &definition.action else {
        return false;
    };
    matches!(
        executor_readiness(setup, owner, Some(executor), BTreeMap::new()).await,
        Readiness::Ready(_)
    )
}

/// An executor ready to launch on this device: the agent and values the
/// resolver chose, with the agent's ACP launch plan.
struct ReadyExecutor {
    executor: ResolvedExecutor,
    launch: AcpLaunch,
}

enum Readiness {
    Ready(Box<ReadyExecutor>),
    Blocked {
        code: RoutineDispatchBlockedCode,
        message: String,
        refusal: Option<RoutineLaunchRefusal>,
    },
}

/// Resolves the Routine's executor with the device's default agent for the
/// participant's agent and checks the agent is ready by the rule of a new
/// session, its launch plan carrying `env`. Starts no agent process.
async fn executor_readiness(
    setup: &AgentSetupState,
    owner: &ResolvedRoutineOwner,
    executor: Option<&str>,
    env: BTreeMap<String, String>,
) -> Readiness {
    let default_agent = setup.default_agent().unwrap_or_else(|error| {
        tracing::warn!("the default agent of this device is unreadable: {error}");
        None
    });
    let resolution = resolve_executor(
        &owner.space_path,
        inherited_root(&owner.project_path, &owner.space_path),
        executor,
        default_agent.as_ref(),
    );
    let executor = match resolution {
        ExecutorResolution::Resolved(executor) => executor,
        unresolved => {
            let refusal = RoutineLaunchRefusal::from_resolution(&unresolved);
            let (code, message) = match &unresolved {
                ExecutorResolution::MissingExecutor => (
                    RoutineDispatchBlockedCode::MissingExecutor,
                    "routine has no Agent Actor executor".to_string(),
                ),
                ExecutorResolution::MissingActor { .. } => (
                    RoutineDispatchBlockedCode::MissingActorId,
                    "routine Agent Actor no longer exists".to_string(),
                ),
                ExecutorResolution::AmbiguousActor { .. } => (
                    RoutineDispatchBlockedCode::AmbiguousActorId,
                    "routine Agent Actor reference is ambiguous between owner catalogs".to_string(),
                ),
                _ => (
                    RoutineDispatchBlockedCode::UnavailableExecutor,
                    refusal
                        .as_ref()
                        .map(RoutineLaunchRefusal::message)
                        .unwrap_or_default(),
                ),
            };
            return Readiness::Blocked {
                code,
                message,
                refusal,
            };
        }
    };
    let (plan, offer) = setup
        .launch_offer(&executor.agent, &owner.space_path, env)
        .await;
    let not_ready = match (offer, plan) {
        (Some(ChatOffer::Available), Ok(launch)) => {
            return Readiness::Ready(Box::new(ReadyExecutor { executor, launch }));
        }
        (Some(ChatOffer::SignInRequired), _) => "the agent is not signed in".to_string(),
        (Some(ChatOffer::Unavailable { reason }), _) | (_, Err(reason)) => reason.to_string(),
        (None, Ok(_)) => "the agent is not offered on this device yet".to_string(),
    };
    let refusal = RoutineLaunchRefusal::new(
        RoutineLaunchRefusalReason::AgentNotReady,
        Some(executor.source),
        Some(executor.agent.as_str().into()),
    )
    .with_detail(&not_ready);
    Readiness::Blocked {
        code: RoutineDispatchBlockedCode::UnavailableExecutor,
        message: refusal.message(),
        refusal: Some(refusal),
    }
}

/// One dispatch of a Routine as a turn of its repository (Stage 11 1.E
/// «Рутины»): the groups close before it, and its changes until the run's
/// recorded outcome land as one version. A dispatch that does not start a
/// run ends its turn at once.
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
    let turn = crate::git::turns::routine_began(app, &repository).await;
    let result = dispatch_in_turn(
        app,
        owner,
        routine_id,
        dispatch_kind,
        git_state,
        access_state,
        routine_stores,
        index_state,
        terminal_manager,
        &turn,
    )
    .await;
    // A started run ends its turn with its recorded outcome.
    if !matches!(result, Ok(RoutineDispatchResult::Started { .. })) {
        crate::git::turns::end_later(app, turn);
    }
    result
}

#[allow(clippy::too_many_arguments)]
async fn dispatch_in_turn(
    app: &AppHandle,
    owner: ResolvedRoutineOwner,
    routine_id: String,
    dispatch_kind: DispatchKind,
    git_state: &GitState,
    access_state: &RepositoryAccessState,
    routine_stores: &RoutineStoreState,
    index_state: &IndexState,
    terminal_manager: &TerminalManager,
    turn: &str,
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
                refusal: None,
            });
        }
    };
    let definition = candidate.definition;
    let executor = candidate.executor.as_deref();

    let pool = routine_stores
        .get_or_create(&owner.index_key, &owner.space_path)
        .await?;
    let live = app.state::<RoutineAcpLaunches>().live_evidence();
    if let Some(run) = latest_run_record(&pool, &owner.descriptor.owner_path, &routine_id).await?
        && run.blocks_relaunch(&live)
    {
        return Ok(RoutineDispatchResult::AlreadyRunning {
            routine_id,
            routine_run_id: run.routine_run_id,
            launch_id: run.launch_id,
            agent_session_id: run.agent_session_id,
            source_session_id: run.source_session_id,
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
                message: error.to_string(),
                refusal: None,
            }),
        };
    }

    let setup = app.state::<AgentSetupState>();
    let ready = match executor_readiness(
        &setup,
        &owner,
        executor,
        routine_mcp_env(app, &owner.project_path),
    )
    .await
    {
        Readiness::Ready(ready) => *ready,
        Readiness::Blocked {
            code,
            message,
            refusal,
        } => {
            return Ok(RoutineDispatchResult::Blocked {
                routine_id,
                code,
                message,
                current_fingerprint: None,
                refusal,
            });
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
            turn.to_owned(),
        )),
    };
    // Only ACP: a refusal before the first prompt starts no other agent and
    // no terminal (Stage 11 `03`, «Запуск Рутины»).
    let ReadyExecutor { executor, launch } = ready;
    let source = executor.agent.clone();
    let started = app
        .state::<RoutineAcpLaunches>()
        .start(AcpRun {
            pool: &pool,
            new_run: run.new_run(source.as_str(), None, "", &RoutineRunLaunch::Acp),
            source: source.clone(),
            launch,
            cwd: Path::new(&executor.launch_space_path),
            values: LaunchValues {
                portable: setting_values(&executor.portable_settings),
                device: setting_values(&executor.device_settings),
            },
            prompt: AdapterRuntimeRegistry.acp_routine_prompt(&input),
            token: new_runtime_id(),
            project_path: &owner.project_path,
            sink: run.sink.clone(),
        })
        .await;
    let refused = match started {
        Ok(result) => {
            if let RoutineDispatchResult::Started {
                agent_session_id,
                source_session_id,
                ..
            }
            | RoutineDispatchResult::Failed {
                agent_session_id,
                source_session_id,
                ..
            } = &result
            {
                run.keep_session(agent_session_id, source_session_id.as_deref());
            }
            super::emit_owner_invalidation(app, &owner);
            return Ok(result);
        }
        Err(AcpStartFailure::Failed(error)) => return Err(error),
        Err(AcpStartFailure::Refused(refused)) => refused,
    };
    // The refused launch is a failed run with its reason, for its last run
    // and the manual run. An empty session the agent keeps in its list is
    // the session of the run.
    let refusal = launch_refusal(&refused.error, executor.source, &source);
    let (source_session_id, agent_session_id) = match &refused.left {
        Some(key) => (
            Some(key.session_id.clone()),
            catalog_session_id(&source, key),
        ),
        None => (None, format!("{}:launch:{launch_id}", source.as_str())),
    };
    operational::create_run(
        &pool,
        run.new_run(
            source.as_str(),
            source_session_id.as_deref(),
            &agent_session_id,
            &RoutineRunLaunch::Acp,
        ),
    )
    .await?;
    operational::record_launch_refusal(&pool, &routine_run_id, &refusal, &now_rfc3339()).await?;
    if source_session_id.is_some() {
        run.keep_session(&agent_session_id, source_session_id.as_deref());
    }
    super::emit_owner_invalidation(app, &owner);
    Ok(RoutineDispatchResult::Failed {
        routine_id,
        routine_run_id,
        launch_id,
        agent_session_id,
        source_session_id,
        message: refusal.message(),
        refusal: Some(refusal),
    })
}

fn setting_values(values: &[AgentSettingValue]) -> Vec<SettingValue> {
    values
        .iter()
        .map(|value| SettingValue {
            setting: value.setting.clone(),
            value: value.value.clone(),
        })
        .collect()
}

/// The reason of a launch the agent or its connection refused before the
/// first prompt, fixed where the refused value was chosen.
fn launch_refusal(
    error: &AgentRuntimeError,
    source: ExecutorSource,
    agent: &AgentId,
) -> RoutineLaunchRefusal {
    use RoutineLaunchRefusalReason as Reason;
    let refusal =
        |reason| RoutineLaunchRefusal::new(reason, Some(source), Some(agent.as_str().into()));
    match error {
        AgentRuntimeError::SettingRefused {
            setting,
            value,
            reason,
        } => {
            let refused = match reason {
                SettingRefusal::NotDeclared => refusal(Reason::SettingNotDeclared),
                SettingRefusal::ModeFromCatalog => refusal(Reason::SettingIsMode),
                SettingRefusal::Agent { message } => {
                    refusal(Reason::SettingRefused).with_detail(message)
                }
                SettingRefusal::BeforeFirstPrompt => {
                    refusal(Reason::SettingRefused).with_detail(&reason.to_string())
                }
            };
            refused.with_value(setting, value)
        }
        AgentRuntimeError::AuthRequired { message } => {
            refusal(Reason::AgentNotReady).with_detail(message)
        }
        other => refusal(Reason::ConnectionFailed).with_detail(&other.to_string()),
    }
}

/// One run of a Routine whose launch is decided.
struct RunContext<'a> {
    app: &'a AppHandle,
    owner: &'a ResolvedRoutineOwner,
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
    /// Keeps the session of this run in Now of its Project, in the row of
    /// the Routine's previous launch (DF-210 R3, R4). The previous launch is
    /// not running, or this one would not start; its session still works
    /// while a Svode terminal shows it.
    fn keep_session(&self, agent_session_id: &str, source_session_id: Option<&str>) {
        let (item, routine) = launched_session(
            self.owner,
            self.routine_id,
            self.launch_id,
            self.name,
            agent_session_id,
            source_session_id,
        );
        let live = self
            .terminal_manager
            .list_agent_surfaces()
            .unwrap_or_default()
            .into_iter()
            .filter(|surface| surface.live)
            .collect::<Vec<_>>();
        navigation::routine_launched(self.app, &self.owner.project_path, item, routine, |key| {
            live.iter().any(|surface| match key {
                NavigationKey::Session { session_id } => &surface.agent_session_id == session_id,
                _ => false,
            })
        });
    }

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

/// The Now item of the session a launch of the Routine recorded, keyed by its
/// catalog id or, until the source reports one, by the launch id, and the
/// Routine it remembers (DF-210 R3).
fn launched_session(
    owner: &ResolvedRoutineOwner,
    routine_id: &str,
    launch_id: &str,
    name: &str,
    agent_session_id: &str,
    source_session_id: Option<&str>,
) -> (NavigationItem, NavigationRoutine) {
    let key = match source_session_id {
        Some(_) => NavigationKey::Session {
            session_id: agent_session_id.to_string(),
        },
        None => NavigationKey::SessionLaunch {
            launch_id: launch_id.to_string(),
        },
    };
    let item = NavigationItem {
        key,
        title: name.to_string(),
        icon: None,
        routine: None,
    };
    let routine = NavigationRoutine {
        space_id: (owner.project_path != owner.space_path)
            .then(|| owner.descriptor.space_id.clone()),
        owner_kind: owner.descriptor.kind,
        owner_path: owner.descriptor.owner_path.clone(),
        routine_id: routine_id.to_string(),
    };
    (item, routine)
}

/// The Svode MCP context a Routine agent process gets: the Desktop
/// discovery file and the Project; the ACP launch adds its caller token.
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
        refusal: None,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_actors::{CatalogMutation, mutate_catalog};
    use svode_core::agent_actors::{ActorBinding, AgentActor, read_catalog};
    use svode_core::default_agent::DefaultAgent;
    use svode_core::routines::model::{RoutineLaunchRecovery, RoutineOwnerInputKind};

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    const ACTOR: &str = "01arz3ndektsv4rrffq69g5fav";

    /// A Project whose catalog has one Actor bound to the participant's
    /// agent, with a device setup of its own.
    fn participant_project() -> (tempfile::TempDir, ResolvedRoutineOwner, AgentSetupState) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        write(&root.join(".svode/config.json"), r#"{"name":"Project"}"#);
        let root = root.canonicalize().unwrap();
        let (_, fingerprint) = read_catalog(&root).unwrap();
        mutate_catalog(
            &root,
            &fingerprint,
            CatalogMutation::Create(AgentActor {
                id: ACTOR.into(),
                name: "My tasks".into(),
                description: None,
                binding: ActorBinding::Participant,
            }),
        )
        .unwrap();
        let owner = service::resolve_owner(
            &root,
            &root,
            "root",
            ".",
            RoutineOwnerInputKind::RegisteredSpace,
        )
        .unwrap();
        let setup = AgentSetupState::new(&temp.path().join("data"), temp.path().join("config"));
        (temp, owner, setup)
    }

    fn blocked(readiness: Readiness) -> (RoutineDispatchBlockedCode, RoutineLaunchRefusal) {
        match readiness {
            Readiness::Blocked {
                code,
                refusal: Some(refusal),
                ..
            } => (code, refusal),
            Readiness::Blocked { refusal: None, .. } => panic!("blocked without a refusal"),
            Readiness::Ready(_) => panic!("the executor is ready"),
        }
    }

    /// The participant's agent claims no automatic launch and refuses a
    /// manual one without a default agent, and with one that cannot start
    /// on this device; no other agent is tried (Stage 11 `03`).
    #[tokio::test]
    async fn the_participants_agent_without_a_ready_default_agent_is_not_ready() {
        let (_temp, owner, setup) = participant_project();
        let executor = format!("agent:{ACTOR}");
        let definition = RoutineDefinition {
            name: None,
            description: None,
            enabled: None,
            trigger: svode_core::routines::model::RoutineTrigger::Manual,
            action: RoutineAction::RunAgent {
                executor: executor.clone(),
            },
            body: "Review".into(),
        };

        assert!(!scheduled_dispatch_ready(&setup, &owner, &definition).await);
        let (code, refusal) =
            blocked(executor_readiness(&setup, &owner, Some(&executor), BTreeMap::new()).await);
        assert_eq!(code, RoutineDispatchBlockedCode::UnavailableExecutor);
        assert_eq!(
            refusal.reason,
            RoutineLaunchRefusalReason::DefaultAgentNotSet
        );
        assert_eq!(refusal.recovery, RoutineLaunchRecovery::AgentSettings);

        setup
            .set_default_agent(Some(&DefaultAgent {
                agent: AgentId::parse("custom-removed").unwrap(),
                settings: Vec::new(),
            }))
            .unwrap();
        assert!(!scheduled_dispatch_ready(&setup, &owner, &definition).await);
        let (_, refusal) =
            blocked(executor_readiness(&setup, &owner, Some(&executor), BTreeMap::new()).await);
        assert_eq!(refusal.reason, RoutineLaunchRefusalReason::AgentNotReady);
        assert_eq!(refusal.agent.as_deref(), Some("custom-removed"));
        assert_eq!(refusal.recovery, RoutineLaunchRecovery::AgentSettings);
    }

    #[test]
    fn a_refused_launch_names_the_value_and_where_it_is_fixed() {
        let codex = AgentId::parse("codex").unwrap();
        let refused = |reason| AgentRuntimeError::SettingRefused {
            setting: "model".into(),
            value: "gpt-5.6".into(),
            reason,
        };
        let stale = launch_refusal(
            &refused(SettingRefusal::NotDeclared),
            ExecutorSource::Binding,
            &codex,
        );
        assert_eq!(stale.reason, RoutineLaunchRefusalReason::SettingNotDeclared);
        assert_eq!(stale.recovery, RoutineLaunchRecovery::ActorEditor);
        assert_eq!(
            (stale.setting.as_deref(), stale.value.as_deref()),
            (Some("model"), Some("gpt-5.6"))
        );
        // The same value of the default agent is fixed in the agent settings.
        assert_eq!(
            launch_refusal(
                &refused(SettingRefusal::NotDeclared),
                ExecutorSource::DefaultAgent,
                &codex,
            )
            .recovery,
            RoutineLaunchRecovery::AgentSettings
        );
        assert_eq!(
            launch_refusal(
                &refused(SettingRefusal::ModeFromCatalog),
                ExecutorSource::Binding,
                &codex,
            )
            .reason,
            RoutineLaunchRefusalReason::SettingIsMode
        );
        let failed = launch_refusal(
            &AgentRuntimeError::Spawn {
                message: "not found".into(),
            },
            ExecutorSource::Binding,
            &codex,
        );
        assert_eq!(failed.reason, RoutineLaunchRefusalReason::ConnectionFailed);
        assert_eq!(failed.recovery, RoutineLaunchRecovery::AgentSettings);
        assert_eq!(failed.setting, None);
    }

    /// A launch keeps its session in the navigation state of the Project
    /// itself, with no window involved (DF-210 R3).
    #[test]
    fn a_launch_keeps_its_session_in_now_of_its_project() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        write(
            &root.join(".svode/config.json"),
            r#"{"name":"Project","spaces":[{"id":"child-id","path":"child"}]}"#,
        );
        write(
            &root.join("child/.svode/config.json"),
            r#"{"name":"Child"}"#,
        );
        let project_owner = service::resolve_owner(
            &root,
            &root,
            "root",
            ".",
            RoutineOwnerInputKind::RegisteredSpace,
        )
        .unwrap();
        let space_owner = service::resolve_owner(
            &root,
            &root.join("child"),
            "child-id",
            ".",
            RoutineOwnerInputKind::RegisteredSpace,
        )
        .unwrap();

        // A terminal launch the source has not named yet is kept by its launch.
        let (item, routine) = launched_session(
            &project_owner,
            "daily",
            "launch-1",
            "Daily",
            "codex:launch:launch-1",
            None,
        );
        assert_eq!(
            item.key,
            NavigationKey::SessionLaunch {
                launch_id: "launch-1".into()
            }
        );
        assert_eq!(item.title, "Daily");
        assert_eq!(routine.space_id, None);
        navigation::keep_launched(&root, item, routine, |_| false).unwrap();

        // A named session, such as an ACP launch, by its catalog id.
        let (item, routine) = launched_session(
            &space_owner,
            "daily",
            "launch-2",
            "Daily",
            "claude:s2",
            Some("s2"),
        );
        assert_eq!(
            item.key,
            NavigationKey::Session {
                session_id: "claude:s2".into()
            }
        );
        assert_eq!(routine.space_id.as_deref(), Some("child-id"));
        assert_eq!(routine.owner_kind, RoutineOwnerKind::Space);
        navigation::keep_launched(&root, item, routine, |_| false).unwrap();

        // The same Routine id of another owner has a row of its own.
        let kept = navigation::read_state(&root).kept;
        assert_eq!(kept.len(), 2);
        assert!(kept.iter().all(|kept| kept.item.routine.is_some()));
    }
}

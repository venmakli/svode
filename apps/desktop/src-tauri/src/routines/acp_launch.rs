//! Routine launches over ACP (Stage 10 `02` "Routine launch through ACP"):
//! the dispatch owner starts the session on a connection of the launch's
//! own provenance, records its run, follows its status into the run through
//! the Routine lifecycle sink and answers the Routine caller check for the
//! launch while its connection lives. Driving the agent belongs to
//! `svode_agents`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use chrono::{SecondsFormat, Utc};
use sqlx::SqlitePool;
use svode_agents::activity::{Change, ConnectionState};
use svode_agents::identity::SessionKey;
use svode_agents::prompt::PromptPart;
use svode_agents::status::{SessionState, StopReason};
use svode_agents::writer::Writer;
use svode_agents::{AcpLaunch, AgentRuntime, ConnectionId, ConnectionLease, SettingValue};
use svode_core::agent_adapters::AgentId;
use svode_core::routines::model::{RoutineDispatchResult, RoutineRunLaunch};
use svode_core::routines::operational::{self, NewRoutineRun};
use tokio::sync::broadcast::error::RecvError;

use super::lifecycle::RoutineRunLifecycleSink;
use crate::AppError;
use crate::agent_sessions::types::catalog_session_id;
use crate::terminal::{AgentTerminalLifecycleSink, AgentTerminalOutcomeEvidence};

/// The live ACP launches of Routines in this process, by run id.
pub(crate) struct RoutineAcpLaunches {
    runtime: AgentRuntime,
    live: Mutex<HashMap<String, LiveLaunch>>,
}

struct LiveLaunch {
    launch_id: String,
    token: String,
    /// Canonical Project path the launch's caller token belongs to.
    project_path: PathBuf,
    session: SessionKey,
    connection: ConnectionId,
    sink: Arc<RoutineRunLifecycleSink>,
    /// Set once the run's outcome is recorded.
    finished: Arc<AtomicBool>,
}

/// One run of a Routine about to start over ACP.
pub(super) struct AcpRun<'a> {
    pub pool: &'a SqlitePool,
    pub new_run: NewRoutineRun<'a>,
    pub source: AgentId,
    pub launch: AcpLaunch,
    pub cwd: &'a Path,
    pub settings: Vec<SettingValue>,
    pub prompt: String,
    /// The opaque Routine caller token, added to the agent's environment.
    pub token: String,
    pub project_path: &'a Path,
    pub sink: Arc<RoutineRunLifecycleSink>,
}

/// How an ACP start ended short of a started run.
pub(super) enum AcpStartFailure {
    /// The connection, the session or a setting failed before the first
    /// prompt: no run was recorded and the writer is free again.
    BeforePrompt(String),
    Failed(AppError),
}

impl RoutineAcpLaunches {
    pub(crate) fn new(runtime: AgentRuntime) -> Self {
        Self {
            runtime,
            live: Mutex::default(),
        }
    }

    /// Runs whose ACP session holds its writer.
    pub(crate) fn live_run_ids(&self) -> HashSet<String> {
        let writers = self.runtime.writers();
        let mut live = self.live.lock().unwrap();
        live.retain(|_, launch| self.connection_open(launch.connection));
        live.iter()
            .filter(|(_, launch)| writers.writer(&launch.session) == Some(Writer::Acp))
            .map(|(run, _)| run.clone())
            .collect()
    }

    /// The Routine caller of `token` in the Project `frozen_project_path`:
    /// a live ACP launch of that Project, whose connection is still open.
    pub(crate) fn resolve_caller(
        &self,
        token: &str,
        frozen_project_path: &Path,
    ) -> Option<svode_tools::host::RoutineCaller> {
        let frozen = std::fs::canonicalize(frozen_project_path).ok()?;
        let mut live = self.live.lock().unwrap();
        live.retain(|_, launch| self.connection_open(launch.connection));
        live.iter()
            .find(|(_, launch)| launch.token == token && launch.project_path == frozen)
            .map(
                |(routine_run_id, launch)| svode_tools::host::RoutineCaller::Launch {
                    routine_run_id: routine_run_id.clone(),
                    launch_id: launch.launch_id.clone(),
                    pty_id: None,
                },
            )
    }

    fn connection_open(&self, connection: ConnectionId) -> bool {
        self.runtime
            .connection_status(connection)
            .is_some_and(|status| status.state != ConnectionState::Closed)
    }

    /// Starts the run's session: claims the ACP writer by launch id before
    /// the agent starts, creates the session with the settings applied
    /// before the first prompt, records the run with the canonical id and
    /// sends the instruction as the first prompt. A failure before the
    /// prompt leaves no run and no writer behind.
    pub(super) async fn start(
        &self,
        run: AcpRun<'_>,
    ) -> Result<RoutineDispatchResult, AcpStartFailure> {
        let before_prompt =
            |error: &dyn std::fmt::Display| AcpStartFailure::BeforePrompt(error.to_string());
        let claim = self
            .runtime
            .writers()
            .claim_launch(run.new_run.launch_id, Writer::Acp)
            .map_err(|refusal| {
                before_prompt(&svode_agents::AgentRuntimeError::WriterRefused { refusal })
            })?;
        // The token is the launch's own provenance: no connection of
        // another origin shares the process that carries it.
        let mut launch = run.launch;
        launch.env.insert(
            svode_mcp::MCP_ROUTINE_CALLER_TOKEN_ENV.to_string(),
            run.token.clone(),
        );
        // Held while the launch's turn runs.
        let lease = self
            .runtime
            .acquire(launch)
            .await
            .map_err(|error| before_prompt(&error))?;
        let session = self
            .runtime
            .new_launch_session(lease.connection(), run.cwd, &run.settings, claim)
            .await
            .map_err(|error| before_prompt(&error))?;
        let source_session_id = session.session_id.clone();
        let agent_session_id = catalog_session_id(&run.source, &session);
        let recorded = operational::create_run(
            run.pool,
            NewRoutineRun {
                source_session_id: Some(&source_session_id),
                agent_session_id: &agent_session_id,
                launch: &RoutineRunLaunch::Acp,
                ..run.new_run
            },
        )
        .await;
        let ids = |message: String| RoutineDispatchResult::Failed {
            routine_id: run.new_run.routine_id.to_string(),
            routine_run_id: run.new_run.routine_run_id.to_string(),
            launch_id: run.new_run.launch_id.to_string(),
            agent_session_id: agent_session_id.clone(),
            source_session_id: Some(source_session_id.clone()),
            pty_id: None,
            message,
        };
        if let Err(error) = recorded {
            let _ = self.runtime.release_session(&session).await;
            return Err(AcpStartFailure::Failed(error.into()));
        }
        let finished = Arc::new(AtomicBool::new(false));
        let routine_run_id = run.new_run.routine_run_id.to_string();
        // Registered before the prompt, so the agent's first Svode call
        // already finds its launch.
        self.live.lock().unwrap().insert(
            routine_run_id.clone(),
            LiveLaunch {
                launch_id: run.new_run.launch_id.to_string(),
                token: run.token,
                project_path: std::fs::canonicalize(run.project_path)
                    .unwrap_or_else(|_| run.project_path.to_path_buf()),
                session: session.clone(),
                connection: lease.connection(),
                sink: run.sink.clone(),
                finished: finished.clone(),
            },
        );
        if let Err(error) = self
            .runtime
            .prompt(&session, &[PromptPart::text(run.prompt)])
        {
            // Nothing reached the agent, but the run is recorded: it fails
            // rather than starting a second launch.
            self.live.lock().unwrap().remove(&routine_run_id);
            let _ = self.runtime.release_session(&session).await;
            let message = format!("the first prompt was not accepted: {error}");
            record_outcome(
                run.sink,
                SessionState::Idle {
                    stop_reason: Some(StopReason::Error),
                },
                message.clone(),
            )
            .await;
            return Ok(ids(message));
        }
        tauri::async_runtime::spawn(follow_run(
            self.runtime.clone(),
            session,
            lease,
            run.sink,
            source_session_id.clone(),
            agent_session_id.clone(),
            finished,
        ));
        Ok(RoutineDispatchResult::Started {
            routine_id: run.new_run.routine_id.to_string(),
            routine_run_id,
            launch_id: run.new_run.launch_id.to_string(),
            agent_session_id,
            source_session_id: Some(source_session_id),
            pty_id: None,
        })
    }

    /// At app exit, after the runtime stopped its connections: the runs
    /// whose outcome is not recorded yet are interrupted.
    pub(crate) fn record_exit(&self) {
        let live: Vec<_> = self
            .live
            .lock()
            .unwrap()
            .drain()
            .map(|(_, launch)| launch)
            .collect();
        for launch in live {
            if launch.finished.load(Ordering::SeqCst) {
                continue;
            }
            if let Err(error) = launch.sink.record_terminal_outcome(&outcome_evidence(
                SessionState::Idle {
                    stop_reason: Some(StopReason::Interrupted),
                },
                "the app exited during the turn".into(),
            )) {
                tracing::warn!("routine run outcome was not recorded at exit: {error}");
            }
        }
    }
}

/// Follows the launch's turn into its run: each status change is
/// reconciled, the end of the turn is the run's outcome. The lease keeps
/// the connection for the turn only.
async fn follow_run(
    runtime: AgentRuntime,
    session: SessionKey,
    lease: ConnectionLease,
    sink: Arc<RoutineRunLifecycleSink>,
    source_session_id: String,
    agent_session_id: String,
    finished: Arc<AtomicBool>,
) {
    let _lease = lease;
    let mut recorded = None;
    loop {
        let Ok(subscription) = runtime.watch(&session) else {
            break;
        };
        let mut state = subscription.snapshot.turn.status.state;
        let mut deltas = subscription.deltas;
        loop {
            if recorded != Some(state) {
                recorded = Some(state);
                if !state.in_turn() {
                    finished.store(true, Ordering::SeqCst);
                    record_outcome(sink, state, turn_reason(state)).await;
                    return;
                }
                let sink = sink.clone();
                let (source, agent) = (source_session_id.clone(), agent_session_id.clone());
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    if let Err(error) =
                        sink.reconcile_agent_session(&source, &agent, state, &now_rfc3339())
                    {
                        tracing::warn!("routine run status was not recorded: {error}");
                    }
                })
                .await;
            }
            match deltas.recv().await {
                Ok(delta) => {
                    if let Change::Turn(turn) = delta.change {
                        state = turn.status.state;
                    }
                }
                // Read the current state again.
                Err(RecvError::Lagged(_)) => break,
                Err(RecvError::Closed) => {
                    finished.store(true, Ordering::SeqCst);
                    let state = SessionState::Idle {
                        stop_reason: Some(StopReason::Interrupted),
                    };
                    record_outcome(sink, state, turn_reason(state)).await;
                    return;
                }
            }
        }
    }
    // The runtime no longer holds the session: its turn ended without an
    // outcome the run saw.
    finished.store(true, Ordering::SeqCst);
    let state = SessionState::Idle {
        stop_reason: Some(StopReason::Interrupted),
    };
    record_outcome(sink, state, turn_reason(state)).await;
}

async fn record_outcome(sink: Arc<RoutineRunLifecycleSink>, state: SessionState, reason: String) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = sink.record_terminal_outcome(&outcome_evidence(state, reason)) {
            tracing::warn!("routine run outcome was not recorded: {error}");
        }
    })
    .await;
}

fn outcome_evidence(state: SessionState, reason: String) -> AgentTerminalOutcomeEvidence {
    AgentTerminalOutcomeEvidence {
        state,
        exit_code: None,
        reason,
        observed_at: now_rfc3339(),
    }
}

fn turn_reason(state: SessionState) -> String {
    match state {
        SessionState::Idle {
            stop_reason: Some(reason),
        } => format!(
            "ACP turn ended: {}",
            serde_json::to_value(reason)
                .ok()
                .and_then(|value| value.as_str().map(str::to_string))
                .unwrap_or_default()
        ),
        _ => "ACP turn ended without a stop reason".into(),
    }
}

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

#[cfg(test)]
#[path = "acp_launch_tests.rs"]
mod tests;

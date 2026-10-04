use chrono::{SecondsFormat, Utc};

use super::native_status::{NativeLogRead, NativeStatusEvidence, short_id};
use super::types::{
    AgentSession, AgentSessionCapabilities, AgentSessionResumeCommand, AgentSessionRuntime,
    AgentSessionScope, AgentSessionTitleSource, catalog_session_id, terminal_resume_argv,
};
use crate::terminal::{AgentTerminalStatusEvidence, AgentTerminalSurface};
use svode_agents::catalog::{ListedSession, RuntimeSession};
use svode_agents::identity::IdentityNamespace;
use svode_agents::status::{SessionState, SessionStatus, StatusConfidence, StatusSource};
use svode_agents::writer::ExternalLiveness;
use svode_core::agent_adapters::AgentId;

pub(super) const SOURCE_LOG_ACTIVE_STALE_AFTER_SECS: i64 = 6 * 60 * 60;

/// What Svode knows about an agent process outside it writing to the
/// session. Only fresh native evidence of a turn counts; there is no process
/// scan, so everything else is unknown, never free.
pub(super) fn external_liveness(session: &AgentSession) -> ExternalLiveness {
    if session.status.source == StatusSource::NativeStatusReader && session.status.state.in_turn() {
        ExternalLiveness::ExternalActive
    } else {
        ExternalLiveness::Unknown
    }
}

/// One piece of status evidence with the moment it was observed.
struct Observation {
    status: SessionStatus,
    reason: String,
    /// RFC 3339 UTC with second precision, so strings order by time.
    observed_at: String,
    waiting_since: Option<String>,
}

/// The session status from its evidence (Stage 10 `02` C10): exact evidence
/// outranks approximate, within one confidence the latest observation wins,
/// and different states observed at that same moment give `unknown` with a
/// diagnostic. No evidence is `unknown`.
fn resolve_status(observations: Vec<Observation>) -> (SessionStatus, String, Option<String>) {
    let Some(confidence) = observations
        .iter()
        .map(|observation| observation.status.confidence)
        .max_by_key(|confidence| *confidence == StatusConfidence::Exact)
    else {
        return (
            SessionStatus::unknown(),
            "no status evidence".to_string(),
            None,
        );
    };
    let ranked = observations
        .into_iter()
        .filter(|observation| observation.status.confidence == confidence)
        .collect::<Vec<_>>();
    let latest = ranked
        .iter()
        .map(|observation| observation.observed_at.as_str())
        .max()
        .expect("ranked evidence")
        .to_string();
    let mut current = ranked
        .into_iter()
        .filter(|observation| observation.observed_at == latest)
        .collect::<Vec<_>>();
    let first = current.remove(0);
    if current
        .iter()
        .any(|observation| observation.status.state != first.status.state)
    {
        let source = if current
            .iter()
            .all(|observation| observation.status.source == first.status.source)
        {
            first.status.source
        } else {
            StatusSource::None
        };
        return (
            SessionStatus {
                state: SessionState::Unknown,
                source,
                confidence: StatusConfidence::Approximate,
            },
            "conflicting status evidence".to_string(),
            None,
        );
    }
    (first.status, first.reason, first.waiting_since)
}

fn native_observation(
    evidence: NativeStatusEvidence,
    last_activity_at: chrono::DateTime<Utc>,
    now: chrono::DateTime<Utc>,
) -> Observation {
    let observed_at = evidence.observed_at.unwrap_or(last_activity_at);
    let stale = evidence.state.in_turn()
        && now.signed_duration_since(observed_at).num_seconds()
            > SOURCE_LOG_ACTIVE_STALE_AFTER_SECS;
    let (state, reason, waiting_since) = if stale {
        (
            SessionState::Unknown,
            format!(
                "stale native evidence of a turn ignored: {}",
                evidence.reason
            ),
            None,
        )
    } else {
        (
            evidence.state,
            evidence.reason,
            evidence
                .waiting_since
                .map(|ts| ts.to_rfc3339_opts(SecondsFormat::Secs, true)),
        )
    };
    Observation {
        status: SessionStatus {
            state,
            source: StatusSource::NativeStatusReader,
            confidence: StatusConfidence::Approximate,
        },
        reason,
        observed_at: observed_at.to_rfc3339_opts(SecondsFormat::Secs, true),
        waiting_since,
    }
}

fn terminal_observation(evidence: AgentTerminalStatusEvidence) -> Observation {
    let waiting_since = matches!(evidence.state, SessionState::RequiresAction { .. })
        .then(|| evidence.observed_at.clone());
    Observation {
        status: SessionStatus {
            state: evidence.state,
            source: StatusSource::ManagedPty,
            confidence: evidence.confidence,
        },
        reason: evidence.reason,
        observed_at: evidence.observed_at,
        waiting_since,
    }
}

/// The catalogue record of a listed session, with its terminal surfaces laid
/// over it: runtime of the most recent surface and one status resolved from
/// the native evidence and the evidence of every matching surface.
pub(super) fn map_listed(
    source: AgentId,
    listed: ListedSession,
    native_read: Option<NativeLogRead>,
    scope: AgentSessionScope,
    last_activity_at: chrono::DateTime<Utc>,
    terminal_surfaces: &[AgentTerminalSurface],
) -> AgentSession {
    let id = catalog_session_id(&source, &listed.key);
    // Only a native id is the target of the agent's CLI resume and of a
    // managed PTY of Svode.
    let native = listed.key.namespace == IdentityNamespace::Native;
    let source_session_id = listed.key.session_id;
    let (title, title_source) = match listed.title.filter(|title| !title.is_empty()) {
        Some(title) => (title, AgentSessionTitleSource::CliTitle),
        None => (
            short_id(&source_session_id),
            AgentSessionTitleSource::SessionId,
        ),
    };
    let resume_command = native
        .then(|| terminal_resume_argv(&source, &source_session_id))
        .flatten()
        .map(|mut argv| {
            let program = argv.remove(0);
            AgentSessionResumeCommand {
                display: std::iter::once(program.as_str())
                    .chain(argv.iter().map(String::as_str))
                    .collect::<Vec<_>>()
                    .join(" "),
                program,
                args: argv,
                cwd: scope.cwd.clone(),
            }
        });
    let (launch_id, evidence) = native_read
        .map(|read| (read.launch_id, read.status))
        .unwrap_or_default();
    // The list is read at lifecycle boundaries; the log tells of later work.
    let last_activity_at = evidence
        .as_ref()
        .and_then(|evidence| evidence.observed_at)
        .map_or(last_activity_at, |observed| observed.max(last_activity_at));
    let mut observations = evidence
        .map(|evidence| native_observation(evidence, last_activity_at, Utc::now()))
        .into_iter()
        .collect::<Vec<_>>();

    let mut session = AgentSession {
        id,
        launch_id,
        routine_run_id: None,
        source,
        source_session_id,
        title,
        title_source,
        status: SessionStatus::unknown(),
        status_reason: None,
        runtime: Some(AgentSessionRuntime::default()),
        project_id: None,
        project_path: Some(scope.project_path.clone()),
        scope_kind: scope.kind,
        scope_status: scope.status,
        space_id: scope.space_id.clone(),
        space_path: scope.space_path.clone(),
        scope_confidence: scope.confidence,
        cwd: scope.cwd.clone(),
        started_at: None,
        last_activity_at: last_activity_at.to_rfc3339_opts(SecondsFormat::Secs, true),
        waiting_since: None,
        resume_command,
        capabilities: AgentSessionCapabilities {
            can_resume: native,
            can_open_in_chat: true,
        },
    };
    if native {
        observations.extend(apply_terminal_runtime(&mut session, terminal_surfaces));
    }
    let (status, reason, waiting_since) = resolve_status(observations);
    session.status = status;
    session.status_reason = Some(reason);
    session.waiting_since = waiting_since;
    session
}

/// Lays the most recent matching terminal surface over the session runtime
/// and returns the status evidence of every matching surface.
fn apply_terminal_runtime(
    session: &mut AgentSession,
    terminal_surfaces: &[AgentTerminalSurface],
) -> Vec<Observation> {
    let matching = terminal_surfaces
        .iter()
        .filter(|surface| {
            surface.agent_session_id == session.id
                || (surface.source == session.source
                    && surface.source_session_id == session.source_session_id)
                || (session.launch_id.is_some() && session.launch_id == surface.launch_id)
        })
        .collect::<Vec<_>>();
    let Some(runtime_surface) = matching
        .iter()
        .max_by(|a, b| surface_activity_key(a).cmp(surface_activity_key(b)))
    else {
        return Vec::new();
    };

    session.launch_id = session
        .launch_id
        .clone()
        .or_else(|| runtime_surface.launch_id.clone());
    session.routine_run_id = session
        .routine_run_id
        .clone()
        .or_else(|| runtime_surface.routine_run_id.clone());
    session.runtime = Some(AgentSessionRuntime {
        pty_id: runtime_surface.live.then(|| runtime_surface.pty_id.clone()),
        pid: None,
        live: runtime_surface.live,
        provisional: false,
        last_output_at: runtime_surface.last_output_at.clone(),
        last_input_at: runtime_surface.last_input_at.clone(),
        acp_session: None,
    });

    matching
        .iter()
        .filter_map(|surface| surface_status_evidence(surface))
        .map(terminal_observation)
        .collect()
}

pub(super) fn map_provisional_surface(
    surface: &AgentTerminalSurface,
    scope: AgentSessionScope,
) -> AgentSession {
    let (status, status_reason, waiting_since) = match surface_status_evidence(surface) {
        Some(evidence) => resolve_status(vec![terminal_observation(evidence)]),
        None if surface.live => (
            SessionStatus::unknown(),
            "routine launch is visible in a managed PTY".to_string(),
            None,
        ),
        None => (
            SessionStatus::unknown(),
            "routine launch has no source session or terminal outcome evidence".to_string(),
            None,
        ),
    };
    let last_activity_at = surface
        .last_input_at
        .as_deref()
        .into_iter()
        .chain(surface.last_output_at.as_deref())
        .chain(Some(surface.created_at.as_str()))
        .max()
        .unwrap_or(surface.created_at.as_str())
        .to_string();

    AgentSession {
        id: surface.agent_session_id.clone(),
        launch_id: surface.launch_id.clone(),
        routine_run_id: surface.routine_run_id.clone(),
        source: surface.source.clone(),
        source_session_id: surface.source_session_id.clone(),
        title: surface.title.clone().unwrap_or_else(|| {
            surface
                .launch_id
                .as_deref()
                .map(short_id)
                .unwrap_or_else(|| short_id(&surface.agent_session_id))
        }),
        title_source: AgentSessionTitleSource::CliTitle,
        status,
        status_reason: Some(status_reason),
        runtime: Some(AgentSessionRuntime {
            pty_id: surface.live.then(|| surface.pty_id.clone()),
            pid: None,
            live: surface.live,
            provisional: true,
            last_output_at: surface.last_output_at.clone(),
            last_input_at: surface.last_input_at.clone(),
            acp_session: None,
        }),
        project_id: None,
        project_path: Some(scope.project_path.clone()),
        scope_kind: scope.kind,
        scope_status: scope.status,
        space_id: scope.space_id.clone(),
        space_path: scope.space_path.clone(),
        scope_confidence: scope.confidence,
        cwd: scope.cwd,
        started_at: Some(surface.created_at.clone()),
        last_activity_at,
        waiting_since,
        resume_command: None,
        capabilities: AgentSessionCapabilities {
            can_resume: false,
            can_open_in_chat: false,
        },
    }
}

fn rfc3339(time: std::time::SystemTime) -> String {
    chrono::DateTime::<Utc>::from(time).to_rfc3339_opts(SecondsFormat::Secs, true)
}

const RUNTIME_STATUS_REASON: &str = "a Svode ACP connection drives the session";

/// Lays a session the runtime drives over its listed record (Stage 10 `02`
/// C3): one record per key, identity and resume target kept, exact runtime
/// status and the key the chat follows.
pub(super) fn overlay_runtime(session: &mut AgentSession, runtime: &RuntimeSession) {
    session.status = runtime.status;
    session.status_reason = Some(RUNTIME_STATUS_REASON.to_string());
    session.waiting_since = None;
    if session.title_source == AgentSessionTitleSource::SessionId
        && let Some(title) = &runtime.title
    {
        session.title = title.clone();
        session.title_source = AgentSessionTitleSource::CliTitle;
    }
    let updated_at = rfc3339(runtime.updated_at);
    if updated_at > session.last_activity_at {
        session.last_activity_at = updated_at;
    }
    session
        .runtime
        .get_or_insert_with(AgentSessionRuntime::default)
        .acp_session = Some(runtime.key.clone());
}

/// The record of a session only the runtime knows so far, such as one just
/// created in the chat before its agent lists it.
pub(super) fn map_runtime_session(
    source: AgentId,
    runtime: &RuntimeSession,
    scope: AgentSessionScope,
) -> AgentSession {
    let native = runtime.key.namespace == IdentityNamespace::Native;
    let source_session_id = runtime.key.session_id.clone();
    let (title, title_source) = match &runtime.title {
        Some(title) => (title.clone(), AgentSessionTitleSource::CliTitle),
        None => (
            short_id(&source_session_id),
            AgentSessionTitleSource::SessionId,
        ),
    };
    let resume_command = native
        .then(|| terminal_resume_argv(&source, &source_session_id))
        .flatten()
        .map(|mut argv| {
            let program = argv.remove(0);
            AgentSessionResumeCommand {
                display: std::iter::once(program.as_str())
                    .chain(argv.iter().map(String::as_str))
                    .collect::<Vec<_>>()
                    .join(" "),
                program,
                args: argv,
                cwd: scope.cwd.clone(),
            }
        });
    AgentSession {
        id: catalog_session_id(&source, &runtime.key),
        launch_id: None,
        routine_run_id: None,
        source,
        source_session_id,
        title,
        title_source,
        status: runtime.status,
        status_reason: Some(RUNTIME_STATUS_REASON.to_string()),
        runtime: Some(AgentSessionRuntime {
            acp_session: Some(runtime.key.clone()),
            ..AgentSessionRuntime::default()
        }),
        project_id: None,
        project_path: Some(scope.project_path.clone()),
        scope_kind: scope.kind,
        scope_status: scope.status,
        space_id: scope.space_id.clone(),
        space_path: scope.space_path.clone(),
        scope_confidence: scope.confidence,
        cwd: scope.cwd,
        started_at: Some(rfc3339(runtime.started_at)),
        last_activity_at: rfc3339(runtime.updated_at),
        waiting_since: None,
        resume_command,
        capabilities: AgentSessionCapabilities {
            can_resume: native,
            can_open_in_chat: true,
        },
    }
}

/// The recorded evidence of a surface, or its outcome from the exit code of
/// a finished initial command.
fn surface_status_evidence(surface: &AgentTerminalSurface) -> Option<AgentTerminalStatusEvidence> {
    if let Some(evidence) = &surface.status_evidence {
        return Some(evidence.clone());
    }

    let finished_at = surface.finished_at.as_ref()?;
    let exit_code = surface.exit_code?;
    let (state, reason) = crate::terminal::agent_exit_outcome(exit_code);
    Some(AgentTerminalStatusEvidence {
        state,
        confidence: StatusConfidence::Exact,
        reason: surface.failure_reason.clone().unwrap_or(reason),
        observed_at: finished_at.clone(),
    })
}

fn surface_activity_key(surface: &AgentTerminalSurface) -> &str {
    let mut key = surface.created_at.as_str();
    if let Some(last_output_at) = surface.last_output_at.as_deref()
        && last_output_at > key
    {
        key = last_output_at;
    }
    if let Some(last_input_at) = surface.last_input_at.as_deref()
        && last_input_at > key
    {
        key = last_input_at;
    }
    key
}

#[cfg(test)]
mod tests {
    use super::*;
    use svode_agents::status::{InteractionKind, StopReason};

    fn observation(
        state: SessionState,
        source: StatusSource,
        confidence: StatusConfidence,
        observed_at: &str,
    ) -> Observation {
        Observation {
            status: SessionStatus {
                state,
                source,
                confidence,
            },
            reason: format!("{state:?}"),
            observed_at: observed_at.to_string(),
            waiting_since: None,
        }
    }

    #[test]
    fn approximate_evidence_merges_by_observation_time() {
        let (status, _, _) = resolve_status(vec![
            observation(
                SessionState::Running,
                StatusSource::NativeStatusReader,
                StatusConfidence::Approximate,
                "2026-07-04T10:00:00Z",
            ),
            observation(
                SessionState::RequiresAction {
                    request: InteractionKind::Permission,
                },
                StatusSource::ManagedPty,
                StatusConfidence::Approximate,
                "2026-07-04T10:00:05Z",
            ),
        ]);

        assert_eq!(
            status.state,
            SessionState::RequiresAction {
                request: InteractionKind::Permission
            }
        );
        assert_eq!(status.source, StatusSource::ManagedPty);
    }

    #[test]
    fn exact_evidence_outranks_newer_approximate_evidence() {
        let exited = SessionState::Idle {
            stop_reason: Some(StopReason::Error),
        };
        let (status, _, _) = resolve_status(vec![
            observation(
                exited,
                StatusSource::ManagedPty,
                StatusConfidence::Exact,
                "2026-07-04T10:00:00Z",
            ),
            observation(
                SessionState::Running,
                StatusSource::NativeStatusReader,
                StatusConfidence::Approximate,
                "2026-07-04T10:05:00Z",
            ),
        ]);

        assert_eq!(status.state, exited);
        assert_eq!(status.confidence, StatusConfidence::Exact);
    }

    #[test]
    fn contradicting_sources_at_one_moment_are_unknown_without_a_source() {
        let (status, reason, _) = resolve_status(vec![
            observation(
                SessionState::Running,
                StatusSource::NativeStatusReader,
                StatusConfidence::Approximate,
                "2026-07-04T10:00:00Z",
            ),
            observation(
                SessionState::RequiresAction {
                    request: InteractionKind::Question,
                },
                StatusSource::ManagedPty,
                StatusConfidence::Approximate,
                "2026-07-04T10:00:00Z",
            ),
        ]);

        assert_eq!(status.state, SessionState::Unknown);
        assert_eq!(status.source, StatusSource::None);
        assert_eq!(reason, "conflicting status evidence");
    }

    #[test]
    fn no_evidence_is_unknown() {
        let (status, _, _) = resolve_status(Vec::new());

        assert_eq!(status, SessionStatus::unknown());
    }
}

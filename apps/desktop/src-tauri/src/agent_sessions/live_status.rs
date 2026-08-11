use chrono::{SecondsFormat, Utc};

use super::sources::{PersistedAgentSessionCandidate, PersistedAgentSessionStatus, short_id};
use super::types::{
    AgentSession, AgentSessionActiveFlag, AgentSessionCapabilities, AgentSessionResumeCommand,
    AgentSessionRuntime, AgentSessionScope, AgentSessionSourceMeta, AgentSessionStatus,
    AgentSessionStatusConfidence, AgentSessionStatusSource, AgentSessionTitleSource,
};
use crate::terminal::{AgentTerminalStatusEvidence, AgentTerminalSurface};

pub(super) const SOURCE_LOG_ACTIVE_STALE_AFTER_SECS: i64 = 6 * 60 * 60;

pub(super) fn map_candidate(
    candidate: PersistedAgentSessionCandidate,
    scope: AgentSessionScope,
    last_activity_at: chrono::DateTime<Utc>,
) -> AgentSession {
    let id = format!(
        "{}:{}",
        candidate.source.as_str(),
        candidate.source_session_id
    );
    let title = candidate
        .title
        .unwrap_or_else(|| short_id(&candidate.source_session_id));
    let title_source = if title.is_empty() {
        AgentSessionTitleSource::SessionId
    } else {
        candidate.title_source
    };
    let mut argv = candidate.source.resume_argv(&candidate.source_session_id);
    let program = argv.remove(0);
    let display = std::iter::once(program.as_str())
        .chain(argv.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ");
    let mut counts = candidate.counts;
    counts.messages = Some(counts.user_messages + counts.assistant_messages);
    let status_evidence = candidate.status;
    let (status, active_flags, status_source, status_confidence, status_reason, waiting_since) =
        match status_evidence {
            Some(evidence)
                if source_log_active_is_stale(&evidence, last_activity_at, Utc::now()) =>
            {
                (
                    AgentSessionStatus::Done,
                    Vec::new(),
                    AgentSessionStatusSource::Fallback,
                    AgentSessionStatusConfidence::Weak,
                    Some(format!(
                        "stale source-log active evidence ignored: {}",
                        evidence.reason
                    )),
                    None,
                )
            }
            Some(evidence) => (
                evidence.status,
                evidence.active_flags,
                AgentSessionStatusSource::SourceLog,
                evidence.confidence,
                Some(evidence.reason),
                evidence
                    .waiting_since
                    .map(|ts| ts.to_rfc3339_opts(SecondsFormat::Secs, true)),
            ),
            None => (
                AgentSessionStatus::Done,
                Vec::new(),
                AgentSessionStatusSource::Fallback,
                AgentSessionStatusConfidence::Weak,
                Some("persisted session without live status evidence".to_string()),
                None,
            ),
        };

    AgentSession {
        id,
        launch_id: candidate.launch_id,
        routine_run_id: None,
        source: candidate.source,
        source_session_id: candidate.source_session_id,
        title,
        title_source,
        status,
        active_flags,
        status_source,
        status_confidence,
        status_reason,
        runtime: Some(AgentSessionRuntime::default()),
        project_id: None,
        project_path: Some(scope.project_path.clone()),
        scope_kind: scope.kind,
        scope_status: scope.status,
        space_id: scope.space_id.clone(),
        space_path: scope.space_path.clone(),
        scope_confidence: scope.confidence,
        cwd: scope.cwd.clone(),
        started_at: candidate
            .created_at
            .map(|ts| ts.to_rfc3339_opts(SecondsFormat::Secs, true)),
        last_activity_at: last_activity_at.to_rfc3339_opts(SecondsFormat::Secs, true),
        waiting_since,
        duration_ms: None,
        resume_command: Some(AgentSessionResumeCommand {
            display,
            program,
            args: argv,
            cwd: scope.cwd,
        }),
        source_file: candidate.source_file,
        counts: Some(counts),
        capabilities: AgentSessionCapabilities::default(),
        pinned: false,
        source_meta: candidate.source_meta,
    }
}

pub(super) fn apply_terminal_overlay(
    session: &mut AgentSession,
    terminal_surfaces: &[AgentTerminalSurface],
) {
    let matching = terminal_surfaces
        .iter()
        .filter(|surface| {
            surface.agent_session_id == session.id
                || (surface.source == session.source
                    && surface.source_session_id == session.source_session_id)
                || (session.launch_id.is_some() && session.launch_id == surface.launch_id)
        })
        .collect::<Vec<_>>();
    if matching.is_empty() {
        return;
    }

    let runtime_surface = matching
        .iter()
        .max_by(|a, b| surface_activity_key(a).cmp(surface_activity_key(b)))
        .expect("matching surface");
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
    });

    let evidences = matching
        .iter()
        .filter_map(|surface| surface_status_evidence(surface))
        .collect::<Vec<_>>();
    if evidences.is_empty() {
        return;
    }
    if matches!(session.status_source, AgentSessionStatusSource::SourceLog) {
        match session.status {
            AgentSessionStatus::Done | AgentSessionStatus::Failed | AgentSessionStatus::Stopped => {
                return;
            }
            AgentSessionStatus::Active
                if evidences
                    .iter()
                    .all(|evidence| evidence.status == AgentSessionStatus::Active) =>
            {
                return;
            }
            AgentSessionStatus::Active | AgentSessionStatus::Unknown => {}
        }
    }

    let first_status = evidences[0].status;
    if evidences
        .iter()
        .any(|evidence| evidence.status != first_status)
    {
        session.status = AgentSessionStatus::Unknown;
        session.active_flags.clear();
        session.waiting_since = None;
        session.status_source = AgentSessionStatusSource::EmbeddedTerminal;
        session.status_confidence = AgentSessionStatusConfidence::Unknown;
        session.status_reason = Some("conflicting embedded terminal status evidence".to_string());
        return;
    }

    let evidence = evidences
        .iter()
        .max_by(|a, b| a.observed_at.cmp(&b.observed_at))
        .expect("status evidence");
    session.status = evidence.status;
    session.status_source = AgentSessionStatusSource::EmbeddedTerminal;
    session.status_confidence = AgentSessionStatusConfidence::Strong;
    session.status_reason = Some(evidence.reason.clone());

    if matches!(evidence.status, AgentSessionStatus::Active) {
        session.active_flags = merged_active_flags(&evidences);
        session.waiting_since =
            (!session.active_flags.is_empty()).then(|| evidence.observed_at.clone());
    } else {
        session.active_flags.clear();
        session.waiting_since = None;
    }
}

pub(super) fn map_provisional_surface(
    surface: &AgentTerminalSurface,
    scope: AgentSessionScope,
) -> AgentSession {
    let evidence = surface_status_evidence(surface);
    let (status, active_flags, status_confidence, status_reason, waiting_since) = match evidence {
        Some(evidence) => {
            let waiting_since = (evidence.status == AgentSessionStatus::Active
                && !evidence.active_flags.is_empty())
            .then(|| evidence.observed_at.clone());
            (
                evidence.status,
                evidence.active_flags,
                AgentSessionStatusConfidence::Strong,
                Some(evidence.reason),
                waiting_since,
            )
        }
        None if surface.live => (
            AgentSessionStatus::Unknown,
            Vec::new(),
            AgentSessionStatusConfidence::Unknown,
            Some("routine launch is visible in a managed PTY".to_string()),
            None,
        ),
        None => (
            AgentSessionStatus::Unknown,
            Vec::new(),
            AgentSessionStatusConfidence::Unknown,
            Some("routine launch has no source session or terminal outcome evidence".to_string()),
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
        source: surface.source,
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
        active_flags,
        status_source: AgentSessionStatusSource::SvodeAgentRuntime,
        status_confidence,
        status_reason,
        runtime: Some(AgentSessionRuntime {
            pty_id: surface.live.then(|| surface.pty_id.clone()),
            pid: None,
            live: surface.live,
            provisional: true,
            last_output_at: surface.last_output_at.clone(),
            last_input_at: surface.last_input_at.clone(),
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
        duration_ms: None,
        resume_command: None,
        source_file: None,
        counts: None,
        capabilities: AgentSessionCapabilities {
            can_resume: false,
            can_reveal_file: false,
            has_readable_log: false,
        },
        pinned: false,
        source_meta: AgentSessionSourceMeta::default(),
    }
}

fn source_log_active_is_stale(
    evidence: &PersistedAgentSessionStatus,
    last_activity_at: chrono::DateTime<Utc>,
    now: chrono::DateTime<Utc>,
) -> bool {
    if !matches!(evidence.status, AgentSessionStatus::Active) {
        return false;
    }

    let observed_at = evidence.observed_at.unwrap_or(last_activity_at);
    now.signed_duration_since(observed_at).num_seconds() > SOURCE_LOG_ACTIVE_STALE_AFTER_SECS
}

fn surface_status_evidence(surface: &AgentTerminalSurface) -> Option<AgentTerminalStatusEvidence> {
    if let Some(evidence) = &surface.status_evidence {
        return Some(evidence.clone());
    }

    let finished_at = surface.finished_at.as_ref()?;
    let exit_code = surface.exit_code?;
    let status = if exit_code == 0 {
        AgentSessionStatus::Done
    } else {
        AgentSessionStatus::Failed
    };
    let reason = surface.failure_reason.clone().unwrap_or_else(|| {
        if exit_code == 0 {
            "initial agent command exited successfully".to_string()
        } else {
            format!("initial agent command exited with code {exit_code}")
        }
    });

    Some(AgentTerminalStatusEvidence {
        status,
        active_flags: Vec::new(),
        reason,
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

fn merged_active_flags(evidences: &[AgentTerminalStatusEvidence]) -> Vec<AgentSessionActiveFlag> {
    let mut flags = Vec::new();
    for evidence in evidences {
        for flag in &evidence.active_flags {
            if !flags.contains(flag) {
                flags.push(*flag);
            }
        }
    }
    flags
}

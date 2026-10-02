use std::collections::{HashMap, HashSet};
#[cfg(test)]
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use chrono::{SecondsFormat, Utc};

use super::AgentSessionsState;
use super::acp_list::AcpListRead;
use super::cache::{
    SourceRead, candidates_for_session_ids, disk_snapshot_reads, memory_is_empty, read_source,
    update_candidate, write_snapshot,
};
use super::live_status::{map_candidate, map_provisional_surface};
use super::scope::{ScopeIndex, load_child_spaces, normalize_project_path, resolve_scope};
use super::sources::{CandidateCwdSource, NativeSource, PersistedAgentSessionCandidate};
use super::types::{
    AgentSession, AgentSessionSourceFileRef, AgentSessionSourceReport, AgentSessionSourceStatus,
    AgentSessionTitleSource, AgentSessionsCacheMode, AgentSessionsCacheReport,
    AgentSessionsHotStatusResult, AgentSessionsListResult, AgentSessionsListStatus,
    AgentSessionsSummary,
};
use crate::error::AppError;
use crate::terminal::AgentTerminalSurface;
use svode_agents::status::SessionState;
use svode_core::agent_adapters::AgentId;

#[cfg(test)]
pub(crate) fn list_sessions(
    state: &AgentSessionsState,
    project_path: String,
    force_refresh: bool,
) -> Result<AgentSessionsListResult, AppError> {
    list_sessions_with_surfaces(state, project_path, force_refresh, Vec::new())
}

pub(crate) fn list_sessions_with_surfaces(
    state: &AgentSessionsState,
    project_path: String,
    force_refresh: bool,
    terminal_surfaces: Vec<AgentTerminalSurface>,
) -> Result<AgentSessionsListResult, AppError> {
    let project = normalize_project_path(&project_path)?;
    let scope_index = ScopeIndex::new(&project, load_child_spaces(&project)?)?;
    let generated_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);

    let acp_reads = state.acp_lists.reads();
    if !force_refresh
        && memory_is_empty(state)?
        && let Some(reads) = disk_snapshot_reads(state, &project, Instant::now())?
    {
        return build_list_result(
            &project,
            &scope_index,
            generated_at,
            reads,
            acp_reads,
            force_refresh,
            Some(AgentSessionsCacheMode::StaleSnapshot),
            &terminal_surfaces,
            &state.home_dir,
        );
    }

    let mut reads = Vec::new();
    for source in NativeSource::all() {
        reads.push(read_source(state, &project, &source, force_refresh)?);
    }

    build_list_result(
        &project,
        &scope_index,
        generated_at,
        reads,
        acp_reads,
        force_refresh,
        None,
        &terminal_surfaces,
        &state.home_dir,
    )
}

fn build_list_result(
    project: &Path,
    scope_index: &ScopeIndex,
    generated_at: String,
    reads: Vec<SourceRead>,
    acp_reads: Vec<AcpListRead>,
    force_refresh: bool,
    cache_mode_override: Option<AgentSessionsCacheMode>,
    terminal_surfaces: &[AgentTerminalSurface],
    home: &Path,
) -> Result<AgentSessionsListResult, AppError> {
    let mut sessions = Vec::new();
    let mut reports = Vec::new();
    let mut summary = AgentSessionsSummary::default();
    let mut source_hits = 0usize;
    let mut source_misses = 0usize;

    let native_ids = reads
        .iter()
        .flat_map(|read| &read.candidates)
        .map(PersistedAgentSessionCandidate::session_id)
        .collect::<HashSet<_>>();
    for read in &reads {
        if read.cache_hit {
            source_hits += 1;
        } else {
            source_misses += 1;
        }
    }
    let reads = reads
        .into_iter()
        .map(|read| (read.candidates, read.report))
        .chain(
            acp_reads
                .into_iter()
                .map(|read| listed_candidates(read, &native_ids)),
        );

    for (candidates, mut report) in reads {
        summary.malformed_lines += report.counts.malformed_lines;
        summary.source_errors += report.counts.source_errors;

        for candidate in candidates {
            let Some(scope) = resolve_scope(scope_index, &candidate, home) else {
                report.counts.unresolved_candidates += 1;
                summary.unresolved_candidates += 1;
                continue;
            };
            let Some(last_activity_at) = candidate.last_activity_at else {
                report.counts.incomplete_candidates += 1;
                summary.incomplete_candidates += 1;
                continue;
            };

            let session = map_candidate(candidate, scope, last_activity_at, terminal_surfaces);
            report.counts.returned_sessions += 1;
            sessions.push(session);
        }

        reports.push(report);
    }

    append_provisional_sessions(&mut sessions, terminal_surfaces, scope_index, home, None);

    sessions.sort_by(compare_sessions);
    summary.returned_sessions = sessions.len();

    let cache_mode = if let Some(cache_mode) = cache_mode_override {
        cache_mode
    } else if force_refresh {
        AgentSessionsCacheMode::ForceRefresh
    } else if source_hits > 0 && source_misses == 0 {
        AgentSessionsCacheMode::FingerprintHit
    } else if source_hits == 0 {
        AgentSessionsCacheMode::FreshScan
    } else {
        AgentSessionsCacheMode::Mixed
    };
    let status = list_status(&reports, sessions.is_empty());

    Ok(AgentSessionsListResult {
        status,
        generated_at,
        project_path: project.to_string_lossy().into_owned(),
        sessions,
        sources: reports,
        summary,
        cache: AgentSessionsCacheReport {
            mode: cache_mode,
            hit: !force_refresh && source_hits > 0 && source_misses == 0,
            source_hits,
            source_misses,
        },
    })
}

/// Candidates of one agent's ACP list. A session a native source already
/// reported under the same key stays one record with that source's
/// metadata: the key, not cwd, title or time, decides.
fn listed_candidates(
    read: AcpListRead,
    native_ids: &HashSet<String>,
) -> (
    Vec<PersistedAgentSessionCandidate>,
    AgentSessionSourceReport,
) {
    let candidates = read
        .sessions
        .into_iter()
        .map(|listed| {
            let mut candidate =
                PersistedAgentSessionCandidate::new(read.source.clone(), listed.key.session_id);
            candidate.namespace = listed.key.namespace;
            candidate.from_acp_list = true;
            if let Some(title) = listed.title {
                candidate.title = Some(title);
                candidate.title_source = AgentSessionTitleSource::CliTitle;
            }
            candidate.cwd = Some(listed.cwd.to_string_lossy().into_owned());
            candidate.last_activity_at = listed
                .updated_at
                .as_deref()
                .and_then(super::sources::parse_timestamp_str);
            candidate
        })
        .filter(|candidate| !native_ids.contains(&candidate.session_id()))
        .collect();
    (candidates, read.report)
}

pub(crate) fn hot_status_with_surfaces(
    state: &AgentSessionsState,
    project_path: String,
    session_ids: Vec<String>,
    terminal_surfaces: Vec<AgentTerminalSurface>,
) -> Result<AgentSessionsHotStatusResult, AppError> {
    let project = normalize_project_path(&project_path)?;
    let scope_index = ScopeIndex::new(&project, load_child_spaces(&project)?)?;
    let generated_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let requested = session_ids.into_iter().collect::<HashSet<_>>();
    let mut candidates = candidates_for_session_ids(state, &requested)?;
    let mut reports = HashMap::<AgentId, AgentSessionSourceReport>::new();
    let mut sessions = Vec::new();
    let mut checked_sessions = 0usize;
    let mut updated_sessions = 0usize;
    let mut skipped_sessions = requested.len().saturating_sub(candidates.len());

    for mut candidate in candidates.drain(..) {
        checked_sessions += 1;
        let Some(native) = NativeSource::of(&candidate.source) else {
            skipped_sessions += 1;
            continue;
        };
        let source = native.agent.clone();
        let root = native.root(&state.home_dir);
        let report = reports.entry(source.clone()).or_insert_with(|| {
            AgentSessionSourceReport::new(source.clone(), root.to_string_lossy().into_owned())
        });
        report.counts.hot_files_checked += 1;

        if let Some(source_file) = candidate.source_file.as_ref() {
            let path = PathBuf::from(&source_file.path);
            if native.is_detail_file(&path) && source_file_metadata_changed(source_file) {
                report.counts.hot_files_reparsed += 1;
                let (detail_candidate, detail_report) =
                    parse_hot_detail_candidate(&native, &root, &path, &candidate.source_session_id);
                merge_report_counts(report, &detail_report);
                match detail_candidate {
                    Some(detail_candidate) => {
                        candidate = merge_hot_candidate(candidate, detail_candidate);
                        if let Some(updated_cache) = update_candidate(state, candidate.clone())? {
                            write_snapshot(
                                &project,
                                &source,
                                &updated_cache.fingerprint,
                                &updated_cache.candidates,
                                &updated_cache.report,
                            );
                        }
                        updated_sessions += 1;
                    }
                    None => {
                        skipped_sessions += 1;
                    }
                }
            }
        } else {
            skipped_sessions += 1;
        }

        let Some(scope) = resolve_scope(&scope_index, &candidate, &state.home_dir) else {
            skipped_sessions += 1;
            continue;
        };
        let Some(last_activity_at) = candidate.last_activity_at else {
            skipped_sessions += 1;
            continue;
        };

        let session = map_candidate(candidate, scope, last_activity_at, &terminal_surfaces);
        sessions.push(session);
    }

    append_provisional_sessions(
        &mut sessions,
        &terminal_surfaces,
        &scope_index,
        &state.home_dir,
        Some(&requested),
    );

    sessions.sort_by(compare_sessions);

    Ok(AgentSessionsHotStatusResult {
        generated_at,
        project_path: project.to_string_lossy().into_owned(),
        sessions,
        checked_sessions,
        updated_sessions,
        skipped_sessions,
        sources: reports.into_values().collect(),
    })
}

fn append_provisional_sessions(
    sessions: &mut Vec<AgentSession>,
    terminal_surfaces: &[AgentTerminalSurface],
    scope_index: &ScopeIndex,
    home: &Path,
    requested: Option<&HashSet<String>>,
) {
    let canonical_launch_ids = sessions
        .iter()
        .filter_map(|session| session.launch_id.clone())
        .collect::<HashSet<_>>();
    let existing_ids = sessions
        .iter()
        .map(|session| session.id.clone())
        .collect::<HashSet<_>>();

    for surface in terminal_surfaces {
        let Some(launch_id) = surface.launch_id.as_ref() else {
            continue;
        };
        if canonical_launch_ids.contains(launch_id)
            || existing_ids.contains(&surface.agent_session_id)
        {
            continue;
        }
        if requested.is_some_and(|ids| !ids.contains(&surface.agent_session_id)) {
            continue;
        }
        let mut candidate = PersistedAgentSessionCandidate::new(
            surface.source.clone(),
            surface.source_session_id.clone(),
        );
        candidate.cwd = Some(surface.shell_cwd.clone());
        candidate.cwd_source = CandidateCwdSource::Cwd;
        let Some(scope) = resolve_scope(scope_index, &candidate, home) else {
            continue;
        };
        sessions.push(map_provisional_surface(surface, scope));
    }
}

fn source_file_metadata_changed(source_file: &AgentSessionSourceFileRef) -> bool {
    let path = PathBuf::from(&source_file.path);
    let current = super::sources::source_file_ref(&path, "detail", None);
    current.mtime_ms != source_file.mtime_ms || current.size_bytes != source_file.size_bytes
}

fn parse_hot_detail_candidate(
    native: &NativeSource,
    root: &Path,
    path: &Path,
    source_session_id: &str,
) -> (
    Option<PersistedAgentSessionCandidate>,
    AgentSessionSourceReport,
) {
    let report =
        AgentSessionSourceReport::new(native.agent.clone(), root.to_string_lossy().into_owned());
    let (candidates, report) = native.scan_detail_file(root, path, report);
    let candidate = candidates
        .into_iter()
        .find(|candidate| candidate.source_session_id == source_session_id);
    (candidate, report)
}

fn merge_hot_candidate(
    mut base: PersistedAgentSessionCandidate,
    detail: PersistedAgentSessionCandidate,
) -> PersistedAgentSessionCandidate {
    if let Some(title) = detail.title
        && matches!(base.title_source, AgentSessionTitleSource::SessionId)
    {
        base.title = Some(title);
        base.title_source = detail.title_source;
    }
    if detail.cwd.is_some() {
        base.cwd = detail.cwd;
        base.cwd_source = detail.cwd_source;
    }
    if detail.created_at.is_some() {
        base.created_at = detail.created_at;
    }
    if detail.last_activity_at.is_some() {
        base.last_activity_at = detail.last_activity_at;
    }
    if detail.source_file.is_some() {
        base.source_file = detail.source_file;
    }
    base.status = detail.status;
    base.counts = detail.counts;
    merge_source_meta(&mut base.source_meta, detail.source_meta);
    base
}

fn merge_source_meta(
    base: &mut crate::agent_sessions::types::AgentSessionSourceMeta,
    detail: crate::agent_sessions::types::AgentSessionSourceMeta,
) {
    base.detail_present = detail.detail_present;
    base.detail_file_count = detail.detail_file_count;
    base.detail_line_count = detail.detail_line_count;
    base.malformed_line_count = detail.malformed_line_count;
    base.function_call_count = detail.function_call_count;
    for note in detail.notes {
        if !base.notes.iter().any(|existing| existing == &note) {
            base.notes.push(note);
        }
    }
}

fn merge_report_counts(target: &mut AgentSessionSourceReport, parsed: &AgentSessionSourceReport) {
    target.counts.files_scanned += parsed.counts.files_scanned;
    target.counts.records_read += parsed.counts.records_read;
    target.counts.candidates += parsed.counts.candidates;
    target.counts.malformed_lines += parsed.counts.malformed_lines;
    target.counts.source_errors += parsed.counts.source_errors;
    if matches!(parsed.status, AgentSessionSourceStatus::PartialError) {
        target.mark_partial_if_ok();
    }
    for diagnostic in &parsed.diagnostics {
        if target.diagnostics.len() >= crate::agent_sessions::types::MAX_SOURCE_DIAGNOSTICS {
            target.truncated_diagnostics += 1;
        } else {
            target.diagnostics.push(diagnostic.clone());
        }
    }
    target.truncated_diagnostics += parsed.truncated_diagnostics;
}

/// Waiting sessions first, then working ones, then by last activity.
fn compare_sessions(a: &AgentSession, b: &AgentSession) -> std::cmp::Ordering {
    fn work_priority(session: &AgentSession) -> u8 {
        match session.status.state {
            SessionState::RequiresAction { .. } => 2,
            SessionState::Running => 1,
            SessionState::Idle { .. } | SessionState::Unknown => 0,
        }
    }
    work_priority(b)
        .cmp(&work_priority(a))
        .then_with(|| b.last_activity_at.cmp(&a.last_activity_at))
        .then_with(|| a.id.cmp(&b.id))
}

fn list_status(reports: &[AgentSessionSourceReport], no_sessions: bool) -> AgentSessionsListStatus {
    let hard_errors = reports
        .iter()
        .filter(|report| {
            matches!(
                report.status,
                AgentSessionSourceStatus::Unreadable | AgentSessionSourceStatus::Error
            )
        })
        .count();
    let has_partial = reports.iter().any(|report| {
        matches!(
            report.status,
            AgentSessionSourceStatus::PartialError
                | AgentSessionSourceStatus::Unreadable
                | AgentSessionSourceStatus::Error
                | AgentSessionSourceStatus::Stale
        )
    });
    let non_missing = reports
        .iter()
        .filter(|report| !matches!(report.status, AgentSessionSourceStatus::MissingRoot))
        .count();

    if no_sessions && non_missing > 0 && hard_errors == non_missing {
        AgentSessionsListStatus::Error
    } else if has_partial {
        AgentSessionsListStatus::Partial
    } else {
        AgentSessionsListStatus::Ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_sessions::AgentSessionsState;
    use crate::agent_sessions::live_status::SOURCE_LOG_ACTIVE_STALE_AFTER_SECS;
    use crate::agent_sessions::types::terminal_resume_argv;
    use crate::agent_sessions::types::{
        AgentSessionScopeConfidence, AgentSessionScopeKind, AgentSessionScopeStatus,
        AgentSessionSourceKind,
    };
    use crate::terminal::{AgentTerminalStatusEvidence, AgentTerminalSurface};
    use svode_agents::status::{
        InteractionKind, SessionStatus, StatusConfidence, StatusSource, StopReason,
    };
    use svode_core::agent_adapters::AgentAdapterKind;

    const PERMISSION: SessionState = SessionState::RequiresAction {
        request: InteractionKind::Permission,
    };
    const QUESTION: SessionState = SessionState::RequiresAction {
        request: InteractionKind::Question,
    };

    fn idle(stop_reason: Option<StopReason>) -> SessionState {
        SessionState::Idle { stop_reason }
    }

    fn write(path: &Path, data: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(path, data).expect("write fixture");
    }

    fn write_root_config(project: &Path, spaces: Vec<serde_json::Value>) {
        write(
            &project.join(".svode/config.json"),
            &serde_json::json!({
                "name": "Project",
                "spaces": spaces,
            })
            .to_string(),
        );
    }

    fn space_ref(id: &str, path: &str, repo: Option<&str>) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "path": path,
            "repo": repo,
        })
    }

    fn write_codex_history(home: &Path, source_session_id: &str, cwd: &Path, timestamp: i64) {
        write(
            &home.join(".codex/history.jsonl"),
            &serde_json::json!({
                "sessionId": source_session_id,
                "cwd": cwd.to_string_lossy(),
                "timestamp": timestamp,
                "text": source_session_id,
            })
            .to_string(),
        );
    }

    fn write_codex_detail(home: &Path, source_session_id: &str, rows: Vec<serde_json::Value>) {
        write(
            &home
                .join(".codex/sessions/2026/07/04")
                .join(format!("rollout-{source_session_id}.jsonl")),
            &rows
                .into_iter()
                .map(|row| row.to_string())
                .collect::<Vec<_>>()
                .join("\n"),
        );
    }

    fn append_codex_detail_row(home: &Path, source_session_id: &str, row: serde_json::Value) {
        let path = home
            .join(".codex/sessions/2026/07/04")
            .join(format!("rollout-{source_session_id}.jsonl"));
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(path)
            .expect("open detail for append");
        use std::io::Write;
        write!(file, "\n{row}").expect("append detail row");
    }

    fn append_codex_history(home: &Path, rows: Vec<serde_json::Value>) {
        write(
            &home.join(".codex/history.jsonl"),
            &rows
                .into_iter()
                .map(|row| row.to_string())
                .collect::<Vec<_>>()
                .join("\n"),
        );
    }

    fn recent_source_log_timestamp() -> String {
        timestamp_offset(chrono::Duration::minutes(-1))
    }

    fn stale_source_log_timestamp() -> String {
        timestamp_offset(chrono::Duration::seconds(
            -(SOURCE_LOG_ACTIVE_STALE_AFTER_SECS + 60),
        ))
    }

    fn timestamp_offset(offset: chrono::Duration) -> String {
        (Utc::now() + offset).to_rfc3339_opts(SecondsFormat::Secs, true)
    }

    fn surface(
        pty_id: &str,
        source: AgentId,
        source_session_id: &str,
        evidence: Option<AgentTerminalStatusEvidence>,
    ) -> AgentTerminalSurface {
        AgentTerminalSurface {
            pty_id: pty_id.to_string(),
            agent_session_id: format!("{}:{source_session_id}", source.as_str()),
            launch_id: None,
            routine_run_id: None,
            mcp_project_path: None,
            mcp_routine_caller_token: None,
            title: Some(format!("Session {source_session_id}")),
            initial_agent_argv: terminal_resume_argv(&source, source_session_id)
                .unwrap_or_default(),
            source,
            source_session_id: source_session_id.to_string(),
            live: true,
            initial_agent_cwd: Some("/tmp/project".to_string()),
            shell_cwd: "/tmp/project".to_string(),
            created_at: "2026-07-04T10:00:00Z".to_string(),
            last_output_at: Some("2026-07-04T10:01:00Z".to_string()),
            last_input_at: None,
            finished_at: None,
            exit_code: None,
            failure_reason: None,
            status_evidence: evidence,
            exit_marker_buffer: String::new(),
        }
    }

    #[test]
    fn routine_launch_is_visible_before_source_session_reconciliation() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        write_root_config(&project, Vec::new());
        let state = AgentSessionsState::with_home(home);
        let mut provisional = surface(
            "pty-routine",
            AgentAdapterKind::Codex.id(),
            "launch:launch-123",
            None,
        );
        provisional.agent_session_id = "codex:launch:launch-123".to_string();
        provisional.launch_id = Some("launch-123".to_string());
        provisional.routine_run_id = Some("run-123".to_string());
        provisional.title = Some("Review backlog".to_string());
        provisional.shell_cwd = project.to_string_lossy().into_owned();
        provisional.initial_agent_cwd = Some(project.to_string_lossy().into_owned());

        let result = list_sessions_with_surfaces(
            &state,
            project.to_string_lossy().into_owned(),
            false,
            vec![provisional],
        )
        .expect("list sessions");

        assert_eq!(result.sessions.len(), 1);
        let session = &result.sessions[0];
        assert_eq!(session.id, "codex:launch:launch-123");
        assert_eq!(session.launch_id.as_deref(), Some("launch-123"));
        assert_eq!(session.routine_run_id.as_deref(), Some("run-123"));
        assert_eq!(session.status.state, SessionState::Unknown);
        assert_eq!(session.status.source, StatusSource::None);
        assert!(session.runtime.as_ref().expect("runtime").provisional);
        assert!(session.runtime.as_ref().expect("runtime").live);
        assert_eq!(session.title, "Review backlog");
    }

    #[test]
    fn routine_launch_reconciles_to_canonical_session_by_launch_id_not_cwd() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        write_root_config(&project, Vec::new());
        write_codex_detail(
            &home,
            "canonical-one",
            vec![
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {"id": "canonical-one", "cwd": project.to_string_lossy()},
                    "timestamp": "2026-08-07T10:00:00Z"
                }),
                serde_json::json!({
                    "type": "response_item",
                    "payload": {
                        "role": "user",
                        "content": [{"type": "input_text", "text": "Review backlog\n<!-- svode-launch:launch-one -->"}]
                    },
                    "timestamp": "2026-08-07T10:00:01Z"
                }),
            ],
        );
        let state = AgentSessionsState::with_home(home);
        let mut provisional = surface(
            "pty-one",
            AgentAdapterKind::Codex.id(),
            "launch:launch-one",
            None,
        );
        provisional.agent_session_id = "codex:launch:launch-one".to_string();
        provisional.launch_id = Some("launch-one".to_string());
        provisional.routine_run_id = Some("run-one".to_string());
        provisional.shell_cwd = project.to_string_lossy().into_owned();
        provisional.initial_agent_cwd = Some(project.to_string_lossy().into_owned());

        let result = list_sessions_with_surfaces(
            &state,
            project.to_string_lossy().into_owned(),
            true,
            vec![provisional],
        )
        .expect("list sessions");

        assert_eq!(result.sessions.len(), 1);
        let session = &result.sessions[0];
        assert_eq!(session.id, "codex:canonical-one");
        assert_eq!(session.launch_id.as_deref(), Some("launch-one"));
        assert_eq!(session.routine_run_id.as_deref(), Some("run-one"));
        assert_eq!(
            session
                .runtime
                .as_ref()
                .and_then(|runtime| runtime.pty_id.as_deref()),
            Some("pty-one")
        );
        assert!(!session.runtime.as_ref().expect("runtime").provisional);
    }

    /// Terminal evidence as the managed PTY records it: exact for a process
    /// exit, approximate for a request recognized in the terminal text.
    fn evidence(state: SessionState, reason: &str) -> AgentTerminalStatusEvidence {
        AgentTerminalStatusEvidence {
            state,
            confidence: if state.in_turn() {
                StatusConfidence::Approximate
            } else {
                StatusConfidence::Exact
            },
            reason: reason.to_string(),
            observed_at: "2026-07-04T10:01:00Z".to_string(),
        }
    }

    #[test]
    fn agent_sessions_scope_filters_unrelated_global_sessions() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        let unrelated = temp.path().join("other");
        fs::create_dir_all(&project).expect("project");
        fs::create_dir_all(&unrelated).expect("unrelated");
        write(
            &home.join(".codex/history.jsonl"),
            &format!(
                "{}\n{}",
                serde_json::json!({
                    "sessionId": "inside",
                    "cwd": project.join("sub").to_string_lossy(),
                    "timestamp": 1700000000,
                    "text": "inside"
                }),
                serde_json::json!({
                    "sessionId": "outside",
                    "cwd": unrelated.to_string_lossy(),
                    "timestamp": 1700000001,
                    "text": "outside"
                })
            ),
        );

        let state = AgentSessionsState::with_home(home);
        let result = list_sessions(&state, project.to_string_lossy().into_owned(), false)
            .expect("list sessions");

        assert_eq!(result.sessions.len(), 1);
        assert_eq!(result.sessions[0].source_session_id, "inside");
        assert_eq!(result.summary.unresolved_candidates, 1);
    }

    #[test]
    fn agent_sessions_scope_resolves_root_exact_match() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        write_codex_history(&home, "root", &project, 1_700_000_000);

        let state = AgentSessionsState::with_home(home);
        let result = list_sessions(&state, project.to_string_lossy().into_owned(), false)
            .expect("list sessions");

        assert_eq!(result.sessions.len(), 1);
        assert_eq!(
            result.sessions[0].scope_kind,
            AgentSessionScopeKind::Project
        );
        assert_eq!(
            result.sessions[0].scope_confidence,
            AgentSessionScopeConfidence::Exact
        );
    }

    #[test]
    fn agent_sessions_scope_resolves_child_exact_match() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        let child = project.join("dev");
        fs::create_dir_all(&child).expect("child");
        write_root_config(&project, vec![space_ref("dev-space", "dev", None)]);
        write_codex_history(&home, "child-exact", &child, 1_700_000_000);

        let state = AgentSessionsState::with_home(home);
        let result = list_sessions(&state, project.to_string_lossy().into_owned(), false)
            .expect("list sessions");

        assert_eq!(result.sessions.len(), 1);
        let session = &result.sessions[0];
        assert_eq!(session.scope_kind, AgentSessionScopeKind::Space);
        assert_eq!(session.scope_status, AgentSessionScopeStatus::Ready);
        assert_eq!(session.space_id.as_deref(), Some("dev-space"));
        assert_eq!(session.scope_confidence, AgentSessionScopeConfidence::Exact);
    }

    #[test]
    fn agent_sessions_scope_resolves_child_prefix_match() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        let child = project.join("dev");
        let nested = child.join("feature");
        fs::create_dir_all(&child).expect("child");
        write_root_config(&project, vec![space_ref("dev-space", "dev", None)]);
        write_codex_history(&home, "child-prefix", &nested, 1_700_000_000);

        let state = AgentSessionsState::with_home(home);
        let result = list_sessions(&state, project.to_string_lossy().into_owned(), false)
            .expect("list sessions");

        assert_eq!(result.sessions.len(), 1);
        assert_eq!(result.sessions[0].scope_kind, AgentSessionScopeKind::Space);
        assert_eq!(result.sessions[0].space_id.as_deref(), Some("dev-space"));
        assert_eq!(
            result.sessions[0].scope_confidence,
            AgentSessionScopeConfidence::CwdPrefix
        );
    }

    #[test]
    fn agent_sessions_scope_rejects_sibling_prefix_false_positive() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        let child = project.join("dev");
        let sibling = project.join("develop");
        fs::create_dir_all(&child).expect("child");
        fs::create_dir_all(&sibling).expect("sibling");
        write_root_config(&project, vec![space_ref("dev-space", "dev", None)]);
        write_codex_history(&home, "sibling", &sibling, 1_700_000_000);

        let state = AgentSessionsState::with_home(home);
        let result = list_sessions(&state, project.to_string_lossy().into_owned(), false)
            .expect("list sessions");

        assert_eq!(result.sessions.len(), 1);
        assert_eq!(
            result.sessions[0].scope_kind,
            AgentSessionScopeKind::Project
        );
        assert_eq!(result.sessions[0].space_id, None);
    }

    #[test]
    fn agent_sessions_scope_keeps_missing_and_broken_child_status() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        write_root_config(
            &project,
            vec![
                space_ref(
                    "missing-space",
                    "missing",
                    Some("https://example.com/missing.git"),
                ),
                space_ref("broken-space", "broken", None),
            ],
        );
        append_codex_history(
            &home,
            vec![
                serde_json::json!({
                    "sessionId": "missing",
                    "cwd": project.join("missing/sub").to_string_lossy(),
                    "timestamp": 1_700_000_000,
                    "text": "missing"
                }),
                serde_json::json!({
                    "sessionId": "broken",
                    "cwd": project.join("broken/sub").to_string_lossy(),
                    "timestamp": 1_700_000_001,
                    "text": "broken"
                }),
            ],
        );

        let state = AgentSessionsState::with_home(home);
        let result = list_sessions(&state, project.to_string_lossy().into_owned(), false)
            .expect("list sessions");

        let missing = result
            .sessions
            .iter()
            .find(|session| session.source_session_id == "missing")
            .expect("missing session");
        let broken = result
            .sessions
            .iter()
            .find(|session| session.source_session_id == "broken")
            .expect("broken session");

        assert_eq!(missing.space_id.as_deref(), Some("missing-space"));
        assert_eq!(missing.scope_status, AgentSessionScopeStatus::Missing);
        assert_eq!(broken.space_id.as_deref(), Some("broken-space"));
        assert_eq!(broken.scope_status, AgentSessionScopeStatus::Broken);
    }

    #[test]
    fn agent_sessions_scope_filters_unknown_external_worktree() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        let external = temp.path().join("external-worktree");
        fs::create_dir_all(&project).expect("project");
        fs::create_dir_all(&external).expect("external");
        write(
            &home.join(".claude/projects/-project/external.jsonl"),
            &format!(
                "{}\n{}",
                serde_json::json!({
                    "type": "worktree-state",
                    "worktreeSession": {"originalCwd": external.to_string_lossy()},
                    "timestamp": "2026-07-04T09:00:00Z"
                }),
                serde_json::json!({
                    "type": "user",
                    "message": {"role": "user", "content": "external worktree"},
                    "cwd": external.to_string_lossy(),
                    "timestamp": "2026-07-04T09:01:00Z"
                })
            ),
        );

        let state = AgentSessionsState::with_home(home);
        let result = list_sessions(&state, project.to_string_lossy().into_owned(), false)
            .expect("list sessions");

        assert!(result.sessions.is_empty());
        assert_eq!(result.summary.unresolved_candidates, 1);
    }

    #[test]
    fn agent_sessions_claude_project_key_does_not_create_scope() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        write(
            &home.join(".claude/projects/-project/claude-noscope.jsonl"),
            r#"{"type":"user","message":{"role":"user","content":"prompt"},"timestamp":1700000000}"#,
        );

        let state = AgentSessionsState::with_home(home);
        let result = list_sessions(&state, project.to_string_lossy().into_owned(), false)
            .expect("list sessions");

        assert!(result.sessions.is_empty());
        assert_eq!(result.summary.unresolved_candidates, 1);
    }

    #[test]
    fn agent_sessions_cache_uses_fingerprint_hit_for_noop_scan() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        write(
            &home.join(".codex/history.jsonl"),
            &format!(
                "{}",
                serde_json::json!({
                    "sessionId": "cached",
                    "cwd": project.to_string_lossy(),
                    "timestamp": 1700000000,
                    "text": "cached"
                })
            ),
        );

        let state = AgentSessionsState::with_home(home);
        let first = list_sessions(&state, project.to_string_lossy().into_owned(), false)
            .expect("first scan");
        let second = list_sessions(&state, project.to_string_lossy().into_owned(), false)
            .expect("second scan");
        let refresh = list_sessions(&state, project.to_string_lossy().into_owned(), true)
            .expect("refresh scan");

        assert_eq!(first.cache.mode, AgentSessionsCacheMode::FreshScan);
        assert_eq!(second.cache.mode, AgentSessionsCacheMode::FingerprintHit);
        assert!(second.cache.hit);
        assert_eq!(refresh.cache.mode, AgentSessionsCacheMode::ForceRefresh);
    }

    #[test]
    fn agent_sessions_disk_cache_warms_new_state_and_rebuilds_after_delete() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        write(
            &home.join(".codex/history.jsonl"),
            &serde_json::json!({
                "sessionId": "disk-cached",
                "cwd": project.to_string_lossy(),
                "timestamp": 1700000000,
                "text": "disk cached"
            })
            .to_string(),
        );

        let first_state = AgentSessionsState::with_home(home.clone());
        let first = list_sessions(&first_state, project.to_string_lossy().into_owned(), false)
            .expect("first list");
        assert_eq!(first.cache.mode, AgentSessionsCacheMode::FreshScan);
        assert!(project.join(".svode/agent-sessions.db").is_file());

        let warm_state = AgentSessionsState::with_home(home.clone());
        let warm = list_sessions(&warm_state, project.to_string_lossy().into_owned(), false)
            .expect("warm list");
        assert_eq!(warm.cache.mode, AgentSessionsCacheMode::StaleSnapshot);
        assert!(warm.cache.hit);
        assert_eq!(warm.sessions[0].source_session_id, "disk-cached");

        let validated = list_sessions(&warm_state, project.to_string_lossy().into_owned(), false)
            .expect("validated warm list");
        assert_eq!(validated.cache.mode, AgentSessionsCacheMode::FingerprintHit);
        assert!(validated.cache.hit);
        assert_eq!(validated.sessions[0].source_session_id, "disk-cached");

        fs::remove_file(project.join(".svode/agent-sessions.db")).expect("remove cache db");
        let rebuild_state = AgentSessionsState::with_home(home);
        let rebuilt = list_sessions(
            &rebuild_state,
            project.to_string_lossy().into_owned(),
            false,
        )
        .expect("rebuilt list");
        assert_eq!(rebuilt.cache.mode, AgentSessionsCacheMode::FreshScan);
        assert_eq!(rebuilt.sessions[0].source_session_id, "disk-cached");
        assert!(project.join(".svode/agent-sessions.db").is_file());
    }

    #[test]
    fn a_cache_row_from_the_previous_status_vocabulary_is_rescanned() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        write_codex_detail(
            &home,
            "old-cache",
            vec![
                serde_json::json!({
                    "type": "session_meta",
                    "payload": { "id": "old-cache", "cwd": project.to_string_lossy() },
                    "timestamp": recent_source_log_timestamp()
                }),
                serde_json::json!({
                    "type": "event_msg",
                    "payload": { "type": "task_started" },
                    "timestamp": recent_source_log_timestamp()
                }),
            ],
        );
        let first = list_sessions(
            &AgentSessionsState::with_home(home.clone()),
            project.to_string_lossy().into_owned(),
            false,
        )
        .expect("first list");
        assert_eq!(first.sessions[0].status.state, SessionState::Running);

        let db = project.join(".svode/agent-sessions.db");
        tauri::async_runtime::block_on(async {
            let pool = sqlx::SqlitePool::connect(&format!("sqlite://{}", db.display()))
                .await
                .expect("cache db");
            let (json,): (String,) =
                sqlx::query_as("SELECT candidates_json FROM source_cache WHERE source = 'codex'")
                    .fetch_one(&pool)
                    .await
                    .expect("codex row");
            let previous = json.replace(
                r#""state":{"state":"running"}"#,
                r#""status":"active","activeFlags":[],"confidence":"strong""#,
            );
            assert_ne!(previous, json);
            sqlx::query("UPDATE source_cache SET candidates_json = ? WHERE source = 'codex'")
                .bind(previous)
                .execute(&pool)
                .await
                .expect("previous row");
            pool.close().await;
        });

        let restarted = list_sessions(
            &AgentSessionsState::with_home(home),
            project.to_string_lossy().into_owned(),
            false,
        )
        .expect("restarted list");
        // The Claude Code row still reads; only the Codex row is scanned again.
        assert_eq!(restarted.cache.mode, AgentSessionsCacheMode::Mixed);
        let codex = restarted
            .sources
            .iter()
            .find(|report| report.source == AgentAdapterKind::Codex.id())
            .expect("codex report");
        assert!(!codex.cache_hit);
        assert_eq!(restarted.sessions[0].status.state, SessionState::Running);
    }

    #[test]
    fn corrupt_agent_sessions_cache_is_quarantined_and_rebuilt_in_place() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(project.join(".svode")).expect("project metadata");
        write_codex_history(&home, "recovered-cache", &project, 1_700_000_000);
        fs::write(project.join(".svode/agent-sessions.db"), "not sqlite")
            .expect("corrupt cache fixture");

        let state = AgentSessionsState::with_home(home);
        let result = list_sessions(&state, project.to_string_lossy().into_owned(), false)
            .expect("fresh scan after corrupt cache");

        assert_eq!(result.cache.mode, AgentSessionsCacheMode::FreshScan);
        assert_eq!(result.sessions[0].source_session_id, "recovered-cache");
        assert!(project.join(".svode/agent-sessions.db").is_file());
        assert!(
            fs::read_dir(project.join(".svode"))
                .unwrap()
                .flatten()
                .any(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .contains("agent-sessions.db.corrupt-"))
        );
    }

    #[test]
    fn agent_sessions_hot_status_updates_cached_codex_detail_append() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        write_codex_detail(
            &home,
            "needs-approval",
            vec![
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {
                        "id": "needs-approval",
                        "cwd": project.to_string_lossy()
                    },
                    "timestamp": recent_source_log_timestamp()
                }),
                serde_json::json!({
                    "type": "event_msg",
                    "payload": { "type": "task_started" },
                    "timestamp": recent_source_log_timestamp()
                }),
            ],
        );

        let state = AgentSessionsState::with_home(home.clone());
        let first = list_sessions(&state, project.to_string_lossy().into_owned(), false)
            .expect("first list");
        assert_eq!(first.sessions[0].status.state, SessionState::Running);

        append_codex_detail_row(
            &home,
            "needs-approval",
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "custom_tool_call",
                    "name": "apply_patch",
                    "call_id": "call-edit-approval",
                    "input": "*** Begin Patch\n*** End Patch"
                },
                "timestamp": recent_source_log_timestamp()
            }),
        );

        let stale_cached = list_sessions(&state, project.to_string_lossy().into_owned(), false)
            .expect("cached list");
        assert_eq!(
            stale_cached.cache.mode,
            AgentSessionsCacheMode::FingerprintHit
        );
        assert_eq!(stale_cached.sessions[0].status.state, SessionState::Running);

        let hot = hot_status_with_surfaces(
            &state,
            project.to_string_lossy().into_owned(),
            vec!["codex:needs-approval".to_string()],
            Vec::new(),
        )
        .expect("hot status");

        assert_eq!(hot.checked_sessions, 1);
        assert_eq!(hot.updated_sessions, 1);
        assert_eq!(
            hot.sources[0].counts.hot_files_checked, 1,
            "hot path should check the requested detail file only",
        );
        assert_eq!(hot.sources[0].counts.hot_files_reparsed, 1);
        assert_eq!(hot.sources[0].counts.files_scanned, 1);
        assert_eq!(hot.sessions[0].status.state, PERMISSION);

        let refreshed_cache = list_sessions(&state, project.to_string_lossy().into_owned(), false)
            .expect("refreshed cached list");
        assert_eq!(refreshed_cache.sessions[0].status.state, PERMISSION);

        let restarted_state = AgentSessionsState::with_home(home);
        let restarted = list_sessions(
            &restarted_state,
            project.to_string_lossy().into_owned(),
            false,
        )
        .expect("restarted warm list");
        assert_eq!(restarted.cache.mode, AgentSessionsCacheMode::StaleSnapshot);
        assert_eq!(restarted.sessions[0].status.state, PERMISSION);
    }

    #[test]
    fn agent_sessions_hot_status_updates_task_complete_to_done() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        write_codex_detail(
            &home,
            "complete-me",
            vec![
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {
                        "id": "complete-me",
                        "cwd": project.to_string_lossy()
                    },
                    "timestamp": recent_source_log_timestamp()
                }),
                serde_json::json!({
                    "type": "event_msg",
                    "payload": { "type": "task_started" },
                    "timestamp": recent_source_log_timestamp()
                }),
            ],
        );

        let state = AgentSessionsState::with_home(home.clone());
        let first = list_sessions(&state, project.to_string_lossy().into_owned(), false)
            .expect("first list");
        assert_eq!(first.sessions[0].status.state, SessionState::Running);

        append_codex_detail_row(
            &home,
            "complete-me",
            serde_json::json!({
                "type": "event_msg",
                "payload": { "type": "task_complete" },
                "timestamp": recent_source_log_timestamp()
            }),
        );

        let hot = hot_status_with_surfaces(
            &state,
            project.to_string_lossy().into_owned(),
            vec!["codex:complete-me".to_string()],
            Vec::new(),
        )
        .expect("hot status");

        assert_eq!(
            hot.sessions[0].status.state,
            idle(Some(StopReason::EndTurn))
        );
        assert_eq!(
            hot.sessions[0].status.source,
            StatusSource::NativeStatusReader
        );
        assert_eq!(
            hot.sessions[0].status.confidence,
            StatusConfidence::Approximate
        );
    }

    #[test]
    fn agent_sessions_open_managed_shell_without_evidence_is_unknown() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        write_codex_history(&home, "live-shell", &project, 1_700_000_000);

        let state = AgentSessionsState::with_home(home);
        let result = list_sessions_with_surfaces(
            &state,
            project.to_string_lossy().into_owned(),
            false,
            vec![surface(
                "pty-live",
                AgentAdapterKind::Codex.id(),
                "live-shell",
                None,
            )],
        )
        .expect("list sessions");

        let session = &result.sessions[0];
        assert_eq!(session.status.state, SessionState::Unknown);
        assert_eq!(session.status.source, StatusSource::None);
        assert!(session.runtime.as_ref().expect("runtime").live);
    }

    #[test]
    fn agent_sessions_terminal_waiting_evidence_overlays_active_status() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        write_codex_history(&home, "needs-approval", &project, 1_700_000_000);

        let state = AgentSessionsState::with_home(home);
        let result = list_sessions_with_surfaces(
            &state,
            project.to_string_lossy().into_owned(),
            false,
            vec![surface(
                "pty-approval",
                AgentAdapterKind::Codex.id(),
                "needs-approval",
                Some(evidence(PERMISSION, "approval prompt")),
            )],
        )
        .expect("list sessions");

        let session = &result.sessions[0];
        assert_eq!(session.status.state, PERMISSION);
        assert_eq!(session.status.source, StatusSource::ManagedPty);
        assert_eq!(session.status.confidence, StatusConfidence::Approximate);
        assert_eq!(
            session.waiting_since.as_deref(),
            Some("2026-07-04T10:01:00Z")
        );
    }

    #[test]
    fn agent_sessions_codex_tail_approval_sets_source_log_waiting_status() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        let meta_ts = recent_source_log_timestamp();
        let started_ts = recent_source_log_timestamp();
        let waiting_ts = recent_source_log_timestamp();
        write_codex_detail(
            &home,
            "needs-approval",
            vec![
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {
                        "id": "needs-approval",
                        "cwd": project.to_string_lossy()
                    },
                    "timestamp": meta_ts
                }),
                serde_json::json!({
                    "type": "event_msg",
                    "payload": { "type": "task_started" },
                    "timestamp": started_ts
                }),
                serde_json::json!({
                    "type": "response_item",
                    "payload": {
                        "type": "function_call",
                        "name": "exec_command",
                        "call_id": "call-approval",
                        "arguments": "{\"cmd\":\"date\",\"sandbox_permissions\":\"require_escalated\"}"
                    },
                    "timestamp": waiting_ts.clone()
                }),
            ],
        );

        let state = AgentSessionsState::with_home(home);
        let result = list_sessions(&state, project.to_string_lossy().into_owned(), false)
            .expect("list sessions");

        let session = &result.sessions[0];
        assert_eq!(session.status.state, PERMISSION);
        assert_eq!(session.status.source, StatusSource::NativeStatusReader);
        assert_eq!(session.waiting_since.as_deref(), Some(waiting_ts.as_str()));
    }

    #[test]
    fn agent_sessions_codex_tail_apply_patch_sets_source_log_waiting_status() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        let meta_ts = recent_source_log_timestamp();
        let started_ts = recent_source_log_timestamp();
        let waiting_ts = recent_source_log_timestamp();
        write_codex_detail(
            &home,
            "needs-edit-approval",
            vec![
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {
                        "id": "needs-edit-approval",
                        "cwd": project.to_string_lossy()
                    },
                    "timestamp": meta_ts
                }),
                serde_json::json!({
                    "type": "event_msg",
                    "payload": { "type": "task_started" },
                    "timestamp": started_ts
                }),
                serde_json::json!({
                    "type": "response_item",
                    "payload": {
                        "type": "custom_tool_call",
                        "name": "apply_patch",
                        "call_id": "call-edit-approval",
                        "input": "*** Begin Patch\n*** Update File: file.txt\n@@\n-old\n+new\n*** End Patch",
                        "status": "completed"
                    },
                    "timestamp": waiting_ts.clone()
                }),
            ],
        );

        let state = AgentSessionsState::with_home(home);
        let result = list_sessions(&state, project.to_string_lossy().into_owned(), false)
            .expect("list sessions");

        let session = &result.sessions[0];
        assert_eq!(session.status.state, PERMISSION);
        assert_eq!(session.status.source, StatusSource::NativeStatusReader);
        assert_eq!(session.waiting_since.as_deref(), Some(waiting_ts.as_str()));
    }

    #[test]
    fn agent_sessions_codex_tail_request_user_input_sets_source_log_waiting_status() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        let meta_ts = recent_source_log_timestamp();
        let started_ts = recent_source_log_timestamp();
        let waiting_ts = recent_source_log_timestamp();
        write_codex_detail(
            &home,
            "needs-input",
            vec![
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {
                        "id": "needs-input",
                        "cwd": project.to_string_lossy()
                    },
                    "timestamp": meta_ts
                }),
                serde_json::json!({
                    "type": "event_msg",
                    "payload": { "type": "task_started" },
                    "timestamp": started_ts
                }),
                serde_json::json!({
                    "type": "response_item",
                    "payload": {
                        "type": "function_call",
                        "name": "request_user_input",
                        "call_id": "call-input",
                        "arguments": "{}"
                    },
                    "timestamp": waiting_ts
                }),
            ],
        );

        let state = AgentSessionsState::with_home(home);
        let result = list_sessions(&state, project.to_string_lossy().into_owned(), false)
            .expect("list sessions");

        let session = &result.sessions[0];
        assert_eq!(session.status.state, QUESTION);
        assert_eq!(session.status.source, StatusSource::NativeStatusReader);
    }

    fn codex_code_mode_escalation(call_id: &str, timestamp: &str) -> serde_json::Value {
        serde_json::json!({
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call",
                "status": "completed",
                "call_id": call_id,
                "name": "exec",
                "input": "const r = await tools.exec_command({cmd: \"touch /tmp/outside.txt\", sandbox_permissions: \"require_escalated\"});\ntext(r.output);"
            },
            "timestamp": timestamp
        })
    }

    fn codex_code_mode_rows(
        source_session_id: &str,
        project: &Path,
        timestamp: &str,
    ) -> Vec<serde_json::Value> {
        vec![
            serde_json::json!({
                "type": "session_meta",
                "payload": {
                    "id": source_session_id,
                    "cwd": project.to_string_lossy(),
                    "cli_version": "0.159.3"
                },
                "timestamp": timestamp
            }),
            serde_json::json!({
                "type": "turn_context",
                "payload": {
                    "approval_policy": "on-request",
                    "approvals_reviewer": "user"
                },
                "timestamp": timestamp
            }),
            serde_json::json!({
                "type": "event_msg",
                "payload": { "type": "task_started" },
                "timestamp": timestamp
            }),
        ]
    }

    #[test]
    fn agent_sessions_codex_code_mode_hot_status_matches_list() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        let started_ts = recent_source_log_timestamp();
        write_codex_detail(
            &home,
            "code-mode",
            codex_code_mode_rows("code-mode", &project, &started_ts),
        );

        let state = AgentSessionsState::with_home(home.clone());
        let first = list_sessions(&state, project.to_string_lossy().into_owned(), false)
            .expect("first list");
        assert_eq!(first.sessions[0].status.state, SessionState::Running);

        let waiting_ts = recent_source_log_timestamp();
        append_codex_detail_row(
            &home,
            "code-mode",
            codex_code_mode_escalation("call-esc", &waiting_ts),
        );

        let hot = hot_status_with_surfaces(
            &state,
            project.to_string_lossy().into_owned(),
            vec!["codex:code-mode".to_string()],
            Vec::new(),
        )
        .expect("hot status");
        assert_eq!(hot.sessions[0].status.state, PERMISSION);
        assert_eq!(
            hot.sessions[0].status.source,
            StatusSource::NativeStatusReader
        );
        assert_eq!(
            hot.sessions[0].waiting_since.as_deref(),
            Some(waiting_ts.as_str())
        );

        let fresh = list_sessions(
            &AgentSessionsState::with_home(home),
            project.to_string_lossy().into_owned(),
            true,
        )
        .expect("fresh list");
        assert_eq!(fresh.sessions[0].status.state, hot.sessions[0].status.state);
        assert_eq!(
            fresh.sessions[0].waiting_since,
            hot.sessions[0].waiting_since
        );
    }

    #[test]
    fn agent_sessions_codex_stale_code_mode_request_is_unknown() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        let stale_ts = stale_source_log_timestamp();
        let mut rows = codex_code_mode_rows("stale-request", &project, &stale_ts);
        rows.push(codex_code_mode_escalation("call-esc", &stale_ts));
        write_codex_detail(&home, "stale-request", rows);

        let state = AgentSessionsState::with_home(home);
        let result = list_sessions(&state, project.to_string_lossy().into_owned(), false)
            .expect("list sessions");

        let session = &result.sessions[0];
        assert_eq!(session.status.state, SessionState::Unknown);
        assert_eq!(session.status.source, StatusSource::NativeStatusReader);
    }

    #[test]
    fn agent_sessions_stale_source_log_active_is_unknown() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        let stale_ts = stale_source_log_timestamp();
        write_codex_detail(
            &home,
            "stale-active",
            vec![
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {
                        "id": "stale-active",
                        "cwd": project.to_string_lossy()
                    },
                    "timestamp": stale_ts.clone()
                }),
                serde_json::json!({
                    "type": "event_msg",
                    "payload": { "type": "task_started" },
                    "timestamp": stale_ts
                }),
            ],
        );

        let state = AgentSessionsState::with_home(home);
        let result = list_sessions(&state, project.to_string_lossy().into_owned(), false)
            .expect("list sessions");

        let session = &result.sessions[0];
        assert_eq!(session.status.state, SessionState::Unknown);
        assert_eq!(session.status.source, StatusSource::NativeStatusReader);
        assert!(
            session
                .status_reason
                .as_deref()
                .is_some_and(|reason| reason.contains("stale native evidence of a turn ignored"))
        );
    }

    #[test]
    fn agent_sessions_source_log_done_overrides_terminal_waiting_evidence() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        write_codex_detail(
            &home,
            "answered",
            vec![
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {
                        "id": "answered",
                        "cwd": project.to_string_lossy()
                    },
                    "timestamp": "2026-07-04T10:00:00Z"
                }),
                serde_json::json!({
                    "type": "event_msg",
                    "payload": { "type": "task_started" },
                    "timestamp": "2026-07-04T10:01:00Z"
                }),
                serde_json::json!({
                    "type": "event_msg",
                    "payload": { "type": "task_complete" },
                    "timestamp": "2026-07-04T10:02:00Z"
                }),
            ],
        );

        let state = AgentSessionsState::with_home(home);
        let result = list_sessions_with_surfaces(
            &state,
            project.to_string_lossy().into_owned(),
            false,
            vec![surface(
                "pty-answered",
                AgentAdapterKind::Codex.id(),
                "answered",
                Some(evidence(PERMISSION, "stale approval prompt")),
            )],
        )
        .expect("list sessions");

        let session = &result.sessions[0];
        assert_eq!(session.status.state, idle(Some(StopReason::EndTurn)));
        assert_eq!(session.status.source, StatusSource::NativeStatusReader);
        assert_eq!(
            session.runtime.as_ref().expect("runtime").pty_id.as_deref(),
            Some("pty-answered")
        );
    }

    #[test]
    fn agent_sessions_terminal_exit_overrides_stale_source_log_active_status() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        write_codex_detail(
            &home,
            "exited-after-start",
            vec![
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {
                        "id": "exited-after-start",
                        "cwd": project.to_string_lossy()
                    },
                    "timestamp": recent_source_log_timestamp()
                }),
                serde_json::json!({
                    "type": "event_msg",
                    "payload": { "type": "task_started" },
                    "timestamp": recent_source_log_timestamp()
                }),
            ],
        );
        let done_surface = surface(
            "pty-exited",
            AgentAdapterKind::Codex.id(),
            "exited-after-start",
            Some(evidence(
                idle(None),
                "initial agent command exited successfully",
            )),
        );

        let state = AgentSessionsState::with_home(home);
        let result = list_sessions_with_surfaces(
            &state,
            project.to_string_lossy().into_owned(),
            false,
            vec![done_surface],
        )
        .expect("list sessions");

        let session = &result.sessions[0];
        assert_eq!(session.status.state, idle(None));
        assert_eq!(session.status.source, StatusSource::ManagedPty);
        assert_eq!(session.status.confidence, StatusConfidence::Exact);
    }

    #[test]
    fn agent_sessions_terminal_completion_exit_code_overlays_failed_status() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        write_codex_history(&home, "exit-failed", &project, 1_700_000_000);

        let mut failed_surface = surface(
            "pty-exit",
            AgentAdapterKind::Codex.id(),
            "exit-failed",
            None,
        );
        failed_surface.finished_at = Some("2026-07-04T10:02:00Z".to_string());
        failed_surface.exit_code = Some(2);
        failed_surface.failure_reason = Some("initial command failed".to_string());

        let state = AgentSessionsState::with_home(home);
        let result = list_sessions_with_surfaces(
            &state,
            project.to_string_lossy().into_owned(),
            false,
            vec![failed_surface],
        )
        .expect("list sessions");

        let session = &result.sessions[0];
        assert_eq!(session.status.state, idle(Some(StopReason::Error)));
        assert_eq!(session.status.source, StatusSource::ManagedPty);
        assert_eq!(
            session.status_reason.as_deref(),
            Some("initial command failed")
        );
    }

    #[test]
    fn agent_sessions_terminal_stopped_and_failed_evidence_is_explicit() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        append_codex_history(
            &home,
            vec![
                serde_json::json!({
                    "sessionId": "failed",
                    "cwd": project.to_string_lossy(),
                    "timestamp": 1_700_000_000,
                    "text": "failed"
                }),
                serde_json::json!({
                    "sessionId": "stopped",
                    "cwd": project.to_string_lossy(),
                    "timestamp": 1_700_000_001,
                    "text": "stopped"
                }),
            ],
        );

        let state = AgentSessionsState::with_home(home);
        let result = list_sessions_with_surfaces(
            &state,
            project.to_string_lossy().into_owned(),
            false,
            vec![
                surface(
                    "pty-failed",
                    AgentAdapterKind::Codex.id(),
                    "failed",
                    Some(evidence(idle(Some(StopReason::Error)), "agent failed")),
                ),
                surface(
                    "pty-stopped",
                    AgentAdapterKind::Codex.id(),
                    "stopped",
                    Some(evidence(
                        idle(Some(StopReason::Interrupted)),
                        "agent stopped",
                    )),
                ),
            ],
        )
        .expect("list sessions");

        let failed = result
            .sessions
            .iter()
            .find(|session| session.source_session_id == "failed")
            .expect("failed session");
        let stopped = result
            .sessions
            .iter()
            .find(|session| session.source_session_id == "stopped")
            .expect("stopped session");

        assert_eq!(failed.status.state, idle(Some(StopReason::Error)));
        assert_eq!(stopped.status.state, idle(Some(StopReason::Interrupted)));
    }

    fn list_one_session_with_evidence(
        session_id: &str,
        evidences: Vec<AgentTerminalStatusEvidence>,
    ) -> AgentSession {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        write_codex_history(&home, session_id, &project, 1_700_000_000);

        let state = AgentSessionsState::with_home(home);
        let surfaces = evidences
            .into_iter()
            .enumerate()
            .map(|(index, evidence)| {
                surface(
                    &format!("pty-{index}"),
                    AgentAdapterKind::Codex.id(),
                    session_id,
                    Some(evidence),
                )
            })
            .collect();
        let mut result = list_sessions_with_surfaces(
            &state,
            project.to_string_lossy().into_owned(),
            false,
            surfaces,
        )
        .expect("list sessions");
        result.sessions.remove(0)
    }

    #[test]
    fn agent_sessions_exact_terminal_evidence_outranks_approximate() {
        let session = list_one_session_with_evidence(
            "exact-wins",
            vec![
                evidence(QUESTION, "input prompt"),
                evidence(idle(Some(StopReason::Error)), "failed"),
            ],
        );

        assert_eq!(session.status.state, idle(Some(StopReason::Error)));
        assert_eq!(session.status.confidence, StatusConfidence::Exact);
        assert_eq!(session.waiting_since, None);
    }

    #[test]
    fn agent_sessions_conflicting_terminal_evidence_becomes_unknown() {
        let session = list_one_session_with_evidence(
            "conflict",
            vec![
                evidence(idle(None), "exited"),
                evidence(idle(Some(StopReason::Error)), "failed"),
            ],
        );

        assert_eq!(session.status.state, SessionState::Unknown);
        assert_eq!(session.status.source, StatusSource::ManagedPty);
        assert_eq!(
            session.status_reason.as_deref(),
            Some("conflicting status evidence")
        );
    }

    #[test]
    fn agent_sessions_missing_roots_are_ok_empty_envelope() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&home).expect("home");
        fs::create_dir_all(&project).expect("project");

        let state = AgentSessionsState::with_home(home);
        let result = list_sessions(&state, project.to_string_lossy().into_owned(), false)
            .expect("list sessions");

        assert_eq!(result.status, AgentSessionsListStatus::Ok);
        assert!(result.sessions.is_empty());
        assert!(
            result
                .sources
                .iter()
                .all(|source| source.status == AgentSessionSourceStatus::MissingRoot)
        );
    }

    #[test]
    fn agent_sessions_unreadable_source_is_report_not_app_error() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&home).expect("home");
        fs::create_dir_all(&project).expect("project");
        fs::write(home.join(".codex"), "not a directory").expect("codex file");

        let state = AgentSessionsState::with_home(home);
        let result = list_sessions(&state, project.to_string_lossy().into_owned(), false)
            .expect("list sessions");

        assert_eq!(result.status, AgentSessionsListStatus::Error);
        assert!(result.sources.iter().any(|source| {
            source.source == AgentAdapterKind::Codex.id()
                && source.status == AgentSessionSourceStatus::Unreadable
        }));
    }

    #[test]
    fn agent_sessions_unreadable_one_source_with_other_data_is_partial() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&home).expect("home");
        fs::create_dir_all(&project).expect("project");
        fs::write(home.join(".codex"), "not a directory").expect("codex file");
        write(
            &home.join(".claude/history.jsonl"),
            &serde_json::json!({
                "sessionId": "claude-ok",
                "display": "Claude ok",
                "project": project.to_string_lossy(),
                "timestamp": 1700000000
            })
            .to_string(),
        );

        let state = AgentSessionsState::with_home(home);
        let result = list_sessions(&state, project.to_string_lossy().into_owned(), false)
            .expect("list sessions");

        assert_eq!(result.status, AgentSessionsListStatus::Partial);
        assert_eq!(result.sessions.len(), 1);
    }

    #[test]
    fn agent_sessions_bounds_diagnostics_and_marks_truncated() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        let bad_lines = (0..60).map(|_| "{").collect::<Vec<_>>().join("\n");
        write(&home.join(".codex/history.jsonl"), &bad_lines);

        let state = AgentSessionsState::with_home(home);
        let result = list_sessions(&state, project.to_string_lossy().into_owned(), false)
            .expect("list sessions");
        let codex = result
            .sources
            .iter()
            .find(|source| source.source == AgentAdapterKind::Codex.id())
            .expect("codex report");

        assert_eq!(
            codex.diagnostics.len(),
            crate::agent_sessions::types::MAX_SOURCE_DIAGNOSTICS
        );
        assert_eq!(codex.truncated_diagnostics, 10);
        assert_eq!(codex.counts.malformed_lines, 60);
    }

    #[test]
    fn agent_sessions_list_dto_excludes_tool_input_body() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        write(
            &home.join(".codex/sessions/2026/07/04/a/rollout-secret.jsonl"),
            &format!(
                "{}\n{}",
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {"id": "secret", "cwd": project.to_string_lossy()},
                    "timestamp": "2026-07-04T10:00:00Z"
                }),
                serde_json::json!({
                    "type": "response_item",
                    "payload": {
                        "type": "function_call",
                        "role": "assistant",
                        "input": {"token": "SECRET_TOOL_INPUT"}
                    },
                    "timestamp": "2026-07-04T10:01:00Z"
                })
            ),
        );

        let state = AgentSessionsState::with_home(home);
        let result = list_sessions(&state, project.to_string_lossy().into_owned(), false)
            .expect("list sessions");
        let serialized = serde_json::to_string(&result).expect("serialize dto");

        assert_eq!(result.sessions.len(), 1);
        assert!(!serialized.contains("SECRET_TOOL_INPUT"));
    }

    fn acp_list(
        state: &AgentSessionsState,
        agent: &str,
        native: bool,
        sessions: Vec<(&str, &Path, Option<&str>)>,
    ) {
        let list = svode_agents::catalog::SessionList {
            sessions: sessions
                .into_iter()
                .map(
                    |(id, cwd, updated_at)| svode_agents::catalog::ListedSession {
                        key: svode_agents::identity::SessionKey::from_acp(agent, id, native),
                        cwd: cwd.to_path_buf(),
                        title: Some(format!("ACP {id}")),
                        updated_at: updated_at.map(str::to_string),
                    },
                )
                .collect(),
            ..Default::default()
        };
        state.acp_lists.apply(agent, Ok(list), 3);
    }

    /// An agent the code does not name (a custom or test agent, or a new
    /// built-in one) reaches the Sessions catalogue under its own id from its
    /// list alone: no consumer keeps a list of agents.
    #[test]
    fn an_agent_with_a_list_is_a_sessions_source_under_its_own_id() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        write_root_config(&project, Vec::new());

        let state = AgentSessionsState::with_home(home);
        acp_list(
            &state,
            "test-agent",
            false,
            vec![("t1", &project, LISTED_AT)],
        );
        let result = list_sessions(&state, project.to_string_lossy().into_owned(), false)
            .expect("list sessions");

        let session = by_id(&result, "test-agent:acp:t1");
        assert_eq!(session.source.as_str(), "test-agent");
        assert!(session.resume_command.is_none());
        assert!(result.sources.iter().any(|report| {
            report.kind == AgentSessionSourceKind::AcpList && report.source.as_str() == "test-agent"
        }));
    }

    fn by_id<'a>(result: &'a AgentSessionsListResult, id: &str) -> &'a AgentSession {
        result
            .sessions
            .iter()
            .find(|session| session.id == id)
            .unwrap_or_else(|| panic!("no session {id}"))
    }

    const LISTED_AT: Option<&str> = Some("2026-09-30T10:00:00Z");

    #[test]
    fn acp_listed_sessions_are_scoped_to_their_space_in_their_own_namespace() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        let child = project.join("dev");
        fs::create_dir_all(&child).expect("child");
        write_root_config(&project, vec![space_ref("dev-space", "dev", None)]);
        write_codex_history(&home, "same-id", &project, 1_700_000_000);
        let elsewhere = temp.path().join("elsewhere");

        let state = AgentSessionsState::with_home(home);
        acp_list(
            &state,
            "codex",
            false,
            vec![
                ("same-id", &project, LISTED_AT),
                ("in-child", &child, LISTED_AT),
                ("unrelated", &elsewhere, LISTED_AT),
                ("no-time", &project, None),
            ],
        );
        let result = list_sessions(&state, project.to_string_lossy().into_owned(), false)
            .expect("list sessions");

        let mut ids: Vec<_> = result.sessions.iter().map(|s| s.id.as_str()).collect();
        ids.sort();
        assert_eq!(
            ids,
            ["codex:acp:in-child", "codex:acp:same-id", "codex:same-id"],
            "without equality evidence an ACP id never merges with the native row"
        );
        let child_session = by_id(&result, "codex:acp:in-child");
        assert_eq!(child_session.space_id.as_deref(), Some("dev-space"));
        assert_eq!(child_session.title, "ACP in-child");
        assert_eq!(
            child_session.title_source,
            AgentSessionTitleSource::CliTitle
        );
        assert_eq!(child_session.last_activity_at, "2026-09-30T10:00:00Z");
        assert!(child_session.resume_command.is_none());
        assert!(!child_session.capabilities.can_resume);
        assert!(!child_session.capabilities.can_reveal_file);
        assert!(!child_session.capabilities.has_readable_log);
        assert!(child_session.counts.is_none());
        assert_eq!(child_session.status, SessionStatus::unknown());

        let report = result
            .sources
            .iter()
            .find(|report| report.kind == AgentSessionSourceKind::AcpList)
            .expect("acp list report");
        assert_eq!(report.source, AgentAdapterKind::Codex.id());
        assert_eq!(report.counts.returned_sessions, 2);
        assert_eq!(report.counts.unresolved_candidates, 1);
        assert_eq!(report.counts.incomplete_candidates, 1);
        assert_eq!(result.status, AgentSessionsListStatus::Ok);
    }

    #[test]
    fn a_native_key_from_the_acp_list_and_a_scanner_is_one_session_with_the_scanner_metadata() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        write_root_config(&project, Vec::new());
        write_codex_history(&home, "shared", &project, 1_700_000_000);

        let state = AgentSessionsState::with_home(home);
        acp_list(
            &state,
            "codex",
            true,
            vec![
                ("shared", &project, LISTED_AT),
                ("only-listed", &project, LISTED_AT),
            ],
        );
        let result = list_sessions(&state, project.to_string_lossy().into_owned(), false)
            .expect("list sessions");

        assert_eq!(result.sessions.len(), 2);
        let shared = by_id(&result, "codex:shared");
        assert_eq!(shared.title, "shared", "the scanner's metadata is shown");
        assert!(shared.counts.is_some());
        assert!(shared.capabilities.can_reveal_file);

        let listed = by_id(&result, "codex:only-listed");
        assert_eq!(listed.source_session_id, "only-listed");
        assert!(
            listed.capabilities.can_resume,
            "a native id is a resume target"
        );
        assert_eq!(
            listed
                .resume_command
                .as_ref()
                .map(|command| command.display.as_str()),
            Some("codex resume only-listed")
        );
        assert!(!listed.capabilities.can_reveal_file);
        assert!(listed.counts.is_none());
    }

    #[test]
    fn a_managed_terminal_never_attaches_to_a_session_in_the_acp_namespace() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        write_root_config(&project, Vec::new());

        let state = AgentSessionsState::with_home(home);
        acp_list(&state, "codex", false, vec![("s1", &project, LISTED_AT)]);
        let result = list_sessions_with_surfaces(
            &state,
            project.to_string_lossy().into_owned(),
            false,
            vec![surface("pty-1", AgentAdapterKind::Codex.id(), "s1", None)],
        )
        .expect("list sessions");

        let listed = by_id(&result, "codex:acp:s1");
        assert!(
            listed
                .runtime
                .as_ref()
                .and_then(|runtime| runtime.pty_id.clone())
                .is_none()
        );
    }

    #[test]
    fn a_stale_acp_source_keeps_its_last_sessions_and_leaves_the_others_untouched() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        write_root_config(&project, Vec::new());
        write_codex_history(&home, "native", &project, 1_700_000_000);

        let state = AgentSessionsState::with_home(home);
        acp_list(
            &state,
            "claude-code",
            false,
            vec![("c1", &project, LISTED_AT)],
        );
        state.acp_lists.apply(
            "claude-code",
            Err(svode_agents::AgentRuntimeError::Timeout),
            0,
        );
        let result = list_sessions(&state, project.to_string_lossy().into_owned(), false)
            .expect("list sessions");

        assert_eq!(result.status, AgentSessionsListStatus::Partial);
        assert!(result.sessions.iter().any(|s| s.id == "claude-code:acp:c1"));
        assert!(result.sessions.iter().any(|s| s.id == "codex:native"));
        let stale = result
            .sources
            .iter()
            .find(|report| report.kind == AgentSessionSourceKind::AcpList)
            .unwrap();
        assert_eq!(stale.status, AgentSessionSourceStatus::Stale);
        assert!(
            result
                .sources
                .iter()
                .filter(|report| report.kind == AgentSessionSourceKind::NativeLog)
                .all(|report| report.status != AgentSessionSourceStatus::Stale)
        );
    }
}

use std::collections::{HashMap, HashSet};
#[cfg(test)]
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use chrono::{SecondsFormat, Utc};

use super::AgentSessionsState;
use super::cache::{
    SourceRead, candidates_for_session_ids, disk_snapshot_reads, memory_is_empty, read_source,
    source_root, update_candidate, write_snapshot,
};
use super::live_status::{apply_terminal_overlay, map_candidate};
use super::scope::{ScopeIndex, load_child_spaces, normalize_project_path, resolve_scope};
use super::sources::{PersistedAgentSessionCandidate, claude_code, codex};
use super::types::{
    AgentSession, AgentSessionSource, AgentSessionSourceFileRef, AgentSessionSourceReport,
    AgentSessionSourceStatus, AgentSessionStatus, AgentSessionTitleSource, AgentSessionsCacheMode,
    AgentSessionsCacheReport, AgentSessionsHotStatusResult, AgentSessionsListResult,
    AgentSessionsListStatus, AgentSessionsSummary,
};
use crate::error::AppError;
use crate::space::config as space_config;
use crate::space::types::AgentSessionsLocalConfig;
use crate::terminal::AgentTerminalSurface;

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
    let pinned_ids = read_pinned_session_ids(&project)?;
    let generated_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);

    if !force_refresh
        && memory_is_empty(state)?
        && let Some(reads) = disk_snapshot_reads(state, &project, Instant::now())?
    {
        return build_list_result(
            &project,
            &scope_index,
            &pinned_ids,
            generated_at,
            reads,
            force_refresh,
            Some(AgentSessionsCacheMode::StaleSnapshot),
            &terminal_surfaces,
            &state.home_dir,
        );
    }

    let mut reads = Vec::new();
    for source in [AgentSessionSource::Codex, AgentSessionSource::ClaudeCode] {
        reads.push(read_source(state, &project, source, force_refresh)?);
    }

    build_list_result(
        &project,
        &scope_index,
        &pinned_ids,
        generated_at,
        reads,
        force_refresh,
        None,
        &terminal_surfaces,
        &state.home_dir,
    )
}

fn build_list_result(
    project: &Path,
    scope_index: &ScopeIndex,
    pinned_ids: &HashSet<String>,
    generated_at: String,
    reads: Vec<SourceRead>,
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

    for mut read in reads {
        if read.cache_hit {
            source_hits += 1;
        } else {
            source_misses += 1;
        }

        summary.malformed_lines += read.report.counts.malformed_lines;
        summary.source_errors += read.report.counts.source_errors;

        for candidate in read.candidates {
            let Some(scope) = resolve_scope(scope_index, &candidate, home) else {
                read.report.counts.unresolved_candidates += 1;
                summary.unresolved_candidates += 1;
                continue;
            };
            let Some(last_activity_at) = candidate.last_activity_at else {
                read.report.counts.incomplete_candidates += 1;
                summary.incomplete_candidates += 1;
                continue;
            };

            let mut session = map_candidate(candidate, scope, last_activity_at);
            apply_terminal_overlay(&mut session, &terminal_surfaces);
            session.pinned = pinned_ids.contains(&session.id);
            read.report.counts.returned_sessions += 1;
            sessions.push(session);
        }

        reports.push(read.report);
    }

    sessions.sort_by(|a, b| compare_sessions(a, b));
    summary.returned_sessions = sessions.len();
    summary.pinned_sessions = sessions.iter().filter(|session| session.pinned).count();

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

pub(crate) fn hot_status_with_surfaces(
    state: &AgentSessionsState,
    project_path: String,
    session_ids: Vec<String>,
    terminal_surfaces: Vec<AgentTerminalSurface>,
) -> Result<AgentSessionsHotStatusResult, AppError> {
    let project = normalize_project_path(&project_path)?;
    let scope_index = ScopeIndex::new(&project, load_child_spaces(&project)?)?;
    let pinned_ids = read_pinned_session_ids(&project)?;
    let generated_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let requested = session_ids.into_iter().collect::<HashSet<_>>();
    let mut candidates = candidates_for_session_ids(state, &requested)?;
    let mut reports = HashMap::<AgentSessionSource, AgentSessionSourceReport>::new();
    let mut sessions = Vec::new();
    let mut checked_sessions = 0usize;
    let mut updated_sessions = 0usize;
    let mut skipped_sessions = requested.len().saturating_sub(candidates.len());

    for mut candidate in candidates.drain(..) {
        checked_sessions += 1;
        let source = candidate.source;
        let root = source_root(&state.home_dir, source);
        let report = reports.entry(source).or_insert_with(|| {
            AgentSessionSourceReport::new(source, root.to_string_lossy().into_owned())
        });
        report.counts.hot_files_checked += 1;

        if let Some(source_file) = candidate.source_file.as_ref() {
            let path = PathBuf::from(&source_file.path);
            if is_detail_source_file(source, &path) && source_file_metadata_changed(source_file) {
                report.counts.hot_files_reparsed += 1;
                let (detail_candidate, detail_report) =
                    parse_hot_detail_candidate(source, &root, &path, &candidate.source_session_id);
                merge_report_counts(report, &detail_report);
                match detail_candidate {
                    Some(detail_candidate) => {
                        candidate = merge_hot_candidate(candidate, detail_candidate);
                        if let Some(updated_cache) = update_candidate(state, candidate.clone())? {
                            write_snapshot(
                                &project,
                                source,
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

        let mut session = map_candidate(candidate, scope, last_activity_at);
        apply_terminal_overlay(&mut session, &terminal_surfaces);
        session.pinned = pinned_ids.contains(&session.id);
        sessions.push(session);
    }

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

fn source_file_metadata_changed(source_file: &AgentSessionSourceFileRef) -> bool {
    let path = PathBuf::from(&source_file.path);
    let current = super::sources::source_file_ref(&path, "detail", None);
    current.mtime_ms != source_file.mtime_ms || current.size_bytes != source_file.size_bytes
}

fn is_detail_source_file(source: AgentSessionSource, path: &Path) -> bool {
    match source {
        AgentSessionSource::Codex => path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("rollout-") && name.ends_with(".jsonl")),
        AgentSessionSource::ClaudeCode => {
            path.extension().and_then(|ext| ext.to_str()) == Some("jsonl")
                && path
                    .components()
                    .any(|component| component.as_os_str().to_string_lossy().as_ref() == "projects")
        }
    }
}

fn parse_hot_detail_candidate(
    source: AgentSessionSource,
    root: &Path,
    path: &Path,
    source_session_id: &str,
) -> (
    Option<PersistedAgentSessionCandidate>,
    AgentSessionSourceReport,
) {
    let report = AgentSessionSourceReport::new(source, root.to_string_lossy().into_owned());
    let (candidates, report) = match source {
        AgentSessionSource::Codex => codex::scan_detail_file(path, report),
        AgentSessionSource::ClaudeCode => claude_code::scan_detail_file(root, path, report),
    };
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

fn read_pinned_session_ids(project: &Path) -> Result<HashSet<String>, AppError> {
    Ok(space_config::read_local_config(project)?
        .agent_sessions
        .map(|config| config.pinned_session_ids.into_iter().collect())
        .unwrap_or_default())
}

pub(crate) fn set_pinned(
    state: &AgentSessionsState,
    project_path: String,
    session_id: String,
    pinned: bool,
    terminal_surfaces: Vec<AgentTerminalSurface>,
) -> Result<crate::agent_sessions::types::AgentSessionsPinResult, AppError> {
    let project = normalize_project_path(&project_path)?;
    let current = list_sessions_with_surfaces(state, project_path, false, terminal_surfaces)?;
    let scoped_ids = current
        .sessions
        .iter()
        .map(|session| session.id.clone())
        .collect::<HashSet<_>>();
    if !scoped_ids.contains(&session_id) {
        return Err(AppError::General(format!(
            "agent session is not scoped to current project: {session_id}"
        )));
    }

    let mut local = space_config::read_local_config(&project)?;
    let overlay = local
        .agent_sessions
        .get_or_insert_with(AgentSessionsLocalConfig::default);
    overlay
        .pinned_session_ids
        .retain(|id| scoped_ids.contains(id) && id != &session_id);
    if pinned {
        overlay.pinned_session_ids.push(session_id.clone());
    }
    let pinned_session_ids = overlay.pinned_session_ids.clone();
    space_config::write_local_config(&project, &local)?;

    Ok(crate::agent_sessions::types::AgentSessionsPinResult {
        session_id,
        pinned,
        pinned_session_ids,
        updated_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
    })
}

fn compare_sessions(a: &AgentSession, b: &AgentSession) -> std::cmp::Ordering {
    let a_active_flags =
        matches!(a.status, AgentSessionStatus::Active) && !a.active_flags.is_empty();
    let b_active_flags =
        matches!(b.status, AgentSessionStatus::Active) && !b.active_flags.is_empty();
    b_active_flags
        .cmp(&a_active_flags)
        .then_with(|| {
            let a_active = matches!(a.status, AgentSessionStatus::Active);
            let b_active = matches!(b.status, AgentSessionStatus::Active);
            b_active.cmp(&a_active)
        })
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
    use crate::agent_sessions::types::{
        AgentSessionActiveFlag, AgentSessionScopeConfidence, AgentSessionScopeKind,
        AgentSessionScopeStatus, AgentSessionStatusConfidence, AgentSessionStatusSource,
        AgentSessionsPinResult,
    };
    use crate::terminal::{AgentTerminalStatusEvidence, AgentTerminalSurface};

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
        source: AgentSessionSource,
        source_session_id: &str,
        evidence: Option<AgentTerminalStatusEvidence>,
    ) -> AgentTerminalSurface {
        AgentTerminalSurface {
            pty_id: pty_id.to_string(),
            agent_session_id: format!("{}:{source_session_id}", source.as_str()),
            title: Some(format!("Session {source_session_id}")),
            source,
            source_session_id: source_session_id.to_string(),
            initial_agent_argv: source.resume_argv(source_session_id),
            initial_agent_cwd: Some("/tmp/project".to_string()),
            shell_cwd: "/tmp/project".to_string(),
            created_at: "2026-07-04T10:00:00Z".to_string(),
            last_output_at: Some("2026-07-04T10:01:00Z".to_string()),
            last_input_at: None,
            finished_at: None,
            exit_code: None,
            failure_reason: None,
            status_evidence: evidence,
        }
    }

    fn evidence(
        status: AgentSessionStatus,
        active_flags: Vec<AgentSessionActiveFlag>,
        reason: &str,
    ) -> AgentTerminalStatusEvidence {
        AgentTerminalStatusEvidence {
            status,
            active_flags,
            reason: reason.to_string(),
            observed_at: "2026-07-04T10:01:00Z".to_string(),
        }
    }

    fn pin(
        state: &AgentSessionsState,
        project: &Path,
        session_id: &str,
        pinned: bool,
    ) -> Result<AgentSessionsPinResult, AppError> {
        set_pinned(
            state,
            project.to_string_lossy().into_owned(),
            session_id.to_string(),
            pinned,
            Vec::new(),
        )
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
        assert_eq!(first.sessions[0].status, AgentSessionStatus::Active);
        assert!(first.sessions[0].active_flags.is_empty());

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
        assert!(stale_cached.sessions[0].active_flags.is_empty());

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
        assert_eq!(hot.sessions[0].status, AgentSessionStatus::Active);
        assert_eq!(
            hot.sessions[0].active_flags,
            vec![AgentSessionActiveFlag::WaitingOnApproval]
        );

        let refreshed_cache = list_sessions(&state, project.to_string_lossy().into_owned(), false)
            .expect("refreshed cached list");
        assert_eq!(
            refreshed_cache.sessions[0].active_flags,
            vec![AgentSessionActiveFlag::WaitingOnApproval]
        );

        let restarted_state = AgentSessionsState::with_home(home);
        let restarted = list_sessions(
            &restarted_state,
            project.to_string_lossy().into_owned(),
            false,
        )
        .expect("restarted warm list");
        assert_eq!(restarted.cache.mode, AgentSessionsCacheMode::StaleSnapshot);
        assert_eq!(
            restarted.sessions[0].active_flags,
            vec![AgentSessionActiveFlag::WaitingOnApproval]
        );
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
        assert_eq!(first.sessions[0].status, AgentSessionStatus::Active);

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

        assert_eq!(hot.sessions[0].status, AgentSessionStatus::Done);
        assert!(hot.sessions[0].active_flags.is_empty());
        assert_eq!(
            hot.sessions[0].status_source,
            AgentSessionStatusSource::SourceLog
        );
    }

    #[test]
    fn agent_sessions_open_managed_shell_keeps_persisted_done_status() {
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
                AgentSessionSource::Codex,
                "live-shell",
                None,
            )],
        )
        .expect("list sessions");

        let session = &result.sessions[0];
        assert_eq!(session.status, AgentSessionStatus::Done);
        assert_eq!(session.status_source, AgentSessionStatusSource::Fallback);
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
                AgentSessionSource::Codex,
                "needs-approval",
                Some(evidence(
                    AgentSessionStatus::Active,
                    vec![AgentSessionActiveFlag::WaitingOnApproval],
                    "approval prompt",
                )),
            )],
        )
        .expect("list sessions");

        let session = &result.sessions[0];
        assert_eq!(session.status, AgentSessionStatus::Active);
        assert_eq!(
            session.active_flags,
            vec![AgentSessionActiveFlag::WaitingOnApproval]
        );
        assert_eq!(
            session.status_source,
            AgentSessionStatusSource::EmbeddedTerminal
        );
        assert_eq!(
            session.status_confidence,
            AgentSessionStatusConfidence::Strong
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
        assert_eq!(session.status, AgentSessionStatus::Active);
        assert_eq!(
            session.active_flags,
            vec![AgentSessionActiveFlag::WaitingOnApproval]
        );
        assert_eq!(session.status_source, AgentSessionStatusSource::SourceLog);
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
        assert_eq!(session.status, AgentSessionStatus::Active);
        assert_eq!(
            session.active_flags,
            vec![AgentSessionActiveFlag::WaitingOnApproval]
        );
        assert_eq!(session.status_source, AgentSessionStatusSource::SourceLog);
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
        assert_eq!(session.status, AgentSessionStatus::Active);
        assert_eq!(
            session.active_flags,
            vec![AgentSessionActiveFlag::WaitingOnUserInput]
        );
        assert_eq!(session.status_source, AgentSessionStatusSource::SourceLog);
    }

    #[test]
    fn agent_sessions_stale_source_log_active_falls_back_to_done() {
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
        assert_eq!(session.status, AgentSessionStatus::Done);
        assert!(session.active_flags.is_empty());
        assert_eq!(session.status_source, AgentSessionStatusSource::Fallback);
        assert!(
            session
                .status_reason
                .as_deref()
                .is_some_and(|reason| reason.contains("stale source-log active evidence ignored"))
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
                AgentSessionSource::Codex,
                "answered",
                Some(evidence(
                    AgentSessionStatus::Active,
                    vec![AgentSessionActiveFlag::WaitingOnApproval],
                    "stale approval prompt",
                )),
            )],
        )
        .expect("list sessions");

        let session = &result.sessions[0];
        assert_eq!(session.status, AgentSessionStatus::Done);
        assert!(session.active_flags.is_empty());
        assert_eq!(session.status_source, AgentSessionStatusSource::SourceLog);
        assert_eq!(
            session.runtime.as_ref().expect("runtime").pty_id.as_deref(),
            Some("pty-answered")
        );
    }

    #[test]
    fn agent_sessions_terminal_completion_exit_code_overlays_failed_status() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        write_codex_history(&home, "exit-failed", &project, 1_700_000_000);

        let mut failed_surface =
            surface("pty-exit", AgentSessionSource::Codex, "exit-failed", None);
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
        assert_eq!(session.status, AgentSessionStatus::Failed);
        assert_eq!(
            session.status_source,
            AgentSessionStatusSource::EmbeddedTerminal
        );
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
                    AgentSessionSource::Codex,
                    "failed",
                    Some(evidence(
                        AgentSessionStatus::Failed,
                        Vec::new(),
                        "agent failed",
                    )),
                ),
                surface(
                    "pty-stopped",
                    AgentSessionSource::Codex,
                    "stopped",
                    Some(evidence(
                        AgentSessionStatus::Stopped,
                        Vec::new(),
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

        assert_eq!(failed.status, AgentSessionStatus::Failed);
        assert_eq!(failed.active_flags, Vec::<AgentSessionActiveFlag>::new());
        assert_eq!(stopped.status, AgentSessionStatus::Stopped);
        assert_eq!(stopped.active_flags, Vec::<AgentSessionActiveFlag>::new());
    }

    #[test]
    fn agent_sessions_conflicting_terminal_evidence_becomes_unknown() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        write_codex_history(&home, "conflict", &project, 1_700_000_000);

        let state = AgentSessionsState::with_home(home);
        let result = list_sessions_with_surfaces(
            &state,
            project.to_string_lossy().into_owned(),
            false,
            vec![
                surface(
                    "pty-active",
                    AgentSessionSource::Codex,
                    "conflict",
                    Some(evidence(
                        AgentSessionStatus::Active,
                        vec![AgentSessionActiveFlag::WaitingOnUserInput],
                        "input prompt",
                    )),
                ),
                surface(
                    "pty-failed",
                    AgentSessionSource::Codex,
                    "conflict",
                    Some(evidence(AgentSessionStatus::Failed, Vec::new(), "failed")),
                ),
            ],
        )
        .expect("list sessions");

        let session = &result.sessions[0];
        assert_eq!(session.status, AgentSessionStatus::Unknown);
        assert_eq!(
            session.status_source,
            AgentSessionStatusSource::EmbeddedTerminal
        );
        assert_eq!(
            session.status_confidence,
            AgentSessionStatusConfidence::Unknown
        );
        assert!(session.active_flags.is_empty());
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
            source.source == AgentSessionSource::Codex
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
            .find(|source| source.source == AgentSessionSource::Codex)
            .expect("codex report");

        assert_eq!(
            codex.diagnostics.len(),
            crate::agent_sessions::types::MAX_SOURCE_DIAGNOSTICS
        );
        assert_eq!(codex.truncated_diagnostics, 10);
        assert_eq!(codex.counts.malformed_lines, 60);
    }

    #[test]
    fn agent_sessions_pin_known_session_round_trips_local_config() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        write_codex_history(&home, "pin-me", &project, 1_700_000_000);

        let state = AgentSessionsState::with_home(home);
        let result = pin(&state, &project, "codex:pin-me", true).expect("pin session");
        assert!(result.pinned);
        assert_eq!(result.pinned_session_ids, vec!["codex:pin-me"]);

        let local = space_config::read_local_config(&project).expect("read local config");
        assert_eq!(
            local
                .agent_sessions
                .expect("agent sessions overlay")
                .pinned_session_ids,
            vec!["codex:pin-me"]
        );

        let listed = list_sessions(&state, project.to_string_lossy().into_owned(), false)
            .expect("list sessions");
        assert!(listed.sessions[0].pinned);
        assert_eq!(listed.summary.pinned_sessions, 1);
    }

    #[test]
    fn agent_sessions_pin_rejects_unknown_or_unscoped_session_id() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        let unrelated = temp.path().join("unrelated");
        fs::create_dir_all(&project).expect("project");
        fs::create_dir_all(&unrelated).expect("unrelated");
        append_codex_history(
            &home,
            vec![serde_json::json!({
                "sessionId": "outside",
                "cwd": unrelated.to_string_lossy(),
                "timestamp": 1_700_000_000,
                "text": "outside"
            })],
        );

        let state = AgentSessionsState::with_home(home);
        assert!(pin(&state, &project, "codex:missing", true).is_err());
        assert!(pin(&state, &project, "codex:outside", true).is_err());
        assert!(!project.join(".svode/local.json").exists());
    }

    #[test]
    fn agent_sessions_stale_pinned_ids_are_ignored_and_cleaned_on_write() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        write_codex_history(&home, "known", &project, 1_700_000_000);
        write(
            &project.join(".svode/local.json"),
            &serde_json::json!({
                "agentSessions": {
                    "pinnedSessionIds": ["codex:stale", "codex:known"]
                }
            })
            .to_string(),
        );

        let state = AgentSessionsState::with_home(home);
        let listed = list_sessions(&state, project.to_string_lossy().into_owned(), false)
            .expect("list sessions");
        assert_eq!(listed.sessions.len(), 1);
        assert!(listed.sessions[0].pinned);
        assert_eq!(listed.summary.pinned_sessions, 1);

        let result = pin(&state, &project, "codex:known", false).expect("unpin known session");
        assert!(result.pinned_session_ids.is_empty());
        let local = space_config::read_local_config(&project).expect("read local config");
        assert!(
            local
                .agent_sessions
                .expect("agent sessions overlay")
                .pinned_session_ids
                .is_empty()
        );
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
}

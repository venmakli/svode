use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::Instant;

use chrono::{SecondsFormat, Utc};

use super::AgentSessionsState;
use super::sources::{
    CandidateCwdSource, PersistedAgentSessionCandidate, SourceScan, claude_code, codex, short_id,
};
use super::types::{
    AgentSession, AgentSessionCapabilities, AgentSessionResumeCommand, AgentSessionRuntime,
    AgentSessionScope, AgentSessionScopeConfidence, AgentSessionScopeKind, AgentSessionScopeStatus,
    AgentSessionSource, AgentSessionSourceReport, AgentSessionSourceStatus, AgentSessionStatus,
    AgentSessionStatusConfidence, AgentSessionStatusSource, AgentSessionTitleSource,
    AgentSessionsCacheMode, AgentSessionsCacheReport, AgentSessionsListResult,
    AgentSessionsListStatus, AgentSessionsSummary,
};
use crate::error::AppError;

#[derive(Debug, Default)]
pub(crate) struct AgentSessionsReadCache {
    sources: HashMap<AgentSessionSource, CachedSourceScan>,
}

#[derive(Debug, Clone)]
struct CachedSourceScan {
    fingerprint: String,
    candidates: Vec<PersistedAgentSessionCandidate>,
    report: AgentSessionSourceReport,
}

#[derive(Debug)]
struct SourceRead {
    candidates: Vec<PersistedAgentSessionCandidate>,
    report: AgentSessionSourceReport,
    cache_hit: bool,
}

pub(crate) fn list_sessions(
    state: &AgentSessionsState,
    project_path: String,
    force_refresh: bool,
) -> Result<AgentSessionsListResult, AppError> {
    let project = normalize_project_path(&project_path)?;
    let generated_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);

    let mut cache = state
        .cache
        .lock()
        .map_err(|_| AppError::General("Agent sessions cache lock poisoned".to_string()))?;

    let mut reads = Vec::new();
    for source in [AgentSessionSource::Codex, AgentSessionSource::ClaudeCode] {
        reads.push(read_source(state, &mut cache, source, force_refresh));
    }
    drop(cache);

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
            let Some(scope) = resolve_scope(&project, &candidate, &state.home_dir) else {
                read.report.counts.unresolved_candidates += 1;
                summary.unresolved_candidates += 1;
                continue;
            };
            let Some(last_activity_at) = candidate.last_activity_at else {
                read.report.counts.incomplete_candidates += 1;
                summary.incomplete_candidates += 1;
                continue;
            };

            let session = map_candidate(candidate, scope, last_activity_at);
            read.report.counts.returned_sessions += 1;
            sessions.push(session);
        }

        reports.push(read.report);
    }

    sessions.sort_by(|a, b| compare_sessions(a, b));
    summary.returned_sessions = sessions.len();
    summary.pinned_sessions = sessions.iter().filter(|session| session.pinned).count();

    let cache_mode = if force_refresh {
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

fn read_source(
    state: &AgentSessionsState,
    cache: &mut AgentSessionsReadCache,
    source: AgentSessionSource,
    force_refresh: bool,
) -> SourceRead {
    let started = Instant::now();
    let root = match source {
        AgentSessionSource::Codex => state.home_dir.join(".codex"),
        AgentSessionSource::ClaudeCode => state.home_dir.join(".claude"),
    };
    let (fingerprint, report) = match source {
        AgentSessionSource::Codex => codex::collect_fingerprint(&root),
        AgentSessionSource::ClaudeCode => claude_code::collect_fingerprint(&root),
    };

    if !force_refresh {
        if let Some(cached) = cache.sources.get(&source)
            && cached.fingerprint == fingerprint.value
        {
            let mut report = cached.report.clone();
            report.cache_hit = true;
            report.fingerprint = Some(cached.fingerprint.clone());
            report.duration_ms = Some(started.elapsed().as_millis());
            return SourceRead {
                candidates: cached.candidates.clone(),
                report,
                cache_hit: true,
            };
        }
    }

    let scan = match source {
        AgentSessionSource::Codex => codex::scan(&root, fingerprint, report),
        AgentSessionSource::ClaudeCode => claude_code::scan(&root, fingerprint, report),
    };
    let mut scan = scan;
    scan.report.cache_hit = false;
    scan.report.duration_ms = Some(started.elapsed().as_millis());
    cache.sources.insert(
        source,
        CachedSourceScan {
            fingerprint: scan.fingerprint.clone(),
            candidates: scan.candidates.clone(),
            report: scan.report.clone(),
        },
    );
    source_read_from_scan(scan)
}

fn source_read_from_scan(scan: SourceScan) -> SourceRead {
    SourceRead {
        candidates: scan.candidates,
        report: scan.report,
        cache_hit: false,
    }
}

fn map_candidate(
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

    AgentSession {
        id,
        source: candidate.source,
        source_session_id: candidate.source_session_id,
        title,
        title_source,
        status: AgentSessionStatus::Done,
        active_flags: Vec::new(),
        status_source: AgentSessionStatusSource::Fallback,
        status_confidence: AgentSessionStatusConfidence::Weak,
        status_reason: Some(
            "persisted session; live status is not checked in Phase 1.1".to_string(),
        ),
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
        waiting_since: None,
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

fn resolve_scope(
    project: &Path,
    candidate: &PersistedAgentSessionCandidate,
    home: &Path,
) -> Option<AgentSessionScope> {
    let cwd_raw = candidate.cwd.as_ref()?;
    let expanded = expand_home(cwd_raw, home);
    let cwd = normalize_existing_or_lexical(&expanded)?;
    if !cwd.starts_with(project) {
        return None;
    }

    let confidence = match candidate.cwd_source {
        CandidateCwdSource::WorktreeOriginal => AgentSessionScopeConfidence::WorktreeOriginal,
        CandidateCwdSource::Cwd if cwd == project => AgentSessionScopeConfidence::Exact,
        CandidateCwdSource::Cwd => AgentSessionScopeConfidence::CwdPrefix,
    };

    Some(AgentSessionScope {
        kind: AgentSessionScopeKind::Project,
        status: AgentSessionScopeStatus::Ready,
        confidence,
        project_path: project.to_string_lossy().into_owned(),
        space_id: None,
        space_path: None,
        cwd: Some(cwd.to_string_lossy().into_owned()),
    })
}

fn expand_home(raw: &str, home: &Path) -> PathBuf {
    if raw == "~" {
        return home.to_path_buf();
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        return home.join(rest);
    }
    PathBuf::from(raw)
}

fn normalize_project_path(project_path: &str) -> Result<PathBuf, AppError> {
    let path = PathBuf::from(project_path);
    let normalized = fs::canonicalize(&path)
        .map_err(|_| AppError::PathNotAccessible(path.to_string_lossy().into_owned()))?;
    if !normalized.is_dir() {
        return Err(AppError::PathNotAccessible(
            normalized.to_string_lossy().into_owned(),
        ));
    }
    Ok(normalized)
}

fn normalize_existing_or_lexical(path: &Path) -> Option<PathBuf> {
    if let Ok(canonical) = fs::canonicalize(path) {
        return Some(canonical);
    }
    if let Some(normalized) = normalize_from_existing_ancestor(path) {
        return Some(normalized);
    }
    normalize_lexical(path)
}

fn normalize_from_existing_ancestor(path: &Path) -> Option<PathBuf> {
    let mut missing = Vec::new();
    let mut current = path;
    loop {
        if let Ok(mut canonical) = fs::canonicalize(current) {
            for component in missing.iter().rev() {
                canonical.push(component);
            }
            return Some(canonical);
        }
        let name = current.file_name()?.to_os_string();
        missing.push(name);
        current = current.parent()?;
    }
}

fn normalize_lexical(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push(std::path::MAIN_SEPARATOR.to_string()),
            Component::CurDir => {}
            Component::Normal(part) => out.push(part),
            Component::ParentDir => {
                if !out.pop() {
                    return None;
                }
            }
        }
    }
    Some(out)
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

    fn write(path: &Path, data: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(path, data).expect("write fixture");
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

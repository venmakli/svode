use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::Instant;

use chrono::{SecondsFormat, Utc};

use super::AgentSessionsState;
use super::sources::{
    CandidateCwdSource, PersistedAgentSessionCandidate, SourceScan, claude_code, codex, short_id,
};
use super::types::{
    AgentSession, AgentSessionActiveFlag, AgentSessionCapabilities, AgentSessionResumeCommand,
    AgentSessionRuntime, AgentSessionScope, AgentSessionScopeConfidence, AgentSessionScopeKind,
    AgentSessionScopeStatus, AgentSessionSource, AgentSessionSourceReport,
    AgentSessionSourceStatus, AgentSessionStatus, AgentSessionStatusConfidence,
    AgentSessionStatusSource, AgentSessionTitleSource, AgentSessionsCacheMode,
    AgentSessionsCacheReport, AgentSessionsListResult, AgentSessionsListStatus,
    AgentSessionsSummary,
};
use crate::error::AppError;
use crate::space::types::{AgentSessionsLocalConfig, SpaceInfo, SpaceStatus};
use crate::space::{config as space_config, project as space_project};
use crate::terminal::AgentTerminalSurface;

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

    let mut reads = Vec::new();
    for source in [AgentSessionSource::Codex, AgentSessionSource::ClaudeCode] {
        reads.push(read_source(state, source, force_refresh)?);
    }

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
            let Some(scope) = resolve_scope(&scope_index, &candidate, &state.home_dir) else {
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
            apply_terminal_status_overlay(&mut session, &terminal_surfaces);
            session.pinned = pinned_ids.contains(&session.id);
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
    source: AgentSessionSource,
    force_refresh: bool,
) -> Result<SourceRead, AppError> {
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
        if let Some(read) = cached_source_read(state, source, &fingerprint.value, started)? {
            return Ok(read);
        }
    }

    let scan = match source {
        AgentSessionSource::Codex => codex::scan(&root, fingerprint, report),
        AgentSessionSource::ClaudeCode => claude_code::scan(&root, fingerprint, report),
    };
    let mut scan = scan;
    scan.report.cache_hit = false;
    scan.report.duration_ms = Some(started.elapsed().as_millis());
    cache_source_scan(state, source, &scan)?;
    Ok(source_read_from_scan(scan))
}

fn cached_source_read(
    state: &AgentSessionsState,
    source: AgentSessionSource,
    fingerprint: &str,
    started: Instant,
) -> Result<Option<SourceRead>, AppError> {
    let cache = state
        .cache
        .lock()
        .map_err(|_| AppError::General("Agent sessions cache lock poisoned".to_string()))?;
    let Some(cached) = cache.sources.get(&source) else {
        return Ok(None);
    };
    if cached.fingerprint != fingerprint {
        return Ok(None);
    }

    let mut report = cached.report.clone();
    report.cache_hit = true;
    report.fingerprint = Some(cached.fingerprint.clone());
    report.duration_ms = Some(started.elapsed().as_millis());
    Ok(Some(SourceRead {
        candidates: cached.candidates.clone(),
        report,
        cache_hit: true,
    }))
}

fn cache_source_scan(
    state: &AgentSessionsState,
    source: AgentSessionSource,
    scan: &SourceScan,
) -> Result<(), AppError> {
    let mut cache = state
        .cache
        .lock()
        .map_err(|_| AppError::General("Agent sessions cache lock poisoned".to_string()))?;
    cache.sources.insert(
        source,
        CachedSourceScan {
            fingerprint: scan.fingerprint.clone(),
            candidates: scan.candidates.clone(),
            report: scan.report.clone(),
        },
    );
    Ok(())
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
    let status_evidence = candidate.status;
    let (status, active_flags, status_source, status_confidence, status_reason, waiting_since) =
        match status_evidence {
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

#[derive(Debug, Clone)]
struct ScopeIndex {
    entries: Vec<ScopeEntry>,
}

#[derive(Debug, Clone)]
struct ScopeEntry {
    kind: AgentSessionScopeKind,
    status: AgentSessionScopeStatus,
    path: PathBuf,
    project_path: String,
    space_id: Option<String>,
    space_path: Option<String>,
}

impl ScopeIndex {
    fn new(project: &Path, child_spaces: Vec<SpaceInfo>) -> Result<Self, AppError> {
        let project_path = project.to_string_lossy().into_owned();
        let mut entries = vec![ScopeEntry {
            kind: AgentSessionScopeKind::Project,
            status: AgentSessionScopeStatus::Ready,
            path: project.to_path_buf(),
            project_path: project_path.clone(),
            space_id: None,
            space_path: None,
        }];

        for space in child_spaces {
            let raw_path = PathBuf::from(&space.path);
            let Some(path) = normalize_existing_or_lexical(&raw_path) else {
                continue;
            };
            entries.push(ScopeEntry {
                kind: AgentSessionScopeKind::Space,
                status: scope_status(space.status),
                project_path: project_path.clone(),
                space_id: Some(space.id),
                space_path: Some(path.to_string_lossy().into_owned()),
                path,
            });
        }

        entries.sort_by(|a, b| {
            b.path
                .components()
                .count()
                .cmp(&a.path.components().count())
        });
        Ok(Self { entries })
    }

    fn resolve(&self, cwd: &Path, cwd_source: CandidateCwdSource) -> Option<AgentSessionScope> {
        let entry = self
            .entries
            .iter()
            .find(|entry| cwd == entry.path || cwd.starts_with(&entry.path))?;
        let confidence = match cwd_source {
            CandidateCwdSource::WorktreeOriginal => AgentSessionScopeConfidence::WorktreeOriginal,
            CandidateCwdSource::Cwd if cwd == entry.path => AgentSessionScopeConfidence::Exact,
            CandidateCwdSource::Cwd => AgentSessionScopeConfidence::CwdPrefix,
        };

        Some(AgentSessionScope {
            kind: entry.kind,
            status: entry.status,
            confidence,
            project_path: entry.project_path.clone(),
            space_id: entry.space_id.clone(),
            space_path: entry.space_path.clone(),
            cwd: Some(cwd.to_string_lossy().into_owned()),
        })
    }
}

fn scope_status(status: SpaceStatus) -> AgentSessionScopeStatus {
    match status {
        SpaceStatus::Ready => AgentSessionScopeStatus::Ready,
        SpaceStatus::Missing => AgentSessionScopeStatus::Missing,
        SpaceStatus::Broken => AgentSessionScopeStatus::Broken,
    }
}

fn load_child_spaces(project: &Path) -> Result<Vec<SpaceInfo>, AppError> {
    match space_project::list_spaces(project) {
        Ok(spaces) => Ok(spaces),
        Err(AppError::FileNotFound(_)) => Ok(Vec::new()),
        Err(error) => Err(error),
    }
}

fn resolve_scope(
    scope_index: &ScopeIndex,
    candidate: &PersistedAgentSessionCandidate,
    home: &Path,
) -> Option<AgentSessionScope> {
    let cwd_raw = candidate.cwd.as_ref()?;
    let expanded = expand_home(cwd_raw, home);
    let cwd = normalize_existing_or_lexical(&expanded)?;
    scope_index.resolve(&cwd, candidate.cwd_source)
}

fn apply_terminal_status_overlay(
    session: &mut AgentSession,
    terminal_surfaces: &[AgentTerminalSurface],
) {
    let matching = terminal_surfaces
        .iter()
        .filter(|surface| {
            surface.agent_session_id == session.id
                || (surface.source == session.source
                    && surface.source_session_id == session.source_session_id)
        })
        .collect::<Vec<_>>();
    if matching.is_empty() {
        return;
    }

    let runtime_surface = matching
        .iter()
        .max_by(|a, b| surface_activity_key(a).cmp(&surface_activity_key(b)))
        .expect("matching surface");
    session.runtime = Some(AgentSessionRuntime {
        pty_id: Some(runtime_surface.pty_id.clone()),
        pid: None,
        live: true,
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
        return;
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

fn surface_status_evidence(
    surface: &AgentTerminalSurface,
) -> Option<crate::terminal::AgentTerminalStatusEvidence> {
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

    Some(crate::terminal::AgentTerminalStatusEvidence {
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

fn merged_active_flags(
    evidences: &[crate::terminal::AgentTerminalStatusEvidence],
) -> Vec<AgentSessionActiveFlag> {
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
    use crate::agent_sessions::types::AgentSessionsPinResult;
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
                    "timestamp": "2026-07-04T10:00:00Z"
                }),
                serde_json::json!({
                    "type": "event_msg",
                    "payload": { "type": "task_started" },
                    "timestamp": "2026-07-04T10:01:00Z"
                }),
                serde_json::json!({
                    "type": "response_item",
                    "payload": {
                        "type": "function_call",
                        "name": "exec_command",
                        "call_id": "call-approval",
                        "arguments": "{\"cmd\":\"date\",\"sandbox_permissions\":\"require_escalated\"}"
                    },
                    "timestamp": "2026-07-04T10:02:00Z"
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
        assert_eq!(
            session.waiting_since.as_deref(),
            Some("2026-07-04T10:02:00Z")
        );
    }

    #[test]
    fn agent_sessions_codex_tail_request_user_input_sets_source_log_waiting_status() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
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
                    "timestamp": "2026-07-04T10:00:00Z"
                }),
                serde_json::json!({
                    "type": "event_msg",
                    "payload": { "type": "task_started" },
                    "timestamp": "2026-07-04T10:01:00Z"
                }),
                serde_json::json!({
                    "type": "response_item",
                    "payload": {
                        "type": "function_call",
                        "name": "request_user_input",
                        "call_id": "call-input",
                        "arguments": "{}"
                    },
                    "timestamp": "2026-07-04T10:02:00Z"
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

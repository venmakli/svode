use std::collections::HashSet;
use std::path::{Path, PathBuf};

use chrono::{DateTime, SecondsFormat, Utc};
use svode_agents::catalog::ListedSession;
use svode_agents::identity::IdentityNamespace;
use svode_agents::status::SessionState;
use svode_core::agent_adapters::AgentId;

use super::AgentSessionsState;
use super::cache::{SavedList, SavedSession};
use super::live_status::{map_listed, map_provisional_surface};
use super::native_status::{NativeReads, parse_timestamp_str};
use super::scope::{ScopeIndex, load_child_spaces, normalize_project_path, resolve_scope};
use super::types::{
    AgentSession, AgentSessionDiagnosticSeverity, AgentSessionScope, AgentSessionSourceReport,
    AgentSessionSourceStatus, AgentSessionsCacheMode, AgentSessionsCacheReport,
    AgentSessionsHotStatusResult, AgentSessionsListResult, AgentSessionsListStatus,
    AgentSessionsSummary, catalog_session_id,
};
use crate::error::AppError;
use crate::terminal::AgentTerminalSurface;

/// One agent's catalogue as the project's list builds it: the agent's ACP
/// list read by this process or, until one is, the list saved before the app
/// started.
struct AgentCatalog {
    source: AgentId,
    sessions: Vec<ListedSession>,
    report: AgentSessionSourceReport,
    read_at: Option<DateTime<Utc>>,
    snapshot: bool,
}

/// A listed session of the project with its scope and last activity.
struct ScopedSession {
    listed: ListedSession,
    scope: AgentSessionScope,
    last_activity_at: DateTime<Utc>,
}

pub(crate) fn list_sessions(
    state: &AgentSessionsState,
    project_path: String,
    terminal_surfaces: Vec<AgentTerminalSurface>,
) -> Result<AgentSessionsListResult, AppError> {
    let project = normalize_project_path(&project_path)?;
    let scope_index = ScopeIndex::new(&project, load_child_spaces(&project)?)?;
    let generated_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);

    let catalogs = catalogs(state, &project);
    let snapshot_shown = catalogs.iter().any(|catalog| catalog.snapshot);
    let mut sessions = Vec::new();
    let mut reports = Vec::new();
    let mut summary = AgentSessionsSummary::default();
    for catalog in catalogs {
        let mut report = catalog.report;
        let scoped = scoped_sessions(&scope_index, &state.home_dir, catalog.sessions, &mut report);
        let mut native = read_native(state, &catalog.source, &scoped);
        // A custom agent's id is of this device and the agent may be removed:
        // its list is read again once its connection opens, never saved
        // into the project.
        if let Some(read_at) = catalog.read_at.filter(|_| !catalog.source.is_custom()) {
            let saved = scoped
                .iter()
                .map(|session| SavedSession {
                    listed: session.listed.clone(),
                    native: native.sessions.get(&session.listed.key.session_id).cloned(),
                })
                .collect();
            state.snapshots.save(
                &project,
                &catalog.source,
                SavedList {
                    read_at,
                    sessions: saved,
                },
            );
        }
        for session in scoped {
            let read = native.sessions.remove(&session.listed.key.session_id);
            sessions.push(map_listed(
                catalog.source.clone(),
                session.listed,
                read,
                session.scope,
                session.last_activity_at,
                &terminal_surfaces,
            ));
            report.counts.returned_sessions += 1;
        }
        summary.unresolved_candidates += report.counts.unresolved_candidates;
        summary.incomplete_candidates += report.counts.incomplete_candidates;
        reports.push(report);
    }

    append_provisional_sessions(
        &mut sessions,
        &terminal_surfaces,
        &scope_index,
        &state.home_dir,
        None,
    );
    sessions.sort_by(compare_sessions);
    summary.returned_sessions = sessions.len();

    Ok(AgentSessionsListResult {
        status: list_status(&reports),
        generated_at,
        project_path: project.to_string_lossy().into_owned(),
        sessions,
        sources: reports,
        summary,
        cache: AgentSessionsCacheReport {
            mode: if snapshot_shown {
                AgentSessionsCacheMode::StaleSnapshot
            } else {
                AgentSessionsCacheMode::Current
            },
        },
    })
}

pub(crate) fn hot_status(
    state: &AgentSessionsState,
    project_path: String,
    session_ids: Vec<String>,
    terminal_surfaces: Vec<AgentTerminalSurface>,
) -> Result<AgentSessionsHotStatusResult, AppError> {
    let project = normalize_project_path(&project_path)?;
    let scope_index = ScopeIndex::new(&project, load_child_spaces(&project)?)?;
    let generated_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let requested = session_ids.into_iter().collect::<HashSet<_>>();
    let mut sessions = Vec::new();
    let mut checked_sessions = 0usize;
    let mut updated_sessions = 0usize;

    for catalog in catalogs(state, &project) {
        let listed = catalog
            .sessions
            .into_iter()
            .filter(|listed| requested.contains(&catalog_session_id(&catalog.source, &listed.key)))
            .collect::<Vec<_>>();
        checked_sessions += listed.len();
        let mut report = catalog.report;
        let scoped = scoped_sessions(&scope_index, &state.home_dir, listed, &mut report);
        let mut native = read_native(state, &catalog.source, &scoped);
        updated_sessions += native.reparsed;
        for session in scoped {
            let read = native.sessions.remove(&session.listed.key.session_id);
            sessions.push(map_listed(
                catalog.source.clone(),
                session.listed,
                read,
                session.scope,
                session.last_activity_at,
                &terminal_surfaces,
            ));
        }
    }
    let skipped_sessions = requested.len().saturating_sub(sessions.len());

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
    })
}

/// Every agent's catalogue for the project: its last good ACP list of this
/// process, else the list saved for the project before the app started.
fn catalogs(state: &AgentSessionsState, project: &Path) -> Vec<AgentCatalog> {
    let mut saved = state.snapshots.lists(project, |lists| {
        for (agent, list) in lists {
            for session in &list.sessions {
                if let Some(read) = &session.native {
                    state
                        .native_status
                        .seed(agent, &session.listed.key.session_id, read.clone());
                }
            }
        }
    });
    let mut catalogs = Vec::new();
    for read in state.acp_lists.reads() {
        let mut catalog = AgentCatalog {
            source: read.source,
            sessions: read.sessions,
            report: read.report,
            read_at: read.read_at,
            snapshot: false,
        };
        let saved_list = saved.remove(&catalog.source);
        if catalog.read_at.is_none()
            && let Some(list) = saved_list
        {
            show_saved(&mut catalog, list);
        }
        catalogs.push(catalog);
    }
    for (source, list) in saved {
        let mut catalog = AgentCatalog {
            report: AgentSessionSourceReport::new(source.clone()),
            source,
            sessions: Vec::new(),
            read_at: None,
            snapshot: false,
        };
        show_saved(&mut catalog, list);
        catalogs.push(catalog);
    }
    catalogs.sort_by(|left, right| left.source.cmp(&right.source));
    catalogs
}

fn show_saved(catalog: &mut AgentCatalog, list: SavedList) {
    catalog.sessions = list
        .sessions
        .into_iter()
        .map(|session| session.listed)
        .collect();
    catalog.read_at = Some(list.read_at);
    catalog.snapshot = true;
    catalog.report.read_at = Some(list.read_at.to_rfc3339_opts(SecondsFormat::Secs, true));
    catalog.report.counts.records_read = catalog.sessions.len();
    catalog.report.counts.candidates = catalog.sessions.len();
    catalog.report.push_diagnostic(
        AgentSessionDiagnosticSeverity::Info,
        "acp-list-snapshot",
        "Showing the session list saved before the app started; it updates once the agent's connection opens",
    );
}

/// The listed sessions that belong to the project and have a last activity.
fn scoped_sessions(
    scope_index: &ScopeIndex,
    home: &Path,
    listed: Vec<ListedSession>,
    report: &mut AgentSessionSourceReport,
) -> Vec<ScopedSession> {
    listed
        .into_iter()
        .filter_map(|listed| {
            let Some(scope) = resolve_scope(scope_index, &listed.cwd, home) else {
                report.counts.unresolved_candidates += 1;
                return None;
            };
            let Some(last_activity_at) = listed.updated_at.as_deref().and_then(parse_timestamp_str)
            else {
                report.counts.incomplete_candidates += 1;
                return None;
            };
            Some(ScopedSession {
                listed,
                scope,
                last_activity_at,
            })
        })
        .collect()
}

/// Native status of the sessions whose id is the agent's native id.
fn read_native(
    state: &AgentSessionsState,
    source: &AgentId,
    sessions: &[ScopedSession],
) -> NativeReads {
    let ids = sessions
        .iter()
        .filter(|session| session.listed.key.namespace == IdentityNamespace::Native)
        .map(|session| session.listed.key.session_id.as_str())
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return NativeReads::default();
    }
    state.native_status.read(source, &ids)
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
        let Some(scope) = resolve_scope(scope_index, &PathBuf::from(&surface.shell_cwd), home)
        else {
            continue;
        };
        sessions.push(map_provisional_surface(surface, scope));
    }
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

fn list_status(reports: &[AgentSessionSourceReport]) -> AgentSessionsListStatus {
    if reports
        .iter()
        .any(|report| report.status == AgentSessionSourceStatus::Stale)
    {
        AgentSessionsListStatus::Partial
    } else {
        AgentSessionsListStatus::Ok
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::agent_sessions::AgentSessionsState;
    use crate::agent_sessions::live_status::SOURCE_LOG_ACTIVE_STALE_AFTER_SECS;
    use crate::agent_sessions::types::terminal_resume_argv;
    use crate::agent_sessions::types::{
        AgentSessionScopeConfidence, AgentSessionScopeKind, AgentSessionScopeStatus,
    };
    use crate::terminal::{AgentTerminalStatusEvidence, AgentTerminalSurface};
    use svode_agents::catalog::SessionList;
    use svode_agents::identity::SessionKey;
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
    const LISTED_AT: Option<&str> = Some("2026-09-30T10:00:00Z");

    fn idle(stop_reason: Option<StopReason>) -> SessionState {
        SessionState::Idle { stop_reason }
    }

    /// A native Codex id: the rollout file name carries it.
    fn codex_id(n: u32) -> String {
        format!("0199a1b2-0000-7000-8000-{n:012}")
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

    fn rollout_path(home: &Path, id: &str) -> PathBuf {
        home.join(".codex/sessions/2026/07/04")
            .join(format!("rollout-2026-07-04T10-00-00-{id}.jsonl"))
    }

    fn write_rollout(home: &Path, id: &str, rows: Vec<serde_json::Value>) {
        write(
            &rollout_path(home, id),
            &rows
                .into_iter()
                .map(|row| row.to_string())
                .collect::<Vec<_>>()
                .join("\n"),
        );
    }

    fn append_rollout_row(home: &Path, id: &str, row: serde_json::Value) {
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(rollout_path(home, id))
            .expect("open rollout for append");
        use std::io::Write;
        write!(file, "\n{row}").expect("append rollout row");
    }

    fn task_started(timestamp: &str) -> serde_json::Value {
        serde_json::json!({
            "type": "event_msg",
            "payload": { "type": "task_started" },
            "timestamp": timestamp
        })
    }

    fn task_complete(timestamp: &str) -> serde_json::Value {
        serde_json::json!({
            "type": "event_msg",
            "payload": { "type": "task_complete" },
            "timestamp": timestamp
        })
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

    /// The agent's last good ACP list, as a read of its connection leaves it.
    fn acp_list(
        state: &AgentSessionsState,
        agent: &str,
        native: bool,
        sessions: Vec<(&str, &Path, Option<&str>)>,
    ) {
        let list = SessionList {
            sessions: sessions
                .into_iter()
                .map(|(id, cwd, updated_at)| ListedSession {
                    key: SessionKey::from_acp(agent, id, native),
                    cwd: cwd.to_path_buf(),
                    title: Some(format!("ACP {id}")),
                    updated_at: updated_at.map(str::to_string),
                })
                .collect(),
            ..Default::default()
        };
        state.acp_lists.apply(agent, Ok(list), 3);
    }

    /// One Codex session listed in the project with its rollout.
    fn listed_codex(
        state: &AgentSessionsState,
        home: &Path,
        project: &Path,
        id: &str,
        rows: Vec<serde_json::Value>,
    ) {
        write_rollout(home, id, rows);
        acp_list(state, "codex", true, vec![(id, project, LISTED_AT)]);
    }

    fn project_dirs() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        write_root_config(&project, Vec::new());
        (temp, home, project)
    }

    fn list(state: &AgentSessionsState, project: &Path) -> AgentSessionsListResult {
        list_with(state, project, Vec::new())
    }

    fn list_with(
        state: &AgentSessionsState,
        project: &Path,
        surfaces: Vec<AgentTerminalSurface>,
    ) -> AgentSessionsListResult {
        list_sessions(state, project.to_string_lossy().into_owned(), surfaces)
            .expect("list sessions")
    }

    fn hot(state: &AgentSessionsState, project: &Path, id: &str) -> AgentSessionsHotStatusResult {
        hot_status(
            state,
            project.to_string_lossy().into_owned(),
            vec![id.to_string()],
            Vec::new(),
        )
        .expect("hot status")
    }

    fn by_id<'a>(result: &'a AgentSessionsListResult, id: &str) -> &'a AgentSession {
        result
            .sessions
            .iter()
            .find(|session| session.id == id)
            .unwrap_or_else(|| panic!("no session {id}"))
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
    fn routine_launch_is_visible_before_source_session_reconciliation() {
        let (_temp, home, project) = project_dirs();
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

        let result = list_with(&state, &project, vec![provisional]);

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

    /// Condition 1 of `02`: a Codex terminal launch meets its listed session
    /// by the launch marker the reader takes from the first user turn.
    #[test]
    fn routine_launch_reconciles_to_its_listed_session_by_the_launch_marker() {
        let (_temp, home, project) = project_dirs();
        let id = codex_id(1);
        let state = AgentSessionsState::with_home(home.clone());
        listed_codex(
            &state,
            &home,
            &project,
            &id,
            vec![serde_json::json!({
                "type": "response_item",
                "payload": {
                    "role": "user",
                    "content": [{"type": "input_text", "text": "Review backlog\n<!-- svode-launch:launch-one -->"}]
                },
                "timestamp": "2026-08-07T10:00:01Z"
            })],
        );
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

        let result = list_with(&state, &project, vec![provisional]);

        assert_eq!(result.sessions.len(), 1);
        let session = &result.sessions[0];
        assert_eq!(session.id, format!("codex:{id}"));
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

    #[test]
    fn listed_sessions_resolve_to_the_project_and_its_spaces() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        let child = project.join("dev");
        let nested = child.join("feature");
        let sibling = project.join("develop");
        let unrelated = temp.path().join("other");
        for dir in [&child, &sibling, &unrelated] {
            fs::create_dir_all(dir).expect("dir");
        }
        write_root_config(&project, vec![space_ref("dev-space", "dev", None)]);
        let state = AgentSessionsState::with_home(home);
        acp_list(
            &state,
            "codex",
            true,
            vec![
                ("root", &project, LISTED_AT),
                ("child-exact", &child, LISTED_AT),
                ("child-prefix", &nested, LISTED_AT),
                ("sibling", &sibling, LISTED_AT),
                ("outside", &unrelated, LISTED_AT),
            ],
        );

        let result = list(&state, &project);

        assert_eq!(result.sessions.len(), 4);
        assert_eq!(result.summary.unresolved_candidates, 1);
        let root = by_id(&result, "codex:root");
        assert_eq!(root.scope_kind, AgentSessionScopeKind::Project);
        assert_eq!(root.scope_confidence, AgentSessionScopeConfidence::Exact);
        let child = by_id(&result, "codex:child-exact");
        assert_eq!(child.scope_kind, AgentSessionScopeKind::Space);
        assert_eq!(child.scope_status, AgentSessionScopeStatus::Ready);
        assert_eq!(child.space_id.as_deref(), Some("dev-space"));
        assert_eq!(child.scope_confidence, AgentSessionScopeConfidence::Exact);
        let nested = by_id(&result, "codex:child-prefix");
        assert_eq!(nested.space_id.as_deref(), Some("dev-space"));
        assert_eq!(
            nested.scope_confidence,
            AgentSessionScopeConfidence::CwdPrefix
        );
        let sibling = by_id(&result, "codex:sibling");
        assert_eq!(sibling.scope_kind, AgentSessionScopeKind::Project);
        assert_eq!(sibling.space_id, None);
    }

    #[test]
    fn listed_sessions_keep_the_status_of_missing_and_broken_spaces() {
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
        let state = AgentSessionsState::with_home(home);
        acp_list(
            &state,
            "codex",
            true,
            vec![
                ("missing", &project.join("missing/sub"), LISTED_AT),
                ("broken", &project.join("broken/sub"), LISTED_AT),
            ],
        );

        let result = list(&state, &project);

        let missing = by_id(&result, "codex:missing");
        assert_eq!(missing.space_id.as_deref(), Some("missing-space"));
        assert_eq!(missing.scope_status, AgentSessionScopeStatus::Missing);
        let broken = by_id(&result, "codex:broken");
        assert_eq!(broken.space_id.as_deref(), Some("broken-space"));
        assert_eq!(broken.scope_status, AgentSessionScopeStatus::Broken);
    }

    /// The reader makes no catalogue record: a session the agent does not
    /// list stays out even with a log on disk, and native history files
    /// make no records at all.
    #[test]
    fn a_native_log_alone_makes_no_session() {
        let (_temp, home, project) = project_dirs();
        write_rollout(
            &home,
            &codex_id(7),
            vec![
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {"id": codex_id(7), "cwd": project.to_string_lossy()},
                    "timestamp": "2026-07-04T10:00:00Z"
                }),
                task_complete("2026-07-04T10:01:00Z"),
            ],
        );
        write(
            &home.join(".codex/history.jsonl"),
            &serde_json::json!({"session_id": codex_id(8), "ts": 1_700_000_000, "text": "x"})
                .to_string(),
        );
        write(
            &home.join(".claude/history.jsonl"),
            &serde_json::json!({"sessionId": "c-history", "project": project.to_string_lossy(), "timestamp": 1_700_000_000, "display": "x"})
                .to_string(),
        );

        let state = AgentSessionsState::with_home(home);
        let result = list(&state, &project);

        assert!(result.sessions.is_empty());
        assert!(result.sources.is_empty());
        assert_eq!(result.status, AgentSessionsListStatus::Ok);
    }

    #[test]
    fn a_listed_native_session_gets_its_status_from_the_native_log_and_its_resume_command() {
        let (_temp, home, project) = project_dirs();
        let id = codex_id(2);
        let state = AgentSessionsState::with_home(home.clone());
        listed_codex(
            &state,
            &home,
            &project,
            &id,
            vec![
                task_started("2026-07-04T10:00:00Z"),
                task_complete("2026-07-04T10:01:00Z"),
            ],
        );

        let result = list(&state, &project);

        let session = by_id(&result, &format!("codex:{id}"));
        assert_eq!(session.title, format!("ACP {id}"));
        assert_eq!(session.last_activity_at, "2026-09-30T10:00:00Z");
        assert_eq!(session.status.state, idle(Some(StopReason::EndTurn)));
        assert_eq!(session.status.source, StatusSource::NativeStatusReader);
        assert_eq!(session.status.confidence, StatusConfidence::Approximate);
        assert!(session.capabilities.can_resume);
        assert_eq!(
            session
                .resume_command
                .as_ref()
                .map(|command| command.display.as_str()),
            Some(format!("codex resume {id}").as_str())
        );
        assert_eq!(result.cache.mode, AgentSessionsCacheMode::Current);
    }

    #[test]
    fn a_listed_session_without_a_log_is_unknown() {
        let (_temp, home, project) = project_dirs();
        let state = AgentSessionsState::with_home(home);
        acp_list(&state, "codex", true, vec![("no-log", &project, LISTED_AT)]);

        let result = list(&state, &project);

        let session = by_id(&result, "codex:no-log");
        assert_eq!(session.status, SessionStatus::unknown());
        assert_eq!(session.status_reason.as_deref(), Some("no status evidence"));
    }

    /// Condition 3 of `02`: after the app starts, the catalogue shows the
    /// list saved before, with the saved status, until the agent's
    /// connection opens; the native reader keeps updating that status.
    #[test]
    fn the_last_good_list_is_shown_after_a_restart_until_the_agent_lists_again() {
        let (_temp, home, project) = project_dirs();
        let id = codex_id(3);
        let state = AgentSessionsState::with_home(home.clone());
        listed_codex(
            &state,
            &home,
            &project,
            &id,
            vec![task_started(&recent_source_log_timestamp())],
        );
        let first = list(&state, &project);
        assert_eq!(first.sessions[0].status.state, SessionState::Running);

        let restarted = AgentSessionsState::with_home(home.clone());
        let saved = list(&restarted, &project);
        assert_eq!(saved.cache.mode, AgentSessionsCacheMode::StaleSnapshot);
        assert_eq!(saved.status, AgentSessionsListStatus::Ok);
        let session = by_id(&saved, &format!("codex:{id}"));
        assert_eq!(session.title, format!("ACP {id}"));
        assert_eq!(session.status.state, SessionState::Running);
        assert_eq!(
            saved.sources[0].diagnostics[0].code, "acp-list-snapshot",
            "the source says its list is the saved one"
        );
        assert!(
            session.last_activity_at > "2026-09-30T10:00:00Z".to_string(),
            "the log's later work moves the last activity past the listed time"
        );
        let unchanged = hot(&restarted, &project, &format!("codex:{id}"));
        assert_eq!(
            unchanged.updated_sessions, 0,
            "the saved read stands while the log is unchanged"
        );

        append_rollout_row(&home, &id, task_complete(&recent_source_log_timestamp()));
        let updated = list(&restarted, &project);
        assert_eq!(
            updated.sessions[0].status.state,
            idle(Some(StopReason::EndTurn))
        );

        acp_list(
            &restarted,
            "codex",
            true,
            vec![(&id, &project, LISTED_AT), ("new-one", &project, LISTED_AT)],
        );
        let listed = list(&restarted, &project);
        assert_eq!(listed.cache.mode, AgentSessionsCacheMode::Current);
        assert_eq!(listed.sessions.len(), 2);
        assert!(listed.sources[0].diagnostics.is_empty());
    }

    #[test]
    fn a_saved_list_stands_in_for_an_agent_whose_first_read_failed() {
        let (_temp, home, project) = project_dirs();
        let state = AgentSessionsState::with_home(home.clone());
        acp_list(&state, "codex", true, vec![("saved", &project, LISTED_AT)]);
        list(&state, &project);

        let restarted = AgentSessionsState::with_home(home);
        restarted
            .acp_lists
            .apply("codex", Err(svode_agents::AgentRuntimeError::Timeout), 0);
        let result = list(&restarted, &project);

        assert_eq!(result.cache.mode, AgentSessionsCacheMode::StaleSnapshot);
        assert_eq!(result.status, AgentSessionsListStatus::Partial);
        assert_eq!(result.sources[0].status, AgentSessionSourceStatus::Stale);
        assert!(result.sessions.iter().any(|s| s.id == "codex:saved"));
    }

    /// The scanners' catalogue cache of earlier versions holds sessions
    /// built from native history files; it is dropped, not shown.
    #[test]
    fn the_scanner_cache_of_an_earlier_version_is_dropped() {
        let (_temp, home, project) = project_dirs();
        let db = super::super::cache::cache_db_path(&project);
        tauri::async_runtime::block_on(async {
            let pool = sqlx::SqlitePool::connect_with(
                sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(&db)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
            sqlx::query("CREATE TABLE source_cache (source TEXT PRIMARY KEY NOT NULL, fingerprint TEXT NOT NULL, candidates_json TEXT NOT NULL, report_json TEXT NOT NULL, updated_at TEXT NOT NULL)")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO source_cache VALUES ('codex', 'f', '[]', '{}', 'now')")
                .execute(&pool)
                .await
                .unwrap();
            pool.close().await;
        });

        let state = AgentSessionsState::with_home(home);
        assert!(list(&state, &project).sessions.is_empty());
        acp_list(&state, "codex", true, vec![("s1", &project, LISTED_AT)]);
        list(&state, &project);

        let tables: Vec<String> = tauri::async_runtime::block_on(async {
            let pool = sqlx::SqlitePool::connect_with(
                sqlx::sqlite::SqliteConnectOptions::new().filename(&db),
            )
            .await
            .unwrap();
            let tables = sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type = 'table'")
                .fetch_all(&pool)
                .await
                .unwrap();
            pool.close().await;
            tables
        });
        assert_eq!(tables, ["acp_list_snapshot"]);
    }

    #[test]
    fn corrupt_agent_sessions_cache_is_quarantined_and_rebuilt_in_place() {
        let (_temp, home, project) = project_dirs();
        fs::write(project.join(".svode/agent-sessions.db"), "not sqlite")
            .expect("corrupt cache fixture");

        let state = AgentSessionsState::with_home(home.clone());
        acp_list(
            &state,
            "codex",
            true,
            vec![("recovered", &project, LISTED_AT)],
        );
        let result = list(&state, &project);
        assert_eq!(result.sessions[0].source_session_id, "recovered");
        assert!(
            fs::read_dir(project.join(".svode"))
                .unwrap()
                .flatten()
                .any(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .contains("agent-sessions.db.corrupt-"))
        );

        let restarted = AgentSessionsState::with_home(home);
        assert!(
            list(&restarted, &project)
                .sessions
                .iter()
                .any(|s| s.id == "codex:recovered")
        );
    }

    #[test]
    fn hot_status_reads_only_a_changed_log_again() {
        let (_temp, home, project) = project_dirs();
        let id = codex_id(4);
        let session_id = format!("codex:{id}");
        let state = AgentSessionsState::with_home(home.clone());
        listed_codex(
            &state,
            &home,
            &project,
            &id,
            vec![task_started(&recent_source_log_timestamp())],
        );
        assert_eq!(
            list(&state, &project).sessions[0].status.state,
            SessionState::Running
        );

        let unchanged = hot(&state, &project, &session_id);
        assert_eq!(unchanged.checked_sessions, 1);
        assert_eq!(unchanged.updated_sessions, 0);

        append_rollout_row(
            &home,
            &id,
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
        let changed = hot(&state, &project, &session_id);
        assert_eq!(changed.updated_sessions, 1);
        assert_eq!(changed.sessions[0].status.state, PERMISSION);

        append_rollout_row(&home, &id, task_complete(&recent_source_log_timestamp()));
        let done = hot(&state, &project, &session_id);
        assert_eq!(
            done.sessions[0].status.state,
            idle(Some(StopReason::EndTurn))
        );
        assert_eq!(
            done.sessions[0].status.source,
            StatusSource::NativeStatusReader
        );

        let missing = hot(&state, &project, "codex:not-listed");
        assert_eq!(missing.checked_sessions, 0);
        assert_eq!(missing.skipped_sessions, 1);
    }

    #[test]
    fn agent_sessions_open_managed_shell_without_evidence_is_unknown() {
        let (_temp, home, project) = project_dirs();
        let state = AgentSessionsState::with_home(home);
        acp_list(
            &state,
            "codex",
            true,
            vec![("live-shell", &project, LISTED_AT)],
        );

        let result = list_with(
            &state,
            &project,
            vec![surface(
                "pty-live",
                AgentAdapterKind::Codex.id(),
                "live-shell",
                None,
            )],
        );

        let session = &result.sessions[0];
        assert_eq!(session.status.state, SessionState::Unknown);
        assert_eq!(session.status.source, StatusSource::None);
        assert!(session.runtime.as_ref().expect("runtime").live);
    }

    #[test]
    fn agent_sessions_terminal_waiting_evidence_overlays_active_status() {
        let (_temp, home, project) = project_dirs();
        let state = AgentSessionsState::with_home(home);
        acp_list(
            &state,
            "codex",
            true,
            vec![("needs-approval", &project, LISTED_AT)],
        );

        let result = list_with(
            &state,
            &project,
            vec![surface(
                "pty-approval",
                AgentAdapterKind::Codex.id(),
                "needs-approval",
                Some(evidence(PERMISSION, "approval prompt")),
            )],
        );

        let session = &result.sessions[0];
        assert_eq!(session.status.state, PERMISSION);
        assert_eq!(session.status.source, StatusSource::ManagedPty);
        assert_eq!(session.status.confidence, StatusConfidence::Approximate);
        assert_eq!(
            session.waiting_since.as_deref(),
            Some("2026-07-04T10:01:00Z")
        );
    }

    fn waiting_status(call: serde_json::Value) -> (AgentSession, String) {
        let (_temp, home, project) = project_dirs();
        let id = codex_id(5);
        let waiting_ts = recent_source_log_timestamp();
        let mut call = call;
        call["timestamp"] = serde_json::Value::from(waiting_ts.clone());
        let state = AgentSessionsState::with_home(home.clone());
        listed_codex(
            &state,
            &home,
            &project,
            &id,
            vec![task_started(&recent_source_log_timestamp()), call],
        );
        (list(&state, &project).sessions.remove(0), waiting_ts)
    }

    #[test]
    fn agent_sessions_codex_tail_requests_set_native_waiting_status() {
        for (call, state) in [
            (
                serde_json::json!({
                    "type": "response_item",
                    "payload": {
                        "type": "function_call",
                        "name": "exec_command",
                        "call_id": "call-approval",
                        "arguments": "{\"cmd\":\"date\",\"sandbox_permissions\":\"require_escalated\"}"
                    }
                }),
                PERMISSION,
            ),
            (
                serde_json::json!({
                    "type": "response_item",
                    "payload": {
                        "type": "custom_tool_call",
                        "name": "apply_patch",
                        "call_id": "call-edit-approval",
                        "input": "*** Begin Patch\n*** Update File: file.txt\n@@\n-old\n+new\n*** End Patch",
                        "status": "completed"
                    }
                }),
                PERMISSION,
            ),
            (
                serde_json::json!({
                    "type": "response_item",
                    "payload": {
                        "type": "function_call",
                        "name": "request_user_input",
                        "call_id": "call-question",
                        "arguments": "{\"questions\":[]}"
                    }
                }),
                QUESTION,
            ),
            (
                serde_json::json!({
                    "type": "response_item",
                    "payload": {
                        "type": "custom_tool_call",
                        "status": "completed",
                        "call_id": "call-esc",
                        "name": "exec",
                        "input": "const r = await tools.exec_command({cmd: \"touch /tmp/outside.txt\", sandbox_permissions: \"require_escalated\"});\ntext(r.output);"
                    }
                }),
                PERMISSION,
            ),
        ] {
            let (session, waiting_ts) = waiting_status(call);
            assert_eq!(session.status.state, state);
            assert_eq!(session.status.source, StatusSource::NativeStatusReader);
            assert_eq!(session.waiting_since.as_deref(), Some(waiting_ts.as_str()));
        }
    }

    #[test]
    fn agent_sessions_stale_source_log_active_is_unknown() {
        let (_temp, home, project) = project_dirs();
        let id = codex_id(6);
        let state = AgentSessionsState::with_home(home.clone());
        listed_codex(
            &state,
            &home,
            &project,
            &id,
            vec![task_started(&stale_source_log_timestamp())],
        );

        let result = list(&state, &project);

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
        let (_temp, home, project) = project_dirs();
        let id = codex_id(9);
        let state = AgentSessionsState::with_home(home.clone());
        listed_codex(
            &state,
            &home,
            &project,
            &id,
            vec![
                task_started("2026-07-04T10:01:00Z"),
                task_complete("2026-07-04T10:02:00Z"),
            ],
        );

        let result = list_with(
            &state,
            &project,
            vec![surface(
                "pty-answered",
                AgentAdapterKind::Codex.id(),
                &id,
                Some(evidence(PERMISSION, "stale approval prompt")),
            )],
        );

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
        let (_temp, home, project) = project_dirs();
        let id = codex_id(10);
        let state = AgentSessionsState::with_home(home.clone());
        listed_codex(
            &state,
            &home,
            &project,
            &id,
            vec![task_started(&recent_source_log_timestamp())],
        );

        let result = list_with(
            &state,
            &project,
            vec![surface(
                "pty-exited",
                AgentAdapterKind::Codex.id(),
                &id,
                Some(evidence(
                    idle(None),
                    "initial agent command exited successfully",
                )),
            )],
        );

        let session = &result.sessions[0];
        assert_eq!(session.status.state, idle(None));
        assert_eq!(session.status.source, StatusSource::ManagedPty);
        assert_eq!(session.status.confidence, StatusConfidence::Exact);
    }

    #[test]
    fn agent_sessions_terminal_completion_exit_code_overlays_failed_status() {
        let (_temp, home, project) = project_dirs();
        let state = AgentSessionsState::with_home(home);
        acp_list(
            &state,
            "codex",
            true,
            vec![("exit-failed", &project, LISTED_AT)],
        );
        let mut failed_surface = surface(
            "pty-exit",
            AgentAdapterKind::Codex.id(),
            "exit-failed",
            None,
        );
        failed_surface.finished_at = Some("2026-07-04T10:02:00Z".to_string());
        failed_surface.exit_code = Some(2);
        failed_surface.failure_reason = Some("initial command failed".to_string());

        let result = list_with(&state, &project, vec![failed_surface]);

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
        let (_temp, home, project) = project_dirs();
        let state = AgentSessionsState::with_home(home);
        acp_list(
            &state,
            "codex",
            true,
            vec![
                ("failed", &project, LISTED_AT),
                ("stopped", &project, LISTED_AT),
            ],
        );

        let result = list_with(
            &state,
            &project,
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
        );

        assert_eq!(
            by_id(&result, "codex:failed").status.state,
            idle(Some(StopReason::Error))
        );
        assert_eq!(
            by_id(&result, "codex:stopped").status.state,
            idle(Some(StopReason::Interrupted))
        );
    }

    fn list_one_session_with_evidence(
        session_id: &str,
        evidences: Vec<AgentTerminalStatusEvidence>,
    ) -> AgentSession {
        let (_temp, home, project) = project_dirs();
        let state = AgentSessionsState::with_home(home);
        acp_list(
            &state,
            "codex",
            true,
            vec![(session_id, &project, LISTED_AT)],
        );
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
        list_with(&state, &project, surfaces).sessions.remove(0)
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

    /// C8: neither the list nor the saved snapshot carries transcript or
    /// tool payload.
    #[test]
    fn the_list_and_its_snapshot_exclude_tool_input() {
        let (_temp, home, project) = project_dirs();
        let id = codex_id(11);
        let state = AgentSessionsState::with_home(home.clone());
        listed_codex(
            &state,
            &home,
            &project,
            &id,
            vec![
                serde_json::json!({
                    "type": "response_item",
                    "payload": {"role": "user", "content": [{"type": "input_text", "text": "SECRET_PROMPT"}]},
                    "timestamp": "2026-07-04T10:00:00Z"
                }),
                serde_json::json!({
                    "type": "response_item",
                    "payload": {
                        "type": "function_call",
                        "name": "exec_command",
                        "call_id": "c1",
                        "arguments": "{\"cmd\":\"echo SECRET_TOOL_INPUT\"}"
                    },
                    "timestamp": "2026-07-04T10:01:00Z"
                }),
            ],
        );

        let result = list(&state, &project);
        let serialized = serde_json::to_string(&result).expect("serialize dto");
        assert_eq!(result.sessions.len(), 1);
        assert!(!serialized.contains("SECRET"));

        let db = super::super::cache::cache_db_path(&project);
        let saved: Vec<String> = tauri::async_runtime::block_on(async {
            let pool = sqlx::SqlitePool::connect_with(
                sqlx::sqlite::SqliteConnectOptions::new().filename(&db),
            )
            .await
            .unwrap();
            let rows = sqlx::query_scalar("SELECT list_json FROM acp_list_snapshot")
                .fetch_all(&pool)
                .await
                .unwrap();
            pool.close().await;
            rows
        });
        assert_eq!(saved.len(), 1);
        assert!(!saved[0].contains("SECRET"));
    }

    /// An agent the code does not name (a custom or test agent, or a new
    /// built-in one) reaches the Sessions catalogue under its own id from its
    /// list alone: no consumer keeps a list of agents.
    #[test]
    fn an_agent_with_a_list_is_a_sessions_source_under_its_own_id() {
        let (_temp, home, project) = project_dirs();
        let state = AgentSessionsState::with_home(home);
        acp_list(
            &state,
            "test-agent",
            false,
            vec![("t1", &project, LISTED_AT)],
        );

        let result = list(&state, &project);

        let session = by_id(&result, "test-agent:acp:t1");
        assert_eq!(session.source.as_str(), "test-agent");
        assert!(session.resume_command.is_none());
        assert!(
            result
                .sources
                .iter()
                .any(|report| report.source.as_str() == "test-agent")
        );
    }

    #[test]
    fn acp_listed_sessions_are_scoped_to_their_space_in_their_own_namespace() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        let child = project.join("dev");
        fs::create_dir_all(&child).expect("child");
        write_root_config(&project, vec![space_ref("dev-space", "dev", None)]);
        let same_id = codex_id(12);
        write_rollout(&home, &same_id, vec![task_complete("2026-07-04T10:00:00Z")]);
        let elsewhere = temp.path().join("elsewhere");

        let state = AgentSessionsState::with_home(home);
        acp_list(
            &state,
            "codex",
            false,
            vec![
                (same_id.as_str(), &project, LISTED_AT),
                ("in-child", &child, LISTED_AT),
                ("unrelated", &elsewhere, LISTED_AT),
                ("no-time", &project, None),
            ],
        );
        let result = list(&state, &project);

        let mut ids: Vec<_> = result.sessions.iter().map(|s| s.id.as_str()).collect();
        ids.sort();
        let same_key = format!("codex:acp:{same_id}");
        assert_eq!(ids, [same_key.as_str(), "codex:acp:in-child"]);
        let same = by_id(&result, &same_key);
        assert_eq!(
            same.status,
            SessionStatus::unknown(),
            "an ACP id without equality evidence never reads a native log"
        );
        let child_session = by_id(&result, "codex:acp:in-child");
        assert_eq!(child_session.space_id.as_deref(), Some("dev-space"));
        assert_eq!(child_session.title, "ACP in-child");
        assert_eq!(
            child_session.title_source,
            crate::agent_sessions::types::AgentSessionTitleSource::CliTitle
        );
        assert_eq!(child_session.last_activity_at, "2026-09-30T10:00:00Z");
        assert!(child_session.resume_command.is_none());
        assert!(!child_session.capabilities.can_resume);

        let report = &result.sources[0];
        assert_eq!(report.source, AgentAdapterKind::Codex.id());
        assert_eq!(report.counts.returned_sessions, 2);
        assert_eq!(report.counts.unresolved_candidates, 1);
        assert_eq!(report.counts.incomplete_candidates, 1);
        assert_eq!(result.status, AgentSessionsListStatus::Ok);
    }

    #[test]
    fn a_managed_terminal_never_attaches_to_a_session_in_the_acp_namespace() {
        let (_temp, home, project) = project_dirs();
        let state = AgentSessionsState::with_home(home);
        acp_list(&state, "codex", false, vec![("s1", &project, LISTED_AT)]);
        let result = list_with(
            &state,
            &project,
            vec![surface("pty-1", AgentAdapterKind::Codex.id(), "s1", None)],
        );

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
        let (_temp, home, project) = project_dirs();
        let state = AgentSessionsState::with_home(home);
        acp_list(
            &state,
            "claude-code",
            true,
            vec![("c1", &project, LISTED_AT)],
        );
        acp_list(&state, "codex", true, vec![("x1", &project, LISTED_AT)]);
        state.acp_lists.apply(
            "claude-code",
            Err(svode_agents::AgentRuntimeError::Timeout),
            0,
        );

        let result = list(&state, &project);

        assert_eq!(result.status, AgentSessionsListStatus::Partial);
        assert!(result.sessions.iter().any(|s| s.id == "claude-code:c1"));
        assert!(result.sessions.iter().any(|s| s.id == "codex:x1"));
        let status_of = |agent: AgentAdapterKind| {
            result
                .sources
                .iter()
                .find(|report| report.source == agent.id())
                .unwrap()
                .status
        };
        assert_eq!(
            status_of(AgentAdapterKind::ClaudeCode),
            AgentSessionSourceStatus::Stale
        );
        assert_eq!(
            status_of(AgentAdapterKind::Codex),
            AgentSessionSourceStatus::Ok
        );
    }
}

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use chrono::{DateTime, SecondsFormat, Utc};
use svode_agents::catalog::{ListedSession, RuntimeSession};
use svode_agents::identity::{IdentityNamespace, SessionKey};
use svode_agents::status::SessionState;
use svode_core::agent_adapters::AgentId;

use super::AgentSessionsState;
use super::cache::{CatalogSourceKey, SavedList, SavedSession};
use super::live_status::{
    map_listed, map_provisional_surface, map_runtime_session, overlay_runtime,
};
use super::native_catalog::{CatalogEntry, NativeListing};
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

/// One catalogue source of an agent as the project's list builds it (Stage
/// 10 `07` N2): its ACP list or a native store, read by this process or,
/// until it is, the list saved before the app started.
struct AgentCatalog {
    key: CatalogSourceKey,
    sessions: Vec<CatalogEntry>,
    report: AgentSessionSourceReport,
    read_at: Option<DateTime<Utc>>,
    snapshot: bool,
}

/// A listed session of the project with its scope and last activity.
struct ScopedSession {
    listed: ListedSession,
    listing: Option<NativeListing>,
    scope: AgentSessionScope,
    last_activity_at: DateTime<Utc>,
}

pub(crate) fn list_sessions(
    state: &AgentSessionsState,
    project_path: String,
    terminal_surfaces: Vec<AgentTerminalSurface>,
    runtime_sessions: Vec<RuntimeSession>,
) -> Result<AgentSessionsListResult, AppError> {
    list(
        state,
        project_path,
        terminal_surfaces,
        runtime_sessions,
        true,
    )
}

/// The list of a project no window works with, such as an expanded project
/// of Home: the same merge over the lists this process already holds and the
/// lists saved in the project, which it does not write.
pub(crate) fn list_saved_sessions(
    state: &AgentSessionsState,
    project_path: String,
    terminal_surfaces: Vec<AgentTerminalSurface>,
    runtime_sessions: Vec<RuntimeSession>,
) -> Result<AgentSessionsListResult, AppError> {
    list(
        state,
        project_path,
        terminal_surfaces,
        runtime_sessions,
        false,
    )
}

fn list(
    state: &AgentSessionsState,
    project_path: String,
    terminal_surfaces: Vec<AgentTerminalSurface>,
    runtime_sessions: Vec<RuntimeSession>,
    save_lists: bool,
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
        let source = catalog.key.agent.clone();
        let mut report = catalog.report;
        let scoped = scoped_sessions(&scope_index, &state.home_dir, catalog.sessions, &mut report);
        let mut native = read_native(state, &source, &scoped);
        if let Some(problem) = &native.problem {
            report_native_problem(&mut report, problem);
        }
        // A custom agent's id is of this device and the agent may be removed:
        // its list is read again once its connection opens, never saved
        // into the project.
        if let Some(read_at) = catalog
            .read_at
            .filter(|_| save_lists && !source.is_custom())
        {
            let saved = scoped
                .iter()
                .map(|session| SavedSession {
                    listed: session.listed.clone(),
                    native: native
                        .sessions
                        .get(&session.listed.key.session_id)
                        .map(|native| native.read.clone()),
                    listing: session.listing.clone(),
                })
                .collect();
            state.snapshots.save(
                &project,
                &catalog.key,
                SavedList {
                    read_at,
                    sessions: saved,
                },
            );
        }
        for session in scoped {
            let read = native.sessions.remove(&session.listed.key.session_id);
            sessions.push(map_listed(
                source.clone(),
                session.listed,
                session.listing,
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

    apply_runtime_sessions(
        &mut sessions,
        &runtime_sessions,
        &scope_index,
        &state.home_dir,
        None,
    );
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
    runtime_sessions: Vec<RuntimeSession>,
) -> Result<AgentSessionsHotStatusResult, AppError> {
    let project = normalize_project_path(&project_path)?;
    let scope_index = ScopeIndex::new(&project, load_child_spaces(&project)?)?;
    let generated_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let requested = session_ids.into_iter().collect::<HashSet<_>>();
    let mut sessions = Vec::new();
    let mut checked_sessions = 0usize;
    let mut updated_sessions = 0usize;

    for catalog in catalogs(state, &project) {
        let source = catalog.key.agent.clone();
        let listed = catalog
            .sessions
            .into_iter()
            .filter(|entry| entry_ids(&source, entry).any(|id| requested.contains(&id)))
            .collect::<Vec<_>>();
        checked_sessions += listed.len();
        let mut report = catalog.report;
        let scoped = scoped_sessions(&scope_index, &state.home_dir, listed, &mut report);
        let mut native = read_native(state, &source, &scoped);
        updated_sessions += native.reparsed;
        for session in scoped {
            let read = native.sessions.remove(&session.listed.key.session_id);
            sessions.push(map_listed(
                source.clone(),
                session.listed,
                session.listing,
                read,
                session.scope,
                session.last_activity_at,
                &terminal_surfaces,
            ));
        }
    }
    apply_runtime_sessions(
        &mut sessions,
        &runtime_sessions,
        &scope_index,
        &state.home_dir,
        Some(&requested),
    );
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

/// Every catalogue source of the project: its last good read of this
/// process, else the list saved for the project before the app started.
/// The sources of one agent cover disjoint origins (Stage 10 `07` N2), so
/// their sessions never share a key.
fn catalogs(state: &AgentSessionsState, project: &Path) -> Vec<AgentCatalog> {
    let mut saved = state.snapshots.lists(project, |lists| {
        for (key, list) in lists {
            for session in &list.sessions {
                if let Some(read) = &session.native {
                    state.native_status.seed(
                        &key.agent,
                        &session.listed.key.session_id,
                        read.clone(),
                    );
                }
            }
        }
    });
    let acp = state
        .acp_lists
        .reads()
        .into_iter()
        .map(|read| AgentCatalog {
            key: CatalogSourceKey::acp(read.source),
            sessions: read
                .sessions
                .into_iter()
                .map(CatalogEntry::listed)
                .collect(),
            report: read.report,
            read_at: read.read_at,
            snapshot: false,
        });
    let native = state
        .native_catalogs
        .reads()
        .into_iter()
        .map(|read| AgentCatalog {
            key: CatalogSourceKey {
                agent: read.source,
                store: Some(read.store),
            },
            sessions: read.sessions,
            report: read.report,
            read_at: read.read_at,
            snapshot: false,
        });
    let mut catalogs = Vec::new();
    for mut catalog in acp.chain(native) {
        let saved_list = saved.remove(&catalog.key);
        if catalog.read_at.is_none()
            && let Some(list) = saved_list
        {
            show_saved(&mut catalog, list);
        }
        catalogs.push(catalog);
    }
    for (key, list) in saved {
        let mut catalog = AgentCatalog {
            report: AgentSessionSourceReport::new(key.agent.clone()),
            key,
            sessions: Vec::new(),
            read_at: None,
            snapshot: false,
        };
        show_saved(&mut catalog, list);
        catalogs.push(catalog);
    }
    catalogs.sort_by(|left, right| left.key.cmp(&right.key));
    catalogs
}

fn show_saved(catalog: &mut AgentCatalog, list: SavedList) {
    catalog.sessions = list
        .sessions
        .into_iter()
        .map(|session| CatalogEntry {
            listed: session.listed,
            listing: session.listing,
        })
        .collect();
    catalog.read_at = Some(list.read_at);
    catalog.snapshot = true;
    catalog.report.read_at = Some(list.read_at.to_rfc3339_opts(SecondsFormat::Secs, true));
    catalog.report.counts.records_read = catalog.sessions.len();
    catalog.report.counts.candidates = catalog.sessions.len();
    let (code, message) = match catalog.key.store {
        None => (
            "acp-list-snapshot",
            "Showing the session list saved before the app started; it updates once the agent's connection opens",
        ),
        Some(_) => (
            "native-catalog-snapshot",
            "Showing the session list saved before the app started; it updates once the agent's store is read",
        ),
    };
    catalog
        .report
        .push_diagnostic(AgentSessionDiagnosticSeverity::Info, code, message);
}

/// The catalogue ids that address an entry: its own and those of the other
/// links of its conversation (Stage 10 `07` N2).
fn entry_ids<'a>(
    source: &'a AgentId,
    entry: &'a CatalogEntry,
) -> impl Iterator<Item = String> + 'a {
    std::iter::once(catalog_session_id(source, &entry.listed.key)).chain(
        entry
            .listing
            .iter()
            .flat_map(|listing| listing.aliases.iter())
            .map(move |alias| {
                catalog_session_id(
                    source,
                    &SessionKey {
                        session_id: alias.clone(),
                        ..entry.listed.key.clone()
                    },
                )
            }),
    )
}

/// The listed sessions that belong to the project and have a last activity.
/// A session of a multi-root workspace takes the first of its folders the
/// project holds (Stage 10 `07` N2).
fn scoped_sessions(
    scope_index: &ScopeIndex,
    home: &Path,
    listed: Vec<CatalogEntry>,
    report: &mut AgentSessionSourceReport,
) -> Vec<ScopedSession> {
    listed
        .into_iter()
        .filter_map(|CatalogEntry { listed, listing }| {
            let folders = listing.iter().flat_map(|listing| listing.folders.iter());
            let Some(scope) = std::iter::once(&listed.cwd)
                .chain(folders)
                .find_map(|cwd| resolve_scope(scope_index, cwd, home))
            else {
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
                listing,
                scope,
                last_activity_at,
            })
        })
        .collect()
}

/// Native status of the sessions whose id is the agent's native id; the
/// store of an agent the user disabled is not read (Stage 10 `07` N1).
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
    if ids.is_empty() || !state.native_catalogs.reads_store(source) {
        return NativeReads::default();
    }
    state.native_status.read(source, &ids)
}

/// The agent's native status source could not be read (Stage 10 `07` N5):
/// the source's diagnostic, named by the agent, and its sessions without a
/// native status; the agent's list and the other agents stay as they are.
fn report_native_problem(report: &mut AgentSessionSourceReport, problem: &str) {
    let agent = report
        .source
        .builtin()
        .map_or(report.source.as_str(), |agent| agent.display_name())
        .to_string();
    report.status = AgentSessionSourceStatus::Stale;
    report.push_diagnostic(
        AgentSessionDiagnosticSeverity::Warning,
        "native-status-unavailable",
        format!("The session status of {agent} cannot be read: {problem}"),
    );
}

/// Sessions the runtime drives: laid over their listed record, or their own
/// record of the project until their agent lists them.
fn apply_runtime_sessions(
    sessions: &mut Vec<AgentSession>,
    runtime_sessions: &[RuntimeSession],
    scope_index: &ScopeIndex,
    home: &Path,
    requested: Option<&HashSet<String>>,
) {
    for runtime in runtime_sessions {
        let Ok(source) = AgentId::parse(&runtime.key.agent) else {
            continue;
        };
        let id = catalog_session_id(&source, &runtime.key);
        if let Some(listed) = sessions
            .iter_mut()
            .find(|session| session.is_addressed_by(&id))
        {
            overlay_runtime(listed, runtime);
            continue;
        }
        if requested.is_some_and(|ids| !ids.contains(&id)) {
            continue;
        }
        let Some(scope) = resolve_scope(scope_index, &runtime.cwd, home) else {
            continue;
        };
        sessions.push(map_runtime_session(source, runtime, scope));
    }
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
    use crate::agent_sessions::types::{
        AgentSessionScopeConfidence, AgentSessionScopeKind, AgentSessionScopeStatus,
    };
    use crate::agent_sessions::types::{catalog_session_key, terminal_resume_argv};
    use crate::terminal::{AgentTerminalStatusEvidence, AgentTerminalSurface};
    use svode_agents::catalog::SessionList;
    use svode_agents::identity::SessionKey;
    use svode_agents::status::{
        InteractionKind, SessionStatus, StatusConfidence, StatusSource, StopReason,
    };
    use svode_agents::writer::ExternalLiveness;
    use svode_core::agent_adapters::AgentAdapterKind;

    use crate::agent_sessions::native_status::process::ProcessRecord;
    use crate::agent_sessions::native_status::{
        NativeLogRead, NativeStatusEvidence, NativeStatusSource, SourceReads,
    };
    use std::collections::HashMap;
    use std::sync::Arc;

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
        list_sessions(
            state,
            project.to_string_lossy().into_owned(),
            surfaces,
            Vec::new(),
        )
        .expect("list sessions")
    }

    fn hot(state: &AgentSessionsState, project: &Path, id: &str) -> AgentSessionsHotStatusResult {
        hot_status(
            state,
            project.to_string_lossy().into_owned(),
            vec![id.to_string()],
            Vec::new(),
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
            initial_agent_argv: terminal_resume_argv(&source, source_session_id, None)
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

    /// Every file under the directory with its contents.
    fn files_of(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let mut files = Vec::new();
        let mut pending = vec![dir.to_path_buf()];
        while let Some(current) = pending.pop() {
            for entry in fs::read_dir(&current).expect("read dir") {
                let path = entry.expect("entry").path();
                if path.is_dir() {
                    pending.push(path);
                } else {
                    let contents = fs::read(&path).expect("read file");
                    files.push((path, contents));
                }
            }
        }
        files.sort();
        files
    }

    fn list_saved(state: &AgentSessionsState, project: &Path) -> AgentSessionsListResult {
        list_saved_sessions(
            state,
            project.to_string_lossy().into_owned(),
            Vec::new(),
            Vec::new(),
        )
        .expect("list saved sessions")
    }

    /// Stage 10 `09`, invariant 6: a project no window works with shows the
    /// lists this process holds and the ones saved in the project, and its
    /// read writes nothing into the project.
    #[test]
    fn a_saved_read_shows_held_and_saved_lists_and_writes_nothing() {
        let (_temp, home, project) = project_dirs();
        let state = AgentSessionsState::with_home(home.clone());
        acp_list(&state, "codex", true, vec![("held", &project, LISTED_AT)]);
        let before = files_of(&project);

        let held = list_saved(&state, &project);

        assert!(held.sessions.iter().any(|s| s.id == "codex:held"));
        assert_eq!(
            files_of(&project),
            before,
            "the read writes no saved list into the project"
        );

        list(&state, &project);
        let restarted = AgentSessionsState::with_home(home);
        let saved = list_saved(&restarted, &project);

        assert_eq!(saved.cache.mode, AgentSessionsCacheMode::StaleSnapshot);
        assert!(saved.sessions.iter().any(|s| s.id == "codex:held"));
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

    fn runtime_session(agent: &str, id: &str, native: bool, cwd: &Path) -> RuntimeSession {
        RuntimeSession {
            key: SessionKey::from_acp(agent, id, native),
            cwd: cwd.to_path_buf(),
            title: Some("Fix the login bug".into()),
            status: SessionStatus::runtime(SessionState::Running),
            started_at: std::time::SystemTime::now(),
            updated_at: std::time::SystemTime::now(),
        }
    }

    fn list_with_runtime(
        state: &AgentSessionsState,
        project: &Path,
        runtime: Vec<RuntimeSession>,
    ) -> AgentSessionsListResult {
        list_sessions(
            state,
            project.to_string_lossy().into_owned(),
            Vec::new(),
            runtime,
        )
        .expect("list sessions")
    }

    #[test]
    fn a_runtime_session_is_listed_in_its_space_before_its_agent_lists_it() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        let child = project.join("dev");
        fs::create_dir_all(&child).expect("child");
        write_root_config(&project, vec![space_ref("dev-space", "dev", None)]);
        let state = AgentSessionsState::with_home(home);
        let elsewhere = temp.path().join("elsewhere");

        let result = list_with_runtime(
            &state,
            &project,
            vec![
                runtime_session("codex", "n1", true, &child),
                runtime_session("custom-local", "c1", false, &project),
                runtime_session("codex", "other", true, &elsewhere),
            ],
        );

        let mut ids: Vec<_> = result.sessions.iter().map(|s| s.id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, ["codex:n1", "custom-local:acp:c1"]);
        let created = by_id(&result, "codex:n1");
        assert_eq!(created.space_id.as_deref(), Some("dev-space"));
        assert_eq!(created.title, "Fix the login bug");
        assert_eq!(
            created.status,
            SessionStatus::runtime(SessionState::Running)
        );
        assert_eq!(
            created
                .runtime
                .as_ref()
                .and_then(|runtime| runtime.acp_session.clone()),
            Some(SessionKey::from_acp("codex", "n1", true))
        );
        assert!(created.resume_command.is_some());
        let custom = by_id(&result, "custom-local:acp:c1");
        assert!(custom.resume_command.is_none());
        assert!(!custom.capabilities.can_resume);
        // Both open in the chat under the key the runtime drives them by.
        assert!(created.capabilities.can_open_in_chat && custom.capabilities.can_open_in_chat);
        assert_eq!(
            catalog_session_key(created),
            Some(SessionKey::from_acp("codex", "n1", true))
        );
        assert_eq!(
            catalog_session_key(custom),
            Some(SessionKey::from_acp("custom-local", "c1", false))
        );
        // The runtime record never reaches the saved list of the project.
        assert!(
            state
                .snapshots
                .lists(&project, |_| ())
                .values()
                .all(|list| list.sessions.is_empty())
        );
    }

    #[test]
    fn a_listed_session_the_runtime_drives_stays_one_record_with_the_runtime_status() {
        let (_temp, home, project) = project_dirs();
        let state = AgentSessionsState::with_home(home);
        let id = codex_id(21);
        acp_list(
            &state,
            "codex",
            true,
            vec![(id.as_str(), &project, LISTED_AT)],
        );

        let result = list_with_runtime(
            &state,
            &project,
            vec![runtime_session("codex", &id, true, &project)],
        );

        let key = format!("codex:{id}");
        assert_eq!(
            result
                .sessions
                .iter()
                .filter(|session| session.id == key)
                .count(),
            1
        );
        let session = by_id(&result, &key);
        assert_eq!(session.title, format!("ACP {id}"), "the listed title stays");
        assert_eq!(
            session.status,
            SessionStatus::runtime(SessionState::Running)
        );
        assert!(session.resume_command.is_some());
        assert_eq!(
            session
                .runtime
                .as_ref()
                .and_then(|runtime| runtime.acp_session.clone()),
            Some(SessionKey::from_acp("codex", &id, true))
        );

        let hot = hot_status(
            &state,
            project.to_string_lossy().into_owned(),
            vec![key.clone()],
            Vec::new(),
            vec![runtime_session("codex", &id, true, &project)],
        )
        .expect("hot status");
        assert_eq!(hot.sessions.len(), 1);
        assert_eq!(hot.sessions[0].status.state, SessionState::Running);
    }

    #[test]
    fn a_listed_session_opens_in_the_chat_under_its_key_in_its_directory() {
        let (_temp, home, project) = project_dirs();
        let state = AgentSessionsState::with_home(home);
        let id = codex_id(22);
        acp_list(
            &state,
            "codex",
            true,
            vec![(id.as_str(), &project, LISTED_AT)],
        );

        let target = crate::agent_sessions::chat::chat_target(
            &state,
            project.to_string_lossy().into_owned(),
            &format!("codex:{id}"),
            Vec::new(),
            Vec::new(),
        )
        .expect("chat target")
        .expect("a listed session opens in the chat");
        assert_eq!(target.agent, "codex");
        assert_eq!(target.key, SessionKey::from_acp("codex", &id, true));
        assert_eq!(
            target.cwd,
            PathBuf::from(svode_core::system_path::user_facing_path(
                &fs::canonicalize(&project).unwrap()
            )),
            "the canonical folder as the user sees it, without the verbatim prefix of Windows"
        );
        // Nothing tells whether another process writes to it.
        assert_eq!(
            target.liveness,
            svode_agents::writer::ExternalLiveness::Unknown
        );

        assert_eq!(
            crate::agent_sessions::chat::chat_target(
                &state,
                project.to_string_lossy().into_owned(),
                "codex:unknown",
                Vec::new(),
                Vec::new(),
            )
            .expect("chat target"),
            None
        );
    }

    /// A native status source of an agent of `07`, as slices 8.1–8.5 add
    /// them: its reads, or the problem of its store.
    struct StoreSource(Result<HashMap<String, NativeLogRead>, String>);

    impl NativeStatusSource for StoreSource {
        fn read(&self, ids: &[&str]) -> Result<SourceReads, String> {
            let reads = self.0.clone()?;
            Ok(SourceReads {
                sessions: reads
                    .into_iter()
                    .filter(|(id, _)| ids.contains(&id.as_str()))
                    .collect(),
                reparsed: 0,
            })
        }
    }

    fn store_read(
        state: SessionState,
        observed_at: DateTime<Utc>,
        process: Option<ProcessRecord>,
    ) -> NativeLogRead {
        NativeLogRead {
            file: None,
            companions: Vec::new(),
            status: Some(NativeStatusEvidence {
                state,
                reason: "store evidence".to_string(),
                observed_at: Some(observed_at),
                waiting_since: None,
            }),
            launch_id: None,
            process,
        }
    }

    fn hermes_with(
        state: &AgentSessionsState,
        project: &Path,
        reads: Result<Vec<(&str, NativeLogRead)>, String>,
    ) {
        let hermes = AgentAdapterKind::Hermes.id();
        let ids = match &reads {
            Ok(reads) => reads.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
            Err(_) => vec!["h1"],
        };
        acp_list(
            state,
            hermes.as_str(),
            true,
            ids.iter().map(|id| (*id, project, LISTED_AT)).collect(),
        );
        state.native_status.set_source(
            hermes,
            Arc::new(StoreSource(reads.map(|reads| {
                reads
                    .into_iter()
                    .map(|(id, read)| (id.to_string(), read))
                    .collect()
            }))),
        );
    }

    fn chat_liveness(state: &AgentSessionsState, project: &Path, id: &str) -> ExternalLiveness {
        crate::agent_sessions::chat::chat_target(
            state,
            project.to_string_lossy().into_owned(),
            id,
            Vec::new(),
            Vec::new(),
        )
        .expect("chat target")
        .expect("listed session")
        .liveness
    }

    fn live_child() -> std::process::Child {
        #[cfg(windows)]
        let mut command = {
            let mut command = std::process::Command::new("ping");
            command.args(["-n", "60", "127.0.0.1"]);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = std::process::Command::new("sleep");
            command.arg("60");
            command
        };
        command
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("spawn a child process")
    }

    fn holder(pid: u32) -> Option<ProcessRecord> {
        Some(ProcessRecord {
            pid,
            host: None,
            started_by: Utc::now() + chrono::Duration::seconds(1),
        })
    }

    #[test]
    fn an_open_turn_of_an_agent_of_07_follows_the_process_that_holds_it() {
        let (_temp, home, project) = project_dirs();
        let state = AgentSessionsState::with_home(home);
        let mut child = live_child();
        let mut exited = live_child();
        let exited_pid = exited.id();
        exited.kill().expect("kill");
        exited.wait().expect("reap");
        let recent = Utc::now() - chrono::Duration::minutes(1);
        let stale = Utc::now() - chrono::Duration::seconds(SOURCE_LOG_ACTIVE_STALE_AFTER_SECS + 60);
        hermes_with(
            &state,
            &project,
            Ok(vec![
                ("alive", store_read(PERMISSION, recent, holder(child.id()))),
                ("dead", store_read(PERMISSION, recent, holder(exited_pid))),
                ("unsignalled", store_read(PERMISSION, recent, None)),
                (
                    "unsignalled-stale",
                    store_read(SessionState::Running, stale, None),
                ),
                (
                    "closed",
                    store_read(idle(Some(StopReason::EndTurn)), recent, holder(exited_pid)),
                ),
            ]),
        );

        let result = list(&state, &project);
        let alive_liveness = chat_liveness(&state, &project, "hermes:alive");
        child.kill().ok();
        child.wait().ok();

        let status = |id: &str| by_id(&result, id).status;
        assert_eq!(status("hermes:alive").state, PERMISSION);
        assert_eq!(
            status("hermes:alive").source,
            StatusSource::NativeStatusReader
        );
        assert_eq!(
            status("hermes:alive").confidence,
            StatusConfidence::Approximate
        );
        assert_eq!(
            status("hermes:dead").state,
            idle(Some(StopReason::Interrupted))
        );
        assert_eq!(status("hermes:unsignalled").state, SessionState::Running);
        assert_eq!(
            status("hermes:unsignalled-stale").state,
            SessionState::Unknown
        );
        assert_eq!(
            status("hermes:closed").state,
            idle(Some(StopReason::EndTurn))
        );

        assert_eq!(alive_liveness, ExternalLiveness::ExternalActive);
        for id in [
            "hermes:dead",
            "hermes:unsignalled",
            "hermes:unsignalled-stale",
            "hermes:closed",
        ] {
            assert_eq!(
                chat_liveness(&state, &project, id),
                ExternalLiveness::Unknown,
                "{id}"
            );
        }
    }

    #[test]
    fn a_native_running_codex_turn_stays_another_writer() {
        let (_temp, home, project) = project_dirs();
        let state = AgentSessionsState::with_home(home.clone());
        let id = codex_id(31);
        listed_codex(
            &state,
            &home,
            &project,
            &id,
            vec![task_started(&recent_source_log_timestamp())],
        );

        assert_eq!(
            chat_liveness(&state, &project, &format!("codex:{id}")),
            ExternalLiveness::ExternalActive
        );
    }

    #[test]
    fn an_unreadable_native_store_is_a_diagnostic_of_its_agent_alone() {
        let (_temp, home, project) = project_dirs();
        let state = AgentSessionsState::with_home(home.clone());
        let id = codex_id(32);
        listed_codex(
            &state,
            &home,
            &project,
            &id,
            vec![task_started(&recent_source_log_timestamp())],
        );
        hermes_with(
            &state,
            &project,
            Err("state.db cannot be opened".to_string()),
        );

        let result = list(&state, &project);

        assert_eq!(result.status, AgentSessionsListStatus::Partial);
        let hermes = result
            .sources
            .iter()
            .find(|report| report.source == AgentAdapterKind::Hermes.id())
            .expect("hermes report");
        assert_eq!(hermes.status, AgentSessionSourceStatus::Stale);
        let diagnostic = &hermes.diagnostics[0];
        assert_eq!(diagnostic.code, "native-status-unavailable");
        assert!(
            diagnostic.message.contains("Hermes"),
            "{}",
            diagnostic.message
        );
        assert!(diagnostic.message.contains("state.db cannot be opened"));
        assert_eq!(by_id(&result, "hermes:h1").status, SessionStatus::unknown());

        let codex = result
            .sources
            .iter()
            .find(|report| report.source == AgentAdapterKind::Codex.id())
            .expect("codex report");
        assert_eq!(codex.status, AgentSessionSourceStatus::Ok);
        assert!(codex.diagnostics.is_empty());
        assert_eq!(
            by_id(&result, &format!("codex:{id}")).status.state,
            SessionState::Running
        );
    }

    #[test]
    fn an_unknown_status_value_is_an_unknown_session_without_a_diagnostic() {
        let (_temp, home, project) = project_dirs();
        let state = AgentSessionsState::with_home(home);
        hermes_with(
            &state,
            &project,
            Ok(vec![(
                "h1",
                store_read(SessionState::Unknown, Utc::now(), None),
            )]),
        );

        let result = list(&state, &project);

        assert_eq!(result.status, AgentSessionsListStatus::Ok);
        assert!(
            result
                .sources
                .iter()
                .all(|report| report.diagnostics.is_empty())
        );
        let session = by_id(&result, "hermes:h1");
        assert_eq!(session.status.state, SessionState::Unknown);
        assert_eq!(session.status.source, StatusSource::NativeStatusReader);
    }

    /// The Hermes store of the device in `home`, read by the catalogue as
    /// the list triggers read it.
    fn hermes_store(state: &AgentSessionsState, home: &Path, sql: &str) {
        crate::agent_sessions::native_status::hermes::tests::store(
            &home.join(".hermes/state.db"),
            sql,
        );
        read_hermes_store(state);
    }

    fn read_hermes_store(state: &AgentSessionsState) {
        let reads = state.native_catalogs.refresh(&[AgentAdapterKind::Hermes]);
        tauri::async_runtime::block_on(async {
            for read in reads {
                read.await.expect("native catalogue read");
            }
        });
    }

    fn hermes_session(id: &str, source: &str, cwd: &Path, extra: &str) -> String {
        crate::agent_sessions::native_status::hermes::tests::session(
            id,
            source,
            Some(&cwd.to_string_lossy()),
            extra,
        )
    }

    fn hermes_answer(id: &str) -> String {
        format!(
            "INSERT INTO messages (session_id, role, content, timestamp, finish_reason) \
             VALUES ('{id}', 'assistant', 'not read', 1800000000, 'stop');"
        )
    }

    /// An ACP conversation compressed from `r` into `t`, an external CLI
    /// session in the project and one outside it.
    fn hermes_conversations(project: &Path, elsewhere: &Path) -> String {
        [
            hermes_session("r", "acp", project, "end_reason = 'compression'"),
            hermes_session(
                "t",
                "acp",
                project,
                "parent_session_id = 'r', started_at = 1800000200",
            ),
            hermes_answer("t"),
            hermes_session("cli", "cli", project, ""),
            hermes_answer("cli"),
            hermes_session("away", "cli", elsewhere, ""),
        ]
        .concat()
    }

    #[test]
    fn a_hermes_conversation_is_one_record_under_its_root_that_continues_at_its_tip() {
        let (temp, home, project) = project_dirs();
        let elsewhere = temp.path().join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        let state = AgentSessionsState::with_home(home.clone());
        hermes_store(&state, &home, &hermes_conversations(&project, &elsewhere));

        let result = list(&state, &project);
        let mut ids = result
            .sessions
            .iter()
            .map(|session| session.id.as_str())
            .collect::<Vec<_>>();
        ids.sort();
        assert_eq!(ids, ["hermes:cli", "hermes:r"]);
        let report = result
            .sources
            .iter()
            .find(|report| report.source == AgentAdapterKind::Hermes.id())
            .expect("hermes report");
        assert_eq!(report.status, AgentSessionSourceStatus::Ok);

        let chain = by_id(&result, "hermes:r");
        assert_eq!(chain.alias_ids, ["hermes:t"]);
        assert_eq!(chain.scope_kind, AgentSessionScopeKind::Project);
        assert!(chain.capabilities.can_open_in_chat);
        let resume = chain.resume_command.as_ref().expect("resume command");
        assert_eq!(resume.program, "hermes");
        assert_eq!(resume.args, ["-p", "default", "--resume", "t"]);
        assert_eq!(
            chain.status.state,
            idle(Some(StopReason::EndTurn)),
            "the last message of the tip"
        );
        assert_eq!(chain.status.source, StatusSource::NativeStatusReader);

        let external = by_id(&result, "hermes:cli");
        assert!(
            !external.capabilities.can_open_in_chat,
            "Hermes loads only its ACP origin over ACP"
        );
        assert!(external.capabilities.can_resume);
        assert_eq!(
            external.resume_command.as_ref().unwrap().args,
            ["-p", "default", "--resume", "cli"]
        );

        let chat = |id: &str| {
            crate::agent_sessions::chat::chat_target(
                &state,
                project.to_string_lossy().into_owned(),
                id,
                Vec::new(),
                Vec::new(),
            )
            .expect("chat target")
        };
        let target = chat("hermes:r").expect("an ACP conversation opens in the chat");
        assert_eq!(target.key, SessionKey::from_acp("hermes", "t", true));
        assert_eq!(
            chat("hermes:t").expect("a key of another link").key,
            target.key
        );
        assert_eq!(chat("hermes:cli"), None, "an external session is not");

        let hot = hot(&state, &project, "hermes:t");
        assert_eq!(hot.sessions.len(), 1);
        assert_eq!(hot.sessions[0].id, "hermes:r");

        // The chat drives the tip: still the one record of the root.
        let result = list_with_runtime(
            &state,
            &project,
            vec![runtime_session("hermes", "t", true, &project)],
        );
        assert_eq!(
            result
                .sessions
                .iter()
                .filter(|session| session.source == AgentAdapterKind::Hermes.id())
                .count(),
            2
        );
        let driven = by_id(&result, "hermes:r");
        assert_eq!(driven.status.source, StatusSource::SvodeRuntime);
        assert_eq!(
            driven.runtime.as_ref().unwrap().acp_session,
            Some(SessionKey::from_acp("hermes", "t", true))
        );
    }

    #[test]
    fn the_saved_hermes_list_is_shown_after_a_restart_with_what_its_store_told() {
        let (temp, home, project) = project_dirs();
        let elsewhere = temp.path().join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        let state = AgentSessionsState::with_home(home.clone());
        hermes_store(&state, &home, &hermes_conversations(&project, &elsewhere));
        list(&state, &project);

        let restarted = AgentSessionsState::with_home(home);
        let result = list(&restarted, &project);
        assert_eq!(result.cache.mode, AgentSessionsCacheMode::StaleSnapshot);
        let chain = by_id(&result, "hermes:r");
        assert_eq!(chain.alias_ids, ["hermes:t"]);
        assert_eq!(
            chain.resume_command.as_ref().unwrap().args,
            ["-p", "default", "--resume", "t"]
        );
        assert!(!by_id(&result, "hermes:cli").capabilities.can_open_in_chat);
        assert_eq!(
            result.sources[0].diagnostics[0].code,
            "native-catalog-snapshot"
        );

        read_hermes_store(&restarted);
        let result = list(&restarted, &project);
        assert_eq!(result.cache.mode, AgentSessionsCacheMode::Current);
        assert_eq!(result.sessions.len(), 2);
    }

    #[test]
    fn a_hermes_turn_lease_of_a_live_process_is_another_writer() {
        let (_temp, home, project) = project_dirs();
        let state = AgentSessionsState::with_home(home.clone());
        let mut child = live_child();
        let now = Utc::now().timestamp() as f64;
        let lease = |id: &str, acquired_at: f64, expires_at: f64| {
            format!(
                "INSERT INTO session_turn_leases VALUES ('{id}', 'pid={}:turn=1:platform=cli', \
                 {acquired_at}, {expires_at});",
                child.id()
            )
        };
        hermes_store(
            &state,
            &home,
            &[
                hermes_session("held", "acp", &project, ""),
                lease("held", now + 5.0, now + 240.0),
                hermes_session("expired", "acp", &project, ""),
                lease("expired", now + 5.0, now - 1.0),
                hermes_session("free", "acp", &project, ""),
                hermes_answer("free"),
            ]
            .concat(),
        );

        let result = list(&state, &project);
        let held = chat_liveness(&state, &project, "hermes:held");
        let expired = chat_liveness(&state, &project, "hermes:expired");
        let free = chat_liveness(&state, &project, "hermes:free");
        child.kill().ok();
        child.wait().ok();

        assert_eq!(
            by_id(&result, "hermes:held").status.state,
            SessionState::Running
        );
        assert_eq!(held, ExternalLiveness::ExternalActive);
        assert_eq!(
            by_id(&result, "hermes:expired").status.state,
            SessionState::Unknown
        );
        assert_eq!(expired, ExternalLiveness::Unknown);
        assert_eq!(free, ExternalLiveness::Unknown, "no lease is never free");
    }

    #[test]
    fn a_disabled_hermes_keeps_its_shown_sessions_and_its_store_is_not_read() {
        let (_temp, home, project) = project_dirs();
        let state = AgentSessionsState::with_home(home.clone());
        hermes_store(
            &state,
            &home,
            &[
                hermes_session("h1", "cli", &project, ""),
                hermes_answer("h1"),
            ]
            .concat(),
        );
        assert_eq!(
            by_id(&list(&state, &project), "hermes:h1").status.state,
            idle(Some(StopReason::EndTurn))
        );

        assert!(state.native_catalogs.refresh(&[]).is_empty());
        let result = list(&state, &project);
        let session = by_id(&result, "hermes:h1");
        assert_eq!(
            session.status,
            SessionStatus::unknown(),
            "the store is not read"
        );
    }

    #[test]
    fn a_hermes_store_of_an_unknown_format_is_its_diagnostic_alone() {
        let (_temp, home, project) = project_dirs();
        let state = AgentSessionsState::with_home(home.clone());
        let id = codex_id(41);
        listed_codex(
            &state,
            &home,
            &project,
            &id,
            vec![task_started(&recent_source_log_timestamp())],
        );
        hermes_store(
            &state,
            &home,
            &[
                hermes_session("h1", "cli", &project, ""),
                "UPDATE schema_version SET version = 30;".to_string(),
            ]
            .concat(),
        );

        let result = list(&state, &project);
        assert_eq!(result.status, AgentSessionsListStatus::Partial);
        let hermes = result
            .sources
            .iter()
            .find(|report| report.source == AgentAdapterKind::Hermes.id())
            .expect("hermes report");
        assert_eq!(hermes.status, AgentSessionSourceStatus::Stale);
        assert_eq!(hermes.diagnostics[0].code, "native-catalog-stale");
        assert!(hermes.diagnostics[0].message.contains("Hermes"));
        assert!(
            result
                .sessions
                .iter()
                .all(|session| session.source != AgentAdapterKind::Hermes.id())
        );
        let codex = result
            .sources
            .iter()
            .find(|report| report.source == AgentAdapterKind::Codex.id())
            .expect("codex report");
        assert_eq!(codex.status, AgentSessionSourceStatus::Ok);
        assert_eq!(
            by_id(&result, &format!("codex:{id}")).status.state,
            SessionState::Running
        );
    }

    /// opencode's sessions listed in the project, read from this
    /// `opencode.db`.
    fn opencode_with(
        state: &AgentSessionsState,
        project: &Path,
        db: &Path,
        sessions: &[crate::agent_sessions::native_status::opencode::fixture::Session],
        extra: &[&str],
    ) {
        use crate::agent_sessions::native_status::opencode;

        opencode::fixture::write(db, sessions, extra);
        acp_list(
            state,
            "opencode",
            true,
            sessions
                .iter()
                .map(|(id, ..)| (*id, project, LISTED_AT))
                .collect(),
        );
        let db = db.to_path_buf();
        state.native_status.set_source(
            AgentAdapterKind::Opencode.id(),
            Arc::new(opencode::Database::new(move || Ok(db.clone()))),
        );
    }

    fn read_native_catalog(state: &AgentSessionsState, agent: AgentAdapterKind) {
        let reads = state.native_catalogs.refresh(&[agent]);
        tauri::async_runtime::block_on(async {
            for read in reads {
                read.await.expect("native catalogue read");
            }
        });
    }

    #[test]
    fn cursor_acp_sessions_terminal_chats_and_ide_chats_of_one_folder_and_title_are_apart() {
        use crate::agent_sessions::native_catalog::cursor_chats::tests::{chat, folder_of, meta};
        use crate::agent_sessions::native_catalog::cursor_ide::{self, tests as ide};

        let (temp, home, project) = project_dirs();
        let root = home.join(".cursor");
        chat(
            &root,
            &folder_of(&project),
            "c1",
            meta(&project, Some("ACP c1")),
            true,
        );
        let moved = folder_of(&temp.path().join("moved"));
        chat(&root, &moved, "c2", meta(&project, None), true);
        ide::store(
            &cursor_ide::app_data_dir(&home, |_| None),
            &[
                ide::HEADERS_TABLE.to_string(),
                ide::row(
                    "c1",
                    Some(1_800_000_100_000),
                    (0, 0),
                    &ide::in_folder("ACP c1", &project),
                ),
            ]
            .concat(),
        );
        let state = AgentSessionsState::with_home(home.clone());
        acp_list(&state, "cursor", false, vec![("c1", &project, LISTED_AT)]);
        read_native_catalog(&state, AgentAdapterKind::Cursor);

        let result = list(&state, &project);
        let mut ids = result
            .sessions
            .iter()
            .map(|session| session.id.as_str())
            .collect::<Vec<_>>();
        ids.sort();
        assert_eq!(
            ids,
            ["cursor:acp:c1", "cursor:c1", "cursor:c2", "cursor:ide:c1"]
        );
        let reports = result
            .sources
            .iter()
            .filter(|report| report.source == AgentAdapterKind::Cursor.id())
            .collect::<Vec<_>>();
        assert_eq!(
            reports.len(),
            3,
            "its ACP list, its chat folders and its IDE chats"
        );
        assert!(
            reports
                .iter()
                .all(|report| report.status == AgentSessionSourceStatus::Ok)
        );

        let acp = by_id(&result, "cursor:acp:c1");
        assert!(acp.capabilities.can_open_in_chat);
        assert!(!acp.capabilities.can_resume);
        assert!(acp.resume_command.is_none());

        let terminal = by_id(&result, "cursor:c1");
        assert_eq!(terminal.title, "ACP c1");
        assert_eq!(terminal.cwd, acp.cwd);
        assert!(!terminal.capabilities.can_open_in_chat);
        assert!(terminal.capabilities.can_resume);
        let resume = terminal.resume_command.as_ref().expect("resume command");
        assert_eq!(resume.program, "cursor-agent");
        assert_eq!(resume.args, ["--resume", "c1"]);
        assert_eq!(resume.cwd, terminal.cwd, "in the folder of the chat");
        assert_eq!(terminal.status.state, SessionState::Unknown);
        assert!(!terminal.native_external_writer);

        assert!(!terminal.capabilities.continues_in_ide);

        let in_ide = by_id(&result, "cursor:ide:c1");
        assert_eq!(in_ide.source_session_id, "c1");
        assert_eq!(in_ide.title, "ACP c1");
        assert_eq!(in_ide.cwd, acp.cwd);
        assert!(!in_ide.capabilities.can_open_in_chat);
        assert!(!in_ide.capabilities.can_resume);
        assert!(in_ide.capabilities.continues_in_ide);
        assert!(in_ide.resume_command.is_none());
        assert_eq!(in_ide.status.state, SessionState::Unknown);
        assert!(!in_ide.native_external_writer);

        let elsewhere = by_id(&result, "cursor:c2");
        assert!(
            !elsewhere.capabilities.can_resume,
            "the CLI would look for the chat in another chat folder"
        );
        assert!(elsewhere.resume_command.is_none());

        let chat_target = |state: &AgentSessionsState, id: &str| {
            crate::agent_sessions::chat::chat_target(
                state,
                project.to_string_lossy().into_owned(),
                id,
                Vec::new(),
                Vec::new(),
            )
            .expect("chat target")
        };
        assert_eq!(chat_target(&state, "cursor:c1"), None);
        assert_eq!(chat_target(&state, "cursor:ide:c1"), None);
        assert!(chat_target(&state, "cursor:acp:c1").is_some());

        // What the chat folders told is saved with the list.
        let restarted = AgentSessionsState::with_home(home);
        let result = list(&restarted, &project);
        assert_eq!(result.cache.mode, AgentSessionsCacheMode::StaleSnapshot);
        assert!(by_id(&result, "cursor:c1").capabilities.can_resume);
        assert!(!by_id(&result, "cursor:c2").capabilities.can_resume);
        assert!(
            by_id(&result, "cursor:ide:c1")
                .capabilities
                .continues_in_ide
        );
    }

    #[test]
    fn an_ide_chat_of_a_multi_root_workspace_is_in_the_first_of_its_folders_the_project_holds() {
        use crate::agent_sessions::native_catalog::cursor_ide::{self, tests as ide};

        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        let dev = project.join("dev");
        let other = temp.path().join("other");
        for dir in [&dev, &other] {
            fs::create_dir_all(dir).expect("dir");
        }
        write_root_config(&project, vec![space_ref("dev-space", "dev", None)]);
        let workspaces = temp.path().join("workspaces");
        let file = |name: &str, folders: &[&str]| {
            let file = workspaces.join(name);
            write(
                &file,
                &serde_json::json!({
                    "folders": folders
                        .iter()
                        .map(|path| serde_json::json!({ "path": path }))
                        .collect::<Vec<_>>()
                })
                .to_string(),
            );
            file
        };
        let work = file(
            "work.code-workspace",
            &["../other", "../project/dev", "../project"],
        );
        let elsewhere = file("elsewhere.code-workspace", &["../other"]);
        let chats = [
            ("work", work),
            ("elsewhere", elsewhere),
            ("deleted", workspaces.join("deleted.code-workspace")),
        ];
        ide::store(
            &cursor_ide::app_data_dir(&home, |_| None),
            &std::iter::once(ide::HEADERS_TABLE.to_string())
                .chain(chats.iter().map(|(id, file)| {
                    ide::row(
                        id,
                        Some(1_800_000_100_000),
                        (0, 0),
                        &ide::in_workspace(id, file),
                    )
                }))
                .collect::<String>(),
        );
        let state = AgentSessionsState::with_home(home);
        read_native_catalog(&state, AgentAdapterKind::Cursor);

        let result = list(&state, &project);
        let ids = result
            .sessions
            .iter()
            .map(|session| session.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            ids,
            ["cursor:ide:work"],
            "no folder of the project, or the workspace file is gone"
        );
        let work = by_id(&result, "cursor:ide:work");
        assert_eq!(work.scope_kind, AgentSessionScopeKind::Space);
        assert_eq!(work.space_id.as_deref(), Some("dev-space"));
        assert_eq!(
            work.cwd.as_deref(),
            Some(fs::canonicalize(&dev).unwrap().to_string_lossy().as_ref())
        );
        let hot = hot(&state, &project, "cursor:ide:work");
        assert_eq!(hot.sessions.len(), 1);
        assert_eq!(hot.sessions[0].space_id.as_deref(), Some("dev-space"));

        // The other project of its folders has it too.
        write_root_config(&other, Vec::new());
        let result = list(&state, &other);
        assert_eq!(
            by_id(&result, "cursor:ide:work").cwd.as_deref(),
            Some(fs::canonicalize(&other).unwrap().to_string_lossy().as_ref())
        );
        by_id(&result, "cursor:ide:elsewhere");
    }

    #[test]
    fn a_cursor_chat_of_another_format_is_the_diagnostic_of_its_chat_folders_alone() {
        use crate::agent_sessions::native_catalog::cursor_chats::tests::{chat, folder_of, meta};

        let (_temp, home, project) = project_dirs();
        let root = home.join(".cursor");
        let folder = folder_of(&project);
        chat(&root, &folder, "c1", meta(&project, None), true);
        let state = AgentSessionsState::with_home(home);
        acp_list(&state, "cursor", false, vec![("a1", &project, LISTED_AT)]);
        read_native_catalog(&state, AgentAdapterKind::Cursor);
        let mut newer = meta(&project, None);
        newer["schemaVersion"] = serde_json::json!(2);
        chat(&root, &folder, "c2", newer, true);
        read_native_catalog(&state, AgentAdapterKind::Cursor);

        let result = list(&state, &project);
        assert_eq!(result.status, AgentSessionsListStatus::Partial);
        by_id(&result, "cursor:acp:a1");
        by_id(&result, "cursor:c1");
        let stale = result
            .sources
            .iter()
            .filter(|report| report.status == AgentSessionSourceStatus::Stale)
            .collect::<Vec<_>>();
        assert_eq!(stale.len(), 1, "the ACP list is untouched");
        let diagnostic = &stale[0].diagnostics[0];
        assert_eq!(diagnostic.code, "native-catalog-stale");
        assert!(
            diagnostic.message.contains("Cursor"),
            "{}",
            diagnostic.message
        );
        assert!(diagnostic.message.contains("schemaVersion"));
    }

    #[test]
    fn a_cursor_ide_store_of_another_format_is_the_diagnostic_of_its_ide_chats_alone() {
        use crate::agent_sessions::native_catalog::cursor_chats::tests::{chat, folder_of, meta};
        use crate::agent_sessions::native_catalog::cursor_ide::{self, tests as ide};

        let (_temp, home, project) = project_dirs();
        chat(
            &home.join(".cursor"),
            &folder_of(&project),
            "c1",
            meta(&project, None),
            true,
        );
        let app_data = cursor_ide::app_data_dir(&home, |_| None);
        ide::store(
            &app_data,
            &[
                ide::HEADERS_TABLE.to_string(),
                ide::row(
                    "i1",
                    Some(1_800_000_100_000),
                    (0, 0),
                    &ide::in_folder("IDE", &project),
                ),
            ]
            .concat(),
        );
        let state = AgentSessionsState::with_home(home);
        acp_list(&state, "cursor", false, vec![("a1", &project, LISTED_AT)]);
        read_native_catalog(&state, AgentAdapterKind::Cursor);
        fs::remove_dir_all(&app_data).unwrap();
        ide::store(&app_data, "CREATE TABLE ItemTable (key TEXT, value BLOB);");
        read_native_catalog(&state, AgentAdapterKind::Cursor);

        let result = list(&state, &project);
        assert_eq!(result.status, AgentSessionsListStatus::Partial);
        by_id(&result, "cursor:acp:a1");
        by_id(&result, "cursor:c1");
        by_id(&result, "cursor:ide:i1");
        let stale = result
            .sources
            .iter()
            .filter(|report| report.status == AgentSessionSourceStatus::Stale)
            .collect::<Vec<_>>();
        assert_eq!(
            stale.len(),
            1,
            "the ACP list and the chat folders are untouched"
        );
        let diagnostic = &stale[0].diagnostics[0];
        assert_eq!(diagnostic.code, "native-catalog-stale");
        assert!(
            diagnostic
                .message
                .contains("Showing the last sessions read")
        );
        assert!(
            diagnostic.message.contains("Cursor")
                && diagnostic.message.contains("not the format Svode reads"),
            "{}",
            diagnostic.message
        );
    }

    #[test]
    fn an_opencode_session_shows_its_claimed_turn_and_the_outcome_of_its_last_one() {
        let (temp, home, project) = project_dirs();
        let state = AgentSessionsState::with_home(home);
        let ms = |offset: chrono::Duration| (Utc::now() + offset).timestamp_millis();
        let recent = ms(chrono::Duration::minutes(-1));
        let stale = ms(chrono::Duration::seconds(
            -(SOURCE_LOG_ACTIVE_STALE_AFTER_SECS + 60),
        ));
        opencode_with(
            &state,
            &project,
            &temp.path().join("opencode.db"),
            &[
                ("claim", Some(recent), Some(recent), Some("succeeded")),
                ("stale-claim", Some(stale), None, None),
                ("succeeded", None, Some(recent), Some("succeeded")),
                ("failed", None, Some(recent), Some("failed")),
                ("interrupted", None, Some(recent), Some("interrupted")),
                ("no-turn", None, None, None),
            ],
            &[],
        );

        let result = list(&state, &project);

        assert_eq!(result.status, AgentSessionsListStatus::Ok);
        let status = |id: &str| by_id(&result, &format!("opencode:{id}")).status;
        assert_eq!(status("claim").state, SessionState::Running);
        assert_eq!(status("claim").source, StatusSource::NativeStatusReader);
        assert_eq!(status("claim").confidence, StatusConfidence::Approximate);
        assert_eq!(status("stale-claim").state, SessionState::Unknown);
        assert_eq!(status("succeeded").state, idle(Some(StopReason::EndTurn)));
        assert_eq!(status("failed").state, idle(Some(StopReason::Error)));
        assert_eq!(
            status("interrupted").state,
            idle(Some(StopReason::Cancelled))
        );
        assert_eq!(status("no-turn").state, idle(None));
        for id in ["claim", "stale-claim", "succeeded"] {
            assert_eq!(
                chat_liveness(&state, &project, &format!("opencode:{id}")),
                ExternalLiveness::Unknown,
                "a claim without a process signal is no other writer: {id}"
            );
        }
    }

    #[test]
    fn an_opencode_store_without_a_needed_migration_is_its_diagnostic() {
        let (temp, home, project) = project_dirs();
        let state = AgentSessionsState::with_home(home);
        opencode_with(
            &state,
            &project,
            &temp.path().join("opencode.db"),
            &[("s1", Some(Utc::now().timestamp_millis()), None, None)],
            &["DELETE FROM migration WHERE id = '20260811161259_execution_claim_attempts'"],
        );

        let result = list(&state, &project);

        let report = result
            .sources
            .iter()
            .find(|report| report.source == AgentAdapterKind::Opencode.id())
            .expect("opencode report");
        assert_eq!(report.status, AgentSessionSourceStatus::Stale);
        assert_eq!(report.diagnostics[0].code, "native-status-unavailable");
        assert!(
            report.diagnostics[0].message.contains("opencode")
                && report.diagnostics[0]
                    .message
                    .contains("20260811161259_execution_claim_attempts"),
            "{}",
            report.diagnostics[0].message
        );
        assert_eq!(
            by_id(&result, "opencode:s1").status,
            SessionStatus::unknown()
        );
    }
}

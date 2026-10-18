//! The session the agent process in a managed PTY runs now (DF-163 R2).
//! Claude Code records each of its processes in `sessions/<pid>.json` of its
//! config directory, and the record follows the session the process runs,
//! one started inside it (`/clear`, `/resume`, a fork) included. Only the
//! processes in the tree of the PTY shell are looked up, and a reused pid is
//! told by the process start time, as for the process records of `07` N4.
//! Codex keeps no such record (E1), so a terminal of Codex follows an
//! approximate source (R7): the one thread of the same cwd whose turn started
//! in this process after the session of the terminal went quiet.
//! The check runs at the refresh boundaries of the read-model (list,
//! refresh, hot status); a PTY without such evidence keeps its link, and the
//! terminals of agents without a record keep the frontend's first match.

use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use chrono::{DateTime, Duration, Utc};
use serde_json::Value;
use svode_core::agent_adapters::{AgentAdapterKind, AgentId};
use svode_core::system_path;

use super::AgentSessionsState;
use super::native_status::claude_code;
use super::native_status::codex::{self, ThreadActivity};
use super::native_status::process::{ProcessRecord, ProcessSignal, signal_of};
use super::types::{catalog_session_id, native_writer_key};
use crate::terminal::{
    AgentTerminalSurface, CurrentPtySession, LivePtyProcesses, PtyProcess, TerminalManager,
};

/// Claude Code writes the record after its process starts; the start time
/// of a process is read in whole seconds.
const RECORD_START_TOLERANCE: Duration = Duration::seconds(2);

/// The client a thread started in the Codex TUI names in its `session_meta`.
const CODEX_TUI_ORIGINATOR: &str = "codex-tui";

/// A rollout written at the bound of the window is still read: file times
/// may be coarser than the records' timestamps.
const ROLLOUT_MODIFIED_TOLERANCE: Duration = Duration::seconds(2);

/// Moves each live PTY of Svode to the session its agent process runs now.
/// A failure leaves every link as it is (R6).
pub(super) fn follow_terminal_sessions(state: &AgentSessionsState, terminals: &TerminalManager) {
    let ptys = match terminals.live_pty_processes() {
        Ok(ptys) => ptys,
        Err(error) => {
            tracing::warn!("the processes of managed terminals cannot be read: {error}");
            return;
        }
    };
    if ptys.is_empty() {
        return;
    }
    let records = claude_code::config_dir(&state.home_dir).join("sessions");
    let agent = AgentId::from(AgentAdapterKind::ClaudeCode);
    let mut current = ptys
        .iter()
        .filter_map(|pty| {
            let session_id = current_session(&records, &pty.processes)?;
            Some(CurrentPtySession {
                pty_id: pty.pty_id.clone(),
                agent_session_id: catalog_session_id(
                    &agent,
                    &native_writer_key(&agent, &session_id),
                ),
                source: agent.clone(),
                source_session_id: session_id,
                approximate: false,
            })
        })
        .collect::<Vec<_>>();
    let codex = codex_terminals(&ptys);
    if !codex.is_empty() {
        match terminals.list_agent_surfaces() {
            Ok(surfaces) => {
                // A Claude Code record of the same PTY is exact.
                let followed =
                    codex_current_sessions(&state.home_dir.join(".codex"), &codex, &surfaces)
                        .into_iter()
                        .filter(|codex| !current.iter().any(|claude| claude.pty_id == codex.pty_id))
                        .collect::<Vec<_>>();
                current.extend(followed);
            }
            Err(error) => {
                tracing::warn!("the sessions of Codex terminals cannot be read: {error}");
            }
        }
    }
    if let Err(error) = terminals.follow_current_sessions(&current) {
        tracing::warn!("managed terminals keep their sessions: {error}");
    }
}

/// The session of the Claude Code process nearest the shell, nearest
/// processes first; none when no process has a valid record or two at the
/// same depth run different sessions.
fn current_session(records: &Path, processes: &[PtyProcess]) -> Option<String> {
    let mut found: Option<(usize, String)> = None;
    for process in processes {
        if found
            .as_ref()
            .is_some_and(|(depth, _)| process.depth > *depth)
        {
            break;
        }
        let Some(session_id) = record_session(records, process) else {
            continue;
        };
        match &found {
            Some((_, other)) if *other != session_id => {
                tracing::debug!(
                    "two Claude Code processes of one managed terminal run different sessions"
                );
                return None;
            }
            Some(_) => {}
            None => found = Some((process.depth, session_id)),
        }
    }
    found.map(|(_, session_id)| session_id)
}

/// The session in the record of this running process; none without a
/// record, for a record of another process and for a pid reused since the
/// record was written.
fn record_session(records: &Path, process: &PtyProcess) -> Option<String> {
    let path = records.join(format!("{}.json", process.pid));
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => return None,
        Err(error) => {
            tracing::warn!(
                path = %path.display(),
                "a Claude Code process record cannot be read: {error}"
            );
            return None;
        }
    };
    let record = match parse_record(&text) {
        Ok(record) => record,
        Err(problem) => {
            tracing::warn!(path = %path.display(), "a Claude Code process record {problem}");
            return None;
        }
    };
    if record.pid != process.pid {
        tracing::debug!(
            path = %path.display(),
            "a Claude Code process record names another process"
        );
        return None;
    }
    let signal = signal_of(
        Some(&ProcessRecord {
            pid: record.pid,
            host: None,
            started_by: record.started_at + RECORD_START_TOLERANCE,
        }),
        None,
        |pid| (pid == process.pid).then_some(Some(process.start_time)),
    );
    if signal != ProcessSignal::Alive {
        tracing::debug!(
            path = %path.display(),
            "a Claude Code process record is of an earlier process with this pid"
        );
        return None;
    }
    Some(record.session_id)
}

/// A live PTY with a Codex process under its shell.
#[derive(Debug, Clone)]
struct CodexTerminal {
    pty_id: String,
    shell_cwd: String,
    /// When the Codex process nearest the shell started; none when its
    /// start time cannot be read.
    started_at: Option<DateTime<Utc>>,
}

/// The live PTYs with a Codex process under their shells.
fn codex_terminals(ptys: &[LivePtyProcesses]) -> Vec<CodexTerminal> {
    let executable = AgentAdapterKind::Codex.executable();
    ptys.iter()
        .filter_map(|pty| {
            let process = pty.processes.iter().find(|process| {
                Path::new(&process.name)
                    .file_stem()
                    .is_some_and(|stem| stem.eq_ignore_ascii_case(executable))
            })?;
            Some(CodexTerminal {
                pty_id: pty.pty_id.clone(),
                shell_cwd: pty.cwd.clone(),
                started_at: i64::try_from(process.start_time)
                    .ok()
                    .filter(|seconds| *seconds > 0)
                    .and_then(|seconds| DateTime::from_timestamp(seconds, 0)),
            })
        })
        .collect()
}

/// The thread each Codex terminal runs now by the approximate source of
/// R7: the only thread started in the Codex TUI in the cwd of the session
/// of the terminal, other than that session, whose latest turn started in
/// the terminal's Codex process after the last activity of that session,
/// while no other Codex terminal of Svode works in that cwd. A terminal
/// without a Codex session, a session without its rollout and any doubt
/// keep the link.
fn codex_current_sessions(
    root: &Path,
    terminals: &[CodexTerminal],
    surfaces: &[AgentTerminalSurface],
) -> Vec<CurrentPtySession> {
    let agent = AgentId::from(AgentAdapterKind::Codex);
    let bound = terminals
        .iter()
        .filter_map(|terminal| {
            let surface = surfaces.iter().find(|surface| {
                surface.pty_id == terminal.pty_id
                    && surface.live
                    && surface.finished_at.is_none()
                    && surface.source == agent
            })?;
            Some((terminal, surface.source_session_id.to_ascii_lowercase()))
        })
        .collect::<Vec<_>>();
    if bound.is_empty() {
        return Vec::new();
    }
    let rollouts = codex::index(root);
    let mut threads = HashMap::<String, Option<ThreadActivity>>::new();
    let mut thread = |id: &str| -> Option<ThreadActivity> {
        threads
            .entry(id.to_string())
            .or_insert_with(|| {
                rollouts
                    .get(id)
                    .and_then(|path| codex::thread_activity(path))
            })
            .clone()
    };
    // Every directory a Codex terminal of Svode works in: its shell's and
    // that of its session.
    let mut busy = terminals
        .iter()
        .map(|terminal| {
            (
                terminal.pty_id.as_str(),
                vec![same_dir_key(&terminal.shell_cwd)],
            )
        })
        .collect::<HashMap<_, _>>();
    for (terminal, session_id) in &bound {
        if let Some(cwd) = thread(session_id).and_then(|thread| thread.cwd) {
            busy.entry(terminal.pty_id.as_str())
                .or_default()
                .push(same_dir_key(&cwd));
        }
    }

    let mut current = Vec::new();
    for (terminal, session_id) in &bound {
        let Some(session) = thread(session_id) else {
            continue;
        };
        let (Some(cwd), Some(quiet_since), Some(started_at)) = (
            session.cwd.as_deref().map(same_dir_key),
            session.last_activity_at,
            terminal.started_at,
        ) else {
            continue;
        };
        if busy
            .iter()
            .any(|(pty_id, dirs)| *pty_id != terminal.pty_id && dirs.contains(&cwd))
        {
            tracing::debug!(
                pty_id = terminal.pty_id,
                "another Codex terminal of Svode works in the cwd of this one"
            );
            continue;
        }
        let since = quiet_since.max(started_at);
        let candidates = rollouts
            .iter()
            .filter(|(id, path)| *id != session_id && modified_since(path, since))
            .filter(|(id, _)| {
                thread(id).is_some_and(|thread| {
                    thread.originator.as_deref() == Some(CODEX_TUI_ORIGINATOR)
                        && thread.cwd.as_deref().map(same_dir_key).as_ref() == Some(&cwd)
                        && thread
                            .turn_started_at
                            .is_some_and(|turn| turn > quiet_since && turn >= started_at)
                })
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        match candidates.as_slice() {
            [thread_id] => current.push(CurrentPtySession {
                pty_id: terminal.pty_id.clone(),
                agent_session_id: catalog_session_id(&agent, &native_writer_key(&agent, thread_id)),
                source: agent.clone(),
                source_session_id: thread_id.clone(),
                approximate: true,
            }),
            [] => {}
            _ => tracing::debug!(
                pty_id = terminal.pty_id,
                "several Codex threads could be the one of this terminal"
            ),
        }
    }
    current
}

/// A directory as the comparison of cwds takes it: resolved when it can
/// be.
fn same_dir_key(dir: &str) -> PathBuf {
    let path = Path::new(dir);
    path.canonicalize()
        .map(|resolved| PathBuf::from(system_path::user_facing_path(&resolved)))
        .unwrap_or_else(|_| path.to_path_buf())
}

/// Whether the file was written at `since` or later.
fn modified_since(path: &Path, since: DateTime<Utc>) -> bool {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .and_then(|elapsed| DateTime::from_timestamp_millis(elapsed.as_millis() as i64))
        .is_some_and(|modified| modified + ROLLOUT_MODIFIED_TOLERANCE >= since)
}

struct ClaudeProcessRecord {
    pid: u32,
    session_id: String,
    started_at: DateTime<Utc>,
}

fn parse_record(text: &str) -> Result<ClaudeProcessRecord, &'static str> {
    let record = serde_json::from_str::<Value>(text).map_err(|_| "is not JSON")?;
    let pid = record
        .get("pid")
        .and_then(Value::as_u64)
        .and_then(|pid| u32::try_from(pid).ok())
        .ok_or("has no pid")?;
    let session_id = record
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .ok_or("has no sessionId")?;
    let started_at = record
        .get("startedAt")
        .and_then(Value::as_i64)
        .and_then(DateTime::from_timestamp_millis)
        .ok_or("has no startedAt")?;
    Ok(ClaudeProcessRecord {
        pid,
        session_id: session_id.to_string(),
        started_at,
    })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use svode_agents::catalog::{ListedSession, SessionList};
    use svode_agents::identity::SessionKey;
    use svode_agents::writer::{
        ExternalLiveness, UnknownLiveness, Writer, WriterClaim, WriterRegistry,
    };

    use super::*;
    use crate::agent_sessions::chat::chat_target;
    use crate::agent_sessions::read_model::list_sessions;
    use crate::agent_sessions::types::{AgentSession, AgentSessionsListResult};
    use crate::terminal::AgentTerminalSurface;

    fn write(path: &Path, data: &str) {
        fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
        fs::write(path, data).expect("write fixture");
    }

    fn write_record(records: &Path, file_pid: u32, record: serde_json::Value) {
        write(
            &records.join(format!("{file_pid}.json")),
            &record.to_string(),
        );
    }

    fn record(pid: u32, session_id: &str, started_at: DateTime<Utc>) -> serde_json::Value {
        serde_json::json!({
            "pid": pid,
            "sessionId": session_id,
            "cwd": "/tmp/project",
            "startedAt": started_at.timestamp_millis(),
            "procStart": "Sun Oct 18 05:34:13 2026",
            "kind": "interactive",
            "status": "idle",
        })
    }

    fn process(pid: u32, depth: usize, start_time: DateTime<Utc>) -> PtyProcess {
        PtyProcess {
            pid,
            depth,
            start_time: start_time.timestamp() as u64,
            name: "claude".to_string(),
        }
    }

    #[test]
    fn a_record_of_the_running_process_tells_its_session() {
        let temp = tempfile::tempdir().expect("temp dir");
        let records = temp.path().join("sessions");
        let started = Utc::now() - Duration::hours(3);
        write_record(
            &records,
            4242,
            record(4242, "s1", started + Duration::seconds(2)),
        );
        write_record(&records, 4243, record(4243, "s2", started));

        assert_eq!(
            record_session(&records, &process(4242, 1, started)).as_deref(),
            Some("s1")
        );
        assert_eq!(
            record_session(&records, &process(4243, 1, started)).as_deref(),
            Some("s2"),
            "a record written in the second the process started"
        );
    }

    #[test]
    fn no_record_an_unreadable_one_or_another_process_tells_nothing() {
        let temp = tempfile::tempdir().expect("temp dir");
        let records = temp.path().join("sessions");
        let started = Utc::now() - Duration::hours(3);
        write(&records.join("1.json"), "{ not json");
        write_record(&records, 2, serde_json::json!({ "pid": 2, "startedAt": 1 }));
        write_record(&records, 3, record(77, "s1", started));
        write_record(
            &records,
            4,
            serde_json::json!({ "pid": 4, "sessionId": "s1" }),
        );
        write_record(&records, 5, record(5, "s1", started));
        write_record(&records, 6, record(6, " ", started));

        for (pid, why) in [
            (1, "malformed"),
            (2, "no session id"),
            (3, "the record of another process"),
            (4, "no start"),
            (6, "an empty session id"),
            (9, "no record"),
        ] {
            assert_eq!(
                record_session(&records, &process(pid, 1, started)),
                None,
                "{why}"
            );
        }
        assert_eq!(
            record_session(&records, &process(5, 1, started + Duration::minutes(10))),
            None,
            "a process started after the record reuses the pid"
        );
        assert_eq!(
            record_session(
                &records,
                &PtyProcess {
                    pid: 5,
                    depth: 1,
                    start_time: 0,
                    name: "claude".to_string(),
                }
            ),
            None,
            "an unreadable start time"
        );
    }

    #[test]
    fn the_claude_code_process_nearest_the_shell_tells_the_session() {
        let temp = tempfile::tempdir().expect("temp dir");
        let records = temp.path().join("sessions");
        let started = Utc::now() - Duration::hours(1);
        write_record(&records, 11, record(11, "outer", started));
        write_record(&records, 12, record(12, "outer", started));
        write_record(&records, 21, record(21, "inner", started));
        write_record(&records, 31, record(31, "left", started));
        write_record(&records, 32, record(32, "right", started));

        let tree = [
            process(10, 0, started),
            process(11, 1, started),
            process(21, 2, started),
        ];
        assert_eq!(current_session(&records, &tree).as_deref(), Some("outer"));
        let same = [
            process(10, 0, started),
            process(11, 1, started),
            process(12, 1, started),
        ];
        assert_eq!(current_session(&records, &same).as_deref(), Some("outer"));
        let two = [
            process(10, 0, started),
            process(31, 1, started),
            process(32, 1, started),
        ];
        assert_eq!(
            current_session(&records, &two),
            None,
            "two sessions at one depth"
        );
        assert_eq!(current_session(&records, &[process(10, 0, started)]), None);
        assert_eq!(current_session(&records, &[]), None, "no processes");
    }

    fn project_with_claude_sessions(
        home: &Path,
        project: &Path,
        state: &AgentSessionsState,
        ids: &[&str],
    ) {
        write(
            &project.join(".svode/config.json"),
            &serde_json::json!({ "name": "Project", "spaces": [] }).to_string(),
        );
        write(
            &claude_code::config_dir(home).join("projects/p/s1.jsonl"),
            &(serde_json::json!({
                "type": "user",
                "message": {
                    "role": "user",
                    "content": "Prepare report\n\n<!-- svode-launch:launch-1 -->"
                },
                "timestamp": "2026-10-18T10:00:00Z"
            })
            .to_string()
                + "\n"
                + &serde_json::json!({
                    "type": "assistant",
                    "message": {
                        "role": "assistant",
                        "content": [{ "type": "text", "text": "done" }],
                        "stop_reason": "end_turn"
                    },
                    "timestamp": "2026-10-18T10:01:00Z"
                })
                .to_string()),
        );
        let list = SessionList {
            sessions: ids
                .iter()
                .map(|id| ListedSession {
                    key: SessionKey::from_acp("claude-code", id, true),
                    cwd: project.to_path_buf(),
                    title: Some(format!("Session {id}")),
                    updated_at: Some("2026-10-18T10:00:00Z".to_string()),
                })
                .collect(),
            ..Default::default()
        };
        state.acp_lists.apply("claude-code", Ok(list), 3);
    }

    fn list(
        state: &AgentSessionsState,
        project: &Path,
        terminals: &TerminalManager,
    ) -> AgentSessionsListResult {
        follow_terminal_sessions(state, terminals);
        list_sessions(
            state,
            project.to_string_lossy().into_owned(),
            terminals.list_agent_surfaces().unwrap(),
            Vec::new(),
        )
        .expect("list sessions")
    }

    fn by_id<'a>(result: &'a AgentSessionsListResult, id: &str) -> &'a AgentSession {
        result
            .sessions
            .iter()
            .find(|session| session.id == id)
            .unwrap_or_else(|| panic!("no session {id}"))
    }

    fn pty_of(session: &AgentSession) -> Option<&str> {
        session
            .runtime
            .as_ref()
            .filter(|runtime| runtime.live)
            .and_then(|runtime| runtime.pty_id.as_deref())
    }

    fn liveness(
        state: &AgentSessionsState,
        project: &Path,
        terminals: &TerminalManager,
        id: &str,
    ) -> ExternalLiveness {
        chat_target(
            state,
            project.to_string_lossy().into_owned(),
            id,
            terminals.list_agent_surfaces().unwrap(),
            Vec::new(),
        )
        .expect("chat target")
        .expect("listed session")
        .liveness
    }

    fn claude_key(id: &str) -> SessionKey {
        native_writer_key(&AgentAdapterKind::ClaudeCode.id(), id)
    }

    fn acp_claim(writers: &WriterRegistry, id: &str) -> WriterClaim {
        writers
            .claim(
                &claude_key(id),
                Writer::Acp,
                ExternalLiveness::Free,
                UnknownLiveness::NotConfirmed,
            )
            .expect("the chat writes the session")
    }

    #[test]
    fn a_live_terminal_follows_the_claude_code_session_its_process_runs() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        let state = AgentSessionsState::with_home(home.clone());
        project_with_claude_sessions(&home, &project, &state, &["s1", "s2", "s3"]);
        let writers = WriterRegistry::default();
        let terminals = TerminalManager::new(writers.clone());
        terminals.insert_shell_for_test("pty-a", &project);
        let shell = terminals.live_pty_processes().unwrap()[0].processes[0].pid;
        let records = claude_code::config_dir(&home).join("sessions");

        // No record yet: the plain terminal stays without a session.
        let listed = list(&state, &project, &terminals);
        assert!(
            listed
                .sessions
                .iter()
                .all(|session| pty_of(session).is_none())
        );

        // A reused pid tells nothing.
        write_record(
            &records,
            shell,
            record(shell, "s1", Utc::now() - Duration::hours(1)),
        );
        let listed = list(&state, &project, &terminals);
        assert!(
            listed
                .sessions
                .iter()
                .all(|session| pty_of(session).is_none())
        );

        write_record(&records, shell, record(shell, "s1", Utc::now()));
        let listed = list(&state, &project, &terminals);
        assert_eq!(pty_of(by_id(&listed, "claude-code:s1")), Some("pty-a"));
        assert_eq!(writers.writer(&claude_key("s1")), Some(Writer::Pty));

        // `/clear` inside the process: the record names the new session.
        write_record(&records, shell, record(shell, "s2", Utc::now()));
        let listed = list(&state, &project, &terminals);
        assert_eq!(pty_of(by_id(&listed, "claude-code:s2")), Some("pty-a"));
        assert_eq!(pty_of(by_id(&listed, "claude-code:s1")), None);
        assert_eq!(writers.writer(&claude_key("s1")), None);
        assert_eq!(writers.writer(&claude_key("s2")), Some(Writer::Pty));
        assert_eq!(
            liveness(&state, &project, &terminals, "claude-code:s1"),
            ExternalLiveness::Unknown,
            "the previous session is no longer held by this PTY"
        );

        // An unreadable record keeps the link.
        write(&records.join(format!("{shell}.json")), "{");
        let listed = list(&state, &project, &terminals);
        assert_eq!(pty_of(by_id(&listed, "claude-code:s2")), Some("pty-a"));

        // `/resume` of a session the chat writes: the terminal goes to it,
        // the key stays with the chat, and a new continuation from the chat
        // is refused while the PTY lives.
        let chat = acp_claim(&writers, "s3");
        write_record(&records, shell, record(shell, "s3", Utc::now()));
        let listed = list(&state, &project, &terminals);
        assert_eq!(pty_of(by_id(&listed, "claude-code:s3")), Some("pty-a"));
        assert_eq!(writers.writer(&claude_key("s3")), Some(Writer::Acp));
        assert_eq!(writers.writer(&claude_key("s2")), None);
        drop(chat);
        assert_eq!(
            liveness(&state, &project, &terminals, "claude-code:s3"),
            ExternalLiveness::ExternalActive
        );

        terminals.kill("pty-a").unwrap();
        let listed = list(&state, &project, &terminals);
        let closed = by_id(&listed, "claude-code:s3");
        assert_eq!(pty_of(closed), None);
        assert_eq!(
            closed.status.state,
            svode_agents::status::SessionState::Idle {
                stop_reason: Some(svode_agents::status::StopReason::Interrupted)
            },
            "the outcome goes to the session current at the exit"
        );
        assert_ne!(
            by_id(&listed, "claude-code:s2").status.state,
            closed.status.state
        );
    }

    #[test]
    fn a_moved_routine_terminal_leaves_its_launch_to_the_session_of_the_launch() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        let state = AgentSessionsState::with_home(home.clone());
        project_with_claude_sessions(&home, &project, &state, &["s1", "s2"]);
        let terminals = TerminalManager::new(WriterRegistry::default());
        terminals.insert_shell_for_test("pty-routine", &project);
        terminals.insert_agent_surface_for_test(AgentTerminalSurface {
            pty_id: "pty-routine".to_string(),
            agent_session_id: "claude-code:s1".to_string(),
            launch_id: Some("launch-1".to_string()),
            routine_run_id: Some("run-1".to_string()),
            mcp_project_path: None,
            mcp_routine_caller_token: None,
            title: Some("Routine".to_string()),
            source: AgentAdapterKind::ClaudeCode.id(),
            source_session_id: "s1".to_string(),
            live: true,
            initial_agent_argv: Vec::new(),
            initial_agent_cwd: None,
            shell_cwd: project.to_string_lossy().into_owned(),
            created_at: "2026-10-18T10:00:00Z".to_string(),
            last_output_at: None,
            last_input_at: None,
            finished_at: None,
            exit_code: None,
            failure_reason: None,
            status_evidence: None,
            exit_marker_buffer: String::new(),
            rebound: false,
            approximate_binding: false,
        });
        let shell = terminals.live_pty_processes().unwrap()[0].processes[0].pid;
        let records = claude_code::config_dir(&home).join("sessions");

        let listed = list(&state, &project, &terminals);
        let launch = by_id(&listed, "claude-code:s1");
        assert_eq!(pty_of(launch), Some("pty-routine"));
        assert_eq!(launch.launch_id.as_deref(), Some("launch-1"));

        write_record(&records, shell, record(shell, "s2", Utc::now()));
        let listed = list(&state, &project, &terminals);
        let launch = by_id(&listed, "claude-code:s1");
        let current = by_id(&listed, "claude-code:s2");
        assert_eq!(
            pty_of(launch),
            None,
            "the launch no longer names the terminal"
        );
        assert_eq!(launch.launch_id.as_deref(), Some("launch-1"));
        assert_eq!(pty_of(current), Some("pty-routine"));
        assert_eq!(current.launch_id, None);
        assert_eq!(current.routine_run_id, None);
        assert_eq!(
            listed.sessions.len(),
            2,
            "no provisional record of the launch"
        );
        terminals.kill("pty-routine").unwrap();
    }

    const T1: &str = "00000000-0000-4000-8000-000000000001";
    const T2: &str = "00000000-0000-4000-8000-000000000002";
    const T3: &str = "00000000-0000-4000-8000-000000000003";
    const T4: &str = "00000000-0000-4000-8000-000000000004";

    fn at(time: DateTime<Utc>) -> String {
        time.to_rfc3339()
    }

    /// A Codex rollout: its `session_meta` at `started`, then an event per
    /// `(type, time)`.
    fn rollout(
        root: &Path,
        id: &str,
        originator: &str,
        cwd: &Path,
        started: DateTime<Utc>,
        events: &[(&str, DateTime<Utc>)],
    ) {
        let mut lines = vec![
            serde_json::json!({
                "timestamp": at(started),
                "type": "session_meta",
                "payload": {
                    "id": id,
                    "timestamp": at(started),
                    "cwd": cwd.to_string_lossy(),
                    "originator": originator,
                    "source": "vscode",
                },
            })
            .to_string(),
        ];
        lines.extend(events.iter().map(|(kind, time)| {
            serde_json::json!({
                "timestamp": at(*time),
                "type": "event_msg",
                "payload": { "type": kind },
            })
            .to_string()
        }));
        write(
            &root.join(format!(
                "sessions/2026/10/18/rollout-2026-10-18T10-00-00-{id}.jsonl"
            )),
            &(lines.join("\n") + "\n"),
        );
    }

    /// A finished turn from `start` to `start + 1 min`.
    fn turn(start: DateTime<Utc>) -> [(&'static str, DateTime<Utc>); 2] {
        [
            ("task_started", start),
            ("task_complete", start + Duration::minutes(1)),
        ]
    }

    fn codex_surface(pty_id: &str, thread_id: &str, cwd: &Path) -> AgentTerminalSurface {
        AgentTerminalSurface {
            pty_id: pty_id.to_string(),
            agent_session_id: format!("codex:{thread_id}"),
            launch_id: None,
            routine_run_id: None,
            mcp_project_path: None,
            mcp_routine_caller_token: None,
            title: None,
            source: AgentAdapterKind::Codex.id(),
            source_session_id: thread_id.to_string(),
            live: true,
            initial_agent_argv: Vec::new(),
            initial_agent_cwd: None,
            shell_cwd: cwd.to_string_lossy().into_owned(),
            created_at: "2026-10-18T10:00:00Z".to_string(),
            last_output_at: None,
            last_input_at: None,
            finished_at: None,
            exit_code: None,
            failure_reason: None,
            status_evidence: None,
            exit_marker_buffer: String::new(),
            rebound: false,
            approximate_binding: false,
        }
    }

    fn codex_terminal(pty_id: &str, cwd: &Path, started_at: DateTime<Utc>) -> CodexTerminal {
        CodexTerminal {
            pty_id: pty_id.to_string(),
            shell_cwd: cwd.to_string_lossy().into_owned(),
            started_at: Some(started_at),
        }
    }

    fn moves(current: &[CurrentPtySession]) -> Vec<(&str, &str)> {
        current
            .iter()
            .map(|current| (current.pty_id.as_str(), current.source_session_id.as_str()))
            .collect()
    }

    /// The thread of a terminal after `/clear`: T1 ran in this Codex process
    /// and went quiet, then the new thread T2 started its turn.
    struct ClearedTerminal {
        _temp: tempfile::TempDir,
        root: PathBuf,
        project: PathBuf,
        process_started: DateTime<Utc>,
        quiet_since: DateTime<Utc>,
    }

    fn cleared_terminal() -> ClearedTerminal {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join(".codex");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project dir");
        let process_started = Utc::now() - Duration::hours(1);
        let first = process_started + Duration::minutes(1);
        rollout(&root, T1, "codex-tui", &project, first, &turn(first));
        let quiet_since = first + Duration::minutes(1);
        let cleared = quiet_since + Duration::minutes(5);
        rollout(
            &root,
            T2,
            "codex-tui",
            &project,
            cleared,
            &[("task_started", cleared)],
        );
        ClearedTerminal {
            _temp: temp,
            root,
            project,
            process_started,
            quiet_since,
        }
    }

    #[test]
    fn a_rollout_tells_where_its_thread_started_and_when_its_turn_and_activity_were() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join(".codex");
        let start = Utc::now() - Duration::hours(2);
        let second = start + Duration::minutes(10);
        rollout(
            &root,
            T1,
            "codex-tui",
            temp.path(),
            start,
            &[
                ("task_started", start),
                ("task_complete", start + Duration::minutes(1)),
                ("task_started", second),
                ("task_complete", second + Duration::minutes(1)),
                ("thread_settings_applied", second + Duration::minutes(30)),
            ],
        );
        let path = codex::index(&root).remove(T1).expect("indexed rollout");
        let thread = codex::thread_activity(&path).expect("thread");
        assert_eq!(thread.cwd.as_deref(), Some(&*temp.path().to_string_lossy()));
        assert_eq!(thread.originator.as_deref(), Some("codex-tui"));
        assert_eq!(thread.turn_started_at, Some(second));
        assert_eq!(
            thread.last_activity_at,
            Some(second + Duration::minutes(1)),
            "settings the agent applies are no activity"
        );

        write(
            &path,
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n",
        );
        assert_eq!(codex::thread_activity(&path), None, "no session_meta");
    }

    #[test]
    fn a_codex_terminal_moves_to_the_only_thread_its_process_started_after_its_session_went_quiet()
    {
        let fixture = cleared_terminal();
        let surfaces = [codex_surface("pty-a", T1, &fixture.project)];
        let terminals = [codex_terminal(
            "pty-a",
            &fixture.project,
            fixture.process_started,
        )];
        let current = codex_current_sessions(&fixture.root, &terminals, &surfaces);
        assert_eq!(moves(&current), vec![("pty-a", T2)]);
        assert_eq!(current[0].agent_session_id, format!("codex:{T2}"));
        assert_eq!(current[0].source, AgentAdapterKind::Codex.id());
        assert!(current[0].approximate);

        // `/resume` of an earlier thread: its new turn tells it.
        let surfaces = [codex_surface("pty-a", T2, &fixture.project)];
        let resumed = Utc::now() - Duration::minutes(1);
        rollout(
            &fixture.root,
            T3,
            "codex-tui",
            &fixture.project,
            fixture.process_started - Duration::days(2),
            &[
                ("task_started", fixture.process_started - Duration::days(2)),
                ("task_started", resumed),
            ],
        );
        rollout(
            &fixture.root,
            T2,
            "codex-tui",
            &fixture.project,
            fixture.quiet_since,
            &turn(fixture.quiet_since),
        );
        assert_eq!(
            moves(&codex_current_sessions(
                &fixture.root,
                &terminals,
                &surfaces
            )),
            vec![("pty-a", T3)]
        );
    }

    #[test]
    fn a_codex_terminal_keeps_its_session_on_any_doubt() {
        let fixture = cleared_terminal();
        let surfaces = [codex_surface("pty-a", T1, &fixture.project)];
        let terminal = codex_terminal("pty-a", &fixture.project, fixture.process_started);
        let follow = |terminals: &[CodexTerminal], surfaces: &[AgentTerminalSurface]| {
            moves(&codex_current_sessions(&fixture.root, terminals, surfaces))
                .into_iter()
                .map(|(pty, thread)| (pty.to_string(), thread.to_string()))
                .collect::<Vec<_>>()
        };
        let none = Vec::<(String, String)>::new();

        // Another live Codex terminal of Svode in the cwd, linked or not.
        let other = codex_terminal("pty-b", &fixture.project, fixture.process_started);
        assert_eq!(follow(&[terminal.clone(), other.clone()], &surfaces), none);
        let elsewhere = tempfile::tempdir().expect("other dir");
        let linked = codex_terminal("pty-b", elsewhere.path(), fixture.process_started);
        assert_eq!(
            follow(
                &[terminal.clone(), linked.clone()],
                &[
                    surfaces[0].clone(),
                    codex_surface("pty-b", T1, &fixture.project)
                ]
            ),
            none,
            "the other terminal runs a session of this cwd"
        );
        assert_eq!(
            follow(&[terminal.clone(), linked], &surfaces),
            vec![("pty-a".to_string(), T2.to_string())],
            "a Codex terminal in another cwd is no obstacle"
        );

        // No Codex session linked to the terminal, or none it can read.
        assert_eq!(follow(std::slice::from_ref(&terminal), &[]), none);
        let mut claude = surfaces[0].clone();
        claude.source = AgentAdapterKind::ClaudeCode.id();
        assert_eq!(follow(std::slice::from_ref(&terminal), &[claude]), none);
        assert_eq!(
            follow(
                std::slice::from_ref(&terminal),
                &[codex_surface("pty-a", T4, &fixture.project)]
            ),
            none,
            "the session of the terminal has no rollout"
        );
        let mut unknown_start = terminal.clone();
        unknown_start.started_at = None;
        assert_eq!(follow(&[unknown_start], &surfaces), none);

        // The turn started before the Codex process of the terminal: the
        // session is just continued in it, as on re-entry.
        let mut later = terminal.clone();
        later.started_at = Some(Utc::now() - Duration::minutes(10));
        assert_eq!(follow(&[later], &surfaces), none);

        // The session of the terminal is active after the turn started.
        rollout(
            &fixture.root,
            T1,
            "codex-tui",
            &fixture.project,
            fixture.process_started,
            &[
                ("task_started", fixture.process_started),
                ("task_complete", Utc::now()),
            ],
        );
        assert_eq!(follow(std::slice::from_ref(&terminal), &surfaces), none);
    }

    #[test]
    fn a_thread_of_another_cwd_or_client_or_a_second_one_is_no_single_candidate() {
        for (originator, cwd_of_thread, why) in [
            ("codex_work_desktop", None, "a thread the Codex app started"),
            ("svode", None, "a thread the chat of Svode started"),
            ("codex-tui", Some("elsewhere"), "a thread of another cwd"),
        ] {
            let fixture = cleared_terminal();
            let cwd = cwd_of_thread
                .map(|dir| fixture.project.parent().unwrap().join(dir))
                .unwrap_or_else(|| fixture.project.clone());
            fs::create_dir_all(&cwd).unwrap();
            let started = fixture.quiet_since + Duration::minutes(5);
            rollout(
                &fixture.root,
                T2,
                originator,
                &cwd,
                started,
                &[("task_started", started)],
            );
            let current = codex_current_sessions(
                &fixture.root,
                &[codex_terminal(
                    "pty-a",
                    &fixture.project,
                    fixture.process_started,
                )],
                &[codex_surface("pty-a", T1, &fixture.project)],
            );
            assert!(current.is_empty(), "{why}");
        }

        let fixture = cleared_terminal();
        let started = fixture.quiet_since + Duration::minutes(6);
        rollout(
            &fixture.root,
            T3,
            "codex-tui",
            &fixture.project,
            started,
            &[("task_started", started)],
        );
        let current = codex_current_sessions(
            &fixture.root,
            &[codex_terminal(
                "pty-a",
                &fixture.project,
                fixture.process_started,
            )],
            &[codex_surface("pty-a", T1, &fixture.project)],
        );
        assert!(current.is_empty(), "two candidates");
    }

    #[test]
    fn a_terminal_without_a_codex_process_is_no_codex_terminal() {
        let started = Utc::now() - Duration::hours(1);
        let named = |pid: u32, depth: usize, name: &str| PtyProcess {
            name: name.to_string(),
            ..process(pid, depth, started)
        };
        let pty = |pty_id: &str, processes: Vec<PtyProcess>| LivePtyProcesses {
            pty_id: pty_id.to_string(),
            cwd: "/tmp/project".to_string(),
            processes,
        };
        let terminals = codex_terminals(&[
            pty("shell", vec![named(1, 0, "zsh")]),
            pty("node", vec![named(2, 0, "zsh"), named(3, 1, "node")]),
            pty(
                "npm",
                vec![
                    named(4, 0, "zsh"),
                    named(5, 1, "node"),
                    named(6, 2, "codex"),
                ],
            ),
            pty(
                "windows",
                vec![named(7, 0, "pwsh.exe"), named(8, 1, "codex.exe")],
            ),
            pty("acp", vec![named(9, 0, "zsh"), named(10, 1, "codex-acp")]),
        ]);
        assert_eq!(
            terminals
                .iter()
                .map(|terminal| terminal.pty_id.as_str())
                .collect::<Vec<_>>(),
            vec!["npm", "windows"]
        );
        assert_eq!(
            terminals[0].started_at,
            DateTime::from_timestamp(started.timestamp(), 0)
        );
    }

    #[test]
    fn a_live_codex_terminal_follows_its_thread_approximately() {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        let state = AgentSessionsState::with_home(home.clone());
        write(
            &project.join(".svode/config.json"),
            &serde_json::json!({ "name": "Project", "spaces": [] }).to_string(),
        );
        let root = home.join(".codex");
        let process_started = Utc::now() - Duration::hours(1);
        let first = process_started + Duration::minutes(1);
        rollout(&root, T1, "codex-tui", &project, first, &turn(first));
        let cleared = first + Duration::minutes(10);
        rollout(
            &root,
            T2,
            "codex-tui",
            &project,
            cleared,
            &[("task_started", cleared)],
        );
        let list = SessionList {
            sessions: [T1, T2]
                .iter()
                .map(|id| ListedSession {
                    key: SessionKey::from_acp("codex", id, true),
                    cwd: project.clone(),
                    title: Some(format!("Thread {id}")),
                    updated_at: Some(at(cleared)),
                })
                .collect(),
            ..Default::default()
        };
        state.acp_lists.apply("codex", Ok(list), 3);
        let writers = WriterRegistry::default();
        let terminals = TerminalManager::new(writers.clone());
        terminals.insert_shell_for_test("pty-a", &project);
        terminals
            .register_existing_agent_session(
                "pty-a".to_string(),
                format!("codex:{T1}"),
                None,
                AgentAdapterKind::Codex.id(),
                T1.to_string(),
                None,
                None,
            )
            .expect("register the terminal");
        let codex_key = |id: &str| native_writer_key(&AgentAdapterKind::Codex.id(), id);
        let read = |terminals: &TerminalManager| {
            list_sessions(
                &state,
                project.to_string_lossy().into_owned(),
                terminals.list_agent_surfaces().unwrap(),
                Vec::new(),
            )
            .expect("list sessions")
        };

        let before = read(&terminals);
        let session = by_id(&before, &format!("codex:{T1}"));
        assert_eq!(pty_of(session), Some("pty-a"));
        assert!(!session.runtime.as_ref().unwrap().approximate_binding);

        let current = codex_current_sessions(
            &root,
            &[codex_terminal("pty-a", &project, process_started)],
            &terminals.list_agent_surfaces().unwrap(),
        );
        terminals.follow_current_sessions(&current).unwrap();

        let after = read(&terminals);
        let previous = by_id(&after, &format!("codex:{T1}"));
        let now = by_id(&after, &format!("codex:{T2}"));
        assert_eq!(pty_of(previous), None);
        assert_eq!(pty_of(now), Some("pty-a"));
        let runtime = now.runtime.as_ref().unwrap();
        assert!(runtime.approximate_binding);
        assert_eq!(
            serde_json::to_value(runtime).unwrap()["approximateBinding"],
            serde_json::json!(true)
        );
        assert_eq!(writers.writer(&codex_key(T1)), None);
        assert_eq!(writers.writer(&codex_key(T2)), Some(Writer::Pty));

        // The next boundary finds no other thread: the terminal stays.
        let current = codex_current_sessions(
            &root,
            &[codex_terminal("pty-a", &project, process_started)],
            &terminals.list_agent_surfaces().unwrap(),
        );
        assert!(current.is_empty());
        terminals.kill("pty-a").unwrap();
    }
}

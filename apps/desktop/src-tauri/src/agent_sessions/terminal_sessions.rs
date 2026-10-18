//! The session the agent process in a managed PTY runs now (DF-163 R2).
//! Claude Code records each of its processes in `sessions/<pid>.json` of its
//! config directory, and the record follows the session the process runs,
//! one started inside it (`/clear`, `/resume`, a fork) included. Only the
//! processes in the tree of the PTY shell are looked up, and a reused pid is
//! told by the process start time, as for the process records of `07` N4.
//! The check runs at the refresh boundaries of the read-model (list,
//! refresh, hot status); a PTY without such evidence keeps its link, and the
//! terminals of agents without a record keep the frontend's first match.

use std::io::ErrorKind;
use std::path::Path;

use chrono::{DateTime, Duration, Utc};
use serde_json::Value;
use svode_core::agent_adapters::{AgentAdapterKind, AgentId};

use super::AgentSessionsState;
use super::native_status::claude_code;
use super::native_status::process::{ProcessRecord, ProcessSignal, signal_of};
use super::types::{catalog_session_id, native_writer_key};
use crate::terminal::{CurrentPtySession, PtyProcess, TerminalManager};

/// Claude Code writes the record after its process starts; the start time
/// of a process is read in whole seconds.
const RECORD_START_TOLERANCE: Duration = Duration::seconds(2);

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
    let current = ptys
        .into_iter()
        .filter_map(|pty| {
            let session_id = current_session(&records, &pty.processes)?;
            Some(CurrentPtySession {
                pty_id: pty.pty_id,
                agent_session_id: catalog_session_id(
                    &agent,
                    &native_writer_key(&agent, &session_id),
                ),
                source: agent.clone(),
                source_session_id: session_id,
            })
        })
        .collect::<Vec<_>>();
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
}

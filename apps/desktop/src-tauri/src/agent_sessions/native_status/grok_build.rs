//! Grok Build's native status (Stage 10 `07` N7): the bounded tail of a
//! session's turn event log and, for an open turn, the TUI registry of
//! active sessions as the signal of the process that holds it. No other
//! file of the session folder is opened (N3).

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Duration, Utc};
use serde_json::Value;

use super::jsonl_tail::{TAIL_BYTES, for_each_tail_line};
use super::process::ProcessRecord;
use super::session_logs::SessionLogLayout;
use super::{NativeStatusEvidence, StoreRead, parse_timestamp_value, string_field};
use svode_agents::status::{InteractionKind, SessionState, StopReason};

const EVENTS_FILE: &str = "events.jsonl";
const REGISTRY_FILE: &str = "active_sessions.json";
/// The format version of the turn events this reader knows (N5).
const SCHEMA_VERSION: &str = "1.0";
/// The TUI registers its session after its process started; the margin
/// covers the second precision of a process start time.
const REGISTRY_START_TOLERANCE: Duration = Duration::seconds(2);

/// The Grok home as Grok Build resolves it: a non-empty `GROK_HOME`, else
/// `.grok` in the home folder (`HOME`, on Windows `USERPROFILE`). `var`
/// reads the environment Grok Build runs in.
pub(super) fn grok_home(home: &Path, var: impl Fn(&str) -> Option<OsString>) -> PathBuf {
    var("GROK_HOME")
        .filter(|env| !env.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".grok"))
}

/// The session folders under the Grok home with the TUI registry beside
/// them. `root` finds the Grok home when the source reads.
pub(super) struct SessionEvents<R> {
    pub root: R,
}

impl<R> SessionLogLayout for SessionEvents<R>
where
    R: Fn() -> PathBuf + Send + Sync,
{
    /// `sessions/<encoded cwd>/<id>/events.jsonl` by session id. The folder
    /// of a canonicalized or hashed `cwd` does not name the listed `cwd`, so
    /// a session is found by its id in every group.
    fn index(&self) -> HashMap<String, PathBuf> {
        let mut files = HashMap::new();
        let Ok(groups) = std::fs::read_dir((self.root)().join("sessions")) else {
            return files;
        };
        for group in groups.flatten() {
            let Ok(sessions) = std::fs::read_dir(group.path()) else {
                continue;
            };
            for session in sessions.flatten() {
                let events = session.path().join(EVENTS_FILE);
                if let Some(id) = session.file_name().to_str()
                    && events.is_file()
                {
                    files.insert(id.to_string(), events);
                }
            }
        }
        files
    }

    fn companions(&self, log: &Path) -> Vec<PathBuf> {
        registry_of(log).into_iter().collect()
    }

    fn read(&self, log: &Path) -> Result<StoreRead, String> {
        let status = read_events(log)?;
        let process = if status.as_ref().is_some_and(|status| status.state.in_turn()) {
            log.parent()
                .and_then(Path::file_name)
                .and_then(|id| id.to_str())
                .zip(registry_of(log))
                .and_then(|(id, registry)| registered_process(&registry, id))
        } else {
            None
        };
        Ok(StoreRead {
            status,
            launch_id: None,
            process,
        })
    }
}

/// The registry in the Grok home of `<home>/sessions/<group>/<id>/events.jsonl`.
fn registry_of(log: &Path) -> Option<PathBuf> {
    Some(log.ancestors().nth(4)?.join(REGISTRY_FILE))
}

/// The session's state from the tail of its turn events. A tail without a
/// turn event gives no status.
fn read_events(path: &Path) -> Result<Option<NativeStatusEvidence>, String> {
    let mut tail = EventsTail::default();
    let mut problem = None;
    for_each_tail_line(path, TAIL_BYTES, |event| {
        if problem.is_none()
            && let Err(error) = tail.observe(&event)
        {
            problem = Some(error);
        }
    })
    .map_err(|error| format!("{EVENTS_FILE} cannot be read: {error}"))?;
    if let Some(problem) = problem {
        return Err(problem);
    }
    match tail.version.as_deref() {
        Some(version) if version != SCHEMA_VERSION => Err(format!(
            "turn events have the unknown format version {version}"
        )),
        _ => Ok(tail.status),
    }
}

#[derive(Default)]
struct EventsTail {
    status: Option<NativeStatusEvidence>,
    /// The last turn event opened or continued a turn.
    open: bool,
    /// The format version of the last turn started within the tail (N5).
    version: Option<String>,
}

impl EventsTail {
    /// Follows one event; an unknown event type, such as the background
    /// events between turns, changes nothing (N5). A turn event without a
    /// field the reader needs fails the source.
    fn observe(&mut self, event: &Value) -> Result<(), String> {
        let at = event.get("ts").and_then(parse_timestamp_value);
        match string_field(event, &["type"]).unwrap_or_default() {
            "turn_started" => {
                let version = required(event, "turn_started", "schema_version")?;
                self.version = Some(version.to_string());
                self.in_turn(SessionState::Running, at, "grok turn started");
            }
            "phase_changed" => {
                let phase = required(event, "phase_changed", "phase")?;
                if self.continues_turn() {
                    match phase {
                        "permission_prompt" => self.awaiting_permission(at),
                        "waiting_for_model"
                        | "streaming_text"
                        | "streaming_reasoning"
                        | "tool_execution" => {
                            self.in_turn(SessionState::Running, at, "grok turn in progress")
                        }
                        _ => self.in_turn(SessionState::Unknown, at, "grok turn phase unknown"),
                    }
                }
            }
            "permission_requested" => {
                if self.continues_turn() {
                    self.awaiting_permission(at);
                }
            }
            "permission_resolved" => {
                if self.continues_turn() {
                    self.in_turn(SessionState::Running, at, "grok permission resolved");
                }
            }
            "turn_ended" => {
                let outcome = required(event, "turn_ended", "outcome")?;
                let stop_reason = match outcome {
                    "completed" => StopReason::EndTurn,
                    "cancelled" => StopReason::Cancelled,
                    "error" => StopReason::Error,
                    "interrupted" => StopReason::Interrupted,
                    _ => {
                        self.ended(
                            SessionState::Unknown,
                            at,
                            "grok turn outcome unknown".into(),
                        );
                        return Ok(());
                    }
                };
                let reason = match cancellation_category(event) {
                    Some(category) => format!("grok turn {outcome}: {category}"),
                    None => format!("grok turn {outcome}"),
                };
                self.ended(
                    SessionState::Idle {
                        stop_reason: Some(stop_reason),
                    },
                    at,
                    reason,
                );
            }
            _ => {}
        }
        Ok(())
    }

    /// A phase or permission event belongs to the open turn. The bounded
    /// tail may begin inside a long turn, so such an event before any turn
    /// event of the tail continues one; after the turn ended it does not
    /// reopen it.
    fn continues_turn(&self) -> bool {
        self.open || self.status.is_none()
    }

    fn awaiting_permission(&mut self, at: Option<DateTime<Utc>>) {
        let waiting_since = match &self.status {
            Some(NativeStatusEvidence {
                state: SessionState::RequiresAction { .. },
                waiting_since,
                ..
            }) if self.open => waiting_since.or(at),
            _ => at,
        };
        self.in_turn(
            SessionState::RequiresAction {
                request: InteractionKind::Permission,
            },
            at,
            "grok turn waiting for permission",
        );
        if let Some(status) = self.status.as_mut() {
            status.waiting_since = waiting_since;
        }
    }

    fn in_turn(&mut self, state: SessionState, at: Option<DateTime<Utc>>, reason: &str) {
        self.open = true;
        self.status = Some(NativeStatusEvidence {
            state,
            reason: reason.to_string(),
            observed_at: at,
            waiting_since: None,
        });
    }

    fn ended(&mut self, state: SessionState, at: Option<DateTime<Utc>>, reason: String) {
        self.open = false;
        self.status = Some(NativeStatusEvidence {
            state,
            reason,
            observed_at: at,
            waiting_since: None,
        });
    }
}

fn required<'a>(event: &'a Value, kind: &str, field: &str) -> Result<&'a str, String> {
    event
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{kind} event lacks {field}"))
}

/// A known category of a cancelled turn; its free-text context is never
/// read (N3).
fn cancellation_category(event: &Value) -> Option<&'static str> {
    match event.get("cancellation_category")?.as_str()? {
        "mid_turn_abort" => Some("mid_turn_abort"),
        "permission_rejected" => Some("permission_rejected"),
        "permission_cancelled" => Some("permission_cancelled"),
        "hook_denied" => Some("hook_denied"),
        _ => None,
    }
}

/// The TUI's record of the process that opened the session, read without
/// its lock: Grok Build replaces the file by an atomic rename. A missing or
/// unreadable registry, or a malformed entry, is no record; the registry
/// keeps no host.
fn registered_process(registry: &Path, session_id: &str) -> Option<ProcessRecord> {
    let bytes = std::fs::read(registry).ok()?;
    let entries = serde_json::from_slice::<Vec<Value>>(&bytes).ok()?;
    entries
        .iter()
        .filter(|entry| entry.get("session_id").and_then(Value::as_str) == Some(session_id))
        .filter_map(|entry| {
            let pid = u32::try_from(entry.get("pid")?.as_u64()?).ok()?;
            let opened_at = entry.get("opened_at").and_then(parse_timestamp_value)?;
            Some(ProcessRecord {
                pid,
                host: None,
                started_by: opened_at + REGISTRY_START_TOLERANCE,
            })
        })
        .next_back()
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::Arc;

    use serde_json::json;
    use svode_agents::catalog::{ListedSession, SessionList};
    use svode_agents::identity::SessionKey;
    use svode_agents::status::StatusSource;
    use svode_agents::writer::ExternalLiveness;
    use svode_core::agent_adapters::AgentAdapterKind;

    use super::*;
    use crate::agent_sessions::AgentSessionsState;
    use crate::agent_sessions::live_status::SOURCE_LOG_ACTIVE_STALE_AFTER_SECS;
    use crate::agent_sessions::native_status::session_logs::SessionLogs;
    use crate::agent_sessions::types::AgentSession;

    const PERMISSION: SessionState = SessionState::RequiresAction {
        request: InteractionKind::Permission,
    };

    fn idle(stop_reason: StopReason) -> SessionState {
        SessionState::Idle {
            stop_reason: Some(stop_reason),
        }
    }

    fn ts(minutes_ago: i64) -> String {
        (Utc::now() - Duration::minutes(minutes_ago))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    fn turn_started(at: &str) -> Value {
        json!({
            "ts": at,
            "type": "turn_started",
            "session_id": "s1",
            "turn_number": 1,
            "model_id": "grok-build",
            "yolo_mode": false,
            "conversation_message_count": 0,
            "session_relationship": "primary",
            "schema_version": "1.0"
        })
    }

    fn phase(at: &str, phase: &str) -> Value {
        json!({ "ts": at, "type": "phase_changed", "phase": phase })
    }

    fn turn_ended(at: &str, outcome: &str) -> Value {
        json!({ "ts": at, "type": "turn_ended", "outcome": outcome })
    }

    /// Writes the session's events under the Grok home, each line ended.
    fn write_events(root: &Path, group: &str, id: &str, events: &[Value]) -> PathBuf {
        let path = root.join("sessions").join(group).join(id).join(EVENTS_FILE);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let text = events
            .iter()
            .map(|event| format!("{event}\n"))
            .collect::<String>();
        std::fs::write(&path, text).unwrap();
        path
    }

    fn write_registry(root: &Path, entries: Value) {
        std::fs::create_dir_all(root).unwrap();
        std::fs::write(root.join(REGISTRY_FILE), entries.to_string()).unwrap();
    }

    fn registry_entry(id: &str, pid: u32) -> Value {
        json!({
            "session_id": id,
            "pid": pid,
            "cwd": "/tmp/project",
            "opened_at": Utc::now().to_rfc3339(),
        })
    }

    fn state_of(events: &[Value]) -> Result<Option<SessionState>, String> {
        let temp = tempfile::tempdir().unwrap();
        let path = write_events(temp.path(), "g", "s1", events);
        read_events(&path).map(|status| status.map(|status| status.state))
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

    fn exited_pid() -> u32 {
        let mut child = live_child();
        let pid = child.id();
        child.kill().expect("kill");
        child.wait().expect("reap");
        pid
    }

    fn at(root: &Path) -> SessionEvents<impl Fn() -> PathBuf + Send + Sync + use<>> {
        let root = root.to_path_buf();
        SessionEvents {
            root: move || root.clone(),
        }
    }

    #[test]
    fn the_grok_home_is_grok_home_or_dot_grok_in_the_home_folder() {
        let home = Path::new("home");
        let env = |value: Option<&str>| {
            let value = value.map(OsString::from);
            move |name: &str| (name == "GROK_HOME").then(|| value.clone()).flatten()
        };
        assert_eq!(grok_home(home, env(None)), home.join(".grok"));
        assert_eq!(grok_home(home, env(Some(""))), home.join(".grok"));
        assert_eq!(
            grok_home(home, env(Some("custom"))),
            PathBuf::from("custom")
        );
    }

    #[test]
    fn a_session_is_found_by_its_id_in_every_cwd_group() {
        let temp = tempfile::tempdir().unwrap();
        let canonical = write_events(temp.path(), "%2Fprivate%2Ftmp%2Fp", "s1", &[]);
        let hashed = write_events(temp.path(), "project-0123456789abcdef", "s2", &[]);
        std::fs::create_dir_all(temp.path().join("sessions/%2Ftmp/no-events")).unwrap();

        let files = at(temp.path()).index();
        assert_eq!(
            files,
            HashMap::from([("s1".to_string(), canonical), ("s2".to_string(), hashed)])
        );
    }

    #[test]
    fn an_open_turn_runs_and_a_permission_prompt_requires_action() {
        let started = ts(3);
        assert_eq!(
            state_of(&[turn_started(&started)]),
            Ok(Some(SessionState::Running))
        );
        assert_eq!(
            state_of(&[
                turn_started(&started),
                phase(&ts(2), "waiting_for_model"),
                phase(&ts(2), "streaming_text"),
                phase(&ts(1), "tool_execution"),
            ]),
            Ok(Some(SessionState::Running))
        );

        let temp = tempfile::tempdir().unwrap();
        let prompt_at = ts(2);
        let requested_at = ts(1);
        let path = write_events(
            temp.path(),
            "g",
            "s1",
            &[
                turn_started(&started),
                phase(&prompt_at, "permission_prompt"),
                json!({ "ts": requested_at, "type": "permission_requested", "tool_name": "bash" }),
            ],
        );
        let waiting = read_events(&path).unwrap().unwrap();
        assert_eq!(waiting.state, PERMISSION);
        assert_eq!(
            waiting.waiting_since,
            parse_timestamp_value(&json!(prompt_at)),
            "the wait counts from its prompt"
        );
        assert_eq!(
            waiting.observed_at,
            parse_timestamp_value(&json!(requested_at))
        );

        assert_eq!(
            state_of(&[
                turn_started(&started),
                json!({ "ts": ts(2), "type": "permission_requested", "tool_name": "bash" }),
            ]),
            Ok(Some(PERMISSION))
        );
        assert_eq!(
            state_of(&[
                turn_started(&started),
                phase(&ts(2), "permission_prompt"),
                json!({ "ts": ts(2), "type": "permission_requested", "tool_name": "bash" }),
                json!({
                    "ts": ts(1), "type": "permission_resolved",
                    "tool_name": "bash", "decision": "allow", "wait_ms": 10
                }),
                phase(&ts(1), "tool_execution"),
            ]),
            Ok(Some(SessionState::Running)),
            "a resolved permission continues the turn"
        );
    }

    #[test]
    fn each_known_turn_outcome_ends_the_turn_with_its_reason() {
        for (outcome, state) in [
            ("completed", idle(StopReason::EndTurn)),
            ("cancelled", idle(StopReason::Cancelled)),
            ("error", idle(StopReason::Error)),
            ("interrupted", idle(StopReason::Interrupted)),
            ("timed_out", SessionState::Unknown),
        ] {
            assert_eq!(
                state_of(&[
                    turn_started(&ts(3)),
                    phase(&ts(2), "permission_prompt"),
                    turn_ended(&ts(1), outcome),
                ]),
                Ok(Some(state)),
                "{outcome}"
            );
        }

        let temp = tempfile::tempdir().unwrap();
        let path = write_events(
            temp.path(),
            "g",
            "s1",
            &[
                turn_started(&ts(3)),
                json!({
                    "ts": ts(1), "type": "turn_ended", "outcome": "cancelled",
                    "cancellation_category": "mid_turn_abort",
                    "cancellation_context": { "message": "free text" }
                }),
            ],
        );
        let cancelled = read_events(&path).unwrap().unwrap();
        assert_eq!(cancelled.reason, "grok turn cancelled: mid_turn_abort");
    }

    #[test]
    fn background_events_between_turns_and_unknown_events_change_nothing() {
        assert_eq!(
            state_of(&[
                turn_started(&ts(5)),
                turn_ended(&ts(4), "completed"),
                json!({ "ts": ts(3), "type": "mcp_server_starting", "server_name": "x" }),
                json!({ "ts": ts(3), "type": "goal_auto_paused", "reason": "user" }),
                json!({ "ts": ts(2), "type": "yolo_toggled", "enabled": true }),
                json!({ "ts": ts(1), "type": "an_event_of_a_later_version" }),
                json!({ "ts": ts(1), "type": "phase_changed", "phase": "tool_execution" }),
            ]),
            Ok(Some(idle(StopReason::EndTurn))),
            "a phase after the turn ended does not reopen it"
        );
        assert_eq!(
            state_of(&[json!({ "ts": ts(1), "type": "mcp_init_completed" })]),
            Ok(None),
            "a tail without a turn event gives no status"
        );
        assert_eq!(
            state_of(&[turn_started(&ts(2)), phase(&ts(1), "compacting")]),
            Ok(Some(SessionState::Unknown)),
            "an unknown phase is an unknown session"
        );
    }

    #[test]
    fn a_tail_that_begins_inside_a_long_turn_keeps_it_open() {
        let temp = tempfile::tempdir().unwrap();
        let mut events = vec![turn_started(&ts(10))];
        let fragments = (TAIL_BYTES as usize / 60) + 10;
        events.extend((0..fragments).map(|_| phase(&ts(2), "streaming_text")));
        events.push(phase(&ts(1), "permission_prompt"));
        let path = write_events(temp.path(), "g", "s1", &events);
        assert!(std::fs::metadata(&path).unwrap().len() > TAIL_BYTES);
        assert_eq!(read_events(&path).unwrap().unwrap().state, PERMISSION);
    }

    #[test]
    fn another_format_version_or_a_missing_field_fails_the_source() {
        let mut other = turn_started(&ts(1));
        other["schema_version"] = json!("2.0");
        assert_eq!(
            state_of(&[other.clone()]),
            Err("turn events have the unknown format version 2.0".to_string())
        );
        assert_eq!(
            state_of(&[
                other.clone(),
                turn_ended(&ts(2), "completed"),
                turn_started(&ts(1))
            ]),
            Ok(Some(SessionState::Running)),
            "the last turn started gives the version"
        );
        assert_eq!(
            state_of(&[turn_started(&ts(3)), turn_ended(&ts(2), "completed"), other]),
            Err("turn events have the unknown format version 2.0".to_string())
        );
        let mut unversioned = turn_started(&ts(1));
        unversioned
            .as_object_mut()
            .unwrap()
            .remove("schema_version");
        assert_eq!(
            state_of(&[unversioned]),
            Err("turn_started event lacks schema_version".to_string())
        );
        assert_eq!(
            state_of(&[
                turn_started(&ts(2)),
                json!({ "ts": ts(1), "type": "turn_ended" })
            ]),
            Err("turn_ended event lacks outcome".to_string())
        );
    }

    #[test]
    fn an_open_turn_reads_its_process_from_the_registry_entry_of_its_session() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let open = write_events(root, "g", "s1", &[turn_started(&ts(1))]);
        let closed = write_events(
            root,
            "g",
            "s2",
            &[turn_started(&ts(2)), turn_ended(&ts(1), "completed")],
        );
        let layout = at(root);
        assert_eq!(layout.companions(&open), vec![root.join(REGISTRY_FILE)]);
        assert_eq!(
            layout.read(&open).unwrap().process,
            None,
            "no registry, no record"
        );

        let opened_at = Utc::now();
        write_registry(
            root,
            json!([
                registry_entry("other", 11),
                { "session_id": "s1", "pid": 4242, "cwd": "/tmp/p",
                  "opened_at": opened_at.to_rfc3339() },
                { "session_id": "s2", "pid": 4343, "cwd": "/tmp/p",
                  "opened_at": opened_at.to_rfc3339() },
            ]),
        );
        assert_eq!(
            layout.read(&open).unwrap().process,
            Some(ProcessRecord {
                pid: 4242,
                host: None,
                started_by: opened_at + REGISTRY_START_TOLERANCE,
            })
        );
        assert_eq!(
            layout.read(&closed).unwrap().process,
            None,
            "a closed turn needs no signal"
        );

        std::fs::write(root.join(REGISTRY_FILE), "[{\"session_id\":").unwrap();
        assert_eq!(layout.read(&open).unwrap().process, None);
    }

    /// A Grok Build session listed in the project with its events under the
    /// Grok home of `home`.
    fn listed_grok(
        state: &AgentSessionsState,
        home: &Path,
        project: &Path,
        sessions: &[(&str, Vec<Value>)],
    ) {
        let root = home.join(".grok");
        for (id, events) in sessions {
            write_events(&root, "%2Fproject", id, events);
        }
        let agent = AgentAdapterKind::GrokBuild.id();
        let list = SessionList {
            sessions: sessions
                .iter()
                .map(|(id, _)| ListedSession {
                    key: SessionKey::from_acp(agent.as_str(), id, true),
                    cwd: project.to_path_buf(),
                    title: Some(format!("ACP {id}")),
                    updated_at: Some("2026-09-30T10:00:00Z".to_string()),
                })
                .collect(),
            ..Default::default()
        };
        state.acp_lists.apply(agent.as_str(), Ok(list), 3);
        state
            .native_status
            .set_source(agent, Arc::new(SessionLogs::new(at(&root))));
    }

    fn project_dirs() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let temp = tempfile::tempdir().expect("temp dir");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        std::fs::create_dir_all(project.join(".svode")).unwrap();
        std::fs::write(
            project.join(".svode/config.json"),
            json!({ "name": "Project", "spaces": [] }).to_string(),
        )
        .unwrap();
        (temp, home, project)
    }

    fn listed(state: &AgentSessionsState, project: &Path) -> Vec<AgentSession> {
        crate::agent_sessions::read_model::list_sessions(
            state,
            project.to_string_lossy().into_owned(),
            Vec::new(),
            Vec::new(),
        )
        .expect("list sessions")
        .sessions
    }

    fn liveness(state: &AgentSessionsState, project: &Path, id: &str) -> ExternalLiveness {
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

    #[test]
    fn an_open_turn_follows_the_tui_process_registered_for_its_session() {
        let (_temp, home, project) = project_dirs();
        let state = AgentSessionsState::with_home(home.clone());
        let mut tui = live_child();
        let stale =
            (Utc::now() - Duration::seconds(SOURCE_LOG_ACTIVE_STALE_AFTER_SECS + 60)).to_rfc3339();
        listed_grok(
            &state,
            &home,
            &project,
            &[
                (
                    "alive",
                    vec![turn_started(&ts(2)), phase(&ts(1), "permission_prompt")],
                ),
                ("dead", vec![turn_started(&ts(1))]),
                ("unregistered", vec![turn_started(&ts(1))]),
                ("unregistered-stale", vec![turn_started(&stale)]),
                (
                    "ended",
                    vec![turn_started(&ts(2)), turn_ended(&ts(1), "completed")],
                ),
            ],
        );
        write_registry(
            &home.join(".grok"),
            json!([
                registry_entry("alive", tui.id()),
                registry_entry("dead", exited_pid()),
                registry_entry("ended", exited_pid()),
            ]),
        );

        let sessions = listed(&state, &project);
        let alive_liveness = liveness(&state, &project, "grok-build:alive");
        let unregistered_liveness = liveness(&state, &project, "grok-build:unregistered");
        tui.kill().ok();
        tui.wait().ok();

        let status = |id: &str| {
            sessions
                .iter()
                .find(|session| session.id == format!("grok-build:{id}"))
                .unwrap_or_else(|| panic!("{id} listed"))
                .status
        };
        assert_eq!(status("alive").state, PERMISSION);
        assert_eq!(status("alive").source, StatusSource::NativeStatusReader);
        assert_eq!(status("dead").state, idle(StopReason::Interrupted));
        assert_eq!(status("unregistered").state, SessionState::Running);
        assert_eq!(status("unregistered-stale").state, SessionState::Unknown);
        assert_eq!(status("ended").state, idle(StopReason::EndTurn));

        assert_eq!(alive_liveness, ExternalLiveness::ExternalActive);
        assert_eq!(unregistered_liveness, ExternalLiveness::Unknown);
    }

    #[test]
    fn another_format_version_is_a_diagnostic_of_grok_build() {
        let (_temp, home, project) = project_dirs();
        let state = AgentSessionsState::with_home(home.clone());
        let mut other = turn_started(&ts(1));
        other["schema_version"] = json!("2.0");
        listed_grok(&state, &home, &project, &[("s1", vec![other])]);

        let result = crate::agent_sessions::read_model::list_sessions(
            &state,
            project.to_string_lossy().into_owned(),
            Vec::new(),
            Vec::new(),
        )
        .expect("list sessions");
        let report = result
            .sources
            .iter()
            .find(|report| report.source == AgentAdapterKind::GrokBuild.id())
            .expect("grok build report");
        let diagnostic = &report.diagnostics[0];
        assert_eq!(diagnostic.code, "native-status-unavailable");
        assert!(
            diagnostic.message.contains("Grok Build"),
            "{}",
            diagnostic.message
        );
        assert!(diagnostic.message.contains("2.0"), "{}", diagnostic.message);
        let session = result
            .sessions
            .iter()
            .find(|session| session.id == "grok-build:s1")
            .expect("listed");
        assert_eq!(session.status.state, SessionState::Unknown);
    }
}

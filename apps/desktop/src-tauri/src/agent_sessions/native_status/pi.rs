//! pi's native status (Stage 10 `07` N4, N7): the tail of the session's
//! jsonl file. The header gives the format version; of the records only the
//! type, the message role, the stop reason and the time are kept (N3). pi
//! records no process, so an open turn has no liveness signal.

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::Value;

use super::jsonl_tail::{TAIL_BYTES, for_each_tail_line};
use super::session_logs::SessionLogLayout;
use super::{NativeStatusEvidence, StoreRead, parse_timestamp_str, parse_timestamp_value};
use svode_agents::status::{SessionState, StopReason};

/// The session format version the reader knows (pi v0.35.0 and later).
const FORMAT_VERSION: u64 = 3;
/// The header line holds the session id and folder only.
const HEADER_BYTES: u64 = 64 * 1024;
/// Bound of the settings file read for its `sessionDir`.
const SETTINGS_BYTES: u64 = 1024 * 1024;

/// pi's session files: `--<cwd>--/<timestamp>_<id>.jsonl` under the sessions
/// directory, or flat in a session directory the user set. `root` finds
/// the directory when the source reads.
pub(super) struct Sessions<R> {
    pub root: R,
}

/// The sessions directory on every OS (N7), as pi 1.0.0 finds it without
/// `--session-dir`: `PI_CODING_AGENT_SESSION_DIR`, else `sessionDir` of the
/// global `settings.json` in the agent directory, else `sessions` there. The
/// agent directory is `PI_CODING_AGENT_DIR`, else `~/.pi/agent`. `var` reads
/// the environment pi runs in. A relative `sessionDir`, which pi resolves
/// against the folder it runs in, and project settings are not followed.
pub(super) fn sessions_dir(home: &Path, var: impl Fn(&str) -> Option<OsString>) -> PathBuf {
    let expand = |dir: PathBuf| match dir.strip_prefix("~") {
        Ok(rest) => home.join(rest),
        Err(_) => dir,
    };
    let set = |name| {
        var(name)
            .filter(|dir: &OsString| !dir.is_empty())
            .map(|dir| expand(PathBuf::from(dir)))
    };
    if let Some(dir) = set("PI_CODING_AGENT_SESSION_DIR") {
        return dir;
    }
    let agent_dir = set("PI_CODING_AGENT_DIR").unwrap_or_else(|| home.join(".pi").join("agent"));
    settings_session_dir(&agent_dir.join("settings.json"))
        .map(|dir| expand(PathBuf::from(dir)))
        .filter(|dir| dir.is_absolute())
        .unwrap_or_else(|| agent_dir.join("sessions"))
}

/// `sessionDir` of pi's settings file. A missing, unreadable or malformed
/// file has none, as pi then starts with empty settings.
fn settings_session_dir(settings: &Path) -> Option<String> {
    let mut text = Vec::new();
    File::open(settings)
        .ok()?
        .take(SETTINGS_BYTES)
        .read_to_end(&mut text)
        .ok()?;
    let text = text.strip_prefix("\u{feff}".as_bytes()).unwrap_or(&text);
    let settings: Settings = serde_json::from_slice(text).ok()?;
    settings.session_dir.filter(|dir| !dir.is_empty())
}

/// The one setting the reader keeps.
#[derive(Deserialize)]
struct Settings {
    #[serde(rename = "sessionDir")]
    session_dir: Option<String>,
}

impl<R> SessionLogLayout for Sessions<R>
where
    R: Fn() -> PathBuf + Send + Sync,
{
    fn index(&self) -> HashMap<String, PathBuf> {
        let mut files = HashMap::new();
        let Ok(entries) = std::fs::read_dir((self.root)()) else {
            return files;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                let Ok(folder) = std::fs::read_dir(entry.path()) else {
                    continue;
                };
                for file in folder.flatten() {
                    insert_session_file(&mut files, file);
                }
            } else {
                insert_session_file(&mut files, entry);
            }
        }
        files
    }

    fn read(&self, log: &Path) -> Result<StoreRead, String> {
        Ok(StoreRead {
            status: read(log)?,
            launch_id: None,
            process: None,
        })
    }
}

/// A session file `<timestamp>_<id>.jsonl` by its session id.
fn insert_session_file(files: &mut HashMap<String, PathBuf>, entry: std::fs::DirEntry) {
    let path = entry.path();
    if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl")
        || !entry.file_type().is_ok_and(|kind| kind.is_file())
    {
        return;
    }
    if let Some((_, id)) = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .and_then(|stem| stem.split_once('_'))
        .filter(|(_, id)| !id.is_empty())
    {
        files.insert(id.to_string(), path.clone());
    }
}

/// The header fields the reader keeps.
#[derive(Deserialize)]
struct Header {
    #[serde(rename = "type")]
    kind: Option<String>,
    version: Option<Value>,
}

/// The status from the last message of the tail. A header of another
/// format version, or a record without a field the rule needs, fails the
/// source (N5); an unknown stop reason is an `unknown` session.
fn read(log: &Path) -> Result<Option<NativeStatusEvidence>, String> {
    let Some(header) = read_header(log).map_err(|error| error.to_string())? else {
        return Ok(None);
    };
    if header.kind.as_deref() != Some("session") {
        return Err("a pi session file without its session header".to_string());
    }
    if header.version.as_ref().and_then(Value::as_u64) != Some(FORMAT_VERSION) {
        let version = header
            .version
            .map_or_else(|| "none".to_string(), |version| version.to_string());
        return Err(format!(
            "pi session format version {version} is not supported"
        ));
    }
    let mut tail = Tail::default();
    let mut problem = None;
    for_each_tail_line(log, TAIL_BYTES, |record| {
        if problem.is_none()
            && let Err(error) = tail.observe(&record)
        {
            problem = Some(error);
        }
    })
    .map_err(|error| error.to_string())?;
    match problem {
        Some(problem) => Err(problem),
        None => Ok(tail.finish()),
    }
}

/// The first line of the file; `None` while it is not written whole.
fn read_header(log: &Path) -> std::io::Result<Option<Header>> {
    let mut line = Vec::new();
    BufReader::new(File::open(log)?.take(HEADER_BYTES)).read_until(b'\n', &mut line)?;
    if line.last() != Some(&b'\n') {
        return Ok(None);
    }
    Ok(serde_json::from_slice(&line).ok())
}

/// What the last message of the tail tells of the turn.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Turn {
    Running(&'static str),
    Idle(StopReason, &'static str),
    /// A failed request: pi retries or recovers when a context edit or a
    /// compaction follows it, otherwise the turn ended with the error.
    Failed,
    Unknown,
}

#[derive(Default)]
struct Tail {
    last: Option<(Turn, Option<DateTime<Utc>>)>,
}

impl Tail {
    fn observe(&mut self, record: &Value) -> Result<(), String> {
        let observed_at = record
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_timestamp_str);
        match record.get("type").and_then(Value::as_str) {
            Some("message") => {
                let message = record.get("message");
                let role = message.and_then(|message| message.get("role"));
                let turn = match role.and_then(Value::as_str) {
                    Some("user") => Turn::Running("pi message from the user"),
                    Some("toolResult") => Turn::Running("pi tool result"),
                    Some("assistant") => {
                        let Some(stop_reason) = message
                            .and_then(|message| message.get("stopReason"))
                            .and_then(Value::as_str)
                        else {
                            return Err("a pi assistant message without stopReason".to_string());
                        };
                        assistant_turn(stop_reason)
                    }
                    _ => return Ok(()),
                };
                let observed_at = observed_at.or_else(|| {
                    message
                        .and_then(|message| message.get("timestamp"))
                        .and_then(parse_timestamp_value)
                });
                self.last = Some((turn, observed_at));
            }
            Some("context_edit" | "compaction") => {
                if let Some((turn, at)) = &mut self.last
                    && *turn == Turn::Failed
                {
                    *turn = Turn::Running("pi retrying after an error");
                    *at = observed_at.or(*at);
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn finish(self) -> Option<NativeStatusEvidence> {
        let (turn, observed_at) = self.last?;
        let (state, reason) = match turn {
            Turn::Running(reason) => (SessionState::Running, reason),
            Turn::Idle(stop_reason, reason) => (
                SessionState::Idle {
                    stop_reason: Some(stop_reason),
                },
                reason,
            ),
            Turn::Failed => (
                SessionState::Idle {
                    stop_reason: Some(StopReason::Error),
                },
                "pi turn ended with an error",
            ),
            Turn::Unknown => (SessionState::Unknown, "pi stop reason not known"),
        };
        Some(NativeStatusEvidence {
            state,
            reason: reason.to_string(),
            observed_at,
            waiting_since: None,
        })
    }
}

fn assistant_turn(stop_reason: &str) -> Turn {
    match stop_reason {
        "stop" => Turn::Idle(StopReason::EndTurn, "pi turn completed"),
        "length" => Turn::Idle(StopReason::MaxTokens, "pi turn reached the output limit"),
        "aborted" => Turn::Idle(StopReason::Cancelled, "pi turn aborted"),
        "toolUse" => Turn::Running("pi tool call"),
        "error" => Turn::Failed,
        _ => Turn::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::NativeStatusReader;
    use super::super::session_logs::SessionLogs;
    use super::super::{NativeLogRead, NativeStatusSource};
    use super::*;
    use std::sync::Arc;
    use svode_core::agent_adapters::{AgentAdapterKind, AgentId};

    const ID: &str = "019a1b2c-3d4e-7f50-8a9b-0c1d2e3f4a5b";
    const SECRET: &str = "the user's private words";

    fn header() -> Value {
        json!({
            "type": "session",
            "version": 3,
            "id": ID,
            "timestamp": "2026-10-07T10:00:00.000Z",
            "cwd": "/tmp/project"
        })
    }

    fn message(minute: u32, message: Value) -> Value {
        json!({
            "type": "message",
            "id": format!("e{minute}"),
            "parentId": null,
            "timestamp": format!("2026-10-07T10:{minute:02}:00.000Z"),
            "message": message
        })
    }

    fn user(minute: u32) -> Value {
        message(
            minute,
            json!({ "role": "user", "content": SECRET, "timestamp": 1 }),
        )
    }

    fn assistant(minute: u32, stop_reason: &str) -> Value {
        message(
            minute,
            json!({
                "role": "assistant",
                "content": [{ "type": "text", "text": SECRET }],
                "stopReason": stop_reason,
                "errorMessage": SECRET
            }),
        )
    }

    fn tool_result(minute: u32) -> Value {
        message(
            minute,
            json!({ "role": "toolResult", "toolName": "bash", "content": SECRET, "isError": false }),
        )
    }

    fn entry(minute: u32, kind: &str) -> Value {
        json!({
            "type": kind,
            "id": format!("e{minute}"),
            "parentId": null,
            "timestamp": format!("2026-10-07T10:{minute:02}:00.000Z"),
            "targetId": "e1",
            "summary": SECRET,
            "replacement": { "content": SECRET }
        })
    }

    fn file(records: &[Value]) -> String {
        records.iter().map(|record| format!("{record}\n")).collect()
    }

    fn session_file(sessions: &Path, folder: &str, id: &str) -> PathBuf {
        sessions
            .join(folder)
            .join(format!("2026-10-07T10-00-00-000Z_{id}.jsonl"))
    }

    fn at(root: &Path) -> Sessions<impl Fn() -> PathBuf + Send + Sync + use<>> {
        let root = root.to_path_buf();
        Sessions {
            root: move || root.clone(),
        }
    }

    /// The reader with pi's source over these session files, without the
    /// login shell environment of the declared store.
    fn pi_reader(sessions: &Path) -> (NativeStatusReader, AgentId) {
        let reader = NativeStatusReader::new(PathBuf::from("/nonexistent"));
        let pi = AgentAdapterKind::Pi.id();
        reader.set_source(pi.clone(), Arc::new(SessionLogs::new(at(sessions))));
        (reader, pi)
    }

    fn write(path: &Path, data: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, data).unwrap();
    }

    fn status_of(data: &str) -> Result<Option<NativeStatusEvidence>, String> {
        let temp = tempfile::tempdir().unwrap();
        let log = session_file(temp.path(), "--tmp-project--", ID);
        write(&log, data);
        read(&log)
    }

    fn state_of(records: &[Value]) -> SessionState {
        status_of(&file(records))
            .expect("a known format")
            .expect("a status")
            .state
    }

    fn idle(stop_reason: StopReason) -> SessionState {
        SessionState::Idle {
            stop_reason: Some(stop_reason),
        }
    }

    #[test]
    fn the_last_message_tells_the_state_of_the_turn() {
        assert_eq!(
            state_of(&[header(), user(1), assistant(2, "stop")]),
            idle(StopReason::EndTurn)
        );
        assert_eq!(
            state_of(&[
                header(),
                user(1),
                assistant(2, "length"),
                entry(3, "context_edit")
            ]),
            idle(StopReason::MaxTokens),
            "a context edit after the output limit does not change the ended turn"
        );
        assert_eq!(
            state_of(&[header(), user(1), assistant(2, "aborted")]),
            idle(StopReason::Cancelled)
        );
        assert_eq!(
            state_of(&[header(), user(1), assistant(2, "toolUse")]),
            SessionState::Running
        );
        assert_eq!(
            state_of(&[header(), user(1), assistant(2, "toolUse"), tool_result(3)]),
            SessionState::Running
        );
        assert_eq!(
            state_of(&[header(), assistant(1, "stop"), user(2)]),
            SessionState::Running,
            "a message of the user without a reply"
        );
    }

    #[test]
    fn an_error_ends_the_turn_unless_pi_retries_it() {
        assert_eq!(
            state_of(&[header(), user(1), assistant(2, "error")]),
            idle(StopReason::Error)
        );
        let retrying = status_of(&file(&[
            header(),
            user(1),
            assistant(2, "error"),
            entry(3, "context_edit"),
        ]))
        .unwrap()
        .unwrap();
        assert_eq!(retrying.state, SessionState::Running);
        assert_eq!(
            retrying.observed_at,
            parse_timestamp_str("2026-10-07T10:03:00.000Z"),
            "the retry is the newest evidence of the turn"
        );
        assert_eq!(
            state_of(&[
                header(),
                user(1),
                assistant(2, "error"),
                entry(3, "context_edit"),
                assistant(4, "error"),
            ]),
            idle(StopReason::Error),
            "retries ran out"
        );
        assert_eq!(
            state_of(&[
                header(),
                user(1),
                assistant(2, "error"),
                entry(3, "compaction")
            ]),
            SessionState::Running,
            "pi recovers from an overflow by compaction"
        );
        assert_eq!(
            state_of(&[
                header(),
                user(1),
                assistant(2, "error"),
                entry(3, "context_edit"),
                assistant(4, "stop"),
            ]),
            idle(StopReason::EndTurn)
        );
    }

    #[test]
    fn an_unknown_stop_reason_is_an_unknown_state() {
        for stop_reason in ["pending", "deferred", "somethingNew"] {
            assert_eq!(
                state_of(&[header(), user(1), assistant(2, stop_reason)]),
                SessionState::Unknown,
                "{stop_reason}"
            );
        }
    }

    #[test]
    fn unknown_records_and_roles_are_skipped() {
        assert_eq!(
            state_of(&[
                header(),
                user(1),
                assistant(2, "stop"),
                entry(3, "model_change"),
                entry(4, "something_new"),
                message(5, json!({ "role": "bashExecution", "command": SECRET })),
            ]),
            idle(StopReason::EndTurn)
        );
    }

    #[test]
    fn a_compaction_in_the_same_file_and_a_fork_in_a_new_one() {
        assert_eq!(
            state_of(&[
                header(),
                user(1),
                assistant(2, "stop"),
                entry(3, "compaction"),
            ]),
            idle(StopReason::EndTurn),
            "a compaction after an ended turn keeps it ended"
        );
        assert_eq!(
            state_of(&[
                header(),
                user(1),
                assistant(2, "stop"),
                entry(3, "compaction"),
                user(4),
            ]),
            SessionState::Running
        );

        let temp = tempfile::tempdir().unwrap();
        let fork_id = "019a1b2c-3d4e-7f50-8a9b-0c1d2e3f4a5c";
        write(
            &session_file(temp.path(), "--tmp-project--", ID),
            &file(&[header(), user(1), assistant(2, "stop"), user(3)]),
        );
        let mut fork_header = header();
        fork_header["id"] = json!(fork_id);
        fork_header["parentSession"] = json!(ID);
        write(
            &session_file(temp.path(), "--tmp-project--", fork_id),
            &file(&[fork_header, user(1), assistant(2, "stop")]),
        );
        let source = SessionLogs::new(at(temp.path()));
        let reads = source.read(&[ID, fork_id]).unwrap();
        let state = |id: &str| reads.sessions[id].status.as_ref().unwrap().state;
        assert_eq!(state(ID), SessionState::Running);
        assert_eq!(state(fork_id), idle(StopReason::EndTurn));
    }

    #[test]
    fn another_format_version_fails_the_source() {
        for version in [json!(2), json!(4), json!("3"), Value::Null] {
            let mut other = header();
            other["version"] = version.clone();
            let problem = status_of(&file(&[other, user(1), assistant(2, "stop")]))
                .expect_err("an unknown format");
            assert!(problem.contains("version"), "{version}: {problem}");
        }
        let mut no_version = header();
        no_version.as_object_mut().unwrap().remove("version");
        assert!(status_of(&file(&[no_version, user(1)])).is_err());
        assert!(
            status_of(&file(&[user(1), assistant(2, "stop")])).is_err(),
            "a file without its header"
        );
        assert!(
            status_of(&file(&[
                header(),
                message(1, json!({ "role": "assistant", "content": [] })),
            ]))
            .is_err(),
            "an assistant message without its stop reason"
        );
    }

    #[test]
    fn an_unfinished_line_is_dropped() {
        let data = format!(
            "{}{{\"type\":\"message\",\"message\":{{\"role\":\"user\"",
            file(&[header(), user(1), assistant(2, "stop")])
        );
        assert_eq!(
            status_of(&data).unwrap().unwrap().state,
            idle(StopReason::EndTurn)
        );
        assert_eq!(
            status_of(&header().to_string()).unwrap(),
            None,
            "a header still being written"
        );
    }

    #[test]
    fn the_header_is_read_beyond_the_tail() {
        let mut records = vec![header()];
        let filler = "x".repeat(1024);
        for minute in 0..300 {
            records.push(message(
                minute % 60,
                json!({ "role": "user", "content": filler }),
            ));
        }
        records.push(assistant(59, "stop"));
        let data = file(&records);
        assert!(data.len() as u64 > TAIL_BYTES);
        assert_eq!(
            status_of(&data).unwrap().unwrap().state,
            idle(StopReason::EndTurn)
        );
    }

    #[test]
    fn no_message_text_is_kept() {
        let temp = tempfile::tempdir().unwrap();
        let log = session_file(temp.path(), "--tmp-project--", ID);
        for records in [
            vec![header(), user(1)],
            vec![header(), user(1), assistant(2, "error")],
            vec![
                header(),
                user(1),
                assistant(2, "error"),
                entry(3, "context_edit"),
            ],
            vec![
                header(),
                user(1),
                assistant(2, "stop"),
                entry(3, "compaction"),
            ],
        ] {
            write(&log, &file(&records));
            let source = SessionLogs::new(at(temp.path()));
            let reads = source.read(&[ID]).unwrap();
            let kept: &NativeLogRead = &reads.sessions[ID];
            let saved = serde_json::to_string(kept).unwrap();
            assert!(!saved.contains("private"), "{saved}");
        }
    }

    #[test]
    fn the_index_finds_sessions_by_id_in_cwd_folders_and_a_flat_folder() {
        let temp = tempfile::tempdir().unwrap();
        let nested = session_file(temp.path(), "--Users-me-project--", ID);
        write(&nested, "");
        let flat = temp
            .path()
            .join("2026-10-07T11-00-00-000Z_019a1b2c-flat.jsonl");
        write(&flat, "");
        write(&temp.path().join("--x--").join("notes.txt"), "");
        write(&temp.path().join("--x--").join("no-id.jsonl"), "");

        let index = at(temp.path()).index();
        assert_eq!(index.len(), 2, "{index:?}");
        assert_eq!(index[ID], nested);
        assert_eq!(index["019a1b2c-flat"], flat);
    }

    #[test]
    fn the_sessions_folder_is_under_the_agent_folder_unless_the_user_moved_it() {
        let home = Path::new("/home/me");
        let dir = |agent_dir: &'static str, session_dir: &'static str| {
            sessions_dir(home, |name| {
                match name {
                    "PI_CODING_AGENT_DIR" => Some(agent_dir),
                    "PI_CODING_AGENT_SESSION_DIR" => Some(session_dir),
                    _ => None,
                }
                .filter(|value| *value != "unset")
                .map(OsString::from)
            })
        };
        assert_eq!(
            dir("unset", "unset"),
            home.join(".pi").join("agent").join("sessions")
        );
        assert_eq!(
            dir("/data/pi", "unset"),
            Path::new("/data/pi").join("sessions")
        );
        assert_eq!(
            dir("~/pi-agent", "unset"),
            home.join("pi-agent").join("sessions")
        );
        assert_eq!(
            dir("/data/pi", "/data/sessions"),
            PathBuf::from("/data/sessions")
        );
        assert_eq!(
            dir("", ""),
            home.join(".pi").join("agent").join("sessions"),
            "an empty variable is not set"
        );
    }

    #[test]
    fn the_global_settings_move_the_sessions_folder_after_the_variable() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let agent_dir = home.join(".pi").join("agent");
        let moved = temp.path().join("moved");
        let dir = |session_dir: Option<&str>| {
            let session_dir = session_dir.map(OsString::from);
            sessions_dir(&home, move |name| {
                (name == "PI_CODING_AGENT_SESSION_DIR")
                    .then(|| session_dir.clone())
                    .flatten()
            })
        };
        let settings = |text: String| write(&agent_dir.join("settings.json"), &text);

        assert_eq!(dir(None), agent_dir.join("sessions"), "no settings file");

        settings(format!(
            "\u{feff}{}",
            json!({ "theme": "dark", "sessionDir": moved.to_str().unwrap() })
        ));
        assert_eq!(dir(None), moved, "an absolute sessionDir");
        assert_eq!(
            dir(Some("/from/the/variable")),
            PathBuf::from("/from/the/variable"),
            "the variable comes first"
        );

        settings(json!({ "sessionDir": "~/pi-sessions" }).to_string());
        assert_eq!(dir(None), home.join("pi-sessions"));

        for text in [
            json!({ "sessionDir": "relative/sessions" }).to_string(),
            json!({ "sessionDir": "" }).to_string(),
            json!({ "sessionDir": 3 }).to_string(),
            "{ \"sessionDir\": ".to_string(),
        ] {
            settings(text.clone());
            assert_eq!(dir(None), agent_dir.join("sessions"), "{text}");
        }

        let agent_elsewhere = temp.path().join("agent");
        write(
            &agent_elsewhere.join("settings.json"),
            &json!({ "sessionDir": moved.to_str().unwrap() }).to_string(),
        );
        let agent_var = agent_elsewhere.clone().into_os_string();
        assert_eq!(
            sessions_dir(&home, |name| (name == "PI_CODING_AGENT_DIR")
                .then(|| agent_var.clone())),
            moved,
            "the settings of the agent directory pi uses"
        );
    }

    #[test]
    fn an_open_turn_without_a_process_signal_is_running_and_no_other_writer() {
        let temp = tempfile::tempdir().unwrap();
        let sessions = temp.path().join(".pi").join("agent").join("sessions");
        let recent = Utc::now().to_rfc3339();
        let mut open = user(1);
        open["timestamp"] = json!(recent);
        write(
            &session_file(&sessions, "--tmp-project--", ID),
            &file(&[header(), open]),
        );
        let (reader, pi) = pi_reader(&sessions);

        let reads = reader.read(&pi, &[ID]);
        assert_eq!(reads.problem, None);
        let read = &reads.sessions[ID];
        assert_eq!(read.status.as_ref().unwrap().state, SessionState::Running);
        assert!(
            !read.external_writer,
            "an approximate running is no other writer: the chat's liveness stays unknown"
        );
    }

    #[test]
    fn an_unknown_format_is_a_problem_of_the_pi_source() {
        let temp = tempfile::tempdir().unwrap();
        let sessions = temp.path().join(".pi").join("agent").join("sessions");
        let mut other = header();
        other["version"] = json!(4);
        write(
            &session_file(&sessions, "--tmp-project--", ID),
            &file(&[other, user(1)]),
        );
        let (reader, pi) = pi_reader(&sessions);

        let reads = reader.read(&pi, &[ID]);
        assert!(reads.sessions.is_empty());
        assert!(
            reads
                .problem
                .as_deref()
                .is_some_and(|problem| problem.contains("version 4")),
            "{:?}",
            reads.problem
        );
    }
}

//! Qwen Code's native status (Stage 10 `07` N4, N7): the state of the turn
//! from the tail of the session's chat log and, for a session of the
//! terminal UI, the process that holds it from its process marker. Only the
//! fields of N3 are kept: types, roles, times, whether an answer calls a
//! tool, the status of a tool result, an event's name and whether a
//! subagent sent it.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Duration, Utc};
use serde_json::Value;
use svode_agents::status::{SessionState, StopReason};

use super::jsonl_tail::{TAIL_BYTES, for_each_tail_line};
use super::process::ProcessRecord;
use super::session_logs::SessionLogLayout;
use super::{
    NativeStatusEvidence, StoreRead, nested_string_field, parse_timestamp_value, string_field,
    timestamp_from_fields,
};

/// The process marker version this reader knows (N5); Qwen Code itself
/// ignores a marker of another version.
const MARKER_SCHEMA_VERSION: u64 = 1;

/// A process started within this time after the marker was written still
/// is the one it records (N7).
const MARKER_START_TOLERANCE: Duration = Duration::seconds(1);

/// The chat logs under the Qwen homes, found with the variables of the
/// agent's environment.
pub(super) struct Chats<V> {
    pub home: PathBuf,
    pub var: V,
}

impl<V> SessionLogLayout for Chats<V>
where
    V: Fn(&str) -> Option<OsString> + Send + Sync,
{
    fn index(&self) -> HashMap<String, PathBuf> {
        let mut files = HashMap::new();
        for base in bases(&self.home, &self.var) {
            index_into(&base, &mut files);
        }
        files
    }

    fn companions(&self, log: &Path) -> Vec<PathBuf> {
        vec![marker_path(log)]
    }

    fn read(&self, log: &Path) -> Result<StoreRead, String> {
        let id = log
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or_default();
        Ok(StoreRead {
            process: read_marker(&marker_path(log), id)?,
            status: read_status(log)?,
            launch_id: None,
        })
    }
}

/// Where Qwen Code may keep its chats (N7), the one it prefers last:
/// `QWEN_HOME` or `~/.qwen`, `advanced.runtimeOutputDir` of the user's and
/// the system settings, then `QWEN_RUNTIME_DIR`. Each is searched, as Qwen
/// Code searches its runtime bases for a session's marker. A relative path
/// resolves against the folder of a Qwen process, which a reader of all
/// sessions does not have, so it is skipped.
fn bases(home: &Path, var: impl Fn(&str) -> Option<OsString>) -> Vec<PathBuf> {
    let set = |name: &str| var(name).filter(|value| !value.is_empty());
    let global = set("QWEN_HOME")
        .and_then(|dir| absolute(home, &dir.to_string_lossy()))
        .unwrap_or_else(|| home.join(".qwen"));
    let system_settings = set("QWEN_CODE_SYSTEM_SETTINGS_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(system_settings_path);
    let mut bases = vec![global.clone()];
    for settings in [global.join("settings.json"), system_settings] {
        bases.extend(runtime_output_dir(&settings).and_then(|dir| absolute(home, &dir)));
    }
    bases.extend(set("QWEN_RUNTIME_DIR").and_then(|dir| absolute(home, &dir.to_string_lossy())));
    let mut unique = Vec::new();
    for base in bases {
        if !unique.contains(&base) {
            unique.push(base);
        }
    }
    unique
}

fn system_settings_path() -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from("/Library/Application Support/QwenCode/settings.json")
    } else if cfg!(windows) {
        PathBuf::from(r"C:\ProgramData\qwen-code\settings.json")
    } else {
        PathBuf::from("/etc/qwen-code/settings.json")
    }
}

/// `advanced.runtimeOutputDir` of a settings file, JSON with comments; the
/// file's other settings are not kept.
fn runtime_output_dir(settings: &Path) -> Option<String> {
    let text = std::fs::read_to_string(settings).ok()?;
    let value: Value = jsonc_parser::parse_to_serde_value(
        text.trim_start_matches('\u{feff}'),
        &jsonc_parser::ParseOptions::default(),
    )
    .ok()?;
    value
        .get("advanced")?
        .get("runtimeOutputDir")?
        .as_str()
        .map(str::to_string)
}

/// The path with `~` as the home folder, if it is absolute.
fn absolute(home: &Path, dir: &str) -> Option<PathBuf> {
    let path = if dir == "~" {
        home.to_path_buf()
    } else if let Some(rest) = dir.strip_prefix("~/").or_else(|| dir.strip_prefix("~\\")) {
        home.join(rest)
    } else {
        PathBuf::from(dir)
    };
    path.is_absolute().then_some(path)
}

/// Chat logs `projects/<key>/chats/<session id>.jsonl` of a base by session
/// id. The id is looked up under every project key, as Qwen Code looks up
/// its markers: `/cd` moves a session to the key of another folder, and keys
/// of different folders may collide.
fn index_into(base: &Path, files: &mut HashMap<String, PathBuf>) {
    let Ok(projects) = std::fs::read_dir(base.join("projects")) else {
        return;
    };
    for project in projects.flatten() {
        let Ok(chats) = std::fs::read_dir(project.path().join("chats")) else {
            continue;
        };
        for chat in chats.flatten() {
            let path = chat.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl")
                || !chat.file_type().is_ok_and(|kind| kind.is_file())
            {
                continue;
            }
            if let Some(id) = path.file_stem().and_then(|stem| stem.to_str()) {
                files.insert(id.to_string(), path.clone());
            }
        }
    }
}

fn marker_path(log: &Path) -> PathBuf {
    log.with_extension("runtime.json")
}

/// The process the session's marker records. Only the terminal UI writes a
/// marker and leaves it when it exits; no marker, or a marker of another
/// session, records no process.
fn read_marker(path: &Path, id: &str) -> Result<Option<ProcessRecord>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("a process marker cannot be read: {error}")),
    };
    let marker = serde_json::from_str::<Value>(&text)
        .map_err(|_| "a process marker is not JSON".to_string())?;
    match marker.get("schema_version").and_then(Value::as_u64) {
        Some(MARKER_SCHEMA_VERSION) => {}
        Some(version) => {
            return Err(format!(
                "a process marker has schema_version {version}, Svode reads {MARKER_SCHEMA_VERSION}"
            ));
        }
        None => return Err("a process marker has no schema_version".to_string()),
    }
    if string_field(&marker, &["session_id"]) != Some(id) {
        return Ok(None);
    }
    let lacks = |field: &str| format!("a process marker has no {field}");
    let pid = marker
        .get("pid")
        .and_then(Value::as_u64)
        .and_then(|pid| u32::try_from(pid).ok())
        .ok_or_else(|| lacks("pid"))?;
    let host = string_field(&marker, &["hostname"]).ok_or_else(|| lacks("hostname"))?;
    let written_at = marker
        .get("started_at")
        .and_then(parse_timestamp_value)
        .ok_or_else(|| lacks("started_at"))?;
    Ok(Some(ProcessRecord {
        pid,
        host: Some(host.to_string()),
        started_by: written_at + MARKER_START_TOLERANCE,
    }))
}

/// The state of the turn from the tail of the chat log; a log deleted or
/// moved since it was found has none.
fn read_status(log: &Path) -> Result<Option<NativeStatusEvidence>, String> {
    let mut status = None;
    match for_each_tail_line(log, TAIL_BYTES, |record| {
        if let Some(evidence) = record_status(&record) {
            status = Some(evidence);
        }
    }) {
        Ok(()) => Ok(status),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("a chat log cannot be read: {error}")),
    }
}

/// What a record of the main agent tells of its turn (N7); other records,
/// a subagent's events among them, tell nothing.
fn record_status(record: &Value) -> Option<NativeStatusEvidence> {
    let observed_at = timestamp_from_fields(record);
    let running = |reason: &str| Some(evidence(SessionState::Running, reason, observed_at));
    let idle = |stop_reason: StopReason, reason: &str| {
        Some(evidence(
            SessionState::Idle {
                stop_reason: Some(stop_reason),
            },
            reason,
            observed_at,
        ))
    };
    match string_field(record, &["type"])? {
        "user" => running("qwen user prompt submitted"),
        // The store does not tell a running tool from one awaiting approval.
        "assistant" if calls_a_tool(record) => running("qwen tool call in progress"),
        // `max_tokens` is written as an ordinary answer.
        "assistant" => idle(StopReason::EndTurn, "qwen turn complete"),
        "tool_result" => match nested_string_field(record, &["toolCallResult", "status"]) {
            None | Some("success" | "error") => running("qwen tool result received"),
            Some("cancelled") => idle(StopReason::Cancelled, "qwen tool call cancelled"),
            Some(_) => Some(evidence(
                SessionState::Unknown,
                "qwen tool result of an unknown status",
                observed_at,
            )),
        },
        "system" if string_field(record, &["subtype"]) == Some("ui_telemetry") => {
            let event = record.get("systemPayload")?.get("uiEvent")?;
            let name = string_field(event, &["event.name"])?;
            let main_agent = ["subagent_id", "subagent_name"]
                .iter()
                .all(|field| event.get(*field).is_none_or(Value::is_null));
            (main_agent && name.strip_prefix("qwen-code.").unwrap_or(name) == "api_error")
                .then(|| idle(StopReason::Error, "qwen api error"))
                .flatten()
        }
        _ => None,
    }
}

fn calls_a_tool(record: &Value) -> bool {
    record
        .get("message")
        .and_then(|message| message.get("parts"))
        .and_then(Value::as_array)
        .is_some_and(|parts| parts.iter().any(|part| part.get("functionCall").is_some()))
}

fn evidence(
    state: SessionState,
    reason: &str,
    observed_at: Option<DateTime<Utc>>,
) -> NativeStatusEvidence {
    NativeStatusEvidence {
        state,
        reason: reason.to_string(),
        observed_at,
        waiting_since: None,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::process::{Child, Command, Stdio};

    use serde_json::json;
    use svode_agents::catalog::{ListedSession, SessionList};
    use svode_agents::identity::SessionKey;
    use svode_agents::writer::ExternalLiveness;
    use svode_core::agent_adapters::AgentAdapterKind;

    use super::*;
    use crate::agent_sessions::AgentSessionsState;
    use crate::agent_sessions::native_status::{NativeReads, NativeStatusReader};

    const SECRET: &str = "secret words of the conversation";

    fn write(path: &Path, data: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, data).unwrap();
    }

    fn at(offset_secs: i64) -> String {
        (Utc::now() + Duration::seconds(offset_secs)).to_rfc3339()
    }

    fn record(kind: &str, extra: Value) -> Value {
        let mut record = json!({
            "uuid": "r",
            "sessionId": "s",
            "timestamp": at(-60),
            "type": kind,
            "cwd": "/tmp/project",
            "version": "0.24.7",
        });
        record
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        record
    }

    fn user() -> Value {
        record(
            "user",
            json!({ "message": { "role": "user", "parts": [{ "text": SECRET }] } }),
        )
    }

    fn answer() -> Value {
        record(
            "assistant",
            json!({ "message": { "role": "model", "parts": [{ "text": SECRET }] } }),
        )
    }

    fn tool_call() -> Value {
        record(
            "assistant",
            json!({ "message": { "role": "model", "parts": [
                { "text": SECRET },
                { "functionCall": { "id": "c1", "name": "run_shell_command", "args": { "command": SECRET } } },
            ] } }),
        )
    }

    fn tool_result(status: &str) -> Value {
        record(
            "tool_result",
            json!({
                "message": { "role": "user", "parts": [{ "functionResponse": { "id": "c1", "response": { "output": SECRET } } }] },
                "toolCallResult": { "callId": "c1", "status": status, "resultDisplay": SECRET },
            }),
        )
    }

    fn event(name: &str, subagent: Option<&str>) -> Value {
        let mut ui_event = json!({
            "event.name": name,
            "event.timestamp": at(-60),
            "error_message": SECRET,
        });
        if let Some(subagent) = subagent {
            ui_event["subagent_name"] = json!(subagent);
        }
        record(
            "system",
            json!({ "subtype": "ui_telemetry", "systemPayload": { "uiEvent": ui_event } }),
        )
    }

    fn jsonl(records: &[Value]) -> String {
        records.iter().map(|record| format!("{record}\n")).collect()
    }

    fn marker(id: &str, pid: u32, host: &str, written_at: DateTime<Utc>) -> Value {
        json!({
            "schema_version": 1,
            "pid": pid,
            "session_id": id,
            "work_dir": "/tmp/project",
            "hostname": host,
            "started_at": written_at.timestamp_millis() as f64 / 1000.0,
            "qwen_version": "0.24.7",
        })
    }

    fn this_host() -> String {
        sysinfo::System::host_name().expect("host name")
    }

    fn sleeping_child() -> Child {
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("ping");
            command.args(["-n", "60", "127.0.0.1"]);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = Command::new("sleep");
            command.arg("60");
            command
        };
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn a child process")
    }

    fn exited_pid() -> u32 {
        let mut child = sleeping_child();
        let pid = child.id();
        child.kill().expect("kill the child");
        child.wait().expect("reap the child");
        pid
    }

    /// A Qwen home with sessions of two project keys.
    struct Store {
        temp: tempfile::TempDir,
    }

    impl Store {
        fn new() -> Self {
            Self {
                temp: tempfile::tempdir().unwrap(),
            }
        }

        fn home(&self) -> PathBuf {
            self.temp.path().join("home")
        }

        fn chats(&self, id: &str) -> PathBuf {
            let key = if id.len() % 2 == 0 {
                "-tmp-project"
            } else {
                "c--users-me-project"
            };
            self.home().join(".qwen/projects").join(key).join("chats")
        }

        fn session(&self, id: &str, records: &[Value], marker: Option<Value>) {
            let chats = self.chats(id);
            write(&chats.join(format!("{id}.jsonl")), &jsonl(records));
            if let Some(marker) = marker {
                write(
                    &chats.join(format!("{id}.runtime.json")),
                    &marker.to_string(),
                );
            }
        }

        fn read(&self, ids: &[&str]) -> NativeReads {
            NativeStatusReader::new(self.home()).read(&AgentAdapterKind::QwenCode.id(), ids)
        }
    }

    fn state(reads: &NativeReads, id: &str) -> SessionState {
        reads.sessions[id].status.as_ref().expect("status").state
    }

    fn idle(stop_reason: StopReason) -> SessionState {
        SessionState::Idle {
            stop_reason: Some(stop_reason),
        }
    }

    #[test]
    fn the_turn_follows_the_last_record_of_the_main_agent() {
        let store = Store::new();
        let cases = [
            ("tool", vec![user(), tool_call()], SessionState::Running),
            (
                "result",
                vec![user(), tool_call(), tool_result("success")],
                SessionState::Running,
            ),
            (
                "failed-tool",
                vec![user(), tool_call(), tool_result("error")],
                SessionState::Running,
            ),
            (
                "done",
                vec![user(), tool_call(), tool_result("success"), answer()],
                idle(StopReason::EndTurn),
            ),
            (
                "rejected",
                vec![
                    user(),
                    tool_call(),
                    event("qwen-code.tool_call", None),
                    tool_result("cancelled"),
                ],
                idle(StopReason::Cancelled),
            ),
            (
                "api-error",
                vec![user(), event("qwen-code.api_error", None)],
                idle(StopReason::Error),
            ),
            (
                "retried",
                vec![user(), event("qwen-code.api_error", None), answer()],
                idle(StopReason::EndTurn),
            ),
            (
                "subagent",
                vec![
                    user(),
                    answer(),
                    event(
                        "qwen-code.api_request",
                        Some("managed-auto-memory-extractor"),
                    ),
                    event("qwen-code.api_error", Some("managed-auto-memory-extractor")),
                    event("qwen-code.api_response", None),
                ],
                idle(StopReason::EndTurn),
            ),
            (
                "unknown-status",
                vec![user(), tool_call(), tool_result("deferred")],
                SessionState::Unknown,
            ),
        ];
        for (id, records, _) in &cases {
            store.session(id, records, None);
        }

        let ids = cases.iter().map(|(id, ..)| *id).collect::<Vec<_>>();
        let reads = store.read(&ids);
        assert!(reads.problem.is_none());
        for (id, _, expected) in &cases {
            assert_eq!(state(&reads, id), *expected, "{id}");
            assert!(!reads.sessions[*id].external_writer, "{id}");
        }
    }

    #[test]
    fn an_open_turn_follows_the_process_its_marker_records() {
        let store = Store::new();
        let mut child = sleeping_child();
        let host = this_host();
        let written = Utc::now();
        let open = [user(), tool_call()];
        store.session(
            "alive",
            &open,
            Some(marker("alive", child.id(), &host, written)),
        );
        store.session(
            "dead",
            &open,
            Some(marker("dead", exited_pid(), &host, written)),
        );
        store.session(
            "reused",
            &open,
            Some(marker(
                "reused",
                child.id(),
                &host,
                written - Duration::minutes(10),
            )),
        );
        store.session(
            "elsewhere",
            &open,
            Some(marker(
                "elsewhere",
                child.id(),
                "another-host.invalid",
                written,
            )),
        );
        store.session(
            "other-session",
            &open,
            Some(marker("alive", child.id(), &host, written)),
        );
        store.session("headless", &open, None);
        store.session(
            "closed",
            &[user(), answer()],
            Some(marker("closed", child.id(), &host, written)),
        );

        let reads = store.read(&[
            "alive",
            "dead",
            "reused",
            "elsewhere",
            "other-session",
            "headless",
            "closed",
        ]);
        child.kill().ok();
        child.wait().ok();

        assert!(reads.problem.is_none());
        let expect = |id: &str, expected: SessionState, external: bool| {
            assert_eq!(state(&reads, id), expected, "{id}");
            assert_eq!(reads.sessions[id].external_writer, external, "{id}");
        };
        expect("alive", SessionState::Running, true);
        expect("dead", idle(StopReason::Interrupted), false);
        expect("reused", idle(StopReason::Interrupted), false);
        expect("elsewhere", SessionState::Running, false);
        expect("other-session", SessionState::Running, false);
        expect("headless", SessionState::Running, false);
        expect("closed", idle(StopReason::EndTurn), false);
        assert_eq!(
            reads.sessions["alive"].read.process.as_ref().unwrap().pid,
            child.id()
        );
        assert_eq!(reads.sessions["other-session"].read.process, None);
    }

    #[test]
    fn a_marker_of_another_schema_version_fails_the_source() {
        let store = Store::new();
        store.session("ok", &[user(), answer()], None);
        let mut newer = marker("newer", 4242, &this_host(), Utc::now());
        newer["schema_version"] = json!(2);
        store.session("newer", &[user()], Some(newer));

        let reads = store.read(&["ok", "newer"]);
        let problem = reads.problem.expect("a diagnostic of the source");
        assert!(problem.contains("schema_version 2"), "{problem}");
        assert!(
            reads.sessions.is_empty(),
            "the source's statuses are unknown"
        );
    }

    #[test]
    fn a_marker_without_a_field_the_reader_needs_fails_the_source() {
        let store = Store::new();
        let mut partial = marker("partial", 4242, &this_host(), Utc::now());
        partial.as_object_mut().unwrap().remove("pid");
        store.session("partial", &[user()], Some(partial));

        let problem = store.read(&["partial"]).problem.expect("diagnostic");
        assert!(problem.contains("pid"), "{problem}");
    }

    #[test]
    fn the_tail_drops_an_unfinished_record() {
        let store = Store::new();
        let mut log = jsonl(&[user(), answer()]);
        log.push_str(&tool_call().to_string());
        store.session("writing", &[], None);
        write(&store.chats("writing").join("writing.jsonl"), &log);

        let reads = store.read(&["writing"]);
        assert_eq!(state(&reads, "writing"), idle(StopReason::EndTurn));
    }

    #[test]
    fn no_text_of_records_or_events_is_kept() {
        let store = Store::new();
        let mut child = sleeping_child();
        store.session(
            "kept",
            &[
                user(),
                tool_call(),
                tool_result("cancelled"),
                event("qwen-code.api_error", None),
            ],
            Some(marker("kept", child.id(), &this_host(), Utc::now())),
        );

        let reads = store.read(&["kept"]);
        child.kill().ok();
        child.wait().ok();
        let saved = serde_json::to_string(&reads.sessions["kept"].read).unwrap();
        assert!(!saved.contains(SECRET), "{saved}");
        assert!(!saved.contains("/tmp/project"), "{saved}");
    }

    #[test]
    fn the_index_finds_chat_logs_under_every_project_key() {
        let store = Store::new();
        store.session("ab", &[], None);
        store.session("abc", &[], None);
        let root = store.home().join(".qwen");
        write(
            &root.join("projects/-tmp-project/chats/ab.runtime.json"),
            "{}",
        );
        write(&root.join("projects/-tmp-project/meta.json"), "{}");

        let files = Chats {
            home: store.home(),
            var: no_variables,
        }
        .index();
        assert_eq!(files.len(), 2);
        assert_eq!(files["ab"], store.chats("ab").join("ab.jsonl"));
        assert_eq!(files["abc"], store.chats("abc").join("abc.jsonl"));
    }

    fn no_variables(name: &str) -> Option<OsString> {
        (name == "QWEN_CODE_SYSTEM_SETTINGS_PATH").then(|| "/nonexistent/settings.json".into())
    }

    #[test]
    fn the_chats_are_found_where_the_agents_environment_and_settings_put_them() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let dir = |name: &str| temp.path().join(name);
        let variables = HashMap::from([
            ("QWEN_HOME", dir("qwen-home").into_os_string()),
            ("QWEN_RUNTIME_DIR", dir("runtime").into_os_string()),
            (
                "QWEN_CODE_SYSTEM_SETTINGS_PATH",
                dir("system/settings.json").into_os_string(),
            ),
        ]);
        let var = |name: &str| variables.get(name).cloned();
        write(
            &dir("qwen-home/settings.json"),
            "\u{feff}{\n  // the user's settings\n  \"advanced\": { \"runtimeOutputDir\": \"~/qwen-out\" },\n}\n",
        );
        write(
            &dir("system/settings.json"),
            &json!({ "advanced": { "runtimeOutputDir": dir("system-out") } }).to_string(),
        );
        assert_eq!(
            bases(&home, var),
            vec![
                dir("qwen-home"),
                home.join("qwen-out"),
                dir("system-out"),
                dir("runtime"),
            ]
        );

        write(
            &dir("qwen-home/settings.json"),
            &json!({ "advanced": { "runtimeOutputDir": "relative/out" } }).to_string(),
        );
        let relative = HashMap::from([
            ("QWEN_HOME", dir("qwen-home").into_os_string()),
            ("QWEN_RUNTIME_DIR", OsString::from("relative/runtime")),
            (
                "QWEN_CODE_SYSTEM_SETTINGS_PATH",
                OsString::from("/nonexistent"),
            ),
        ]);
        assert_eq!(
            bases(&home, |name: &str| relative.get(name).cloned()),
            vec![dir("qwen-home")],
            "a relative path depends on the folder of a Qwen process"
        );
        assert_eq!(bases(&home, no_variables), vec![home.join(".qwen")]);

        let chats = dir("runtime/projects/-tmp-project/chats");
        write(&chats.join("s1.jsonl"), &jsonl(&[user(), answer()]));
        let files = Chats {
            home: home.clone(),
            var,
        }
        .index();
        assert_eq!(files["s1"], chats.join("s1.jsonl"));
    }

    /// The listed session's chat target: another writer only for an open
    /// turn of a live terminal process (N6).
    #[test]
    fn only_an_open_turn_of_a_live_marker_is_another_writer() {
        let store = Store::new();
        let project = store.temp.path().join("project");
        write(
            &project.join(".svode/config.json"),
            &json!({ "name": "Project", "spaces": [] }).to_string(),
        );
        let state = AgentSessionsState::with_home(store.home());
        let agent = AgentAdapterKind::QwenCode.id();
        let ids = ["terminal", "headless"];
        state.acp_lists.apply(
            agent.as_str(),
            Ok(SessionList {
                sessions: ids
                    .iter()
                    .map(|id| ListedSession {
                        key: SessionKey::from_acp(agent.as_str(), id, true),
                        cwd: project.clone(),
                        title: None,
                        updated_at: Some(at(-120)),
                    })
                    .collect(),
                ..Default::default()
            }),
            3,
        );
        let mut child = sleeping_child();
        let open = [user(), tool_call()];
        store.session(
            "terminal",
            &open,
            Some(marker("terminal", child.id(), &this_host(), Utc::now())),
        );
        store.session("headless", &open, None);

        let liveness = |id: &str| {
            crate::agent_sessions::chat::chat_target(
                &state,
                project.to_string_lossy().into_owned(),
                &format!("qwen-code:{id}"),
                Vec::new(),
                Vec::new(),
            )
            .expect("chat target")
            .expect("listed session")
            .liveness
        };
        let terminal = liveness("terminal");
        let headless = liveness("headless");
        child.kill().ok();
        child.wait().ok();

        assert_eq!(terminal, ExternalLiveness::ExternalActive);
        assert_eq!(headless, ExternalLiveness::Unknown);
    }
}

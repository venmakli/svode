//! Native status reader of the Sessions catalogue (Stage 10 `02` C10, `07`
//! N1): the current status of a session the catalogue lists, read from its
//! agent's native store and always approximate. The reader never makes a
//! catalogue record, counts or metadata and keeps no transcript or tool
//! payload (C8, `07` N3). Each agent's source reads its own store and tells
//! itself when the store changed; the reader lays the liveness rule of an
//! open turn over what the sources read (N4, N6). From the same read the
//! Claude Code and Codex sources take the launch marker of a terminal
//! launch's first user turn, the remainder of condition 1 of `02` for Codex.

pub(crate) mod claude_code;
pub(crate) mod codex;
pub(crate) mod grok_build;
pub(crate) mod hermes;
pub(crate) mod jsonl_tail;
pub(crate) mod opencode;
pub(crate) mod pi;
pub(crate) mod process;
pub(crate) mod qwen_code;
pub(crate) mod session_logs;
pub(crate) mod sqlite;

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use chrono::{DateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use svode_agents::registry::{AdapterRuntimeRegistry, NativeStatusStore};
use svode_agents::status::{SessionState, StopReason};
use svode_core::agent_adapters::AgentId;

use super::StoreRoot;
use crate::process::login_env::LoginEnvironment;
use process::{ProcessRecord, ProcessSignal, process_signals};
use session_logs::SessionLogs;

/// What the native status reader read from the agent's store; always
/// approximate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeStatusEvidence {
    pub state: SessionState,
    pub reason: String,
    pub observed_at: Option<DateTime<Utc>>,
    pub waiting_since: Option<DateTime<Utc>>,
}

/// One read of a session's native store, valid until its source sees the
/// store change; saved with the session list for the next start.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeLogRead {
    /// The session's own log as it was read; a store of all sessions keeps
    /// none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<NativeLogFile>,
    /// The files read together with the log.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub companions: Vec<NativeLogFile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<NativeStatusEvidence>,
    /// Launch marker of the first user turn of a terminal launch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_id: Option<String>,
    /// The store's record of the process that holds the session (N4).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process: Option<ProcessRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeLogFile {
    pub path: PathBuf,
    pub modified_ms: u128,
    pub size: u64,
}

impl NativeLogFile {
    /// The file's path, modification time and size; a source compares them
    /// to tell whether a store file changed.
    pub(crate) fn stat(path: &Path) -> Option<Self> {
        let metadata = std::fs::metadata(path).ok()?;
        Some(Self {
            path: path.to_path_buf(),
            modified_ms: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis())
                .unwrap_or(0),
            size: metadata.len(),
        })
    }
}

/// What a source read of one session from its store.
#[derive(Debug, Default)]
pub(crate) struct StoreRead {
    pub status: Option<NativeStatusEvidence>,
    pub launch_id: Option<String>,
    pub process: Option<ProcessRecord>,
}

/// What evidence of an open turn in the store means (Stage 10 `02` C7, `07`
/// N4, N6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TurnEvidence {
    /// Claude Code and Codex as built: the store's state of the turn stands,
    /// and the turn alone tells that another process writes to the session.
    LogAlone,
    /// The agents of `07`: the store's record of the process that holds the
    /// session decides an open turn, and only a process confirmed alive is
    /// another writer.
    ProcessSignal,
}

/// One agent's native status source (Stage 10 `07` N1): it reads its own
/// store, be it one database of all sessions or a log per session with its
/// process file, and tells itself whether the store changed since its last
/// read.
pub(crate) trait NativeStatusSource: Send + Sync {
    /// Reads of the sessions with these native ids. A session the store does
    /// not know gets nothing. A store that is missing or cannot be read, or
    /// lacks a field the source needs or has a format version it does not
    /// know, fails the whole source (N5); an unknown value of a status field
    /// is an `unknown` state of that session.
    fn read(&self, ids: &[&str]) -> Result<SourceReads, String>;

    /// A read saved before the app started; a source that keeps no reads
    /// ignores it.
    fn seed(&self, _id: &str, _read: NativeLogRead) {}

    fn turn_evidence(&self) -> TurnEvidence {
        TurnEvidence::ProcessSignal
    }
}

/// A source's reads of one call.
#[derive(Debug, Default)]
pub(crate) struct SourceReads {
    pub sessions: HashMap<String, NativeLogRead>,
    /// Sessions read again because their store changed or was not read yet.
    pub reparsed: usize,
}

/// The agents' native status sources, each made when its agent is first
/// read.
pub(crate) struct NativeStatusReader {
    home: PathBuf,
    /// The Hermes home (`07` N7).
    hermes_home: StoreRoot,
    sources: Mutex<HashMap<AgentId, Arc<dyn NativeStatusSource>>>,
}

/// The reads of one call.
#[derive(Default)]
pub(crate) struct NativeReads {
    pub sessions: HashMap<String, NativeSessionRead>,
    /// Sessions read again because their store changed or was not read yet.
    pub reparsed: usize,
    /// Why the agent's source could not be read; its sessions get no status.
    pub problem: Option<String>,
}

/// A session's native read with its status after the liveness rule.
#[derive(Debug, Clone)]
pub(crate) struct NativeSessionRead {
    /// The read as the source made it, saved with the list.
    pub read: NativeLogRead,
    pub status: Option<NativeStatusEvidence>,
    /// The status is a turn another process drives (C7): its evidence alone
    /// for Claude Code and Codex, a live process for the agents of `07`.
    pub external_writer: bool,
}

impl NativeStatusReader {
    #[cfg(test)]
    pub(crate) fn new(home: PathBuf) -> Self {
        let hermes = home.join(".hermes");
        Self::with_stores(home, Arc::new(move || hermes.clone()))
    }

    pub(crate) fn with_stores(home: PathBuf, hermes_home: StoreRoot) -> Self {
        Self {
            home,
            hermes_home,
            sources: Mutex::new(HashMap::new()),
        }
    }

    fn source(&self, agent: &AgentId) -> Option<Arc<dyn NativeStatusSource>> {
        let mut sources = self.sources.lock().unwrap();
        if let Some(source) = sources.get(agent) {
            return Some(source.clone());
        }
        let store = AdapterRuntimeRegistry.native_status_store(agent.builtin()?)?;
        let source = source_of(store, &self.home, &self.hermes_home);
        sources.insert(agent.clone(), source.clone());
        Some(source)
    }

    /// Status and launch marker of the agent's sessions with these native
    /// ids. A session the store does not know gets nothing.
    pub(crate) fn read(&self, agent: &AgentId, ids: &[&str]) -> NativeReads {
        let Some(source) = self.source(agent) else {
            return NativeReads::default();
        };
        let reads = match source.read(ids) {
            Ok(reads) => reads,
            Err(problem) => {
                return NativeReads {
                    problem: Some(problem),
                    ..NativeReads::default()
                };
            }
        };
        let rule = source.turn_evidence();
        let sessions = reads.sessions.into_iter().collect::<Vec<_>>();
        // Only an open turn of the agents of `07` asks for its process.
        let records = sessions
            .iter()
            .map(|(_, read)| {
                read.process.as_ref().filter(|_| {
                    rule == TurnEvidence::ProcessSignal
                        && read
                            .status
                            .as_ref()
                            .is_some_and(|status| status.state.in_turn())
                })
            })
            .collect::<Vec<_>>();
        let signals = process_signals(&records);
        NativeReads {
            sessions: sessions
                .into_iter()
                .zip(signals)
                .map(|((id, read), signal)| {
                    let (status, external_writer) = match read.status.clone() {
                        Some(evidence) => {
                            let (status, external) = turn_status(evidence, rule, signal);
                            (Some(status), external)
                        }
                        None => (None, false),
                    };
                    (
                        id,
                        NativeSessionRead {
                            read,
                            status,
                            external_writer,
                        },
                    )
                })
                .collect(),
            reparsed: reads.reparsed,
            problem: None,
        }
    }

    /// A read saved before the app started; a newer read is kept.
    pub(crate) fn seed(&self, agent: &AgentId, id: &str, read: NativeLogRead) {
        if let Some(source) = self.source(agent) {
            source.seed(id, read);
        }
    }

    /// Reads the agent's sessions from this source instead of its declared
    /// store.
    #[cfg(test)]
    pub(crate) fn set_source(&self, agent: AgentId, source: Arc<dyn NativeStatusSource>) {
        self.sources.lock().unwrap().insert(agent, source);
    }
}

fn source_of(
    store: NativeStatusStore,
    home: &Path,
    hermes_home: &StoreRoot,
) -> Arc<dyn NativeStatusSource> {
    match store {
        NativeStatusStore::CodexRollouts => Arc::new(SessionLogs::new(codex::Rollouts {
            root: home.join(".codex"),
        })),
        NativeStatusStore::ClaudeProjects => Arc::new(SessionLogs::new(claude_code::Projects {
            root: home.join(".claude"),
        })),
        NativeStatusStore::HermesStates => Arc::new(hermes::HermesStates::new(hermes_home.clone())),
        NativeStatusStore::OpencodeDb => {
            let home = home.to_path_buf();
            Arc::new(opencode::Database::new(move || {
                opencode::database_path(&home, agent_variable)
            }))
        }
        NativeStatusStore::PiSessions => {
            let home = home.to_path_buf();
            Arc::new(SessionLogs::new(pi::Sessions {
                root: move || pi::sessions_dir(&home, agent_variable),
            }))
        }
        NativeStatusStore::QwenChats => Arc::new(SessionLogs::new(qwen_code::Chats {
            home: home.to_path_buf(),
            var: agent_variable,
        })),
        NativeStatusStore::GrokSessionEvents => {
            let home = home.to_path_buf();
            Arc::new(SessionLogs::new(grok_build::SessionEvents {
                root: move || grok_build::grok_home(&home, agent_variable),
            }))
        }
    }
}

/// A variable of the environment the agent's processes run in: the user's
/// login shell environment (Stage 10 `03` A1), else the app's, as the agent
/// gets it where there is no login shell.
pub(crate) fn agent_variable(name: &str) -> Option<OsString> {
    match tauri::async_runtime::block_on(LoginEnvironment::session().get()) {
        Some(environment) => environment.get(name).map(OsStr::to_os_string),
        None => std::env::var_os(name),
    }
}

/// The status of a session from its store's evidence and whether it is a
/// turn another process drives (Stage 10 `07` N4, N6). An open turn of an
/// agent of `07` follows the process that holds the session: dead — `idle`,
/// `interrupted`; alive — the store's state, and another writer; no signal —
/// an approximate `running`, which the C10 threshold later turns `unknown`.
pub(crate) fn turn_status(
    evidence: NativeStatusEvidence,
    rule: TurnEvidence,
    signal: ProcessSignal,
) -> (NativeStatusEvidence, bool) {
    if !evidence.state.in_turn() {
        return (evidence, false);
    }
    match (rule, signal) {
        (TurnEvidence::LogAlone, _) | (TurnEvidence::ProcessSignal, ProcessSignal::Alive) => {
            (evidence, true)
        }
        (TurnEvidence::ProcessSignal, ProcessSignal::Dead) => (
            NativeStatusEvidence {
                state: SessionState::Idle {
                    stop_reason: Some(StopReason::Interrupted),
                },
                reason: format!("the process of the turn exited: {}", evidence.reason),
                waiting_since: None,
                ..evidence
            },
            false,
        ),
        (TurnEvidence::ProcessSignal, ProcessSignal::None) => (
            NativeStatusEvidence {
                state: SessionState::Running,
                reason: format!("no process signal of the turn: {}", evidence.reason),
                waiting_since: None,
                ..evidence
            },
            false,
        ),
    }
}

/// Every well-formed JSON line of the log; unreadable and malformed lines
/// are skipped.
pub(super) fn for_each_jsonl(path: &Path, mut handle: impl FnMut(Value)) {
    let Ok(file) = File::open(path) else {
        return;
    };
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else {
            continue;
        };
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(&line) {
            handle(value);
        }
    }
}

pub(crate) fn short_id(source_session_id: &str) -> String {
    source_session_id.chars().take(8).collect()
}

const MAX_LAUNCH_CONTEXT_BYTES: usize = 16 * 1024;
const LAUNCH_MARKER_PREFIX: &str = "<!-- svode-launch:";

pub(super) fn launch_id_from_text(text: &str) -> Option<String> {
    let mut start = text.len().saturating_sub(MAX_LAUNCH_CONTEXT_BYTES);
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    let bounded = &text[start..];
    let marker = bounded.rfind(LAUNCH_MARKER_PREFIX)? + LAUNCH_MARKER_PREFIX.len();
    let rest = &bounded[marker..];
    let end = rest.find(" -->")?;
    let id = &rest[..end];
    (!id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'))
    .then(|| id.to_string())
}

pub(super) fn string_field<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    for key in keys {
        if let Some(s) = value.get(*key).and_then(Value::as_str) {
            if !s.trim().is_empty() {
                return Some(s);
            }
        }
    }
    None
}

pub(super) fn nested_string_field<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str().filter(|s| !s.trim().is_empty())
}

pub(super) fn parse_timestamp_value(value: &Value) -> Option<DateTime<Utc>> {
    match value {
        Value::String(s) => parse_timestamp_str(s),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                parse_epoch_number(i as f64)
            } else {
                n.as_f64().and_then(parse_epoch_number)
            }
        }
        _ => None,
    }
}

pub(crate) fn parse_timestamp_str(raw: &str) -> Option<DateTime<Utc>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(i) = trimmed.parse::<i64>() {
        return parse_epoch_number(i as f64);
    }
    if let Ok(f) = trimmed.parse::<f64>() {
        return parse_epoch_number(f);
    }
    DateTime::parse_from_rfc3339(trimmed)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

fn parse_epoch_number(value: f64) -> Option<DateTime<Utc>> {
    if !value.is_finite() || value <= 0.0 {
        return None;
    }
    if value >= 10_000_000_000.0 {
        let millis = value.round() as i64;
        Utc.timestamp_millis_opt(millis).single()
    } else {
        let seconds = value.trunc() as i64;
        let nanos = ((value.fract().abs()) * 1_000_000_000.0).round() as u32;
        Utc.timestamp_opt(seconds, nanos).single()
    }
}

pub(super) fn timestamp_from_fields(value: &Value) -> Option<DateTime<Utc>> {
    for key in [
        "timestamp",
        "ts",
        "time",
        "created_at",
        "createdAt",
        "updated_at",
        "updatedAt",
        "lastActivityAt",
    ] {
        if let Some(ts) = value.get(key).and_then(parse_timestamp_value) {
            return Some(ts);
        }
    }
    if let Some(payload) = value.get("payload") {
        for key in ["timestamp", "ts", "created_at", "createdAt"] {
            if let Some(ts) = payload.get(key).and_then(parse_timestamp_value) {
                return Some(ts);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use svode_core::agent_adapters::AgentAdapterKind;

    fn write(path: &Path, data: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, data).unwrap();
    }

    const RUNNING: &str = r#"{"type":"event_msg","payload":{"type":"task_started"},"timestamp":"2026-07-04T10:00:00Z"}"#;
    const COMPLETE: &str = r#"{"type":"event_msg","payload":{"type":"task_complete"},"timestamp":"2026-07-04T10:01:00Z"}"#;

    #[test]
    fn the_reader_finds_a_listed_session_by_id_and_reads_its_log_again_only_when_it_changes() {
        let temp = tempfile::tempdir().unwrap();
        let rollout = temp
            .path()
            .join(".codex/sessions/2026/07/04/rollout-2026-07-04T10-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl");
        write(&rollout, RUNNING);
        let reader = NativeStatusReader::new(temp.path().to_path_buf());
        let codex = AgentAdapterKind::Codex.id();
        let id = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

        let first = reader.read(&codex, &[id, "not-on-disk"]);
        assert_eq!(first.reparsed, 1);
        assert_eq!(
            first.sessions.len(),
            1,
            "a session without a log gets nothing"
        );
        assert_eq!(
            first.sessions[id].status.as_ref().unwrap().state,
            SessionState::Running
        );

        let unchanged = reader.read(&codex, &[id]);
        assert_eq!(unchanged.reparsed, 0);

        write(&rollout, &format!("{RUNNING}\n{COMPLETE}"));
        let changed = reader.read(&codex, &[id]);
        assert_eq!(changed.reparsed, 1);
        assert!(matches!(
            changed.sessions[id].status.as_ref().unwrap().state,
            SessionState::Idle { .. }
        ));
    }

    #[test]
    fn a_seeded_read_is_kept_while_its_log_is_unchanged() {
        let temp = tempfile::tempdir().unwrap();
        let transcript = temp.path().join(".claude/projects/-tmp-project/c1.jsonl");
        write(
            &transcript,
            r#"{"type":"user","message":{"role":"user","content":"hi"},"timestamp":"2026-07-04T10:00:00Z"}"#,
        );
        let reader = NativeStatusReader::new(temp.path().to_path_buf());
        let claude = AgentAdapterKind::ClaudeCode.id();
        let saved = NativeLogRead {
            file: NativeLogFile::stat(&transcript),
            companions: Vec::new(),
            status: None,
            launch_id: Some("launch-saved".into()),
            process: None,
        };
        reader.seed(&claude, "c1", saved.clone());

        let reads = reader.read(&claude, &["c1"]);
        assert_eq!(reads.reparsed, 0);
        assert_eq!(reads.sessions["c1"].read, saved);
    }

    fn evidence(state: SessionState) -> NativeStatusEvidence {
        NativeStatusEvidence {
            state,
            reason: "turn open".to_string(),
            observed_at: Some(Utc.timestamp_opt(1_800_000_000, 0).unwrap()),
            waiting_since: Some(Utc.timestamp_opt(1_800_000_000, 0).unwrap()),
        }
    }

    const PERMISSION: SessionState = SessionState::RequiresAction {
        request: svode_agents::status::InteractionKind::Permission,
    };

    #[test]
    fn an_open_turn_follows_the_process_that_holds_it() {
        use ProcessSignal::{Alive, Dead, None as NoSignal};
        use TurnEvidence::{LogAlone, ProcessSignal as BySignal};

        let (alive, external) = turn_status(evidence(PERMISSION), BySignal, Alive);
        assert_eq!(
            alive,
            evidence(PERMISSION),
            "a live process: the store's state"
        );
        assert!(external);

        let (dead, external) = turn_status(evidence(PERMISSION), BySignal, Dead);
        assert_eq!(
            dead.state,
            SessionState::Idle {
                stop_reason: Some(StopReason::Interrupted)
            }
        );
        assert_eq!(dead.observed_at, evidence(PERMISSION).observed_at);
        assert_eq!(dead.waiting_since, None);
        assert!(!external);

        let (unsignalled, external) = turn_status(evidence(PERMISSION), BySignal, NoSignal);
        assert_eq!(unsignalled.state, SessionState::Running);
        assert_eq!(
            unsignalled.observed_at,
            evidence(PERMISSION).observed_at,
            "the C10 threshold counts from the store's evidence"
        );
        assert!(!external, "an approximate running is no other writer");

        let (as_built, external) = turn_status(evidence(PERMISSION), LogAlone, NoSignal);
        assert_eq!(
            as_built,
            evidence(PERMISSION),
            "Claude Code and Codex keep the log's state"
        );
        assert!(external);

        let idle = evidence(SessionState::Idle {
            stop_reason: Some(StopReason::EndTurn),
        });
        let unknown = evidence(SessionState::Unknown);
        for rule in [LogAlone, BySignal] {
            for signal in [Alive, Dead, NoSignal] {
                assert_eq!(
                    turn_status(idle.clone(), rule, signal),
                    (idle.clone(), false)
                );
                assert_eq!(
                    turn_status(unknown.clone(), rule, signal),
                    (unknown.clone(), false)
                );
            }
        }
    }

    #[test]
    fn a_read_saved_by_an_earlier_version_is_still_read() {
        let saved: NativeLogRead = serde_json::from_value(json!({
            "file": { "path": "/tmp/c1.jsonl", "modifiedMs": 1, "size": 2 },
            "status": {
                "state": { "state": "running" },
                "reason": "codex task started",
                "observedAt": null,
                "waitingSince": null
            },
            "launchId": "launch-1"
        }))
        .expect("saved read");
        assert_eq!(saved.file.unwrap().size, 2);
        assert!(saved.companions.is_empty());
        assert_eq!(saved.process, None);
        assert_eq!(saved.launch_id.as_deref(), Some("launch-1"));
    }

    /// A log per session with a process file beside it.
    struct LogWithProcess {
        root: PathBuf,
    }

    impl session_logs::SessionLogLayout for LogWithProcess {
        fn index(&self) -> HashMap<String, PathBuf> {
            HashMap::from([("s1".to_string(), self.root.join("s1.jsonl"))])
        }

        fn companions(&self, log: &Path) -> Vec<PathBuf> {
            vec![log.with_extension("process.json")]
        }

        fn read(&self, log: &Path) -> Result<StoreRead, String> {
            let text = std::fs::read_to_string(log).unwrap_or_default();
            if text.contains("version 9") {
                return Err("unknown format version 9".to_string());
            }
            let process = std::fs::read_to_string(log.with_extension("process.json"))
                .ok()
                .map(|pid| ProcessRecord {
                    pid: pid.trim().parse().unwrap(),
                    host: None,
                    started_by: Utc::now(),
                });
            Ok(StoreRead {
                status: Some(evidence(SessionState::Running)),
                launch_id: None,
                process,
            })
        }
    }

    #[test]
    fn a_session_is_read_again_when_its_process_file_appears_or_changes() {
        let temp = tempfile::tempdir().unwrap();
        let log = temp.path().join("s1.jsonl");
        write(&log, "{}");
        let source = SessionLogs::new(LogWithProcess {
            root: temp.path().to_path_buf(),
        });

        let first = source.read(&["s1"]).unwrap();
        assert_eq!(
            (first.reparsed, first.sessions["s1"].process.is_none()),
            (1, true)
        );
        assert_eq!(source.read(&["s1"]).unwrap().reparsed, 0);

        write(&log.with_extension("process.json"), "4242");
        let appeared = source.read(&["s1"]).unwrap();
        assert_eq!(appeared.reparsed, 1);
        assert_eq!(appeared.sessions["s1"].process.as_ref().unwrap().pid, 4242);

        write(&log.with_extension("process.json"), "424243");
        assert_eq!(
            source.read(&["s1"]).unwrap().sessions["s1"]
                .process
                .as_ref()
                .unwrap()
                .pid,
            424243
        );
    }

    #[test]
    fn a_log_of_an_unknown_format_fails_the_source() {
        let temp = tempfile::tempdir().unwrap();
        write(&temp.path().join("s1.jsonl"), "version 9");
        let source = SessionLogs::new(LogWithProcess {
            root: temp.path().to_path_buf(),
        });
        assert_eq!(
            source.read(&["s1"]).unwrap_err(),
            "unknown format version 9"
        );
    }

    #[test]
    fn an_agent_without_a_native_log_has_no_reader() {
        let kimi = AgentAdapterKind::KimiCode.id();
        let reader = NativeStatusReader::new(PathBuf::from("/nonexistent"));
        let reads = reader.read(&kimi, &["k1"]);
        assert!(reads.sessions.is_empty());
        assert_eq!(reads.problem, None);
    }

    #[test]
    fn agent_sessions_timestamp_parser_rejects_invalid_and_zero() {
        assert!(parse_timestamp_value(&json!(0)).is_none());
        assert!(parse_timestamp_value(&json!("0")).is_none());
        assert!(parse_timestamp_value(&json!("not a timestamp")).is_none());
    }

    #[test]
    fn agent_sessions_timestamp_parser_accepts_seconds_and_milliseconds() {
        let seconds = parse_timestamp_value(&json!(1_700_000_000)).expect("seconds timestamp");
        let millis = parse_timestamp_value(&json!(1_700_000_000_000i64)).expect("millis timestamp");

        assert_eq!(seconds.timestamp(), 1_700_000_000);
        assert_eq!(millis.timestamp(), 1_700_000_000);
    }

    #[test]
    fn agent_sessions_timestamp_parser_accepts_iso() {
        let parsed = parse_timestamp_value(&json!("2026-07-04T10:11:12Z")).expect("iso timestamp");
        assert_eq!(parsed.to_rfc3339(), "2026-07-04T10:11:12+00:00");
    }

    #[test]
    fn routine_launch_context_is_machine_readable() {
        let prompt = concat!(
            "Проверь проект\n\n",
            "<!-- svode-owner:space:. -->\n",
            "<!-- svode-launch:launch-a1 -->"
        );

        assert_eq!(launch_id_from_text(prompt).as_deref(), Some("launch-a1"));
    }

    #[test]
    fn routine_launch_ids_distinguish_same_cwd_prompts() {
        let first = "same task\n<!-- svode-launch:launch-one -->";
        let second = "same task\n<!-- svode-launch:launch-two -->";

        assert_eq!(launch_id_from_text(first).as_deref(), Some("launch-one"));
        assert_eq!(launch_id_from_text(second).as_deref(), Some("launch-two"));
        assert_ne!(launch_id_from_text(first), launch_id_from_text(second));
    }

    #[test]
    fn routine_launch_uses_the_appended_marker_after_long_or_marker_like_body() {
        let instruction = format!(
            "{}\n<!-- svode-launch:user-authored -->",
            "длинная инструкция ".repeat(2_000)
        );
        let prompt = format!(
            "{instruction}\n\n<!-- svode-owner:space:. -->\n<!-- svode-launch:launch-real -->"
        );

        assert_eq!(launch_id_from_text(&prompt).as_deref(), Some("launch-real"));
    }
}

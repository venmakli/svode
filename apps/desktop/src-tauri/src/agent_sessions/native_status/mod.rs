//! Native status reader of the Sessions catalogue (Stage 10 `02` C10): the
//! current status of a session the catalogue lists, read from its agent's
//! native log and always approximate. The reader never makes a catalogue
//! record, counts or metadata and keeps no transcript or tool payload (C8).
//! From the same read it takes the launch marker of a terminal launch's first
//! user turn, the remainder of condition 1 of `02` for Codex.

pub(crate) mod claude_code;
pub(crate) mod codex;

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};

use chrono::{DateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use svode_agents::registry::{AdapterRuntimeRegistry, NativeSessionLog};
use svode_agents::status::SessionState;
use svode_core::agent_adapters::AgentId;

/// A session id missing from the log index rebuilds it at most this often:
/// a new session's log appears after the agent lists it.
const INDEX_REBUILD_AFTER: Duration = Duration::from_secs(5);

/// What the native status reader read from the agent's log; always
/// approximate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeStatusEvidence {
    pub state: SessionState,
    pub reason: String,
    pub observed_at: Option<DateTime<Utc>>,
    pub waiting_since: Option<DateTime<Utc>>,
}

/// One read of a session's native log, valid while the log keeps its size
/// and modification time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeLogRead {
    pub file: NativeLogFile,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<NativeStatusEvidence>,
    /// Launch marker of the first user turn of a terminal launch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeLogFile {
    pub path: PathBuf,
    pub modified_ms: u128,
    pub size: u64,
}

impl NativeLogFile {
    fn stat(path: &Path) -> Option<Self> {
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

/// Reads of the sessions' native logs, kept per session and repeated only for
/// a log that changed, with the index of each agent's logs by session id.
pub(crate) struct NativeStatusReader {
    home: PathBuf,
    state: Mutex<ReaderState>,
}

#[derive(Default)]
struct ReaderState {
    reads: HashMap<(AgentId, String), NativeLogRead>,
    indexes: HashMap<AgentId, LogIndex>,
}

struct LogIndex {
    files: HashMap<String, PathBuf>,
    built: Instant,
}

/// The reads of one call.
#[derive(Default)]
pub(crate) struct NativeReads {
    pub sessions: HashMap<String, NativeLogRead>,
    /// Logs parsed again because they changed or were not read yet.
    pub reparsed: usize,
}

impl NativeStatusReader {
    pub(crate) fn new(home: PathBuf) -> Self {
        Self {
            home,
            state: Mutex::new(ReaderState::default()),
        }
    }

    /// Status and launch marker of the agent's sessions with these native
    /// ids. A session without a log gets nothing.
    pub(crate) fn read(&self, agent: &AgentId, ids: &[&str]) -> NativeReads {
        let Some(log) = log_of(agent) else {
            return NativeReads::default();
        };
        let mut targets = Vec::new();
        let mut missing = Vec::new();
        let rebuild_index = {
            let state = self.state.lock().unwrap();
            let index = state.indexes.get(agent);
            for id in ids {
                if let Some(known) = state.reads.get(&(agent.clone(), id.to_string())) {
                    targets.push((*id, known.file.path.clone(), Some(known.clone())));
                } else if let Some(path) = index.and_then(|index| index.files.get(*id)) {
                    targets.push((*id, path.clone(), None));
                } else {
                    missing.push(*id);
                }
            }
            !missing.is_empty()
                && index.is_none_or(|index| index.built.elapsed() >= INDEX_REBUILD_AFTER)
        };
        if rebuild_index {
            let files = log_index(log, &self.home);
            for id in missing {
                if let Some(path) = files.get(id) {
                    targets.push((id, path.clone(), None));
                }
            }
            self.state.lock().unwrap().indexes.insert(
                agent.clone(),
                LogIndex {
                    files,
                    built: Instant::now(),
                },
            );
        }

        let mut reads = NativeReads::default();
        let mut gone = Vec::new();
        for (id, path, known) in targets {
            // Stat before reading: a log that grows meanwhile is read again.
            let Some(file) = NativeLogFile::stat(&path) else {
                gone.push(id);
                continue;
            };
            if let Some(known) = known.filter(|known| known.file == file) {
                reads.sessions.insert(id.to_string(), known);
                continue;
            }
            let (status, launch_id) = read_log(log, &path);
            reads.reparsed += 1;
            reads.sessions.insert(
                id.to_string(),
                NativeLogRead {
                    file,
                    status,
                    launch_id,
                },
            );
        }

        let mut state = self.state.lock().unwrap();
        for id in gone {
            // A moved log is found again by the next index rebuild.
            state.reads.remove(&(agent.clone(), id.to_string()));
            if let Some(index) = state.indexes.get_mut(agent) {
                index.files.remove(id);
            }
        }
        for (id, read) in &reads.sessions {
            state
                .reads
                .insert((agent.clone(), id.clone()), read.clone());
        }
        reads
    }

    /// A read saved before the app started; a newer read is kept.
    pub(crate) fn seed(&self, agent: &AgentId, id: &str, read: NativeLogRead) {
        self.state
            .lock()
            .unwrap()
            .reads
            .entry((agent.clone(), id.to_string()))
            .or_insert(read);
    }
}

fn log_of(agent: &AgentId) -> Option<NativeSessionLog> {
    AdapterRuntimeRegistry.native_session_log(agent.builtin()?)
}

fn log_index(log: NativeSessionLog, home: &Path) -> HashMap<String, PathBuf> {
    match log {
        NativeSessionLog::CodexRollouts => codex::index(&home.join(".codex")),
        NativeSessionLog::ClaudeProjects => claude_code::index(&home.join(".claude")),
    }
}

fn read_log(log: NativeSessionLog, path: &Path) -> (Option<NativeStatusEvidence>, Option<String>) {
    match log {
        NativeSessionLog::CodexRollouts => codex::read(path),
        NativeSessionLog::ClaudeProjects => claude_code::read(path),
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
            file: NativeLogFile::stat(&transcript).unwrap(),
            status: None,
            launch_id: Some("launch-saved".into()),
        };
        reader.seed(&claude, "c1", saved.clone());

        let reads = reader.read(&claude, &["c1"]);
        assert_eq!(reads.reparsed, 0);
        assert_eq!(reads.sessions["c1"], saved);
    }

    #[test]
    fn an_agent_without_a_native_log_has_no_reader() {
        let hermes = AgentAdapterKind::Hermes.id();
        let reader = NativeStatusReader::new(PathBuf::from("/nonexistent"));
        assert!(reader.read(&hermes, &["h1"]).sessions.is_empty());
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

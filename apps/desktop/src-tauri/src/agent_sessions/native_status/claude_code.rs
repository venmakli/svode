use std::collections::HashMap;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde_json::Value;

use super::session_logs::SessionLogLayout;
use super::{
    NativeStatusEvidence, StoreRead, TurnEvidence, for_each_jsonl, launch_id_from_text,
    nested_string_field, string_field, timestamp_from_fields,
};
use svode_agents::status::{SessionState, StopReason};

/// The session transcripts under the Claude config directory.
pub(super) struct Projects {
    pub root: PathBuf,
}

impl SessionLogLayout for Projects {
    fn index(&self) -> HashMap<String, PathBuf> {
        index(&self.root)
    }

    fn read(&self, log: &Path) -> Result<StoreRead, String> {
        let (status, launch_id) = read(log);
        Ok(StoreRead {
            status,
            launch_id,
            process: None,
        })
    }

    fn turn_evidence(&self) -> TurnEvidence {
        TurnEvidence::LogAlone
    }

    fn tells_conversation(&self) -> bool {
        true
    }
}

/// Session transcripts `projects/<project>/<session id>.jsonl` under the
/// Claude config directory by session id (E01: the listed id is the jsonl
/// session UUID).
pub(super) fn index(root: &Path) -> HashMap<String, PathBuf> {
    let mut files = HashMap::new();
    let Ok(projects) = std::fs::read_dir(root.join("projects")) else {
        return files;
    };
    for project in projects.flatten() {
        let Ok(transcripts) = std::fs::read_dir(project.path()) else {
            continue;
        };
        for transcript in transcripts.flatten() {
            let path = transcript.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl")
                || !transcript.file_type().is_ok_and(|kind| kind.is_file())
            {
                continue;
            }
            if let Some(id) = path.file_stem().and_then(|stem| stem.to_str()) {
                files.insert(id.to_string(), path.clone());
            }
        }
    }
    files
}

/// Status from the transcript tail and the launch marker of the first user
/// turn that carries one.
pub(super) fn read(path: &Path) -> (Option<NativeStatusEvidence>, Option<String>) {
    let mut tail = ClaudeTailState::default();
    let mut launch_id = None;
    for_each_jsonl(path, |value| {
        tail.observe(&value);
        if launch_id.is_none() && message_role(&value) == Some("user") {
            launch_id = launch_id_of(&value);
        }
    });
    (tail.finish(), launch_id)
}

fn message_role(value: &Value) -> Option<&str> {
    match string_field(value, &["type"]) {
        Some("user") => Some("user"),
        Some("assistant") => Some("assistant"),
        _ => nested_string_field(value, &["message", "role"]),
    }
}

fn is_tool_result_line(value: &Value) -> bool {
    if string_field(value, &["type"]).is_some_and(|kind| kind == "tool_result") {
        return true;
    }
    let Some(content) = value
        .get("message")
        .and_then(|message| message.get("content"))
        .or_else(|| value.get("content"))
    else {
        return false;
    };
    match content {
        Value::Array(items) => items
            .iter()
            .any(|item| string_field(item, &["type"]).is_some_and(|kind| kind == "tool_result")),
        _ => false,
    }
}

fn launch_id_of(value: &Value) -> Option<String> {
    if is_tool_result_line(value) {
        return None;
    }
    let message = value.get("message").unwrap_or(value);
    message
        .get("content")
        .and_then(|content| {
            content.as_str().and_then(launch_id_from_text).or_else(|| {
                content.as_array().and_then(|items| {
                    items.iter().find_map(|item| {
                        string_field(item, &["text"]).and_then(launch_id_from_text)
                    })
                })
            })
        })
        .or_else(|| string_field(message, &["text", "prompt"]).and_then(launch_id_from_text))
}

#[derive(Debug, Default)]
struct ClaudeTailState {
    status: Option<NativeStatusEvidence>,
    open_tool_ids: Vec<String>,
}

impl ClaudeTailState {
    fn observe(&mut self, value: &Value) {
        let observed_at = timestamp_from_fields(value);
        match string_field(value, &["type"]) {
            Some("assistant") => self.observe_assistant(value, observed_at),
            Some("user") => self.observe_user(value, observed_at),
            Some("progress") => {
                if !self.open_tool_ids.is_empty() {
                    self.set_active(observed_at, "claude tool progress");
                }
            }
            Some("system") => {
                if matches!(
                    self.status.as_ref().map(|status| status.state),
                    Some(SessionState::Idle { .. })
                ) {
                    return;
                }
                if !self.open_tool_ids.is_empty() {
                    self.set_active(observed_at, "claude task in progress");
                }
            }
            _ => {}
        }
    }

    fn finish(self) -> Option<NativeStatusEvidence> {
        self.status
    }

    fn observe_assistant(&mut self, value: &Value, observed_at: Option<DateTime<Utc>>) {
        let tool_ids = assistant_tool_use_ids(value);
        if !tool_ids.is_empty() {
            self.open_tool_ids.extend(tool_ids);
            self.set_active(observed_at, "claude tool call in progress");
            return;
        }

        let stop_reason = nested_string_field(value, &["message", "stop_reason"]);
        if matches!(stop_reason, Some("end_turn" | "stop_sequence")) {
            self.open_tool_ids.clear();
            self.status = Some(NativeStatusEvidence {
                state: SessionState::Idle {
                    stop_reason: Some(StopReason::EndTurn),
                },
                reason: "claude turn complete".to_string(),
                observed_at,
                waiting_since: None,
            });
            return;
        }

        if !self.open_tool_ids.is_empty() {
            self.set_active(observed_at, "claude task in progress");
        }
    }

    fn observe_user(&mut self, value: &Value, observed_at: Option<DateTime<Utc>>) {
        let result_ids = user_tool_result_ids(value);
        if !result_ids.is_empty() {
            self.open_tool_ids
                .retain(|id| !result_ids.iter().any(|result_id| result_id == id));
            self.set_active(observed_at, "claude tool result received");
            return;
        }

        match user_record(value) {
            UserRecord::Prompt => {
                self.open_tool_ids.clear();
                self.set_active(observed_at, "claude user prompt submitted");
            }
            UserRecord::Interrupt => {
                if self
                    .status
                    .as_ref()
                    .is_some_and(|status| status.state.in_turn())
                {
                    self.open_tool_ids.clear();
                    self.status = Some(NativeStatusEvidence {
                        state: SessionState::Idle {
                            stop_reason: Some(StopReason::Cancelled),
                        },
                        reason: "claude turn interrupted by the user".to_string(),
                        observed_at,
                        waiting_since: None,
                    });
                }
            }
            UserRecord::Service => {}
        }
    }

    fn set_active(&mut self, observed_at: Option<DateTime<Utc>>, reason: &str) {
        self.status = Some(NativeStatusEvidence {
            state: SessionState::Running,
            reason: reason.to_string(),
            observed_at,
            waiting_since: None,
        });
    }
}

/// What a user record without a tool result does to the turn (DF-169 R1).
enum UserRecord {
    /// A record the agent answers: a user message, a task notification, a
    /// message of another agent, or a record of a kind not known here.
    Prompt,
    /// The marker Claude Code writes when the user interrupts the turn.
    Interrupt,
    /// A transcript-only record, a local command or its output, or a
    /// compaction summary: no turn starts and the last activity stays.
    Service,
}

const INTERRUPT_MARKER: &str = "[Request interrupted by user";
const LOCAL_COMMAND_TAGS: [&str; 3] = [
    "<local-command-caveat>",
    "<command-name>",
    "<local-command-stdout>",
];

fn user_record(value: &Value) -> UserRecord {
    let flag = |key: &str| value.get(key).and_then(Value::as_bool) == Some(true);
    if flag("queueTranscriptOnly") || flag("isCompactSummary") {
        return UserRecord::Service;
    }
    let Some(text) = user_text(value).map(str::trim_start) else {
        return UserRecord::Prompt;
    };
    if LOCAL_COMMAND_TAGS.iter().any(|tag| text.starts_with(tag)) {
        UserRecord::Service
    } else if text.starts_with(INTERRUPT_MARKER) {
        UserRecord::Interrupt
    } else {
        UserRecord::Prompt
    }
}

/// The text of a user record: its string content or its first text item.
fn user_text(value: &Value) -> Option<&str> {
    let content = value
        .get("message")
        .and_then(|message| message.get("content"))
        .or_else(|| value.get("content"))?;
    content.as_str().or_else(|| {
        content
            .as_array()?
            .iter()
            .find(|item| string_field(item, &["type"]) == Some("text"))?
            .get("text")?
            .as_str()
    })
}

fn assistant_tool_use_ids(value: &Value) -> Vec<String> {
    message_content_items(value)
        .into_iter()
        .filter(|item| string_field(item, &["type"]).is_some_and(|kind| kind == "tool_use"))
        .filter_map(|item| string_field(item, &["id"]).map(str::to_string))
        .collect()
}

fn user_tool_result_ids(value: &Value) -> Vec<String> {
    message_content_items(value)
        .into_iter()
        .filter(|item| string_field(item, &["type"]).is_some_and(|kind| kind == "tool_result"))
        .filter_map(|item| string_field(item, &["tool_use_id"]).map(str::to_string))
        .collect()
}

fn message_content_items(value: &Value) -> Vec<&Value> {
    value
        .get("message")
        .and_then(|message| message.get("content"))
        .or_else(|| value.get("content"))
        .and_then(Value::as_array)
        .map(|items| items.iter().collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(path: &Path, data: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(path, data).expect("write fixture");
    }

    #[test]
    fn the_index_finds_transcripts_by_session_id() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join(".claude");
        let transcript = root.join("projects/-tmp-project/claude-1.jsonl");
        write(&transcript, "");
        write(
            &root.join("projects/-tmp-project/claude-1/subagents/agent-a.jsonl"),
            "",
        );
        write(&root.join("history.jsonl"), "");

        let files = index(&root);
        assert_eq!(files.len(), 1);
        assert_eq!(files["claude-1"], transcript);
    }

    #[test]
    fn agent_sessions_claude_tail_tool_use_sets_active_status() {
        let temp = tempfile::tempdir().expect("temp dir");
        let transcript = temp.path().join("claude-active.jsonl");
        write(
            &transcript,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"date"}}],"stop_reason":"tool_use"},"timestamp":"2026-07-04T09:00:00Z"}"#,
        );

        let status = read(&transcript).0.expect("status");
        assert_eq!(status.state, SessionState::Running);
        assert_eq!(status.reason, "claude tool call in progress");
    }

    #[test]
    fn agent_sessions_claude_tail_end_turn_sets_done_status() {
        let temp = tempfile::tempdir().expect("temp dir");
        let transcript = temp.path().join("claude-done.jsonl");
        write(
            &transcript,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"stop_reason":"end_turn"},"timestamp":"2026-07-04T09:00:00Z"}"#,
        );

        let status = read(&transcript).0.expect("status");
        assert_eq!(
            status.state,
            SessionState::Idle {
                stop_reason: Some(StopReason::EndTurn)
            }
        );
        assert_eq!(status.reason, "claude turn complete");
    }

    /// Records of the forms Claude Code 2.1.x writes (DF-169 evidence); the
    /// text is a placeholder.
    fn prompt(at: &str) -> Value {
        serde_json::json!({"type": "user", "message": {"role": "user", "content": "run it"}, "origin": {"kind": "human"}, "promptSource": "typed", "timestamp": at})
    }

    fn end_turn(at: &str) -> Value {
        serde_json::json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "done"}], "stop_reason": "end_turn"}, "timestamp": at})
    }

    fn tool_use(at: &str) -> Value {
        serde_json::json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {}}], "stop_reason": "tool_use"}, "timestamp": at})
    }

    fn tool_result(at: &str) -> Value {
        serde_json::json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_1", "content": "ok"}]}, "timestamp": at})
    }

    fn task_notification(at: &str, transcript_only: bool) -> Value {
        let mut record = serde_json::json!({"type": "user", "message": {"role": "user", "content": "<task-notification>\n<status>killed</status>\n</task-notification>"}, "origin": {"kind": "task-notification"}, "promptSource": "system", "timestamp": at});
        if transcript_only {
            record["queueTranscriptOnly"] = Value::Bool(true);
        }
        record
    }

    fn peer(at: &str) -> Value {
        serde_json::json!({"type": "user", "isMeta": true, "message": {"role": "user", "content": "a message"}, "origin": {"kind": "peer", "from": "agent-a"}, "promptSource": "system", "timestamp": at})
    }

    fn interrupt(at: &str, marker: &str) -> Value {
        serde_json::json!({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": marker}]}, "timestamp": at})
    }

    fn local_command(at: &str) -> Vec<Value> {
        vec![
            serde_json::json!({"type": "user", "isMeta": true, "message": {"role": "user", "content": "<local-command-caveat>Caveat</local-command-caveat>"}, "timestamp": at}),
            serde_json::json!({"type": "user", "message": {"role": "user", "content": "<command-name>/model</command-name>\n<command-message>model</command-message>"}, "timestamp": at}),
            serde_json::json!({"type": "user", "message": {"role": "user", "content": "<local-command-stdout>Set model</local-command-stdout>"}, "timestamp": at}),
        ]
    }

    fn compact_summary(at: &str) -> Value {
        serde_json::json!({"type": "user", "isCompactSummary": true, "isVisibleInTranscriptOnly": true, "message": {"role": "user", "content": "This session is being continued"}, "timestamp": at})
    }

    fn status_of(records: &[Value]) -> NativeStatusEvidence {
        let temp = tempfile::tempdir().expect("temp dir");
        let transcript = temp.path().join("claude.jsonl");
        let lines = records
            .iter()
            .map(|record| format!("{record}\n"))
            .collect::<String>();
        write(&transcript, &lines);
        read(&transcript).0.expect("status")
    }

    fn at(timestamp: &str) -> Option<DateTime<Utc>> {
        Some(timestamp.parse().expect("timestamp"))
    }

    const PROMPT_AT: &str = "2026-10-04T11:13:06Z";
    const DONE_AT: &str = "2026-10-04T11:13:13Z";
    const LATER_AT: &str = "2026-10-04T11:13:50Z";

    /// DF-169 acceptance 1: transcript-only records, a local command with its
    /// output and a compaction summary after the turn leave it ended, with
    /// the time of its end.
    #[test]
    fn service_records_after_a_turn_keep_its_end() {
        let service = [
            vec![task_notification(LATER_AT, true)],
            local_command(LATER_AT),
            vec![compact_summary(LATER_AT)],
        ];
        for records in service {
            let mut log = vec![prompt(PROMPT_AT), end_turn(DONE_AT)];
            log.extend(records.clone());
            let status = status_of(&log);
            assert_eq!(
                status.state,
                SessionState::Idle {
                    stop_reason: Some(StopReason::EndTurn)
                },
                "{records:?}"
            );
            assert_eq!(status.observed_at, at(DONE_AT), "{records:?}");
        }
    }

    /// A service record during an open turn does not extend it.
    #[test]
    fn a_service_record_keeps_the_time_of_an_open_turn() {
        let status = status_of(&[
            prompt(PROMPT_AT),
            tool_use(DONE_AT),
            task_notification(LATER_AT, true),
        ]);
        assert_eq!(status.state, SessionState::Running);
        assert_eq!(status.observed_at, at(DONE_AT));
    }

    /// DF-169 acceptance 1: the interrupt marker closes an open turn as
    /// cancelled, also when it follows the rejected tool result.
    #[test]
    fn the_interrupt_marker_cancels_an_open_turn() {
        let cancelled = SessionState::Idle {
            stop_reason: Some(StopReason::Cancelled),
        };
        let status = status_of(&[
            prompt(PROMPT_AT),
            interrupt(LATER_AT, "[Request interrupted by user]"),
        ]);
        assert_eq!(status.state, cancelled);
        assert_eq!(status.observed_at, at(LATER_AT));

        let status = status_of(&[
            prompt(PROMPT_AT),
            tool_use(DONE_AT),
            tool_result(LATER_AT),
            interrupt(LATER_AT, "[Request interrupted by user for tool use]"),
        ]);
        assert_eq!(status.state, cancelled);

        let status = status_of(&[
            prompt(PROMPT_AT),
            end_turn(DONE_AT),
            interrupt(LATER_AT, "[Request interrupted by user]"),
        ]);
        assert_eq!(
            status.state,
            SessionState::Idle {
                stop_reason: Some(StopReason::EndTurn)
            },
            "a marker without an open turn changes nothing"
        );
        assert_eq!(status.observed_at, at(DONE_AT));
    }

    /// DF-169 acceptance 1: a user message, a task notification the agent
    /// answers, a message of another agent and a record of an unknown kind
    /// start a turn; a tool result keeps the open turn.
    #[test]
    fn records_the_agent_answers_start_a_turn() {
        let unknown = serde_json::json!({"type": "user", "message": {"role": "user", "content": "<future-record>x</future-record>"}, "timestamp": LATER_AT});
        for record in [
            prompt(LATER_AT),
            task_notification(LATER_AT, false),
            peer(LATER_AT),
            unknown,
        ] {
            let status = status_of(&[prompt(PROMPT_AT), end_turn(DONE_AT), record.clone()]);
            assert_eq!(status.state, SessionState::Running, "{record}");
            assert_eq!(status.reason, "claude user prompt submitted");
            assert_eq!(status.observed_at, at(LATER_AT), "{record}");
        }

        let status = status_of(&[prompt(PROMPT_AT), tool_use(DONE_AT), tool_result(LATER_AT)]);
        assert_eq!(status.state, SessionState::Running);
        assert_eq!(status.reason, "claude tool result received");
    }

    #[test]
    fn the_launch_marker_of_a_preassigned_session_comes_from_its_first_user_turn() {
        let temp = tempfile::tempdir().expect("temp dir");
        let transcript = temp
            .path()
            .join("123e4567-e89b-42d3-a456-426614174000.jsonl");
        write(
            &transcript,
            r##"{"sessionId":"123e4567-e89b-42d3-a456-426614174000","type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t0","content":"<!-- svode-launch:not-a-turn -->"}]},"timestamp":1700000000}
{"sessionId":"123e4567-e89b-42d3-a456-426614174000","type":"user","message":{"role":"user","content":[{"type":"text","text":"Prepare report\n\n<!-- svode-launch:launch-claude -->"}]},"cwd":"/tmp/project","timestamp":1700000001}"##,
        );

        assert_eq!(read(&transcript).1.as_deref(), Some("launch-claude"));
    }
}

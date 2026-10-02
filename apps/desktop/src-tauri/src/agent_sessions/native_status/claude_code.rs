use std::collections::HashMap;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde_json::Value;

use super::{
    NativeStatusEvidence, for_each_jsonl, launch_id_from_text, nested_string_field, string_field,
    timestamp_from_fields,
};
use svode_agents::status::{SessionState, StopReason};

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

        self.open_tool_ids.clear();
        self.set_active(observed_at, "claude user prompt submitted");
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

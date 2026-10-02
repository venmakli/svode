use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use chrono::{DateTime, Utc};
use regex::Regex;
use serde_json::Value;

use super::{
    NativeStatusEvidence, for_each_jsonl, launch_id_from_text, string_field, timestamp_from_fields,
};
use svode_agents::status::{InteractionKind, SessionState, StopReason};

static ROLLOUT_ID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
        .expect("valid rollout id regex")
});

/// Rollout files under the Codex home by session id: the id is the uuid in
/// the file name (E01: `sessionId` = `thread.id` = rollout id).
pub(super) fn index(root: &Path) -> HashMap<String, PathBuf> {
    let mut files = HashMap::new();
    collect_rollouts(&root.join("sessions"), &mut files);
    files
}

fn collect_rollouts(dir: &Path, files: &mut HashMap<String, PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if file_type.is_dir() {
            collect_rollouts(&path, files);
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !(name.starts_with("rollout-") && name.ends_with(".jsonl")) {
            continue;
        }
        if let Some(id) = ROLLOUT_ID.find(name) {
            files.insert(id.as_str().to_ascii_lowercase(), path);
        }
    }
}

/// Status from the rollout tail and the launch marker of the first user
/// turn that carries one.
pub(super) fn read(path: &Path) -> (Option<NativeStatusEvidence>, Option<String>) {
    let mut tail = CodexTailState::default();
    let mut launch_id = None;
    for_each_jsonl(path, |value| {
        tail.observe(&value);
        if launch_id.is_none()
            && string_field(&value, &["type"]) == Some("response_item")
            && let Some(payload) = value.get("payload")
            && string_field(payload, &["role"]) == Some("user")
        {
            launch_id = launch_id_of(payload);
        }
    });
    (tail.finish(), launch_id)
}

fn launch_id_of(payload: &Value) -> Option<String> {
    string_field(payload, &["text", "prompt"])
        .and_then(launch_id_from_text)
        .or_else(|| {
            payload.get("content").and_then(|content| {
                content.as_str().and_then(launch_id_from_text).or_else(|| {
                    content.as_array().and_then(|items| {
                        items.iter().find_map(|item| {
                            string_field(item, &["text", "input_text"])
                                .and_then(launch_id_from_text)
                        })
                    })
                })
            })
        })
}

fn is_function_call_output(value: &Value) -> bool {
    string_field(value, &["type"])
        .is_some_and(|kind| matches!(kind, "function_call_output" | "custom_tool_call_output"))
}

#[derive(Debug, Default)]
struct CodexTailState {
    status: Option<NativeStatusEvidence>,
    turn_open: bool,
    open_calls: HashMap<String, CodexOpenCall>,
    // Set by the latest turn settings when approval requests are not put to
    // the user; a rollout without turn settings asks the user.
    approvals_bypass_user: bool,
}

#[derive(Debug, Clone)]
struct CodexOpenCall {
    request: Option<InteractionKind>,
    observed_at: Option<DateTime<Utc>>,
}

impl CodexTailState {
    fn observe(&mut self, value: &Value) {
        let event_type = string_field(value, &["type"]).unwrap_or_default();
        let payload = value.get("payload").unwrap_or(value);
        let payload_type = string_field(payload, &["type"]).unwrap_or_default();
        let observed_at = timestamp_from_fields(payload).or_else(|| timestamp_from_fields(value));

        if event_type == "turn_context" {
            self.approvals_bypass_user = approvals_bypass_user(payload);
            return;
        }

        if event_type == "event_msg" {
            match payload_type {
                "task_started" => {
                    self.turn_open = true;
                    self.open_calls.clear();
                    self.set_state(
                        SessionState::Running,
                        None,
                        observed_at,
                        "codex task started",
                    );
                }
                "task_complete" => {
                    self.turn_open = false;
                    self.open_calls.clear();
                    self.set_state(
                        SessionState::Idle {
                            stop_reason: Some(StopReason::EndTurn),
                        },
                        None,
                        observed_at,
                        "codex task complete",
                    );
                }
                "turn_aborted" => {
                    self.turn_open = false;
                    self.open_calls.clear();
                    let reason = string_field(payload, &["reason"])
                        .map(|reason| format!("codex turn aborted: {reason}"))
                        .unwrap_or_else(|| "codex turn aborted".to_string());
                    self.set_state(
                        SessionState::Idle {
                            stop_reason: Some(StopReason::Cancelled),
                        },
                        None,
                        observed_at,
                        &reason,
                    );
                }
                _ => {
                    if self.turn_open {
                        self.refresh_active(observed_at);
                    }
                }
            }
            return;
        }

        if event_type != "response_item" {
            return;
        }

        if is_codex_tool_call(payload) {
            self.turn_open = true;
            if let Some(call_id) = string_field(payload, &["call_id"]) {
                self.open_calls.insert(
                    call_id.to_string(),
                    CodexOpenCall {
                        request: codex_wait_request(payload),
                        observed_at,
                    },
                );
            }
            self.refresh_active(observed_at);
            return;
        }

        if is_function_call_output(payload) {
            if let Some(call_id) = string_field(payload, &["call_id"]) {
                self.open_calls.remove(call_id);
            }
            if self.turn_open {
                self.refresh_active(observed_at);
            }
            return;
        }

        if self.turn_open {
            self.refresh_active(observed_at);
        }
    }

    fn finish(self) -> Option<NativeStatusEvidence> {
        self.status
    }

    fn refresh_active(&mut self, observed_at: Option<DateTime<Utc>>) {
        let mut approval_since: Option<DateTime<Utc>> = None;
        let mut input_since: Option<DateTime<Utc>> = None;
        let mut has_approval = false;
        let mut has_input = false;
        for call in self.open_calls.values() {
            match call.request {
                Some(InteractionKind::Permission) if self.approvals_bypass_user => {}
                Some(InteractionKind::Permission) => {
                    has_approval = true;
                    approval_since = earliest_timestamp(approval_since, call.observed_at);
                }
                Some(InteractionKind::Question) => {
                    has_input = true;
                    input_since = earliest_timestamp(input_since, call.observed_at);
                }
                None => {}
            }
        }

        // An open approval outranks an open question.
        let (state, waiting_since, reason) = if has_approval {
            (
                SessionState::RequiresAction {
                    request: InteractionKind::Permission,
                },
                approval_since,
                "codex task waiting for approval",
            )
        } else if has_input {
            (
                SessionState::RequiresAction {
                    request: InteractionKind::Question,
                },
                input_since,
                "codex task waiting for user input",
            )
        } else {
            (SessionState::Running, None, "codex task in progress")
        };
        self.set_state(state, waiting_since, observed_at, reason);
    }

    fn set_state(
        &mut self,
        state: SessionState,
        waiting_since: Option<DateTime<Utc>>,
        observed_at: Option<DateTime<Utc>>,
        reason: &str,
    ) {
        self.status = Some(NativeStatusEvidence {
            state,
            reason: reason.to_string(),
            observed_at,
            waiting_since,
        });
    }
}

fn earliest_timestamp(
    current: Option<DateTime<Utc>>,
    next: Option<DateTime<Utc>>,
) -> Option<DateTime<Utc>> {
    match (current, next) {
        (Some(current), Some(next)) => Some(current.min(next)),
        (None, Some(next)) => Some(next),
        (current, None) => current,
    }
}

fn is_codex_tool_call(payload: &Value) -> bool {
    string_field(payload, &["type"])
        .is_some_and(|kind| matches!(kind, "function_call" | "custom_tool_call"))
}

fn codex_wait_request(payload: &Value) -> Option<InteractionKind> {
    match string_field(payload, &["name"]) {
        Some("apply_patch") => Some(InteractionKind::Permission),
        Some("request_user_input") => Some(InteractionKind::Question),
        Some("exec_command") => exec_command_wait_request(payload),
        Some("exec") => code_mode_wait_request(payload),
        _ => None,
    }
}

fn exec_command_wait_request(payload: &Value) -> Option<InteractionKind> {
    let args = string_field(payload, &["arguments"])
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())?;
    string_field(&args, &["sandbox_permissions"])
        .is_some_and(|value| value == "require_escalated")
        .then_some(InteractionKind::Permission)
}

static CODE_MODE_TOOL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\btools\s*(?:\.\s*([A-Za-z_]\w*)|\[\s*["']([A-Za-z_]\w*)["']\s*\])"#)
        .expect("valid code mode tool regex")
});

static ESCALATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\bsandbox_permissions["']?\s*:\s*["']require_escalated["']"#)
        .expect("valid escalation regex")
});

/// Classifies a code-mode `exec` cell by the tools its JS input calls; the
/// input is matched as text and never executed.
fn code_mode_wait_request(payload: &Value) -> Option<InteractionKind> {
    let input = string_field(payload, &["input"])?;
    let mut runs_commands = false;
    let mut edits_files = false;
    for captures in CODE_MODE_TOOL.captures_iter(input) {
        match captures
            .get(1)
            .or_else(|| captures.get(2))
            .map(|m| m.as_str())
        {
            Some("exec_command" | "write_stdin") => runs_commands = true,
            Some("apply_patch") => edits_files = true,
            _ => {}
        }
    }
    if runs_commands {
        ESCALATION
            .is_match(input)
            .then_some(InteractionKind::Permission)
    } else {
        edits_files.then_some(InteractionKind::Permission)
    }
}

fn approvals_bypass_user(turn_context: &Value) -> bool {
    let policy = turn_context.get("approval_policy");
    let never = policy.and_then(Value::as_str) == Some("never");
    let sandbox_approval_off = policy
        .and_then(|policy| policy.get("granular"))
        .and_then(|granular| granular.get("sandbox_approval"))
        .and_then(Value::as_bool)
        == Some(false);
    let auto_review = string_field(turn_context, &["approvals_reviewer"]) == Some("auto_review");
    never || sandbox_approval_off || auto_review
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

    const PERMISSION: SessionState = SessionState::RequiresAction {
        request: InteractionKind::Permission,
    };
    const QUESTION: SessionState = SessionState::RequiresAction {
        request: InteractionKind::Question,
    };

    fn turn_context(approval_policy: Value, approvals_reviewer: &str) -> Value {
        serde_json::json!({
            "type": "turn_context",
            "timestamp": "2026-10-01T21:40:00Z",
            "payload": {
                "turn_id": "turn-1",
                "cwd": "/tmp/project",
                "approval_policy": approval_policy,
                "approvals_reviewer": approvals_reviewer,
                "sandbox_policy": { "type": "workspace-write" }
            }
        })
    }

    fn task_started() -> Value {
        serde_json::json!({
            "type": "event_msg",
            "timestamp": "2026-10-01T21:40:01Z",
            "payload": { "type": "task_started", "turn_id": "turn-1" }
        })
    }

    fn exec_cell(call_id: &str, input: &str, timestamp: &str) -> Value {
        serde_json::json!({
            "type": "response_item",
            "timestamp": timestamp,
            "payload": {
                "type": "custom_tool_call",
                "id": format!("ctc_{call_id}"),
                "status": "completed",
                "call_id": call_id,
                "name": "exec",
                "input": input
            }
        })
    }

    fn call_output(call_id: &str, timestamp: &str) -> Value {
        serde_json::json!({
            "type": "response_item",
            "timestamp": timestamp,
            "payload": {
                "type": "custom_tool_call_output",
                "call_id": call_id,
                "output": "Script completed"
            }
        })
    }

    fn function_call(name: &str, call_id: &str, arguments: &str, timestamp: &str) -> Value {
        serde_json::json!({
            "type": "response_item",
            "timestamp": timestamp,
            "payload": {
                "type": "function_call",
                "name": name,
                "call_id": call_id,
                "arguments": arguments
            }
        })
    }

    fn tail_status(rows: &[Value]) -> NativeStatusEvidence {
        let mut tail = CodexTailState::default();
        for row in rows {
            tail.observe(row);
        }
        tail.finish().expect("tail status")
    }

    fn on_request_user() -> Value {
        turn_context(Value::from("on-request"), "user")
    }

    const ESCALATED_UNQUOTED: &str = "const r = await tools.exec_command({cmd: \"touch /tmp/outside.txt\", sandbox_permissions: \"require_escalated\", justification: \"write outside workspace\", yield_time_ms: 30000});\ntext(r.output);";
    const ESCALATED_QUOTED: &str = "const r = await tools.exec_command({ \"cmd\": \"touch /tmp/outside.txt\" , \"sandbox_permissions\" :\n  'require_escalated' });\ntext(r.output);";
    const COMMAND: &str = "const r = await tools.exec_command({cmd: \"rg -n foo\", yield_time_ms: 10000});\ntext(r.output);";
    const PATCH: &str = "const r = await tools.apply_patch(\"*** Begin Patch\\n*** Update File: a.txt\\n@@\\n-old\\n+new\\n*** End Patch\");\ntext(r);";

    #[test]
    fn agent_sessions_codex_code_mode_escalation_waits_for_permission() {
        for input in [ESCALATED_UNQUOTED, ESCALATED_QUOTED] {
            let status = tail_status(&[
                on_request_user(),
                task_started(),
                exec_cell("call-esc", input, "2026-10-01T21:40:05Z"),
            ]);
            assert_eq!(status.state, PERMISSION, "input: {input}");
            assert_eq!(
                status.waiting_since.map(|ts| ts.to_rfc3339()).as_deref(),
                Some("2026-10-01T21:40:05+00:00")
            );
        }
    }

    #[test]
    fn agent_sessions_codex_code_mode_command_without_escalation_runs() {
        let status = tail_status(&[
            on_request_user(),
            task_started(),
            exec_cell("call-cmd", COMMAND, "2026-10-01T21:40:05Z"),
        ]);
        assert_eq!(status.state, SessionState::Running);
        assert_eq!(status.waiting_since, None);
    }

    #[test]
    fn agent_sessions_codex_code_mode_edit_only_waits_and_edit_with_command_runs() {
        let edit_only = tail_status(&[
            on_request_user(),
            task_started(),
            exec_cell("call-edit", PATCH, "2026-10-01T21:40:05Z"),
        ]);
        assert_eq!(edit_only.state, PERMISSION);

        let edit_with_command = tail_status(&[
            on_request_user(),
            task_started(),
            exec_cell(
                "call-mixed",
                &format!("{PATCH}\n{COMMAND}"),
                "2026-10-01T21:40:05Z",
            ),
        ]);
        assert_eq!(edit_with_command.state, SessionState::Running);

        let edit_with_stdin = tail_status(&[
            on_request_user(),
            task_started(),
            exec_cell(
                "call-stdin",
                &format!("{PATCH}\nawait tools[\"write_stdin\"]({{session_id: 3, chars: \"\"}});"),
                "2026-10-01T21:40:05Z",
            ),
        ]);
        assert_eq!(edit_with_stdin.state, SessionState::Running);
    }

    #[test]
    fn agent_sessions_codex_questions_block_only_when_synchronous() {
        let blocking = tail_status(&[
            on_request_user(),
            task_started(),
            function_call(
                "request_user_input",
                "call-q",
                "{\"questions\":[]}",
                "2026-10-01T21:40:05Z",
            ),
        ]);
        assert_eq!(blocking.state, QUESTION);

        let async_question = tail_status(&[
            on_request_user(),
            task_started(),
            function_call(
                "request_user_input_async",
                "call-qa",
                "{\"questions\":[]}",
                "2026-10-01T21:40:05Z",
            ),
        ]);
        assert_eq!(async_question.state, SessionState::Running);
    }

    #[test]
    fn agent_sessions_codex_turn_settings_without_user_review_do_not_wait() {
        let granular = serde_json::json!({
            "granular": {
                "sandbox_approval": false,
                "rules": false,
                "skill_approval": false,
                "request_permissions": true,
                "mcp_elicitations": true
            }
        });
        for settings in [
            turn_context(Value::from("never"), "user"),
            turn_context(granular, "user"),
            turn_context(Value::from("on-request"), "auto_review"),
        ] {
            for input in [ESCALATED_UNQUOTED, PATCH] {
                let status = tail_status(&[
                    settings.clone(),
                    task_started(),
                    exec_cell("call-auto", input, "2026-10-01T21:40:05Z"),
                ]);
                assert_eq!(status.state, SessionState::Running, "settings: {settings}");
            }
            let legacy = tail_status(&[
                settings.clone(),
                task_started(),
                function_call(
                    "exec_command",
                    "call-legacy",
                    "{\"cmd\":\"date\",\"sandbox_permissions\":\"require_escalated\"}",
                    "2026-10-01T21:40:05Z",
                ),
            ]);
            assert_eq!(legacy.state, SessionState::Running, "settings: {settings}");
        }

        let granular_with_sandbox_approval = turn_context(
            serde_json::json!({ "granular": { "sandbox_approval": true } }),
            "user",
        );
        let status = tail_status(&[
            granular_with_sandbox_approval,
            task_started(),
            exec_cell("call-esc", ESCALATED_UNQUOTED, "2026-10-01T21:40:05Z"),
        ]);
        assert_eq!(status.state, PERMISSION);

        let without_turn_context = tail_status(&[
            task_started(),
            exec_cell("call-esc", ESCALATED_UNQUOTED, "2026-10-01T21:40:05Z"),
        ]);
        assert_eq!(without_turn_context.state, PERMISSION);
    }

    #[test]
    fn agent_sessions_codex_code_mode_request_transitions() {
        let approved = tail_status(&[
            on_request_user(),
            task_started(),
            exec_cell("call-esc", ESCALATED_UNQUOTED, "2026-10-01T21:40:05Z"),
            call_output("call-esc", "2026-10-01T21:41:30Z"),
        ]);
        assert_eq!(approved.state, SessionState::Running);
        assert_eq!(approved.waiting_since, None);

        let denied = tail_status(&[
            on_request_user(),
            task_started(),
            exec_cell("call-esc", ESCALATED_UNQUOTED, "2026-10-01T21:40:05Z"),
            call_output("call-esc", "2026-10-01T21:41:30Z"),
            serde_json::json!({
                "type": "event_msg",
                "timestamp": "2026-10-01T21:41:31Z",
                "payload": { "type": "turn_aborted", "reason": "interrupted" }
            }),
        ]);
        assert_eq!(
            denied.state,
            SessionState::Idle {
                stop_reason: Some(StopReason::Cancelled)
            }
        );

        let permission_over_question = tail_status(&[
            on_request_user(),
            task_started(),
            function_call("request_user_input", "call-q", "{}", "2026-10-01T21:40:03Z"),
            exec_cell("call-edit", PATCH, "2026-10-01T21:40:05Z"),
            exec_cell("call-esc", ESCALATED_QUOTED, "2026-10-01T21:40:09Z"),
        ]);
        assert_eq!(permission_over_question.state, PERMISSION);
        assert_eq!(
            permission_over_question
                .waiting_since
                .map(|ts| ts.to_rfc3339())
                .as_deref(),
            Some("2026-10-01T21:40:05+00:00")
        );
    }

    #[test]
    fn the_index_finds_rollouts_by_the_id_in_their_name() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join(".codex");
        let rollout = root.join(
            "sessions/2026/07/04/rollout-2026-07-04T10-00-00-0199A1B2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl",
        );
        write(&rollout, "");
        write(&root.join("sessions/2026/07/04/notes.jsonl"), "");
        write(&root.join("history.jsonl"), "");

        let files = index(&root);
        assert_eq!(files.len(), 1);
        assert_eq!(files["0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"], rollout);
    }

    #[test]
    fn the_launch_marker_comes_from_the_first_user_turn_that_carries_it() {
        let temp = tempfile::tempdir().expect("temp dir");
        let rollout = temp.path().join("rollout-launch.jsonl");
        write(
            &rollout,
            r##"{"type":"session_meta","payload":{"id":"codex-launch","cwd":"/tmp/project"},"timestamp":"2026-07-04T10:00:00Z"}
{"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"<environment_context><cwd>/tmp/project</cwd></environment_context>"}]},"timestamp":"2026-07-04T10:00:30Z"}
{"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"Review backlog\n\n<!-- svode-launch:launch-codex -->"}]},"timestamp":"2026-07-04T10:01:00Z"}
{"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"later\n<!-- svode-launch:launch-later -->"}]},"timestamp":"2026-07-04T10:02:00Z"}
{"type":"event_msg","payload":{"type":"task_complete"},"timestamp":"2026-07-04T10:03:00Z"}"##,
        );

        let (status, launch_id) = read(&rollout);
        assert_eq!(launch_id.as_deref(), Some("launch-codex"));
        assert_eq!(
            status.expect("status").state,
            SessionState::Idle {
                stop_reason: Some(StopReason::EndTurn)
            }
        );
    }
}

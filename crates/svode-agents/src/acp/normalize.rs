//! ACP v1 wire messages → Svode activity changes. The only place that reads
//! ACP session updates; historical replay and live turns share it.

use serde_json::Value;

use super::wire;

use crate::activity::{
    DetailBlock, InteractionOption, InteractionOptionKind, ItemStatus, Plan, PlanEntry,
    PlanEntryPriority, PlanEntryStatus, ToolKind,
};
use crate::status::StopReason;

/// Upper bound for labels taken from unknown agent payloads.
const LABEL_LIMIT: usize = 80;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MessageRole {
    User,
    Agent,
    Reasoning,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ToolUpdate {
    pub id: String,
    pub title: Option<String>,
    pub tool: Option<ToolKind>,
    pub status: Option<ItemStatus>,
    /// Replaces the collected content when present.
    pub blocks: Option<Vec<DetailBlock>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Normalized {
    Message {
        role: MessageRole,
        message_id: Option<String>,
        text: String,
    },
    Tool(ToolUpdate),
    Plan(Plan),
    ModeChange(String),
    ConfigChange,
    Usage {
        used: u64,
        size: u64,
    },
    /// A known update that carries no activity (commands, session info).
    None,
    /// An update or extension the runtime does not model.
    Generic(String),
}

/// Session id and normalized change of a `session/update` notification.
pub(crate) fn session_update(params: Value) -> Option<(String, Normalized)> {
    let session_id = params.get("sessionId")?.as_str()?.to_string();
    let label = params
        .get("update")
        .and_then(|update| update.get("sessionUpdate"))
        .and_then(Value::as_str)
        .map(|tag| bounded(tag, LABEL_LIMIT))
        .unwrap_or_else(|| "unknown".to_string());
    let normalized = match serde_json::from_value::<wire::SessionNotification>(params) {
        Ok(notification) => normalize(notification.update),
        Err(_) => Normalized::Generic(label),
    };
    Some((session_id, normalized))
}

fn normalize(update: wire::SessionUpdate) -> Normalized {
    match update {
        wire::SessionUpdate::UserMessageChunk(chunk) => message(MessageRole::User, chunk),
        wire::SessionUpdate::AgentMessageChunk(chunk) => message(MessageRole::Agent, chunk),
        wire::SessionUpdate::AgentThoughtChunk(chunk) => message(MessageRole::Reasoning, chunk),
        wire::SessionUpdate::ToolCall(call) => Normalized::Tool(ToolUpdate {
            id: call.tool_call_id,
            title: Some(call.title),
            tool: Some(tool_kind(call.kind.as_deref())),
            status: Some(item_status(call.status.as_deref())),
            blocks: Some(tool_blocks(call.content, call.raw_output)),
        }),
        wire::SessionUpdate::ToolCallUpdate(update) => Normalized::Tool(ToolUpdate {
            id: update.tool_call_id,
            title: update.title,
            tool: update.kind.as_deref().map(|kind| tool_kind(Some(kind))),
            status: update
                .status
                .as_deref()
                .map(|status| item_status(Some(status))),
            blocks: match (update.content, update.raw_output) {
                (None, None) => None,
                (content, raw_output) => Some(tool_blocks(content.unwrap_or_default(), raw_output)),
            },
        }),
        wire::SessionUpdate::Plan(plan) => Normalized::Plan(Plan {
            entries: plan
                .entries
                .into_iter()
                .map(|entry| PlanEntry {
                    content: entry.content,
                    priority: match entry.priority.as_str() {
                        "high" => PlanEntryPriority::High,
                        "low" => PlanEntryPriority::Low,
                        _ => PlanEntryPriority::Medium,
                    },
                    status: match entry.status.as_str() {
                        "in_progress" => PlanEntryStatus::InProgress,
                        "completed" => PlanEntryStatus::Completed,
                        _ => PlanEntryStatus::Pending,
                    },
                })
                .collect(),
        }),
        wire::SessionUpdate::CurrentModeUpdate { current_mode_id } => {
            Normalized::ModeChange(bounded(&current_mode_id, LABEL_LIMIT))
        }
        wire::SessionUpdate::ConfigOptionUpdate {} => Normalized::ConfigChange,
        wire::SessionUpdate::UsageUpdate { used, size } => Normalized::Usage { used, size },
        wire::SessionUpdate::AvailableCommandsUpdate {}
        | wire::SessionUpdate::SessionInfoUpdate {} => Normalized::None,
    }
}

fn message(role: MessageRole, chunk: wire::ContentChunk) -> Normalized {
    Normalized::Message {
        role,
        message_id: chunk.message_id,
        text: content_text(&chunk.content),
    }
}

fn tool_blocks(content: Vec<Value>, raw_output: Option<Value>) -> Vec<DetailBlock> {
    let mut blocks: Vec<DetailBlock> = content
        .iter()
        .filter_map(|content| match content.get("type")?.as_str()? {
            "content" => Some(DetailBlock::Text {
                text: content_text(content.get("content")?),
            }),
            "diff" => Some(DetailBlock::Diff {
                path: content.get("path")?.as_str()?.to_string(),
                old_text: content
                    .get("oldText")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                new_text: content.get("newText")?.as_str()?.to_string(),
            }),
            "terminal" => Some(DetailBlock::Terminal {
                terminal_id: content.get("terminalId")?.as_str()?.to_string(),
            }),
            _ => None,
        })
        .collect();
    if blocks.is_empty()
        && let Some(output) = raw_output
    {
        blocks.push(DetailBlock::Text {
            text: match output {
                Value::String(text) => text,
                other => other.to_string(),
            },
        });
    }
    blocks
}

/// Text of an ACP content block; non-text content is named, not inlined.
fn content_text(content: &Value) -> String {
    match content.get("type").and_then(Value::as_str) {
        Some("text") => content
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        Some("resource_link") => content
            .get("uri")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        Some(kind) => format!("[{}]", bounded(kind, LABEL_LIMIT)),
        None => "[content]".to_string(),
    }
}

fn tool_kind(kind: Option<&str>) -> ToolKind {
    match kind {
        Some("read") => ToolKind::Read,
        Some("edit") => ToolKind::Edit,
        Some("delete") => ToolKind::Delete,
        Some("move") => ToolKind::Move,
        Some("search") => ToolKind::Search,
        Some("execute") => ToolKind::Execute,
        Some("think") => ToolKind::Think,
        Some("fetch") => ToolKind::Fetch,
        Some("switch_mode") => ToolKind::SwitchMode,
        _ => ToolKind::Other,
    }
}

fn item_status(status: Option<&str>) -> ItemStatus {
    match status {
        Some("in_progress") => ItemStatus::InProgress,
        Some("completed") => ItemStatus::Completed,
        Some("failed") => ItemStatus::Failed,
        _ => ItemStatus::Pending,
    }
}

pub(crate) fn stop_reason(response: Value) -> Result<StopReason, String> {
    let response: wire::PromptResponse =
        serde_json::from_value(response).map_err(|error| error.to_string())?;
    Ok(match response.stop_reason.as_str() {
        "end_turn" => StopReason::EndTurn,
        "max_tokens" => StopReason::MaxTokens,
        "max_turn_requests" => StopReason::MaxTurnRequests,
        "refusal" => StopReason::Refusal,
        "cancelled" => StopReason::Cancelled,
        other => {
            return Err(format!(
                "unknown stop reason {}",
                bounded(other, LABEL_LIMIT)
            ));
        }
    })
}

/// A `session/request_permission` in Svode terms.
pub(crate) struct PermissionRequest {
    pub session_id: String,
    pub title: String,
    pub options: Vec<InteractionOption>,
}

pub(crate) fn permission_request(params: Value) -> Result<PermissionRequest, String> {
    let request: wire::RequestPermission =
        serde_json::from_value(params).map_err(|error| error.to_string())?;
    Ok(PermissionRequest {
        session_id: request.session_id,
        title: request
            .tool_call
            .title
            .unwrap_or(request.tool_call.tool_call_id),
        options: request
            .options
            .into_iter()
            .map(|option| InteractionOption {
                id: option.option_id,
                label: option.name,
                kind: match option.kind.as_str() {
                    "allow_once" => InteractionOptionKind::AllowOnce,
                    "allow_always" => InteractionOptionKind::AllowAlways,
                    "reject_once" => InteractionOptionKind::RejectOnce,
                    "reject_always" => InteractionOptionKind::RejectAlways,
                    _ => InteractionOptionKind::Other,
                },
            })
            .collect(),
    })
}

pub(crate) fn bounded(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn chunks_tools_and_plans_normalize_without_wire_types() {
        let (session, chunk) = session_update(json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "Hello" },
                "messageId": "m1"
            }
        }))
        .unwrap();
        assert_eq!(session, "s1");
        assert_eq!(
            chunk,
            Normalized::Message {
                role: MessageRole::Agent,
                message_id: Some("m1".into()),
                text: "Hello".into()
            }
        );

        let (_, tool) = session_update(json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "tool_call_update",
                "toolCallId": "t1",
                "status": "completed",
                "content": [{ "type": "diff", "path": "/a.md", "oldText": "a", "newText": "b" }]
            }
        }))
        .unwrap();
        assert_eq!(
            tool,
            Normalized::Tool(ToolUpdate {
                id: "t1".into(),
                title: None,
                tool: None,
                status: Some(ItemStatus::Completed),
                blocks: Some(vec![DetailBlock::Diff {
                    path: "/a.md".into(),
                    old_text: Some("a".into()),
                    new_text: "b".into()
                }])
            })
        );

        let (_, plan) = session_update(json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "plan",
                "entries": [{ "content": "Step", "priority": "high", "status": "in_progress" }]
            }
        }))
        .unwrap();
        assert!(matches!(plan, Normalized::Plan(plan) if plan.entries.len() == 1));
    }

    #[test]
    fn unknown_updates_become_bounded_generic_items() {
        let (_, update) = session_update(json!({
            "sessionId": "s1",
            "update": { "sessionUpdate": "x".repeat(500), "payload": "secret transcript" }
        }))
        .unwrap();
        let Normalized::Generic(label) = update else {
            panic!("expected a generic item");
        };
        assert_eq!(label.len(), LABEL_LIMIT);
        assert!(!label.contains("secret"));
    }

    #[test]
    fn bounded_text_respects_char_boundaries() {
        assert_eq!(bounded("привет", 3), "п");
        assert_eq!(bounded("ok", 10), "ok");
    }
}

//! ACP v1 wire messages → Svode activity changes. The only place that reads
//! ACP session updates; historical replay and live turns share it.

use serde_json::Value;

use super::wire;

use crate::activity::{
    ChoiceOption, DetailBlock, FieldInput, InteractionOption, InteractionOptionKind, ItemStatus,
    MessageSegment, PlanEntry, PlanEntryPriority, PlanEntryStatus, QuestionField, SessionSetting,
    SettingCategory, SettingOption, ToolKind,
};
use crate::status::StopReason;

/// Upper bound for labels taken from unknown agent payloads.
const LABEL_LIMIT: usize = 80;
/// A longer URI in a user message is not kept as a link.
pub(crate) const URI_LIMIT: usize = 4 * 1024;
/// Bounds of a pending interaction the runtime hands to consumers.
pub(crate) const TITLE_LIMIT: usize = 512;
const QUESTION_LIMIT: usize = 4 * 1024;
const MAX_FIELDS: usize = 64;
const MAX_CHOICES: usize = 256;
const MAX_SETTINGS: usize = 64;
const SETTING_NAME_LIMIT: usize = 256;
const SETTING_DESCRIPTION_LIMIT: usize = 1024;
/// Id of the one setting legacy session modes become.
pub(crate) const LEGACY_MODE_SETTING: &str = "mode";

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
        /// A user message chunk with a link or an image, as its segments in
        /// order; empty for plain text. `text` is how the summary reads it.
        segments: Vec<MessageSegment>,
    },
    Tool(ToolUpdate),
    /// The whole plan; it replaces the previous one.
    Plan(Vec<PlanEntry>),
    ModeChange(String),
    /// The full set of config options with their current values.
    ConfigChange(Vec<SessionSetting>),
    Usage {
        used: u64,
        size: u64,
    },
    /// The session title the agent reported.
    Title(String),
    /// A known update that carries no activity (commands, a session info
    /// update without a title).
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
        wire::SessionUpdate::ToolCallUpdate(update) => Normalized::Tool(tool_update(update)),
        wire::SessionUpdate::Plan(plan) => Normalized::Plan(
            plan.entries
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
        ),
        wire::SessionUpdate::CurrentModeUpdate { current_mode_id } => {
            Normalized::ModeChange(bounded(&current_mode_id, LABEL_LIMIT))
        }
        wire::SessionUpdate::ConfigOptionUpdate { config_options } => {
            Normalized::ConfigChange(config_settings(config_options))
        }
        wire::SessionUpdate::UsageUpdate { used, size } => Normalized::Usage { used, size },
        wire::SessionUpdate::SessionInfoUpdate { title: Some(title) }
            if !title.trim().is_empty() =>
        {
            Normalized::Title(bounded(title.trim(), TITLE_LIMIT))
        }
        wire::SessionUpdate::AvailableCommandsUpdate {}
        | wire::SessionUpdate::SessionInfoUpdate { .. } => Normalized::None,
    }
}

fn tool_update(update: wire::ToolCallUpdate) -> ToolUpdate {
    ToolUpdate {
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
    }
}

/// Settings a session declared, and whether they are legacy session modes,
/// which are changed by `session/set_mode` instead of a config option.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct DeclaredSettings {
    pub settings: Vec<SessionSetting>,
    pub legacy_modes: bool,
}

/// Config options win over legacy modes when an agent declares both.
pub(crate) fn declared_settings(declared: wire::DeclaredSettings) -> DeclaredSettings {
    if let Some(options) = declared.config_options {
        return DeclaredSettings {
            settings: config_settings(options),
            legacy_modes: false,
        };
    }
    let Some(modes) = declared.modes else {
        return DeclaredSettings::default();
    };
    let options = modes
        .available_modes
        .into_iter()
        .filter_map(|mode| serde_json::from_value::<wire::SessionMode>(mode).ok())
        .take(MAX_CHOICES)
        .map(|mode| setting_option(mode.id, mode.name, mode.description))
        .collect();
    DeclaredSettings {
        settings: vec![SessionSetting {
            id: LEGACY_MODE_SETTING.into(),
            name: "Mode".into(),
            description: None,
            category: SettingCategory::Mode,
            current_value: modes.current_mode_id,
            options,
        }],
        legacy_modes: true,
    }
}

/// Select options with a string value, in the agent's order; groups are
/// flattened, other option types are left to the agent's defaults.
pub(crate) fn config_settings(options: Vec<Value>) -> Vec<SessionSetting> {
    options
        .into_iter()
        .filter_map(|option| serde_json::from_value::<wire::ConfigOption>(option).ok())
        .filter(|option| option.option_type == "select")
        .filter_map(|option| {
            let current_value = option.current_value.as_str()?.to_string();
            Some(SessionSetting {
                id: option.id,
                name: bounded(&option.name, SETTING_NAME_LIMIT),
                description: option
                    .description
                    .map(|text| bounded(&text, SETTING_DESCRIPTION_LIMIT)),
                category: match option.category.as_deref() {
                    Some("mode") => SettingCategory::Mode,
                    Some("model") => SettingCategory::Model,
                    Some("thought_level") => SettingCategory::ThoughtLevel,
                    _ => SettingCategory::Other,
                },
                current_value,
                options: select_options(option.options),
            })
        })
        .take(MAX_SETTINGS)
        .collect()
}

fn select_options(entries: Vec<Value>) -> Vec<SettingOption> {
    let mut options = Vec::new();
    for entry in entries {
        match serde_json::from_value::<wire::ConfigSelectEntry>(entry) {
            Ok(wire::ConfigSelectEntry::Value {
                value,
                name,
                description,
            }) => options.push(setting_option(value, name, description)),
            Ok(wire::ConfigSelectEntry::Group { options: grouped }) => {
                options.extend(select_options(grouped))
            }
            Err(_) => {}
        }
    }
    options.truncate(MAX_CHOICES);
    options
}

fn setting_option(value: String, name: String, description: Option<String>) -> SettingOption {
    SettingOption {
        value,
        name: bounded(&name, SETTING_NAME_LIMIT),
        description: description.map(|text| bounded(&text, SETTING_DESCRIPTION_LIMIT)),
    }
}

fn message(role: MessageRole, chunk: wire::ContentChunk) -> Normalized {
    let (text, segments) = match role {
        MessageRole::User => user_content(&chunk.content),
        MessageRole::Agent | MessageRole::Reasoning => (content_text(&chunk.content), Vec::new()),
    };
    Normalized::Message {
        role,
        message_id: chunk.message_id,
        text,
        segments,
    }
}

/// A block of a user message: text, or a link or an image kept as a
/// segment. An embedded resource is kept as its link; image data is never
/// kept, also when an adapter inlines it into the text.
fn user_content(content: &Value) -> (String, Vec<MessageSegment>) {
    let field =
        |value: &Value, key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
    match content.get("type").and_then(Value::as_str) {
        Some("text") => {
            let text = content_text(content);
            let segments = inline_images(&text);
            let plain = segments
                .iter()
                .filter_map(|segment| match segment {
                    MessageSegment::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<String>();
            match segments.is_empty() {
                true => (text, segments),
                false => (plain, segments),
            }
        }
        Some("resource_link") => link(field(content, "uri"), field(content, "name")),
        Some("resource") => match content.get("resource") {
            Some(resource) => link(field(resource, "uri"), None),
            None => (content_text(content), Vec::new()),
        },
        Some("image") => (
            String::new(),
            vec![MessageSegment::Image {
                uri: field(content, "uri")
                    .filter(|uri| uri.len() <= URI_LIMIT && !uri.starts_with("data:")),
                name: None,
            }],
        ),
        _ => (content_text(content), Vec::new()),
    }
}

/// The segments of a user message text in which an adapter inlined images
/// as `[@name](data:…)` links (Codex replays them so): text around them and
/// an image segment for each, without its data. Empty when there is none.
fn inline_images(text: &str) -> Vec<MessageSegment> {
    let mut segments = Vec::new();
    let mut pending = String::new();
    let mut rest = text;
    while let Some(start) = rest.find("[@") {
        let tail = &rest[start + 2..];
        let image = tail
            .find(']')
            .filter(|end| !tail[..*end].contains('\n') && tail[end + 1..].starts_with("(data:"))
            .and_then(|end| {
                tail[end + 1..]
                    .find(')')
                    .map(|close| (end, end + 1 + close))
            });
        let Some((name_end, close)) = image else {
            pending.push_str(&rest[..start + 2]);
            rest = tail;
            continue;
        };
        pending.push_str(&rest[..start]);
        if !pending.is_empty() {
            segments.push(MessageSegment::Text {
                text: std::mem::take(&mut pending),
            });
        }
        segments.push(MessageSegment::Image {
            uri: None,
            name: Some(bounded(&tail[..name_end], LABEL_LIMIT)),
        });
        rest = &tail[close + 1..];
    }
    if segments.is_empty() {
        return segments;
    }
    pending.push_str(rest);
    if !pending.is_empty() {
        segments.push(MessageSegment::Text { text: pending });
    }
    segments
}

/// A link segment named `@name`; without a name the last part of the URI
/// names it.
fn link(uri: Option<String>, name: Option<String>) -> (String, Vec<MessageSegment>) {
    let Some(uri) = uri.filter(|uri| !uri.is_empty() && uri.len() <= URI_LIMIT) else {
        return ("[resource_link]".to_string(), Vec::new());
    };
    let name = bounded(
        &name.unwrap_or_else(|| {
            uri.trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or(&uri)
                .to_string()
        }),
        LABEL_LIMIT,
    );
    (format!("@{name}"), vec![MessageSegment::Link { uri, name }])
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

/// A `session/request_permission` in Svode terms: the request and the
/// update its tool call fields make to the timeline item of that call.
pub(crate) struct PermissionRequest {
    pub session_id: String,
    pub title: String,
    pub tool_call: ToolUpdate,
    pub options: Vec<InteractionOption>,
}

pub(crate) fn permission_request(params: &str) -> Result<PermissionRequest, String> {
    let request: wire::RequestPermission =
        serde_json::from_str(params).map_err(|error| error.to_string())?;
    let tool_call = tool_update(request.tool_call);
    Ok(PermissionRequest {
        session_id: request.session_id,
        title: bounded(
            tool_call.title.as_deref().unwrap_or(&tool_call.id),
            TITLE_LIMIT,
        ),
        tool_call,
        options: request
            .options
            .into_iter()
            .map(|option| InteractionOption {
                id: option.option_id,
                label: bounded(&option.name, TITLE_LIMIT),
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

/// An `elicitation/create` form in Svode terms.
#[derive(Debug)]
pub(crate) struct QuestionRequest {
    pub session_id: String,
    pub title: String,
    pub fields: Vec<QuestionField>,
}

/// An elicitation the model does not express; the runtime answers it
/// `cancel` and names the reason in the session when it knows the session.
#[derive(Debug)]
pub(crate) struct UnsupportedQuestion {
    pub session_id: Option<String>,
    pub reason: String,
}

pub(crate) fn question_request(params: &str) -> Result<QuestionRequest, UnsupportedQuestion> {
    let request: wire::CreateElicitation =
        serde_json::from_str(params).map_err(|_| UnsupportedQuestion {
            session_id: None,
            reason: "malformed question".into(),
        })?;
    let unsupported = |reason: String| UnsupportedQuestion {
        session_id: request.session_id.clone(),
        reason: bounded(&reason, LABEL_LIMIT),
    };
    let Some(session_id) = request.session_id.clone() else {
        return Err(unsupported("question outside a session".into()));
    };
    if request.mode != "form" {
        return Err(unsupported(format!("{} question", request.mode)));
    }
    let schema = request
        .requested_schema
        .ok_or_else(|| unsupported("question without a form".into()))?;
    if schema.properties.len() > MAX_FIELDS {
        return Err(unsupported("question with too many fields".into()));
    }
    let required = schema.required.unwrap_or_default();
    let fields = schema
        .properties
        .into_iter()
        .map(|(id, property)| {
            let required = required.contains(&id);
            question_field(id, required, property)
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(unsupported)?;
    Ok(QuestionRequest {
        session_id,
        title: bounded(&request.message, QUESTION_LIMIT),
        fields,
    })
}

fn question_field(id: String, required: bool, property: Value) -> Result<QuestionField, String> {
    let kind = property
        .get("type")
        .and_then(Value::as_str)
        .map(|kind| bounded(kind, LABEL_LIMIT))
        .unwrap_or_default();
    let property: wire::ElicitationProperty =
        serde_json::from_value(property).map_err(|_| format!("question field of type {kind}"))?;
    let (title, description, input) = match property {
        wire::ElicitationProperty::String(text) => {
            let options = match (text.one_of, text.values) {
                (Some(options), _) => Some(choices(options)?),
                (None, Some(values)) => Some(plain_choices(values)?),
                (None, None) => None,
            };
            let input = match options {
                Some(options) => FieldInput::SingleChoice {
                    options,
                    default: text.default,
                },
                None => FieldInput::Text {
                    default: text.default,
                    min_length: text.min_length,
                    max_length: text.max_length,
                    format: text.format,
                    pattern: text.pattern,
                },
            };
            (text.title, text.description, input)
        }
        wire::ElicitationProperty::Number(number) => (
            number.title,
            number.description,
            FieldInput::Number {
                default: number.default,
                minimum: number.minimum,
                maximum: number.maximum,
            },
        ),
        wire::ElicitationProperty::Integer(number) => (
            number.title,
            number.description,
            FieldInput::Integer {
                default: number.default,
                minimum: number.minimum,
                maximum: number.maximum,
            },
        ),
        wire::ElicitationProperty::Boolean(flag) => (
            flag.title,
            flag.description,
            FieldInput::Boolean {
                default: flag.default,
            },
        ),
        wire::ElicitationProperty::Array(select) => {
            let options = match (select.items.any_of, select.items.values) {
                (Some(options), _) => choices(options)?,
                (None, Some(values)) if select.items.item_type.as_deref() == Some("string") => {
                    plain_choices(values)?
                }
                _ => return Err("question field with unknown choices".into()),
            };
            (
                select.title,
                select.description,
                FieldInput::MultipleChoice {
                    options,
                    default: select.default,
                    min_items: select.min_items,
                    max_items: select.max_items,
                },
            )
        }
    };
    Ok(QuestionField {
        title: bounded(title.as_deref().unwrap_or(&id), TITLE_LIMIT),
        description: description.map(|text| bounded(&text, QUESTION_LIMIT)),
        id,
        required,
        input,
    })
}

fn choices(options: Vec<wire::EnumOption>) -> Result<Vec<ChoiceOption>, String> {
    if options.len() > MAX_CHOICES {
        return Err("question field with too many choices".into());
    }
    Ok(options
        .into_iter()
        .map(|option| ChoiceOption {
            label: bounded(&option.title, TITLE_LIMIT),
            description: option.description.map(|text| bounded(&text, TITLE_LIMIT)),
            id: option.value,
        })
        .collect())
}

fn plain_choices(values: Vec<String>) -> Result<Vec<ChoiceOption>, String> {
    if values.len() > MAX_CHOICES {
        return Err("question field with too many choices".into());
    }
    Ok(values
        .into_iter()
        .map(|value| ChoiceOption {
            label: bounded(&value, TITLE_LIMIT),
            description: None,
            id: value,
        })
        .collect())
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
    fn links_and_images_of_a_user_message_become_segments() {
        let user = |content: Value| match session_update(json!({
            "sessionId": "s1",
            "update": { "sessionUpdate": "user_message_chunk", "content": content }
        })) {
            Some((_, Normalized::Message { text, segments, .. })) => (text, segments),
            other => panic!("unexpected {other:?}"),
        };
        assert_eq!(
            user(json!({ "type": "resource_link", "uri": "file:///p/a.md", "name": "a.md" })),
            (
                "@a.md".into(),
                vec![MessageSegment::Link {
                    uri: "file:///p/a.md".into(),
                    name: "a.md".into()
                }]
            )
        );
        assert_eq!(
            user(
                json!({ "type": "resource", "resource": { "uri": "file:///p/b.txt", "text": "body" } })
            ),
            (
                "@b.txt".into(),
                vec![MessageSegment::Link {
                    uri: "file:///p/b.txt".into(),
                    name: "b.txt".into()
                }]
            )
        );
        assert_eq!(
            user(json!({ "type": "image", "mimeType": "image/png", "data": "iVBORw==" })),
            (
                String::new(),
                vec![MessageSegment::Image {
                    uri: None,
                    name: None
                }]
            )
        );
        assert_eq!(
            user(json!({ "type": "text", "text": "[@a.md](file:///p/a.md)" })),
            ("[@a.md](file:///p/a.md)".into(), Vec::new())
        );
        assert_eq!(
            user(
                json!({ "type": "text", "text": "See [@a.md](file:///a.md)[@image](data:image/png;base64,iVBO) then [@x] (data:y)" })
            ),
            (
                "See [@a.md](file:///a.md) then [@x] (data:y)".into(),
                vec![
                    MessageSegment::Text {
                        text: "See [@a.md](file:///a.md)".into()
                    },
                    MessageSegment::Image {
                        uri: None,
                        name: Some("image".into())
                    },
                    MessageSegment::Text {
                        text: " then [@x] (data:y)".into()
                    },
                ]
            ),
            "Codex inlines the image data into the replayed text; it is not kept"
        );
    }

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
                text: "Hello".into(),
                segments: Vec::new()
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
        assert!(matches!(plan, Normalized::Plan(entries) if entries.len() == 1));
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

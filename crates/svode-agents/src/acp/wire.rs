//! The ACP v1 wire shapes the client reads. Private and lenient: a field
//! the client does not use is ignored, an unknown enum value maps to the
//! generic case instead of failing the whole message.

use serde::Deserialize;
use serde_json::Value;

pub(crate) const PROTOCOL_VERSION: u64 = 1;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InitializeResponse {
    pub protocol_version: u64,
    #[serde(default)]
    pub agent_capabilities: AgentCapabilities,
    pub agent_info: Option<Implementation>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentCapabilities {
    #[serde(default)]
    pub load_session: bool,
    #[serde(default)]
    pub session_capabilities: SessionCapabilities,
}

#[derive(Default, Deserialize)]
pub(crate) struct SessionCapabilities {
    pub list: Option<Value>,
    pub resume: Option<Value>,
    pub close: Option<Value>,
}

#[derive(Deserialize)]
pub(crate) struct Implementation {
    pub name: String,
    pub version: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewSessionResponse {
    pub session_id: String,
}

/// Entries are read one by one, so one malformed entry does not fail the
/// page.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListSessionsResponse {
    #[serde(default)]
    pub sessions: Vec<Value>,
    pub next_cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionInfo {
    pub session_id: String,
    pub cwd: String,
    pub title: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PromptResponse {
    pub stop_reason: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionNotification {
    pub update: SessionUpdate,
}

#[derive(Deserialize)]
#[serde(tag = "sessionUpdate", rename_all = "snake_case")]
pub(crate) enum SessionUpdate {
    UserMessageChunk(ContentChunk),
    AgentMessageChunk(ContentChunk),
    AgentThoughtChunk(ContentChunk),
    ToolCall(ToolCall),
    ToolCallUpdate(ToolCallUpdate),
    Plan(Plan),
    AvailableCommandsUpdate {},
    CurrentModeUpdate {
        #[serde(rename = "currentModeId")]
        current_mode_id: String,
    },
    ConfigOptionUpdate {},
    SessionInfoUpdate {},
    UsageUpdate {
        used: u64,
        size: u64,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContentChunk {
    pub content: Value,
    #[serde(default)]
    pub message_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolCall {
    pub tool_call_id: String,
    #[serde(default)]
    pub title: String,
    pub kind: Option<String>,
    pub status: Option<String>,
    #[serde(default)]
    pub content: Vec<Value>,
    pub raw_output: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolCallUpdate {
    pub tool_call_id: String,
    pub title: Option<String>,
    pub kind: Option<String>,
    pub status: Option<String>,
    pub content: Option<Vec<Value>>,
    pub raw_output: Option<Value>,
}

#[derive(Deserialize)]
pub(crate) struct Plan {
    #[serde(default)]
    pub entries: Vec<PlanEntry>,
}

#[derive(Deserialize)]
pub(crate) struct PlanEntry {
    pub content: String,
    #[serde(default)]
    pub priority: String,
    #[serde(default)]
    pub status: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RequestPermission {
    pub session_id: String,
    pub tool_call: PermissionToolCall,
    #[serde(default)]
    pub options: Vec<PermissionOption>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PermissionToolCall {
    pub tool_call_id: String,
    pub title: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PermissionOption {
    pub option_id: String,
    pub name: String,
    #[serde(default)]
    pub kind: String,
}

/// `elicitation/create`; a request-scoped one has no `sessionId`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateElicitation {
    pub session_id: Option<String>,
    pub mode: String,
    #[serde(default)]
    pub message: String,
    pub requested_schema: Option<ElicitationSchema>,
}

#[derive(Deserialize)]
pub(crate) struct ElicitationSchema {
    /// Raw values in the agent's order: one unsupported property type
    /// rejects the form, it does not fail the message.
    #[serde(default, deserialize_with = "ordered_properties")]
    pub properties: Vec<(String, Value)>,
    #[serde(default)]
    pub required: Option<Vec<String>>,
}

/// A JSON object as its entries in document order; `serde_json::Map`
/// sorts keys without `preserve_order`, which would reorder questions.
fn ordered_properties<'de, D>(deserializer: D) -> Result<Vec<(String, Value)>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct Entries;

    impl<'de> serde::de::Visitor<'de> for Entries {
        type Value = Vec<(String, Value)>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("an object of property schemas")
        }

        fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
        where
            A: serde::de::MapAccess<'de>,
        {
            let mut entries = Vec::new();
            while let Some(entry) = map.next_entry()? {
                entries.push(entry);
            }
            Ok(entries)
        }
    }

    deserializer.deserialize_map(Entries)
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum ElicitationProperty {
    String(StringProperty),
    Number(NumberProperty<f64>),
    Integer(NumberProperty<i64>),
    Boolean(BooleanProperty),
    Array(MultiSelectProperty),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StringProperty {
    pub title: Option<String>,
    pub description: Option<String>,
    pub min_length: Option<u32>,
    pub max_length: Option<u32>,
    pub pattern: Option<String>,
    pub format: Option<String>,
    pub default: Option<String>,
    #[serde(rename = "enum")]
    pub values: Option<Vec<String>>,
    pub one_of: Option<Vec<EnumOption>>,
}

#[derive(Deserialize)]
pub(crate) struct NumberProperty<T> {
    pub title: Option<String>,
    pub description: Option<String>,
    pub minimum: Option<T>,
    pub maximum: Option<T>,
    pub default: Option<T>,
}

#[derive(Deserialize)]
pub(crate) struct BooleanProperty {
    pub title: Option<String>,
    pub description: Option<String>,
    pub default: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MultiSelectProperty {
    pub title: Option<String>,
    pub description: Option<String>,
    pub min_items: Option<u64>,
    pub max_items: Option<u64>,
    pub items: MultiSelectItems,
    #[serde(default)]
    pub default: Vec<String>,
}

/// Untitled `{ type: "string", enum }` or titled `{ anyOf }` items.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MultiSelectItems {
    #[serde(rename = "type")]
    pub item_type: Option<String>,
    #[serde(rename = "enum")]
    pub values: Option<Vec<String>>,
    pub any_of: Option<Vec<EnumOption>>,
}

#[derive(Deserialize)]
pub(crate) struct EnumOption {
    #[serde(rename = "const")]
    pub value: String,
    pub title: String,
    pub description: Option<String>,
}

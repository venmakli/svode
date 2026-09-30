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

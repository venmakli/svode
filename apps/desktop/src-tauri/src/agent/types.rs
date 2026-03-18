use serde::{Deserialize, Serialize};

/// Configuration for agent execution, extracted from workspace config.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    /// Maximum number of turns (passed as --max-turns to CLI)
    #[serde(default)]
    pub max_turns: Option<u32>,

    /// System prompt override
    #[serde(default)]
    pub system_prompt: Option<String>,

    /// Allowed tools list
    #[serde(default)]
    pub allowed_tools: Option<Vec<String>>,
}

/// Normalized agent event emitted to the frontend via Tauri events.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AgentEvent {
    TextDelta {
        session_id: String,
        delta: String,
    },
    ToolCall {
        session_id: String,
        name: String,
        args: serde_json::Value,
        id: String,
    },
    ToolInputDelta {
        session_id: String,
        id: String,
        delta: String,
    },
    ToolResult {
        session_id: String,
        id: String,
        result: serde_json::Value,
    },
    Reasoning {
        session_id: String,
        text: String,
    },
    Error {
        session_id: String,
        message: String,
    },
    Done {
        session_id: String,
        message_id: String,
    },
}

impl AgentEvent {
    /// Return the Tauri event name for this event.
    pub fn event_name(&self) -> &'static str {
        match self {
            AgentEvent::TextDelta { .. } => "agent:text-delta",
            AgentEvent::ToolCall { .. } => "agent:tool-call",
            AgentEvent::ToolInputDelta { .. } => "agent:tool-input-delta",
            AgentEvent::ToolResult { .. } => "agent:tool-result",
            AgentEvent::Reasoning { .. } => "agent:reasoning",
            AgentEvent::Error { .. } => "agent:error",
            AgentEvent::Done { .. } => "agent:done",
        }
    }
}

/// Info about an available agent CLI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableAgent {
    pub name: String,
    pub path: String,
}

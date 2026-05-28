use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Configuration for agent execution, extracted from space config.
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

    /// Maximum timeout in seconds for agent execution (default: 600 = 10 min)
    #[serde(default)]
    pub max_timeout: Option<u64>,

    /// Model name override (passed as --model to CLI, e.g. "claude-sonnet-4-5")
    #[serde(default)]
    pub model: Option<String>,
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
    PermissionRequest {
        session_id: String,
        request_id: String,
        tool_name: String,
        input: serde_json::Value,
        tool_use_id: String,
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
            AgentEvent::PermissionRequest { .. } => "agent:permission-request",
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
    pub version: Option<String>,
    pub auth_status: String,
    pub docs_url: String,
}

/// A model option available for an agent CLI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    /// Short alias used with --model flag (e.g. "sonnet", "opus")
    pub id: String,
    /// Display name (e.g. "Claude Sonnet 4")
    pub name: String,
    /// Brief description
    pub description: String,
}

/// Agent-related settings loaded from space `.svode/` config files.
#[derive(Debug, Clone, Default)]
pub struct SpaceAgentConfig {
    /// List of allowed CLI names (e.g. ["claude"])
    pub clis: Vec<String>,
    /// Map of CLI name -> custom binary path
    pub cli_paths: HashMap<String, PathBuf>,
}

/// Load space agent config from `.svode/config.json` and `.svode/local.json`.
///
/// Best-effort: missing files or fields silently fall back to defaults.
pub fn load_space_agent_config(space_dir: &std::path::Path) -> SpaceAgentConfig {
    let mut result = SpaceAgentConfig::default();

    // Read .svode/config.json → agent.clis
    let config_path = space_dir.join(".svode/config.json");
    if let Ok(data) = std::fs::read_to_string(&config_path) {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&data) {
            if let Some(clis) = parsed
                .get("agent")
                .and_then(|a| a.get("clis"))
                .and_then(|c| c.as_array())
            {
                result.clis = clis
                    .iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect();
            }
        }
    }

    // Read .svode/local.json → agent.cliPaths
    let local_path = space_dir.join(".svode/local.json");
    if let Ok(data) = std::fs::read_to_string(&local_path) {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&data) {
            if let Some(paths) = parsed
                .get("agent")
                .and_then(|a| a.get("cliPaths"))
                .and_then(|p| p.as_object())
            {
                for (key, val) in paths {
                    if let Some(s) = val.as_str() {
                        result.cli_paths.insert(key.clone(), PathBuf::from(s));
                    }
                }
            }
        }
    }

    result
}

//! ACP v1 client. The one implementation of the Svode adapter contract so
//! far; wire shapes do not leave this module.

pub(crate) mod normalize;
pub(crate) mod rpc;
mod wire;

use std::path::Path;

use serde_json::{Value, json};

use crate::interaction::{FieldValue, InteractionAnswer};
use crate::runtime::{AgentCapabilities, AgentInfo};
use crate::status::InteractionKind;

pub(crate) const INITIALIZE: &str = "initialize";
pub(crate) const SESSION_NEW: &str = "session/new";
pub(crate) const SESSION_PROMPT: &str = "session/prompt";
pub(crate) const SESSION_CANCEL: &str = "session/cancel";
pub(crate) const SESSION_CLOSE: &str = "session/close";
pub(crate) const SESSION_UPDATE: &str = "session/update";
pub(crate) const SESSION_REQUEST_PERMISSION: &str = "session/request_permission";
pub(crate) const ELICITATION_CREATE: &str = "elicitation/create";

/// Svode advertises no client file system or terminal: the agent works with
/// its own tools. It asks the user form questions, never opens agent URLs.
pub(crate) fn initialize_request() -> Value {
    json!({
        "protocolVersion": wire::PROTOCOL_VERSION,
        "clientCapabilities": {
            "fs": { "readTextFile": false, "writeTextFile": false },
            "terminal": false,
            "elicitation": { "form": {} }
        },
        "clientInfo": { "name": "svode", "title": "Svode", "version": env!("CARGO_PKG_VERSION") }
    })
}

pub(crate) fn agent_info(response: Value) -> Result<AgentInfo, String> {
    let response: wire::InitializeResponse =
        serde_json::from_value(response).map_err(|error| error.to_string())?;
    if response.protocol_version != wire::PROTOCOL_VERSION {
        return Err(format!(
            "agent speaks ACP version {}, Svode speaks {}",
            response.protocol_version,
            wire::PROTOCOL_VERSION
        ));
    }
    let capabilities = response.agent_capabilities;
    let (name, version) = match response.agent_info {
        Some(info) => (Some(info.name), Some(info.version)),
        None => (None, None),
    };
    Ok(AgentInfo {
        name,
        version,
        capabilities: AgentCapabilities {
            load_session: capabilities.load_session,
            list_sessions: capabilities.session_capabilities.list.is_some(),
            resume_session: capabilities.session_capabilities.resume.is_some(),
            close_session: capabilities.session_capabilities.close.is_some(),
        },
    })
}

pub(crate) fn new_session_request(cwd: &Path) -> Value {
    json!({ "cwd": cwd, "mcpServers": [] })
}

pub(crate) fn new_session_id(response: Value) -> Result<String, String> {
    let response: wire::NewSessionResponse =
        serde_json::from_value(response).map_err(|error| error.to_string())?;
    Ok(response.session_id)
}

pub(crate) fn prompt_request(session_id: &str, text: &str) -> Value {
    json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": text }] })
}

pub(crate) fn cancel_notification(session_id: &str) -> Value {
    json!({ "sessionId": session_id })
}

pub(crate) fn close_request(session_id: &str) -> Value {
    json!({ "sessionId": session_id })
}

pub(crate) fn permission_cancelled() -> Value {
    json!({ "outcome": { "outcome": "cancelled" } })
}

pub(crate) fn question_cancelled() -> Value {
    json!({ "action": "cancel" })
}

/// The `cancel` answer to a pending request of this kind.
pub(crate) fn cancelled(kind: InteractionKind) -> Value {
    match kind {
        InteractionKind::Permission => permission_cancelled(),
        InteractionKind::Question => question_cancelled(),
    }
}

/// The agent's answer for a validated user answer.
pub(crate) fn answer(answer: &InteractionAnswer) -> Value {
    match answer {
        InteractionAnswer::Option { option_id } => {
            json!({ "outcome": { "outcome": "selected", "optionId": option_id } })
        }
        InteractionAnswer::Form { values } => {
            let content: serde_json::Map<String, Value> = values
                .iter()
                .map(|(id, value)| {
                    let value = match value {
                        FieldValue::Boolean(flag) => json!(flag),
                        FieldValue::Integer(number) => json!(number),
                        FieldValue::Number(number) => json!(number),
                        FieldValue::Text(text) => json!(text),
                        FieldValue::Choices(choices) => json!(choices),
                    };
                    (id.clone(), value)
                })
                .collect();
            json!({ "action": "accept", "content": content })
        }
        InteractionAnswer::Decline => json!({ "action": "decline" }),
    }
}

//! ACP v1 client. The one implementation of the Svode adapter contract so
//! far; wire shapes do not leave this module.

pub(crate) mod normalize;
pub(crate) mod rpc;
mod wire;

use std::path::Path;

use serde_json::{Value, json};

use crate::runtime::{AgentCapabilities, AgentInfo};

pub(crate) const INITIALIZE: &str = "initialize";
pub(crate) const SESSION_NEW: &str = "session/new";
pub(crate) const SESSION_PROMPT: &str = "session/prompt";
pub(crate) const SESSION_CANCEL: &str = "session/cancel";
pub(crate) const SESSION_UPDATE: &str = "session/update";
pub(crate) const SESSION_REQUEST_PERMISSION: &str = "session/request_permission";

/// Svode advertises no client file system or terminal: the agent works with
/// its own tools.
pub(crate) fn initialize_request() -> Value {
    json!({
        "protocolVersion": wire::PROTOCOL_VERSION,
        "clientCapabilities": {
            "fs": { "readTextFile": false, "writeTextFile": false },
            "terminal": false
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

pub(crate) fn permission_cancelled() -> Value {
    json!({ "outcome": { "outcome": "cancelled" } })
}

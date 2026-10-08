//! ACP v1 client. The one implementation of the Svode adapter contract so
//! far; wire shapes do not leave this module.

pub(crate) mod mcp;
pub(crate) mod media;
pub(crate) mod normalize;
pub(crate) mod rpc;
mod wire;

use std::path::Path;

use serde_json::{Value, json};

use crate::activity::SessionSetting;
use crate::catalog::{ListEntry, ListPage};
use crate::interaction::{FieldValue, InteractionAnswer};
use crate::prompt::PromptBlock;
use crate::runtime::{AgentCapabilities, AgentInfo};
use crate::status::InteractionKind;
use normalize::DeclaredSettings;

pub(crate) const INITIALIZE: &str = "initialize";
pub(crate) const SESSION_NEW: &str = "session/new";
pub(crate) const SESSION_LOAD: &str = "session/load";
pub(crate) const SESSION_RESUME: &str = "session/resume";
pub(crate) const SESSION_PROMPT: &str = "session/prompt";
pub(crate) const SESSION_CANCEL: &str = "session/cancel";
pub(crate) const SESSION_CLOSE: &str = "session/close";
pub(crate) const SESSION_LIST: &str = "session/list";
pub(crate) const SESSION_SET_CONFIG_OPTION: &str = "session/set_config_option";
pub(crate) const SESSION_SET_MODE: &str = "session/set_mode";
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
            image_prompt: capabilities.prompt_capabilities.image,
        },
    })
}

pub(crate) fn new_session_request(cwd: &Path) -> Value {
    json!({ "cwd": cwd, "mcpServers": [] })
}

/// Params of `session/load` and `session/resume`: both attach an existing
/// session in `cwd`; only load replays its history.
pub(crate) fn open_session_request(session_id: &str, cwd: &Path) -> Value {
    json!({ "sessionId": session_id, "cwd": cwd, "mcpServers": [] })
}

/// The new session's id and the settings it declares.
pub(crate) fn new_session(response: Value) -> Result<(String, DeclaredSettings), String> {
    let response: wire::NewSessionResponse =
        serde_json::from_value(response).map_err(|error| error.to_string())?;
    Ok((
        response.session_id,
        normalize::declared_settings(response.settings),
    ))
}

/// Settings an opened session declares; `None` when the answer declares
/// none, so settings the replay reported stay.
pub(crate) fn opened_session_settings(response: Value) -> Option<DeclaredSettings> {
    serde_json::from_value::<wire::DeclaredSettings>(response)
        .ok()
        .filter(|declared| declared.config_options.is_some() || declared.modes.is_some())
        .map(normalize::declared_settings)
}

pub(crate) fn set_config_option_request(session_id: &str, setting: &str, value: &str) -> Value {
    json!({ "sessionId": session_id, "configId": setting, "value": value })
}

/// The full set of config options the agent answers a change with.
pub(crate) fn set_config_option_settings(response: Value) -> Result<Vec<SessionSetting>, String> {
    let response: wire::SetConfigOptionResponse =
        serde_json::from_value(response).map_err(|error| error.to_string())?;
    Ok(normalize::config_settings(response.config_options))
}

pub(crate) fn set_mode_request(session_id: &str, mode: &str) -> Value {
    json!({ "sessionId": session_id, "modeId": mode })
}

/// Params of one `session/list` page. The `cwd` filter only for an agent
/// whose list covers one directory per request; otherwise its semantics per
/// agent are unconfirmed, so the host's scope resolver decides.
pub(crate) fn list_request(cursor: Option<&str>, cwd: Option<&Path>) -> Value {
    let mut params = json!({});
    if let Some(cursor) = cursor {
        params["cursor"] = json!(cursor);
    }
    if let Some(cwd) = cwd {
        params["cwd"] = json!(cwd);
    }
    params
}

pub(crate) fn list_page(response: Value) -> Result<ListPage, String> {
    let response: wire::ListSessionsResponse =
        serde_json::from_value(response).map_err(|error| error.to_string())?;
    let mut malformed = 0;
    let entries = response
        .sessions
        .into_iter()
        .filter_map(
            |entry| match serde_json::from_value::<wire::SessionInfo>(entry) {
                Ok(info) => Some(ListEntry {
                    session_id: info.session_id,
                    cwd: info.cwd,
                    title: info.title,
                    updated_at: info.updated_at,
                }),
                Err(_) => {
                    malformed += 1;
                    None
                }
            },
        )
        .collect();
    Ok(ListPage {
        entries,
        malformed,
        next_cursor: response.next_cursor,
    })
}

pub(crate) fn prompt_request(session_id: &str, blocks: &[PromptBlock]) -> Value {
    let prompt: Vec<Value> = blocks
        .iter()
        .map(|block| match block {
            PromptBlock::Text(text) => json!({ "type": "text", "text": text }),
            PromptBlock::Link {
                uri,
                name,
                mime_type,
            } => match mime_type {
                Some(mime_type) => {
                    json!({ "type": "resource_link", "uri": uri, "name": name, "mimeType": mime_type })
                }
                None => json!({ "type": "resource_link", "uri": uri, "name": name }),
            },
            PromptBlock::Image {
                uri,
                mime_type,
                data,
            } => json!({ "type": "image", "mimeType": mime_type, "data": data, "uri": uri }),
        })
        .collect();
    json!({ "sessionId": session_id, "prompt": prompt })
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

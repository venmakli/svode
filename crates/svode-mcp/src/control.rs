//! Public MCP control plane: protocol version, instructions, the catalog a
//! host publishes and routing of bridge methods.

use serde_json::{Value, json};
use svode_tools::dispatch::{check_tool, served_definitions};
use svode_tools::error::ToolError;
use svode_tools::host::ToolHost;

use crate::protocol::IpcResponse;

pub const MCP_PROTOCOL_VERSION: &str = "2025-06-18";

const MCP_INSTRUCTIONS: &str = "Use Svode MCP as a product API for metadata, fields, structure, schema, imports and Routines. With file access, edit Page bodies below the frontmatter with your own tools; body write tools serve clients without file access and require the sourceVersion of your last read. Discover explicit Routine owners with list_spaces/list_collections and read fingerprints with list_routines/get_routine. Use managed create_routine/update_routine/delete_routine for definitions and run_routine, served only through the running Svode desktop app, only for an explicit manual/schedule launch. Routine actions do not autocommit; enabled schedule/event writes require confirmAutomaticExecution=true without changing device authority, and Routine-launched agents cannot recurse. Create Collections for structured repeated data and Pages for narrative knowledge. Use owner README and Collection item tools for those contexts. Import new local binary files with import_asset and continue with its returned canonical contentPath after any managed Page conversion. For Apps, call get_svode_guide, validate the full app.yaml candidate with validate_app_manifest before writing and after edits, and put credentials behind Settings Variables references. Call get_svode_guide when unsure.";

pub fn initialize(host_version: &str) -> Value {
    json!({
        "protocolVersion": MCP_PROTOCOL_VERSION,
        "serverInfo": { "name": "svode", "version": host_version },
        "capabilities": { "tools": {} },
        "instructions": MCP_INSTRUCTIONS,
    })
}

/// Catalog limited to the tools the host declares.
pub fn tools_list(host: &impl ToolHost) -> Value {
    json!({ "tools": served_definitions(host) })
}

/// Result of routing one private bridge method.
pub enum BridgeCall {
    /// Complete response of a control method or protocol error.
    Respond(IpcResponse),
    /// A catalog tool the host must execute within its request context.
    CallTool { name: String, args: Value },
}

pub fn bridge_request(host: &impl ToolHost, method: &str, params: &Value) -> BridgeCall {
    let result = match method {
        "initialize" => Ok(initialize(host.version())),
        "tools/list" => Ok(tools_list(host)),
        "ping" => Ok(json!({ "ok": true })),
        "tools/call" => {
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return protocol_error(ToolError::new(
                    "INVALID_REQUEST",
                    "tools/call requires name",
                ));
            };
            if let Err(error) = check_tool(host, name) {
                return protocol_error(error);
            }
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            return BridgeCall::CallTool {
                name: name.to_string(),
                args,
            };
        }
        _ => Err(ToolError::new(
            "UNKNOWN_METHOD",
            "unknown desktop IPC method",
        )),
    };
    match result {
        Ok(result) => BridgeCall::Respond(IpcResponse {
            result: Some(result),
            tool_result: None,
            error: None,
        }),
        Err(error) => protocol_error(error),
    }
}

fn protocol_error(error: ToolError) -> BridgeCall {
    BridgeCall::Respond(IpcResponse {
        result: None,
        tool_result: None,
        error: Some(error),
    })
}

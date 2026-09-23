//! `svode-mcp --project`: one MCP stdio session served in-process on the
//! shared standalone host, without the desktop app.

use std::path::Path;

use serde_json::Value;
use svode_tools::dispatch::call_tool;
use svode_tools::error::ToolError;
use svode_tools::host::{RequestTarget, ToolHost};
use svode_tools::standalone::StandaloneHost;
use svode_tools::target::{resolve_default_space, resolve_project};

use crate::control::{BridgeCall, bridge_request};
use crate::protocol::IpcResponse;
use crate::{MCP_VERSION, stdio};

/// Freezes the target before the first request, serves the session and
/// closes every session-owned resource when it ends.
pub(crate) async fn run(project: &str, space: Option<&str>) -> Result<(), ToolError> {
    let cwd = std::env::current_dir()?;
    let project = resolve_project(&cwd.join(project))?;
    let space = resolve_default_space(project, space, &cwd)?;
    let target = RequestTarget::for_space(&space);
    let host = StandaloneHost::new(MCP_VERSION);
    host.open_project(Path::new(&target.project_path)).await?;
    let (host_ref, target_ref) = (&host, &target);
    let served =
        stdio::serve(move |method, params| request(host_ref, target_ref, method, params)).await;
    host.close().await;
    served
}

async fn request(
    host: &StandaloneHost,
    target: &RequestTarget,
    method: String,
    params: Value,
) -> Result<IpcResponse, ToolError> {
    if method == "tools/call"
        && let Some(name) = params.get("name").and_then(Value::as_str)
        && let Err(error) = host.check_call(name)
    {
        return Ok(tool_response(
            svode_tools::result::ToolCallResult::business_error(error),
        ));
    }
    Ok(match bridge_request(host, &method, &params) {
        BridgeCall::Respond(response) => response,
        BridgeCall::CallTool { name, args } => {
            tool_response(call_tool(host, Some(target), &name, args).await)
        }
    })
}

fn tool_response(result: svode_tools::result::ToolCallResult) -> IpcResponse {
    IpcResponse {
        result: None,
        tool_result: Some(result),
        error: None,
    }
}

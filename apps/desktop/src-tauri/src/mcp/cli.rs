use std::io::{self, BufRead, Write};

use serde_json::{Value, json};

use super::config::{self, McpClient};
use super::error::McpBusinessError;
use super::ipc;
use super::protocol::{IpcResponse, ToolCallResult};
use super::{MCP_BRIDGE_PROTOCOL, MCP_VERSION};

pub async fn run_cli() -> i32 {
    match run_cli_inner().await {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("{}: {}", error.code, error.message);
            1
        }
    }
}

async fn run_cli_inner() -> Result<(), McpBusinessError> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match args.first().map(String::as_str) {
        Some("--app") if args.get(1).map(String::as_str) == Some("desktop") => run_stdio().await,
        Some("install") => {
            let client = parse_client_arg(&args)?;
            let result = config::install_client(client)?;
            println!("{}", serde_json::to_string_pretty(&result)?);
            Ok(())
        }
        Some("remove") => {
            let client = parse_client_arg(&args)?;
            let result = config::remove_client(client)?;
            println!("{}", serde_json::to_string_pretty(&result)?);
            Ok(())
        }
        Some("print-config") => {
            let client = parse_client_arg(&args)?;
            let result = config::print_config(client);
            println!("{}", result.manual_config);
            Ok(())
        }
        Some("doctor") => {
            let report = config::doctor(ipc::discovery_exists(), ipc::desktop_reachable().await);
            println!("{}", serde_json::to_string_pretty(&report)?);
            Ok(())
        }
        Some("--bridge-protocol") => {
            println!("{MCP_BRIDGE_PROTOCOL}");
            Ok(())
        }
        Some("--version") | Some("-V") => {
            println!("{MCP_VERSION}");
            Ok(())
        }
        _ => {
            print_usage();
            Ok(())
        }
    }
}

fn parse_client_arg(args: &[String]) -> Result<McpClient, McpBusinessError> {
    let client = args
        .windows(2)
        .find_map(|pair| (pair[0] == "--client").then(|| pair[1].as_str()))
        .ok_or_else(|| {
            McpBusinessError::new("INVALID_ARGS", "expected --client <claude-code|codex>")
        })?;
    McpClient::parse(client)
}

fn print_usage() {
    eprintln!(
        "Usage:
  svode-mcp --app desktop
  svode-mcp install --client <claude-code|codex>
  svode-mcp remove --client <claude-code|codex>
  svode-mcp print-config --client <claude-code|codex>
  svode-mcp doctor
  svode-mcp --bridge-protocol"
    );
}

async fn run_stdio() -> Result<(), McpBusinessError> {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let response = handle_jsonrpc_line(&line).await;
        if let Some(response) = response {
            stdout.write_all(serde_json::to_string(&response)?.as_bytes())?;
            stdout.write_all(b"\n")?;
            stdout.flush()?;
        }
    }
    Ok(())
}

async fn handle_jsonrpc_line(line: &str) -> Option<Value> {
    handle_jsonrpc_line_with(line, |method, params| async move {
        ipc::desktop_request(&method, params).await
    })
    .await
}

async fn handle_jsonrpc_line_with<Request, Future>(
    line: &str,
    desktop_request: Request,
) -> Option<Value>
where
    Request: Fn(String, Value) -> Future,
    Future: std::future::Future<Output = Result<IpcResponse, McpBusinessError>>,
{
    let request: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(error) => {
            return Some(error_response(json!(null), -32700, &error.to_string()));
        }
    };
    let id = request.get("id").cloned();
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    if id.is_none() && method.starts_with("notifications/") {
        return None;
    }
    let id = id.unwrap_or(json!(null));
    match method {
        "initialize" | "ping" | "tools/list" | "tools/call" => {
            let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
            Some(forward_desktop_response(
                id,
                method,
                desktop_request(method.to_string(), params).await,
            ))
        }
        _ => Some(error_response(id, -32601, "method not found")),
    }
}

fn forward_desktop_response(
    id: Value,
    method: &str,
    response: Result<IpcResponse, McpBusinessError>,
) -> Value {
    let response = match response {
        Ok(response) => response,
        Err(error) if method == "tools/call" => {
            return ok_tool_response(id, ToolCallResult::business_error(error));
        }
        Err(error) => return error_response(id, -32603, &error.message),
    };

    if let Some(error) = response.error {
        if matches!(error.code.as_str(), "INVALID_REQUEST" | "UNKNOWN_TOOL") {
            return error_response(id, -32602, &error.message);
        }
        if error.code == "UNKNOWN_METHOD" {
            return error_response(id, -32601, &error.message);
        }
        if method == "tools/call" {
            return ok_tool_response(id, ToolCallResult::business_error(error));
        }
        return error_response(id, -32603, &error.message);
    }

    if method == "tools/call" {
        return match response.tool_result {
            Some(result) => ok_tool_response(id, result),
            None => ok_tool_response(
                id,
                ToolCallResult::business_error(McpBusinessError::new(
                    "DESKTOP_PROTOCOL_ERROR",
                    "desktop did not return a tool result",
                )),
            ),
        };
    }

    ok_response(id, response.result.unwrap_or_else(|| json!({})))
}

fn ok_tool_response(id: Value, result: ToolCallResult) -> Value {
    ok_response(
        id,
        serde_json::to_value(result).unwrap_or_else(|_| json!({})),
    )
}

fn ok_response(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error_response(id: Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    #[tokio::test]
    async fn initialize_and_catalog_are_forwarded_from_active_desktop() {
        let response = handle_jsonrpc_line_with(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
            |method, _| async move {
                assert_eq!(method, "initialize");
                Ok(IpcResponse {
                    result: Some(json!({
                        "protocolVersion": "desktop-protocol",
                        "serverInfo": { "name": "svode", "version": "desktop-build" },
                        "capabilities": { "tools": {} },
                        "instructions": "desktop-owned",
                    })),
                    tool_result: None,
                    error: None,
                })
            },
        )
        .await
        .expect("response");
        let result = response.get("result").expect("result");
        assert_eq!(result["protocolVersion"], "desktop-protocol");
        assert_eq!(result["serverInfo"]["version"], "desktop-build");
        assert_eq!(result["instructions"], "desktop-owned");

        let response = handle_jsonrpc_line_with(
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"cursor":"abc"}}"#,
            |method, params| async move {
                assert_eq!(method, "tools/list");
                assert_eq!(params["cursor"], "abc");
                Ok(IpcResponse {
                    result: Some(json!({ "tools": [{ "name": "desktop_only_tool" }] })),
                    tool_result: None,
                    error: None,
                })
            },
        )
        .await
        .expect("response");
        let tools = response["result"]["tools"].as_array().expect("tools array");
        assert_eq!(tools, &[json!({ "name": "desktop_only_tool" })]);
    }

    #[tokio::test]
    async fn stale_tool_is_rejected_by_active_desktop_without_side_effects() {
        let response = handle_jsonrpc_line_with(
            r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"legacy_tool","arguments":{}}}"#,
            |method, params| async move {
                assert_eq!(method, "tools/call");
                assert_eq!(params["name"], "legacy_tool");
                Ok(IpcResponse {
                    result: None,
                    tool_result: None,
                    error: Some(McpBusinessError::new(
                        "UNKNOWN_TOOL",
                        "unknown Svode MCP tool: legacy_tool",
                    )),
                })
            },
        )
        .await
        .expect("response");
        assert_eq!(response["error"]["code"], -32602);
        assert!(
            response["error"]["message"]
                .as_str()
                .is_some_and(|message| message.contains("legacy_tool"))
        );
    }

    #[tokio::test]
    async fn one_bridge_connection_reads_each_catalog_from_current_desktop_owner() {
        let active_catalog = Arc::new(Mutex::new("installed_tool"));
        let request = |method: String, _params: Value| {
            let active_catalog = Arc::clone(&active_catalog);
            async move {
                assert_eq!(method, "tools/list");
                let name = *active_catalog.lock().expect("catalog mutex");
                Ok(IpcResponse {
                    result: Some(json!({ "tools": [{ "name": name }] })),
                    tool_result: None,
                    error: None,
                })
            }
        };

        let first = handle_jsonrpc_line_with(
            r#"{"jsonrpc":"2.0","id":6,"method":"tools/list"}"#,
            &request,
        )
        .await
        .expect("first response");
        assert_eq!(first["result"]["tools"][0]["name"], "installed_tool");

        *active_catalog.lock().expect("catalog mutex") = "dev_tool";
        let second = handle_jsonrpc_line_with(
            r#"{"jsonrpc":"2.0","id":7,"method":"tools/list"}"#,
            &request,
        )
        .await
        .expect("second response");
        assert_eq!(second["result"]["tools"][0]["name"], "dev_tool");
    }

    #[tokio::test]
    async fn unknown_method_is_protocol_error() {
        let response = handle_jsonrpc_line_with(
            r#"{"jsonrpc":"2.0","id":5,"method":"resources/list"}"#,
            |_, _| async { unreachable!("unknown methods stay in the transport adapter") },
        )
        .await
        .expect("response");
        assert_eq!(response["error"]["code"], -32601);
    }
}

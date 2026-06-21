use std::io::{self, BufRead, Write};

use serde_json::{Value, json};

use super::MCP_VERSION;
use super::config::{self, McpClient};
use super::error::McpBusinessError;
use super::ipc;
use super::protocol::ToolCallResult;
use super::tools;

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
  svode-mcp doctor"
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
        "initialize" => Some(ok_response(
            id,
            json!({
                "protocolVersion": "2025-06-18",
                "serverInfo": { "name": "svode", "version": MCP_VERSION },
                "capabilities": { "tools": {} },
                "instructions": "Use Svode MCP as a product API, not as raw filesystem access. Create collections for structured repeated data; create documents for narrative pages. Call get_svode_guide when unsure."
            }),
        )),
        "ping" => Some(ok_response(id, json!({}))),
        "tools/list" => Some(ok_response(id, json!({ "tools": tools::definitions() }))),
        "tools/call" => {
            let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return Some(error_response(
                    id,
                    -32602,
                    "tools/call requires a tool name",
                ));
            };
            if !tools::is_public_tool(name) {
                return Some(error_response(
                    id,
                    -32602,
                    &format!("unknown Svode MCP tool: {name}"),
                ));
            }
            if name == "get_svode_guide" {
                let result =
                    ToolCallResult::ok("Svode MCP guide.", json!({ "guide": tools::guide_text() }));
                return Some(ok_response(
                    id,
                    serde_json::to_value(result).unwrap_or_else(|_| json!({})),
                ));
            }
            let forwarded = match ipc::desktop_request("tools/call", params).await {
                Ok(response) => response.tool_result.unwrap_or_else(|| {
                    ToolCallResult::business_error(McpBusinessError::new(
                        "DESKTOP_PROTOCOL_ERROR",
                        "desktop did not return a tool result",
                    ))
                }),
                Err(error) => ToolCallResult::business_error(error),
            };
            Some(ok_response(
                id,
                serde_json::to_value(forwarded).unwrap_or_else(|_| json!({})),
            ))
        }
        _ => Some(error_response(id, -32601, "method not found")),
    }
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
    use super::*;

    #[tokio::test]
    async fn initialize_returns_tools_only_capabilities() {
        let response =
            handle_jsonrpc_line(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#)
                .await
                .expect("response");
        let result = response.get("result").expect("result");
        assert_eq!(result["protocolVersion"], "2025-06-18");
        assert!(result["capabilities"].get("tools").is_some());
        assert!(result["serverInfo"].get("name").is_some());
        assert!(result.get("instructions").is_some());
    }

    #[tokio::test]
    async fn tools_list_tolerates_pagination_params() {
        let response = handle_jsonrpc_line(
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"cursor":"abc"}}"#,
        )
        .await
        .expect("response");
        let tools = response["result"]["tools"].as_array().expect("tools array");
        assert!(tools.iter().any(|tool| tool["name"] == "delete_entry"));
        assert!(tools.iter().any(|tool| tool["name"] == "list_actors"));
        assert!(!tools.iter().any(|tool| tool["name"] == "get_entry"));
    }

    #[tokio::test]
    async fn tools_call_rejects_missing_or_unadvertised_names_as_protocol_errors() {
        let missing = handle_jsonrpc_line(
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"arguments":{}}}"#,
        )
        .await
        .expect("response");
        assert_eq!(missing["error"]["code"], -32602);

        let hidden = handle_jsonrpc_line(
            r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_entry","arguments":{"path":"A.md"}}}"#,
        )
        .await
        .expect("response");
        assert_eq!(hidden["error"]["code"], -32602);
    }

    #[tokio::test]
    async fn unknown_method_is_protocol_error() {
        let response = handle_jsonrpc_line(r#"{"jsonrpc":"2.0","id":5,"method":"resources/list"}"#)
            .await
            .expect("response");
        assert_eq!(response["error"]["code"], -32601);
    }
}

//! The MCP server a `svode-mcp` launcher runs when it cannot start the
//! runtime. Clients hide the stderr of a server that exits, and Claude Code
//! stops starting a failed plugin server for a while, so the launcher
//! answers `initialize` and `tools/list` and says what happened on every
//! tool call.

use std::io::{BufRead, Write};

use serde_json::{Value, json};

use crate::VERSION;
use crate::ownership::Unavailable;

const PROTOCOL_VERSION: &str = "2025-06-18";
pub const CODE: &str = "RUNTIME_UNAVAILABLE";

/// Serves newline-delimited JSON-RPC on stdin/stdout until stdin ends.
pub fn serve(unavailable: &Unavailable) {
    let stdin = std::io::stdin().lock();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lines() {
        let Ok(line) = line else { break };
        if let Some(response) = respond(&line, unavailable) {
            let written = writeln!(stdout, "{response}").and_then(|()| stdout.flush());
            if written.is_err() {
                break;
            }
        }
    }
}

/// The response to one line, `None` for notifications and blank lines.
pub fn respond(line: &str, unavailable: &Unavailable) -> Option<Value> {
    if line.trim().is_empty() {
        return None;
    }
    let request: Value = match serde_json::from_str(line) {
        Ok(request) => request,
        Err(error) => return Some(error_response(Value::Null, -32700, &error.to_string())),
    };
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let id = request.get("id").cloned()?;
    let result = match method {
        "initialize" => {
            let requested = request
                .pointer("/params/protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or(PROTOCOL_VERSION);
            json!({
                "protocolVersion": requested,
                "serverInfo": { "name": "svode", "version": VERSION },
                "capabilities": { "tools": {} },
                "instructions": format!("Svode is unavailable: {}. {}", unavailable.message, unavailable.hint),
            })
        }
        "ping" => json!({}),
        "tools/list" => json!({ "tools": [{
            "name": "get_svode_guide",
            "description": format!("Svode is unavailable: {}. Call this tool for the next step.", unavailable.message),
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "readOnlyHint": true },
        }] }),
        "tools/call" => json!({
            "content": [{ "type": "text", "text": format!("{} {}", unavailable.message, unavailable.hint) }],
            "structuredContent": { "error": {
                "code": CODE,
                "message": unavailable.message,
                "hint": unavailable.hint,
            } },
            "isError": true,
        }),
        _ => return Some(error_response(id, -32601, "method not found")),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

fn error_response(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unavailable() -> Unavailable {
        Unavailable {
            message: "the Svode runtime is not installed".into(),
            hint: "Install it.",
        }
    }

    #[test]
    fn answers_the_session_and_reports_the_reason_on_every_tool_call() {
        let u = unavailable();
        let init = respond(
            r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}"#,
            &u,
        )
        .unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert!(
            init["result"]["instructions"]
                .as_str()
                .unwrap()
                .contains("not installed")
        );
        assert_eq!(
            respond(
                r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
                &u
            ),
            None
        );
        let list = respond(r#"{"jsonrpc":"2.0","id":"a","method":"tools/list"}"#, &u).unwrap();
        assert_eq!(list["id"], "a");
        assert_eq!(list["result"]["tools"][0]["name"], "get_svode_guide");
        let call = respond(
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_page","arguments":{"id":"x"}}}"#,
            &u,
        )
        .unwrap();
        assert_eq!(call["result"]["isError"], true);
        assert_eq!(call["result"]["structuredContent"]["error"]["code"], CODE);
        assert_eq!(
            call["result"]["structuredContent"]["error"]["hint"],
            "Install it."
        );
        assert_eq!(
            respond(r#"{"jsonrpc":"2.0","id":3,"method":"resources/list"}"#, &u).unwrap()["error"]
                ["code"],
            -32601
        );
        assert_eq!(respond("{", &u).unwrap()["error"]["code"], -32700);
    }
}

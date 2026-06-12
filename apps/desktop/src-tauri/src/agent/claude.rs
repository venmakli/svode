use std::path::Path;
use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::agent::AgentProcess;
use crate::agent::executor::AgentExecutor;
use crate::agent::types::{AgentConfig, AgentEvent, ModelOption};
use crate::{error::AppError, process};

/// Claude Code CLI executor.
pub struct ClaudeCodeExecutor;

impl AgentExecutor for ClaudeCodeExecutor {
    fn spawn(
        &self,
        space_dir: &Path,
        config: &AgentConfig,
        cli_path: Option<&Path>,
    ) -> Result<AgentProcess, AppError> {
        let resolved_path = match cli_path {
            Some(p) => p.to_string_lossy().to_string(),
            None => detect_cli().ok_or_else(|| AppError::AgentCliNotFound("claude".to_string()))?,
        };

        let mut cmd = build_command(space_dir, config, &resolved_path);
        let mut child = cmd
            .spawn()
            .map_err(|e| AppError::AgentSpawnFailed(e.to_string()))?;

        let stdin = child.stdin.take();

        Ok(AgentProcess {
            child,
            session_id: String::new(),
            space_dir: space_dir.to_string_lossy().to_string(),
            stdin,
        })
    }

    fn parse_line(&self, raw: &str, session_id: &str) -> Vec<AgentEvent> {
        parse_jsonl_line(raw, session_id)
    }

    async fn handle_permission(
        &self,
        stdin: &mut tokio::process::ChildStdin,
        request_id: &str,
        behavior: &str,
        updated_input: Option<serde_json::Value>,
        message: Option<String>,
    ) -> Result<(), AppError> {
        send_permission_response(
            stdin,
            request_id,
            behavior,
            updated_input.as_ref(),
            message.as_deref(),
        )
        .await
    }

    async fn send_message(
        &self,
        stdin: &mut tokio::process::ChildStdin,
        message: &str,
    ) -> Result<(), AppError> {
        send_user_message(stdin, message).await
    }

    fn name(&self) -> &str {
        "claude"
    }

    fn detect(&self) -> Option<String> {
        detect_cli()
    }

    fn available_models(&self) -> Vec<ModelOption> {
        claude_models()
    }
}

/// Detect the `claude` CLI binary. Checks PATH first, then common install locations.
fn detect_cli() -> Option<String> {
    if let Ok(p) = which::which("claude") {
        return Some(p.to_string_lossy().to_string());
    }

    let home = std::env::var("HOME").ok()?;
    let candidates = [
        format!("{home}/.local/bin/claude"),
        format!("{home}/.npm/bin/claude"),
        format!("{home}/.bun/bin/claude"),
        "/usr/local/bin/claude".to_string(),
    ];

    for path in &candidates {
        if std::path::Path::new(path).exists() {
            return Some(path.clone());
        }
    }

    None
}

/// Build the CLI command with appropriate flags.
fn build_command(space_dir: &Path, config: &AgentConfig, cli_path: &str) -> Command {
    let mut cmd = Command::new(cli_path);
    process::hide_tokio_window(&mut cmd);
    cmd.arg("--print")
        .arg("--verbose")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--input-format")
        .arg("stream-json")
        .arg("--include-partial-messages")
        .arg("--permission-prompt-tool=stdio")
        .current_dir(space_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(max_turns) = config.max_turns {
        cmd.arg("--max-turns").arg(max_turns.to_string());
    }

    if let Some(ref system_prompt) = config.system_prompt {
        cmd.arg("--system-prompt").arg(system_prompt);
    }

    if let Some(ref allowed_tools) = config.allowed_tools {
        if !allowed_tools.is_empty() {
            cmd.arg("--allowedTools").arg(allowed_tools.join(","));
        }
    }

    if let Some(ref model) = config.model {
        cmd.arg("--model").arg(model);
    }

    cmd
}

/// Parse a single JSONL line from Claude Code `--include-partial-messages` output.
fn parse_jsonl_line(line: &str, session_id: &str) -> Vec<AgentEvent> {
    let line = line.trim();
    if line.is_empty() {
        return vec![];
    }

    let parsed: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("Failed to parse JSONL line: {e}");
            return vec![];
        }
    };

    let sid = session_id.to_string();
    let top_type = parsed.get("type").and_then(|t| t.as_str()).unwrap_or("");

    match top_type {
        "stream_event" => parse_stream_event(&parsed, &sid),

        "result" => {
            let subtype = parsed.get("subtype").and_then(|s| s.as_str()).unwrap_or("");
            match subtype {
                "success" => {
                    let cli_session = parsed
                        .get("session_id")
                        .and_then(|s| s.as_str())
                        .unwrap_or("")
                        .to_string();
                    vec![AgentEvent::Done {
                        session_id: sid,
                        message_id: cli_session,
                    }]
                }
                _ => {
                    let msg = parsed
                        .get("error")
                        .and_then(|e| e.as_str())
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| format!("Agent finished with: {subtype}"));
                    vec![AgentEvent::Error {
                        session_id: sid,
                        message: msg,
                    }]
                }
            }
        }

        "control_request" => {
            let request_id = parsed
                .get("request_id")
                .and_then(|r| r.as_str())
                .unwrap_or("")
                .to_string();
            let request = parsed.get("request");
            let tool_name = request
                .and_then(|r| r.get("tool_name"))
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string();
            let input = request
                .and_then(|r| r.get("input"))
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            let tool_use_id = request
                .and_then(|r| r.get("tool_use_id"))
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string();
            vec![AgentEvent::PermissionRequest {
                session_id: sid,
                request_id,
                tool_name,
                input,
                tool_use_id,
            }]
        }

        "system" | "rate_limit_event" | "assistant" => vec![],

        _ => {
            tracing::debug!("Unhandled JSONL event type: {top_type}");
            vec![]
        }
    }
}

/// Parse a `stream_event` envelope containing Anthropic API-style SSE events.
fn parse_stream_event(parsed: &serde_json::Value, session_id: &str) -> Vec<AgentEvent> {
    let event = match parsed.get("event") {
        Some(e) => e,
        None => return vec![],
    };

    let event_type = event.get("type").and_then(|t| t.as_str()).unwrap_or("");

    match event_type {
        "content_block_delta" => {
            let delta = event.get("delta");
            let delta_type = delta
                .and_then(|d| d.get("type"))
                .and_then(|t| t.as_str())
                .unwrap_or("");

            match delta_type {
                "text_delta" => {
                    let text = delta
                        .and_then(|d| d.get("text"))
                        .and_then(|t| t.as_str())
                        .unwrap_or("");
                    if text.is_empty() {
                        return vec![];
                    }
                    vec![AgentEvent::TextDelta {
                        session_id: session_id.to_string(),
                        delta: text.to_string(),
                    }]
                }
                "input_json_delta" => {
                    let partial = delta
                        .and_then(|d| d.get("partial_json"))
                        .and_then(|t| t.as_str())
                        .unwrap_or("");
                    if partial.is_empty() {
                        return vec![];
                    }
                    let index = event.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
                    vec![AgentEvent::ToolInputDelta {
                        session_id: session_id.to_string(),
                        id: format!("block_{}", index),
                        delta: partial.to_string(),
                    }]
                }
                "thinking_delta" => {
                    let text = delta
                        .and_then(|d| d.get("thinking"))
                        .and_then(|t| t.as_str())
                        .unwrap_or("");
                    if text.is_empty() {
                        return vec![];
                    }
                    vec![AgentEvent::Reasoning {
                        session_id: session_id.to_string(),
                        text: text.to_string(),
                    }]
                }
                _ => vec![],
            }
        }

        "content_block_start" => {
            let block = event.get("content_block");
            let block_type = block
                .and_then(|b| b.get("type"))
                .and_then(|t| t.as_str())
                .unwrap_or("");

            if block_type == "tool_use" {
                let name = block
                    .and_then(|b| b.get("name"))
                    .and_then(|n| n.as_str())
                    .unwrap_or("")
                    .to_string();
                let id = block
                    .and_then(|b| b.get("id"))
                    .and_then(|i| i.as_str())
                    .unwrap_or("")
                    .to_string();
                vec![AgentEvent::ToolCall {
                    session_id: session_id.to_string(),
                    name,
                    args: serde_json::Value::Object(serde_json::Map::new()),
                    id,
                }]
            } else {
                vec![]
            }
        }

        _ => vec![],
    }
}

/// Send a user message through stdin as JSON (for --input-format stream-json).
async fn send_user_message(
    stdin: &mut tokio::process::ChildStdin,
    message: &str,
) -> Result<(), AppError> {
    let msg = serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": message
        }
    });
    let mut line = serde_json::to_string(&msg).map_err(|e| AppError::General(e.to_string()))?;
    line.push('\n');
    tracing::debug!("Sending user message via stdin: {line}");
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| AppError::General(format!("Failed to write to stdin: {e}")))?;
    stdin
        .flush()
        .await
        .map_err(|e| AppError::General(format!("Failed to flush stdin: {e}")))?;
    Ok(())
}

/// Send a permission response (control_response) through stdin.
async fn send_permission_response(
    stdin: &mut tokio::process::ChildStdin,
    request_id: &str,
    behavior: &str,
    updated_input: Option<&serde_json::Value>,
    message: Option<&str>,
) -> Result<(), AppError> {
    tracing::info!("Sending permission response: request_id={request_id} behavior={behavior}");
    let response = if behavior == "allow" {
        serde_json::json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": request_id,
                "response": {
                    "behavior": "allow",
                    "updatedInput": updated_input,
                    "updatedPermissions": null
                }
            }
        })
    } else {
        serde_json::json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": request_id,
                "response": {
                    "behavior": "deny",
                    "message": message.unwrap_or("User denied this action"),
                    "interrupt": false
                }
            }
        })
    };
    let mut line =
        serde_json::to_string(&response).map_err(|e| AppError::General(e.to_string()))?;
    line.push('\n');
    tracing::debug!("Sending control_response via stdin: {line}");
    stdin.write_all(line.as_bytes()).await.map_err(|e| {
        AppError::General(format!("Failed to write permission response to stdin: {e}"))
    })?;
    stdin.flush().await.map_err(|e| {
        AppError::General(format!("Failed to flush permission response stdin: {e}"))
    })?;
    tracing::info!("Permission response sent successfully for request_id={request_id}");
    Ok(())
}

/// Claude Code CLI model aliases. Updated manually with app releases.
/// CLI resolves each alias to the latest version of that model family.
fn claude_models() -> Vec<ModelOption> {
    vec![
        ModelOption {
            id: "sonnet".to_string(),
            name: "Claude Sonnet 4.6".to_string(),
            description: "Balanced".to_string(),
        },
        ModelOption {
            id: "opus".to_string(),
            name: "Claude Opus 4.6".to_string(),
            description: "Most powerful".to_string(),
        },
        ModelOption {
            id: "haiku".to_string(),
            name: "Claude Haiku 4.5".to_string(),
            description: "Fast, cheap".to_string(),
        },
    ]
}

/// Read stdout line by line, parse into AgentEvents, send through channel.
pub async fn stream_stdout(
    stdout: tokio::process::ChildStdout,
    session_id: &str,
    tx: tokio::sync::mpsc::UnboundedSender<AgentEvent>,
) {
    let executor = ClaudeCodeExecutor;
    let reader = BufReader::new(stdout);
    let mut lines = reader.lines();

    while let Ok(Some(line)) = lines.next_line().await {
        let events = executor.parse_line(&line, session_id);
        for event in events {
            if tx.send(event).is_err() {
                return;
            }
        }
    }
}

use std::path::Path;
use std::process::Stdio;

use tokio::io::AsyncBufReadExt;
use tokio::io::BufReader;
use tokio::process::{Child, Command};

use crate::agent::types::{AgentConfig, AgentEvent};
use crate::error::AppError;

/// Detect the `claude` CLI binary. Checks PATH first, then common install locations.
pub fn detect_cli() -> Option<String> {
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
fn build_command(
    workspace_dir: &Path,
    message: &str,
    config: &AgentConfig,
) -> Result<Command, AppError> {
    let cli_path = detect_cli().ok_or_else(|| {
        AppError::AgentCliNotFound("claude".to_string())
    })?;
    let mut cmd = Command::new(&cli_path);
    cmd.arg("--print")
        .arg("--verbose")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--include-partial-messages")
        .arg(message)
        .current_dir(workspace_dir)
        .stdin(Stdio::null())
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
            cmd.arg("--allowedTools")
                .arg(allowed_tools.join(","));
        }
    }

    Ok(cmd)
}

/// Spawn the Claude CLI process and return the child handle.
pub fn spawn_cli(
    workspace_dir: &Path,
    message: &str,
    config: &AgentConfig,
) -> Result<Child, AppError> {
    let mut cmd = build_command(workspace_dir, message, config)?;
    let child = cmd.spawn().map_err(|e| {
        AppError::AgentSpawnFailed(e.to_string())
    })?;
    Ok(child)
}

/// Parse a single JSONL line from Claude Code `--include-partial-messages` output.
///
/// With `--include-partial-messages`, Claude Code emits real streaming events:
/// - `stream_event` with `event.type`:
///   - `content_block_delta` → `delta.type: "text_delta"` (real text deltas)
///   - `content_block_start` → tool_use blocks
///   - `message_start`, `message_delta`, `message_stop`, `content_block_stop`
/// - `assistant` → final message snapshot (ignore — we already streamed deltas)
/// - `result` → done/error
/// - `system`, `rate_limit_event` → ignore
pub fn parse_jsonl_line(line: &str, session_id: &str) -> Vec<AgentEvent> {
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
        // Real streaming events from --include-partial-messages
        "stream_event" => parse_stream_event(&parsed, &sid),

        // Final result (done / error)
        "result" => {
            let subtype = parsed
                .get("subtype")
                .and_then(|s| s.as_str())
                .unwrap_or("");
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

        // Ignore: system init, rate_limit, assistant (final snapshot — already streamed)
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
        // Text delta — the real streaming content
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

        // Content block start — detect tool_use blocks
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

        // Ignore: message_start, message_delta, message_stop, content_block_stop
        _ => vec![],
    }
}

/// Read stdout line by line, parse into AgentEvents, send through channel.
pub async fn stream_stdout(
    stdout: tokio::process::ChildStdout,
    session_id: &str,
    tx: tokio::sync::mpsc::UnboundedSender<AgentEvent>,
) {
    let reader = BufReader::new(stdout);
    let mut lines = reader.lines();

    while let Ok(Some(line)) = lines.next_line().await {
        let events = parse_jsonl_line(&line, session_id);
        for event in events {
            if tx.send(event).is_err() {
                return;
            }
        }
    }
}

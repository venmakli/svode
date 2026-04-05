use std::path::Path;
use std::time::Duration;

use tauri::{AppHandle, Emitter, State};

use crate::agent::claude::{self, ClaudeCodeExecutor};
use crate::agent::executor::AgentExecutor;
use crate::agent::types::{
    load_workspace_agent_config, AgentConfig, AgentEvent, AvailableAgent, ModelOption,
};
use crate::agent::AgentSessions;
use crate::error::AppError;

/// Default timeout for agent execution: 10 minutes.
const DEFAULT_TIMEOUT_SECS: u64 = 600;

/// Send a message to the agent. Spawns a new CLI process for each message.
/// The session_id groups messages logically but each call is a separate CLI invocation.
#[tauri::command]
pub async fn agent_send(
    app: AppHandle,
    sessions: State<'_, AgentSessions>,
    workspace_path: String,
    session_id: String,
    message: String,
    config: Option<AgentConfig>,
) -> Result<(), AppError> {
    let workspace_dir = Path::new(&workspace_path);
    if !workspace_dir.exists() || !workspace_dir.is_dir() {
        return Err(AppError::PathNotAccessible(workspace_path));
    }

    // If there's already a running process for this session, stop it first
    if let Some(mut old_process) = sessions.remove(&session_id).await {
        tracing::info!("Killing existing agent process for session {session_id}");
        let _ = old_process.child.kill().await;
    }

    let agent_config = config.unwrap_or_default();

    // Load workspace-level agent config (best-effort)
    let ws_config = load_workspace_agent_config(workspace_dir);

    // Resolve CLI path: workspace local.json override → PATH detection
    let executor = ClaudeCodeExecutor;
    let cli_path_override = ws_config.cli_paths.get(executor.name()).cloned();

    // Spawn the CLI process
    let mut process = executor.spawn(
        workspace_dir,
        &agent_config,
        cli_path_override.as_deref(),
    )?;

    // Take stdout for streaming
    let stdout = process.child.stdout.take().ok_or_else(|| {
        AppError::AgentSpawnFailed("Failed to capture CLI stdout".to_string())
    })?;

    // Take stdin for sending messages and permission responses
    let mut stdin = process.stdin.take().ok_or_else(|| {
        AppError::AgentSpawnFailed("Failed to capture CLI stdin".to_string())
    })?;

    // Send the user message through stdin
    executor.send_message(&mut stdin, &message).await?;

    // Store the process with stdin handle
    process.session_id = session_id.clone();
    process.stdin = Some(stdin);
    sessions.insert(session_id.clone(), process).await;

    // Create a channel for streaming events
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<AgentEvent>();

    let sid = session_id.clone();
    let timeout_secs = agent_config.max_timeout.unwrap_or(DEFAULT_TIMEOUT_SECS);

    // Spawn a task to read CLI output and send events through the channel, with timeout
    let sessions_for_timeout = sessions.inner().clone();
    let sid_for_timeout = session_id.clone();
    tokio::spawn(async move {
        let stream_future = claude::stream_stdout(stdout, &sid, tx.clone());
        let result = tokio::time::timeout(
            Duration::from_secs(timeout_secs),
            stream_future,
        )
        .await;

        if result.is_err() {
            // Timeout — kill the process and emit error
            tracing::error!(
                "Agent timeout after {timeout_secs}s for session {sid_for_timeout}"
            );
            let error_event = AgentEvent::Error {
                session_id: sid_for_timeout.clone(),
                message: format!("Agent timeout after {} minutes", timeout_secs / 60),
            };
            let _ = tx.send(error_event);

            // Kill the process
            if let Some(mut process) = sessions_for_timeout.remove(&sid_for_timeout).await
            {
                let _ = process.child.kill().await;
            }

            // Emit done so frontend knows the stream ended
            let done_event = AgentEvent::Done {
                session_id: sid_for_timeout,
                message_id: String::new(),
            };
            let _ = tx.send(done_event);
        }
    });

    // Spawn a task to forward events from the channel to Tauri events
    let app_clone = app.clone();
    let sessions_clone = sessions.inner().clone();
    let sid_for_emitter = session_id.clone();
    tokio::spawn(async move {
        let mut got_done = false;
        while let Some(event) = rx.recv().await {
            if matches!(event, AgentEvent::Done { .. }) {
                got_done = true;
            }
            let event_name = event.event_name();
            if let Err(e) = app_clone.emit(event_name, &event) {
                tracing::error!("Failed to emit Tauri event {event_name}: {e}");
            }
        }

        // Stream ended — ensure frontend knows we're done
        if !got_done {
            let done = AgentEvent::Done {
                session_id: sid_for_emitter.clone(),
                message_id: String::new(),
            };
            let _ = app_clone.emit(done.event_name(), &done);
        }

        // Clean up session and wait for process
        if let Some(mut process) = sessions_clone.remove(&sid_for_emitter).await {
            match process.child.wait().await {
                Ok(status) if !status.success() => {
                    tracing::warn!("Claude CLI exited with status: {status}");
                }
                Err(e) => {
                    tracing::error!("Failed to wait for Claude CLI: {e}");
                }
                _ => {}
            }
        }
        tracing::debug!("Agent stream ended for session {sid_for_emitter}");
    });

    Ok(())
}

/// Stop a running agent session by killing its CLI process.
#[tauri::command]
pub async fn agent_stop(
    sessions: State<'_, AgentSessions>,
    session_id: String,
) -> Result<(), AppError> {
    if let Some(mut process) = sessions.remove(&session_id).await {
        tracing::info!("Stopping agent session {session_id}");
        process.child.kill().await.map_err(|e| {
            AppError::General(format!("Failed to kill agent process: {e}"))
        })?;
        Ok(())
    } else {
        // Not an error — session may have already finished
        tracing::debug!("No active agent process for session {session_id}");
        Ok(())
    }
}

/// Respond to a permission request from the agent CLI.
///
/// When `behavior` is "allow", `updated_input` must be the original tool input
/// from the control_request (passed through from frontend).
#[tauri::command]
pub async fn agent_respond_permission(
    sessions: State<'_, AgentSessions>,
    session_id: String,
    request_id: String,
    behavior: String,
    updated_input: Option<serde_json::Value>,
    message: Option<String>,
) -> Result<(), AppError> {
    tracing::info!(
        "Responding to permission request: session={session_id} request={request_id} behavior={behavior}"
    );
    let executor = ClaudeCodeExecutor;
    let result = sessions
        .with_stdin(&session_id, |stdin| {
            let request_id = request_id.clone();
            let behavior = behavior.clone();
            let updated_input = updated_input.clone();
            let message = message.clone();
            Box::pin(async move {
                executor
                    .handle_permission(
                        stdin,
                        &request_id,
                        &behavior,
                        updated_input,
                        message,
                    )
                    .await
            })
        })
        .await;
    if let Err(ref e) = result {
        tracing::error!("Failed to respond to permission: {e}");
    }
    result
}

async fn get_cli_version(cli_path: &str) -> Option<String> {
    let output = tokio::process::Command::new(cli_path)
        .arg("--version")
        .output()
        .await
        .ok()?;
    if output.status.success() {
        Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        None
    }
}

async fn get_cli_auth_status(cli_path: &str) -> String {
    match tokio::process::Command::new(cli_path)
        .args(["auth", "status"])
        .output()
        .await
    {
        Ok(output) if output.status.success() => "authorized".to_string(),
        Ok(_) => "unauthorized".to_string(),
        Err(_) => "unknown".to_string(),
    }
}

/// List available agent CLI tools detected on the system.
#[tauri::command]
pub async fn agent_list_available() -> Result<Vec<AvailableAgent>, AppError> {
    let mut agents = Vec::new();

    let executor = ClaudeCodeExecutor;
    if let Some(path) = executor.detect() {
        let version = get_cli_version(&path).await;
        let auth_status = get_cli_auth_status(&path).await;
        agents.push(AvailableAgent {
            name: executor.name().to_string(),
            path,
            version,
            auth_status,
            docs_url: "https://docs.anthropic.com/claude-code".to_string(),
        });
    } else {
        agents.push(AvailableAgent {
            name: "claude".to_string(),
            path: String::new(),
            version: None,
            auth_status: "not_found".to_string(),
            docs_url: "https://docs.anthropic.com/claude-code".to_string(),
        });
    }

    // Codex
    let codex_path = which::which("codex")
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let codex_status = if codex_path.is_empty() {
        "not_found"
    } else {
        "authorized"
    };
    agents.push(AvailableAgent {
        name: "codex".to_string(),
        path: codex_path,
        version: None,
        auth_status: codex_status.to_string(),
        docs_url: "https://github.com/openai/codex".to_string(),
    });

    Ok(agents)
}

/// List available models for the active agent CLI in a workspace.
#[tauri::command]
pub async fn agent_list_models(
    workspace_path: String,
) -> Result<Vec<ModelOption>, AppError> {
    let workspace_dir = Path::new(&workspace_path);
    let ws_config = load_workspace_agent_config(workspace_dir);
    let active_cli = ws_config.clis.first().map(|s| s.as_str()).unwrap_or("claude");

    let models = match active_cli {
        "claude" => ClaudeCodeExecutor.available_models(),
        _ => ClaudeCodeExecutor.available_models(),
    };

    Ok(models)
}

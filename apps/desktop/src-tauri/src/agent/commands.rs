use std::path::Path;

use tauri::{AppHandle, Emitter, State};

use crate::agent::claude;
use crate::agent::types::{AgentConfig, AgentEvent, AvailableAgent};
use crate::agent::AgentSessions;
use crate::error::AppError;

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

    // Spawn the CLI process (no message arg — message sent via stdin)
    let mut child = claude::spawn_cli(workspace_dir, &agent_config)?;

    // Take stdout for streaming
    let stdout = child.stdout.take().ok_or_else(|| {
        AppError::AgentSpawnFailed("Failed to capture CLI stdout".to_string())
    })?;

    // Take stdin for sending messages and permission responses
    let mut stdin = child.stdin.take().ok_or_else(|| {
        AppError::AgentSpawnFailed("Failed to capture CLI stdin".to_string())
    })?;

    // Send the user message through stdin
    claude::send_user_message(&mut stdin, &message).await?;

    // Store the process with stdin handle
    let process = crate::agent::AgentProcess {
        child,
        session_id: session_id.clone(),
        workspace_dir: workspace_path.clone(),
        stdin: Some(stdin),
    };
    sessions.insert(session_id.clone(), process).await;

    // Create a channel for streaming events
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<AgentEvent>();

    let sid = session_id.clone();

    // Spawn a task to read CLI output and send events through the channel
    tokio::spawn(async move {
        claude::stream_stdout(stdout, &sid, tx).await;
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
    let result = sessions.with_stdin(&session_id, |stdin| {
        let request_id = request_id.clone();
        let behavior = behavior.clone();
        let updated_input = updated_input.clone();
        let message = message.clone();
        Box::pin(async move {
            claude::send_permission_response(
                stdin,
                &request_id,
                &behavior,
                updated_input.as_ref(),
                message.as_deref(),
            ).await
        })
    }).await;
    if let Err(ref e) = result {
        tracing::error!("Failed to respond to permission: {e}");
    }
    result
}

/// List available agent CLI tools detected on the system.
#[tauri::command]
pub fn agent_list_available() -> Result<Vec<AvailableAgent>, AppError> {
    let mut agents = Vec::new();

    if let Some(path) = claude::detect_cli() {
        agents.push(AvailableAgent {
            name: "claude".to_string(),
            path,
        });
    }

    Ok(agents)
}

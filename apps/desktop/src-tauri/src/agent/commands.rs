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

    // Spawn the CLI process
    let mut child = claude::spawn_cli(workspace_dir, &message, &agent_config)?;

    // Take stdout before storing child — streaming reads from stdout,
    // while child handle stays in sessions for agent_stop to kill
    let stdout = child.stdout.take().ok_or_else(|| {
        AppError::AgentSpawnFailed("Failed to capture CLI stdout".to_string())
    })?;

    // Store the process so agent_stop can kill it
    let process = crate::agent::AgentProcess {
        child,
        session_id: session_id.clone(),
        workspace_dir: workspace_path.clone(),
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

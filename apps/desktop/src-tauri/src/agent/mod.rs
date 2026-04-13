pub mod claude;
pub mod commands;
pub mod executor;
pub mod types;

use std::collections::HashMap;
use std::sync::Arc;

use tokio::process::Child;
use tokio::sync::Mutex;

use crate::error::AppError;


/// Handle for a running agent CLI process.
pub struct AgentProcess {
    pub child: Child,
    pub session_id: String,
    #[allow(dead_code)]
    pub workspace_dir: String,
    pub stdin: Option<tokio::process::ChildStdin>,
}

/// Shared state holding all active agent sessions.
/// Key: session_id, Value: AgentProcess
#[derive(Clone)]
pub struct AgentSessions {
    sessions: Arc<Mutex<HashMap<String, AgentProcess>>>,
}

impl AgentSessions {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn insert(&self, session_id: String, process: AgentProcess) {
        self.sessions.lock().await.insert(session_id, process);
    }

    pub async fn remove(&self, session_id: &str) -> Option<AgentProcess> {
        self.sessions.lock().await.remove(session_id)
    }

    #[allow(dead_code)]
    pub async fn contains(&self, session_id: &str) -> bool {
        self.sessions.lock().await.contains_key(session_id)
    }

    pub async fn with_stdin<F>(&self, session_id: &str, f: F) -> Result<(), AppError>
    where
        F: for<'a> FnOnce(&'a mut tokio::process::ChildStdin) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), AppError>> + Send + 'a>>,
    {
        let mut sessions = self.sessions.lock().await;
        if let Some(process) = sessions.get_mut(session_id) {
            if let Some(ref mut stdin) = process.stdin {
                f(stdin).await
            } else {
                Err(AppError::General("No stdin handle for session".to_string()))
            }
        } else {
            Err(AppError::General(format!("No active session: {session_id}")))
        }
    }
}

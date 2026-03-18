pub mod claude;
pub mod commands;
pub mod types;

use std::collections::HashMap;
use std::sync::Arc;

use tokio::process::Child;
use tokio::sync::Mutex;

/// Handle for a running agent CLI process.
pub struct AgentProcess {
    pub child: Child,
    pub session_id: String,
    pub workspace_dir: String,
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

    pub async fn contains(&self, session_id: &str) -> bool {
        self.sessions.lock().await.contains_key(session_id)
    }
}

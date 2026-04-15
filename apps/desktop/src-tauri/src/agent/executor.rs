use std::path::Path;

use tokio::process::ChildStdin;

use super::types::{AgentConfig, AgentEvent, ModelOption};
use super::AgentProcess;
use crate::error::AppError;

/// Trait abstracting over different agent CLI backends (Claude Code, etc.).
pub trait AgentExecutor: Send + Sync {
    /// Spawn CLI process in space directory.
    fn spawn(
        &self,
        space_dir: &Path,
        config: &AgentConfig,
        cli_path: Option<&Path>,
    ) -> Result<AgentProcess, AppError>;

    /// Parse a single JSONL line into events.
    fn parse_line(&self, raw: &str, session_id: &str) -> Vec<AgentEvent>;

    /// Send permission response through stdin.
    fn handle_permission(
        &self,
        stdin: &mut ChildStdin,
        request_id: &str,
        behavior: &str,
        updated_input: Option<serde_json::Value>,
        message: Option<String>,
    ) -> impl std::future::Future<Output = Result<(), AppError>> + Send;

    /// Send user message through stdin.
    fn send_message(
        &self,
        stdin: &mut ChildStdin,
        message: &str,
    ) -> impl std::future::Future<Output = Result<(), AppError>> + Send;

    /// CLI name identifier.
    fn name(&self) -> &str;

    /// Detect if CLI is available on the system. Returns the path if found.
    fn detect(&self) -> Option<String>;

    /// Return the list of models supported by this CLI.
    fn available_models(&self) -> Vec<ModelOption>;
}

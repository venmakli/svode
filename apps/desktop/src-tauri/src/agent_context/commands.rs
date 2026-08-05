use std::path::PathBuf;

use tauri::State;

use crate::AppError;
use crate::agent_adapters::system_registry_environment;

use super::model::AgentContextSnapshot;
use super::scanner;
use super::state::AgentContextState;

#[tauri::command]
pub async fn agent_context_get_instructions(
    state: State<'_, AgentContextState>,
    project_path: String,
    space_path: String,
) -> Result<AgentContextSnapshot, AppError> {
    discover_and_publish(&state, project_path, space_path).await
}

#[tauri::command]
pub async fn agent_context_refresh_instructions(
    state: State<'_, AgentContextState>,
    project_path: String,
    space_path: String,
) -> Result<AgentContextSnapshot, AppError> {
    discover_and_publish(&state, project_path, space_path).await
}

async fn discover_and_publish(
    state: &AgentContextState,
    project_path: String,
    space_path: String,
) -> Result<AgentContextSnapshot, AppError> {
    let environment = system_registry_environment().await?;
    let project_path = PathBuf::from(project_path);
    let space_path = PathBuf::from(space_path);
    let content = tokio::task::spawn_blocking(move || {
        scanner::scan(&project_path, &space_path, &environment)
    })
    .await
    .map_err(|error| AppError::General(format!("agent context scan task failed: {error}")))??;
    let key = format!("{}\0{}", content.project_root, content.target_root);
    state.publish(key, content)
}

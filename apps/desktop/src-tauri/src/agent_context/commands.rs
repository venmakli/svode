use std::path::PathBuf;

use tauri::State;

use crate::AppError;

use super::state::AgentContextState;
use crate::agent_setup::AgentSetupState;
use svode_core::agent_context::model::{AgentContextSnapshot, MarkdownPreview};
use svode_core::agent_context::scanner;
use svode_core::agent_context::scanner::skill_files::{self, SkillFilesBranch};

#[tauri::command]
pub async fn agent_context_get_items(
    state: State<'_, AgentContextState>,
    agents: State<'_, AgentSetupState>,
    project_path: String,
    space_path: String,
) -> Result<AgentContextSnapshot, AppError> {
    discover_and_publish(&state, &agents, project_path, space_path).await
}

#[tauri::command]
pub async fn agent_context_refresh_items(
    state: State<'_, AgentContextState>,
    agents: State<'_, AgentSetupState>,
    project_path: String,
    space_path: String,
) -> Result<AgentContextSnapshot, AppError> {
    discover_and_publish(&state, &agents, project_path, space_path).await
}

/// The supported files directly inside `path` of a skill folder; `path` is
/// empty for the folder itself. Only a skill of a published snapshot is read.
#[tauri::command]
pub async fn agent_context_list_skill_files(
    state: State<'_, AgentContextState>,
    item_id: String,
    path: String,
) -> Result<SkillFilesBranch, AppError> {
    let directory = skill_directory(&state, &item_id)?;
    tokio::task::spawn_blocking(move || skill_files::list_skill_files(&directory, &path))
        .await
        .map_err(|error| AppError::General(format!("skill files task failed: {error}")))?
        .map_err(AppError::from)
}

/// The text of a Markdown file of a skill, read within its folder.
#[tauri::command]
pub async fn agent_context_read_skill_file(
    state: State<'_, AgentContextState>,
    item_id: String,
    path: String,
) -> Result<MarkdownPreview, AppError> {
    let directory = skill_directory(&state, &item_id)?;
    tokio::task::spawn_blocking(move || skill_files::read_skill_markdown(&directory, &path))
        .await
        .map_err(|error| AppError::General(format!("skill file task failed: {error}")))?
        .map_err(AppError::from)
}

fn skill_directory(state: &AgentContextState, item_id: &str) -> Result<PathBuf, AppError> {
    state.skill_directory(item_id).ok_or_else(|| {
        AppError::PathNotAccessible(format!("{item_id} is not a skill of the Context"))
    })
}

/// The agents enabled in Providers are the scan's input: sources outside the
/// target's repository boundary are read only for them.
async fn discover_and_publish(
    state: &AgentContextState,
    agents: &AgentSetupState,
    project_path: String,
    space_path: String,
) -> Result<AgentContextSnapshot, AppError> {
    let environment = svode_core::agent_adapters::system_source_registry_environment()?;
    let enabled_agents = agents.enabled_agents().await;
    let project_path = PathBuf::from(project_path);
    let space_path = PathBuf::from(space_path);
    let content = tokio::task::spawn_blocking(move || {
        scanner::scan(&project_path, &space_path, &environment, &enabled_agents)
    })
    .await
    .map_err(|error| AppError::General(format!("agent context scan task failed: {error}")))??;
    let key = format!("{}\0{}", content.project_root, content.target_root);
    state.publish(key, content)
}

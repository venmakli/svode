//! Thin commands over agent setup. Reading setup runs only the bounded
//! version, sign-in and Node.js checks: it starts no ACP process and
//! installs nothing. Install, update and removal are explicit actions.

use std::sync::Arc;

use serde::Serialize;
use svode_agents::AgentCheck;
use svode_agents::adapters::{AgentSetup, ChatOffer, chat_offer};
use svode_agents::custom::{
    CustomAgent, CustomAgentDefinition, CustomAgentSetup, custom_agent_setup,
};
use svode_agents::registry::{
    AdapterRuntimeRegistry, AdapterTarget, AgentVerdict, SystemRuntimeCommandRunner,
};
use svode_core::agent_adapters::{
    AgentAdapterKind, CustomAgentId, resolve_space_executable, system_home_dir,
};
use tauri::{AppHandle, Emitter, State};
use tokio::task::JoinSet;

use super::AgentSetupState;
use crate::agent_runtime::AgentRuntimeState;
use crate::agent_runtime::connections::{AgentConnections, LaunchPlanner};
use crate::agent_sessions::AgentSessionsState;
use crate::error::AppError;
use crate::process::path_env::ProcessPath;
use crate::terminal::{TerminalManager, TerminalSession};

/// The home directory, where no Space-local override applies, and the
/// login shell PATH.
pub(super) async fn target() -> Result<AdapterTarget, AppError> {
    let home = system_home_dir()
        .ok_or_else(|| AppError::PathNotAccessible("home directory is unavailable".into()))?;
    Ok(AdapterTarget {
        cwd: home,
        search_path: ProcessPath::session().get().await.map(ToOwned::to_owned),
    })
}

async fn setup(state: &AgentSetupState, agent: AgentAdapterKind) -> Result<AgentSetup, AppError> {
    Ok(state
        .store
        .agent_setup(
            agent,
            state.choice(agent.as_str()),
            &target().await?,
            &SystemRuntimeCommandRunner,
        )
        .await)
}

/// Every registry agent in registry order; the agents are read concurrently,
/// so a slow CLI does not hold the others.
#[tauri::command]
pub async fn agent_setup_list(
    state: State<'_, AgentSetupState>,
) -> Result<Vec<AgentSetup>, AppError> {
    let target = target().await?;
    let mut reads = JoinSet::new();
    for (order, agent) in AgentAdapterKind::ALL.into_iter().enumerate() {
        let state = (*state).clone();
        let target = target.clone();
        reads.spawn(async move {
            let setup = state
                .store
                .agent_setup(
                    agent,
                    state.choice(agent.as_str()),
                    &target,
                    &SystemRuntimeCommandRunner,
                )
                .await;
            (order, setup)
        });
    }
    let mut setups = reads.join_all().await;
    setups.sort_by_key(|(order, _)| *order);
    Ok(setups.into_iter().map(|(_, setup)| setup).collect())
}

/// One agent a new session offers for chat.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAgent {
    pub agent: String,
    pub name: String,
    pub offer: ChatOffer,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAgents {
    /// In the order of the agent settings: registry agents, then custom
    /// agents in the order the user added them.
    pub agents: Vec<ChatAgent>,
    /// The agent of the last session created in the chat on this device.
    pub last: Option<String>,
}

/// The agents a new session draft offers (Stage 10 `04`, `03` A1/A8). Only
/// launch plans are resolved: bounded version probes, no ACP process.
#[tauri::command]
pub async fn agent_setup_chat_agents(
    state: State<'_, AgentSetupState>,
) -> Result<ChatAgents, AppError> {
    let builtin = AgentAdapterKind::ALL.into_iter().map(|agent| {
        (
            agent.as_str().to_string(),
            agent.display_name().to_string(),
            AdapterRuntimeRegistry.verdict(agent) == AgentVerdict::Deferred,
        )
    });
    let custom = state.custom_agents().into_iter().map(|custom| {
        (
            custom.id.agent_id().as_str().to_string(),
            custom.definition.name,
            false,
        )
    });
    let mut reads = JoinSet::new();
    for (order, (agent, name, deferred)) in builtin.chain(custom).enumerate() {
        let state = (*state).clone();
        reads.spawn(async move {
            let plan = state.plan(&agent).await;
            let offer = chat_offer(deferred, &plan);
            (order, offer.map(|offer| ChatAgent { agent, name, offer }))
        });
    }
    let mut offered = reads.join_all().await;
    offered.sort_by_key(|(order, _)| *order);
    Ok(ChatAgents {
        agents: offered.into_iter().filter_map(|(_, agent)| agent).collect(),
        last: state.last_chat_agent(),
    })
}

/// Enabling an agent with an adapter installs the adapter when none is
/// installed; the choice is recorded only after that succeeds.
#[tauri::command]
pub async fn agent_setup_enable(
    state: State<'_, AgentSetupState>,
    agent: AgentAdapterKind,
) -> Result<AgentSetup, AppError> {
    state
        .store
        .prepare_enable(
            agent,
            &target().await?,
            &SystemRuntimeCommandRunner,
            &*state.source,
        )
        .await?;
    state.set_choice(agent.as_str(), true)?;
    setup(&state, agent).await
}

/// Disabling leaves the adapter, terminal work, native config and sessions
/// of the agent as they are.
#[tauri::command]
pub async fn agent_setup_disable(
    state: State<'_, AgentSetupState>,
    connections: State<'_, Arc<AgentConnections>>,
    agent: AgentAdapterKind,
) -> Result<AgentSetup, AppError> {
    state.set_choice(agent.as_str(), false)?;
    connections.forget_agent(agent.as_str());
    setup(&state, agent).await
}

#[tauri::command]
pub async fn agent_setup_update_adapter(
    state: State<'_, AgentSetupState>,
    agent: AgentAdapterKind,
) -> Result<AgentSetup, AppError> {
    state
        .store
        .install_adapter(
            agent,
            &target().await?,
            &SystemRuntimeCommandRunner,
            &*state.source,
        )
        .await?;
    setup(&state, agent).await
}

#[tauri::command]
pub async fn agent_setup_remove_adapter(
    state: State<'_, AgentSetupState>,
    agent: AgentAdapterKind,
) -> Result<AgentSetup, AppError> {
    state.store.uninstall(agent).await?;
    setup(&state, agent).await
}

/// Opens a terminal in the home directory with the agent's own sign-in
/// command. The agent keeps its credentials; Svode never sees them (A5).
#[tauri::command]
pub async fn agent_setup_sign_in(
    app: AppHandle,
    terminals: State<'_, TerminalManager>,
    agent: AgentAdapterKind,
) -> Result<TerminalSession, AppError> {
    let target = target().await?;
    let executable = resolve_space_executable(
        agent,
        &target.cwd,
        &target.cwd,
        target.search_path.as_deref(),
    )
    .ok_or_else(|| AppError::AgentCliNotFound(agent.executable().to_string()))?;
    let args = AdapterRuntimeRegistry
        .sign_in_arguments(agent)
        .ok_or_else(|| {
            AppError::General(format!("{} has no sign-in command", agent.display_name()))
        })?;
    terminals.spawn_command_shell(
        app,
        target.cwd.to_string_lossy().into_owned(),
        &executable.to_string_lossy(),
        &args,
    )
}

/// The custom agents changed; every window reads their labels and rows again.
const CUSTOM_AGENTS_CHANGED_EVENT: &str = "agents:custom-changed";

async fn custom_setup(
    state: &AgentSetupState,
    runtime: &AgentRuntimeState,
    agent: &CustomAgent,
) -> Result<CustomAgentSetup, AppError> {
    let id = agent.id.agent_id().as_str();
    Ok(custom_agent_setup(
        agent,
        state.choice(id),
        &target().await?,
        runtime.runtime().declared(id),
    ))
}

/// The custom ACP agents in the order the user added them. Only their
/// commands are looked up; nothing starts.
#[tauri::command]
pub async fn agent_custom_list(
    state: State<'_, AgentSetupState>,
    runtime: State<'_, AgentRuntimeState>,
) -> Result<Vec<CustomAgentSetup>, AppError> {
    let mut setups = Vec::new();
    for agent in state.custom_agents() {
        setups.push(custom_setup(&state, &runtime, &agent).await?);
    }
    Ok(setups)
}

#[tauri::command]
pub async fn agent_custom_add(
    app: AppHandle,
    state: State<'_, AgentSetupState>,
    runtime: State<'_, AgentRuntimeState>,
    sessions: State<'_, AgentSessionsState>,
    definition: CustomAgentDefinition,
) -> Result<CustomAgentSetup, AppError> {
    let agent = state.add_custom_agent(definition)?;
    sessions.acp_lists.remember(agent.id.agent_id().as_str());
    let _ = app.emit(CUSTOM_AGENTS_CHANGED_EVENT, ());
    custom_setup(&state, &runtime, &agent).await
}

/// A changed command is another process: what the agent declared and its
/// catalogue connection are dropped. Its sessions keep their ids.
#[tauri::command]
pub async fn agent_custom_update(
    app: AppHandle,
    state: State<'_, AgentSetupState>,
    runtime: State<'_, AgentRuntimeState>,
    connections: State<'_, Arc<AgentConnections>>,
    agent: CustomAgentId,
    definition: CustomAgentDefinition,
) -> Result<CustomAgentSetup, AppError> {
    let agent = state.update_custom_agent(agent, definition)?;
    let id = agent.id.agent_id().as_str();
    connections.forget_agent(id);
    runtime.runtime().forget_declared(id);
    let _ = app.emit(CUSTOM_AGENTS_CHANGED_EVENT, ());
    custom_setup(&state, &runtime, &agent).await
}

/// Svode forgets the agent: its command, enable choice, catalogue
/// connection and the list read in this process. The agent's own sessions
/// and configuration stay as they are.
#[tauri::command]
pub async fn agent_custom_remove(
    app: AppHandle,
    state: State<'_, AgentSetupState>,
    runtime: State<'_, AgentRuntimeState>,
    connections: State<'_, Arc<AgentConnections>>,
    sessions: State<'_, AgentSessionsState>,
    agent: CustomAgentId,
) -> Result<(), AppError> {
    state.remove_custom_agent(&agent)?;
    let id = agent.agent_id().as_str();
    connections.forget_agent(id);
    runtime.runtime().forget_declared(id);
    sessions.acp_lists.forget(id);
    let _ = app.emit(CUSTOM_AGENTS_CHANGED_EVENT, ());
    Ok(())
}

/// Turning a custom agent on or off installs and removes nothing.
#[tauri::command]
pub async fn agent_custom_set_enabled(
    state: State<'_, AgentSetupState>,
    runtime: State<'_, AgentRuntimeState>,
    connections: State<'_, Arc<AgentConnections>>,
    agent: CustomAgentId,
    enabled: bool,
) -> Result<CustomAgentSetup, AppError> {
    let custom = state.custom_agent(&agent)?;
    let id = agent.agent_id().as_str();
    state.set_choice(id, enabled)?;
    if !enabled {
        connections.forget_agent(id);
    }
    custom_setup(&state, &runtime, &custom).await
}

/// The user's check of a definition in the form, before it is saved:
/// starts the command, runs `initialize` and closes it. `agent` is the
/// custom agent being edited, none for a new one.
#[tauri::command]
pub async fn agent_custom_check(
    connections: State<'_, Arc<AgentConnections>>,
    agent: Option<CustomAgentId>,
    definition: CustomAgentDefinition,
) -> Result<AgentCheck, AppError> {
    let definition = definition.normalized()?;
    let agent = agent.map(|agent| agent.agent_id().as_str().to_string());
    Ok(connections.check_draft(agent.as_deref(), definition).await)
}

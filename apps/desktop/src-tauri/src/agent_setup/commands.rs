//! Thin commands over agent setup. Reading setup runs only the bounded
//! version, sign-in and Node.js checks: it starts no ACP process and
//! installs nothing. Install, update and removal are explicit actions.

use std::sync::Arc;

use svode_agents::adapters::AgentSetup;
use svode_agents::registry::{AdapterTarget, SystemRuntimeCommandRunner};
use svode_core::agent_adapters::{AgentAdapterKind, system_home_dir};
use tauri::State;

use super::AgentSetupState;
use crate::agent_runtime::connections::AgentConnections;
use crate::error::AppError;
use crate::process::path_env::ProcessPath;

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
            state.choice(agent),
            &target().await?,
            &SystemRuntimeCommandRunner,
        )
        .await)
}

#[tauri::command]
pub async fn agent_setup_list(
    state: State<'_, AgentSetupState>,
) -> Result<Vec<AgentSetup>, AppError> {
    let mut setups = Vec::new();
    for agent in AgentAdapterKind::ALL {
        setups.push(setup(&state, agent).await?);
    }
    Ok(setups)
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
    state.set_choice(agent, true)?;
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
    state.set_choice(agent, false)?;
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

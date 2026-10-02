//! Thin commands over agent setup. Reading setup runs only the bounded
//! version, sign-in and Node.js checks: it starts no ACP process and
//! installs nothing. Install, update and removal are explicit actions.

use std::sync::Arc;

use svode_agents::adapters::AgentSetup;
use svode_agents::registry::{AdapterRuntimeRegistry, AdapterTarget, SystemRuntimeCommandRunner};
use svode_core::agent_adapters::{AgentAdapterKind, resolve_space_executable, system_home_dir};
use tauri::{AppHandle, State};
use tokio::task::JoinSet;

use super::AgentSetupState;
use crate::agent_runtime::connections::AgentConnections;
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
            state.choice(agent),
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
                    state.choice(agent),
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

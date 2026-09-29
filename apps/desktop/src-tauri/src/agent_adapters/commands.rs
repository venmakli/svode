use svode_core::agent_adapters::{AgentAdapterIdentity, AgentAdapterRegistry};

/// Labels of the registered agent adapters, by adapter id.
#[tauri::command]
pub fn agent_adapters_list_identities() -> Vec<AgentAdapterIdentity> {
    AgentAdapterRegistry.identities()
}

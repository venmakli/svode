use super::types::{ProjectDefaults, WorkspaceConfig};

/// Shallow merge: workspace config takes priority, falls back to project defaults.
/// Currently only merges the `agent` field.
pub fn merge_config(defaults: &ProjectDefaults, ws_config: &WorkspaceConfig) -> WorkspaceConfig {
    WorkspaceConfig {
        name: ws_config.name.clone(),
        description: ws_config.description.clone(),
        icon: ws_config.icon.clone(),
        agent: ws_config.agent.clone().or_else(|| defaults.agent.clone()),
    }
}

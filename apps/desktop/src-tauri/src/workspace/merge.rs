use super::types::{AgentConfig, WorkspaceConfig, WorkspaceDefaults};

/// Merge parent defaults into child workspace config.
/// Child values take priority; falls back to parent defaults.
#[allow(dead_code)]
pub fn merge_with_defaults(child: &WorkspaceConfig, defaults: &WorkspaceDefaults) -> WorkspaceConfig {
    let merged_agent = match (&child.agent, &defaults.agent) {
        (Some(child_agent), Some(default_agent)) => Some(AgentConfig {
            clis: child_agent.clis.clone().or_else(|| default_agent.clis.clone()),
            default_model: child_agent
                .default_model
                .clone()
                .or_else(|| default_agent.default_model.clone()),
            system_prompt: child_agent
                .system_prompt
                .clone()
                .or_else(|| default_agent.system_prompt.clone()),
            max_turns: child_agent.max_turns.or(default_agent.max_turns),
            max_timeout: child_agent.max_timeout.or(default_agent.max_timeout),
        }),
        (Some(agent), None) => Some(agent.clone()),
        (None, Some(agent)) => Some(agent.clone()),
        (None, None) => None,
    };

    WorkspaceConfig {
        name: child.name.clone(),
        description: child.description.clone(),
        icon: child.icon.clone(),
        children: child.children.clone(),
        agent: merged_agent,
        defaults: child.defaults.clone(),
        git: child.git.clone(),
        assets: child.assets.clone(),
    }
}

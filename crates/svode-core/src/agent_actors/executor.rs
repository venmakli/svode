//! The process-free executor resolver of an Agent Actor launch: which agent
//! runs a Routine and with which values, from the catalog, the device mode
//! of the Actor and the default agent of the device.
//!
//! It probes no executable, starts no process and checks no value against
//! an agent's declaration: readiness and the values the agent declares are
//! the launch's own checks.

use std::path::Path;

use serde::Serialize;

use super::local::read_actor_mode;
use super::{
    ActorBinding, AgentSettingValue, CanonicalActorResolution, resolve_canonical_reference,
};
use crate::agent_adapters::AgentId;
use crate::default_agent::DefaultAgent;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ExecutorResolution {
    /// The Routine names no executor.
    MissingExecutor,
    /// No effective Actor has this canonical reference, or it is not one.
    MissingActor {
        reference: String,
    },
    /// The Space and root both define the id.
    AmbiguousActor {
        reference: String,
    },
    /// The device mode of the Actor cannot be read.
    ModeUnavailable {
        reference: String,
        actor_owner_path: String,
        message: String,
    },
    /// The binding names an agent this version does not know or a custom
    /// agent a V1 catalog kept: the Actor needs another agent in its editor.
    UnknownAgent {
        reference: String,
        actor_owner_path: String,
        agent: AgentId,
    },
    /// The participant's agent with no default agent on this device.
    DefaultAgentNotSet {
        reference: String,
        actor_owner_path: String,
    },
    Resolved(ResolvedExecutor),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutorSource {
    /// The concrete agent of the Actor's binding.
    Binding,
    /// The device's default agent for the participant's agent.
    DefaultAgent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedExecutor {
    pub actor_reference: String,
    pub actor_owner_path: String,
    pub launch_space_path: String,
    pub source: ExecutorSource,
    pub agent: AgentId,
    /// Values from the catalog. A value the agent declares in category
    /// `mode` came into the catalog by hand and refuses the launch.
    pub portable_settings: Vec<AgentSettingValue>,
    /// Values of this device: the Actor mode for its agent, or every value
    /// of the default agent, its mode included.
    pub device_settings: Vec<AgentSettingValue>,
}

/// Resolve the executor reference of a Routine launched in `launch_space`,
/// whose catalog domain is the Space and its `inherited_root`.
/// `default_agent` is the device's default agent for an Actor bound to the
/// participant's agent.
pub fn resolve_executor(
    launch_space: &Path,
    inherited_root: Option<&Path>,
    executor: Option<&str>,
    default_agent: Option<&DefaultAgent>,
) -> ExecutorResolution {
    let Some(reference) = executor.filter(|executor| !executor.is_empty()) else {
        return ExecutorResolution::MissingExecutor;
    };
    let resolved = match resolve_canonical_reference(launch_space, inherited_root, reference) {
        CanonicalActorResolution::Resolved { actor } => actor,
        CanonicalActorResolution::Missing { .. } => {
            return ExecutorResolution::MissingActor {
                reference: reference.into(),
            };
        }
        CanonicalActorResolution::Ambiguous { .. } => {
            return ExecutorResolution::AmbiguousActor {
                reference: reference.into(),
            };
        }
    };
    let launch_space_path = launch_space.to_string_lossy().into_owned();
    match resolved.actor.binding {
        ActorBinding::Participant => match default_agent {
            None => ExecutorResolution::DefaultAgentNotSet {
                reference: reference.into(),
                actor_owner_path: resolved.owner_path,
            },
            Some(default) => ExecutorResolution::Resolved(ResolvedExecutor {
                actor_reference: reference.into(),
                actor_owner_path: resolved.owner_path,
                launch_space_path,
                source: ExecutorSource::DefaultAgent,
                agent: default.agent.clone(),
                portable_settings: Vec::new(),
                device_settings: default.settings.clone(),
            }),
        },
        ActorBinding::Agent { agent, settings } => {
            if agent.builtin().is_none() {
                return ExecutorResolution::UnknownAgent {
                    reference: reference.into(),
                    actor_owner_path: resolved.owner_path,
                    agent,
                };
            }
            let mode = match read_actor_mode(Path::new(&resolved.owner_path), &resolved.actor.id) {
                Ok(mode) => mode,
                Err(error) => {
                    return ExecutorResolution::ModeUnavailable {
                        reference: reference.into(),
                        actor_owner_path: resolved.owner_path,
                        message: error.to_string(),
                    };
                }
            };
            ExecutorResolution::Resolved(ResolvedExecutor {
                actor_reference: reference.into(),
                actor_owner_path: resolved.owner_path,
                launch_space_path,
                source: ExecutorSource::Binding,
                agent,
                portable_settings: settings,
                device_settings: mode
                    .into_iter()
                    .map(|mode| AgentSettingValue {
                        setting: mode.setting,
                        value: mode.value,
                    })
                    .collect(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::local::{ActorMode, store_mode};
    use super::super::test_support::write_raw;
    use super::*;
    use crate::agent_adapters::AgentAdapterKind;
    use tempfile::tempdir;

    const ACTOR: &str = "01arz3ndektsv4rrffq69g5fav";

    fn reference() -> String {
        format!("agent:{ACTOR}")
    }

    fn value(setting: &str, value: &str) -> AgentSettingValue {
        AgentSettingValue {
            setting: setting.into(),
            value: value.into(),
        }
    }

    fn catalog(owner: &Path, binding: serde_json::Value) {
        write_raw(
            owner,
            serde_json::json!({"schemaVersion": 2, "actors": [
                {"id": ACTOR, "name": "Agent", "binding": binding}
            ]}),
        );
    }

    #[test]
    fn missing_executor_actor_and_collision_are_distinct_outcomes() {
        let root = tempdir().unwrap();
        let child = tempdir().unwrap();
        assert_eq!(
            resolve_executor(child.path(), None, None, None),
            ExecutorResolution::MissingExecutor
        );
        assert_eq!(
            resolve_executor(child.path(), None, Some(""), None),
            ExecutorResolution::MissingExecutor
        );
        assert!(matches!(
            resolve_executor(child.path(), None, Some("agent:NOT-CANONICAL"), None),
            ExecutorResolution::MissingActor { .. }
        ));
        assert!(matches!(
            resolve_executor(child.path(), Some(root.path()), Some(&reference()), None),
            ExecutorResolution::MissingActor { .. }
        ));
        let binding = serde_json::json!({"agent": "codex", "settings": []});
        catalog(root.path(), binding.clone());
        catalog(child.path(), binding);
        assert!(matches!(
            resolve_executor(child.path(), Some(root.path()), Some(&reference()), None),
            ExecutorResolution::AmbiguousActor { .. }
        ));
    }

    #[test]
    fn a_concrete_agent_runs_with_its_portable_values_and_the_device_mode() {
        let root = tempdir().unwrap();
        let child = tempdir().unwrap();
        catalog(
            root.path(),
            serde_json::json!({"agent": "codex", "settings": [
                {"setting": "model", "value": "gpt-6.1-sol"},
                {"setting": "reasoning_effort", "value": "high"}
            ]}),
        );
        store_mode(
            root.path(),
            ACTOR,
            Some(&ActorMode {
                agent: AgentAdapterKind::Codex.id(),
                setting: "mode".into(),
                value: "agent".into(),
            }),
        )
        .unwrap();

        let ExecutorResolution::Resolved(executor) =
            resolve_executor(child.path(), Some(root.path()), Some(&reference()), None)
        else {
            panic!("a Codex binding resolves");
        };
        assert_eq!(executor.source, ExecutorSource::Binding);
        assert_eq!(executor.agent, AgentAdapterKind::Codex);
        assert_eq!(executor.actor_owner_path, root.path().to_string_lossy());
        assert_eq!(executor.launch_space_path, child.path().to_string_lossy());
        assert_eq!(
            executor.portable_settings,
            [
                value("model", "gpt-6.1-sol"),
                value("reasoning_effort", "high")
            ]
        );
        assert_eq!(executor.device_settings, [value("mode", "agent")]);
    }

    #[test]
    fn a_mode_for_another_agent_is_not_applied() {
        let space = tempdir().unwrap();
        catalog(
            space.path(),
            serde_json::json!({"agent": "claude-code", "settings": []}),
        );
        store_mode(
            space.path(),
            ACTOR,
            Some(&ActorMode {
                agent: AgentAdapterKind::Codex.id(),
                setting: "mode".into(),
                value: "agent".into(),
            }),
        )
        .unwrap();
        let ExecutorResolution::Resolved(executor) =
            resolve_executor(space.path(), None, Some(&reference()), None)
        else {
            panic!("a Claude Code binding resolves");
        };
        assert!(executor.device_settings.is_empty());
    }

    #[test]
    fn the_participant_runs_the_default_agent_with_all_its_values() {
        let space = tempdir().unwrap();
        catalog(space.path(), serde_json::json!({"participant": true}));
        assert!(matches!(
            resolve_executor(space.path(), None, Some(&reference()), None),
            ExecutorResolution::DefaultAgentNotSet { .. }
        ));

        let default = DefaultAgent {
            agent: AgentId::parse("custom-hermes").unwrap(),
            settings: vec![value("model", "m"), value("mode", "accept_edits")],
        };
        let ExecutorResolution::Resolved(executor) =
            resolve_executor(space.path(), None, Some(&reference()), Some(&default))
        else {
            panic!("the participant's agent resolves to the default agent");
        };
        assert_eq!(executor.source, ExecutorSource::DefaultAgent);
        assert_eq!(executor.agent.as_str(), "custom-hermes");
        assert!(executor.portable_settings.is_empty());
        assert_eq!(executor.device_settings, default.settings);
    }

    #[test]
    fn an_unknown_or_custom_agent_of_a_binding_is_an_outcome_of_its_own() {
        for agent in ["future-agent", "custom-hermes"] {
            let space = tempdir().unwrap();
            catalog(
                space.path(),
                serde_json::json!({"agent": agent, "settings": []}),
            );
            assert_eq!(
                resolve_executor(space.path(), None, Some(&reference()), None),
                ExecutorResolution::UnknownAgent {
                    reference: reference(),
                    actor_owner_path: space.path().to_string_lossy().into_owned(),
                    agent: AgentId::parse(agent).unwrap(),
                }
            );
        }
    }

    #[test]
    fn an_unreadable_device_mode_blocks_the_concrete_agent() {
        let space = tempdir().unwrap();
        write_raw(
            space.path(),
            serde_json::json!({"schemaVersion": 1, "actors": [
                {"id": ACTOR, "name": "A", "adapters": [{"adapter": "codex"}]}
            ]}),
        );
        std::fs::write(
            super::super::local_path(space.path()),
            format!(r#"{{"agentActors":{{"{ACTOR}":{{"approvalMode":"future-mode"}}}}}}"#),
        )
        .unwrap();
        assert!(matches!(
            resolve_executor(space.path(), None, Some(&reference()), None),
            ExecutorResolution::ModeUnavailable { .. }
        ));
    }
}

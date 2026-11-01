//! The V1 catalog and local approval modes, read only to translate them.
//!
//! A V1 Actor holds an ordered list of bindings (the first is the primary,
//! the rest fallbacks) with `model` / `effort`, and its owner-local
//! `approvalMode` is one of three strategies Svode mapped onto each agent.
//! This version reads V1 as V2: the primary binding becomes the Actor's
//! binding with its values in the agent's terms, fallbacks are dropped, and
//! the approval mode becomes the device mode of the Actor once. The mapping
//! here is the translation only; nothing else uses it.

use serde::{Deserialize, Serialize};

use super::local::ActorMode;
use super::{
    ActorBinding, AgentActor, AgentActorCatalog, AgentSettingValue, CATALOG_SCHEMA_VERSION,
    CatalogError, ensure_agent_id, is_lowercase_ulid, reject_unknown_fields,
};
use crate::agent_adapters::{AgentAdapterKind, AgentId};

/// A V1 binding: an agent with optional closed-list selectors.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentAdapter {
    pub adapter: AgentId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

/// The V1 owner-local approval strategy of an Actor.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalMode {
    Ask,
    Auto,
    Full,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogV1 {
    #[allow(dead_code)]
    schema_version: u32,
    actors: Vec<ActorV1>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActorV1 {
    id: String,
    name: String,
    #[serde(default)]
    description: Option<String>,
    adapters: Vec<AgentAdapter>,
}

/// A V1 local row: `{"approvalMode": "ask" | "auto" | "full"}`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalApprovalV1 {
    pub approval_mode: ApprovalMode,
}

pub(crate) fn read_as_v2(value: serde_json::Value) -> Result<AgentActorCatalog, CatalogError> {
    ensure_known_shape(&value)?;
    let catalog: CatalogV1 =
        serde_json::from_value(value).map_err(|e| CatalogError::Invalid(e.to_string()))?;
    let mut ids = std::collections::HashSet::new();
    let mut actors = Vec::with_capacity(catalog.actors.len());
    for actor in catalog.actors {
        let mut agents = std::collections::HashSet::new();
        if actor.name.trim().is_empty()
            || !is_lowercase_ulid(&actor.id)
            || !ids.insert(actor.id.clone())
        {
            return Err(CatalogError::Invalid("invalid actor".into()));
        }
        if actor.adapters.is_empty() || actor.adapters.iter().any(|x| !agents.insert(&x.adapter)) {
            return Err(CatalogError::Invalid(
                "actor adapters must be unique and nonempty".into(),
            ));
        }
        let binding = translate_binding(&actor.adapters[0]);
        actors.push(AgentActor {
            id: actor.id,
            name: actor.name,
            description: actor.description,
            binding,
        });
    }
    Ok(AgentActorCatalog {
        schema_version: CATALOG_SCHEMA_VERSION,
        actors,
    })
}

/// The primary V1 binding in the agent's terms: `model` stays `model`;
/// `effort` is Codex `reasoning_effort` and Claude Code `effort`. A value the
/// agent does not declare is dropped, so the agent runs with its native
/// default: Codex `none` (it ran only in the terminal) and the effort of an
/// agent that never had an effort selector.
pub fn translate_binding(binding: &AgentAdapter) -> ActorBinding {
    let mut settings = Vec::new();
    if let Some(model) = binding
        .model
        .as_ref()
        .filter(|model| !model.trim().is_empty())
    {
        settings.push(AgentSettingValue {
            setting: "model".into(),
            value: model.clone(),
        });
    }
    let effort_setting = match binding.adapter.builtin() {
        Some(AgentAdapterKind::Codex) => Some("reasoning_effort"),
        Some(AgentAdapterKind::ClaudeCode) => Some("effort"),
        _ => None,
    };
    if let (Some(setting), Some(effort)) = (effort_setting, binding.effort.as_ref()) {
        let undeclared =
            binding.adapter.builtin() == Some(AgentAdapterKind::Codex) && effort == "none";
        if !undeclared && !effort.trim().is_empty() {
            settings.push(AgentSettingValue {
                setting: setting.into(),
                value: effort.clone(),
            });
        }
    }
    ActorBinding::Agent {
        agent: binding.adapter.clone(),
        settings,
    }
}

/// The value of the agent's `mode` setting the V1 strategy ran as, `None`
/// where the agent had no equivalent.
fn mode_equivalent(agent: AgentAdapterKind, mode: ApprovalMode) -> Option<&'static str> {
    use AgentAdapterKind as Agent;
    use ApprovalMode as Mode;
    Some(match (agent, mode) {
        (Agent::Codex, Mode::Ask) => "workspace-write",
        (Agent::Codex, Mode::Auto) => "agent",
        (Agent::Codex, Mode::Full) => "agent-full-access",
        (Agent::ClaudeCode, Mode::Ask) => "default",
        (Agent::ClaudeCode, Mode::Auto) => "auto",
        (Agent::ClaudeCode, Mode::Full) => "bypassPermissions",
        (Agent::Hermes, Mode::Ask) => "default",
        (Agent::Hermes, Mode::Auto) => "accept_edits",
        (Agent::QwenCode, Mode::Ask) => "default",
        (Agent::QwenCode, Mode::Auto) => "auto-edit",
        (Agent::QwenCode, Mode::Full) => "yolo",
        (Agent::KimiCode, Mode::Ask) => "default",
        (Agent::KimiCode, Mode::Auto) => "auto",
        (Agent::KimiCode, Mode::Full) => "yolo",
        _ => return None,
    })
}

/// The device mode a V1 approval strategy becomes for the agent of the
/// binding; the participant's agent and an agent without an equivalent get
/// none.
pub(crate) fn translate_mode(binding: &ActorBinding, approval: ApprovalMode) -> Option<ActorMode> {
    let agent = binding.agent()?;
    let value = mode_equivalent(agent.builtin()?, approval)?;
    Some(ActorMode {
        agent: agent.clone(),
        setting: "mode".into(),
        value: value.into(),
    })
}

fn ensure_known_shape(value: &serde_json::Value) -> Result<(), CatalogError> {
    const ROOT_FIELDS: &[&str] = &["schemaVersion", "actors"];
    const ACTOR_FIELDS: &[&str] = &["id", "name", "description", "adapters"];
    const ADAPTER_FIELDS: &[&str] = &["adapter", "model", "effort"];

    let Some(root) = value.as_object() else {
        return Ok(());
    };
    reject_unknown_fields(root, ROOT_FIELDS, "catalog")?;
    let Some(actors) = root.get("actors").and_then(serde_json::Value::as_array) else {
        return Ok(());
    };
    for (actor_index, actor) in actors.iter().enumerate() {
        let Some(actor) = actor.as_object() else {
            continue;
        };
        reject_unknown_fields(actor, ACTOR_FIELDS, &format!("actors[{actor_index}]"))?;
        let Some(adapters) = actor.get("adapters").and_then(serde_json::Value::as_array) else {
            continue;
        };
        for (adapter_index, adapter) in adapters.iter().enumerate() {
            let Some(adapter) = adapter.as_object() else {
                continue;
            };
            reject_unknown_fields(
                adapter,
                ADAPTER_FIELDS,
                &format!("actors[{actor_index}].adapters[{adapter_index}]"),
            )?;
            if let Some(adapter_id) = adapter.get("adapter").and_then(serde_json::Value::as_str) {
                ensure_agent_id(adapter_id)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{codex, write_raw};
    use super::super::{catalog_path, read_catalog};
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn a_v1_catalog_reads_as_v2_with_the_primary_binding_and_its_values() {
        let d = tempdir().unwrap();
        write_raw(
            d.path(),
            serde_json::json!({
                "schemaVersion": 1,
                "actors": [
                    {
                        "id": "01arz3ndektsv4rrffq69g5fav",
                        "name": "Codex",
                        "description": "Reviews",
                        "adapters": [
                            {"adapter": "codex", "model": "gpt-5.6-sol", "effort": "high"},
                            {"adapter": "claude-code", "model": "sonnet", "effort": "low"}
                        ]
                    },
                    {
                        "id": "01arz3ndektsv4rrffq69g5faw",
                        "name": "Codex none",
                        "adapters": [{"adapter": "codex", "effort": "none"}]
                    },
                    {
                        "id": "01arz3ndektsv4rrffq69g5fax",
                        "name": "Claude",
                        "adapters": [{"adapter": "claude-code", "model": "opus", "effort": "medium"}]
                    },
                    {
                        "id": "01arz3ndektsv4rrffq69g5fay",
                        "name": "Hermes",
                        "adapters": [{"adapter": "hermes", "effort": "high"}, {"adapter": "codex"}]
                    }
                ]
            }),
        );
        let before = fs::read(catalog_path(d.path())).unwrap();

        let (catalog, _) = read_catalog(d.path()).unwrap();
        assert_eq!(catalog.schema_version, 2);
        assert_eq!(
            catalog.actors[0].binding,
            codex(&[("model", "gpt-5.6-sol"), ("reasoning_effort", "high")])
        );
        assert_eq!(catalog.actors[0].description.as_deref(), Some("Reviews"));
        assert_eq!(catalog.actors[1].binding, codex(&[]));
        assert_eq!(
            catalog.actors[2].binding,
            ActorBinding::Agent {
                agent: AgentAdapterKind::ClaudeCode.id(),
                settings: vec![
                    AgentSettingValue {
                        setting: "model".into(),
                        value: "opus".into()
                    },
                    AgentSettingValue {
                        setting: "effort".into(),
                        value: "medium".into()
                    },
                ],
            }
        );
        assert_eq!(
            catalog.actors[3].binding,
            ActorBinding::Agent {
                agent: AgentAdapterKind::Hermes.id(),
                settings: Vec::new(),
            }
        );
        // Reading V1 changes nothing in the file.
        assert_eq!(fs::read(catalog_path(d.path())).unwrap(), before);
    }

    #[test]
    fn a_custom_primary_v1_binding_becomes_an_unavailable_binding_with_its_id() {
        let d = tempdir().unwrap();
        write_raw(
            d.path(),
            serde_json::json!({
                "schemaVersion": 1,
                "actors": [{
                    "id": "01arz3ndektsv4rrffq69g5fav",
                    "name": "Mine",
                    "adapters": [{"adapter": "custom-hermes"}, {"adapter": "codex"}]
                }]
            }),
        );
        let (catalog, _) = read_catalog(d.path()).unwrap();
        assert_eq!(
            catalog.actors[0].binding,
            ActorBinding::Agent {
                agent: AgentId::parse("custom-hermes").unwrap(),
                settings: Vec::new(),
            }
        );
        assert_eq!(catalog.actors[0].binding.agent().unwrap().builtin(), None);
    }

    #[test]
    fn an_unknown_v1_agent_id_is_kept_and_a_malformed_one_is_read_only() {
        let d = tempdir().unwrap();
        write_raw(
            d.path(),
            serde_json::json!({
                "schemaVersion": 1,
                "actors": [{
                    "id": "01arz3ndektsv4rrffq69g5fav",
                    "name": "Future",
                    "adapters": [{"adapter": "future-client", "model": "m1", "effort": "e1"}]
                }]
            }),
        );
        let (catalog, _) = read_catalog(d.path()).unwrap();
        assert_eq!(
            serde_json::to_value(&catalog.actors[0].binding).unwrap(),
            serde_json::json!({
                "agent": "future-client",
                "settings": [{"setting": "model", "value": "m1"}]
            })
        );

        let malformed = tempdir().unwrap();
        write_raw(
            malformed.path(),
            serde_json::json!({
                "schemaVersion": 1,
                "actors": [{
                    "id": "01arz3ndektsv4rrffq69g5fav",
                    "name": "Future",
                    "adapters": [{"adapter": "Future Client"}]
                }]
            }),
        );
        assert!(matches!(
            read_catalog(malformed.path()),
            Err(CatalogError::Compatibility(_))
        ));
        let unknown_field = tempdir().unwrap();
        write_raw(
            unknown_field.path(),
            serde_json::json!({"schemaVersion": 1, "actors": [], "futureField": true}),
        );
        assert!(matches!(
            read_catalog(unknown_field.path()),
            Err(CatalogError::Compatibility(_))
        ));
    }

    #[test]
    fn v1_rules_still_guard_the_translated_catalog() {
        let d = tempdir().unwrap();
        write_raw(
            d.path(),
            serde_json::json!({
                "schemaVersion": 1,
                "actors": [{
                    "id": "01arz3ndektsv4rrffq69g5fav",
                    "name": "Dup",
                    "adapters": [{"adapter": "codex"}, {"adapter": "codex"}]
                }]
            }),
        );
        assert!(matches!(
            read_catalog(d.path()),
            Err(CatalogError::Invalid(_))
        ));
    }

    #[test]
    fn the_approval_strategies_of_the_five_agents_translate_to_their_modes() {
        use AgentAdapterKind as Agent;
        use ApprovalMode as Mode;
        let table = [
            (
                Agent::Codex,
                ["workspace-write", "agent", "agent-full-access"],
            ),
            (Agent::ClaudeCode, ["default", "auto", "bypassPermissions"]),
            (Agent::QwenCode, ["default", "auto-edit", "yolo"]),
            (Agent::KimiCode, ["default", "auto", "yolo"]),
        ];
        for (agent, values) in table {
            for (mode, value) in [Mode::Ask, Mode::Auto, Mode::Full].into_iter().zip(values) {
                assert_eq!(
                    mode_equivalent(agent, mode),
                    Some(value),
                    "{agent:?} {mode:?}"
                );
            }
        }
        assert_eq!(mode_equivalent(Agent::Hermes, Mode::Ask), Some("default"));
        assert_eq!(
            mode_equivalent(Agent::Hermes, Mode::Auto),
            Some("accept_edits")
        );
        assert_eq!(mode_equivalent(Agent::Hermes, Mode::Full), None);
        assert_eq!(mode_equivalent(Agent::GrokBuild, Mode::Ask), None);
        assert_eq!(translate_mode(&ActorBinding::Participant, Mode::Ask), None);
    }
}

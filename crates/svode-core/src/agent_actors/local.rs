//! The device mode of Agent Actors: the value of one setting of category
//! `mode` an Actor runs with on this device, kept with the agent it was
//! chosen for in `.svode/local.json` of the catalog owner, outside Git.
//!
//! A mode chosen for another agent than the Actor's binding has now is not
//! effective, and the participant's agent has no Actor mode: it runs with
//! the mode of the device's default agent. A device translates the V1
//! `approvalMode` rows of an owner once; afterwards a missing mode is the
//! agent's native default.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::v1::{ApprovalMode, LocalApprovalV1, translate_mode};
use super::{ActorBinding, AgentActorCatalog, CatalogError, read_catalog_versioned};
use crate::agent_adapters::AgentId;
use crate::routines::local::{self as local_config, LocalConfig, LocalConfigError};

const AGENT_ACTORS_KEY: &str = "agentActors";
/// Marks the owner's local rows as V2 on this device, so the V1 translation
/// never runs twice.
const LOCAL_VERSION_KEY: &str = "agentActorsLocalVersion";
const LOCAL_VERSION: u64 = 2;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActorMode {
    /// The agent the value was chosen for.
    pub agent: AgentId,
    pub setting: String,
    pub value: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalRow {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mode: Option<ActorMode>,
}

impl From<LocalConfigError> for CatalogError {
    fn from(error: LocalConfigError) -> Self {
        match error {
            LocalConfigError::Serde(error) => CatalogError::Invalid(error.to_string()),
            error => CatalogError::Io(error.to_string()),
        }
    }
}

/// The effective modes of the Actors of `owner` on this device, by actor
/// id: only a mode chosen for the agent of the Actor's binding. Before the
/// device translated the owner's V1 rows, the translation is computed
/// without being written.
pub fn read_actor_modes(owner: &Path) -> Result<HashMap<String, ActorMode>, CatalogError> {
    let read = read_catalog_versioned(owner)?;
    let local = local_config::read(owner)?;
    let rows = stored_or_translated(&local, &read.catalog, read.file_version)?;
    Ok(effective(rows, &read.catalog))
}

/// The effective mode of one Actor of `owner` on this device.
pub fn read_actor_mode(owner: &Path, actor_id: &str) -> Result<Option<ActorMode>, CatalogError> {
    Ok(read_actor_modes(owner)?.remove(actor_id))
}

/// Writes the one-time translation of the owner's V1 `approvalMode` rows
/// into modes if this device has not written it yet: each Actor gets the
/// equivalent of its strategy for the agent of its binding, a missing row
/// of a V1 catalog meant `ask`, an agent without an equivalent gets no mode.
/// Returns whether it wrote. Nothing is written while the catalog cannot be
/// read.
pub fn translate_local_modes(owner: &Path) -> Result<bool, CatalogError> {
    if is_translated(&local_config::read(owner)?) {
        return Ok(false);
    }
    let read = read_catalog_versioned(owner)?;
    local_config::mutate_with(owner, |local| -> Result<bool, CatalogError> {
        if is_translated(local) {
            return Ok(false);
        }
        let rows = stored_or_translated(local, &read.catalog, read.file_version)?;
        write_rows(local, rows);
        Ok(true)
    })
}

/// The stored mode row of one Actor after the translation, whether or not
/// it is effective; a compound catalog write restores it if publishing the
/// catalog fails.
pub fn stored_mode(owner: &Path, actor_id: &str) -> Result<Option<ActorMode>, CatalogError> {
    translate_local_modes(owner)?;
    let local = local_config::read(owner)?;
    Ok(stored_rows(&local)?.remove(actor_id))
}

/// Stores or clears the mode of one Actor without checking the catalog: the
/// local half of a compound catalog write, which checks the Actor itself.
pub fn store_mode(
    owner: &Path,
    actor_id: &str,
    mode: Option<&ActorMode>,
) -> Result<(), CatalogError> {
    translate_local_modes(owner)?;
    local_config::mutate_with(owner, |local| -> Result<(), CatalogError> {
        let mut rows = stored_rows(local)?;
        match mode {
            Some(mode) => {
                rows.insert(actor_id.to_string(), mode.clone());
            }
            None => {
                rows.remove(actor_id);
            }
        }
        write_rows(local, rows);
        Ok(())
    })
}

/// The mode `binding` can keep: one chosen for its agent. The participant's
/// agent keeps none.
pub fn mode_for_binding(binding: &ActorBinding, mode: Option<ActorMode>) -> Option<ActorMode> {
    mode.filter(|mode| binding.agent() == Some(&mode.agent))
}

/// The local-only mode change of an existing Actor: it neither rewrites nor
/// commits the catalog. The mode must be for the agent of the Actor's
/// binding; `None` returns the Actor to the agent's native default.
pub fn set_actor_mode(
    owner: &Path,
    expected_fingerprint: &str,
    actor_id: &str,
    mode: Option<&ActorMode>,
) -> Result<String, CatalogError> {
    let read = read_catalog_versioned(owner)?;
    if read.fingerprint != expected_fingerprint {
        return Err(CatalogError::Stale);
    }
    let actor = read
        .catalog
        .actors
        .iter()
        .find(|actor| actor.id == actor_id)
        .ok_or_else(|| CatalogError::Invalid(format!("missing_actor_id: agent:{actor_id}")))?;
    if let Some(mode) = mode {
        if actor.binding.agent() != Some(&mode.agent) {
            return Err(CatalogError::Invalid(format!(
                "the mode is for {}, not for the agent of agent:{actor_id}",
                mode.agent
            )));
        }
    }
    store_mode(owner, actor_id, mode)?;
    Ok(read.fingerprint)
}

fn is_translated(local: &LocalConfig) -> bool {
    local
        .extensions
        .get(LOCAL_VERSION_KEY)
        .and_then(|value| value.as_u64())
        == Some(LOCAL_VERSION)
}

fn rows_object(
    local: &LocalConfig,
) -> Result<Option<&serde_json::Map<String, serde_json::Value>>, CatalogError> {
    match local.extensions.get(AGENT_ACTORS_KEY) {
        None => Ok(None),
        Some(value) => value
            .as_object()
            .map(Some)
            .ok_or_else(|| CatalogError::Invalid("agentActors must be an object".into())),
    }
}

fn stored_rows(local: &LocalConfig) -> Result<HashMap<String, ActorMode>, CatalogError> {
    let mut modes = HashMap::new();
    for (id, value) in rows_object(local)?.into_iter().flatten() {
        let row: LocalRow = serde_json::from_value(value.clone())
            .map_err(|e| CatalogError::Invalid(format!("local mode of agent:{id}: {e}")))?;
        if let Some(mode) = row.mode {
            modes.insert(id.clone(), mode);
        }
    }
    Ok(modes)
}

fn stored_or_translated(
    local: &LocalConfig,
    catalog: &AgentActorCatalog,
    catalog_file_version: u32,
) -> Result<HashMap<String, ActorMode>, CatalogError> {
    if is_translated(local) {
        return stored_rows(local);
    }
    let rows = rows_object(local)?;
    let mut modes = HashMap::new();
    for actor in &catalog.actors {
        let approval = match rows.and_then(|rows| rows.get(&actor.id)) {
            Some(value) => {
                serde_json::from_value::<LocalApprovalV1>(value.clone())
                    .map_err(|e| {
                        CatalogError::Invalid(format!("approval mode of agent:{}: {e}", actor.id))
                    })?
                    .approval_mode
            }
            // A V1 Actor without a row ran with `ask`; an Actor of a V2
            // catalog without a row never had a mode on this device.
            None if catalog_file_version == 1 => ApprovalMode::Ask,
            None => continue,
        };
        if let Some(mode) = translate_mode(&actor.binding, approval) {
            modes.insert(actor.id.clone(), mode);
        }
    }
    Ok(modes)
}

fn effective(
    mut rows: HashMap<String, ActorMode>,
    catalog: &AgentActorCatalog,
) -> HashMap<String, ActorMode> {
    catalog
        .actors
        .iter()
        .filter_map(|actor| {
            mode_for_binding(&actor.binding, rows.remove(&actor.id))
                .map(|mode| (actor.id.clone(), mode))
        })
        .collect()
}

fn write_rows(local: &mut LocalConfig, rows: HashMap<String, ActorMode>) {
    let mut rows = rows.into_iter().collect::<Vec<_>>();
    rows.sort_by(|left, right| left.0.cmp(&right.0));
    let object = rows
        .into_iter()
        .map(|(id, mode)| {
            (
                id,
                serde_json::to_value(LocalRow { mode: Some(mode) }).expect("local row"),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    if object.is_empty() {
        local.extensions.remove(AGENT_ACTORS_KEY);
    } else {
        local
            .extensions
            .insert(AGENT_ACTORS_KEY.into(), serde_json::Value::Object(object));
    }
    local
        .extensions
        .insert(LOCAL_VERSION_KEY.into(), LOCAL_VERSION.into());
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{codex, write_raw};
    use super::super::{local_path, read_catalog};
    use super::*;
    use crate::agent_adapters::AgentAdapterKind;
    use std::fs;
    use tempfile::tempdir;

    const ACTOR: &str = "01arz3ndektsv4rrffq69g5fav";

    fn mode(agent: AgentAdapterKind, value: &str) -> ActorMode {
        ActorMode {
            agent: agent.id(),
            setting: "mode".into(),
            value: value.into(),
        }
    }

    fn v1_actor(id: &str, agent: &str) -> serde_json::Value {
        serde_json::json!({"id": id, "name": agent, "adapters": [{"adapter": agent}]})
    }

    fn write_local(owner: &Path, value: serde_json::Value) {
        fs::create_dir_all(owner.join(".svode")).unwrap();
        fs::write(local_path(owner), serde_json::to_vec(&value).unwrap()).unwrap();
    }

    fn local_json(owner: &Path) -> serde_json::Value {
        serde_json::from_slice(&fs::read(local_path(owner)).unwrap()).unwrap()
    }

    #[test]
    fn v1_approval_modes_of_the_five_agents_translate_once_into_device_modes() {
        let d = tempdir().unwrap();
        let ids = [
            "01arz3ndektsv4rrffq69g5fa0",
            "01arz3ndektsv4rrffq69g5fa1",
            "01arz3ndektsv4rrffq69g5fa2",
            "01arz3ndektsv4rrffq69g5fa3",
            "01arz3ndektsv4rrffq69g5fa4",
            "01arz3ndektsv4rrffq69g5fa5",
            "01arz3ndektsv4rrffq69g5fa6",
        ];
        write_raw(
            d.path(),
            serde_json::json!({"schemaVersion": 1, "actors": [
                v1_actor(ids[0], "codex"),
                v1_actor(ids[1], "claude-code"),
                v1_actor(ids[2], "hermes"),
                v1_actor(ids[3], "qwen-code"),
                v1_actor(ids[4], "kimi-code"),
                v1_actor(ids[5], "hermes"),
                v1_actor(ids[6], "grok-build"),
            ]}),
        );
        let catalog_before = fs::read(super::super::catalog_path(d.path())).unwrap();
        write_local(
            d.path(),
            serde_json::json!({
                "agentActors": {
                    ids[0]: {"approvalMode": "full"},
                    ids[1]: {"approvalMode": "auto"},
                    ids[2]: {"approvalMode": "auto"},
                    // ids[3] has no row: it ran with `ask`.
                    ids[4]: {"approvalMode": "full"},
                    ids[5]: {"approvalMode": "full"},
                    ids[6]: {"approvalMode": "ask"},
                },
                "custom": true
            }),
        );

        // Before the translation is written, reads compute it.
        let expected = HashMap::from([
            (
                ids[0].to_string(),
                mode(AgentAdapterKind::Codex, "agent-full-access"),
            ),
            (
                ids[1].to_string(),
                mode(AgentAdapterKind::ClaudeCode, "auto"),
            ),
            (
                ids[2].to_string(),
                mode(AgentAdapterKind::Hermes, "accept_edits"),
            ),
            (
                ids[3].to_string(),
                mode(AgentAdapterKind::QwenCode, "default"),
            ),
            (ids[4].to_string(), mode(AgentAdapterKind::KimiCode, "yolo")),
        ]);
        assert_eq!(read_actor_modes(d.path()).unwrap(), expected);

        assert!(translate_local_modes(d.path()).unwrap());
        assert_eq!(read_actor_modes(d.path()).unwrap(), expected);
        let local = local_json(d.path());
        assert_eq!(local["agentActorsLocalVersion"], 2);
        assert_eq!(local["custom"], true);
        assert!(
            local["agentActors"][ids[5]].is_null(),
            "Hermes full: no mode"
        );
        assert!(local["agentActors"][ids[6]].is_null());
        assert!(local.to_string().find("approvalMode").is_none());
        // The catalog is not touched by the translation.
        assert_eq!(
            fs::read(super::super::catalog_path(d.path())).unwrap(),
            catalog_before
        );

        // It never runs again: a missing mode now means the native default.
        store_mode(d.path(), ids[3], None).unwrap();
        assert!(!translate_local_modes(d.path()).unwrap());
        assert_eq!(read_actor_mode(d.path(), ids[3]).unwrap(), None);
    }

    #[test]
    fn a_v2_actor_without_a_row_has_no_mode_before_the_translation() {
        let d = tempdir().unwrap();
        write_raw(
            d.path(),
            serde_json::json!({"schemaVersion": 2, "actors": [
                {"id": ACTOR, "name": "A", "binding": {"agent": "codex", "settings": []}}
            ]}),
        );
        assert_eq!(read_actor_mode(d.path(), ACTOR).unwrap(), None);
    }

    #[test]
    fn a_custom_v1_binding_gets_no_mode() {
        let d = tempdir().unwrap();
        write_raw(
            d.path(),
            serde_json::json!({"schemaVersion": 1, "actors": [{
                "id": ACTOR, "name": "Mine",
                "adapters": [{"adapter": "custom-hermes"}, {"adapter": "codex"}]
            }]}),
        );
        write_local(
            d.path(),
            serde_json::json!({"agentActors": {ACTOR: {"approvalMode": "ask"}}}),
        );
        assert_eq!(read_actor_mode(d.path(), ACTOR).unwrap(), None);
    }

    #[test]
    fn changing_the_agent_of_the_binding_leaves_the_mode_unselected() {
        let d = tempdir().unwrap();
        write_raw(
            d.path(),
            serde_json::json!({"schemaVersion": 2, "actors": [
                {"id": ACTOR, "name": "A", "binding": {"agent": "codex", "settings": []}}
            ]}),
        );
        let (_, fingerprint) = read_catalog(d.path()).unwrap();
        let codex_mode = mode(AgentAdapterKind::Codex, "read-only");
        set_actor_mode(d.path(), &fingerprint, ACTOR, Some(&codex_mode)).unwrap();
        assert_eq!(
            read_actor_mode(d.path(), ACTOR).unwrap(),
            Some(codex_mode.clone())
        );

        write_raw(
            d.path(),
            serde_json::json!({"schemaVersion": 2, "actors": [
                {"id": ACTOR, "name": "A", "binding": {"agent": "claude-code", "settings": []}}
            ]}),
        );
        assert_eq!(read_actor_mode(d.path(), ACTOR).unwrap(), None);
        assert_eq!(
            mode_for_binding(&codex(&[]), Some(codex_mode.clone())),
            Some(codex_mode.clone())
        );
        assert_eq!(
            mode_for_binding(&ActorBinding::Participant, Some(codex_mode)),
            None
        );
    }

    #[test]
    fn a_local_only_mode_change_is_checked_and_leaves_the_catalog_as_it_is() {
        let d = tempdir().unwrap();
        write_raw(
            d.path(),
            serde_json::json!({"schemaVersion": 2, "actors": [
                {"id": ACTOR, "name": "A", "binding": {"participant": true}}
            ]}),
        );
        let before = fs::read(super::super::catalog_path(d.path())).unwrap();
        let (_, fingerprint) = read_catalog(d.path()).unwrap();
        assert!(matches!(
            set_actor_mode(
                d.path(),
                &fingerprint,
                ACTOR,
                Some(&mode(AgentAdapterKind::Codex, "agent"))
            ),
            Err(CatalogError::Invalid(_))
        ));
        assert!(matches!(
            set_actor_mode(d.path(), "stale", ACTOR, None),
            Err(CatalogError::Stale)
        ));
        assert_eq!(
            set_actor_mode(d.path(), &fingerprint, ACTOR, None).unwrap(),
            fingerprint
        );
        assert_eq!(
            fs::read(super::super::catalog_path(d.path())).unwrap(),
            before
        );
    }

    #[test]
    fn an_unreadable_v1_row_blocks_the_translation_without_writing() {
        let d = tempdir().unwrap();
        write_raw(
            d.path(),
            serde_json::json!({"schemaVersion": 1, "actors": [v1_actor(ACTOR, "codex")]}),
        );
        write_local(
            d.path(),
            serde_json::json!({"agentActors": {ACTOR: {"approvalMode": "future-mode"}}}),
        );
        let before = fs::read(local_path(d.path())).unwrap();
        assert!(matches!(
            read_actor_mode(d.path(), ACTOR),
            Err(CatalogError::Invalid(_))
        ));
        assert!(translate_local_modes(d.path()).is_err());
        assert_eq!(fs::read(local_path(d.path())).unwrap(), before);
    }
}

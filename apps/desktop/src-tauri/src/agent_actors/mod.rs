//! Desktop-owned Agent Actor catalog mutation over the shared core read owner.
//!
//! The portable catalog and the device mode of its Actors stay separate
//! persistence domains: the catalog is shareable Git content, while modes
//! are local-only state. Reading, resolution, catalog validation and the
//! mode overlay belong to `svode_core::agent_actors`.

pub mod commands;

use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};

use svode_core::agent_actors::local::{
    ActorMode, mode_for_binding, store_mode, stored_mode, translate_local_modes,
};
use svode_core::agent_actors::{
    AgentActor, AgentActorCatalog, CatalogError, catalog_path, check_binding_write, read_catalog,
    validate_catalog,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CatalogMutation {
    Create(AgentActor),
    Update(AgentActor),
    Reorder(Vec<String>),
    Delete(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AgentActorMutationInput {
    /// `mode`: the device mode of the new Actor; one for another agent than
    /// its binding, or for the participant's agent, is not kept.
    Create {
        actor: AgentActor,
        #[serde(default)]
        mode: Option<ActorMode>,
    },
    /// `mode`: the device mode after the update, `None` for the agent's
    /// native default; it is not kept once the binding has another agent.
    Update {
        actor: AgentActor,
        #[serde(default)]
        mode: Option<ActorMode>,
    },
    Reorder {
        actor_ids: Vec<String>,
    },
    Delete {
        actor_id: String,
    },
    /// The local-only mode change of an existing Actor.
    SetMode {
        actor_id: String,
        #[serde(default)]
        mode: Option<ActorMode>,
    },
}

impl AgentActorMutationInput {
    pub(crate) fn create_actor_id(&self) -> Option<&str> {
        match self {
            Self::Create { actor, .. } => Some(&actor.id),
            _ => None,
        }
    }

    fn into_compound(self) -> CompoundCatalogMutation {
        match self {
            Self::Create { actor, mode } => CompoundCatalogMutation {
                mode: Some(mode_for_binding(&actor.binding, mode)),
                mutation: CatalogMutation::Create(actor),
            },
            Self::Update { actor, mode } => CompoundCatalogMutation {
                mode: Some(mode_for_binding(&actor.binding, mode)),
                mutation: CatalogMutation::Update(actor),
            },
            Self::Reorder { actor_ids } => CompoundCatalogMutation {
                mutation: CatalogMutation::Reorder(actor_ids),
                mode: None,
            },
            Self::Delete { actor_id } => CompoundCatalogMutation {
                mutation: CatalogMutation::Delete(actor_id),
                mode: None,
            },
            Self::SetMode { .. } => {
                unreachable!("local-only mode changes are handled before catalog mutation")
            }
        }
    }
}

/// The portable operation and its optional owner-local mode change are
/// intentionally one domain operation. `mode: None` leaves the overlay
/// untouched (reorder/delete), `Some(None)` clears the mode; delete removes
/// a stale record only after the portable catalog has been published.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompoundCatalogMutation {
    pub mutation: CatalogMutation,
    pub mode: Option<Option<ActorMode>>,
}

#[cfg(test)]
pub fn mutate_catalog(
    owner: &Path,
    expected_fingerprint: &str,
    mutation: CatalogMutation,
) -> Result<AgentActorCatalog, CatalogError> {
    let (next, actual) = next_catalog(owner, mutation)?;
    if actual != expected_fingerprint {
        return Err(CatalogError::Stale);
    }
    publish_catalog(owner, &next)?;
    Ok(next)
}

/// Apply a catalog mutation without ever exposing a new/edited portable actor
/// when its local mode cannot be saved. The prior local mode is restored if
/// the following portable atomic replace fails. The device translates the
/// owner's V1 approval modes before the first write, so a translation never
/// lands on an Actor whose agent this write changes.
pub fn mutate_catalog_compound(
    owner: &Path,
    expected_fingerprint: &str,
    compound: CompoundCatalogMutation,
) -> Result<AgentActorCatalog, CatalogError> {
    let (next, actual) = next_catalog(owner, compound.mutation.clone())?;
    if actual != expected_fingerprint {
        return Err(CatalogError::Stale);
    }
    translate_local_modes(owner)?;

    let actor_id = compound
        .mode
        .as_ref()
        .map(|_| {
            mutation_actor_id(&compound.mutation)
                .ok_or_else(|| CatalogError::Invalid("a mode needs an actor id".into()))
        })
        .transpose()?;
    let local_before = actor_id
        .map(|actor_id| stored_mode(owner, actor_id))
        .transpose()?;
    if let (Some(mode), Some(actor_id)) = (&compound.mode, actor_id) {
        store_mode(owner, actor_id, mode.as_ref())?;
    }

    if let Err(error) = publish_catalog(owner, &next) {
        if let Some(actor_id) = actor_id {
            store_mode(owner, actor_id, local_before.flatten().as_ref())?;
        }
        return Err(error);
    }

    if matches!(compound.mutation, CatalogMutation::Delete(_)) {
        if let Some(id) = mutation_actor_id(&compound.mutation) {
            if let Err(error) = store_mode(owner, id, None) {
                tracing::warn!(
                    "agent actor catalog was deleted but local mode cleanup failed: {error}"
                );
            }
        }
    }
    Ok(next)
}

fn next_catalog(
    owner: &Path,
    mutation: CatalogMutation,
) -> Result<(AgentActorCatalog, String), CatalogError> {
    let (mut catalog, fingerprint) = read_catalog(owner)?;
    match mutation {
        CatalogMutation::Create(actor) => {
            let actor = normalize_actor(actor);
            if catalog.actors.iter().any(|a| a.id == actor.id) {
                return Err(CatalogError::Invalid("duplicate actor id".into()));
            }
            check_binding_write(None, &actor.binding)?;
            catalog.actors.push(actor);
        }
        CatalogMutation::Update(actor) => {
            let actor = normalize_actor(actor);
            let item = catalog
                .actors
                .iter_mut()
                .find(|a| a.id == actor.id)
                .ok_or_else(|| CatalogError::Invalid("actor not found".into()))?;
            check_binding_write(Some(&item.binding), &actor.binding)?;
            *item = actor;
        }
        CatalogMutation::Delete(id) => catalog.actors.retain(|a| a.id != id),
        CatalogMutation::Reorder(ids) => {
            if ids.len() != catalog.actors.len()
                || ids.iter().collect::<HashSet<_>>().len() != ids.len()
            {
                return Err(CatalogError::Invalid("invalid actor order".into()));
            }
            let mut by_id: HashMap<_, _> = catalog
                .actors
                .drain(..)
                .map(|a| (a.id.clone(), a))
                .collect();
            catalog.actors = ids
                .into_iter()
                .map(|id| {
                    by_id.remove(&id).ok_or_else(|| {
                        CatalogError::Invalid("order references missing actor".into())
                    })
                })
                .collect::<Result<_, _>>()?;
        }
    }
    validate_catalog(&catalog)?;
    Ok((catalog, fingerprint))
}

fn publish_catalog(owner: &Path, catalog: &AgentActorCatalog) -> Result<(), CatalogError> {
    let path = catalog_path(owner);
    if catalog.actors.is_empty() {
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(ref e) if e.kind() == ErrorKind::NotFound => Ok(()),
            Err(e) => Err(CatalogError::Io(e.to_string())),
        }
    } else {
        atomic_write(
            &path,
            &serde_json::to_vec_pretty(catalog)
                .map_err(|e| CatalogError::Invalid(e.to_string()))?,
        )
    }
}

fn mutation_actor_id(mutation: &CatalogMutation) -> Option<&str> {
    match mutation {
        CatalogMutation::Create(actor) | CatalogMutation::Update(actor) => Some(&actor.id),
        CatalogMutation::Delete(id) => Some(id),
        CatalogMutation::Reorder(_) => None,
    }
}

fn normalize_actor(mut actor: AgentActor) -> AgentActor {
    actor.name = actor.name.trim().to_string();
    actor.description = actor
        .description
        .map(|description| description.trim().to_string())
        .filter(|description| !description.is_empty());
    actor
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), CatalogError> {
    let parent = path
        .parent()
        .ok_or_else(|| CatalogError::Io("missing parent".into()))?;
    fs::create_dir_all(parent).map_err(|e| CatalogError::Io(e.to_string()))?;
    let temp = parent.join(format!(".agent-actors-{}.tmp", ulid::Ulid::new()));
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|e| CatalogError::Io(e.to_string()))?;
    f.write_all(bytes)
        .map_err(|e| CatalogError::Io(e.to_string()))?;
    f.sync_all().map_err(|e| CatalogError::Io(e.to_string()))?;
    fs::rename(&temp, path).map_err(|e| CatalogError::Io(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use svode_core::agent_actors::local::{read_actor_mode, set_actor_mode};
    use svode_core::agent_actors::{ActorBinding, AgentSettingValue};
    use svode_core::agent_adapters::{AgentAdapterKind, AgentId};
    use tempfile::tempdir;

    fn codex(settings: &[(&str, &str)]) -> ActorBinding {
        ActorBinding::Agent {
            agent: AgentAdapterKind::Codex.id(),
            settings: settings
                .iter()
                .map(|(setting, value)| AgentSettingValue {
                    setting: (*setting).into(),
                    value: (*value).into(),
                })
                .collect(),
        }
    }

    fn actor(id: &str) -> AgentActor {
        AgentActor {
            id: id.into(),
            name: "A".into(),
            description: None,
            binding: codex(&[("model", "future-model")]),
        }
    }

    fn codex_mode(value: &str) -> ActorMode {
        ActorMode {
            agent: AgentAdapterKind::Codex.id(),
            setting: "mode".into(),
            value: value.into(),
        }
    }

    fn compound(
        mutation: CatalogMutation,
        mode: Option<Option<ActorMode>>,
    ) -> CompoundCatalogMutation {
        CompoundCatalogMutation { mutation, mode }
    }

    fn written(owner: &Path) -> serde_json::Value {
        serde_json::from_slice(&fs::read(catalog_path(owner)).unwrap()).unwrap()
    }

    #[test]
    fn schema_and_stale_are_guarded() {
        let d = tempdir().unwrap();
        let (_, fp) = read_catalog(d.path()).unwrap();
        let id = "01arZ3ndektsv4rrffq69g5fav".to_lowercase();
        let c = mutate_catalog(d.path(), &fp, CatalogMutation::Create(actor(&id))).unwrap();
        assert_eq!(c.actors.len(), 1);
        assert!(matches!(
            mutate_catalog(d.path(), &fp, CatalogMutation::Delete(id)),
            Err(CatalogError::Stale)
        ));
    }

    /// Reading V1 writes nothing; the next write of the catalog writes V2
    /// with the primary binding, its values and no fallback.
    #[test]
    fn a_write_after_reading_v1_publishes_v2() {
        let d = tempdir().unwrap();
        let path = catalog_path(d.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let first = "01arz3ndektsv4rrffq69g5fav";
        let other = "01arz3ndektsv4rrffq69g5faw";
        let v1 = serde_json::json!({
            "schemaVersion": 1,
            "actors": [
                {
                    "id": first,
                    "name": "Codex",
                    "adapters": [
                        {"adapter": "codex", "model": "gpt-5.6-sol", "effort": "none"},
                        {"adapter": "claude-code", "model": "sonnet"}
                    ]
                },
                {"id": other, "name": "Other", "adapters": [{"adapter": "claude-code", "effort": "high"}]}
            ]
        })
        .to_string();
        fs::write(&path, &v1).unwrap();
        let (catalog, fp) = read_catalog(d.path()).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), v1);

        let mut renamed = catalog.actors[1].clone();
        renamed.name = "Renamed".into();
        mutate_catalog(d.path(), &fp, CatalogMutation::Update(renamed)).unwrap();
        assert_eq!(
            written(d.path()),
            serde_json::json!({
                "schemaVersion": 2,
                "actors": [
                    {
                        "id": first,
                        "name": "Codex",
                        "binding": {"agent": "codex", "settings": [
                            {"setting": "model", "value": "gpt-5.6-sol"}
                        ]}
                    },
                    {
                        "id": other,
                        "name": "Renamed",
                        "binding": {"agent": "claude-code", "settings": [
                            {"setting": "effort", "value": "high"}
                        ]}
                    }
                ]
            })
        );
    }

    /// Stage 10 `03` A7: a binding of an agent another Svode version knows,
    /// or the custom primary binding a V1 catalog kept, stays in the catalog
    /// unchanged while the other actors are edited, and its fallback is
    /// dropped rather than run in its place.
    #[test]
    fn an_unavailable_binding_survives_edits_of_other_actors() {
        let d = tempdir().unwrap();
        let path = catalog_path(d.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let future = "01arz3ndektsv4rrffq69g5fav";
        let custom = "01arz3ndektsv4rrffq69g5fax";
        let other = "01arz3ndektsv4rrffq69g5faw";
        fs::write(
            &path,
            serde_json::json!({
                "schemaVersion": 1,
                "actors": [
                    {
                        "id": future,
                        "name": "Future",
                        "adapters": [
                            {"adapter": "future-agent", "model": "m", "effort": "e"},
                            {"adapter": "gemini-cli"}
                        ]
                    },
                    {
                        "id": custom,
                        "name": "Mine",
                        "adapters": [{"adapter": "custom-hermes"}, {"adapter": "codex"}]
                    },
                    {"id": other, "name": "Other", "adapters": [{"adapter": "codex"}]}
                ]
            })
            .to_string(),
        )
        .unwrap();

        let (catalog, fp) = read_catalog(d.path()).unwrap();
        assert_eq!(catalog.actors.len(), 3);
        let mut edited = catalog.actors[2].clone();
        edited.name = "Renamed".into();
        mutate_catalog(d.path(), &fp, CatalogMutation::Update(edited)).unwrap();

        let value = written(d.path());
        assert_eq!(
            value["actors"][0]["binding"],
            serde_json::json!({"agent": "future-agent", "settings": [
                {"setting": "model", "value": "m"}
            ]})
        );
        assert_eq!(
            value["actors"][1]["binding"],
            serde_json::json!({"agent": "custom-hermes", "settings": []})
        );
        assert_eq!(value["actors"][2]["name"], "Renamed");

        // Renaming the custom Actor keeps its binding; a new custom binding
        // is refused.
        let (catalog, fp) = read_catalog(d.path()).unwrap();
        let mut renamed = catalog.actors[1].clone();
        renamed.name = "Still mine".into();
        mutate_catalog(d.path(), &fp, CatalogMutation::Update(renamed)).unwrap();
        assert_eq!(
            written(d.path())["actors"][1]["binding"]["agent"],
            "custom-hermes"
        );
    }

    /// A custom agent's id never reaches the portable catalog (A2, A7).
    #[test]
    fn a_custom_agent_binding_is_refused_and_the_catalog_stays_as_it_was() {
        let d = tempdir().unwrap();
        let (_, fp) = read_catalog(d.path()).unwrap();
        let id = "01arz3ndektsv4rrffq69g5fav".to_string();
        let mut custom = actor(&id);
        custom.binding = ActorBinding::Agent {
            agent: AgentId::parse("custom-hermes").unwrap(),
            settings: Vec::new(),
        };
        let refused = mutate_catalog_compound(
            d.path(),
            &fp,
            compound(CatalogMutation::Create(custom.clone()), Some(None)),
        );
        assert!(matches!(refused, Err(CatalogError::Invalid(_))));
        assert!(!catalog_path(d.path()).exists());

        mutate_catalog_compound(
            d.path(),
            &fp,
            compound(CatalogMutation::Create(actor(&id)), None),
        )
        .unwrap();
        let before = fs::read(catalog_path(d.path())).unwrap();
        let (_, fp) = read_catalog(d.path()).unwrap();
        assert!(matches!(
            mutate_catalog_compound(
                d.path(),
                &fp,
                compound(CatalogMutation::Update(custom), None),
            ),
            Err(CatalogError::Invalid(_))
        ));
        assert_eq!(fs::read(catalog_path(d.path())).unwrap(), before);
    }

    #[test]
    fn compound_create_writes_the_local_mode_and_delete_cleans_it() {
        let d = tempdir().unwrap();
        let (_, fp) = read_catalog(d.path()).unwrap();
        let id = "01arz3ndektsv4rrffq69g5fav".to_string();
        mutate_catalog_compound(
            d.path(),
            &fp,
            compound(
                CatalogMutation::Create(actor(&id)),
                Some(Some(codex_mode("agent"))),
            ),
        )
        .unwrap();
        assert_eq!(
            read_actor_mode(d.path(), &id).unwrap(),
            Some(codex_mode("agent"))
        );
        // The mode never reaches the portable catalog.
        assert!(
            !written(d.path())
                .to_string()
                .contains("\"agent\":\"codex\",\"setting\"")
        );
        assert!(
            !fs::read_to_string(catalog_path(d.path()))
                .unwrap()
                .contains("\"mode\"")
        );
        let (_, fp) = read_catalog(d.path()).unwrap();
        mutate_catalog_compound(
            d.path(),
            &fp,
            compound(CatalogMutation::Delete(id.clone()), None),
        )
        .unwrap();
        assert_eq!(read_actor_mode(d.path(), &id).unwrap(), None);
    }

    #[test]
    fn changing_the_agent_of_the_binding_leaves_the_mode_unselected() {
        let d = tempdir().unwrap();
        let (_, fp) = read_catalog(d.path()).unwrap();
        let id = "01arz3ndektsv4rrffq69g5fav".to_string();
        let created = AgentActorMutationInput::Create {
            actor: actor(&id),
            mode: Some(codex_mode("read-only")),
        };
        mutate_catalog_compound(d.path(), &fp, created.into_compound()).unwrap();

        let mut claude = actor(&id);
        claude.binding = ActorBinding::Agent {
            agent: AgentAdapterKind::ClaudeCode.id(),
            settings: Vec::new(),
        };
        // The window still holds the previous mode; it is not kept.
        let updated = AgentActorMutationInput::Update {
            actor: claude,
            mode: Some(codex_mode("read-only")),
        };
        let (_, fp) = read_catalog(d.path()).unwrap();
        mutate_catalog_compound(d.path(), &fp, updated.into_compound()).unwrap();
        assert_eq!(read_actor_mode(d.path(), &id).unwrap(), None);
        assert_eq!(
            svode_core::agent_actors::local::stored_mode(d.path(), &id).unwrap(),
            None
        );
    }

    #[test]
    fn the_first_write_translates_the_v1_approval_modes_before_the_agent_changes() {
        let d = tempdir().unwrap();
        let path = catalog_path(d.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let id = "01arz3ndektsv4rrffq69g5fav";
        let other = "01arz3ndektsv4rrffq69g5faw";
        fs::write(
            &path,
            serde_json::json!({"schemaVersion": 1, "actors": [
                {"id": id, "name": "A", "adapters": [{"adapter": "codex"}]},
                {"id": other, "name": "B", "adapters": [{"adapter": "codex"}]}
            ]})
            .to_string(),
        )
        .unwrap();
        fs::write(
            svode_core::agent_actors::local_path(d.path()),
            serde_json::json!({"agentActors": {id: {"approvalMode": "full"}}}).to_string(),
        )
        .unwrap();
        let (catalog, fp) = read_catalog(d.path()).unwrap();
        let mut hermes = catalog.actors[0].clone();
        hermes.binding = ActorBinding::Agent {
            agent: AgentAdapterKind::Hermes.id(),
            settings: Vec::new(),
        };
        mutate_catalog_compound(
            d.path(),
            &fp,
            AgentActorMutationInput::Update {
                actor: hermes,
                mode: None,
            }
            .into_compound(),
        )
        .unwrap();
        assert_eq!(read_actor_mode(d.path(), id).unwrap(), None);
        // The untouched V1 Actor without a record keeps the `ask` equivalent.
        assert_eq!(
            read_actor_mode(d.path(), other).unwrap(),
            Some(codex_mode("workspace-write"))
        );
    }

    #[test]
    fn local_only_mode_preserves_catalog_and_rejects_stale_fingerprint() {
        let d = tempdir().unwrap();
        let id = "01arz3ndektsv4rrffq69g5fav".to_string();
        let (_, initial_fingerprint) = read_catalog(d.path()).unwrap();
        mutate_catalog(
            d.path(),
            &initial_fingerprint,
            CatalogMutation::Create(actor(&id)),
        )
        .unwrap();
        let catalog_before = fs::read(catalog_path(d.path())).unwrap();
        let (_, fingerprint) = read_catalog(d.path()).unwrap();

        assert_eq!(
            set_actor_mode(d.path(), &fingerprint, &id, Some(&codex_mode("agent"))).unwrap(),
            fingerprint
        );
        assert_eq!(fs::read(catalog_path(d.path())).unwrap(), catalog_before);
        assert_eq!(
            read_actor_mode(d.path(), &id).unwrap(),
            Some(codex_mode("agent"))
        );

        assert!(matches!(
            set_actor_mode(d.path(), &initial_fingerprint, &id, None),
            Err(CatalogError::Stale)
        ));
        assert_eq!(
            read_actor_mode(d.path(), &id).unwrap(),
            Some(codex_mode("agent"))
        );
    }

    #[test]
    fn mutations_normalize_human_text_fields() {
        let d = tempdir().unwrap();
        let id = "01arz3ndektsv4rrffq69g5fav";
        let (_, fingerprint) = read_catalog(d.path()).unwrap();
        let mut value = actor(id);
        value.name = "  Documentation Agent  ".into();
        value.description = Some("   ".into());
        let catalog =
            mutate_catalog(d.path(), &fingerprint, CatalogMutation::Create(value)).unwrap();
        assert_eq!(catalog.actors[0].name, "Documentation Agent");
        assert_eq!(catalog.actors[0].description, None);
    }

    #[test]
    fn catalog_crud_preserves_explicit_order_and_stable_identity() {
        let d = tempdir().unwrap();
        let first_id = "01arz3ndektsv4rrffq69g5fav";
        let second_id = "01arz3ndektsv4rrffq69g5faw";
        let (_, fingerprint) = read_catalog(d.path()).unwrap();
        mutate_catalog(
            d.path(),
            &fingerprint,
            CatalogMutation::Create(actor(first_id)),
        )
        .unwrap();
        let (_, fingerprint) = read_catalog(d.path()).unwrap();
        let mut participant = actor(second_id);
        participant.binding = ActorBinding::Participant;
        mutate_catalog(d.path(), &fingerprint, CatalogMutation::Create(participant)).unwrap();
        let (_, fingerprint) = read_catalog(d.path()).unwrap();
        let reordered = mutate_catalog(
            d.path(),
            &fingerprint,
            CatalogMutation::Reorder(vec![second_id.into(), first_id.into()]),
        )
        .unwrap();
        assert_eq!(reordered.actors[0].id, second_id);
        assert_eq!(reordered.actors[0].binding, ActorBinding::Participant);

        let (_, fingerprint) = read_catalog(d.path()).unwrap();
        let mut updated = reordered.actors[1].clone();
        updated.name = "Renamed".into();
        let updated =
            mutate_catalog(d.path(), &fingerprint, CatalogMutation::Update(updated)).unwrap();
        assert_eq!(updated.actors[1].id, first_id);
        assert_eq!(updated.actors[1].name, "Renamed");

        let (_, fingerprint) = read_catalog(d.path()).unwrap();
        let deleted = mutate_catalog(
            d.path(),
            &fingerprint,
            CatalogMutation::Delete(second_id.into()),
        )
        .unwrap();
        assert_eq!(deleted.actors.len(), 1);
        assert_eq!(deleted.actors[0].id, first_id);
    }
}

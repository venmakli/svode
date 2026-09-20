//! Desktop-owned Agent Actor catalog mutation over the shared core read owner.
//!
//! The portable catalog and its local approval overlay stay separate
//! persistence domains: the catalog is shareable Git content, while approvals
//! are local-only state. Reading, resolution and catalog validation belong to
//! `svode_core::agent_actors`.

pub mod commands;
#[allow(dead_code)]
pub mod launch;

use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};

use svode_core::agent_actors::{
    AgentActor, AgentActorCatalog, ApprovalMode, CatalogError, catalog_path, read_catalog,
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
    Create {
        actor: AgentActor,
        approval_mode: ApprovalMode,
    },
    Update {
        actor: AgentActor,
        approval_mode: ApprovalMode,
    },
    Reorder {
        actor_ids: Vec<String>,
    },
    Delete {
        actor_id: String,
    },
    SetApproval {
        actor_id: String,
        approval_mode: ApprovalMode,
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
            Self::Create {
                actor,
                approval_mode,
            } => CompoundCatalogMutation {
                mutation: CatalogMutation::Create(actor),
                approval_mode: Some(approval_mode),
            },
            Self::Update {
                actor,
                approval_mode,
            } => CompoundCatalogMutation {
                mutation: CatalogMutation::Update(actor),
                approval_mode: Some(approval_mode),
            },
            Self::Reorder { actor_ids } => CompoundCatalogMutation {
                mutation: CatalogMutation::Reorder(actor_ids),
                approval_mode: None,
            },
            Self::Delete { actor_id } => CompoundCatalogMutation {
                mutation: CatalogMutation::Delete(actor_id),
                approval_mode: None,
            },
            Self::SetApproval { .. } => {
                unreachable!("local-only approval changes are handled before catalog mutation")
            }
        }
    }
}

/// The portable operation and its optional owner-local approval change are
/// intentionally one domain operation.  `approval_mode: None` leaves the
/// overlay untouched (reorder/delete); delete removes a stale row only after
/// the portable catalog has been published.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompoundCatalogMutation {
    pub mutation: CatalogMutation,
    pub approval_mode: Option<ApprovalMode>,
}

#[cfg(test)]
pub fn mutate_catalog(
    owner: &Path,
    expected_fingerprint: &str,
    mutation: CatalogMutation,
) -> Result<AgentActorCatalog, CatalogError> {
    let (mut catalog, actual) = read_catalog(owner)?;
    if actual != expected_fingerprint {
        return Err(CatalogError::Stale);
    }
    match mutation {
        CatalogMutation::Create(actor) => {
            let actor = normalize_actor(actor);
            if catalog.actors.iter().any(|a| a.id == actor.id) {
                return Err(CatalogError::Invalid("duplicate actor id".into()));
            }
            catalog.actors.push(actor);
        }
        CatalogMutation::Update(actor) => {
            let actor = normalize_actor(actor);
            let item = catalog
                .actors
                .iter_mut()
                .find(|a| a.id == actor.id)
                .ok_or_else(|| CatalogError::Invalid("actor not found".into()))?;
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
    if catalog.actors.is_empty() {
        let path = catalog_path(owner);
        if path.exists() {
            fs::remove_file(path).map_err(|e| CatalogError::Io(e.to_string()))?;
        }
    } else {
        atomic_write(
            &catalog_path(owner),
            &serde_json::to_vec_pretty(&catalog)
                .map_err(|e| CatalogError::Invalid(e.to_string()))?,
        )?;
    }
    Ok(catalog)
}

/// Apply a catalog mutation without ever exposing a new/edited portable actor
/// when its local consent cannot be saved. The prior local bytes are restored
/// if the following portable atomic replace fails.
pub fn mutate_catalog_compound(
    owner: &Path,
    expected_fingerprint: &str,
    compound: CompoundCatalogMutation,
) -> Result<AgentActorCatalog, CatalogError> {
    let (next, actual) = next_catalog(owner, compound.mutation.clone())?;
    if actual != expected_fingerprint {
        return Err(CatalogError::Stale);
    }

    let actor_id = compound
        .approval_mode
        .map(|_| {
            mutation_actor_id(&compound.mutation)
                .ok_or_else(|| CatalogError::Invalid("approval needs an actor id".into()))
        })
        .transpose()?;
    let local_before = actor_id
        .map(|actor_id| read_local_actor_value(owner, actor_id))
        .transpose()?;
    if let Some(mode) = compound.approval_mode {
        let actor_id = actor_id.expect("approval mode resolved an actor id");
        write_local_approval(owner, actor_id.to_string(), mode)?;
    }

    if let Err(error) = publish_catalog(owner, &next) {
        if let Some(actor_id) = actor_id {
            write_local_actor_value(owner, actor_id, local_before.flatten())?;
        }
        return Err(error);
    }

    if matches!(compound.mutation, CatalogMutation::Delete(_)) {
        if let Some(id) = mutation_actor_id(&compound.mutation) {
            if let Err(error) = remove_local_approval(owner, id) {
                tracing::warn!(
                    "agent actor catalog was deleted but local approval cleanup failed: {error}"
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
            catalog.actors.push(actor);
        }
        CatalogMutation::Update(actor) => {
            let actor = normalize_actor(actor);
            let item = catalog
                .actors
                .iter_mut()
                .find(|a| a.id == actor.id)
                .ok_or_else(|| CatalogError::Invalid("actor not found".into()))?;
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

pub fn write_local_approval(
    owner: &Path,
    actor_id: String,
    approval_mode: ApprovalMode,
) -> Result<(), CatalogError> {
    write_local_actor_value(
        owner,
        &actor_id,
        Some(serde_json::json!({ "approvalMode": approval_mode })),
    )
}

pub fn set_local_approval(
    owner: &Path,
    expected_fingerprint: &str,
    actor_id: &str,
    approval_mode: ApprovalMode,
) -> Result<String, CatalogError> {
    let (catalog, fingerprint) = read_catalog(owner)?;
    if fingerprint != expected_fingerprint {
        return Err(CatalogError::Stale);
    }
    if !catalog.actors.iter().any(|actor| actor.id == actor_id) {
        return Err(CatalogError::Invalid(format!(
            "missing_actor_id: agent:{actor_id}"
        )));
    }
    write_local_approval(owner, actor_id.to_string(), approval_mode)?;
    Ok(fingerprint)
}

pub fn remove_local_approval(owner: &Path, actor_id: &str) -> Result<(), CatalogError> {
    write_local_actor_value(owner, actor_id, None)
}

fn read_local_actor_value(
    owner: &Path,
    actor_id: &str,
) -> Result<Option<serde_json::Value>, CatalogError> {
    let local = crate::space::config::read_local_config(owner).map_err(local_config_error)?;
    let Some(actors) = local.extensions.get("agentActors") else {
        return Ok(None);
    };
    let actors = actors
        .as_object()
        .ok_or_else(|| CatalogError::Invalid("agentActors must be an object".into()))?;
    Ok(actors.get(actor_id).cloned())
}

fn write_local_actor_value(
    owner: &Path,
    actor_id: &str,
    value: Option<serde_json::Value>,
) -> Result<(), CatalogError> {
    crate::space::config::mutate_local_config(owner, |local| {
        if value.is_none() && !local.extensions.contains_key("agentActors") {
            return Ok(());
        }
        let actors = local
            .extensions
            .entry("agentActors".to_string())
            .or_insert_with(|| serde_json::json!({}));
        let actors = actors
            .as_object_mut()
            .ok_or_else(|| crate::AppError::General("agentActors must be an object".to_string()))?;
        match value {
            Some(value) => {
                actors.insert(actor_id.to_string(), value);
            }
            None => {
                actors.remove(actor_id);
            }
        }
        if actors.is_empty() {
            local.extensions.remove("agentActors");
        }
        Ok(())
    })
    .map_err(local_config_error)
}

fn local_config_error(error: crate::AppError) -> CatalogError {
    match error {
        crate::AppError::Serde(error) => CatalogError::Invalid(error.to_string()),
        crate::AppError::General(message) => CatalogError::Invalid(message),
        error => CatalogError::Io(error.to_string()),
    }
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
    use crate::agent_adapters::AgentAdapterKind;
    use svode_core::agent_actors::{AgentAdapter, read_local_approval};
    use tempfile::tempdir;
    fn actor(id: &str) -> AgentActor {
        AgentActor {
            id: id.into(),
            name: "A".into(),
            description: None,
            adapters: vec![AgentAdapter {
                adapter: AgentAdapterKind::Codex,
                model: Some("future-model".into()),
                effort: Some("future-effort".into()),
            }],
        }
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
    #[test]
    fn local_overlay_is_not_portable() {
        let d = tempdir().unwrap();
        write_local_approval(d.path(), "id".into(), ApprovalMode::Full).unwrap();
        assert_eq!(
            read_local_approval(d.path(), "id").unwrap(),
            ApprovalMode::Full
        );
        assert!(!catalog_path(d.path()).exists());
    }
    #[test]
    fn compound_create_writes_local_overlay_and_delete_cleans_it() {
        let d = tempdir().unwrap();
        let (_, fp) = read_catalog(d.path()).unwrap();
        let id = "01arz3ndektsv4rrffq69g5fav".to_string();
        mutate_catalog_compound(
            d.path(),
            &fp,
            CompoundCatalogMutation {
                mutation: CatalogMutation::Create(actor(&id)),
                approval_mode: Some(ApprovalMode::Auto),
            },
        )
        .unwrap();
        assert_eq!(
            read_local_approval(d.path(), &id).unwrap(),
            ApprovalMode::Auto
        );
        let (_, fp) = read_catalog(d.path()).unwrap();
        mutate_catalog_compound(
            d.path(),
            &fp,
            CompoundCatalogMutation {
                mutation: CatalogMutation::Delete(id.clone()),
                approval_mode: None,
            },
        )
        .unwrap();
        assert_eq!(
            read_local_approval(d.path(), &id).unwrap(),
            ApprovalMode::Ask
        );
    }

    #[test]
    fn local_only_approval_preserves_catalog_and_rejects_stale_fingerprint() {
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
            set_local_approval(d.path(), &fingerprint, &id, ApprovalMode::Full).unwrap(),
            fingerprint
        );
        assert_eq!(fs::read(catalog_path(d.path())).unwrap(), catalog_before);
        assert_eq!(
            read_local_approval(d.path(), &id).unwrap(),
            ApprovalMode::Full
        );

        assert!(matches!(
            set_local_approval(d.path(), &initial_fingerprint, &id, ApprovalMode::Auto),
            Err(CatalogError::Stale)
        ));
        assert_eq!(
            read_local_approval(d.path(), &id).unwrap(),
            ApprovalMode::Full
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
        mutate_catalog(
            d.path(),
            &fingerprint,
            CatalogMutation::Create(actor(second_id)),
        )
        .unwrap();
        let (_, fingerprint) = read_catalog(d.path()).unwrap();
        let reordered = mutate_catalog(
            d.path(),
            &fingerprint,
            CatalogMutation::Reorder(vec![second_id.into(), first_id.into()]),
        )
        .unwrap();
        assert_eq!(reordered.actors[0].id, second_id);

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

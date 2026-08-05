//! Portable agent actor catalog and local approval overlay.
//!
//! This module deliberately keeps the two persistence domains separate: the
//! catalog is shareable Git content, while approvals are local-only state.

pub mod commands;

use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::agent_adapters::AgentAdapterKind;

const CATALOG_RELATIVE_PATH: &str = ".svode/agent-actors.json";
const LOCAL_RELATIVE_PATH: &str = ".svode/local.json";
const MAX_CATALOG_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentActorCatalog {
    pub schema_version: u32,
    pub actors: Vec<AgentActor>,
}

impl Default for AgentActorCatalog {
    fn default() -> Self {
        Self {
            schema_version: 1,
            actors: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentActor {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub adapters: Vec<AgentAdapter>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentAdapter {
    pub adapter: AgentAdapterKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalMode {
    Ask,
    Auto,
    Full,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalActorSettings {
    #[serde(default)]
    pub agent_actors: HashMap<String, LocalActorApproval>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalActorApproval {
    pub approval_mode: ApprovalMode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CatalogError {
    Unsafe(String),
    Invalid(String),
    UnknownSchema(u32),
    Compatibility(String),
    Stale,
    Io(String),
}

impl std::fmt::Display for CatalogError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for CatalogError {}

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

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedAgentActor {
    pub actor: AgentActor,
    pub owner_path: String,
    pub approval_mode: ApprovalMode,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentActorCatalogDiagnostic {
    pub owner_path: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentActorResolution {
    pub actors: Vec<ResolvedAgentActor>,
    pub diagnostics: Vec<AgentActorCatalogDiagnostic>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum CanonicalActorResolution {
    Resolved { actor: ResolvedAgentActor },
    Missing { code: String, reference: String },
    Ambiguous { code: String, reference: String },
}

/// Resolve exactly the current Space and, when supplied by project context,
/// the project root. No filesystem walk is performed, so siblings can never
/// leak into the effective actor domain.
pub fn resolve_catalogs(own: &Path, inherited_root: Option<&Path>) -> AgentActorResolution {
    let mut diagnostics = Vec::new();
    let mut sources: Vec<(&Path, AgentActorCatalog)> = Vec::new();
    for owner in std::iter::once(own).chain(inherited_root.into_iter().filter(|root| *root != own))
    {
        match read_catalog(owner) {
            Ok((catalog, _)) => sources.push((owner, catalog)),
            Err(error) => diagnostics.push(AgentActorCatalogDiagnostic {
                owner_path: owner.to_string_lossy().to_string(),
                code: "catalog_unavailable".into(),
                message: error.to_string(),
            }),
        }
    }
    let mut counts = HashMap::<String, usize>::new();
    for (_, catalog) in &sources {
        for actor in &catalog.actors {
            *counts.entry(actor.id.clone()).or_default() += 1;
        }
    }
    let mut actors = Vec::new();
    for (owner, catalog) in sources {
        for actor in catalog.actors {
            if counts[&actor.id] > 1 {
                diagnostics.push(AgentActorCatalogDiagnostic {
                    owner_path: owner.to_string_lossy().to_string(),
                    code: "ambiguous_actor_id".into(),
                    message: format!(
                        "agent:{} is defined by multiple effective catalogs",
                        actor.id
                    ),
                });
                continue;
            }
            let approval_mode = read_local_approval(owner, &actor.id).unwrap_or(ApprovalMode::Ask);
            actors.push(ResolvedAgentActor {
                actor,
                owner_path: owner.to_string_lossy().to_string(),
                approval_mode,
            });
        }
    }
    AgentActorResolution {
        actors,
        diagnostics,
    }
}

/// Resolve only canonical `agent:<lowercase-ulid>` references. Invalid values
/// never get a best-effort match, and absent actors remain distinct from a
/// fail-closed own/root collision.
#[allow(dead_code)]
pub fn resolve_canonical_reference(
    own: &Path,
    inherited_root: Option<&Path>,
    reference: &str,
) -> CanonicalActorResolution {
    let Some(id) = reference
        .strip_prefix("agent:")
        .filter(|id| is_lowercase_ulid(id))
    else {
        return CanonicalActorResolution::Missing {
            code: "missing_actor_id".into(),
            reference: reference.into(),
        };
    };
    let resolution = resolve_catalogs(own, inherited_root);
    if resolution.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == "ambiguous_actor_id"
            && diagnostic.message.contains(&format!("agent:{id}"))
    }) {
        return CanonicalActorResolution::Ambiguous {
            code: "ambiguous_actor_id".into(),
            reference: reference.into(),
        };
    }
    match resolution
        .actors
        .into_iter()
        .find(|item| item.actor.id == id)
    {
        Some(actor) => CanonicalActorResolution::Resolved { actor },
        None => CanonicalActorResolution::Missing {
            code: "missing_actor_id".into(),
            reference: reference.into(),
        },
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

pub fn catalog_path(owner: &Path) -> PathBuf {
    owner.join(CATALOG_RELATIVE_PATH)
}
pub fn local_path(owner: &Path) -> PathBuf {
    owner.join(LOCAL_RELATIVE_PATH)
}

pub fn read_catalog(owner: &Path) -> Result<(AgentActorCatalog, String), CatalogError> {
    let path = catalog_path(owner);
    let raw = match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == ErrorKind::NotFound => {
            return Ok((AgentActorCatalog::default(), fingerprint(&[])));
        }
        Err(e) => return Err(CatalogError::Io(e.to_string())),
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => {
            return Err(CatalogError::Unsafe(
                "catalog must be a regular file".into(),
            ));
        }
        Ok(meta) if meta.len() > MAX_CATALOG_BYTES => {
            return Err(CatalogError::Unsafe("catalog exceeds size limit".into()));
        }
        Ok(_) => fs::read(&path).map_err(|e| CatalogError::Io(e.to_string()))?,
    };
    let text = std::str::from_utf8(&raw)
        .map_err(|_| CatalogError::Unsafe("catalog is not UTF-8".into()))?;
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|e| CatalogError::Invalid(e.to_string()))?;
    if let Some(schema_version) = value.get("schemaVersion").and_then(|value| value.as_u64()) {
        if schema_version != 1 {
            return Err(CatalogError::UnknownSchema(
                u32::try_from(schema_version).unwrap_or(u32::MAX),
            ));
        }
    }
    ensure_known_v1_shape(&value)?;
    let catalog: AgentActorCatalog =
        serde_json::from_value(value).map_err(|e| CatalogError::Invalid(e.to_string()))?;
    if catalog.schema_version != 1 {
        return Err(CatalogError::UnknownSchema(catalog.schema_version));
    }
    validate_catalog(&catalog)?;
    Ok((catalog, fingerprint(&raw)))
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

    let local_before = fs::read(local_path(owner));
    if let Some(mode) = compound.approval_mode {
        let actor_id = mutation_actor_id(&compound.mutation)
            .ok_or_else(|| CatalogError::Invalid("approval needs an actor id".into()))?;
        write_local_approval(owner, actor_id.to_string(), mode)?;
    }

    if let Err(error) = publish_catalog(owner, &next) {
        if compound.approval_mode.is_some() {
            restore_local_bytes(owner, local_before)?;
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

fn restore_local_bytes(
    owner: &Path,
    before: Result<Vec<u8>, std::io::Error>,
) -> Result<(), CatalogError> {
    match before {
        Ok(bytes) => atomic_write(&local_path(owner), &bytes),
        Err(e) if e.kind() == ErrorKind::NotFound => match fs::remove_file(local_path(owner)) {
            Ok(()) => Ok(()),
            Err(ref e) if e.kind() == ErrorKind::NotFound => Ok(()),
            Err(e) => Err(CatalogError::Io(e.to_string())),
        },
        Err(e) => Err(CatalogError::Io(e.to_string())),
    }
}

pub fn read_local_approval(owner: &Path, actor_id: &str) -> Result<ApprovalMode, CatalogError> {
    let path = local_path(owner);
    let raw = match fs::read(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(ApprovalMode::Ask),
        Err(e) => return Err(CatalogError::Io(e.to_string())),
    };
    let settings: LocalActorSettings =
        serde_json::from_slice(&raw).map_err(|e| CatalogError::Invalid(e.to_string()))?;
    Ok(settings
        .agent_actors
        .get(actor_id)
        .map(|v| v.approval_mode)
        .unwrap_or(ApprovalMode::Ask))
}

pub fn write_local_approval(
    owner: &Path,
    actor_id: String,
    approval_mode: ApprovalMode,
) -> Result<(), CatalogError> {
    let path = local_path(owner);
    let mut settings: serde_json::Value = match fs::read(&path) {
        Ok(raw) => {
            serde_json::from_slice(&raw).map_err(|e| CatalogError::Invalid(e.to_string()))?
        }
        Err(e) if e.kind() == ErrorKind::NotFound => serde_json::json!({}),
        Err(e) => return Err(CatalogError::Io(e.to_string())),
    };
    let root = settings
        .as_object_mut()
        .ok_or_else(|| CatalogError::Invalid("local config must be an object".into()))?;
    let actors = root
        .entry("agentActors")
        .or_insert_with(|| serde_json::json!({}));
    let actors = actors
        .as_object_mut()
        .ok_or_else(|| CatalogError::Invalid("agentActors must be an object".into()))?;
    actors.insert(
        actor_id,
        serde_json::json!({ "approvalMode": approval_mode }),
    );
    atomic_write(
        &path,
        &serde_json::to_vec_pretty(&settings).map_err(|e| CatalogError::Invalid(e.to_string()))?,
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
    let path = local_path(owner);
    let mut value: serde_json::Value = match fs::read(&path) {
        Ok(raw) => {
            serde_json::from_slice(&raw).map_err(|e| CatalogError::Invalid(e.to_string()))?
        }
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(CatalogError::Io(e.to_string())),
    };
    if let Some(actors) = value
        .get_mut("agentActors")
        .and_then(serde_json::Value::as_object_mut)
    {
        actors.remove(actor_id);
        if actors.is_empty() {
            value
                .as_object_mut()
                .expect("object containing agentActors")
                .remove("agentActors");
        }
        atomic_write(
            &path,
            &serde_json::to_vec_pretty(&value).map_err(|e| CatalogError::Invalid(e.to_string()))?,
        )?;
    }
    Ok(())
}

fn validate_catalog(c: &AgentActorCatalog) -> Result<(), CatalogError> {
    if c.schema_version != 1 {
        return Err(CatalogError::UnknownSchema(c.schema_version));
    }
    let mut ids = HashSet::new();
    for a in &c.actors {
        if a.name.trim().is_empty() || !is_lowercase_ulid(&a.id) || !ids.insert(&a.id) {
            return Err(CatalogError::Invalid("invalid actor".into()));
        }
        let mut adapters = HashSet::new();
        if a.adapters.is_empty() || a.adapters.iter().any(|x| !adapters.insert(&x.adapter)) {
            return Err(CatalogError::Invalid(
                "actor adapters must be unique and nonempty".into(),
            ));
        }
    }
    Ok(())
}

fn ensure_known_v1_shape(value: &serde_json::Value) -> Result<(), CatalogError> {
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
                if !matches!(adapter_id, "codex" | "claude-code") {
                    return Err(CatalogError::Compatibility(format!(
                        "unsupported adapter id: {adapter_id}"
                    )));
                }
            }
        }
    }
    Ok(())
}

fn reject_unknown_fields(
    object: &serde_json::Map<String, serde_json::Value>,
    allowed: &[&str],
    context: &str,
) -> Result<(), CatalogError> {
    if let Some(field) = object
        .keys()
        .find(|field| !allowed.contains(&field.as_str()))
    {
        return Err(CatalogError::Compatibility(format!(
            "unsupported field {context}.{field}"
        )));
    }
    Ok(())
}

fn is_lowercase_ulid(value: &str) -> bool {
    value.len() == 26
        && value == value.to_ascii_lowercase()
        && ulid::Ulid::from_string(&value.to_ascii_uppercase()).is_ok()
}
fn fingerprint(raw: &[u8]) -> String {
    format!(
        "{:016x}",
        raw.iter()
            .fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(*b))
                .wrapping_mul(0x100000001b3))
    )
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
    fn resolver_inherits_only_root_and_fails_closed_on_collision() {
        let root = tempdir().unwrap();
        let child = tempdir().unwrap();
        let sibling = tempdir().unwrap();
        let id = "01arZ3ndektsv4rrffq69g5fav".to_lowercase();
        let (_, root_fp) = read_catalog(root.path()).unwrap();
        mutate_catalog(root.path(), &root_fp, CatalogMutation::Create(actor(&id))).unwrap();
        let (_, sibling_fp) = read_catalog(sibling.path()).unwrap();
        mutate_catalog(
            sibling.path(),
            &sibling_fp,
            CatalogMutation::Create(actor("01arz3ndektsv4rrffq69g5faw")),
        )
        .unwrap();

        let inherited = resolve_catalogs(child.path(), Some(root.path()));
        assert_eq!(inherited.actors.len(), 1);
        assert_eq!(resolve_catalogs(child.path(), None).actors.len(), 0);

        let (_, child_fp) = read_catalog(child.path()).unwrap();
        mutate_catalog(child.path(), &child_fp, CatalogMutation::Create(actor(&id))).unwrap();
        let collision = resolve_catalogs(child.path(), Some(root.path()));
        assert!(collision.actors.is_empty());
        assert!(
            collision
                .diagnostics
                .iter()
                .all(|d| d.code == "ambiguous_actor_id")
        );
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
    fn incompatible_catalog_is_read_only_and_not_overwritten() {
        let d = tempdir().unwrap();
        let path = catalog_path(d.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let raw = br#"{"schemaVersion":1,"actors":[],"futureField":true}"#;
        fs::write(&path, raw).unwrap();

        assert!(matches!(
            read_catalog(d.path()),
            Err(CatalogError::Compatibility(_))
        ));
        assert_eq!(fs::read(&path).unwrap(), raw);
    }

    #[test]
    fn unsupported_adapter_id_is_a_read_only_compatibility_state() {
        let d = tempdir().unwrap();
        let path = catalog_path(d.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let raw = br#"{
            "schemaVersion": 1,
            "actors": [{
                "id": "01arz3ndektsv4rrffq69g5fav",
                "name": "Future agent",
                "adapters": [{"adapter":"future-client"}]
            }]
        }"#;
        fs::write(&path, raw).unwrap();

        assert!(matches!(
            read_catalog(d.path()),
            Err(CatalogError::Compatibility(_))
        ));
        assert_eq!(fs::read(&path).unwrap(), raw);
    }

    #[test]
    fn unsafe_and_unknown_catalog_states_block_reads() {
        let non_utf8 = tempdir().unwrap();
        let path = catalog_path(non_utf8.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, [0xff, 0xfe]).unwrap();
        assert!(matches!(
            read_catalog(non_utf8.path()),
            Err(CatalogError::Unsafe(_))
        ));

        let non_regular = tempdir().unwrap();
        fs::create_dir_all(catalog_path(non_regular.path())).unwrap();
        assert!(matches!(
            read_catalog(non_regular.path()),
            Err(CatalogError::Unsafe(_))
        ));

        let unknown = tempdir().unwrap();
        let path = catalog_path(unknown.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, r#"{"schemaVersion":2,"actors":[]}"#).unwrap();
        assert!(matches!(
            read_catalog(unknown.path()),
            Err(CatalogError::UnknownSchema(2))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_catalog_is_never_followed_or_overwritten() {
        use std::os::unix::fs::symlink;

        let d = tempdir().unwrap();
        let target = d.path().join("outside.json");
        let path = catalog_path(d.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&target, r#"{"schemaVersion":1,"actors":[]}"#).unwrap();
        symlink(&target, &path).unwrap();

        assert!(matches!(
            read_catalog(d.path()),
            Err(CatalogError::Unsafe(_))
        ));
        assert!(
            fs::symlink_metadata(&path)
                .unwrap()
                .file_type()
                .is_symlink()
        );
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

    #[test]
    fn canonical_reference_distinguishes_missing_from_ambiguous() {
        let root = tempdir().unwrap();
        let child = tempdir().unwrap();
        let id = "01arz3ndektsv4rrffq69g5fav".to_string();
        let reference = format!("agent:{id}");
        assert!(matches!(
            resolve_canonical_reference(child.path(), Some(root.path()), &reference),
            CanonicalActorResolution::Missing { .. }
        ));
        let (_, root_fp) = read_catalog(root.path()).unwrap();
        mutate_catalog(root.path(), &root_fp, CatalogMutation::Create(actor(&id))).unwrap();
        assert!(matches!(
            resolve_canonical_reference(child.path(), Some(root.path()), &reference),
            CanonicalActorResolution::Resolved { .. }
        ));
        let (_, child_fp) = read_catalog(child.path()).unwrap();
        mutate_catalog(child.path(), &child_fp, CatalogMutation::Create(actor(&id))).unwrap();
        assert!(matches!(
            resolve_canonical_reference(child.path(), Some(root.path()), &reference),
            CanonicalActorResolution::Ambiguous { .. }
        ));
        assert!(matches!(
            resolve_canonical_reference(child.path(), Some(root.path()), "agent:NOT-CANONICAL"),
            CanonicalActorResolution::Missing { .. }
        ));
    }
}

//! Portable Agent Actor catalog: the shared read owner for the catalog file,
//! its device-local mode overlay and the executor resolver of a launch.
//!
//! The persistence domains stay separate: the catalog is shareable Git
//! content (V2: one binding per Actor), while the mode of an Actor and the
//! device's default agent are local-only state. Catalog mutation and agent
//! launch stay with their host consumers.

pub mod executor;
pub mod local;
pub mod v1;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::agent_adapters::AgentId;

/// The registry launch path still takes the V1 binding shape and approval
/// mode until Routine dispatch moves to the executor resolver.
pub use v1::{AgentAdapter, ApprovalMode};

const CATALOG_RELATIVE_PATH: &str = ".svode/agent-actors.json";
const LOCAL_RELATIVE_PATH: &str = ".svode/local.json";
const MAX_CATALOG_BYTES: u64 = 1024 * 1024;

/// The catalog schema this version writes.
pub const CATALOG_SCHEMA_VERSION: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentActorCatalog {
    pub schema_version: u32,
    pub actors: Vec<AgentActor>,
}

impl Default for AgentActorCatalog {
    fn default() -> Self {
        Self {
            schema_version: CATALOG_SCHEMA_VERSION,
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
    pub binding: ActorBinding,
}

/// The one way an Actor runs: a concrete agent with portable values of its
/// settings, or the participant's agent, which is the default agent of the
/// device the launch runs on.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(try_from = "RawBinding", into = "RawBinding")]
pub enum ActorBinding {
    /// Any well-formed agent id, so a binding of an agent another Svode
    /// version knows, or of a custom agent a V1 catalog kept, is read as
    /// unavailable and kept as is on every write.
    Agent {
        agent: AgentId,
        /// In the agent's terms, in the order they were chosen; never a
        /// value of a setting of category `mode`.
        settings: Vec<AgentSettingValue>,
    },
    Participant,
}

impl ActorBinding {
    pub fn agent(&self) -> Option<&AgentId> {
        match self {
            Self::Agent { agent, .. } => Some(agent),
            Self::Participant => None,
        }
    }
}

/// A value of one setting an agent declared, as the agent names both: the
/// setting id and the value id (C5 `02`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSettingValue {
    pub setting: String,
    pub value: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawBinding {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent: Option<AgentId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    settings: Option<Vec<AgentSettingValue>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    participant: Option<bool>,
}

impl TryFrom<RawBinding> for ActorBinding {
    type Error = String;

    fn try_from(raw: RawBinding) -> Result<Self, Self::Error> {
        match raw {
            RawBinding {
                agent: Some(agent),
                settings,
                participant: None,
            } => Ok(Self::Agent {
                agent,
                settings: settings.unwrap_or_default(),
            }),
            RawBinding {
                agent: None,
                settings: None,
                participant: Some(true),
            } => Ok(Self::Participant),
            _ => Err("a binding names one agent or is the participant's agent".into()),
        }
    }
}

impl From<ActorBinding> for RawBinding {
    fn from(binding: ActorBinding) -> Self {
        match binding {
            ActorBinding::Agent { agent, settings } => Self {
                agent: Some(agent),
                settings: Some(settings),
                participant: None,
            },
            ActorBinding::Participant => Self {
                agent: None,
                settings: None,
                participant: Some(true),
            },
        }
    }
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

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedAgentActor {
    pub actor: AgentActor,
    pub owner_path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentActorCatalogDiagnostic {
    pub owner_path: String,
    pub code: String,
    pub message: String,
    /// Id an `ambiguous_actor_id` diagnostic is about; the message names it
    /// for the window, so it is not serialized.
    #[serde(skip)]
    pub actor_id: Option<String>,
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
                actor_id: None,
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
                    actor_id: Some(actor.id.clone()),
                });
                continue;
            }
            actors.push(ResolvedAgentActor {
                actor,
                owner_path: owner.to_string_lossy().to_string(),
            });
        }
    }
    AgentActorResolution {
        actors,
        diagnostics,
    }
}

/// Catalog a Space inherits in its project context: the project root for a
/// registered child Space; the root, and a standalone Space that is its own
/// project, inherit nothing.
pub fn inherited_root<'a>(project: &'a Path, space: &Path) -> Option<&'a Path> {
    (space != project).then_some(project)
}

/// Effective Agent Actors of a Space in its project context: the one
/// executor domain of the Routine owners of that Space and of its
/// Collections.
pub fn resolve_space_catalogs(project: &Path, space: &Path) -> AgentActorResolution {
    resolve_catalogs(space, inherited_root(project, space))
}

/// Resolve only canonical `agent:<lowercase-ulid>` references. Invalid values
/// never get a best-effort match, and absent actors remain distinct from a
/// fail-closed own/root collision.
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

pub fn catalog_path(owner: &Path) -> PathBuf {
    owner.join(CATALOG_RELATIVE_PATH)
}
pub fn local_path(owner: &Path) -> PathBuf {
    owner.join(LOCAL_RELATIVE_PATH)
}

/// The catalog of `owner` as V2 with the fingerprint of its bytes. A V1 file
/// is read as V2 without being rewritten: the next write of the catalog
/// writes V2.
pub fn read_catalog(owner: &Path) -> Result<(AgentActorCatalog, String), CatalogError> {
    read_catalog_versioned(owner).map(|read| (read.catalog, read.fingerprint))
}

pub(crate) struct CatalogRead {
    pub catalog: AgentActorCatalog,
    pub fingerprint: String,
    /// Schema version of the file; an absent file reads as the current one.
    pub file_version: u32,
}

pub(crate) fn read_catalog_versioned(owner: &Path) -> Result<CatalogRead, CatalogError> {
    let path = catalog_path(owner);
    let raw = match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == ErrorKind::NotFound => {
            return Ok(CatalogRead {
                catalog: AgentActorCatalog::default(),
                fingerprint: fingerprint(&[]),
                file_version: CATALOG_SCHEMA_VERSION,
            });
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
    let file_version = match value.get("schemaVersion").and_then(|value| value.as_u64()) {
        Some(version) => u32::try_from(version).unwrap_or(u32::MAX),
        None => return Err(CatalogError::Invalid("missing schemaVersion".into())),
    };
    let catalog = match file_version {
        1 => v1::read_as_v2(value)?,
        CATALOG_SCHEMA_VERSION => {
            ensure_known_v2_shape(&value)?;
            serde_json::from_value(value).map_err(|e| CatalogError::Invalid(e.to_string()))?
        }
        other => return Err(CatalogError::UnknownSchema(other)),
    };
    validate_catalog(&catalog)?;
    Ok(CatalogRead {
        catalog,
        fingerprint: fingerprint(&raw),
        file_version,
    })
}

/// The rules every V2 catalog meets: actor identity, one binding and each
/// setting at most once in it.
pub fn validate_catalog(c: &AgentActorCatalog) -> Result<(), CatalogError> {
    if c.schema_version != CATALOG_SCHEMA_VERSION {
        return Err(CatalogError::UnknownSchema(c.schema_version));
    }
    let mut ids = HashSet::new();
    for a in &c.actors {
        if a.name.trim().is_empty() || !is_lowercase_ulid(&a.id) || !ids.insert(&a.id) {
            return Err(CatalogError::Invalid("invalid actor".into()));
        }
        if let ActorBinding::Agent { settings, .. } = &a.binding {
            validate_settings(settings).map_err(CatalogError::Invalid)?;
        }
    }
    Ok(())
}

/// Each setting at most once, with non-empty ids.
pub fn validate_settings(settings: &[AgentSettingValue]) -> Result<(), String> {
    let mut seen = HashSet::new();
    for value in settings {
        if value.setting.trim().is_empty() || value.value.trim().is_empty() {
            return Err("a setting value names its setting and value".into());
        }
        if !seen.insert(value.setting.as_str()) {
            return Err(format!("setting {} appears more than once", value.setting));
        }
    }
    Ok(())
}

/// The binding a write may put into the catalog: a built-in agent of this
/// version or the participant's agent. A binding already in the file stays
/// as it is when the Actor is edited, so an unavailable binding of an agent
/// another version knows, or of a custom agent a V1 catalog kept, is never
/// lost. `previous` is the binding before an update.
pub fn check_binding_write(
    previous: Option<&ActorBinding>,
    next: &ActorBinding,
) -> Result<(), CatalogError> {
    if previous == Some(next) {
        return Ok(());
    }
    match next {
        ActorBinding::Participant => Ok(()),
        ActorBinding::Agent { agent, .. } if agent.builtin().is_some() => Ok(()),
        ActorBinding::Agent { agent, .. } if agent.is_custom() => Err(CatalogError::Invalid(
            format!("{agent} is a custom agent of this device and cannot be an Actor binding"),
        )),
        ActorBinding::Agent { agent, .. } => Err(CatalogError::Invalid(format!(
            "{agent} is not an agent this version of Svode knows"
        ))),
    }
}

fn ensure_known_v2_shape(value: &serde_json::Value) -> Result<(), CatalogError> {
    const ROOT_FIELDS: &[&str] = &["schemaVersion", "actors"];
    const ACTOR_FIELDS: &[&str] = &["id", "name", "description", "binding"];
    const BINDING_FIELDS: &[&str] = &["agent", "settings", "participant"];
    const SETTING_FIELDS: &[&str] = &["setting", "value"];

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
        let context = format!("actors[{actor_index}]");
        reject_unknown_fields(actor, ACTOR_FIELDS, &context)?;
        let Some(binding) = actor.get("binding").and_then(serde_json::Value::as_object) else {
            continue;
        };
        reject_unknown_fields(binding, BINDING_FIELDS, &format!("{context}.binding"))?;
        if let Some(agent) = binding.get("agent").and_then(serde_json::Value::as_str) {
            ensure_agent_id(agent)?;
        }
        let Some(settings) = binding
            .get("settings")
            .and_then(serde_json::Value::as_array)
        else {
            continue;
        };
        for (setting_index, setting) in settings.iter().enumerate() {
            if let Some(setting) = setting.as_object() {
                reject_unknown_fields(
                    setting,
                    SETTING_FIELDS,
                    &format!("{context}.binding.settings[{setting_index}]"),
                )?;
            }
        }
    }
    Ok(())
}

pub(crate) fn ensure_agent_id(agent: &str) -> Result<(), CatalogError> {
    AgentId::parse(agent)
        .map(|_| ())
        .map_err(|_| CatalogError::Compatibility(format!("unsupported agent id: {agent}")))
}

pub(crate) fn reject_unknown_fields(
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

pub(crate) fn is_lowercase_ulid(value: &str) -> bool {
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

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    pub fn codex(settings: &[(&str, &str)]) -> ActorBinding {
        ActorBinding::Agent {
            agent: crate::agent_adapters::AgentAdapterKind::Codex.id(),
            settings: settings
                .iter()
                .map(|(setting, value)| AgentSettingValue {
                    setting: (*setting).into(),
                    value: (*value).into(),
                })
                .collect(),
        }
    }

    pub fn actor(id: &str, binding: ActorBinding) -> AgentActor {
        AgentActor {
            id: id.into(),
            name: "A".into(),
            description: None,
            binding,
        }
    }

    pub fn write_raw(owner: &Path, value: serde_json::Value) {
        let path = catalog_path(owner);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    }

    pub fn write_actor(owner: &Path, id: &str) {
        let (mut catalog, _) = read_catalog(owner).unwrap();
        catalog
            .actors
            .push(actor(id, codex(&[("model", "future-model")])));
        let path = catalog_path(owner);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, serde_json::to_vec_pretty(&catalog).unwrap()).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use crate::agent_adapters::AgentAdapterKind;
    use tempfile::tempdir;

    #[test]
    fn resolver_inherits_only_root_and_fails_closed_on_collision() {
        let root = tempdir().unwrap();
        let child = tempdir().unwrap();
        let sibling = tempdir().unwrap();
        let id = "01arZ3ndektsv4rrffq69g5fav".to_lowercase();
        write_actor(root.path(), &id);
        write_actor(sibling.path(), "01arz3ndektsv4rrffq69g5faw");

        let inherited = resolve_catalogs(child.path(), Some(root.path()));
        assert_eq!(inherited.actors.len(), 1);
        assert_eq!(resolve_catalogs(child.path(), None).actors.len(), 0);
        write_actor(child.path(), &id);
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
    fn a_space_inherits_the_root_catalog_only_as_a_child_of_its_project() {
        let project = tempdir().unwrap();
        let child = project.path().join("child");
        fs::create_dir_all(&child).unwrap();
        write_actor(project.path(), "01arz3ndektsv4rrffq69g5fav");
        write_actor(&child, "01arz3ndektsv4rrffq69g5faw");
        let ids = |resolution: AgentActorResolution| {
            resolution
                .actors
                .into_iter()
                .map(|resolved| resolved.actor.id)
                .collect::<Vec<_>>()
        };

        assert_eq!(
            ids(resolve_space_catalogs(project.path(), &child)),
            ["01arz3ndektsv4rrffq69g5faw", "01arz3ndektsv4rrffq69g5fav"]
        );
        assert_eq!(
            ids(resolve_space_catalogs(project.path(), project.path())),
            ["01arz3ndektsv4rrffq69g5fav"]
        );
        assert_eq!(inherited_root(project.path(), &child), Some(project.path()));
        assert_eq!(inherited_root(project.path(), project.path()), None);
        // A standalone child is its own project.
        assert_eq!(inherited_root(&child, &child), None);
        assert_eq!(
            ids(resolve_space_catalogs(&child, &child)),
            ["01arz3ndektsv4rrffq69g5faw"]
        );

        write_actor(&child, "01arz3ndektsv4rrffq69g5fav");
        let collision = resolve_space_catalogs(project.path(), &child);
        assert_eq!(ids(collision.clone()), ["01arz3ndektsv4rrffq69g5faw"]);
        assert_eq!(collision.diagnostics.len(), 2);
        assert!(collision.diagnostics.iter().all(|diagnostic| {
            diagnostic.code == "ambiguous_actor_id"
                && diagnostic.actor_id.as_deref() == Some("01arz3ndektsv4rrffq69g5fav")
        }));
        // The window reads the id from the message, not from a new field.
        assert!(
            serde_json::to_value(&collision.diagnostics[0])
                .unwrap()
                .get("actorId")
                .is_none()
        );
    }

    #[test]
    fn a_v2_catalog_holds_one_binding_of_either_kind() {
        let d = tempdir().unwrap();
        let value = serde_json::json!({
            "schemaVersion": 2,
            "actors": [
                {
                    "id": "01arz3ndektsv4rrffq69g5fav",
                    "name": "Reviewer",
                    "binding": {
                        "agent": "codex",
                        "settings": [
                            {"setting": "model", "value": "gpt-6.1-sol"},
                            {"setting": "reasoning_effort", "value": "high"}
                        ]
                    }
                },
                {
                    "id": "01arz3ndektsv4rrffq69g5faw",
                    "name": "Mine",
                    "binding": {"participant": true}
                }
            ]
        });
        write_raw(d.path(), value.clone());

        let (catalog, _) = read_catalog(d.path()).unwrap();
        assert_eq!(
            catalog.actors[0].binding,
            codex(&[("model", "gpt-6.1-sol"), ("reasoning_effort", "high")])
        );
        assert_eq!(catalog.actors[1].binding, ActorBinding::Participant);
        assert_eq!(serde_json::to_value(&catalog).unwrap(), value);
    }

    #[test]
    fn a_repeated_setting_makes_the_catalog_invalid() {
        let d = tempdir().unwrap();
        write_raw(
            d.path(),
            serde_json::json!({
                "schemaVersion": 2,
                "actors": [{
                    "id": "01arz3ndektsv4rrffq69g5fav",
                    "name": "Reviewer",
                    "binding": {"agent": "codex", "settings": [
                        {"setting": "model", "value": "a"},
                        {"setting": "model", "value": "b"}
                    ]}
                }]
            }),
        );
        assert!(matches!(
            read_catalog(d.path()),
            Err(CatalogError::Invalid(_))
        ));
    }

    #[test]
    fn a_binding_of_both_or_neither_kind_is_invalid() {
        for binding in [
            serde_json::json!({"agent": "codex", "participant": true}),
            serde_json::json!({}),
            serde_json::json!({"participant": false}),
            serde_json::json!({"participant": true, "settings": []}),
        ] {
            let d = tempdir().unwrap();
            write_raw(
                d.path(),
                serde_json::json!({
                    "schemaVersion": 2,
                    "actors": [{
                        "id": "01arz3ndektsv4rrffq69g5fav",
                        "name": "Reviewer",
                        "binding": binding
                    }]
                }),
            );
            assert!(
                matches!(read_catalog(d.path()), Err(CatalogError::Invalid(_))),
                "{binding}"
            );
        }
    }

    #[test]
    fn unknown_fields_and_a_newer_schema_are_read_only_states() {
        for (raw, compatibility) in [
            (
                serde_json::json!({"schemaVersion": 2, "actors": [], "futureField": true}),
                true,
            ),
            (
                serde_json::json!({"schemaVersion": 2, "actors": [{
                    "id": "01arz3ndektsv4rrffq69g5fav",
                    "name": "A",
                    "binding": {"agent": "codex", "settings": [], "future": 1}
                }]}),
                true,
            ),
            (
                serde_json::json!({"schemaVersion": 2, "actors": [{
                    "id": "01arz3ndektsv4rrffq69g5fav",
                    "name": "A",
                    "binding": {"agent": "codex", "settings": [
                        {"setting": "model", "value": "m", "category": "model"}
                    ]}
                }]}),
                true,
            ),
            (
                serde_json::json!({"schemaVersion": 2, "actors": [{
                    "id": "01arz3ndektsv4rrffq69g5fav",
                    "name": "A",
                    "binding": {"agent": "Future Client"}
                }]}),
                true,
            ),
            (serde_json::json!({"schemaVersion": 3, "actors": []}), false),
        ] {
            let d = tempdir().unwrap();
            write_raw(d.path(), raw.clone());
            let before = fs::read(catalog_path(d.path())).unwrap();
            let result = read_catalog(d.path());
            if compatibility {
                assert!(
                    matches!(result, Err(CatalogError::Compatibility(_))),
                    "{raw}"
                );
            } else {
                assert!(matches!(result, Err(CatalogError::UnknownSchema(3))));
            }
            assert_eq!(fs::read(catalog_path(d.path())).unwrap(), before);
        }
    }

    #[test]
    fn a_binding_of_an_unknown_agent_is_read_and_kept_as_is() {
        let d = tempdir().unwrap();
        let binding = serde_json::json!({
            "agent": "future-client",
            "settings": [{"setting": "model", "value": "m1"}]
        });
        write_raw(
            d.path(),
            serde_json::json!({"schemaVersion": 2, "actors": [{
                "id": "01arz3ndektsv4rrffq69g5fav",
                "name": "Future agent",
                "binding": binding
            }]}),
        );

        let (catalog, _) = read_catalog(d.path()).unwrap();
        let read = &catalog.actors[0].binding;
        assert_eq!(read.agent().unwrap().as_str(), "future-client");
        assert_eq!(read.agent().unwrap().builtin(), None);
        assert_eq!(serde_json::to_value(read).unwrap(), binding);
        // An edit that keeps it is allowed; a new one is not.
        assert_eq!(check_binding_write(Some(read), read), Ok(()));
        assert!(check_binding_write(None, read).is_err());
    }

    #[test]
    fn a_write_takes_a_built_in_agent_or_the_participant_but_never_a_custom_agent() {
        let custom = ActorBinding::Agent {
            agent: AgentId::parse("custom-hermes").unwrap(),
            settings: Vec::new(),
        };
        assert!(matches!(
            check_binding_write(None, &custom),
            Err(CatalogError::Invalid(_))
        ));
        assert!(matches!(
            check_binding_write(Some(&codex(&[])), &custom),
            Err(CatalogError::Invalid(_))
        ));
        // A custom binding a V1 catalog kept stays until the agent changes.
        assert_eq!(check_binding_write(Some(&custom), &custom), Ok(()));
        assert_eq!(check_binding_write(Some(&custom), &codex(&[])), Ok(()));
        assert_eq!(
            check_binding_write(None, &ActorBinding::Participant),
            Ok(())
        );
        let hermes = ActorBinding::Agent {
            agent: AgentAdapterKind::Hermes.id(),
            settings: vec![AgentSettingValue {
                setting: "model".into(),
                value: "openai-codex:gpt".into(),
            }],
        };
        assert_eq!(check_binding_write(None, &hermes), Ok(()));
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

        let unversioned = tempdir().unwrap();
        write_raw(unversioned.path(), serde_json::json!({"actors": []}));
        assert!(matches!(
            read_catalog(unversioned.path()),
            Err(CatalogError::Invalid(_))
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
        fs::write(&target, r#"{"schemaVersion":2,"actors":[]}"#).unwrap();
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
    fn canonical_reference_distinguishes_missing_from_ambiguous() {
        let root = tempdir().unwrap();
        let child = tempdir().unwrap();
        let id = "01arz3ndektsv4rrffq69g5fav".to_string();
        let reference = format!("agent:{id}");
        assert!(matches!(
            resolve_canonical_reference(child.path(), Some(root.path()), &reference),
            CanonicalActorResolution::Missing { .. }
        ));
        write_actor(root.path(), &id);
        assert!(matches!(
            resolve_canonical_reference(child.path(), Some(root.path()), &reference),
            CanonicalActorResolution::Resolved { .. }
        ));
        write_actor(child.path(), &id);
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

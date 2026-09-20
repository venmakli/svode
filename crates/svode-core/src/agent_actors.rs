//! Portable Agent Actor catalog: the shared read owner for the catalog file
//! and its local approval overlay.
//!
//! The two persistence domains stay separate: the catalog is shareable Git
//! content, while approvals are local-only state. Catalog mutation and agent
//! launch stay with their host consumers.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::ErrorKind;
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

pub fn validate_catalog(c: &AgentActorCatalog) -> Result<(), CatalogError> {
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

    fn write_actor(owner: &Path, id: &str) {
        let (mut catalog, _) = read_catalog(owner).unwrap();
        catalog.actors.push(actor(id));
        let path = catalog_path(owner);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, serde_json::to_vec_pretty(&catalog).unwrap()).unwrap();
    }

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

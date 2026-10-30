//! Ordering of the child Spaces registered by a Project.
//!
//! The Project itself is never part of the order. The new order is persisted
//! into the `spaces` registry of the Project `.svode/config.json`.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::content_tree::ContentTreeError;
use crate::space_config::{self, SpaceConfig, SpaceConfigError};

/// Result of reordering the child Spaces of a Project.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChildSpaceOrderOutcome {
    pub previous_order: Vec<String>,
    pub ordered_space_ids: Vec<String>,
    pub changed: bool,
}

/// Persist a new child-Space order into the Project config. An unchanged
/// order writes nothing; a changed one keeps every registry entry and the
/// shared config fields, and is written by the shared config write rule.
pub fn reorder_child_spaces(
    project: &Path,
    ordered_space_ids: Vec<String>,
) -> Result<ChildSpaceOrderOutcome, ContentTreeError> {
    let previous_order = registered_ids(&space_config::read(project)?);
    if previous_order == ordered_space_ids {
        return Ok(ChildSpaceOrderOutcome {
            previous_order,
            ordered_space_ids,
            changed: false,
        });
    }

    space_config::mutate(project, |config| {
        let previous_order = registered_ids(config);
        let ordered_space_ids = plan_child_space_order(&previous_order, ordered_space_ids)?;
        let mut by_id = config
            .spaces
            .take()
            .unwrap_or_default()
            .into_iter()
            .map(|entry| (entry.id.clone(), entry))
            .collect::<HashMap<_, _>>();
        let mut reordered = Vec::with_capacity(ordered_space_ids.len());
        for id in &ordered_space_ids {
            reordered.push(by_id.remove(id).ok_or_else(|| unknown_child_space(id))?);
        }
        config.spaces = Some(reordered);
        let changed = previous_order != ordered_space_ids;
        Ok(ChildSpaceOrderOutcome {
            previous_order,
            ordered_space_ids,
            changed,
        })
    })
}

fn registered_ids(config: &SpaceConfig) -> Vec<String> {
    config
        .spaces
        .iter()
        .flatten()
        .map(|entry| entry.id.clone())
        .collect()
}

impl From<SpaceConfigError> for ContentTreeError {
    fn from(error: SpaceConfigError) -> Self {
        match error {
            SpaceConfigError::Missing(path) => Self::FileNotFound(path),
            SpaceConfigError::Io(error) => Self::Io(error),
            SpaceConfigError::Serde(error) => Self::Serde(error),
            SpaceConfigError::Storage(error) => Self::Invalid(format!("Storage: {error}")),
            error @ (SpaceConfigError::Unreadable(_) | SpaceConfigError::Exists) => {
                Self::Invalid(error.to_string())
            }
        }
    }
}

/// Validate a proposed child-Space order against the registered ids and return
/// the ids in their new order. The proposal must be exactly the registered ids,
/// with no duplicates, missing or unknown ids, so a stale client cannot drop a
/// Space from the registry by reordering it.
fn plan_child_space_order(
    registered_ids: &[String],
    ordered_space_ids: Vec<String>,
) -> Result<Vec<String>, ContentTreeError> {
    if ordered_space_ids.len() != registered_ids.len() {
        return Err(ContentTreeError::Invalid(format!(
            "space reorder expected {} ids, got {}",
            registered_ids.len(),
            ordered_space_ids.len()
        )));
    }

    let mut seen = HashSet::with_capacity(ordered_space_ids.len());
    for id in &ordered_space_ids {
        if !seen.insert(id.clone()) {
            return Err(ContentTreeError::Invalid(format!(
                "space reorder contains duplicate id: {id}"
            )));
        }
    }

    let current_ids: HashSet<String> = registered_ids.iter().cloned().collect();
    let ordered_ids: HashSet<String> = ordered_space_ids.iter().cloned().collect();

    let missing: Vec<String> = current_ids.difference(&ordered_ids).cloned().collect();
    if !missing.is_empty() {
        return Err(ContentTreeError::Invalid(format!(
            "space reorder is missing ids: {}",
            missing.join(", ")
        )));
    }

    let unknown: Vec<String> = ordered_ids.difference(&current_ids).cloned().collect();
    if !unknown.is_empty() {
        return Err(ContentTreeError::Invalid(format!(
            "space reorder contains unknown ids: {}",
            unknown.join(", ")
        )));
    }

    Ok(ordered_space_ids)
}

/// The error reported when a planned id is no longer registered.
fn unknown_child_space(id: &str) -> ContentTreeError {
    ContentTreeError::Invalid(format!("space reorder contains unknown id: {id}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::variables::files;
    use serde_json::Value;
    use std::fs;

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn planned_order_must_be_exactly_the_registered_ids() {
        let registered = ids(&["a", "b", "c"]);

        assert_eq!(
            plan_child_space_order(&registered, ids(&["c", "a", "b"])).unwrap(),
            ids(&["c", "a", "b"])
        );

        for (proposal, expected) in [
            (ids(&["a", "b"]), "expected 3 ids, got 2"),
            (ids(&["a", "a", "b"]), "duplicate id: a"),
            (ids(&["a", "b", "d"]), "missing ids: c"),
        ] {
            let error = plan_child_space_order(&registered, proposal).expect_err("rejected");
            assert!(
                error.to_string().contains(expected),
                "{error} should contain {expected}"
            );
        }
    }

    fn project_with_children(extra: Value) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("project");
        let mut config = serde_json::json!({
            "name": "Root",
            "spaces": [
                { "id": "a", "path": "alpha", "repo": null },
                { "id": "b", "path": "beta", "repo": "https://example.com/beta.git" }
            ]
        });
        for (key, value) in extra.as_object().expect("object") {
            config[key] = value.clone();
        }
        fs::create_dir_all(dir.path().join(".svode")).expect("svode dir");
        fs::write(
            dir.path().join(".svode/config.json"),
            serde_json::to_string_pretty(&config).expect("json"),
        )
        .expect("config");
        dir
    }

    fn config(dir: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(dir.join(".svode/config.json")).unwrap()).unwrap()
    }

    #[test]
    fn reorder_persists_the_new_order_with_every_registry_entry() {
        let project = project_with_children(serde_json::json!({
            "description": "kept",
            "variables": { "version": 1 },
            "git": { "autoSync": true }
        }));

        let outcome = reorder_child_spaces(project.path(), ids(&["b", "a"])).expect("reorder");

        assert_eq!(
            outcome,
            ChildSpaceOrderOutcome {
                previous_order: ids(&["a", "b"]),
                ordered_space_ids: ids(&["b", "a"]),
                changed: true,
            }
        );
        let config = config(project.path());
        assert_eq!(config["spaces"][0]["id"], "b");
        assert_eq!(config["spaces"][0]["repo"], "https://example.com/beta.git");
        assert_eq!(config["spaces"][1]["path"], "alpha");
        assert_eq!(config["description"], "kept");
        assert_eq!(config["variables"]["version"], 1);
        assert!(config.get("git").is_none());
    }

    #[test]
    fn reorder_keeps_unknown_keys_of_the_config_and_its_entries() {
        let project = project_with_children(serde_json::json!({
            "futureRoot": { "mode": "team" },
            "tree": { "futureTree": 1 }
        }));
        let mut raw = config(project.path());
        raw["spaces"][1]["futureSpace"] = serde_json::json!("beta");
        fs::write(
            project.path().join(".svode/config.json"),
            serde_json::to_string_pretty(&raw).unwrap(),
        )
        .unwrap();

        reorder_child_spaces(project.path(), ids(&["b", "a"])).expect("reorder");

        let config = config(project.path());
        assert_eq!(config["futureRoot"]["mode"], "team");
        assert_eq!(config["tree"]["futureTree"], 1);
        assert_eq!(config["spaces"][0]["futureSpace"], "beta");
        assert!(config["spaces"][1].get("futureSpace").is_none());
    }

    #[test]
    fn unchanged_order_writes_nothing() {
        let project = project_with_children(serde_json::json!({}));
        let config_path = project.path().join(".svode/config.json");
        let before = fs::read(&config_path).expect("before");

        let outcome = reorder_child_spaces(project.path(), ids(&["a", "b"])).expect("reorder");

        assert!(!outcome.changed);
        assert_eq!(fs::read(&config_path).expect("after"), before);
        assert!(
            !project
                .path()
                .join(".svode")
                .join(files::LOCK_FILE)
                .exists()
        );
    }

    #[test]
    fn reorder_rejects_duplicate_missing_and_unknown_ids_without_writing() {
        let project = project_with_children(serde_json::json!({}));
        let config_path = project.path().join(".svode/config.json");
        let before = fs::read(&config_path).expect("before");

        for proposal in [ids(&["a", "a"]), ids(&["a"]), ids(&["a", "c"])] {
            assert!(reorder_child_spaces(project.path(), proposal).is_err());
        }
        assert_eq!(fs::read(&config_path).expect("after"), before);
    }

    #[test]
    fn a_missing_registered_id_is_reported_before_unknown_ids() {
        let error =
            plan_child_space_order(&ids(&["a", "b"]), ids(&["a", "z"])).expect_err("missing id");

        assert!(error.to_string().contains("missing ids: b"));
    }
}

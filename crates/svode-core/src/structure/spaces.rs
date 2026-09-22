//! Ordering of the child Spaces registered by a Project.
//!
//! The Project itself is never part of the order. The new order is persisted
//! into the `spaces` registry of the Project `.svode/config.json`.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use serde_json::Value;

use crate::content_tree::ContentTreeError;
use crate::variables::files;

/// Result of reordering the child Spaces of a Project.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChildSpaceOrderOutcome {
    pub previous_order: Vec<String>,
    pub ordered_space_ids: Vec<String>,
    pub changed: bool,
}

/// Persist a new child-Space order into the Project config. An unchanged
/// order writes nothing; a changed one keeps every registry entry and the
/// shared config fields, and drops the legacy shared Git automation policy
/// like every shared config write.
pub fn reorder_child_spaces(
    project: &Path,
    ordered_space_ids: Vec<String>,
) -> Result<ChildSpaceOrderOutcome, ContentTreeError> {
    let dir = project.join(".svode");
    let config_path = dir.join("config.json");
    let previous_order = registered_ids(&read_config(&config_path)?)?;
    if previous_order == ordered_space_ids {
        return Ok(ChildSpaceOrderOutcome {
            previous_order,
            ordered_space_ids,
            changed: false,
        });
    }

    let _guard = files::lock(&dir).map_err(storage_error)?;
    let mut config = read_config(&config_path)?;
    let previous_order = registered_ids(&config)?;
    let ordered_space_ids = plan_child_space_order(&previous_order, ordered_space_ids)?;
    let object = config
        .as_object_mut()
        .ok_or_else(|| ContentTreeError::Invalid("Project config is not an object".into()))?;
    let mut by_id = match object.remove("spaces") {
        Some(Value::Array(entries)) => entries
            .into_iter()
            .filter_map(|entry| Some((entry.get("id")?.as_str()?.to_string(), entry)))
            .collect::<HashMap<_, _>>(),
        _ => HashMap::new(),
    };
    let mut reordered = Vec::with_capacity(ordered_space_ids.len());
    for id in &ordered_space_ids {
        reordered.push(by_id.remove(id).ok_or_else(|| unknown_child_space(id))?);
    }
    object.insert("spaces".into(), Value::Array(reordered));
    object.remove("git");
    files::write_preserving_variables(&config_path, &config).map_err(storage_error)?;
    let changed = previous_order != ordered_space_ids;
    Ok(ChildSpaceOrderOutcome {
        previous_order,
        ordered_space_ids,
        changed,
    })
}

fn read_config(path: &Path) -> Result<Value, ContentTreeError> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(ContentTreeError::FileNotFound(path.display().to_string()));
        }
        Err(error) => return Err(error.into()),
    };
    Ok(serde_json::from_str(&raw)?)
}

fn registered_ids(config: &Value) -> Result<Vec<String>, ContentTreeError> {
    let Some(entries) = config.get("spaces").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    entries
        .iter()
        .map(|entry| {
            entry
                .get("id")
                .and_then(Value::as_str)
                .map(ToString::to_string)
                .ok_or_else(|| ContentTreeError::Invalid("registered Space has no id".into()))
        })
        .collect()
}

fn storage_error(error: crate::variables::Error) -> ContentTreeError {
    ContentTreeError::Invalid(format!("Storage: {error}"))
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

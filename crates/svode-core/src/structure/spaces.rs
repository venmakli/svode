//! Ordering rule for the child Spaces registered by a Project.
//!
//! The Project itself is never part of the order. Persisting the new order into
//! the Project config stays with the host that owns the Space registry.

use std::collections::HashSet;

use crate::content_tree::ContentTreeError;

/// Validate a proposed child-Space order against the registered ids and return
/// the ids in their new order. The proposal must be exactly the registered ids,
/// with no duplicates, missing or unknown ids, so a stale client cannot drop a
/// Space from the registry by reordering it.
pub fn plan_child_space_order(
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

/// The error a caller reports when a planned id is no longer registered.
pub fn unknown_child_space(id: &str) -> ContentTreeError {
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

    #[test]
    fn a_missing_registered_id_is_reported_before_unknown_ids() {
        let error =
            plan_child_space_order(&ids(&["a", "b"]), ids(&["a", "z"])).expect_err("missing id");

        assert!(error.to_string().contains("missing ids: b"));
    }
}

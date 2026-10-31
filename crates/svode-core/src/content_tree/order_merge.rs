//! The merge rule of `.svode/order.json`, owned by Pages (module 01, 1.C).
//!
//! The sides are base, ours (local) and theirs (incoming); a missing side is
//! an empty order. A folder list changed by one side is taken from it. A list
//! changed by both starts from the incoming one: names the local side removed
//! go, names it added go after their nearest preceding local neighbour that
//! is in the result, or first. Both sides reordering the same folder keep the
//! incoming order. A folder removed by one side and changed by the other is
//! kept. Duplicates go, and the result is written by the order file's own
//! writer, so its layout does not depend on the order of the changes.

use std::collections::BTreeSet;

use indexmap::IndexMap;

use super::{SpaceOrder, parse_order, render_order};
use crate::git::service_merge::{
    ConflictedPath, Resolution, RuleContext, RuleFuture, RuleOutcome, ServiceRule,
};

type Sections = IndexMap<String, Vec<String>>;

pub struct OrderRule;

impl ServiceRule for OrderRule {
    fn claims(&self, conflict: &ConflictedPath) -> bool {
        is_order_path(&conflict.path) && conflict.sides().all(|side| side.is_regular_file())
    }

    fn resolve<'a>(
        &'a self,
        ctx: &'a RuleContext<'a>,
        conflict: &'a ConflictedPath,
    ) -> RuleFuture<'a> {
        Box::pin(async move {
            let base = ctx.blob(conflict.base.as_ref()).await?;
            let ours = ctx.blob(conflict.ours.as_ref()).await?;
            let theirs = ctx.blob(conflict.theirs.as_ref()).await?;
            Ok(
                match merge_order(base.as_deref(), ours.as_deref(), theirs.as_deref()) {
                    Some(text) => RuleOutcome::Resolved(Resolution::Content(text.into_bytes())),
                    None => RuleOutcome::Declined,
                },
            )
        })
    }
}

/// The order file of a Space at the repository-relative `path`.
fn is_order_path(path: &str) -> bool {
    path == ".svode/order.json" || path.ends_with("/.svode/order.json")
}

/// The merged text of three order files, `None` for a side Svode does not
/// read as an order (the conflict stays with the person).
pub(crate) fn merge_order(
    base: Option<&[u8]>,
    ours: Option<&[u8]>,
    theirs: Option<&[u8]>,
) -> Option<String> {
    let base = sections(base)?;
    let ours = sections(ours)?;
    let theirs = sections(theirs)?;
    let mut result = SpaceOrder {
        sections: theirs.clone(),
    };
    let keys: BTreeSet<&String> = base
        .keys()
        .chain(ours.keys())
        .chain(theirs.keys())
        .collect();
    for key in keys {
        let (b, o, t) = (base.get(key), ours.get(key), theirs.get(key));
        let merged = if o == b {
            t.cloned()
        } else if t == b {
            o.cloned()
        } else {
            match (o, t) {
                (Some(o), Some(t)) => {
                    Some(merge_list(b.map(Vec::as_slice).unwrap_or_default(), o, t))
                }
                // A folder removed by one side and changed by the other stays.
                (Some(kept), None) | (None, Some(kept)) => Some(kept.clone()),
                (None, None) => None,
            }
        };
        match merged {
            Some(children) => *result.children_mut(key) = unique(children),
            None => {
                result.remove(key);
            }
        }
    }
    render_order(&result).ok()
}

/// A side as directory key → child names, keys as every reader normalizes
/// them; a missing side is empty.
fn sections(side: Option<&[u8]>) -> Option<Sections> {
    let Some(bytes) = side else {
        return Some(Sections::new());
    };
    let order = parse_order(std::str::from_utf8(bytes).ok()?).ok()?;
    Some(
        order
            .into_iter()
            .map(|(key, children)| (key.replace('\\', "/"), children))
            .collect(),
    )
}

/// One folder list changed by both sides.
fn merge_list(base: &[String], ours: &[String], theirs: &[String]) -> Vec<String> {
    let mut result: Vec<String> = theirs
        .iter()
        .filter(|name| !(base.contains(name) && !ours.contains(name)))
        .cloned()
        .collect();
    for (index, name) in ours.iter().enumerate() {
        if base.contains(name) || result.contains(name) {
            continue;
        }
        let at = ours[..index]
            .iter()
            .rev()
            .find_map(|neighbour| result.iter().position(|known| known == neighbour))
            .map_or(0, |position| position + 1);
        result.insert(at, name.clone());
    }
    result
}

fn unique(children: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    children
        .into_iter()
        .filter(|name| seen.insert(name.clone()))
        .collect()
}

#[cfg(test)]
#[path = "order_merge_tests.rs"]
mod tests;

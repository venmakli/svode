use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StructuralOp {
    Create(String),
    Delete(String),
    Rename { old: String, new: String },
    Move(String),
    Reorder,
    ConvertToFolder(String),
    ConvertToLeaf(String),
    MakeCollection(String),
    Duplicate { old: String, new: String },
    CreateTemplate(String),
    DeleteTemplate(String),
    DuplicateTemplate { old: String, new: String },
    InstantiateTemplate { title: String, parent: String },
}

#[derive(Clone)]
struct PendingItem {
    op: Option<StructuralOp>,
    paths: Vec<PathBuf>,
}

struct PendingBatch {
    items: Vec<PendingItem>,
}

pub struct PendingSave {
    pending: Arc<Mutex<HashMap<PathBuf, PendingBatch>>>,
    space: PathBuf,
    items: Vec<PendingItem>,
}

impl PendingSave {
    pub fn paths(&self) -> Vec<PathBuf> {
        dedupe_paths(self.items.iter().flat_map(|item| item.paths.clone()))
    }

    pub fn complete(&mut self) {
        self.items.clear();
    }
}

impl Drop for PendingSave {
    fn drop(&mut self) {
        if self.items.is_empty() {
            return;
        }
        let mut map = self.pending.lock().unwrap();
        map.entry(self.space.clone())
            .or_insert_with(|| PendingBatch { items: Vec::new() })
            .items
            .append(&mut self.items);
    }
}

#[derive(Default)]
pub struct PendingPaths {
    pending: Arc<Mutex<HashMap<PathBuf, PendingBatch>>>,
}

impl PendingPaths {
    pub fn begin_save(&self, space: &Path, anchors: Option<&[PathBuf]>) -> PendingSave {
        let mut map = self.pending.lock().unwrap();
        let mut selected = Vec::new();
        if let Some(batch) = map.get_mut(space) {
            let ops = anchors.map(|anchors| {
                batch
                    .items
                    .iter()
                    .filter(|item| pending_item_touches(item, anchors))
                    .filter_map(|item| item.op.clone())
                    .collect::<Vec<_>>()
            });
            batch.items.retain(|item| {
                let related = anchors.is_none_or(|anchors| {
                    pending_item_touches(item, anchors)
                        || item
                            .op
                            .as_ref()
                            .is_some_and(|op| ops.as_ref().is_some_and(|ops| ops.contains(op)))
                });
                if related {
                    selected.push(item.clone());
                }
                !related
            });
        }
        PendingSave {
            pending: self.pending.clone(),
            space: space.to_path_buf(),
            items: selected,
        }
    }

    pub fn record(&self, space: &Path, op: Option<StructuralOp>, paths: Vec<PathBuf>) {
        let mut map = self.pending.lock().unwrap();
        let entry = map
            .entry(space.to_path_buf())
            .or_insert_with(|| PendingBatch { items: Vec::new() });
        entry.items.push(PendingItem {
            op,
            paths: paths
                .into_iter()
                .map(|path| {
                    if path.is_absolute() {
                        path
                    } else {
                        space.join(path)
                    }
                })
                .collect(),
        });
    }

    pub fn clear(&self) {
        self.pending.lock().unwrap().clear();
    }
}

fn pending_item_touches(item: &PendingItem, anchor_paths: &[PathBuf]) -> bool {
    item.paths
        .iter()
        .any(|path| anchor_paths.iter().any(|anchor| path == anchor))
}

fn dedupe_paths(paths: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    let mut unique = Vec::new();
    for path in paths {
        if !unique.iter().any(|existing: &PathBuf| existing == &path) {
            unique.push(path);
        }
    }
    unique
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_save_restores_pending_and_success_retains_new_events() {
        let state = PendingPaths::default();
        let space = PathBuf::from("/space");
        state.record(
            &space,
            None,
            vec![space.join("old.md"), space.join("new.md")],
        );

        {
            let _save = state.begin_save(&space, None);
        }
        assert_eq!(state.begin_save(&space, None).paths().len(), 2);

        state.record(&space, None, vec![space.join("old.md")]);
        let mut save = state.begin_save(&space, None);
        state.record(&space, None, vec![space.join("later.md")]);
        save.complete();
        drop(save);

        assert_eq!(
            state.begin_save(&space, None).paths(),
            vec![space.join("later.md")]
        );
    }

    #[test]
    fn scoped_save_keeps_unrelated_pending_paths() {
        let state = PendingPaths::default();
        let space = PathBuf::from("/space");
        state.record(&space, None, vec![space.join("selected.md")]);
        state.record(&space, None, vec![space.join("other.md")]);

        let mut selected = state.begin_save(&space, Some(&[space.join("selected.md")]));
        assert_eq!(selected.paths(), vec![space.join("selected.md")]);
        selected.complete();

        assert_eq!(
            state.begin_save(&space, None).paths(),
            vec![space.join("other.md")]
        );
    }

    #[test]
    fn scoped_save_drains_all_paths_from_the_same_structural_operation() {
        let state = PendingPaths::default();
        let space = PathBuf::from("/space");
        let operation = StructuralOp::Rename {
            old: "old.md".to_string(),
            new: "new.md".to_string(),
        };
        state.record(
            &space,
            Some(operation.clone()),
            vec![space.join("old.md"), space.join("new.md")],
        );
        state.record(&space, Some(operation), vec![space.join("backlink.md")]);
        state.record(
            &space,
            Some(StructuralOp::Create("other.md".to_string())),
            vec![space.join("other.md")],
        );

        let mut save = state.begin_save(&space, Some(&[space.join("new.md")]));
        assert_eq!(
            save.paths(),
            vec![
                space.join("old.md"),
                space.join("new.md"),
                space.join("backlink.md"),
            ]
        );
        save.complete();

        assert_eq!(
            state.begin_save(&space, None).paths(),
            vec![space.join("other.md")]
        );
    }
}

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
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

static NEXT_OPERATION: AtomicU64 = AtomicU64::new(1);

/// Identity of one managed structural operation. Every pending item the
/// operation records, in any Space, carries it; equal labels never group
/// items of different operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct OperationId(u64);

impl OperationId {
    pub fn next() -> Self {
        Self(NEXT_OPERATION.fetch_add(1, Ordering::Relaxed))
    }
}

/// The entity path an operation moved away from and the one it moved to. A
/// folder entity is represented by its directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Relocation {
    pub source: PathBuf,
    pub target: PathBuf,
}

impl Relocation {
    fn endpoints(&self) -> [&PathBuf; 2] {
        [&self.source, &self.target]
    }
}

/// One registration of a managed structural operation for the next manual
/// save: its identity, history label and, for the registration owning a
/// relocated entity, the relocation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StructuralChange {
    id: OperationId,
    pub op: StructuralOp,
    relocation: Option<Relocation>,
}

impl StructuralChange {
    /// A new operation.
    pub fn new(op: StructuralOp) -> Self {
        Self::of(OperationId::next(), op)
    }

    /// A registration of an already identified operation.
    pub fn of(id: OperationId, op: StructuralOp) -> Self {
        Self {
            id,
            op,
            relocation: None,
        }
    }

    pub fn relocating(mut self, relocation: Relocation) -> Self {
        self.relocation = Some(relocation);
        self
    }

    /// The same operation for its companion paths (backlinks, other Spaces):
    /// they share the identity but never extend a relocation chain.
    pub fn companion(&self) -> Self {
        Self::of(self.id, self.op.clone())
    }

    pub fn id(&self) -> OperationId {
        self.id
    }
}

#[derive(Clone)]
struct PendingItem {
    change: Option<StructuralChange>,
    paths: Vec<PathBuf>,
}

impl PendingItem {
    fn id(&self) -> Option<OperationId> {
        self.change.as_ref().map(StructuralChange::id)
    }

    fn relocation(&self) -> Option<&Relocation> {
        self.change.as_ref()?.relocation.as_ref()
    }

    /// A path equal to an anchor, or a relocation endpoint at or above it: a
    /// file saved inside a relocated folder belongs to that relocation.
    fn touches(&self, anchors: &[PathBuf]) -> bool {
        anchors.iter().any(|anchor| {
            self.paths.iter().any(|path| path == anchor)
                || self.relocation().is_some_and(|relocation| {
                    relocation
                        .endpoints()
                        .into_iter()
                        .any(|endpoint| anchor.starts_with(endpoint))
                })
        })
    }
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
    /// Take what a save of `anchors` (or of the whole Space when `None`)
    /// commits: items touching an anchor, every item of their operations and,
    /// transitively in both directions, operations whose relocation shares an
    /// endpoint with a selected one.
    pub fn begin_save(&self, space: &Path, anchors: Option<&[PathBuf]>) -> PendingSave {
        let mut map = self.pending.lock().unwrap();
        let mut selected = Vec::new();
        if let Some(batch) = map.get_mut(space) {
            let mut chosen = match anchors {
                Some(anchors) => lineage(&batch.items, anchors),
                None => vec![true; batch.items.len()],
            }
            .into_iter();
            batch.items.retain(|item| {
                let take = chosen.next().unwrap_or(false);
                if take {
                    selected.push(item.clone());
                }
                !take
            });
        }
        PendingSave {
            pending: self.pending.clone(),
            space: space.to_path_buf(),
            items: selected,
        }
    }

    pub fn record(&self, space: &Path, change: Option<StructuralChange>, paths: Vec<PathBuf>) {
        let mut map = self.pending.lock().unwrap();
        let entry = map
            .entry(space.to_path_buf())
            .or_insert_with(|| PendingBatch { items: Vec::new() });
        entry.items.push(PendingItem {
            change,
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

/// Grow the anchored selection to a fixed point over operation identity and
/// relocation endpoints. Companion paths such as order files or backlinks
/// never link operations.
fn lineage(items: &[PendingItem], anchors: &[PathBuf]) -> Vec<bool> {
    let mut chosen = items
        .iter()
        .map(|item| item.touches(anchors))
        .collect::<Vec<_>>();
    loop {
        let mut ids = HashSet::new();
        let mut endpoints = HashSet::new();
        for (item, _) in items.iter().zip(&chosen).filter(|(_, chosen)| **chosen) {
            ids.extend(item.id());
            if let Some(relocation) = item.relocation() {
                endpoints.extend(relocation.endpoints().map(PathBuf::clone));
            }
        }
        let mut grew = false;
        for (item, chosen) in items.iter().zip(chosen.iter_mut()) {
            let related = item.id().is_some_and(|id| ids.contains(&id))
                || item.relocation().is_some_and(|relocation| {
                    relocation
                        .endpoints()
                        .into_iter()
                        .any(|endpoint| endpoints.contains(endpoint))
                });
            if !*chosen && related {
                *chosen = true;
                grew = true;
            }
        }
        if !grew {
            return chosen;
        }
    }
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

    fn rename(old: &str, new: &str) -> StructuralOp {
        StructuralOp::Rename {
            old: old.to_string(),
            new: new.to_string(),
        }
    }

    /// Record a relocation of `from` to `to` in `space` with the order file
    /// and `companions`, and return the operation for further registrations.
    fn relocate(
        state: &PendingPaths,
        space: &Path,
        op: StructuralOp,
        from: &str,
        to: &str,
        companions: &[&str],
    ) -> StructuralChange {
        let change = StructuralChange::new(op).relocating(Relocation {
            source: space.join(from),
            target: space.join(to),
        });
        let mut paths = vec![
            space.join(".svode/order.json"),
            space.join(from),
            space.join(to),
        ];
        paths.extend(companions.iter().map(|path| space.join(path)));
        state.record(space, Some(change.clone()), paths);
        change
    }

    fn sorted(mut paths: Vec<PathBuf>) -> Vec<PathBuf> {
        paths.sort();
        paths
    }

    fn joined(space: &Path, paths: &[&str]) -> Vec<PathBuf> {
        sorted(paths.iter().map(|path| space.join(path)).collect())
    }

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
    fn scoped_save_drains_all_items_of_the_same_operation() {
        let state = PendingPaths::default();
        let space = PathBuf::from("/space");
        let other_space = PathBuf::from("/space/child");
        let change = relocate(
            &state,
            &space,
            rename("old.md", "new.md"),
            "old.md",
            "new.md",
            &[],
        );
        state.record(
            &space,
            Some(change.companion()),
            vec![space.join("backlink.md")],
        );
        state.record(
            &other_space,
            Some(change.companion()),
            vec![other_space.join("link.md")],
        );
        state.record(
            &space,
            Some(StructuralChange::new(StructuralOp::Create(
                "other.md".into(),
            ))),
            vec![space.join("other.md")],
        );

        let mut save = state.begin_save(&space, Some(&[space.join("new.md")]));
        assert_eq!(
            sorted(save.paths()),
            joined(
                &space,
                &[".svode/order.json", "backlink.md", "new.md", "old.md"]
            )
        );
        save.complete();

        assert_eq!(
            state.begin_save(&space, None).paths(),
            vec![space.join("other.md")]
        );
        assert_eq!(
            state.begin_save(&other_space, None).paths(),
            vec![other_space.join("link.md")]
        );
    }

    #[test]
    fn scoped_save_takes_the_whole_relocation_chain_from_either_end() {
        for anchor in ["Accepted.md", "Page.md"] {
            let state = PendingPaths::default();
            let space = PathBuf::from("/space");
            for (index, (from, to)) in [
                ("Page.md", "Renamed.md"),
                ("Renamed.md", "Final.md"),
                ("Final.md", "Accepted.md"),
            ]
            .into_iter()
            .enumerate()
            {
                let change = relocate(&state, &space, rename(from, to), from, to, &[]);
                state.record(
                    &space,
                    Some(change.companion()),
                    vec![space.join(format!("link-{index}.md"))],
                );
            }
            state.record(&space, None, vec![space.join("unrelated.md")]);

            let mut save = state.begin_save(&space, Some(&[space.join(anchor)]));
            assert_eq!(
                sorted(save.paths()),
                joined(
                    &space,
                    &[
                        ".svode/order.json",
                        "Accepted.md",
                        "Final.md",
                        "Page.md",
                        "Renamed.md",
                        "link-0.md",
                        "link-1.md",
                        "link-2.md",
                    ]
                ),
                "anchor {anchor}"
            );
            save.complete();
            assert_eq!(
                state.begin_save(&space, None).paths(),
                vec![space.join("unrelated.md")]
            );
        }
    }

    #[test]
    fn a_file_inside_a_relocated_folder_selects_the_folder_chain() {
        let state = PendingPaths::default();
        let space = PathBuf::from("/space");
        relocate(
            &state,
            &space,
            rename("Page", "Plan"),
            "Page.md",
            "Plan.md",
            &[],
        );
        relocate(
            &state,
            &space,
            StructuralOp::Move("Plan.md".into()),
            "Plan.md",
            "Area/Plan.md",
            &[],
        );
        relocate(
            &state,
            &space,
            StructuralOp::ConvertToFolder("Plan".into()),
            "Area/Plan.md",
            "Area/Plan",
            &[],
        );

        let save = state.begin_save(&space, Some(&[space.join("Area/Plan/README.md")]));
        assert_eq!(
            sorted(save.paths()),
            joined(
                &space,
                &[
                    ".svode/order.json",
                    "Area/Plan",
                    "Area/Plan.md",
                    "Page.md",
                    "Plan.md",
                ]
            )
        );
    }

    #[test]
    fn equal_labels_and_shared_companions_do_not_join_operations() {
        let state = PendingPaths::default();
        let space = PathBuf::from("/space");
        relocate(
            &state,
            &space,
            rename("Note.md", "Plan.md"),
            "a/Note.md",
            "a/Plan.md",
            &["target.md"],
        );
        relocate(
            &state,
            &space,
            rename("Note.md", "Plan.md"),
            "b/Note.md",
            "b/Plan.md",
            &["target.md"],
        );
        let sensitive = rename("collection entry", "collection entry");
        relocate(
            &state,
            &space,
            sensitive.clone(),
            "tasks/x.md",
            "tasks/y.md",
            &[],
        );
        relocate(&state, &space, sensitive, "tasks/p.md", "tasks/q.md", &[]);

        let mut save = state.begin_save(&space, Some(&[space.join("a/Plan.md")]));
        assert_eq!(
            sorted(save.paths()),
            joined(
                &space,
                &[".svode/order.json", "a/Note.md", "a/Plan.md", "target.md"]
            )
        );
        save.complete();

        let mut save = state.begin_save(&space, Some(&[space.join("tasks/y.md")]));
        assert_eq!(
            sorted(save.paths()),
            joined(&space, &[".svode/order.json", "tasks/x.md", "tasks/y.md"])
        );
        save.complete();

        assert_eq!(
            sorted(state.begin_save(&space, None).paths()),
            joined(
                &space,
                &[
                    ".svode/order.json",
                    "b/Note.md",
                    "b/Plan.md",
                    "target.md",
                    "tasks/p.md",
                    "tasks/q.md",
                ]
            )
        );
    }

    #[test]
    fn a_failed_chain_save_restores_every_taken_item() {
        let state = PendingPaths::default();
        let space = PathBuf::from("/space");
        relocate(&state, &space, rename("A", "B"), "A.md", "B.md", &[]);
        relocate(&state, &space, rename("B", "C"), "B.md", "C.md", &[]);
        {
            let _save = state.begin_save(&space, Some(&[space.join("C.md")]));
        }
        let save = state.begin_save(&space, Some(&[space.join("C.md")]));
        assert_eq!(
            sorted(save.paths()),
            joined(&space, &[".svode/order.json", "A.md", "B.md", "C.md"])
        );
    }
}

//! Version groups (Stage 11 1.G): one reason, one commit. Svode groups the
//! changes it commits by what it knows about the data, not by the file list:
//! a managed operation with the paths it touched, the creation of a Page
//! with its renames before the first commit, then the remaining changes by
//! their owner. Kinds of changes and repositories never share a group.

use std::path::Path;

use crate::git::pending::{OperationId, StructuralOp};

use super::changes::{ChangeStatus, PathChange, Sources};

/// Most groups of changes no operation claimed that one commit action
/// splits into; a larger set, such as thousands of files changed outside
/// Svode, lands as one commit of the repository so that a commit of any
/// size stays a bounded number of Git calls (DF-270).
pub const MAX_OWNER_GROUPS: usize = 50;

/// What a group of changes is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum GroupKind {
    /// A managed operation on a committed object, with the links, order and
    /// relations it touched.
    Operation,
    /// A Page created since the last commit, with its renames, moves and
    /// edits.
    Creation,
    /// Edits of one Page or record.
    Page,
    /// Field edits of the records of one Collection.
    Fields,
    /// The schema and views of one Collection.
    Schema,
    /// Attachments added to or removed from one owner.
    Attachments,
    /// Other content of one folder, such as its order.
    Folder,
    /// System settings: config of a Space, ignore rules, agent instructions.
    System,
    /// Structure: Space pointers and submodule metadata.
    Structural,
}

impl GroupKind {
    /// Whether the group holds content rather than system or structural
    /// changes (Stage 11 1.E: kinds of commits never mix).
    pub fn is_content(self) -> bool {
        !matches!(self, Self::System | Self::Structural)
    }
}

/// A registration of a managed operation (or of a touched set without one)
/// waiting for a commit, with repository-relative paths.
#[derive(Debug, Clone)]
pub struct PendingOperation {
    pub id: Option<OperationId>,
    pub op: Option<StructuralOp>,
    /// Where the operation moved its entity: source and target.
    pub relocation: Option<(String, String)>,
    pub paths: Vec<String>,
}

/// The entity of an operation group.
#[derive(Debug, Clone, Default)]
pub(crate) struct OperationShape {
    /// The committed path the chain of relocations started at and the path
    /// it ended at.
    pub origin: Option<String>,
    pub target: Option<String>,
    pub deletes: bool,
}

/// One group: the changes one commit takes.
#[derive(Debug, Clone)]
pub struct VersionGroup {
    pub kind: GroupKind,
    /// The owner the group is keyed by: a Page path, a Collection or folder
    /// directory; empty for the repository root.
    pub owner: String,
    pub changes: Vec<PathChange>,
    pub(crate) operation: Option<OperationShape>,
}

impl VersionGroup {
    /// Every path the commit of the group takes, rename sources included.
    pub fn paths(&self) -> Vec<String> {
        let mut paths = Vec::new();
        for change in &self.changes {
            for path in change.paths() {
                if !paths.iter().any(|known| known == path) {
                    paths.push(path.to_string());
                }
            }
        }
        paths
    }

    /// The key an open group keeps between changes: its kind and owner.
    pub fn key(&self) -> (GroupKind, &str) {
        (self.kind, &self.owner)
    }
}

/// Split `changes` into groups. `operations` are the pending registrations
/// in order; an operation group claims the content changes at or under the
/// paths of its operations, linked by identity and relocation endpoints.
pub(crate) fn group_changes(
    repo: &Path,
    changes: Vec<PathChange>,
    operations: &[PendingOperation],
    sources: &Sources,
) -> Vec<VersionGroup> {
    let mut left = changes.into_iter().map(Some).collect::<Vec<_>>();
    let mut groups = Vec::<VersionGroup>::new();

    // System and structural changes keep their own commits.
    let mut system = Vec::<VersionGroup>::new();
    for slot in left.iter_mut() {
        let Some(change) = slot.as_ref() else {
            continue;
        };
        let kind = if change.gitlink || change.path == ".gitmodules" {
            Some((GroupKind::Structural, String::new()))
        } else {
            system_owner(&change.path).map(|owner| (GroupKind::System, owner))
        };
        if let Some((kind, owner)) = kind {
            let change = slot.take().expect("checked above");
            push(&mut system, kind, owner, change);
        }
    }

    for component in components(operations) {
        let ops = component.iter().map(|index| &operations[*index]);
        let mut claimed = Vec::new();
        for op in ops.clone() {
            for path in &op.paths {
                for slot in left.iter_mut() {
                    if slot
                        .as_ref()
                        .is_some_and(|change| change.paths().any(|own| at_or_under(own, path)))
                    {
                        claimed.push(slot.take().expect("checked above"));
                    }
                }
            }
        }
        if claimed.is_empty() {
            continue;
        }
        let shape = shape(ops.clone());
        let creation = ops.clone().any(|op| {
            matches!(
                op.op,
                Some(
                    StructuralOp::Create(_)
                        | StructuralOp::Duplicate { .. }
                        | StructuralOp::InstantiateTemplate { .. }
                )
            )
        }) || (shape.origin.is_some()
            && !committed(shape.origin.as_deref(), &claimed));
        let kind = if creation {
            GroupKind::Creation
        } else {
            GroupKind::Operation
        };
        let owner = shape
            .target
            .clone()
            .or_else(|| claimed.first().map(|change| change.path.clone()))
            .unwrap_or_default();
        groups.push(VersionGroup {
            kind,
            owner,
            changes: claimed,
            operation: Some(shape),
        });
    }

    // A touched set without an operation that rewrote a schema, such as a
    // field rename migrating its records, belongs with that schema.
    let mut owned = Vec::<VersionGroup>::new();
    for op in operations.iter().filter(|op| op.op.is_none()) {
        let Some(schema) = op.paths.iter().find(|path| is_schema(path)) else {
            continue;
        };
        let owner = parent(schema).to_string();
        for slot in left.iter_mut() {
            if slot.as_ref().is_some_and(|change| {
                change
                    .paths()
                    .any(|own| op.paths.iter().any(|path| at_or_under(own, path)))
            }) {
                let change = slot.take().expect("checked above");
                push(&mut owned, GroupKind::Schema, owner.clone(), change);
            }
        }
    }

    for change in left.into_iter().flatten() {
        let (kind, owner) = owner_of(repo, &change, sources);
        push(&mut owned, kind, owner, change);
    }
    if owned.len() > MAX_OWNER_GROUPS {
        owned = vec![VersionGroup {
            kind: GroupKind::Folder,
            owner: String::new(),
            changes: owned.into_iter().flat_map(|group| group.changes).collect(),
            operation: None,
        }];
    }
    owned.sort_by(|a, b| a.owner.cmp(&b.owner).then(a.kind.cmp(&b.kind)));
    system.sort_by(|a, b| a.kind.cmp(&b.kind).then(a.owner.cmp(&b.owner)));
    groups.extend(owned);
    groups.extend(system);
    groups
}

fn push(groups: &mut Vec<VersionGroup>, kind: GroupKind, owner: String, change: PathChange) {
    match groups
        .iter_mut()
        .find(|group| group.kind == kind && group.owner == owner)
    {
        Some(group) => group.changes.push(change),
        None => groups.push(VersionGroup {
            kind,
            owner,
            changes: vec![change],
            operation: None,
        }),
    }
}

/// The owner of a change no operation claimed (Stage 11 1.G: changes Svode
/// cannot attribute group by their Page, Collection or folder).
fn owner_of(repo: &Path, change: &PathChange, sources: &Sources) -> (GroupKind, String) {
    let path = change.path.as_str();
    if is_page(path) {
        // An unreadable schema keeps its records in the Collection.
        let collection = crate::collections::schema::find_collection_root(repo, path)
            .map(|root| root.to_string_lossy().replace('\\', "/"));
        if let Some(root) = collection
            && change.status == ChangeStatus::Modified
            && fields_only(sources, path)
        {
            return (GroupKind::Fields, root);
        }
        return (GroupKind::Page, path.to_string());
    }
    if is_schema(path) {
        return (GroupKind::Schema, parent(path).to_string());
    }
    if let Some((collection, _)) = path.split_once("/.templates/") {
        return (GroupKind::Schema, collection.to_string());
    }
    if let Some(dir) = path.strip_suffix(".svode/order.json") {
        return (GroupKind::Folder, dir.trim_end_matches('/').to_string());
    }
    if let Some((dir, _)) = svode_dir(path) {
        return (GroupKind::Folder, dir.to_string());
    }
    (GroupKind::Attachments, parent(path).to_string())
}

/// Whether only the frontmatter of the Page at `path` changed.
fn fields_only(sources: &Sources, path: &str) -> bool {
    let (Some(old), Some(new)) = (sources.head(path), sources.work(path)) else {
        return false;
    };
    let old = crate::page::changes::PageVersion::read(old);
    let new = crate::page::changes::PageVersion::read(&new);
    old.same_text(&new) && old.title == new.title
}

/// The owner folder of a system settings file.
fn system_owner(path: &str) -> Option<String> {
    let file = path.rsplit('/').next().unwrap_or(path);
    if matches!(
        file,
        ".gitignore" | ".gitattributes" | ".lfsconfig" | ".mailmap"
    ) {
        return Some(parent(path).to_string());
    }
    let (dir, name) = svode_dir(path)?;
    matches!(name, "config.json" | "AGENTS.md").then(|| dir.to_string())
}

/// The folder owning a direct `.svode/<name>` file, and the name.
fn svode_dir(path: &str) -> Option<(&str, &str)> {
    let (rest, name) = path.rsplit_once('/')?;
    if name.contains('/') {
        return None;
    }
    if rest == ".svode" {
        return Some(("", name));
    }
    let dir = rest.strip_suffix("/.svode")?;
    Some((dir, name))
}

/// Groups of operations linked by identity or a shared relocation
/// endpoint, in order of their first registration. Touched sets without an
/// operation never link.
fn components(operations: &[PendingOperation]) -> Vec<Vec<usize>> {
    let mut component = (0..operations.len()).collect::<Vec<_>>();
    fn find(component: &mut [usize], index: usize) -> usize {
        let mut root = index;
        while component[root] != root {
            root = component[root];
        }
        component[index] = root;
        root
    }
    for a in 0..operations.len() {
        for b in a + 1..operations.len() {
            let (left, right) = (&operations[a], &operations[b]);
            if left.op.is_none() || right.op.is_none() {
                continue;
            }
            let same_id = left.id.is_some() && left.id == right.id;
            let chained = match (&left.relocation, &right.relocation) {
                (Some((ls, lt)), Some((rs, rt))) => ls == rs || ls == rt || lt == rs || lt == rt,
                _ => false,
            };
            if same_id || chained {
                let (ra, rb) = (find(&mut component, a), find(&mut component, b));
                component[rb.max(ra)] = ra.min(rb);
            }
        }
    }
    let mut groups = Vec::<(usize, Vec<usize>)>::new();
    for (index, operation) in operations.iter().enumerate() {
        if operation.op.is_none() {
            continue;
        }
        let root = find(&mut component, index);
        match groups.iter_mut().find(|(known, _)| *known == root) {
            Some((_, members)) => members.push(index),
            None => groups.push((root, vec![index])),
        }
    }
    groups.into_iter().map(|(_, members)| members).collect()
}

/// The entity of a component: the chain of relocations from the source no
/// other relocation leads to, to the target no other leaves from.
fn shape<'a>(ops: impl Iterator<Item = &'a PendingOperation> + Clone) -> OperationShape {
    let relocations = ops
        .clone()
        .filter_map(|op| op.relocation.as_ref())
        .collect::<Vec<_>>();
    let origin = relocations
        .iter()
        .find(|(source, _)| !relocations.iter().any(|(_, target)| target == source))
        .map(|(source, _)| source.clone());
    let target = relocations
        .iter()
        .rev()
        .find(|(_, target)| !relocations.iter().any(|(source, _)| source == target))
        .map(|(_, target)| target.clone());
    let deletes = ops
        .clone()
        .any(|op| matches!(op.op, Some(StructuralOp::Delete(_))));
    OperationShape {
        origin,
        target,
        deletes,
    }
}

/// Whether the chain started at a committed path: the commit removes it or
/// moves it away.
fn committed(origin: Option<&str>, claimed: &[PathChange]) -> bool {
    let Some(origin) = origin else {
        return false;
    };
    claimed.iter().any(|change| {
        (change.status == ChangeStatus::Deleted && at_or_under(&change.path, origin))
            || change
                .from
                .as_deref()
                .is_some_and(|from| at_or_under(from, origin))
    })
}

pub(crate) fn at_or_under(path: &str, root: &str) -> bool {
    !root.is_empty()
        && (path == root
            || path
                .strip_prefix(root)
                .is_some_and(|rest| rest.starts_with('/')))
}

pub(crate) fn is_page(path: &str) -> bool {
    path.ends_with(".md")
}

fn is_schema(path: &str) -> bool {
    path == "schema.yaml" || path.ends_with("/schema.yaml")
}

pub(crate) fn parent(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(dir, _)| dir)
}

pub(crate) fn readme_of(dir: &str) -> String {
    if dir.is_empty() {
        "README.md".into()
    } else {
        format!("{dir}/README.md")
    }
}

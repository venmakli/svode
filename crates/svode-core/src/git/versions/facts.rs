//! Facts of a version group (Stage 11 1.G): the closed set Svode recognizes
//! in its own formats, the place the message starts with and the names it
//! takes from Page and Collection titles rather than file names. The Page
//! and Collection modules tell what changed in their sources. The root of
//! the Project and of a Space is named by its `.svode/config.json`, never by
//! the directory a clone lies in on the device (DF-283).

use std::path::Path;

use crate::collections::schema_changes::{SchemaChange, schema_changes};
use crate::page::changes::{PageVersion, field_changes, section_changes};

use super::changes::{ChangeStatus, PathChange, Sources};
use super::group::{GroupKind, VersionGroup, is_page, parent, readme_of};

/// One recognized change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChangeFact {
    PageCreated {
        title: String,
    },
    PageDeleted {
        title: String,
    },
    PageMoved {
        title: String,
        /// The folder it moved to; `None` for a repository root without a
        /// name.
        folder: Option<String>,
    },
    PageRenamed {
        from: String,
        to: String,
    },
    FieldChanged {
        record: String,
        field: String,
        from: Option<String>,
        to: Option<String>,
    },
    SectionChanged {
        page: String,
        heading: Option<String>,
        share: u8,
    },
    SchemaFieldAdded {
        field: String,
    },
    SchemaFieldRemoved {
        field: String,
    },
    SchemaFieldRenamed {
        from: String,
        to: String,
    },
    ViewChanged {
        view: String,
    },
    AttachmentAdded {
        name: String,
    },
    AttachmentRemoved {
        name: String,
    },
}

impl ChangeFact {
    /// A fact that names its Page itself and needs no place before it.
    pub fn self_placed(&self) -> bool {
        matches!(
            self,
            Self::PageCreated { .. }
                | Self::PageDeleted { .. }
                | Self::PageMoved { .. }
                | Self::PageRenamed { .. }
        )
    }
}

/// The owner a message starts with: a Page, a folder or a Collection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Place {
    None,
    Named(String),
    Collection(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlacedFact {
    pub place: Place,
    pub fact: ChangeFact,
}

/// The general wording of a group without recognized facts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum General {
    Page,
    Entries,
    Schema,
    Order,
    Settings,
    Spaces,
    Files,
}

/// What a message of a sensitive Collection may say.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sensitive {
    Created,
    Deleted,
    Renamed,
    Moved,
    Schema,
    Entries(usize),
}

/// Everything a message is composed of.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupFacts {
    pub place: Place,
    pub facts: Vec<PlacedFact>,
    /// Pages an operation updated besides its own: links, relations.
    pub links: usize,
    pub general: General,
    /// Changed Pages and changed files of the group.
    pub pages: usize,
    pub files: usize,
    pub sensitive: Option<Sensitive>,
}

pub(crate) fn facts_of(repo: &Path, group: &VersionGroup, sources: &Sources) -> GroupFacts {
    let names = Names { repo, sources };
    let files = group.changes.len();
    let pages = group
        .changes
        .iter()
        .filter(|change| is_page(&change.path))
        .count();
    let mut facts = GroupFacts {
        place: names.place(&group.owner),
        facts: Vec::new(),
        links: 0,
        general: General::Files,
        pages,
        files,
        sensitive: None,
    };
    let sensitive = group.kind.is_content()
        && group
            .changes
            .iter()
            .flat_map(PathChange::paths)
            .any(|path| in_sensitive_collection(repo, path));
    match group.kind {
        GroupKind::Operation | GroupKind::Creation => {
            operation_facts(&names, group, &mut facts);
        }
        GroupKind::Page => {
            let title = names.page(&group.owner, true);
            facts.place = Place::Named(title);
            facts.general = General::Page;
            if let Some(change) = group
                .changes
                .iter()
                .find(|change| change.path == group.owner)
            {
                let place = facts.place.clone();
                for fact in page_facts(&names, change) {
                    facts.facts.push(PlacedFact {
                        place: place.clone(),
                        fact,
                    });
                }
            }
        }
        GroupKind::Fields => {
            facts.place = names.place(&group.owner);
            facts.general = General::Entries;
            for change in &group.changes {
                let old = PageVersion::read(sources.head(&change.path).unwrap_or_default());
                let new = PageVersion::read(&sources.work(&change.path).unwrap_or_default());
                let record = names.titled(new.title.clone(), &change.path);
                for field in field_changes(&old, &new) {
                    facts.facts.push(PlacedFact {
                        place: facts.place.clone(),
                        fact: ChangeFact::FieldChanged {
                            record: record.clone(),
                            field: field.field,
                            from: field.from,
                            to: field.to,
                        },
                    });
                }
            }
        }
        GroupKind::Schema => {
            facts.place = names
                .folder(&group.owner)
                .map_or(Place::None, Place::Collection);
            facts.general = General::Schema;
            let schema = join(&group.owner, "schema.yaml");
            if group.changes.iter().any(|change| change.path == schema) {
                let old = sources.head(&schema);
                let new = sources.work(&schema);
                for change in schema_changes(old, new.as_deref()) {
                    facts.facts.push(PlacedFact {
                        place: facts.place.clone(),
                        fact: match change {
                            SchemaChange::FieldAdded(field) => {
                                ChangeFact::SchemaFieldAdded { field }
                            }
                            SchemaChange::FieldRemoved(field) => {
                                ChangeFact::SchemaFieldRemoved { field }
                            }
                            SchemaChange::FieldRenamed { from, to } => {
                                ChangeFact::SchemaFieldRenamed { from, to }
                            }
                            SchemaChange::ViewChanged(view) => ChangeFact::ViewChanged { view },
                        },
                    });
                }
            }
        }
        GroupKind::Attachments => {
            for change in &group.changes {
                let name = |path: &str| path.rsplit('/').next().unwrap_or(path).to_string();
                let mut push = |fact| {
                    facts.facts.push(PlacedFact {
                        place: facts.place.clone(),
                        fact,
                    })
                };
                match change.status {
                    ChangeStatus::Added => push(ChangeFact::AttachmentAdded {
                        name: name(&change.path),
                    }),
                    ChangeStatus::Deleted => push(ChangeFact::AttachmentRemoved {
                        name: name(&change.path),
                    }),
                    ChangeStatus::Renamed => {
                        if let Some(from) = &change.from {
                            push(ChangeFact::AttachmentRemoved { name: name(from) });
                        }
                        push(ChangeFact::AttachmentAdded {
                            name: name(&change.path),
                        });
                    }
                    ChangeStatus::Modified => {}
                }
            }
        }
        GroupKind::Folder => {
            if only_order(group) {
                facts.general = General::Order;
            }
        }
        GroupKind::System => facts.general = General::Settings,
        GroupKind::Structural => facts.general = General::Spaces,
    }
    if sensitive {
        facts.sensitive = Some(sensitive_wording(group, &facts));
    }
    facts
}

fn operation_facts(names: &Names, group: &VersionGroup, facts: &mut GroupFacts) {
    let Some(shape) = group.operation.as_ref() else {
        return;
    };
    let mut entity_files = Vec::<String>::new();
    let fact = if group.kind == GroupKind::Creation {
        let created = shape
            .target
            .as_deref()
            .map(page_file)
            .or_else(|| shallowest(group, ChangeStatus::Added));
        created.map(|path| {
            entity_files.push(path.clone());
            ChangeFact::PageCreated {
                title: names.page(&path, true),
            }
        })
    } else if let (Some(origin), Some(target)) = (&shape.origin, &shape.target) {
        entity_files.push(page_file(target));
        let from = names.page(&page_file(origin), false);
        let to = names.page(&page_file(target), true);
        if parent(origin) != parent(target) {
            Some(ChangeFact::PageMoved {
                title: to,
                folder: names.folder(parent(target)),
            })
        } else if from != to {
            Some(ChangeFact::PageRenamed { from, to })
        } else {
            None
        }
    } else if shape.deletes {
        shallowest(group, ChangeStatus::Deleted).map(|path| {
            entity_files.push(path.clone());
            ChangeFact::PageDeleted {
                title: names.page(&path, false),
            }
        })
    } else {
        None
    };
    let entity_dirs = entity_files
        .iter()
        .filter(|path| path.ends_with("/README.md"))
        .map(|path| parent(path).to_string())
        .collect::<Vec<_>>();
    // Without an entity the owner is the first file the group claimed, such
    // as the order of a folder a reorder rewrote: the place is its folder.
    facts.place = names.place(
        entity_files
            .first()
            .map(|path| entity_parent(path))
            .unwrap_or_else(|| file_folder(&group.owner)),
    );
    if fact.is_none() && only_order(group) {
        facts.general = General::Order;
    }
    if let Some(fact) = fact {
        facts.facts.push(PlacedFact {
            place: facts.place.clone(),
            fact,
        });
        facts.links = group
            .changes
            .iter()
            .filter(|change| {
                change.status == ChangeStatus::Modified
                    && is_page(&change.path)
                    && !entity_files.contains(&change.path)
                    && !entity_dirs
                        .iter()
                        .any(|dir| change.path.starts_with(&format!("{dir}/")))
            })
            .count();
    }
}

/// The facts of one Page file change of a Page group.
fn page_facts(names: &Names, change: &PathChange) -> Vec<ChangeFact> {
    let path = &change.path;
    match change.status {
        ChangeStatus::Added => vec![ChangeFact::PageCreated {
            title: names.page(path, true),
        }],
        ChangeStatus::Deleted => vec![ChangeFact::PageDeleted {
            title: names.page(path, false),
        }],
        ChangeStatus::Modified | ChangeStatus::Renamed => {
            let from_path = change.from.as_deref().unwrap_or(path);
            let old_source = names.sources.head(from_path);
            let new_source = names.sources.work(path);
            let old = PageVersion::read(old_source.unwrap_or_default());
            let new = PageVersion::read(new_source.as_deref().unwrap_or_default());
            let old_title = names.titled(old.title.clone(), from_path);
            let new_title = names.titled(new.title.clone(), path);
            let mut facts = Vec::new();
            if parent(from_path) != parent(path) {
                facts.push(ChangeFact::PageMoved {
                    title: new_title.clone(),
                    folder: names.folder(parent(path)),
                });
            } else if old_title != new_title {
                facts.push(ChangeFact::PageRenamed {
                    from: old_title,
                    to: new_title.clone(),
                });
            }
            if old_source.is_none() || new_source.is_none() {
                return facts;
            }
            for field in field_changes(&old, &new) {
                facts.push(ChangeFact::FieldChanged {
                    record: new_title.clone(),
                    field: field.field,
                    from: field.from,
                    to: field.to,
                });
            }
            for section in section_changes(&old.body, &new.body) {
                facts.push(ChangeFact::SectionChanged {
                    page: new_title.clone(),
                    heading: section.heading.clone(),
                    share: section.share(),
                });
            }
            facts
        }
    }
}

fn sensitive_wording(group: &VersionGroup, facts: &GroupFacts) -> Sensitive {
    let first = facts.facts.first().map(|placed| &placed.fact);
    match (group.kind, first) {
        (GroupKind::Schema, _) => Sensitive::Schema,
        (_, Some(ChangeFact::PageCreated { .. })) => Sensitive::Created,
        (_, Some(ChangeFact::PageDeleted { .. })) => Sensitive::Deleted,
        (_, Some(ChangeFact::PageMoved { .. })) => Sensitive::Moved,
        (_, Some(ChangeFact::PageRenamed { .. })) => Sensitive::Renamed,
        (GroupKind::Creation, _) => Sensitive::Created,
        _ => Sensitive::Entries(facts.pages.max(1)),
    }
}

/// The shallowest changed Page of `status`: the root of a folder entity.
fn shallowest(group: &VersionGroup, status: ChangeStatus) -> Option<String> {
    group
        .changes
        .iter()
        .filter(|change| change.status == status && is_page(&change.path))
        .min_by_key(|change| {
            let depth = change.path.matches('/').count();
            // A folder Page is its README, one level below its siblings.
            if change.path.ends_with("/README.md") {
                depth.saturating_sub(1) * 2
            } else {
                depth * 2 + 1
            }
        })
        .map(|change| change.path.clone())
}

fn page_file(entity: &str) -> String {
    if is_page(entity) {
        entity.to_string()
    } else {
        readme_of(entity)
    }
}

/// The folder an entity's Page lives in.
fn entity_parent(page: &str) -> &str {
    if page.ends_with("/README.md") || page == "README.md" {
        parent(parent(page))
    } else {
        parent(page)
    }
}

fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

/// Whether every change of the group is the order of a folder.
fn only_order(group: &VersionGroup) -> bool {
    group
        .changes
        .iter()
        .all(|change| change.path.ends_with(".svode/order.json"))
}

/// The folder a file belongs to: the one owning its `.svode` directory for a
/// Svode service file, its parent otherwise.
fn file_folder(path: &str) -> &str {
    let dir = parent(path);
    if dir == ".svode" {
        ""
    } else {
        dir.strip_suffix("/.svode").unwrap_or(dir)
    }
}

fn is_readme(path: &str) -> bool {
    path.rsplit('/')
        .next()
        .is_some_and(|file| file.eq_ignore_ascii_case("README.md"))
}

/// The last segment of a folder path.
fn segment(dir: &str) -> String {
    dir.rsplit('/').next().unwrap_or(dir).to_string()
}

fn in_sensitive_collection(repo: &Path, path: &str) -> bool {
    sensitive_collection_of(repo, path).is_some()
}

/// The root of the sensitive Collection `path` lies in, relative to the
/// repository; `None` outside one.
pub(super) fn sensitive_collection_of(repo: &Path, path: &str) -> Option<String> {
    crate::collections::schema::resolve_collection_schema_by_location(repo, path)
        .ok()
        .flatten()
        .filter(|(schema, _)| crate::collections::engine::schema_has_sensitive_columns(schema))
        .map(|(_, root)| root.to_string_lossy().replace('\\', "/"))
}

struct Names<'a> {
    repo: &'a Path,
    sources: &'a Sources,
}

impl Names<'_> {
    /// The title of the Page at `path`, from the working tree or HEAD.
    fn page(&self, path: &str, current: bool) -> String {
        let source = if current {
            self.sources
                .work(path)
                .or_else(|| self.sources.head(path).map(str::to_string))
        } else {
            self.sources
                .head(path)
                .map(str::to_string)
                .or_else(|| self.sources.work(path))
        };
        self.titled(
            source.and_then(|source| PageVersion::read(&source).title),
            path,
        )
    }

    /// A Page's `title`, or for a missing or empty one the name of its file:
    /// the stem, and for a README the name of its folder by
    /// [`Names::folder`] without the README itself (DF-283 R2).
    fn titled(&self, title: Option<String>, path: &str) -> String {
        if let Some(title) = title.filter(|title| !title.trim().is_empty()) {
            return title;
        }
        if is_readme(path) {
            let dir = parent(path);
            return self
                .root(dir)
                .flatten()
                .or_else(|| (!dir.is_empty()).then(|| segment(dir)))
                .unwrap_or_else(|| "README".to_string());
        }
        let file = path.rsplit('/').next().unwrap_or(path);
        file.strip_suffix(".md").unwrap_or(file).to_string()
    }

    /// The place a folder names: none for a repository root without a name.
    fn place(&self, dir: &str) -> Place {
        self.folder(dir).map_or(Place::None, Place::Named)
    }

    /// The name of a folder (DF-283 R1): the `name` of the Project or Space
    /// whose root it is, otherwise its README's `title` or its name in the
    /// tree. A repository root without a readable `name` has none; the root of
    /// an Inline Space without one is named as its folder.
    fn folder(&self, dir: &str) -> Option<String> {
        if let Some(root) = self.root(dir) {
            return root.or_else(|| (!dir.is_empty()).then(|| segment(dir)));
        }
        let readme = readme_of(dir);
        let title = self
            .sources
            .work(&readme)
            .or_else(|| self.sources.head(&readme).map(str::to_string))
            .and_then(|source| PageVersion::read(&source).title)
            .filter(|title| !title.trim().is_empty());
        Some(title.unwrap_or_else(|| segment(dir)))
    }

    /// For the root of the repository or of an Inline Space in it, the
    /// `name` of its `.svode/config.json` if it reads; `None` for any other
    /// folder. The directory of the repository on the device never names it.
    fn root(&self, dir: &str) -> Option<Option<String>> {
        let root = self.repo.join(dir);
        if !dir.is_empty() && !root.join(".svode").join("config.json").is_file() {
            return None;
        }
        Some(
            crate::space_config::read(&root)
                .ok()
                .map(|config| config.name)
                .filter(|name| !name.trim().is_empty()),
        )
    }
}

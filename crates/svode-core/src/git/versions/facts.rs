//! Facts of a version group (Stage 11 1.G): the closed set Svode recognizes
//! in its own formats, the place the message starts with and the names it
//! takes from Page and Collection titles rather than file names. The Page
//! and Collection modules tell what changed in their sources.

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
        folder: String,
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
        place: Place::Named(names.folder(&group.owner)),
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
            facts.place = Place::Named(names.folder(&group.owner));
            facts.general = General::Entries;
            for change in &group.changes {
                let old = PageVersion::read(sources.head(&change.path).unwrap_or_default());
                let new = PageVersion::read(&sources.work(&change.path).unwrap_or_default());
                let record = new
                    .title
                    .clone()
                    .unwrap_or_else(|| file_title(&change.path));
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
            facts.place = Place::Collection(names.folder(&group.owner));
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
            if group
                .changes
                .iter()
                .all(|change| change.path.ends_with(".svode/order.json"))
            {
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
    facts.place = Place::Named(
        names.folder(
            entity_files
                .first()
                .map(|path| entity_parent(path))
                .unwrap_or(&group.owner),
        ),
    );
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
            let old_title = old.title.clone().unwrap_or_else(|| file_title(from_path));
            let new_title = new.title.clone().unwrap_or_else(|| file_title(path));
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

/// A Page's name from its file: the folder of a README, the stem otherwise.
fn file_title(path: &str) -> String {
    let file = path.rsplit('/').next().unwrap_or(path);
    if file.eq_ignore_ascii_case("README.md") {
        let dir = parent(path);
        return dir.rsplit('/').next().unwrap_or(dir).to_string();
    }
    file.strip_suffix(".md").unwrap_or(file).to_string()
}

fn in_sensitive_collection(repo: &Path, path: &str) -> bool {
    crate::collections::schema::resolve_collection_schema_by_location(repo, path)
        .ok()
        .flatten()
        .is_some_and(|(schema, _)| {
            crate::collections::engine::schema_has_sensitive_columns(&schema)
        })
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
        let title = source
            .and_then(|source| PageVersion::read(&source).title)
            .unwrap_or_else(|| file_title(path));
        if title.is_empty() {
            self.root_name()
        } else {
            title
        }
    }

    /// The title of a folder: its README's, or its name.
    fn folder(&self, dir: &str) -> String {
        let readme = readme_of(dir);
        let source = self
            .sources
            .work(&readme)
            .or_else(|| self.sources.head(&readme).map(str::to_string));
        if let Some(title) = source.and_then(|source| PageVersion::read(&source).title) {
            return title;
        }
        if dir.is_empty() {
            return self.root_name();
        }
        dir.rsplit('/').next().unwrap_or(dir).to_string()
    }

    fn root_name(&self) -> String {
        self.repo
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default()
    }
}

//! The renumbering of `unique_id` numbers that the integration of an
//! upstream revision repeats (DF-237 R3), owned by Collections.
//!
//! The Git integration step reads the repeats of the working copy
//! ([`repeats_in_repository`]), what the observed upstream revision holds at
//! their paths, and calls [`renumber`]: in a group of items with one number
//! where exactly one item has that number at its path in the upstream
//! revision, that item keeps it and the others get new numbers by the rule
//! of allocation, in ascending order of path. Git decides which of these
//! changes go into its merge commit, with the transforms of the index
//! versions here ([`item_source_with_number`], [`schema_source_with_next`]).

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::engine::{read_collection_schema, reassign_unique_ids, unique_id_display_value};
use super::list::list_collections;
use super::model::{Column, PropertyType};
use super::schema::parse_schema;
use super::schema_support::unique_id_value;
use super::unique_id_duplicates::{UniqueIdHolder, UniqueIdNumbers};
use crate::content_tree::child_folder_names;
use crate::page::frontmatter;

const SCHEMA_FILE: &str = "schema.yaml";

/// A Collection whose items repeat a valid number, read from the working
/// copy.
#[derive(Debug, Clone)]
pub struct Repeats {
    /// The Space of the Collection.
    space: PathBuf,
    /// The folder of the Space relative to the repository, `""` for its root
    /// and with a trailing `/` otherwise.
    space_dir: String,
    /// The Collection relative to its Space.
    collection: String,
    title: String,
    column: Column,
    /// Groups by number, items by path relative to the Space.
    groups: Vec<(u64, Vec<UniqueIdHolder>)>,
}

impl Repeats {
    pub fn field(&self) -> &str {
        &self.column.name
    }

    /// The items holding a repeated number, relative to the repository.
    pub fn item_paths(&self) -> impl Iterator<Item = String> + '_ {
        self.groups
            .iter()
            .flat_map(|(_, holders)| holders)
            .map(|holder| format!("{}{}", self.space_dir, holder.path))
    }

    /// The `schema.yaml` of the Collection, relative to the repository.
    pub fn schema_path(&self) -> String {
        match self.collection.as_str() {
            "." | "" => format!("{}{SCHEMA_FILE}", self.space_dir),
            collection => format!("{}{collection}/{SCHEMA_FILE}", self.space_dir),
        }
    }
}

/// The Collections with `unique_id` of the repository at `repo` — of its
/// Space and the child Spaces stored in it — whose items repeat a number. A
/// Collection or a Space that does not read is left out.
pub fn repeats_in_repository(repo: &Path) -> Vec<Repeats> {
    let mut repeats = Vec::new();
    for (space, space_dir) in repository_spaces(repo) {
        let space_str = space.to_string_lossy().into_owned();
        let collections = match list_collections(&space_str) {
            Ok(collections) => collections,
            Err(error) => {
                tracing::warn!("Collections of {} unavailable: {error}", space.display());
                continue;
            }
        };
        for collection in collections {
            let read = read_collection_schema(&space_str, &collection.path).and_then(|schema| {
                let column = schema
                    .columns
                    .into_iter()
                    .find(|column| column.type_ == PropertyType::UniqueId);
                Ok(column.zip(UniqueIdNumbers::read(&space_str, &collection.path)?))
            });
            let (column, numbers) = match read {
                Ok(Some(read)) => read,
                Ok(None) => continue,
                Err(error) => {
                    tracing::warn!("unique_id of {} unavailable: {error}", collection.path);
                    continue;
                }
            };
            let groups: Vec<(u64, Vec<UniqueIdHolder>)> = numbers
                .duplicate_groups()
                .into_iter()
                .map(|(number, holders)| (number, holders.into_iter().cloned().collect()))
                .collect();
            if groups.is_empty() {
                continue;
            }
            repeats.push(Repeats {
                space: space.clone(),
                space_dir: space_dir.clone(),
                collection: collection.path,
                title: collection.title,
                column,
                groups,
            });
        }
    }
    repeats
}

/// The Space at `repo` and the child Spaces stored in the same repository,
/// each with its folder relative to `repo`.
fn repository_spaces(repo: &Path) -> Vec<(PathBuf, String)> {
    let mut spaces = vec![(repo.to_path_buf(), String::new())];
    let mut index = 0;
    while index < spaces.len() {
        let (space, space_dir) = spaces[index].clone();
        let mut children: Vec<String> = child_folder_names(&space).into_iter().collect();
        children.sort();
        for child in children {
            let path = space.join(&child);
            // A child Space with its own repository syncs on its own.
            if path.is_dir() && path.join(".git").symlink_metadata().is_err() {
                spaces.push((path, format!("{space_dir}{child}/")));
            }
        }
        index += 1;
    }
    spaces
}

/// An item that got a new number, as the sync result names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenumberedItem {
    /// Relative to the repository.
    pub path: String,
    pub title: String,
    /// The title of the Collection.
    pub collection: String,
    /// The number before, with the prefix of the column.
    pub from: String,
    /// The new number, with the prefix of the column.
    pub to: String,
}

/// An item that got a new number with its numbers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Renumbered {
    pub item: RenumberedItem,
    pub old: u64,
    pub new: u64,
}

/// The renumbering of one Collection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollectionRenumbering {
    /// The `schema.yaml` of the Collection, relative to the repository.
    pub schema_path: String,
    pub field: String,
    /// `next` of the column after the renumbering.
    pub next: u64,
    /// In the order of allocation.
    pub items: Vec<Renumbered>,
}

/// Renumber the repeats by DF-237 R3. `published` holds the sources of the
/// item paths in the observed upstream revision, by path relative to the
/// repository; a path without one is not published. Items at `held`, the
/// paths in conflict, keep their number. A group whose number is published
/// at more than one item or at none stays as it is. A Collection whose
/// renumbering fails is left as it was.
pub fn renumber(
    repeats: &[Repeats],
    published: &HashMap<String, String>,
    held: &BTreeSet<String>,
) -> Vec<CollectionRenumbering> {
    let mut renumbered = Vec::new();
    for repeat in repeats {
        let holders = to_renumber(repeat, published, held);
        if holders.is_empty() {
            continue;
        }
        let space = repeat.space.to_string_lossy();
        let paths: Vec<String> = holders.iter().map(|holder| holder.path.clone()).collect();
        let numbers = match reassign_unique_ids(&space, &repeat.collection, &paths) {
            Ok(numbers) => numbers,
            Err(error) => {
                tracing::warn!("unique_id of {} not renumbered: {error}", repeat.collection);
                continue;
            }
        };
        let next = read_collection_schema(&space, &repeat.collection)
            .ok()
            .and_then(|schema| {
                schema
                    .columns
                    .into_iter()
                    .find(|column| column.type_ == PropertyType::UniqueId)
                    .and_then(|column| column.next)
            })
            .unwrap_or_default();
        let items = holders
            .into_iter()
            .zip(numbers)
            .map(|(holder, new)| Renumbered {
                item: RenumberedItem {
                    path: format!("{}{}", repeat.space_dir, holder.path),
                    title: holder.title.clone(),
                    collection: repeat.title.clone(),
                    from: unique_id_display_value(&repeat.column, holder.number),
                    to: unique_id_display_value(&repeat.column, new),
                },
                old: holder.number,
                new,
            })
            .collect();
        renumbered.push(CollectionRenumbering {
            schema_path: repeat.schema_path(),
            field: repeat.column.name.clone(),
            next,
            items,
        });
    }
    renumbered
}

/// The items of `repeat` that get new numbers: in each group whose number
/// exactly one item holds at its path upstream, the others, by path, except
/// the held ones.
fn to_renumber<'a>(
    repeat: &'a Repeats,
    published: &HashMap<String, String>,
    held: &BTreeSet<String>,
) -> Vec<&'a UniqueIdHolder> {
    let path = |holder: &UniqueIdHolder| format!("{}{}", repeat.space_dir, holder.path);
    let mut renumber = Vec::new();
    for (number, holders) in &repeat.groups {
        let is_published = |holder: &UniqueIdHolder| {
            published
                .get(&path(holder))
                .and_then(|source| source_number(source, repeat.field()))
                == Some(*number)
        };
        if holders.iter().filter(|holder| is_published(holder)).count() != 1 {
            continue;
        }
        renumber.extend(
            holders
                .iter()
                .filter(|holder| !is_published(holder) && !held.contains(&path(holder))),
        );
    }
    renumber.sort_by(|left, right| left.path.cmp(&right.path));
    renumber
}

/// The valid number of `field` in the item source `source`.
pub fn source_number(source: &str, field: &str) -> Option<u64> {
    let (meta, _) = frontmatter::try_parse(source).ok()??;
    meta.extra.get(field).and_then(unique_id_value)
}

/// The item source `source` with `field` set to `number`; `None` when its
/// frontmatter does not read.
pub fn item_source_with_number(source: &str, field: &str, number: u64) -> Option<String> {
    let (mut meta, body) = frontmatter::try_parse(source).ok()??;
    meta.extra
        .insert(field.to_owned(), serde_norway::to_value(number).ok()?);
    Some(frontmatter::serialize(&meta, &body))
}

/// The `schema.yaml` source `source` with `next` of the `unique_id` column
/// `field` raised to at least `next`; `None` when it does not read or has no
/// such column.
pub fn schema_source_with_next(source: &str, field: &str, next: u64) -> Option<String> {
    let mut schema = parse_schema(source).ok()?;
    let column = schema
        .columns
        .iter_mut()
        .find(|column| column.name == field && column.type_ == PropertyType::UniqueId)?;
    column.next = Some(column.next.unwrap_or(1).max(next));
    schema.to_file_yaml().ok()
}

#[cfg(test)]
#[path = "unique_id_renumber_tests.rs"]
mod tests;

//! A Page in conflict merged by its properties (DF-292): the frontmatter of
//! the base (stage 1), mine (2) and the incoming side (3) read by the reader
//! of Pages and merged key by key, the text below the properties merged as
//! text with the conflict markers of the size of the path, and the Page
//! composed from the decisions of the disputed keys by the writer of Page
//! frontmatter, as an edit of a property writes it.
//!
//! A key is disputed when both sides changed it from the base differently:
//! different values, additions with different values, an edit against a
//! deletion. Values are compared as read, not as lines, so `"USD"` and `USD`
//! are one value. A change of one side, and the same change of both, merge
//! on their own. Without a base (add/add) every key with different values is
//! disputed. The writer keeps neither YAML comments nor the manual layout of
//! the frontmatter.

use std::collections::BTreeMap;
use std::path::Path;

use indexmap::{IndexMap, IndexSet};
use serde::{Deserialize, Serialize};

use super::GitError;
use super::cli::GitCli;
use super::conflict_file::{self, ResolutionFinding};
use super::markers;
use super::service_merge;
use super::stage_merge::{self, ConflictStyle, StageTexts};
use crate::page::frontmatter::{self, EntryMeta, ParseStatus};

type Value = serde_norway::Value;

/// A stage of a conflicted path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Base,
    Ours,
    Theirs,
}

/// Why a Page in conflict has no choice by properties.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum NoMerge {
    /// A side lacks the path, or a version is not a regular file or is too
    /// large to read.
    MissingStage,
    /// The frontmatter of `stage` does not read; `message` is the reader's.
    Unreadable { stage: Stage, message: String },
}

/// A property of a Page in conflict.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedProperty {
    pub key: String,
    /// The value of each side as read; absent when the side has no such key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ours: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theirs: Option<Value>,
    /// Both sides changed the key from the base differently.
    pub disputed: bool,
    /// The merged value; absent while the key is disputed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merged: Option<Value>,
}

/// A Page in conflict by its properties, or why it has none.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum PageMerge {
    /// The keys of the merged frontmatter and the disputed ones, in the order
    /// of my side, then the incoming one, then the base; a key the merge
    /// deletes is not among them. `body` is the text below the properties
    /// merged as text, with conflict markers of the size of the path.
    Merged {
        properties: Vec<MergedProperty>,
        body: String,
    },
    Unavailable {
        reason: NoMerge,
    },
}

/// How the person decided a disputed property.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum PropertyDecision {
    /// The value of my side; none when my side deleted the key.
    Ours,
    /// The value of the incoming side; none when it deleted the key.
    Theirs,
    /// A value set by the control of the property under the rules of an
    /// edit of the field; `null` removes a custom property.
    Value { value: serde_json::Value },
}

/// The Page composed from the decisions, or why it does not resolve the
/// path; nothing is written either way.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum PageMergeResult {
    Composed { content: String },
    Unresolved { finding: ResolutionFinding },
}

/// A version of a side read as a Page.
struct Version {
    meta: EntryMeta,
    body: String,
    frontmatter: bool,
}

struct Sides {
    /// `None` when both sides added the path.
    base: Option<Version>,
    ours: Version,
    theirs: Version,
}

/// What the merge does with a key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outcome {
    /// The value of a side, or no key when that side has none.
    Take(Stage),
    Disputed,
}

/// The one rule of a disputed key: both sides changed it from the base
/// differently, or, without a base, they differ.
fn decide(base: Option<Option<&Value>>, ours: Option<&Value>, theirs: Option<&Value>) -> Outcome {
    if ours == theirs {
        return Outcome::Take(Stage::Ours);
    }
    match base {
        Some(base) if base == ours => Outcome::Take(Stage::Theirs),
        Some(base) if base == theirs => Outcome::Take(Stage::Ours),
        _ => Outcome::Disputed,
    }
}

fn read_version(stage: Stage, content: &[u8]) -> Result<Version, NoMerge> {
    let unreadable = |message: String| NoMerge::Unreadable { stage, message };
    let text = std::str::from_utf8(content).map_err(|error| unreadable(error.to_string()))?;
    match frontmatter::parse_status(text) {
        ParseStatus::Valid { meta, body } => Ok(Version {
            meta,
            body,
            frontmatter: true,
        }),
        ParseStatus::Missing { body } => Ok(Version {
            meta: EntryMeta::synthesized(String::new(), String::new(), String::new()),
            body,
            frontmatter: false,
        }),
        ParseStatus::Malformed { message, .. } => Err(unreadable(message)),
    }
}

fn read_sides(texts: &StageTexts) -> Result<Sides, NoMerge> {
    Ok(Sides {
        base: texts
            .base
            .as_deref()
            .map(|base| read_version(Stage::Base, base))
            .transpose()?,
        ours: read_version(Stage::Ours, &texts.ours)?,
        theirs: read_version(Stage::Theirs, &texts.theirs)?,
    })
}

/// The properties the writer of Page frontmatter writes for `meta`, by key.
fn values(meta: &EntryMeta) -> IndexMap<String, Value> {
    let mut values = IndexMap::new();
    if meta.frontmatter_keys.title {
        values.insert("title".to_owned(), Value::String(meta.title.clone()));
    }
    if let Some(icon) = &meta.icon {
        values.insert("icon".to_owned(), Value::String(icon.clone()));
    }
    if let Some(description) = &meta.description {
        values.insert("description".to_owned(), Value::String(description.clone()));
    }
    if let Some(cover) = meta
        .cover
        .as_ref()
        .and_then(|cover| serde_norway::to_value(cover).ok())
    {
        values.insert("cover".to_owned(), cover);
    }
    for (key, value) in &meta.extra {
        values.insert(key.clone(), value.clone());
    }
    values
}

/// The key `key` of `side` set in `meta`; nothing when `side` has none.
fn take(meta: &mut EntryMeta, key: &str, side: &EntryMeta) {
    match key {
        "title" => {
            if side.frontmatter_keys.title {
                meta.title = side.title.clone();
                meta.mark_title_present();
            }
        }
        "icon" => {
            if side.icon.is_some() {
                meta.icon = side.icon.clone();
                meta.mark_icon_present();
            }
        }
        "description" => {
            if side.description.is_some() {
                meta.description = side.description.clone();
                meta.mark_description_present();
            }
        }
        "cover" => {
            if side.cover.is_some() {
                meta.cover = side.cover.clone();
                meta.mark_cover_present();
            }
        }
        custom => {
            if let Some(value) = side.extra.get(custom) {
                meta.extra.insert(custom.to_owned(), value.clone());
            }
        }
    }
}

/// The keys of the sides with what the merge does with each, in the order
/// of my side, then the incoming one, then the base.
struct Merge {
    base: Option<IndexMap<String, Value>>,
    ours: IndexMap<String, Value>,
    theirs: IndexMap<String, Value>,
    keys: Vec<(String, Outcome)>,
}

impl Merge {
    fn of(sides: &Sides) -> Self {
        let base = sides.base.as_ref().map(|base| values(&base.meta));
        let ours = values(&sides.ours.meta);
        let theirs = values(&sides.theirs.meta);
        let order: IndexSet<&String> = ours
            .keys()
            .chain(theirs.keys())
            .chain(base.iter().flat_map(IndexMap::keys))
            .collect();
        let keys = order
            .into_iter()
            .map(|key| {
                let outcome = decide(
                    base.as_ref().map(|base| base.get(key)),
                    ours.get(key),
                    theirs.get(key),
                );
                (key.clone(), outcome)
            })
            .collect();
        Self {
            base,
            ours,
            theirs,
            keys,
        }
    }

    fn side(&self, stage: Stage) -> &IndexMap<String, Value> {
        match stage {
            Stage::Ours => &self.ours,
            _ => &self.theirs,
        }
    }

    fn properties(&self) -> Vec<MergedProperty> {
        self.keys
            .iter()
            .filter_map(|(key, outcome)| {
                let merged = match outcome {
                    Outcome::Take(stage) => Some(self.side(*stage).get(key)?.clone()),
                    Outcome::Disputed => None,
                };
                Some(MergedProperty {
                    key: key.clone(),
                    base: self.base.as_ref().and_then(|base| base.get(key)).cloned(),
                    ours: self.ours.get(key).cloned(),
                    theirs: self.theirs.get(key).cloned(),
                    disputed: *outcome == Outcome::Disputed,
                    merged,
                })
            })
            .collect()
    }
}

/// A Page in conflict as the index stages hold it.
struct Conflict {
    repo: std::path::PathBuf,
    path: String,
    size: usize,
    sides: Result<Sides, NoMerge>,
}

async fn conflict(cli: &GitCli, space: &Path, path: &str) -> Result<Conflict, GitError> {
    let (repo, prefix) = conflict_file::repository_of(cli, space).await?;
    let relative = conflict_file::repository_path(&prefix, path)?;
    let conflicted = service_merge::index_conflicts(cli, &repo)
        .await?
        .into_iter()
        .find(|conflict| conflict.path == relative)
        .ok_or_else(|| GitError::Conflict(format!("{relative} is not in conflict")))?;
    let size = markers::marker_sizes(cli, &repo, std::slice::from_ref(&relative))
        .await?
        .get(&relative)
        .copied()
        .unwrap_or(markers::DEFAULT_MARKER_SIZE);
    let sides = match stage_merge::read_stages(cli, &repo, &conflicted).await? {
        Some(texts) => read_sides(&texts),
        None => Err(NoMerge::MissingStage),
    };
    Ok(Conflict {
        repo,
        path: relative,
        size,
        sides,
    })
}

/// The conflicted Page at `path` (relative to `space`, a path in its
/// repository) by its properties: the frontmatter of its index stages merged
/// key by key and the text below the properties merged as text, or why it
/// has no choice by properties.
pub async fn read(cli: &GitCli, space: &Path, path: &str) -> Result<PageMerge, GitError> {
    let conflict = conflict(cli, space, path).await?;
    let sides = match conflict.sides {
        Ok(sides) => sides,
        Err(reason) => return Ok(PageMerge::Unavailable { reason }),
    };
    let texts = StageTexts {
        base: sides
            .base
            .as_ref()
            .map(|base| base.body.as_bytes().to_vec()),
        ours: sides.ours.body.as_bytes().to_vec(),
        theirs: sides.theirs.body.as_bytes().to_vec(),
    };
    let body = stage_merge::merge_texts(
        cli,
        &conflict.repo,
        &texts,
        conflict.size,
        ConflictStyle::Merge,
    )
    .await?;
    Ok(PageMerge::Merged {
        properties: Merge::of(&sides).properties(),
        body: String::from_utf8_lossy(&body).into_owned(),
    })
}

/// The conflicted Page at `path` (relative to `space`) composed from the
/// merge of its properties with `decisions` of every disputed key and the
/// text `body` below them, by the writer of Page frontmatter. It resolves
/// the path only without marker lines of the size of the path and when its
/// frontmatter reads; decisions that are not exactly those of the disputed
/// keys find the Page changed, a value the field rules refuse does not read.
/// Nothing is written.
pub async fn compose(
    cli: &GitCli,
    space: &Path,
    path: &str,
    decisions: &BTreeMap<String, PropertyDecision>,
    body: &str,
) -> Result<PageMergeResult, GitError> {
    let unresolved = |finding| Ok(PageMergeResult::Unresolved { finding });
    let conflict = conflict(cli, space, path).await?;
    let Ok(sides) = &conflict.sides else {
        return unresolved(ResolutionFinding::Changed);
    };
    let merge = Merge::of(sides);
    let disputed = merge
        .keys
        .iter()
        .filter(|(_, outcome)| *outcome == Outcome::Disputed);
    if disputed.clone().count() != decisions.len()
        || disputed
            .clone()
            .any(|(key, _)| !decisions.contains_key(key))
    {
        return unresolved(ResolutionFinding::Changed);
    }
    let space_text = space.to_string_lossy();
    let side = |stage| match stage {
        Stage::Ours => &sides.ours.meta,
        _ => &sides.theirs.meta,
    };
    let mut meta = EntryMeta::synthesized(String::new(), String::new(), String::new());
    for (key, outcome) in &merge.keys {
        let decision = match outcome {
            Outcome::Take(stage) => {
                take(&mut meta, key, side(*stage));
                continue;
            }
            Outcome::Disputed => &decisions[key],
        };
        match decision {
            PropertyDecision::Ours => take(&mut meta, key, side(Stage::Ours)),
            PropertyDecision::Theirs => take(&mut meta, key, side(Stage::Theirs)),
            PropertyDecision::Value { value } => {
                if let Err(message) = set_value(&mut meta, &space_text, path, key, value) {
                    return unresolved(ResolutionFinding::Unreadable { message });
                }
            }
        }
    }
    let content = if values(&meta).is_empty()
        && !sides.ours.frontmatter
        && !sides.theirs.frontmatter
        && sides.base.as_ref().is_none_or(|base| !base.frontmatter)
    {
        body.to_owned()
    } else {
        frontmatter::serialize(&meta, body)
    };
    if let Some(finding) =
        conflict_file::check_result(&conflict.path, content.as_bytes(), conflict.size)
    {
        return unresolved(finding);
    }
    Ok(PageMergeResult::Composed { content })
}

/// `value` set as the property `key` of `meta` by the rules of an edit of
/// the field of the Page at `path` in `space`.
fn set_value(
    meta: &mut EntryMeta,
    space: &str,
    path: &str,
    key: &str,
    value: &serde_json::Value,
) -> Result<(), String> {
    frontmatter::apply_entry_field_update(meta, key, value.clone())
        .map_err(|error| error.to_string())?;
    if let Some(slot) = meta.extra.get_mut(key) {
        let normalized =
            crate::collections::engine::normalize_entry_field_value(space, path, key, slot.clone())
                .map_err(|error| error.to_string())?;
        crate::collections::engine::validate_entry_field_value(space, path, key, &normalized)
            .map_err(|error| error.to_string())?;
        *slot = normalized;
    }
    Ok(())
}

#[cfg(all(test, unix))]
#[path = "page_merge_tests.rs"]
mod tests;

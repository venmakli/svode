//! The merge rule of the `next` counter of a `unique_id` column in a
//! Collection `schema.yaml`, owned by Collections (DF-237 R2, module 01 1.C).
//!
//! A conflicted `schema.yaml` resolves only when its disputed places are the
//! values of `next` of the `unique_id` column: the sides are merged as text
//! by Git with those values masked, and a conflict left after that keeps the
//! file with the person. The merged file is the text of that merge, not a
//! merge by keys, with `next` set to the largest value of the sides and not
//! below the largest number of the Collection items in the result plus one.
//! The items are read from the working tree, where a merge in the index has
//! its result; the in-memory preflight only asks whether the rule resolves.

use std::path::{Path, PathBuf};

use saphyr_parser::{Event, Parser, ScalarStyle};

use super::model::{CollectionSchema, PropertyType};
use super::schema::{find_collection_root_by_location, is_direct_collection_path, parse_schema};
use super::schema_support::unique_id_value;
use super::traversal::collect_md_files_in_space;
use crate::git::GitError;
use crate::git::service_merge::{
    ConflictedPath, Resolution, RuleContext, RuleFuture, RuleOutcome, ServiceRule,
};
use crate::git::stage_merge::{self, StageTexts};
use crate::page::frontmatter;

const SCHEMA_FILE: &str = "schema.yaml";
/// What the value of `next` reads as while the sides are merged; a result
/// that still holds it after `next` is set does not resolve.
const MASK: &str = "__svode_unique_id_next__";

pub struct UniqueIdNextRule;

impl ServiceRule for UniqueIdNextRule {
    fn claims(&self, conflict: &ConflictedPath) -> bool {
        is_schema_path(&conflict.path) && conflict.sides().all(|side| side.is_regular_file())
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
            let (Some(ours), Some(theirs)) = (ours, theirs) else {
                return Ok(RuleOutcome::Declined);
            };
            let collection = collection_dir(&conflict.path);
            Ok(
                match merge_schema(ctx, &collection, base.as_deref(), &ours, &theirs).await? {
                    Some(text) => RuleOutcome::Resolved(Resolution::Content(text.into_bytes())),
                    None => RuleOutcome::Declined,
                },
            )
        })
    }
}

/// A `schema.yaml` at the repository-relative `path`.
fn is_schema_path(path: &str) -> bool {
    path == SCHEMA_FILE || path.ends_with(&format!("/{SCHEMA_FILE}"))
}

/// The repository-relative folder of the Collection of `schema_path`.
fn collection_dir(schema_path: &str) -> PathBuf {
    Path::new(schema_path)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default()
}

/// The merged text of the sides, `None` when a side is not a Collection
/// schema or a disputed place is not `next` of the `unique_id` column.
async fn merge_schema(
    ctx: &RuleContext<'_>,
    collection: &Path,
    base: Option<&[u8]>,
    ours: &[u8],
    theirs: &[u8],
) -> Result<Option<String>, GitError> {
    let Some(sides) = Sides::read(base, ours, theirs) else {
        return Ok(None);
    };
    let texts = StageTexts {
        base: sides.base.map(|text| text.into_bytes()),
        ours: sides.ours.into_bytes(),
        theirs: sides.theirs.into_bytes(),
    };
    let Some(merged) = stage_merge::merge_texts_clean(ctx.cli, ctx.repo, &texts).await? else {
        return Ok(None);
    };
    let Ok(merged) = String::from_utf8(merged) else {
        return Ok(None);
    };
    let Some(spans) = next_spans(&merged) else {
        return Ok(None);
    };
    // A result without the column means a side removed it: more than a
    // disputed value.
    let text = match spans.as_slice() {
        [span] => {
            // The schema of the result with a valid `next` names the column
            // and says which items it holds.
            let mut text = merged;
            text.replace_range(span.clone(), "1");
            let Ok(schema) = parse_schema(&text) else {
                return Ok(None);
            };
            let Some((field, _)) = unique_id_column(&schema) else {
                return Ok(None);
            };
            let items = max_item_number(ctx.repo, collection, field, schema.nested_items);
            let Some(after_items) = items.checked_add(1) else {
                return Ok(None);
            };
            let next = sides.next.max(after_items);
            text.replace_range(span.start..span.start + 1, &next.to_string());
            text
        }
        _ => return Ok(None),
    };
    if text.contains(MASK) || parse_schema(&text).is_err() {
        return Ok(None);
    }
    Ok(Some(text))
}

/// The sides with the value of `next` masked and the largest `next` of mine
/// and the incoming side.
struct Sides {
    base: Option<String>,
    ours: String,
    theirs: String,
    next: u64,
}

impl Sides {
    fn read(base: Option<&[u8]>, ours: &[u8], theirs: &[u8]) -> Option<Self> {
        let side = |bytes: &[u8]| -> Option<(String, Option<u64>)> {
            let text = std::str::from_utf8(bytes).ok()?;
            let schema = parse_schema(text).ok()?;
            Some((
                mask(text)?,
                unique_id_column(&schema).and_then(|(_, next)| next),
            ))
        };
        let base = match base {
            Some(bytes) => Some(side(bytes)?.0),
            None => None,
        };
        let (ours, ours_next) = side(ours)?;
        let (theirs, theirs_next) = side(theirs)?;
        Some(Self {
            base,
            ours,
            theirs,
            next: ours_next.max(theirs_next).unwrap_or(1),
        })
    }
}

/// The `unique_id` column of `schema`: its name and `next`.
fn unique_id_column(schema: &CollectionSchema) -> Option<(&str, Option<u64>)> {
    schema
        .columns
        .iter()
        .find(|column| column.type_ == PropertyType::UniqueId)
        .map(|column| (column.name.as_str(), column.next))
}

/// `text` with the value of `next` of the `unique_id` column replaced by
/// [`MASK`]; `None` when the text does not read as YAML.
fn mask(text: &str) -> Option<String> {
    let mut masked = text.to_owned();
    for span in next_spans(text)?.into_iter().rev() {
        masked.replace_range(span, MASK);
    }
    Some(masked)
}

/// The byte ranges of the values of `next` of the `unique_id` columns of
/// the schema text, in order; `None` when the text does not read as YAML.
fn next_spans(text: &str) -> Option<Vec<std::ops::Range<usize>>> {
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Role {
        Root,
        Columns,
        Column,
        Other,
    }
    struct Frame {
        role: Role,
        mapping: bool,
        /// The key whose value comes next, in a mapping.
        key: Option<String>,
    }
    #[derive(Default)]
    struct Column {
        unique_id: bool,
        next: Option<std::ops::Range<usize>>,
    }

    // The parser counts characters; the ranges are bytes of `text`.
    let offsets: Vec<usize> = text
        .char_indices()
        .map(|(offset, _)| offset)
        .chain([text.len()])
        .collect();
    let byte = |index: usize| offsets.get(index).copied();

    let mut frames: Vec<Frame> = Vec::new();
    let mut column = Column::default();
    let mut spans = Vec::new();
    for event in Parser::new_from_str(text) {
        let (event, span) = event.ok()?;
        match event {
            Event::Scalar(value, style, _, _) => {
                let Some(frame) = frames.last_mut() else {
                    continue;
                };
                if !frame.mapping {
                    continue;
                }
                let Some(key) = frame.key.take() else {
                    frame.key = Some(value.into_owned());
                    continue;
                };
                if frame.role == Role::Column {
                    match key.as_str() {
                        "type" => column.unique_id = value == "unique_id",
                        "next" if style == ScalarStyle::Plain => {
                            column.next = Some(byte(span.start.index())?..byte(span.end.index())?);
                        }
                        _ => {}
                    }
                }
            }
            Event::Alias(_) => {
                if let Some(frame) = frames.last_mut().filter(|frame| frame.mapping) {
                    frame.key = match frame.key.take() {
                        Some(_) => None,
                        None => Some(String::new()),
                    };
                }
            }
            Event::MappingStart(..) | Event::SequenceStart(..) => {
                let mapping = matches!(event, Event::MappingStart(..));
                let role = match frames.last() {
                    None if mapping => Role::Root,
                    Some(parent)
                        if parent.role == Role::Root
                            && !mapping
                            && parent.key.as_deref() == Some("columns") =>
                    {
                        Role::Columns
                    }
                    Some(parent) if parent.role == Role::Columns && mapping => {
                        column = Column::default();
                        Role::Column
                    }
                    _ => Role::Other,
                };
                frames.push(Frame {
                    role,
                    mapping,
                    key: None,
                });
            }
            Event::MappingEnd | Event::SequenceEnd => {
                let frame = frames.pop()?;
                if frame.role == Role::Column && column.unique_id {
                    spans.extend(column.next.take());
                }
                // The container was the value of its key.
                if let Some(parent) = frames.last_mut() {
                    parent.key = None;
                }
            }
            Event::Nothing
            | Event::StreamStart
            | Event::StreamEnd
            | Event::DocumentStart(_)
            | Event::DocumentEnd => {}
        }
    }
    Some(spans)
}

/// The largest valid number of `field` among the items of the Collection at
/// the repository-relative `collection` in the working tree of `repo`; 0
/// without one. Items whose frontmatter does not read hold no number.
fn max_item_number(repo: &Path, collection: &Path, field: &str, nested_items: bool) -> u64 {
    let space = space_root(repo, collection);
    let root = repo.join(collection);
    let Ok(collection) = root.strip_prefix(&space).map(Path::to_path_buf) else {
        return 0;
    };
    let Ok(files) = collect_md_files_in_space(&space, &root) else {
        return 0;
    };
    files
        .iter()
        .filter_map(|file| {
            let rel = file
                .strip_prefix(&space)
                .ok()?
                .to_string_lossy()
                .replace('\\', "/");
            let member = find_collection_root_by_location(&space, &rel)? == collection
                && (nested_items || is_direct_collection_path(&collection, &rel));
            if !member {
                return None;
            }
            let raw = std::fs::read_to_string(file).ok()?;
            let (meta, _) = frontmatter::try_parse(&raw).ok()??;
            meta.extra.get(field).and_then(unique_id_value)
        })
        .max()
        .unwrap_or(0)
}

/// The Space of the Collection: the nearest folder from the Collection up to
/// the repository root with its own `.svode/config.json`, the repository
/// root without one.
fn space_root(repo: &Path, collection: &Path) -> PathBuf {
    collection
        .ancestors()
        .map(|dir| repo.join(dir))
        .find(|dir| dir.join(".svode/config.json").is_file())
        .unwrap_or_else(|| repo.to_path_buf())
}

#[cfg(test)]
#[path = "unique_id_merge_tests.rs"]
mod tests;

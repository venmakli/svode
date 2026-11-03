//! A text file in conflict outside a Page (module 01, 1.F): its places of
//! dispute by the conflict markers of the size of its path, the choice of a
//! side in every place applied at once, the version of a side for the whole
//! file, and the check that marks the path resolved only when the result has
//! no marker lines and reads.
//!
//! The places come from the same reading of marker lines as the Page editor
//! (DF-238): all blocks of a file share one style, `diff3` when every block
//! has a `|` line before its `=` line; a block takes the first `<` line, the
//! first `|` line in the `diff3` style, the first `=` line after it and the
//! first `>` line after that. A block whose marker lines allow another split
//! is ambiguous, and so are marker lines that do not fold into blocks: such a
//! file has no places, only the version of a side for the whole file.
//!
//! In a Page the places in its frontmatter are marked: a choice of both
//! sides there would repeat its keys, so «Оба» is refused for them.
//!
//! A file without markers — binary or LFS, modify/delete, add/add of a
//! binary file, rename/rename and rename/delete — is resolved as a whole:
//! the version of a side, the deletion of the path, or my version in place
//! with the incoming one beside it as a copy.

use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::GitError;
use super::branch::GitOperation;
use super::cli::{GitCli, literal_pathspec_input, nul_paths_input};
use super::conflict_kind::{self, ConflictKind, RenameGroup};
use super::diagnostics::GitStage;
use super::markers;
use super::path::{RootMode, normalize_repo_relative};
use super::service_merge::{self, ConflictedPath};
use super::sync::SyncResult;
use super::versions::MessageLanguage;

/// A text file larger than this is not shown or resolved by places.
const MAX_TEXT: usize = 4 * 1024 * 1024;
/// A version of a side larger than this is not taken for the whole file.
const MAX_SIDE: usize = 64 * 1024 * 1024;
/// Git decides a version is binary by a NUL byte among its first bytes.
const BINARY_PROBE: usize = 8000;
/// A Git LFS pointer file is never larger than this.
const LFS_POINTER_MAX: usize = 1024;

/// One place of dispute: the lines of its block in the file and the text of
/// each side, without the line ending of its last line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictPlace {
    /// Index of the `<` marker line, from 0.
    pub start_line: usize,
    /// Index of the `>` marker line.
    pub end_line: usize,
    pub ours: String,
    pub theirs: String,
    /// The place lies in the frontmatter of a Page, through its closing
    /// `---` included: both sides there would repeat its keys, so «Оба» is
    /// not offered and is refused.
    pub frontmatter: bool,
}

/// Why the places of a file are not told apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UnclearReason {
    /// A block whose marker lines allow more than one split.
    Ambiguous,
    /// Marker lines that do not fold into blocks.
    Broken,
    /// No block of markers of the size of the path.
    NoMarkers,
    /// The file is too large to show by places.
    TooLarge,
}

/// The places of a text file in conflict, or why there are none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum Places {
    Places { places: Vec<ConflictPlace> },
    Unclear { reason: UnclearReason },
}

/// A conflicted path as «Изменения» resolve it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    /// Relative to the requested path.
    pub path: String,
    pub kind: ConflictKind,
    /// The version of the working file the places come from; a resolution
    /// by places names it and is refused once the file changed.
    pub version: String,
    /// The text of the working file, for a text file Svode reads by places.
    pub content: Option<String>,
    /// For a text file: its places or why there are none.
    pub places: Option<Places>,
    /// The versions of the sides before the merge that the index holds.
    pub ours: bool,
    pub theirs: bool,
    /// Git does not merge the sides as text: a binary or LFS file.
    pub binary: bool,
    /// For a file without markers: what each side did with it.
    pub changes: Option<SideChanges>,
}

/// What each side of the merge did with a file without markers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SideChanges {
    pub ours: SideChange,
    pub theirs: SideChange,
}

/// What one side did with the file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SideChange {
    pub change: Change,
    /// The name the side renamed the file to, relative to the requested path.
    pub path: Option<String>,
    /// The size of the version of the side in bytes, for a binary file; the
    /// size of the object of an LFS file.
    pub size: Option<u64>,
}

/// A change of a side to a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Change {
    Modified,
    Added,
    Deleted,
    Renamed,
}

/// The side chosen in a place.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaceChoice {
    Ours,
    Theirs,
    /// My side first, then the incoming one.
    Both,
}

/// A side of the merge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Ours,
    Theirs,
}

/// How the person resolves a conflicted file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum FileResolution {
    /// A choice in every place of the `version` of the file, in order.
    Places {
        version: String,
        choices: Vec<PlaceChoice>,
    },
    /// The version of `side` before the merge for the whole file; for a
    /// rename/rename conflict the file under the name of `side`.
    Side { side: Side },
    /// Remove the path, as the side that deleted the file did.
    Delete,
    /// My version stays at the path and the incoming one goes beside it as a
    /// copy named with the suffix of `language`, the interface language of
    /// the author, which the host fills in.
    KeepBoth {
        #[serde(skip)]
        language: MessageLanguage,
    },
}

impl FileResolution {
    /// The resolution in the interface language of the author: it names the
    /// copy of «Сохранить обе».
    pub fn in_language(self, language: MessageLanguage) -> Self {
        match self {
            Self::KeepBoth { .. } => Self::KeepBoth { language },
            other => other,
        }
    }
}

/// Why a chosen result does not resolve its path; nothing was written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum ResolutionFinding {
    /// Marker lines of the size of the path remain.
    Markers,
    /// The result does not read as its format; `message` is the reader's.
    Unreadable { message: String },
    /// The file changed after its places were read.
    Changed,
    /// The incoming version of an LFS file has no object here and Git LFS
    /// did not fetch it; `message` says why.
    LfsObject { message: String },
}

/// The working copy of a path, by lines as Git reads them.
pub(super) struct Line {
    pub(super) start: usize,
    /// End of the line without its ending.
    pub(super) content_end: usize,
    /// End of the line with its ending.
    pub(super) end: usize,
    pub(super) kind: Option<u8>,
}

/// A block of a file: the indices of its marker lines; `bar` only in the
/// `diff3` style.
#[derive(Debug, Clone, Copy)]
pub(super) struct Split {
    pub(super) lt: usize,
    pub(super) bar: Option<usize>,
    pub(super) eq: usize,
    pub(super) gt: usize,
}

/// The marker line kind of `line` for markers of `size`: `size` copies of `<`
/// or `>` with a space and a label, of `|` alone or with a space and a label,
/// or exactly `size` copies of `=`.
fn marker_kind(line: &[u8], size: usize) -> Option<u8> {
    let marker = *line.first()?;
    if !matches!(marker, b'<' | b'|' | b'=' | b'>') || line.len() < size {
        return None;
    }
    if line[..size].iter().any(|byte| *byte != marker) {
        return None;
    }
    let next = line.get(size);
    let valid = match marker {
        b'=' => next.is_none(),
        b'|' => next.is_none_or(|next| *next == b' '),
        _ => next == Some(&b' '),
    };
    valid.then_some(marker)
}

/// Lines as Git reads them: up to `\n`, with a `\r` before it in the ending.
pub(super) fn split_lines(content: &[u8], size: usize) -> Vec<Line> {
    let mut lines = Vec::new();
    let mut start = 0;
    while start < content.len() {
        let newline = content[start..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|offset| start + offset);
        let end = newline.map_or(content.len(), |newline| newline + 1);
        let mut content_end = newline.unwrap_or(content.len());
        if newline.is_some() && content_end > start && content[content_end - 1] == b'\r' {
            content_end -= 1;
        }
        lines.push(Line {
            start,
            content_end,
            end,
            kind: marker_kind(&content[start..content_end], size),
        });
        start = end;
    }
    lines
}

/// The blocks of `lines` and whether they are in the `diff3` style.
pub(super) fn find_splits(lines: &[Line]) -> (Vec<Split>, bool) {
    let find = |kind: u8, from: usize, to: usize| {
        (from..to.min(lines.len())).find(|index| lines[*index].kind == Some(kind))
    };
    let split_from = |from: usize, diff3: bool| -> Option<Split> {
        let lt = find(b'<', from, lines.len())?;
        let bar = if diff3 {
            Some(find(b'|', lt + 1, lines.len())?)
        } else {
            None
        };
        let eq = find(b'=', bar.unwrap_or(lt) + 1, lines.len())?;
        let gt = find(b'>', eq + 1, lines.len())?;
        Some(Split { lt, bar, eq, gt })
    };
    let split_all = |diff3: bool| {
        let mut splits = Vec::new();
        let mut next = split_from(0, diff3);
        while let Some(split) = next {
            splits.push(split);
            next = split_from(split.gt + 1, diff3);
        }
        splits
    };
    let merge = split_all(false);
    let diff3 = !merge.is_empty()
        && merge.iter().all(|split| {
            find(b'|', split.lt + 1, split.gt)
                .is_some_and(|bar| find(b'=', bar + 1, split.gt).is_some())
        });
    if diff3 {
        (split_all(true), true)
    } else {
        (merge, false)
    }
}

/// The places of `content` with markers of `size`; for a Page (`page`) the
/// places in its frontmatter are marked ([`frontmatter_places`]).
pub fn places(content: &[u8], size: usize, page: bool) -> Places {
    if content.len() > MAX_TEXT {
        return Places::Unclear {
            reason: UnclearReason::TooLarge,
        };
    }
    let lines = split_lines(content, size);
    let (splits, _) = find_splits(&lines);
    if splits.is_empty() {
        let reason = if lines.iter().any(|line| is_resolvable_marker(line.kind)) {
            UnclearReason::Broken
        } else {
            UnclearReason::NoMarkers
        };
        return Places::Unclear { reason };
    }
    if (0..splits.len()).any(|index| ambiguous(&lines, &splits, index)) {
        return Places::Unclear {
            reason: UnclearReason::Ambiguous,
        };
    }
    if unowned_marker(&lines, &splits, 0..lines.len()) {
        return Places::Unclear {
            reason: UnclearReason::Broken,
        };
    }
    let frontmatter = page
        .then(|| frontmatter_places(content, &lines, &splits))
        .flatten()
        .unwrap_or_default();
    Places::Places {
        places: splits
            .iter()
            .enumerate()
            .map(|(at, split)| conflict_place(content, &lines, split, frontmatter.contains(&at)))
            .collect(),
    }
}

/// The line that opens and closes the frontmatter of a Page.
const FRONTMATTER_DELIMITER: &[u8] = b"---";

/// The indices into `splits` of the places of the Page `content` read as
/// `lines` that lie in its frontmatter: a block that opens before the closing `---`,
/// including one that takes the closing `---` and the start of the text, and
/// one from the first line whose side opens with `---`. `None` when the Page
/// has no frontmatter or no `<` marker line stands in it; a `<` line that
/// folds into no block leaves the places empty.
fn frontmatter_places(content: &[u8], lines: &[Line], splits: &[Split]) -> Option<Vec<usize>> {
    let delimiter = |index: usize| {
        lines
            .get(index)
            .is_some_and(|line| &content[line.start..line.content_end] == FRONTMATTER_DELIMITER)
    };
    let mut opened = delimiter(0);
    if !opened {
        // A conflict from the first line holds the opening `---` in a side.
        let first = splits.first().filter(|split| split.lt == 0)?;
        if !delimiter(1) && !delimiter(first.eq + 1) {
            return None;
        }
    }
    let mut index = usize::from(opened);
    let mut blocks = Vec::new();
    while index < lines.len() {
        if let Some(at) = splits.iter().position(|split| split.lt == index) {
            let split = splits[at];
            blocks.push(at);
            let delimiters =
                |from: usize, to: usize| (from + 1..to).filter(|line| delimiter(*line)).count();
            let closing = if opened { 1 } else { 2 };
            index = split.gt + 1;
            if delimiters(split.lt, split.bar.unwrap_or(split.eq)) >= closing
                || delimiters(split.eq, split.gt) >= closing
            {
                break;
            }
            opened = true;
            continue;
        }
        index += 1;
        if delimiter(index - 1) {
            break;
        }
    }
    if blocks.is_empty() && !lines[..index].iter().any(|line| line.kind == Some(b'<')) {
        return None;
    }
    Some(blocks)
}

/// Whether a conflict place of the Page `content` with markers of `size`
/// lies in its frontmatter ([`frontmatter_places`]): the conflict is in the
/// properties of the Page, otherwise in its text.
pub fn places_in_frontmatter(content: &[u8], size: usize) -> bool {
    let lines = split_lines(content, size);
    let (splits, _) = find_splits(&lines);
    frontmatter_places(content, &lines, &splits).is_some()
}

/// Whether the marker lines of block `index` of `splits` allow another
/// split: a `<` line before its sides, a second `|` line in the `diff3`
/// style, a second `=` line, or a `>` line after it before the next block.
pub(super) fn ambiguous(lines: &[Line], splits: &[Split], index: usize) -> bool {
    let find = |kind: u8, from: usize, to: usize| {
        (from..to.min(lines.len())).find(|index| lines[*index].kind == Some(kind))
    };
    let split = splits[index];
    let limit = splits.get(index + 1).map_or(lines.len(), |next| next.lt);
    let ours_end = split.bar.unwrap_or(split.eq);
    find(b'<', split.lt + 1, ours_end).is_some()
        || split
            .bar
            .is_some_and(|bar| find(b'|', bar + 1, split.eq).is_some())
        || find(b'=', split.eq + 1, split.gt).is_some()
        || find(b'>', split.gt + 1, limit).is_some()
}

/// Whether a marker line Git would still see after a choice in every block
/// of `splits` lies in `range` of `lines` outside those blocks.
fn unowned_marker(lines: &[Line], splits: &[Split], range: std::ops::Range<usize>) -> bool {
    let mut owned = vec![false; lines.len()];
    for split in splits {
        owned[split.lt] = true;
        owned[split.eq] = true;
        owned[split.gt] = true;
        if let Some(bar) = split.bar {
            // The base section is dropped by every choice.
            owned[bar..split.eq]
                .iter_mut()
                .for_each(|line| *line = true);
        }
    }
    range
        .into_iter()
        .any(|index| !owned[index] && is_resolvable_marker(lines[index].kind))
}

/// The place of block `split`: its marker lines, the text of each side and
/// whether it lies in the frontmatter of a Page.
fn conflict_place(
    content: &[u8],
    lines: &[Line],
    split: &Split,
    frontmatter: bool,
) -> ConflictPlace {
    let side = |from: usize, to: usize| -> String {
        if to - from > 1 {
            String::from_utf8_lossy(&content[lines[from + 1].start..lines[to - 1].content_end])
                .into_owned()
        } else {
            String::new()
        }
    };
    ConflictPlace {
        start_line: split.lt,
        end_line: split.gt,
        ours: side(split.lt, split.bar.unwrap_or(split.eq)),
        theirs: side(split.eq, split.gt),
        frontmatter,
    }
}

/// The lines of the side `ours` (or the incoming one) of block `split` with
/// their endings: each is followed by a marker line.
fn raw_side<'a>(content: &'a [u8], lines: &[Line], split: &Split, ours: bool) -> &'a [u8] {
    let (from, to) = if ours {
        (split.lt, split.bar.unwrap_or(split.eq))
    } else {
        (split.eq, split.gt)
    };
    &content[lines[from].end..lines[to].start]
}

/// A `<`, `|` or `>` marker line: Git counts it as a conflict left in the
/// file. A lone `=` line is valid text.
pub(super) fn is_resolvable_marker(kind: Option<u8>) -> bool {
    matches!(kind, Some(b'<' | b'|' | b'>'))
}

/// `content` with every place replaced by the lines of its chosen side,
/// `None` when the places are not told apart or the choices do not cover
/// them all. Text outside the places stays as Git merged it.
pub fn apply_choices(content: &[u8], size: usize, choices: &[PlaceChoice]) -> Option<Vec<u8>> {
    let Places::Places { places } = places(content, size, false) else {
        return None;
    };
    if places.len() != choices.len() {
        return None;
    }
    let lines = split_lines(content, size);
    let (splits, _) = find_splits(&lines);
    let mut result = Vec::with_capacity(content.len());
    let mut cursor = 0;
    for (split, choice) in splits.iter().zip(choices) {
        let ours = raw_side(content, &lines, split, true);
        let theirs = raw_side(content, &lines, split, false);
        result.extend_from_slice(&content[cursor..lines[split.lt].start]);
        match choice {
            PlaceChoice::Ours => result.extend_from_slice(ours),
            PlaceChoice::Theirs => result.extend_from_slice(theirs),
            PlaceChoice::Both => {
                result.extend_from_slice(ours);
                result.extend_from_slice(theirs);
            }
        }
        cursor = lines[split.gt].end;
    }
    result.extend_from_slice(&content[cursor..]);
    Some(result)
}

/// Why `content` cannot resolve `path` (relative to its repository), if it
/// cannot: marker lines of `size` remain, or it does not read — a Svode
/// service file by the reader Svode reads it with, other JSON and YAML as
/// such, the frontmatter of Markdown by the reader of Pages. A JSON object
/// that repeats a key, as «Оба» gives when both sides set it, does not read
/// either: a reader would silently keep one of the values.
pub fn check_result(path: &str, content: &[u8], size: usize) -> Option<ResolutionFinding> {
    if markers::has_marker_lines(content, size) {
        return Some(ResolutionFinding::Markers);
    }
    let unreadable = |message: String| Some(ResolutionFinding::Unreadable { message });
    let name = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    let json = name.ends_with(".json");
    if let Some(parse) = super::publication::service_parser(path) {
        if let Err(message) = parse(content) {
            return unreadable(message);
        }
    } else if name.ends_with(".md") {
        return frontmatter_finding(content);
    } else if json {
        if let Err(error) = serde_json::from_slice::<serde_json::Value>(content) {
            return unreadable(error.to_string());
        }
    } else if name.ends_with(".yaml") || name.ends_with(".yml") {
        let text = match std::str::from_utf8(content) {
            Ok(text) => text,
            Err(error) => return unreadable(error.to_string()),
        };
        if let Err(error) = serde_norway::from_str::<serde_norway::Value>(text) {
            return unreadable(error.to_string());
        }
    }
    if json {
        if let Err(error) = serde_json::from_slice::<UniqueKeys>(content) {
            return unreadable(error.to_string());
        }
    }
    None
}

/// Why the frontmatter of the Markdown `content` does not read, if it does
/// not; Markdown without frontmatter reads.
fn frontmatter_finding(content: &[u8]) -> Option<ResolutionFinding> {
    let text = match std::str::from_utf8(content) {
        Ok(text) => text,
        Err(error) => {
            return Some(ResolutionFinding::Unreadable {
                message: error.to_string(),
            });
        }
    };
    match crate::page::frontmatter::parse_status(text) {
        crate::page::frontmatter::ParseStatus::Malformed { message, .. } => {
            Some(ResolutionFinding::Unreadable { message })
        }
        _ => None,
    }
}

/// A JSON value whose objects, at every level, name each key once.
struct UniqueKeys;

impl<'de> Deserialize<'de> for UniqueKeys {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(UniqueKeys)
    }
}

impl<'de> serde::de::Visitor<'de> for UniqueKeys {
    type Value = UniqueKeys;

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_bool<E>(self, _: bool) -> Result<Self, E> {
        Ok(self)
    }

    fn visit_i64<E>(self, _: i64) -> Result<Self, E> {
        Ok(self)
    }

    fn visit_u64<E>(self, _: u64) -> Result<Self, E> {
        Ok(self)
    }

    fn visit_f64<E>(self, _: f64) -> Result<Self, E> {
        Ok(self)
    }

    fn visit_str<E>(self, _: &str) -> Result<Self, E> {
        Ok(self)
    }

    fn visit_unit<E>(self) -> Result<Self, E> {
        Ok(self)
    }

    fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Self, A::Error> {
        while seq.next_element::<UniqueKeys>()?.is_some() {}
        Ok(self)
    }

    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Self, A::Error> {
        let mut keys = std::collections::HashSet::new();
        while let Some(key) = map.next_key::<String>()? {
            if keys.contains(&key) {
                return Err(serde::de::Error::custom(format_args!(
                    "the key `{key}` is repeated"
                )));
            }
            map.next_value::<UniqueKeys>()?;
            keys.insert(key);
        }
        Ok(self)
    }
}

/// The conflicted path `path` (relative to `requested`, a path in its
/// repository) as «Изменения» resolve it.
pub async fn read(cli: &GitCli, requested: &Path, path: &str) -> Result<ConflictFile, GitError> {
    let (repo, prefix) = repository_of(cli, requested).await?;
    let relative = repository_path(&prefix, path)?;
    let conflict = conflicted(cli, &repo, &relative).await?;
    let kind = conflict_kind::unresolved(cli, &repo)
        .await?
        .into_iter()
        .find(|item| item.holds(&relative))
        .map(|item| item.kind)
        .ok_or_else(|| not_in_conflict(&relative))?;
    let binary = conflict.ours.is_some()
        && conflict.theirs.is_some()
        && (kind == ConflictKind::Binary
            || conflict_kind::is_binary(cli, &repo, &conflict).await?);
    let changes = if without_markers(kind, binary) {
        let group = if kind == ConflictKind::RenameRename {
            let conflicts = service_merge::index_conflicts(cli, &repo).await?;
            conflict_kind::rename_groups(cli, &repo, &conflicts)
                .await?
                .into_iter()
                .find(|group| group.holds(&relative))
        } else {
            None
        };
        Some(
            side_changes(
                cli,
                &repo,
                &prefix,
                &relative,
                kind,
                binary,
                &conflict,
                group.as_ref(),
            )
            .await?,
        )
    } else {
        None
    };
    let content = read_working(&repo.join(&relative))?;
    let version = content.as_deref().map(version_of).unwrap_or_default();
    let text_kind = matches!(
        kind,
        ConflictKind::Text
            | ConflictKind::AddAdd
            | ConflictKind::PageText
            | ConflictKind::PageProperties
    ) && !binary;
    let (content, places) = match content {
        Some(content) if text_kind && !content.contains(&0) => {
            let size = markers::marker_sizes(cli, &repo, std::slice::from_ref(&relative))
                .await?
                .get(&relative)
                .copied()
                .unwrap_or(markers::DEFAULT_MARKER_SIZE);
            let places = places(&content, size, super::versions::is_page(&relative));
            let shown =
                (content.len() <= MAX_TEXT).then(|| String::from_utf8_lossy(&content).into_owned());
            (shown, Some(places))
        }
        _ => (None, None),
    };
    Ok(ConflictFile {
        path: path.to_owned(),
        kind,
        version,
        content,
        places,
        ours: conflict.ours.is_some(),
        theirs: conflict.theirs.is_some(),
        binary,
        changes,
    })
}

/// Whether a conflict of `kind` is resolved as a whole file, without places.
fn without_markers(kind: ConflictKind, binary: bool) -> bool {
    match kind {
        ConflictKind::Binary
        | ConflictKind::ModifyDelete
        | ConflictKind::RenameRename
        | ConflictKind::RenameDelete => true,
        ConflictKind::AddAdd => binary,
        _ => false,
    }
}

/// What each side did with the file without markers at the
/// repository-relative `path`; names are relative to `prefix`.
#[allow(clippy::too_many_arguments)]
async fn side_changes(
    cli: &GitCli,
    repo: &Path,
    prefix: &str,
    path: &str,
    kind: ConflictKind,
    binary: bool,
    conflict: &ConflictedPath,
    group: Option<&RenameGroup>,
) -> Result<SideChanges, GitError> {
    let shown = |name: &str| {
        let under = format!("{prefix}/");
        if prefix.is_empty() {
            name.to_owned()
        } else {
            name.strip_prefix(&under).unwrap_or(name).to_owned()
        }
    };
    let mut sides = Vec::with_capacity(2);
    for (stage, renamed) in [
        (&conflict.ours, group.map(|group| group.ours.as_str())),
        (&conflict.theirs, group.map(|group| group.theirs.as_str())),
    ] {
        let change = match (kind, stage) {
            (ConflictKind::RenameRename, _) => Change::Renamed,
            (_, None) => Change::Deleted,
            (ConflictKind::AddAdd, Some(_)) => Change::Added,
            (ConflictKind::RenameDelete, Some(_)) => Change::Renamed,
            _ => Change::Modified,
        };
        let name = match change {
            Change::Renamed => renamed.or(stage.as_ref().map(|_| path)).map(shown),
            _ => None,
        };
        let size = match stage {
            Some(stage) if binary => Some(stage_facts(cli, repo, stage).await?.size),
            _ => None,
        };
        sides.push(SideChange {
            change,
            path: name,
            size,
        });
    }
    let theirs = sides.pop().expect("two sides");
    let ours = sides.pop().expect("two sides");
    Ok(SideChanges { ours, theirs })
}

/// What decides how a version of a side is written.
struct StageFacts {
    /// The version is a Git LFS pointer.
    lfs: bool,
    /// Bytes of the version; of the object of an LFS pointer.
    size: u64,
}

async fn stage_facts(
    cli: &GitCli,
    repo: &Path,
    stage: &service_merge::StageEntry,
) -> Result<StageFacts, GitError> {
    let (_, head) = super::cli::read_bounded(
        cli,
        repo,
        &["cat-file", "blob", &stage.oid],
        LFS_POINTER_MAX,
    )
    .await?;
    if head.starts_with(conflict_kind::LFS_POINTER) {
        let size = String::from_utf8_lossy(&head)
            .lines()
            .find_map(|line| line.strip_prefix("size ")?.trim().parse().ok());
        if let Some(size) = size {
            return Ok(StageFacts { lfs: true, size });
        }
    }
    let out = cli.exec(repo, &["cat-file", "-s", &stage.oid]).await?;
    if out.exit_code != 0 {
        return Err(GitError::GitCommandFailed(format!(
            "git cat-file failed: {}",
            out.stderr.trim()
        )));
    }
    let size = out.stdout.trim().parse().map_err(|_| {
        GitError::GitCommandFailed(format!("git cat-file gave no size: {}", out.stdout.trim()))
    })?;
    Ok(StageFacts { lfs: false, size })
}

/// Resolve the conflicted text file at the repository-relative `path` of
/// `repo` by `resolution`, then continue as resolving a path does: the last
/// path finishes the merge and publishes it, files in conflict without an
/// operation become ordinary changes. A result with marker lines or one that
/// does not read is not written and comes back as
/// [`SyncResult::Unresolved`].
pub async fn resolve(
    cli: &GitCli,
    repo: &Path,
    path: &str,
    resolution: &FileResolution,
) -> Result<SyncResult, GitError> {
    // Another operation gives its index stages other sides.
    if let Some(operation) = super::branch::operation_in_progress(cli, repo)
        .await?
        .filter(|operation| *operation != GitOperation::Merge)
    {
        return super::sync::operation_stopped(cli, repo, operation).await;
    }
    let path = normalize_repo_relative(path, RootMode::Reject)?;
    let target = super::operations::read_transport(cli, repo).await?;
    let conflict = conflicted(cli, repo, &path).await?;
    let size = markers::marker_sizes(cli, repo, std::slice::from_ref(&path))
        .await?
        .get(&path)
        .copied()
        .unwrap_or(markers::DEFAULT_MARKER_SIZE);
    let unresolved = |finding| {
        Ok(SyncResult::Unresolved {
            path: path.clone(),
            finding,
        })
    };
    if !matches!(resolution, FileResolution::Places { .. }) {
        let kind = conflict_kind::unresolved(cli, repo)
            .await?
            .into_iter()
            .find(|item| item.holds(&path))
            .map(|item| item.kind)
            .ok_or_else(|| not_in_conflict(&path))?;
        let binary = conflict.ours.is_some()
            && conflict.theirs.is_some()
            && (kind == ConflictKind::Binary
                || conflict_kind::is_binary(cli, repo, &conflict).await?);
        let finding = match resolution {
            FileResolution::Side { side } if without_markers(kind, binary) => {
                Some(take_side(cli, repo, &path, &conflict, kind, *side, size).await?)
            }
            FileResolution::Delete => Some(delete(cli, repo, &path, &conflict, kind).await?),
            FileResolution::KeepBoth { language } => {
                Some(keep_both(cli, repo, &path, &conflict, kind, *language, size).await?)
            }
            _ => None,
        };
        match finding {
            Some(Some(finding)) => return unresolved(finding),
            Some(None) => {
                return super::sync::continue_merge(cli, repo, &target, Vec::new()).await;
            }
            None => {}
        }
    }
    let result = match resolution {
        FileResolution::Places { version, choices } => {
            let Some(content) = read_working(&repo.join(&path))? else {
                return unresolved(ResolutionFinding::Changed);
            };
            if version_of(&content) != *version {
                return unresolved(ResolutionFinding::Changed);
            }
            if let Places::Places { places } =
                places(&content, size, super::versions::is_page(&path))
                && places
                    .iter()
                    .zip(choices)
                    .any(|(place, choice)| place.frontmatter && *choice == PlaceChoice::Both)
            {
                return Err(GitError::Conflict(format!(
                    "Both sides cannot be kept in a place in the frontmatter of {path}: they would repeat its keys"
                )));
            }
            let Some(result) = apply_choices(&content, size, choices) else {
                return unresolved(ResolutionFinding::Changed);
            };
            result
        }
        FileResolution::Side { side } => {
            let stage = match side {
                Side::Ours => conflict.ours.as_ref(),
                Side::Theirs => conflict.theirs.as_ref(),
            };
            let Some(stage) = stage.filter(|stage| stage.is_regular_file()) else {
                return Err(GitError::Conflict(format!(
                    "The {} version of {path} is not in the index",
                    match side {
                        Side::Ours => "local",
                        Side::Theirs => "incoming",
                    }
                )));
            };
            let (complete, bytes) =
                super::cli::read_bounded(cli, repo, &["cat-file", "blob", &stage.oid], MAX_SIDE)
                    .await?;
            if !complete {
                return Err(GitError::GitCommandFailed(format!(
                    "Cannot read the version of {path} from the index"
                )));
            }
            bytes
        }
        FileResolution::Delete | FileResolution::KeepBoth { .. } => {
            return Err(GitError::Conflict(format!(
                "{path} is resolved as a whole file"
            )));
        }
    };
    if let Some(finding) = check_result(&path, &result, size) {
        return unresolved(finding);
    }
    let file = repo.join(&path);
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&file, &result)?;
    let out = cli
        .exec_with_input(
            repo,
            &["add", "--pathspec-from-file=-", "--pathspec-file-nul"],
            &[],
            &literal_pathspec_input(std::slice::from_ref(&path)),
        )
        .await?;
    if out.exit_code != 0 {
        return Err(super::ops::sync_failure(
            repo,
            GitStage::Commit,
            &out.stderr,
            false,
        ));
    }
    super::sync::continue_merge(cli, repo, &target, Vec::new()).await
}

/// Temporary files of versions Git wrote into the repository, removed when
/// they were not moved into place.
#[derive(Default)]
struct Temporary(Vec<std::path::PathBuf>);

impl Drop for Temporary {
    fn drop(&mut self) {
        for file in &self.0 {
            let _ = std::fs::remove_file(file);
        }
    }
}

/// A version of a side written by Git to a temporary file, with the facts of
/// its stage.
struct Version {
    file: std::path::PathBuf,
    facts: StageFacts,
}

/// The version of stage `stage` (2 mine, 3 incoming) of the
/// repository-relative `path`, written by Git with the filters of the path:
/// an LFS file gets its object, which Git LFS fetches when it is missing. An
/// object Git LFS cannot give, or an incoming pointer it left as is, is a
/// [`ResolutionFinding::LfsObject`].
async fn checkout_stage(
    cli: &GitCli,
    repo: &Path,
    path: &str,
    stage: &service_merge::StageEntry,
    number: u8,
    temporary: &mut Temporary,
) -> Result<Result<Version, ResolutionFinding>, GitError> {
    if !stage.is_regular_file() {
        return Err(GitError::Conflict(format!(
            "A version of {path} in the index is not a file"
        )));
    }
    let facts = stage_facts(cli, repo, stage).await?;
    let stage_arg = format!("--stage={number}");
    let out = cli
        .exec_with_input(
            repo,
            &["checkout-index", &stage_arg, "--temp", "-z", "--stdin"],
            &[],
            &nul_paths_input([&path.to_owned()]),
        )
        .await?;
    if out.exit_code != 0 {
        let message = out.stderr.trim().to_owned();
        if facts.lfs {
            return Ok(Err(ResolutionFinding::LfsObject { message }));
        }
        return Err(GitError::GitCommandFailed(format!(
            "git checkout-index failed: {message}"
        )));
    }
    let name = out
        .stdout
        .split(['\t', '\0'])
        .next()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| GitError::GitCommandFailed("git checkout-index wrote no version".into()))?;
    let file = repo.join(name);
    temporary.0.push(file.clone());
    if facts.lfs && number == 3 {
        let mut head = vec![0; conflict_kind::LFS_POINTER.len()];
        let read = std::fs::File::open(&file)
            .and_then(|mut opened| std::io::Read::read(&mut opened, &mut head))?;
        if head[..read] == *conflict_kind::LFS_POINTER {
            return Ok(Err(ResolutionFinding::LfsObject {
                message: "Git LFS did not fetch the object of the incoming version".into(),
            }));
        }
    }
    Ok(Ok(Version { file, facts }))
}

/// Why the text `version` cannot resolve `path`, if it is text and cannot;
/// binary and LFS versions are not read.
fn check_version(
    path: &str,
    version: &Version,
    size: usize,
) -> Result<Option<ResolutionFinding>, GitError> {
    if version.facts.lfs || version.facts.size > MAX_SIDE as u64 {
        return Ok(None);
    }
    let content = std::fs::read(&version.file)?;
    let probe = &content[..content.len().min(BINARY_PROBE)];
    if probe.contains(&0) {
        return Ok(None);
    }
    Ok(check_result(path, &content, size))
}

/// Move the version Git wrote into place at the repository-relative `path`.
fn place(repo: &Path, version: &Version, path: &str) -> Result<(), GitError> {
    let file = repo.join(path);
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(&version.file, &file)?;
    Ok(())
}

/// The version of `side` for a file without markers: under the name of the
/// side for a rename/rename conflict, the other names removed.
async fn take_side(
    cli: &GitCli,
    repo: &Path,
    path: &str,
    conflict: &ConflictedPath,
    kind: ConflictKind,
    side: Side,
    size: usize,
) -> Result<Option<ResolutionFinding>, GitError> {
    let number = match side {
        Side::Ours => 2,
        Side::Theirs => 3,
    };
    let (keep, stage, drop) = if kind == ConflictKind::RenameRename {
        let conflicts = service_merge::index_conflicts(cli, repo).await?;
        let group = conflict_kind::rename_groups(cli, repo, &conflicts)
            .await?
            .into_iter()
            .find(|group| group.holds(path))
            .ok_or_else(|| {
                GitError::Conflict(format!("The names of the renames of {path} are not known"))
            })?;
        let (keep, other) = match side {
            Side::Ours => (group.ours, group.theirs),
            Side::Theirs => (group.theirs, group.ours),
        };
        let stage = conflicts
            .iter()
            .find(|conflict| conflict.path == keep)
            .and_then(|conflict| match side {
                Side::Ours => conflict.ours.clone(),
                Side::Theirs => conflict.theirs.clone(),
            });
        (keep, stage, vec![group.original, other])
    } else {
        let stage = match side {
            Side::Ours => conflict.ours.clone(),
            Side::Theirs => conflict.theirs.clone(),
        };
        (path.to_owned(), stage, Vec::new())
    };
    let Some(stage) = stage else {
        return Err(GitError::Conflict(format!(
            "The {} version of {keep} is not in the index",
            match side {
                Side::Ours => "local",
                Side::Theirs => "incoming",
            }
        )));
    };
    let mut temporary = Temporary::default();
    let version = match checkout_stage(cli, repo, &keep, &stage, number, &mut temporary).await? {
        Ok(version) => version,
        Err(finding) => return Ok(Some(finding)),
    };
    if let Some(finding) = check_version(&keep, &version, size)? {
        return Ok(Some(finding));
    }
    place(repo, &version, &keep)?;
    remove_paths(cli, repo, &drop).await?;
    add_paths(cli, repo, &[keep]).await?;
    Ok(None)
}

/// «Удалить»: the path goes, as the side that deleted the file did.
async fn delete(
    cli: &GitCli,
    repo: &Path,
    path: &str,
    conflict: &ConflictedPath,
    kind: ConflictKind,
) -> Result<Option<ResolutionFinding>, GitError> {
    let deleted = conflict.ours.is_none() || conflict.theirs.is_none();
    if !deleted
        || !matches!(
            kind,
            ConflictKind::ModifyDelete | ConflictKind::RenameDelete
        )
    {
        return Err(GitError::Conflict(format!(
            "{path} is not deleted on either side"
        )));
    }
    remove_paths(cli, repo, &[path.to_owned()]).await?;
    Ok(None)
}

/// «Сохранить обе»: my version stays at the path, the incoming one goes
/// beside it as a copy named with the suffix of `language` and a number when
/// the name is taken; a Page copy is a new Page right after the original.
#[allow(clippy::too_many_arguments)]
async fn keep_both(
    cli: &GitCli,
    repo: &Path,
    path: &str,
    conflict: &ConflictedPath,
    kind: ConflictKind,
    language: MessageLanguage,
    size: usize,
) -> Result<Option<ResolutionFinding>, GitError> {
    let (Some(ours), Some(theirs)) = (&conflict.ours, &conflict.theirs) else {
        return Err(GitError::Conflict(format!(
            "{path} has no version on one side"
        )));
    };
    if !matches!(kind, ConflictKind::Binary | ConflictKind::AddAdd) {
        return Err(GitError::Conflict(format!(
            "Both versions of {path} cannot be kept"
        )));
    }
    let mut temporary = Temporary::default();
    let mine = match checkout_stage(cli, repo, path, ours, 2, &mut temporary).await? {
        Ok(version) => version,
        Err(finding) => return Ok(Some(finding)),
    };
    let incoming = match checkout_stage(cli, repo, path, theirs, 3, &mut temporary).await? {
        Ok(version) => version,
        Err(finding) => return Ok(Some(finding)),
    };
    if let Some(finding) = check_version(path, &mine, size)? {
        return Ok(Some(finding));
    }
    let suffix = incoming_suffix(language);
    let mut staged = vec![path.to_owned()];
    if super::versions::is_page(path) {
        let content = std::fs::read(&incoming.file)?;
        let space = space_of(repo, path);
        let prefix = space
            .strip_prefix(repo)
            .unwrap_or(Path::new(""))
            .to_string_lossy()
            .replace('\\', "/");
        let within = if prefix.is_empty() {
            path.to_owned()
        } else {
            path.strip_prefix(&format!("{prefix}/"))
                .unwrap_or(path)
                .to_owned()
        };
        let order = space.join(".svode").join("order.json");
        let order_path = if prefix.is_empty() {
            ".svode/order.json".to_owned()
        } else {
            format!("{prefix}/.svode/order.json")
        };
        let order_conflicted = service_merge::index_conflicts(cli, repo)
            .await?
            .iter()
            .any(|conflict| conflict.path == order_path);
        let before = std::fs::read(&order).ok();
        place(repo, &mine, path)?;
        let copy = crate::page::store::write_incoming_copy(&space, &within, &content, suffix)
            .map_err(|error| GitError::GitCommandFailed(error.to_string()))?;
        staged.push(repository_path(&prefix, &copy)?);
        if !order_conflicted && std::fs::read(&order).ok() != before && order.exists() {
            staged.push(order_path);
        }
    } else {
        let copy = copy_path(repo, path, suffix)?;
        place(repo, &mine, path)?;
        place(repo, &incoming, &copy)?;
        staged.push(copy);
    }
    add_paths(cli, repo, &staged).await?;
    Ok(None)
}

/// The suffix of the incoming copy of «Сохранить обе» in `language`.
pub fn incoming_suffix(language: MessageLanguage) -> &'static str {
    match language {
        MessageLanguage::Ru => "(входящая)",
        MessageLanguage::En => "(incoming)",
    }
}

/// The repository-relative path of the incoming copy of `path`: its name
/// with `suffix` before the extension, numbered when the name is taken, as
/// Svode numbers the names of Pages.
fn copy_path(repo: &Path, path: &str, suffix: &str) -> Result<String, GitError> {
    let (parent, name) = path.rsplit_once('/').unwrap_or(("", path));
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, Some(extension)),
        _ => (name, None),
    };
    let projection = crate::page::filename::project(&format!("{stem} {suffix}"));
    let (file, _) =
        crate::page::filename::allocate_available_path(&repo.join(parent), &projection, extension)
            .map_err(|error| GitError::GitCommandFailed(error.to_string()))?;
    let name = file
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(if parent.is_empty() {
        name
    } else {
        format!("{parent}/{name}")
    })
}

/// The Space of the repository-relative `path`: the nearest folder above it
/// within `repo` with a Space config, else the repository.
fn space_of(repo: &Path, path: &str) -> std::path::PathBuf {
    let file = repo.join(path);
    file.ancestors()
        .skip(1)
        .take_while(|folder| folder.starts_with(repo))
        .find(|folder| folder.join(".svode").join("config.json").is_file())
        .unwrap_or(repo)
        .to_path_buf()
}

/// Stage the repository-relative `paths` as resolved.
async fn add_paths(cli: &GitCli, repo: &Path, paths: &[String]) -> Result<(), GitError> {
    let out = cli
        .exec_with_input(
            repo,
            &["add", "--pathspec-from-file=-", "--pathspec-file-nul"],
            &[],
            &literal_pathspec_input(paths),
        )
        .await?;
    if out.exit_code != 0 {
        return Err(super::ops::sync_failure(
            repo,
            GitStage::Commit,
            &out.stderr,
            false,
        ));
    }
    Ok(())
}

/// Remove the repository-relative `paths` from the index, every stage, and
/// from the working tree.
async fn remove_paths(cli: &GitCli, repo: &Path, paths: &[String]) -> Result<(), GitError> {
    if paths.is_empty() {
        return Ok(());
    }
    let out = cli
        .exec_with_input(
            repo,
            &[
                "rm",
                "-q",
                "--ignore-unmatch",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ],
            &[],
            &literal_pathspec_input(paths),
        )
        .await?;
    if out.exit_code != 0 {
        return Err(super::ops::sync_failure(
            repo,
            GitStage::Commit,
            &out.stderr,
            false,
        ));
    }
    Ok(())
}

/// The repository top level of `requested` and the prefix of `requested`
/// within it.
pub async fn repository_of(
    cli: &GitCli,
    requested: &Path,
) -> Result<(std::path::PathBuf, String), GitError> {
    let out = cli
        .exec(
            requested,
            &["rev-parse", "--show-toplevel", "--show-prefix"],
        )
        .await?;
    if out.exit_code != 0 {
        return Err(GitError::GitCommandFailed(format!(
            "git rev-parse failed: {}",
            out.stderr.trim()
        )));
    }
    let mut lines = out.stdout.lines();
    let top = lines
        .next()
        .filter(|top| !top.is_empty())
        .ok_or_else(|| GitError::GitCommandFailed("git rev-parse returned no top level".into()))?;
    let prefix = lines.next().unwrap_or("").trim_end_matches('/').to_owned();
    Ok((std::path::PathBuf::from(top), prefix))
}

/// `path` relative to the repository, from a path relative to `prefix`.
pub fn repository_path(prefix: &str, path: &str) -> Result<String, GitError> {
    let path = normalize_repo_relative(path, RootMode::Reject)?;
    Ok(if prefix.is_empty() {
        path
    } else {
        format!("{prefix}/{path}")
    })
}

async fn conflicted(cli: &GitCli, repo: &Path, path: &str) -> Result<ConflictedPath, GitError> {
    service_merge::index_conflicts(cli, repo)
        .await?
        .into_iter()
        .find(|conflict| conflict.path == path)
        .ok_or_else(|| not_in_conflict(path))
}

fn not_in_conflict(path: &str) -> GitError {
    GitError::Conflict(format!("{path} is not in conflict"))
}

/// The working file `file`, or `None` when there is none.
pub(super) fn read_working(file: &Path) -> Result<Option<Vec<u8>>, GitError> {
    match std::fs::read(file) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn version_of(content: &[u8]) -> String {
    Sha256::digest(content)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
#[path = "conflict_file_tests.rs"]
mod tests;

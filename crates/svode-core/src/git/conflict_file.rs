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

use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::GitError;
use super::branch::GitOperation;
use super::cli::{GitCli, literal_pathspec_input};
use super::conflict_kind::{self, ConflictKind};
use super::diagnostics::GitStage;
use super::markers;
use super::path::{RootMode, normalize_repo_relative};
use super::service_merge::{self, ConflictedPath};
use super::sync::SyncResult;

/// A text file larger than this is not shown or resolved by places.
const MAX_TEXT: usize = 4 * 1024 * 1024;
/// A version of a side larger than this is not taken for the whole file.
const MAX_SIDE: usize = 64 * 1024 * 1024;

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

/// How the person resolves a text file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum FileResolution {
    /// A choice in every place of the `version` of the file, in order.
    Places {
        version: String,
        choices: Vec<PlaceChoice>,
    },
    /// The version of `side` before the merge for the whole file.
    Side { side: Side },
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
}

/// The working copy of a path, by lines as Git reads them.
struct Line {
    start: usize,
    /// End of the line without its ending.
    content_end: usize,
    /// End of the line with its ending.
    end: usize,
    kind: Option<u8>,
}

/// A block of a file: the indices of its marker lines; `bar` only in the
/// `diff3` style.
#[derive(Debug, Clone, Copy)]
struct Split {
    lt: usize,
    bar: Option<usize>,
    eq: usize,
    gt: usize,
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
fn split_lines(content: &[u8], size: usize) -> Vec<Line> {
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
fn find_splits(lines: &[Line]) -> (Vec<Split>, bool) {
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

/// The places of `content` with markers of `size`.
pub fn places(content: &[u8], size: usize) -> Places {
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
    let find = |kind: u8, from: usize, to: usize| {
        (from..to.min(lines.len())).find(|index| lines[*index].kind == Some(kind))
    };
    for (index, split) in splits.iter().enumerate() {
        let limit = splits.get(index + 1).map_or(lines.len(), |next| next.lt);
        let ours_end = split.bar.unwrap_or(split.eq);
        let ambiguous = find(b'<', split.lt + 1, ours_end).is_some()
            || split
                .bar
                .is_some_and(|bar| find(b'|', bar + 1, split.eq).is_some())
            || find(b'=', split.eq + 1, split.gt).is_some()
            || find(b'>', split.gt + 1, limit).is_some();
        if ambiguous {
            return Places::Unclear {
                reason: UnclearReason::Ambiguous,
            };
        }
    }
    // Every marker line Git would still see after a choice belongs to a block.
    let mut owned = vec![false; lines.len()];
    for split in &splits {
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
    if lines
        .iter()
        .zip(&owned)
        .any(|(line, owned)| !owned && is_resolvable_marker(line.kind))
    {
        return Places::Unclear {
            reason: UnclearReason::Broken,
        };
    }
    let side = |from: usize, to: usize| -> String {
        if to - from > 1 {
            String::from_utf8_lossy(&content[lines[from + 1].start..lines[to - 1].content_end])
                .into_owned()
        } else {
            String::new()
        }
    };
    Places::Places {
        places: splits
            .iter()
            .map(|split| ConflictPlace {
                start_line: split.lt,
                end_line: split.gt,
                ours: side(split.lt, split.bar.unwrap_or(split.eq)),
                theirs: side(split.eq, split.gt),
            })
            .collect(),
    }
}

/// A `<`, `|` or `>` marker line: Git counts it as a conflict left in the
/// file. A lone `=` line is valid text.
fn is_resolvable_marker(kind: Option<u8>) -> bool {
    matches!(kind, Some(b'<' | b'|' | b'>'))
}

/// `content` with every place replaced by the lines of its chosen side,
/// `None` when the places are not told apart or the choices do not cover
/// them all. Text outside the places stays as Git merged it.
pub fn apply_choices(content: &[u8], size: usize, choices: &[PlaceChoice]) -> Option<Vec<u8>> {
    let Places::Places { places } = places(content, size) else {
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
        // The lines of a side with their endings: each is followed by a marker line.
        let raw = |from: usize, to: usize| &content[lines[from].end..lines[to].start];
        let ours = raw(split.lt, split.bar.unwrap_or(split.eq));
        let theirs = raw(split.eq, split.gt);
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
/// such.
pub fn check_result(path: &str, content: &[u8], size: usize) -> Option<ResolutionFinding> {
    if markers::has_marker_lines(content, size) {
        return Some(ResolutionFinding::Markers);
    }
    let unreadable = |message: String| Some(ResolutionFinding::Unreadable { message });
    if let Some(parse) = super::publication::service_parser(path) {
        return match parse(content) {
            Ok(()) => None,
            Err(message) => unreadable(message),
        };
    }
    let name = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    if name.ends_with(".json") {
        return match serde_json::from_slice::<serde_json::Value>(content) {
            Ok(_) => None,
            Err(error) => unreadable(error.to_string()),
        };
    }
    if name.ends_with(".yaml") || name.ends_with(".yml") {
        let text = match std::str::from_utf8(content) {
            Ok(text) => text,
            Err(error) => return unreadable(error.to_string()),
        };
        return match serde_norway::from_str::<serde_norway::Value>(text) {
            Ok(_) => None,
            Err(error) => unreadable(error.to_string()),
        };
    }
    None
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
        .find(|item| item.path == relative)
        .map(|item| item.kind)
        .ok_or_else(|| not_in_conflict(&relative))?;
    let content = read_working(&repo.join(&relative))?;
    let version = content.as_deref().map(version_of).unwrap_or_default();
    let text_kind = matches!(kind, ConflictKind::Text | ConflictKind::AddAdd);
    let (content, places) = match content {
        Some(content) if text_kind && !content.contains(&0) => {
            let size = markers::marker_sizes(cli, &repo, std::slice::from_ref(&relative))
                .await?
                .get(&relative)
                .copied()
                .unwrap_or(markers::DEFAULT_MARKER_SIZE);
            let places = places(&content, size);
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
    })
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
        return Ok(SyncResult::OperationInProgress { operation });
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
    let result = match resolution {
        FileResolution::Places { version, choices } => {
            let Some(content) = read_working(&repo.join(&path))? else {
                return unresolved(ResolutionFinding::Changed);
            };
            if version_of(&content) != *version {
                return unresolved(ResolutionFinding::Changed);
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

fn read_working(file: &Path) -> Result<Option<Vec<u8>>, GitError> {
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

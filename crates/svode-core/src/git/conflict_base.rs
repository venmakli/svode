//! The base of each conflict place of a Page (DF-293 R1): the common
//! version the two sides changed, read from the place itself in the `diff3`
//! and `zdiff3` styles, otherwise from the merge of the index stages of the
//! path matched to the places of the text by order and the text of the
//! sides.
//!
//! The places are the blocks of the marker lines of the text (DF-238), one
//! per block in order, as the Page editor reads the same text. A place has
//! no base when its marker lines allow another split, when the path has no
//! base stage (add/add) or no stages at all, or when no run of places of the
//! merge after the place matched before it has its sides — the file was
//! edited after the merge or Git merged it otherwise.

use std::path::Path;

use super::GitError;
use super::cli::GitCli;
use super::conflict_file::{Line, Split, ambiguous, find_splits, repository_of, split_lines};
use super::service_merge;
use super::stage_merge::{self, ConflictStyle};
use super::version::GitVersion;

/// `merge.conflictStyle=zdiff3` arrived in Git 2.35.
const ZDIFF3: GitVersion = GitVersion::new(2, 35, 0);

/// The base of each conflict place of `content`, the text of the Page
/// `file` with conflict markers of `size`, in the order of its blocks;
/// `None` for a place without one. Git runs only for places of the `merge`
/// style; without Git only a base in the place itself is found.
pub async fn place_bases(
    cli: Option<&GitCli>,
    file: &Path,
    content: &[u8],
    size: usize,
) -> Result<Vec<Option<String>>, GitError> {
    let lines = split_lines(content, size);
    let (splits, diff3) = find_splits(&lines);
    let clear: Vec<bool> = (0..splits.len())
        .map(|index| !ambiguous(&lines, &splits, index))
        .collect();
    if diff3 {
        return Ok(splits
            .iter()
            .zip(&clear)
            .map(|(split, clear)| {
                clear.then(|| {
                    let bar = split
                        .bar
                        .expect("a block of the diff3 style has a base line");
                    text_of(content, &lines, (bar + 1..split.eq).collect())
                })
            })
            .collect());
    }
    let mut bases = vec![None; splits.len()];
    let Some(cli) = cli.filter(|_| clear.contains(&true)) else {
        return Ok(bases);
    };
    let Some(merge) = merge_of(cli, file, size).await? else {
        return Ok(bases);
    };
    let merged = Merged::new(&merge.text, merge.size);
    let mut from = 0;
    for (index, split) in splits.iter().enumerate() {
        if !clear[index] {
            continue;
        }
        let ours: Vec<&[u8]> = (split.lt + 1..split.eq)
            .map(|line| text(content, &lines[line]))
            .collect();
        let theirs: Vec<&[u8]> = (split.eq + 1..split.gt)
            .map(|line| text(content, &lines[line]))
            .collect();
        if let Some((base, next)) = merged.base_of(&ours, &theirs, from) {
            bases[index] = Some(base);
            from = next;
        }
    }
    Ok(bases)
}

/// The merge of the stages of a path with markers of a size no line of its
/// versions starts with.
struct StageMerge {
    text: Vec<u8>,
    size: usize,
}

/// The stages of `file` merged in the `diff3` style, `zdiff3` where Git has
/// it, `None` when the file is outside a repository, not in conflict,
/// without a base stage or without versions to merge.
async fn merge_of(cli: &GitCli, file: &Path, size: usize) -> Result<Option<StageMerge>, GitError> {
    let (Some(dir), Some(name)) = (
        file.parent(),
        file.file_name().and_then(|name| name.to_str()),
    ) else {
        return Err(GitError::PathNotAccessible(file.display().to_string()));
    };
    let (repo, prefix) = match repository_of(cli, dir).await {
        Ok(found) => found,
        Err(GitError::GitCommandFailed(message)) if message.contains("not a git repository") => {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    let path = if prefix.is_empty() {
        name.to_owned()
    } else {
        format!("{prefix}/{name}")
    };
    let Some(conflict) = service_merge::index_conflicts(cli, &repo)
        .await?
        .into_iter()
        .find(|conflict| conflict.path == path)
    else {
        return Ok(None);
    };
    let Some(texts) = stage_merge::read_stages(cli, &repo, &conflict).await? else {
        return Ok(None);
    };
    let Some(base) = &texts.base else {
        return Ok(None);
    };
    // Longer markers than any run in the versions split the merge one way.
    let size = [base, &texts.ours, &texts.theirs]
        .into_iter()
        .map(|version| longest_marker_run(version) + 1)
        .fold(size, usize::max);
    let style = if cli.version().is_some_and(|version| version >= ZDIFF3) {
        ConflictStyle::Zdiff3
    } else {
        ConflictStyle::Diff3
    };
    let text = stage_merge::merge_texts(cli, &repo, &texts, size, style).await?;
    Ok(Some(StageMerge { text, size }))
}

/// The longest run of one marker character a line of `version` starts with.
fn longest_marker_run(version: &[u8]) -> usize {
    version
        .split(|byte| *byte == b'\n')
        .filter_map(|line| {
            let marker = *line.first()?;
            matches!(marker, b'<' | b'|' | b'=' | b'>')
                .then(|| line.iter().take_while(|byte| **byte == marker).count())
        })
        .max()
        .unwrap_or(0)
}

/// The places of a merge of the stages in the `diff3` style.
struct Merged<'a> {
    content: &'a [u8],
    lines: Vec<Line>,
    splits: Vec<Split>,
}

impl<'a> Merged<'a> {
    fn new(content: &'a [u8], size: usize) -> Self {
        let lines = split_lines(content, size);
        let (splits, diff3) = find_splits(&lines);
        Self {
            content,
            lines,
            splits: if diff3 { splits } else { Vec::new() },
        }
    }

    /// The base of the place with sides `ours` and `theirs` and the place
    /// to match the next one from: the first run of places from `from` whose
    /// sides, joined by the lines between them, are these. Git may write as
    /// one place what is several in the `diff3` style, when little lies
    /// between them.
    fn base_of(&self, ours: &[&[u8]], theirs: &[&[u8]], from: usize) -> Option<(String, usize)> {
        (from..self.splits.len()).find_map(|first| {
            self.run_from(first, ours, theirs)
                .map(|(base, last)| (base, last + 1))
        })
    }

    /// The base and last place of the run from place `first` with sides
    /// `ours` and `theirs`.
    fn run_from(&self, first: usize, ours: &[&[u8]], theirs: &[&[u8]]) -> Option<(String, usize)> {
        let (mut run_ours, mut run_theirs, mut run_base) = (Vec::new(), Vec::new(), Vec::new());
        for last in first..self.splits.len() {
            let split = self.splits[last];
            if last > first {
                let between = self.splits[last - 1].gt + 1..split.lt;
                run_ours.extend(between.clone());
                run_theirs.extend(between.clone());
                run_base.extend(between);
            }
            let bar = split.bar?;
            run_ours.extend(split.lt + 1..bar);
            run_base.extend(bar + 1..split.eq);
            run_theirs.extend(split.eq + 1..split.gt);
            if run_ours.len() > ours.len() || run_theirs.len() > theirs.len() {
                return None;
            }
            if self.same(&run_ours, ours) && self.same(&run_theirs, theirs) {
                return Some((text_of(self.content, &self.lines, run_base), last));
            }
        }
        None
    }

    /// Whether the lines `indices` of the merge read as `side`; line endings
    /// do not count, the stages keep the endings of the repository.
    fn same(&self, indices: &[usize], side: &[&[u8]]) -> bool {
        indices.len() == side.len()
            && indices
                .iter()
                .zip(side)
                .all(|(index, line)| text(self.content, &self.lines[*index]) == *line)
    }
}

fn text<'a>(content: &'a [u8], line: &Line) -> &'a [u8] {
    &content[line.start..line.content_end]
}

/// The lines `indices` of `content` with their endings, but the last.
fn text_of(content: &[u8], lines: &[Line], indices: Vec<usize>) -> String {
    let mut text = Vec::new();
    for (position, index) in indices.iter().enumerate() {
        let line = &lines[*index];
        let end = if position + 1 == indices.len() {
            line.content_end
        } else {
            line.end
        };
        text.extend_from_slice(&content[line.start..end]);
    }
    String::from_utf8_lossy(&text).into_owned()
}

#[cfg(all(test, unix))]
#[path = "conflict_base_tests.rs"]
mod tests;

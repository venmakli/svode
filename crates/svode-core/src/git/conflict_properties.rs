//! The properties of a Page in conflict (module 01, 1.F «Свойства Page»):
//! the places of dispute in its frontmatter and the frontmatter with the
//! lines of the chosen side of every place, word for word.
//!
//! The editor shows only the text after the frontmatter through Markdown IO:
//! read and written as Markdown, YAML lines lose escapes, indents and line
//! breaks (Evidence E4). The places come from the same reading of marker
//! lines as a text file in conflict ([`super::conflict_file::places`]); a
//! place that takes the closing `---` and the start of the text belongs to
//! the frontmatter as a whole. A place that is not told apart leaves the
//! version of a side for the whole file.

use serde::Serialize;

use super::conflict_file::{
    self, Line, MAX_TEXT, Places, ResolutionFinding, Side, Split, UnclearReason,
};
use super::conflict_kind::markers_in_frontmatter;
use super::markers;

const DELIMITER: &[u8] = b"---";

/// The frontmatter of a Page in conflict and the text after it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertiesConflict {
    /// The places of the frontmatter, or why there are none.
    pub places: Places,
    /// The text after the frontmatter and its places: what the editor shows
    /// below the block.
    pub body: String,
    /// A place takes the closing `---` and the start of the text.
    pub reaches_text: bool,
}

/// The frontmatter after a choice in every place, or why it does not
/// resolve the properties.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum PropertiesResolution {
    /// The frontmatter through its closing `---`, with the text lines of a
    /// place that reaches the text.
    Resolved {
        frontmatter: String,
    },
    Unresolved {
        finding: ResolutionFinding,
    },
}

/// The frontmatter of a conflicted Page by lines.
struct Frontmatter {
    lines: Vec<Line>,
    splits: Vec<Split>,
    /// Indices into `splits` of the blocks in the frontmatter.
    blocks: Vec<usize>,
    /// Index of the first line after the frontmatter.
    end_line: usize,
    reaches_text: bool,
}

impl Frontmatter {
    /// The frontmatter of `content` with conflict markers of `size` in it.
    fn read(content: &[u8], size: usize) -> Option<Self> {
        if !markers_in_frontmatter(content, size) {
            return None;
        }
        let lines = conflict_file::split_lines(content, size);
        let (splits, _) = conflict_file::find_splits(&lines);
        let delimiter = |index: usize| {
            let line = &lines[index];
            &content[line.start..line.content_end] == DELIMITER
        };
        // A conflict from the first line holds the opening `---` in its sides.
        let mut opened = delimiter(0);
        let mut index = usize::from(opened);
        let mut blocks = Vec::new();
        let mut reaches_text = false;
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
                    reaches_text = true;
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
        Some(Self {
            lines,
            splits,
            blocks,
            end_line: index,
            reaches_text,
        })
    }

    /// Offset of the text after the frontmatter.
    fn end(&self, content: &[u8]) -> usize {
        self.lines
            .get(self.end_line)
            .map_or(content.len(), |line| line.start)
    }

    /// The places of the frontmatter, or why they are not told apart.
    fn places(&self, content: &[u8]) -> Places {
        let unclear = |reason| Places::Unclear { reason };
        if content.len() > MAX_TEXT {
            return unclear(UnclearReason::TooLarge);
        }
        if self.blocks.is_empty() {
            return unclear(UnclearReason::Broken);
        }
        if self
            .blocks
            .iter()
            .any(|at| conflict_file::ambiguous(&self.lines, &self.splits, *at))
        {
            return unclear(UnclearReason::Ambiguous);
        }
        let blocks: Vec<Split> = self.blocks.iter().map(|at| self.splits[*at]).collect();
        if conflict_file::unowned_marker(&self.lines, &blocks, 0..self.end_line) {
            return unclear(UnclearReason::Broken);
        }
        Places::Places {
            places: blocks
                .iter()
                .map(|split| conflict_file::conflict_place(content, &self.lines, split))
                .collect(),
        }
    }
}

/// The properties conflict of the Page `content` with conflict markers of
/// `size`, `None` when no marker opens in its frontmatter.
pub fn properties(content: &[u8], size: usize) -> Option<PropertiesConflict> {
    let frontmatter = Frontmatter::read(content, size)?;
    Some(PropertiesConflict {
        places: frontmatter.places(content),
        body: String::from_utf8_lossy(&content[frontmatter.end(content)..]).into_owned(),
        reaches_text: frontmatter.reaches_text,
    })
}

/// The frontmatter of the Page `content` with every place of its properties
/// replaced by the lines of its chosen side as they are. It resolves only
/// without marker lines of `size` and when it reads as frontmatter; choices
/// that do not match the places find the file changed.
pub fn resolve_properties(content: &[u8], size: usize, choices: &[Side]) -> PropertiesResolution {
    let unresolved = |finding| PropertiesResolution::Unresolved { finding };
    let Some(frontmatter) = Frontmatter::read(content, size) else {
        return unresolved(ResolutionFinding::Changed);
    };
    let Places::Places { places } = frontmatter.places(content) else {
        return unresolved(ResolutionFinding::Changed);
    };
    if places.len() != choices.len() {
        return unresolved(ResolutionFinding::Changed);
    }
    let lines = &frontmatter.lines;
    let mut result = Vec::with_capacity(frontmatter.end(content));
    let mut cursor = 0;
    for (at, choice) in frontmatter.blocks.iter().zip(choices) {
        let split = &frontmatter.splits[*at];
        result.extend_from_slice(&content[cursor..lines[split.lt].start]);
        result.extend_from_slice(conflict_file::raw_side(
            content,
            lines,
            split,
            *choice == Side::Ours,
        ));
        cursor = lines[split.gt].end;
    }
    result.extend_from_slice(&content[cursor..frontmatter.end(content)]);
    if markers::has_marker_lines(&result, size) {
        return unresolved(ResolutionFinding::Markers);
    }
    if let Some(finding) = conflict_file::frontmatter_finding(&result) {
        return unresolved(finding);
    }
    PropertiesResolution::Resolved {
        frontmatter: String::from_utf8_lossy(&result).into_owned(),
    }
}

#[cfg(test)]
#[path = "conflict_properties_tests.rs"]
mod tests;

//! The properties of a Page in conflict (module 01, 1.F «Свойства Page»):
//! the places of dispute in its frontmatter and the frontmatter with the
//! lines of the chosen side of every place, word for word.
//!
//! The editor shows only the text after the frontmatter through Markdown IO:
//! read and written as Markdown, YAML lines lose escapes, indents and line
//! breaks (Evidence E4). The places come from the same reading of marker
//! lines as a text file in conflict ([`super::conflict_file::places`]), and
//! so does the rule of which places lie in the frontmatter
//! ([`super::conflict_file::frontmatter_places`]); a place that takes the
//! closing `---` and the start of the text belongs to the frontmatter as a
//! whole. A place that is not told apart leaves the version of a side for
//! the whole file.

use std::path::Path;

use serde::Serialize;

use super::conflict_file::{
    self, FrontmatterPlaces, Line, MAX_TEXT, Places, ResolutionFinding, Side, Split, UnclearReason,
};
use super::markers;

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
    /// The opening `---` lies in a side of a place from the first line, as
    /// when both sides added the Page: the place is in the text of the Page
    /// as the editor shows it (DF-293 R6).
    pub opens_in_place: bool,
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
    opens_in_place: bool,
}

impl Frontmatter {
    /// The frontmatter of `content` with conflict markers of `size` in it.
    fn read(content: &[u8], size: usize) -> Option<Self> {
        let lines = conflict_file::split_lines(content, size);
        let (splits, _) = conflict_file::find_splits(&lines);
        let FrontmatterPlaces {
            blocks,
            end_line,
            reaches_text,
            opens_in_place,
        } = conflict_file::frontmatter_places(content, &lines, &splits)?;
        Some(Self {
            lines,
            splits,
            blocks,
            end_line,
            reaches_text,
            opens_in_place,
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
                .map(|split| conflict_file::conflict_place(content, &self.lines, split, true))
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
        opens_in_place: frontmatter.opens_in_place,
    })
}

/// The properties conflict of the Page `file` whose text, as the editor
/// reads it, is `content`: only when that text is the whole file — the
/// frontmatter of the Page does not read, so the editor got all of it.
/// Otherwise the text follows a frontmatter that reads and no place of it
/// is in the frontmatter.
pub fn page_properties(file: &Path, content: &[u8], size: usize) -> Option<PropertiesConflict> {
    let whole = std::fs::read(file).ok()?;
    if whole != content {
        return None;
    }
    properties(content, size)
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

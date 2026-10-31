//! Kinds of conflicted paths (module 01, 1.F): one vocabulary for the stop
//! «Конфликт с правками коллег» of the in-memory preflight (1.B) and for the
//! unresolved paths of a merge. A kind follows the index stages of the path
//! and whether Git merged it as text, not its extension; a Page is told
//! apart by where its conflict markers stand.

use serde::Serialize;

use super::service_merge::{ConflictedPath, StageEntry};

/// What kind of conflict a path holds, as the person resolves it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictKind {
    /// Both sides changed the text of a Page.
    PageText,
    /// Both sides changed the properties (frontmatter) of a Page.
    PageProperties,
    /// Both sides changed a text file outside a Page.
    Text,
    /// Both sides changed a file Git does not merge as text, LFS included.
    Binary,
    /// One side changed the file, the other deleted it.
    ModifyDelete,
    /// Both sides added a file at the path.
    AddAdd,
    /// Both sides renamed the same file differently.
    RenameRename,
    /// One side renamed the file, the other deleted it.
    RenameDelete,
    /// The Space pointer (gitlink) of the project.
    SpacePointer,
}

/// A conflicted path and its kind; the path is relative to the repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathConflict {
    pub path: String,
    pub kind: ConflictKind,
}

/// What decides a kind besides the stages of the path.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct KindFacts {
    /// Git did not merge the sides as text.
    pub binary: bool,
    /// The path takes part in a rename conflict:
    /// [`ConflictKind::RenameRename`] or [`ConflictKind::RenameDelete`].
    pub rename: Option<ConflictKind>,
    /// Conflict markers of the merged Page stand in its frontmatter.
    pub frontmatter: bool,
}

/// The kind of `conflict` by its stages and `facts`.
pub fn classify(conflict: &ConflictedPath, facts: KindFacts) -> ConflictKind {
    if conflict.sides().any(StageEntry::is_gitlink) {
        return ConflictKind::SpacePointer;
    }
    if let Some(rename) = facts.rename {
        return rename;
    }
    match (&conflict.base, &conflict.ours, &conflict.theirs) {
        (None, Some(_), Some(_)) => ConflictKind::AddAdd,
        (Some(_), Some(_), Some(_)) if facts.binary => ConflictKind::Binary,
        (Some(_), Some(_), Some(_)) if super::versions::is_page(&conflict.path) => {
            if facts.frontmatter {
                ConflictKind::PageProperties
            } else {
                ConflictKind::PageText
            }
        }
        (Some(_), Some(_), Some(_)) => ConflictKind::Text,
        _ => ConflictKind::ModifyDelete,
    }
}

/// Whether a conflict marker of `size` in the merged `content` of a Page
/// opens before the end of its frontmatter: the conflict is in the
/// properties, including a conflict that spans the closing `---` and the
/// start of the text.
pub fn markers_in_frontmatter(content: &[u8], size: usize) -> bool {
    let mut lines = content.split(|byte| *byte == b'\n').map(|line| {
        // As Git reads lines: a `\r` belongs to the line ending only before `\n`.
        line.strip_suffix(b"\r").unwrap_or(line)
    });
    let opens = |line: &[u8]| {
        line.len() >= size
            && line[..size].iter().all(|byte| *byte == b'<')
            && line.get(size).is_none_or(|next| *next == b' ')
    };
    match lines.next() {
        Some(b"---") => {}
        // A conflict from the first line that holds the opening `---`.
        Some(first) if opens(first) => return lines.next() == Some(b"---"),
        _ => return false,
    }
    for line in lines {
        if opens(line) {
            return true;
        }
        if line == b"---" {
            return false;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(mode: &str) -> Option<StageEntry> {
        Some(StageEntry {
            mode: mode.into(),
            oid: "0".repeat(40),
        })
    }

    fn conflict(path: &str, stages: [bool; 3]) -> ConflictedPath {
        let side = |present: bool| present.then(|| entry("100644")).flatten();
        ConflictedPath {
            path: path.into(),
            base: side(stages[0]),
            ours: side(stages[1]),
            theirs: side(stages[2]),
        }
    }

    #[test]
    fn kinds_follow_the_stages_and_facts() {
        let none = KindFacts::default();
        assert_eq!(
            classify(&conflict("notes.txt", [true, true, true]), none),
            ConflictKind::Text
        );
        assert_eq!(
            classify(&conflict("page.md", [true, true, true]), none),
            ConflictKind::PageText
        );
        let frontmatter = KindFacts {
            frontmatter: true,
            ..none
        };
        assert_eq!(
            classify(&conflict("page.md", [true, true, true]), frontmatter),
            ConflictKind::PageProperties
        );
        let binary = KindFacts {
            binary: true,
            ..none
        };
        // A binary file named like a Page is still binary.
        assert_eq!(
            classify(&conflict("image.md", [true, true, true]), binary),
            ConflictKind::Binary
        );
        assert_eq!(
            classify(&conflict("a.txt", [true, true, false]), none),
            ConflictKind::ModifyDelete
        );
        assert_eq!(
            classify(&conflict("a.txt", [true, false, true]), none),
            ConflictKind::ModifyDelete
        );
        assert_eq!(
            classify(&conflict("a.txt", [false, true, true]), none),
            ConflictKind::AddAdd
        );
        let renamed = KindFacts {
            rename: Some(ConflictKind::RenameDelete),
            ..none
        };
        assert_eq!(
            classify(&conflict("b.txt", [true, true, false]), renamed),
            ConflictKind::RenameDelete
        );
        let pointer = ConflictedPath {
            path: "space".into(),
            base: entry("160000"),
            ours: entry("160000"),
            theirs: entry("160000"),
        };
        assert_eq!(classify(&pointer, none), ConflictKind::SpacePointer);
    }

    #[test]
    fn a_marker_before_the_closing_line_is_in_the_properties() {
        let properties =
            b"---\n<<<<<<< ours\ntitle: A\n=======\ntitle: B\n>>>>>>> theirs\n---\nText\n";
        assert!(markers_in_frontmatter(properties, 7));
        let text = b"---\ntitle: A\n---\n<<<<<<< ours\nA\n=======\nB\n>>>>>>> theirs\n";
        assert!(!markers_in_frontmatter(text, 7));
        // A conflict spanning the closing line and the start of the text.
        let spanning = b"---\ntitle: A\n<<<<<<< ours\n---\nA\n=======\n---\nB\n>>>>>>> theirs\n";
        assert!(markers_in_frontmatter(spanning, 7));
        // CRLF line endings and the marker size of the path.
        let crlf =
            b"---\r\n<<<<<<<<<< ours\r\na: 1\r\n==========\r\na: 2\r\n>>>>>>>>>> theirs\r\n---\r\n";
        assert!(markers_in_frontmatter(crlf, 10));
        assert!(!markers_in_frontmatter(crlf, 7));
        // No frontmatter: every conflict is in the text.
        assert!(!markers_in_frontmatter(
            b"<<<<<<< ours\nA\n=======\nB\n>>>>>>> theirs\n",
            7
        ));
        // A conflict from the first line over the opening `---`.
        assert!(markers_in_frontmatter(
            b"<<<<<<< ours\n---\ntitle: A\n---\n=======\nB\n>>>>>>> theirs\n",
            7
        ));
    }
}

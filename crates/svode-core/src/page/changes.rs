//! What changed in one Page between two versions of its Markdown source: its
//! title, the values of its fields and the sections of its text. The facts of
//! version messages (Stage 11 1.G) are made of these.

use serde_norway::Value;

use super::frontmatter::{self, FrontmatterFields, ParseStatus};

/// Longest value a field fact quotes.
const VALUE_CHARS: usize = 60;
/// Largest line comparison a text diff makes; a bigger change counts every
/// line between the common start and end as changed.
const DIFF_CELLS: usize = 4_000_000;

/// One version of a Page source.
#[derive(Debug, Clone, Default)]
pub struct PageVersion {
    /// The title its frontmatter sets; `None` without one.
    pub title: Option<String>,
    pub fields: FrontmatterFields,
    pub body: String,
}

impl PageVersion {
    pub fn read(source: &str) -> Self {
        match frontmatter::parse_status(source) {
            ParseStatus::Valid { meta, body } => Self {
                title: (meta.frontmatter_keys.title && !meta.title.trim().is_empty())
                    .then(|| meta.title.trim().to_string()),
                fields: meta.extra,
                body,
            },
            ParseStatus::Missing { body } | ParseStatus::Malformed { body, .. } => Self {
                title: None,
                fields: FrontmatterFields::new(),
                body,
            },
        }
    }

    /// Whether only the frontmatter differs from `other`.
    pub fn same_text(&self, other: &Self) -> bool {
        self.body.trim_end() == other.body.trim_end()
    }
}

/// A user field whose value differs between two versions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldChange {
    pub field: String,
    pub from: Option<String>,
    pub to: Option<String>,
}

/// Frontmatter keys Svode keeps itself; they are no user fields.
const SYSTEM_KEYS: [&str; 6] = [
    "title",
    "icon",
    "description",
    "cover",
    "created",
    "updated",
];

/// The user fields whose shown value changed, in the order of the new
/// version, then the removed ones.
pub fn field_changes(old: &PageVersion, new: &PageVersion) -> Vec<FieldChange> {
    let mut changes = Vec::new();
    let user = |field: &&String| !SYSTEM_KEYS.contains(&field.as_str());
    for (field, value) in new.fields.iter().filter(|(field, _)| user(field)) {
        let from = old.fields.get(field).and_then(shown_value);
        let to = shown_value(value);
        if from != to {
            changes.push(FieldChange {
                field: field.clone(),
                from,
                to,
            });
        }
    }
    for (field, value) in old.fields.iter().filter(|(field, _)| user(field)) {
        if new.fields.contains_key(field) {
            continue;
        }
        if let Some(from) = shown_value(value) {
            changes.push(FieldChange {
                field: field.clone(),
                from: Some(from),
                to: None,
            });
        }
    }
    changes
}

fn shown_value(value: &Value) -> Option<String> {
    let text = match value {
        Value::Null => return None,
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.trim().to_string(),
        Value::Sequence(items) => items
            .iter()
            .filter_map(shown_value)
            .collect::<Vec<_>>()
            .join(", "),
        Value::Mapping(_) | Value::Tagged(_) => serde_norway::to_string(value)
            .ok()?
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" "),
    };
    if text.is_empty() {
        return None;
    }
    if text.chars().count() <= VALUE_CHARS {
        return Some(text);
    }
    let mut short = text.chars().take(VALUE_CHARS - 1).collect::<String>();
    short.push('…');
    Some(short)
}

/// Lines changed under one heading of the new text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SectionChange {
    /// The heading the lines are under; `None` before the first heading.
    pub heading: Option<String>,
    pub changed: usize,
    pub total: usize,
}

impl SectionChange {
    /// Changed lines as a percentage of the section.
    pub fn share(&self) -> u8 {
        (self.changed * 100 / self.total.max(1)).min(100) as u8
    }
}

/// The sections of `new` with changed lines: added and replaced lines count
/// where they are, removed lines in the section they were removed from.
pub fn section_changes(old: &str, new: &str) -> Vec<SectionChange> {
    let old_lines = old.lines().collect::<Vec<_>>();
    let new_lines = new.lines().collect::<Vec<_>>();
    let (added, removed) = changed_lines(&old_lines, &new_lines);
    if new_lines.is_empty() {
        let removed = removed.iter().sum::<usize>();
        return if removed == 0 {
            Vec::new()
        } else {
            vec![SectionChange {
                heading: None,
                changed: removed,
                total: removed,
            }]
        };
    }
    let mut sections = Vec::<(SectionChange, usize, usize)>::new();
    let mut fenced = None::<char>;
    for (index, line) in new_lines.iter().enumerate() {
        let heading = if fenced.is_none() {
            heading_text(line)
        } else {
            None
        };
        if let Some(fence) = fence_marker(line) {
            fenced = match fenced {
                Some(open) if open == fence => None,
                None => Some(fence),
                open => open,
            };
        }
        if index == 0 || heading.is_some() {
            sections.push((
                SectionChange {
                    heading,
                    changed: 0,
                    total: 0,
                },
                0,
                0,
            ));
        }
        let (section, section_added, section_removed) =
            sections.last_mut().expect("first line opens a section");
        section.total += 1;
        *section_added += added[index];
        *section_removed += removed[index];
    }
    // A replaced line is one change: an added and a removed line together.
    sections
        .into_iter()
        .map(|(mut section, added, removed)| {
            section.changed = added.max(removed);
            section
        })
        .filter(|section| section.changed > 0)
        .collect()
}

/// Added lines at each line of `new` and old lines removed right after it
/// (before the first line for removals at the start).
fn changed_lines(old: &[&str], new: &[&str]) -> (Vec<usize>, Vec<usize>) {
    let mut counts = vec![0; new.len().max(1)];
    let mut removed = vec![0; new.len().max(1)];
    let prefix = old
        .iter()
        .zip(new)
        .take_while(|(old, new)| old == new)
        .count();
    let suffix = old[prefix..]
        .iter()
        .rev()
        .zip(new[prefix..].iter().rev())
        .take_while(|(old, new)| old == new)
        .count();
    let a = &old[prefix..old.len() - suffix];
    let b = &new[prefix..new.len() - suffix];
    fn removed_at(position: usize, counts: &mut [usize]) {
        let index = position.saturating_sub(1).min(counts.len() - 1);
        counts[index] += 1;
    }
    if a.len().saturating_mul(b.len()) > DIFF_CELLS {
        for index in 0..b.len() {
            counts[prefix + index] += 1;
        }
        for _ in 0..a.len() {
            removed_at(prefix + b.len(), &mut removed);
        }
        return (counts, removed);
    }
    // Longest common subsequence of the middles, from their ends.
    let width = b.len() + 1;
    let mut table = vec![0u32; (a.len() + 1) * width];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            table[i * width + j] = if a[i] == b[j] {
                table[(i + 1) * width + j + 1] + 1
            } else {
                table[(i + 1) * width + j].max(table[i * width + j + 1])
            };
        }
    }
    let (mut i, mut j) = (0, 0);
    while i < a.len() || j < b.len() {
        if i < a.len() && j < b.len() && a[i] == b[j] {
            i += 1;
            j += 1;
        } else if j == b.len()
            || (i < a.len() && table[(i + 1) * width + j] >= table[i * width + j + 1])
        {
            removed_at(prefix + j, &mut removed);
            i += 1;
        } else {
            counts[prefix + j] += 1;
            j += 1;
        }
    }
    (counts, removed)
}

/// The text of an ATX heading line.
fn heading_text(line: &str) -> Option<String> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let level = rest.chars().take_while(|char| *char == '#').count();
    if level == 0 || level > 6 {
        return None;
    }
    let rest = &rest[level..];
    if !rest.is_empty() && !rest.starts_with([' ', '\t']) {
        return None;
    }
    let text = rest.trim().trim_end_matches('#').trim();
    (!text.is_empty()).then(|| text.to_string())
}

fn fence_marker(line: &str) -> Option<char> {
    let trimmed = line.trim_start();
    if trimmed.starts_with("```") {
        Some('`')
    } else if trimmed.starts_with("~~~") {
        Some('~')
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(source: &str) -> PageVersion {
        PageVersion::read(source)
    }

    #[test]
    fn field_changes_name_the_old_and_new_shown_value() {
        let old = page("---\ntitle: BQ-12\nStatus: In progress\nTags: [a]\nOwner: Ann\n---\n");
        let new = page(
            "---\ntitle: BQ-12\nStatus: Done\nTags: [a, b]\nOwner: Ann\nDue: 2026-11-01\n---\n",
        );
        assert_eq!(
            field_changes(&old, &new),
            vec![
                FieldChange {
                    field: "Status".into(),
                    from: Some("In progress".into()),
                    to: Some("Done".into()),
                },
                FieldChange {
                    field: "Tags".into(),
                    from: Some("a".into()),
                    to: Some("a, b".into()),
                },
                FieldChange {
                    field: "Due".into(),
                    from: None,
                    to: Some("2026-11-01".into()),
                },
            ]
        );
        assert_eq!(new.title.as_deref(), Some("BQ-12"));
        assert!(old.same_text(&new));
    }

    #[test]
    fn a_removed_field_and_a_long_value_are_shown() {
        let old = page(&format!(
            "---\ntitle: A\nNote: {}\nGone: x\n---\n",
            "w".repeat(80)
        ));
        let new = page("---\ntitle: A\n---\n");
        let changes = field_changes(&old, &new);
        assert_eq!(changes.len(), 2);
        assert_eq!(
            changes[0].from.as_ref().unwrap().chars().count(),
            VALUE_CHARS
        );
        assert!(changes[0].from.as_ref().unwrap().ends_with('…'));
        assert_eq!(changes[1].field, "Gone");
        assert_eq!(changes[1].to, None);
    }

    #[test]
    fn section_changes_name_the_heading_above_changed_lines() {
        let old = "Intro\n\n## Pricing\nBasic: 10\nPro: 20\n\n## FAQ\nQ\nA\n";
        let new = "Intro\n\n## Pricing\nBasic: 12\nPro: 20\n\n## FAQ\nQ\nA\n";
        assert_eq!(
            section_changes(old, new),
            vec![SectionChange {
                heading: Some("Pricing".into()),
                changed: 1,
                total: 4,
            }]
        );
        assert_eq!(section_changes(old, new)[0].share(), 25);
    }

    #[test]
    fn removed_lines_count_in_their_section_and_text_before_headings_has_none() {
        let old = "Lead\nmore\n# A\none\ntwo\n# B\nx\n";
        let new = "Lead changed\nmore\n# A\none\n# B\nx\n";
        let sections = section_changes(old, new);
        assert_eq!(sections.len(), 2);
        assert_eq!(sections[0].heading, None);
        assert_eq!(sections[1].heading.as_deref(), Some("A"));
        assert_eq!(sections[1].changed, 1);
    }

    #[test]
    fn headings_inside_code_fences_do_not_open_sections() {
        let old = "# Real\n```\n# not a heading\nold\n```\n";
        let new = "# Real\n```\n# not a heading\nnew\n```\n";
        let sections = section_changes(old, new);
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].heading.as_deref(), Some("Real"));
    }

    #[test]
    fn identical_text_has_no_sections_and_cleared_text_has_one() {
        assert!(section_changes("a\nb\n", "a\nb\n").is_empty());
        assert_eq!(
            section_changes("a\nb\n", ""),
            vec![SectionChange {
                heading: None,
                changed: 2,
                total: 2,
            }]
        );
    }
}

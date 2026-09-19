use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use unicode_casefold::UnicodeCaseFold;
use unicode_normalization::UnicodeNormalization;

use super::source::{PageSourceError, ParsedMarkdown, parse_markdown};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentNameConflictEvidence {
    pub path: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentNameConflict {
    pub parent_path: Option<String>,
    pub conflicts: Vec<DocumentNameConflictEvidence>,
}

pub fn display_name_key(value: &str) -> String {
    let normalized = value.nfkc().case_fold().nfkc().collect::<String>();
    normalized.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn repo_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn is_readme(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("README.md"))
}

pub fn logical_document_parent(path: &str) -> Option<String> {
    let path = Path::new(path.trim_matches('/'));
    if is_readme(path) {
        let folder = path.parent()?;
        if folder.as_os_str().is_empty() {
            return None;
        }
        return Some(repo_path(folder.parent().unwrap_or_else(|| Path::new(""))));
    }
    Some(repo_path(path.parent().unwrap_or_else(|| Path::new(""))))
}

pub fn is_user_document(path: &str) -> bool {
    logical_document_parent(path).is_some()
        && !Path::new(path.trim_matches('/'))
            .parent()
            .into_iter()
            .flat_map(Path::components)
            .any(|component| component.as_os_str().to_string_lossy().starts_with('.'))
}

fn title_for_markdown(path: &Path, fallback: String) -> String {
    let Ok(content) = fs::read_to_string(path) else {
        return fallback;
    };
    match parse_markdown(&content, "") {
        ParsedMarkdown::Valid(meta, _) if meta.title_present => meta.title,
        _ => fallback,
    }
}

fn direct_document_siblings(
    space: &Path,
    parent: Option<&str>,
    current: &str,
) -> Result<Vec<DocumentNameConflictEvidence>, PageSourceError> {
    let directory = space.join(parent.unwrap_or("").trim_matches('/'));
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let mut siblings = Vec::new();
    let entries = fs::read_dir(&directory).map_err(PageSourceError::Io)?;
    for item in entries.filter_map(Result::ok) {
        let path = item.path();
        let name = item.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let rel = path.strip_prefix(space).unwrap_or(&path);
        if path.is_dir() {
            let Some(readme) = fs::read_dir(&path)
                .ok()
                .into_iter()
                .flatten()
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .find(|candidate| candidate.is_file() && is_readme(candidate))
            else {
                continue;
            };
            if repo_path(readme.strip_prefix(space).unwrap_or(&readme)) == current {
                continue;
            }
            siblings.push(DocumentNameConflictEvidence {
                path: repo_path(readme.strip_prefix(space).unwrap_or(&readme)),
                title: title_for_markdown(&readme, name),
            });
        } else if path.is_file()
            && path.extension().and_then(|extension| extension.to_str()) == Some("md")
            && !is_readme(&path)
        {
            if repo_path(rel) == current {
                continue;
            }
            let fallback = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("Untitled")
                .replace(['-', '_'], " ");
            siblings.push(DocumentNameConflictEvidence {
                path: repo_path(rel),
                title: title_for_markdown(&path, fallback),
            });
        }
    }
    Ok(siblings)
}

pub fn document_name_conflict(
    space: &Path,
    path: &str,
    title: &str,
) -> Result<Option<DocumentNameConflict>, PageSourceError> {
    if !is_user_document(path) {
        return Ok(None);
    }
    let parent = logical_document_parent(path);
    let key = display_name_key(title);
    let current = path.trim_matches('/').replace('\\', "/");
    let conflicts = direct_document_siblings(space, parent.as_deref(), &current)?
        .into_iter()
        .filter(|sibling| display_name_key(&sibling.title) == key)
        .collect::<Vec<_>>();
    Ok((!conflicts.is_empty()).then_some(DocumentNameConflict {
        parent_path: parent.filter(|value| !value.is_empty()),
        conflicts,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unicode_casefold_and_directory_heads_share_document_scope() {
        assert_eq!(
            display_name_key("  Quarterly\u{2003}Review  "),
            display_name_key("ＱＵＡＲＴＥＲＬＹ review")
        );
        assert_eq!(display_name_key("Straße"), display_name_key("STRASSE"));
        assert_eq!(logical_document_parent("docs/note.md"), Some("docs".into()));
        assert_eq!(
            logical_document_parent("docs/topic/README.md"),
            Some("docs".into())
        );
        assert_eq!(logical_document_parent("README.md"), None);
    }

    #[test]
    fn conflicting_titles_detected_without_hidden_sources() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("one.md"), "---\ntitle: Shared\n---\nOne").unwrap();
        fs::write(temp.path().join("two.md"), "---\ntitle: shared\n---\nTwo").unwrap();
        let conflict = document_name_conflict(temp.path(), "one.md", "Shared")
            .unwrap()
            .unwrap();
        assert_eq!(conflict.conflicts[0].path, "two.md");
        fs::create_dir(temp.path().join(".templates")).unwrap();
        fs::write(
            temp.path().join(".templates/hidden.md"),
            "---\ntitle: Shared\n---\nHidden",
        )
        .unwrap();
        assert!(
            document_name_conflict(temp.path(), ".templates/hidden.md", "Shared")
                .unwrap()
                .is_none()
        );
    }
}

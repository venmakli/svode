use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use unicode_casefold::UnicodeCaseFold;
use unicode_normalization::UnicodeNormalization;

use super::error::PageError;
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

static DOCUMENT_NAME_LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();

/// Serialize name allocation and title-driven renames within one Space.
pub fn with_document_name_lock<T, E: From<PageError>>(
    space: &str,
    operation: impl FnOnce() -> Result<T, E>,
) -> Result<T, E> {
    let lock = {
        let locks = DOCUMENT_NAME_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
        let mut locks = locks
            .lock()
            .map_err(|_| PageError::General("document name lock is poisoned".into()))?;
        locks
            .entry(space.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    let _guard = lock
        .lock()
        .map_err(|_| PageError::General("document name lock is poisoned".into()))?;
    operation()
}

pub fn ensure_document_name_available(
    space: &Path,
    path: &str,
    title: &str,
) -> Result<(), PageError> {
    if let Some(conflict) = document_name_conflict(space, path, title)? {
        return Err(PageError::DocumentNameConflict(conflict));
    }
    Ok(())
}

pub fn allocate_document_title(
    space: &Path,
    path_for_scope: &str,
    requested: &str,
) -> Result<String, PageError> {
    if !is_user_document(path_for_scope)
        || document_name_conflict(space, path_for_scope, requested)?.is_none()
    {
        return Ok(requested.to_string());
    }
    for index in 2..=10_000 {
        let candidate = format!("{requested} {index}");
        if document_name_conflict(space, path_for_scope, &candidate)?.is_none() {
            return Ok(candidate);
        }
    }
    Err(PageError::General(
        "could not allocate a unique document title".into(),
    ))
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

/// Legacy ASCII projection used only by hidden template source slugs.
fn transliterate(input: &str) -> String {
    let mut result = String::with_capacity(input.len() * 2);
    for c in input.chars() {
        let mapped = match c {
            'а' | 'А' => "a",
            'б' | 'Б' => "b",
            'в' | 'В' => "v",
            'г' | 'Г' => "g",
            'д' | 'Д' => "d",
            'е' | 'Е' => "e",
            'ё' | 'Ё' => "yo",
            'ж' | 'Ж' => "zh",
            'з' | 'З' => "z",
            'и' | 'И' => "i",
            'й' | 'Й' => "j",
            'к' | 'К' => "k",
            'л' | 'Л' => "l",
            'м' | 'М' => "m",
            'н' | 'Н' => "n",
            'о' | 'О' => "o",
            'п' | 'П' => "p",
            'р' | 'Р' => "r",
            'с' | 'С' => "s",
            'т' | 'Т' => "t",
            'у' | 'У' => "u",
            'ф' | 'Ф' => "f",
            'х' | 'Х' => "h",
            'ц' | 'Ц' => "ts",
            'ч' | 'Ч' => "ch",
            'ш' | 'Ш' => "sh",
            'щ' | 'Щ' => "shch",
            'ъ' | 'Ъ' => "",
            'ы' | 'Ы' => "y",
            'ь' | 'Ь' => "",
            'э' | 'Э' => "e",
            'ю' | 'Ю' => "yu",
            'я' | 'Я' => "ya",
            _ => {
                result.push(c);
                continue;
            }
        };
        result.push_str(mapped);
    }
    result
}

const MAX_SLUG_LENGTH: usize = 60;

/// Generate a legacy ASCII template source slug from a title.
pub fn slugify(title: &str) -> String {
    // Transliterate Cyrillic → Latin, then lowercase
    let transliterated = transliterate(title);
    let slug: String = transliterated
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c
            } else if c == ' ' || c == '_' || c == '-' {
                '-'
            } else {
                '\0'
            }
        })
        .filter(|&c| c != '\0')
        .collect();

    // Collapse multiple hyphens
    let mut result = String::with_capacity(slug.len());
    let mut prev_hyphen = false;
    for c in slug.chars() {
        if c == '-' {
            if !prev_hyphen {
                result.push(c);
            }
            prev_hyphen = true;
        } else {
            result.push(c);
            prev_hyphen = false;
        }
    }
    let trimmed = result.trim_matches('-');

    // Fallback for empty slugs (e.g. CJK-only input)
    if trimmed.is_empty() {
        return "untitled".to_string();
    }

    // Truncate to MAX_SLUG_LENGTH on word boundary
    if trimmed.len() <= MAX_SLUG_LENGTH {
        return trimmed.to_string();
    }

    let truncated = &trimmed[..MAX_SLUG_LENGTH];
    match truncated.rfind('-') {
        Some(pos) => truncated[..pos].to_string(),
        None => truncated.to_string(),
    }
}

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use unicode_casefold::UnicodeCaseFold;
use unicode_normalization::UnicodeNormalization;

use super::error::PageError;
use super::membership::ChildSpaceRoots;
use super::source::{FrontmatterHead, PageSourceError, read_frontmatter_head};

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

/// Frontmatter facts of one document as its single head read gives them;
/// `title` is `None` when the frontmatter has no title or does not read.
#[derive(Debug, Clone, Default)]
pub struct DocumentHead {
    pub title: Option<String>,
    pub icon: Option<String>,
    pub description: Option<String>,
}

impl DocumentHead {
    /// Read the frontmatter head of the Markdown file at `path`.
    pub fn read(path: &Path) -> Self {
        match read_frontmatter_head(path) {
            FrontmatterHead::Valid(meta) => Self {
                title: meta.title_present.then_some(meta.title),
                icon: meta.icon,
                description: meta.description,
            },
            FrontmatterHead::Missing | FrontmatterHead::Unreadable => Self::default(),
        }
    }
}

/// One document of a naming scope with the title the naming rule compares.
#[derive(Debug)]
struct ScopeDocument {
    path: String,
    title: String,
    head: DocumentHead,
}

/// The documents that share one naming scope (logical parent), each read
/// once: the leaf Markdown files of the directory and the README of each
/// of its folders. Hidden entries and the folders of registered child
/// Spaces are not part of it. A document without a title is named by its
/// file stem with `-` and `_` as spaces, a folder head by its folder name.
#[derive(Debug, Default)]
struct DocumentScope {
    parent: Option<String>,
    documents: Vec<ScopeDocument>,
    by_path: HashMap<String, usize>,
    by_key: HashMap<String, Vec<usize>>,
}

impl DocumentScope {
    fn read(
        space: &Path,
        parent: &str,
        child_spaces: &ChildSpaceRoots,
    ) -> Result<Self, PageSourceError> {
        let mut scope = Self {
            parent: Some(parent.to_string()).filter(|parent| !parent.is_empty()),
            ..Self::default()
        };
        let directory = space.join(parent);
        if !directory.is_dir() {
            return Ok(scope);
        }
        let entries = fs::read_dir(&directory).map_err(PageSourceError::Io)?;
        for item in entries.filter_map(Result::ok) {
            let path = item.path();
            let name = item.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let rel = repo_path(path.strip_prefix(space).unwrap_or(&path));
            if path.is_dir() {
                if child_spaces.owner_of(&rel).is_some() {
                    continue;
                }
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
                scope.push(
                    repo_path(readme.strip_prefix(space).unwrap_or(&readme)),
                    DocumentHead::read(&readme),
                    name,
                );
            } else if path.is_file()
                && path.extension().and_then(|extension| extension.to_str()) == Some("md")
                && !is_readme(&path)
            {
                let fallback = path
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .unwrap_or("Untitled")
                    .replace(['-', '_'], " ");
                scope.push(rel, DocumentHead::read(&path), fallback);
            }
        }
        Ok(scope)
    }

    fn push(&mut self, path: String, head: DocumentHead, fallback: String) {
        let title = head.title.clone().unwrap_or(fallback);
        let index = self.documents.len();
        self.by_key
            .entry(display_name_key(&title))
            .or_default()
            .push(index);
        self.by_path.insert(path.clone(), index);
        self.documents.push(ScopeDocument { path, title, head });
    }

    fn document(&self, path: &str) -> Option<&ScopeDocument> {
        self.by_path.get(path).map(|index| &self.documents[*index])
    }

    /// The other documents of the scope that `title` names alike.
    fn conflict(&self, current: &str, title: &str) -> Option<DocumentNameConflict> {
        let conflicts = self
            .by_key
            .get(&display_name_key(title))
            .into_iter()
            .flatten()
            .map(|index| &self.documents[*index])
            .filter(|document| document.path != current)
            .map(|document| DocumentNameConflictEvidence {
                path: document.path.clone(),
                title: document.title.clone(),
            })
            .collect::<Vec<_>>();
        (!conflicts.is_empty()).then(|| DocumentNameConflict {
            parent_path: self.parent.clone(),
            conflicts,
        })
    }
}

/// The naming scopes of one Space, each read on first use and kept, so a
/// listing or a batch of reads asks any number of conflicts for one read of
/// every document per scope. Name conflict marks of listings and reads and
/// the name check of writes all come from it.
pub struct DocumentNames {
    space: PathBuf,
    child_spaces: ChildSpaceRoots,
    scopes: HashMap<String, DocumentScope>,
}

impl DocumentNames {
    /// Naming scopes of the Space at `space`. A config that does not read
    /// registers no child Space here, as the tree that shows the Space
    /// treats it; writes refuse such a config by their own membership check.
    pub fn new(space: &Path) -> Self {
        Self {
            space: space.to_path_buf(),
            child_spaces: ChildSpaceRoots::read(space).unwrap_or_default(),
            scopes: HashMap::new(),
        }
    }

    fn scope(&mut self, parent: &str) -> Result<&DocumentScope, PageSourceError> {
        if !self.scopes.contains_key(parent) {
            let scope = DocumentScope::read(&self.space, parent, &self.child_spaces)?;
            self.scopes.insert(parent.to_string(), scope);
        }
        Ok(&self.scopes[parent])
    }

    fn scope_of(
        &mut self,
        path: &str,
    ) -> Result<Option<(&DocumentScope, String)>, PageSourceError> {
        if !is_user_document(path) {
            return Ok(None);
        }
        let current = path.trim_matches('/').replace('\\', "/");
        let parent = logical_document_parent(&current).unwrap_or_default();
        Ok(Some((self.scope(&parent)?, current)))
    }

    /// The conflict that the document at `path` would have under `title`.
    pub fn conflict_for(
        &mut self,
        path: &str,
        title: &str,
    ) -> Result<Option<DocumentNameConflict>, PageSourceError> {
        Ok(self
            .scope_of(path)?
            .and_then(|(scope, current)| scope.conflict(&current, title)))
    }

    /// The conflict of the existing document at `path` under the title the
    /// naming rule gives it, so two documents mark each other alike;
    /// `fallback_title` serves a document its scope does not hold.
    pub fn conflict_of(
        &mut self,
        path: &str,
        fallback_title: &str,
    ) -> Result<Option<DocumentNameConflict>, PageSourceError> {
        Ok(self.scope_of(path)?.and_then(|(scope, current)| {
            let title = scope
                .document(&current)
                .map_or(fallback_title, |document| document.title.as_str());
            scope.conflict(&current, title)
        }))
    }

    /// Frontmatter head of the document at `path` from its scope's read,
    /// or its own read when the scope does not hold it.
    pub fn head(&mut self, path: &str) -> Result<DocumentHead, PageSourceError> {
        let held = self.scope_of(path)?.and_then(|(scope, current)| {
            scope
                .document(&current)
                .map(|document| document.head.clone())
        });
        Ok(held.unwrap_or_else(|| DocumentHead::read(&self.space.join(path))))
    }
}

pub fn document_name_conflict(
    space: &Path,
    path: &str,
    title: &str,
) -> Result<Option<DocumentNameConflict>, PageSourceError> {
    DocumentNames::new(space).conflict_for(path, title)
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

/// `requested`, or the first of "`requested` 2", "`requested` 3"… free in
/// the naming scope of `path_for_scope`; every candidate is checked against
/// one read of the scope.
pub fn allocate_document_title(
    space: &Path,
    path_for_scope: &str,
    requested: &str,
) -> Result<String, PageError> {
    let mut names = DocumentNames::new(space);
    let Some((scope, current)) = names.scope_of(path_for_scope)? else {
        return Ok(requested.to_string());
    };
    if scope.conflict(&current, requested).is_none() {
        return Ok(requested.to_string());
    }
    for index in 2..=10_000 {
        let candidate = format!("{requested} {index}");
        if scope.conflict(&current, &candidate).is_none() {
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

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use unicode_casefold::UnicodeCaseFold;
use unicode_normalization::UnicodeNormalization;

use crate::error::AppError;
use crate::files::frontmatter;

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

static DOCUMENT_NAME_LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();

pub(crate) fn display_name_key(value: &str) -> String {
    let normalized = value.nfkc().case_fold().nfkc().collect::<String>();
    normalized.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(crate) fn with_document_name_lock<T>(
    space: &str,
    operation: impl FnOnce() -> Result<T, AppError>,
) -> Result<T, AppError> {
    let lock = {
        let locks = DOCUMENT_NAME_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
        let mut locks = locks
            .lock()
            .map_err(|_| AppError::General("document name lock is poisoned".to_string()))?;
        locks
            .entry(space.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    let _guard = lock
        .lock()
        .map_err(|_| AppError::General("document name lock is poisoned".to_string()))?;
    operation()
}

fn repo_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn is_readme(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("README.md"))
}

pub(crate) fn logical_document_parent(path: &str) -> Option<String> {
    let path = Path::new(path.trim_matches('/'));
    if is_readme(path) {
        let folder = path.parent()?;
        if folder.as_os_str().is_empty() {
            return None;
        }
        let parent = folder.parent().unwrap_or_else(|| Path::new(""));
        return Some(repo_path(parent));
    }
    Some(repo_path(path.parent().unwrap_or_else(|| Path::new(""))))
}

fn has_hidden_storage_parent(path: &str) -> bool {
    Path::new(path.trim_matches('/'))
        .parent()
        .into_iter()
        .flat_map(Path::components)
        .any(|component| component.as_os_str().to_string_lossy().starts_with('.'))
}

pub(crate) fn is_user_document(path: &str) -> bool {
    logical_document_parent(path).is_some() && !has_hidden_storage_parent(path)
}

fn title_for_markdown(path: &Path, fallback: String) -> String {
    let Ok(content) = fs::read_to_string(path) else {
        return fallback;
    };
    frontmatter::try_parse(&content)
        .ok()
        .flatten()
        .filter(|(meta, _)| meta.frontmatter_keys.title)
        .map(|(meta, _)| meta.title)
        .unwrap_or(fallback)
}

fn direct_document_siblings(
    space: &Path,
    parent_path: Option<&str>,
) -> Result<Vec<DocumentNameConflictEvidence>, AppError> {
    let parent = parent_path.unwrap_or("").trim_matches('/');
    let directory = space.join(parent);
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let mut siblings = Vec::new();
    for item in fs::read_dir(&directory)?.filter_map(Result::ok) {
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
            siblings.push(DocumentNameConflictEvidence {
                path: repo_path(readme.strip_prefix(space).unwrap_or(&readme)),
                title: title_for_markdown(&readme, name),
            });
        } else if path.is_file()
            && path.extension().and_then(|extension| extension.to_str()) == Some("md")
            && !is_readme(&path)
        {
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

pub(crate) fn document_name_conflict(
    space: &Path,
    path: &str,
    title: &str,
) -> Result<Option<DocumentNameConflict>, AppError> {
    if !is_user_document(path) {
        return Ok(None);
    }
    let parent = logical_document_parent(path);
    let key = display_name_key(title);
    let current = path.trim_matches('/').replace('\\', "/");
    let conflicts = direct_document_siblings(space, parent.as_deref())?
        .into_iter()
        .filter(|sibling| sibling.path != current && display_name_key(&sibling.title) == key)
        .collect::<Vec<_>>();
    Ok((!conflicts.is_empty()).then_some(DocumentNameConflict {
        parent_path: parent.filter(|value| !value.is_empty()),
        conflicts,
    }))
}

pub(crate) fn ensure_document_name_available(
    space: &Path,
    path: &str,
    title: &str,
) -> Result<(), AppError> {
    if let Some(conflict) = document_name_conflict(space, path, title)? {
        return Err(AppError::DocumentNameConflict(conflict));
    }
    Ok(())
}

pub(crate) fn allocate_document_title(
    space: &Path,
    path_for_scope: &str,
    requested: &str,
) -> Result<String, AppError> {
    if !is_user_document(path_for_scope) {
        return Ok(requested.to_string());
    }
    if document_name_conflict(space, path_for_scope, requested)?.is_none() {
        return Ok(requested.to_string());
    }
    for index in 2..=10_000 {
        let candidate = format!("{requested} {index}");
        if document_name_conflict(space, path_for_scope, &candidate)?.is_none() {
            return Ok(candidate);
        }
    }
    Err(AppError::General(
        "could not allocate a unique document title".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_document(space: &Path, path: &str, title: &str) {
        let abs = space.join(path);
        if let Some(parent) = abs.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let meta = crate::files::entry::EntryMeta::new_persisted(title.to_string());
        fs::write(abs, frontmatter::serialize(&meta, "")).unwrap();
    }

    #[test]
    fn display_name_key_is_locale_independent_and_compatibility_normalized() {
        for equivalent in [
            "  Quarterly\u{2003}Review  ",
            "quarterly review",
            "ＱＵＡＲＴＥＲＬＹ REVIEW",
        ] {
            assert_eq!(display_name_key(equivalent), "quarterly review");
        }
        assert_eq!(display_name_key("Straße"), display_name_key("STRASSE"));
        assert_eq!(display_name_key("oﬃce"), display_name_key("OFFICE"));
        assert_ne!(display_name_key("Resume"), display_name_key("Résumé"));
    }

    #[test]
    fn logical_parent_places_leaf_and_folder_document_in_the_same_scope() {
        assert_eq!(logical_document_parent("docs/note.md"), Some("docs".into()));
        assert_eq!(
            logical_document_parent("docs/topic/README.md"),
            Some("docs".into())
        );
        assert_eq!(logical_document_parent("README.md"), None);
    }

    #[test]
    fn home_is_excluded_but_collection_heads_and_rows_share_document_scopes() {
        let tmp = TempDir::new().unwrap();
        write_document(tmp.path(), "README.md", "Shared");
        write_document(tmp.path(), "shared.md", "Shared");
        assert!(
            document_name_conflict(tmp.path(), "shared.md", "Shared")
                .unwrap()
                .is_none()
        );

        fs::create_dir_all(tmp.path().join("collection")).unwrap();
        fs::write(tmp.path().join("collection/schema.yaml"), "name: Test\n").unwrap();
        write_document(tmp.path(), "collection/README.md", "Shared");
        assert!(
            document_name_conflict(tmp.path(), "collection/README.md", "Shared")
                .unwrap()
                .is_some()
        );

        write_document(tmp.path(), "collection/row-one.md", "Row");
        write_document(tmp.path(), "collection/row-two.md", " row ");
        assert!(
            document_name_conflict(tmp.path(), "collection/row-one.md", "Row")
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn hidden_template_sources_stay_outside_the_user_document_namespace() {
        let tmp = TempDir::new().unwrap();
        write_document(tmp.path(), ".templates/one.md", "Shared");
        write_document(tmp.path(), ".templates/two.md", "shared");

        assert!(
            document_name_conflict(tmp.path(), ".templates/one.md", "Shared")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn external_duplicates_project_on_both_rows_and_clear_after_recovery() {
        let tmp = TempDir::new().unwrap();
        write_document(tmp.path(), "one.md", "Shared");
        write_document(tmp.path(), "two.md", "shared");

        let duplicated =
            crate::files::tree::list_tree_children(tmp.path().to_string_lossy().as_ref(), None)
                .unwrap();
        assert!(duplicated.iter().all(|node| node.name_conflict.is_some()));

        crate::files::entry::update_field(
            tmp.path().to_string_lossy().as_ref(),
            None,
            "two.md",
            "title",
            serde_json::Value::String("Recovered".to_string()),
        )
        .unwrap();
        let recovered =
            crate::files::tree::list_tree_children(tmp.path().to_string_lossy().as_ref(), None)
                .unwrap();
        assert!(recovered.iter().all(|node| node.name_conflict.is_none()));
    }

    #[test]
    fn external_collection_duplicates_project_on_rows() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join("collection")).unwrap();
        fs::write(tmp.path().join("collection/schema.yaml"), "name: Test\n").unwrap();
        write_document(tmp.path(), "collection/one.md", "Shared");
        write_document(tmp.path(), "collection/two.md", "shared");

        let duplicated = crate::files::tree::list_tree_children(
            tmp.path().to_string_lossy().as_ref(),
            Some("collection"),
        )
        .unwrap();
        assert!(duplicated.iter().all(|node| node.name_conflict.is_some()));
    }
}

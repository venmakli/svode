use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::git::path::{RootMode, normalize_repo_relative};

use super::CollectionError;
use super::engine::TEMPLATES_DIR;
use super::model::CollectionSchema;
use super::schema_validation::{normalize_schema, validate_schema};

pub fn read_schema_at(path: &Path) -> Result<CollectionSchema, CollectionError> {
    let raw = fs::read_to_string(path)?;
    let mut schema: CollectionSchema = serde_norway::from_str(&raw).map_err(|error| {
        CollectionError::Schema(format!("{}: invalid schema YAML: {error}", path.display()))
    })?;
    normalize_schema(&mut schema);
    validate_schema(&schema)
        .map_err(|error| CollectionError::Schema(format!("{}: {error}", path.display())))?;
    Ok(schema)
}

/// Schema of the Collection that the Page at `file_path` is an item of.
pub fn resolve_collection_schema_result(
    space: &Path,
    file_path: &str,
) -> Result<Option<(CollectionSchema, PathBuf)>, CollectionError> {
    let Some((schema, root)) = resolve_collection_schema_by_location(space, file_path)? else {
        return Ok(None);
    };
    let member = schema.nested_items || is_direct_collection_path(&root, file_path);
    Ok(member.then_some((schema, root)))
}

/// Schema of the Collection whose folder contains `file_path`, whether or not
/// the Page there is one of its items.
pub fn resolve_collection_schema_by_location(
    space: &Path,
    file_path: &str,
) -> Result<Option<(CollectionSchema, PathBuf)>, CollectionError> {
    let Some(root) = find_collection_root_by_location(space, file_path) else {
        return Ok(None);
    };
    let schema = read_schema_at(&space.join(&root).join("schema.yaml"))?;
    Ok(Some((schema, root)))
}

/// Root of the Collection that the Page at `file_path` is an item of: the
/// nearest `schema.yaml` above it, when the Page is a direct child of that
/// root or the schema sets `nested_items`.
pub fn find_collection_root(space: &Path, file_path: &str) -> Option<PathBuf> {
    let root = find_collection_root_by_location(space, file_path)?;
    if is_direct_collection_path(&root, file_path) {
        return Some(root);
    }
    // An unreadable schema keeps the Page in its Collection, so the schema
    // read of the caller reports the error instead of a silent standalone Page.
    read_schema_at(&space.join(&root).join("schema.yaml"))
        .map_or(true, |schema| schema.nested_items)
        .then_some(root)
}

/// Root of the nearest `schema.yaml` above `file_path`; the README of a
/// folder searches from the folder's parent.
pub fn find_collection_root_by_location(space: &Path, file_path: &str) -> Option<PathBuf> {
    let rel = normalize_rel_path(file_path);
    let rel_path = Path::new(&rel);
    let parent = rel_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .map(Path::to_path_buf);
    let mut dir = if is_readme(rel_path) {
        let owner_dir = parent?;
        owner_dir
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .map(Path::to_path_buf)
            .unwrap_or_default()
    } else {
        parent.unwrap_or_default()
    };
    loop {
        if space.join(&dir).join("schema.yaml").is_file() {
            return Some(dir);
        }
        if dir.as_os_str().is_empty() {
            break;
        }
        dir = dir
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .map(Path::to_path_buf)
            .unwrap_or_default();
    }
    None
}

/// `<root>/<name>.md` or `<root>/<name>/README.md`; the Collection's own
/// `.templates/` and `.routines/` sources keep its schema at any depth.
fn is_direct_collection_path(root: &Path, file_path: &str) -> bool {
    let rel = normalize_rel_path(file_path);
    let Ok(inner) = Path::new(&rel).strip_prefix(root) else {
        return false;
    };
    let parts = inner
        .components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part),
            _ => None,
        })
        .collect::<Vec<_>>();
    match parts.as_slice() {
        [first, ..] if *first == TEMPLATES_DIR || *first == ".routines" => true,
        [_] => true,
        [_, file] => is_readme(Path::new(file)),
        _ => false,
    }
}

fn is_readme(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("README.md"))
}

pub fn normalize_rel_path(path: &str) -> String {
    normalize_repo_relative(path, RootMode::Allow).unwrap_or_else(|_| {
        path.trim_matches('/')
            .replace('\\', "/")
            .trim_start_matches("./")
            .to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nearest_valid_schema_and_owner_readme_keep_existing_membership() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("tasks/nested")).unwrap();
        fs::write(root.join("schema.yaml"), "columns: []\n").unwrap();
        fs::write(
            root.join("tasks/schema.yaml"),
            "nested_items: true\ncolumns: []\n",
        )
        .unwrap();
        assert_eq!(
            resolve_collection_schema_result(root, "tasks/nested/item.md")
                .unwrap()
                .unwrap()
                .1,
            PathBuf::from("tasks")
        );
        assert_eq!(
            resolve_collection_schema_result(root, "tasks/README.md")
                .unwrap()
                .unwrap()
                .1,
            PathBuf::new()
        );
        fs::write(root.join("tasks/schema.yaml"), "columns: [broken\n").unwrap();
        assert!(resolve_collection_schema_result(root, "tasks/nested/item.md").is_err());
    }

    #[test]
    fn deep_pages_are_items_only_with_nested_items_while_location_keeps_the_root() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("tasks")).unwrap();
        fs::write(root.join("tasks/schema.yaml"), "columns: []\n").unwrap();
        for path in [
            "tasks/a.md",
            "tasks/b/README.md",
            "tasks/.templates/t.md",
            "tasks/.templates/folder/README.md",
            "tasks/.routines/daily.md",
        ] {
            assert_eq!(
                find_collection_root(root, path),
                Some("tasks".into()),
                "{path}"
            );
        }
        for path in ["tasks/b/note.md", "tasks/b/sub/README.md", "tasks/d/e.md"] {
            assert_eq!(find_collection_root(root, path), None, "{path}");
            assert!(
                resolve_collection_schema_result(root, path)
                    .unwrap()
                    .is_none()
            );
            assert_eq!(
                resolve_collection_schema_by_location(root, path)
                    .unwrap()
                    .map(|(_, root)| root),
                Some("tasks".into()),
                "{path}"
            );
        }
        fs::write(
            root.join("tasks/schema.yaml"),
            "nested_items: true\ncolumns: []\n",
        )
        .unwrap();
        assert_eq!(
            find_collection_root(root, "tasks/b/sub/README.md"),
            Some("tasks".into())
        );
    }
}

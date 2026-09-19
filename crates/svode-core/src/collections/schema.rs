use std::fs;
use std::path::{Path, PathBuf};

use crate::git::path::{RootMode, normalize_repo_relative};

use super::CollectionError;
use super::model::CollectionSchema;
use super::schema_validation::{normalize_schema, validate_schema};

pub fn read_schema_at(path: &Path) -> Result<CollectionSchema, CollectionError> {
    let raw = fs::read_to_string(path)?;
    let mut schema: CollectionSchema = serde_yml::from_str(&raw).map_err(|error| {
        CollectionError::Schema(format!("{}: invalid schema YAML: {error}", path.display()))
    })?;
    normalize_schema(&mut schema);
    validate_schema(&schema)
        .map_err(|error| CollectionError::Schema(format!("{}: {error}", path.display())))?;
    Ok(schema)
}

pub fn resolve_collection_schema_result(
    space: &Path,
    file_path: &str,
) -> Result<Option<(CollectionSchema, PathBuf)>, CollectionError> {
    let Some(root) = find_collection_root(space, file_path) else {
        return Ok(None);
    };
    let schema = read_schema_at(&space.join(&root).join("schema.yaml"))?;
    Ok(Some((schema, root)))
}

pub fn find_collection_root(space: &Path, file_path: &str) -> Option<PathBuf> {
    let rel = normalize_rel_path(file_path);
    let rel_path = Path::new(&rel);
    let parent = rel_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .map(Path::to_path_buf);
    let mut dir = if rel_path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("README.md"))
    {
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
        fs::write(root.join("tasks/schema.yaml"), "columns: []\n").unwrap();
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
}

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use super::CollectionError;
use super::schema::{find_collection_root, normalize_rel_path};
use super::traversal::{collection_markdown_files, is_collection_traversal_ignored};
use crate::content_tree::child_folder_names;
use crate::content_tree::policy::TreeIgnorePolicy;
use crate::page::{ParsedMarkdown, parse_markdown};
use serde::Serialize;

const SCHEMA_FILE: &str = "schema.yaml";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionInfo {
    pub path: String,
    pub title: String,
    pub row_count: usize,
    pub nested: bool,
}

pub fn list_collections(space: &str) -> Result<Vec<CollectionInfo>, CollectionError> {
    let root = Path::new(space);
    let mut infos = Vec::new();
    let skip_dirs = child_folder_names(root);
    let policy = TreeIgnorePolicy::from_space_root(root);
    if root.join(SCHEMA_FILE).is_file() {
        infos.push(CollectionInfo {
            path: ".".to_string(),
            title: collection_title(
                root,
                root.file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("Collection"),
            ),
            row_count: collection_markdown_files(space, ".")?.len(),
            nested: false,
        });
    }
    collect_collections(root, root, &skip_dirs, &policy, &mut infos)?;
    infos.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(infos)
}

fn collect_collections(
    space: &Path,
    dir: &Path,
    skip_dirs: &HashSet<String>,
    policy: &TreeIgnorePolicy,
    out: &mut Vec<CollectionInfo>,
) -> Result<(), CollectionError> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();

        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() || !meta.is_dir() {
            continue;
        }

        if is_collection_traversal_ignored(space, &path, &meta, skip_dirs, policy) {
            continue;
        }

        if path.join(SCHEMA_FILE).is_file() {
            let rel = path
                .strip_prefix(space)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let title = collection_title(&path, &name);
            let row_count = collection_markdown_files(&space.to_string_lossy(), &rel)?.len();
            let nested =
                find_collection_root(space, &format!("{}/README.md", normalize_rel_path(&rel)))
                    .is_some();
            out.push(CollectionInfo {
                path: rel.clone(),
                title,
                row_count,
                nested,
            });
        }

        collect_collections(space, &path, skip_dirs, policy, out)?;
    }
    Ok(())
}

fn collection_title(collection_dir: &Path, fallback_name: &str) -> String {
    let readme = collection_dir.join("README.md");
    if let Ok(raw) = fs::read_to_string(readme) {
        if let ParsedMarkdown::Valid(meta, _) = parse_markdown(&raw, "README.md") {
            if !meta.title.trim().is_empty() {
                return meta.title;
            }
        }
    }
    fallback_name.replace(['-', '_'], " ")
}

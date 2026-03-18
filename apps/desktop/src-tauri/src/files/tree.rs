use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

use crate::error::AppError;
use crate::files::frontmatter;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    pub title: String,
    pub icon: Option<String>,
    pub has_changes: bool,
    pub children: Vec<TreeNode>,
}

/// Check if a directory entry should be skipped.
fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

/// Read title and icon from frontmatter. Falls back to filename without .md on error.
fn read_frontmatter_meta(abs_path: &Path) -> (String, Option<String>) {
    let fallback = abs_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let content = match fs::read_to_string(abs_path) {
        Ok(c) => c,
        Err(_) => return (fallback, None),
    };

    match frontmatter::parse(&content) {
        Ok((meta, _)) => (meta.title, meta.icon),
        Err(_) => (fallback, None),
    }
}

/// Build a file tree from a workspace directory.
pub fn build_tree(workspace: &str) -> Result<Vec<TreeNode>, AppError> {
    let root = Path::new(workspace);
    if !root.is_dir() {
        return Err(AppError::FileNotFound(workspace.to_string()));
    }
    read_dir_recursive(root, root)
}

fn read_dir_recursive(base: &Path, dir: &Path) -> Result<Vec<TreeNode>, AppError> {
    let mut nodes: Vec<TreeNode> = Vec::new();
    let mut entries: Vec<fs::DirEntry> = fs::read_dir(dir)?.filter_map(|e| e.ok()).collect();

    // Sort by name for consistent ordering
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();

        if is_hidden(&name) {
            continue;
        }

        let abs_path = entry.path();
        let rel_path = abs_path
            .strip_prefix(base)
            .unwrap_or(&abs_path)
            .to_string_lossy()
            .to_string();

        if abs_path.is_dir() {
            let readme_path = abs_path.join("readme.md");
            if !readme_path.is_file() {
                // Folder without readme.md → skip entirely
                continue;
            }

            let (title, icon) = read_frontmatter_meta(&readme_path);
            let readme_rel = format!("{rel_path}/readme.md");

            // Recurse and filter out readme.md from children
            let children: Vec<TreeNode> = read_dir_recursive(base, &abs_path)?
                .into_iter()
                .filter(|node| node.name.to_lowercase() != "readme.md")
                .collect();

            nodes.push(TreeNode {
                name,
                path: readme_rel,
                title,
                icon,
                has_changes: false,
                children,
            });
        } else if name.ends_with(".md") {
            let (title, icon) = read_frontmatter_meta(&abs_path);
            nodes.push(TreeNode {
                name,
                path: rel_path,
                title,
                icon,
                has_changes: false,
                children: vec![],
            });
        }
        // Non-.md files are ignored
    }

    Ok(nodes)
}

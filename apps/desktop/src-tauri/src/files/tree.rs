use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

use crate::error::AppError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum TreeNode {
    Page {
        name: String,
        path: String,
        has_changes: bool,
    },
    Category {
        name: String,
        path: String,
        children: Vec<TreeNode>,
    },
}

/// Check if a directory entry should be skipped.
fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

/// Build a file tree from a workspace directory.
/// `base` is the workspace root (absolute), `rel` is the current relative path.
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

        // Skip hidden directories/files (starting with '.')
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
            // Check if this folder has a readme.md → category
            let has_readme = abs_path.join("readme.md").is_file();

            if has_readme {
                let children = read_dir_recursive(base, &abs_path)?;
                // Filter out readme.md from children (it's the category's own page)
                let children: Vec<TreeNode> = children
                    .into_iter()
                    .filter(|node| {
                        !matches!(node, TreeNode::Page { name, .. } if name.to_lowercase() == "readme.md")
                    })
                    .collect();

                nodes.push(TreeNode::Category {
                    name,
                    path: rel_path,
                    children,
                });
            } else {
                // Regular directory — still recurse, treat as category without readme
                let children = read_dir_recursive(base, &abs_path)?;
                if !children.is_empty() {
                    nodes.push(TreeNode::Category {
                        name,
                        path: rel_path,
                        children,
                    });
                }
            }
        } else if name.ends_with(".md") {
            nodes.push(TreeNode::Page {
                name,
                path: rel_path,
                has_changes: false,
            });
        }
        // Non-.md files are ignored
    }

    Ok(nodes)
}

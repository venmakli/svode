use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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

/// Read order.json from workspace .combai directory.
/// Returns map: directory relative path -> ordered list of child names.
/// Key "." means workspace root.
pub fn read_order(workspace: &Path) -> HashMap<String, Vec<String>> {
    let order_path = workspace.join(".combai").join("order.json");
    match fs::read_to_string(&order_path) {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

/// Write order.json to workspace .combai directory.
pub fn write_order(
    workspace: &Path,
    order: &HashMap<String, Vec<String>>,
) -> Result<(), AppError> {
    let combai_dir = workspace.join(".combai");
    fs::create_dir_all(&combai_dir)?;
    let data = serde_json::to_string_pretty(order)?;
    fs::write(combai_dir.join("order.json"), data)?;
    Ok(())
}

/// Sort nodes by order.json for a given directory key.
/// Entries in order come first (in order), then remaining entries alphabetically.
fn apply_order(nodes: &mut Vec<TreeNode>, order_list: Option<&Vec<String>>) {
    let Some(ordered) = order_list else {
        // No custom order: sort alphabetically by name
        nodes.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        return;
    };

    // Build position map for O(1) lookup
    let positions: HashMap<&str, usize> = ordered
        .iter()
        .enumerate()
        .map(|(i, name)| (name.as_str(), i))
        .collect();

    nodes.sort_by(|a, b| {
        match (positions.get(a.name.as_str()), positions.get(b.name.as_str())) {
            (Some(pa), Some(pb)) => pa.cmp(pb),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });
}

/// Build a file tree from a workspace directory.
pub fn build_tree(workspace: &str) -> Result<Vec<TreeNode>, AppError> {
    let root = Path::new(workspace);
    if !root.is_dir() {
        return Err(AppError::FileNotFound(workspace.to_string()));
    }
    let order = read_order(root);
    read_dir_recursive(root, root, &order)
}

fn read_dir_recursive(
    base: &Path,
    dir: &Path,
    order: &HashMap<String, Vec<String>>,
) -> Result<Vec<TreeNode>, AppError> {
    let mut nodes: Vec<TreeNode> = Vec::new();
    let entries: Vec<fs::DirEntry> = fs::read_dir(dir)?.filter_map(|e| e.ok()).collect();

    // Compute the directory key for order lookup
    let dir_key = if dir == base {
        ".".to_string()
    } else {
        dir.strip_prefix(base)
            .unwrap_or(dir)
            .to_string_lossy()
            .to_string()
    };

    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();

        if is_hidden(&name) {
            continue;
        }

        let abs_path = entry.path();

        // Skip symlinks (CLI-generated infrastructure files)
        if let Ok(meta) = fs::symlink_metadata(&abs_path) {
            if meta.file_type().is_symlink() {
                continue;
            }
        }
        let rel_path = abs_path
            .strip_prefix(base)
            .unwrap_or(&abs_path)
            .to_string_lossy()
            .to_string();

        if abs_path.is_dir() {
            let readme_path = abs_path.join("readme.md");
            let has_readme = readme_path.is_file();

            let (title, icon) = if has_readme {
                read_frontmatter_meta(&readme_path)
            } else {
                (name.clone(), None)
            };

            // For document folders: path = "dir/readme.md"
            // For bare folders: path = "dir" (no .md extension)
            let node_path = if has_readme {
                format!("{rel_path}/readme.md")
            } else {
                rel_path.clone()
            };

            // Recurse and filter out readme.md from children
            let children: Vec<TreeNode> = read_dir_recursive(base, &abs_path, order)?
                .into_iter()
                .filter(|node| node.name.to_lowercase() != "readme.md")
                .collect();

            nodes.push(TreeNode {
                name,
                path: node_path,
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

    // Apply custom order for this directory
    apply_order(&mut nodes, order.get(&dir_key));

    Ok(nodes)
}

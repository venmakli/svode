use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use crate::error::AppError;
use crate::files::frontmatter;
use crate::space::config::read_space_config;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    pub title: String,
    pub icon: Option<String>,
    pub description: Option<String>,
    pub has_changes: bool,
    pub has_schema: bool,
    pub children: Vec<TreeNode>,
}

/// Check if a directory entry should be skipped.
fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

/// Find a readme.md file inside a directory (case-insensitive).
/// Returns the absolute path if found.
fn find_readme(dir: &Path) -> Option<std::path::PathBuf> {
    fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .find_map(|e| {
            let name = e.file_name();
            if name.to_string_lossy().eq_ignore_ascii_case("readme.md") && e.path().is_file() {
                Some(e.path())
            } else {
                None
            }
        })
}

/// Read sidebar metadata from frontmatter. Falls back to filename without .md on error.
fn read_frontmatter_meta(abs_path: &Path) -> (String, Option<String>, Option<String>) {
    let fallback = abs_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let content = match fs::read_to_string(abs_path) {
        Ok(c) => c,
        Err(_) => return (fallback, None, None),
    };

    match frontmatter::parse(&content) {
        Ok((meta, _)) => (meta.title, meta.icon, meta.description),
        Err(_) => (fallback, None, None),
    }
}

/// Read order.json from space .svode directory.
/// Returns map: directory relative path -> ordered list of child names.
/// Key "." means space root.
pub fn read_order(space: &Path) -> HashMap<String, Vec<String>> {
    let order_path = space.join(".svode").join("order.json");
    match fs::read_to_string(&order_path) {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

/// Write order.json to space .svode directory.
pub fn write_order(space: &Path, order: &HashMap<String, Vec<String>>) -> Result<(), AppError> {
    let svode_dir = space.join(".svode");
    fs::create_dir_all(&svode_dir)?;
    let data = serde_json::to_string_pretty(order)?;
    fs::write(svode_dir.join("order.json"), data)?;
    Ok(())
}

/// Sort nodes by order.json for a given directory key.
/// Entries in order come first (in order), then remaining entries alphabetically.
fn apply_order(nodes: &mut Vec<TreeNode>, order_list: Option<&Vec<String>>) {
    let Some(ordered) = order_list else {
        // No custom order: sort alphabetically by name
        nodes.sort_by_key(|a| a.name.to_lowercase());
        return;
    };

    // Build position map for O(1) lookup
    let positions: HashMap<&str, usize> = ordered
        .iter()
        .enumerate()
        .map(|(i, name)| (name.as_str(), i))
        .collect();

    nodes.sort_by(|a, b| {
        match (
            positions.get(a.name.as_str()),
            positions.get(b.name.as_str()),
        ) {
            (Some(pa), Some(pb)) => pa.cmp(pb),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });
}

/// Collect relative folder names of child spaces from config.
fn child_folder_names(space: &Path) -> HashSet<String> {
    let mut names = HashSet::new();
    if let Ok(cfg) = read_space_config(space) {
        if let Some(spaces) = cfg.spaces {
            for child in spaces {
                names.insert(child.path);
            }
        }
    }
    names
}

/// Build a file tree from a space directory.
pub fn build_tree(space: &str) -> Result<Vec<TreeNode>, AppError> {
    let root = Path::new(space);
    if !root.is_dir() {
        return Err(AppError::FileNotFound(space.to_string()));
    }
    let order = read_order(root);
    let skip_dirs = child_folder_names(root);
    read_dir_recursive(root, root, &order, &skip_dirs)
}

fn read_dir_recursive(
    base: &Path,
    dir: &Path,
    order: &HashMap<String, Vec<String>>,
    skip_dirs: &HashSet<String>,
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
            // Skip child space folders (registered in parent config)
            if skip_dirs.contains(&rel_path) {
                continue;
            }

            let has_schema = abs_path.join("schema.yaml").is_file();
            let readme = find_readme(&abs_path);

            let (title, icon, description) = if let Some(ref rp) = readme {
                let (t, i, d) = read_frontmatter_meta(rp);
                // If frontmatter missing, title falls back to "README" — use folder name instead
                if i.is_none() && t.eq_ignore_ascii_case("readme") {
                    (name.clone(), None, None)
                } else {
                    (t, i, d)
                }
            } else {
                (name.clone(), None, None)
            };

            // For document folders: path = "dir/README.md" (actual filename)
            // For bare folders: path = "dir" (no .md extension)
            let node_path = if let Some(ref rp) = readme {
                let readme_name = rp.file_name().unwrap_or_default().to_string_lossy();
                format!("{rel_path}/{readme_name}")
            } else {
                rel_path.clone()
            };

            // Recurse and filter out readme.md from children
            let children: Vec<TreeNode> = read_dir_recursive(base, &abs_path, order, skip_dirs)?
                .into_iter()
                .filter(|node| node.name.to_lowercase() != "readme.md")
                .collect();

            nodes.push(TreeNode {
                name,
                path: node_path,
                title,
                icon,
                description,
                has_changes: false,
                has_schema,
                children,
            });
        } else if name.ends_with(".md") {
            let (title, icon, description) = read_frontmatter_meta(&abs_path);
            nodes.push(TreeNode {
                name,
                path: rel_path,
                title,
                icon,
                description,
                has_changes: false,
                has_schema: false,
                children: vec![],
            });
        }
        // Non-.md files are ignored
    }

    // Apply custom order for this directory
    apply_order(&mut nodes, order.get(&dir_key));

    Ok(nodes)
}

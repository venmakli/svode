use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::time::Instant;

use crate::error::AppError;
use crate::files::frontmatter;
use crate::files::tree_policy::{TreeIgnorePolicy, TreePathKind};
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

/// Find a readme.md file inside a directory (case-insensitive).
/// Returns the absolute path if found.
fn find_readme(base: &Path, dir: &Path, policy: &TreeIgnorePolicy) -> Option<std::path::PathBuf> {
    fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .find_map(|e| {
            let name = e.file_name();
            let path = e.path();
            if !name.to_string_lossy().eq_ignore_ascii_case("readme.md") || !path.is_file() {
                return None;
            }
            let rel = path.strip_prefix(base).unwrap_or(&path);
            if policy.is_ignored_rel(rel, TreePathKind::File) {
                return None;
            }
            Some(path)
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

fn repo_path_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn path_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("<unknown>")
        .to_string()
}

fn count_tree_nodes(nodes: &[TreeNode]) -> usize {
    nodes
        .iter()
        .map(|node| 1 + count_tree_nodes(&node.children))
        .sum()
}

/// Read order.json from space .svode directory.
/// Returns map: directory relative path -> ordered list of child names.
/// Key "." means space root.
pub fn read_order(space: &Path) -> HashMap<String, Vec<String>> {
    let order_path = space.join(".svode").join("order.json");
    match fs::read_to_string(&order_path) {
        Ok(data) => serde_json::from_str::<HashMap<String, Vec<String>>>(&data)
            .unwrap_or_default()
            .into_iter()
            .map(|(key, value)| (key.replace('\\', "/"), value))
            .collect(),
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
                names.insert(child.path.replace('\\', "/"));
            }
        }
    }
    names
}

/// Build a file tree from a space directory.
pub fn build_tree(space: &str) -> Result<Vec<TreeNode>, AppError> {
    let started = Instant::now();
    let root = Path::new(space);
    let space_name = path_name(root);
    if !root.is_dir() {
        let error = AppError::FileNotFound(space.to_string());
        tracing::info!(
            target: "svode::perf",
            event = "tree.build_tree",
            space = %space_name,
            duration_ms = started.elapsed().as_millis() as u64,
            error_kind = error.kind(),
            "tree::build_tree failed"
        );
        return Err(error);
    }
    let result = (|| {
        let order = read_order(root);
        let skip_dirs = child_folder_names(root);
        let policy = TreeIgnorePolicy::from_space_root(root);
        read_dir_recursive(root, root, &order, &skip_dirs, &policy)
    })();
    let duration_ms = started.elapsed().as_millis() as u64;

    match &result {
        Ok(nodes) => tracing::info!(
            target: "svode::perf",
            event = "tree.build_tree",
            space = %space_name,
            node_count = count_tree_nodes(nodes),
            duration_ms,
            "tree::build_tree completed"
        ),
        Err(error) => tracing::info!(
            target: "svode::perf",
            event = "tree.build_tree",
            space = %space_name,
            duration_ms,
            error_kind = error.kind(),
            "tree::build_tree failed"
        ),
    }

    result
}

fn read_dir_recursive(
    base: &Path,
    dir: &Path,
    order: &HashMap<String, Vec<String>>,
    skip_dirs: &HashSet<String>,
    policy: &TreeIgnorePolicy,
) -> Result<Vec<TreeNode>, AppError> {
    let mut nodes: Vec<TreeNode> = Vec::new();
    let entries: Vec<fs::DirEntry> = fs::read_dir(dir)?.filter_map(|e| e.ok()).collect();

    // Compute the directory key for order lookup
    let dir_key = if dir == base {
        ".".to_string()
    } else {
        repo_path_string(dir.strip_prefix(base).unwrap_or(dir))
    };

    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();

        let abs_path = entry.path();

        // Skip symlinks (CLI-generated infrastructure files)
        let Ok(meta) = fs::symlink_metadata(&abs_path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }

        let rel_path = abs_path.strip_prefix(base).unwrap_or(&abs_path);
        let rel_path = repo_path_string(rel_path);
        let kind = if meta.is_dir() {
            TreePathKind::Directory
        } else if meta.is_file() {
            TreePathKind::File
        } else {
            TreePathKind::Unknown
        };

        if policy.is_ignored_rel(Path::new(&rel_path), kind) {
            continue;
        }

        if meta.is_dir() {
            // Skip child space folders (registered in parent config)
            if skip_dirs.contains(&rel_path) {
                continue;
            }

            let schema_path = abs_path.join("schema.yaml");
            let schema_rel = schema_path.strip_prefix(base).unwrap_or(&schema_path);
            let has_schema =
                schema_path.is_file() && !policy.is_ignored_rel(schema_rel, TreePathKind::File);
            let readme = find_readme(base, &abs_path, policy);

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
            let children: Vec<TreeNode> =
                read_dir_recursive(base, &abs_path, order, skip_dirs, policy)?
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
        } else if meta.is_file() && name.ends_with(".md") {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::config::write_space_config;
    use crate::space::types::{SpaceConfig, TreeSpaceConfig};
    use tempfile::TempDir;

    fn write_tree_config(tmp: &TempDir, exclude: Vec<&str>, include: Vec<&str>) {
        write_space_config(
            tmp.path(),
            &SpaceConfig {
                name: "Test".to_string(),
                description: String::new(),
                icon: "folder".to_string(),
                spaces: None,
                agent: None,
                defaults: None,
                git: None,
                assets: None,
                tree: Some(TreeSpaceConfig {
                    exclude: exclude.into_iter().map(ToString::to_string).collect(),
                    include: include.into_iter().map(ToString::to_string).collect(),
                    show_ignored_placeholders: false,
                }),
            },
        )
        .expect("write config");
    }

    fn child_names(nodes: &[TreeNode]) -> Vec<String> {
        nodes.iter().map(|node| node.name.clone()).collect()
    }

    #[test]
    fn read_order_normalizes_windows_directory_keys() {
        let tmp = TempDir::new().unwrap();
        let svode = tmp.path().join(".svode");
        fs::create_dir_all(&svode).unwrap();
        fs::write(
            svode.join("order.json"),
            r#"{"operations\\board":["task.md"],".":["operations"]}"#,
        )
        .unwrap();

        let order = read_order(tmp.path());

        assert!(order.contains_key("operations/board"));
        assert!(!order.contains_key("operations\\board"));
        assert_eq!(
            order.get("operations/board").unwrap(),
            &vec!["task.md".to_string()]
        );
    }

    #[test]
    fn build_tree_applies_system_excludes() {
        let tmp = TempDir::new().unwrap();
        for dirname in [".git", ".svode", ".assets", ".templates", ".cache"] {
            fs::create_dir_all(tmp.path().join(dirname)).unwrap();
            fs::write(tmp.path().join(dirname).join("README.md"), "hidden").unwrap();
        }
        fs::write(tmp.path().join("visible.md"), "visible").unwrap();

        let nodes = build_tree(tmp.path().to_str().unwrap()).expect("build tree");

        assert_eq!(child_names(&nodes), vec!["visible.md".to_string()]);
    }

    #[test]
    fn build_tree_lets_user_include_override_user_exclude() {
        let tmp = TempDir::new().unwrap();
        write_tree_config(&tmp, vec!["docs/*.md"], vec!["docs/keep.md"]);
        fs::create_dir_all(tmp.path().join("docs")).unwrap();
        fs::write(tmp.path().join("docs").join("drop.md"), "drop").unwrap();
        fs::write(tmp.path().join("docs").join("keep.md"), "keep").unwrap();

        let nodes = build_tree(tmp.path().to_str().unwrap()).expect("build tree");
        let docs = nodes.iter().find(|node| node.name == "docs").expect("docs");

        assert_eq!(child_names(&docs.children), vec!["keep.md".to_string()]);
    }

    #[test]
    fn build_tree_descends_to_user_included_paths_inside_excluded_parent() {
        let tmp = TempDir::new().unwrap();
        write_tree_config(&tmp, vec!["docs"], vec!["docs/guides/keep.md"]);
        fs::create_dir_all(tmp.path().join("docs").join("guides")).unwrap();
        fs::write(tmp.path().join("docs").join("drop.md"), "drop").unwrap();
        fs::write(
            tmp.path().join("docs").join("guides").join("drop.md"),
            "drop",
        )
        .unwrap();
        fs::write(
            tmp.path().join("docs").join("guides").join("keep.md"),
            "keep",
        )
        .unwrap();

        let nodes = build_tree(tmp.path().to_str().unwrap()).expect("build tree");
        let docs = nodes.iter().find(|node| node.name == "docs").expect("docs");
        let guides = docs
            .children
            .iter()
            .find(|node| node.name == "guides")
            .expect("guides");

        assert_eq!(child_names(&docs.children), vec!["guides".to_string()]);
        assert_eq!(child_names(&guides.children), vec!["keep.md".to_string()]);
    }

    #[test]
    fn build_tree_does_not_descend_into_ignored_dirs() {
        let tmp = TempDir::new().unwrap();
        write_tree_config(&tmp, vec!["node_modules"], vec![]);
        fs::create_dir_all(tmp.path().join("node_modules").join("pkg")).unwrap();
        fs::write(
            tmp.path()
                .join("node_modules")
                .join("pkg")
                .join("README.md"),
            "pkg",
        )
        .unwrap();
        fs::write(tmp.path().join("visible.md"), "visible").unwrap();

        let nodes = build_tree(tmp.path().to_str().unwrap()).expect("build tree");

        assert_eq!(child_names(&nodes), vec!["visible.md".to_string()]);
    }

    #[test]
    fn build_tree_matches_direct_relative_exclude_paths() {
        let tmp = TempDir::new().unwrap();
        write_tree_config(&tmp, vec!["src/generated"], vec![]);
        fs::create_dir_all(tmp.path().join("src").join("generated")).unwrap();
        fs::write(
            tmp.path().join("src").join("generated").join("client.md"),
            "generated",
        )
        .unwrap();
        fs::write(tmp.path().join("src").join("manual.md"), "manual").unwrap();

        let nodes = build_tree(tmp.path().to_str().unwrap()).expect("build tree");
        let src = nodes.iter().find(|node| node.name == "src").expect("src");

        assert_eq!(child_names(&src.children), vec!["manual.md".to_string()]);
    }
}

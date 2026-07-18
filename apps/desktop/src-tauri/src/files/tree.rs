use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::time::Instant;

use crate::error::AppError;
use crate::files::frontmatter;
use crate::files::tree_policy::{TreeIgnorePolicy, TreePathKind};
use crate::repo_path::{RootMode, normalize_repo_relative};
use crate::space::config::read_space_config;

const MAX_FRONTMATTER_HEAD_BYTES: usize = 64 * 1024;

pub(crate) fn has_direct_schema(directory: &Path) -> bool {
    directory.join("schema.yaml").is_file()
}

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TreeChildKind {
    Document,
    Folder,
    Collection,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TreeChildNode {
    pub name: String,
    pub path: String,
    pub title: String,
    pub icon: Option<String>,
    pub description: Option<String>,
    pub has_changes: bool,
    pub has_schema: bool,
    pub parent: Option<String>,
    #[serde(rename = "hasChildren")]
    pub has_children: bool,
    pub kind: TreeChildKind,
}

fn is_readme_name(name: &str) -> bool {
    name.eq_ignore_ascii_case("readme.md")
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
            if !is_readme_name(&name.to_string_lossy()) || !path.is_file() {
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
        Ok((meta, _)) => title_or_fallback(meta, fallback),
        Err(_) => (fallback, None, None),
    }
}

/// Lazy tree metadata reader: stop at frontmatter instead of loading markdown body.
fn read_frontmatter_meta_head(abs_path: &Path) -> (String, Option<String>, Option<String>) {
    let fallback = abs_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let Ok(file) = fs::File::open(abs_path) else {
        return (fallback, None, None);
    };
    let mut reader = BufReader::new(file);
    let mut head = String::new();
    let mut started = false;

    loop {
        let mut line = String::new();
        let Ok(bytes) = reader.read_line(&mut line) else {
            return (fallback, None, None);
        };
        if bytes == 0 {
            break;
        }

        if !started {
            if line.trim().is_empty() {
                head.push_str(&line);
                continue;
            }
            if line.trim_end() != "---" {
                return (fallback, None, None);
            }
            if head.len() + line.len() > MAX_FRONTMATTER_HEAD_BYTES {
                return (fallback, None, None);
            }
            started = true;
            head.push_str(&line);
            continue;
        }

        let is_closing = line.trim_end() == "---";
        if head.len() + line.len() > MAX_FRONTMATTER_HEAD_BYTES {
            return (fallback, None, None);
        }
        head.push_str(&line);
        if is_closing {
            match frontmatter::parse(&head) {
                Ok((meta, _)) => return title_or_fallback(meta, fallback),
                Err(_) => return (fallback, None, None),
            }
        }
    }

    (fallback, None, None)
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

fn title_or_fallback(
    meta: crate::files::EntryMeta,
    fallback: String,
) -> (String, Option<String>, Option<String>) {
    let title = if meta.frontmatter_keys.title {
        meta.title
    } else {
        fallback
    };
    (title, meta.icon, meta.description)
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
pub(crate) fn child_folder_names(space: &Path) -> HashSet<String> {
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
    let result = {
        let order = read_order(root);
        let skip_dirs = child_folder_names(root);
        let policy = TreeIgnorePolicy::from_space_root(root);
        read_dir_recursive(root, root, &order, &skip_dirs, &policy)
    };
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

pub fn list_tree_children(
    space: &str,
    parent_path: Option<&str>,
) -> Result<Vec<TreeChildNode>, AppError> {
    let root = Path::new(space);
    if !root.is_dir() {
        return Err(AppError::FileNotFound(space.to_string()));
    }

    let parent_rel = normalize_tree_parent_path(parent_path)?;
    let dir = if parent_rel == "." {
        root.to_path_buf()
    } else {
        root.join(&parent_rel)
    };
    if !dir.is_dir() {
        return Err(AppError::FileNotFound(parent_rel));
    }

    let policy = TreeIgnorePolicy::from_space_root(root);
    if parent_rel != "." && policy.is_ignored_rel(Path::new(&parent_rel), TreePathKind::Directory) {
        return Err(AppError::FileNotFound(parent_rel));
    }

    let order = read_order(root);
    let skip_dirs = child_folder_names(root);
    read_dir_direct(root, &dir, &parent_rel, &order, &skip_dirs, &policy)
}

pub(crate) fn normalize_tree_parent_path(parent_path: Option<&str>) -> Result<String, AppError> {
    let Some(raw) = parent_path.map(str::trim).filter(|path| !path.is_empty()) else {
        return Ok(".".to_string());
    };
    let normalized = normalize_repo_relative(raw, RootMode::Allow)?;
    if normalized == "." {
        return Ok(normalized);
    }

    let path = Path::new(&normalized);
    if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(is_readme_name)
    {
        let parent = path.parent().unwrap_or_else(|| Path::new(""));
        let parent = repo_path_string(parent);
        if parent.is_empty() {
            return Ok(".".to_string());
        }
        return Ok(parent);
    }

    Ok(normalized)
}

fn read_dir_direct(
    base: &Path,
    dir: &Path,
    parent_rel: &str,
    order: &HashMap<String, Vec<String>>,
    skip_dirs: &HashSet<String>,
    policy: &TreeIgnorePolicy,
) -> Result<Vec<TreeChildNode>, AppError> {
    let mut nodes: Vec<TreeChildNode> = Vec::new();
    let entries: Vec<fs::DirEntry> = fs::read_dir(dir)?.filter_map(|e| e.ok()).collect();
    let order_key = if parent_rel == "." { "." } else { parent_rel };
    let parent = if parent_rel == "." {
        None
    } else {
        Some(parent_rel.to_string())
    };

    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();
        let abs_path = entry.path();

        let Ok(meta) = fs::symlink_metadata(&abs_path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }

        let rel_path = abs_path.strip_prefix(base).unwrap_or(&abs_path);
        let rel_path = repo_path_string(rel_path);
        let path_kind = if meta.is_dir() {
            TreePathKind::Directory
        } else if meta.is_file() {
            TreePathKind::File
        } else {
            TreePathKind::Unknown
        };

        if policy.is_ignored_rel(Path::new(&rel_path), path_kind) {
            continue;
        }

        if meta.is_dir() {
            if skip_dirs.contains(&rel_path) {
                continue;
            }

            let schema_path = abs_path.join("schema.yaml");
            let schema_rel = schema_path.strip_prefix(base).unwrap_or(&schema_path);
            let has_schema = has_direct_schema(&abs_path)
                && !policy.is_ignored_rel(schema_rel, TreePathKind::File);
            let readme = find_readme(base, &abs_path, policy);
            let (title, icon, description) = if let Some(ref readme_path) = readme {
                let (title, icon, description) = read_frontmatter_meta_head(readme_path);
                if icon.is_none() && title.eq_ignore_ascii_case("readme") {
                    (name.clone(), None, None)
                } else {
                    (title, icon, description)
                }
            } else {
                (name.clone(), None, None)
            };
            let node_path = if let Some(ref readme_path) = readme {
                let readme_name = readme_path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy();
                format!("{rel_path}/{readme_name}")
            } else {
                rel_path.clone()
            };

            nodes.push(TreeChildNode {
                name,
                path: node_path,
                title,
                icon,
                description,
                has_changes: false,
                has_schema,
                parent: parent.clone(),
                has_children: has_visible_direct_children(base, &abs_path, skip_dirs, policy)?,
                kind: if has_schema {
                    TreeChildKind::Collection
                } else {
                    TreeChildKind::Folder
                },
            });
        } else if meta.is_file()
            && ((name.ends_with(".md") && !is_readme_name(&name))
                || (parent_rel == "." && is_readme_name(&name)))
        {
            let (title, icon, description) = read_frontmatter_meta_head(&abs_path);
            nodes.push(TreeChildNode {
                name,
                path: rel_path,
                title,
                icon,
                description,
                has_changes: false,
                has_schema: false,
                parent: parent.clone(),
                has_children: false,
                kind: TreeChildKind::Document,
            });
        }
    }

    apply_child_order(&mut nodes, order.get(order_key));
    Ok(nodes)
}

fn has_visible_direct_children(
    base: &Path,
    dir: &Path,
    skip_dirs: &HashSet<String>,
    policy: &TreeIgnorePolicy,
) -> Result<bool, AppError> {
    for entry in fs::read_dir(dir)?.filter_map(|e| e.ok()) {
        let name = entry.file_name().to_string_lossy().to_string();
        let abs_path = entry.path();

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
            if !skip_dirs.contains(&rel_path) {
                return Ok(true);
            }
        } else if meta.is_file() && name.ends_with(".md") && !is_readme_name(&name) {
            return Ok(true);
        }
    }

    Ok(false)
}

fn apply_child_order(nodes: &mut Vec<TreeChildNode>, order_list: Option<&Vec<String>>) {
    let Some(ordered) = order_list else {
        nodes.sort_by_key(|node| node.name.to_lowercase());
        return;
    };

    let positions: HashMap<&str, usize> = ordered
        .iter()
        .enumerate()
        .map(|(index, name)| (name.as_str(), index))
        .collect();

    nodes.sort_by(|a, b| {
        match (
            positions.get(a.name.as_str()),
            positions.get(b.name.as_str()),
        ) {
            (Some(left), Some(right)) => left.cmp(right),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });
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
            let has_schema = has_direct_schema(&abs_path)
                && !policy.is_ignored_rel(schema_rel, TreePathKind::File);
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

    fn child_names_direct(nodes: &[TreeChildNode]) -> Vec<String> {
        nodes.iter().map(|node| node.name.clone()).collect()
    }

    fn write_doc(path: &Path, title: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(
            path,
            format!(
                "---\nid: test\ntitle: {title}\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-01T00:00:00Z\n---\nBody that lazy tree listing should not need.\n"
            ),
        )
        .unwrap();
    }

    #[test]
    fn list_tree_children_root_returns_direct_children_only() {
        let tmp = TempDir::new().unwrap();
        write_doc(&tmp.path().join("a.md"), "A");
        write_doc(&tmp.path().join("folder").join("b.md"), "B");
        write_doc(&tmp.path().join("folder").join("nested").join("c.md"), "C");

        let nodes = list_tree_children(tmp.path().to_str().unwrap(), None).expect("children");

        assert_eq!(
            child_names_direct(&nodes),
            vec!["a.md".to_string(), "folder".to_string()]
        );
        assert!(!child_names_direct(&nodes).contains(&"b.md".to_string()));
        let folder = nodes.iter().find(|node| node.name == "folder").unwrap();
        assert_eq!(folder.parent, None);
        assert_eq!(folder.kind, TreeChildKind::Folder);
        assert!(folder.has_children);
    }

    #[test]
    fn list_tree_children_folder_parent_returns_direct_children_only() {
        let tmp = TempDir::new().unwrap();
        write_doc(&tmp.path().join("docs").join("a.md"), "A");
        write_doc(&tmp.path().join("docs").join("nested").join("b.md"), "B");
        write_doc(
            &tmp.path()
                .join("docs")
                .join("nested")
                .join("deep")
                .join("c.md"),
            "C",
        );

        let nodes =
            list_tree_children(tmp.path().to_str().unwrap(), Some("docs")).expect("children");

        assert_eq!(
            child_names_direct(&nodes),
            vec!["a.md".to_string(), "nested".to_string()]
        );
        assert!(!child_names_direct(&nodes).contains(&"b.md".to_string()));
        assert!(
            nodes
                .iter()
                .all(|node| node.parent.as_deref() == Some("docs"))
        );
        assert!(
            nodes
                .iter()
                .find(|node| node.name == "nested")
                .unwrap()
                .has_children
        );
    }

    #[test]
    fn list_tree_children_uses_readme_as_folder_metadata_without_duplicate_child() {
        let tmp = TempDir::new().unwrap();
        write_doc(&tmp.path().join("docs").join("README.md"), "Docs Home");
        write_doc(&tmp.path().join("docs").join("child.md"), "Child");

        let root_nodes = list_tree_children(tmp.path().to_str().unwrap(), None).expect("root");
        let docs = root_nodes
            .iter()
            .find(|node| node.name == "docs")
            .expect("docs");

        assert_eq!(docs.path, "docs/README.md");
        assert_eq!(docs.title, "Docs Home");
        assert!(docs.has_children);

        let children = list_tree_children(tmp.path().to_str().unwrap(), Some("docs/README.md"))
            .expect("docs children");

        assert_eq!(child_names_direct(&children), vec!["child.md".to_string()]);
        assert!(!child_names_direct(&children).contains(&"README.md".to_string()));
    }

    #[test]
    fn list_tree_children_ignores_user_heavy_dir_and_does_not_count_it_as_children() {
        let tmp = TempDir::new().unwrap();
        write_tree_config(&tmp, vec!["node_modules"], vec![]);
        write_doc(
            &tmp.path()
                .join("node_modules")
                .join("pkg")
                .join("README.md"),
            "Package",
        );
        write_doc(&tmp.path().join("docs").join("README.md"), "Docs");
        write_doc(
            &tmp.path()
                .join("docs")
                .join("node_modules")
                .join("pkg")
                .join("README.md"),
            "Nested Package",
        );

        let nodes = list_tree_children(tmp.path().to_str().unwrap(), None).expect("root");

        assert_eq!(child_names_direct(&nodes), vec!["docs".to_string()]);
        let docs = nodes.iter().find(|node| node.name == "docs").unwrap();
        assert!(!docs.has_children);

        let docs_children =
            list_tree_children(tmp.path().to_str().unwrap(), Some("docs")).expect("docs");
        assert!(docs_children.is_empty());
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

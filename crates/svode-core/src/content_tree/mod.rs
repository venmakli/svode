pub mod children;
pub mod policy;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;

use serde::{Deserialize, Serialize};

use self::children::{DirectoryFacts, DirectoryKind, is_regular_source};
use self::policy::{TreeIgnorePolicy, TreePathKind};
use crate::page::identity::{MarkdownIdentityFacts, SourceShape, resolve_markdown_identity};
use crate::page::naming::{DocumentNameConflict, document_name_conflict};
use crate::page::{PageSourceMeta, ParsedMarkdown, parse_markdown};
use crate::page::{SpaceReadiness, space_reference_status};

#[derive(Debug, thiserror::Error)]
pub enum ContentTreeError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("File not found: {0}")]
    FileNotFound(String),
    #[error("Path not accessible: {0}")]
    PathNotAccessible(String),
    #[error("Page source error: {0}")]
    Source(#[from] crate::page::PageSourceError),
    #[error("{0}")]
    Invalid(String),
}

#[derive(Deserialize)]
struct TreeConfigSource {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default = "default_space_icon")]
    icon: String,
    tree: Option<TreeConfig>,
    spaces: Option<Vec<ChildSpace>>,
}

fn default_space_icon() -> String {
    "\u{1F4C1}".to_string()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TreeConfig {
    #[serde(default)]
    exclude: Vec<String>,
    #[serde(default)]
    include: Vec<String>,
    #[serde(default)]
    show_ignored_placeholders: bool,
}

#[derive(Deserialize)]
struct ChildSpace {
    id: String,
    path: String,
    repo: Option<String>,
}

fn read_tree_config(root: &std::path::Path) -> Option<TreeConfigSource> {
    read_tree_config_checked(root).ok()
}

fn read_tree_config_checked(root: &Path) -> Result<TreeConfigSource, ContentTreeError> {
    let path = root.join(".svode/config.json");
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(ContentTreeError::FileNotFound(path.display().to_string()));
        }
        Err(error) => return Err(error.into()),
    };
    Ok(serde_json::from_str(&raw)?)
}

#[derive(Debug, Clone)]
pub struct ProjectChild {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub description: String,
    pub path: std::path::PathBuf,
    pub has_spaces: bool,
    pub has_schema: bool,
    pub has_app: bool,
    pub status: SpaceReadiness,
}

pub fn list_project_children(parent: &Path) -> Result<Vec<ProjectChild>, ContentTreeError> {
    let config = read_tree_config_checked(parent)?;
    let mut result = Vec::new();
    for child in config.spaces.unwrap_or_default() {
        let path = parent.join(&child.path);
        let status = space_reference_status(parent, &child.path, child.repo.as_deref());
        let child_config = if status == SpaceReadiness::Ready {
            read_tree_config(&path)
        } else {
            None
        };
        let ready = status == SpaceReadiness::Ready;
        result.push(ProjectChild {
            id: child.id,
            name: if ready {
                child_config
                    .as_ref()
                    .map(|config| config.name.clone())
                    .unwrap_or_else(|| {
                        path.file_name()
                            .map(|name| name.to_string_lossy().to_string())
                            .unwrap_or_default()
                    })
            } else {
                child.path
            },
            icon: child_config
                .as_ref()
                .map(|config| config.icon.clone())
                .unwrap_or_default(),
            description: child_config
                .as_ref()
                .map(|config| config.description.clone())
                .unwrap_or_default(),
            path: path.clone(),
            has_spaces: child_config
                .as_ref()
                .and_then(|config| config.spaces.as_ref())
                .is_some_and(|children| !children.is_empty()),
            has_schema: ready && has_direct_schema(&path),
            has_app: ready && has_direct_app_marker(&path),
            status,
        });
    }
    Ok(result)
}

fn has_direct_app_marker(directory: &Path) -> bool {
    fs::read_dir(directory).is_ok_and(|entries| {
        entries
            .filter_map(Result::ok)
            .any(|entry| entry.file_name() == "app.yaml")
    })
}

fn normalize_parent_path(raw: &str) -> Result<String, ContentTreeError> {
    let path = raw.replace('\\', "/");
    if path.is_empty() || path == "." {
        return Ok(".".to_string());
    }
    let has_drive_prefix =
        path.as_bytes().get(1) == Some(&b':') && path.as_bytes()[0].is_ascii_alphabetic();
    if path.starts_with('/') {
        return Err(ContentTreeError::PathNotAccessible(format!(
            "repo-relative path cannot be absolute: {path}"
        )));
    }
    if has_drive_prefix {
        return Err(ContentTreeError::PathNotAccessible(format!(
            "repo-relative path cannot contain a drive prefix: {path}"
        )));
    }
    for part in path.split('/') {
        if part.is_empty() {
            return Err(ContentTreeError::PathNotAccessible(format!(
                "repo-relative path cannot contain empty segments: {path}"
            )));
        }
        if part == "." || part == ".." {
            return Err(ContentTreeError::PathNotAccessible(format!(
                "repo-relative path cannot contain '{part}' segments: {path}"
            )));
        }
    }
    Ok(path)
}

const MAX_FRONTMATTER_HEAD_BYTES: usize = 64 * 1024;

pub fn has_direct_schema(directory: &Path) -> bool {
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
    #[serde(default)]
    pub has_app: bool,
    pub kind: TreeChildKind,
    pub source_shape: SourceShape,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_conflict: Option<DocumentNameConflict>,
    pub children: Vec<TreeNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TreeChildKind {
    Page,
    Folder,
    Collection,
    App,
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
    #[serde(default)]
    pub has_app: bool,
    pub parent: Option<String>,
    #[serde(rename = "hasChildren")]
    pub has_children: bool,
    pub kind: TreeChildKind,
    pub source_shape: SourceShape,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_conflict: Option<DocumentNameConflict>,
}

fn is_readme_name(name: &str) -> bool {
    name.eq_ignore_ascii_case("readme.md")
}

/// Find a readme.md file inside a directory (case-insensitive).
/// Returns the absolute path if found.
fn find_readme(
    base: &Path,
    dir: &Path,
    policy: &TreeIgnorePolicy,
) -> Result<Option<std::path::PathBuf>, std::io::Error> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if !is_readme_name(&entry.file_name().to_string_lossy()) {
            continue;
        }
        let rel = path.strip_prefix(base).unwrap_or(&path);
        if policy.is_ignored_rel(rel, TreePathKind::File) {
            continue;
        }
        if entry.file_type()?.is_file() {
            return Ok(Some(path));
        }
    }
    Ok(None)
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

    match parse_markdown(&content, "") {
        ParsedMarkdown::Valid(meta, _) => title_or_fallback(meta, fallback),
        _ => (fallback, None, None),
    }
}

/// Lazy tree metadata reader: stop at frontmatter instead of loading markdown body.
pub fn read_frontmatter_meta_head(abs_path: &Path) -> (String, Option<String>, Option<String>) {
    let fallback = abs_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    read_frontmatter_meta_head_with_fallback(abs_path, fallback)
}

pub fn read_frontmatter_meta_head_with_fallback(
    abs_path: &Path,
    fallback: String,
) -> (String, Option<String>, Option<String>) {
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
            match parse_markdown(&head, "") {
                ParsedMarkdown::Valid(meta, _) => return title_or_fallback(meta, fallback),
                _ => return (fallback, None, None),
            }
        }
    }

    (fallback, None, None)
}

fn repo_path_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn title_or_fallback(
    meta: PageSourceMeta,
    fallback: String,
) -> (String, Option<String>, Option<String>) {
    let title = if meta.title_present {
        meta.title
    } else {
        fallback
    };
    (title, meta.icon, meta.description)
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

/// Persist order.json for a Space.
pub fn write_order(
    space: &Path,
    order: &HashMap<String, Vec<String>>,
) -> Result<(), ContentTreeError> {
    let svode_dir = space.join(".svode");
    fs::create_dir_all(&svode_dir)?;
    let data = serde_json::to_string_pretty(order)?;
    fs::write(svode_dir.join("order.json"), data)?;
    Ok(())
}

/// Markdown files under `root` that the Space tree policy does not ignore.
/// Symlinks are skipped; `base` is the Space root used for policy matching.
pub fn collect_markdown_paths(
    base: &Path,
    root: &Path,
    policy: &policy::TreeIgnorePolicy,
) -> Result<Vec<std::path::PathBuf>, std::io::Error> {
    let Ok(meta) = fs::symlink_metadata(root) else {
        return Ok(Vec::new());
    };
    if meta.file_type().is_symlink() {
        return Ok(Vec::new());
    }
    let rel_path = root.strip_prefix(base).unwrap_or(root);
    let kind = if meta.is_dir() {
        policy::TreePathKind::Directory
    } else if meta.is_file() {
        policy::TreePathKind::File
    } else {
        policy::TreePathKind::Unknown
    };
    if policy.is_ignored_rel(rel_path, kind) {
        return Ok(Vec::new());
    }
    if meta.is_file() {
        return Ok(root
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
            .then(|| vec![root.to_path_buf()])
            .unwrap_or_default());
    }
    if !meta.is_dir() {
        return Ok(Vec::new());
    }
    let mut paths = Vec::new();
    for item in fs::read_dir(root)? {
        paths.extend(collect_markdown_paths(base, &item?.path(), policy)?);
    }
    Ok(paths)
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
pub fn child_folder_names(space: &Path) -> HashSet<String> {
    let mut names = HashSet::new();
    if let Some(cfg) = read_tree_config(space) {
        if let Some(spaces) = cfg.spaces {
            for child in spaces {
                names.insert(child.path.replace('\\', "/"));
            }
        }
    }
    names
}

/// Build a file tree from a space directory.
pub fn build_tree(space: &str) -> Result<Vec<TreeNode>, ContentTreeError> {
    let root = Path::new(space);
    if !root.is_dir() {
        return Err(ContentTreeError::FileNotFound(space.to_string()));
    }
    let order = read_order(root);
    let skip_dirs = child_folder_names(root);
    let policy = TreeIgnorePolicy::from_space_root(root);
    let mut nodes = read_dir_recursive(root, root, &order, &skip_dirs, &policy)?;
    annotate_recursive_name_conflicts(root, &mut nodes)?;
    Ok(nodes)
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TreeLoadError {
    Missing {
        path: String,
    },
    Hidden {
        path: String,
    },
    Unavailable {
        message: String,
        #[serde(skip)]
        source: ContentTreeError,
    },
}

impl From<ContentTreeError> for TreeLoadError {
    fn from(error: ContentTreeError) -> Self {
        Self::Unavailable {
            message: error.to_string(),
            source: error,
        }
    }
}

impl From<std::io::Error> for TreeLoadError {
    fn from(error: std::io::Error) -> Self {
        ContentTreeError::Io(error).into()
    }
}

pub fn list_tree_children(
    space: &str,
    parent_path: Option<&str>,
) -> Result<Vec<TreeChildNode>, ContentTreeError> {
    list_tree_children_checked(space, parent_path).map_err(|error| match error {
        TreeLoadError::Missing { path } | TreeLoadError::Hidden { path } => {
            ContentTreeError::FileNotFound(path)
        }
        TreeLoadError::Unavailable { source, .. } => source,
    })
}

pub fn list_tree_children_checked(
    space: &str,
    parent_path: Option<&str>,
) -> Result<Vec<TreeChildNode>, TreeLoadError> {
    let root = Path::new(space);
    // Missing targets only authorize cleanup while the owning root is readable.
    fs::read_dir(root)?;
    let parent_rel = normalize_tree_parent_path(parent_path)?;
    let policy = TreeIgnorePolicy::from_space_root(root);
    let skip_dirs = child_folder_names(root);
    let mut dir = root.to_path_buf();
    if parent_rel != "." {
        let mut relative = std::path::PathBuf::new();
        for component in Path::new(&parent_rel).components() {
            relative.push(component);
            let parent_has_app = directory_facts(root, &dir, &policy)?.0.has_app;
            dir.push(component);
            let path = repo_path_string(&relative);
            if skip_dirs.contains(&path)
                || policy.is_ignored_rel(&relative, TreePathKind::Directory)
            {
                return Err(TreeLoadError::Hidden { path });
            }
            match fs::symlink_metadata(&dir) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    return Err(TreeLoadError::Hidden { path });
                }
                Ok(meta) if meta.is_dir() => {
                    fs::read_dir(&dir)?;
                    if !directory_facts(root, &dir, &policy)?
                        .0
                        .is_child_of(parent_has_app)
                    {
                        return Err(TreeLoadError::Hidden { path });
                    }
                }
                Ok(_) => {
                    fs::read_dir(root)?;
                    return Err(TreeLoadError::Missing { path });
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    fs::read_dir(root)?;
                    return Err(TreeLoadError::Missing { path });
                }
                Err(error) => return Err(error.into()),
            }
        }
    }

    let order = read_order(root);
    let skip_dirs = child_folder_names(root);
    let mut nodes = read_dir_direct(root, &dir, &parent_rel, &order, &skip_dirs, &policy)?;
    for node in &mut nodes {
        if node.path.to_lowercase().ends_with(".md") {
            node.name_conflict = document_name_conflict(root, &node.path, &node.title)
                .map_err(ContentTreeError::from)?;
        }
    }
    Ok(nodes)
}

fn annotate_recursive_name_conflicts(
    space: &Path,
    nodes: &mut [TreeNode],
) -> Result<(), ContentTreeError> {
    for node in nodes {
        if node.path.to_lowercase().ends_with(".md") {
            node.name_conflict = document_name_conflict(space, &node.path, &node.title)
                .map_err(ContentTreeError::from)?;
        }
        annotate_recursive_name_conflicts(space, &mut node.children)?;
    }
    Ok(())
}

pub fn normalize_tree_parent_path(parent_path: Option<&str>) -> Result<String, ContentTreeError> {
    let Some(raw) = parent_path.map(str::trim).filter(|path| !path.is_empty()) else {
        return Ok(".".to_string());
    };
    let normalized = normalize_parent_path(raw)?;
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

fn tree_directory_kind(facts: DirectoryFacts) -> TreeChildKind {
    match facts.kind() {
        DirectoryKind::Collection => TreeChildKind::Collection,
        DirectoryKind::Page => TreeChildKind::Page,
        DirectoryKind::App => TreeChildKind::App,
        DirectoryKind::Directory => TreeChildKind::Folder,
    }
}

fn directory_facts(
    base: &Path,
    dir: &Path,
    policy: &TreeIgnorePolicy,
) -> Result<(DirectoryFacts, Option<std::path::PathBuf>), std::io::Error> {
    let visible_marker = |name: &str| {
        let path = dir.join(name);
        is_regular_source(&path)
            && !policy.is_ignored_rel(path.strip_prefix(base).unwrap_or(&path), TreePathKind::File)
    };
    let readme = find_readme(base, dir, policy)?;
    Ok((
        DirectoryFacts {
            has_head: readme.is_some(),
            has_schema: visible_marker("schema.yaml"),
            has_app: visible_marker("app.yaml"),
        },
        readme,
    ))
}

fn read_dir_direct(
    base: &Path,
    dir: &Path,
    parent_rel: &str,
    order: &HashMap<String, Vec<String>>,
    skip_dirs: &HashSet<String>,
    policy: &TreeIgnorePolicy,
) -> Result<Vec<TreeChildNode>, ContentTreeError> {
    let mut nodes: Vec<TreeChildNode> = Vec::new();
    let entries: Vec<fs::DirEntry> = fs::read_dir(dir)?.collect::<Result<_, _>>()?;
    let order_key = if parent_rel == "." { "." } else { parent_rel };
    let parent = if parent_rel == "." {
        None
    } else {
        Some(parent_rel.to_string())
    };
    let parent_has_app = directory_facts(base, dir, policy)?.0.has_app;

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

            let (facts, readme) = directory_facts(base, &abs_path, policy)?;
            let has_schema = facts.has_schema;
            let has_app = facts.has_app;
            if !facts.is_child_of(parent_has_app) {
                continue;
            }
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
            let kind = tree_directory_kind(facts);

            nodes.push(TreeChildNode {
                name,
                path: node_path,
                title,
                icon,
                description,
                has_changes: false,
                has_schema,
                has_app,
                parent: parent.clone(),
                has_children: has_visible_direct_children(base, &abs_path, skip_dirs, policy)?,
                kind,
                source_shape: SourceShape::Directory,
                name_conflict: None,
            });
        } else if meta.is_file() && name.ends_with(".md") && !is_readme_name(&name) {
            let (title, icon, description) = read_frontmatter_meta_head(&abs_path);
            debug_assert!(
                resolve_markdown_identity(MarkdownIdentityFacts {
                    path: &rel_path,
                    source_shape: SourceShape::File,
                    collection_root: None,
                    agent_context: false,
                })
                .is_page()
            );
            nodes.push(TreeChildNode {
                name,
                path: rel_path,
                title,
                icon,
                description,
                has_changes: false,
                has_schema: false,
                has_app: false,
                parent: parent.clone(),
                has_children: false,
                kind: TreeChildKind::Page,
                source_shape: SourceShape::File,
                name_conflict: None,
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
) -> Result<bool, ContentTreeError> {
    let parent_has_app = directory_facts(base, dir, policy)?.0.has_app;
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
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
            if skip_dirs.contains(&rel_path) {
                continue;
            }
            let (facts, _) = directory_facts(base, &abs_path, policy)?;
            if facts.is_child_of(parent_has_app) {
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
) -> Result<Vec<TreeNode>, ContentTreeError> {
    let mut nodes: Vec<TreeNode> = Vec::new();
    let entries: Vec<fs::DirEntry> = fs::read_dir(dir)?.filter_map(|e| e.ok()).collect();

    // Compute the directory key for order lookup
    let dir_key = if dir == base {
        ".".to_string()
    } else {
        repo_path_string(dir.strip_prefix(base).unwrap_or(dir))
    };
    let parent_has_app = directory_facts(base, dir, policy)?.0.has_app;

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

            let (facts, readme) = directory_facts(base, &abs_path, policy)?;
            let has_schema = facts.has_schema;
            let has_app = facts.has_app;
            if !facts.is_child_of(parent_has_app) {
                continue;
            }

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
                has_app,
                kind: tree_directory_kind(facts),
                source_shape: SourceShape::Directory,
                name_conflict: None,
                children,
            });
        } else if meta.is_file() && name.ends_with(".md") && !is_readme_name(&name) {
            let (title, icon, description) = read_frontmatter_meta(&abs_path);
            nodes.push(TreeNode {
                name,
                path: rel_path,
                title,
                icon,
                description,
                has_changes: false,
                has_schema: false,
                has_app: false,
                kind: TreeChildKind::Page,
                source_shape: SourceShape::File,
                name_conflict: None,
                children: vec![],
            });
        }
        // Non-.md files are ignored
    }

    // Apply custom order for this directory
    apply_order(&mut nodes, order.get(&dir_key));

    Ok(nodes)
}

#[derive(Debug, PartialEq, Eq)]
pub struct ContentOrderOutcome {
    pub parent_path: String,
    pub previous_order: Vec<String>,
    pub ordered_children: Vec<String>,
    pub changed: bool,
}

/// Replace the sibling order under `parent_path`. The proposal must be exactly
/// the current direct children, so a stale client cannot drop or invent one.
/// A no-op order never creates the order source.
pub fn reorder_content(
    space: &str,
    parent_path: &str,
    ordered_children: Vec<String>,
) -> Result<ContentOrderOutcome, ContentTreeError> {
    let parent_path = normalize_tree_parent_path(Some(parent_path))?;
    let actual_children = list_tree_children(space, Some(&parent_path))?;
    let previous_order = actual_children
        .iter()
        .map(|child| child.path.clone())
        .collect::<Vec<_>>();
    let expected = previous_order.iter().collect::<HashSet<_>>();
    let proposed = ordered_children.iter().collect::<HashSet<_>>();

    if proposed.len() != ordered_children.len() {
        return Err(ContentTreeError::Invalid(
            "orderedChildren contains duplicate paths".to_string(),
        ));
    }
    if proposed != expected {
        return Err(ContentTreeError::Invalid(
            "orderedChildren must contain each current direct child exactly once".to_string(),
        ));
    }

    let changed = previous_order != ordered_children;
    if changed {
        let names = ordered_children
            .iter()
            .map(|path| {
                actual_children
                    .iter()
                    .find(|child| child.path == *path)
                    .map(|child| child.name.clone())
                    .ok_or_else(|| ContentTreeError::Invalid(format!("unknown child path: {path}")))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut order = read_order(Path::new(space));
        order.insert(parent_path.clone(), names);
        write_order(Path::new(space), &order)?;
    }

    Ok(ContentOrderOutcome {
        parent_path: if parent_path == "." {
            String::new()
        } else {
            parent_path
        },
        previous_order,
        ordered_children,
        changed,
    })
}

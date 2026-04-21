use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::error::AppError;
use crate::files::backlinks::BacklinkIndex;
use crate::files::frontmatter;
use crate::files::tree;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WriteResult {
    /// New relative path if file was renamed, None if path unchanged.
    pub new_path: Option<String>,
    /// Files whose backlinks were updated due to rename.
    pub modified_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EntryMeta {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub created: String,
    pub updated: String,
    /// User-defined custom fields from frontmatter YAML.
    #[serde(flatten)]
    pub extra: HashMap<String, serde_yml::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub meta: EntryMeta,
    pub body: String,
    /// Relative path from space root.
    pub path: String,
}

/// Resolve an absolute path from space root + relative path.
fn resolve(space: &str, rel: &str) -> PathBuf {
    Path::new(space).join(rel)
}

/// Transliterate Cyrillic characters to Latin equivalents.
fn transliterate(input: &str) -> String {
    let mut result = String::with_capacity(input.len() * 2);
    for c in input.chars() {
        let mapped = match c {
            'а' | 'А' => "a",
            'б' | 'Б' => "b",
            'в' | 'В' => "v",
            'г' | 'Г' => "g",
            'д' | 'Д' => "d",
            'е' | 'Е' => "e",
            'ё' | 'Ё' => "yo",
            'ж' | 'Ж' => "zh",
            'з' | 'З' => "z",
            'и' | 'И' => "i",
            'й' | 'Й' => "j",
            'к' | 'К' => "k",
            'л' | 'Л' => "l",
            'м' | 'М' => "m",
            'н' | 'Н' => "n",
            'о' | 'О' => "o",
            'п' | 'П' => "p",
            'р' | 'Р' => "r",
            'с' | 'С' => "s",
            'т' | 'Т' => "t",
            'у' | 'У' => "u",
            'ф' | 'Ф' => "f",
            'х' | 'Х' => "h",
            'ц' | 'Ц' => "ts",
            'ч' | 'Ч' => "ch",
            'ш' | 'Ш' => "sh",
            'щ' | 'Щ' => "shch",
            'ъ' | 'Ъ' => "",
            'ы' | 'Ы' => "y",
            'ь' | 'Ь' => "",
            'э' | 'Э' => "e",
            'ю' | 'Ю' => "yu",
            'я' | 'Я' => "ya",
            _ => {
                result.push(c);
                continue;
            }
        };
        result.push_str(mapped);
    }
    result
}

const MAX_SLUG_LENGTH: usize = 60;

/// Generate a URL-safe slug from a title.
pub(crate) fn slugify(title: &str) -> String {
    // Transliterate Cyrillic → Latin, then lowercase
    let transliterated = transliterate(title);
    let slug: String = transliterated
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c
            } else if c == ' ' || c == '_' || c == '-' {
                '-'
            } else {
                '\0'
            }
        })
        .filter(|&c| c != '\0')
        .collect();

    // Collapse multiple hyphens
    let mut result = String::with_capacity(slug.len());
    let mut prev_hyphen = false;
    for c in slug.chars() {
        if c == '-' {
            if !prev_hyphen {
                result.push(c);
            }
            prev_hyphen = true;
        } else {
            result.push(c);
            prev_hyphen = false;
        }
    }
    let trimmed = result.trim_matches('-');

    // Fallback for empty slugs (e.g. CJK-only input)
    if trimmed.is_empty() {
        return "untitled".to_string();
    }

    // Truncate to MAX_SLUG_LENGTH on word boundary
    if trimmed.len() <= MAX_SLUG_LENGTH {
        return trimmed.to_string();
    }

    let truncated = &trimmed[..MAX_SLUG_LENGTH];
    match truncated.rfind('-') {
        Some(pos) => truncated[..pos].to_string(),
        None => truncated.to_string(),
    }
}

/// Current UTC timestamp in RFC 3339 format.
fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Convert filesystem timestamp to RFC 3339 string, falling back to now.
fn system_time_to_rfc3339(st: std::io::Result<std::time::SystemTime>) -> String {
    st.ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| {
            chrono::DateTime::from_timestamp(d.as_secs() as i64, d.subsec_nanos())
                .unwrap_or_else(chrono::Utc::now)
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
        })
        .unwrap_or_else(now_rfc3339)
}

/// Generate a title from a filename stem: "my-notes" → "My notes".
fn title_from_stem(stem: &str) -> String {
    let s = stem.replace('-', " ").replace('_', " ");
    let mut chars = s.chars();
    match chars.next() {
        None => "Untitled".to_string(),
        Some(c) => c.to_uppercase().to_string() + chars.as_str(),
    }
}

/// Append a filename to order.json for a given directory key.
fn order_append(space: &Path, dir_key: &str, name: &str) {
    let mut order = tree::read_order(space);
    order
        .entry(dir_key.to_string())
        .or_default()
        .push(name.to_string());
    let _ = tree::write_order(space, &order);
}

/// Rename an entry in order.json (replace old_name with new_name in the given directory).
fn order_rename(space: &Path, dir_key: &str, old_name: &str, new_name: &str) {
    let mut order = tree::read_order(space);
    if let Some(list) = order.get_mut(dir_key) {
        if let Some(pos) = list.iter().position(|n| n == old_name) {
            list[pos] = new_name.to_string();
            let _ = tree::write_order(space, &order);
        }
    }
}

/// Create a new entry on disk. Returns the created Entry.
pub fn create(
    space: &str,
    parent_path: Option<&str>,
    title: &str,
) -> Result<Entry, AppError> {
    let id = ulid::Ulid::new().to_string().to_lowercase();
    let slug = slugify(title);

    // Find a non-colliding filename: slug.md, slug-1.md, slug-2.md, ...
    let (rel_path, abs_path) = {
        let make_rel = |name: &str| match parent_path {
            Some(parent) => format!("{parent}/{name}.md"),
            None => format!("{name}.md"),
        };

        let base_rel = make_rel(&slug);
        let base_abs = resolve(space, &base_rel);

        if !base_abs.exists() {
            (base_rel, base_abs)
        } else {
            let mut found = None;
            for i in 1..=100 {
                let candidate = format!("{slug}-{i}");
                let rel = make_rel(&candidate);
                let abs = resolve(space, &rel);
                if !abs.exists() {
                    found = Some((rel, abs));
                    break;
                }
            }
            found.ok_or_else(|| {
                AppError::FileAlreadyExists(make_rel(&slug))
            })?
        }
    };

    // Ensure parent directory exists
    if let Some(parent_dir) = abs_path.parent() {
        fs::create_dir_all(parent_dir)?;
    }

    let now = now_rfc3339();
    let meta = EntryMeta {
        id,
        title: title.to_string(),
        icon: None,
        created: now.clone(),
        updated: now,
        extra: HashMap::new(),
    };

    let body = "";
    let content = frontmatter::serialize(&meta, body);
    fs::write(&abs_path, &content)?;

    // Append to order.json so the new file appears at the end
    let filename = Path::new(&rel_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let dir_key = parent_path.unwrap_or(".");
    order_append(Path::new(space), dir_key, &filename);

    Ok(Entry {
        meta,
        body: body.to_string(),
        path: rel_path,
    })
}

/// Create a bare folder (directory without readme.md).
/// The folder name is the title as-is (no slugify, no transliteration).
/// Returns the relative path of the created folder.
pub fn create_folder(
    space: &str,
    parent_path: Option<&str>,
    name: &str,
) -> Result<String, AppError> {
    let rel_path = match parent_path {
        Some(parent) => format!("{parent}/{name}"),
        None => name.to_string(),
    };

    let abs_path = resolve(space, &rel_path);

    if abs_path.exists() {
        return Err(AppError::FileAlreadyExists(rel_path));
    }

    fs::create_dir_all(&abs_path)?;

    // Git doesn't track empty directories — drop a `.gitkeep` placeholder so
    // `Create <folder>` auto-commit has a tracked file to stage. We keep the
    // file after real children appear (harmless, preserves the structural
    // commit history).
    fs::write(abs_path.join(".gitkeep"), "")?;

    // Append to order.json
    let dir_key = parent_path.unwrap_or(".");
    order_append(Path::new(space), dir_key, name);

    Ok(rel_path)
}

/// Read an entry from disk.
/// If the file has no frontmatter, generates metadata in memory without modifying the file.
/// Frontmatter will be written to disk only on the first explicit save (write).
pub fn read(space: &str, path: &str) -> Result<Entry, AppError> {
    let abs_path = resolve(space, path);

    if !abs_path.exists() {
        return Err(AppError::FileNotFound(path.to_string()));
    }

    let content = fs::read_to_string(&abs_path)?;

    match frontmatter::try_parse(&content)? {
        Some((meta, body)) => Ok(Entry {
            meta,
            body,
            path: path.to_string(),
        }),
        None => {
            // No frontmatter — generate meta in memory, don't touch the file
            let fs_meta = fs::metadata(&abs_path)?;
            let created = system_time_to_rfc3339(fs_meta.created());
            let updated = system_time_to_rfc3339(fs_meta.modified());

            let stem = Path::new(path)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("untitled");
            let title = title_from_stem(stem);

            let meta = EntryMeta {
                id: ulid::Ulid::new().to_string().to_lowercase(),
                title,
                icon: None,
                created,
                updated,
                extra: HashMap::new(),
            };

            Ok(Entry {
                meta,
                body: content,
                path: path.to_string(),
            })
        }
    }
}

/// Write content to an entry, updating the `updated` field in frontmatter.
/// Optionally update title, icon, and custom fields if provided.
/// If title changes, the file may be renamed based on the new slug.
/// `existing_id` is used when saving a file that had no frontmatter — preserves
/// the id generated during `read()`.
/// Returns WriteResult with new_path if a rename occurred.
pub fn write(
    space: &str,
    path: &str,
    content: &str,
    title: Option<&str>,
    icon: Option<&str>,
    extra: Option<HashMap<String, serde_yml::Value>>,
    existing_id: Option<&str>,
    backlink_index: Option<&BacklinkIndex>,
) -> Result<WriteResult, AppError> {
    let abs_path = resolve(space, path);

    if !abs_path.exists() {
        return Err(AppError::FileNotFound(path.to_string()));
    }

    // Read existing frontmatter to preserve metadata
    let existing = fs::read_to_string(&abs_path)?;
    let parsed_existing = frontmatter::try_parse(&existing)?;
    let had_frontmatter = parsed_existing.is_some();
    let meta_needs_write = had_frontmatter || title.is_some() || icon.is_some() || extra.is_some();

    let (old_title, mut meta) = if meta_needs_write {
        let meta = match parsed_existing.clone() {
            Some((meta, _)) => meta,
            None => {
                // First metadata change on a file without frontmatter — generate meta
                let fs_meta = fs::metadata(&abs_path)?;
                let created = system_time_to_rfc3339(fs_meta.created());
                let id = existing_id
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| ulid::Ulid::new().to_string().to_lowercase());
                EntryMeta {
                    id,
                    title: title_from_stem(
                        Path::new(path).file_stem().and_then(|s| s.to_str()).unwrap_or("untitled"),
                    ),
                    icon: None,
                    created,
                    updated: String::new(),
                    extra: HashMap::new(),
                }
            }
        };
        let old_title = meta.title.clone();

        (old_title, meta)
    } else {
        // Body-only save on a file without frontmatter — write content as-is,
        // skipping the write entirely if nothing changed (avoids spurious commits).
        if existing == content {
            return Ok(WriteResult { new_path: None, modified_files: Vec::new() });
        }
        fs::write(&abs_path, content)?;
        return Ok(WriteResult { new_path: None, modified_files: Vec::new() });
    };

    // Update title and icon if provided
    if let Some(t) = title {
        meta.title = t.to_string();
    }
    if let Some(i) = icon {
        meta.icon = Some(i.to_string());
    }

    // Update custom fields if provided
    if let Some(e) = extra {
        meta.extra = e;
    }

    // Skip the write entirely if neither body nor meta (ignoring `updated`)
    // changed. Otherwise every Cmd+S would bump `updated` and create an empty
    // commit even though the user typed nothing.
    if let Some((ref old_meta, ref old_body)) = parsed_existing {
        if old_body == content
            && old_meta.id == meta.id
            && old_meta.title == meta.title
            && old_meta.icon == meta.icon
            && old_meta.created == meta.created
            && old_meta.extra == meta.extra
        {
            return Ok(WriteResult { new_path: None, modified_files: Vec::new() });
        }
    }

    // Update the timestamp only once we know something actually changed.
    meta.updated = now_rfc3339();

    let full_content = frontmatter::serialize(&meta, content);
    fs::write(&abs_path, full_content)?;

    // Check if title changed and we need to rename
    let mut new_path: Option<String> = None;

    if let Some(t) = title {
        if t != old_title {
            let new_slug = slugify(t);
            let current_stem = Path::new(path)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("");

            // Check if the file is a readme.md (category file)
            let is_readme = Path::new(path)
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.eq_ignore_ascii_case("readme.md"));

            if new_slug != current_stem || is_readme {
                if is_readme {
                    // For readme.md, rename the parent folder
                    if let Some(parent_rel) = Path::new(path).parent() {
                        if parent_rel.as_os_str().is_empty() {
                            // readme.md at root, no parent folder to rename
                        } else {
                            let grandparent = parent_rel
                                .parent()
                                .unwrap_or(Path::new(""));
                            let new_dir_name = new_slug.clone();
                            let new_dir_rel = if grandparent.as_os_str().is_empty() {
                                new_dir_name.clone()
                            } else {
                                format!("{}/{}", grandparent.display(), new_dir_name)
                            };
                            let new_dir_abs = resolve(space, &new_dir_rel);

                            if !new_dir_abs.exists() {
                                let old_dir_abs = resolve(space, &parent_rel.to_string_lossy());
                                fs::rename(&old_dir_abs, &new_dir_abs)?;
                                let readme_filename = Path::new(path)
                                    .file_name()
                                    .unwrap_or_default()
                                    .to_string_lossy();
                                let renamed_path = format!("{}/{}", new_dir_rel, readme_filename);
                                new_path = Some(renamed_path);
                            }
                            // If collision, content is already saved, just skip rename
                        }
                    }
                } else {
                    // Regular file: rename slug.md
                    let parent_dir = Path::new(path)
                        .parent()
                        .unwrap_or(Path::new(""));
                    let new_filename = format!("{new_slug}.md");
                    let new_rel = if parent_dir.as_os_str().is_empty() {
                        new_filename
                    } else {
                        format!("{}/{}", parent_dir.display(), new_filename)
                    };
                    let new_abs = resolve(space, &new_rel);

                    if !new_abs.exists() {
                        fs::rename(&abs_path, &new_abs)?;
                        new_path = Some(new_rel);
                    }
                    // If collision, content is already saved, just skip rename
                }
            }
        }
    }

    // Update order.json if file/folder was renamed
    if let Some(ref np) = new_path {
        let sp_path = Path::new(space);
        let old_name = Path::new(path)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let new_name = Path::new(np.as_str())
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        // For readme.md renames, the "name" in order is the folder name, not "readme.md"
        let is_readme = old_name.eq_ignore_ascii_case("readme.md");
        if is_readme {
            let old_dir_name = Path::new(path)
                .parent()
                .and_then(|p| p.file_name())
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let new_dir_name = Path::new(np.as_str())
                .parent()
                .and_then(|p| p.file_name())
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let grandparent = Path::new(path)
                .parent()
                .and_then(|p| p.parent())
                .unwrap_or(Path::new(""));
            let dir_key = if grandparent.as_os_str().is_empty() {
                ".".to_string()
            } else {
                grandparent.to_string_lossy().to_string()
            };
            // Rename folder entry in parent's order list
            order_rename(sp_path, &dir_key, &old_dir_name, &new_dir_name);
            // Rename the key itself (children order moves to new dir name)
            let mut order = tree::read_order(sp_path);
            let old_key = if dir_key == "." {
                old_dir_name.clone()
            } else {
                format!("{}/{}", dir_key, old_dir_name)
            };
            if let Some(children) = order.remove(&old_key) {
                let new_key = if dir_key == "." {
                    new_dir_name
                } else {
                    format!("{}/{}", dir_key, new_dir_name)
                };
                order.insert(new_key, children);
                let _ = tree::write_order(sp_path, &order);
            }
        } else {
            // Regular file: dir_key is the parent directory
            let parent_dir = Path::new(path)
                .parent()
                .unwrap_or(Path::new(""));
            let dir_key = if parent_dir.as_os_str().is_empty() {
                ".".to_string()
            } else {
                parent_dir.to_string_lossy().to_string()
            };
            order_rename(sp_path, &dir_key, &old_name, &new_name);
        }
    }

    // Update backlink index
    let current_path = new_path.as_deref().unwrap_or(path);
    let mut modified_files = Vec::new();
    if let Some(index) = backlink_index {
        // If renamed, update links in other files
        if let Some(ref np) = new_path {
            modified_files = index
                .update_links_on_rename(Path::new(space), path, np)
                .unwrap_or_default();
        }
        // Re-index the written file
        let _ = index.update_file(Path::new(space), current_path);
    }

    Ok(WriteResult { new_path, modified_files })
}

/// Move a file or directory to a new parent directory.
/// Updates backlinks. Returns the new relative path.
pub fn move_entry(
    space: &Path,
    from: &str,
    to_parent: &str,
    backlink_index: Option<&BacklinkIndex>,
) -> Result<String, AppError> {
    let abs_from = space.join(from);

    if !abs_from.exists() {
        return Err(AppError::FileNotFound(from.to_string()));
    }

    let filename = Path::new(from)
        .file_name()
        .ok_or_else(|| AppError::General("invalid source path".to_string()))?;

    let new_rel = if to_parent.is_empty() {
        filename.to_string_lossy().to_string()
    } else {
        format!("{}/{}", to_parent, filename.to_string_lossy())
    };

    let abs_to = space.join(&new_rel);

    if abs_to.exists() {
        return Err(AppError::FileAlreadyExists(new_rel));
    }

    let is_md = abs_from.is_dir()
        || Path::new(from).extension().and_then(|e| e.to_str()) == Some("md");

    // Ensure target parent directory exists
    if let Some(parent_dir) = abs_to.parent() {
        fs::create_dir_all(parent_dir)?;
    }

    fs::rename(&abs_from, &abs_to)?;

    // Update backlinks
    if let Some(index) = backlink_index {
        if is_md {
            let _ = index.update_links_on_rename(space, from, &new_rel);
            let _ = index.update_file(space, &new_rel);
        }
    }

    Ok(new_rel)
}

/// Nest an entry: convert `foo.md` → `foo/readme.md`, making it a category.
/// Returns the new relative path (e.g. "foo/readme.md").
pub fn nest_entry(
    space: &Path,
    path: &str,
    backlink_index: Option<&BacklinkIndex>,
) -> Result<String, AppError> {
    let abs_path = space.join(path);

    if !abs_path.exists() {
        return Err(AppError::FileNotFound(path.to_string()));
    }

    // Only works on .md files, not directories
    if abs_path.is_dir() {
        return Err(AppError::General(
            "Path is already a directory".to_string(),
        ));
    }

    // Already a readme.md inside a folder — nothing to do
    let filename = abs_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    if filename.eq_ignore_ascii_case("readme.md") {
        return Ok(path.to_string());
    }

    // Determine the folder name: foo.md → foo/
    let stem = abs_path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::General("invalid filename".to_string()))?;

    let parent = abs_path.parent().unwrap_or(space);
    let folder = parent.join(stem);

    if folder.exists() {
        return Err(AppError::FileAlreadyExists(
            folder.to_string_lossy().to_string(),
        ));
    }

    // Create the folder and move the file into it as README.md
    fs::create_dir_all(&folder)?;
    let new_abs = folder.join("README.md");
    fs::rename(&abs_path, &new_abs)?;

    // Compute new relative path
    let new_rel = new_abs
        .strip_prefix(space)
        .unwrap_or(&new_abs)
        .to_string_lossy()
        .to_string();

    // Update backlinks
    if let Some(index) = backlink_index {
        let _ = index.update_links_on_rename(space, path, &new_rel);
        let _ = index.update_file(space, &new_rel);
    }

    Ok(new_rel)
}

/// Unnest an entry: convert `foo/readme.md` → `foo.md` when the folder has no
/// other children. Returns the new relative path (e.g. "foo.md").
/// If the folder still has children, returns an error.
pub fn unnest_entry(
    space: &Path,
    path: &str,
    backlink_index: Option<&BacklinkIndex>,
) -> Result<String, AppError> {
    let abs_path = space.join(path);

    if !abs_path.exists() {
        return Err(AppError::FileNotFound(path.to_string()));
    }

    // Must be a readme.md inside a folder
    let filename = abs_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    if !filename.eq_ignore_ascii_case("readme.md") {
        return Err(AppError::General(
            "Only readme.md inside a folder can be unnested".to_string(),
        ));
    }

    let folder = abs_path
        .parent()
        .ok_or_else(|| AppError::General("no parent directory".to_string()))?;

    // Check that the folder has no other children
    let siblings: Vec<_> = fs::read_dir(folder)?
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name();
            let s = name.to_string_lossy();
            !s.eq_ignore_ascii_case("readme.md") && !s.starts_with('.')
        })
        .collect();

    if !siblings.is_empty() {
        return Err(AppError::General(
            "Folder still has children, cannot unnest".to_string(),
        ));
    }

    // Move readme.md → folder_name.md at the parent level
    let folder_name = folder
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::General("invalid folder name".to_string()))?;
    let parent_dir = folder
        .parent()
        .ok_or_else(|| AppError::General("no parent for folder".to_string()))?;
    let new_abs = parent_dir.join(format!("{}.md", folder_name));

    if new_abs.exists() {
        return Err(AppError::FileAlreadyExists(
            new_abs.to_string_lossy().to_string(),
        ));
    }

    // Move the file out, then remove the empty folder
    fs::rename(&abs_path, &new_abs)?;
    let _ = fs::remove_dir(folder); // remove empty dir

    let new_rel = new_abs
        .strip_prefix(space)
        .unwrap_or(&new_abs)
        .to_string_lossy()
        .to_string();

    // Update backlinks
    if let Some(index) = backlink_index {
        let _ = index.update_links_on_rename(space, path, &new_rel);
        let _ = index.update_file(space, &new_rel);
    }

    Ok(new_rel)
}

/// Delete an entry from disk. Removes from backlink index if provided.
pub fn delete(
    space: &str,
    path: &str,
    backlink_index: Option<&BacklinkIndex>,
) -> Result<(), AppError> {
    let abs_path = resolve(space, path);

    if !abs_path.exists() {
        return Err(AppError::FileNotFound(path.to_string()));
    }

    if abs_path.is_dir() {
        fs::remove_dir_all(&abs_path)?;
    } else {
        fs::remove_file(&abs_path)?;
    }

    if let Some(index) = backlink_index {
        index.remove_file(path);
    }

    Ok(())
}

/// Rename/move an entry on disk.
pub fn rename(space: &str, from: &str, to: &str) -> Result<(), AppError> {
    let abs_from = resolve(space, from);
    let abs_to = resolve(space, to);

    if !abs_from.exists() {
        return Err(AppError::FileNotFound(from.to_string()));
    }

    if abs_to.exists() {
        return Err(AppError::FileAlreadyExists(to.to_string()));
    }

    // Ensure target parent directory exists
    if let Some(parent_dir) = abs_to.parent() {
        fs::create_dir_all(parent_dir)?;
    }

    fs::rename(&abs_from, &abs_to)?;

    // Update order.json: rename entry in parent's order list
    let old_name = Path::new(from)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let new_name = Path::new(to)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let parent_dir = Path::new(from)
        .parent()
        .unwrap_or(Path::new(""));
    let dir_key = if parent_dir.as_os_str().is_empty() {
        ".".to_string()
    } else {
        parent_dir.to_string_lossy().to_string()
    };
    let sp_path = Path::new(space);
    order_rename(sp_path, &dir_key, &old_name, &new_name);

    // If it's a directory, also rename the key in order.json
    if abs_to.is_dir() {
        let mut order = tree::read_order(sp_path);
        let old_key = if dir_key == "." {
            old_name
        } else {
            format!("{}/{}", dir_key, old_name)
        };
        if let Some(children) = order.remove(&old_key) {
            let new_key = if dir_key == "." {
                new_name
            } else {
                format!("{}/{}", dir_key, new_name)
            };
            order.insert(new_key, children);
            let _ = tree::write_order(sp_path, &order);
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_slugify_basic() {
        assert_eq!(slugify("Hello World"), "hello-world");
        assert_eq!(slugify("My Cool Page!"), "my-cool-page");
        assert_eq!(slugify("  Spaced  Out  "), "spaced-out");
        assert_eq!(slugify("CamelCase"), "camelcase");
    }

    #[test]
    fn test_slugify_cyrillic() {
        assert_eq!(slugify("Архитектура"), "arhitektura");
        assert_eq!(slugify("Привет мир"), "privet-mir");
        assert_eq!(slugify("Ёжик в тумане"), "yozhik-v-tumane");
        assert_eq!(slugify("Щука"), "shchuka");
    }

    #[test]
    fn test_slugify_mixed() {
        assert_eq!(slugify("My Документ"), "my-dokument");
        assert_eq!(slugify("Stage 1 Обзор"), "stage-1-obzor");
    }

    #[test]
    fn test_slugify_empty_and_fallback() {
        assert_eq!(slugify(""), "untitled");
        assert_eq!(slugify("!!!"), "untitled");
        // CJK characters are not transliterated → fallback
        assert_eq!(slugify("你好世界"), "untitled");
    }

    #[test]
    fn test_slugify_max_length() {
        // 70-char slug should be truncated at word boundary
        let long_title = "this is a very long title that should be truncated at a word boundary somewhere";
        let slug = slugify(long_title);
        assert!(slug.len() <= 60);
        assert!(!slug.ends_with('-'));
        assert_eq!(
            slug,
            "this-is-a-very-long-title-that-should-be-truncated-at-a"
        );
    }

    #[test]
    fn test_slugify_max_length_no_hyphen() {
        // A single very long word with no hyphens → hard truncate at 60
        let long_word = "a".repeat(80);
        let slug = slugify(&long_word);
        assert_eq!(slug.len(), 60);
    }

    #[test]
    fn test_create_collision_suffix() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path().to_str().unwrap();

        // Create first entry
        let e1 = create(ws, None, "Test Doc").unwrap();
        assert_eq!(e1.path, "test-doc.md");

        // Create second with same title → should get -1
        let e2 = create(ws, None, "Test Doc").unwrap();
        assert_eq!(e2.path, "test-doc-1.md");

        // Third → -2
        let e3 = create(ws, None, "Test Doc").unwrap();
        assert_eq!(e3.path, "test-doc-2.md");
    }

    #[test]
    fn test_create_collision_with_parent() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path().to_str().unwrap();

        let e1 = create(ws, Some("docs"), "readme").unwrap();
        assert_eq!(e1.path, "docs/readme.md");

        let e2 = create(ws, Some("docs"), "readme").unwrap();
        assert_eq!(e2.path, "docs/readme-1.md");
    }

    #[test]
    fn test_write_title_change_renames_file() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path().to_str().unwrap();

        let entry = create(ws, None, "Original Title").unwrap();
        assert_eq!(entry.path, "original-title.md");

        let result = write(
            ws,
            &entry.path,
            "body content",
            Some("New Title"),
            None,
            None,
            None,
            None,
        )
        .unwrap();

        assert_eq!(result.new_path, Some("new-title.md".to_string()));
        assert!(!resolve(ws, "original-title.md").exists());
        assert!(resolve(ws, "new-title.md").exists());
    }

    #[test]
    fn test_write_title_change_collision_no_rename() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path().to_str().unwrap();

        let e1 = create(ws, None, "Doc A").unwrap();
        let _e2 = create(ws, None, "Doc B").unwrap();

        // Try to rename Doc A to Doc B — collision, should save content but not rename
        let result = write(
            ws,
            &e1.path,
            "updated body",
            Some("Doc B"),
            None,
            None,
            None,
            None,
        )
        .unwrap();

        assert_eq!(result.new_path, None);
        // Original file still exists with updated content
        assert!(resolve(ws, "doc-a.md").exists());
    }

    #[test]
    fn test_write_same_title_no_rename() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path().to_str().unwrap();

        let entry = create(ws, None, "Keep Same").unwrap();

        let result = write(
            ws,
            &entry.path,
            "new body",
            Some("Keep Same"),
            None,
            None,
            None,
            None,
        )
        .unwrap();

        assert_eq!(result.new_path, None);
        assert!(resolve(ws, "keep-same.md").exists());
    }
}

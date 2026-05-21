use serde::{
    Deserialize, Serialize,
    ser::{SerializeStruct, Serializer},
};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::error::AppError;
use crate::files::backlinks::{BacklinkIndex, ModifiedLinkSource};
use crate::files::frontmatter;
use crate::files::tree;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ColorName {
    Neutral,
    Gray,
    Red,
    Orange,
    Yellow,
    Green,
    Blue,
    Purple,
    Pink,
    Brown,
}

impl ColorName {
    fn from_name(value: &str) -> Option<Self> {
        match value {
            "neutral" => Some(Self::Neutral),
            "gray" => Some(Self::Gray),
            "red" => Some(Self::Red),
            "orange" => Some(Self::Orange),
            "yellow" => Some(Self::Yellow),
            "green" => Some(Self::Green),
            "blue" => Some(Self::Blue),
            "purple" => Some(Self::Purple),
            "pink" => Some(Self::Pink),
            "brown" => Some(Self::Brown),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Cover {
    Color {
        value: ColorName,
    },
    Image {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        position: Option<u8>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WriteResult {
    /// New relative path if file was renamed, None if path unchanged.
    pub new_path: Option<String>,
    /// Files whose backlinks were updated due to rename.
    pub modified_files: Vec<String>,
    /// Files whose backlinks were updated, including cross-space source
    /// identity when project-aware rewrites are available.
    #[serde(default)]
    pub modified_sources: Vec<ModifiedLinkSource>,
    /// Short-TTL nonce associated with this write; attached to the watcher
    /// `file:changed` payload so the editor can drop its own echo.
    pub write_nonce: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EntryMeta {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover: Option<Cover>,
    pub created: String,
    pub updated: String,
    /// User-defined custom fields from frontmatter YAML.
    #[serde(flatten)]
    pub extra: HashMap<String, serde_yml::Value>,
}

impl Serialize for EntryMeta {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut state = serializer.serialize_struct("EntryMeta", 8)?;
        state.serialize_field("id", &self.id)?;
        state.serialize_field("title", &self.title)?;
        state.serialize_field("icon", &self.icon)?;
        state.serialize_field("description", &self.description)?;
        state.serialize_field("cover", &self.cover)?;
        state.serialize_field("created", &self.created)?;
        state.serialize_field("updated", &self.updated)?;
        state.serialize_field("extra", &self.extra)?;
        state.end()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub meta: EntryMeta,
    pub body: String,
    /// Relative path from space root.
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryDetailForm {
    Leaf,
    Folder,
    NestedCollection,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryDetailState {
    pub form: EntryDetailForm,
    pub subpage_count: usize,
    pub other_file_count: usize,
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

fn meta_for_file_without_frontmatter(abs_path: &Path, path: &str) -> Result<EntryMeta, AppError> {
    let fs_meta = fs::metadata(abs_path)?;
    let created = system_time_to_rfc3339(fs_meta.created());
    let updated = system_time_to_rfc3339(fs_meta.modified());

    let stem = Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("untitled");
    let title = title_from_stem(stem);

    Ok(EntryMeta {
        id: ulid::Ulid::new().to_string().to_lowercase(),
        title,
        icon: None,
        description: None,
        cover: None,
        created,
        updated,
        extra: HashMap::new(),
    })
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

fn order_insert_after(space: &Path, dir_key: &str, after_name: &str, name: &str) {
    let mut order = tree::read_order(space);
    let list = order.entry(dir_key.to_string()).or_default();
    if list.iter().any(|item| item == name) {
        return;
    }
    if let Some(pos) = list.iter().position(|item| item == after_name) {
        list.insert(pos + 1, name.to_string());
    } else {
        list.push(name.to_string());
    }
    let _ = tree::write_order(space, &order);
}

fn order_remove_key(space: &Path, dir_key: &str) {
    let mut order = tree::read_order(space);
    if order.remove(dir_key).is_some() {
        let _ = tree::write_order(space, &order);
    }
}

fn dir_key_for(parent: &Path) -> String {
    if parent.as_os_str().is_empty() {
        ".".to_string()
    } else {
        parent.to_string_lossy().replace('\\', "/")
    }
}

fn rel_from_abs(space: &Path, path: &Path) -> String {
    path.strip_prefix(space)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn humanize_slug(name: &str) -> String {
    let mut chars = name.replace(['-', '_'], " ").chars().collect::<Vec<_>>();
    if let Some(first) = chars.first_mut() {
        first.make_ascii_uppercase();
    }
    chars.into_iter().collect()
}

fn unique_child_path(parent: &Path, stem: &str, extension: Option<&str>) -> PathBuf {
    let make = |candidate: &str| match extension {
        Some(ext) => parent.join(format!("{candidate}.{ext}")),
        None => parent.join(candidate),
    };
    let first = make(stem);
    if !first.exists() {
        return first;
    }
    for i in 1..=1000 {
        let candidate = make(&format!("{stem}-{i}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    make(&format!(
        "{stem}-{}",
        ulid::Ulid::new().to_string().to_lowercase()
    ))
}

fn collect_entry_md_files(root: &Path, out: &mut Vec<PathBuf>) -> Result<(), AppError> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            collect_entry_md_files(&path, out)?;
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("md") {
            out.push(path);
        }
    }
    Ok(())
}

fn find_entry_path_by_id(space: &Path, entry_id: &str) -> Result<String, AppError> {
    let mut files = Vec::new();
    collect_entry_md_files(space, &mut files)?;
    for file in files {
        let raw = fs::read_to_string(&file)?;
        let Some((meta, _)) = frontmatter::try_parse(&raw)? else {
            continue;
        };
        if meta.id == entry_id {
            return Ok(rel_from_abs(space, &file));
        }
    }
    Err(AppError::FileNotFound(entry_id.to_string()))
}

fn refresh_markdown_identity(path: &Path, title_suffix: Option<&str>) -> Result<(), AppError> {
    let raw = fs::read_to_string(path)?;
    let Some((mut meta, body)) = frontmatter::try_parse(&raw)? else {
        return Ok(());
    };
    meta.id = ulid::Ulid::new().to_string().to_lowercase();
    let now = now_rfc3339();
    meta.created = now.clone();
    meta.updated = now;
    if let Some(suffix) = title_suffix {
        meta.title.push_str(suffix);
    }
    fs::write(path, frontmatter::serialize(&meta, &body))?;
    Ok(())
}

/// Create a new entry on disk. Returns the created Entry.
pub fn create(space: &str, parent_path: Option<&str>, title: &str) -> Result<Entry, AppError> {
    create_with_contextual_defaults(space, parent_path, title, None)
}

/// Create a new entry on disk with optional schema-validated contextual defaults.
pub fn create_with_contextual_defaults(
    space: &str,
    parent_path: Option<&str>,
    title: &str,
    contextual_defaults: Option<HashMap<String, serde_yml::Value>>,
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
            found.ok_or_else(|| AppError::FileAlreadyExists(make_rel(&slug)))?
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
        description: None,
        cover: None,
        created: now.clone(),
        updated: now,
        extra: HashMap::new(),
    };
    let mut meta = meta;
    crate::properties::apply_schema_defaults_for_path(space, &rel_path, &mut meta)?;
    if let Some(contextual_defaults) = contextual_defaults.as_ref() {
        crate::properties::apply_contextual_defaults_for_path(
            space,
            &rel_path,
            &mut meta,
            contextual_defaults,
        )?;
    }

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
            let meta = meta_for_file_without_frontmatter(&abs_path, path)?;

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
    skip_rename: bool,
) -> Result<WriteResult, AppError> {
    let abs_path = resolve(space, path);

    if !abs_path.exists() {
        return Err(AppError::FileNotFound(path.to_string()));
    }

    // Fresh nonce attached to every WriteResult (including no-op early returns)
    // so the watcher can associate its `file:changed` event with the caller's
    // write and the frontend can filter own-write echoes.
    let write_nonce = ulid::Ulid::new().to_string().to_lowercase();

    // Read existing frontmatter to preserve metadata
    let existing = fs::read_to_string(&abs_path)?;
    let parsed_existing = frontmatter::try_parse(&existing)?;
    let had_frontmatter = parsed_existing.is_some();
    let meta_needs_write = had_frontmatter || title.is_some() || icon.is_some() || extra.is_some();

    let mut meta = if meta_needs_write {
        match parsed_existing.clone() {
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
                        Path::new(path)
                            .file_stem()
                            .and_then(|s| s.to_str())
                            .unwrap_or("untitled"),
                    ),
                    icon: None,
                    description: None,
                    cover: None,
                    created,
                    updated: String::new(),
                    extra: HashMap::new(),
                }
            }
        }
    } else {
        // Body-only save on a file without frontmatter — write content as-is,
        // skipping the write entirely if nothing changed (avoids spurious commits).
        if existing == content {
            return Ok(WriteResult {
                new_path: None,
                modified_files: Vec::new(),
                modified_sources: Vec::new(),
                write_nonce,
            });
        }
        fs::write(&abs_path, content)?;
        return Ok(WriteResult {
            new_path: None,
            modified_files: Vec::new(),
            modified_sources: Vec::new(),
            write_nonce,
        });
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

    // On ⌘S, a rename may be pending even when body/meta match on-disk state —
    // auto-save debounce (`skip_rename=true`) already persisted the new title
    // to frontmatter, so `old_meta.title == meta.title` does not imply the
    // filename matches the slug. Compute rename-needed up-front to keep the
    // no-op short-circuit from swallowing the ⌘S materialize.
    let rename_needed = !skip_rename
        && title.is_some_and(|t| {
            let new_slug = slugify(t);
            let current_stem = Path::new(path)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("");
            let is_readme = Path::new(path)
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.eq_ignore_ascii_case("readme.md"));
            new_slug != current_stem || is_readme
        });

    // Skip the write entirely if neither body nor meta (ignoring `updated`)
    // changed AND no rename is pending. Otherwise every Cmd+S would bump
    // `updated` and create an empty commit even though the user typed nothing.
    if let Some((ref old_meta, ref old_body)) = parsed_existing {
        if !rename_needed
            && old_body == content
            && old_meta.id == meta.id
            && old_meta.title == meta.title
            && old_meta.icon == meta.icon
            && old_meta.description == meta.description
            && old_meta.cover == meta.cover
            && old_meta.created == meta.created
            && old_meta.extra == meta.extra
        {
            return Ok(WriteResult {
                new_path: None,
                modified_files: Vec::new(),
                modified_sources: Vec::new(),
                write_nonce,
            });
        }
    }

    // Update the timestamp only once we know something actually changed.
    meta.updated = now_rfc3339();

    let full_content = frontmatter::serialize(&meta, content);
    fs::write(&abs_path, full_content)?;

    // Auto-save path: frontmatter + body are already on disk above. Don't
    // rename, don't touch order.json, don't update backlinks in other files.
    // Still re-index the current file so link targets stay fresh.
    if skip_rename {
        if let Some(index) = backlink_index {
            let _ = index.update_file(Path::new(space), path);
        }
        return Ok(WriteResult {
            new_path: None,
            modified_files: Vec::new(),
            modified_sources: Vec::new(),
            write_nonce,
        });
    }

    // Materialize rename when slug(title) diverges from filename stem.
    // Gate by title-change-since-last-read would miss renames when auto-save
    // debounce already persisted the new title to frontmatter before ⌘S.
    let mut new_path: Option<String> = None;

    if let Some(t) = title {
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
                        let grandparent = parent_rel.parent().unwrap_or(Path::new(""));
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
                            if let Err(error) = crate::properties::rename_template_slug_references(
                                space,
                                path,
                                &renamed_path,
                            ) {
                                let _ = fs::rename(&new_dir_abs, &old_dir_abs);
                                return Err(error);
                            }
                            new_path = Some(renamed_path);
                        }
                        // If collision, content is already saved, just skip rename
                    }
                }
            } else {
                // Regular file: rename slug.md
                let parent_dir = Path::new(path).parent().unwrap_or(Path::new(""));
                let new_filename = format!("{new_slug}.md");
                let new_rel = if parent_dir.as_os_str().is_empty() {
                    new_filename
                } else {
                    format!("{}/{}", parent_dir.display(), new_filename)
                };
                let new_abs = resolve(space, &new_rel);

                if !new_abs.exists() {
                    fs::rename(&abs_path, &new_abs)?;
                    if let Err(error) =
                        crate::properties::rename_template_slug_references(space, path, &new_rel)
                    {
                        let _ = fs::rename(&new_abs, &abs_path);
                        return Err(error);
                    }
                    new_path = Some(new_rel);
                }
                // If collision, content is already saved, just skip rename
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
            let parent_dir = Path::new(path).parent().unwrap_or(Path::new(""));
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
        // If renamed, update links in other files. Pass the new title so
        // display text gets refreshed too when it was derived from the old
        // filename stem.
        if let Some(ref np) = new_path {
            modified_files = index
                .update_links_on_rename(Path::new(space), path, np, Some(&meta.title))
                .unwrap_or_default();

            // Readme rename renames the parent folder — every descendant now
            // sits under a new path, so backlinks to those descendants must be
            // rewritten too (URL only, their own titles didn't change).
            let is_readme = Path::new(path)
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.eq_ignore_ascii_case("readme.md"));
            if is_readme {
                let old_folder = Path::new(path)
                    .parent()
                    .map(|p| p.to_string_lossy().to_string());
                let new_folder = Path::new(np)
                    .parent()
                    .map(|p| p.to_string_lossy().to_string());
                if let (Some(of), Some(nf)) = (old_folder, new_folder) {
                    if !of.is_empty() && of != nf {
                        let descendants = index
                            .update_links_on_folder_rename(Path::new(space), &of, &nf)
                            .unwrap_or_default();
                        for m in descendants {
                            if !modified_files.contains(&m) {
                                modified_files.push(m);
                            }
                        }
                    }
                }
            }
        }
        // Re-index the written file
        let _ = index.update_file(Path::new(space), current_path);
    }

    Ok(WriteResult {
        new_path,
        modified_sources: modified_files
            .iter()
            .map(|path| ModifiedLinkSource {
                space_id: None,
                path: path.clone(),
            })
            .collect(),
        modified_files,
        write_nonce,
    })
}

fn invalid_entry_field(message: impl Into<String>) -> AppError {
    AppError::General(format!("invalid entry field: {}", message.into()))
}

fn expect_string(value: serde_json::Value, field: &str) -> Result<String, AppError> {
    match value {
        serde_json::Value::String(s) => Ok(s),
        _ => Err(invalid_entry_field(format!("{field} must be a string"))),
    }
}

fn cover_from_json(value: serde_json::Value) -> Result<Cover, AppError> {
    let serde_json::Value::Object(mut object) = value else {
        return Err(invalid_entry_field("cover must be an object or null"));
    };

    let cover_type = object
        .remove("type")
        .and_then(|v| v.as_str().map(ToOwned::to_owned))
        .ok_or_else(|| invalid_entry_field("cover.type must be 'color' or 'image'"))?;

    match cover_type.as_str() {
        "color" => {
            let value = object
                .remove("value")
                .and_then(|v| v.as_str().map(ToOwned::to_owned))
                .ok_or_else(|| invalid_entry_field("cover.value must be a color name"))?;
            let value = ColorName::from_name(&value).ok_or_else(|| {
                invalid_entry_field(
                    "cover.value must be one of neutral, gray, red, orange, yellow, green, blue, purple, pink, brown",
                )
            })?;
            Ok(Cover::Color { value })
        }
        "image" => {
            let path = object
                .remove("path")
                .and_then(|v| v.as_str().map(ToOwned::to_owned))
                .ok_or_else(|| invalid_entry_field("cover.path must be a string"))?;
            let position = match object.remove("position") {
                None | Some(serde_json::Value::Null) => None,
                Some(serde_json::Value::Number(n)) => {
                    let pos = n
                        .as_u64()
                        .ok_or_else(|| invalid_entry_field("cover.position must be 0..=100"))?;
                    if pos > 100 {
                        return Err(invalid_entry_field("cover.position must be 0..=100"));
                    }
                    Some(pos as u8)
                }
                Some(_) => return Err(invalid_entry_field("cover.position must be 0..=100")),
            };
            Ok(Cover::Image { path, position })
        }
        _ => Err(invalid_entry_field(
            "cover.type must be either 'color' or 'image'",
        )),
    }
}

pub(crate) fn apply_entry_field_update(
    meta: &mut EntryMeta,
    field: &str,
    value: serde_json::Value,
) -> Result<(), AppError> {
    match field {
        "id" | "created" | "updated" => Err(invalid_entry_field(format!("{field} is read-only"))),
        "title" => {
            meta.title = expect_string(value, "title")?;
            Ok(())
        }
        "icon" => {
            meta.icon = match value {
                serde_json::Value::Null => None,
                v => Some(expect_string(v, "icon")?),
            };
            Ok(())
        }
        "description" => {
            meta.description = match value {
                serde_json::Value::Null => None,
                serde_json::Value::String(s) => {
                    if s.chars().count() > 500 {
                        return Err(invalid_entry_field(
                            "description must be at most 500 characters",
                        ));
                    }
                    if s.is_empty() { None } else { Some(s) }
                }
                _ => return Err(invalid_entry_field("description must be a string or null")),
            };
            Ok(())
        }
        "cover" => {
            meta.cover = match value {
                serde_json::Value::Null => None,
                v => Some(cover_from_json(v)?),
            };
            Ok(())
        }
        custom => {
            if value.is_null() {
                meta.extra.remove(custom);
            } else {
                let yaml_value = serde_yml::to_value(value)
                    .map_err(|e| invalid_entry_field(format!("{custom}: {e}")))?;
                meta.extra.insert(custom.to_string(), yaml_value);
            }
            Ok(())
        }
    }
}

pub fn update_field(
    space: &str,
    path: &str,
    field: &str,
    value: serde_json::Value,
) -> Result<Entry, AppError> {
    if !matches!(
        field,
        "id" | "created" | "updated" | "title" | "icon" | "description" | "cover"
    ) {
        let yaml_value = serde_yml::to_value(value.clone())
            .map_err(|e| invalid_entry_field(format!("{field}: {e}")))?;
        if let Some(entry) =
            crate::properties::update_relation_entry_field(space, path, field, yaml_value)?
        {
            return Ok(entry);
        }
    }

    let abs_path = resolve(space, path);

    if !abs_path.exists() {
        return Err(AppError::FileNotFound(path.to_string()));
    }

    let content = fs::read_to_string(&abs_path)?;
    let (mut meta, body) = match frontmatter::try_parse(&content)? {
        Some((meta, body)) => (meta, body),
        None => (meta_for_file_without_frontmatter(&abs_path, path)?, content),
    };

    if !matches!(
        field,
        "id" | "created" | "updated" | "title" | "icon" | "description" | "cover"
    ) && !value.is_null()
    {
        let yaml_value = serde_yml::to_value(value.clone())
            .map_err(|e| invalid_entry_field(format!("{field}: {e}")))?;
        crate::properties::validate_entry_field_value(space, path, field, &yaml_value)?;
    }

    apply_entry_field_update(&mut meta, field, value)?;
    meta.updated = now_rfc3339();

    let full_content = frontmatter::serialize(&meta, &body);
    fs::write(&abs_path, full_content)?;

    Ok(Entry {
        meta,
        body,
        path: path.to_string(),
    })
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

    let from_is_dir = abs_from.is_dir();
    let is_md = from_is_dir || Path::new(from).extension().and_then(|e| e.to_str()) == Some("md");

    // Ensure target parent directory exists
    if let Some(parent_dir) = abs_to.parent() {
        fs::create_dir_all(parent_dir)?;
    }

    fs::rename(&abs_from, &abs_to)?;
    crate::properties::apply_schema_defaults_to_entry_tree(space, &new_rel)?;
    crate::properties::rewrite_relation_paths_for_move(&space.to_string_lossy(), from, &new_rel)?;

    // Update backlinks. For folder moves, every .md descendant sits under a
    // new path now — rewrite their inbound links too, not just the folder itself
    // (which isn't even a .md target).
    if let Some(index) = backlink_index {
        if from_is_dir {
            let _ = index.update_links_on_folder_rename(space, from, &new_rel);
        } else if is_md {
            let _ = index.update_links_on_rename(space, from, &new_rel, None);
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
        return Err(AppError::General("Path is already a directory".to_string()));
    }

    // Already a readme.md inside a folder — nothing to do
    let filename = abs_path.file_name().and_then(|n| n.to_str()).unwrap_or("");
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
    crate::properties::rewrite_relation_paths_for_move(&space.to_string_lossy(), path, &new_rel)?;

    // Update backlinks
    if let Some(index) = backlink_index {
        let _ = index.update_links_on_rename(space, path, &new_rel, None);
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
    let filename = abs_path.file_name().and_then(|n| n.to_str()).unwrap_or("");
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
    crate::properties::rewrite_relation_paths_for_move(&space.to_string_lossy(), path, &new_rel)?;

    // Update backlinks
    if let Some(index) = backlink_index {
        let _ = index.update_links_on_rename(space, path, &new_rel, None);
        let _ = index.update_file(space, &new_rel);
    }

    Ok(new_rel)
}

pub fn convert_entry_to_folder(
    space: &Path,
    entry_id: &str,
    backlink_index: Option<&BacklinkIndex>,
) -> Result<Entry, AppError> {
    let path = find_entry_path_by_id(space, entry_id)?;
    let abs_path = space.join(&path);
    if abs_path.is_dir()
        || path
            .rsplit('/')
            .next()
            .is_some_and(|name| name.eq_ignore_ascii_case("README.md"))
    {
        return Err(AppError::General("entry is already a folder".to_string()));
    }
    if abs_path.extension().and_then(|ext| ext.to_str()) != Some("md") {
        return Err(AppError::General(
            "entry must be a markdown leaf".to_string(),
        ));
    }

    let stem = abs_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or_else(|| AppError::General("invalid entry filename".to_string()))?;
    let parent_abs = abs_path.parent().unwrap_or(space);
    let folder_abs = parent_abs.join(stem);
    if folder_abs.exists() {
        return Err(AppError::FileAlreadyExists(rel_from_abs(
            space,
            &folder_abs,
        )));
    }
    fs::create_dir_all(&folder_abs)?;
    let new_abs = folder_abs.join("README.md");
    fs::rename(&abs_path, &new_abs)?;
    let new_rel = rel_from_abs(space, &new_abs);
    crate::properties::rewrite_relation_paths_for_move(&space.to_string_lossy(), &path, &new_rel)?;

    let parent_rel = Path::new(&path).parent().unwrap_or(Path::new(""));
    let dir_key = dir_key_for(parent_rel);
    let old_name = Path::new(&path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    order_rename(space, &dir_key, &old_name, stem);

    if let Some(index) = backlink_index {
        let _ = index.update_links_on_rename(space, &path, &new_rel, None);
        let _ = index.update_file(space, &new_rel);
    }
    read(&space.to_string_lossy(), &new_rel)
}

pub fn entry_detail_state(space: &Path, path: &str) -> Result<EntryDetailState, AppError> {
    let rel = path.trim_matches('/').replace('\\', "/");
    let abs = space.join(&rel);
    if abs.is_dir() {
        if !dir_has_readme(&abs) {
            return Err(AppError::FileNotFound(rel));
        }
        let (subpage_count, other_file_count) = folder_child_counts(&abs)?;
        return Ok(EntryDetailState {
            form: if abs.join("schema.yaml").exists() {
                EntryDetailForm::NestedCollection
            } else {
                EntryDetailForm::Folder
            },
            subpage_count,
            other_file_count,
        });
    }

    if !abs.exists() {
        return Err(AppError::FileNotFound(rel));
    }

    let is_readme = abs
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("README.md"));
    if !is_readme {
        return Ok(EntryDetailState {
            form: EntryDetailForm::Leaf,
            subpage_count: 0,
            other_file_count: 0,
        });
    }

    let folder = abs
        .parent()
        .ok_or_else(|| AppError::General("README.md has no parent folder".to_string()))?;
    let (subpage_count, other_file_count) = folder_child_counts(folder)?;
    Ok(EntryDetailState {
        form: if folder.join("schema.yaml").exists() {
            EntryDetailForm::NestedCollection
        } else {
            EntryDetailForm::Folder
        },
        subpage_count,
        other_file_count,
    })
}

fn folder_child_counts(folder: &Path) -> Result<(usize, usize), AppError> {
    let mut subpage_count = 0;
    let mut other_file_count = 0;

    for item in fs::read_dir(folder)? {
        let item = item?;
        let name = item.file_name().to_string_lossy().to_string();
        if name.starts_with('.')
            || name.eq_ignore_ascii_case("README.md")
            || name.eq_ignore_ascii_case("schema.yaml")
        {
            continue;
        }

        let path = item.path();
        if path.is_dir() {
            if dir_has_readme(&path) {
                subpage_count += 1;
            } else {
                other_file_count += 1;
            }
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("md") {
            subpage_count += 1;
        } else {
            other_file_count += 1;
        }
    }

    Ok((subpage_count, other_file_count))
}

fn dir_has_readme(dir: &Path) -> bool {
    fs::read_dir(dir)
        .ok()
        .into_iter()
        .flat_map(|items| items.filter_map(Result::ok))
        .any(|item| {
            item.path().is_file()
                && item
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.eq_ignore_ascii_case("README.md"))
        })
}

pub fn convert_entry_to_leaf(
    space: &Path,
    entry_id: &str,
    backlink_index: Option<&BacklinkIndex>,
) -> Result<Entry, AppError> {
    let path = find_entry_path_by_id(space, entry_id)?;
    let readme_abs = space.join(&path);
    if !readme_abs
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("README.md"))
    {
        return Err(AppError::General(
            "only folder README.md can be converted to leaf".to_string(),
        ));
    }
    let folder_abs = readme_abs
        .parent()
        .ok_or_else(|| AppError::General("README.md has no parent folder".to_string()))?;
    if folder_abs.join("schema.yaml").exists() {
        return Err(AppError::General(
            "EntryNotEmpty { entries: [], folders: [], other: [\"schema.yaml\"] }".to_string(),
        ));
    }

    let mut entries = Vec::new();
    let mut folders = Vec::new();
    let mut other = Vec::new();
    for item in fs::read_dir(folder_abs)? {
        let item = item?;
        let name = item.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name.eq_ignore_ascii_case("README.md") {
            continue;
        }
        let item_path = item.path();
        if item_path.is_dir() {
            folders.push(name);
        } else if item_path.extension().and_then(|ext| ext.to_str()) == Some("md") {
            entries.push(name);
        } else {
            other.push(name);
        }
    }
    if !entries.is_empty() || !folders.is_empty() || !other.is_empty() {
        return Err(AppError::General(format!(
            "EntryNotEmpty {{ entries: {:?}, folders: {:?}, other: {:?} }}",
            entries, folders, other
        )));
    }

    let folder_name = folder_abs
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppError::General("invalid folder name".to_string()))?;
    let parent_abs = folder_abs
        .parent()
        .ok_or_else(|| AppError::General("folder has no parent".to_string()))?;
    let leaf_abs = parent_abs.join(format!("{folder_name}.md"));
    if leaf_abs.exists() {
        return Err(AppError::FileAlreadyExists(rel_from_abs(space, &leaf_abs)));
    }
    fs::rename(&readme_abs, &leaf_abs)?;
    let _ = fs::remove_dir_all(folder_abs);
    let new_rel = rel_from_abs(space, &leaf_abs);
    crate::properties::rewrite_relation_paths_for_move(&space.to_string_lossy(), &path, &new_rel)?;

    let parent_rel = Path::new(&path)
        .parent()
        .and_then(Path::parent)
        .unwrap_or(Path::new(""));
    let dir_key = dir_key_for(parent_rel);
    order_rename(space, &dir_key, folder_name, &format!("{folder_name}.md"));
    let child_key = if dir_key == "." {
        folder_name.to_string()
    } else {
        format!("{}/{}", dir_key, folder_name)
    };
    order_remove_key(space, &child_key);

    if let Some(index) = backlink_index {
        let _ = index.update_links_on_rename(space, &path, &new_rel, None);
        let _ = index.update_file(space, &new_rel);
    }
    read(&space.to_string_lossy(), &new_rel)
}

pub fn convert_entry_to_nested_collection(
    space: &Path,
    entry_id: &str,
) -> Result<String, AppError> {
    let path = find_entry_path_by_id(space, entry_id)?;
    let readme_abs = space.join(&path);
    if !readme_abs
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("README.md"))
    {
        return Err(AppError::General(
            "entry must be converted to folder before making a collection".to_string(),
        ));
    }
    let folder_rel = Path::new(&path)
        .parent()
        .map(|parent| parent.to_string_lossy().replace('\\', "/"))
        .ok_or_else(|| AppError::General("README.md has no parent folder".to_string()))?;
    let schema_abs = space.join(&folder_rel).join("schema.yaml");
    if schema_abs.exists() {
        return Err(AppError::FileAlreadyExists(rel_from_abs(
            space,
            &schema_abs,
        )));
    }
    crate::properties::write_default_collection_schema(&space.to_string_lossy(), &folder_rel)?;
    Ok(folder_rel)
}

pub fn convert_bare_folder_to_collection(
    space: &Path,
    folder_path: &str,
) -> Result<Entry, AppError> {
    let rel = folder_path.trim_matches('/').replace('\\', "/");
    let folder_abs = space.join(&rel);
    if !folder_abs.is_dir() {
        return Err(AppError::FileNotFound(rel));
    }
    let readme_abs = folder_abs.join("README.md");
    let schema_abs = folder_abs.join("schema.yaml");
    if readme_abs.exists() {
        return Err(AppError::FileAlreadyExists(rel_from_abs(
            space,
            &readme_abs,
        )));
    }
    if schema_abs.exists() {
        return Err(AppError::FileAlreadyExists(rel_from_abs(
            space,
            &schema_abs,
        )));
    }

    let folder_name = folder_abs
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Collection");
    let now = now_rfc3339();
    let mut meta = EntryMeta {
        id: ulid::Ulid::new().to_string().to_lowercase(),
        title: humanize_slug(folder_name),
        icon: None,
        description: None,
        cover: None,
        created: now.clone(),
        updated: now,
        extra: HashMap::new(),
    };
    crate::properties::apply_schema_defaults_for_path(
        &space.to_string_lossy(),
        &format!("{rel}/README.md"),
        &mut meta,
    )?;
    fs::write(&readme_abs, frontmatter::serialize(&meta, ""))?;
    crate::properties::write_default_collection_schema(&space.to_string_lossy(), &rel)?;
    read(&space.to_string_lossy(), &format!("{rel}/README.md"))
}

pub fn duplicate_entry(space: &Path, file_path: &str) -> Result<Entry, AppError> {
    let rel = file_path.trim_matches('/').replace('\\', "/");
    let source_abs = space.join(&rel);
    if !source_abs.exists() {
        return Err(AppError::FileNotFound(rel));
    }

    let (root_source_abs, source_order_name, parent_abs, root_head_rel) = if source_abs.is_dir() {
        let parent = source_abs.parent().unwrap_or(space).to_path_buf();
        let order_name = source_abs
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let head = source_abs.join("README.md");
        let head_rel = rel_from_abs(space, &head);
        (source_abs.clone(), order_name, parent, head_rel)
    } else if source_abs
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("README.md"))
    {
        let folder = source_abs
            .parent()
            .ok_or_else(|| AppError::General("README.md has no parent folder".to_string()))?;
        let parent = folder.parent().unwrap_or(space).to_path_buf();
        let order_name = folder
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        (folder.to_path_buf(), order_name, parent, rel.clone())
    } else {
        let parent = source_abs.parent().unwrap_or(space).to_path_buf();
        let order_name = source_abs
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        (source_abs.clone(), order_name, parent, rel.clone())
    };

    let copy_title = read(&space.to_string_lossy(), &root_head_rel)
        .map(|entry| format!("{} (copy)", entry.meta.title))
        .unwrap_or_else(|_| format!("{} (copy)", source_order_name));
    let copy_stem = slugify(&copy_title);
    let dest_abs = if root_source_abs.is_dir() {
        unique_child_path(&parent_abs, &copy_stem, None)
    } else {
        unique_child_path(&parent_abs, &copy_stem, Some("md"))
    };

    if root_source_abs.is_dir() {
        copy_dir_recursive(&root_source_abs, &dest_abs)?;
        let head = dest_abs.join("README.md");
        if head.exists() {
            refresh_markdown_identity(&head, Some(" (copy)"))?;
        }
        let mut files = Vec::new();
        collect_entry_md_files(&dest_abs, &mut files)?;
        for file in files {
            if file != head {
                refresh_markdown_identity(&file, None)?;
            }
        }
    } else {
        fs::copy(&root_source_abs, &dest_abs)?;
        refresh_markdown_identity(&dest_abs, Some(" (copy)"))?;
    }

    crate::properties::rewrite_internal_relation_refs_for_copy(
        &space.to_string_lossy(),
        &rel_from_abs(space, &root_source_abs),
        &rel_from_abs(space, &dest_abs),
    )?;

    let dir_key = rel_from_abs(space, &parent_abs);
    let dir_key = if dir_key.is_empty() {
        ".".to_string()
    } else {
        dir_key
    };
    let dest_order_name = dest_abs
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    order_insert_after(space, &dir_key, &source_order_name, &dest_order_name);

    let entry_rel = if dest_abs.is_dir() {
        rel_from_abs(space, &dest_abs.join("README.md"))
    } else {
        rel_from_abs(space, &dest_abs)
    };
    read(&space.to_string_lossy(), &entry_rel)
}

fn copy_dir_recursive(source: &Path, dest: &Path) -> Result<(), AppError> {
    fs::create_dir_all(dest)?;
    for item in fs::read_dir(source)? {
        let item = item?;
        if item.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let source_path = item.path();
        let dest_path = dest.join(item.file_name());
        if source_path.is_dir() {
            copy_dir_recursive(&source_path, &dest_path)?;
        } else {
            fs::copy(&source_path, &dest_path)?;
        }
    }
    Ok(())
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

    let deleted_paths = collect_deleted_entry_paths(Path::new(space), &abs_path)?;
    crate::properties::cascade_clean_deleted_entries(space, &deleted_paths)?;

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

fn collect_deleted_entry_paths(space: &Path, abs_path: &Path) -> Result<Vec<String>, AppError> {
    if abs_path.is_dir() {
        let mut files = Vec::new();
        collect_entry_md_files(abs_path, &mut files)?;
        Ok(files
            .into_iter()
            .map(|file| rel_from_abs(space, &file))
            .collect())
    } else {
        Ok(vec![rel_from_abs(space, abs_path)])
    }
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
    crate::properties::rewrite_relation_paths_for_move(space, from, to)?;

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
    let parent_dir = Path::new(from).parent().unwrap_or(Path::new(""));
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
        let long_title =
            "this is a very long title that should be truncated at a word boundary somewhere";
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

    fn test_meta() -> EntryMeta {
        EntryMeta {
            id: "01abc".into(),
            title: "Title".into(),
            icon: None,
            description: None,
            cover: None,
            created: "2026-03-17T00:00:00Z".into(),
            updated: "2026-03-17T00:00:00Z".into(),
            extra: HashMap::new(),
        }
    }

    #[test]
    fn test_update_field_validates_description() {
        let mut meta = test_meta();
        apply_entry_field_update(
            &mut meta,
            "description",
            serde_json::Value::String("Summary".into()),
        )
        .unwrap();
        assert_eq!(meta.description.as_deref(), Some("Summary"));

        apply_entry_field_update(
            &mut meta,
            "description",
            serde_json::Value::String(String::new()),
        )
        .unwrap();
        assert_eq!(meta.description, None);

        let err = apply_entry_field_update(
            &mut meta,
            "description",
            serde_json::Value::String("x".repeat(501)),
        )
        .unwrap_err();
        assert!(err.to_string().contains("500"));
    }

    #[test]
    fn test_update_field_validates_cover() {
        let mut meta = test_meta();
        apply_entry_field_update(
            &mut meta,
            "cover",
            serde_json::json!({ "type": "color", "value": "blue" }),
        )
        .unwrap();
        assert_eq!(
            meta.cover,
            Some(Cover::Color {
                value: ColorName::Blue,
            })
        );

        apply_entry_field_update(
            &mut meta,
            "cover",
            serde_json::json!({ "type": "image", "path": ".assets/cover.jpg", "position": 100 }),
        )
        .unwrap();
        assert_eq!(
            meta.cover,
            Some(Cover::Image {
                path: ".assets/cover.jpg".into(),
                position: Some(100),
            })
        );

        let err = apply_entry_field_update(
            &mut meta,
            "cover",
            serde_json::json!({ "type": "image", "path": ".assets/cover.jpg", "position": 101 }),
        )
        .unwrap_err();
        assert!(err.to_string().contains("0..=100"));
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
            false,
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
            false,
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
            false,
        )
        .unwrap();

        assert_eq!(result.new_path, None);
        assert!(resolve(ws, "keep-same.md").exists());
    }
}

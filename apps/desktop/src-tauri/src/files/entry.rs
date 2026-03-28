use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::error::AppError;
use crate::files::frontmatter;

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
    /// Relative path from workspace root.
    pub path: String,
}

/// Resolve an absolute path from workspace root + relative path.
fn resolve(workspace: &str, rel: &str) -> PathBuf {
    Path::new(workspace).join(rel)
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

/// Create a new entry on disk. Returns the created Entry.
pub fn create(
    workspace: &str,
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
        let base_abs = resolve(workspace, &base_rel);

        if !base_abs.exists() {
            (base_rel, base_abs)
        } else {
            let mut found = None;
            for i in 1..=100 {
                let candidate = format!("{slug}-{i}");
                let rel = make_rel(&candidate);
                let abs = resolve(workspace, &rel);
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

    Ok(Entry {
        meta,
        body: body.to_string(),
        path: rel_path,
    })
}

/// Read an entry from disk.
pub fn read(workspace: &str, path: &str) -> Result<Entry, AppError> {
    let abs_path = resolve(workspace, path);

    if !abs_path.exists() {
        return Err(AppError::FileNotFound(path.to_string()));
    }

    let content = fs::read_to_string(&abs_path)?;
    let (meta, body) = frontmatter::parse(&content)?;

    Ok(Entry {
        meta,
        body,
        path: path.to_string(),
    })
}

/// Write content to an entry, updating the `updated` field in frontmatter.
/// Optionally update title, icon, and custom fields if provided.
pub fn write(
    workspace: &str,
    path: &str,
    content: &str,
    title: Option<&str>,
    icon: Option<&str>,
    extra: Option<HashMap<String, serde_yml::Value>>,
) -> Result<(), AppError> {
    let abs_path = resolve(workspace, path);

    if !abs_path.exists() {
        return Err(AppError::FileNotFound(path.to_string()));
    }

    // Read existing frontmatter to preserve metadata
    let existing = fs::read_to_string(&abs_path)?;
    let (mut meta, _old_body) = frontmatter::parse(&existing)?;

    // Update the timestamp
    meta.updated = now_rfc3339();

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

    let full_content = frontmatter::serialize(&meta, content);
    fs::write(&abs_path, full_content)?;

    Ok(())
}

/// Delete an entry from disk.
pub fn delete(workspace: &str, path: &str) -> Result<(), AppError> {
    let abs_path = resolve(workspace, path);

    if !abs_path.exists() {
        return Err(AppError::FileNotFound(path.to_string()));
    }

    if abs_path.is_dir() {
        fs::remove_dir_all(&abs_path)?;
    } else {
        fs::remove_file(&abs_path)?;
    }

    Ok(())
}

/// Rename/move an entry on disk.
pub fn rename(workspace: &str, from: &str, to: &str) -> Result<(), AppError> {
    let abs_from = resolve(workspace, from);
    let abs_to = resolve(workspace, to);

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
}

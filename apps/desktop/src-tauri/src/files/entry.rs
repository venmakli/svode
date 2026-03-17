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

/// Generate a URL-safe slug from a title.
fn slugify(title: &str) -> String {
    let slug: String = title
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c
            } else if c == ' ' || c == '_' {
                '-'
            } else {
                // skip non-ascii non-alphanumeric
                '\0'
            }
        })
        .filter(|&c| c != '\0')
        .collect();

    // collapse multiple hyphens
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
    result.trim_matches('-').to_string()
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
    let filename = format!("{slug}.md");

    let rel_path = match parent_path {
        Some(parent) => format!("{parent}/{filename}"),
        None => filename,
    };

    let abs_path = resolve(workspace, &rel_path);

    // Ensure parent directory exists
    if let Some(parent_dir) = abs_path.parent() {
        fs::create_dir_all(parent_dir)?;
    }

    if abs_path.exists() {
        return Err(AppError::FileAlreadyExists(rel_path));
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

    #[test]
    fn test_slugify() {
        assert_eq!(slugify("Hello World"), "hello-world");
        assert_eq!(slugify("My Cool Page!"), "my-cool-page");
        assert_eq!(slugify("  Spaced  Out  "), "spaced-out");
        assert_eq!(slugify("CamelCase"), "camelcase");
    }
}

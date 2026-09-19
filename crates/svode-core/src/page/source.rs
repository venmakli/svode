use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use super::naming::{DocumentNameConflict, document_name_conflict};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, thiserror::Error)]
pub enum PageSourceError {
    #[error("source not found: {0}")]
    Missing(String),
    #[error("invalid Page path: {0}")]
    InvalidPath(String),
    #[error("path is not a standalone Page: {0}")]
    InvalidOwner(String),
    #[error("Space not found or not ready: {0}")]
    SpaceNotFound(String),
    #[error("invalid Project config: {0}")]
    InvalidConfig(serde_json::Error),
    #[error("Page source is not UTF-8: {0}")]
    InvalidEncoding(String),
    #[error("Page source access denied: {0}")]
    Access(String),
    #[error("Page source I/O failed: {0}")]
    Io(#[source] std::io::Error),
}

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
    pub fn from_name(value: &str) -> Option<Self> {
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

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone)]
pub struct PageSourceMeta {
    pub title: String,
    pub icon: Option<String>,
    pub description: Option<String>,
    pub cover: Option<Cover>,
    pub extra: HashMap<String, serde_yml::Value>,
    pub title_present: bool,
    pub icon_present: bool,
    pub description_present: bool,
    pub cover_present: bool,
}

impl PageSourceMeta {
    fn fallback(path: &str) -> Self {
        Self {
            title: fallback_title(path),
            icon: None,
            description: None,
            cover: None,
            extra: HashMap::new(),
            title_present: false,
            icon_present: false,
            description_present: false,
            cover_present: false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PageSourceWarning {
    pub kind: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceVersion(String);

impl SourceVersion {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone)]
pub struct ResolvedPageTarget {
    pub space: PathBuf,
    pub absolute: PathBuf,
    pub path: String,
}

#[derive(Debug, Clone)]
pub struct PageSource {
    pub target: ResolvedPageTarget,
    pub meta: PageSourceMeta,
    pub body: String,
    pub created: String,
    pub updated: String,
    pub warnings: Vec<PageSourceWarning>,
    pub name_conflict: Option<DocumentNameConflict>,
    pub version: SourceVersion,
}

fn source_error(path: &Path, error: std::io::Error) -> PageSourceError {
    match error.kind() {
        std::io::ErrorKind::NotFound => PageSourceError::Missing(path.display().to_string()),
        std::io::ErrorKind::PermissionDenied => PageSourceError::Access(path.display().to_string()),
        _ => PageSourceError::Io(error),
    }
}

pub fn resolve_page_target(
    space: &Path,
    path: &str,
) -> Result<ResolvedPageTarget, PageSourceError> {
    let space = fs::canonicalize(space).map_err(|error| source_error(space, error))?;
    if !space.is_dir() {
        return Err(PageSourceError::InvalidPath(space.display().to_string()));
    }
    let path = normalize_page_path(path)?;
    let absolute = space.join(&path);
    let absolute = fs::canonicalize(&absolute).map_err(|error| source_error(&absolute, error))?;
    if !absolute.starts_with(&space) {
        return Err(PageSourceError::InvalidPath(path));
    }
    if !absolute.is_file() {
        return Err(PageSourceError::InvalidPath(path));
    }
    let canonical_path = absolute
        .strip_prefix(&space)
        .map_err(|_| PageSourceError::InvalidPath(path.clone()))?
        .to_str()
        .ok_or_else(|| PageSourceError::InvalidEncoding(path.clone()))?
        .replace('\\', "/");
    Ok(ResolvedPageTarget {
        space,
        absolute,
        path: canonical_path,
    })
}

pub(super) fn normalize_page_path(path: &str) -> Result<String, PageSourceError> {
    let normalized = path.replace('\\', "/");
    if normalized.is_empty()
        || normalized.starts_with('/')
        || normalized == "."
        || normalized.as_bytes().get(1) == Some(&b':')
        || normalized
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || Path::new(&normalized)
            .extension()
            .and_then(|extension| extension.to_str())
            .is_none_or(|extension| !extension.eq_ignore_ascii_case("md"))
    {
        return Err(PageSourceError::InvalidPath(path.to_string()));
    }
    Ok(normalized)
}

pub fn read_page_source(target: ResolvedPageTarget) -> Result<PageSource, PageSourceError> {
    let bytes =
        fs::read(&target.absolute).map_err(|error| source_error(&target.absolute, error))?;
    let content = String::from_utf8(bytes.clone())
        .map_err(|_| PageSourceError::InvalidEncoding(target.path.clone()))?;
    let (created, updated) = filesystem_dates(&target.absolute)?;
    let (meta, body, warnings) = match parse_markdown(&content, &target.path) {
        ParsedMarkdown::Valid(mut meta, body) => {
            if !meta.title_present {
                meta.title = fallback_title(&target.path);
            }
            (meta, body, Vec::new())
        }
        ParsedMarkdown::Missing(body) => (PageSourceMeta::fallback(&target.path), body, Vec::new()),
        ParsedMarkdown::Malformed(message, body) => (
            PageSourceMeta::fallback(&target.path),
            body,
            vec![PageSourceWarning {
                kind: "malformed_frontmatter".into(),
                message,
            }],
        ),
    };
    let mut hasher = Sha256::new();
    hasher.update(target.space.to_string_lossy().as_bytes());
    hasher.update([0]);
    hasher.update(target.path.as_bytes());
    hasher.update([0]);
    hasher.update(bytes);
    let version = SourceVersion(format!("{:x}", hasher.finalize()));
    let name_conflict = document_name_conflict(&target.space, &target.path, &meta.title)?;
    Ok(PageSource {
        target,
        meta,
        body,
        created,
        updated,
        warnings,
        name_conflict,
        version,
    })
}

pub fn filesystem_dates(path: &Path) -> Result<(String, String), PageSourceError> {
    let metadata = fs::metadata(path).map_err(|error| source_error(path, error))?;
    Ok((
        file_date(metadata.created()),
        file_date(metadata.modified()),
    ))
}

fn file_date(time: std::io::Result<std::time::SystemTime>) -> String {
    time.ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|duration| {
            chrono::DateTime::from_timestamp(duration.as_secs() as i64, duration.subsec_nanos())
        })
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(SecondsFormat::Secs, true)
}

pub fn fallback_title(path: &str) -> String {
    let stem = Path::new(path)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("untitled");
    let text = stem.replace(['-', '_'], " ");
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().to_string() + chars.as_str(),
        None => "Untitled".into(),
    }
}

pub enum ParsedMarkdown {
    Valid(PageSourceMeta, String),
    Missing(String),
    Malformed(String, String),
}

pub fn parse_markdown(content: &str, path: &str) -> ParsedMarkdown {
    if !content.trim_start().starts_with("---") {
        return ParsedMarkdown::Missing(content.to_string());
    }
    match parse_frontmatter(content, path) {
        Ok((meta, body)) => ParsedMarkdown::Valid(meta, body),
        Err(message) => ParsedMarkdown::Malformed(message, content.to_string()),
    }
}

fn parse_frontmatter(content: &str, path: &str) -> Result<(PageSourceMeta, String), String> {
    let leading_len = content.len() - content.trim_start().len();
    let trimmed = &content[leading_len..];
    let after_first = &trimmed[3..];
    let skipped_newline = after_first.starts_with('\n');
    let after_first = if skipped_newline {
        &after_first[1..]
    } else {
        after_first
    };
    let yaml_start = leading_len + 3 + usize::from(skipped_newline);
    let end_pos = after_first
        .find("\n---")
        .ok_or_else(|| "missing closing frontmatter delimiter '---'".to_string())?;
    let closing_end = yaml_start + end_pos + 4;
    let body_start = if content[closing_end..].starts_with("\r\n") {
        closing_end + 2
    } else if content[closing_end..].starts_with('\n') {
        closing_end + 1
    } else {
        closing_end
    };
    let yaml: serde_yml::Value = serde_yml::from_str(&after_first[..end_pos])
        .map_err(|error| format!("invalid YAML frontmatter: {error}"))?;
    let mapping = match yaml {
        serde_yml::Value::Null => serde_yml::Mapping::new(),
        serde_yml::Value::Mapping(mapping) => mapping,
        _ => return Err("invalid YAML frontmatter: expected a mapping".into()),
    };
    let mut meta = PageSourceMeta::fallback(path);
    if !meta.title_present {
        meta.title.clear();
    }
    for (key, value) in mapping {
        let serde_yml::Value::String(key) = key else {
            return Err("invalid YAML frontmatter: keys must be strings".into());
        };
        match key.as_str() {
            "title" => {
                meta.title_present = true;
                meta.title = serde_yml::from_value(value)
                    .map_err(|error| format!("invalid YAML frontmatter: title: {error}"))?;
            }
            "icon" => {
                meta.icon_present = true;
                meta.icon = parse_optional(value, "icon")?;
            }
            "description" => {
                meta.description_present = true;
                meta.description = parse_optional(value, "description")?;
            }
            "cover" => {
                meta.cover_present = true;
                meta.cover = parse_optional(value, "cover")?;
            }
            _ => {
                meta.extra.insert(key, value);
            }
        }
    }
    Ok((meta, content[body_start..].to_string()))
}

fn parse_optional<T: serde::de::DeserializeOwned>(
    value: serde_yml::Value,
    name: &str,
) -> Result<Option<T>, String> {
    if value.is_null() {
        return Ok(None);
    }
    serde_yml::from_value(value)
        .map(Some)
        .map_err(|error| format!("invalid YAML frontmatter: {name}: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{PageSourceError, source_error};
    use std::io::{Error, ErrorKind};
    use std::path::Path;

    #[test]
    fn access_failure_keeps_a_distinct_typed_error() {
        let path = Path::new("blocked.md");
        assert!(matches!(
            source_error(path, Error::from(ErrorKind::PermissionDenied)),
            PageSourceError::Access(value) if value == "blocked.md"
        ));
    }
}

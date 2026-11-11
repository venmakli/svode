use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use super::frontmatter::FrontmatterFields;
use super::naming::{DocumentNameConflict, DocumentNames};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, thiserror::Error)]
pub enum PageSourceError {
    #[error("source not found: {0}")]
    Missing(String),
    #[error("invalid Page path: {0}")]
    InvalidPath(String),
    #[error("Page path is outside the public Space content: {0}")]
    Forbidden(String),
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

#[derive(Debug, Clone)]
pub struct PageSourceMeta {
    pub title: String,
    pub icon: Option<String>,
    pub description: Option<String>,
    pub cover: Option<Cover>,
    pub extra: FrontmatterFields,
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
            extra: FrontmatterFields::new(),
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
    /// Token a caller received from a read or write and passes back whole;
    /// it is compared, never parsed.
    pub fn from_token(token: impl Into<String>) -> Self {
        Self(token.into())
    }

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
        return Err(PageSourceError::Forbidden(path));
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
    let mut names = DocumentNames::new(&target.space);
    read_page_source_with_names(target, &mut names)
}

/// [`read_page_source`] with its name conflict from `names`, which a reader
/// of many Pages of one Space shares, so each naming scope is read once.
pub fn read_page_source_with_names(
    target: ResolvedPageTarget,
    names: &mut DocumentNames,
) -> Result<PageSource, PageSourceError> {
    let bytes =
        fs::read(&target.absolute).map_err(|error| source_error(&target.absolute, error))?;
    let content = std::str::from_utf8(&bytes)
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
    let version = version_of(&target, &bytes);
    let name_conflict = names.conflict_of(&target.path, &meta.title)?;
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

/// Version of the current bytes of one Page source.
pub fn current_source_version(space: &Path, path: &str) -> Result<SourceVersion, PageSourceError> {
    let target = resolve_page_target(space, path)?;
    let bytes =
        fs::read(&target.absolute).map_err(|error| source_error(&target.absolute, error))?;
    Ok(version_of(&target, &bytes))
}

/// Digest of the canonical target and the full bytes of one read.
fn version_of(target: &ResolvedPageTarget, bytes: &[u8]) -> SourceVersion {
    let mut hasher = Sha256::new();
    hasher.update(target.space.to_string_lossy().as_bytes());
    hasher.update([0]);
    hasher.update(target.path.as_bytes());
    hasher.update([0]);
    hasher.update(bytes);
    SourceVersion(format!("{:x}", hasher.finalize()))
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

/// Longest frontmatter a head read accepts.
const MAX_FRONTMATTER_HEAD_BYTES: usize = 64 * 1024;

/// The frontmatter at the head of a Markdown source, read up to its closing
/// line and no further than [`MAX_FRONTMATTER_HEAD_BYTES`].
pub(crate) enum FrontmatterHead {
    Missing,
    Valid(PageSourceMeta),
    Unreadable,
}

pub(crate) fn frontmatter_head(mut reader: impl BufRead) -> FrontmatterHead {
    let mut head = String::new();
    let mut started = false;

    loop {
        let mut line = String::new();
        let Ok(bytes) = reader.read_line(&mut line) else {
            return FrontmatterHead::Unreadable;
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
                return FrontmatterHead::Missing;
            }
            if head.len() + line.len() > MAX_FRONTMATTER_HEAD_BYTES {
                return FrontmatterHead::Unreadable;
            }
            started = true;
            head.push_str(&line);
            continue;
        }

        let is_closing = line.trim_end() == "---";
        if head.len() + line.len() > MAX_FRONTMATTER_HEAD_BYTES {
            return FrontmatterHead::Unreadable;
        }
        head.push_str(&line);
        if is_closing {
            return match parse_markdown(&head, "") {
                ParsedMarkdown::Valid(meta, _) => FrontmatterHead::Valid(meta),
                _ => FrontmatterHead::Unreadable,
            };
        }
    }

    if started {
        FrontmatterHead::Unreadable
    } else {
        FrontmatterHead::Missing
    }
}

/// Frontmatter head of the Markdown file at `path`, without its body: the
/// one read of a document that listings and naming scopes make. A file that
/// does not open reads as unreadable.
pub(crate) fn read_frontmatter_head(path: &Path) -> FrontmatterHead {
    #[cfg(test)]
    head_reads::record(path);
    match fs::File::open(path) {
        Ok(file) => frontmatter_head(BufReader::new(file)),
        Err(_) => FrontmatterHead::Unreadable,
    }
}

/// Head reads per file on the current thread, so tests can count how often
/// a listing reads each document.
#[cfg(test)]
pub(crate) mod head_reads {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};

    thread_local! {
        static READS: RefCell<HashMap<PathBuf, usize>> = RefCell::new(HashMap::new());
    }

    pub(crate) fn record(path: &Path) {
        READS.with(|reads| *reads.borrow_mut().entry(path.to_path_buf()).or_default() += 1);
    }

    /// Head reads made on this thread since the last call, by file.
    pub(crate) fn take() -> HashMap<PathBuf, usize> {
        READS.with(|reads| std::mem::take(&mut *reads.borrow_mut()))
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
    let yaml: serde_norway::Value = serde_norway::from_str(&after_first[..end_pos])
        .map_err(|error| format!("invalid YAML frontmatter: {error}"))?;
    let mapping = match yaml {
        serde_norway::Value::Null => serde_norway::Mapping::new(),
        serde_norway::Value::Mapping(mapping) => mapping,
        _ => return Err("invalid YAML frontmatter: expected a mapping".into()),
    };
    let mut meta = PageSourceMeta::fallback(path);
    if !meta.title_present {
        meta.title.clear();
    }
    for (key, value) in mapping {
        let serde_norway::Value::String(key) = key else {
            return Err("invalid YAML frontmatter: keys must be strings".into());
        };
        match key.as_str() {
            "title" => {
                meta.title_present = true;
                meta.title = serde_norway::from_value(value)
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
    value: serde_norway::Value,
    name: &str,
) -> Result<Option<T>, String> {
    if value.is_null() {
        return Ok(None);
    }
    serde_norway::from_value(value)
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

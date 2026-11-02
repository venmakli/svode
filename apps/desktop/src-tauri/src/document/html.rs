//! HTML Documents (Stage 11 `06`): which file is shown and from which root,
//! how its entry file is answered, and how changes of a root outside the
//! project are observed. The loopback server itself is the one of static
//! Apps.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, UNIX_EPOCH};

use chrono::{DateTime, SecondsFormat, Utc};
use notify::event::RemoveKind;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Deserialize;

use super::source::{DocumentSourceError, map_io_error, reject_registered_space_boundary};
use crate::attachments::source::resolve_registered_owner;
use crate::repo_path::{RootMode, normalize_repo_relative, repo_relative_from_base};
use svode_core::system_path;

/// The largest HTML file shown.
pub(crate) const HTML_DOCUMENT_LIMIT: u64 = 16 * 1024 * 1024;

const CHANGE_DEBOUNCE: Duration = Duration::from_millis(200);
const CHARSET_PRESCAN_BYTES: usize = 1024;
const UTF8_BOM: &[u8] = b"\xEF\xBB\xBF";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum HtmlTheme {
    Light,
    Dark,
}

impl HtmlTheme {
    fn name(self) -> &'static str {
        match self {
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }
}

/// A file inside a Space of the project, or a local file by its absolute
/// path outside it. A path from an agent is untrusted input either way.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum HtmlDocumentInput {
    Space {
        project_path: String,
        space_id: Option<String>,
        target_path: String,
    },
    Local {
        path: String,
    },
}

#[derive(Debug)]
pub(crate) struct ResolvedHtmlDocument {
    /// The canonical directory of the file, served with its subdirectories
    /// unless it is a wide root.
    pub root: PathBuf,
    /// The canonical file.
    pub entry: PathBuf,
    /// The root is wide: only the file itself is served.
    pub single_file: bool,
    /// Outside the project, where no Space watcher sees its changes.
    pub outside_project: bool,
    pub size_bytes: u64,
    pub modified_at: String,
}

/// Resolves the file to show. `wide_roots` are the canonical directories
/// whose files are served alone: the home directory and its Desktop,
/// Documents and Downloads, and the system temporary directories.
pub(crate) fn resolve_html_document(
    input: &HtmlDocumentInput,
    wide_roots: &[PathBuf],
) -> Result<ResolvedHtmlDocument, DocumentSourceError> {
    let mut wide_roots = wide_roots.to_vec();
    let (candidate, boundary, outside_project) = match input {
        HtmlDocumentInput::Space {
            project_path,
            space_id,
            target_path,
        } => {
            let owner = resolve_registered_owner(Path::new(project_path), space_id.as_deref())
                .map_err(|error| match error {
                    crate::AppError::FileNotFound(_) => DocumentSourceError::SourceMissing,
                    _ => DocumentSourceError::PathUnresolved,
                })?;
            let space_root = fs::canonicalize(&owner.space_path).map_err(map_io_error)?;
            let normalized = normalize_repo_relative(target_path, RootMode::Reject)
                .map_err(|_| DocumentSourceError::PathUnresolved)?;
            require_html_extension(Path::new(&normalized))?;
            reject_registered_space_boundary(&space_root, &normalized)
                .map_err(|_| DocumentSourceError::PathUnresolved)?;
            reject_symlink_components(&space_root, Path::new(&normalized))?;
            if let Ok(project_root) = fs::canonicalize(&owner.project_path) {
                wide_roots.push(project_root);
            }
            wide_roots.push(space_root.clone());
            (space_root.join(&normalized), Some(space_root), false)
        }
        HtmlDocumentInput::Local { path } => (resolve_local_html(Path::new(path))?, None, true),
    };

    let metadata = fs::symlink_metadata(&candidate).map_err(map_io_error)?;
    if metadata.file_type().is_symlink() {
        return Err(DocumentSourceError::Symlink);
    }
    if !metadata.is_file() {
        return Err(DocumentSourceError::PathUnresolved);
    }
    let entry = fs::canonicalize(&candidate).map_err(map_io_error)?;
    if boundary.is_some_and(|boundary| !entry.starts_with(boundary)) {
        return Err(DocumentSourceError::PathUnresolved);
    }
    if metadata.len() > HTML_DOCUMENT_LIMIT {
        return Err(DocumentSourceError::ResourceLimit {
            limit_bytes: HTML_DOCUMENT_LIMIT,
            actual_bytes: metadata.len(),
        });
    }
    File::open(&entry).map_err(|error| match map_io_error(error) {
        DocumentSourceError::SourceMissing => DocumentSourceError::SourceMissing,
        _ => DocumentSourceError::SourceInaccessible,
    })?;
    let root = entry
        .parent()
        .ok_or(DocumentSourceError::PathUnresolved)?
        .to_path_buf();
    let modified = metadata.modified().map_err(map_io_error)?;
    modified
        .duration_since(UNIX_EPOCH)
        .map_err(|_| DocumentSourceError::SourceInaccessible)?;
    Ok(ResolvedHtmlDocument {
        single_file: is_wide_root(&root, &wide_roots),
        root,
        entry,
        outside_project,
        size_bytes: metadata.len(),
        modified_at: DateTime::<Utc>::from(modified).to_rfc3339_opts(SecondsFormat::Secs, true),
    })
}

/// The directory, relative to its Space, of the App whose files include the
/// HTML file at `target_path` (Stage 11 `06` H1): a link to it opens the App,
/// not a Document. None outside Apps.
pub(crate) fn html_app_directory(
    project_path: &Path,
    space_id: Option<&str>,
    target_path: &str,
) -> Result<Option<String>, DocumentSourceError> {
    let owner = resolve_registered_owner(project_path, space_id)
        .map_err(|_| DocumentSourceError::PathUnresolved)?;
    let normalized = normalize_repo_relative(target_path, RootMode::Reject)
        .map_err(|_| DocumentSourceError::PathUnresolved)?;
    require_html_extension(Path::new(&normalized))?;
    let candidate = owner.space_path.join(&normalized);
    let Some(directory) = candidate.parent() else {
        return Ok(None);
    };
    svode_core::attachments::format::app_directory(&owner.space_path, directory)
        .map(|app| {
            repo_relative_from_base(&owner.space_path, app, RootMode::Allow)
                .map_err(|_| DocumentSourceError::PathUnresolved)
        })
        .transpose()
}

/// A local HTML file by its absolute path, outside the project: the only
/// local files the chat shows as Documents; other files open in their
/// system application. A network share is not a local file: not even
/// resolved, since that reaches the server.
pub(crate) fn resolve_local_html(path: &Path) -> Result<PathBuf, DocumentSourceError> {
    if !path.is_absolute() || system_path::is_network_path(&path.to_string_lossy()) {
        return Err(DocumentSourceError::PathUnresolved);
    }
    require_html_extension(path)?;
    let metadata = fs::symlink_metadata(path).map_err(map_io_error)?;
    if metadata.file_type().is_symlink() {
        return Err(DocumentSourceError::Symlink);
    }
    if !metadata.is_file() {
        return Err(DocumentSourceError::PathUnresolved);
    }
    fs::canonicalize(path).map_err(map_io_error)
}

fn require_html_extension(path: &Path) -> Result<(), DocumentSourceError> {
    let html = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("html") || extension.eq_ignore_ascii_case("htm")
        });
    if html {
        Ok(())
    } else {
        Err(DocumentSourceError::UnsupportedFormat)
    }
}

fn reject_symlink_components(root: &Path, relative: &Path) -> Result<(), DocumentSourceError> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&current).map_err(map_io_error)?;
        if metadata.file_type().is_symlink() {
            return Err(DocumentSourceError::Symlink);
        }
    }
    Ok(())
}

/// A directory too broad to serve: a root of the filesystem or a volume, a
/// project or Space root, or one of `wide_roots`.
pub(crate) fn is_wide_root(directory: &Path, wide_roots: &[PathBuf]) -> bool {
    directory.parent().is_none()
        || wide_roots.iter().any(|root| root == directory)
        || directory.join(".svode").join("config.json").is_file()
        || is_mount_point(directory)
}

#[cfg(unix)]
fn is_mount_point(directory: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let (Some(parent), Ok(metadata)) = (directory.parent(), fs::metadata(directory)) else {
        return false;
    };
    fs::metadata(parent).is_ok_and(|parent| parent.dev() != metadata.dev())
}

/// A Windows volume root has no parent, which `is_wide_root` checks first.
#[cfg(not(unix))]
fn is_mount_point(_directory: &Path) -> bool {
    false
}

/// The canonical wide roots of this device that exist.
pub(crate) fn device_wide_roots(app: &tauri::AppHandle) -> Vec<PathBuf> {
    use tauri::Manager;
    let paths = app.path();
    let mut roots = vec![
        paths.home_dir().ok(),
        paths.desktop_dir().ok(),
        paths.document_dir().ok(),
        paths.download_dir().ok(),
        paths.temp_dir().ok(),
        Some(std::env::temp_dir()),
    ];
    #[cfg(unix)]
    roots.push(Some(PathBuf::from("/tmp")));
    roots
        .into_iter()
        .flatten()
        .filter_map(|root| fs::canonicalize(root).ok())
        .collect()
}

/// Whether a component of `relative` is hidden: `.git`, `.svode`, `.env`.
pub(crate) fn has_hidden_component(relative: &Path) -> bool {
    relative.components().any(|component| {
        matches!(component, Component::Normal(name) if name.to_string_lossy().starts_with('.'))
    })
}

/// Whether a change of `path` alters what a Document root serves: a regular
/// file of the root outside hidden components, or one that is gone and was
/// not a directory; for a wide root only the entry file.
pub(crate) fn is_document_change(
    root: &Path,
    entry: &Path,
    single_file: bool,
    path: &Path,
    removed_directory: bool,
) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    if relative.as_os_str().is_empty()
        || has_hidden_component(relative)
        || (single_file && path != entry)
    {
        return false;
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) => metadata.is_file(),
        Err(_) => !removed_directory,
    }
}

/// Observes a root outside the project while it is served: the directory
/// with its subdirectories, or for a wide root only its own entries. A
/// series of changes calls `on_change` once; dropping the watcher ends it.
pub(crate) fn observe_outside(
    root: PathBuf,
    entry: PathBuf,
    single_file: bool,
    on_change: impl Fn() + Send + 'static,
) -> notify::Result<RecommendedWatcher> {
    let (changes, received) = mpsc::channel::<()>();
    let watched_root = root.clone();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        let Ok(event) = result else { return };
        let removed_directory = matches!(event.kind, EventKind::Remove(RemoveKind::Folder));
        if event.paths.iter().any(|path| {
            is_document_change(&watched_root, &entry, single_file, path, removed_directory)
        }) {
            let _ = changes.send(());
        }
    })?;
    let mode = if single_file {
        RecursiveMode::NonRecursive
    } else {
        RecursiveMode::Recursive
    };
    watcher.watch(&root, mode)?;
    std::thread::spawn(move || {
        while received.recv().is_ok() {
            loop {
                match received.recv_timeout(CHANGE_DEBOUNCE) {
                    Ok(()) => continue,
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
            on_change();
        }
    });
    Ok(watcher)
}

/// The entry file as answered: a fragment wrapped into a standards-mode
/// page, the Svode theme in `data-theme` on `<html>`, and the charset the
/// document declares.
pub(crate) struct RenderedEntry {
    pub body: Vec<u8>,
    pub charset: String,
}

pub(crate) fn render_entry(bytes: &[u8], theme: HtmlTheme) -> RenderedEntry {
    match EntryEncoding::of(bytes) {
        EntryEncoding::Utf16 { little_endian } => {
            let text = decode_utf16(&bytes[2..], little_endian);
            render_content(text.as_bytes(), "utf-8".to_string(), theme)
        }
        EntryEncoding::Utf8Bom => {
            render_content(&bytes[UTF8_BOM.len()..], "utf-8".to_string(), theme)
        }
        EntryEncoding::Declared(charset) => render_content(bytes, charset, theme),
    }
}

/// The encoding of an HTML file as its entry is served (Stage 11 `06` H2):
/// a BOM, else the charset a `<meta>` of the first kilobyte declares, else
/// UTF-8.
enum EntryEncoding {
    Utf16 { little_endian: bool },
    Utf8Bom,
    Declared(String),
}

impl EntryEncoding {
    fn of(bytes: &[u8]) -> Self {
        match bytes {
            [0xFF, 0xFE, ..] => Self::Utf16 {
                little_endian: true,
            },
            [0xFE, 0xFF, ..] => Self::Utf16 {
                little_endian: false,
            },
            _ if bytes.starts_with(UTF8_BOM) => Self::Utf8Bom,
            _ => Self::Declared(declared_charset(bytes).unwrap_or_else(|| "utf-8".to_string())),
        }
    }

    /// The label of the encoding, as the Encoding Standard names it.
    fn label(self) -> String {
        match self {
            Self::Utf16 {
                little_endian: true,
            } => "utf-16le".to_string(),
            Self::Utf16 {
                little_endian: false,
            } => "utf-16be".to_string(),
            Self::Utf8Bom => "utf-8".to_string(),
            Self::Declared(charset) => charset,
        }
    }
}

/// The encoding of the HTML file at `path`, by its first kilobyte, for the
/// text of «Исходник»: the one its page is served with.
pub(crate) fn html_source_encoding(path: &Path) -> Result<String, DocumentSourceError> {
    let mut prefix = Vec::with_capacity(CHARSET_PRESCAN_BYTES);
    File::open(path)
        .and_then(|file| {
            file.take(CHARSET_PRESCAN_BYTES as u64)
                .read_to_end(&mut prefix)
        })
        .map_err(map_io_error)?;
    Ok(EntryEncoding::of(&prefix).label())
}

fn render_content(content: &[u8], charset: String, theme: HtmlTheme) -> RenderedEntry {
    let attribute = format!(" data-theme=\"{}\"", theme.name());
    let start = skip_ignorable(content, 0);
    let body = if starts_with_ignore_case(&content[start..], b"<!doctype") {
        let doctype_end = content[start..]
            .iter()
            .position(|byte| *byte == b'>')
            .map_or(content.len(), |offset| start + offset + 1);
        let after = skip_ignorable(content, doctype_end);
        if is_html_tag(&content[after..]) {
            splice(content, after + "<html".len(), attribute.as_bytes())
        } else {
            let tag = format!("<html{attribute}>");
            splice(content, doctype_end, tag.as_bytes())
        }
    } else if is_html_tag(&content[start..]) {
        splice(content, start + "<html".len(), attribute.as_bytes())
    } else {
        let mut page = format!(
            "<!doctype html>\n<html{attribute}>\n<meta charset=\"{charset}\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
        )
        .into_bytes();
        page.extend_from_slice(content);
        page
    };
    RenderedEntry { body, charset }
}

fn splice(content: &[u8], at: usize, inserted: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(content.len() + inserted.len());
    body.extend_from_slice(&content[..at]);
    body.extend_from_slice(inserted);
    body.extend_from_slice(&content[at..]);
    body
}

/// The position after whitespace and comments from `index`.
fn skip_ignorable(content: &[u8], mut index: usize) -> usize {
    loop {
        while content.get(index).is_some_and(u8::is_ascii_whitespace) {
            index += 1;
        }
        if !content[index..].starts_with(b"<!--") {
            return index;
        }
        match find(&content[index + 4..], b"-->") {
            Some(offset) => index += 4 + offset + 3,
            None => return content.len(),
        }
    }
}

fn is_html_tag(content: &[u8]) -> bool {
    starts_with_ignore_case(content, b"<html")
        && content
            .get(5)
            .is_none_or(|byte| byte.is_ascii_whitespace() || matches!(byte, b'>' | b'/'))
}

fn starts_with_ignore_case(content: &[u8], prefix: &[u8]) -> bool {
    content.len() >= prefix.len() && content[..prefix.len()].eq_ignore_ascii_case(prefix)
}

fn find(content: &[u8], needle: &[u8]) -> Option<usize> {
    content
        .windows(needle.len())
        .position(|window| window == needle)
}

fn find_ignore_case(content: &[u8], needle: &[u8]) -> Option<usize> {
    content
        .windows(needle.len())
        .position(|window| window.eq_ignore_ascii_case(needle))
}

/// The charset a `<meta>` in the first kilobyte declares, as browsers
/// prescan it; a UTF-16 label there means UTF-8.
fn declared_charset(content: &[u8]) -> Option<String> {
    let mut rest = &content[..content.len().min(CHARSET_PRESCAN_BYTES)];
    while let Some(start) = find_ignore_case(rest, b"<meta") {
        let tag_start = &rest[start + "<meta".len()..];
        let tag = &tag_start[..tag_start
            .iter()
            .position(|byte| *byte == b'>')
            .unwrap_or(tag_start.len())];
        if let Some(label) = charset_in_tag(tag) {
            return Some(if label.starts_with("utf-16") {
                "utf-8".to_string()
            } else {
                label
            });
        }
        rest = tag_start;
    }
    None
}

fn charset_in_tag(tag: &[u8]) -> Option<String> {
    let mut rest = tag;
    while let Some(start) = find_ignore_case(rest, b"charset") {
        rest = &rest[start + "charset".len()..];
        let mut index = 0;
        while rest.get(index).is_some_and(u8::is_ascii_whitespace) {
            index += 1;
        }
        if rest.get(index) != Some(&b'=') {
            continue;
        }
        index += 1;
        while rest
            .get(index)
            .is_some_and(|byte| byte.is_ascii_whitespace() || matches!(byte, b'"' | b'\''))
        {
            index += 1;
        }
        let label: String = rest[index..]
            .iter()
            .take_while(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':')
            })
            .map(|byte| byte.to_ascii_lowercase() as char)
            .collect();
        if !label.is_empty() {
            return Some(label);
        }
    }
    None
}

fn decode_utf16(content: &[u8], little_endian: bool) -> String {
    let units = content.chunks_exact(2).map(|pair| {
        if little_endian {
            u16::from_le_bytes([pair[0], pair[1]])
        } else {
            u16::from_be_bytes([pair[0], pair[1]])
        }
    });
    char::decode_utf16(units)
        .map(|unit| unit.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::config::write_space_config;
    use crate::space::types::SpaceConfig;

    fn write_project(path: &Path) {
        fs::create_dir_all(path).unwrap();
        write_space_config(
            path,
            &SpaceConfig {
                name: "Project".into(),
                description: String::new(),
                icon: "folder".into(),
                spaces: None,
                agent: None,
                defaults: None,
                git: None,
                assets: None,
                tree: None,
                extensions: Default::default(),
            },
        )
        .unwrap();
    }

    fn space(project: &Path, target_path: &str) -> HtmlDocumentInput {
        HtmlDocumentInput::Space {
            project_path: project.to_string_lossy().into_owned(),
            space_id: None,
            target_path: target_path.to_string(),
        }
    }

    fn local(path: &Path) -> HtmlDocumentInput {
        HtmlDocumentInput::Local {
            path: path.to_string_lossy().into_owned(),
        }
    }

    fn kind(result: Result<ResolvedHtmlDocument, DocumentSourceError>) -> String {
        match result {
            Ok(_) => "ok".to_string(),
            Err(error) => serde_json::to_value(&error).unwrap()["kind"]
                .as_str()
                .unwrap()
                .to_string(),
        }
    }

    #[test]
    fn the_input_is_the_platform_shape() {
        let space: HtmlDocumentInput = serde_json::from_value(serde_json::json!({
            "kind": "space", "projectPath": "/p", "spaceId": null, "targetPath": "a.html"
        }))
        .unwrap();
        assert!(matches!(
            space,
            HtmlDocumentInput::Space { ref project_path, space_id: None, ref target_path }
                if project_path == "/p" && target_path == "a.html"
        ));
        let local: HtmlDocumentInput =
            serde_json::from_value(serde_json::json!({ "kind": "local", "path": "/tmp/a.html" }))
                .unwrap();
        assert!(matches!(local, HtmlDocumentInput::Local { ref path } if path == "/tmp/a.html"));
        let theme: HtmlTheme = serde_json::from_value(serde_json::json!("dark")).unwrap();
        assert_eq!(theme, HtmlTheme::Dark);
    }

    #[test]
    fn the_root_is_the_directory_of_the_file_unless_it_is_wide() {
        let temp = tempfile::tempdir().unwrap();
        let project = fs::canonicalize(temp.path()).unwrap().join("project");
        write_project(&project);
        fs::create_dir_all(project.join("reports/data")).unwrap();
        fs::write(project.join("reports/dash.HTML"), "<p>").unwrap();
        fs::write(project.join("index.htm"), "<p>").unwrap();

        let nested = resolve_html_document(&space(&project, "reports/dash.HTML"), &[]).unwrap();
        assert_eq!(nested.root, project.join("reports"));
        assert_eq!(nested.entry, project.join("reports/dash.HTML"));
        assert!(!nested.single_file && !nested.outside_project);
        assert_eq!(nested.size_bytes, 3);

        // The project root.
        let root = resolve_html_document(&space(&project, "index.htm"), &[]).unwrap();
        assert_eq!(root.root, project);
        assert!(root.single_file);

        // A directory of the device list, such as Downloads.
        let downloads = fs::canonicalize(temp.path()).unwrap().join("Downloads");
        fs::create_dir_all(&downloads).unwrap();
        fs::write(downloads.join("page.html"), "<p>").unwrap();
        let wide =
            resolve_html_document(&local(&downloads.join("page.html")), &[downloads.clone()])
                .unwrap();
        assert!(wide.single_file && wide.outside_project);
        let narrow = resolve_html_document(&local(&downloads.join("page.html")), &[]).unwrap();
        assert!(!narrow.single_file);

        // Another project or Space root, and the filesystem root.
        let other = fs::canonicalize(temp.path()).unwrap().join("other");
        write_project(&other);
        fs::write(other.join("a.html"), "<p>").unwrap();
        assert!(
            resolve_html_document(&local(&other.join("a.html")), &[])
                .unwrap()
                .single_file
        );
        assert!(is_wide_root(Path::new("/"), &[]));
    }

    #[test]
    fn inputs_are_refused_with_their_reason() {
        let temp = tempfile::tempdir().unwrap();
        let project = fs::canonicalize(temp.path()).unwrap().join("project");
        write_project(&project);
        fs::create_dir_all(project.join("docs")).unwrap();
        fs::write(project.join("docs/notes.txt"), "text").unwrap();
        fs::write(project.join("docs/page.html"), "<p>").unwrap();
        let large = File::create(project.join("docs/large.html")).unwrap();
        large.set_len(HTML_DOCUMENT_LIMIT + 1).unwrap();
        let outside = fs::canonicalize(temp.path()).unwrap().join("outside.html");
        fs::write(&outside, "<p>").unwrap();

        assert_eq!(
            kind(resolve_html_document(
                &space(&project, "docs/missing.html"),
                &[]
            )),
            "source_missing"
        );
        assert_eq!(
            kind(resolve_html_document(
                &space(&project, "docs/notes.txt"),
                &[]
            )),
            "unsupported_format"
        );
        assert_eq!(
            kind(resolve_html_document(
                &space(&project, "../outside.html"),
                &[]
            )),
            "path_unresolved"
        );
        assert_eq!(
            kind(resolve_html_document(
                &space(&project, "/abs/page.html"),
                &[]
            )),
            "path_unresolved"
        );
        assert_eq!(
            kind(resolve_html_document(&space(&project, "docs"), &[])),
            "unsupported_format"
        );
        assert_eq!(
            kind(resolve_html_document(
                &space(&project, "docs/large.html"),
                &[]
            )),
            "resource_limit"
        );
        assert_eq!(
            kind(resolve_html_document(
                &local(Path::new("docs/page.html")),
                &[]
            )),
            "path_unresolved"
        );
        assert_eq!(
            kind(resolve_html_document(
                &local(Path::new("//server/share/a.html")),
                &[]
            )),
            "path_unresolved"
        );
        assert_eq!(kind(resolve_html_document(&local(&outside), &[])), "ok");

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            symlink(&outside, project.join("docs/linked.html")).unwrap();
            symlink(project.join("docs"), project.join("alias")).unwrap();
            assert_eq!(
                kind(resolve_html_document(
                    &space(&project, "docs/linked.html"),
                    &[]
                )),
                "symlink"
            );
            assert_eq!(
                kind(resolve_html_document(
                    &space(&project, "alias/page.html"),
                    &[]
                )),
                "symlink"
            );
            assert_eq!(
                kind(resolve_html_document(
                    &local(&project.join("docs/linked.html")),
                    &[]
                )),
                "symlink"
            );
        }
    }

    #[test]
    fn an_html_file_of_an_app_names_its_app_directory() {
        let temp = tempfile::tempdir().unwrap();
        let project = fs::canonicalize(temp.path()).unwrap().join("project");
        write_project(&project);
        fs::create_dir_all(project.join("tools/dash/public")).unwrap();
        fs::create_dir_all(project.join("reports")).unwrap();
        fs::write(project.join("tools/dash/app.yaml"), "runtime: static").unwrap();
        let app = |path: &str| html_app_directory(&project, None, path).unwrap();

        assert_eq!(
            app("tools/dash/public/index.html").as_deref(),
            Some("tools/dash")
        );
        assert_eq!(app("tools/dash/page.HTM").as_deref(), Some("tools/dash"));
        assert_eq!(app("reports/report.html"), None);
        assert_eq!(app("report.html"), None);
        assert!(html_app_directory(&project, None, "tools/dash/notes.pdf").is_err());
        assert!(html_app_directory(&project, None, "../outside.html").is_err());
    }

    #[test]
    fn a_local_html_file_is_resolved_by_its_absolute_path() {
        let temp = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(temp.path()).unwrap();
        fs::write(base.join("page.html"), "<p>").unwrap();
        fs::write(base.join("guide.pdf"), "%PDF").unwrap();
        let reason = |path: &Path| {
            serde_json::to_value(resolve_local_html(path).unwrap_err()).unwrap()["kind"]
                .as_str()
                .unwrap()
                .to_string()
        };

        assert_eq!(
            resolve_local_html(&base.join("page.html")).unwrap(),
            base.join("page.html")
        );
        // Other local files open in their system application.
        assert_eq!(reason(&base.join("guide.pdf")), "unsupported_format");
        assert_eq!(reason(Path::new("page.html")), "path_unresolved");
        assert_eq!(
            reason(Path::new("//server/share/page.html")),
            "path_unresolved"
        );
        assert_eq!(reason(&base.join("missing.html")), "source_missing");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(base.join("page.html"), base.join("linked.html")).unwrap();
            assert_eq!(reason(&base.join("linked.html")), "symlink");
        }
    }

    fn rendered(source: &[u8], theme: HtmlTheme) -> (String, String) {
        let entry = render_entry(source, theme);
        (String::from_utf8(entry.body).unwrap(), entry.charset)
    }

    #[test]
    fn a_fragment_is_wrapped_into_a_standards_mode_page() {
        for fragment in [
            "<div id=\"app\"></div>".as_bytes(),
            b"\xEF\xBB\xBF  \n<style>p{}</style><p>",
            b"<!-- artifact --> <script>1</script>",
            b"<htmlx></htmlx>",
        ] {
            let (page, charset) = rendered(fragment, HtmlTheme::Dark);
            assert!(
                page.starts_with("<!doctype html>\n<html data-theme=\"dark\">\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"),
                "{page}"
            );
            assert!(!page.contains('\u{FEFF}'));
            assert_eq!(charset, "utf-8");
        }
        for document in [
            "<!DOCTYPE html><HTML lang=\"en\"><body>".as_bytes(),
            b"\xEF\xBB\xBF<!-- a --><!doctype html>\n<!-- b -->\n<html>",
            b"  <Html class=\"x\">",
            b"<html>",
        ] {
            let (page, _) = rendered(document, HtmlTheme::Light);
            assert!(
                !page.starts_with("<!doctype html>\n<html data-theme"),
                "{page}"
            );
        }
    }

    #[test]
    fn the_theme_goes_on_the_html_element() {
        assert_eq!(
            rendered(
                b"<!DOCTYPE html>\n<HTML lang=\"en\" data-theme=\"x\"><body>",
                HtmlTheme::Dark
            )
            .0,
            "<!DOCTYPE html>\n<HTML data-theme=\"dark\" lang=\"en\" data-theme=\"x\"><body>"
        );
        assert_eq!(
            rendered(b"<!-- c --><html>", HtmlTheme::Light).0,
            "<!-- c --><html data-theme=\"light\">"
        );
        // A document without its own `<html>` gets one after the doctype.
        assert_eq!(
            rendered(b"<!doctype html><title>t</title>", HtmlTheme::Light).0,
            "<!doctype html><html data-theme=\"light\"><title>t</title>"
        );
    }

    #[test]
    fn the_declared_encoding_is_kept() {
        let entry = render_entry(
            b"<!doctype html><html><head><meta charset=\"windows-1251\"><title>\xcf\xf0\xe8</title>",
            HtmlTheme::Light,
        );
        assert_eq!(entry.charset, "windows-1251");
        assert!(entry.body.ends_with(b"<title>\xcf\xf0\xe8</title>"));
        assert_eq!(
            render_entry(
                b"<html><meta http-equiv=\"Content-Type\" content=\"text/html; charset=ISO-8859-1\">",
                HtmlTheme::Light
            )
            .charset,
            "iso-8859-1"
        );
        // A fragment's own charset goes into its wrapper.
        let fragment = render_entry(b"<meta charset=koi8-r><p>", HtmlTheme::Light);
        assert_eq!(fragment.charset, "koi8-r");
        assert!(String::from_utf8_lossy(&fragment.body).contains("<meta charset=\"koi8-r\">"));
        // A BOM wins over the declaration; UTF-16 is answered as UTF-8.
        assert_eq!(
            render_entry(
                b"\xEF\xBB\xBF<meta charset=\"windows-1251\">",
                HtmlTheme::Light
            )
            .charset,
            "utf-8"
        );
        let utf16: Vec<u8> = [0xFF, 0xFE]
            .into_iter()
            .chain("<html><p>Привет".encode_utf16().flat_map(u16::to_le_bytes))
            .collect();
        let (page, charset) = rendered(&utf16, HtmlTheme::Dark);
        assert_eq!(
            (page.as_str(), charset.as_str()),
            ("<html data-theme=\"dark\"><p>Привет", "utf-8")
        );
        assert_eq!(render_entry(b"<p>", HtmlTheme::Light).charset, "utf-8");
    }

    #[test]
    fn the_source_is_read_in_the_encoding_of_its_page() {
        let temp = tempfile::tempdir().unwrap();
        let encoding = |name: &str, bytes: &[u8]| {
            let path = temp.path().join(name);
            fs::write(&path, bytes).unwrap();
            html_source_encoding(&path).unwrap()
        };
        assert_eq!(
            encoding(
                "cp1251.html",
                b"<!doctype html><meta charset=\"windows-1251\"><title>\xcf\xf0\xe8</title>"
            ),
            "windows-1251"
        );
        let utf16: Vec<u8> = [0xFE, 0xFF]
            .into_iter()
            .chain("<p>Привет".encode_utf16().flat_map(u16::to_be_bytes))
            .collect();
        assert_eq!(encoding("utf16be.html", &utf16), "utf-16be");
        assert_eq!(encoding("utf16le.html", b"\xFF\xFE<\x00p\x00"), "utf-16le");
        assert_eq!(
            encoding("bom.html", b"\xEF\xBB\xBF<meta charset=koi8-r>"),
            "utf-8"
        );
        assert_eq!(encoding("plain.html", b"<p>"), "utf-8");
        // Only the first kilobyte declares it, as the page is served.
        let late = [
            vec![b' '; CHARSET_PRESCAN_BYTES],
            b"<meta charset=koi8-r>".to_vec(),
        ]
        .concat();
        assert_eq!(encoding("late.html", &late), "utf-8");
        assert!(matches!(
            html_source_encoding(&temp.path().join("gone.html")),
            Err(DocumentSourceError::SourceMissing)
        ));
    }

    #[test]
    fn changes_are_regular_files_of_the_root_outside_hidden_components() {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap().join("report");
        fs::create_dir_all(root.join("data")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join("index.html"), "<p>").unwrap();
        fs::write(root.join("data/a.csv"), "1").unwrap();
        fs::write(root.join(".git/HEAD"), "ref").unwrap();
        fs::write(root.join(".env"), "KEY=1").unwrap();
        let entry = root.join("index.html");
        let change =
            |path: &Path, single_file| is_document_change(&root, &entry, single_file, path, false);

        assert!(change(&entry, false));
        assert!(change(&root.join("data/a.csv"), false));
        assert!(change(&root.join("data/gone.csv"), false));
        assert!(!is_document_change(
            &root,
            &entry,
            false,
            &root.join("gone"),
            true
        ));
        assert!(!change(&root.join("data"), false));
        assert!(!change(&root.join(".git/HEAD"), false));
        assert!(!change(&root.join(".env"), false));
        assert!(!change(&temp.path().join("report-old/index.html"), false));
        assert!(change(&entry, true));
        assert!(!change(&root.join("data/a.csv"), true));
    }

    #[test]
    fn a_root_outside_the_project_is_observed_while_served() {
        let temp = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(temp.path()).unwrap();
        let root = base.join("scratch");
        let sibling = base.join("sibling");
        fs::create_dir_all(root.join("data")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(&sibling).unwrap();
        fs::write(root.join("index.html"), "<p>").unwrap();
        let (changed, received) = mpsc::channel();
        let observer = observe_outside(root.clone(), root.join("index.html"), false, move || {
            let _ = changed.send(());
        })
        .unwrap();
        // Let the backend start before the first write.
        std::thread::sleep(Duration::from_millis(300));

        fs::write(root.join(".git/HEAD"), "ref").unwrap();
        fs::write(sibling.join("index.html"), "<p>").unwrap();
        assert!(received.recv_timeout(Duration::from_millis(1500)).is_err());

        fs::write(root.join("data/a.csv"), "1").unwrap();
        assert!(received.recv_timeout(Duration::from_secs(5)).is_ok());
        drop(observer);
    }
}

use std::fs;
use std::io::Write;
use std::path::Path;

use crate::page::PageError;
use crate::page::frontmatter::{self, ParseStatus};

use super::{Entry, EntryMeta, EntryWarning, title_from_stem};

/// Current UTC timestamp in RFC 3339 format.
fn derived_file_dates(abs_path: &Path) -> Result<(String, String), PageError> {
    crate::page::filesystem_dates(abs_path).map_err(Into::into)
}

pub(super) fn fallback_title_for_path(path: &str) -> String {
    crate::page::fallback_title(path)
}

pub(super) fn meta_for_file_without_frontmatter(
    abs_path: &Path,
    path: &str,
) -> Result<EntryMeta, PageError> {
    let (created, updated) = derived_file_dates(abs_path)?;

    Ok(EntryMeta::synthesized(
        fallback_title_for_path(path),
        created,
        updated,
    ))
}

pub(super) fn apply_runtime_metadata(
    meta: &mut EntryMeta,
    abs_path: &Path,
    path: &str,
) -> Result<(), PageError> {
    if !meta.frontmatter_keys.title {
        meta.title = fallback_title_for_path(path);
    }
    let (created, updated) = derived_file_dates(abs_path)?;
    meta.created = created;
    meta.updated = updated;
    Ok(())
}

/// Read an entry from disk without mutating a missing or malformed frontmatter block.
pub fn read(space: &str, path: &str) -> Result<Entry, PageError> {
    let target = crate::page::resolve_page_target(Path::new(space), path)?;
    let source = crate::page::read_page_source(target)?;
    entry_from_source(source)
}

/// Source read of an entry with dates from the Git history of its effective
/// repository, for a reader without an index; falls back to file dates.
pub async fn read_with_git_dates(space: &str, path: &str) -> Result<Entry, PageError> {
    let target = crate::page::resolve_page_target(Path::new(space), path)?;
    let mut source = crate::page::read_page_source(target)?;
    crate::page::dates::enrich_source_git_dates(&mut source).await;
    entry_from_source(source)
}

pub fn entry_from_source(source: crate::page::PageSource) -> Result<Entry, PageError> {
    let meta = EntryMeta::from_page_source(&source);
    Ok(Entry {
        source_version: Some(source.version),
        meta,
        body: source.body,
        path: source.target.path,
        warnings: source
            .warnings
            .into_iter()
            .map(|warning| EntryWarning {
                kind: warning.kind,
                message: warning.message,
                path: None,
            })
            .collect(),
        name_conflict: source.name_conflict,
    })
}

pub(super) fn read_existing(abs_path: &Path) -> Result<(String, ParseStatus), PageError> {
    let existing = fs::read_to_string(abs_path)?;
    let parsed = frontmatter::parse_status(&existing);
    Ok((existing, parsed))
}

pub(super) fn write_body_preserving_frontmatter(
    abs_path: &Path,
    existing: &str,
    parsed: ParseStatus,
    body: &str,
) -> Result<(), PageError> {
    let full_content = match parsed {
        ParseStatus::Valid { .. } => {
            frontmatter::replace_body_preserving_frontmatter(existing, body)?
        }
        ParseStatus::Missing { .. } | ParseStatus::Malformed { .. } => body.to_string(),
    };
    if existing != full_content {
        replace_file(abs_path, full_content.as_bytes())?;
    }
    Ok(())
}

pub(super) fn write_serialized(
    abs_path: &Path,
    meta: &EntryMeta,
    body: &str,
) -> Result<(), PageError> {
    replace_file(abs_path, frontmatter::serialize(meta, body).as_bytes())?;
    Ok(())
}

/// Publishes the new bytes of one existing source by replacing the file
/// from a complete staged sibling copy: a reader sees the old or the new
/// bytes, and a crash leaves one of them. The copy is hidden and never
/// Markdown, so neither the content tree nor the index pick it up. The
/// source keeps its permissions and must itself be writable, as for an
/// in-place write. A new file is written directly: no reader has seen it.
fn replace_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    match fs::OpenOptions::new().write(true).open(path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return fs::write(path, bytes);
        }
        Err(error) => return Err(error),
    }
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let staged = staged_copy_path(path);
    let written = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staged)?;
        file.write_all(bytes)?;
        file.set_permissions(fs::metadata(path)?.permissions())?;
        file.sync_all()?;
        fs::rename(&staged, path)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&staged);
    }
    written?;
    #[cfg(unix)]
    fs::File::open(parent)?.sync_all()?;
    Ok(())
}

const STAGED_SUFFIX: &str = ".tmp";
const STAGED_ID_LEN: usize = 26;

/// Staged sibling copy of `path`: `.<name>.<id>.tmp`.
fn staged_copy_path(path: &Path) -> std::path::PathBuf {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let id = ulid::Ulid::new().to_string().to_lowercase();
    path.with_file_name(format!(".{name}.{id}{STAGED_SUFFIX}"))
}

/// Source that a staged copy at `path` replaces in place, if `path` is one.
/// A file watcher uses it to report the replacement of an existing source
/// as a change of that source, not as its creation.
pub fn replaced_by_staged_copy(path: &Path) -> Option<std::path::PathBuf> {
    let name = path.file_name()?.to_str()?;
    let inner = name.strip_prefix('.')?.strip_suffix(STAGED_SUFFIX)?;
    let (target, id) = inner.rsplit_once('.')?;
    (!target.is_empty()
        && id.len() == STAGED_ID_LEN
        && id.chars().all(|c| c.is_ascii_alphanumeric()))
    .then(|| path.with_file_name(target))
}

pub(super) fn refresh_markdown_copy_metadata(
    path: &Path,
    title_override: Option<&str>,
) -> Result<(), PageError> {
    let raw = fs::read_to_string(path)?;
    let (mut meta, body) = match frontmatter::try_parse(&raw)? {
        Some((meta, body)) => (meta, body),
        None => {
            let stem = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("untitled");
            (EntryMeta::new_persisted(title_from_stem(stem)), raw)
        }
    };
    if let Some(title) = title_override {
        meta.mark_title_present();
        meta.title = title.to_string();
    }
    write_serialized(path, &meta, &body)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;

    #[test]
    fn a_staged_copy_names_the_source_it_replaces() {
        let source = Path::new("/space/notes/Plan.v2.md");
        let staged = staged_copy_path(source);
        assert_eq!(replaced_by_staged_copy(&staged).as_deref(), Some(source));
        for other in [
            "/space/notes/Plan.v2.md",
            "/space/notes/.Plan.md.swp",
            "/space/notes/.Plan.md.tmp",
            "/space/notes/..0123456789abcdefghijklmnop.tmp",
        ] {
            assert_eq!(replaced_by_staged_copy(Path::new(other)), None, "{other}");
        }
    }

    #[test]
    fn body_write_preserves_frontmatter_bytes() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("note.md");
        let existing = "---\ntitle: Note\ncustom: 'quoted'\n---\nOld body\n";
        fs::write(&path, existing).unwrap();
        let (raw, parsed) = read_existing(&path).unwrap();

        write_body_preserving_frontmatter(&path, &raw, parsed, "New body\n").unwrap();

        assert_eq!(
            fs::read_to_string(path).unwrap(),
            "---\ntitle: Note\ncustom: 'quoted'\n---\nNew body\n"
        );
    }
}

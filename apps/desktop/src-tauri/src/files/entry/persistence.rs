use std::fs;
use std::path::Path;

use crate::error::AppError;
use crate::files::frontmatter::{self, ParseStatus};

use super::{Entry, EntryMeta, EntryWarning, title_from_stem};

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

fn derived_file_dates(abs_path: &Path) -> Result<(String, String), AppError> {
    let fs_meta = fs::metadata(abs_path)?;
    Ok((
        system_time_to_rfc3339(fs_meta.created()),
        system_time_to_rfc3339(fs_meta.modified()),
    ))
}

pub(super) fn fallback_title_for_path(path: &str) -> String {
    let stem = Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("untitled");
    title_from_stem(stem)
}

pub(super) fn meta_for_file_without_frontmatter(
    abs_path: &Path,
    path: &str,
) -> Result<EntryMeta, AppError> {
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
) -> Result<(), AppError> {
    if !meta.frontmatter_keys.title {
        meta.title = fallback_title_for_path(path);
    }
    let (created, updated) = derived_file_dates(abs_path)?;
    meta.created = created;
    meta.updated = updated;
    Ok(())
}

/// Read an entry from disk without mutating a missing or malformed frontmatter block.
pub fn read(space: &str, path: &str) -> Result<Entry, AppError> {
    let abs_path = Path::new(space).join(path);

    if !abs_path.exists() {
        return Err(AppError::FileNotFound(path.to_string()));
    }

    let content = fs::read_to_string(&abs_path)?;

    match frontmatter::parse_status(&content) {
        ParseStatus::Valid { mut meta, body } => {
            apply_runtime_metadata(&mut meta, &abs_path, path)?;
            Ok(Entry {
                meta,
                body,
                path: path.to_string(),
                warnings: Vec::new(),
            })
        }
        ParseStatus::Missing { body } => {
            let meta = meta_for_file_without_frontmatter(&abs_path, path)?;
            Ok(Entry {
                meta,
                body,
                path: path.to_string(),
                warnings: Vec::new(),
            })
        }
        ParseStatus::Malformed { message, body } => {
            let meta = meta_for_file_without_frontmatter(&abs_path, path)?;
            Ok(Entry {
                meta,
                body,
                path: path.to_string(),
                warnings: vec![EntryWarning::malformed_frontmatter(message)],
            })
        }
    }
}

pub(super) fn read_existing(abs_path: &Path) -> Result<(String, ParseStatus), AppError> {
    let existing = fs::read_to_string(abs_path)?;
    let parsed = frontmatter::parse_status(&existing);
    Ok((existing, parsed))
}

pub(super) fn write_body_preserving_frontmatter(
    abs_path: &Path,
    existing: &str,
    parsed: ParseStatus,
    body: &str,
) -> Result<(), AppError> {
    let full_content = match parsed {
        ParseStatus::Valid { .. } => {
            frontmatter::replace_body_preserving_frontmatter(existing, body)?
        }
        ParseStatus::Missing { .. } | ParseStatus::Malformed { .. } => body.to_string(),
    };
    if existing != full_content {
        fs::write(abs_path, full_content)?;
    }
    Ok(())
}

pub(super) fn write_serialized(
    abs_path: &Path,
    meta: &EntryMeta,
    body: &str,
) -> Result<(), AppError> {
    fs::write(abs_path, frontmatter::serialize(meta, body))?;
    Ok(())
}

pub(super) fn refresh_markdown_copy_metadata(
    path: &Path,
    title_suffix: Option<&str>,
) -> Result<(), AppError> {
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
    if let Some(suffix) = title_suffix {
        meta.mark_title_present();
        meta.title.push_str(suffix);
    }
    write_serialized(path, &meta, &body)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;

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

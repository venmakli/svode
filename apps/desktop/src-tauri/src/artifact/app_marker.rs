use std::fs;
use std::io::{Read, Take};
use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;

use crate::AppError;
use crate::artifact::identity::SourceShape;
use crate::repo_path::{RootMode, normalize_repo_relative};

const MAX_APP_INDEX_PROBE_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AppMarkerInvalidReason {
    Duplicate,
    InvalidEncoding,
    InvalidValue,
    Malformed,
    ProbeLimit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum AppMarkerProbe {
    NoMatch,
    Match,
    Invalid { reason: AppMarkerInvalidReason },
}

pub(crate) fn probe_app_target(
    space_path: &str,
    target_path: &str,
    source_shape: SourceShape,
) -> Result<AppMarkerProbe, AppError> {
    if source_shape != SourceShape::Directory {
        return Ok(AppMarkerProbe::NoMatch);
    }

    let normalized_target = normalize_repo_relative(target_path, RootMode::Reject)?;
    let target = Path::new(&normalized_target);
    let app_root = if target
        .file_name()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("README.md"))
    {
        target.parent().ok_or_else(|| {
            AppError::PathNotAccessible(format!(
                "directory-backed artifact has no parent: {normalized_target}"
            ))
        })?
    } else {
        target
    };

    let canonical_space = fs::canonicalize(space_path).map_err(|error| {
        AppError::PathNotAccessible(format!("cannot resolve space path {space_path}: {error}"))
    })?;
    let canonical_app_root = fs::canonicalize(canonical_space.join(app_root)).map_err(|error| {
        AppError::PathNotAccessible(format!(
            "cannot resolve artifact target {normalized_target}: {error}"
        ))
    })?;
    if !canonical_app_root.starts_with(&canonical_space) {
        return Err(AppError::PathNotAccessible(format!(
            "artifact target escapes space boundary: {normalized_target}"
        )));
    }
    if !canonical_app_root.is_dir() {
        return Err(AppError::PathNotAccessible(format!(
            "directory artifact target is not a directory: {normalized_target}"
        )));
    }

    probe_app_directory(&canonical_app_root, &canonical_space)
}

pub(crate) fn probe_app_directory(
    app_root: &Path,
    boundary: &Path,
) -> Result<AppMarkerProbe, AppError> {
    let index_path = app_root.join("index.html");
    let metadata = match fs::symlink_metadata(&index_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AppMarkerProbe::NoMatch);
        }
        Err(error) => return Err(error.into()),
    };
    if !metadata.file_type().is_file() && !metadata.file_type().is_symlink() {
        return Ok(AppMarkerProbe::Invalid {
            reason: AppMarkerInvalidReason::Malformed,
        });
    }

    let canonical_boundary = fs::canonicalize(boundary)?;
    let canonical_root = fs::canonicalize(app_root)?;
    let canonical_index = fs::canonicalize(&index_path)?;
    if !canonical_root.starts_with(&canonical_boundary)
        || !canonical_index.starts_with(&canonical_root)
    {
        return Err(AppError::PathNotAccessible(format!(
            "App index escapes artifact boundary: {}",
            index_path.display()
        )));
    }

    let file = fs::File::open(&canonical_index)?;
    probe_index_prefix(file.take(MAX_APP_INDEX_PROBE_BYTES + 1))
}

fn probe_index_prefix(mut reader: Take<fs::File>) -> Result<AppMarkerProbe, AppError> {
    let mut bytes = Vec::with_capacity(MAX_APP_INDEX_PROBE_BYTES as usize + 1);
    reader.read_to_end(&mut bytes)?;
    let truncated = bytes.len() > MAX_APP_INDEX_PROBE_BYTES as usize;
    bytes.truncate(MAX_APP_INDEX_PROBE_BYTES as usize);

    let source = match String::from_utf8(bytes) {
        Ok(source) => source,
        Err(error) => {
            let bytes = error.into_bytes();
            let contains_marker = String::from_utf8_lossy(&bytes)
                .to_ascii_lowercase()
                .contains("svode-app");
            return Ok(if contains_marker {
                AppMarkerProbe::Invalid {
                    reason: AppMarkerInvalidReason::InvalidEncoding,
                }
            } else {
                AppMarkerProbe::NoMatch
            });
        }
    };

    parse_index_prefix(&source, truncated)
}

fn parse_index_prefix(source: &str, truncated: bool) -> Result<AppMarkerProbe, AppError> {
    let lowercase = source.to_ascii_lowercase();
    let contains_marker = lowercase.contains("svode-app");
    let Some(head) = head_regex()
        .captures(source)
        .and_then(|captures| captures.get(1))
        .map(|capture| capture.as_str())
    else {
        return Ok(if contains_marker {
            AppMarkerProbe::Invalid {
                reason: if truncated {
                    AppMarkerInvalidReason::ProbeLimit
                } else {
                    AppMarkerInvalidReason::Malformed
                },
            }
        } else {
            AppMarkerProbe::NoMatch
        });
    };

    let marker_tags = meta_tag_regex()
        .find_iter(head)
        .filter_map(|matched| {
            let tag = matched.as_str();
            let attributes = parse_attributes(tag);
            let names = attributes
                .iter()
                .filter(|(name, _)| name.eq_ignore_ascii_case("name"))
                .map(|(_, value)| value.trim().to_string())
                .collect::<Vec<_>>();
            let mentions_marker = tag.to_ascii_lowercase().contains("svode-app");
            let declares_marker = names
                .iter()
                .any(|value| value.eq_ignore_ascii_case("svode-app"));
            (mentions_marker || declares_marker).then_some((attributes, names))
        })
        .collect::<Vec<_>>();

    if marker_tags.is_empty() {
        return Ok(if contains_marker {
            AppMarkerProbe::Invalid {
                reason: AppMarkerInvalidReason::Malformed,
            }
        } else {
            AppMarkerProbe::NoMatch
        });
    }
    if marker_tags.len() > 1 {
        return Ok(AppMarkerProbe::Invalid {
            reason: AppMarkerInvalidReason::Duplicate,
        });
    }

    let (attributes, names) = &marker_tags[0];
    if names.len() != 1 || !names[0].eq_ignore_ascii_case("svode-app") {
        return Ok(AppMarkerProbe::Invalid {
            reason: AppMarkerInvalidReason::Malformed,
        });
    }
    let contents = attributes
        .iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case("content"))
        .map(|(_, value)| value.trim())
        .collect::<Vec<_>>();
    if contents.len() != 1 {
        return Ok(AppMarkerProbe::Invalid {
            reason: AppMarkerInvalidReason::Malformed,
        });
    }
    if contents[0] != "1" {
        return Ok(AppMarkerProbe::Invalid {
            reason: AppMarkerInvalidReason::InvalidValue,
        });
    }

    Ok(AppMarkerProbe::Match)
}

fn parse_attributes(tag: &str) -> Vec<(String, String)> {
    attribute_regex()
        .captures_iter(tag)
        .filter_map(|captures| {
            let name = captures.get(1)?.as_str().to_string();
            let value = captures
                .get(2)
                .or_else(|| captures.get(3))
                .or_else(|| captures.get(4))?
                .as_str()
                .to_string();
            Some((name, value))
        })
        .collect()
}

fn head_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"(?is)<head(?:\s[^>]*)?>(.*?)</head\s*>").unwrap())
}

fn meta_tag_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"(?is)<meta\b[^>]*>").unwrap())
}

fn attribute_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r#"(?is)([a-z_:][a-z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))"#)
            .unwrap()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    fn write_app_index(root: &Path, source: &str) {
        fs::create_dir_all(root).unwrap();
        fs::write(root.join("index.html"), source).unwrap();
    }

    #[test]
    fn detects_one_marker_in_the_bounded_head() {
        let temp = TempDir::new().unwrap();
        let app = temp.path().join("dashboard");
        write_app_index(
            &app,
            r#"<!doctype html><html><head><meta content='1' name='SVODE-APP'></head><body></body></html>"#,
        );

        assert_eq!(
            probe_app_target(
                temp.path().to_str().unwrap(),
                "dashboard/README.md",
                SourceShape::Directory,
            )
            .unwrap(),
            AppMarkerProbe::Match
        );
    }

    #[test]
    fn ordinary_index_does_not_claim_a_directory_backed_page() {
        let temp = TempDir::new().unwrap();
        let app = temp.path().join("docs");
        write_app_index(
            &app,
            "<!doctype html><html><head><title>Docs</title></head></html>",
        );

        assert_eq!(
            probe_app_target(
                temp.path().to_str().unwrap(),
                "docs/README.md",
                SourceShape::Directory,
            )
            .unwrap(),
            AppMarkerProbe::NoMatch
        );
    }

    #[test]
    fn invalid_and_duplicate_markers_do_not_fall_through() {
        let temp = TempDir::new().unwrap();
        let invalid = temp.path().join("invalid");
        write_app_index(
            &invalid,
            r#"<html><head><meta name="svode-app" content="2"></head></html>"#,
        );
        let duplicate = temp.path().join("duplicate");
        write_app_index(
            &duplicate,
            r#"<html><head><meta name="svode-app" content="1"><meta content="1" name="svode-app"></head></html>"#,
        );

        assert_eq!(
            probe_app_target(
                temp.path().to_str().unwrap(),
                "invalid/README.md",
                SourceShape::Directory,
            )
            .unwrap(),
            AppMarkerProbe::Invalid {
                reason: AppMarkerInvalidReason::InvalidValue,
            }
        );
        assert_eq!(
            probe_app_target(
                temp.path().to_str().unwrap(),
                "duplicate/README.md",
                SourceShape::Directory,
            )
            .unwrap(),
            AppMarkerProbe::Invalid {
                reason: AppMarkerInvalidReason::Duplicate,
            }
        );
    }

    #[test]
    fn marker_after_the_probe_boundary_is_not_detected() {
        let temp = TempDir::new().unwrap();
        let app = temp.path().join("large");
        fs::create_dir_all(&app).unwrap();
        let mut index = fs::File::create(app.join("index.html")).unwrap();
        index.write_all(b"<html><head>").unwrap();
        index
            .write_all(&vec![b' '; MAX_APP_INDEX_PROBE_BYTES as usize])
            .unwrap();
        index
            .write_all(b"<meta name=\"svode-app\" content=\"1\"></head></html>")
            .unwrap();

        assert_eq!(
            probe_app_target(
                temp.path().to_str().unwrap(),
                "large/README.md",
                SourceShape::Directory,
            )
            .unwrap(),
            AppMarkerProbe::NoMatch
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_an_index_symlink_that_escapes_the_app_root() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new().unwrap();
        let app = temp.path().join("app");
        fs::create_dir_all(&app).unwrap();
        let external = temp.path().join("external.html");
        fs::write(
            &external,
            r#"<html><head><meta name="svode-app" content="1"></head></html>"#,
        )
        .unwrap();
        symlink(&external, app.join("index.html")).unwrap();

        assert!(
            probe_app_target(
                temp.path().to_str().unwrap(),
                "app/README.md",
                SourceShape::Directory,
            )
            .is_err()
        );
    }
}

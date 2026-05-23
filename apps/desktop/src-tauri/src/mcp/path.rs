use std::path::{Component, Path, PathBuf};

use super::error::McpBusinessError;

pub fn validate_public_rel_path(path: &str, allow_root: bool) -> Result<String, McpBusinessError> {
    let raw = path.trim();
    if raw.is_empty() {
        if allow_root {
            return Ok(String::new());
        }
        return Err(McpBusinessError::new(
            "INVALID_PATH",
            "path must not be empty",
        ));
    }
    if raw.starts_with('/')
        || raw.starts_with('\\')
        || raw.starts_with("//")
        || raw.starts_with("\\\\")
        || has_windows_drive_prefix(raw)
    {
        return Err(McpBusinessError::new(
            "INVALID_PATH",
            "absolute paths are not accepted",
        ));
    }

    let normalized = raw.replace('\\', "/");
    if normalized == "." {
        if allow_root {
            return Ok(String::new());
        }
        return Err(McpBusinessError::new(
            "INVALID_PATH",
            "path must not be empty",
        ));
    }
    let mut parts = Vec::new();
    for part in normalized.split('/') {
        match part {
            "" | "." => {
                return Err(McpBusinessError::new(
                    "INVALID_PATH",
                    "path must not contain empty or '.' segments",
                ));
            }
            ".." => {
                return Err(McpBusinessError::new(
                    "INVALID_PATH",
                    "path must not contain '..'",
                ));
            }
            _ => parts.push(part),
        }
    }
    if parts.is_empty() && !allow_root {
        return Err(McpBusinessError::new(
            "INVALID_PATH",
            "path must not be empty",
        ));
    }
    if let Some(first) = parts.first() {
        if first.eq_ignore_ascii_case(".git") || first.eq_ignore_ascii_case(".combai") {
            return Err(McpBusinessError::new(
                "PATH_FORBIDDEN",
                ".git and .combai paths are not exposed through public MCP document tools",
            ));
        }
    }
    Ok(parts.join("/"))
}

pub fn validate_document_path(path: &str) -> Result<String, McpBusinessError> {
    let path = validate_public_rel_path(path, false)?;
    if Path::new(&path)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
    {
        Ok(path)
    } else {
        Err(McpBusinessError::new(
            "INVALID_PATH",
            "document path must end with .md",
        ))
    }
}

pub fn normalize_create_document_path(path: &str) -> Result<String, McpBusinessError> {
    let trimmed = path.trim();
    if trimmed.ends_with('/') || trimmed.ends_with('\\') {
        let base = trimmed.trim_end_matches(['/', '\\']);
        let base = validate_public_rel_path(base, false)?;
        return validate_document_path(&format!("{base}/README.md"));
    }
    let mut rel = validate_public_rel_path(path, false)?;
    if Path::new(&rel).extension().is_none() {
        rel.push_str(".md");
    }
    validate_document_path(&rel)
}

pub fn ensure_inside(root: &Path, rel: &str) -> Result<PathBuf, McpBusinessError> {
    let normalized_root = root.canonicalize().map_err(|error| {
        McpBusinessError::new(
            "PATH_FORBIDDEN",
            format!("root path could not be canonicalized: {error}"),
        )
    })?;
    let target = normalized_root.join(rel);
    let normalized = normalize_path(&target).ok_or_else(|| {
        McpBusinessError::new("INVALID_PATH", "path could not be normalized safely")
    })?;
    if !normalized.starts_with(&normalized_root) {
        return Err(McpBusinessError::new(
            "PATH_FORBIDDEN",
            "path resolves outside the active CombAI space",
        ));
    }

    let existing = nearest_existing_path(&normalized);
    let existing = existing.canonicalize().map_err(|error| {
        McpBusinessError::new(
            "PATH_FORBIDDEN",
            format!("path could not be canonicalized safely: {error}"),
        )
    })?;
    if existing.starts_with(&normalized_root) {
        Ok(normalized)
    } else {
        Err(McpBusinessError::new(
            "PATH_FORBIDDEN",
            "path resolves outside the active CombAI space",
        ))
    }
}

fn nearest_existing_path(path: &Path) -> PathBuf {
    let mut current = path.to_path_buf();
    while !current.exists() {
        if !current.pop() {
            break;
        }
    }
    current
}

fn has_windows_drive_prefix(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic()
}

fn normalize_path(path: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push(std::path::MAIN_SEPARATOR.to_string()),
            Component::CurDir => {}
            Component::Normal(part) => out.push(part),
            Component::ParentDir => {
                if !out.pop() {
                    return None;
                }
            }
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_absolute_and_escape_paths() {
        for value in ["/tmp/a.md", "C:/tmp/a.md", "\\\\server\\share", "a/../b.md"] {
            assert!(validate_public_rel_path(value, false).is_err(), "{value}");
        }
    }

    #[test]
    fn rejects_internal_dirs() {
        assert!(validate_public_rel_path(".git/config", false).is_err());
        assert!(validate_public_rel_path(".combai/config.json", false).is_err());
    }

    #[test]
    fn accepts_dot_only_as_root_when_allowed() {
        assert_eq!(validate_public_rel_path(".", true).unwrap(), "");
        assert!(validate_public_rel_path(".", false).is_err());
        assert!(validate_public_rel_path("./docs", true).is_err());
    }

    #[test]
    fn normalizes_valid_paths() {
        assert_eq!(
            validate_public_rel_path("docs\\note.md", false).unwrap(),
            "docs/note.md"
        );
        assert_eq!(
            normalize_create_document_path("docs/new-note").unwrap(),
            "docs/new-note.md"
        );
        assert_eq!(
            normalize_create_document_path("docs/").unwrap(),
            "docs/README.md"
        );
    }
}

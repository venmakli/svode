use std::path::{Component, Path};

use super::GitError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootPolicy {
    Reject,
    Allow,
}

pub type RootMode = RootPolicy;

#[cfg(test)]
pub fn normalize_repo_path(path: &str) -> Result<String, GitError> {
    normalize_repo_path_with(path, RootPolicy::Reject)
}

#[cfg(test)]
pub fn normalize_repo_path_allow_root(path: &str) -> Result<String, GitError> {
    normalize_repo_path_with(path, RootPolicy::Allow)
}

pub fn normalize_repo_path_with(path: &str, root_policy: RootPolicy) -> Result<String, GitError> {
    let normalized = path.replace('\\', "/");
    validate_normalized(&normalized, root_policy)
}

pub fn normalize_repo_relative(path: &str, root_policy: RootMode) -> Result<String, GitError> {
    normalize_repo_path_with(path, root_policy)
}

pub fn path_to_repo_path(path: &Path, root_policy: RootPolicy) -> Result<String, GitError> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => {
                let Some(part) = part.to_str() else {
                    return Err(GitError::PathNotAccessible(format!(
                        "path is not valid UTF-8: {}",
                        path.display()
                    )));
                };
                parts.push(part);
            }
            Component::CurDir if parts.is_empty() => {}
            Component::ParentDir => {
                return Err(GitError::PathNotAccessible(format!(
                    "repo-relative path cannot contain '..': {}",
                    path.display()
                )));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(GitError::PathNotAccessible(format!(
                    "repo-relative path cannot be absolute: {}",
                    path.display()
                )));
            }
            Component::CurDir => {
                return Err(GitError::PathNotAccessible(format!(
                    "repo-relative path cannot contain '.': {}",
                    path.display()
                )));
            }
        }
    }

    if parts.is_empty() {
        return match root_policy {
            RootPolicy::Allow => Ok(".".to_string()),
            RootPolicy::Reject => Err(GitError::PathNotAccessible(
                "repo-relative path cannot be empty".to_string(),
            )),
        };
    }

    normalize_repo_path_with(&parts.join("/"), root_policy)
}

pub fn repo_relative_from_path(path: &Path, root_policy: RootMode) -> Result<String, GitError> {
    path_to_repo_path(path, root_policy)
}

pub fn repo_relative_from_base(
    base: &Path,
    path: &Path,
    root_policy: RootMode,
) -> Result<String, GitError> {
    let rel = path.strip_prefix(base).map_err(|_| {
        GitError::PathNotAccessible(format!("path is outside repo root: {}", path.display()))
    })?;
    path_to_repo_path(rel, root_policy)
}

fn validate_normalized(path: &str, root_policy: RootPolicy) -> Result<String, GitError> {
    if path == "." {
        return match root_policy {
            RootPolicy::Allow => Ok(".".to_string()),
            RootPolicy::Reject => Err(GitError::PathNotAccessible(
                "repo-relative path cannot be root marker '.'".to_string(),
            )),
        };
    }

    if path.is_empty() {
        return match root_policy {
            RootPolicy::Allow => Ok(".".to_string()),
            RootPolicy::Reject => Err(GitError::PathNotAccessible(
                "repo-relative path cannot be empty".to_string(),
            )),
        };
    }
    if path.starts_with('/') {
        return Err(GitError::PathNotAccessible(format!(
            "repo-relative path cannot be absolute: {path}"
        )));
    }
    if has_drive_prefix(path) {
        return Err(GitError::PathNotAccessible(format!(
            "repo-relative path cannot contain a drive prefix: {path}"
        )));
    }

    for segment in path.split('/') {
        if segment.is_empty() {
            return Err(GitError::PathNotAccessible(format!(
                "repo-relative path cannot contain empty segments: {path}"
            )));
        }
        if segment == "." || segment == ".." {
            return Err(GitError::PathNotAccessible(format!(
                "repo-relative path cannot contain '{segment}' segments: {path}"
            )));
        }
    }

    Ok(path.to_string())
}

fn has_drive_prefix(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_windows_separators_spaces_and_unicode() {
        assert_eq!(
            normalize_repo_path("Folder With Space\\кириллица.md").unwrap(),
            "Folder With Space/кириллица.md"
        );
    }

    #[test]
    fn rejects_absolute_drive_unc_and_leading_slash() {
        assert!(normalize_repo_path("/docs/readme.md").is_err());
        assert!(normalize_repo_path("C:\\docs\\readme.md").is_err());
        assert!(normalize_repo_path("C:/docs/readme.md").is_err());
        assert!(normalize_repo_path("\\\\server\\share\\file.md").is_err());
    }

    #[test]
    fn rejects_parent_empty_and_dot_segments() {
        assert!(normalize_repo_path("../readme.md").is_err());
        assert!(normalize_repo_path("docs//readme.md").is_err());
        assert!(normalize_repo_path("docs/./readme.md").is_err());
    }

    #[test]
    fn root_marker_requires_explicit_policy() {
        assert!(normalize_repo_path(".").is_err());
        assert_eq!(normalize_repo_path_allow_root(".").unwrap(), ".");
        assert_eq!(normalize_repo_path_allow_root("").unwrap(), ".");
    }

    #[test]
    fn path_components_convert_to_repo_paths() {
        assert_eq!(
            path_to_repo_path(Path::new("docs/readme.md"), RootPolicy::Reject).unwrap(),
            "docs/readme.md"
        );
        assert_eq!(
            path_to_repo_path(Path::new(""), RootPolicy::Allow).unwrap(),
            "."
        );
    }
}

/// Resolve a repo-relative path inside `root` without leaving it through a
/// symlink or a parent traversal. The returned path may not exist yet.
pub fn contained_file(root: &Path, path: &str) -> Result<std::path::PathBuf, GitError> {
    let path = normalize_repo_relative(path, RootMode::Reject)?;
    let root = root.canonicalize()?;
    let target = root.join(&path);
    let mut component = root.clone();
    for part in path.split('/') {
        component.push(part);
        if std::fs::symlink_metadata(&component)
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err(GitError::PathNotAccessible(
                "Symlink source is unavailable".into(),
            ));
        }
    }
    let mut ancestor = target.as_path();
    while !ancestor.exists() {
        ancestor = ancestor
            .parent()
            .ok_or_else(|| GitError::PathNotAccessible("Source unavailable".into()))?;
    }
    if !ancestor.canonicalize()?.starts_with(&root) {
        return Err(GitError::PathNotAccessible(
            "Source leaves repository scope".into(),
        ));
    }
    Ok(target)
}

/// A registered child Space folder: one ASCII path segment under its parent.
pub fn normalize_space_folder(folder_name: &str) -> Result<String, GitError> {
    let normalized = normalize_repo_relative(&folder_name.replace('\\', "/"), RootMode::Reject)?;
    let is_single_ascii_segment = !normalized.contains('/')
        && normalized
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !is_single_ascii_segment {
        return Err(GitError::PathNotAccessible(folder_name.to_string()));
    }
    Ok(normalized)
}

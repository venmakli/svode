use std::path::{Component, Path};

use crate::AppError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootPolicy {
    Reject,
    Allow,
}

pub type RootMode = RootPolicy;

#[cfg(test)]
pub fn normalize_repo_path(path: &str) -> Result<String, AppError> {
    normalize_repo_path_with(path, RootPolicy::Reject)
}

#[cfg(test)]
pub fn normalize_repo_path_allow_root(path: &str) -> Result<String, AppError> {
    normalize_repo_path_with(path, RootPolicy::Allow)
}

pub fn normalize_repo_path_with(path: &str, root_policy: RootPolicy) -> Result<String, AppError> {
    let normalized = path.replace('\\', "/");
    validate_normalized(&normalized, root_policy)
}

pub fn normalize_repo_relative(path: &str, root_policy: RootMode) -> Result<String, AppError> {
    normalize_repo_path_with(path, root_policy)
}

pub fn path_to_repo_path(path: &Path, root_policy: RootPolicy) -> Result<String, AppError> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => {
                let Some(part) = part.to_str() else {
                    return Err(AppError::PathNotAccessible(format!(
                        "path is not valid UTF-8: {}",
                        path.display()
                    )));
                };
                parts.push(part);
            }
            Component::CurDir if parts.is_empty() => {}
            Component::ParentDir => {
                return Err(AppError::PathNotAccessible(format!(
                    "repo-relative path cannot contain '..': {}",
                    path.display()
                )));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(AppError::PathNotAccessible(format!(
                    "repo-relative path cannot be absolute: {}",
                    path.display()
                )));
            }
            Component::CurDir => {
                return Err(AppError::PathNotAccessible(format!(
                    "repo-relative path cannot contain '.': {}",
                    path.display()
                )));
            }
        }
    }

    if parts.is_empty() {
        return match root_policy {
            RootPolicy::Allow => Ok(".".to_string()),
            RootPolicy::Reject => Err(AppError::PathNotAccessible(
                "repo-relative path cannot be empty".to_string(),
            )),
        };
    }

    normalize_repo_path_with(&parts.join("/"), root_policy)
}

pub fn repo_relative_from_path(path: &Path, root_policy: RootMode) -> Result<String, AppError> {
    path_to_repo_path(path, root_policy)
}

pub fn repo_relative_from_base(
    base: &Path,
    path: &Path,
    root_policy: RootMode,
) -> Result<String, AppError> {
    let rel = path.strip_prefix(base).map_err(|_| {
        AppError::PathNotAccessible(format!("path is outside repo root: {}", path.display()))
    })?;
    path_to_repo_path(rel, root_policy)
}

fn validate_normalized(path: &str, root_policy: RootPolicy) -> Result<String, AppError> {
    if path == "." {
        return match root_policy {
            RootPolicy::Allow => Ok(".".to_string()),
            RootPolicy::Reject => Err(AppError::PathNotAccessible(
                "repo-relative path cannot be root marker '.'".to_string(),
            )),
        };
    }

    if path.is_empty() {
        return match root_policy {
            RootPolicy::Allow => Ok(".".to_string()),
            RootPolicy::Reject => Err(AppError::PathNotAccessible(
                "repo-relative path cannot be empty".to_string(),
            )),
        };
    }
    if path.starts_with('/') {
        return Err(AppError::PathNotAccessible(format!(
            "repo-relative path cannot be absolute: {path}"
        )));
    }
    if has_drive_prefix(path) {
        return Err(AppError::PathNotAccessible(format!(
            "repo-relative path cannot contain a drive prefix: {path}"
        )));
    }

    for segment in path.split('/') {
        if segment.is_empty() {
            return Err(AppError::PathNotAccessible(format!(
                "repo-relative path cannot contain empty segments: {path}"
            )));
        }
        if segment == "." || segment == ".." {
            return Err(AppError::PathNotAccessible(format!(
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

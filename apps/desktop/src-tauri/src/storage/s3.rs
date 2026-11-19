//! S3 prefix defaults of the storage settings and removal of the local agent
//! config; the connection check and the agent config belong to
//! `svode_core::storage::s3`.

use std::path::Path;

use crate::error::AppError;

pub const AGENT_CONFIG_REL: &str = svode_core::storage::s3::CONFIG_REL;

fn slug_source(source: &str) -> String {
    let mut out = String::new();
    let mut pending_separator = false;

    for ch in source.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_separator && !out.is_empty() {
                out.push('-');
            }
            out.push(ch.to_ascii_lowercase());
            pending_separator = false;
        } else if ch.is_whitespace() || matches!(ch, '-' | '_' | '.' | '/' | '\\' | ':' | '+' | '&')
        {
            pending_separator = !out.is_empty();
        }
    }

    out.trim_matches('-').to_string()
}

pub fn normalize_prefix_part(source: &str, fallback: &str) -> String {
    let normalized = slug_source(source);
    if !normalized.is_empty() {
        return normalized;
    }

    let fallback = slug_source(fallback);
    if fallback.is_empty() {
        "project".to_string()
    } else {
        fallback
    }
}

fn project_prefix(project: &Path, project_name: Option<&str>) -> String {
    let path_name = project
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let from_path = slug_source(path_name);
    if !from_path.is_empty() {
        return from_path;
    }

    project_name
        .map(|name| normalize_prefix_part(name, "project"))
        .unwrap_or_else(|| "project".to_string())
}

pub fn default_root_prefix(project: &Path, project_name: Option<&str>) -> String {
    format!("{}/root", project_prefix(project, project_name))
}

pub fn default_repo_space_prefix(
    project: &Path,
    project_name: Option<&str>,
    space_dir: &Path,
) -> String {
    let raw_space = space_dir
        .strip_prefix(project)
        .ok()
        .and_then(|path| path.to_str())
        .or_else(|| space_dir.file_name().and_then(|name| name.to_str()))
        .unwrap_or("");
    let space_prefix = normalize_prefix_part(raw_space, "space");
    format!("{}/{}", project_prefix(project, project_name), space_prefix)
}

pub fn normalize_prefix_path(prefix: &str, fallback: &str) -> String {
    let segments = prefix
        .trim()
        .trim_matches('/')
        .split(['/', '\\'])
        .map(slug_source)
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();

    if segments.is_empty() {
        fallback.trim_matches('/').to_string()
    } else {
        segments.join("/")
    }
}

/// Delete the agent config file. Missing file is fine.
pub fn delete_agent_config(space_dir: &Path) -> Result<(), AppError> {
    let path = space_dir.join(AGENT_CONFIG_REL);
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_part_normalization_builds_path_safe_slugs() {
        assert_eq!(normalize_prefix_part(" Big Quest ", "project"), "big-quest");
        assert_eq!(
            normalize_prefix_part("Marketing Docs/2026", "space"),
            "marketing-docs-2026"
        );
        assert_eq!(normalize_prefix_part("!!!", "space"), "space");
    }

    #[test]
    fn default_prefixes_use_project_root_and_repo_space_layout() {
        let project = Path::new("/tmp/Big Quest");
        assert_eq!(
            default_root_prefix(project, Some("Ignored")),
            "big-quest/root"
        );
        assert_eq!(
            default_repo_space_prefix(
                project,
                Some("Ignored"),
                Path::new("/tmp/Big Quest/Marketing")
            ),
            "big-quest/marketing"
        );
    }

    #[test]
    fn prefix_path_normalization_preserves_safe_segments() {
        assert_eq!(
            normalize_prefix_path(" / Big Quest // Marketing Docs / ", "fallback/root"),
            "big-quest/marketing-docs"
        );
        assert_eq!(
            normalize_prefix_path("///", "fallback/root"),
            "fallback/root"
        );
    }
}

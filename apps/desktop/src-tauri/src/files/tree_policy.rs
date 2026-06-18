use std::path::{Component, Path, PathBuf};

use crate::space::config::read_space_config;

const SYSTEM_EXCLUDED_DIRS: &[&str] = &[".git", ".svode", ".assets", ".templates"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TreePathKind {
    File,
    Directory,
    Unknown,
}

#[derive(Debug, Clone)]
pub struct TreeIgnorePolicy {
    root: PathBuf,
    user_excludes: Vec<TreePattern>,
    user_includes: Vec<TreePattern>,
    pub show_ignored_placeholders: bool,
}

impl TreeIgnorePolicy {
    pub fn system_only(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
            user_excludes: Vec::new(),
            user_includes: Vec::new(),
            show_ignored_placeholders: false,
        }
    }

    pub fn from_space_root(root: &Path) -> Self {
        let mut policy = Self::system_only(root);
        let Ok(config) = read_space_config(root) else {
            return policy;
        };
        let Some(tree) = config.tree else {
            return policy;
        };

        policy.user_excludes = tree
            .exclude
            .iter()
            .filter_map(|pattern| TreePattern::new(pattern))
            .collect();
        policy.user_includes = tree
            .include
            .iter()
            .filter_map(|pattern| TreePattern::new(pattern))
            .collect();
        policy.show_ignored_placeholders = tree.show_ignored_placeholders;
        policy
    }

    pub fn is_ignored_abs(&self, path: &Path, kind: TreePathKind) -> bool {
        let rel = path.strip_prefix(&self.root).unwrap_or(path);
        self.is_ignored_rel(rel, kind)
    }

    pub fn is_ignored_rel(&self, rel_path: &Path, kind: TreePathKind) -> bool {
        let rel = normalize_path(rel_path);
        if rel.is_empty() {
            return false;
        }
        if is_system_ignored_rel(&rel, kind) {
            return true;
        }
        let is_user_excluded = self
            .user_excludes
            .iter()
            .any(|pattern| pattern.matches(&rel));
        if !is_user_excluded {
            return false;
        }
        let is_user_included = self.user_includes.iter().any(|pattern| {
            pattern.matches(&rel)
                || (kind == TreePathKind::Directory && pattern.can_match_descendant_of(&rel))
        });
        !is_user_included
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TreePattern {
    raw: String,
    segments: Vec<String>,
    has_slash: bool,
    has_glob: bool,
}

impl TreePattern {
    fn new(pattern: &str) -> Option<Self> {
        let raw = normalize_pattern(pattern);
        if raw.is_empty() {
            return None;
        }
        let segments = raw.split('/').map(ToString::to_string).collect::<Vec<_>>();
        Some(Self {
            has_slash: raw.contains('/'),
            has_glob: raw.contains('*') || raw.contains('?'),
            raw,
            segments,
        })
    }

    fn matches(&self, rel: &str) -> bool {
        if self.has_glob {
            let path_segments = rel.split('/').collect::<Vec<_>>();
            return glob_segments_match(&self.segments, &path_segments);
        }

        if self.has_slash {
            return rel == self.raw || rel.starts_with(&(self.raw.clone() + "/"));
        }

        rel.split('/').any(|component| component == self.raw)
    }

    fn can_match_descendant_of(&self, rel: &str) -> bool {
        if !self.has_slash {
            return false;
        }

        let prefix = format!("{rel}/");
        if !self.has_glob {
            return self.raw.starts_with(&prefix);
        }

        let rel_segments = rel.split('/').collect::<Vec<_>>();
        glob_prefix_can_match(&self.segments, &rel_segments)
    }
}

fn normalize_pattern(pattern: &str) -> String {
    pattern
        .trim()
        .replace('\\', "/")
        .trim_matches('/')
        .to_string()
}

fn normalize_path(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(name) => Some(name.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn is_system_ignored_rel(rel: &str, kind: TreePathKind) -> bool {
    let components = rel.split('/').collect::<Vec<_>>();
    let last_index = components.len().saturating_sub(1);

    components.iter().enumerate().any(|(index, component)| {
        if SYSTEM_EXCLUDED_DIRS.contains(component) {
            return true;
        }
        component.starts_with('.')
            && match kind {
                TreePathKind::Directory | TreePathKind::Unknown => true,
                TreePathKind::File => index < last_index,
            }
    })
}

fn glob_segments_match(pattern: &[String], path: &[&str]) -> bool {
    if pattern.is_empty() {
        return path.is_empty();
    }

    if pattern[0] == "**" {
        return glob_segments_match(&pattern[1..], path)
            || (!path.is_empty() && glob_segments_match(pattern, &path[1..]));
    }

    if path.is_empty() {
        return false;
    }

    segment_matches(&pattern[0], path[0]) && glob_segments_match(&pattern[1..], &path[1..])
}

fn glob_prefix_can_match(pattern: &[String], prefix: &[&str]) -> bool {
    if prefix.is_empty() {
        return true;
    }
    if pattern.is_empty() {
        return false;
    }
    if pattern[0] == "**" {
        return glob_prefix_can_match(&pattern[1..], prefix)
            || glob_prefix_can_match(pattern, &prefix[1..]);
    }
    segment_matches(&pattern[0], prefix[0]) && glob_prefix_can_match(&pattern[1..], &prefix[1..])
}

fn segment_matches(pattern: &str, value: &str) -> bool {
    let pattern_chars = pattern.chars().collect::<Vec<_>>();
    let value_chars = value.chars().collect::<Vec<_>>();
    segment_match_chars(&pattern_chars, &value_chars)
}

fn segment_match_chars(pattern: &[char], value: &[char]) -> bool {
    if pattern.is_empty() {
        return value.is_empty();
    }

    match pattern[0] {
        '*' => {
            segment_match_chars(&pattern[1..], value)
                || (!value.is_empty() && segment_match_chars(pattern, &value[1..]))
        }
        '?' => !value.is_empty() && segment_match_chars(&pattern[1..], &value[1..]),
        expected => value.first().is_some_and(|actual| {
            *actual == expected && segment_match_chars(&pattern[1..], &value[1..])
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_excludes_win_over_user_includes() {
        let mut policy = TreeIgnorePolicy::system_only(Path::new("/space"));
        policy.user_includes = vec![TreePattern::new(".svode/config.json").unwrap()];

        assert!(policy.is_ignored_rel(Path::new(".git/config"), TreePathKind::File));
        assert!(policy.is_ignored_rel(Path::new(".svode/config.json"), TreePathKind::File));
        assert!(policy.is_ignored_rel(Path::new(".assets/image.png"), TreePathKind::File));
        assert!(policy.is_ignored_rel(Path::new(".templates/page.md"), TreePathKind::File));
        assert!(policy.is_ignored_rel(Path::new(".cache"), TreePathKind::Directory));
    }

    #[test]
    fn user_includes_override_user_excludes() {
        let mut policy = TreeIgnorePolicy::system_only(Path::new("/space"));
        policy.user_excludes = vec![TreePattern::new("docs/*.md").unwrap()];
        policy.user_includes = vec![TreePattern::new("docs/keep.md").unwrap()];

        assert!(policy.is_ignored_rel(Path::new("docs/drop.md"), TreePathKind::File));
        assert!(!policy.is_ignored_rel(Path::new("docs/keep.md"), TreePathKind::File));
    }

    #[test]
    fn descendant_includes_keep_excluded_parent_directories_traversable() {
        let mut policy = TreeIgnorePolicy::system_only(Path::new("/space"));
        policy.user_excludes = vec![TreePattern::new("docs").unwrap()];
        policy.user_includes = vec![TreePattern::new("docs/guides/keep.md").unwrap()];

        assert!(!policy.is_ignored_rel(Path::new("docs"), TreePathKind::Directory));
        assert!(!policy.is_ignored_rel(Path::new("docs/guides"), TreePathKind::Directory));
        assert!(policy.is_ignored_rel(Path::new("docs/drop.md"), TreePathKind::File));
        assert!(!policy.is_ignored_rel(Path::new("docs/guides/keep.md"), TreePathKind::File));
    }

    #[test]
    fn direct_basename_and_relative_path_matching_cover_descendants() {
        let mut policy = TreeIgnorePolicy::system_only(Path::new("/space"));
        policy.user_excludes = vec![
            TreePattern::new("node_modules").unwrap(),
            TreePattern::new("src/generated").unwrap(),
        ];

        assert!(policy.is_ignored_rel(
            Path::new("app/node_modules/pkg/index.md"),
            TreePathKind::File
        ));
        assert!(policy.is_ignored_rel(Path::new("src/generated"), TreePathKind::Directory));
        assert!(policy.is_ignored_rel(Path::new("src/generated/client.md"), TreePathKind::File));
        assert!(!policy.is_ignored_rel(Path::new("src/manual/client.md"), TreePathKind::File));
    }

    #[test]
    fn simple_glob_patterns_match_across_directories() {
        let pattern = TreePattern::new("docs/**/*.md").unwrap();

        assert!(pattern.matches("docs/index.md"));
        assert!(pattern.matches("docs/guides/index.md"));
        assert!(!pattern.matches("docs/guides/image.png"));
        assert!(!pattern.matches("src/docs/index.md"));
    }
}

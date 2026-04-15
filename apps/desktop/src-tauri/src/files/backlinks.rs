use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use regex::Regex;
use serde::Serialize;

use crate::error::AppError;

/// Regex matching `[text](url.md)` or `[text](url.md#anchor)`.
static MD_LINK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\[(?:[^\[\]]|\\\[|\\\])*\]\(([^)]+\.md(?:#[^)]*)?)\)").unwrap()
});

/// Regex matching any `[text](url)` markdown link.
static ANY_LINK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\[(?:[^\[\]]|\\\[|\\\])*\]\(([^)]+)\)").unwrap()
});

/// Byte span of a markdown link `[text](url)` in the source content.
#[derive(Debug, Clone, Serialize)]
pub struct LinkSpan {
    pub byte_start: usize,
    pub byte_end: usize,
}

/// Info about backlinks pointing to a target file.
#[derive(Debug, Clone, Serialize)]
pub struct BacklinkInfo {
    pub source_path: String,
    pub link_count: usize,
}

/// Parse standard markdown links `[text](./path.md)` from content.
/// Returns vec of (normalized_target_path, LinkSpan).
/// Only matches relative .md paths (not http, mailto, #anchors).
pub fn parse_markdown_links(content: &str) -> Vec<(String, LinkSpan)> {
    let mut results = Vec::new();

    for cap in MD_LINK_RE.captures_iter(content) {
        let full_match = cap.get(0).unwrap();
        let url = cap.get(1).unwrap().as_str();

        // Skip absolute URLs, mailto, anchors-only
        if url.starts_with("http://")
            || url.starts_with("https://")
            || url.starts_with("mailto:")
            || url.starts_with('#')
        {
            continue;
        }

        // Strip anchor fragment for path normalization
        let path_part = url.split('#').next().unwrap_or(url);

        let normalized = normalize_link_path(path_part);

        results.push((
            normalized,
            LinkSpan {
                byte_start: full_match.start(),
                byte_end: full_match.end(),
            },
        ));
    }

    results
}

/// Normalize a relative link path: strip leading `./`, collapse `..` segments.
fn normalize_link_path(path: &str) -> String {
    let p = path.strip_prefix("./").unwrap_or(path);
    // Use PathBuf to normalize path components
    let mut parts: Vec<&str> = Vec::new();
    for segment in p.split('/') {
        match segment {
            "." | "" => continue,
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    parts.join("/")
}

/// In-memory backlink index. Key = normalized target path, Value = vec of (source_path, link_positions).
pub struct BacklinkIndex {
    inner: Mutex<HashMap<String, Vec<(String, Vec<LinkSpan>)>>>,
    built: Mutex<bool>,
}

impl Default for BacklinkIndex {
    fn default() -> Self {
        Self::new()
    }
}

impl BacklinkIndex {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            built: Mutex::new(false),
        }
    }

    /// Whether the index has been built at least once.
    pub fn is_built(&self) -> bool {
        *self.built.lock().unwrap()
    }

    /// Build index by scanning all .md files under space_path.
    pub fn build(&self, space_path: &Path) -> Result<(), AppError> {
        let mut index: HashMap<String, Vec<(String, Vec<LinkSpan>)>> = HashMap::new();

        let md_files = collect_md_files(space_path)?;

        for file_path in &md_files {
            let rel_path = file_path
                .strip_prefix(space_path)
                .unwrap_or(file_path)
                .to_string_lossy()
                .to_string();

            let content = fs::read_to_string(file_path)?;
            let links = parse_markdown_links(&content);

            // Group links by target
            let mut by_target: HashMap<String, Vec<LinkSpan>> = HashMap::new();
            for (target, span) in links {
                // Resolve target relative to the file's parent directory
                let resolved = resolve_relative_to(&rel_path, &target);
                by_target.entry(resolved).or_default().push(span);
            }

            for (target, spans) in by_target {
                index
                    .entry(target)
                    .or_default()
                    .push((rel_path.clone(), spans));
            }
        }

        let mut guard = self.inner.lock().unwrap();
        *guard = index;
        *self.built.lock().unwrap() = true;
        Ok(())
    }

    /// Re-index a single file. Removes old entries for this source, then re-parses.
    pub fn update_file(
        &self,
        space_path: &Path,
        file_rel_path: &str,
    ) -> Result<(), AppError> {
        // First remove old entries where this file is the source
        self.remove_file(file_rel_path);

        let abs_path = space_path.join(file_rel_path);
        if !abs_path.exists() {
            return Ok(());
        }

        let content = fs::read_to_string(&abs_path)?;
        let links = parse_markdown_links(&content);

        let mut by_target: HashMap<String, Vec<LinkSpan>> = HashMap::new();
        for (target, span) in links {
            let resolved = resolve_relative_to(file_rel_path, &target);
            by_target.entry(resolved).or_default().push(span);
        }

        let mut guard = self.inner.lock().unwrap();
        for (target, spans) in by_target {
            guard
                .entry(target)
                .or_default()
                .push((file_rel_path.to_string(), spans));
        }

        Ok(())
    }

    /// Remove all entries where file_rel_path is the source.
    pub fn remove_file(&self, file_rel_path: &str) {
        let mut guard = self.inner.lock().unwrap();
        for entries in guard.values_mut() {
            entries.retain(|(src, _)| src != file_rel_path);
        }
        // Remove empty target entries
        guard.retain(|_, v| !v.is_empty());
    }

    /// Get all files that link to the given target path.
    pub fn get_backlinks(&self, target_path: &str) -> Vec<BacklinkInfo> {
        let guard = self.inner.lock().unwrap();
        let normalized = normalize_link_path(target_path);

        match guard.get(&normalized) {
            Some(entries) => entries
                .iter()
                .map(|(src, spans)| BacklinkInfo {
                    source_path: src.clone(),
                    link_count: spans.len(),
                })
                .collect(),
            None => Vec::new(),
        }
    }

    /// Update all links pointing to old_path so they point to new_path.
    /// Rewrites files on disk, updates the index. Returns list of modified file paths.
    pub fn update_links_on_rename(
        &self,
        space_path: &Path,
        old_path: &str,
        new_path: &str,
    ) -> Result<Vec<String>, AppError> {
        let normalized_old = normalize_link_path(old_path);
        let mut modified_files = Vec::new();

        // Get source files that link to old_path
        let sources: Vec<(String, Vec<LinkSpan>)> = {
            let guard = self.inner.lock().unwrap();
            match guard.get(&normalized_old) {
                Some(entries) => entries.clone(),
                None => return Ok(modified_files),
            }
        };

        for (source_path, _spans) in &sources {
            let abs_source = space_path.join(source_path);
            if !abs_source.exists() {
                continue;
            }

            let content = fs::read_to_string(&abs_source)?;

            // Compute relative path from source's directory to old and new targets
            let source_dir = Path::new(source_path)
                .parent()
                .unwrap_or(Path::new(""));
            let old_rel = make_relative_link(source_dir, old_path);
            let new_rel = make_relative_link(source_dir, new_path);

            // Replace link URLs in content (only the URL part, not the text)
            let updated = replace_link_urls(&content, &old_rel, &new_rel);

            if updated != content {
                fs::write(&abs_source, &updated)?;
                modified_files.push(source_path.clone());
            }
        }

        // Update the index: move entries from old_path to new_path
        {
            let mut guard = self.inner.lock().unwrap();
            if let Some(entries) = guard.remove(&normalized_old) {
                let normalized_new = normalize_link_path(new_path);
                guard
                    .entry(normalized_new)
                    .or_default()
                    .extend(entries);
            }
        }

        // Re-index modified files to get correct spans
        for source_path in &modified_files {
            self.update_file(space_path, source_path)?;
        }

        Ok(modified_files)
    }
}

/// Replace markdown link URLs from old_rel to new_rel in content.
/// Only replaces the URL part inside `](...)`, preserving link text.
fn replace_link_urls(content: &str, old_rel: &str, new_rel: &str) -> String {
    // Also handle ./prefix variant
    let old_with_dot = format!("./{old_rel}");

    let mut result = String::with_capacity(content.len());
    let mut last_end = 0;

    for cap in ANY_LINK_RE.captures_iter(content) {
        let full_match = cap.get(0).unwrap();
        let url_match = cap.get(1).unwrap();
        let url = url_match.as_str();

        // Check if the URL path (without anchor) matches old_rel
        let (path_part, anchor) = match url.find('#') {
            Some(pos) => (&url[..pos], &url[pos..]),
            None => (url, ""),
        };

        let matches = path_part == old_rel || path_part == old_with_dot;

        if matches {
            // Append content before this match
            result.push_str(&content[last_end..url_match.start()]);
            // Write the new URL, preserving anchor
            result.push_str(new_rel);
            result.push_str(anchor);
            last_end = url_match.end();
        } else {
            // No change needed, but we still need to process
            result.push_str(&content[last_end..full_match.end()]);
            last_end = full_match.end();
        }
    }

    result.push_str(&content[last_end..]);
    result
}

/// Make a relative link path from source_dir to target_path.
fn make_relative_link(source_dir: &Path, target_path: &str) -> String {
    let target = Path::new(target_path);

    // Try to compute relative path
    let source_components: Vec<&str> = source_dir
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect();
    let target_components: Vec<&str> = target
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect();

    // Find common prefix length
    let common_len = source_components
        .iter()
        .zip(target_components.iter())
        .take_while(|(a, b)| a == b)
        .count();

    let ups = source_components.len() - common_len;
    let mut parts: Vec<String> = Vec::new();

    if ups == 0 && common_len == 0 {
        // Same directory
        return target_path.to_string();
    }

    for _ in 0..ups {
        parts.push("..".to_string());
    }

    for comp in &target_components[common_len..] {
        parts.push(comp.to_string());
    }

    if parts.is_empty() {
        target_path.to_string()
    } else {
        parts.join("/")
    }
}

/// Resolve a target path relative to a source file's location.
/// e.g. source = "docs/intro.md", target = "../readme.md" => "readme.md"
/// e.g. source = "docs/intro.md", target = "other.md" => "docs/other.md"
fn resolve_relative_to(source_rel_path: &str, target_link: &str) -> String {
    let source_dir = Path::new(source_rel_path)
        .parent()
        .unwrap_or(Path::new(""));

    let combined = source_dir.join(target_link);

    // Normalize the path
    let mut parts: Vec<String> = Vec::new();
    for component in combined.components() {
        match component {
            std::path::Component::Normal(s) => {
                parts.push(s.to_string_lossy().to_string());
            }
            std::path::Component::ParentDir => {
                parts.pop();
            }
            std::path::Component::CurDir => {}
            _ => {}
        }
    }

    parts.join("/")
}

/// Result of validating a single link in a document.
#[derive(Debug, Clone, Serialize)]
pub struct LinkValidation {
    pub url: String,
    pub exists: bool,
}

/// Validate all internal (.md) links in a document.
/// Returns a list of {url, exists} for each link found.
pub fn validate_links(space_path: &Path, doc_rel_path: &str) -> Result<Vec<LinkValidation>, AppError> {
    let abs_path = space_path.join(doc_rel_path);
    if !abs_path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(&abs_path)?;
    let links = parse_markdown_links(&content);

    let mut results = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for (target, _span) in links {
        let resolved = resolve_relative_to(doc_rel_path, &target);
        if !seen.insert(resolved.clone()) {
            continue;
        }
        let target_abs = space_path.join(&resolved);
        results.push(LinkValidation {
            url: resolved,
            exists: target_abs.exists(),
        });
    }

    Ok(results)
}

/// Collect all .md files under a directory, recursively.
fn collect_md_files(dir: &Path) -> Result<Vec<PathBuf>, AppError> {
    let mut files = Vec::new();
    collect_md_files_recursive(dir, &mut files)?;
    Ok(files)
}

fn collect_md_files_recursive(dir: &Path, files: &mut Vec<PathBuf>) -> Result<(), AppError> {
    if !dir.is_dir() {
        return Ok(());
    }

    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();

        // Skip hidden directories
        if path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with('.'))
        {
            continue;
        }

        if path.is_dir() {
            collect_md_files_recursive(&path, files)?;
        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
            files.push(path);
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_parse_markdown_links_basic() {
        let content = "See [intro](./intro.md) and [guide](guide.md).";
        let links = parse_markdown_links(content);
        assert_eq!(links.len(), 2);
        assert_eq!(links[0].0, "intro.md");
        assert_eq!(links[1].0, "guide.md");
    }

    #[test]
    fn test_parse_markdown_links_with_anchors() {
        let content = "See [section](./doc.md#heading) for details.";
        let links = parse_markdown_links(content);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].0, "doc.md");
    }

    #[test]
    fn test_parse_markdown_links_skip_http() {
        let content = "Visit [site](https://example.com/page.md) and [local](local.md).";
        let links = parse_markdown_links(content);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].0, "local.md");
    }

    #[test]
    fn test_parse_markdown_links_nested_dirs() {
        let content = "See [deep](../other/file.md).";
        let links = parse_markdown_links(content);
        assert_eq!(links.len(), 1);
        // The raw path without resolution context
        assert_eq!(links[0].0, "other/file.md");
    }

    #[test]
    fn test_parse_markdown_links_no_links() {
        let content = "No links here. Just [text] and (parens).";
        let links = parse_markdown_links(content);
        assert_eq!(links.len(), 0);
    }

    #[test]
    fn test_parse_markdown_links_non_md() {
        let content = "See [image](photo.png) and [doc](notes.md).";
        let links = parse_markdown_links(content);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].0, "notes.md");
    }

    #[test]
    fn test_parse_markdown_links_span_positions() {
        let content = "Hello [link](test.md) world";
        let links = parse_markdown_links(content);
        assert_eq!(links.len(), 1);
        assert_eq!(&content[links[0].1.byte_start..links[0].1.byte_end], "[link](test.md)");
    }

    #[test]
    fn test_normalize_link_path() {
        assert_eq!(normalize_link_path("./intro.md"), "intro.md");
        assert_eq!(normalize_link_path("docs/../intro.md"), "intro.md");
        assert_eq!(normalize_link_path("docs/guide.md"), "docs/guide.md");
    }

    #[test]
    fn test_resolve_relative_to() {
        assert_eq!(
            resolve_relative_to("docs/intro.md", "guide.md"),
            "docs/guide.md"
        );
        assert_eq!(
            resolve_relative_to("docs/intro.md", "../readme.md"),
            "readme.md"
        );
        assert_eq!(
            resolve_relative_to("intro.md", "other.md"),
            "other.md"
        );
    }

    #[test]
    fn test_backlink_index_build_and_query() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path();

        // Create files with links
        fs::write(ws.join("a.md"), "---\nid: a\ntitle: A\ncreated: '2026-01-01T00:00:00Z'\nupdated: '2026-01-01T00:00:00Z'\n---\nSee [B](b.md).\n").unwrap();
        fs::write(ws.join("b.md"), "---\nid: b\ntitle: B\ncreated: '2026-01-01T00:00:00Z'\nupdated: '2026-01-01T00:00:00Z'\n---\nContent here.\n").unwrap();
        fs::write(ws.join("c.md"), "---\nid: c\ntitle: C\ncreated: '2026-01-01T00:00:00Z'\nupdated: '2026-01-01T00:00:00Z'\n---\nAlso see [B](./b.md) and [A](a.md).\n").unwrap();

        let index = BacklinkIndex::new();
        index.build(ws).unwrap();

        let backlinks_b = index.get_backlinks("b.md");
        assert_eq!(backlinks_b.len(), 2);

        let backlinks_a = index.get_backlinks("a.md");
        assert_eq!(backlinks_a.len(), 1);
        assert_eq!(backlinks_a[0].source_path, "c.md");
    }

    #[test]
    fn test_backlink_index_update_file() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path();

        fs::write(ws.join("a.md"), "See [B](b.md).\n").unwrap();
        fs::write(ws.join("b.md"), "Content.\n").unwrap();

        let index = BacklinkIndex::new();
        index.build(ws).unwrap();

        assert_eq!(index.get_backlinks("b.md").len(), 1);

        // Update a.md to no longer link to b.md
        fs::write(ws.join("a.md"), "No more links.\n").unwrap();
        index.update_file(ws, "a.md").unwrap();

        assert_eq!(index.get_backlinks("b.md").len(), 0);
    }

    #[test]
    fn test_backlink_index_remove_file() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path();

        fs::write(ws.join("a.md"), "See [B](b.md).\n").unwrap();
        fs::write(ws.join("b.md"), "Content.\n").unwrap();

        let index = BacklinkIndex::new();
        index.build(ws).unwrap();

        assert_eq!(index.get_backlinks("b.md").len(), 1);

        index.remove_file("a.md");
        assert_eq!(index.get_backlinks("b.md").len(), 0);
    }

    #[test]
    fn test_update_links_on_rename() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path();

        fs::write(ws.join("a.md"), "See [B doc](b.md) for info.\n").unwrap();
        fs::write(ws.join("b.md"), "Content.\n").unwrap();

        let index = BacklinkIndex::new();
        index.build(ws).unwrap();

        let modified = index
            .update_links_on_rename(ws, "b.md", "renamed-b.md")
            .unwrap();
        assert_eq!(modified, vec!["a.md"]);

        let updated_content = fs::read_to_string(ws.join("a.md")).unwrap();
        assert!(updated_content.contains("[B doc](renamed-b.md)"));
        assert!(!updated_content.contains("](b.md)"));

        // Index should now have entries for renamed-b.md
        assert_eq!(index.get_backlinks("renamed-b.md").len(), 1);
        assert_eq!(index.get_backlinks("b.md").len(), 0);
    }

    #[test]
    fn test_make_relative_link() {
        assert_eq!(make_relative_link(Path::new(""), "intro.md"), "intro.md");
        assert_eq!(
            make_relative_link(Path::new("docs"), "intro.md"),
            "../intro.md"
        );
        assert_eq!(
            make_relative_link(Path::new("docs"), "docs/guide.md"),
            "guide.md"
        );
    }
}

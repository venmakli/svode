use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::files::entry::slugify;
use crate::files::tree_policy::{TreeIgnorePolicy, TreePathKind};

/// Byte span of a markdown link `[text](url)` in the source content.
#[derive(Debug, Clone, Serialize)]
pub struct LinkSpan {
    pub byte_start: usize,
    pub byte_end: usize,
}

/// Identity of the document that contains a link. `None` means the root
/// project pool; `Some(id)` means a child space pool.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkSource {
    pub source_space_id: Option<String>,
    pub source_path: String,
}

/// Info about backlinks pointing to a target file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BacklinkInfo {
    pub source_space_id: Option<String>,
    pub source_path: String,
    pub link_count: usize,
}

/// File modified by a backlink rewrite.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModifiedLinkSource {
    pub space_id: Option<String>,
    pub path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LinkDestinationStyle {
    Plain,
    Angle,
}

/// Parsed ordinary inline Markdown link. Spans are byte offsets into the
/// original content. Reference-style links and images are intentionally absent.
#[derive(Debug, Clone)]
struct MarkdownLink {
    full_start: usize,
    full_end: usize,
    label_start: usize,
    label_end: usize,
    destination_outer_start: usize,
    destination_outer_end: usize,
    path: String,
    anchor: String,
    style: LinkDestinationStyle,
}

/// Parse standard markdown links `[text](./path.md)` from content.
/// Returns vec of (normalized_target_path, LinkSpan).
/// Only matches relative .md paths (not http, mailto, #anchors).
pub fn parse_markdown_links(content: &str) -> Vec<(String, LinkSpan)> {
    parse_markdown_link_nodes(content)
        .into_iter()
        .map(|link| {
            (
                link.path,
                LinkSpan {
                    byte_start: link.full_start,
                    byte_end: link.full_end,
                },
            )
        })
        .collect()
}

fn parse_markdown_link_nodes(content: &str) -> Vec<MarkdownLink> {
    let bytes = content.as_bytes();
    let mut links = Vec::new();
    let mut cursor = 0usize;

    while let Some(open_rel) = content[cursor..].find('[') {
        let open = cursor + open_rel;
        if open > 0 && bytes[open - 1] == b'!' {
            cursor = open + 1;
            continue;
        }

        let Some(label_close) = find_unescaped_byte(content, open + 1, b']') else {
            break;
        };
        let paren_open = label_close + 1;
        if bytes.get(paren_open) != Some(&b'(') {
            cursor = label_close + 1;
            continue;
        }

        let dest_start = paren_open + 1;
        let (style, destination_outer_start, destination_outer_end, destination) =
            if bytes.get(dest_start) == Some(&b'<') {
                let inner_start = dest_start + 1;
                let Some(angle_close) = find_unescaped_byte(content, inner_start, b'>') else {
                    cursor = dest_start;
                    continue;
                };
                let Some(paren_close) = find_unescaped_byte(content, angle_close + 1, b')') else {
                    cursor = angle_close + 1;
                    continue;
                };
                (
                    LinkDestinationStyle::Angle,
                    dest_start,
                    angle_close + 1,
                    &content[inner_start..angle_close],
                )
                    .with_full_end(paren_close + 1)
            } else {
                let Some(paren_close) = find_unescaped_byte(content, dest_start, b')') else {
                    cursor = dest_start;
                    continue;
                };
                let Some(destination_end) =
                    plain_destination_end(&content[dest_start..paren_close])
                else {
                    cursor = paren_close + 1;
                    continue;
                };
                (
                    LinkDestinationStyle::Plain,
                    dest_start,
                    dest_start + destination_end,
                    &content[dest_start..dest_start + destination_end],
                )
                    .with_full_end(paren_close + 1)
            };

        let full_end = destination.full_end;
        let destination = destination.value;
        if let Some((path, anchor)) = parse_internal_markdown_destination(destination) {
            links.push(MarkdownLink {
                full_start: open,
                full_end,
                label_start: open + 1,
                label_end: label_close,
                destination_outer_start,
                destination_outer_end,
                path,
                anchor,
                style,
            });
        }
        cursor = full_end;
    }

    links
}

struct ParsedDestination<'a> {
    value: &'a str,
    full_end: usize,
}

trait DestinationWithFullEnd<'a> {
    fn with_full_end(
        self,
        full_end: usize,
    ) -> (LinkDestinationStyle, usize, usize, ParsedDestination<'a>);
}

impl<'a> DestinationWithFullEnd<'a> for (LinkDestinationStyle, usize, usize, &'a str) {
    fn with_full_end(
        self,
        full_end: usize,
    ) -> (LinkDestinationStyle, usize, usize, ParsedDestination<'a>) {
        (
            self.0,
            self.1,
            self.2,
            ParsedDestination {
                value: self.3,
                full_end,
            },
        )
    }
}

fn find_unescaped_byte(content: &str, start: usize, needle: u8) -> Option<usize> {
    let bytes = content.as_bytes();
    let mut idx = start;
    while idx < bytes.len() {
        if bytes[idx] == needle && !is_escaped(bytes, idx) {
            return Some(idx);
        }
        idx += 1;
    }
    None
}

fn is_escaped(bytes: &[u8], idx: usize) -> bool {
    let mut count = 0usize;
    let mut cursor = idx;
    while cursor > 0 && bytes[cursor - 1] == b'\\' {
        count += 1;
        cursor -= 1;
    }
    count % 2 == 1
}

fn plain_destination_end(destination_with_suffix: &str) -> Option<usize> {
    let trimmed_end = destination_with_suffix.trim_end().len();
    let candidate = &destination_with_suffix[..trimmed_end];
    if candidate.is_empty() {
        return None;
    }

    let mut search_start = 0usize;
    let lower = candidate.to_ascii_lowercase();
    let mut best = None;
    while let Some(offset) = lower[search_start..].find(".md") {
        let md_end = search_start + offset + ".md".len();
        let mut end = md_end;
        if candidate[end..].starts_with('#') {
            let anchor_start = end + 1;
            let mut anchor_end = candidate.len();
            for (idx, ch) in candidate[anchor_start..].char_indices() {
                if ch.is_whitespace() {
                    anchor_end = anchor_start + idx;
                    break;
                }
            }
            end = if anchor_end == anchor_start {
                md_end
            } else {
                anchor_end
            };
            if end == md_end {
                end = md_end;
            }
        }
        if end == candidate.len()
            || candidate[end..]
                .chars()
                .next()
                .is_some_and(char::is_whitespace)
        {
            best = Some(end);
        }
        search_start = md_end;
    }

    best.or(Some(trimmed_end))
}

fn parse_internal_markdown_destination(destination: &str) -> Option<(String, String)> {
    let unescaped;
    let destination = if destination.contains("\\<") || destination.contains("\\>") {
        unescaped = destination.replace("\\<", "<").replace("\\>", ">");
        unescaped.as_str()
    } else {
        destination
    };
    if is_external_or_anchor_url(destination) {
        return None;
    }
    let (path_part, anchor) = match destination.find('#') {
        Some(pos) => (&destination[..pos], &destination[pos..]),
        None => (destination, ""),
    };
    if path_part.is_empty() || !path_part.to_ascii_lowercase().ends_with(".md") {
        return None;
    }
    Some((
        normalize_link_path_preserve_parent(path_part),
        anchor.to_string(),
    ))
}

/// Normalize a relative link path for target-key lookup. Escaping parents are
/// dropped for compatibility with pre-cross-space callers that only operate
/// inside one space.
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

/// Normalize a link URL while preserving leading `..` segments. This is the
/// parser-facing form; resolver code decides whether the path escapes a root.
fn normalize_link_path_preserve_parent(path: &str) -> String {
    let p = path.strip_prefix("./").unwrap_or(path);
    let mut parts: Vec<&str> = Vec::new();
    let mut leading_parents = 0usize;
    for segment in p.split('/') {
        match segment {
            "." | "" => continue,
            ".." => {
                if parts.pop().is_none() {
                    leading_parents += 1;
                }
            }
            s => parts.push(s),
        }
    }
    let mut out: Vec<String> = Vec::with_capacity(leading_parents + parts.len());
    for _ in 0..leading_parents {
        out.push("..".to_string());
    }
    out.extend(parts.into_iter().map(ToString::to_string));
    out.join("/")
}

/// In-memory backlink index. Key = normalized target path, Value = vec of
/// (source identity, link_positions).
///
/// Each instance is per-`IndexKey` (root pool or one child space) — the
/// project's `IndexState` keeps a `HashMap<IndexKey, Arc<BacklinkIndex>>`.
/// `skip_top_level` records folders that lazy/auto rebuilds must skip
/// (the project's root index excludes child-space directories).
pub struct BacklinkIndex {
    inner: Mutex<HashMap<String, Vec<(LinkSource, Vec<LinkSpan>)>>>,
    built: Mutex<bool>,
    skip_top_level: Mutex<Vec<String>>,
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
            skip_top_level: Mutex::new(Vec::new()),
        }
    }

    /// Replace the list of top-level folders to skip on subsequent builds.
    /// Called from `IndexState` when the resolver cache changes (open_project,
    /// space:added/removed) so the root backlink index reflects the current
    /// child-space layout.
    pub fn set_skip_top_level(&self, skip: Vec<String>) {
        if let Ok(mut g) = self.skip_top_level.lock() {
            *g = skip;
        }
    }

    fn current_skip(&self) -> Vec<String> {
        self.skip_top_level
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default()
    }

    /// Whether the index has been built at least once.
    pub fn is_built(&self) -> bool {
        *self.built.lock().unwrap()
    }

    pub fn mark_built(&self) {
        *self.built.lock().unwrap() = true;
    }

    pub fn mark_stale(&self) {
        *self.built.lock().unwrap() = false;
        self.inner.lock().unwrap().clear();
    }

    /// Build index by scanning all .md files under space_path. Honors the
    /// configured `skip_top_level` (set via `set_skip_top_level`).
    pub fn build(&self, space_path: &Path) -> Result<(), AppError> {
        let skip = self.current_skip();
        self.build_with_skip(space_path, &skip)
    }

    /// Build index by scanning `.md` files under `space_path`, skipping the
    /// listed top-level folder names. Public for callers that need an
    /// explicit one-shot skip set; `build` uses the stored configuration.
    pub fn build_with_skip(
        &self,
        space_path: &Path,
        skip_top_level: &[String],
    ) -> Result<(), AppError> {
        let mut index: HashMap<String, Vec<(LinkSource, Vec<LinkSpan>)>> = HashMap::new();

        let md_files = collect_md_files_filtered(space_path, skip_top_level)?;

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
                index.entry(target).or_default().push((
                    LinkSource {
                        source_space_id: None,
                        source_path: rel_path.clone(),
                    },
                    spans,
                ));
            }
        }

        let mut guard = self.inner.lock().unwrap();
        *guard = index;
        *self.built.lock().unwrap() = true;
        Ok(())
    }

    /// Re-index a single file. Removes old entries for this source, then re-parses.
    pub fn update_file(&self, space_path: &Path, file_rel_path: &str) -> Result<(), AppError> {
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
            guard.entry(target).or_default().push((
                LinkSource {
                    source_space_id: None,
                    source_path: file_rel_path.to_string(),
                },
                spans,
            ));
        }

        Ok(())
    }

    /// Remove all entries where file_rel_path is the source.
    pub fn remove_file(&self, file_rel_path: &str) {
        self.remove_source(&LinkSource {
            source_space_id: None,
            source_path: file_rel_path.to_string(),
        });
    }

    /// Remove all entries for one source identity.
    pub fn remove_source(&self, source: &LinkSource) {
        let mut guard = self.inner.lock().unwrap();
        for entries in guard.values_mut() {
            entries.retain(|(src, _)| src != source);
        }
        // Remove empty target entries
        guard.retain(|_, v| !v.is_empty());
    }

    pub fn remove_sources_in_space(&self, source_space_id: Option<&str>) {
        let mut guard = self.inner.lock().unwrap();
        for entries in guard.values_mut() {
            entries.retain(|(src, _)| src.source_space_id.as_deref() != source_space_id);
        }
        guard.retain(|_, v| !v.is_empty());
    }

    /// Add source spans to a target in this target-space index.
    pub fn add_source_links(&self, target_path: &str, source: LinkSource, spans: Vec<LinkSpan>) {
        if spans.is_empty() {
            return;
        }
        let normalized = normalize_link_path(target_path);
        let mut guard = self.inner.lock().unwrap();
        let entries = guard.entry(normalized).or_default();
        if let Some((_, existing)) = entries.iter_mut().find(|(src, _)| src == &source) {
            existing.extend(spans);
        } else {
            entries.push((source, spans));
        }
    }

    /// Snapshot all sources that link to `target_path`.
    pub fn sources_for_target(&self, target_path: &str) -> Vec<(LinkSource, Vec<LinkSpan>)> {
        let guard = self.inner.lock().unwrap();
        let normalized = normalize_link_path(target_path);
        guard.get(&normalized).cloned().unwrap_or_default()
    }

    pub fn target_paths_under(&self, folder_path: &str) -> Vec<String> {
        let guard = self.inner.lock().unwrap();
        let normalized = normalize_link_path(folder_path);
        let prefix = format!("{}/", normalized);
        guard
            .keys()
            .filter(|k| k.starts_with(&prefix))
            .cloned()
            .collect()
    }

    /// Get all files that link to the given target path.
    pub fn get_backlinks(&self, target_path: &str) -> Vec<BacklinkInfo> {
        let guard = self.inner.lock().unwrap();
        let normalized = normalize_link_path(target_path);

        match guard.get(&normalized) {
            Some(entries) => entries
                .iter()
                .map(|(src, spans)| BacklinkInfo {
                    source_space_id: src.source_space_id.clone(),
                    source_path: src.source_path.clone(),
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
        new_title: Option<&str>,
    ) -> Result<Vec<String>, AppError> {
        // Incremental `update_file` only indexes files the user has touched in
        // this session; after app startup the map is empty until something
        // triggers a build. Without this, a rename of a file that no one has
        // edited since launch silently loses its backlink updates.
        if !self.is_built() {
            self.build(space_path)?;
        }

        let normalized_old = normalize_link_path(old_path);
        let mut modified_files = Vec::new();

        // Get source files that link to old_path
        let sources: Vec<(LinkSource, Vec<LinkSpan>)> = {
            let guard = self.inner.lock().unwrap();
            match guard.get(&normalized_old) {
                Some(entries) => entries.clone(),
                None => return Ok(modified_files),
            }
        };

        // When caller provides a new title, auto-update link text whose slug
        // matches the old filename stem. Preserves intentional custom texts
        // like `[click here]`.
        let old_stem = link_stem_of(old_path);
        let text_replace = new_title.map(|t| (old_stem.as_str(), t));

        for (source, _spans) in &sources {
            let source_path = &source.source_path;
            let abs_source = space_path.join(source_path);
            if !abs_source.exists() {
                continue;
            }

            let content = fs::read_to_string(&abs_source)?;

            let updated =
                replace_target_links(&content, source_path, old_path, new_path, text_replace);

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
                guard.entry(normalized_new).or_default().extend(entries);
            }
        }

        // Re-index modified files to get correct spans
        for source_path in &modified_files {
            self.update_file(space_path, source_path)?;
        }

        Ok(modified_files)
    }

    /// When a folder is renamed or moved on disk, rewrite backlinks for every
    /// descendant whose target path now lives under the new prefix. Descendants
    /// keep their link text as-is (their own title did not change — only the
    /// ancestor path did); only URLs get rewritten.
    pub fn update_links_on_folder_rename(
        &self,
        space_path: &Path,
        old_folder: &str,
        new_folder: &str,
    ) -> Result<Vec<String>, AppError> {
        if !self.is_built() {
            self.build(space_path)?;
        }

        let normalized_old = normalize_link_path(old_folder);
        let normalized_new = normalize_link_path(new_folder);
        if normalized_old == normalized_new {
            return Ok(Vec::new());
        }
        let prefix = format!("{}/", normalized_old);

        // Snapshot keys under the old prefix. We call update_links_on_rename
        // per descendant, which mutates the map, so iteration must snapshot first.
        let descendants: Vec<String> = {
            let guard = self.inner.lock().unwrap();
            guard
                .keys()
                .filter(|k| k.starts_with(&prefix))
                .cloned()
                .collect()
        };

        let mut all_modified: Vec<String> = Vec::new();
        for old_key in descendants {
            let remainder = old_key.strip_prefix(&prefix).unwrap_or(&old_key);
            let new_key = format!("{}/{}", normalized_new, remainder);
            let modified = self.update_links_on_rename(space_path, &old_key, &new_key, None)?;
            for m in modified {
                if !all_modified.contains(&m) {
                    all_modified.push(m);
                }
            }
        }

        Ok(all_modified)
    }
}

/// Replace links that resolve to `old_path` from this source location. When
/// `text_replace` is Some((old_stem, new_text)), link text is also replaced
/// with new_text for links whose text slugifies to old_stem (i.e. the text was
/// derived from the target's previous title). Custom texts like `[click here]`
/// stay intact.
fn replace_target_links(
    content: &str,
    source_rel_path: &str,
    old_path: &str,
    new_path: &str,
    text_replace: Option<(&str, &str)>,
) -> String {
    let old_norm = normalize_link_path(old_path);
    rewrite_links(content, |link| {
        if resolve_relative_to(source_rel_path, &link.path) != old_norm {
            return None;
        }
        let source_dir = Path::new(source_rel_path).parent().unwrap_or(Path::new(""));
        let new_rel = make_relative_link(source_dir, new_path);
        Some((
            serialize_destination(&new_rel, &link.anchor, link.style),
            replacement_label(content, link, text_replace),
        ))
    })
}

fn replacement_label(
    content: &str,
    link: &MarkdownLink,
    text_replace: Option<(&str, &str)>,
) -> Option<String> {
    let text = &content[link.label_start..link.label_end];
    text_replace
        .filter(|(old_stem, _)| !old_stem.is_empty() && slugify(text) == *old_stem)
        .map(|(_, new_text)| new_text.to_string())
}

fn rewrite_links<F>(content: &str, mut replacement: F) -> String
where
    F: FnMut(&MarkdownLink) -> Option<(String, Option<String>)>,
{
    let links = parse_markdown_link_nodes(content);
    if links.is_empty() {
        return content.to_string();
    }

    let mut result = String::with_capacity(content.len());
    let mut last_end = 0usize;
    let mut changed = false;

    for link in links {
        result.push_str(&content[last_end..link.full_start]);
        if let Some((new_destination, new_label)) = replacement(&link) {
            changed = true;
            result.push_str(&content[link.full_start..link.label_start]);
            if let Some(label) = new_label {
                result.push_str(&label);
            } else {
                result.push_str(&content[link.label_start..link.label_end]);
            }
            result.push_str(&content[link.label_end..link.destination_outer_start]);
            result.push_str(&new_destination);
            result.push_str(&content[link.destination_outer_end..link.full_end]);
        } else {
            result.push_str(&content[link.full_start..link.full_end]);
        }
        last_end = link.full_end;
    }

    result.push_str(&content[last_end..]);
    if changed { result } else { content.to_string() }
}

fn serialize_destination(path: &str, anchor: &str, style: LinkDestinationStyle) -> String {
    let destination = format!("{path}{anchor}");
    if matches!(style, LinkDestinationStyle::Angle) || requires_angle_destination(&destination) {
        format!("<{}>", escape_angle_destination(&destination))
    } else {
        destination
    }
}

fn requires_angle_destination(destination: &str) -> bool {
    destination
        .chars()
        .any(|ch| ch.is_whitespace() || matches!(ch, '<' | '>' | '(' | ')' | '[' | ']'))
}

fn escape_angle_destination(destination: &str) -> String {
    destination.replace('<', "\\<").replace('>', "\\>")
}

/// Extract the "name-like" stem from a link target path. For `readme.md`
/// inside a folder, returns the folder name (what users type as link text);
/// for regular files, the filename stem; for bare folders, the folder name.
fn link_stem_of(path: &str) -> String {
    let p = Path::new(path);
    let is_readme = p
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case("readme.md"));
    if is_readme {
        p.parent()
            .and_then(|parent| parent.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string()
    } else {
        p.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string()
    }
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
    let source_dir = Path::new(source_rel_path).parent().unwrap_or(Path::new(""));

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
pub fn validate_links(
    space_path: &Path,
    doc_rel_path: &str,
) -> Result<Vec<LinkValidation>, AppError> {
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

/// Return true for URLs that are outside Svode's local markdown-link domain.
pub fn is_external_or_anchor_url(url: &str) -> bool {
    let url = unwrap_angle_destination(url.trim());
    url.starts_with('#') || url.starts_with("//") || has_url_scheme(url)
}

fn has_url_scheme(url: &str) -> bool {
    let Some((scheme, _)) = url.split_once(':') else {
        return false;
    };
    let mut chars = scheme.chars();
    chars.next().is_some_and(|ch| ch.is_ascii_alphabetic())
        && chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '-' | '.'))
}

/// Strip the fragment from a markdown URL and normalize separators while
/// preserving leading `..` for the resolver.
pub fn markdown_url_path(url: &str) -> String {
    let url = unwrap_angle_destination(url.trim());
    let path_part = url.split('#').next().unwrap_or(url);
    normalize_link_path_preserve_parent(path_part)
}

fn unwrap_angle_destination(url: &str) -> &str {
    url.strip_prefix('<')
        .and_then(|inner| inner.strip_suffix('>'))
        .unwrap_or(url)
}

/// Make a relative markdown URL from a source document absolute path to a
/// target document absolute path.
pub fn make_relative_link_between(source_doc_abs: &Path, target_doc_abs: &Path) -> String {
    let source_dir = source_doc_abs.parent().unwrap_or(Path::new(""));
    make_relative_path(source_dir, target_doc_abs)
}

/// Make a relative markdown URL from an absolute source directory to an
/// absolute target path.
pub fn make_relative_path(source_dir: &Path, target_path: &Path) -> String {
    let source_components = path_components(source_dir);
    let target_components = path_components(target_path);

    let common_len = source_components
        .iter()
        .zip(target_components.iter())
        .take_while(|(a, b)| a == b)
        .count();

    let mut parts: Vec<String> = Vec::new();
    for _ in common_len..source_components.len() {
        parts.push("..".to_string());
    }
    for comp in &target_components[common_len..] {
        parts.push(comp.clone());
    }
    if parts.is_empty() {
        target_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string()
    } else {
        parts.join("/")
    }
}

fn path_components(path: &Path) -> Vec<String> {
    path.components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().to_string()),
            _ => None,
        })
        .collect()
}

/// Collect all .md files under a directory, skipping the listed top-level
/// folder names directly under `dir` (used to omit child-space directories
/// from the project's root backlink index).
fn collect_md_files_filtered(
    dir: &Path,
    skip_top_level: &[String],
) -> Result<Vec<PathBuf>, AppError> {
    let mut files = Vec::new();
    let policy = TreeIgnorePolicy::from_space_root(dir);
    collect_md_files_recursive(dir, dir, skip_top_level, &policy, &mut files)?;
    Ok(files)
}

/// Public walker for project-aware backlink rebuilds.
pub fn collect_md_files(dir: &Path, skip_top_level: &[String]) -> Result<Vec<PathBuf>, AppError> {
    collect_md_files_filtered(dir, skip_top_level)
}

/// Replace a link URL using absolute source/target paths.
pub fn replace_link_urls_between(
    content: &str,
    source_doc_abs: &Path,
    old_target_abs: &Path,
    new_target_abs: &Path,
    text_replace: Option<(&str, &str)>,
) -> String {
    let source_dir = source_doc_abs.parent().unwrap_or(Path::new(""));
    let Some(old_abs) = normalize_path(old_target_abs) else {
        return content.to_string();
    };
    rewrite_links(content, |link| {
        let Some(target_abs) = normalize_path(&source_dir.join(&link.path)) else {
            return None;
        };
        if target_abs != old_abs {
            return None;
        }
        let new_rel = make_relative_path(source_dir, new_target_abs);
        Some((
            serialize_destination(&new_rel, &link.anchor, link.style),
            replacement_label(content, link, text_replace),
        ))
    })
}

pub fn link_stem(path: &str) -> String {
    link_stem_of(path)
}

/// Rebase outgoing links after the source document moves inside the same
/// space root. Broken links are mechanically preserved by resolving their old
/// intended target from the previous source location.
pub fn rebase_source_links(
    content: &str,
    old_source_rel_path: &str,
    new_source_rel_path: &str,
) -> String {
    rewrite_links(content, |link| {
        let target = resolve_relative_to(old_source_rel_path, &link.path);
        let new_source_dir = Path::new(new_source_rel_path)
            .parent()
            .unwrap_or(Path::new(""));
        let new_rel = make_relative_link(new_source_dir, &target);
        let destination = serialize_destination(&new_rel, &link.anchor, link.style);
        Some((destination, None))
    })
}

/// Rebase outgoing links after a source document moves, using absolute source
/// paths. This preserves cross-space relative links in project-aware flows.
pub fn rebase_source_links_between(
    content: &str,
    old_source_abs: &Path,
    new_source_abs: &Path,
) -> String {
    rebase_source_links_between_with_target_map(content, old_source_abs, new_source_abs, None)
}

/// Rebase outgoing links after a source document moves as part of a moved
/// subtree. Links whose old target was inside the moved subtree follow that
/// subtree to its new location; links to outside documents keep their old
/// absolute target.
pub fn rebase_source_links_between_moved_tree(
    content: &str,
    old_source_abs: &Path,
    new_source_abs: &Path,
    old_root_abs: &Path,
    new_root_abs: &Path,
) -> String {
    rebase_source_links_between_with_target_map(
        content,
        old_source_abs,
        new_source_abs,
        Some((old_root_abs, new_root_abs)),
    )
}

fn rebase_source_links_between_with_target_map(
    content: &str,
    old_source_abs: &Path,
    new_source_abs: &Path,
    moved_root: Option<(&Path, &Path)>,
) -> String {
    let old_source_dir = old_source_abs.parent().unwrap_or(Path::new(""));
    let new_source_dir = new_source_abs.parent().unwrap_or(Path::new(""));
    let moved_root = moved_root.and_then(|(old_root, new_root)| {
        Some((normalize_path(old_root)?, normalize_path(new_root)?))
    });
    rewrite_links(content, |link| {
        let mut target_abs = normalize_path(&old_source_dir.join(&link.path))?;
        if let Some((old_root, new_root)) = &moved_root {
            if let Ok(rest) = target_abs.strip_prefix(old_root) {
                target_abs = new_root.join(rest);
            }
        }
        let new_rel = make_relative_path(new_source_dir, &target_abs);
        let destination = serialize_destination(&new_rel, &link.anchor, link.style);
        Some((destination, None))
    })
}

fn normalize_path(path: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(p) => out.push(p.as_os_str()),
            Component::RootDir => out.push(std::path::MAIN_SEPARATOR.to_string()),
            Component::CurDir => {}
            Component::Normal(s) => out.push(s),
            Component::ParentDir => {
                if !out.pop() {
                    return None;
                }
            }
        }
    }
    Some(out)
}

/// Deduplicate modified sources while preserving discovery order.
pub fn dedupe_modified_sources(items: Vec<ModifiedLinkSource>) -> Vec<ModifiedLinkSource> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for item in items {
        if seen.insert(item.clone()) {
            out.push(item);
        }
    }
    out
}

fn collect_md_files_recursive(
    base: &Path,
    dir: &Path,
    skip_top_level: &[String],
    policy: &TreeIgnorePolicy,
    files: &mut Vec<PathBuf>,
) -> Result<(), AppError> {
    let Ok(meta) = fs::symlink_metadata(dir) else {
        return Ok(());
    };
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Ok(());
    }

    let at_base = dir == base;

    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();

        if at_base {
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default();
            if skip_top_level.iter().any(|s| s == name) {
                continue;
            }
        }

        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }

        let rel_path = path.strip_prefix(base).unwrap_or(&path);
        let kind = if meta.is_dir() {
            TreePathKind::Directory
        } else if meta.is_file() {
            TreePathKind::File
        } else {
            TreePathKind::Unknown
        };
        if policy.is_ignored_rel(rel_path, kind) {
            continue;
        }

        if meta.is_dir() {
            collect_md_files_recursive(base, &path, skip_top_level, policy, files)?;
        } else if meta.is_file() && path.extension().and_then(|e| e.to_str()) == Some("md") {
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
    fn test_parse_markdown_links_angle_whitespace_anchor_cyrillic() {
        let content = "See [section](<Новая папка/Документ.md#heading>) for details.";
        let links = parse_markdown_links(content);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].0, "Новая папка/Документ.md");
    }

    #[test]
    fn test_parse_markdown_links_plain_title_suffix() {
        let content =
            r#"See [doc](docs/doc.md "Readable title") and [spaced](Новая папка/doc.md)."#;
        let links = parse_markdown_links(content);
        assert_eq!(links.len(), 2);
        assert_eq!(links[0].0, "docs/doc.md");
        assert_eq!(links[1].0, "Новая папка/doc.md");
    }

    #[test]
    fn test_parse_markdown_links_unescapes_angle_delimiters() {
        let content = r"See [doc](<docs/a\>b.md>).";
        let links = parse_markdown_links(content);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].0, "docs/a>b.md");
    }

    #[test]
    fn test_parse_markdown_links_escaped_label_brackets() {
        let content = r"See [escaped \[label\]](docs/guide.md).";
        let links = parse_markdown_links(content);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].0, "docs/guide.md");
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
        // Preserve leading parent segments so resolver can apply source context.
        assert_eq!(links[0].0, "../other/file.md");
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
    fn test_parse_markdown_links_skip_images_external_reference_style() {
        let content = "\
![image](photo.md)
[external](mailto:test@example.com)
[anchor](#local)
[ref][target]
[local](target.md)

[target]: ignored.md
";
        let links = parse_markdown_links(content);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].0, "target.md");
    }

    #[test]
    fn test_parse_markdown_links_span_positions() {
        let content = "Hello [link](test.md) world";
        let links = parse_markdown_links(content);
        assert_eq!(links.len(), 1);
        assert_eq!(
            &content[links[0].1.byte_start..links[0].1.byte_end],
            "[link](test.md)"
        );
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
        assert_eq!(resolve_relative_to("intro.md", "other.md"), "other.md");
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
            .update_links_on_rename(ws, "b.md", "renamed-b.md", None)
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
    fn test_update_links_on_rename_uses_angle_for_whitespace() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path();

        fs::write(ws.join("a.md"), "See [B](b.md).\n").unwrap();
        fs::write(ws.join("b.md"), "Content.\n").unwrap();

        let index = BacklinkIndex::new();
        index.build(ws).unwrap();

        let modified = index
            .update_links_on_rename(ws, "b.md", "Новая папка/b.md", None)
            .unwrap();
        assert_eq!(modified, vec!["a.md"]);
        assert_eq!(
            fs::read_to_string(ws.join("a.md")).unwrap(),
            "See [B](<Новая папка/b.md>).\n"
        );
    }

    #[test]
    fn test_update_links_on_rename_preserves_angle_and_anchor() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path();

        fs::write(ws.join("a.md"), "See [B](<b.md#heading>).\n").unwrap();
        fs::write(ws.join("b.md"), "Content.\n").unwrap();

        let index = BacklinkIndex::new();
        index.build(ws).unwrap();

        index
            .update_links_on_rename(ws, "b.md", "folder/b.md", None)
            .unwrap();
        assert_eq!(
            fs::read_to_string(ws.join("a.md")).unwrap(),
            "See [B](<folder/b.md#heading>).\n"
        );
    }

    #[test]
    fn test_rebase_source_links_root_to_folder() {
        let content = "See [B](B.md) and [C](C.md#heading).\n";
        let updated = rebase_source_links(content, "A.md", "Folder/A.md");
        assert_eq!(updated, "See [B](../B.md) and [C](../C.md#heading).\n");
    }

    #[test]
    fn test_rebase_source_links_leaf_folder_conversion_round_trip() {
        let folder = rebase_source_links("See [B](B.md).\n", "A.md", "A/README.md");
        assert_eq!(folder, "See [B](../B.md).\n");

        let leaf = rebase_source_links(&folder, "A/README.md", "A.md");
        assert_eq!(leaf, "See [B](B.md).\n");
    }

    #[test]
    fn test_rebase_source_links_preserves_broken_intended_target() {
        let updated = rebase_source_links("See [Missing](Missing.md).\n", "A.md", "Folder/A.md");
        assert_eq!(updated, "See [Missing](../Missing.md).\n");
    }

    #[test]
    fn test_rebase_source_links_moved_tree_preserves_internal_targets() {
        let old_source = Path::new("/space/Folder/A.md");
        let new_source = Path::new("/space/Archive/Folder/A.md");
        let old_root = Path::new("/space/Folder");
        let new_root = Path::new("/space/Archive/Folder");
        let content = "See [Sibling](Sibling.md) and [Outside](../Outside.md).\n";

        let updated = rebase_source_links_between_moved_tree(
            content, old_source, new_source, old_root, new_root,
        );

        assert_eq!(
            updated,
            "See [Sibling](Sibling.md) and [Outside](../../Outside.md).\n"
        );
    }

    #[test]
    fn test_collect_md_files_uses_tree_ignore_policy() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path();
        fs::create_dir_all(ws.join(".svode")).unwrap();
        fs::create_dir_all(ws.join(".assets")).unwrap();
        fs::write(ws.join("keep.md"), "keep").unwrap();
        fs::write(ws.join(".notes.md"), "notes").unwrap();
        fs::write(ws.join(".svode").join("hidden.md"), "hidden").unwrap();
        fs::write(ws.join(".assets").join("asset.md"), "asset").unwrap();

        let mut rels = collect_md_files(ws, &[])
            .unwrap()
            .into_iter()
            .map(|path| {
                path.strip_prefix(ws)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect::<Vec<_>>();
        rels.sort();

        assert_eq!(rels, vec![".notes.md".to_string(), "keep.md".to_string()]);
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

    #[test]
    fn test_make_relative_link_between_spaces() {
        let source = Path::new("/project/space-a/docs/source.md");
        let target = Path::new("/project/space-b/target.md");
        assert_eq!(
            make_relative_link_between(source, target),
            "../../space-b/target.md"
        );
    }
}

//! Svode-owned exact routing blocks in repository `.gitignore` and
//! `.gitattributes`. User-owned lines outside the generated sections are
//! preserved byte-for-byte.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

pub const LOCAL_PATHS_START: &str = "# svode:assets-local-paths:start";
pub const LOCAL_PATHS_END: &str = "# svode:assets-local-paths:end";
pub const LFS_PATHS_START: &str = "# svode:assets-lfs-paths:start";
pub const LFS_PATHS_END: &str = "# svode:assets-lfs-paths:end";
const MANAGED_PATH_PREFIX: &str = "# svode:path ";

#[derive(Debug, thiserror::Error)]
pub enum ManagedRouteError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Malformed(String),
}

/// Read a file to a string, returning an empty string if the file does not
/// exist. Any other IO error is propagated.
pub fn read_or_empty(path: &Path) -> Result<String, std::io::Error> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e),
    }
}

/// Strip a managed block between the given start/end markers (inclusive),
/// returning the remainder. Robust to missing blocks **and** to a dangling
/// start marker with no matching end: in that case we buffer lines inside the
/// would-be block and flush them back unchanged, so we never truncate the
/// file to whatever happened to follow a malformed marker.
pub fn strip_block(contents: &str, start_marker: &str, end_marker: &str) -> String {
    let lines: Vec<&str> = contents.lines().collect();
    let mut out: Vec<&str> = Vec::with_capacity(lines.len());
    let mut buffered: Vec<&str> = Vec::new();
    let mut inside = false;
    for line in &lines {
        if !inside && line.trim() == start_marker {
            inside = true;
            buffered.push(line);
            continue;
        }
        if inside && line.trim() == end_marker {
            inside = false;
            buffered.clear();
            continue;
        }
        if inside {
            buffered.push(line);
            continue;
        }
        out.push(line);
    }
    // Dangling start with no end — preserve the buffered lines so we don't
    // silently drop user content after a broken marker.
    if inside {
        out.extend(buffered);
    }
    out.join("\n")
}

/// Append a managed block to `contents`, ensuring a single blank line between
/// the prior content and the block, and a single trailing newline.
pub fn append_block(contents: &str, start_marker: &str, body: &str, end_marker: &str) -> String {
    let mut base = contents.trim_end_matches('\n').to_string();
    if !base.is_empty() {
        base.push('\n');
    }
    base.push_str(start_marker);
    base.push('\n');
    base.push_str(body);
    base.push('\n');
    base.push_str(end_marker);
    base.push('\n');
    base
}

/// Ensure `contents` ends with exactly one trailing newline (or is empty).
pub fn normalize_trailing_newline(mut s: String) -> String {
    while s.ends_with("\n\n") {
        s.pop();
    }
    if !s.is_empty() && !s.ends_with('\n') {
        s.push('\n');
    }
    s
}

pub fn parse_managed_paths(
    contents: &str,
    start_marker: &str,
    end_marker: &str,
) -> Result<BTreeSet<String>, ManagedRouteError> {
    let mut paths = BTreeSet::new();
    let mut inside = false;
    let mut blocks = 0_u8;
    for line in contents.lines() {
        match line.trim() {
            value if value == start_marker => {
                if inside || blocks > 0 {
                    return Err(ManagedRouteError::Malformed(format!(
                        "managed Git policy block `{start_marker}` is malformed"
                    )));
                }
                inside = true;
                blocks += 1;
            }
            value if value == end_marker => {
                if !inside {
                    return Err(ManagedRouteError::Malformed(format!(
                        "managed Git policy block `{start_marker}` is malformed"
                    )));
                }
                inside = false;
            }
            _ if inside => {
                if let Some(encoded) = line.trim().strip_prefix(MANAGED_PATH_PREFIX) {
                    let path: String = serde_json::from_str(encoded).map_err(|_| {
                        ManagedRouteError::Malformed(format!(
                            "managed Git policy path in `{start_marker}` is malformed"
                        ))
                    })?;
                    paths.insert(path);
                }
            }
            _ => {}
        }
    }
    if inside {
        return Err(ManagedRouteError::Malformed(format!(
            "managed Git policy block `{start_marker}` is malformed"
        )));
    }
    Ok(paths)
}

fn render_managed_path_body(paths: &BTreeSet<String>, lfs: bool) -> String {
    paths
        .iter()
        .flat_map(|path| {
            let metadata = format!(
                "{MANAGED_PATH_PREFIX}{}",
                serde_json::to_string(path).expect("serializing a String cannot fail")
            );
            let pattern = escape_git_pattern(path, !lfs);
            let rule = if lfs {
                format!("{pattern} filter=lfs diff=lfs merge=lfs -text")
            } else {
                pattern
            };
            [metadata, rule]
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn rewrite_managed_path_block(
    contents: &str,
    start_marker: &str,
    end_marker: &str,
    paths: &BTreeSet<String>,
    lfs: bool,
) -> String {
    let stripped = strip_block(contents, start_marker, end_marker);
    if paths.is_empty() {
        return normalize_trailing_newline(stripped);
    }
    normalize_trailing_newline(append_block(
        &stripped,
        start_marker,
        &render_managed_path_body(paths, lfs),
        end_marker,
    ))
}

fn escape_git_pattern(path: &str, root_anchored: bool) -> String {
    let mut output = String::with_capacity(path.len() + usize::from(root_anchored));
    if root_anchored {
        output.push('/');
    }
    for character in path.chars() {
        if matches!(
            character,
            '\\' | ' ' | '\t' | '!' | '#' | '[' | ']' | '*' | '?'
        ) {
            output.push('\\');
        }
        output.push(character);
    }
    output
}

/// Write `contents` to `path`, creating or replacing the file. If contents is
/// empty, the file is removed (we don't want to leave an empty .gitattributes
/// lying around).
pub fn write_or_remove(path: &Path, contents: &str) -> Result<(), std::io::Error> {
    let trimmed = contents.trim();
    if trimmed.is_empty() {
        if path.exists() {
            std::fs::remove_file(path)?;
        }
        return Ok(());
    }
    std::fs::write(path, contents)
}

/// Rebase Svode-owned exact rules after a managed Page/folder move. User
/// blocks remain byte-for-byte outside the generated sections.
pub fn rebase_managed_import_routes(
    repo_dir: &Path,
    old_path: &str,
    new_path: &str,
    subtree: bool,
) -> Result<Vec<PathBuf>, ManagedRouteError> {
    let mut changed = Vec::new();
    for (file_name, start, end, lfs) in [
        (".gitignore", LOCAL_PATHS_START, LOCAL_PATHS_END, false),
        (".gitattributes", LFS_PATHS_START, LFS_PATHS_END, true),
    ] {
        let path = repo_dir.join(file_name);
        if !path.exists() {
            continue;
        }
        let current = read_or_empty(&path)?;
        let paths = parse_managed_paths(&current, start, end)?;
        let rebased = paths
            .into_iter()
            .map(|path| rebase_managed_path(&path, old_path, new_path, subtree))
            .collect::<BTreeSet<_>>();
        let next = rewrite_managed_path_block(&current, start, end, &rebased, lfs);
        if next != current {
            write_or_remove(&path, &next)?;
            changed.push(path);
        }
    }
    Ok(changed)
}

fn rebase_managed_path(path: &str, old_path: &str, new_path: &str, subtree: bool) -> String {
    if path == old_path {
        return new_path.to_string();
    }
    if subtree
        && let Some(suffix) = path.strip_prefix(old_path)
        && suffix.starts_with('/')
    {
        return format!("{new_path}{suffix}");
    }
    path.to_string()
}

fn managed_attachment_repository_dir(space: &str, project_path: Option<&str>) -> PathBuf {
    let space_dir = PathBuf::from(space);
    if space_dir.join(".git").symlink_metadata().is_ok() {
        return space_dir;
    }
    project_path
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .unwrap_or(space_dir)
}

/// Repository policy files whose managed routing blocks a Page move may rewrite.
pub fn managed_attachment_policy_paths(space: &str, project_path: Option<&str>) -> Vec<PathBuf> {
    let repo_dir = managed_attachment_repository_dir(space, project_path);
    vec![repo_dir.join(".gitignore"), repo_dir.join(".gitattributes")]
}

/// Rebase managed Attachment routes of `from` (Space-relative) to `to`.
pub fn rebase_managed_attachment_routes(
    space: &str,
    project_path: Option<&str>,
    from: &str,
    to: &str,
    subtree: bool,
) -> Result<Vec<PathBuf>, ManagedRouteError> {
    let space_dir = PathBuf::from(space);
    let repo_dir = managed_attachment_repository_dir(space, project_path);
    let space_prefix = space_dir.strip_prefix(&repo_dir).unwrap_or(Path::new(""));
    let old_path = space_prefix.join(from).to_string_lossy().replace('\\', "/");
    let new_path = space_prefix.join(to).to_string_lossy().replace('\\', "/");
    rebase_managed_import_routes(&repo_dir, &old_path, &new_path, subtree)
}

use std::{io::Read, path::Path};

use serde::{Deserialize, Serialize};
use tauri::State;

use super::{GitState, require_cli};
use crate::AppError;
use svode_core::git::cli::GitCli;
use svode_core::git::path::{RootMode, contained_file, normalize_repo_relative};
use svode_core::storage::policy::check_lfs_filters;

const MAX_BYTES: usize = 512 * 1024;
const MAX_LINE_BYTES: usize = 16 * 1024;
/// Patch of one file with full context: both sides within [`MAX_BYTES`] plus
/// a one-byte prefix per line and the headers. A larger patch means more
/// content or lines than a text diff shows anyway.
const PATCH_BYTES: usize = 2 * MAX_BYTES + 64 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingTreeItem {
    path: String,
    generation: String,
    state: &'static str,
    before: Option<String>,
    after: Option<String>,
    previous_path: Option<String>,
    title: Option<String>,
    before_bytes: usize,
    after_bytes: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectionScope {
    kind: ScopeKind,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum ScopeKind {
    File,
    Directory,
    Repository,
}

impl InspectionScope {
    pub(crate) fn contains(&self, path: &str) -> Result<bool, AppError> {
        let root = normalize_repo_relative(&self.path, RootMode::Allow)?;
        Ok(match self.kind {
            ScopeKind::File => root != "." && path == root,
            ScopeKind::Directory => root == "." || path.starts_with(&format!("{root}/")),
            ScopeKind::Repository => root == ".",
        })
    }
}

async fn bounded_git(
    cli: &GitCli,
    repo: &Path,
    args: &[&str],
) -> Result<(bool, Vec<u8>), AppError> {
    Ok(svode_core::git::cli::read_bounded(cli, repo, args, MAX_BYTES).await?)
}

#[cfg(test)]
pub(crate) async fn read_item(
    cli: &GitCli,
    space: &Path,
    path: &str,
    generation: String,
) -> Result<WorkingTreeItem, AppError> {
    read_scoped_item(cli, space, path, generation, None).await
}

pub(crate) async fn read_scoped_item(
    cli: &GitCli,
    space: &Path,
    path: &str,
    generation: String,
    scope: Option<InspectionScope>,
) -> Result<WorkingTreeItem, AppError> {
    let path = normalize_repo_relative(path, RootMode::Reject)?;
    if generation.len() > 256
        || scope
            .as_ref()
            .is_some_and(|scope| !scope.contains(&path).unwrap_or(false))
    {
        return Err(AppError::PathNotAccessible(
            "Source leaves inspection scope".into(),
        ));
    }
    let target = contained_file(space, &path)?;
    let (valid_repo, root) = bounded_git(cli, space, &["rev-parse", "--show-toplevel"]).await?;
    if !valid_repo {
        return Err(AppError::GitCommandFailed("Repository unavailable".into()));
    }
    let root = std::path::PathBuf::from(
        String::from_utf8(root)
            .map_err(|_| AppError::GitCommandFailed("Invalid repository path".into()))?
            .trim(),
    );
    let relative = crate::repo_path::repo_relative_from_base(
        &root.canonicalize()?,
        &target,
        RootMode::Reject,
    )?;
    let context = target.parent().unwrap_or(space);
    let mut existing = context;
    while !existing.exists() {
        existing = existing.parent().unwrap_or(space);
    }
    let (_, actual_root) = bounded_git(cli, existing, &["rev-parse", "--show-toplevel"]).await?;
    if String::from_utf8_lossy(&actual_root).trim() != root.to_string_lossy() {
        return Err(AppError::PathNotAccessible(
            "Source belongs to another repository".into(),
        ));
    }
    let (has_head, head) = bounded_git(cli, &root, &["rev-parse", "--verify", "HEAD"]).await?;
    let head_id = String::from_utf8_lossy(&head).trim().to_string();
    let (valid_status, status_bytes) = bounded_git(
        cli,
        space,
        &[
            "--literal-pathspecs",
            "status",
            "--porcelain=v2",
            "-z",
            "--untracked-files=no",
            "--ignore-submodules=dirty",
            "--",
            ".",
        ],
    )
    .await?;
    if !valid_status || status_bytes.len() > MAX_BYTES {
        return Err(AppError::GitCommandFailed("Item status unavailable".into()));
    }
    let status_text = String::from_utf8(status_bytes)
        .map_err(|_| AppError::GitCommandFailed("Invalid item status".into()))?;
    let mut records = status_text.split('\0');
    let mut record = "";
    let mut previous_path = None;
    while let Some(candidate) = records.next() {
        let field_count = if candidate.starts_with("2 ") {
            10
        } else if candidate.starts_with("u ") {
            11
        } else {
            9
        };
        let candidate_path = candidate.splitn(field_count, ' ').last();
        let previous = if candidate.starts_with("2 ") {
            records.next()
        } else {
            None
        };
        if candidate_path == Some(relative.as_str()) {
            record = candidate;
            previous_path = previous;
            break;
        }
    }
    let mut result = WorkingTreeItem {
        path: path.clone(),
        generation,
        state: "text",
        before: None,
        after: None,
        previous_path: None,
        title: None,
        before_bytes: 0,
        after_bytes: 0,
    };
    if record.starts_with("u ") {
        result.state = "conflict";
        return Ok(result);
    }
    // Porcelain rename evidence is metadata; the list still contains both affected paths.
    if record.starts_with("2 ") {
        if let Some(previous) = previous_path {
            let previous = normalize_repo_relative(previous, RootMode::Reject)?;
            let absolute = root.join(&previous);
            if let Ok(local) = absolute.strip_prefix(space.canonicalize()?) {
                let local = local.to_string_lossy().replace('\\', "/");
                if scope
                    .as_ref()
                    .is_none_or(|scope| scope.contains(&local).unwrap_or(false))
                {
                    contained_file(space, &local)?;
                    result.previous_path = Some(local);
                }
            }
        }
    }
    let mut baseline_exists = false;
    let before = if has_head {
        let (listed, entry) = bounded_git(
            cli,
            &root,
            &[
                "--literal-pathspecs",
                "ls-tree",
                "-z",
                "-l",
                &head_id,
                "--",
                &relative,
            ],
        )
        .await?;
        if !listed {
            return Err(AppError::GitCommandFailed("Could not read baseline".into()));
        }
        if entry.is_empty() {
            Vec::new()
        } else if entry.starts_with(b"160000 commit ") {
            result.state = "gitlink";
            return Ok(result);
        } else if !entry.starts_with(b"100") {
            result.state = "metadata";
            return Ok(result);
        } else {
            baseline_exists = true;
            result.before_bytes = String::from_utf8_lossy(&entry)
                .split('\t')
                .next()
                .and_then(|header| header.split_whitespace().last())
                .and_then(|size| size.parse().ok())
                .unwrap_or(0);
            let (read, bytes) =
                bounded_git(cli, &root, &["show", &format!("{head_id}:{relative}")]).await?;
            if !read && bytes.len() <= MAX_BYTES {
                return Err(AppError::GitCommandFailed(
                    "Could not read baseline source".into(),
                ));
            }
            bytes
        }
    } else {
        Vec::new()
    };
    if target.is_dir() {
        result.state = "metadata";
        return Ok(result);
    }
    let source_metadata = std::fs::metadata(&target).ok();
    let current_exists = target.exists();
    if current_exists && !std::fs::symlink_metadata(&target)?.is_file() {
        return Err(AppError::PathNotAccessible(
            "Not a regular source file".into(),
        ));
    }
    let after = match std::fs::File::open(&target) {
        Ok(file) => {
            if !file.metadata()?.is_file() {
                return Err(AppError::PathNotAccessible(
                    "Not a regular source file".into(),
                ));
            }
            let mut bytes = Vec::new();
            file.take((MAX_BYTES + 1) as u64).read_to_end(&mut bytes)?;
            bytes
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error.into()),
    };
    // A new file has nothing to be normalized against and keeps its bytes.
    // Read before the source check below, so a write meanwhile means retry.
    let after = if baseline_exists
        && current_exists
        && !is_binary_format(&path)
        && before.len() <= MAX_BYTES
        && after.len() <= MAX_BYTES
    {
        repository_form(cli, &root, &head_id, &relative, &before, after).await?
    } else {
        Some(after)
    };
    contained_file(space, &path)?;
    let current_metadata = std::fs::metadata(&target).ok();
    if source_metadata
        .as_ref()
        .map(|meta| (meta.len(), meta.modified().ok()))
        != current_metadata
            .as_ref()
            .map(|meta| (meta.len(), meta.modified().ok()))
    {
        return Err(AppError::GitCommandFailed(
            "Source changed; retry inspection".into(),
        ));
    }
    let (still_has_head, current_head) =
        bounded_git(cli, &root, &["rev-parse", "--verify", "HEAD"]).await?;
    if has_head != still_has_head || head != current_head {
        return Err(AppError::GitCommandFailed(
            "Baseline changed; retry inspection".into(),
        ));
    }
    result.after_bytes = current_metadata
        .as_ref()
        .map(|meta| meta.len() as usize)
        .unwrap_or(0);
    if !baseline_exists && !current_exists {
        result.state = "disappeared";
        return Ok(result);
    }
    let Some(after) = after else {
        result.state = "truncated";
        return Ok(result);
    };
    if is_binary_format(&path) {
        result.state = "binary";
    } else if before.len() > MAX_BYTES || after.len() > MAX_BYTES {
        result.state = "truncated";
    } else if before.contains(&0) || after.contains(&0) {
        result.state = "binary";
    } else if let (Ok(before), Ok(after)) = (String::from_utf8(before), String::from_utf8(after)) {
        if before.lines().count() + after.lines().count() > 10_000
            || before
                .lines()
                .chain(after.lines())
                .any(|line| line.len() > MAX_LINE_BYTES)
        {
            result.state = "truncated";
        } else {
            if before == after {
                result.state = "no_content_diff";
            }
            if path.ends_with(".md") {
                let source = if current_exists { &after } else { &before };
                result.title = svode_core::page::frontmatter::try_parse(source)
                    .ok()
                    .flatten()
                    .map(|(meta, _)| meta.title)
                    .filter(|title| !title.is_empty());
            }
            result.before = Some(before);
            result.after = Some(after);
        }
    } else {
        result.state = "invalid_encoding";
    }
    Ok(result)
}

/// The working file `after` of the tracked `relative` as `git diff <head>`
/// compares it: converted by Git itself to the repository form of the path
/// (`core.autocrlf`, `core.eol`, `text`/`eol`, safe-crlf, `ident`,
/// `working-tree-encoding`), so a line differing only by an ending Git
/// normalizes is not a change. A path with a `filter` driver keeps its bytes:
/// running a clean driver may write (Git LFS stores objects). `None` when the
/// patch exceeds [`PATCH_BYTES`].
async fn repository_form(
    cli: &GitCli,
    root: &Path,
    head_id: &str,
    relative: &str,
    before: &[u8],
    after: Vec<u8>,
) -> Result<Option<Vec<u8>>, AppError> {
    let filter = check_lfs_filters(cli, root, &[relative.to_string()]).await?;
    if filter
        .first()
        .is_none_or(|check| !matches!(check.value.as_str(), "unspecified" | "unset"))
    {
        return Ok(Some(after));
    }
    let lines = |bytes: &[u8]| bytes.iter().filter(|byte| **byte == b'\n').count();
    let context = format!("-U{}", lines(before) + lines(&after) + 1);
    // The index is not refreshed and no object is written.
    let (read, patch) = svode_core::git::cli::read_bounded(
        cli,
        root,
        &[
            "--literal-pathspecs",
            "diff-index",
            "-p",
            "-a",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            &context,
            head_id,
            "--",
            relative,
        ],
        PATCH_BYTES,
    )
    .await?;
    if patch.len() > PATCH_BYTES {
        return Ok(None);
    }
    if !read {
        return Err(AppError::GitCommandFailed(
            "Could not read source changes".into(),
        ));
    }
    Ok(Some(after_from_patch(&patch, before).unwrap_or(after)))
}

/// The new side of a one-hunk full-context `patch` of `before`; `None` when
/// the patch is not a modification of exactly `before` (the path left the
/// index, an unexpected shape), so the caller keeps the bytes on disk.
fn after_from_patch(patch: &[u8], before: &[u8]) -> Option<Vec<u8>> {
    if patch.is_empty() {
        return Some(before.to_vec());
    }
    let mut old = Vec::new();
    let mut new = Vec::new();
    let mut in_hunk = false;
    let mut last = None;
    for line in patch.split_inclusive(|byte| *byte == b'\n') {
        if !in_hunk {
            if line.starts_with(b"@@ ") {
                in_hunk = true;
            } else if line.starts_with(b"new file mode")
                || line.starts_with(b"deleted file mode")
                || line.starts_with(b"Binary files")
            {
                return None;
            }
            continue;
        }
        match line.first() {
            Some(b' ') => {
                old.extend_from_slice(&line[1..]);
                new.extend_from_slice(&line[1..]);
            }
            Some(b'-') => old.extend_from_slice(&line[1..]),
            Some(b'+') => new.extend_from_slice(&line[1..]),
            // An empty context line under `diff.suppressBlankEmpty`.
            Some(b'\n') => {
                old.push(b'\n');
                new.push(b'\n');
            }
            // `\ No newline at end of file` ends the side(s) of the line above.
            Some(b'\\') => {
                if matches!(last, Some(b' ' | b'-')) && old.pop() != Some(b'\n') {
                    return None;
                }
                if matches!(last, Some(b' ' | b'+')) && new.pop() != Some(b'\n') {
                    return None;
                }
            }
            _ => return None,
        }
        last = line.first().copied();
    }
    (in_hunk && old == before).then_some(new)
}

pub(crate) fn is_binary_format(path: &str) -> bool {
    let extension = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(
        extension.as_str(),
        "pdf"
            | "doc"
            | "docx"
            | "xls"
            | "xlsx"
            | "ppt"
            | "pptx"
            | "png"
            | "jpg"
            | "jpeg"
            | "webp"
            | "gif"
            | "ico"
            | "mp3"
            | "wav"
            | "ogg"
            | "mp4"
            | "mov"
            | "webm"
            | "zip"
    )
}

#[tauri::command]
pub async fn git_working_tree_item(
    state: State<'_, GitState>,
    space_path: String,
    path: String,
    generation: String,
    scope: Option<InspectionScope>,
) -> Result<WorkingTreeItem, AppError> {
    read_scoped_item(
        &require_cli(&state)?,
        Path::new(&space_path),
        &path,
        generation,
        scope,
    )
    .await
}

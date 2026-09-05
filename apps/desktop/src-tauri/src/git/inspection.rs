use std::{io::Read, path::Path};

use serde::{Deserialize, Serialize};
use tauri::State;

use super::{
    cli::GitCli,
    commands::{GitState, require_cli},
};
use crate::{
    AppError,
    repo_path::{RootMode, normalize_repo_relative},
};

const MAX_BYTES: usize = 512 * 1024;
const MAX_LINE_BYTES: usize = 16 * 1024;

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
    fn contains(&self, path: &str) -> Result<bool, AppError> {
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
    super::cli::read_bounded(cli, repo, args, MAX_BYTES).await
}

pub(crate) fn contained_file(space: &Path, path: &str) -> Result<std::path::PathBuf, AppError> {
    let path = normalize_repo_relative(path, RootMode::Reject)?;
    let root = space.canonicalize()?;
    let target = root.join(&path);
    let mut component = root.clone();
    for part in path.split('/') {
        component.push(part);
        if std::fs::symlink_metadata(&component)
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err(AppError::PathNotAccessible(
                "Symlink source is unavailable".into(),
            ));
        }
    }
    let mut ancestor = target.as_path();
    while !ancestor.exists() {
        ancestor = ancestor
            .parent()
            .ok_or_else(|| AppError::PathNotAccessible("Source unavailable".into()))?;
    }
    if !ancestor.canonicalize()?.starts_with(&root) {
        return Err(AppError::PathNotAccessible(
            "Source leaves repository scope".into(),
        ));
    }
    Ok(target)
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
                result.title = crate::files::frontmatter::try_parse(source)
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

fn is_binary_format(path: &str) -> bool {
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

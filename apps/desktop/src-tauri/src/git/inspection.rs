use std::{io::Read, path::Path, process::Stdio, time::Duration};

use serde::Serialize;
use tauri::State;
use tokio::{io::AsyncReadExt, process::Command};

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
}

async fn bounded_git(
    cli: &GitCli,
    repo: &Path,
    args: &[&str],
) -> Result<(bool, Vec<u8>), AppError> {
    let mut command = Command::new(cli.git_path());
    crate::process::hide_tokio_window(&mut command);
    cli.configure_process_env(&mut command);
    command
        .args(args)
        .current_dir(repo)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn()?;
    let result = tokio::time::timeout(Duration::from_secs(3), async {
        let mut bytes = Vec::new();
        child
            .stdout
            .take()
            .unwrap()
            .take((MAX_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() > MAX_BYTES {
            child.kill().await?;
            return Ok((false, bytes));
        }
        Ok::<_, std::io::Error>((child.wait().await?.success(), bytes))
    })
    .await
    .map_err(|_| AppError::GitCommandFailed("Diff read timed out".into()))??;
    Ok(result)
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

pub(crate) async fn read_item(
    cli: &GitCli,
    space: &Path,
    path: &str,
    generation: String,
) -> Result<WorkingTreeItem, AppError> {
    let path = normalize_repo_relative(path, RootMode::Reject)?;
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
    let before = if has_head {
        let (listed, entry) = bounded_git(
            cli,
            &root,
            &[
                "--literal-pathspecs",
                "ls-tree",
                "-z",
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
        } else {
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
    let (still_has_head, current_head) =
        bounded_git(cli, &root, &["rev-parse", "--verify", "HEAD"]).await?;
    if has_head != still_has_head || head != current_head {
        return Err(AppError::GitCommandFailed(
            "Baseline changed; retry inspection".into(),
        ));
    }
    let mut result = WorkingTreeItem {
        path,
        generation,
        state: "text",
        before: None,
        after: None,
    };
    if before.len() > MAX_BYTES || after.len() > MAX_BYTES {
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
            result.before = Some(before);
            result.after = Some(after);
        }
    } else {
        result.state = "invalid_encoding";
    }
    Ok(result)
}

#[tauri::command]
pub async fn git_working_tree_item(
    state: State<'_, GitState>,
    space_path: String,
    path: String,
    generation: String,
) -> Result<WorkingTreeItem, AppError> {
    read_item(
        &require_cli(&state)?,
        Path::new(&space_path),
        &path,
        generation,
    )
    .await
}

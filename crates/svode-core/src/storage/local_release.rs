//! Leaving the `local` strategy: which untracked files its `.gitignore`
//! blocks keep out of Git right now, and the exact LFS rules those files need
//! when the repository moves to Git LFS. Nothing here indexes or commits.

use std::collections::BTreeSet;
use std::path::Path;

use crate::git::GitError;
use crate::git::cli::{GitCli, nul_paths_input};

use super::config::BinaryRoutingConfig;
use super::local_rules::{
    LEGACY_ASSETS_IGNORE_END, LEGACY_ASSETS_IGNORE_START, LOCAL_EXTENSIONS_END,
    LOCAL_EXTENSIONS_START,
};
use super::policy::{self, StoragePolicyError};
use super::routes::{
    LFS_PATHS_END, LFS_PATHS_START, LOCAL_PATHS_END, LOCAL_PATHS_START, parse_managed_paths,
    read_or_empty, rewrite_managed_path_block,
};

/// The `.gitignore` blocks of the `local` strategy; leaving `local` removes
/// all of them.
const LOCAL_BLOCKS: [(&str, &str); 3] = [
    (LOCAL_EXTENSIONS_START, LOCAL_EXTENSIONS_END),
    (LOCAL_PATHS_START, LOCAL_PATHS_END),
    (LEGACY_ASSETS_IGNORE_START, LEGACY_ASSETS_IGNORE_END),
];

/// Untracked files of the repository at `repo_dir` that a rule of a `local`
/// block in its `.gitignore` keeps out of Git right now: the rule Git applies
/// to the file is one of those blocks. Repository-relative paths, sorted.
/// Without such blocks the repository is not asked at all.
pub async fn files_held_by_local_rules(
    cli: &GitCli,
    repo_dir: &Path,
) -> Result<Vec<String>, StoragePolicyError> {
    let block_lines = local_block_lines(&read_or_empty(&repo_dir.join(".gitignore"))?);
    if block_lines.is_empty() {
        return Ok(Vec::new());
    }

    // `matching` names an ignored directory once instead of its files, so an
    // ignored dependency tree costs one entry.
    let status = cli
        .exec(
            repo_dir,
            &[
                "status",
                "--porcelain=v2",
                "--ignored=matching",
                "--untracked-files=all",
                "--no-renames",
                "-z",
            ],
        )
        .await?;
    if status.exit_code != 0 {
        return Err(git_failed("status", &status.stderr));
    }
    let ignored: Vec<String> = status
        .stdout
        .split_terminator('\0')
        .filter_map(|record| record.strip_prefix("! "))
        .map(str::to_string)
        .collect();
    if ignored.is_empty() {
        return Ok(Vec::new());
    }

    let output = cli
        .exec_with_input(
            repo_dir,
            &["check-ignore", "--verbose", "-z", "--stdin"],
            &[],
            &nul_paths_input(&ignored),
        )
        .await?;
    // Exit 1 means that no path matched.
    if !matches!(output.exit_code, 0 | 1) {
        return Err(git_failed("check-ignore", &output.stderr));
    }
    let fields: Vec<&str> = output.stdout.split_terminator('\0').collect();
    if !fields.len().is_multiple_of(4) {
        return Err(GitError::GitCommandFailed(
            "git check-ignore returned malformed NUL-delimited output".to_string(),
        )
        .into());
    }

    let mut held = BTreeSet::new();
    for record in fields.chunks_exact(4) {
        let (source, line, path) = (record[0], record[1], record[3]);
        let in_local_block = source == ".gitignore"
            && line
                .parse::<usize>()
                .is_ok_and(|line| block_lines.contains(&line));
        if !in_local_block {
            continue;
        }
        match path.strip_suffix('/') {
            Some(directory) => collect_files(repo_dir, directory, &mut held)?,
            None => {
                held.insert(path.to_string());
            }
        }
    }
    Ok(held.into_iter().collect())
}

/// `.gitattributes` text that also routes `released` files to Git LFS by
/// exact rules where the repository rules of `routing` leave them out: a file
/// of another format at least the threshold. Exact rules already there are
/// kept; without new ones `contents` comes back as is.
pub fn with_released_lfs_paths(
    contents: &str,
    repo_dir: &Path,
    released: &[String],
    routing: &BinaryRoutingConfig,
) -> Result<String, StoragePolicyError> {
    let mut added = Vec::new();
    for path in released {
        let Ok(metadata) = repo_dir.join(path).symlink_metadata() else {
            continue;
        };
        if metadata.is_file() && policy::needs_exact_lfs_rule(path, metadata.len(), routing) {
            added.push(path.clone());
        }
    }
    if added.is_empty() {
        return Ok(contents.to_string());
    }
    let mut paths = parse_managed_paths(contents, LFS_PATHS_START, LFS_PATHS_END)?;
    let before = paths.len();
    paths.extend(added);
    if paths.len() == before {
        return Ok(contents.to_string());
    }
    Ok(rewrite_managed_path_block(
        contents,
        LFS_PATHS_START,
        LFS_PATHS_END,
        &paths,
        true,
    ))
}

/// 1-based numbers of the lines inside complete `local` blocks.
fn local_block_lines(contents: &str) -> BTreeSet<usize> {
    let mut lines = BTreeSet::new();
    let mut open: Option<(&str, Vec<usize>)> = None;
    for (index, line) in contents.lines().enumerate() {
        let line = line.trim();
        match open.take() {
            Some((end, inner)) if line == end => lines.extend(inner),
            Some((end, mut inner)) => {
                inner.push(index + 1);
                open = Some((end, inner));
            }
            None => {
                open = LOCAL_BLOCKS
                    .iter()
                    .find(|(start, _)| line == *start)
                    .map(|(_, end)| (*end, Vec::new()));
            }
        }
    }
    lines
}

/// Add the files under the ignored `directory` (repository relative) to
/// `held`. Links are counted as files and never followed; `.git`
/// directories are skipped.
fn collect_files(
    repo_dir: &Path,
    directory: &str,
    held: &mut BTreeSet<String>,
) -> Result<(), std::io::Error> {
    let mut stack = vec![directory.to_string()];
    while let Some(relative) = stack.pop() {
        for entry in std::fs::read_dir(repo_dir.join(&relative))? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if name == ".git" {
                continue;
            }
            let path = format!("{relative}/{name}");
            if entry.file_type()?.is_dir() {
                stack.push(path);
            } else {
                held.insert(path);
            }
        }
    }
    Ok(())
}

fn git_failed(command: &str, stderr: &str) -> StoragePolicyError {
    GitError::GitCommandFailed(format!("git {command} failed: {}", stderr.trim())).into()
}

#[cfg(test)]
#[path = "local_release_tests.rs"]
mod tests;

//! Repository rules of the `local` strategy in `.gitignore`: the managed
//! block with one rule per extension of the effective list, which keeps such
//! files out of Git whatever way they reached the folder, and the cleanup of
//! exact rules whose files are gone. User lines outside the Svode blocks are
//! kept.

use std::collections::BTreeSet;
use std::path::Path;

use crate::git::GitError;
use crate::git::cli::GitCli;

use super::config::{AssetsStrategy, read_space_assets_config};
use super::policy::{self, StoragePolicyError, case_insensitive_extension_pattern};
use super::routes::{
    LOCAL_PATHS_END, LOCAL_PATHS_START, append_block, normalize_trailing_newline,
    parse_managed_paths, read_or_empty, rewrite_managed_path_block, strip_block, write_or_remove,
};

pub const LOCAL_EXTENSIONS_START: &str = "# svode:assets-local-extensions:start";
pub const LOCAL_EXTENSIONS_END: &str = "# svode:assets-local-extensions:end";

/// Paths one `git ls-files` call names at most.
const LS_FILES_CHUNK: usize = 500;

/// One case-insensitive rule per extension, matching at any depth.
pub fn local_extensions_body(extensions: &[String]) -> String {
    extensions
        .iter()
        .map(|extension| case_insensitive_extension_pattern(extension))
        .collect::<Vec<_>>()
        .join("\n")
}

/// `Some` keeps the block with the rules of `extensions` (no block for an
/// empty list), `None` removes it. A block that is already there keeps its
/// place in the file.
pub fn rewrite_local_extensions_block(contents: &str, extensions: Option<&[String]>) -> String {
    let body = extensions
        .filter(|extensions| !extensions.is_empty())
        .map(local_extensions_body);
    replace_block(
        contents,
        LOCAL_EXTENSIONS_START,
        body.as_deref(),
        LOCAL_EXTENSIONS_END,
    )
}

fn replace_block(contents: &str, start: &str, body: Option<&str>, end: &str) -> String {
    let lines: Vec<&str> = contents.lines().collect();
    let starts: Vec<usize> = marker_positions(&lines, start);
    let ends: Vec<usize> = marker_positions(&lines, end);
    if let ([first], [last]) = (starts.as_slice(), ends.as_slice())
        && first < last
    {
        let mut out: Vec<&str> = lines[..*first].to_vec();
        if let Some(body) = body {
            out.push(start);
            out.extend(body.lines());
            out.push(end);
        }
        out.extend_from_slice(&lines[last + 1..]);
        return normalize_trailing_newline(out.join("\n"));
    }
    let stripped = strip_block(contents, start, end);
    normalize_trailing_newline(match body {
        Some(body) => append_block(&stripped, start, body, end),
        None => stripped,
    })
}

fn marker_positions(lines: &[&str], marker: &str) -> Vec<usize> {
    lines
        .iter()
        .enumerate()
        .filter(|(_, line)| line.trim() == marker)
        .map(|(index, _)| index)
        .collect()
}

/// Keep the exact local rules whose path is on disk or in the Git index; the
/// rule of a path that is neither would silently hide a future file.
pub async fn retain_present_local_paths(
    cli: &GitCli,
    repo_dir: &Path,
    paths: BTreeSet<String>,
) -> Result<BTreeSet<String>, StoragePolicyError> {
    let (mut present, missing): (BTreeSet<String>, BTreeSet<String>) = paths
        .into_iter()
        .partition(|path| repo_dir.join(path).symlink_metadata().is_ok());
    let missing: Vec<String> = missing.into_iter().collect();
    for chunk in missing.chunks(LS_FILES_CHUNK) {
        let mut args = vec!["ls-files", "--cached", "-z", "--"];
        args.extend(chunk.iter().map(String::as_str));
        let output = cli
            .exec_with_env(repo_dir, &args, &[("GIT_LITERAL_PATHSPECS", "1")])
            .await?;
        if output.exit_code != 0 {
            return Err(GitError::GitCommandFailed(format!(
                "git ls-files failed: {}",
                output.stderr.trim()
            ))
            .into());
        }
        let indexed: BTreeSet<&str> = output.stdout.split_terminator('\0').collect();
        present.extend(
            chunk
                .iter()
                .filter(|path| indexed.contains(path.as_str()))
                .cloned(),
        );
    }
    Ok(present)
}

/// The `.gitignore` text of a repository with the `local` strategy: exact
/// rules of gone paths dropped, exact rules of `added_paths` (repository
/// relative) written, then the extension block of `extensions`.
pub async fn local_gitignore(
    cli: &GitCli,
    repo_dir: &Path,
    contents: &str,
    extensions: &[String],
    added_paths: &[String],
) -> Result<String, StoragePolicyError> {
    let paths = parse_managed_paths(contents, LOCAL_PATHS_START, LOCAL_PATHS_END)?;
    let mut retained = retain_present_local_paths(cli, repo_dir, paths.clone()).await?;
    retained.extend(added_paths.iter().cloned());
    let next = if retained == paths {
        contents.to_string()
    } else {
        rewrite_managed_path_block(
            contents,
            LOCAL_PATHS_START,
            LOCAL_PATHS_END,
            &retained,
            false,
        )
    };
    Ok(rewrite_local_extensions_block(&next, Some(extensions)))
}

/// Bring the `local` rules of the repository at `repo_dir` up to date when
/// its own config sets the `local` strategy. A config that cannot be read,
/// another strategy or routing of a newer version leaves the file alone, and
/// the config is never written. A malformed Svode block is left for the user
/// and reported as unchanged. Returns whether `.gitignore` changed.
pub async fn repair_local_rules(cli: &GitCli, repo_dir: &Path) -> Result<bool, GitError> {
    match write_local_rules(cli, repo_dir).await {
        Ok(changed) => Ok(changed),
        Err(StoragePolicyError::Io(error)) => Err(error.into()),
        Err(StoragePolicyError::Git(error)) => Err(error),
        Err(StoragePolicyError::Storage(message)) => {
            tracing::warn!(repository = %repo_dir.display(), "local storage rules left as they are: {message}");
            Ok(false)
        }
    }
}

async fn write_local_rules(cli: &GitCli, repo_dir: &Path) -> Result<bool, StoragePolicyError> {
    let Ok(config) = read_space_assets_config(repo_dir) else {
        return Ok(false);
    };
    let assets = config.assets.unwrap_or_default();
    if assets.strategy != AssetsStrategy::Local {
        return Ok(false);
    }
    let Ok(routing) = policy::supported_binary_routing(&assets) else {
        return Ok(false);
    };
    let extensions = policy::effective_local_extensions(&routing);
    let path = repo_dir.join(".gitignore");
    let current = read_or_empty(&path)?;
    let next = local_gitignore(cli, repo_dir, &current, &extensions, &[]).await?;
    if next == current {
        return Ok(false);
    }
    write_or_remove(&path, &next)?;
    Ok(true)
}

#[cfg(test)]
#[path = "local_rules_tests.rs"]
mod tests;

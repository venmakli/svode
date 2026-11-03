//! The renumbering of repeated `unique_id` numbers in the integration step
//! (module 01 1.B, DF-237 R3). The rule belongs to Collections
//! ([`crate::collections::unique_id_renumber`]); Git reads what the observed
//! revision published, keeps the paths in conflict as they are and puts the
//! renumbering of committed items into the merge of the step: the merge
//! commit Svode made, or the merge stopped for the person, who concludes it.
//! The renumbering of items that are not committed stays in the working
//! copy and is committed like any other edit.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;
use std::time::Duration;

use super::GitError;
use super::cli::{GitCli, blobs_at, literal_pathspec_input, literal_pathspecs};
use super::diagnostics::{GitStage, HookTrace};
use crate::collections::unique_id_renumber::{
    self, CollectionRenumbering, RenumberedItem, item_source_with_number, schema_source_with_next,
    source_number,
};

const SOURCE_BYTES: usize = 32 * 1024 * 1024;
const SOURCE_TIMEOUT: Duration = Duration::from_secs(10);

/// Where the integration step leaves the renumbering of committed items.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Landing {
    /// A fast-forward: every committed item is published, so the
    /// renumbering stays in the working copy.
    WorkingCopy,
    /// The merge commit the step made, amended with it.
    MergeCommit,
    /// The merge stopped for the person: it is staged for the merge commit.
    Merge,
}

/// Renumber the items of the repository at `repo` that repeat a number
/// published in `revision`, the observed upstream revision the step
/// integrated, and name them.
pub(crate) async fn renumber_repeated(
    cli: &GitCli,
    repo: &Path,
    revision: &str,
    landing: Landing,
) -> Result<Vec<RenumberedItem>, GitError> {
    let repeats = unique_id_renumber::repeats_in_repository(repo);
    if repeats.is_empty() {
        return Ok(Vec::new());
    }
    let items: Vec<String> = repeats
        .iter()
        .flat_map(|repeat| repeat.item_paths())
        .collect();
    let published = blobs_at(cli, repo, revision, &items, SOURCE_BYTES, SOURCE_TIMEOUT).await;
    let held = if landing == Landing::Merge {
        unmerged_paths(cli, repo).await?
    } else {
        BTreeSet::new()
    };
    // What is committed, read before the renumbering writes: the index
    // versions and the paths whose working copy differs from them.
    let (index, changed) = if landing == Landing::WorkingCopy {
        (HashMap::new(), HashSet::new())
    } else {
        let mut paths = items;
        paths.extend(repeats.iter().map(|repeat| repeat.schema_path()));
        let index = blobs_at(cli, repo, "", &paths, SOURCE_BYTES, SOURCE_TIMEOUT).await;
        (index, changed_in_working_copy(cli, repo, &paths).await?)
    };
    let renumbered = unique_id_renumber::renumber(&repeats, &published, &held);
    if landing != Landing::WorkingCopy
        && stage_committed(cli, repo, &renumbered, &index, &changed).await?
        && landing == Landing::MergeCommit
    {
        amend_merge_commit(cli, repo).await?;
    }
    let items: Vec<RenumberedItem> = renumbered
        .into_iter()
        .flat_map(|collection| collection.items.into_iter().map(|item| item.item))
        .collect();
    if !items.is_empty() {
        tracing::info!(
            "Renumbered {} repeated unique_id in {}",
            items.len(),
            repo.display()
        );
    }
    Ok(items)
}

/// Stage the renumbering of the committed items of `renumbered` and the
/// `next` of their Collection: a path whose working copy was its index
/// version is added, the index version of one with other edits gets the same
/// change while those edits stay in the working copy. An item is committed
/// when its index version holds the number it gave up. Whether anything was
/// staged.
async fn stage_committed(
    cli: &GitCli,
    repo: &Path,
    renumbered: &[CollectionRenumbering],
    index: &HashMap<String, String>,
    changed: &HashSet<String>,
) -> Result<bool, GitError> {
    let mut added = Vec::new();
    let mut versions = Vec::new();
    for collection in renumbered {
        let mut committed = false;
        for item in &collection.items {
            let path = &item.item.path;
            let Some(source) = index.get(path) else {
                continue;
            };
            if source_number(source, &collection.field) != Some(item.old) {
                continue;
            }
            committed = true;
            if !changed.contains(path) {
                added.push(path.clone());
            } else if let Some(text) = item_source_with_number(source, &collection.field, item.new)
            {
                versions.push((path.clone(), text));
            }
        }
        let schema = &collection.schema_path;
        let Some(source) = index.get(schema).filter(|_| committed) else {
            continue;
        };
        if !changed.contains(schema) {
            added.push(schema.clone());
        } else if let Some(text) =
            schema_source_with_next(source, &collection.field, collection.next)
        {
            versions.push((schema.clone(), text));
        }
    }
    if !added.is_empty() {
        let out = cli
            .exec_with_input(
                repo,
                &["add", "--pathspec-from-file=-", "--pathspec-file-nul"],
                &[],
                &literal_pathspec_input(&added),
            )
            .await?;
        if out.exit_code != 0 {
            return Err(GitError::GitCommandFailed(format!(
                "git add failed: {}",
                out.stderr.trim()
            )));
        }
    }
    for (path, text) in &versions {
        write_index_version(cli, repo, path, text).await?;
    }
    Ok(!added.is_empty() || !versions.is_empty())
}

/// Record `text` as the index version of `path` with its current mode,
/// leaving the working copy as it is.
async fn write_index_version(
    cli: &GitCli,
    repo: &Path,
    path: &str,
    text: &str,
) -> Result<(), GitError> {
    let failed = |command: &str, stderr: &str| {
        GitError::GitCommandFailed(format!("git {command} failed: {}", stderr.trim()))
    };
    let path_arg = format!("--path={path}");
    let hashed = cli
        .exec_with_input(
            repo,
            &["hash-object", "-w", "--stdin", &path_arg],
            &[],
            text.as_bytes(),
        )
        .await?;
    if hashed.exit_code != 0 {
        return Err(failed("hash-object", &hashed.stderr));
    }
    let literal = format!(":(literal){path}");
    let staged = cli
        .exec(repo, &["ls-files", "--stage", "-z", "--", &literal])
        .await?;
    let Some(mode) = staged
        .stdout
        .split(' ')
        .next()
        .filter(|mode| !mode.is_empty())
    else {
        return Err(failed("ls-files", &staged.stderr));
    };
    let cache = format!("{mode},{},{path}", hashed.stdout.trim());
    let out = cli
        .exec(repo, &["update-index", "--cacheinfo", &cache])
        .await?;
    if out.exit_code != 0 {
        return Err(failed("update-index", &out.stderr));
    }
    Ok(())
}

/// Conclude the renumbering in the merge commit the step made: the same
/// commit with the staged renumbering, its message, parents, hooks and
/// signing.
async fn amend_merge_commit(cli: &GitCli, repo: &Path) -> Result<(), GitError> {
    let trace = HookTrace::new();
    let out = cli
        .exec_with_env(
            repo,
            &[
                "-c",
                "rerere.enabled=false",
                "commit",
                "--amend",
                "--no-edit",
            ],
            &trace.env(&[]),
        )
        .await?;
    if out.exit_code != 0 {
        return Err(super::ops::sync_failure(
            repo,
            GitStage::Integrate,
            &out.stderr,
            trace.hook_failed(),
        ));
    }
    Ok(())
}

/// Of `paths`, those whose working copy differs from the index.
async fn changed_in_working_copy(
    cli: &GitCli,
    repo: &Path,
    paths: &[String],
) -> Result<HashSet<String>, GitError> {
    let pathspecs = literal_pathspecs(paths);
    let mut args = vec!["diff", "--name-only", "--no-renames", "-z", "--"];
    args.extend(pathspecs.iter().map(String::as_str));
    let out = cli.exec(repo, &args).await?;
    if out.exit_code != 0 {
        return Err(GitError::GitCommandFailed(format!(
            "git diff failed: {}",
            out.stderr.trim()
        )));
    }
    Ok(out
        .stdout
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
        .collect())
}

/// The paths in conflict, relative to the repository.
async fn unmerged_paths(cli: &GitCli, repo: &Path) -> Result<BTreeSet<String>, GitError> {
    Ok(super::service_merge::index_conflicts(cli, repo)
        .await?
        .into_iter()
        .map(|conflict| conflict.path)
        .collect())
}

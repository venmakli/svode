//! The stop «Идёт операция Git» (1.F): the step Git reports for a rebase,
//! cherry-pick, revert or sequencer it stopped, and its abort by Git's own
//! command. Svode never continues the operation itself.

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::GitError;
use super::branch::{GitOperation, operation_in_progress};
use super::cli::GitCli;
use super::diagnostics::{GitFailure, GitFailureCause, GitStage, repository_name};

/// Where the stopped operation is, as Git reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum OperationStep {
    /// A rebase stopped at commit `current` of the `total` it replays.
    Position { current: u32, total: u32 },
    /// A sequence of cherry-picks or reverts has `count` commits left to
    /// apply, the stopped one included.
    Remaining { count: u32 },
}

/// The state directories of rebase and of the cherry-pick/revert sequencer.
/// They are directories in the repository's Git directory with either ref
/// store.
struct StateDirectories {
    rebase_merge: PathBuf,
    rebase_apply: PathBuf,
    sequencer: PathBuf,
}

async fn state_directories(cli: &GitCli, repo: &Path) -> Result<StateDirectories, GitError> {
    let out = cli
        .exec(
            repo,
            &[
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                "rebase-merge",
                "--git-path",
                "rebase-apply",
                "--git-path",
                "sequencer",
            ],
        )
        .await?;
    let mut lines = out.stdout.lines().map(PathBuf::from);
    match (out.exit_code, lines.next(), lines.next(), lines.next()) {
        (0, Some(rebase_merge), Some(rebase_apply), Some(sequencer)) => Ok(StateDirectories {
            rebase_merge,
            rebase_apply,
            sequencer,
        }),
        _ => Err(GitError::GitCommandFailed(format!(
            "cannot locate the Git operation state: {}",
            out.stderr.trim()
        ))),
    }
}

fn number(directory: &Path, name: &str) -> Option<u32> {
    std::fs::read_to_string(directory.join(name))
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// The commands a sequencer has left: its todo without comments and blank
/// lines. The stopped command is its first line until Git moves past it.
fn todo_commands(sequencer: &Path) -> Option<u32> {
    let todo = std::fs::read_to_string(sequencer.join("todo")).ok()?;
    let count = todo
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .count();
    u32::try_from(count).ok()
}

/// The step of `operation` that Git reports: a rebase by the commit it
/// replays (`msgnum`/`end` of the merge backend, `next`/`last` of the apply
/// backend), a sequence of cherry-picks or reverts by what its todo has
/// left. A single cherry-pick or revert reports no step.
pub async fn step(
    cli: &GitCli,
    repo: &Path,
    operation: GitOperation,
) -> Result<Option<OperationStep>, GitError> {
    let directories = state_directories(cli, repo).await?;
    Ok(match operation {
        GitOperation::Merge => None,
        GitOperation::Rebase => [
            (&directories.rebase_merge, "msgnum", "end"),
            (&directories.rebase_apply, "next", "last"),
        ]
        .into_iter()
        .find(|(directory, _, _)| directory.is_dir())
        .and_then(|(directory, current, total)| {
            Some(OperationStep::Position {
                current: number(directory, current)?,
                total: number(directory, total)?,
            })
        }),
        GitOperation::CherryPick | GitOperation::Revert | GitOperation::Sequencer => {
            todo_commands(&directories.sequencer).map(|count| OperationStep::Remaining { count })
        }
    })
}

/// Abort the stopped rebase, cherry-pick, revert or sequencer with Git's own
/// command, which returns the branch and the files to the state before the
/// operation; for a sequence of cherry-picks or reverts, before the whole
/// sequence. Commits made before the operation are kept.
///
/// A sequencer whose HEAD moved after its last step (a commit made by hand
/// at the stop) is refused before Git runs: Git would end the sequence
/// without rewinding the branch. Git's own refusal is a
/// [`GitError::SyncFailed`] of stage [`GitStage::Abort`] with the cause it
/// names; no operation to abort is a [`GitError::GitCommandFailed`].
pub async fn abort(cli: &GitCli, repo: &Path) -> Result<(), GitError> {
    let operation = operation_in_progress(cli, repo).await?;
    let command = match operation {
        Some(GitOperation::Rebase) => "rebase",
        Some(GitOperation::CherryPick) => "cherry-pick",
        Some(GitOperation::Revert) => "revert",
        // Git rolls back a sequence the same way whichever command started
        // it, and refuses a sequence that is not its own only for --skip.
        Some(GitOperation::Sequencer) => "cherry-pick",
        Some(GitOperation::Merge) | None => {
            return Err(GitError::GitCommandFailed(
                "no rebase, cherry-pick or revert is in progress".into(),
            ));
        }
    };
    if command != "rebase" && head_moved(cli, repo).await? {
        return Err(GitError::SyncFailed(GitFailure {
            repository: repository_name(repo),
            stage: GitStage::Abort,
            cause: Some(GitFailureCause::HeadMoved),
        }));
    }
    let out = cli.exec(repo, &[command, "--abort"]).await?;
    if out.exit_code != 0 {
        tracing::warn!(
            "git {command} --abort failed in {}: {}",
            repo.display(),
            out.stderr.trim()
        );
        return Err(GitError::SyncFailed(GitFailure::from_output(
            repo,
            GitStage::Abort,
            &out.stderr,
            false,
        )));
    }
    tracing::info!("Aborted git {command} in {}", repo.display());
    Ok(())
}

/// Whether HEAD is no longer where the sequencer left it, by the check of
/// Git's rollback, which then only drops the sequence. A single cherry-pick
/// or revert has no sequence to rewind.
async fn head_moved(cli: &GitCli, repo: &Path) -> Result<bool, GitError> {
    let sequencer = state_directories(cli, repo).await?.sequencer;
    if !sequencer.join("head").is_file() {
        return Ok(false);
    }
    // Git expects no HEAD when the record is missing.
    let safety = match std::fs::read_to_string(sequencer.join("abort-safety")) {
        Ok(safety) => safety,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.into()),
    };
    let head = cli
        .exec(repo, &["rev-parse", "-q", "--verify", "HEAD"])
        .await?;
    // An unborn HEAD gives an empty record, as Git writes it.
    let head = if head.exit_code == 0 {
        head.stdout.trim().to_string()
    } else {
        String::new()
    };
    Ok(safety.trim() != head)
}

#[cfg(test)]
#[path = "operation_stop_tests.rs"]
mod tests;

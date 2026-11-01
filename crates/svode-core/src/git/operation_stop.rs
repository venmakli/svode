//! The stop «Идёт операция Git» (1.F): the step Git reports for a rebase,
//! cherry-pick, revert or sequencer it stopped, the commits the abort of a
//! sequence drops, and the abort, by Git's own command or, for a sequence
//! whose HEAD moved, by rewinding its branch (DF-282). Svode never continues
//! the operation itself.

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

/// How many titles of the commits a sequence abort drops the stop names;
/// the rest is only counted.
pub const SEQUENCE_TITLES: usize = 5;

/// What the abort of a sequence of cherry-picks or reverts drops: the
/// commits from the start of the sequence to `head`, that is the applied
/// steps and the commits made by hand at a stop.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceCommits {
    /// The HEAD the list is for. An abort that names another HEAD, or none,
    /// is refused with [`GitFailureCause::StateChanged`].
    pub head: String,
    /// How many commits the abort drops.
    pub count: u32,
    /// The titles of the newest [`SEQUENCE_TITLES`] of them, newest first.
    pub titles: Vec<String>,
}

/// The record of a sequence of cherry-picks or reverts: the revision it
/// started from and the HEAD of its last stop. A single cherry-pick or
/// revert has none.
struct Sequence {
    start: String,
    /// `None` for an unborn HEAD at the stop, as Git writes it.
    safety: Option<String>,
}

async fn sequence(cli: &GitCli, repo: &Path) -> Result<Option<Sequence>, GitError> {
    let directory = state_directories(cli, repo).await?.sequencer;
    let start = match std::fs::read_to_string(directory.join("head")) {
        Ok(start) => start.trim().to_string(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    // Git expects no HEAD when the record is missing.
    let safety = match std::fs::read_to_string(directory.join("abort-safety")) {
        Ok(safety) => safety.trim().to_string(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.into()),
    };
    Ok(Some(Sequence {
        start,
        safety: Some(safety).filter(|safety| !safety.is_empty()),
    }))
}

/// HEAD, or `None` when it is unborn.
async fn head(cli: &GitCli, repo: &Path) -> Result<Option<String>, GitError> {
    let out = cli
        .exec(repo, &["rev-parse", "-q", "--verify", "HEAD"])
        .await?;
    Ok((out.exit_code == 0)
        .then(|| out.stdout.trim().to_string())
        .filter(|head| !head.is_empty()))
}

/// Whether `head` continues `start`: a record that is not an object id, or
/// not a commit, continues nothing.
async fn continues(cli: &GitCli, repo: &Path, start: &str, head: &str) -> Result<bool, GitError> {
    if start.is_empty() || !start.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Ok(false);
    }
    let out = cli
        .exec(repo, &["merge-base", "--is-ancestor", start, head])
        .await?;
    Ok(out.exit_code == 0)
}

async fn count(cli: &GitCli, repo: &Path, revisions: &[&str]) -> Result<u32, GitError> {
    let mut args = vec!["rev-list", "--count"];
    args.extend_from_slice(revisions);
    let out = cli.exec(repo, &args).await?;
    if out.exit_code != 0 {
        return Err(GitError::GitCommandFailed(format!(
            "cannot count the commits of the sequence: {}",
            out.stderr.trim()
        )));
    }
    out.stdout.trim().parse().map_err(|_| {
        GitError::GitCommandFailed("unexpected count of the commits of the sequence".into())
    })
}

/// The commits the abort of the stopped sequence of cherry-picks or reverts
/// drops, for its confirmation (DF-282 R3). `None` for a rebase, a single
/// cherry-pick or revert, an unborn HEAD, and a branch that no longer
/// continues the start of the sequence, whose abort is refused.
pub async fn sequence_commits(
    cli: &GitCli,
    repo: &Path,
) -> Result<Option<SequenceCommits>, GitError> {
    let Some(sequence) = sequence(cli, repo).await? else {
        return Ok(None);
    };
    let Some(head) = head(cli, repo).await? else {
        return Ok(None);
    };
    if !continues(cli, repo, &sequence.start, &head).await? {
        return Ok(None);
    }
    let range = format!("{}..{head}", sequence.start);
    let count = count(cli, repo, &[&range]).await?;
    let limit = SEQUENCE_TITLES.to_string();
    let out = cli
        .exec(
            repo,
            &[
                "log",
                "--no-show-signature",
                "--no-color",
                "--format=%s",
                "-n",
                &limit,
                &range,
            ],
        )
        .await?;
    if out.exit_code != 0 {
        return Err(GitError::GitCommandFailed(format!(
            "cannot read the commits of the sequence: {}",
            out.stderr.trim()
        )));
    }
    Ok(Some(SequenceCommits {
        head,
        count,
        titles: out.stdout.lines().map(str::to_string).collect(),
    }))
}

/// Abort the stopped rebase, cherry-pick, revert or sequencer, returning the
/// branch and the files to the state before the operation; for a sequence
/// of cherry-picks or reverts, before the whole sequence. Commits made
/// before the operation are kept.
///
/// A sequence is checked first, with local data only (DF-282 R2): its
/// branch still continues its start ([`GitFailureCause::BranchLeftSequence`]),
/// no commit it drops is reachable from a remote-tracking ref
/// ([`GitFailureCause::CommitsPublished`]) and HEAD is `expected_head`, the
/// HEAD of the [`SequenceCommits`] the confirmation listed
/// ([`GitFailureCause::StateChanged`]). When HEAD is no longer where the
/// sequence stopped, a commit made by hand at the stop, Git would end the
/// sequence without rewinding the branch, so Svode rewinds it to the start
/// keeping the edits the rewind does not touch, then drops the sequence.
/// Otherwise Git's own command aborts.
///
/// Every refusal is a [`GitError::SyncFailed`] of stage [`GitStage::Abort`]
/// with its cause and changes nothing; no operation to abort is a
/// [`GitError::GitCommandFailed`].
pub async fn abort(cli: &GitCli, repo: &Path, expected_head: Option<&str>) -> Result<(), GitError> {
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
    if command != "rebase" {
        if let Some(sequence) = sequence(cli, repo).await? {
            let head = head(cli, repo).await?;
            if let Some(start) = check_sequence(cli, repo, &sequence, head, expected_head).await? {
                return rewind(cli, repo, command, &start).await;
            }
        }
    }
    let out = cli.exec(repo, &[command, "--abort"]).await?;
    if out.exit_code != 0 {
        tracing::warn!(
            "git {command} --abort failed in {}: {}",
            repo.display(),
            out.stderr.trim()
        );
        return Err(abort_failed(repo, &out.stderr));
    }
    tracing::info!("Aborted git {command} in {}", repo.display());
    Ok(())
}

/// The checks of DF-282 R2 (a)–(c) before the abort of `sequence`; the
/// start to rewind to when HEAD moved after its last stop, `None` when Git's
/// own abort rewinds it.
async fn check_sequence(
    cli: &GitCli,
    repo: &Path,
    sequence: &Sequence,
    head: Option<String>,
    expected_head: Option<&str>,
) -> Result<Option<String>, GitError> {
    let moved = sequence.safety != head;
    if let Some(head) = &head {
        if !continues(cli, repo, &sequence.start, head).await? {
            // Git's own abort is safe only from HEAD of the last stop, which
            // always continues the start.
            if moved {
                return Err(refused(repo, GitFailureCause::BranchLeftSequence));
            }
        } else {
            let range = format!("{}..{head}", sequence.start);
            let dropped = count(cli, repo, &[&range]).await?;
            if dropped > 0 && count(cli, repo, &[&range, "--not", "--remotes"]).await? != dropped {
                return Err(refused(repo, GitFailureCause::CommitsPublished));
            }
        }
    } else if moved {
        return Err(refused(repo, GitFailureCause::BranchLeftSequence));
    }
    if expected_head != head.as_deref() {
        return Err(refused(repo, GitFailureCause::StateChanged));
    }
    Ok(moved.then(|| sequence.start.clone()))
}

/// Rewind the branch of a sequence whose HEAD moved to its `start`, then
/// drop the sequence and the stopped step. `reset --keep` refuses before it
/// changes anything when a file it changes has edits without a commit, and
/// keeps the others.
async fn rewind(cli: &GitCli, repo: &Path, command: &str, start: &str) -> Result<(), GitError> {
    let out = cli.exec(repo, &["reset", "-q", "--keep", start]).await?;
    if out.exit_code != 0 {
        tracing::warn!(
            "git reset --keep to the start of the sequence failed in {}: {}",
            repo.display(),
            out.stderr.trim()
        );
        return Err(abort_failed(repo, &out.stderr));
    }
    // After the rewind a failed quit leaves a sequence at its start, whose
    // retried abort only drops it.
    let out = cli.exec(repo, &[command, "--quit"]).await?;
    if out.exit_code != 0 {
        tracing::warn!(
            "git {command} --quit failed in {}: {}",
            repo.display(),
            out.stderr.trim()
        );
        return Err(abort_failed(repo, &out.stderr));
    }
    tracing::info!(
        "Rewound the {command} sequence whose HEAD moved in {}",
        repo.display()
    );
    Ok(())
}

fn refused(repo: &Path, cause: GitFailureCause) -> GitError {
    GitError::SyncFailed(GitFailure {
        repository: repository_name(repo),
        stage: GitStage::Abort,
        cause: Some(cause),
    })
}

fn abort_failed(repo: &Path, stderr: &str) -> GitError {
    GitError::SyncFailed(GitFailure::from_output(
        repo,
        GitStage::Abort,
        stderr,
        false,
    ))
}

#[cfg(test)]
#[path = "operation_stop_tests.rs"]
mod tests;

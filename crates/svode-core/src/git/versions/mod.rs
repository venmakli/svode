//! Smart versions (Stage 11 1.G): the changes of an explicit commit split
//! into groups — one reason, one commit — each with a message composed of
//! the facts Svode recognizes, in the author's interface language. Manual
//! commits (⌘S, ⇧⌘S, «Commit all») and later automatic versions share this
//! owner ([`auto`]); the author is always the person of the device, and no
//! agent, session or Routine is written into a message.

pub mod auto;
#[cfg(test)]
mod auto_tests;
mod changes;
mod facts;
mod group;
mod message;
#[cfg(test)]
mod tests;

use std::collections::BTreeSet;
use std::path::Path;

pub use changes::{ChangeStatus, PathChange};
pub use facts::{ChangeFact, General, GroupFacts, Place, PlacedFact, Sensitive};
pub use group::{GroupKind, PendingOperation, VersionGroup};
pub use message::{MessageLanguage, VersionMessage, compose};

use super::GitError;
use super::cli::{GitCli, literal_pathspec_input};
use super::diagnostics::{GitStage, HookTrace};
use super::{branch, ops, staging};
use changes::Sources;

/// A group with its facts and message.
#[derive(Debug, Clone)]
pub struct PlannedVersion {
    pub group: VersionGroup,
    pub facts: GroupFacts,
    pub message: VersionMessage,
}

/// What a grouped commit did: the commits it created and the pending
/// registrations it settled (all of whose groups landed or had nothing to
/// commit), as indices of the given operations.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CommitReport {
    pub commits: usize,
    pub settled: Vec<usize>,
}

/// A grouped commit that stopped at a group; the groups before it landed.
#[derive(Debug)]
pub struct CommitFailure {
    pub error: GitError,
    pub report: CommitReport,
}

/// The groups of the changes at `paths` as the index holds them now, with
/// their facts and messages.
pub async fn plan(
    cli: &GitCli,
    repo: &Path,
    paths: &[String],
    operations: &[PendingOperation],
    language: MessageLanguage,
) -> Result<Vec<PlannedVersion>, GitError> {
    let changes = changes::staged(cli, repo, paths).await?;
    let sources = Sources::read(cli, repo, &changes).await;
    Ok(group::group_changes(repo, changes, operations, &sources)
        .into_iter()
        .map(|group| {
            let facts = facts::facts_of(repo, &group, &sources);
            let message = compose(&facts, language);
            PlannedVersion {
                group,
                facts,
                message,
            }
        })
        .collect())
}

/// Commit `paths` (a scope Git expands) as one commit per group. The
/// staged versions of other paths stay staged.
pub async fn commit_grouped(
    cli: &GitCli,
    repo: &Path,
    paths: &[String],
    operations: &[PendingOperation],
    language: MessageLanguage,
) -> Result<CommitReport, CommitFailure> {
    let fail = |error, report| CommitFailure { error, report };
    let prepared = match prepare(cli, repo, paths).await {
        Ok(Some(prepared)) => prepared,
        Ok(None) => {
            return Ok(CommitReport {
                commits: 0,
                settled: (0..operations.len()).collect(),
            });
        }
        Err(error) => return Err(fail(error, CommitReport::default())),
    };
    let planned = plan(cli, repo, &prepared.paths, operations, language)
        .await
        .map_err(|error| fail(error, CommitReport::default()))?;
    let membership = operations
        .iter()
        .map(|operation| {
            planned
                .iter()
                .enumerate()
                .filter(|(_, version)| {
                    version.group.changes.iter().any(|change| {
                        change.paths().any(|own| {
                            operation
                                .paths
                                .iter()
                                .any(|path| group::at_or_under(own, path))
                        })
                    })
                })
                .map(|(index, _)| index)
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    let mut landed = Vec::new();
    let mut commits = 0;
    let report = |landed: &[usize], commits| CommitReport {
        commits,
        settled: membership
            .iter()
            .enumerate()
            .filter(|(_, groups)| groups.iter().all(|group| landed.contains(group)))
            .map(|(index, _)| index)
            .collect(),
    };
    for (index, version) in planned.iter().enumerate() {
        let group_paths = version.group.paths();
        match commit_prepared(
            cli,
            repo,
            &group_paths,
            &prepared.present,
            &version.message.text(),
        )
        .await
        {
            Ok(committed) => {
                commits += usize::from(committed);
                landed.push(index);
            }
            Err(error) => return Err(fail(error, report(&landed, commits))),
        }
    }
    Ok(report(&landed, commits))
}

/// Commit `paths` (a scope Git expands) as one version whose message
/// gathers the facts of all its groups.
pub async fn commit_single(
    cli: &GitCli,
    repo: &Path,
    paths: &[String],
    language: MessageLanguage,
) -> Result<bool, GitError> {
    let Some(prepared) = prepare(cli, repo, paths).await? else {
        return Ok(false);
    };
    let planned = plan(cli, repo, &prepared.paths, &[], language).await?;
    let message = compose(
        &merged(planned.iter().map(|version| &version.facts)),
        language,
    );
    commit_prepared(
        cli,
        repo,
        &prepared.paths,
        &prepared.present,
        &message.text(),
    )
    .await
}

/// The facts of several groups as one: each fact keeps its place.
fn merged<'a>(groups: impl Iterator<Item = &'a GroupFacts>) -> GroupFacts {
    let mut all = GroupFacts {
        place: Place::None,
        facts: Vec::new(),
        links: 0,
        general: General::Files,
        pages: 0,
        files: 0,
        sensitive: None,
    };
    let mut count = 0;
    for group in groups {
        count += 1;
        if count == 1 {
            all.place = group.place.clone();
            all.general = group.general;
            all.sensitive = group.sensitive;
        } else {
            all.general = General::Files;
            all.sensitive = match (all.sensitive, group.sensitive) {
                (None, None) => None,
                _ => Some(Sensitive::Entries(0)),
            };
        }
        all.facts.extend(group.facts.iter().cloned());
        all.links += group.links;
        all.pages += group.pages;
        all.files += group.files;
    }
    if let Some(Sensitive::Entries(_)) = all.sensitive {
        all.sensitive = Some(Sensitive::Entries(all.pages.max(1)));
    }
    all
}

struct Prepared {
    paths: Vec<String>,
    present: BTreeSet<String>,
}

/// Expand and stage the scope; `None` when nothing in it changed.
async fn prepare(
    cli: &GitCli,
    repo: &Path,
    paths: &[String],
) -> Result<Option<Prepared>, GitError> {
    if paths.is_empty() {
        return Ok(None);
    }
    branch::prepare_existing(cli, repo).await?;
    let paths = staging::resolve(cli, repo, paths).await?;
    if paths.is_empty() {
        return Ok(None);
    }
    if ops::full_status(cli, repo).await?.has_conflicts {
        return Err(GitError::Conflict(
            "Resolve the repository merge before saving paths".into(),
        ));
    }
    let present = staging::prepare(cli, repo, &paths).await?;
    if !staging::has_changes(cli, repo, &paths).await? {
        return Ok(None);
    }
    Ok(Some(Prepared { paths, present }))
}

/// Commit the prepared `paths` with `message`; `false` when none of them
/// differs from HEAD.
async fn commit_prepared(
    cli: &GitCli,
    repo: &Path,
    paths: &[String],
    present: &BTreeSet<String>,
    message: &str,
) -> Result<bool, GitError> {
    if !staging::has_changes(cli, repo, paths).await? {
        return Ok(false);
    }
    staging::verify(cli, repo, paths, present).await?;
    let mut presence = staging::Presence::new(repo);
    // Each version is its own commit with its own hooks: a refusal names
    // the hook and the stage of this commit.
    let trace = HookTrace::new();
    let out = if paths.iter().any(|path| presence.shadowed(path)) {
        staging::commit_prepared(cli, repo, paths, message, &trace).await?
    } else {
        staging::exec_input(
            cli,
            repo,
            &[
                "commit",
                "--only",
                "-m",
                message,
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ],
            &trace.env(&[]),
            &literal_pathspec_input(paths),
            GitStage::Commit,
            paths,
        )
        .await?
    };
    if out.exit_code != 0 {
        return Err(staging::command_failure(
            repo,
            GitStage::Commit,
            &out,
            Some(&trace),
            paths,
        ));
    }
    Ok(true)
}

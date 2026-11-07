//! Automatic versions of content edits (Stage 11 1.E). With content commits
//! on for a repository, its open groups (1.G) become versions as they close:
//! after a pause, when the user leaves a Page or the window, before a sync
//! and on quit. Desktop plans these moments; this owner decides which groups
//! closed and commits them. Which groups a closing takes follows the
//! effective policy ([`Lifecycle`], DF-322): with content commits, content
//! and system groups as one lifecycle; with only system commits, the system
//! groups by owner, each its own commit; structural groups never, they
//! follow the pointer rules. Versions wait while the repository is in a Git
//! operation, has files in conflict or a detached HEAD, while an agent turn
//! or a Routine run holds the repository ([`super::turns`]) and while
//! another writer holds its write guard. The pending creation commits of
//! the repository land before its versions, and until they land no version
//! and no system commit takes their paths or a path inside an Inline Space
//! they create ([`super::super::space_creation`]).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;

use super::super::GitError;
use super::super::host::GitHost;
use super::super::path::{RootMode, repo_relative_from_base};
use super::super::pending::PendingSave;
use super::super::state::GitRuntime;
use super::super::{access, branch, ops, policy, space_creation, staging, write_guard};
use super::changes::{ChangeStatus, PathChange, Sources};
use super::group::{self, GroupKind, PendingOperation, VersionGroup, at_or_under};
use super::{MessageLanguage, commit_grouped, commit_single};

/// Which open groups of a repository close now.
#[derive(Debug, Clone)]
pub struct Closing {
    /// Groups whose last change is at least this old close.
    pub pause: Duration,
    /// Content groups at or under these repository-relative paths close: the
    /// Page or Collection the user left.
    pub left: Vec<String>,
    /// Every open group closes: the window lost focus, a sync starts or the
    /// app quits.
    pub all: bool,
}

impl Closing {
    pub fn paused(pause: Duration) -> Self {
        Self {
            pause,
            left: Vec::new(),
            all: false,
        }
    }

    pub fn all(pause: Duration) -> Self {
        Self {
            all: true,
            ..Self::paused(pause)
        }
    }
}

/// Why automatic versions of a repository wait.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Held {
    /// A merge, rebase, cherry-pick or revert is unfinished.
    Operation,
    /// Files are in conflict with no operation.
    Conflicts,
    /// HEAD is detached.
    DetachedHead,
    /// An agent turn or a Routine run is in progress in the repository; its
    /// end makes the version of the turn.
    Turn,
    /// Another writer, such as a Space being created by another process,
    /// holds the write guard of the repository past the bounded wait; the
    /// next closing tries again.
    Writer,
}

/// What a closing did to a repository.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AutoVersions {
    /// Content and system commits are off for the repository.
    Off,
    /// The repository is in a state where versions wait; edits accumulate.
    Held(Held),
    /// The closed groups landed as `commits` versions; `next` is when the
    /// earliest group still open reaches the pause.
    Done {
        commits: usize,
        next: Option<Duration>,
    },
}

/// The repository a Space or a path of it belongs to, in the form the path
/// was given: the nearest directory with its own `.git`.
pub fn repository_of(path: &Path) -> Option<PathBuf> {
    path.ancestors()
        .find(|dir| dir.join(".git").symlink_metadata().is_ok())
        .map(Path::to_path_buf)
}

/// What the automatic commits of a repository take, by the effective
/// policy of the device (1.E «Виды коммитов и жизненный цикл», DF-322).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lifecycle {
    /// Content commits are on: a commit is one lifecycle, and versions take
    /// the content and system groups.
    Content,
    /// Content commits are off and system commits on: the system changes no
    /// Desktop operation committed land as their groups by owner, only their
    /// paths.
    System,
}

impl Lifecycle {
    /// Whether the automatic commits of this lifecycle take a group of
    /// `kind`. Structural groups stay with the pointer rules.
    fn takes(self, kind: GroupKind) -> bool {
        match self {
            Self::Content => kind != GroupKind::Structural,
            Self::System => kind == GroupKind::System,
        }
    }
}

/// The lifecycle of the automatic commits of `repo` (the root flags for an
/// Inline Space, its own for an Independent or Submodule Space: the flags of
/// the repository root); `None` with content and system commits off.
pub fn lifecycle(repo: &Path) -> Option<Lifecycle> {
    let policy = policy::effective_user_policy(repo);
    if policy.auto_commit_content {
        Some(Lifecycle::Content)
    } else if policy.auto_commit_system {
        Some(Lifecycle::System)
    } else {
        None
    }
}

/// Whether the device enabled automatic versions of content for `repo`.
pub fn enabled(repo: &Path) -> bool {
    lifecycle(repo) == Some(Lifecycle::Content)
}

/// Close the groups `closing` names in `repo` and commit them with messages
/// in `language`, as its [`Lifecycle`] takes them. A failed commit is
/// returned as is: the groups before it keep their commits, the rest stays
/// in the working copy and Svode tries again only at the next closing.
pub async fn close(
    runtime: &GitRuntime,
    host: &dyn GitHost,
    repo: &Path,
    closing: &Closing,
    language: MessageLanguage,
) -> Result<AutoVersions, GitError> {
    let Some(lifecycle) = lifecycle(repo) else {
        return Ok(AutoVersions::Off);
    };
    if super::turns::holds(repo) {
        return Ok(AutoVersions::Held(Held::Turn));
    }
    version(
        runtime,
        host,
        repo,
        language,
        lifecycle,
        Select::Closing(closing),
    )
    .await
}

/// Which changed paths of a repository become versions now, and in what
/// shape.
pub(super) enum Select<'a> {
    /// The groups a closing names, one version per group.
    Closing(&'a Closing),
    /// The paths a turn changed, as one version (1.E «Ходы агентов»).
    Turn(&'a (dyn Fn(&str) -> bool + Sync)),
}

/// Commit the paths `select` picks in `repo` from the groups `lifecycle`
/// takes; the shared body of a closing and of the version of a turn.
pub(super) async fn version(
    runtime: &GitRuntime,
    host: &dyn GitHost,
    repo: &Path,
    language: MessageLanguage,
    lifecycle: Lifecycle,
    select: Select<'_>,
) -> Result<AutoVersions, GitError> {
    let cli = runtime.require_cli()?;
    let lock = runtime.get_lock(repo).await;
    let guard = lock.lock().await;
    // A version never commits what another writer is still writing.
    let repository = access::local_repository_root(repo)?;
    let writes = match write_guard::acquire(&BTreeSet::from([repository]), &[]).await {
        Ok(writes) => writes,
        Err(GitError::SourceBusy { .. }) => return Ok(AutoVersions::Held(Held::Writer)),
        Err(error) => return Err(error),
    };
    if branch::operation_in_progress(&cli, repo).await?.is_some() {
        return Ok(AutoVersions::Held(Held::Operation));
    }
    let mut status = ops::full_status(&cli, repo).await?;
    if status.has_conflicts {
        return Ok(AutoVersions::Held(Held::Conflicts));
    }
    if status.branch == "(detached)" || status.branch == "HEAD" {
        return Ok(AutoVersions::Held(Held::DetachedHead));
    }
    // The creation commits come first; a refused one stops the closing and
    // the next closing repeats it first.
    if space_creation::commit_pending_locked(&cli, host, repo).await? > 0 {
        status = ops::full_status(&cli, repo).await?;
    }
    let creations = space_creation::pending(&cli, repo).await?;
    let created = |path: &str| creations.iter().any(|creation| creation.holds(path));

    let pending = runtime.pending();
    let mut peeked = pending
        .peek_under(repo)
        .into_iter()
        .filter(|registration| repository_of(&registration.space).as_deref() == Some(repo))
        .collect::<Vec<_>>();
    let mut operations = peeked
        .iter()
        .map(|registration| {
            PendingOperation::registered(
                repo,
                registration.change.as_ref(),
                registration.paths.as_slice(),
            )
        })
        .collect::<Vec<_>>();
    // A registered operation is content written by Desktop: system commits
    // alone leave every path of it for its manual commit.
    let registered = match lifecycle {
        Lifecycle::Content => Vec::new(),
        Lifecycle::System => {
            peeked.clear();
            std::mem::take(&mut operations)
                .into_iter()
                .flat_map(|operation| operation.paths)
                .collect()
        }
    };
    let changes = status
        .files
        .iter()
        .filter(|file| {
            file.state != "conflict"
                && !nested_repository(repo, &file.path)
                && !created(&file.path)
                && !registered.iter().any(|path| at_or_under(&file.path, path))
        })
        .map(|file| PathChange {
            status: match file.state.as_str() {
                "untracked" => ChangeStatus::Added,
                "deleted" => ChangeStatus::Deleted,
                _ => ChangeStatus::Modified,
            },
            path: file.path.clone(),
            from: None,
            gitlink: false,
        })
        .collect::<Vec<_>>();
    if changes.is_empty() {
        return Ok(AutoVersions::Done {
            commits: 0,
            next: None,
        });
    }
    let sources = Sources::read(&cli, repo, &changes).await;
    let groups = group::group_changes(repo, changes, &operations, &sources);
    let (due, next) = match &select {
        Select::Closing(closing) => due_paths(repo, &groups, lifecycle, closing, SystemTime::now()),
        Select::Turn(changed) => (turn_paths(&groups, lifecycle, changed), None),
    };
    if due.is_empty() {
        return Ok(AutoVersions::Done { commits: 0, next });
    }

    host.authorize_repository(repo).await?;
    let anchors = due.iter().map(|path| repo.join(path)).collect::<Vec<_>>();
    let mut spaces = Vec::<PathBuf>::new();
    for registration in &peeked {
        if !spaces.contains(&registration.space) {
            spaces.push(registration.space.clone());
        }
    }
    let mut taken = spaces
        .iter()
        .map(|space| pending.begin_save(space, Some(&anchors)))
        .collect::<Vec<_>>();
    let mut paths = due;
    let mut derived = Vec::new();
    for save in &taken {
        for path in save.paths() {
            if let Ok(path) = repo_relative_from_base(repo, &path, RootMode::Reject)
                && !paths.contains(&path)
                && !derived.contains(&path)
                && !created(&path)
            {
                derived.push(path);
            }
        }
    }
    paths.extend(staging::recorded(&cli, repo, derived).await?);
    let mut owners = Vec::new();
    let mut taken_operations = Vec::new();
    for (index, save) in taken.iter().enumerate() {
        for (local, (change, paths)) in save.registrations().enumerate() {
            owners.push((index, local));
            taken_operations.push(PendingOperation::registered(repo, change, paths));
        }
    }

    let (commits, failure) = match select {
        Select::Closing(_) => {
            match commit_grouped(&cli, repo, &paths, &taken_operations, language).await {
                Ok(report) => {
                    for save in &mut taken {
                        save.complete();
                    }
                    (report.commits, None)
                }
                Err(failure) => {
                    settle(&mut taken, &owners, &failure.report.settled);
                    (failure.report.commits, Some(failure.error))
                }
            }
        }
        // One version: its registrations land together or return to their
        // Spaces together.
        Select::Turn(_) => match commit_single(&cli, repo, &paths, language).await {
            Ok(committed) => {
                for save in &mut taken {
                    save.complete();
                }
                (usize::from(committed), None)
            }
            Err(error) => (0, Some(error)),
        },
    };
    drop(taken);
    drop(writes);
    drop(guard);
    if commits > 0 {
        super::super::autocommit::finish_content_version(runtime, host, &cli, repo).await;
    }
    match failure {
        Some(error) => Err(error),
        None => Ok(AutoVersions::Done { commits, next }),
    }
}

/// The repository-relative paths of the groups `lifecycle` takes that close
/// now, and when the earliest group left open reaches the pause. A system
/// group closes like changes of an unknown source (1.G): by the pause or
/// when every group closes, never by leaving a Page.
fn due_paths(
    repo: &Path,
    groups: &[VersionGroup],
    lifecycle: Lifecycle,
    closing: &Closing,
    now: SystemTime,
) -> (Vec<String>, Option<Duration>) {
    let mut due = Vec::new();
    let mut next: Option<Duration> = None;
    for group in groups.iter().filter(|group| lifecycle.takes(group.kind)) {
        let paths = group.paths();
        let idle = idle_for(repo, &paths, now);
        let left = group.kind.is_content()
            && closing.left.iter().any(|left| {
                at_or_under(&group.owner, left) || paths.iter().any(|path| at_or_under(path, left))
            });
        if closing.all || closes_at_once(group) || left || idle >= closing.pause {
            for path in paths {
                if !due.contains(&path) {
                    due.push(path);
                }
            }
        } else {
            let wait = closing.pause - idle;
            next = Some(next.map_or(wait, |next| next.min(wait)));
        }
    }
    (due, next)
}

/// The paths of the groups `lifecycle` takes that `changed` says the turn
/// changed.
fn turn_paths(
    groups: &[VersionGroup],
    lifecycle: Lifecycle,
    changed: &(dyn Fn(&str) -> bool + Sync),
) -> Vec<String> {
    let mut paths = Vec::new();
    for group in groups.iter().filter(|group| lifecycle.takes(group.kind)) {
        for path in group.paths() {
            if changed(&path) && !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
    paths
}

/// Groups that close right after their operation (1.G): an operation on a
/// committed object, and an imported attachment, a creation without a
/// content object. A created Page, record, folder or Collection closes like
/// an edit in the editor (DF-284).
fn closes_at_once(group: &VersionGroup) -> bool {
    group.kind == GroupKind::Operation
        || (group.kind == GroupKind::Creation
            && group
                .operation
                .as_ref()
                .is_none_or(|shape| shape.target.is_none()))
}

/// How long ago the last change of the paths was made, by their files on
/// disk; paths that no longer exist do not hold the group open.
fn idle_for(repo: &Path, paths: &[String], now: SystemTime) -> Duration {
    paths
        .iter()
        .filter_map(|path| std::fs::symlink_metadata(repo.join(path)).ok())
        .filter_map(|metadata| metadata.modified().ok())
        .map(|modified| now.duration_since(modified).unwrap_or_default())
        .min()
        .unwrap_or(Duration::MAX)
}

/// A changed path that is a repository of its own: a Space pointer, which
/// structural commits own.
pub(super) fn nested_repository(repo: &Path, path: &str) -> bool {
    repo.join(path).join(".git").symlink_metadata().is_ok()
}

/// Consume the registrations a failed commit settled; the others return to
/// their Spaces when the saves drop.
fn settle(taken: &mut [PendingSave], owners: &[(usize, usize)], settled: &[usize]) {
    for (index, save) in taken.iter_mut().enumerate() {
        let local = settled
            .iter()
            .filter_map(|settled| owners.get(*settled))
            .filter(|(owner, _)| *owner == index)
            .map(|(_, local)| *local)
            .collect::<Vec<_>>();
        save.settle(&local);
    }
}

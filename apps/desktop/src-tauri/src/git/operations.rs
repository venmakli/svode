use std::{
    collections::HashMap,
    future::Future,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, watch};

use super::{
    cli::GitCli,
    ops::GitStatus,
    publication_flow::{PublicationStatus, SyncReport},
};
use crate::AppError;

/// Preserve the original IPC error and kind while sharing a terminal outcome.
#[derive(Debug, Clone)]
pub struct SharedError(Arc<AppError>);

impl From<AppError> for SharedError {
    fn from(error: AppError) -> Self {
        Self(Arc::new(error))
    }
}
impl std::ops::Deref for SharedError {
    type Target = AppError;
    fn deref(&self) -> &AppError {
        &self.0
    }
}
impl std::fmt::Display for SharedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}
impl Serialize for SharedError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Intent {
    Sync {
        background: bool,
    },
    Push,
    Publish,
    Resolve,
    FetchStatus,
    InspectPublication,
    RetryParent {
        head: String,
        parent: PathBuf,
        target: String,
    },
}

impl Intent {
    pub(crate) fn reader(&self) -> bool {
        matches!(self, Self::FetchStatus | Self::InspectPublication)
    }

    fn covers(&self, other: &Self) -> bool {
        self == other
            || matches!(
                (self, other),
                (
                    Self::Sync { background: false },
                    Self::Sync { background: true }
                )
            )
    }

    pub(crate) fn background(&self) -> bool {
        matches!(self, Self::Sync { background: true })
    }

    pub(crate) fn admitted(&self, repo: &Path) -> bool {
        !self.background() || crate::space::config::effective_git_user_policy(repo).auto_sync
    }

    fn reserves_parent(&self) -> bool {
        matches!(
            self,
            Self::Sync { .. } | Self::Resolve | Self::RetryParent { .. }
        )
    }
}

#[derive(Debug, Clone)]
pub(crate) enum Output {
    Sync(SyncReport),
    Status(GitStatus),
    Parent(PublicationStatus),
    Inspection(super::readers::PublicationRead),
}

/// Local observations only; never a replacement for publication's remote proof.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Snapshot {
    pub(crate) target: String,
    pub(crate) transport: String,
    pub(crate) head: String,
    refs: String,
    branch: String,
    pseudo_refs: String,
    ordinary_sources: bool,
}

fn transport_hash(branch: &str, config: &str) -> Sha256 {
    let mut hash = Sha256::new();
    let branch_ref = branch.trim();
    let branch_name = branch_ref.strip_prefix("refs/heads/").unwrap_or_default();
    let remote_key = format!("branch.{branch_name}.remote");
    let merge_key = format!("branch.{branch_name}.merge");
    let entries = config
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .collect::<Vec<_>>();
    let default_tracking = !branch_name.is_empty()
        && entries.iter().all(|entry| {
            let (key, value) = entry.split_once('\n').unwrap_or((entry, ""));
            (key != remote_key || value == "origin") && (key != merge_key || value == branch_ref)
        });
    // First publish installs origin/current-branch tracking. That does not
    // change the target already selected by the no-upstream sync intent.
    for entry in entries {
        let key = entry.split_once('\n').map(|(key, _)| key).unwrap_or(entry);
        if default_tracking && (key == remote_key || key == merge_key) {
            continue;
        }
        hash.update(entry.as_bytes());
        hash.update([0]);
    }
    if default_tracking {
        hash.update(b"svode-origin-current-tracking\0");
    }
    hash.update(branch.as_bytes());
    hash
}

pub(crate) async fn read_transport(cli: &GitCli, repo: &Path) -> Result<String, AppError> {
    let (branch, config) = tokio::join!(
        cli.exec(repo, &["symbolic-ref", "-q", "HEAD"]),
        cli.exec_redacted(repo, &["config", "--null", "--list"]),
    );
    let (branch, config) = (branch?, config?);
    if config.exit_code != 0 || branch.exit_code > 1 {
        return Err(target_changed(repo));
    }
    Ok(format!(
        "{:x}",
        transport_hash(&branch.stdout, &config.stdout).finalize()
    ))
}

impl Snapshot {
    pub(crate) async fn read(cli: &GitCli, repo: &Path) -> Result<Self, AppError> {
        let (branch, config, refs, git_dir, index) = tokio::join!(
            cli.exec(repo, &["symbolic-ref", "-q", "HEAD"]),
            cli.exec_redacted(repo, &["config", "--null", "--list"]),
            cli.exec(repo, &["show-ref", "--head"]),
            cli.exec(repo, &["rev-parse", "--absolute-git-dir"]),
            cli.exec(repo, &["ls-files", "--stage", "-z"]),
        );
        let (branch, config, refs, git_dir, index) = (branch?, config?, refs?, git_dir?, index?);
        if config.exit_code != 0 || branch.exit_code > 1 {
            return Err(target_changed(repo));
        }
        let mut hash = transport_hash(&branch.stdout, &config.stdout);
        let transport = format!("{:x}", hash.clone().finalize());
        match std::fs::read(repo.join(".gitmodules")) {
            Ok(bytes) => hash.update(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        if refs.exit_code > 1 {
            return Err(target_changed(repo));
        }
        let head = refs
            .stdout
            .lines()
            .find_map(|line| line.strip_suffix(" HEAD"))
            .unwrap_or_default()
            .to_owned();
        if git_dir.exit_code != 0 {
            return Err(target_changed(repo));
        }
        // A custom source expression (including a pseudo-ref or legacy remote
        // definition) is shared only against the exact admitted observation.
        let no_legacy_definitions = ["remotes", "branches"].iter().all(|name| {
            match std::fs::read_dir(Path::new(git_dir.stdout.trim()).join(name)) {
                Ok(mut entries) => entries.next().is_none(),
                Err(error) => error.kind() == std::io::ErrorKind::NotFound,
            }
        });
        let ordinary_sources = no_legacy_definitions
            && config.stdout.split('\0').all(|entry| {
                let (key, value) = entry.split_once('\n').unwrap_or((entry, ""));
                !(key.starts_with("remote.")
                    && (key.ends_with(".push") || key.ends_with(".mirror")))
                    && (key != "push.default" || matches!(value, "simple" | "current" | "upstream"))
            });
        let mut pseudo = Sha256::new();
        for name in [
            "ORIG_HEAD",
            "FETCH_HEAD",
            "MERGE_HEAD",
            "CHERRY_PICK_HEAD",
            "REBASE_HEAD",
        ] {
            match std::fs::read(Path::new(git_dir.stdout.trim()).join(name)) {
                Ok(bytes) => {
                    pseudo.update(name);
                    pseudo.update(bytes);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        // Cached stat data and index extensions can change during a reader's
        // git status; only the actual staged entries are part of generation.
        if index.exit_code != 0 {
            return Err(target_changed(repo));
        }
        pseudo.update(index.stdout.as_bytes());
        Ok(Self {
            target: format!("{:x}", hash.finalize()),
            transport,
            head,
            refs: refs.stdout,
            branch: branch.stdout.trim().into(),
            pseudo_refs: format!("{:x}", pseudo.finalize()),
            ordinary_sources,
        })
    }

    pub(crate) fn same_remote_observation(&self, observed: &Self) -> bool {
        let refs = |snapshot: &Self| {
            snapshot
                .refs
                .lines()
                .filter(|line| {
                    let name = line.split_once(' ').map(|(_, name)| name).unwrap_or("");
                    name != "HEAD" && name != snapshot.branch
                })
                .map(str::to_owned)
                .collect::<Vec<_>>()
        };
        self.target == observed.target
            && self.branch == observed.branch
            && refs(self) == refs(observed)
    }

    // Only the current branch and remote tracking refs may have changed in our
    // own successful pull/push. Other sources require another admitted pass.
    pub(crate) fn publication_covers(&self, before: &Self, published: &str) -> bool {
        let other_refs = |s: &Self| {
            s.refs
                .lines()
                .filter(|line| {
                    let name = line.split_once(' ').map(|(_, name)| name).unwrap_or("");
                    name != "HEAD" && name != s.branch && !name.starts_with("refs/remotes/")
                })
                .map(str::to_owned)
                .collect::<Vec<_>>()
        };
        self.ordinary_sources
            && before.ordinary_sources
            && self.head == published
            && self.target == before.target
            && other_refs(self) == other_refs(before)
    }
}

pub(crate) fn target_changed(repo: &Path) -> AppError {
    AppError::GitPublicationBlocked {
        repository: repo.to_string_lossy().into_owned(),
        child: None,
        reason: super::publication::PublicationBlockReason::TargetChanged,
    }
}

#[derive(Clone)]
pub(crate) struct Request {
    pub(crate) repo: PathBuf,
    pub(crate) intent: Intent,
    pub(crate) snapshot: Snapshot,
    pub(crate) parent: Option<(PathBuf, Option<Snapshot>)>,
    pub(crate) previous: Option<Completion>,
}

#[derive(Clone)]
pub(crate) struct ParentEvidence {
    pub(crate) repo: PathBuf,
    pub(crate) before: Snapshot,
    pub(crate) after: Snapshot,
    pub(crate) result: super::sync::SyncResult,
    pub(crate) background: bool,
    pub(crate) remote_status: Option<GitStatus>,
}

#[derive(Clone)]
pub(crate) struct Completion {
    pub(crate) result: Result<Output, SharedError>,
    pub(crate) before: Snapshot,
    pub(crate) after: Snapshot,
    pub(crate) parent: Option<ParentEvidence>,
    pub(crate) read_sync: Option<SyncReport>,
}

impl Completion {
    pub(crate) fn sync_report(&self) -> Option<&SyncReport> {
        match &self.result {
            Ok(Output::Sync(report)) => Some(report),
            _ => self.read_sync.as_ref(),
        }
    }
}

struct Flight {
    request: Request,
    result: watch::Sender<Option<Completion>>,
}

impl Flight {
    async fn wait(&self) -> Result<Completion, SharedError> {
        let mut receiver = self.result.subscribe();
        loop {
            if let Some(result) = receiver.borrow_and_update().clone() {
                return Ok(result);
            }
            receiver
                .changed()
                .await
                .map_err(|_| AppError::General("Git operation stopped".into()))?;
        }
    }
}

#[derive(Default)]
pub(crate) struct Operations {
    flights: Mutex<HashMap<PathBuf, Arc<Flight>>>,
}

impl Operations {
    #[cfg(test)]
    pub(crate) async fn wait_for_parent_reader(&self, parent: &Path) {
        let parent = std::fs::canonicalize(parent).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                if self.flights.lock().await.values().any(|f| {
                    f.request
                        .parent
                        .as_ref()
                        .is_some_and(|(root, _)| root == &parent)
                        && f.result.receiver_count() >= 2
                }) {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("parent waiter did not register");
    }

    #[cfg(test)]
    pub(crate) async fn wait_for_readers(&self, repo: &Path, count: usize) {
        let repo = std::fs::canonicalize(repo).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                if self
                    .flights
                    .lock()
                    .await
                    .get(&repo)
                    .is_some_and(|f| f.result.receiver_count() >= count)
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("operation waiters did not register");
    }

    /// The executing task outlives any one IPC caller. Completed flights are
    /// removed; only callers already waiting on them retain their evidence.
    pub(crate) async fn run<F, Fut>(
        self: &Arc<Self>,
        cli: GitCli,
        path: &Path,
        intent: Intent,
        execute: F,
    ) -> Result<Output, SharedError>
    where
        F: FnOnce(Request) -> Fut + Send + 'static,
        Fut: Future<Output = Completion> + Send + 'static,
    {
        let repo = super::access::resolve_repository(&cli, path).await?;
        // Admission is ordered before local observations so a later root
        // request sees the child reservation even before its Git lock is free.
        let mut flights = self.flights.lock().await;
        let original = Snapshot::read(&cli, &repo).await?;
        let parent = if intent.reserves_parent() {
            match super::branch::parent(&cli, &repo).await? {
                Some(parent) => Some((parent.clone(), Snapshot::read(&cli, &parent).await.ok())),
                None => None,
            }
        } else {
            None
        };
        let mut snapshot = original.clone();
        let mut previous = None;
        loop {
            let mut waiting = if let Some(flight) = flights.get(&repo) {
                vec![flight.clone()]
            } else {
                flights
                    .values()
                    .filter(|flight| {
                        flight
                            .request
                            .parent
                            .as_ref()
                            .is_some_and(|(root, _)| root == &repo)
                    })
                    .cloned()
                    .collect::<Vec<_>>()
            };
            if waiting.is_empty() {
                let request = Request {
                    repo: repo.clone(),
                    intent,
                    snapshot,
                    parent,
                    previous,
                };
                let (sender, _) = watch::channel(None);
                let flight = Arc::new(Flight {
                    request: request.clone(),
                    result: sender,
                });
                flights.insert(repo.clone(), flight.clone());
                drop(flights);
                let owner = self.clone();
                let worker = flight.clone();
                tokio::spawn(async move {
                    let fallback = request.snapshot.clone();
                    let result = match tokio::spawn(execute(request)).await {
                        Ok(result) => result,
                        Err(_) => Completion {
                            result: Err(AppError::General("Git operation stopped".into()).into()),
                            before: fallback.clone(),
                            after: fallback,
                            parent: None,
                            read_sync: None,
                        },
                    };
                    let mut flights = owner.flights.lock().await;
                    worker.result.send_replace(Some(result));
                    flights.remove(&repo);
                });
                return flight.wait().await?.result;
            }
            drop(flights);
            let mut completed = Vec::new();
            loop {
                for flight in &waiting[completed.len()..] {
                    completed.push(flight.wait().await?);
                }
                if waiting[0].request.repo == repo {
                    break;
                }
                let flights = self.flights.lock().await;
                let additional = flights
                    .values()
                    .filter(|flight| {
                        flight
                            .request
                            .parent
                            .as_ref()
                            .is_some_and(|(parent, _)| parent == &repo)
                            && !waiting.iter().any(|known| Arc::ptr_eq(known, flight))
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                if additional.is_empty() {
                    break;
                }
                waiting.extend(additional);
            }
            let current = Snapshot::read(&cli, &repo).await?;
            if waiting[0].request.repo == repo {
                let flight = &waiting[0];
                let done = &completed[0];
                let inspection_current = match &done.result {
                    Ok(Output::Inspection(read)) if intent == Intent::InspectPublication => {
                        read.is_current(&cli).await?
                    }
                    _ => true,
                };
                if inspection_current
                    && flight.request.intent.covers(&intent)
                    && current == done.after
                    && (snapshot == done.before
                        || snapshot == flight.request.snapshot
                        || (snapshot == done.after
                            && matches!(&done.result,
                            Ok(Output::Sync(SyncReport { child: super::sync::SyncResult::Success { published_head }, .. }))
                                if done.after.publication_covers(&done.before, published_head))))
                {
                    return done.result.clone();
                }
                if intent.reader()
                    && (current == done.after
                        || (intent == Intent::FetchStatus
                            && current.same_remote_observation(&done.after)))
                {
                    previous = Some(done.clone());
                }
            } else if matches!(intent, Intent::Sync { .. }) || intent.reader() {
                let evidence = completed
                    .iter()
                    .map(|done| done.parent.as_ref())
                    .collect::<Option<Vec<_>>>();
                if let Some(evidence) = evidence {
                    let permitted = evidence.iter().all(|e| {
                        e.repo == repo
                            && (!e.background || intent.background() || intent.reader())
                            && e.before.target == original.target
                            && matches!(e.result, super::sync::SyncResult::Success { .. })
                    });
                    let covers_start = evidence.iter().any(|e| e.before == snapshot);
                    if permitted && covers_start {
                        if let Some(last) = evidence.iter().find(|e| e.after == current) {
                            if let super::sync::SyncResult::Success { published_head } =
                                &last.result
                            {
                                if current.publication_covers(&last.before, published_head) {
                                    let report = SyncReport {
                                        child: last.result.clone(),
                                        parent: None,
                                        remote_status: last.remote_status.clone(),
                                    };
                                    if !intent.reader() {
                                        return Ok(Output::Sync(report));
                                    }
                                    previous = Some(Completion {
                                        result: Ok(Output::Sync(report)),
                                        before: last.before.clone(),
                                        after: last.after.clone(),
                                        parent: None,
                                        read_sync: None,
                                    });
                                }
                            }
                        }
                    }
                }
            }
            if current.target != original.target {
                return Err(target_changed(&repo).into());
            }
            // New generations coalesce at the next admission. An incompatible
            // explicit intent keeps its authority without upgrading the old task.
            snapshot = current;
            flights = self.flights.lock().await;
        }
    }
}

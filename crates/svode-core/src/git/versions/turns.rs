//! Agent turns and Routine runs in a repository (Stage 11 1.E «Ходы
//! агентов», «Рутины»). With content commits on, the open groups of a
//! repository close before the first turn; while at least one turn runs,
//! the repository makes no content versions and no integration step that
//! changes its working copy; after the last turn the content paths the
//! turns changed land as one version. Paths the Svode editor wrote meanwhile
//! and no turn touched keep their own groups.
//!
//! Turn boundaries are runtime state of this process: a host (Desktop)
//! binds the signals of the agent runtime, the known status of terminal
//! sessions and Routine runs to a repository and reports them here by a
//! key of its own. Nothing about a turn is stored, and no agent, session or
//! Routine is written into a version.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use super::super::GitError;
use super::super::host::GitHost;
use super::super::ops;
use super::super::state::GitRuntime;
use super::MessageLanguage;
use super::auto::{self, AutoVersions, Closing, Select};

/// Whether Svode wraps a turn in a version.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnWrap {
    /// An ordinary turn or a Routine run: the groups close before it and
    /// its changes become the version of the turn.
    Version,
    /// A turn sent with the request «Зафиксировать с агентом» (or another
    /// request that leaves the commits to the agent): nothing is committed
    /// before it and no version of it is made; what the agent leaves
    /// uncommitted returns to the ordinary groups.
    AgentCommits,
}

/// What the start of a turn did.
#[derive(Debug)]
pub enum TurnBegin {
    /// Content commits are off for the repository: the turn is not tracked.
    Off,
    /// The first turn of the repository: the groups before it closed with
    /// `closed` (`None` for a turn that leaves commits to the agent). A
    /// refused commit does not stop the turn: its edits stay in the working
    /// copy and the refusal is the host's commit stop.
    First {
        closed: Option<Result<AutoVersions, GitError>>,
    },
    /// Another turn already runs in the repository; nothing closed.
    Joined,
}

/// What the end of a turn did.
#[derive(Debug)]
pub enum TurnEnd {
    /// No turn has this key.
    Unknown,
    /// Other turns still run in `repository`.
    Continuing { repository: PathBuf },
    /// The last turn of `repository` ended. `version` is the number of
    /// versions of the turn (0 or 1) or the refused commit, whose edits stay
    /// in the working copy; `deferred` says that a sync left its integration
    /// for after the turn.
    Ended {
        repository: PathBuf,
        version: Result<usize, GitError>,
        deferred: bool,
    },
}

/// A file as the turn bookkeeping sees it: its size and modification time,
/// `None` when it does not exist.
type Stamp = Option<(u64, SystemTime)>;

/// The turns of one repository from the start of the first until the end
/// of the last.
struct Period {
    /// Running turns by host key, with whether each is wrapped in a version.
    active: HashMap<String, TurnWrap>,
    /// At least one turn of the period is wrapped in a version.
    wraps: bool,
    /// Repository-relative paths changed when the period started.
    baseline: HashMap<String, Stamp>,
    /// Paths the Svode editor wrote during the period, as it left them.
    editor: HashMap<String, Stamp>,
    /// A sync left its integration for after the period.
    deferred: bool,
}

impl Period {
    fn join(&mut self, key: &str, wrap: TurnWrap) {
        self.active.insert(key.to_owned(), wrap);
        self.wraps |= wrap == TurnWrap::Version;
    }

    /// Whether the turns of the period changed `path`: changed since the
    /// period started and not left as the editor wrote it.
    fn changed(&self, repo: &Path, path: &str) -> bool {
        let now = stamp(&repo.join(path));
        let since_start = self.baseline.get(path).is_none_or(|start| *start != now);
        let editor_only = self.editor.get(path).is_some_and(|wrote| *wrote == now);
        since_start && !editor_only
    }
}

/// The turns of this process by canonical repository root.
#[derive(Default)]
struct Turns {
    periods: Mutex<HashMap<PathBuf, Period>>,
}

fn turns() -> &'static Turns {
    static TURNS: OnceLock<Turns> = OnceLock::new();
    TURNS.get_or_init(Turns::default)
}

fn periods() -> std::sync::MutexGuard<'static, HashMap<PathBuf, Period>> {
    turns()
        .periods
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

fn canonical(repo: &Path) -> PathBuf {
    std::fs::canonicalize(repo).unwrap_or_else(|_| repo.to_path_buf())
}

fn stamp(path: &Path) -> Stamp {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    Some((metadata.len(), metadata.modified().ok()?))
}

/// Whether a turn runs in `repo` now: content versions and integration
/// steps that change its working copy wait.
pub fn holds(repo: &Path) -> bool {
    periods().contains_key(&canonical(repo))
}

/// A sync reached its integration step while a turn runs in `repo`: the
/// step does not run and the period remembers to sync after it. `false`
/// when no turn runs.
pub(crate) fn defer_integration(repo: &Path) -> bool {
    match periods().get_mut(&canonical(repo)) {
        Some(period) => {
            period.deferred = true;
            true
        }
        None => false,
    }
}

/// The turn `key` of a session or a Routine run starts in `repo`. The first
/// turn wrapped in a version closes the open groups of the repository
/// first; a turn that leaves commits to the agent closes nothing. Without
/// content commits the turn is not tracked.
pub async fn begin(
    runtime: &GitRuntime,
    host: &dyn GitHost,
    repo: &Path,
    key: &str,
    wrap: TurnWrap,
    language: MessageLanguage,
) -> TurnBegin {
    if !auto::enabled(repo) {
        return TurnBegin::Off;
    }
    let canonical = canonical(repo);
    if let Some(period) = periods().get_mut(&canonical) {
        period.join(key, wrap);
        return TurnBegin::Joined;
    }
    let closed = match wrap {
        TurnWrap::Version => Some(
            auto::version(
                runtime,
                host,
                repo,
                language,
                Select::Closing(&Closing::all(std::time::Duration::ZERO)),
            )
            .await,
        ),
        TurnWrap::AgentCommits => None,
    };
    let baseline = match baseline(runtime, repo).await {
        Ok(baseline) => baseline,
        Err(error) => {
            // Without it every changed path counts as the turn's.
            tracing::warn!(
                kind = error.kind(),
                "changed paths before a turn unavailable"
            );
            HashMap::new()
        }
    };
    periods()
        .entry(canonical)
        // A turn that started meanwhile opened the period.
        .or_insert_with(|| Period {
            active: HashMap::new(),
            wraps: false,
            baseline,
            editor: HashMap::new(),
            deferred: false,
        })
        .join(key, wrap);
    TurnBegin::First { closed }
}

/// The changed paths of `repo` as they are when the period starts.
async fn baseline(runtime: &GitRuntime, repo: &Path) -> Result<HashMap<String, Stamp>, GitError> {
    let cli = runtime.require_cli()?;
    let status = ops::full_status(&cli, repo).await?;
    Ok(status
        .files
        .iter()
        .map(|file| (file.path.clone(), stamp(&repo.join(&file.path))))
        .collect())
}

/// The Svode editor wrote `paths` (absolute): those of a repository with a
/// running turn keep their own groups unless the turn changes them again.
pub fn editor_wrote(paths: &[PathBuf]) {
    let mut periods = periods();
    if periods.is_empty() {
        return;
    }
    for path in paths {
        let Some(repo) = auto::repository_of(path) else {
            continue;
        };
        let repo = canonical(&repo);
        let Some(period) = periods.get_mut(&repo) else {
            continue;
        };
        let absolute = canonical(path);
        if let Ok(relative) = absolute.strip_prefix(&repo) {
            let relative = relative.to_string_lossy().replace('\\', "/");
            period.editor.insert(relative, stamp(&absolute));
        }
    }
}

/// The turn `key` ended: answered, cancelled, failed, its session ended or
/// its process was lost. After the last turn of a repository wrapped in a
/// version, the content paths the turns changed land as one version with a
/// message of the 1.G templates.
pub async fn end(
    runtime: &GitRuntime,
    host: &dyn GitHost,
    key: &str,
    language: MessageLanguage,
) -> TurnEnd {
    let (repository, period) = {
        let mut periods = periods();
        let Some(repository) = periods
            .iter_mut()
            .find_map(|(repo, period)| period.active.remove(key).map(|_| repo.clone()))
        else {
            return TurnEnd::Unknown;
        };
        if periods
            .get(&repository)
            .is_some_and(|period| !period.active.is_empty())
        {
            return TurnEnd::Continuing { repository };
        }
        let period = periods.remove(&repository).expect("period of the turn");
        (repository, period)
    };
    let version = if period.wraps && auto::enabled(&repository) {
        let changed = |path: &str| period.changed(&repository, path);
        auto::version(runtime, host, &repository, language, Select::Turn(&changed))
            .await
            .map(|versions| match versions {
                AutoVersions::Done { commits, .. } => commits,
                AutoVersions::Off | AutoVersions::Held(_) => 0,
            })
    } else {
        Ok(0)
    };
    TurnEnd::Ended {
        repository,
        version,
        deferred: period.deferred,
    }
}

/// The keys of the turns running now, for a host that reconciles its own
/// view of them.
pub fn running() -> BTreeSet<String> {
    periods()
        .values()
        .flat_map(|period| period.active.keys().cloned())
        .collect()
}

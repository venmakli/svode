//! Rhythm of background sync (Stage 11 1.E): which repository runs a
//! background sync or the fetch for the counters, and when.
//!
//! Actions start sync: a landed commit publishes, opening a Space, starting
//! the app and focusing the window check incoming. A timer is only the
//! safety check while the window stays visible and idle. Background network
//! of one repository runs at most once per [`MIN_GAP`]; commits in a row go
//! out as one push; a network error is retried after a growing pause.
//!
//! Pure planning with the clock passed in: the host owns the timers, the
//! window visibility and running the work; the explicit sync of the user is
//! not planned here and only resets the rhythm.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Background network calls of one repository are at least this far apart.
pub const MIN_GAP: Duration = Duration::from_secs(30);
/// The safety check after the last check, while checks find incoming.
pub const IDLE_FIRST: Duration = Duration::from_secs(5 * 60);
/// Each further check in a row without incoming lengthens the interval by
/// this much.
pub const IDLE_STEP: Duration = Duration::from_secs(5 * 60);
pub const IDLE_MAX: Duration = Duration::from_secs(15 * 60);
/// The pause before the first retry after a network error; it doubles.
pub const RETRY_FIRST: Duration = Duration::from_secs(30);
pub const RETRY_MAX: Duration = Duration::from_secs(15 * 60);
/// Commits that land this close together go out as one push.
pub const COALESCE: Duration = Duration::from_secs(2);

/// An action that starts sync of a repository.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    /// A commit landed, automatic or manual: publish it.
    Committed,
    /// A Space of the repository was opened, including at app start.
    Opened,
    /// The window showing the repository got focus.
    Focused,
}

/// Work the host runs now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Work {
    /// A background sync, with sync on.
    Sync,
    /// The fetch for the counters, with sync off.
    Fetch,
}

/// A timer the host arms; a newer one replaces it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Wake {
    pub at: Instant,
    pub generation: u64,
}

/// What the host does after a step of the rhythm.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Run(Work),
    Arm(Wake),
    Nothing,
}

/// How a background sync ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Sync finished or stopped; `incoming` when the remote had new commits.
    Checked { incoming: bool },
    /// The remote could not be reached.
    NetworkError,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reason {
    Publish,
    Retry,
    Idle,
}

#[derive(Debug)]
struct Cadence {
    last_network: Option<Instant>,
    idle: Duration,
    /// The last check found no incoming.
    quiet: bool,
    pause: Option<Duration>,
    blocked_until: Option<Instant>,
    running: bool,
    publish: bool,
    visible: bool,
    wake: Option<(Instant, u64, Reason)>,
    generation: u64,
}

impl Default for Cadence {
    fn default() -> Self {
        Self {
            last_network: None,
            idle: IDLE_FIRST,
            quiet: false,
            pause: None,
            blocked_until: None,
            running: false,
            publish: false,
            visible: false,
            wake: None,
            generation: 0,
        }
    }
}

impl Cadence {
    /// The earliest moment background network may run again.
    fn allowed(&self) -> Option<Instant> {
        let gap = self.last_network.map(|at| at + MIN_GAP);
        match (gap, self.blocked_until) {
            (Some(gap), Some(blocked)) => Some(gap.max(blocked)),
            (gap, blocked) => gap.or(blocked),
        }
    }

    fn may_run(&self, now: Instant) -> bool {
        self.allowed().is_none_or(|at| at <= now)
    }

    fn arm(&mut self, at: Instant, reason: Reason) -> Step {
        if let Some((current, generation, current_reason)) = self.wake
            && current <= at
        {
            // An earlier timer runs the same sync; publication is not
            // dropped by an idle one, as `fire` publishes regardless.
            if current_reason == Reason::Idle && reason != Reason::Idle {
                self.wake = Some((current, generation, reason));
            }
            return Step::Nothing;
        }
        self.generation += 1;
        self.wake = Some((at, self.generation, reason));
        Step::Arm(Wake {
            at,
            generation: self.generation,
        })
    }

    fn start(&mut self, now: Instant) -> Step {
        self.wake = None;
        self.running = true;
        self.publish = false;
        self.last_network = Some(now);
        Step::Run(Work::Sync)
    }

    /// The timer after a finished check: a waiting publication, else the
    /// safety check of a visible window.
    fn next(&mut self, now: Instant) -> Step {
        if self.running {
            return Step::Nothing;
        }
        if self.publish {
            let at = (now + COALESCE).max(self.allowed().unwrap_or(now));
            return self.arm(at, Reason::Publish);
        }
        if self.visible {
            let at = self.last_network.unwrap_or(now) + self.idle;
            return self.arm(at.max(self.allowed().unwrap_or(at)), Reason::Idle);
        }
        Step::Nothing
    }

    fn check(&mut self, now: Instant) -> Step {
        if self.running || !self.may_run(now) {
            // The running sync checks; a recent check or a retry pause
            // keeps its own timer.
            return self.next(now);
        }
        self.start(now)
    }
}

/// The rhythm of every repository the host syncs.
#[derive(Debug, Default)]
pub struct Rhythm {
    repositories: HashMap<PathBuf, Cadence>,
}

impl Rhythm {
    fn cadence(&mut self, repo: &Path) -> &mut Cadence {
        self.repositories.entry(repo.to_path_buf()).or_default()
    }

    /// An action of the repository; `auto` is its sync toggle now.
    pub fn trigger(&mut self, repo: &Path, trigger: Trigger, auto: bool, now: Instant) -> Step {
        let cadence = self.cadence(repo);
        if trigger != Trigger::Committed {
            cadence.visible = true;
        }
        if trigger == Trigger::Focused {
            cadence.pause = None;
            cadence.blocked_until = None;
        }
        if !auto {
            cadence.publish = false;
            cadence.wake = None;
            // Without sync only focus fetches, for the counters.
            if trigger == Trigger::Focused && cadence.may_run(now) {
                cadence.last_network = Some(now);
                return Step::Run(Work::Fetch);
            }
            return Step::Nothing;
        }
        match trigger {
            Trigger::Committed => {
                cadence.publish = true;
                cadence.next(now)
            }
            Trigger::Opened | Trigger::Focused => cadence.check(now),
        }
    }

    /// The timer of `generation` fired. `visible` says whether a window
    /// shows the repository now; the safety check needs one.
    pub fn fire(
        &mut self,
        repo: &Path,
        generation: u64,
        visible: bool,
        auto: bool,
        now: Instant,
    ) -> Step {
        let cadence = self.cadence(repo);
        let Some((_, current, reason)) = cadence.wake else {
            return Step::Nothing;
        };
        if current != generation {
            return Step::Nothing;
        }
        cadence.wake = None;
        cadence.visible = visible;
        if !auto {
            cadence.publish = false;
            return Step::Nothing;
        }
        if cadence.running {
            return Step::Nothing;
        }
        if reason == Reason::Idle && !cadence.publish && !visible {
            // Hidden or minimized: focus brings the next check.
            return Step::Nothing;
        }
        if !cadence.may_run(now) {
            let at = cadence.allowed().unwrap_or(now);
            return cadence.arm(at, reason);
        }
        cadence.start(now)
    }

    /// The background sync of the repository ended.
    pub fn finished(&mut self, repo: &Path, outcome: Outcome, now: Instant) -> Step {
        let cadence = self.cadence(repo);
        cadence.running = false;
        match outcome {
            Outcome::NetworkError => {
                let pause = cadence
                    .pause
                    .map_or(RETRY_FIRST, |pause| (pause * 2).min(RETRY_MAX));
                cadence.pause = Some(pause);
                cadence.blocked_until = Some(now + pause);
                cadence.arm(now + pause, Reason::Retry)
            }
            Outcome::Checked { incoming } => {
                cadence.pause = None;
                cadence.blocked_until = None;
                cadence.idle = if incoming {
                    IDLE_FIRST
                } else if cadence.quiet {
                    (cadence.idle + IDLE_STEP).min(IDLE_MAX)
                } else {
                    cadence.idle
                };
                cadence.quiet = !incoming;
                cadence.next(now)
            }
        }
    }

    /// The user synced the repository: the pause after an error and the
    /// safety interval start over. The explicit sync itself is never held.
    pub fn explicit(&mut self, repo: &Path, auto: bool, now: Instant) -> Step {
        let cadence = self.cadence(repo);
        cadence.pause = None;
        cadence.blocked_until = None;
        cadence.idle = IDLE_FIRST;
        cadence.quiet = false;
        cadence.last_network = Some(now);
        cadence.visible = true;
        if !auto {
            cadence.wake = None;
            return Step::Nothing;
        }
        cadence.next(now)
    }
}

/// The revision the upstream tracking ref of `repo` holds, read locally. A
/// background sync that moved it found incoming commits.
pub async fn upstream_revision(cli: &super::cli::GitCli, repo: &Path) -> Option<String> {
    let out = cli
        .exec(repo, &["rev-parse", "--verify", "-q", "@{upstream}"])
        .await
        .ok()?;
    let revision = out.stdout.trim();
    (out.exit_code == 0 && !revision.is_empty()).then(|| revision.to_owned())
}

/// The outcome of a background sync for the rhythm: only an unreachable
/// remote is retried; every other result or stop is a finished check.
pub fn outcome(
    result: &Result<super::flow::SyncReport, super::operations::SharedError>,
    before: Option<&str>,
    after: Option<&str>,
) -> Outcome {
    let network = result.as_ref().err().is_some_and(|error| {
        error.failure().and_then(|failure| failure.cause)
            == Some(super::diagnostics::GitFailureCause::Network)
    });
    if network {
        Outcome::NetworkError
    } else {
        Outcome::Checked {
            incoming: after.is_some() && after != before,
        }
    }
}

#[cfg(test)]
#[path = "rhythm_tests.rs"]
mod tests;

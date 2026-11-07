//! Desktop moments of automatic content versions and background system
//! commits (Stage 11 1.E): the pause timer of each repository, leaving a
//! Page or the window, a sync and quit, where content or system commits are
//! on. Which groups closed and their commits belong to
//! `svode_core::git::versions::auto`. A refused background commit becomes
//! the commit stop of its repository and is tried again only at the next
//! closing, never in a loop. Agent turns and Routine runs hold the
//! versions of their repository ([`super::turns`]).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use svode_core::git::GitError;
use svode_core::git::autocommit::AutocommitService;
use svode_core::git::versions::auto::{self, AutoVersions, Closing};
use tauri::{AppHandle, Emitter, Manager};

use super::commands::message_language;
use super::delivery::{host, runtime};
use crate::AppError;

/// A content group closes after this long without changes; with the timer
/// slack, a version comes well within the 2 minutes 1.E allows.
pub(crate) const PAUSE: Duration = Duration::from_secs(60);
/// A group that closes right after its operation waits this long, so the
/// operation's own writes land first.
const OPERATION_DELAY: Duration = Duration::from_secs(1);
/// Leaving a Page waits for the editor to write its last change.
const LEAVE_DELAY: Duration = Duration::from_secs(2);
const SLACK: Duration = Duration::from_secs(1);
/// Quitting waits at most this long for the last versions.
const QUIT_TIMEOUT: Duration = Duration::from_secs(10);

const EVENT_AUTO_VERSION: &str = "git:auto-version";

/// When each repository closes its groups next. Pure planning: the state
/// owns the timers that follow from it.
#[derive(Default)]
pub(crate) struct Planner {
    repositories: HashMap<PathBuf, Schedule>,
}

#[derive(Default)]
struct Schedule {
    wake: Option<Instant>,
    generation: u64,
    left: Vec<String>,
    stopped: bool,
}

/// A timer to start: when, and the generation that keeps it current.
pub(crate) type Wake = (Instant, u64);

impl Planner {
    fn arm(&mut self, repo: &Path, at: Instant) -> Option<Wake> {
        let schedule = self.repositories.entry(repo.to_path_buf()).or_default();
        if schedule.wake.is_some_and(|wake| wake <= at) {
            return None;
        }
        schedule.wake = Some(at);
        schedule.generation += 1;
        Some((at, schedule.generation))
    }

    /// Content of the repository changed: its groups are checked after the
    /// pause unless a check is already planned.
    pub(crate) fn touched(&mut self, repo: &Path, now: Instant) -> Option<Wake> {
        if self
            .repositories
            .get(repo)
            .is_some_and(|schedule| schedule.wake.is_some())
        {
            return None;
        }
        self.arm(repo, now + PAUSE)
    }

    /// A managed operation registered its changes: they close at once.
    pub(crate) fn operation(&mut self, repo: &Path, now: Instant) -> Option<Wake> {
        self.arm(repo, now + OPERATION_DELAY)
    }

    /// The user left a Page or Collection at `path` of the repository.
    pub(crate) fn left(&mut self, repo: &Path, path: String, now: Instant) -> Option<Wake> {
        let schedule = self.repositories.entry(repo.to_path_buf()).or_default();
        if !schedule.left.contains(&path) {
            schedule.left.push(path);
        }
        self.arm(repo, now + LEAVE_DELAY)
    }

    /// The timer of `generation` fired: the paths left since the last check,
    /// or `None` when a newer timer replaced it.
    pub(crate) fn take(&mut self, repo: &Path, generation: u64) -> Option<Vec<String>> {
        let schedule = self.repositories.get_mut(repo)?;
        if schedule.generation != generation || schedule.wake.is_none() {
            return None;
        }
        schedule.wake = None;
        Some(std::mem::take(&mut schedule.left))
    }

    /// A check ended. Only open groups plan the next one: a refused commit
    /// and a repository in a waiting state wait for the next closing.
    pub(crate) fn finished(
        &mut self,
        repo: &Path,
        next: Option<Duration>,
        now: Instant,
    ) -> Option<Wake> {
        next.and_then(|next| self.arm(repo, now + next + SLACK))
    }

    /// Record whether the repository shows the commit stop now; `true` when
    /// that changed.
    pub(crate) fn set_stopped(&mut self, repo: &Path, stopped: bool) -> bool {
        let schedule = self.repositories.entry(repo.to_path_buf()).or_default();
        std::mem::replace(&mut schedule.stopped, stopped) != stopped
    }

    pub(crate) fn repositories(&self) -> Vec<PathBuf> {
        self.repositories.keys().cloned().collect()
    }
}

/// Tauri-managed planner of automatic versions.
#[derive(Default)]
pub struct AutoVersionState(Mutex<Planner>);

impl AutoVersionState {
    pub fn new() -> Self {
        Self::default()
    }

    fn plan<T>(&self, plan: impl FnOnce(&mut Planner) -> T) -> T {
        plan(&mut self.0.lock().unwrap_or_else(|error| error.into_inner()))
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AutoVersionEvent {
    repository: String,
    /// The refused commit as the IPC error of a save; `null` ends the
    /// commit stop.
    error: Option<serde_json::Value>,
}

/// Plan with the managed planner; nothing to plan where it is not managed.
fn plan<T>(app: &AppHandle, plan: impl FnOnce(&mut Planner) -> T) -> Option<T> {
    app.try_state::<AutoVersionState>()
        .map(|state| state.plan(plan))
}

/// The repository of `space` when content or system commits are on for it.
fn enabled_repository(space: &Path) -> Option<PathBuf> {
    auto::repository_of(space).filter(|repo| auto::lifecycle(repo).is_some())
}

/// A file of the Space changed on disk.
pub(crate) fn touched(app: &AppHandle, space: &Path) {
    if let Some(repo) = enabled_repository(space) {
        let wake = plan(app, |planner| planner.touched(&repo, Instant::now()));
        start(app, repo, wake.flatten());
    }
}

/// A managed operation registered content changes of the Space.
pub(crate) fn operation(app: &AppHandle, space: &Path) {
    if let Some(repo) = enabled_repository(space) {
        let wake = plan(app, |planner| planner.operation(&repo, Instant::now()));
        start(app, repo, wake.flatten());
    }
}

/// The user left the Page or Collection at `path` of the Space.
pub(crate) fn left(app: &AppHandle, space: &Path, path: &str) -> Result<(), AppError> {
    let Some(repo) = enabled_repository(space) else {
        return Ok(());
    };
    let relative = svode_core::git::path::repo_relative_from_base(
        &repo,
        &space.join(path),
        svode_core::git::path::RootMode::Reject,
    )?;
    let wake = plan(app, |planner| planner.left(&repo, relative, Instant::now()));
    start(app, repo, wake.flatten());
    Ok(())
}

/// Close every open group of the repositories of `spaces` now: the window
/// lost focus or a sync starts.
pub(crate) async fn close_all(app: &AppHandle, spaces: &[PathBuf]) {
    let mut repositories = Vec::<PathBuf>::new();
    for space in spaces {
        if let Some(repo) = enabled_repository(space)
            && !repositories.contains(&repo)
        {
            repositories.push(repo);
        }
    }
    for repo in repositories {
        run(app, repo, Closing::all(PAUSE)).await;
    }
}

/// Close every open group of the repositories this run saw, before the app
/// exits.
pub(crate) async fn close_on_quit(app: &AppHandle) {
    let spaces = plan(app, |planner| planner.repositories()).unwrap_or_default();
    if tokio::time::timeout(QUIT_TIMEOUT, close_all(app, &spaces))
        .await
        .is_err()
    {
        tracing::warn!("automatic versions on quit timed out; edits stay uncommitted");
    }
}

fn start(app: &AppHandle, repo: PathBuf, wake: Option<Wake>) {
    let Some((at, generation)) = wake else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep_until(at.into()).await;
        let left = plan(&app, |planner| planner.take(&repo, generation));
        if let Some(left) = left.flatten() {
            run(&app, repo, timer_closing(left)).await;
        }
    });
}

/// What a fired timer closes: the groups idle for the pause, those the user
/// left and those that close right after their operation.
fn timer_closing(left: Vec<String>) -> Closing {
    Closing {
        left,
        ..Closing::paused(PAUSE)
    }
}

async fn run(app: &AppHandle, repo: PathBuf, closing: Closing) {
    let result = auto::close(
        &runtime(app),
        host(app).as_ref(),
        &repo,
        &closing,
        message_language(app),
    )
    .await;
    settle(app, repo, result);
}

/// What versions of `repo` made by a closing or a turn did: a refused
/// commit becomes the commit stop, a success ends it, and open groups plan
/// their next check.
pub(crate) fn settle(app: &AppHandle, repo: PathBuf, result: Result<AutoVersions, GitError>) {
    let (next, error) = match result {
        Ok(AutoVersions::Done { next, .. }) => (next, None),
        Ok(AutoVersions::Off | AutoVersions::Held(_)) => return,
        Err(error) => {
            tracing::warn!(kind = error.kind(), "automatic version refused");
            let error = serde_json::to_value(AppError::from(error))
                .unwrap_or_else(|_| serde_json::json!({ "kind": "general" }));
            (None, Some(error))
        }
    };
    let Some((changed, wake)) = plan(app, |planner| {
        (
            planner.set_stopped(&repo, error.is_some()),
            planner.finished(&repo, next, Instant::now()),
        )
    }) else {
        return;
    };
    if changed || error.is_some() {
        let repository = std::fs::canonicalize(&repo).unwrap_or_else(|_| repo.clone());
        let event = AutoVersionEvent {
            repository: repository.to_string_lossy().into_owned(),
            error,
        };
        if let Err(error) = app.emit(EVENT_AUTO_VERSION, event) {
            tracing::warn!("failed to emit {EVENT_AUTO_VERSION}: {error}");
        }
    }
    start(app, repo, wake);
}

/// The creation commits of the Spaces of `project` whose `SpaceRef` is not
/// committed yet, where structural commits are on (Stage 11 05 «Коммиты
/// создания»). A refusal keeps the Spaces and becomes the commit stop
/// (1.E n. 3); a writer of another process holding the project defers them
/// to the next closing of groups, pickup or opening.
pub(crate) async fn commit_space_creations(app: &AppHandle, project: &Path) {
    let autocommit = app.state::<Arc<AutocommitService>>();
    match autocommit.commit_space_creations(project).await {
        Ok(_) => {}
        Err(GitError::SourceBusy { .. }) => {
            tracing::info!("creation commit deferred while another writer holds the project");
        }
        Err(error) => {
            tracing::warn!(kind = error.kind(), "creation commit refused");
            settle(app, project.to_path_buf(), Err(error));
        }
    }
}

#[cfg(test)]
pub(crate) use tests::QuietHost;

#[cfg(test)]
mod tests {
    use std::process::Command;

    use svode_core::git::cli::GitCli;
    use svode_core::git::flow::{ParentPublication, SyncReport};
    use svode_core::git::host::{GitHost, HostFuture};
    use svode_core::git::operations::SharedError;
    use svode_core::git::policy::{GitUserPolicy, write_user_policy};
    use svode_core::git::state::GitRuntime;
    use svode_core::git::versions::MessageLanguage;

    use super::*;

    fn repo() -> PathBuf {
        PathBuf::from("/project")
    }

    #[test]
    fn a_change_plans_one_check_after_the_pause_and_later_changes_keep_it() {
        let mut planner = Planner::default();
        let now = Instant::now();
        let (at, generation) = planner.touched(&repo(), now).expect("timer");
        assert_eq!(at, now + PAUSE);
        assert_eq!(planner.touched(&repo(), now + Duration::from_secs(5)), None);
        assert_eq!(planner.take(&repo(), generation), Some(Vec::new()));
        // An open group plans the check at its pause; a version comes
        // within 2 minutes of its last change.
        let (at, _) = planner
            .finished(&repo(), Some(Duration::from_secs(40)), now)
            .expect("next check");
        assert!(at - now <= Duration::from_secs(41));
        assert!(PAUSE + SLACK + LEAVE_DELAY < Duration::from_secs(120));
    }

    #[test]
    fn leaving_a_page_and_an_operation_bring_the_check_forward() {
        let mut planner = Planner::default();
        let now = Instant::now();
        let (_, first) = planner.touched(&repo(), now).unwrap();
        let (at, second) = planner.left(&repo(), "a.md".into(), now).unwrap();
        assert_eq!(at, now + LEAVE_DELAY);
        // The replaced timer does nothing when it fires.
        assert_eq!(planner.take(&repo(), first), None);
        let (at, third) = planner.operation(&repo(), now).unwrap();
        assert_eq!(at, now + OPERATION_DELAY);
        assert_eq!(planner.take(&repo(), second), None);
        assert_eq!(planner.take(&repo(), third), Some(vec!["a.md".to_string()]));
    }

    #[test]
    fn a_refused_commit_is_tried_once_at_the_next_closing_not_in_a_loop() {
        let mut planner = Planner::default();
        let now = Instant::now();
        let (_, generation) = planner.touched(&repo(), now).unwrap();
        planner.take(&repo(), generation).unwrap();
        // The check failed: no timer follows from it.
        assert!(planner.set_stopped(&repo(), true));
        assert_eq!(planner.finished(&repo(), None, now), None);
        assert!(!planner.set_stopped(&repo(), true));
        // The next change of a group plans exactly one attempt.
        let (_, generation) = planner.touched(&repo(), now).expect("next closing");
        assert_eq!(planner.touched(&repo(), now), None);
        planner.take(&repo(), generation).unwrap();
        assert!(planner.set_stopped(&repo(), false));
    }

    /// A host that allows every mutation and delivers nothing.
    pub(crate) struct QuietHost;

    impl GitHost for QuietHost {
        fn authorize_repository<'a>(&'a self, _: &'a Path) -> HostFuture<'a, Result<(), GitError>> {
            Box::pin(async { Ok(()) })
        }

        fn authorize_paths<'a>(&'a self, _: Vec<PathBuf>) -> HostFuture<'a, Result<(), GitError>> {
            Box::pin(async { Ok(()) })
        }

        fn invalidate_repository_access<'a>(
            &'a self,
            _: &'a GitCli,
            _: &'a Path,
        ) -> HostFuture<'a, ()> {
            Box::pin(async {})
        }

        fn record_write_evidence<'a>(&'a self, _: &'a GitCli, _: &'a Path) -> HostFuture<'a, ()> {
            Box::pin(async {})
        }

        fn refresh_synced_repository<'a>(
            &'a self,
            _: &'a GitCli,
            _: &'a Path,
        ) -> HostFuture<'a, ()> {
            Box::pin(async {})
        }

        fn invalidate_actor_space<'a>(&'a self, _: &'a Path) -> HostFuture<'a, ()> {
            Box::pin(async {})
        }

        fn publish_commit(&self, _: &Path, _: &Path) {}

        fn schedule_auto_sync(&self, _: &Path) {}

        fn publish_sync_state(
            &self,
            _: &Path,
            _: bool,
            _: bool,
            _: Option<&SyncReport>,
            _: Option<&SharedError>,
        ) {
        }

        fn publish_publication(&self, _: &Path, _: &str, _: Option<&ParentPublication>) {}
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(output.status.success(), "git {args:?}");
        String::from_utf8(output.stdout).unwrap()
    }

    #[tokio::test]
    async fn the_check_after_creating_a_page_leaves_its_group_open_until_a_closing() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        git(root, &["init", "-q"]);
        git(root, &["config", "user.email", "test@example.test"]);
        git(root, &["config", "user.name", "Test"]);
        git(root, &["config", "commit.gpgsign", "false"]);
        std::fs::write(root.join(".gitignore"), ".svode/local.json\n").unwrap();
        git(root, &["add", "-A"]);
        git(root, &["commit", "-q", "-m", "Base"]);
        write_user_policy(
            root,
            &GitUserPolicy {
                auto_commit_content: true,
                ..GitUserPolicy::default()
            },
        )
        .unwrap();
        let runtime = Arc::new(GitRuntime::new());
        let host = Arc::new(QuietHost);
        let close = async |closing: Closing| match auto::close(
            &runtime,
            host.as_ref(),
            root,
            &closing,
            MessageLanguage::En,
        )
        .await
        {
            Ok(AutoVersions::Done { commits, next }) => (commits, next),
            other => panic!("versions expected, got {other:?}"),
        };

        // The page and its order key as the create command writes them,
        // registered the way it registers them.
        std::fs::write(root.join("Untitled.md"), "---\ntitle: Untitled\n---\n").unwrap();
        std::fs::create_dir_all(root.join(".svode")).unwrap();
        std::fs::write(root.join(".svode/order.json"), r#"{".":["Untitled"]}"#).unwrap();
        let space = root.to_str().unwrap();
        let service = AutocommitService::new(runtime.clone(), host.clone());
        crate::commands::files::schedule_created_page(&service, Some(space), space, "Untitled.md");

        // The operation plans the check a second later; it commits nothing
        // and plans the next one at the pause.
        let mut planner = Planner::default();
        let now = Instant::now();
        let (at, generation) = planner.operation(root, now).expect("timer");
        assert_eq!(at, now + OPERATION_DELAY);
        let left = planner.take(root, generation).expect("current timer");
        let (commits, next) = close(timer_closing(left)).await;
        assert_eq!(commits, 0);
        let next = next.expect("open group");
        assert!(next > PAUSE - Duration::from_secs(10), "{next:?}");
        let (at, _) = planner.finished(root, Some(next), now).expect("next check");
        assert!(at - now > Duration::from_secs(50));

        // Leaving the Page closes it as one version.
        let (commits, _) = close(timer_closing(vec!["Untitled.md".into()])).await;
        assert_eq!(commits, 1);
        let mut committed = git(root, &["show", "--name-only", "--format=", "HEAD"])
            .lines()
            .map(str::to_string)
            .collect::<Vec<_>>();
        committed.sort();
        assert_eq!(committed, [".svode/order.json", "Untitled.md"]);
    }
}

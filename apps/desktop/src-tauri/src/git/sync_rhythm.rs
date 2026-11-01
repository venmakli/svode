//! Desktop side of the sync rhythm (Stage 11 1.E): the actions that reach
//! it, its timers, the windows that keep the safety check going and the
//! background runs. When each repository syncs belongs to
//! `svode_core::git::rhythm`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Instant, SystemTime};

use svode_core::git::flow;
use svode_core::git::operations::SharedError;
use svode_core::git::ops::GitStatus;
use svode_core::git::rhythm::{self, Rhythm, Step, Trigger, Work};
use tauri::{AppHandle, Manager};

use super::delivery::{host, runtime};

/// Tauri-managed rhythm and the repositories each window shows.
#[derive(Default)]
pub struct SyncRhythmState {
    rhythm: Mutex<Rhythm>,
    windows: Mutex<HashMap<String, HashSet<PathBuf>>>,
}

impl SyncRhythmState {
    pub fn new() -> Self {
        Self::default()
    }

    fn plan<T>(&self, plan: impl FnOnce(&mut Rhythm) -> T) -> T {
        plan(
            &mut self
                .rhythm
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        )
    }

    fn windows(&self) -> std::sync::MutexGuard<'_, HashMap<String, HashSet<PathBuf>>> {
        self.windows
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }
}

fn state(app: &AppHandle) -> Option<tauri::State<'_, SyncRhythmState>> {
    app.try_state::<SyncRhythmState>()
}

fn auto_sync(repo: &Path) -> bool {
    svode_core::git::policy::effective_user_policy(repo).auto_sync
}

/// An action of the window `window` on the repository of `path`. With sync
/// off, focus returns the counters its fetch read.
pub(crate) async fn trigger(
    app: &AppHandle,
    window: Option<&str>,
    path: &Path,
    trigger: Trigger,
) -> Result<Option<GitStatus>, SharedError> {
    let runtime = runtime(app);
    let cli = runtime.require_cli()?;
    let repo = svode_core::git::access::resolve_repository(&cli, path).await?;
    let Some(state) = state(app) else {
        return Ok(None);
    };
    if let Some(window) = window
        && trigger != Trigger::Committed
    {
        state
            .windows()
            .entry(window.to_owned())
            .or_default()
            .insert(repo.clone());
    }
    let auto = auto_sync(&repo);
    let step = state.plan(|rhythm| rhythm.trigger(&repo, trigger, auto, Instant::now()));
    if step == Step::Run(Work::Fetch) {
        return flow::fetch_status(&runtime, &host(app), path)
            .await
            .map(Some);
    }
    apply(app, repo, step);
    Ok(None)
}

/// A commit landed in `repo`: its publication joins the rhythm.
pub(crate) fn committed(app: &AppHandle, repo: &Path) {
    let app = app.clone();
    let repo = repo.to_path_buf();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = trigger(&app, None, &repo, Trigger::Committed).await {
            tracing::warn!(kind = error.kind(), "sync after commit not planned");
        }
    });
}

/// The fetch for the counters of the repository of `path`, which every
/// implicit read of the counters is (DF-285): it reaches the remote only
/// when the rhythm admits background network of the repository now,
/// otherwise it reads the counters the last observation left, after the
/// running sync.
pub(crate) async fn fetch_status(app: &AppHandle, path: &Path) -> Result<GitStatus, SharedError> {
    let runtime = runtime(app);
    let cli = runtime.require_cli()?;
    let repo = svode_core::git::access::resolve_repository(&cli, path).await?;
    let network =
        state(app).is_none_or(|state| state.plan(|rhythm| rhythm.counters(&repo, Instant::now())));
    if network {
        return flow::fetch_status(&runtime, &host(app), path).await;
    }
    Ok(runtime.status(path, true).await?)
}

/// The user synced the repository of `path`; the rhythm starts over.
pub(crate) async fn explicit(app: &AppHandle, path: &Path) {
    let Ok(cli) = runtime(app).require_cli() else {
        return;
    };
    let Ok(repo) = svode_core::git::access::resolve_repository(&cli, path).await else {
        return;
    };
    let Some(step) = state(app).map(|state| {
        let auto = auto_sync(&repo);
        state.plan(|rhythm| rhythm.explicit(&repo, auto, Instant::now()))
    }) else {
        return;
    };
    apply(app, repo, step);
}

/// The window closed: it no longer keeps a safety check going.
pub(crate) fn release_window(app: &AppHandle, window: &str) {
    if let Some(state) = state(app) {
        state.windows().remove(window);
    }
}

fn apply(app: &AppHandle, repo: PathBuf, step: Step) {
    match step {
        Step::Run(work @ (Work::Sync | Work::Integrate)) => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { run(&app, repo, work).await });
        }
        Step::Arm(wake) => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep_until(wake.at.into()).await;
                let visible = visible(&app, &repo);
                let auto = auto_sync(&repo);
                let Some(step) = state(&app).map(|state| {
                    state.plan(|rhythm| {
                        rhythm.fire(&repo, wake.generation, visible, auto, Instant::now())
                    })
                }) else {
                    return;
                };
                apply(&app, repo, step);
            });
        }
        // The fetch for the counters runs only where an action asks for it.
        Step::Run(Work::Fetch) | Step::Nothing => {}
    }
}

/// A shown, not minimized window has the repository open.
fn visible(app: &AppHandle, repo: &Path) -> bool {
    let Some(state) = state(app) else {
        return false;
    };
    let labels: Vec<String> = state
        .windows()
        .iter()
        .filter(|(_, repositories)| repositories.contains(repo))
        .map(|(label, _)| label.clone())
        .collect();
    labels.iter().any(|label| {
        app.get_webview_window(label).is_some_and(|window| {
            window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(true)
        })
    })
}

async fn run(app: &AppHandle, repo: PathBuf, work: Work) {
    let runtime = runtime(app);
    let cli = runtime.require_cli().ok();
    let before = match &cli {
        Some(cli) => rhythm::incoming_revision(cli, &repo, work).await,
        None => None,
    };
    // Open content groups close before a sync (1.E).
    super::auto_versions::close_all(app, std::slice::from_ref(&repo)).await;
    let result = if work == Work::Integrate {
        flow::sync_observed(&runtime, &host(app), &repo).await
    } else {
        flow::sync(&runtime, &host(app), &repo, true).await
    };
    if let Err(error) = &result {
        tracing::warn!(kind = error.kind(), "background sync failed");
    }
    let after = match &cli {
        Some(cli) => rhythm::incoming_revision(cli, &repo, work).await,
        None => None,
    };
    let outcome = rhythm::outcome(&result, before.as_deref(), after.as_deref());
    let Some(step) = state(app)
        .map(|state| state.plan(|rhythm| rhythm.finished(&repo, outcome, Instant::now())))
    else {
        return;
    };
    apply(app, repo, step);
}

/// Records a successful sync of `repository` on this device and returns
/// its time in milliseconds since the Unix epoch.
pub(crate) fn record_synced(app: &AppHandle, repository: &Path) -> Option<u64> {
    let store = last_sync_store(app)?;
    match svode_core::git::last_sync::record(&store, repository, SystemTime::now()) {
        Ok(at) => Some(at),
        Err(error) => {
            tracing::warn!("failed to record the last sync time: {error}");
            None
        }
    }
}

/// The last successful sync of `repository` on this device.
pub(crate) fn last_synced(app: &AppHandle, repository: &Path) -> Option<u64> {
    svode_core::git::last_sync::read(&last_sync_store(app)?, repository)
}

fn last_sync_store(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(svode_core::git::last_sync::LAST_SYNC_FILE))
}

//! The open Desktop follows the list of Projects of the device on disk
//! (Stage 11 05 «Открытый Desktop следует `spaces` на диске», last
//! paragraph): when another process (CLI, headless MCP) or another Desktop
//! window changes `spaces.json`, Home and the recent projects menu read it
//! again and the Routine schedulers follow it, without a restart. Repeated
//! observations of the same contents change nothing.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::mpsc;
use std::time::Duration;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use svode_core::project::registry;
use tauri::{AppHandle, Emitter, Manager};

use crate::routines::RoutineSchedulerState;

/// The list of Projects of the device changed on disk.
pub const PROJECT_LIST_CHANGED_EVENT: &str = "projects:changed";

/// A series of writes, such as a lock and an atomic replace, is one change.
const CHANGE_DEBOUNCE: Duration = Duration::from_millis(200);

/// Keeps the watcher of the list for the life of the app.
#[derive(Default)]
pub struct ProjectListState {
    watcher: Mutex<Option<RecommendedWatcher>>,
}

impl ProjectListState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Start following the list in the config directory of the app.
    pub fn follow(&self, app: &AppHandle) {
        let dir = match app.path().app_config_dir() {
            Ok(dir) => dir,
            Err(error) => {
                tracing::warn!("the project list cannot be followed: {error}");
                return;
            }
        };
        let handle = app.clone();
        match follow(dir, move || changed(&handle)) {
            Ok(watcher) => {
                *self
                    .watcher
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = Some(watcher);
            }
            Err(error) => tracing::warn!("the project list cannot be followed: {error}"),
        }
    }
}

/// What the app does after the list changed: the same as after its own
/// project operations, and Home reads the list again.
fn changed(app: &AppHandle) {
    if let Err(error) = crate::app_windows::rebuild_app_menu(app) {
        tracing::warn!("failed to rebuild recent projects menu: {error}");
    }
    app.state::<RoutineSchedulerState>().sync(app);
    let _ = app.emit(PROJECT_LIST_CHANGED_EVENT, ());
}

/// Watch the list in `dir` and call `on_change` once for a series of
/// changes that leaves contents other than the last ones seen; dropping the
/// watcher ends it.
fn follow(
    dir: PathBuf,
    on_change: impl Fn() + Send + 'static,
) -> notify::Result<RecommendedWatcher> {
    std::fs::create_dir_all(&dir)?;
    let file = registry::file(&dir);
    let (changes, received) = mpsc::channel::<()>();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        let Ok(event) = result else { return };
        if !matches!(event.kind, EventKind::Access(_))
            && event.paths.iter().any(|path| is_list(path))
        {
            let _ = changes.send(());
        }
    })?;
    watcher.watch(&dir, RecursiveMode::NonRecursive)?;
    let mut seen = std::fs::read(&file).ok();
    std::thread::spawn(move || {
        while received.recv().is_ok() {
            loop {
                match received.recv_timeout(CHANGE_DEBOUNCE) {
                    Ok(()) => continue,
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
            let now = std::fs::read(&file).ok();
            if now != seen {
                seen = now;
                on_change();
            }
        }
    });
    Ok(watcher)
}

fn is_list(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|name| name == registry::REGISTRY_FILE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Instant;

    fn wait_for(count: &AtomicUsize, expected: usize) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while count.load(Ordering::SeqCst) < expected && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(count.load(Ordering::SeqCst), expected);
    }

    /// A writer outside this Desktop registers a Project and later removes
    /// it: each change is observed once; rewriting the same contents and
    /// unrelated files of the directory are not changes.
    #[test]
    fn a_change_of_the_list_by_another_writer_is_observed_once() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("config");
        let count = Arc::new(AtomicUsize::new(0));
        let observed = count.clone();
        let _watcher = follow(dir.clone(), move || {
            observed.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();
        // The watcher of some platforms starts delivering a moment later.
        std::thread::sleep(Duration::from_millis(300));

        registry::add(&dir, "external", "/projects/external").unwrap();
        wait_for(&count, 1);

        let contents = std::fs::read(registry::file(&dir)).unwrap();
        std::fs::write(registry::file(&dir), &contents).unwrap();
        std::fs::write(dir.join("settings.json"), "{}").unwrap();
        std::thread::sleep(Duration::from_millis(800));
        assert_eq!(count.load(Ordering::SeqCst), 1);

        registry::remove(&dir, "external").unwrap();
        wait_for(&count, 2);
        assert!(registry::read(&dir).unwrap().spaces.is_empty());
    }
}

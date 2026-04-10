use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::error::AppError;

struct WatcherHandle {
    _watcher: RecommendedWatcher,
    /// Send a signal to stop the debounce thread.
    stop_tx: mpsc::Sender<()>,
}

/// Manages file watchers per workspace.
pub struct FileWatcher {
    handles: Arc<Mutex<HashMap<String, WatcherHandle>>>,
}

impl FileWatcher {
    pub fn new() -> Self {
        Self {
            handles: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Start watching a workspace directory.
    pub fn watch(&self, workspace: String, app: AppHandle) -> Result<(), AppError> {
        let workspace_path = PathBuf::from(&workspace);
        if !workspace_path.is_dir() {
            return Err(AppError::FileNotFound(workspace.clone()));
        }

        // Stop existing watcher for this workspace if any
        self.unwatch(&workspace)?;

        let (event_tx, event_rx) = mpsc::channel::<Event>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();

        let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                let _ = event_tx.send(event);
            }
        })
        .map_err(|e| AppError::Watcher(e.to_string()))?;

        watcher
            .watch(&workspace_path, RecursiveMode::Recursive)
            .map_err(|e| AppError::Watcher(e.to_string()))?;

        // Spawn debounce thread
        let ws = workspace.clone();
        std::thread::spawn(move || {
            debounce_loop(event_rx, stop_rx, &ws, &app);
        });

        let mut handles = self
            .handles
            .lock()
            .map_err(|e| AppError::General(e.to_string()))?;

        handles.insert(
            workspace,
            WatcherHandle {
                _watcher: watcher,
                stop_tx,
            },
        );

        Ok(())
    }

    /// Stop watching a workspace directory.
    pub fn unwatch(&self, workspace: &str) -> Result<(), AppError> {
        let mut handles = self
            .handles
            .lock()
            .map_err(|e| AppError::General(e.to_string()))?;

        if let Some(handle) = handles.remove(workspace) {
            let _ = handle.stop_tx.send(());
        }

        Ok(())
    }
}

/// Debounce loop: collects events over 200ms windows and emits deduplicated Tauri events.
fn debounce_loop(
    event_rx: mpsc::Receiver<Event>,
    stop_rx: mpsc::Receiver<()>,
    workspace: &str,
    app: &AppHandle,
) {
    let debounce = Duration::from_millis(200);

    loop {
        // Wait for the first event or stop signal
        match event_rx.recv_timeout(Duration::from_secs(60)) {
            Ok(first_event) => {
                // Collect events over the debounce window
                let mut events = vec![first_event];
                let deadline = std::time::Instant::now() + debounce;
                loop {
                    let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                    if remaining.is_zero() {
                        break;
                    }
                    match event_rx.recv_timeout(remaining) {
                        Ok(ev) => events.push(ev),
                        Err(mpsc::RecvTimeoutError::Timeout) => break,
                        Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    }
                }

                // Process collected events
                process_events(&events, workspace, app);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // No events, check stop signal
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }

        // Check stop signal (non-blocking)
        if stop_rx.try_recv().is_ok() {
            return;
        }
    }
}

/// Process a batch of debounced events.
fn process_events(events: &[Event], workspace: &str, app: &AppHandle) {
    // Deduplicate by path — keep the last event kind per path
    let mut seen: HashMap<PathBuf, &EventKind> = HashMap::new();
    let mut any_dirty = false;
    for event in events {
        for path in &event.paths {
            if should_ignore(path) {
                continue;
            }
            // Any non-ignored file change → workspace is dirty.
            // Includes non-.md assets (frontend uses this to refresh git status).
            any_dirty = true;
            // Per-file file:* events are emitted only for .md files.
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            seen.insert(path.clone(), &event.kind);
        }
    }

    if any_dirty {
        let _ = app.emit(
            "workspace:dirty",
            serde_json::json!({ "workspace": workspace }),
        );
    }

    for (path, kind) in seen {
        let rel_path = path
            .strip_prefix(workspace)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();

        let payload = serde_json::json!({ "path": rel_path });

        let event_name = match kind {
            EventKind::Create(_) => "file:created",
            EventKind::Modify(_) => "file:changed",
            EventKind::Remove(_) => "file:deleted",
            _ => continue,
        };

        let _ = app.emit(event_name, payload);
    }
}

/// Check if a path should be ignored by the watcher.
fn should_ignore(path: &Path) -> bool {
    for component in path.components() {
        if let std::path::Component::Normal(name) = component {
            let name = name.to_string_lossy();
            if name.starts_with('.') {
                return true;
            }
        }
    }
    false
}

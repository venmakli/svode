use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::error::AppError;
use crate::files::WriteNonceRegistry;
use crate::index::{IndexKey, IndexState};
use crate::repo_path::{RootMode, repo_relative_from_base};

struct WatcherHandle {
    _watcher: RecommendedWatcher,
    /// Send a signal to stop the debounce thread.
    stop_tx: mpsc::Sender<()>,
    ref_count: usize,
}

/// Manages file watchers per space.
pub struct FileWatcher {
    handles: Arc<Mutex<HashMap<String, WatcherHandle>>>,
}

impl FileWatcher {
    pub fn new() -> Self {
        Self {
            handles: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Start watching a space directory.
    pub fn watch(&self, space: String, app: AppHandle) -> Result<(), AppError> {
        let space_path = PathBuf::from(&space);
        if !space_path.is_dir() {
            return Err(AppError::FileNotFound(space.clone()));
        }

        {
            let mut handles = self
                .handles
                .lock()
                .map_err(|e| AppError::General(e.to_string()))?;
            if let Some(handle) = handles.get_mut(&space) {
                handle.ref_count += 1;
                return Ok(());
            }
        }

        let (event_tx, event_rx) = mpsc::channel::<Event>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();

        let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                let _ = event_tx.send(event);
            }
        })
        .map_err(|e| AppError::Watcher(e.to_string()))?;

        watcher
            .watch(&space_path, RecursiveMode::Recursive)
            .map_err(|e| AppError::Watcher(e.to_string()))?;

        // Spawn debounce thread
        let sp = space.clone();
        std::thread::spawn(move || {
            debounce_loop(event_rx, stop_rx, &sp, &app);
        });

        let mut handles = self
            .handles
            .lock()
            .map_err(|e| AppError::General(e.to_string()))?;

        if let Some(handle) = handles.get_mut(&space) {
            handle.ref_count += 1;
            let _ = stop_tx.send(());
            return Ok(());
        }

        handles.insert(
            space,
            WatcherHandle {
                _watcher: watcher,
                stop_tx,
                ref_count: 1,
            },
        );

        Ok(())
    }

    /// Stop watching a space directory.
    pub fn unwatch(&self, space: &str) -> Result<(), AppError> {
        let mut handles = self
            .handles
            .lock()
            .map_err(|e| AppError::General(e.to_string()))?;

        if let Some(handle) = handles.get_mut(space) {
            if handle.ref_count > 1 {
                handle.ref_count -= 1;
                return Ok(());
            }
        }

        if let Some(handle) = handles.remove(space) {
            let _ = handle.stop_tx.send(());
        }

        Ok(())
    }
}

/// Debounce loop: collects events over 200ms windows and emits deduplicated Tauri events.
fn debounce_loop(
    event_rx: mpsc::Receiver<Event>,
    stop_rx: mpsc::Receiver<()>,
    space: &str,
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
                process_events(&events, space, app);
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
fn process_events(events: &[Event], space: &str, app: &AppHandle) {
    // Deduplicate by path — keep the last event kind per path
    let mut seen: HashMap<PathBuf, &EventKind> = HashMap::new();
    let mut any_dirty = false;
    let mut any_assets_changed = false;
    let space_root = Path::new(space);
    for event in events {
        for path in &event.paths {
            if should_ignore(path) {
                continue;
            }
            // Any non-ignored file change → space is dirty.
            // Includes non-.md assets (frontend uses this to refresh git status).
            any_dirty = true;
            // Detect `.assets/`-scoped changes so we can emit a targeted
            // event for the storage reactor to re-scan the assets table.
            if is_under_assets(path, space_root) {
                any_assets_changed = true;
            }
            // Per-file file:* events are emitted for document entries and
            // collection schemas. Schema changes are derived-state inputs only;
            // they do not trigger autocommit from the watcher.
            if !is_document_or_schema(path) {
                continue;
            }
            seen.insert(path.clone(), &event.kind);
        }
    }

    if any_dirty {
        let _ = app.emit("space:dirty", serde_json::json!({ "space": space }));
    }
    if any_assets_changed {
        let _ = app.emit(
            "space:assets_changed",
            serde_json::json!({ "space": space }),
        );
    }

    let nonces = app.state::<Arc<WriteNonceRegistry>>();

    for (path, kind) in seen {
        let rel_path = match repo_relative_from_base(space_root, &path, RootMode::Reject) {
            Ok(path) => path,
            Err(e) => {
                tracing::warn!(
                    "watcher skipped invalid repo-relative path {}: {e}",
                    path.display()
                );
                continue;
            }
        };

        let event_name = match kind {
            EventKind::Create(_) => "file:created",
            EventKind::Modify(_) => "file:changed",
            EventKind::Remove(_) => "file:deleted",
            _ => continue,
        };

        sync_index_for_watched_path(space_root, &path, app);

        // Only `file:changed` carries a write-nonce — our own writes surface
        // as Modify events, so Create/Remove never need echo-guarding here.
        let payload = if matches!(kind, EventKind::Modify(_)) {
            match nonces.take(&path) {
                Some(nonce) => serde_json::json!({ "path": rel_path, "writeNonce": nonce }),
                None => serde_json::json!({ "path": rel_path }),
            }
        } else {
            serde_json::json!({ "path": rel_path })
        };

        let _ = app.emit(event_name, payload);
    }
}

fn sync_index_for_watched_path(space_root: &Path, path: &Path, app: &AppHandle) {
    tauri::async_runtime::block_on(async {
        let state = app.state::<IndexState>();
        let key = state
            .key_for_space_dir(space_root)
            .await
            .unwrap_or_else(|| IndexKey::Root(space_root.to_path_buf()));

        if is_schema_path(path) {
            if let Err(e) = state.run_full_reindex(&key).await {
                tracing::warn!("watcher full reindex failed for {:?}: {e}", key);
            }
            return;
        }

        let project = key.project().to_path_buf();
        if let Err(e) = crate::index::update::update_entry(&state, &project, path).await {
            tracing::warn!("watcher index update failed for {}: {e}", path.display());
        }
    });
}

/// Check if a path should be ignored by the watcher.
///
/// We skip anything inside a dotted directory (`.git`, `.combai`, …) with one
/// exception: `.assets/` is allowed through so we can re-index uploads and
/// detect LFS pointer changes after a sync.
fn should_ignore(path: &Path) -> bool {
    let mut first_dot_seen = false;
    for component in path.components() {
        if let std::path::Component::Normal(name) = component {
            let name_str = name.to_string_lossy();
            if name_str.starts_with('.') {
                if !first_dot_seen && name_str == ".assets" {
                    first_dot_seen = true;
                    continue;
                }
                return true;
            }
            first_dot_seen = false;
        }
    }
    false
}

/// True iff `path` is inside the watched space's `.assets/` directory.
/// Uses the literal space root so unrelated `.assets` folders nested deeper
/// don't trip this (the watcher only fires on paths under the root anyway).
fn is_under_assets(path: &Path, space_root: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(space_root) else {
        return false;
    };
    rel.components().next().is_some_and(|c| {
        matches!(c, std::path::Component::Normal(name) if name == std::ffi::OsStr::new(".assets"))
    })
}

fn is_document_or_schema(path: &Path) -> bool {
    if path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
    {
        return true;
    }
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == "schema.yaml")
}

fn is_schema_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == "schema.yaml")
}

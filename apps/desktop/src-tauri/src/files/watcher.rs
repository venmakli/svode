use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::error::AppError;
use crate::files::WriteNonceRegistry;
use crate::files::tree_policy::{TreeIgnorePolicy, TreePathKind};
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
    let policy = TreeIgnorePolicy::from_space_root(space_root);
    for event in events {
        for path in &event.paths {
            // Detect `.assets/`-scoped changes so we can emit a targeted
            // event for the storage reactor to re-scan the assets table.
            if is_under_assets(path, space_root) {
                any_assets_changed = true;
                any_dirty = true;
            }

            // Any non-ignored file change → space is dirty.
            // Includes non-.md assets (frontend uses this to refresh git status).
            if !policy.is_ignored_abs(path, path_kind(path)) {
                any_dirty = true;
            }
            // Per-file file:* events are emitted for document entries and
            // collection schemas. Schema changes are derived-state inputs only;
            // they do not trigger autocommit from the watcher.
            if !should_emit_content_tree_event(&policy, path) {
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

fn path_kind(path: &Path) -> TreePathKind {
    if path.is_dir() {
        TreePathKind::Directory
    } else if path.is_file() {
        TreePathKind::File
    } else {
        TreePathKind::Unknown
    }
}

fn should_emit_content_tree_event(policy: &TreeIgnorePolicy, path: &Path) -> bool {
    !policy.is_ignored_abs(path, path_kind(path)) && is_document_or_schema(path)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::config::write_space_config;
    use crate::space::types::{SpaceConfig, TreeSpaceConfig};
    use tempfile::TempDir;

    fn write_tree_config(tmp: &TempDir, exclude: Vec<&str>, include: Vec<&str>) {
        write_space_config(
            tmp.path(),
            &SpaceConfig {
                name: "Test".to_string(),
                description: String::new(),
                icon: "folder".to_string(),
                spaces: None,
                agent: None,
                defaults: None,
                git: None,
                assets: None,
                tree: Some(TreeSpaceConfig {
                    exclude: exclude.into_iter().map(ToString::to_string).collect(),
                    include: include.into_iter().map(ToString::to_string).collect(),
                    show_ignored_placeholders: false,
                }),
            },
        )
        .expect("write config");
    }

    #[test]
    fn watcher_keeps_assets_targeted_but_out_of_content_tree_events() {
        let tmp = TempDir::new().unwrap();
        let assets = tmp.path().join(".assets");
        std::fs::create_dir_all(&assets).unwrap();
        let asset_doc = assets.join("image.md");
        std::fs::write(&asset_doc, "asset metadata").unwrap();
        let policy = TreeIgnorePolicy::from_space_root(tmp.path());

        assert!(is_under_assets(&asset_doc, tmp.path()));
        assert!(!should_emit_content_tree_event(&policy, &asset_doc));
    }

    #[test]
    fn watcher_filters_user_excluded_document_paths() {
        let tmp = TempDir::new().unwrap();
        write_tree_config(&tmp, vec!["node_modules"], vec![]);
        let ignored_dir = tmp.path().join("node_modules").join("pkg");
        std::fs::create_dir_all(&ignored_dir).unwrap();
        let ignored_doc = ignored_dir.join("README.md");
        std::fs::write(&ignored_doc, "ignored").unwrap();
        let visible_doc = tmp.path().join("visible.md");
        std::fs::write(&visible_doc, "visible").unwrap();
        let policy = TreeIgnorePolicy::from_space_root(tmp.path());

        assert!(!should_emit_content_tree_event(&policy, &ignored_doc));
        assert!(should_emit_content_tree_event(&policy, &visible_doc));
    }

    #[test]
    fn watcher_allows_user_included_document_paths() {
        let tmp = TempDir::new().unwrap();
        write_tree_config(&tmp, vec!["docs/*.md"], vec!["docs/keep.md"]);
        let docs = tmp.path().join("docs");
        std::fs::create_dir_all(&docs).unwrap();
        let dropped = docs.join("drop.md");
        let kept = docs.join("keep.md");
        std::fs::write(&dropped, "drop").unwrap();
        std::fs::write(&kept, "keep").unwrap();
        let policy = TreeIgnorePolicy::from_space_root(tmp.path());

        assert!(!should_emit_content_tree_event(&policy, &dropped));
        assert!(should_emit_content_tree_event(&policy, &kept));
    }
}

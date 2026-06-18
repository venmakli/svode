use notify::event::{CreateKind, ModifyKind, RemoveKind};
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
use crate::repo_path::{RootMode, repo_relative_from_base, repo_relative_from_path};

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
    // Deduplicate by path while preserving structural create/delete semantics.
    // Backends often report Create followed by Modify for the same file within
    // one debounce window; the sidebar still needs this as `file:created`.
    let mut seen: HashMap<PathBuf, EventKind> = HashMap::new();
    let mut any_dirty = false;
    let mut any_assets_changed = false;
    let mut any_tree_changed = false;
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
            if !policy.is_ignored_abs(path, path_kind(path, &event.kind)) {
                any_dirty = true;
            }
            // Per-file file:* events are emitted for document entries and
            // collection schemas. Schema changes are derived-state inputs only;
            // they do not trigger autocommit from the watcher.
            let Some(classification) =
                classify_content_tree_event(space_root, &policy, path, &event.kind)
            else {
                continue;
            };
            any_tree_changed =
                any_tree_changed || classification.affects_tree || classification.affects_metadata;
            seen.entry(path.clone())
                .and_modify(|current| *current = merge_event_kind(*current, event.kind))
                .or_insert(event.kind);
        }
    }

    if any_dirty {
        let _ = app.emit(
            "space:dirty",
            serde_json::json!({ "space": space, "affectsTree": any_tree_changed }),
        );
    }
    if any_assets_changed {
        let _ = app.emit(
            "space:assets_changed",
            serde_json::json!({ "space": space }),
        );
    }

    let nonces = app.state::<Arc<WriteNonceRegistry>>();

    for (path, kind) in seen {
        let Some(classification) = classify_content_tree_event(space_root, &policy, &path, &kind)
        else {
            continue;
        };

        let event_name = match kind {
            EventKind::Create(_) => "file:created",
            EventKind::Modify(_) => "file:changed",
            EventKind::Remove(_) => "file:deleted",
            _ => continue,
        };

        sync_index_for_watched_path(space_root, &path, classification.kind, app);

        // Only `file:changed` carries a write-nonce — our own writes surface
        // as Modify events, so Create/Remove never need echo-guarding here.
        let nonce = if matches!(kind, EventKind::Modify(_)) {
            nonces.take(&path)
        } else {
            None
        };
        let mut payload = serde_json::json!({
            "space": space,
            "path": classification.rel_path,
            "kind": classification.kind.as_payload_str(),
            "isDir": classification.is_dir,
            "parentPath": classification.parent_path,
            "affectsTree": classification.affects_tree,
            "affectsMetadata": classification.affects_metadata,
        });
        if let Some(nonce) = nonce {
            payload["writeNonce"] = serde_json::json!(nonce);
        }

        let _ = app.emit(event_name, payload);
    }
}

fn sync_index_for_watched_path(
    space_root: &Path,
    path: &Path,
    kind: ContentTreeEventKind,
    app: &AppHandle,
) {
    if kind == ContentTreeEventKind::Folder {
        return;
    }

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ContentTreeEventKind {
    Document,
    Schema,
    Folder,
}

impl ContentTreeEventKind {
    fn as_payload_str(self) -> &'static str {
        match self {
            Self::Document => "document",
            Self::Schema => "schema",
            Self::Folder => "folder",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ContentTreeEventClassification {
    rel_path: String,
    kind: ContentTreeEventKind,
    is_dir: bool,
    parent_path: String,
    affects_tree: bool,
    affects_metadata: bool,
}

fn classify_content_tree_event(
    space_root: &Path,
    policy: &TreeIgnorePolicy,
    path: &Path,
    event_kind: &EventKind,
) -> Option<ContentTreeEventClassification> {
    let tree_kind = path_kind(path, event_kind);
    if policy.is_ignored_abs(path, tree_kind) {
        return None;
    }

    let kind = content_tree_event_kind(path, event_kind)?;
    let rel_path = match repo_relative_from_base(space_root, path, RootMode::Reject) {
        Ok(path) => path,
        Err(e) => {
            tracing::warn!(
                "watcher skipped invalid repo-relative path {}: {e}",
                path.display()
            );
            return None;
        }
    };
    let parent_path = parent_path_for_rel(&rel_path);

    Some(ContentTreeEventClassification {
        rel_path,
        kind,
        is_dir: kind == ContentTreeEventKind::Folder,
        parent_path,
        affects_tree: affects_tree(kind, event_kind),
        affects_metadata: affects_metadata(kind, path, event_kind),
    })
}

fn path_kind(path: &Path, event_kind: &EventKind) -> TreePathKind {
    if path.is_dir() {
        TreePathKind::Directory
    } else if path.is_file() {
        TreePathKind::File
    } else if event_kind_is_folder(event_kind) {
        TreePathKind::Directory
    } else if is_document_or_schema(path) {
        TreePathKind::File
    } else {
        TreePathKind::Unknown
    }
}

#[cfg(test)]
fn should_emit_content_tree_event(policy: &TreeIgnorePolicy, path: &Path) -> bool {
    let event_kind = if path.is_dir() {
        EventKind::Create(CreateKind::Folder)
    } else {
        EventKind::Create(CreateKind::File)
    };
    !policy.is_ignored_abs(path, path_kind(path, &event_kind))
        && content_tree_event_kind(path, &event_kind).is_some()
}

fn content_tree_event_kind(path: &Path, event_kind: &EventKind) -> Option<ContentTreeEventKind> {
    if is_schema_path(path) {
        return Some(ContentTreeEventKind::Schema);
    }
    if is_markdown_path(path) {
        return Some(ContentTreeEventKind::Document);
    }
    if is_folder_content_tree_event(path, event_kind) {
        return Some(ContentTreeEventKind::Folder);
    }
    None
}

fn is_folder_content_tree_event(path: &Path, event_kind: &EventKind) -> bool {
    event_kind_is_folder(event_kind)
        || (path.is_dir()
            && matches!(
                event_kind,
                EventKind::Create(_)
                    | EventKind::Remove(_)
                    | EventKind::Modify(ModifyKind::Name(_))
            ))
}

fn event_kind_is_folder(event_kind: &EventKind) -> bool {
    matches!(
        event_kind,
        EventKind::Create(CreateKind::Folder) | EventKind::Remove(RemoveKind::Folder)
    )
}

fn affects_tree(kind: ContentTreeEventKind, event_kind: &EventKind) -> bool {
    match kind {
        ContentTreeEventKind::Document => !matches!(event_kind, EventKind::Modify(_)),
        ContentTreeEventKind::Schema => !matches!(event_kind, EventKind::Modify(_)),
        ContentTreeEventKind::Folder => true,
    }
}

fn affects_metadata(kind: ContentTreeEventKind, path: &Path, event_kind: &EventKind) -> bool {
    match kind {
        ContentTreeEventKind::Document => {
            matches!(event_kind, EventKind::Modify(_)) || is_readme_path(path)
        }
        ContentTreeEventKind::Schema | ContentTreeEventKind::Folder => false,
    }
}

fn parent_path_for_rel(rel_path: &str) -> String {
    Path::new(rel_path)
        .parent()
        .and_then(|parent| repo_relative_from_path_or_root(parent))
        .unwrap_or_default()
}

fn repo_relative_from_path_or_root(path: &Path) -> Option<String> {
    match repo_relative_from_path(path, RootMode::Allow).ok()? {
        root if root == "." => Some(String::new()),
        rel => Some(rel),
    }
}

fn merge_event_kind(current: EventKind, next: EventKind) -> EventKind {
    match next {
        EventKind::Remove(_) => next,
        EventKind::Create(_) => next,
        EventKind::Modify(_) if matches!(current, EventKind::Create(_) | EventKind::Remove(_)) => {
            current
        }
        _ => next,
    }
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
    is_markdown_path(path) || is_schema_path(path)
}

fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
}

fn is_readme_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("README.md"))
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

    fn classify(
        tmp: &TempDir,
        path: &Path,
        event_kind: EventKind,
    ) -> Option<ContentTreeEventClassification> {
        let policy = TreeIgnorePolicy::from_space_root(tmp.path());
        classify_content_tree_event(tmp.path(), &policy, path, &event_kind)
    }

    #[test]
    fn watcher_classifies_regular_markdown_payload_fields() {
        let tmp = TempDir::new().unwrap();
        let docs = tmp.path().join("docs");
        std::fs::create_dir_all(&docs).unwrap();
        let doc = docs.join("note.md");
        std::fs::write(&doc, "body").unwrap();

        let classification = classify(&tmp, &doc, EventKind::Create(CreateKind::File)).unwrap();

        assert_eq!(classification.rel_path, "docs/note.md");
        assert_eq!(classification.kind, ContentTreeEventKind::Document);
        assert!(!classification.is_dir);
        assert_eq!(classification.parent_path, "docs");
        assert!(classification.affects_tree);
        assert!(!classification.affects_metadata);
    }

    #[test]
    fn watcher_classifies_readme_change_as_folder_metadata_update() {
        let tmp = TempDir::new().unwrap();
        let folder = tmp.path().join("docs");
        std::fs::create_dir_all(&folder).unwrap();
        let readme = folder.join("README.md");
        std::fs::write(&readme, "---\ntitle: Docs\n---\n").unwrap();

        let classification = classify(&tmp, &readme, EventKind::Modify(ModifyKind::Any)).unwrap();

        assert_eq!(classification.rel_path, "docs/README.md");
        assert_eq!(classification.kind, ContentTreeEventKind::Document);
        assert_eq!(classification.parent_path, "docs");
        assert!(!classification.affects_tree);
        assert!(classification.affects_metadata);
    }

    #[test]
    fn watcher_classifies_schema_marker_updates() {
        let tmp = TempDir::new().unwrap();
        let collection = tmp.path().join("tasks");
        std::fs::create_dir_all(&collection).unwrap();
        let schema = collection.join("schema.yaml");

        let classification = classify(&tmp, &schema, EventKind::Remove(RemoveKind::File)).unwrap();

        assert_eq!(classification.rel_path, "tasks/schema.yaml");
        assert_eq!(classification.kind, ContentTreeEventKind::Schema);
        assert!(!classification.is_dir);
        assert_eq!(classification.parent_path, "tasks");
        assert!(classification.affects_tree);
        assert!(!classification.affects_metadata);
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
        assert!(classify(&tmp, &ignored_doc, EventKind::Modify(ModifyKind::Any)).is_none());
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

    #[test]
    fn watcher_classifies_deleted_dot_markdown_as_file_path() {
        let tmp = TempDir::new().unwrap();
        let deleted_doc = tmp.path().join(".notes.md");
        let policy = TreeIgnorePolicy::from_space_root(tmp.path());

        assert_eq!(
            path_kind(&deleted_doc, &EventKind::Remove(RemoveKind::File)),
            TreePathKind::File
        );
        assert!(should_emit_content_tree_event(&policy, &deleted_doc));
    }

    #[test]
    fn watcher_classifies_deleted_folder_from_event_kind_when_path_is_gone() {
        let tmp = TempDir::new().unwrap();
        let deleted_folder = tmp.path().join("archive");

        let classification =
            classify(&tmp, &deleted_folder, EventKind::Remove(RemoveKind::Folder)).unwrap();

        assert_eq!(classification.rel_path, "archive");
        assert_eq!(classification.kind, ContentTreeEventKind::Folder);
        assert!(classification.is_dir);
        assert_eq!(classification.parent_path, "");
        assert!(classification.affects_tree);
        assert!(!classification.affects_metadata);
    }

    #[test]
    fn watcher_does_not_emit_content_tree_event_for_deleted_non_document_file() {
        let tmp = TempDir::new().unwrap();
        let deleted_asset = tmp.path().join("image.png");

        assert!(classify(&tmp, &deleted_asset, EventKind::Remove(RemoveKind::File)).is_none());
    }
}

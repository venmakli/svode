use notify::event::{CreateKind, ModifyKind, RemoveKind, RenameMode};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::agent_context::AgentContextState;
use crate::apps::{APP_SOURCE_CHANGED_EVENT, AppSourceState, DOCUMENT_SOURCE_CHANGED_EVENT};
use crate::error::AppError;
use crate::files::tree::{child_folder_names, has_direct_schema};
use crate::index::update::IndexUpdateState;
use crate::index::{IndexKey, IndexState};
use crate::repo_path::{RootMode, repo_relative_from_base, repo_relative_from_path};
use crate::routines::{
    CollectionEventOrigin, CollectionEventSourceKind, RoutineInvalidationPayload, RoutineOwnerKind,
};
use svode_core::agent_adapters::PROJECT_INSTRUCTION_FILE_NAMES;
use svode_core::content_tree::policy::{TreeIgnorePolicy, TreePathKind};
use svode_core::page::nonce::WriteNonceRegistry;
use svode_core::routines::parser as routine_parser;

struct WatcherHandle {
    _watcher: RecommendedWatcher,
    _actors: super::actor_observation::ActorObservation,
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

        let actors = {
            let git_state = app.state::<crate::git::GitState>();
            crate::git::require_cli(&git_state).and_then(|cli| {
                let actor_app = app.clone();
                let git_app = app.clone();
                let watched_space = space_path.clone();
                super::actor_observation::ActorObservation::start(
                    cli,
                    space_path.clone(),
                    move |repository| {
                        if let Err(error) =
                            crate::actors::invalidate_repository(&actor_app, repository)
                        {
                            tracing::warn!("actor observation invalidation failed: {error}");
                        }
                    },
                    move |repository| {
                        crate::git::delivery::emit_committed(&git_app, &watched_space, repository);
                        // Leaving a merge or a detached HEAD lets waiting
                        // edits become versions (Stage 11 1.E).
                        crate::git::auto_versions::touched(&git_app, &watched_space);
                    },
                )
            })?
        };

        // Edits left from an earlier run become versions after the pause.
        crate::git::auto_versions::touched(&app, &space_path);

        // Spawn debounce thread
        let sp = space.clone();
        let root_schema_present = has_direct_schema(&space_path);
        std::thread::spawn(move || {
            debounce_loop(event_rx, stop_rx, &sp, &app, root_schema_present);
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
                _actors: actors,
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
    mut root_schema_present: bool,
) {
    let debounce = Duration::from_millis(200);
    let mut attachments_generation = 0_u64;

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
                process_events(
                    &events,
                    space,
                    app,
                    &mut root_schema_present,
                    &mut attachments_generation,
                );
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
fn process_events(
    events: &[Event],
    space: &str,
    app: &AppHandle,
    root_schema_present: &mut bool,
    attachments_generation: &mut u64,
) {
    let nonces = app.state::<Arc<WriteNonceRegistry>>();
    if let Err(error) = nonces.with_source_publication(|| {
        process_published_events(
            events,
            space,
            app,
            root_schema_present,
            attachments_generation,
        );
        Ok(())
    }) {
        tracing::warn!("watcher source publication failed: {error}");
    }
}

fn process_published_events(
    events: &[Event],
    space: &str,
    app: &AppHandle,
    root_schema_present: &mut bool,
    attachments_generation: &mut u64,
) {
    // Deduplicate by path while preserving structural create/delete semantics.
    // Backends often report Create followed by Modify for the same file within
    // one debounce window; the sidebar still needs this as `file:created`.
    let mut seen: HashMap<PathBuf, EventKind> = HashMap::new();
    let mut any_dirty = false;
    // System settings files are hidden from the tree but committed by the
    // automatic commits of their repository (Stage 11 1.E, DF-322).
    let mut system_changed = false;
    let mut any_assets_changed = false;
    let mut any_tree_changed = false;
    let mut visibility_policy_changed = false;
    let mut spaces_config_changed = false;
    let mut membership_only_paths: HashMap<PathBuf, ContentTreeEventKind> = HashMap::new();
    let mut variable_owners = BTreeSet::new();
    let mut agent_context_paths = BTreeSet::new();
    let mut agent_context_targets = BTreeSet::new();
    let mut routine_owner_paths = BTreeSet::new();
    let mut agent_actor_owners = BTreeSet::new();
    let mut attachment_invalidations =
        BTreeMap::<String, BTreeMap<String, AttachmentInvalidationKind>>::new();
    // Sources that a Svode write of any process replaced in place.
    let mut replaced_in_place = BTreeSet::new();
    let mut vanished_directories = HashSet::new();
    let space_root = Path::new(space);
    let policy = TreeIgnorePolicy::from_space_root(space_root);
    let skip_dirs = child_folder_names(space_root);
    // Open static Apps and HTML Documents reload from their roots,
    // git-ignored files included, so their check comes before any tree
    // filtering.
    let app_sources = app.state::<AppSourceState>();
    let canonical_space_root = app_sources
        .is_serving()
        .then(|| std::fs::canonicalize(space_root).ok())
        .flatten();
    let mut changed_app_sources = BTreeSet::new();
    let mut changed_documents = BTreeSet::new();
    for event in events.iter().filter(|event| changes_files(event)) {
        for (path_index, path) in event.paths.iter().enumerate() {
            let (event_kind, vanished_directory) =
                path_event_kind(space_root, &policy, &skip_dirs, event, path_index);
            if vanished_directory {
                vanished_directories.insert(path.clone());
            }
            if let Some(canonical_space_root) = &canonical_space_root {
                let canonical_path = canonical_event_path(space_root, canonical_space_root, path);
                // The files of a removed folder report their own removal; a
                // directory that left at once is itself the change of its files.
                let removed_directory = event_kind_is_folder(&event_kind) && !vanished_directory;
                changed_app_sources
                    .extend(app_sources.sources_changed_by(&canonical_path, removed_directory));
                changed_documents
                    .extend(app_sources.documents_changed_by(&canonical_path, removed_directory));
            }
            if let Some(source) = svode_core::page::store::replaced_by_staged_copy(path) {
                replaced_in_place.insert(source);
            }
            if path
                .parent()
                .is_some_and(|parent| parent.file_name().is_some_and(|name| name == ".svode"))
                && path.file_name().is_some_and(|name| {
                    matches!(
                        name.to_str(),
                        Some("config.json" | "local.json" | "variables.pending.json")
                    )
                })
            {
                variable_owners.insert(path.parent().unwrap().to_path_buf());
            }
            for invalidation in classify_attachment_invalidations(space_root, path, &event_kind) {
                attachment_invalidations
                    .entry(invalidation.owner_path)
                    .or_default()
                    .entry(invalidation.path)
                    .and_modify(|current| {
                        *current = current.merge(invalidation.kind);
                    })
                    .or_insert(invalidation.kind);
            }
            visibility_policy_changed =
                visibility_policy_changed || is_visibility_policy_path(space_root, path);
            system_changed = system_changed || is_system_settings_path(space_root, path);
            spaces_config_changed = spaces_config_changed
                || relative_watched_path(space_root, path).as_deref() == Some(".svode/config.json");
            if let Some(kind) =
                classify_membership_index_event(space_root, &policy, &skip_dirs, path, &event_kind)
                && classify_content_tree_event(space_root, &policy, &skip_dirs, path, &event_kind)
                    .is_none()
            {
                membership_only_paths.insert(path.clone(), kind);
            }
            if let Some(owner_path) = relative_watched_path(space_root, path)
                .as_deref()
                .and_then(routine_parser::definition_file_owner_path)
                && !is_under_child_space(&owner_path, &skip_dirs)
            {
                routine_owner_paths.insert(owner_path);
            }
            if let Some(owner) = agent_actor_owner_for_path(space_root, path)
                && relative_watched_path(space_root, &owner)
                    .is_none_or(|relative| !is_under_child_space(&relative, &skip_dirs))
            {
                agent_actor_owners.insert(owner);
            }
            let standard_agent_context_path = agent_context_observed_path(space_root, path);
            let observing_targets = app
                .state::<AgentContextState>()
                .targets_observing_project_path(path);
            if standard_agent_context_path.is_some() || !observing_targets.is_empty() {
                if let Some(relative) = relative_watched_path(space_root, path) {
                    agent_context_paths.insert(relative);
                }
                agent_context_targets.extend(observing_targets);
                if standard_agent_context_path
                    .as_deref()
                    .is_some_and(|relative| !is_under_child_space(relative, &skip_dirs))
                {
                    agent_context_targets.insert(space.to_string());
                }
                // Another observed source, such as `opencode.json`, may
                // also be content of the Space.
                if standard_agent_context_path.is_some() {
                    continue;
                }
            }
            // Detect `.assets/`-scoped changes so we can emit a targeted
            // event for the storage reactor to re-scan the assets table.
            if is_under_assets(path, space_root) {
                any_assets_changed = true;
                any_dirty = true;
            }

            // Any non-ignored file change → space is dirty.
            // Includes non-.md assets (frontend uses this to refresh git status).
            if !policy.is_ignored_abs(path, path_kind(path, &event_kind)) {
                any_dirty = true;
            }
            // Per-file file:* events are emitted for pages and
            // collection schemas. Schema changes are derived-state inputs only;
            // they do not trigger autocommit from the watcher.
            let Some(classification) =
                classify_content_tree_event(space_root, &policy, &skip_dirs, path, &event_kind)
            else {
                continue;
            };
            any_tree_changed =
                any_tree_changed || classification.affects_tree || classification.affects_metadata;
            seen.entry(path.clone())
                .and_modify(|current| *current = merge_event_kind(*current, event_kind))
                .or_insert(event_kind);
        }
    }

    report_replacements_as_changes(&mut seen, &replaced_in_place);
    let (current_root_schema_present, root_schema_changed) =
        queue_root_schema_transition(&mut seen, space_root, *root_schema_present);
    *root_schema_present = current_root_schema_present;
    if root_schema_changed {
        any_dirty = true;
        any_tree_changed = true;
        attachment_invalidations
            .entry(".".to_string())
            .or_default()
            .insert(
                "schema.yaml".to_string(),
                AttachmentInvalidationKind::Boundary,
            );
    }

    for capability_token in changed_app_sources {
        let _ = app.emit(
            APP_SOURCE_CHANGED_EVENT,
            serde_json::json!({ "capabilityToken": capability_token }),
        );
    }
    for capability_token in changed_documents {
        let _ = app.emit(
            DOCUMENT_SOURCE_CHANGED_EVENT,
            serde_json::json!({ "capabilityToken": capability_token }),
        );
    }

    emit_attachment_invalidations(
        app,
        space,
        &attachment_invalidations,
        attachments_generation,
    );

    for owner_path in routine_owner_paths {
        emit_routine_invalidation(space_root, &owner_path, app);
    }
    for owner in agent_actor_owners {
        crate::agent_actors::commands::emit_catalog_invalidation(app, &owner);
    }
    for owner_path in variable_owners {
        let _ = app.emit(
            crate::commands::app_variables::APP_VARIABLES_CHANGED_EVENT,
            serde_json::json!({ "ownerPath": owner_path }),
        );
    }
    if any_dirty || system_changed {
        crate::git::auto_versions::touched(app, space_root);
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
    if !agent_context_paths.is_empty() {
        let paths = agent_context_paths.into_iter().collect::<Vec<_>>();
        let targets = agent_context_targets.into_iter().collect::<Vec<_>>();
        for target in &targets {
            let _ = app.emit(
                "agent-context:changed",
                serde_json::json!({ "spacePath": target, "paths": paths }),
            );
        }
        for target in targets {
            tauri::async_runtime::block_on(async {
                let state = app.state::<IndexState>();
                if let Err(error) = crate::index::update::refresh_agent_context_projection(
                    &state,
                    Path::new(&target),
                )
                .await
                {
                    tracing::warn!(
                        "watcher Agent Context knowledge refresh failed for {target}: {error}"
                    );
                }
            });
        }
    }

    // The Spaces of an open project follow its root config; a Space folder
    // that joined or left rebuilds the root index already.
    let root_rebuilds = spaces_config_changed && pick_up_spaces(space_root, app);

    let nonces = app.state::<Arc<WriteNonceRegistry>>();
    let membership_requires_rebuild = membership_only_paths
        .values()
        .any(|kind| *kind == ContentTreeEventKind::Schema);
    if (visibility_policy_changed && !root_rebuilds) || membership_requires_rebuild {
        sync_index_for_visibility_change(space_root, app, visibility_policy_changed);
    } else {
        for (path, kind) in membership_only_paths {
            let write_metadata = nonces.take_metadata(&path);
            let origin = write_metadata
                .map(|metadata| CollectionEventOrigin {
                    source_kind: CollectionEventSourceKind::Managed,
                    origin: Some(metadata.origin),
                    routine_run_id: metadata.routine_run_id,
                })
                .unwrap_or_else(CollectionEventOrigin::watcher);
            sync_index_for_watched_path(space_root, &path, kind, app, origin);
        }
    }

    for (path, kind) in seen {
        let Some(classification) =
            classify_content_tree_event(space_root, &policy, &skip_dirs, &path, &kind)
        else {
            continue;
        };

        let Some(event_name) = file_event_name(&kind) else {
            continue;
        };

        let write_metadata = nonces.take_metadata(&path);
        let event_origin = if let Some(metadata) = write_metadata.as_ref() {
            CollectionEventOrigin {
                source_kind: CollectionEventSourceKind::Managed,
                origin: Some(metadata.origin.clone()),
                routine_run_id: metadata.routine_run_id.clone(),
            }
        } else {
            CollectionEventOrigin::watcher()
        };
        let vanished_sources = if matches!(kind, EventKind::Remove(_))
            && vanished_directories.contains(&path)
        {
            sync_index_for_vanished_directory(space_root, &path, app, event_origin)
        } else {
            sync_index_for_watched_path(space_root, &path, classification.kind, app, event_origin);
            Vec::new()
        };

        // Only `file:changed` exposes writeNonce to the frontend. Metadata is
        // still consumed for creates so Collection events retain managed origin.
        let nonce = matches!(kind, EventKind::Modify(_))
            .then(|| write_metadata.map(|metadata| metadata.nonce))
            .flatten();
        let _ = app.emit(
            event_name,
            file_event_payload(space, &classification, nonce),
        );
        for removal in vanished_source_removals(space_root, &policy, &skip_dirs, &vanished_sources)
        {
            let _ = app.emit("file:deleted", file_event_payload(space, &removal, None));
        }
    }
}

fn file_event_payload(
    space: &str,
    classification: &ContentTreeEventClassification,
    nonce: Option<String>,
) -> serde_json::Value {
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
    payload
}

/// The removal of each indexed Markdown source of a directory that left at
/// once, as `rm -r` reports it file by file: consumers that follow the
/// sources, such as a Collection table, see them go (DF-258 R3).
fn vanished_source_removals(
    space_root: &Path,
    policy: &TreeIgnorePolicy,
    skip_dirs: &HashSet<String>,
    sources: &[PathBuf],
) -> Vec<ContentTreeEventClassification> {
    let removed = EventKind::Remove(RemoveKind::File);
    sources
        .iter()
        .filter_map(|source| {
            classify_content_tree_event(space_root, policy, skip_dirs, source, &removed)
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum AttachmentInvalidationKind {
    Page,
    Binary,
    Boundary,
}

impl AttachmentInvalidationKind {
    fn as_payload_str(self) -> &'static str {
        match self {
            Self::Page => "page",
            Self::Binary => "binary",
            Self::Boundary => "boundary",
        }
    }

    fn merge(self, next: Self) -> Self {
        self.max(next)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AttachmentInvalidation {
    owner_path: String,
    path: String,
    kind: AttachmentInvalidationKind,
}

fn classify_attachment_invalidations(
    space_root: &Path,
    path: &Path,
    event_kind: &EventKind,
) -> Vec<AttachmentInvalidation> {
    let Some(relative) = relative_watched_path(space_root, path) else {
        return Vec::new();
    };
    if relative == ".svode/config.json" {
        return vec![AttachmentInvalidation {
            owner_path: ".".to_string(),
            path: relative,
            kind: AttachmentInvalidationKind::Boundary,
        }];
    }

    let components = relative.split('/').collect::<Vec<_>>();
    if components.is_empty() || components[0].starts_with('.') {
        return Vec::new();
    }
    let name = components.last().copied().unwrap_or_default();
    if is_attachment_sidecar(name) || agent_context_observed_path(space_root, path).is_some() {
        return Vec::new();
    }

    let parent = if components.len() <= 1 {
        ".".to_string()
    } else {
        components[..components.len() - 1].join("/")
    };
    let grandparent = if components.len() <= 2 {
        ".".to_string()
    } else {
        components[..components.len() - 2].join("/")
    };
    let is_schema = name == "schema.yaml";
    let is_readme = name.eq_ignore_ascii_case("README.md");
    let is_folder = is_folder_content_tree_event(path, event_kind);

    if is_schema || name == "app.yaml" {
        let mut invalidations = vec![AttachmentInvalidation {
            owner_path: parent.clone(),
            path: relative.clone(),
            kind: AttachmentInvalidationKind::Boundary,
        }];
        if components.len() >= 2 {
            invalidations.push(AttachmentInvalidation {
                owner_path: grandparent,
                path: relative,
                kind: AttachmentInvalidationKind::Boundary,
            });
        }
        invalidations.sort_by(|left, right| left.owner_path.cmp(&right.owner_path));
        invalidations.dedup_by(|left, right| left.owner_path == right.owner_path);
        return invalidations;
    }
    if is_readme {
        return vec![AttachmentInvalidation {
            owner_path: grandparent,
            path: relative,
            kind: AttachmentInvalidationKind::Page,
        }];
    }
    if is_folder {
        return vec![AttachmentInvalidation {
            owner_path: parent,
            path: relative,
            kind: AttachmentInvalidationKind::Boundary,
        }];
    }
    if is_markdown_path(path) {
        return vec![AttachmentInvalidation {
            owner_path: parent,
            path: relative,
            kind: AttachmentInvalidationKind::Page,
        }];
    }
    if crate::attachments::source::classify_binary_path(path).is_some()
        || svode_core::attachments::format::is_html_path(path)
    {
        return vec![AttachmentInvalidation {
            owner_path: parent,
            path: relative,
            kind: AttachmentInvalidationKind::Binary,
        }];
    }
    Vec::new()
}

fn emit_attachment_invalidations(
    app: &AppHandle,
    space: &str,
    invalidations: &BTreeMap<String, BTreeMap<String, AttachmentInvalidationKind>>,
    generation: &mut u64,
) {
    if invalidations.is_empty() {
        return;
    }
    *generation = generation.wrapping_add(1);
    for (owner_path, changes) in invalidations {
        let changes = changes
            .iter()
            .map(|(path, kind)| {
                serde_json::json!({
                    "path": path,
                    "kind": kind.as_payload_str(),
                })
            })
            .collect::<Vec<_>>();
        let _ = app.emit(
            "attachments:invalidated",
            serde_json::json!({
                "spacePath": space,
                "ownerPath": owner_path,
                "generation": *generation,
                "changes": changes,
            }),
        );
    }
}

fn is_attachment_sidecar(name: &str) -> bool {
    let lowercase = name.to_ascii_lowercase();
    name.starts_with("~$")
        || name.starts_with('#') && name.ends_with('#')
        || name.ends_with('~')
        || matches!(
            lowercase.as_str(),
            "readme.md~" | "thumbs.db" | "desktop.ini"
        )
        || matches!(
            Path::new(&lowercase)
                .extension()
                .and_then(|value| value.to_str()),
            Some("tmp" | "temp" | "lock" | "swp" | "swo")
        )
}

fn emit_routine_invalidation(space_root: &Path, owner_path: &str, app: &AppHandle) {
    tauri::async_runtime::block_on(async {
        let canonical_space_root =
            std::fs::canonicalize(space_root).unwrap_or_else(|_| space_root.to_path_buf());
        let index_state = app.state::<IndexState>();
        let key = index_state
            .key_for_space_dir(&canonical_space_root)
            .await
            .unwrap_or_else(|| IndexKey::Root(canonical_space_root.clone()));
        let owner_kind =
            RoutineOwnerKind::for_owner_path(owner_path, matches!(key, IndexKey::Root(_)));
        crate::routines::emit_invalidation(
            app,
            RoutineInvalidationPayload {
                project_path: key.project().to_string_lossy().into_owned(),
                space_path: canonical_space_root.to_string_lossy().into_owned(),
                owner_kind,
                owner_path: owner_path.to_string(),
            },
        );
    });
}

fn agent_actor_owner_for_path(space_root: &Path, path: &Path) -> Option<PathBuf> {
    let relative = relative_watched_path(space_root, path)?;
    let normalized = relative.replace('\\', "/");
    let suffix = if normalized.ends_with("/.svode/agent-actors.json") {
        "/.svode/agent-actors.json"
    } else if normalized.ends_with("/.svode/local.json") {
        "/.svode/local.json"
    } else if matches!(
        normalized.as_str(),
        ".svode/agent-actors.json" | ".svode/local.json"
    ) {
        return Some(space_root.to_path_buf());
    } else {
        return None;
    };
    Some(space_root.join(normalized.strip_suffix(suffix)?))
}

fn sync_index_for_watched_path(
    space_root: &Path,
    path: &Path,
    kind: ContentTreeEventKind,
    app: &AppHandle,
    origin: CollectionEventOrigin,
) {
    if matches!(
        kind,
        ContentTreeEventKind::Folder | ContentTreeEventKind::App
    ) {
        return;
    }

    tauri::async_runtime::block_on(async {
        let state = app.state::<IndexState>();
        let updates = app.state::<IndexUpdateState>();
        let key = state
            .key_for_space_dir(space_root)
            .await
            .unwrap_or_else(|| IndexKey::Root(space_root.to_path_buf()));

        if is_schema_path(path) {
            if let Err(e) = crate::index::service::repair_space(&state, &updates, &key).await {
                tracing::warn!("watcher full reindex failed for {:?}: {e}", key);
            }
            return;
        }

        let project = key.project().to_path_buf();
        if let Err(e) =
            crate::index::update::publish_path_with_origin(&state, &updates, &project, path, origin)
                .await
        {
            tracing::warn!("watcher index update failed for {}: {e}", path.display());
        }
    });
}

/// Indexed sources under a directory that left at once report no removal of
/// their own, so the directory publishes it for them. Returns those sources.
fn sync_index_for_vanished_directory(
    space_root: &Path,
    path: &Path,
    app: &AppHandle,
    origin: CollectionEventOrigin,
) -> Vec<PathBuf> {
    tauri::async_runtime::block_on(async {
        let state = app.state::<IndexState>();
        let updates = app.state::<IndexUpdateState>();
        let key = state
            .key_for_space_dir(space_root)
            .await
            .unwrap_or_else(|| IndexKey::Root(space_root.to_path_buf()));
        crate::index::update::publish_removed_directory_with_origin(
            &state,
            &updates,
            key.project(),
            path,
            origin,
        )
        .await
        .unwrap_or_else(|e| {
            tracing::warn!(
                "watcher index update failed for removed directory {}: {e}",
                path.display()
            );
            Vec::new()
        })
    })
}

/// Follows a change of `spaces` in the root config of an open project made
/// by another process or outside Svode (Stage 11 05 «Открытый Desktop
/// следует `spaces` на диске»). The config of a child Space lists no Spaces.
/// Returns whether a Space folder joined or left, which rebuilds the root
/// index.
fn pick_up_spaces(space_root: &Path, app: &AppHandle) -> bool {
    tauri::async_runtime::block_on(async {
        let Some(IndexKey::Root(project)) = app
            .state::<IndexState>()
            .key_for_space_dir(space_root)
            .await
        else {
            return false;
        };
        match app
            .state::<crate::project_runtime::ProjectRuntimeState>()
            .pick_up_spaces(app, &project)
            .await
        {
            Ok(change) => change.moves_folders(),
            Err(error) => {
                tracing::info!("spaces of {} not picked up: {error}", project.display());
                false
            }
        }
    })
}

fn sync_index_for_visibility_change(
    space_root: &Path,
    app: &AppHandle,
    invalidate_backlinks: bool,
) {
    tauri::async_runtime::block_on(async {
        let state = app.state::<IndexState>();
        let updates = app.state::<IndexUpdateState>();
        let key = state
            .key_for_space_dir(space_root)
            .await
            .unwrap_or_else(|| IndexKey::Root(space_root.to_path_buf()));
        if let Err(error) = crate::index::service::repair_space(&state, &updates, &key).await {
            tracing::warn!("watcher visibility reindex failed for {:?}: {error}", key);
        }
        if invalidate_backlinks {
            state.invalidate_project_backlinks(key.project()).await;
        }
    });
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ContentTreeEventKind {
    Page,
    Schema,
    App,
    Folder,
}

impl ContentTreeEventKind {
    fn as_payload_str(self) -> &'static str {
        match self {
            Self::Page => "page",
            Self::Schema => "schema",
            Self::App => "app",
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
    skip_dirs: &HashSet<String>,
    path: &Path,
    event_kind: &EventKind,
) -> Option<ContentTreeEventClassification> {
    let tree_kind = path_kind(path, event_kind);
    let is_root_marker =
        (is_schema_path(path) || is_app_manifest_path(path)) && path.parent() == Some(space_root);
    if policy.is_ignored_abs(path, tree_kind) && !is_root_marker {
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
    if is_under_child_space(&rel_path, skip_dirs) {
        return None;
    }
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

fn classify_membership_index_event(
    space_root: &Path,
    policy: &TreeIgnorePolicy,
    skip_dirs: &HashSet<String>,
    path: &Path,
    event_kind: &EventKind,
) -> Option<ContentTreeEventKind> {
    let kind = content_tree_event_kind(path, event_kind)?;
    if matches!(
        kind,
        ContentTreeEventKind::Folder | ContentTreeEventKind::App
    ) || policy.is_system_ignored_abs(path, path_kind(path, event_kind))
    {
        return None;
    }
    let rel_path = repo_relative_from_base(space_root, path, RootMode::Reject).ok()?;
    (!is_under_child_space(&rel_path, skip_dirs)).then_some(kind)
}

fn is_visibility_policy_path(space_root: &Path, path: &Path) -> bool {
    relative_watched_path(space_root, path)
        .is_some_and(|path| matches!(path.as_str(), ".gitignore" | ".svode/config.json"))
}

fn is_system_settings_path(space_root: &Path, path: &Path) -> bool {
    relative_watched_path(space_root, path)
        .is_some_and(|path| svode_core::git::versions::is_system_path(&path))
}

fn is_under_child_space(rel_path: &str, skip_dirs: &HashSet<String>) -> bool {
    skip_dirs.iter().any(|child| {
        !child.is_empty() && (rel_path == child || rel_path.starts_with(&format!("{child}/")))
    })
}

fn agent_context_observed_path(space_root: &Path, path: &Path) -> Option<String> {
    let relative = relative_watched_path(space_root, path)?;
    let normalized = relative.replace('\\', "/");
    let basename = Path::new(&normalized)
        .file_name()
        .and_then(|name| name.to_str())?;
    let standard = PROJECT_INSTRUCTION_FILE_NAMES.contains(&basename);
    let recognized_root = !normalized.contains('/')
        && matches!(basename, "GEMINI.md" | "SOUL.md" | "USER.md" | "MEMORY.md");
    let exact_config = matches!(
        normalized.as_str(),
        ".claude/CLAUDE.md" | ".codex/config.toml" | ".svode/local.json"
    );
    let skill_path = normalized
        .split('/')
        .collect::<Vec<_>>()
        .windows(2)
        .any(|parts| matches!(parts, [".agents", "skills"] | [".claude", "skills"]));
    (standard || recognized_root || exact_config || skill_path).then_some(normalized)
}

/// The event path under the canonical Space root, whichever of the two
/// spellings of the root the backend reported it with.
fn canonical_event_path(space_root: &Path, canonical_space_root: &Path, path: &Path) -> PathBuf {
    path.strip_prefix(space_root).map_or_else(
        |_| path.to_path_buf(),
        |relative| canonical_space_root.join(relative),
    )
}

fn relative_watched_path(space_root: &Path, path: &Path) -> Option<String> {
    path.strip_prefix(space_root)
        .ok()
        .and_then(|relative| repo_relative_from_path(relative, RootMode::Reject).ok())
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
    if is_app_manifest_path(path) {
        return Some(ContentTreeEventKind::App);
    }
    if is_markdown_path(path) {
        return Some(ContentTreeEventKind::Page);
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
        ContentTreeEventKind::Page => !matches!(event_kind, EventKind::Modify(_)),
        ContentTreeEventKind::Schema | ContentTreeEventKind::App => {
            !matches!(event_kind, EventKind::Modify(_))
        }
        ContentTreeEventKind::Folder => true,
    }
}

fn affects_metadata(kind: ContentTreeEventKind, path: &Path, event_kind: &EventKind) -> bool {
    match kind {
        ContentTreeEventKind::Page => {
            matches!(event_kind, EventKind::Modify(_)) || is_readme_path(path)
        }
        ContentTreeEventKind::Schema | ContentTreeEventKind::App | ContentTreeEventKind::Folder => {
            false
        }
    }
}

fn parent_path_for_rel(rel_path: &str) -> String {
    Path::new(rel_path)
        .parent()
        .and_then(repo_relative_from_path_or_root)
        .unwrap_or_default()
}

fn repo_relative_from_path_or_root(path: &Path) -> Option<String> {
    match repo_relative_from_path(path, RootMode::Allow).ok()? {
        root if root == "." => Some(String::new()),
        rel => Some(rel),
    }
}

/// A source replaced in place from a staged copy existed before and still
/// exists: backends that report the rename as a creation of the source get
/// a change, so the editor filters its own write or reloads another one.
/// Whether an event can change files. Opening and closing a file (inotify
/// reports both, closing after every write) changes nothing by itself, and a
/// close after a write must not replace the change already recorded for it.
fn changes_files(event: &Event) -> bool {
    !matches!(event.kind, EventKind::Access(_))
}

fn report_replacements_as_changes(
    seen: &mut HashMap<PathBuf, EventKind>,
    replaced_in_place: &BTreeSet<PathBuf>,
) {
    for source in replaced_in_place {
        if let Some(kind) = seen.get_mut(source)
            && matches!(kind, EventKind::Create(_))
            && source.is_file()
        {
            *kind = EventKind::Modify(ModifyKind::Data(notify::event::DataChange::Content));
        }
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

fn queue_root_schema_transition(
    seen: &mut HashMap<PathBuf, EventKind>,
    space_root: &Path,
    previous: bool,
) -> (bool, bool) {
    let current = has_direct_schema(space_root);
    if current == previous {
        return (current, false);
    }

    seen.entry(space_root.join("schema.yaml"))
        .or_insert_with(|| {
            if current {
                EventKind::Create(CreateKind::File)
            } else {
                EventKind::Remove(RemoveKind::File)
            }
        });
    (current, true)
}

fn file_event_name(kind: &EventKind) -> Option<&'static str> {
    match kind {
        EventKind::Create(_) => Some("file:created"),
        EventKind::Modify(_) => Some("file:changed"),
        EventKind::Remove(_) => Some("file:deleted"),
        _ => None,
    }
}

/// The kind of one path of `event` for every consumer of the watcher, and
/// whether the path is a directory that left at once. Such a directory of
/// Space content is a folder removal, as with `rm -r` (DF-258).
fn path_event_kind(
    space_root: &Path,
    policy: &TreeIgnorePolicy,
    skip_dirs: &HashSet<String>,
    event: &Event,
    path_index: usize,
) -> (EventKind, bool) {
    if is_vanished_directory(space_root, policy, skip_dirs, event, path_index) {
        (EventKind::Remove(RemoveKind::Folder), true)
    } else {
        (event_kind_for_path(event, path_index), false)
    }
}

/// A path that left the disk by a rename of any mode, or by a removal
/// without a kind (Windows), and is not a document, a marker, hidden from
/// the content tree or under a child Space: a directory moved or renamed
/// away, put in the Trash or deleted through a tombstone. A file outside the
/// tree may also match; its folder removal only re-reads the parent.
fn is_vanished_directory(
    space_root: &Path,
    policy: &TreeIgnorePolicy,
    skip_dirs: &HashSet<String>,
    event: &Event,
    path_index: usize,
) -> bool {
    let path = &event.paths[path_index];
    let left = match event.kind {
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => {
            path_index == 0 && event.paths.len() >= 2
        }
        EventKind::Modify(ModifyKind::Name(
            RenameMode::From | RenameMode::Any | RenameMode::Other,
        ))
        | EventKind::Remove(RemoveKind::Any | RemoveKind::Other) => true,
        _ => false,
    };
    left && !is_document_or_schema(path)
        && std::fs::symlink_metadata(path).is_err()
        && relative_watched_path(space_root, path)
            .is_some_and(|relative| !is_under_child_space(&relative, skip_dirs))
        && !policy.is_ignored_abs(path, TreePathKind::Directory)
}

fn event_kind_for_path(event: &Event, path_index: usize) -> EventKind {
    let path = &event.paths[path_index];
    if !is_schema_path(path) && !is_app_manifest_path(path) {
        return event.kind;
    }

    match event.kind {
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => schema_rename_remove_kind(),
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) => schema_rename_create_kind(),
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) if event.paths.len() >= 2 => {
            if path_index == 0 {
                schema_rename_remove_kind()
            } else {
                schema_rename_create_kind()
            }
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::Any | RenameMode::Other)) => {
            if path.exists() {
                schema_rename_create_kind()
            } else {
                schema_rename_remove_kind()
            }
        }
        _ => event.kind,
    }
}

fn schema_rename_remove_kind() -> EventKind {
    EventKind::Remove(RemoveKind::File)
}

fn schema_rename_create_kind() -> EventKind {
    EventKind::Create(CreateKind::File)
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
    is_markdown_path(path) || is_schema_path(path) || is_app_manifest_path(path)
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

fn is_app_manifest_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == "app.yaml")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::config::write_space_config;
    use crate::space::types::SpaceConfig;
    use svode_core::space_config::TreeSpaceConfig;
    use tempfile::TempDir;

    #[test]
    fn app_marker_invalidates_its_owner_and_containing_snapshot() {
        let root = Path::new("/project");
        for kind in [
            EventKind::Create(CreateKind::File),
            EventKind::Remove(RemoveKind::File),
        ] {
            let invalidations =
                classify_attachment_invalidations(root, &root.join("folder/app.yaml"), &kind);
            let owners = invalidations
                .iter()
                .map(|item| item.owner_path.as_str())
                .collect::<Vec<_>>();
            assert_eq!(owners, vec![".", "folder"]);
        }
    }

    #[test]
    fn watched_routine_paths_reach_the_shared_definition_owner() {
        let root = Path::new("/project");
        let owner = |path: &str| {
            relative_watched_path(root, Path::new(path))
                .as_deref()
                .and_then(routine_parser::definition_file_owner_path)
        };
        assert_eq!(owner("/project/.routines/daily.md"), Some(".".into()));
        assert_eq!(
            owner("/project/tasks/.routines/daily.md"),
            Some("tasks".into())
        );
        assert_eq!(owner("/project/tasks/.routines/nested/daily.md"), None);
    }

    #[test]
    fn agent_actor_paths_are_classified_by_exact_owner() {
        let root = Path::new("/project");
        assert_eq!(
            agent_actor_owner_for_path(root, Path::new("/project/.svode/agent-actors.json")),
            Some(PathBuf::from("/project"))
        );
        assert_eq!(
            agent_actor_owner_for_path(root, Path::new("/project/docs/.svode/agent-actors.json")),
            Some(PathBuf::from("/project/docs"))
        );
    }

    #[test]
    fn event_paths_reach_the_canonical_space_root() {
        let canonical = Path::new("/private/var/space");
        assert_eq!(
            canonical_event_path(
                Path::new("/var/space"),
                canonical,
                Path::new("/var/space/app/a.json")
            ),
            canonical.join("app/a.json")
        );
        assert_eq!(
            canonical_event_path(canonical, canonical, &canonical.join("app/a.json")),
            canonical.join("app/a.json")
        );
        assert_eq!(
            canonical_event_path(
                Path::new("/var/space"),
                canonical,
                &canonical.join("app/a.json")
            ),
            canonical.join("app/a.json")
        );
    }

    #[test]
    fn git_metadata_never_becomes_content_tree_events() {
        let temp = tempfile::tempdir().unwrap();
        let policy = TreeIgnorePolicy::from_space_root(temp.path());
        for relative in [
            ".git",
            ".git/refs",
            ".git/config",
            ".git/modules/child/HEAD",
        ] {
            let path = temp.path().join(relative);
            assert!(
                classify_content_tree_event(
                    temp.path(),
                    &policy,
                    &HashSet::new(),
                    &path,
                    &EventKind::Create(CreateKind::Folder)
                )
                .is_none()
            );
        }
    }

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
                    extensions: Default::default(),
                }),
                extensions: Default::default(),
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
        let skip_dirs = child_folder_names(tmp.path());
        classify_content_tree_event(tmp.path(), &policy, &skip_dirs, path, &event_kind)
    }

    #[test]
    fn attachments_invalidation_is_owner_scoped_and_keeps_page_vocabulary() {
        let root = Path::new("/project");
        let page = classify_attachment_invalidations(
            root,
            Path::new("/project/roadmap.md"),
            &EventKind::Modify(ModifyKind::Any),
        );
        let binary = classify_attachment_invalidations(
            root,
            Path::new("/project/guide.pdf"),
            &EventKind::Create(CreateKind::File),
        );
        let nested_page = classify_attachment_invalidations(
            root,
            Path::new("/project/notes/idea.md"),
            &EventKind::Modify(ModifyKind::Any),
        );

        assert_eq!(
            page,
            vec![AttachmentInvalidation {
                owner_path: ".".into(),
                path: "roadmap.md".into(),
                kind: AttachmentInvalidationKind::Page,
            }]
        );
        assert_eq!(page[0].kind.as_payload_str(), "page");
        assert_eq!(binary[0].kind, AttachmentInvalidationKind::Binary);
        assert_eq!(nested_page[0].owner_path, "notes");
    }

    #[test]
    fn attachments_invalidation_routes_owner_boundary_markers() {
        let root = Path::new("/project");
        let readme = classify_attachment_invalidations(
            root,
            Path::new("/project/roadmap/README.md"),
            &EventKind::Modify(ModifyKind::Any),
        );
        let schema = classify_attachment_invalidations(
            root,
            Path::new("/project/roadmap/schema.yaml"),
            &EventKind::Create(CreateKind::File),
        );
        let registry = classify_attachment_invalidations(
            root,
            Path::new("/project/.svode/config.json"),
            &EventKind::Modify(ModifyKind::Any),
        );

        assert_eq!(readme[0].owner_path, ".");
        assert_eq!(readme[0].kind, AttachmentInvalidationKind::Page);
        assert_eq!(
            schema
                .iter()
                .map(|item| item.owner_path.as_str())
                .collect::<Vec<_>>(),
            vec![".", "roadmap"]
        );
        assert_eq!(registry[0].owner_path, ".");
        assert_eq!(registry[0].kind, AttachmentInvalidationKind::Boundary);
    }

    #[test]
    fn attachments_invalidation_ignores_system_and_unknown_files() {
        let root = Path::new("/project");
        for relative in [
            ".assets/photo.png",
            "AGENTS.md",
            "~$draft.docx",
            "archive.zip",
        ] {
            assert!(
                classify_attachment_invalidations(
                    root,
                    &root.join(relative),
                    &EventKind::Modify(ModifyKind::Any),
                )
                .is_empty(),
                "{relative}"
            );
        }
    }

    /// inotify reports opening and closing the file around every write; the
    /// close after the rename of a managed write must not hide the change.
    #[test]
    fn opening_and_closing_a_written_file_keeps_its_change() {
        use notify::event::{AccessKind, AccessMode, DataChange};
        let page = PathBuf::from("/space/note.md");
        let staged = PathBuf::from("/space/.note.md.01m38ypdj92hj3n7y8x71fwq89.tmp");
        let event = |kind, paths: &[&PathBuf]| {
            paths.iter().fold(Event::new(kind), |event, path| {
                event.add_path((*path).clone())
            })
        };
        let events = [
            event(
                EventKind::Access(AccessKind::Open(AccessMode::Any)),
                &[&page],
            ),
            event(
                EventKind::Access(AccessKind::Close(AccessMode::Write)),
                &[&page],
            ),
            event(EventKind::Create(CreateKind::File), &[&staged]),
            event(
                EventKind::Modify(ModifyKind::Data(DataChange::Any)),
                &[&staged],
            ),
            event(
                EventKind::Modify(ModifyKind::Name(RenameMode::To)),
                &[&page],
            ),
            event(
                EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
                &[&staged, &page],
            ),
            event(
                EventKind::Access(AccessKind::Close(AccessMode::Write)),
                &[&page],
            ),
        ];
        let mut seen: HashMap<PathBuf, EventKind> = HashMap::new();
        for event in events.iter().filter(|event| changes_files(event)) {
            for (index, path) in event.paths.iter().enumerate() {
                let kind = event_kind_for_path(event, index);
                seen.entry(path.clone())
                    .and_modify(|current| *current = merge_event_kind(*current, kind))
                    .or_insert(kind);
            }
        }
        assert!(matches!(seen[&page], EventKind::Modify(_)), "{seen:?}");
    }

    /// A managed write replaces the source from a staged sibling copy. The
    /// OS events of that replacement must still reach the editor as one
    /// `file:changed` of the Page, which carries the write nonce, and the
    /// hidden staged copy must produce no content-tree or attachment event.
    #[test]
    fn an_atomic_managed_write_is_a_page_change_for_the_watcher() {
        let tmp = TempDir::new().unwrap();
        let space = tmp.path().canonicalize().unwrap();
        let page = space.join("note.md");
        std::fs::write(&page, "---\ntitle: Note\n---\nOld body\n").unwrap();

        let (tx, rx) = mpsc::channel::<Event>();
        let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                let _ = tx.send(event);
            }
        })
        .unwrap();
        watcher.watch(&space, RecursiveMode::Recursive).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(500));
        while rx.try_recv().is_ok() {}

        svode_core::page::store::write_under_name_lock(
            space.to_str().unwrap(),
            "note.md",
            "New body\n",
            None,
            None,
            None,
            None,
            None,
            None,
            true,
            None,
            None,
        )
        .unwrap();
        let mut events = Vec::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(1500);
        while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
            match rx.recv_timeout(left) {
                Ok(event) => events.push(event),
                Err(_) => break,
            }
        }
        drop(watcher);

        let policy = TreeIgnorePolicy::from_space_root(&space);
        let skip_dirs = child_folder_names(&space);
        let mut seen: HashMap<PathBuf, EventKind> = HashMap::new();
        let mut replaced = BTreeSet::new();
        for event in events.iter().filter(|event| changes_files(event)) {
            for (index, path) in event.paths.iter().enumerate() {
                let kind = event_kind_for_path(event, index);
                replaced.extend(svode_core::page::store::replaced_by_staged_copy(path));
                assert!(
                    classify_attachment_invalidations(&space, path, &kind)
                        .iter()
                        .all(|invalidation| invalidation.path == "note.md"),
                    "{path:?}: {kind:?}"
                );
                if classify_content_tree_event(&space, &policy, &skip_dirs, path, &kind).is_some() {
                    seen.entry(path.clone())
                        .and_modify(|current| *current = merge_event_kind(*current, kind))
                        .or_insert(kind);
                }
            }
        }
        report_replacements_as_changes(&mut seen, &replaced);
        assert_eq!(
            seen.keys().cloned().collect::<Vec<_>>(),
            vec![page.clone()],
            "{events:?}"
        );
        assert!(
            matches!(seen[&page], EventKind::Modify(_)),
            "{:?}: {events:?}",
            seen[&page]
        );
        assert!(
            std::fs::read_to_string(&page)
                .unwrap()
                .ends_with("New body\n")
        );
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
        assert_eq!(classification.kind, ContentTreeEventKind::Page);
        assert_eq!(classification.kind.as_payload_str(), "page");
        assert!(!classification.is_dir);
        assert_eq!(classification.parent_path, "docs");
        assert!(classification.affects_tree);
        assert!(!classification.affects_metadata);
    }

    #[test]
    fn watcher_targets_agent_context_without_content_tree_events() {
        let tmp = TempDir::new().unwrap();
        let docs = tmp.path().join("docs");
        std::fs::create_dir_all(&docs).unwrap();

        for relative in [
            "AGENTS.md",
            "docs/CLAUDE.local.md",
            "docs/QWEN.md",
            "HERMES.md",
            "GEMINI.md",
            ".claude/CLAUDE.md",
            ".codex/config.toml",
            ".svode/local.json",
            ".agents/skills",
            ".agents/skills/review/SKILL.md",
            "docs/.claude/skills/review/SKILL.md",
        ] {
            let path = tmp.path().join(relative);
            assert_eq!(
                agent_context_observed_path(tmp.path(), &path).as_deref(),
                Some(relative)
            );
            assert!(classify(&tmp, &path, EventKind::Modify(ModifyKind::Any)).is_none());
        }
        for relative in [
            "README.md",
            "docs/GEMINI.md",
            ".claude/rules/rule.md",
            ".agents/skills-other/review/SKILL.md",
        ] {
            assert!(agent_context_observed_path(tmp.path(), &tmp.path().join(relative)).is_none());
        }
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
        assert_eq!(classification.kind, ContentTreeEventKind::Page);
        assert_eq!(classification.kind.as_payload_str(), "page");
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
    fn schema_capability_detection_and_watcher_classification_cover_root_and_nested_transitions() {
        for owner_rel in [Path::new(""), Path::new("tasks")] {
            let tmp = TempDir::new().unwrap();
            let owner = tmp.path().join(owner_rel);
            std::fs::create_dir_all(&owner).unwrap();
            let schema = owner.join("schema.yaml");
            let backup = owner.join("schema.backup");

            // Initial capability detection depends only on the owner's direct
            // child marker, even when its contents are not valid YAML.
            std::fs::write(&schema, "not: [valid").unwrap();
            assert!(has_direct_schema(&owner));
            if !owner_rel.as_os_str().is_empty() {
                assert!(!has_direct_schema(tmp.path()));
            }

            let created = classify(&tmp, &schema, EventKind::Create(CreateKind::File)).unwrap();
            assert_eq!(created.kind, ContentTreeEventKind::Schema);
            let expected_rel_path = if owner_rel.as_os_str().is_empty() {
                "schema.yaml"
            } else {
                "tasks/schema.yaml"
            };
            assert_eq!(created.rel_path, expected_rel_path);
            assert!(created.affects_tree);

            std::fs::remove_file(&schema).unwrap();
            let deleted = classify(&tmp, &schema, EventKind::Remove(RemoveKind::File)).unwrap();
            assert_eq!(deleted.kind, ContentTreeEventKind::Schema);
            assert!(deleted.affects_tree);
            assert!(!has_direct_schema(&owner));

            std::fs::write(&schema, "columns: []").unwrap();
            std::fs::rename(&schema, &backup).unwrap();
            let renamed_away = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
                .add_path(schema.clone())
                .add_path(backup.clone());
            let away_kind = event_kind_for_path(&renamed_away, 0);
            assert_eq!(away_kind, EventKind::Remove(RemoveKind::File));
            assert!(classify(&tmp, &schema, away_kind).unwrap().affects_tree);
            assert!(!has_direct_schema(&owner));

            std::fs::rename(&backup, &schema).unwrap();
            let renamed_into = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
                .add_path(backup)
                .add_path(schema.clone());
            let into_kind = event_kind_for_path(&renamed_into, 1);
            assert_eq!(into_kind, EventKind::Create(CreateKind::File));
            assert!(classify(&tmp, &schema, into_kind).unwrap().affects_tree);
            assert!(has_direct_schema(&owner));
        }
    }

    #[test]
    fn watcher_classifies_root_schema_rename_away_as_delete() {
        let tmp = TempDir::new().unwrap();
        let schema = tmp.path().join("schema.yaml");
        let renamed = tmp.path().join("schema.backup");
        std::fs::write(&renamed, "columns: []").unwrap();
        let event = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
            .add_path(schema.clone())
            .add_path(renamed.clone());

        let removed_kind = event_kind_for_path(&event, 0);
        let created_kind = event_kind_for_path(&event, 1);

        assert_eq!(removed_kind, EventKind::Remove(RemoveKind::File));
        assert_eq!(
            created_kind,
            EventKind::Modify(ModifyKind::Name(RenameMode::Both))
        );
        let classification = classify(&tmp, &schema, removed_kind).unwrap();
        assert_eq!(classification.rel_path, "schema.yaml");
        assert_eq!(classification.kind, ContentTreeEventKind::Schema);
        assert!(classification.affects_tree);
        assert!(classify(&tmp, &renamed, created_kind).is_none());
    }

    #[test]
    fn watcher_classifies_nested_schema_rename_into_place_as_create() {
        let tmp = TempDir::new().unwrap();
        let collection = tmp.path().join("tasks");
        std::fs::create_dir_all(&collection).unwrap();
        let previous = collection.join("schema.draft");
        let schema = collection.join("schema.yaml");
        std::fs::write(&schema, "columns: []").unwrap();
        let event = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
            .add_path(previous.clone())
            .add_path(schema.clone());

        let removed_kind = event_kind_for_path(&event, 0);
        let created_kind = event_kind_for_path(&event, 1);

        assert_eq!(
            removed_kind,
            EventKind::Modify(ModifyKind::Name(RenameMode::Both))
        );
        assert_eq!(created_kind, EventKind::Create(CreateKind::File));
        assert!(classify(&tmp, &previous, removed_kind).is_none());
        let classification = classify(&tmp, &schema, created_kind).unwrap();
        assert_eq!(classification.rel_path, "tasks/schema.yaml");
        assert_eq!(classification.kind, ContentTreeEventKind::Schema);
        assert!(classification.affects_tree);
    }

    #[test]
    fn watcher_resolves_unpaired_schema_rename_from_filesystem_state() {
        let tmp = TempDir::new().unwrap();
        let removed_schema = tmp.path().join("schema.yaml");
        let removed_event = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Any)))
            .add_path(removed_schema);
        let removed_kind = event_kind_for_path(&removed_event, 0);

        let created_schema = tmp.path().join("schema.yaml");
        std::fs::write(&created_schema, "columns: []").unwrap();
        let created_event = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Any)))
            .add_path(created_schema);

        assert_eq!(removed_kind, EventKind::Remove(RemoveKind::File));
        assert_eq!(
            event_kind_for_path(&created_event, 0),
            EventKind::Create(CreateKind::File)
        );
    }

    #[test]
    fn watcher_queues_root_schema_transition_for_ambiguous_rename_path() {
        let tmp = TempDir::new().unwrap();
        let schema = tmp.path().join("schema.yaml");
        std::fs::write(&schema, "columns: []").unwrap();
        let mut seen = HashMap::new();

        let (present, changed) = queue_root_schema_transition(&mut seen, tmp.path(), false);

        assert!(present);
        assert!(changed);
        assert_eq!(
            seen.get(&schema),
            Some(&EventKind::Create(CreateKind::File))
        );

        std::fs::rename(&schema, tmp.path().join("schema.backup")).unwrap();
        seen.clear();
        let (present, changed) = queue_root_schema_transition(&mut seen, tmp.path(), true);

        assert!(!present);
        assert!(changed);
        assert_eq!(
            seen.get(&schema),
            Some(&EventKind::Remove(RemoveKind::File))
        );
    }

    #[test]
    fn watcher_does_not_duplicate_precise_root_schema_event() {
        let tmp = TempDir::new().unwrap();
        let schema = tmp.path().join("schema.yaml");
        std::fs::write(&schema, "columns: []").unwrap();
        let mut seen = HashMap::from([(schema.clone(), EventKind::Modify(ModifyKind::Any))]);

        let (_, changed) = queue_root_schema_transition(&mut seen, tmp.path(), false);

        assert!(changed);
        assert_eq!(seen.get(&schema), Some(&EventKind::Modify(ModifyKind::Any)));
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
    fn df_088_watcher_routes_hidden_pages_to_membership_without_tree_publication() {
        let tmp = TempDir::new().unwrap();
        write_tree_config(&tmp, vec!["hidden.md"], vec![]);
        let hidden = tmp.path().join("hidden.md");
        std::fs::write(&hidden, "hidden").unwrap();
        let policy = TreeIgnorePolicy::from_space_root(tmp.path());
        let skip_dirs = child_folder_names(tmp.path());
        let event_kind = EventKind::Modify(ModifyKind::Any);

        assert!(
            classify_content_tree_event(tmp.path(), &policy, &skip_dirs, &hidden, &event_kind,)
                .is_none()
        );
        assert_eq!(
            classify_membership_index_event(tmp.path(), &policy, &skip_dirs, &hidden, &event_kind,),
            Some(ContentTreeEventKind::Page)
        );
        assert!(is_visibility_policy_path(
            tmp.path(),
            &tmp.path().join(".gitignore")
        ));
        assert!(is_visibility_policy_path(
            tmp.path(),
            &tmp.path().join(".svode/config.json")
        ));
    }

    #[test]
    fn system_settings_files_wake_the_automatic_commits_although_the_tree_hides_them() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        for path in [
            ".svode/config.json",
            ".svode/AGENTS.md",
            ".gitignore",
            ".gitattributes",
            ".lfsconfig",
            ".mailmap",
            "notes/.svode/config.json",
        ] {
            assert!(is_system_settings_path(root, &root.join(path)), "{path}");
        }
        for path in [".svode/local.json", ".svode/order.json", "Page.md"] {
            assert!(!is_system_settings_path(root, &root.join(path)), "{path}");
        }
    }

    #[test]
    fn watcher_keeps_root_schema_capability_signal_outside_user_tree_excludes() {
        let tmp = TempDir::new().unwrap();
        write_tree_config(&tmp, vec!["schema.yaml"], vec![]);
        let schema = tmp.path().join("schema.yaml");
        std::fs::write(&schema, "columns: []").unwrap();

        let classification = classify(&tmp, &schema, EventKind::Create(CreateKind::File)).unwrap();

        assert_eq!(classification.rel_path, "schema.yaml");
        assert_eq!(classification.kind, ContentTreeEventKind::Schema);
    }

    #[test]
    fn watcher_classifies_app_manifest_without_indexing_it() {
        let tmp = TempDir::new().unwrap();
        let manifest = tmp.path().join("dashboard/app.yaml");
        std::fs::create_dir_all(manifest.parent().unwrap()).unwrap();
        std::fs::write(&manifest, "invalid").unwrap();

        let classification =
            classify(&tmp, &manifest, EventKind::Create(CreateKind::File)).unwrap();

        assert_eq!(classification.rel_path, "dashboard/app.yaml");
        assert_eq!(classification.kind, ContentTreeEventKind::App);
        assert!(classification.affects_tree);
        assert!(!classification.affects_metadata);
        assert!(
            classify_membership_index_event(
                tmp.path(),
                &TreeIgnorePolicy::from_space_root(tmp.path()),
                &child_folder_names(tmp.path()),
                &manifest,
                &EventKind::Create(CreateKind::File),
            )
            .is_none()
        );
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

    #[test]
    fn watcher_skips_registered_child_space_paths() {
        let tmp = TempDir::new().unwrap();
        write_space_config(
            tmp.path(),
            &SpaceConfig {
                name: "Root".to_string(),
                description: String::new(),
                icon: "folder".to_string(),
                spaces: Some(vec![crate::space::types::SpaceRef {
                    id: "child".to_string(),
                    path: "child".to_string(),
                    repo: None,
                    extensions: Default::default(),
                }]),
                agent: None,
                defaults: None,
                git: None,
                assets: None,
                tree: None,
                extensions: Default::default(),
            },
        )
        .expect("write config");
        let child_dir = tmp.path().join("child");
        std::fs::create_dir_all(&child_dir).unwrap();
        let child_doc = child_dir.join("note.md");
        std::fs::write(&child_doc, "child").unwrap();
        let sibling_doc = tmp.path().join("child-notes.md");
        std::fs::write(&sibling_doc, "sibling").unwrap();

        assert!(classify(&tmp, &child_doc, EventKind::Create(CreateKind::File)).is_none());
        assert!(classify(&tmp, &sibling_doc, EventKind::Create(CreateKind::File)).is_some());
    }

    /// What the debounce loop publishes for a batch: the merged kind of each
    /// content tree path with its classification.
    fn published(
        space: &Path,
        events: &[Event],
    ) -> HashMap<PathBuf, (EventKind, ContentTreeEventClassification)> {
        let policy = TreeIgnorePolicy::from_space_root(space);
        let skip_dirs = child_folder_names(space);
        let mut seen: HashMap<PathBuf, EventKind> = HashMap::new();
        for event in events.iter().filter(|event| changes_files(event)) {
            for (index, path) in event.paths.iter().enumerate() {
                let (kind, _) = path_event_kind(space, &policy, &skip_dirs, event, index);
                if classify_content_tree_event(space, &policy, &skip_dirs, path, &kind).is_some() {
                    seen.entry(path.clone())
                        .and_modify(|current| *current = merge_event_kind(*current, kind))
                        .or_insert(kind);
                }
            }
        }
        seen.into_iter()
            .filter_map(|(path, kind)| {
                classify_content_tree_event(space, &policy, &skip_dirs, &path, &kind)
                    .map(|classification| (path, (kind, classification)))
            })
            .collect()
    }

    fn kind_of(tmp: &TempDir, event: &Event, index: usize) -> (EventKind, bool) {
        path_event_kind(
            tmp.path(),
            &TreeIgnorePolicy::from_space_root(tmp.path()),
            &child_folder_names(tmp.path()),
            event,
            index,
        )
    }

    fn event_of(kind: EventKind, paths: &[&Path]) -> Event {
        paths.iter().fold(Event::new(kind), |event, path| {
            event.add_path(path.to_path_buf())
        })
    }

    #[test]
    fn df_258_a_directory_gone_by_any_rename_or_kindless_removal_is_a_folder_removal() {
        let tmp = TempDir::new().unwrap();
        let renamed = tmp.path().join("renamed");
        std::fs::create_dir_all(&renamed).unwrap();
        for gone in [
            tmp.path().join("notebook"),
            tmp.path().join("docs/notebook"),
        ] {
            for event in [
                event_of(
                    EventKind::Modify(ModifyKind::Name(RenameMode::Any)),
                    &[&gone],
                ),
                event_of(
                    EventKind::Modify(ModifyKind::Name(RenameMode::From)),
                    &[&gone],
                ),
                event_of(
                    EventKind::Modify(ModifyKind::Name(RenameMode::Other)),
                    &[&gone],
                ),
                event_of(
                    EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
                    &[&gone, &renamed],
                ),
                event_of(EventKind::Remove(RemoveKind::Any), &[&gone]),
                event_of(EventKind::Remove(RemoveKind::Other), &[&gone]),
            ] {
                let (kind, vanished) = kind_of(&tmp, &event, 0);
                assert_eq!(kind, EventKind::Remove(RemoveKind::Folder), "{event:?}");
                assert!(vanished, "{event:?}");
                assert_eq!(file_event_name(&kind), Some("file:deleted"));
                let classification = classify(&tmp, &gone, kind).unwrap();
                let relative = relative_watched_path(tmp.path(), &gone).unwrap();
                assert_eq!(classification.rel_path, relative);
                assert_eq!(classification.kind, ContentTreeEventKind::Folder);
                assert!(classification.is_dir);
                assert!(classification.affects_tree);
                assert_eq!(classification.parent_path, parent_path_for_rel(&relative));
                let owner = if classification.parent_path.is_empty() {
                    ".".to_string()
                } else {
                    classification.parent_path.clone()
                };
                assert_eq!(
                    classify_attachment_invalidations(tmp.path(), &gone, &kind),
                    vec![AttachmentInvalidation {
                        owner_path: owner,
                        path: relative,
                        kind: AttachmentInvalidationKind::Boundary,
                    }]
                );
            }
        }
    }

    #[test]
    fn df_258_present_documents_markers_hidden_and_child_space_paths_keep_their_events() {
        let tmp = TempDir::new().unwrap();
        write_space_config(
            tmp.path(),
            &SpaceConfig {
                name: "Root".to_string(),
                description: String::new(),
                icon: "folder".to_string(),
                spaces: Some(vec![crate::space::types::SpaceRef {
                    id: "child".to_string(),
                    path: "child".to_string(),
                    repo: None,
                    extensions: Default::default(),
                }]),
                agent: None,
                defaults: None,
                git: None,
                assets: None,
                tree: Some(TreeSpaceConfig {
                    exclude: vec!["node_modules".to_string()],
                    include: Vec::new(),
                    show_ignored_placeholders: false,
                    extensions: Default::default(),
                }),
                extensions: Default::default(),
            },
        )
        .expect("write config");
        let existing = tmp.path().join("existing");
        std::fs::create_dir_all(&existing).unwrap();
        let rename_any = EventKind::Modify(ModifyKind::Name(RenameMode::Any));

        // An existing directory keeps its rename event.
        let event = event_of(rename_any, &[&existing]);
        assert_eq!(kind_of(&tmp, &event, 0), (rename_any, false));
        let classification = classify(&tmp, &existing, rename_any).unwrap();
        assert_eq!(classification.kind, ContentTreeEventKind::Folder);
        assert_eq!(file_event_name(&rename_any), Some("file:changed"));

        // The new path of a paired rename and a rename into place.
        let gone = tmp.path().join("notebook");
        let both = EventKind::Modify(ModifyKind::Name(RenameMode::Both));
        let event = event_of(both, &[&gone, &existing]);
        assert_eq!(kind_of(&tmp, &event, 1), (both, false));
        let to = EventKind::Modify(ModifyKind::Name(RenameMode::To));
        assert_eq!(kind_of(&tmp, &event_of(to, &[&gone]), 0), (to, false));

        // Kinded removals keep their kind.
        for kind in [
            EventKind::Remove(RemoveKind::File),
            EventKind::Remove(RemoveKind::Folder),
        ] {
            assert_eq!(kind_of(&tmp, &event_of(kind, &[&gone]), 0), (kind, false));
        }

        // Documents and markers keep their own rules.
        let note = tmp.path().join("notes/note.md");
        assert_eq!(
            kind_of(&tmp, &event_of(rename_any, &[&note]), 0),
            (rename_any, false)
        );
        assert_eq!(
            classify(&tmp, &note, rename_any).unwrap().kind,
            ContentTreeEventKind::Page
        );
        for marker in ["tasks/schema.yaml", "dashboard/app.yaml"] {
            let marker = tmp.path().join(marker);
            for kind in [rename_any, EventKind::Remove(RemoveKind::Any)] {
                let (marker_kind, vanished) = kind_of(&tmp, &event_of(kind, &[&marker]), 0);
                assert!(!vanished, "{marker:?}");
                assert_eq!(
                    marker_kind,
                    event_kind_for_path(&event_of(kind, &[&marker]), 0)
                );
            }
        }

        // Hidden, excluded and child Space paths publish nothing new.
        for relative in [
            ".svode-delete-01jz",
            "notes/.svode-delete-01jz",
            ".git/refs",
            "node_modules",
            "child/notebook",
        ] {
            let path = tmp.path().join(relative);
            for kind in [rename_any, EventKind::Remove(RemoveKind::Any)] {
                let (path_kind, vanished) = kind_of(&tmp, &event_of(kind, &[&path]), 0);
                assert_eq!((path_kind, vanished), (kind, false), "{relative}");
                assert!(classify(&tmp, &path, path_kind).is_none(), "{relative}");
            }
        }
    }

    #[test]
    fn df_258_b_the_indexed_sources_of_a_gone_directory_are_removed_pages() {
        let tmp = TempDir::new().unwrap();
        write_space_config(
            tmp.path(),
            &SpaceConfig {
                name: "Root".to_string(),
                description: String::new(),
                icon: "folder".to_string(),
                spaces: Some(vec![crate::space::types::SpaceRef {
                    id: "child".to_string(),
                    path: "child".to_string(),
                    repo: None,
                    extensions: Default::default(),
                }]),
                agent: None,
                defaults: None,
                git: None,
                assets: None,
                tree: None,
                extensions: Default::default(),
            },
        )
        .expect("write config");
        let sources = [
            "projects/zeta/README.md",
            "projects/zeta/item.md",
            "child/page.md",
        ]
        .map(|relative| tmp.path().join(relative));

        let removals = vanished_source_removals(
            tmp.path(),
            &TreeIgnorePolicy::from_space_root(tmp.path()),
            &child_folder_names(tmp.path()),
            &sources,
        );

        let published = removals
            .iter()
            .map(|removal| {
                assert_eq!(removal.kind, ContentTreeEventKind::Page);
                assert!(!removal.is_dir);
                (removal.rel_path.as_str(), removal.parent_path.as_str())
            })
            .collect::<Vec<_>>();
        assert_eq!(
            published,
            vec![
                ("projects/zeta/README.md", "projects/zeta"),
                ("projects/zeta/item.md", "projects/zeta"),
            ]
        );
    }

    #[test]
    fn df_258_a_gone_file_outside_the_tree_only_rereads_its_parent() {
        let tmp = TempDir::new().unwrap();
        let image = tmp.path().join("docs/image.png");
        let event = event_of(
            EventKind::Modify(ModifyKind::Name(RenameMode::Any)),
            &[&image],
        );

        let (kind, vanished) = kind_of(&tmp, &event, 0);

        assert!(vanished);
        let classification = classify(&tmp, &image, kind).unwrap();
        assert_eq!(classification.rel_path, "docs/image.png");
        assert_eq!(classification.parent_path, "docs");
        assert_eq!(
            classify_attachment_invalidations(tmp.path(), &image, &kind),
            vec![AttachmentInvalidation {
                owner_path: "docs".into(),
                path: "docs/image.png".into(),
                kind: AttachmentInvalidationKind::Boundary,
            }]
        );
    }

    /// A real move of a directory with Pages out of the watched root reaches
    /// the tree as `file:deleted` of the folder, like `rm -r`.
    #[test]
    fn df_258_a_directory_moved_out_of_the_space_publishes_a_folder_removal() {
        let tmp = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let space = tmp.path().canonicalize().unwrap();
        let notebook = space.join("notebook");
        std::fs::create_dir_all(notebook.join("sub")).unwrap();
        std::fs::write(notebook.join("README.md"), "---\ntitle: Notebook\n---\n").unwrap();
        std::fs::write(notebook.join("page.md"), "page").unwrap();
        std::fs::write(notebook.join("sub/deep.md"), "deep").unwrap();

        let (tx, rx) = mpsc::channel::<Event>();
        let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                let _ = tx.send(event);
            }
        })
        .unwrap();
        watcher.watch(&space, RecursiveMode::Recursive).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(500));
        while rx.try_recv().is_ok() {}

        std::fs::rename(&notebook, outside.path().join("notebook")).unwrap();
        let mut events = Vec::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
            match rx.recv_timeout(left.min(std::time::Duration::from_millis(500))) {
                Ok(event) => events.push(event),
                Err(_) if events.iter().any(|event| event.paths.contains(&notebook)) => break,
                Err(_) => {}
            }
        }
        drop(watcher);

        let published = published(&space, &events);
        let (kind, classification) = published
            .get(&notebook)
            .unwrap_or_else(|| panic!("{events:?}"));
        assert_eq!(file_event_name(kind), Some("file:deleted"), "{events:?}");
        assert_eq!(classification.kind, ContentTreeEventKind::Folder);
        assert!(classification.is_dir);
        assert_eq!(classification.rel_path, "notebook");
        assert_eq!(classification.parent_path, "");
    }
}

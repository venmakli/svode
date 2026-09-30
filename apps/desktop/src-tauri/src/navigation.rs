//! Device-local navigation state of one Project: pinned objects, the objects
//! kept in Now, and the expanded folders of the Artifacts tree of each
//! registered Space.
//!
//! It is recoverable UI state in its own file under the Project `.svode/`,
//! covered by the managed Git local policy (`svode_core::git::policy`). It
//! shares no lock, recovery or watcher invalidation with `.svode/local.json`.
//! A missing, unreadable or unknown-version file reads as empty and is
//! replaced by the next write.
//!
//! An object is pinned or kept, never both: pinning a kept object moves it to
//! the pinned list.
//!
//! Every read resolves the pinned and kept artifacts and Spaces against their
//! source:
//! an available target refreshes its display snapshot, an unreadable source
//! keeps it as unavailable, and only a target whose absence a successful read
//! confirms is dropped. Sessions are resolved by the frontend catalog.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use svode_core::content_tree::{self, TreeChildKind, TreeLoadError};
use svode_core::page::SpaceReadiness;
use tauri::{AppHandle, Emitter};

use crate::error::AppError;

/// Emitted after an in-app change of artifact paths changed navigation keys.
pub const NAVIGATION_CHANGED_EVENT: &str = "navigation:changed";

const FILE_NAME: &str = "navigation.json";
/// Replacement files match the same local policy entry as the state file.
const TEMP_PREFIX: &str = "navigation.tmp-";
const VERSION: u32 = 1;

/// Serializes read-modify-write of navigation files in this process.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Projects with an in-app path change in flight, once per change. While one
/// runs, its source path is already gone but its key is not moved yet, so
/// reads of that Project do not drop missing targets.
static PATH_CHANGES: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

fn path_change_in_flight(project: &Path) -> bool {
    PATH_CHANGES
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .iter()
        .any(|changing| changing == project)
}

/// Typed identity of an object in the navigation state. Artifacts are keyed
/// by their registered Space (`None` for the Project root) and normalized
/// repo-relative path; a session by its canonical id, or by its launch id
/// until the catalog knows the canonical one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum NavigationKey {
    #[serde(rename_all = "camelCase")]
    Space {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        space_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Page {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        space_id: Option<String>,
        path: String,
    },
    #[serde(rename_all = "camelCase")]
    Collection {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        space_id: Option<String>,
        path: String,
    },
    #[serde(rename_all = "camelCase")]
    Attachment {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        space_id: Option<String>,
        path: String,
    },
    #[serde(rename_all = "camelCase")]
    App {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        space_id: Option<String>,
        path: String,
    },
    #[serde(rename_all = "camelCase")]
    Session { session_id: String },
    #[serde(rename_all = "camelCase")]
    SessionLaunch { launch_id: String },
}

impl NavigationKey {
    /// Registered Space id and repo-relative path of an artifact key.
    fn artifact(&self) -> Option<(Option<&str>, &str)> {
        match self {
            Self::Page { space_id, path }
            | Self::Collection { space_id, path }
            | Self::Attachment { space_id, path }
            | Self::App { space_id, path } => Some((space_id.as_deref(), path)),
            _ => None,
        }
    }

    fn artifact_path_mut(&mut self) -> Option<&mut String> {
        match self {
            Self::Page { path, .. }
            | Self::Collection { path, .. }
            | Self::Attachment { path, .. }
            | Self::App { path, .. } => Some(path),
            _ => None,
        }
    }

    /// Whether both keys address one object. An artifact is its Space and
    /// path, whatever form the key recorded.
    fn same_target(&self, other: &Self) -> bool {
        match (self.artifact(), other.artifact()) {
            (Some(left), Some(right)) => left == right,
            _ => self == other,
        }
    }

    /// The key of the same Page, Collection or App path in its current form.
    fn with_owner(self, owner: OwnerKind) -> Self {
        match self {
            Self::Page { space_id, path }
            | Self::Collection { space_id, path }
            | Self::App { space_id, path } => match owner {
                OwnerKind::Page => Self::Page { space_id, path },
                OwnerKind::Collection => Self::Collection { space_id, path },
                OwnerKind::App => Self::App { space_id, path },
            },
            other => other,
        }
    }

    fn normalized(self) -> Result<Self, AppError> {
        let path = |path: String| -> Result<String, AppError> {
            let path = path.replace('\\', "/");
            let path = path.trim_matches('/').to_string();
            if path.is_empty()
                || path
                    .split('/')
                    .any(|segment| segment.is_empty() || segment == "." || segment == "..")
            {
                return Err(AppError::General(format!(
                    "Invalid navigation path: {path}"
                )));
            }
            Ok(path)
        };
        let id = |value: String, name: &str| -> Result<String, AppError> {
            if value.trim().is_empty() {
                return Err(AppError::General(format!("Empty navigation {name}")));
            }
            Ok(value)
        };
        Ok(match self {
            Self::Space { space_id } => Self::Space { space_id },
            Self::Page { space_id, path: p } => Self::Page {
                space_id,
                path: path(key_path(&p))?,
            },
            Self::Collection { space_id, path: p } => Self::Collection {
                space_id,
                path: path(key_path(&p))?,
            },
            Self::Attachment { space_id, path: p } => Self::Attachment {
                space_id,
                path: path(p)?,
            },
            Self::App { space_id, path: p } => Self::App {
                space_id,
                path: path(key_path(&p))?,
            },
            Self::Session { session_id } => Self::Session {
                session_id: id(session_id, "session id")?,
            },
            Self::SessionLaunch { launch_id } => Self::SessionLaunch {
                launch_id: id(launch_id, "launch id")?,
            },
        })
    }
}

/// A navigation entry with the display snapshot shown while its source is
/// unavailable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationItem {
    pub key: NavigationKey,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

/// A pinned or kept item as the frontend sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedItem {
    #[serde(flatten)]
    pub item: NavigationItem,
    /// Whether the source read shows the target; `None` for sessions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available: Option<bool>,
    /// The path an available artifact opens by: the Page file or README of
    /// a folder owner as the tree shows it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_path: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationState {
    /// In pin order, newest last.
    pub pinned: Vec<ResolvedItem>,
    /// Kept in Now, in keep order, newest last.
    pub kept: Vec<ResolvedItem>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpaceExpansion {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    space_id: Option<String>,
    paths: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NavigationFile {
    version: u32,
    #[serde(default)]
    pinned: Vec<NavigationItem>,
    #[serde(default)]
    kept: Vec<NavigationItem>,
    #[serde(default)]
    expanded: Vec<SpaceExpansion>,
}

impl NavigationFile {
    fn empty() -> Self {
        Self {
            version: VERSION,
            ..Self::default()
        }
    }
}

fn file_path(project: &Path) -> PathBuf {
    project.join(".svode").join(FILE_NAME)
}

fn read_file(project: &Path) -> NavigationFile {
    std::fs::read(file_path(project))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<NavigationFile>(&bytes).ok())
        .filter(|file| file.version == VERSION)
        .unwrap_or_else(NavigationFile::empty)
}

fn write_file(project: &Path, file: &NavigationFile) -> Result<(), AppError> {
    let directory = project.join(".svode");
    let bytes = serde_json::to_vec_pretty(file)?;
    let mut temp = tempfile::Builder::new()
        .prefix(TEMP_PREFIX)
        .tempfile_in(&directory)?;
    temp.write_all(&bytes)?;
    temp.as_file().sync_all()?;
    temp.persist(file_path(project))
        .map_err(|error| AppError::Io(error.error))?;
    Ok(())
}

fn is_project(project: &Path) -> bool {
    project.join(".svode/config.json").is_file()
}

/// Read-modify-write of the navigation file; it is written only when the
/// operation changed it.
fn mutate<T>(
    project: &Path,
    operation: impl FnOnce(&mut NavigationFile) -> Result<T, AppError>,
) -> Result<T, AppError> {
    if !is_project(project) {
        return Err(AppError::SpaceNotFound(
            svode_core::system_path::user_facing_path(project),
        ));
    }
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let original = read_file(project);
    let mut file = original.clone();
    let result = operation(&mut file)?;
    // Expansion of a Space that a successful read shows is no longer
    // registered is dropped; an unreadable Project config keeps it.
    if let Ok(spaces) = svode_core::page::registered_spaces(project) {
        file.expanded.retain(|expansion| {
            expansion
                .space_id
                .as_ref()
                .is_none_or(|id| spaces.iter().any(|space| &space.id == id))
        });
    }
    if file != original {
        file.version = VERSION;
        write_file(project, &file)?;
    }
    Ok(result)
}

/// The pinned and kept items resolved against their sources, keeping the file
/// in step: refreshed snapshots of available targets, confirmed-missing ones
/// dropped.
fn resolved(project: &Path, file: &mut NavigationFile) -> NavigationState {
    let mut sources = Sources::new(project);
    NavigationState {
        pinned: resolve_items(&mut sources, &mut file.pinned),
        kept: resolve_items(&mut sources, &mut file.kept),
    }
}

/// Resolves the pinned and kept items against their sources. Outside a
/// Project there is no navigation state.
pub fn read_state(project: &Path) -> NavigationState {
    if !is_project(project) {
        return NavigationState::default();
    }
    let mut shown = None;
    let result = mutate(project, |file| {
        let state = resolved(project, file);
        shown = Some(state.clone());
        Ok(state)
    });
    result.unwrap_or_else(|error| {
        tracing::warn!("navigation state not updated: {error}");
        shown.unwrap_or_default()
    })
}

fn normalized_item(item: NavigationItem) -> Result<NavigationItem, AppError> {
    Ok(NavigationItem {
        key: item.key.normalized()?,
        ..item
    })
}

fn normalized_keys(keys: Vec<NavigationKey>) -> Result<Vec<NavigationKey>, AppError> {
    keys.into_iter().map(NavigationKey::normalized).collect()
}

fn position(items: &[NavigationItem], key: &NavigationKey) -> Option<usize> {
    items.iter().position(|item| item.key.same_target(key))
}

fn remove_all(items: &mut Vec<NavigationItem>, keys: &[NavigationKey]) {
    items.retain(|item| !keys.iter().any(|key| key.same_target(&item.key)));
}

/// Pins an item at the end, or refreshes the snapshot of an existing pin in
/// place. A kept item moves to the pinned list.
pub fn pin(project: &Path, item: NavigationItem) -> Result<NavigationState, AppError> {
    let item = normalized_item(item)?;
    mutate(project, |file| {
        remove_all(&mut file.kept, std::slice::from_ref(&item.key));
        match position(&file.pinned, &item.key) {
            Some(index) => file.pinned[index] = item,
            None => file.pinned.push(item),
        }
        Ok(resolved(project, file))
    })
}

/// Keeps an item in Now at the end, or refreshes the snapshot of a kept item
/// in place. A pinned item is left pinned.
pub fn keep(project: &Path, item: NavigationItem) -> Result<NavigationState, AppError> {
    let item = normalized_item(item)?;
    mutate(project, |file| {
        if position(&file.pinned, &item.key).is_none() {
            match position(&file.kept, &item.key) {
                Some(index) => file.kept[index] = item,
                None => file.kept.push(item),
            }
        }
        Ok(resolved(project, file))
    })
}

/// Removes the given keys from the pinned list.
pub fn unpin(project: &Path, keys: Vec<NavigationKey>) -> Result<NavigationState, AppError> {
    let keys = normalized_keys(keys)?;
    mutate(project, |file| {
        remove_all(&mut file.pinned, &keys);
        Ok(resolved(project, file))
    })
}

/// Removes the given keys from Now.
pub fn unkeep(project: &Path, keys: Vec<NavigationKey>) -> Result<NavigationState, AppError> {
    let keys = normalized_keys(keys)?;
    mutate(project, |file| {
        remove_all(&mut file.kept, &keys);
        Ok(resolved(project, file))
    })
}

/// Removes targets whose absence a successful read of their source confirmed
/// from the whole navigation state.
pub fn forget(project: &Path, keys: Vec<NavigationKey>) -> Result<NavigationState, AppError> {
    let keys = normalized_keys(keys)?;
    mutate(project, |file| {
        remove_all(&mut file.pinned, &keys);
        remove_all(&mut file.kept, &keys);
        Ok(resolved(project, file))
    })
}

/// Refreshes the display snapshot of a pinned or kept item, such as the
/// current title of a session; an item in neither list is not added.
pub fn retitle(project: &Path, item: NavigationItem) -> Result<NavigationState, AppError> {
    let item = normalized_item(item)?;
    mutate(project, |file| {
        for items in [&mut file.pinned, &mut file.kept] {
            if let Some(index) = position(items, &item.key) {
                items[index] = item.clone();
            }
        }
        Ok(resolved(project, file))
    })
}

/// Resolves one artifact or Space against its source without recording it,
/// e.g. the object of the main area; `None` when the source shows it is gone.
/// A source that cannot be read keeps the given snapshot as unavailable.
/// Sessions are resolved by the frontend catalog.
pub fn describe(project: &Path, item: NavigationItem) -> Result<Option<ResolvedItem>, AppError> {
    let item = normalized_item(item)?;
    if !is_project(project) {
        return Ok(None);
    }
    let mut items = vec![item];
    Ok(resolve_items(&mut Sources::new(project), &mut items).pop())
}

/// What a read of its source shows about a pinned artifact or Space.
enum Resolution {
    Available {
        title: String,
        icon: Option<String>,
        /// The form a Page, Collection or App has now.
        owner: Option<OwnerKind>,
        open_path: Option<String>,
    },
    /// The source could not be read, or the Space is missing or broken.
    Unavailable,
    /// A successful read of the source confirms the target is gone.
    Missing,
}

#[derive(Debug, Clone, Copy)]
enum OwnerKind {
    Page,
    Collection,
    App,
}

/// Sources of one resolution pass; the registered Spaces are read once.
struct Sources<'a> {
    project: &'a Path,
    spaces: Option<Option<Vec<content_tree::ProjectChild>>>,
}

impl<'a> Sources<'a> {
    fn new(project: &'a Path) -> Self {
        Self {
            project,
            spaces: None,
        }
    }

    fn spaces(&mut self) -> Option<&[content_tree::ProjectChild]> {
        let project = self.project;
        self.spaces
            .get_or_insert_with(|| content_tree::list_project_children(project).ok())
            .as_deref()
    }

    fn space(&mut self, space_id: Option<&str>) -> Resolution {
        let Some(id) = space_id else {
            return match content_tree::read_space_display(self.project) {
                Ok(display) => Resolution::Available {
                    title: display.name,
                    icon: non_empty(display.icon),
                    owner: None,
                    open_path: None,
                },
                Err(_) => Resolution::Unavailable,
            };
        };
        let Some(spaces) = self.spaces() else {
            return Resolution::Unavailable;
        };
        match spaces.iter().find(|space| space.id == id) {
            None => Resolution::Missing,
            Some(space) if space.status == SpaceReadiness::Ready => Resolution::Available {
                title: space.name.clone(),
                icon: non_empty(space.icon.clone()),
                owner: None,
                open_path: None,
            },
            Some(_) => Resolution::Unavailable,
        }
    }

    /// Directory of the Space an artifact belongs to, or the resolution of an
    /// artifact of a Space that is gone or unreadable.
    fn space_root(&mut self, space_id: Option<&str>) -> Result<PathBuf, Resolution> {
        let Some(id) = space_id else {
            return Ok(self.project.to_path_buf());
        };
        let Some(spaces) = self.spaces() else {
            return Err(Resolution::Unavailable);
        };
        match spaces.iter().find(|space| space.id == id) {
            None => Err(Resolution::Missing),
            Some(space) if space.status == SpaceReadiness::Ready => Ok(space.path.clone()),
            Some(_) => Err(Resolution::Unavailable),
        }
    }

    fn artifact(&mut self, key: &NavigationKey) -> Resolution {
        let Some((space_id, path)) = key.artifact() else {
            return Resolution::Unavailable;
        };
        let root = match self.space_root(space_id) {
            Ok(root) => root,
            Err(resolution) => return resolution,
        };
        if matches!(key, NavigationKey::Attachment { .. }) {
            return attachment(&root, path);
        }
        owner(&root, path)
    }
}

fn non_empty(value: String) -> Option<String> {
    (!value.trim().is_empty()).then_some(value)
}

/// An attachment is a file of the Space; it is not a tree node.
fn attachment(root: &Path, path: &str) -> Resolution {
    match std::fs::metadata(root.join(path)) {
        Ok(metadata) if metadata.is_file() => Resolution::Available {
            title: path.rsplit('/').next().unwrap_or(path).to_string(),
            icon: None,
            owner: None,
            open_path: Some(path.to_string()),
        },
        Ok(_) => Resolution::Missing,
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound && std::fs::read_dir(root).is_ok() =>
        {
            Resolution::Missing
        }
        Err(_) => Resolution::Unavailable,
    }
}

/// A Page, Collection or App is the node of its parent listing with the same
/// folder identity; the listing reports what it shows and what is gone.
fn owner(root: &Path, path: &str) -> Resolution {
    let parent = path.rsplit_once('/').map(|(parent, _)| parent);
    match content_tree::list_tree_children_checked(&root.to_string_lossy(), parent) {
        Ok(nodes) => {
            let Some(node) = nodes.into_iter().find(|node| key_path(&node.path) == path) else {
                return Resolution::Missing;
            };
            let owner = match node.kind {
                TreeChildKind::Page => OwnerKind::Page,
                TreeChildKind::Collection => OwnerKind::Collection,
                TreeChildKind::App => OwnerKind::App,
                // A folder without README, schema or app is no longer the
                // pinned object.
                TreeChildKind::Folder => return Resolution::Missing,
            };
            Resolution::Available {
                title: node.title,
                icon: node.icon,
                owner: Some(owner),
                open_path: Some(node.path),
            }
        }
        Err(TreeLoadError::Missing { .. }) => Resolution::Missing,
        Err(_) => Resolution::Unavailable,
    }
}

/// Resolves navigation items in place and returns what the frontend shows.
/// Sessions are left to the frontend catalog. While an in-app path change is
/// in flight, a missing target stays as unavailable.
fn resolve_items(sources: &mut Sources, items: &mut Vec<NavigationItem>) -> Vec<ResolvedItem> {
    let drop_missing = !path_change_in_flight(sources.project);
    let mut shown = Vec::with_capacity(items.len());
    items.retain_mut(|item| {
        let resolution = match &item.key {
            NavigationKey::Session { .. } | NavigationKey::SessionLaunch { .. } => {
                shown.push(ResolvedItem {
                    item: item.clone(),
                    available: None,
                    open_path: None,
                });
                return true;
            }
            NavigationKey::Space { space_id } => sources.space(space_id.as_deref()),
            key => sources.artifact(key),
        };
        let (available, open_path) = match resolution {
            Resolution::Missing if drop_missing => return false,
            Resolution::Missing | Resolution::Unavailable => (false, None),
            Resolution::Available {
                title,
                icon,
                owner,
                open_path,
            } => {
                item.title = title;
                item.icon = icon;
                if let Some(owner) = owner {
                    item.key = item.key.clone().with_owner(owner);
                }
                (true, open_path)
            }
        };
        shown.push(ResolvedItem {
            item: item.clone(),
            available: Some(available),
            open_path,
        });
        true
    });
    shown
}

/// The key path of a tree node or an in-app path: a folder Page, Collection
/// or App is its folder, whether addressed by the directory or its README.
fn key_path(path: &str) -> String {
    let path = path.replace('\\', "/");
    let path = path.trim_matches('/');
    match path.rsplit_once('/') {
        Some((folder, name)) if name.eq_ignore_ascii_case("readme.md") => folder.to_string(),
        _ => path.to_string(),
    }
}

/// `path` with its `from` prefix replaced by `to`, when it is `from` or lies
/// under it.
fn remap(path: &str, from: &str, to: &str) -> Option<String> {
    if path == from {
        return Some(to.to_string());
    }
    path.strip_prefix(from)
        .filter(|rest| rest.starts_with('/'))
        .map(|rest| format!("{to}{rest}"))
}

/// Marks an in-app change of artifact paths of a Project while it runs.
pub struct PathChange(Option<PathBuf>);

impl Drop for PathChange {
    fn drop(&mut self) {
        let Some(project) = self.0.take() else {
            return;
        };
        let mut changes = PATH_CHANGES
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(index) = changes.iter().position(|changing| *changing == project) {
            changes.swap_remove(index);
        }
    }
}

/// Held around an in-app rename, move or change of form in `space`, so a
/// read in between does not take the old path for a removed target.
pub fn path_change(space: &str) -> PathChange {
    let project = svode_core::page::project_for_directory(Path::new(space));
    if let Some(project) = &project {
        PATH_CHANGES
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(project.clone());
    }
    PathChange(project)
}

/// Moves the keys of the artifact at `from` and of everything under it to
/// `to`; the moved targets take the form they have now. Returns whether the
/// navigation state changed.
fn retarget(space: &Path, from: &str, to: &str) -> Result<bool, AppError> {
    let (project, space_id) = space_target(space)?;
    let (from, to) = (key_path(from), key_path(to));
    mutate(&project, |file| {
        let before = file.clone();
        for item in file.pinned.iter_mut().chain(file.kept.iter_mut()) {
            if item
                .key
                .artifact()
                .is_none_or(|(id, _)| id != space_id.as_deref())
            {
                continue;
            }
            if let Some(path) = item.key.artifact_path_mut()
                && let Some(moved) = remap(path, &from, &to)
            {
                *path = moved;
            }
        }
        resolved(&project, file);
        Ok(*file != before)
    })
}

/// Re-resolves the pinned and kept items of the Project of `space`. Returns
/// whether the navigation state changed.
fn refresh(space: &Path) -> Result<bool, AppError> {
    let (project, _) = space_target(space)?;
    mutate(&project, |file| {
        let before = file.clone();
        resolved(&project, file);
        Ok(*file != before)
    })
}

fn notify(app: &AppHandle, changed: Result<bool, AppError>) {
    match changed {
        Ok(true) => {
            if let Err(error) = app.emit(NAVIGATION_CHANGED_EVENT, ()) {
                tracing::warn!("navigation change not delivered: {error}");
            }
        }
        Ok(false) => {}
        Err(error) => tracing::warn!("navigation state not updated: {error}"),
    }
}

/// Keeps pinned and kept items on an in-app rename, move or change of form of
/// an artifact.
/// Navigation is recoverable UI state, so a failure never fails the change.
pub fn artifact_moved(app: &AppHandle, space: &str, from: &str, to: &str) {
    notify(app, retarget(Path::new(space), from, to));
}

/// Drops the pinned and kept items an in-app deletion removed; the read of
/// their source confirms they are gone.
pub fn artifact_removed(app: &AppHandle, space: &str) {
    notify(app, refresh(Path::new(space)));
}

/// Project and registered Space id (`None` for the Project root) of a Space
/// directory.
fn space_target(space: &Path) -> Result<(PathBuf, Option<String>), AppError> {
    let not_found = || AppError::SpaceNotFound(svode_core::system_path::user_facing_path(space));
    let project = svode_core::page::project_for_directory(space).ok_or_else(not_found)?;
    if project == space {
        return Ok((project, None));
    }
    let folder = space
        .strip_prefix(&project)
        .map_err(|_| not_found())?
        .to_string_lossy()
        .replace('\\', "/");
    let id = svode_core::page::registered_spaces(&project)
        .map_err(|_| not_found())?
        .into_iter()
        .find(|reference| reference.path == folder)
        .map(|reference| reference.id)
        .ok_or_else(not_found)?;
    Ok((project, Some(id)))
}

pub fn expanded_paths(space: &Path) -> Result<Vec<String>, AppError> {
    let (project, space_id) = space_target(space)?;
    Ok(read_file(&project)
        .expanded
        .into_iter()
        .find(|expansion| expansion.space_id == space_id)
        .map(|expansion| expansion.paths)
        .unwrap_or_default())
}

pub fn save_expanded_paths(space: &Path, paths: Vec<String>) -> Result<(), AppError> {
    let (project, space_id) = space_target(space)?;
    mutate(&project, |file| {
        file.expanded
            .retain(|expansion| expansion.space_id != space_id);
        if !paths.is_empty() {
            file.expanded.push(SpaceExpansion { space_id, paths });
        }
        Ok(())
    })
}

pub mod commands {
    use std::path::Path;

    use super::{NavigationItem, NavigationKey, NavigationState, ResolvedItem};
    use crate::error::AppError;

    /// Resolving pinned targets reads the file system, so it runs off the
    /// main thread.
    async fn blocking<T: Send + 'static>(
        task: impl FnOnce() -> Result<T, AppError> + Send + 'static,
    ) -> Result<T, AppError> {
        tauri::async_runtime::spawn_blocking(task)
            .await
            .map_err(|error| AppError::General(format!("Navigation worker failed: {error}")))?
    }

    #[tauri::command]
    pub async fn navigation_read(project_path: String) -> Result<NavigationState, AppError> {
        blocking(move || Ok(super::read_state(Path::new(&project_path)))).await
    }

    #[tauri::command]
    pub async fn navigation_pin(
        project_path: String,
        item: NavigationItem,
    ) -> Result<NavigationState, AppError> {
        blocking(move || super::pin(Path::new(&project_path), item)).await
    }

    #[tauri::command]
    pub async fn navigation_keep(
        project_path: String,
        item: NavigationItem,
    ) -> Result<NavigationState, AppError> {
        blocking(move || super::keep(Path::new(&project_path), item)).await
    }

    #[tauri::command]
    pub async fn navigation_unpin(
        project_path: String,
        keys: Vec<NavigationKey>,
    ) -> Result<NavigationState, AppError> {
        blocking(move || super::unpin(Path::new(&project_path), keys)).await
    }

    #[tauri::command]
    pub async fn navigation_unkeep(
        project_path: String,
        keys: Vec<NavigationKey>,
    ) -> Result<NavigationState, AppError> {
        blocking(move || super::unkeep(Path::new(&project_path), keys)).await
    }

    #[tauri::command]
    pub async fn navigation_forget(
        project_path: String,
        keys: Vec<NavigationKey>,
    ) -> Result<NavigationState, AppError> {
        blocking(move || super::forget(Path::new(&project_path), keys)).await
    }

    #[tauri::command]
    pub async fn navigation_retitle(
        project_path: String,
        item: NavigationItem,
    ) -> Result<NavigationState, AppError> {
        blocking(move || super::retitle(Path::new(&project_path), item)).await
    }

    #[tauri::command]
    pub async fn navigation_describe(
        project_path: String,
        item: NavigationItem,
    ) -> Result<Option<ResolvedItem>, AppError> {
        blocking(move || super::describe(Path::new(&project_path), item)).await
    }

    #[tauri::command]
    pub fn navigation_expanded_paths(space: String) -> Result<Vec<String>, AppError> {
        super::expanded_paths(Path::new(&space))
    }

    #[tauri::command]
    pub fn navigation_save_expanded_paths(
        space: String,
        paths: Vec<String>,
    ) -> Result<(), AppError> {
        super::save_expanded_paths(Path::new(&space), paths)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> tempfile::TempDir {
        let temp = tempfile::tempdir().expect("temp dir");
        std::fs::create_dir_all(temp.path().join(".svode")).expect("svode dir");
        std::fs::write(
            temp.path().join(".svode/config.json"),
            serde_json::json!({
                "name": "Project",
                "spaces": [{ "id": "child-id", "path": "child" }]
            })
            .to_string(),
        )
        .expect("project config");
        std::fs::create_dir_all(temp.path().join("child/.svode")).expect("child dir");
        std::fs::write(
            temp.path().join("child/.svode/config.json"),
            serde_json::json!({ "name": "Child" }).to_string(),
        )
        .expect("child config");
        temp
    }

    fn session(id: &str) -> NavigationItem {
        NavigationItem {
            key: NavigationKey::Session {
                session_id: id.to_string(),
            },
            title: id.to_string(),
            icon: None,
        }
    }

    fn pinned_ids(state: &NavigationState) -> Vec<String> {
        state
            .pinned
            .iter()
            .map(|pinned| match &pinned.item.key {
                NavigationKey::Session { session_id } => session_id.clone(),
                other => format!("{other:?}"),
            })
            .collect()
    }

    fn write(root: &Path, path: &str, content: &str) {
        let path = root.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    fn page(title: &str) -> String {
        format!("---\ntitle: {title}\n---\n")
    }

    fn artifact(key: NavigationKey, title: &str) -> NavigationItem {
        NavigationItem {
            key,
            title: title.into(),
            icon: None,
        }
    }

    fn child_page(path: &str) -> NavigationKey {
        NavigationKey::Page {
            space_id: Some("child-id".into()),
            path: path.into(),
        }
    }

    /// Keys, titles and availability as the frontend receives them.
    fn shown(state: &NavigationState) -> Vec<(NavigationKey, String, Option<bool>)> {
        state
            .pinned
            .iter()
            .map(|pinned| {
                (
                    pinned.item.key.clone(),
                    pinned.item.title.clone(),
                    pinned.available,
                )
            })
            .collect()
    }

    #[test]
    fn pins_keep_pin_order_and_survive_reread() {
        let project = project();
        pin(project.path(), session("codex:a")).unwrap();
        pin(project.path(), session("codex:b")).unwrap();
        let state = pin(
            project.path(),
            NavigationItem {
                title: "Renamed".into(),
                ..session("codex:a")
            },
        )
        .unwrap();

        assert_eq!(pinned_ids(&state), vec!["codex:a", "codex:b"]);
        assert_eq!(state.pinned[0].item.title, "Renamed");
        assert_eq!(state.pinned[0].available, None);
        assert_eq!(read_state(project.path()), state);

        let state = forget(
            project.path(),
            vec![NavigationKey::Session {
                session_id: "codex:a".into(),
            }],
        )
        .unwrap();
        assert_eq!(pinned_ids(&state), vec!["codex:b"]);
        assert_eq!(read_state(project.path()), state);
    }

    #[test]
    fn artifact_keys_are_normalized_and_invalid_paths_rejected() {
        let project = project();
        write(
            &project.path().join("child"),
            "notes/plan/README.md",
            &page("Plan"),
        );
        let state = pin(
            project.path(),
            NavigationItem {
                key: child_page("/notes\\plan/README.md"),
                title: "Plan".into(),
                icon: Some("📄".into()),
            },
        )
        .unwrap();
        assert_eq!(state.pinned[0].item.key, child_page("notes/plan"));
        assert!(
            pin(
                project.path(),
                NavigationItem {
                    key: NavigationKey::Page {
                        space_id: None,
                        path: "../outside".into(),
                    },
                    title: "Outside".into(),
                    icon: None,
                },
            )
            .is_err()
        );
    }

    #[test]
    fn missing_corrupt_or_unknown_version_file_reads_empty_and_is_replaced() {
        let project = project();
        assert_eq!(read_state(project.path()), NavigationState::default());

        let path = file_path(project.path());
        for content in ["not json", r#"{"version":99,"pinned":[{"bad":true}]}"#] {
            std::fs::write(&path, content).unwrap();
            assert_eq!(read_state(project.path()), NavigationState::default());
            assert!(expanded_paths(project.path()).unwrap().is_empty());
        }

        pin(project.path(), session("codex:a")).unwrap();
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(written["version"], serde_json::json!(VERSION));
        assert_eq!(pinned_ids(&read_state(project.path())), vec!["codex:a"]);
    }

    #[test]
    fn expansion_is_kept_per_space_and_pruned_for_removed_spaces() {
        let project = project();
        let child = project.path().join("child");
        save_expanded_paths(project.path(), vec!["root-folder".into()]).unwrap();
        save_expanded_paths(&child, vec!["a".into(), "a/b".into()]).unwrap();

        assert_eq!(expanded_paths(project.path()).unwrap(), vec!["root-folder"]);
        assert_eq!(expanded_paths(&child).unwrap(), vec!["a", "a/b"]);
        assert!(save_expanded_paths(&project.path().join("stray"), vec![]).is_err());

        std::fs::write(
            project.path().join(".svode/config.json"),
            serde_json::json!({ "name": "Project", "spaces": [] }).to_string(),
        )
        .unwrap();
        pin(project.path(), session("codex:a")).unwrap();
        let file = read_file(project.path());
        assert_eq!(
            file.expanded,
            vec![SpaceExpansion {
                space_id: None,
                paths: vec!["root-folder".into()],
            }]
        );
    }

    #[test]
    fn unreadable_project_config_keeps_expansion_of_every_space() {
        let project = project();
        save_expanded_paths(&project.path().join("child"), vec!["a".into()]).unwrap();
        std::fs::write(project.path().join(".svode/config.json"), "broken").unwrap();

        pin(project.path(), session("codex:a")).unwrap();
        assert_eq!(read_file(project.path()).expanded.len(), 1);
    }

    #[test]
    fn writes_leave_local_config_and_variables_lock_alone() {
        let project = project();
        let lock = svode_core::variables::files::lock(&project.path().join(".svode")).unwrap();
        std::fs::write(project.path().join(".svode/variables.pending.json"), "{}").unwrap();

        pin(project.path(), session("codex:a")).unwrap();
        save_expanded_paths(project.path(), vec!["folder".into()]).unwrap();

        drop(lock);
        assert!(!project.path().join(".svode/local.json").exists());
        assert_eq!(pinned_ids(&read_state(project.path())), vec!["codex:a"]);
    }

    #[test]
    fn state_file_and_its_replacements_are_git_local() {
        assert!(svode_core::git::policy::contains(".svode/navigation.json"));
        assert!(svode_core::git::policy::contains(&format!(
            ".svode/{TEMP_PREFIX}abc"
        )));
        assert!(svode_core::git::policy::contains(&format!(
            "child/.svode/{FILE_NAME}"
        )));
    }

    #[test]
    fn pinned_targets_resolve_against_their_sources() {
        let project = project();
        let child = project.path().join("child");
        write(&child, "notes/plan.md", &page("Plan"));
        write(&child, "docs/README.md", &page("Docs"));
        write(&child, "files/scan.pdf", "pdf");
        let attachment_key = NavigationKey::Attachment {
            space_id: Some("child-id".into()),
            path: "files/scan.pdf".into(),
        };
        for item in [
            artifact(child_page("notes/plan.md"), "Old title"),
            artifact(child_page("docs"), "Docs"),
            artifact(attachment_key.clone(), "scan.pdf"),
            artifact(
                NavigationKey::Space {
                    space_id: Some("child-id".into()),
                },
                "Child",
            ),
            artifact(NavigationKey::Space { space_id: None }, "Project"),
            session("codex:a"),
        ] {
            pin(project.path(), item).unwrap();
        }
        // A target already gone is not kept.
        let state = pin(project.path(), artifact(child_page("gone.md"), "Gone")).unwrap();
        assert_eq!(
            shown(&state),
            vec![
                (child_page("notes/plan.md"), "Plan".into(), Some(true)),
                (child_page("docs"), "Docs".into(), Some(true)),
                (attachment_key.clone(), "scan.pdf".into(), Some(true)),
                (
                    NavigationKey::Space {
                        space_id: Some("child-id".into())
                    },
                    "Child".into(),
                    Some(true)
                ),
                (
                    NavigationKey::Space { space_id: None },
                    "Project".into(),
                    Some(true)
                ),
                (
                    NavigationKey::Session {
                        session_id: "codex:a".into()
                    },
                    "codex:a".into(),
                    None
                ),
            ]
        );

        // A deleted target is dropped by the read that confirms it.
        std::fs::remove_dir_all(child.join("docs")).unwrap();
        std::fs::remove_file(child.join("files/scan.pdf")).unwrap();
        assert_eq!(pinned_ids(&read_state(project.path())).len(), 4);

        // A missing Space keeps its pins as unavailable with the last title.
        std::fs::rename(&child, project.path().join("moved-away")).unwrap();
        let state = read_state(project.path());
        assert_eq!(
            shown(&state)[..2],
            [
                (child_page("notes/plan.md"), "Plan".into(), Some(false)),
                (
                    NavigationKey::Space {
                        space_id: Some("child-id".into())
                    },
                    "Child".into(),
                    Some(false)
                ),
            ]
        );

        // An unreadable Project config confirms nothing.
        std::fs::write(project.path().join(".svode/config.json"), "broken").unwrap();
        assert_eq!(read_state(project.path()).pinned.len(), 4);

        // A Space removed from the Project takes its pins with it.
        std::fs::write(
            project.path().join(".svode/config.json"),
            serde_json::json!({ "name": "Project", "spaces": [] }).to_string(),
        )
        .unwrap();
        assert_eq!(
            pinned_ids(&read_state(project.path())),
            vec!["Space { space_id: None }", "codex:a"]
        );
    }

    #[test]
    fn in_app_path_changes_move_keys_in_place() {
        let project = project();
        let child = project.path().join("child");
        write(&child, "notes/plan.md", &page("Plan"));
        write(&child, "area/README.md", &page("Area"));
        write(&child, "area/sub.md", &page("Sub"));
        write(project.path(), "area/README.md", &page("Root area"));
        for item in [
            session("codex:a"),
            artifact(child_page("notes/plan.md"), "Plan"),
            artifact(child_page("area/sub.md"), "Sub"),
            artifact(child_page("area"), "Area"),
            artifact(
                NavigationKey::Page {
                    space_id: None,
                    path: "area".into(),
                },
                "Root area",
            ),
        ] {
            pin(project.path(), item).unwrap();
        }
        let keys = || {
            read_state(project.path())
                .pinned
                .into_iter()
                .map(|pinned| pinned.item.key)
                .collect::<Vec<_>>()
        };

        // Rename of a leaf Page.
        std::fs::rename(child.join("notes/plan.md"), child.join("notes/next.md")).unwrap();
        assert!(retarget(&child, "notes/plan.md", "notes/next.md").unwrap());
        // Move of a folder Page with everything under it, in its Space only.
        std::fs::create_dir_all(child.join("archive")).unwrap();
        std::fs::rename(child.join("area"), child.join("archive/area")).unwrap();
        assert!(retarget(&child, "area/README.md", "archive/area/README.md").unwrap());
        // Leaf → folder, then folder → Collection at the same path.
        std::fs::create_dir_all(child.join("notes/next")).unwrap();
        std::fs::rename(
            child.join("notes/next.md"),
            child.join("notes/next/README.md"),
        )
        .unwrap();
        assert!(retarget(&child, "notes/next.md", "notes/next/README.md").unwrap());
        write(&child, "notes/next/schema.yaml", "fields: []\n");
        assert!(retarget(&child, "notes/next/README.md", "notes/next/README.md").unwrap());

        assert_eq!(
            keys(),
            vec![
                NavigationKey::Session {
                    session_id: "codex:a".into()
                },
                NavigationKey::Collection {
                    space_id: Some("child-id".into()),
                    path: "notes/next".into(),
                },
                child_page("archive/area/sub.md"),
                child_page("archive/area"),
                NavigationKey::Page {
                    space_id: None,
                    path: "area".into(),
                },
            ]
        );

        // An external rename is a removal.
        std::fs::rename(
            child.join("archive/area/sub.md"),
            child.join("archive/area/x.md"),
        )
        .unwrap();
        assert_eq!(keys().len(), 4);

        // Unpin addresses the object, whatever form the caller knew.
        let state = forget(project.path(), vec![child_page("notes/next/README.md")]).unwrap();
        assert_eq!(state.pinned.len(), 3);
        assert_eq!(
            state.pinned[1].open_path.as_deref(),
            Some("archive/area/README.md")
        );
    }

    #[test]
    fn reads_during_a_path_change_keep_missing_targets() {
        let project = project();
        let child = project.path().join("child");
        write(&child, "plan.md", &page("Plan"));
        pin(project.path(), artifact(child_page("plan.md"), "Plan")).unwrap();

        let change = path_change(&child.to_string_lossy());
        std::fs::rename(child.join("plan.md"), child.join("next.md")).unwrap();
        assert_eq!(
            shown(&read_state(project.path())),
            vec![(child_page("plan.md"), "Plan".into(), Some(false))]
        );
        assert!(retarget(&child, "plan.md", "next.md").unwrap());
        drop(change);

        assert_eq!(
            shown(&read_state(project.path())),
            vec![(child_page("next.md"), "Plan".into(), Some(true))]
        );
    }

    fn kept_ids(state: &NavigationState) -> Vec<String> {
        pinned_ids(&NavigationState {
            pinned: state.kept.clone(),
            kept: Vec::new(),
        })
    }

    fn session_key(id: &str) -> NavigationKey {
        NavigationKey::Session {
            session_id: id.into(),
        }
    }

    #[test]
    fn kept_items_keep_order_and_are_never_also_pinned() {
        let project = project();
        keep(project.path(), session("codex:a")).unwrap();
        keep(project.path(), session("codex:b")).unwrap();
        pin(project.path(), session("codex:c")).unwrap();
        // Keeping a kept item refreshes it in place; a pinned one stays pinned.
        keep(
            project.path(),
            NavigationItem {
                title: "Renamed".into(),
                ..session("codex:a")
            },
        )
        .unwrap();
        let state = keep(project.path(), session("codex:c")).unwrap();
        assert_eq!(kept_ids(&state), vec!["codex:a", "codex:b"]);
        assert_eq!(state.kept[0].item.title, "Renamed");
        assert_eq!(pinned_ids(&state), vec!["codex:c"]);
        assert_eq!(read_state(project.path()), state);

        // Pinning a kept item moves it to the pinned list.
        let state = pin(project.path(), session("codex:a")).unwrap();
        assert_eq!(kept_ids(&state), vec!["codex:b"]);
        assert_eq!(pinned_ids(&state), vec!["codex:c", "codex:a"]);

        // Unpin and close touch only their own list; a confirmed-missing
        // target leaves both.
        keep(project.path(), session("codex:d")).unwrap();
        let state = unpin(project.path(), vec![session_key("codex:b")]).unwrap();
        assert_eq!(kept_ids(&state), vec!["codex:b", "codex:d"]);
        let state = unkeep(project.path(), vec![session_key("codex:c")]).unwrap();
        assert_eq!(pinned_ids(&state), vec!["codex:c", "codex:a"]);
        let state = unkeep(project.path(), vec![session_key("codex:b")]).unwrap();
        assert_eq!(kept_ids(&state), vec!["codex:d"]);
        let state = forget(
            project.path(),
            vec![session_key("codex:a"), session_key("codex:d")],
        )
        .unwrap();
        assert_eq!(pinned_ids(&state), vec!["codex:c"]);
        assert!(state.kept.is_empty());
    }

    #[test]
    fn retitle_refreshes_snapshots_without_adding() {
        let project = project();
        pin(project.path(), session("codex:a")).unwrap();
        keep(project.path(), session("codex:b")).unwrap();
        for id in ["codex:a", "codex:b", "codex:c"] {
            retitle(
                project.path(),
                NavigationItem {
                    title: format!("{id} now"),
                    ..session(id)
                },
            )
            .unwrap();
        }
        let state = read_state(project.path());
        assert_eq!(state.pinned[0].item.title, "codex:a now");
        assert_eq!(state.kept[0].item.title, "codex:b now");
        assert_eq!(pinned_ids(&state), vec!["codex:a"]);
        assert_eq!(kept_ids(&state), vec!["codex:b"]);
    }

    #[test]
    fn kept_artifacts_resolve_and_follow_in_app_path_changes() {
        let project = project();
        let child = project.path().join("child");
        write(&child, "notes/plan.md", &page("Plan"));
        write(&child, "gone.md", &page("Gone"));
        keep(project.path(), artifact(child_page("notes/plan.md"), "Old")).unwrap();
        let state = keep(project.path(), artifact(child_page("gone.md"), "Gone")).unwrap();
        assert_eq!(
            shown(&NavigationState {
                pinned: state.kept.clone(),
                kept: Vec::new(),
            }),
            vec![
                (child_page("notes/plan.md"), "Plan".into(), Some(true)),
                (child_page("gone.md"), "Gone".into(), Some(true)),
            ]
        );

        std::fs::remove_file(child.join("gone.md")).unwrap();
        std::fs::rename(child.join("notes/plan.md"), child.join("notes/next.md")).unwrap();
        assert!(retarget(&child, "notes/plan.md", "notes/next.md").unwrap());
        let state = read_state(project.path());
        assert_eq!(state.kept.len(), 1);
        assert_eq!(state.kept[0].item.key, child_page("notes/next.md"));

        // A missing Space keeps its kept items as unavailable.
        std::fs::rename(&child, project.path().join("moved-away")).unwrap();
        assert_eq!(read_state(project.path()).kept[0].available, Some(false));
    }

    #[test]
    fn describe_resolves_without_recording() {
        let project = project();
        let child = project.path().join("child");
        write(&child, "docs/README.md", &page("Docs"));
        write(&child, "docs/schema.yaml", "fields: []\n");

        let described = describe(
            project.path(),
            artifact(child_page("docs/README.md"), "README.md"),
        )
        .unwrap()
        .expect("available collection");
        assert_eq!(
            described.item.key,
            NavigationKey::Collection {
                space_id: Some("child-id".into()),
                path: "docs".into(),
            }
        );
        assert_eq!(described.item.title, "Docs");
        assert_eq!(described.available, Some(true));
        assert_eq!(read_state(project.path()), NavigationState::default());

        assert!(
            describe(project.path(), artifact(child_page("gone.md"), "gone"))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn writes_require_a_project() {
        let temp = tempfile::tempdir().unwrap();
        assert!(pin(temp.path(), session("codex:a")).is_err());
        assert!(!temp.path().join(".svode").exists());
    }
}

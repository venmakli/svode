//! The list of Projects of the device (`spaces.json` in the device-local
//! config directory of the install, [`crate::runtime::device::config_dir`]).
//! Every host reads it from the same directory; every change is a
//! read-modify-write under an advisory lock on a device-local lock file next
//! to it and lands by an atomic replace, so writers of different processes
//! do not lose each other's entries and a reader never sees a partial file.
//! A write keeps the keys it does not know and a last view of a later
//! version.

use std::fs::{File, OpenOptions, TryLockError};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

use crate::space_config::UnknownKeys;
use crate::system_path;

/// The file of the list in the config directory.
pub const REGISTRY_FILE: &str = "spaces.json";

/// The lock file of the list, next to it.
const LOCK_FILE: &str = "spaces.lock";

/// Longest wait for the lock another writer holds. Not a public contract.
const LOCK_WAIT: Duration = Duration::from_secs(3);
const LOCK_RETRY: Duration = Duration::from_millis(10);

#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("The project list cannot be read: {0}")]
    Json(#[from] serde_json::Error),
    /// Another writer held the list for longer than the bounded wait.
    #[error("The project list is busy in another Svode process: {0}")]
    Busy(String),
    #[error("Project registration is unavailable")]
    NotRegistered,
    #[error("Project registration is ambiguous")]
    Ambiguous,
}

/// The Projects of the device and the view the last window showed.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRegistry {
    #[serde(default)]
    pub spaces: Vec<RegistryEntry>,
    pub last_active: Option<String>,
    /// The view of the window the user was in last; the launch opens it.
    /// Earlier Svode versions ignore it and launch into `last_active`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_view: Option<LastView>,
    #[serde(flatten)]
    pub extensions: UnknownKeys,
}

/// One Project of the list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryEntry {
    pub id: String,
    pub last_opened: Option<String>,
    pub path: String,
    #[serde(flatten)]
    pub extensions: UnknownKeys,
}

impl RegistryEntry {
    pub fn new(id: &str, path: &str) -> Self {
        Self {
            id: id.to_string(),
            last_opened: None,
            path: system_path::user_facing_path_str(path),
            extensions: UnknownKeys::new(),
        }
    }
}

/// The view of the window the user was in last.
#[derive(Debug, Clone, PartialEq)]
pub enum LastView {
    Home,
    Project {
        project_id: String,
    },
    /// A view written by a later Svode version: the launch treats it as an
    /// absent view, and a write keeps it as it is.
    Unknown(Value),
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum KnownView {
    Home,
    Project {
        #[serde(rename = "projectId")]
        project_id: String,
    },
}

impl Serialize for LastView {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Home => KnownView::Home.serialize(serializer),
            Self::Project { project_id } => KnownView::Project {
                project_id: project_id.clone(),
            }
            .serialize(serializer),
            Self::Unknown(value) => value.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for LastView {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        Ok(match serde_json::from_value::<KnownView>(value.clone()) {
            Ok(KnownView::Home) => Self::Home,
            Ok(KnownView::Project { project_id }) => Self::Project { project_id },
            Err(_) => Self::Unknown(value),
        })
    }
}

/// The path of the list in `dir`.
pub fn file(dir: &Path) -> PathBuf {
    dir.join(REGISTRY_FILE)
}

/// Read the list; a missing file is an empty list and is not created.
pub fn read(dir: &Path) -> Result<ProjectRegistry, RegistryError> {
    let data = match std::fs::read(file(dir)) {
        Ok(data) => data,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ProjectRegistry::default());
        }
        Err(error) => return Err(error.into()),
    };
    let mut registry: ProjectRegistry = serde_json::from_slice(&data)?;
    normalize_paths(&mut registry);
    Ok(registry)
}

/// Change the list under its lock: read it, apply `operation` and replace
/// the file atomically when the list changed.
pub fn mutate<T>(
    dir: &Path,
    operation: impl FnOnce(&mut ProjectRegistry) -> T,
) -> Result<T, RegistryError> {
    let _lock = lock(dir)?;
    let before = read(dir)?;
    let mut registry = before.clone();
    let result = operation(&mut registry);
    normalize_paths(&mut registry);
    if registry != before || !file(dir).exists() {
        persist(dir, &registry)?;
    }
    Ok(result)
}

/// Replace the whole list. Only for the paths that rewrite it on purpose,
/// such as a test fixture; the list keeps unknown keys only from `registry`.
pub fn write(dir: &Path, registry: &ProjectRegistry) -> Result<(), RegistryError> {
    mutate(dir, |current| *current = registry.clone())
}

/// The id of the Project at `path`: the entry the list already has for it,
/// or a new entry.
pub fn register(dir: &Path, path: &Path) -> Result<String, RegistryError> {
    let path = system_path::user_facing_path(path);
    mutate(dir, |registry| {
        if let Some(entry) = registry.spaces.iter().find(|entry| entry.path == path) {
            return entry.id.clone();
        }
        let id = super::scaffold::new_space_id();
        registry.spaces.push(RegistryEntry::new(&id, &path));
        id
    })
}

/// Add the Project `id` at `path` unless the list has that id.
pub fn add(dir: &Path, id: &str, path: &str) -> Result<(), RegistryError> {
    mutate(dir, |registry| {
        if !registry.spaces.iter().any(|entry| entry.id == id) {
            registry.spaces.push(RegistryEntry::new(id, path));
        }
    })
}

/// The entry of the Project `id`.
pub fn find(dir: &Path, id: &str) -> Result<Option<RegistryEntry>, RegistryError> {
    Ok(read(dir)?.spaces.into_iter().find(|entry| entry.id == id))
}

/// Remove the Project `id` from the list.
pub fn remove(dir: &Path, id: &str) -> Result<(), RegistryError> {
    mutate(dir, |registry| {
        registry.spaces.retain(|entry| entry.id != id);
        if registry.last_active.as_deref() == Some(id) {
            registry.last_active = None;
        }
    })
}

/// Remember the Project the user opened last.
pub fn set_last_active(dir: &Path, id: &str) -> Result<(), RegistryError> {
    mutate(dir, |registry| registry.last_active = Some(id.to_string()))
}

/// Remember the view of the window the user was in last.
pub fn set_last_view(dir: &Path, view: LastView) -> Result<(), RegistryError> {
    mutate(dir, |registry| registry.last_view = Some(view))
}

/// Stamp the Project `id` as opened now.
pub fn touch_last_opened(dir: &Path, id: &str) -> Result<(), RegistryError> {
    let now = chrono::Utc::now().to_rfc3339();
    mutate(dir, |registry| {
        if let Some(entry) = registry.spaces.iter_mut().find(|entry| entry.id == id) {
            entry.last_opened = Some(now);
        }
    })
}

/// The one entry whose folder is `path`; reading never registers a Project.
pub fn find_by_path(dir: &Path, path: &Path) -> Result<RegistryEntry, RegistryError> {
    let path = path.canonicalize()?;
    let registry = read(dir)?;
    let mut matches = registry
        .spaces
        .iter()
        .filter(|entry| Path::new(&entry.path).canonicalize().ok().as_ref() == Some(&path));
    let project = matches.next().ok_or(RegistryError::NotRegistered)?;
    if matches.next().is_some()
        || project.id.is_empty()
        || registry
            .spaces
            .iter()
            .filter(|entry| entry.id == project.id)
            .count()
            != 1
    {
        return Err(RegistryError::Ambiguous);
    }
    Ok(project.clone())
}

fn normalize_paths(registry: &mut ProjectRegistry) {
    for entry in &mut registry.spaces {
        entry.path = system_path::user_facing_path_str(&entry.path);
    }
}

/// The lock of every read-modify-write of the list. The operating system
/// releases it when its holder exits, so a crash leaves no stale lock; a
/// second handle of the same process waits like another process.
fn lock(dir: &Path) -> Result<File, RegistryError> {
    std::fs::create_dir_all(dir)?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join(LOCK_FILE))?;
    let deadline = Instant::now() + LOCK_WAIT;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                std::thread::sleep(LOCK_RETRY);
            }
            Err(TryLockError::WouldBlock) => {
                return Err(RegistryError::Busy(system_path::user_facing_path(
                    &self::file(dir),
                )));
            }
            Err(TryLockError::Error(error)) => return Err(error.into()),
        }
    }
}

/// The caller holds the lock.
fn persist(dir: &Path, registry: &ProjectRegistry) -> Result<(), RegistryError> {
    let mut staged = tempfile::NamedTempFile::new_in(dir)?;
    staged.write_all(serde_json::to_string_pretty(registry)?.as_bytes())?;
    staged.as_file().sync_all()?;
    staged
        .persist(file(dir))
        .map_err(|error| RegistryError::Io(error.error))?;
    #[cfg(unix)]
    File::open(dir)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reading_normalizes_windows_verbatim_paths() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            file(dir.path()),
            r#"{
  "spaces": [
    {
      "id": "root",
      "lastOpened": null,
      "path": "\\\\?\\C:\\Users\\eeeoo\\Documents\\pro\\mine"
    }
  ],
  "lastActive": "root"
}"#,
        )
        .unwrap();

        let registry = read(dir.path()).unwrap();

        assert_eq!(
            registry.spaces[0].path,
            r"C:\Users\eeeoo\Documents\pro\mine"
        );
    }

    #[test]
    fn a_missing_list_reads_empty_and_is_not_created() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read(dir.path()).unwrap(), ProjectRegistry::default());
        assert!(!file(dir.path()).exists());
    }

    #[test]
    fn a_list_without_the_last_view_reads_as_before() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            file(dir.path()),
            r#"{ "spaces": [{ "id": "root", "lastOpened": null, "path": "/p" }], "lastActive": "root" }"#,
        )
        .unwrap();

        let registry = read(dir.path()).unwrap();

        assert_eq!(registry.last_active.as_deref(), Some("root"));
        assert_eq!(registry.last_view, None);
    }

    #[test]
    fn the_last_view_is_stored_beside_the_last_active_project() {
        let dir = tempfile::tempdir().unwrap();
        add(dir.path(), "root", "/p").unwrap();
        set_last_active(dir.path(), "root").unwrap();

        set_last_view(dir.path(), LastView::Home).unwrap();

        let stored: Value = serde_json::from_slice(&std::fs::read(file(dir.path())).unwrap())
            .expect("parse registry");
        assert_eq!(stored["lastActive"], "root");
        assert_eq!(stored["lastView"], serde_json::json!({ "kind": "home" }));
        assert_eq!(stored["spaces"][0]["lastOpened"], Value::Null);

        set_last_view(
            dir.path(),
            LastView::Project {
                project_id: "root".to_string(),
            },
        )
        .unwrap();
        assert_eq!(
            read(dir.path()).unwrap().last_view,
            Some(LastView::Project {
                project_id: "root".to_string()
            })
        );
    }

    #[test]
    fn writes_keep_the_last_view_and_the_keys_of_a_later_version() {
        let dir = tempfile::tempdir().unwrap();
        let later_view = serde_json::json!({ "kind": "workspace", "workspaceId": "w" });
        std::fs::write(
            file(dir.path()),
            serde_json::json!({
                "spaces": [{ "id": "a", "lastOpened": null, "path": "/a", "pinned": true }],
                "lastActive": "a",
                "lastView": later_view,
                "futureList": { "kept": 1 }
            })
            .to_string(),
        )
        .unwrap();
        let registry = read(dir.path()).unwrap();
        assert_eq!(
            registry.last_view,
            Some(LastView::Unknown(later_view.clone()))
        );

        register(dir.path(), Path::new("/b")).unwrap();
        touch_last_opened(dir.path(), "a").unwrap();
        set_last_active(dir.path(), "a").unwrap();

        let stored: Value = serde_json::from_slice(&std::fs::read(file(dir.path())).unwrap())
            .expect("parse registry");
        assert_eq!(stored["lastView"], later_view);
        assert_eq!(stored["futureList"], serde_json::json!({ "kept": 1 }));
        assert_eq!(stored["spaces"][0]["pinned"], true);
        assert!(stored["spaces"][0]["lastOpened"].is_string());
        assert_eq!(stored["spaces"][1]["path"], "/b");

        set_last_view(dir.path(), LastView::Home).unwrap();
        let stored: Value = serde_json::from_slice(&std::fs::read(file(dir.path())).unwrap())
            .expect("parse registry");
        assert_eq!(stored["lastView"], serde_json::json!({ "kind": "home" }));
        assert_eq!(stored["futureList"], serde_json::json!({ "kept": 1 }));
    }

    #[test]
    fn registering_a_listed_folder_keeps_its_id() {
        let dir = tempfile::tempdir().unwrap();
        let first = register(dir.path(), Path::new("/p")).unwrap();
        let again = register(dir.path(), Path::new("/p")).unwrap();
        let other = register(dir.path(), Path::new("/q")).unwrap();

        assert_eq!(first, again);
        assert_ne!(first, other);
        assert_eq!(read(dir.path()).unwrap().spaces.len(), 2);
    }

    #[test]
    fn removing_the_last_active_project_clears_it() {
        let dir = tempfile::tempdir().unwrap();
        add(dir.path(), "a", "/a").unwrap();
        set_last_active(dir.path(), "a").unwrap();

        remove(dir.path(), "a").unwrap();

        let registry = read(dir.path()).unwrap();
        assert!(registry.spaces.is_empty());
        assert_eq!(registry.last_active, None);
        assert_eq!(find(dir.path(), "a").unwrap(), None);
    }

    #[test]
    fn a_held_lock_makes_a_writer_wait_and_then_busy() {
        let dir = tempfile::tempdir().unwrap();
        let held = lock(dir.path()).unwrap();
        let started = Instant::now();

        let busy = add(dir.path(), "a", "/a");

        assert!(started.elapsed() >= LOCK_WAIT);
        assert!(matches!(busy, Err(RegistryError::Busy(_))));
        drop(held);
        add(dir.path(), "a", "/a").unwrap();
    }

    /// Writers in several processes register Projects at once; the list
    /// keeps every one of them.
    #[test]
    fn processes_registering_at_once_keep_every_project() {
        const CHILD: &str = "SVODE_PROJECT_REGISTRY_TEST_DIRECTORY";
        const PER_WRITER: usize = 15;
        if let Some(dir) = std::env::var_os(CHILD) {
            let dir = PathBuf::from(dir);
            let writer = std::process::id();
            for index in 0..PER_WRITER {
                register(&dir, Path::new(&format!("/projects/{writer}-{index}"))).unwrap();
            }
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            file(dir.path()),
            r#"{ "spaces": [], "lastActive": null, "lastView": { "kind": "home" }, "future": 1 }"#,
        )
        .unwrap();
        let children = (0..3)
            .map(|_| {
                std::process::Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "project::registry::tests::processes_registering_at_once_keep_every_project",
                        "--nocapture",
                    ])
                    .env(CHILD, dir.path())
                    .stdout(std::process::Stdio::piped())
                    .spawn()
                    .unwrap()
            })
            .collect::<Vec<_>>();
        for index in 0..PER_WRITER {
            register(dir.path(), Path::new(&format!("/projects/parent-{index}"))).unwrap();
        }
        for child in children {
            let output = child.wait_with_output().unwrap();
            assert!(output.status.success());
            assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed;"));
        }

        let registry = read(dir.path()).unwrap();
        assert_eq!(registry.spaces.len(), 4 * PER_WRITER);
        assert_eq!(registry.last_view, Some(LastView::Home));
        assert_eq!(registry.extensions["future"], 1);
    }
}

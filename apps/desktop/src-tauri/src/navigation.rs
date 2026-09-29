//! Device-local navigation state of one Project: pinned objects and the
//! expanded folders of the Artifacts tree of each registered Space.
//!
//! It is recoverable UI state in its own file under the Project `.svode/`,
//! covered by the managed Git local policy (`svode_core::git::policy`). It
//! shares no lock, recovery or watcher invalidation with `.svode/local.json`.
//! A missing, unreadable or unknown-version file reads as empty and is
//! replaced by the next write.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::AppError;

const FILE_NAME: &str = "navigation.json";
/// Replacement files match the same local policy entry as the state file.
const TEMP_PREFIX: &str = "navigation.tmp-";
const VERSION: u32 = 1;

/// Serializes read-modify-write of navigation files in this process.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

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
                path: path(p)?,
            },
            Self::Collection { space_id, path: p } => Self::Collection {
                space_id,
                path: path(p)?,
            },
            Self::Attachment { space_id, path: p } => Self::Attachment {
                space_id,
                path: path(p)?,
            },
            Self::App { space_id, path: p } => Self::App {
                space_id,
                path: path(p)?,
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

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationState {
    /// In pin order, newest last.
    pub pinned: Vec<NavigationItem>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpaceExpansion {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    space_id: Option<String>,
    paths: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NavigationFile {
    version: u32,
    #[serde(default)]
    pinned: Vec<NavigationItem>,
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

    fn state(self) -> NavigationState {
        NavigationState {
            pinned: self.pinned,
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

fn mutate<T>(
    project: &Path,
    operation: impl FnOnce(&mut NavigationFile) -> Result<T, AppError>,
) -> Result<T, AppError> {
    if !project.join(".svode/config.json").is_file() {
        return Err(AppError::SpaceNotFound(
            svode_core::system_path::user_facing_path(project),
        ));
    }
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let mut file = read_file(project);
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
    file.version = VERSION;
    write_file(project, &file)?;
    Ok(result)
}

pub fn read_state(project: &Path) -> NavigationState {
    read_file(project).state()
}

/// Pins an item at the end, or refreshes the snapshot of an existing pin in
/// place.
pub fn pin(project: &Path, item: NavigationItem) -> Result<NavigationState, AppError> {
    let item = NavigationItem {
        key: item.key.normalized()?,
        ..item
    };
    mutate(project, |file| {
        match file.pinned.iter_mut().find(|pinned| pinned.key == item.key) {
            Some(pinned) => *pinned = item,
            None => file.pinned.push(item),
        }
        Ok(file.clone().state())
    })
}

/// Removes the given keys from the navigation state: an explicit unpin, or
/// targets whose absence a successful read of their source confirmed.
pub fn forget(project: &Path, keys: Vec<NavigationKey>) -> Result<NavigationState, AppError> {
    let keys = keys
        .into_iter()
        .map(NavigationKey::normalized)
        .collect::<Result<Vec<_>, _>>()?;
    mutate(project, |file| {
        file.pinned.retain(|pinned| !keys.contains(&pinned.key));
        Ok(file.clone().state())
    })
}

/// Project and registered Space id (`None` for the Project root) of a Space
/// directory.
fn expansion_target(space: &Path) -> Result<(PathBuf, Option<String>), AppError> {
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
    let (project, space_id) = expansion_target(space)?;
    Ok(read_file(&project)
        .expanded
        .into_iter()
        .find(|expansion| expansion.space_id == space_id)
        .map(|expansion| expansion.paths)
        .unwrap_or_default())
}

pub fn save_expanded_paths(space: &Path, paths: Vec<String>) -> Result<(), AppError> {
    let (project, space_id) = expansion_target(space)?;
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

    use super::{NavigationItem, NavigationKey, NavigationState};
    use crate::error::AppError;

    #[tauri::command]
    pub fn navigation_read(project_path: String) -> NavigationState {
        super::read_state(Path::new(&project_path))
    }

    #[tauri::command]
    pub fn navigation_pin(
        project_path: String,
        item: NavigationItem,
    ) -> Result<NavigationState, AppError> {
        super::pin(Path::new(&project_path), item)
    }

    #[tauri::command]
    pub fn navigation_forget(
        project_path: String,
        keys: Vec<NavigationKey>,
    ) -> Result<NavigationState, AppError> {
        super::forget(Path::new(&project_path), keys)
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
            .map(|item| match &item.key {
                NavigationKey::Session { session_id } => session_id.clone(),
                other => format!("{other:?}"),
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
        assert_eq!(state.pinned[0].title, "Renamed");
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
        let state = pin(
            project.path(),
            NavigationItem {
                key: NavigationKey::Page {
                    space_id: Some("child-id".into()),
                    path: "/notes\\plan/".into(),
                },
                title: "Plan".into(),
                icon: Some("📄".into()),
            },
        )
        .unwrap();
        assert_eq!(
            state.pinned[0].key,
            NavigationKey::Page {
                space_id: Some("child-id".into()),
                path: "notes/plan".into(),
            }
        );
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
    fn writes_require_a_project() {
        let temp = tempfile::tempdir().unwrap();
        assert!(pin(temp.path(), session("codex:a")).is_err());
        assert!(!temp.path().join(".svode").exists());
    }
}

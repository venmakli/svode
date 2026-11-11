//! Space membership of a path: the root and the contents of a registered
//! child Space belong to that child Space, not to the Space that registers
//! it. Writes addressed through a Space, the standalone Page read and the
//! rename by path all refuse a path that another Space owns by this rule.

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;

use super::PageError;
use super::source::PageSourceError;
use super::target::SpaceReference;

/// Registered child Spaces of one Space directory (`spaces[]` of its
/// `.svode/config.json`) with their canonical roots, read once to classify
/// several paths of that Space.
#[derive(Debug, Clone, Default)]
pub struct ChildSpaceRoots {
    space: PathBuf,
    children: Vec<ChildSpaceRoot>,
}

#[derive(Debug, Clone)]
struct ChildSpaceRoot {
    id: String,
    /// Registered path relative to the Space, with `/` separators.
    registered: String,
    /// Canonical root, `None` while the child is absent on disk (no clone,
    /// uninitialized submodule).
    root: Option<PathBuf>,
}

#[derive(Deserialize)]
struct SpacesConfig {
    #[serde(default)]
    spaces: Option<Vec<SpaceReference>>,
}

impl ChildSpaceRoots {
    /// Child Spaces registered by the Space at `space`. A Space without a
    /// config, or a missing directory, registers none; an unreadable or
    /// invalid config is an error, so a write is never let through blind.
    pub fn read(space: &Path) -> Result<Self, PageSourceError> {
        let Ok(space) = fs::canonicalize(space) else {
            return Ok(Self::default());
        };
        let config_path = space.join(".svode/config.json");
        let bytes = match fs::read(&config_path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self {
                    space,
                    children: Vec::new(),
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                return Err(PageSourceError::Access(config_path.display().to_string()));
            }
            Err(error) => return Err(PageSourceError::Io(error)),
        };
        let config: SpacesConfig =
            serde_json::from_slice(&bytes).map_err(PageSourceError::InvalidConfig)?;
        let children = config
            .spaces
            .unwrap_or_default()
            .into_iter()
            .map(|reference| {
                let registered = normalized_components(&reference.path).join("/");
                let root = (!registered.is_empty())
                    .then(|| fs::canonicalize(space.join(&registered)).ok())
                    .flatten();
                ChildSpaceRoot {
                    id: reference.id,
                    registered,
                    root,
                }
            })
            .filter(|child| !child.registered.is_empty())
            .collect();
        Ok(Self { space, children })
    }

    /// Id of the registered child Space that owns `path` (relative to the
    /// Space): the path is its root or lies inside it. The path is compared
    /// canonically, so neither a symlink nor another letter case on a
    /// case-insensitive file system reaches around the rule. The repository
    /// type and readiness of the child do not matter: an absent child still
    /// owns its registered path, compared ignoring ASCII case.
    pub fn owner_of(&self, path: &str) -> Option<&str> {
        if self.children.is_empty() {
            return None;
        }
        let candidate = canonical_candidate(&self.space, path);
        let relative = candidate
            .strip_prefix(&self.space)
            .ok()
            .map(|relative| relative.to_string_lossy().replace('\\', "/").to_lowercase());
        self.children
            .iter()
            .find(|child| match &child.root {
                Some(root) => candidate.starts_with(root),
                None => relative.as_deref().is_some_and(|relative| {
                    let registered = child.registered.to_lowercase();
                    relative == registered
                        || relative
                            .strip_prefix(&registered)
                            .is_some_and(|rest| rest.starts_with('/'))
                }),
            })
            .map(|child| child.id.as_str())
    }
}

/// Refuse `path`, addressed through the Space at `space`, when a registered
/// child Space owns it. Every write operation that takes a path of a Space
/// calls this for its source, parent and destination before its first
/// write.
pub fn ensure_path_in_space(space: impl AsRef<Path>, path: &str) -> Result<(), PageError> {
    match ChildSpaceRoots::read(space.as_ref())?.owner_of(path) {
        Some(space_id) => Err(PageError::PathInOtherSpace {
            path: path.to_string(),
            space_id: space_id.to_string(),
        }),
        None => Ok(()),
    }
}

/// Path components of `path` without empty and `.` parts, with `..`
/// applied lexically and either separator accepted.
fn normalized_components(path: &str) -> Vec<String> {
    let mut components: Vec<String> = Vec::new();
    for component in Path::new(&path.replace('\\', "/")).components() {
        match component {
            Component::Normal(part) => components.push(part.to_string_lossy().into_owned()),
            Component::ParentDir => {
                components.pop();
            }
            Component::CurDir | Component::RootDir | Component::Prefix(_) => {}
        }
    }
    components
}

/// Canonical form of `space/path`: every existing prefix is resolved by
/// the file system (symlinks, letter case), the missing rest is appended
/// as given.
fn canonical_candidate(space: &Path, path: &str) -> PathBuf {
    let mut current = space.to_path_buf();
    let mut components = normalized_components(path).into_iter();
    for component in components.by_ref() {
        let next = current.join(&component);
        match fs::canonicalize(&next) {
            Ok(resolved) => current = resolved,
            Err(_) => {
                current = next;
                break;
            }
        }
    }
    for component in components {
        current.push(component);
    }
    current
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(root: &Path) {
        fs::create_dir_all(root.join(".svode")).unwrap();
        fs::write(
            root.join(".svode/config.json"),
            r#"{"name":"Root","spaces":[{"id":"eng","path":"eng"},{"id":"absent","path":"absent","repo":"https://example.invalid/absent.git"}]}"#,
        )
        .unwrap();
        fs::create_dir_all(root.join("eng/.svode")).unwrap();
        fs::write(root.join("eng/.svode/config.json"), r#"{"name":"Eng"}"#).unwrap();
        fs::write(root.join("eng/Spec.md"), "spec").unwrap();
        fs::create_dir_all(root.join("notes")).unwrap();
    }

    #[test]
    fn a_child_space_owns_its_root_and_contents() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        project(root);
        let roots = ChildSpaceRoots::read(root).unwrap();

        for path in [
            "eng",
            "eng/",
            "./eng",
            "eng/README.md",
            "eng/Spec.md",
            "eng/New/Page.md",
            "notes/../eng/Spec.md",
            "eng\\Spec.md",
        ] {
            assert_eq!(roots.owner_of(path), Some("eng"), "{path}");
        }
        for path in [
            "",
            ".",
            "notes",
            "notes/Page.md",
            "engine.md",
            "eng.md",
            "Readme.md",
        ] {
            assert_eq!(roots.owner_of(path), None, "{path}");
        }
    }

    #[test]
    fn an_absent_child_space_still_owns_its_registered_path() {
        let temp = tempfile::tempdir().unwrap();
        project(temp.path());
        let roots = ChildSpaceRoots::read(temp.path()).unwrap();

        assert_eq!(roots.owner_of("absent"), Some("absent"));
        assert_eq!(roots.owner_of("absent/Page.md"), Some("absent"));
        assert_eq!(roots.owner_of("ABSENT/Page.md"), Some("absent"));
        assert_eq!(roots.owner_of("absentee/Page.md"), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_into_a_child_space_is_owned_by_it() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        project(root);
        std::os::unix::fs::symlink(root.join("eng"), root.join("notes/link")).unwrap();
        let roots = ChildSpaceRoots::read(root).unwrap();

        assert_eq!(roots.owner_of("notes/link"), Some("eng"));
        assert_eq!(roots.owner_of("notes/link/Spec.md"), Some("eng"));
        assert_eq!(roots.owner_of("notes/link/New.md"), Some("eng"));
    }

    #[test]
    fn another_letter_case_is_owned_on_a_case_insensitive_file_system() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        project(root);
        let case_insensitive = root.join("ENG").exists();
        let roots = ChildSpaceRoots::read(root).unwrap();

        let expected = case_insensitive.then_some("eng");
        assert_eq!(roots.owner_of("ENG"), expected);
        assert_eq!(roots.owner_of("Eng/Spec.md"), expected);
        assert_eq!(roots.owner_of("ENG/New.md"), expected);
    }

    #[test]
    fn a_space_without_children_or_config_owns_every_path() {
        let temp = tempfile::tempdir().unwrap();
        let roots = ChildSpaceRoots::read(temp.path()).unwrap();
        assert_eq!(roots.owner_of("eng/Spec.md"), None);
        assert!(ensure_path_in_space(temp.path(), "eng/Spec.md").is_ok());

        project(temp.path());
        // A child Space registers no children of its own here.
        assert!(ensure_path_in_space(temp.path().join("eng"), "Spec.md").is_ok());
    }

    #[test]
    fn an_unregistered_folder_with_a_repository_is_an_ordinary_folder() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        project(root);
        fs::create_dir_all(root.join("clone/.git")).unwrap();
        fs::create_dir_all(root.join("clone/.svode")).unwrap();
        fs::write(root.join("clone/.svode/config.json"), r#"{"name":"Clone"}"#).unwrap();

        assert!(ensure_path_in_space(root, "clone/Page.md").is_ok());
    }

    #[test]
    fn the_refusal_names_the_owning_space() {
        let temp = tempfile::tempdir().unwrap();
        project(temp.path());

        let error = ensure_path_in_space(temp.path(), "eng/README.md").unwrap_err();
        assert!(
            matches!(&error, PageError::PathInOtherSpace { path, space_id }
                if path == "eng/README.md" && space_id == "eng"),
            "{error:?}"
        );
        assert_eq!(
            error.to_string(),
            "eng/README.md belongs to Space eng; run the operation in that Space"
        );
    }

    #[test]
    fn an_invalid_config_refuses_instead_of_letting_the_write_through() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join(".svode")).unwrap();
        fs::write(temp.path().join(".svode/config.json"), "{not json").unwrap();

        assert!(ChildSpaceRoots::read(temp.path()).is_err());
        assert!(ensure_path_in_space(temp.path(), "Page.md").is_err());
    }
}

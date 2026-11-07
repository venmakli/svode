//! The `.svode/` scaffold of a Project or Space and its home README, and
//! the registration of a connected child Space.

use std::path::Path;

use super::ProjectError;
use crate::git::path::normalize_space_folder;
use crate::page::frontmatter;
use crate::page::store::PageMeta;
use crate::routines::local::{self, LocalConfigError};
use crate::space_config::{self, SpaceConfig, SpaceConfigError, SpaceRef, Unreadable};
use crate::storage::config::{AssetsSpaceConfig, SpaceGitType};
use crate::system_path;

pub const README_FILE: &str = "README.md";

/// The icon of a scaffold created without one.
pub const DEFAULT_ICON: &str = "\u{1F4C1}";

/// Who owns the storage policy of a scaffolded scope.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Storage {
    /// An Inline Space inherits the policy of its Project repository.
    Inherited,
    /// A Project, Independent or Submodule Space owns a local strategy with
    /// the default binary routing.
    Own,
}

impl Storage {
    /// The storage of a Space by its requested Git type, never by the
    /// presence of `.git` (DF-232).
    pub fn of(git_type: SpaceGitType) -> Self {
        match git_type {
            SpaceGitType::Inline => Self::Inherited,
            SpaceGitType::Independent | SpaceGitType::Submodule => Self::Own,
        }
    }

    /// The storage of an existing folder: its own repository owns its policy.
    pub fn of_folder(path: &Path) -> Self {
        if path.join(".git").symlink_metadata().is_ok() {
            Self::Own
        } else {
            Self::Inherited
        }
    }
}

/// The name of a folder, the fallback name of its Project or Space.
pub fn folder_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "Space".to_string())
}

/// A fresh id of a Project or Space registration.
pub fn new_space_id() -> String {
    ulid::Ulid::new().to_string().to_lowercase()
}

/// Ensure a scope home document exists without overwriting user content.
///
/// Returns `true` only when a new README was created.
pub fn ensure_readme(path: &Path, title: &str) -> Result<bool, std::io::Error> {
    let readme_path = path.join(README_FILE);
    if readme_path.exists() {
        return Ok(false);
    }

    std::fs::create_dir_all(path)?;
    let meta = PageMeta::new_persisted(if title.trim().is_empty() {
        "Home".to_string()
    } else {
        title.to_string()
    });
    std::fs::write(readme_path, frontmatter::serialize(&meta, ""))?;
    Ok(true)
}

/// Ensure an existing Project or Space has a home README titled by its
/// config, or by `fallback_title` when the config cannot be read.
///
/// Returns `true` only when README.md was created.
pub fn ensure_scope_readme(path: &Path, fallback_title: &str) -> Result<bool, ProjectError> {
    let title = space_config::read(path)
        .map(|config| config.name)
        .unwrap_or_else(|_| fallback_title.to_string());
    Ok(ensure_readme(path, &title)?)
}

/// Create `.svode/config.json`, `.svode/local.json` and `README.md` of a
/// scope at `path`. An existing README is kept.
pub fn scaffold(
    path: &Path,
    name: &str,
    icon: &str,
    description: &str,
    storage: Storage,
) -> Result<SpaceConfig, ProjectError> {
    std::fs::create_dir_all(path.join(".svode"))?;

    let config = SpaceConfig {
        name: name.to_string(),
        description: description.to_string(),
        icon: if icon.is_empty() {
            DEFAULT_ICON.to_string()
        } else {
            icon.to_string()
        },
        spaces: None,
        agent: None,
        defaults: None,
        git: None,
        assets: match storage {
            Storage::Inherited => None,
            Storage::Own => Some(AssetsSpaceConfig::new_project_default()),
        },
        tree: None,
        extensions: Default::default(),
    };
    space_config::create(path, &config)?;
    local::mutate_with(path, |_| Ok::<_, LocalConfigError>(()))?;
    ensure_readme(path, name)?;
    Ok(config)
}

/// The config of a folder being opened or connected.
#[derive(Debug, Clone)]
pub struct Opened {
    pub config: SpaceConfig,
    /// Why its existing config cannot be read; `config` then holds only the
    /// name of its folder.
    pub config_unreadable: Option<Unreadable>,
}

/// Read the config of a folder being opened or connected, giving it a home
/// README; only a missing config is scaffolded, and a config that cannot be
/// read stays as it is, byte for byte, without a README repair.
pub fn open(
    path: &Path,
    name: &str,
    icon: &str,
    description: &str,
    storage: Storage,
) -> Result<Opened, ProjectError> {
    match space_config::read(path) {
        Ok(config) => {
            ensure_readme(path, &config.name)?;
            Ok(Opened {
                config,
                config_unreadable: None,
            })
        }
        Err(SpaceConfigError::Missing(_)) => Ok(Opened {
            config: scaffold(path, name, icon, description, storage)?,
            config_unreadable: None,
        }),
        Err(SpaceConfigError::Unreadable(reason)) => Ok(Opened {
            config: SpaceConfig::named(&folder_name(path)),
            config_unreadable: Some(reason),
        }),
        Err(error) => Err(error.into()),
    }
}

/// A child Space connected to its Project.
#[derive(Debug, Clone)]
pub struct Connected {
    pub id: String,
    pub opened: Opened,
}

/// Connect an existing folder of `parent`, such as a fresh clone, as its
/// child Space: open or scaffold its config and register its `SpaceRef`
/// unless the Project already registers the folder, whose id it keeps.
pub fn connect_child(
    parent: &Path,
    folder: &str,
    fallback_name: &str,
    icon: &str,
    repo: Option<String>,
) -> Result<Connected, ProjectError> {
    let folder = normalize_space_folder(folder)
        .map_err(|_| ProjectError::InvalidFolder(folder.to_string()))?;
    let space_dir = parent.join(&folder);
    if !space_dir.is_dir() {
        return Err(ProjectError::PathNotAccessible(
            system_path::user_facing_path(&space_dir),
        ));
    }

    let parent_config = space_config::read(parent)?;
    if let Some(existing) = parent_config
        .spaces
        .iter()
        .flatten()
        .find(|entry| entry.path == folder)
    {
        let opened = open(
            &space_dir,
            fallback_name,
            icon,
            "",
            Storage::of_folder(&space_dir),
        )?;
        return Ok(Connected {
            id: existing.id.clone(),
            opened,
        });
    }

    let storage = if repo.is_some() {
        Storage::Own
    } else {
        Storage::of_folder(&space_dir)
    };
    let opened = open(&space_dir, fallback_name, icon, "", storage)?;
    let id = new_space_id();
    space_config::mutate(parent, |config| {
        config.spaces.get_or_insert_with(Vec::new).push(SpaceRef {
            id: id.clone(),
            path: folder,
            repo,
            extensions: Default::default(),
        });
        Ok::<_, SpaceConfigError>(())
    })?;
    Ok(Connected { id, opened })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scaffold_creates_stage_6_default_svode_files_and_readme() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let space_path = temp_dir.path();

        scaffold(space_path, "Stage 5", "", "", Storage::Own).expect("scaffold repository space");

        let svode_dir = space_path.join(".svode");
        assert!(svode_dir.join("config.json").is_file());
        assert!(svode_dir.join("local.json").is_file());
        assert!(space_path.join(README_FILE).is_file());
        assert!(!svode_dir.join("AGENTS.md").exists());
        assert!(!svode_dir.join("mcp.json").exists());
        assert!(!svode_dir.join("skills").exists());
        assert!(!svode_dir.join("agents").exists());
        let config = std::fs::read_to_string(svode_dir.join("config.json")).expect("config");
        assert!(config.contains("\"binaryRouting\""));
        assert!(config.contains("\"lfsThresholdBytes\": 10000000"));
    }

    #[test]
    fn inline_space_scaffold_does_not_persist_storage_override() {
        let temp = tempfile::tempdir().expect("temp dir");
        let space_path = temp.path().join("inline");

        scaffold(&space_path, "Inline", "", "", Storage::Inherited).expect("scaffold inline");

        let config =
            std::fs::read_to_string(space_path.join(".svode/config.json")).expect("config");
        assert!(!config.contains("\"assets\""));
        assert!(!config.contains("\"binaryRouting\""));
    }

    #[test]
    fn scaffold_preserves_existing_legacy_agent_artifacts() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let space_path = temp_dir.path();
        let svode_dir = space_path.join(".svode");
        std::fs::create_dir_all(svode_dir.join("skills")).expect("skills dir");
        std::fs::create_dir_all(svode_dir.join("agents")).expect("agents dir");
        std::fs::write(svode_dir.join("AGENTS.md"), "legacy instructions").expect("agents md");
        std::fs::write(svode_dir.join("mcp.json"), "{ \"legacy\": true }").expect("mcp json");

        scaffold(space_path, "Stage 5", "", "", Storage::Inherited).expect("scaffold space");

        assert_eq!(
            std::fs::read_to_string(svode_dir.join("AGENTS.md")).expect("read agents md"),
            "legacy instructions"
        );
        assert_eq!(
            std::fs::read_to_string(svode_dir.join("mcp.json")).expect("read mcp json"),
            "{ \"legacy\": true }"
        );
        assert!(svode_dir.join("skills").is_dir());
        assert!(svode_dir.join("agents").is_dir());
    }

    #[test]
    fn ensure_readme_is_idempotent_and_preserves_existing_content() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let space_path = temp_dir.path();
        let readme_path = space_path.join(README_FILE);
        std::fs::write(&readme_path, "user content").expect("readme");

        let created = ensure_readme(space_path, "Ignored").expect("ensure readme");

        assert!(!created);
        assert_eq!(
            std::fs::read_to_string(readme_path).expect("read readme"),
            "user content"
        );
    }

    #[test]
    fn ensure_readme_creates_frontmatter_document() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let space_path = temp_dir.path();

        let created = ensure_readme(space_path, "Project Home").expect("ensure readme");

        assert!(created);
        let raw =
            std::fs::read_to_string(space_path.join(README_FILE)).expect("read created readme");
        let (meta, body) = frontmatter::parse(&raw).expect("parse frontmatter");
        assert_eq!(meta.title, "Project Home");
        assert_eq!(body, "");
    }

    fn write_config(path: &Path, contents: &str) {
        std::fs::create_dir_all(path.join(".svode")).expect("svode dir");
        std::fs::write(path.join(".svode/config.json"), contents).expect("config");
    }

    fn read_config(path: &Path) -> String {
        std::fs::read_to_string(path.join(".svode/config.json")).expect("config")
    }

    fn raw_config(path: &Path) -> serde_json::Value {
        serde_json::from_str(&read_config(path)).expect("json")
    }

    fn root(project: &Path) {
        scaffold(project, "Root", "", "", Storage::Own).expect("root scaffold");
    }

    #[test]
    fn connecting_a_space_with_an_unreadable_config_keeps_the_file() {
        let conflict = "{\n<<<<<<< HEAD\n  \"name\": \"Ours\"\n=======\n  \"name\": \"Theirs\"\n>>>>>>> origin/main\n}\n";
        for registered in [true, false] {
            let project_dir = tempfile::tempdir().expect("project dir");
            let project = project_dir.path();
            root(project);
            let space = project.join("docs");
            std::fs::create_dir_all(space.join(".git")).expect("space git");
            write_config(&space, conflict);
            if registered {
                space_config::mutate(project, |config| {
                    config.spaces = Some(vec![SpaceRef {
                        id: "registered-id".into(),
                        path: "docs".into(),
                        repo: None,
                        extensions: Default::default(),
                    }]);
                    Ok::<_, SpaceConfigError>(())
                })
                .expect("register space");
            }

            let connected = connect_child(project, "docs", "Fallback", "", None).expect("connect");

            assert_eq!(
                connected.opened.config_unreadable,
                Some(Unreadable::Conflict)
            );
            assert_eq!(connected.opened.config.name, "docs");
            assert_eq!(read_config(&space), conflict);
            assert!(!space.join(README_FILE).exists());
            let listed = space_config::read(project)
                .expect("project config")
                .spaces
                .expect("spaces");
            assert_eq!(listed.len(), 1);
            assert_eq!(listed[0].id, connected.id);
            if registered {
                assert_eq!(connected.id, "registered-id");
            }
        }
    }

    #[test]
    fn connecting_scaffolds_the_storage_block_only_without_config() {
        let project_dir = tempfile::tempdir().expect("project dir");
        let project = project_dir.path();
        root(project);
        let project_assets = raw_config(project)["assets"].clone();
        assert!(project_assets.is_object());

        let fresh = project.join("fresh");
        std::fs::create_dir_all(fresh.join(".git")).expect("fresh git");
        connect_child(project, "fresh", "Fresh", "", None).expect("connect fresh");
        assert_eq!(raw_config(&fresh)["assets"], project_assets);

        let existing = project.join("existing");
        std::fs::create_dir_all(existing.join(".git")).expect("existing git");
        let config = r#"{"name":"Existing","icon":"x","description":""}"#;
        write_config(&existing, config);
        connect_child(
            project,
            "existing",
            "Fallback",
            "",
            Some("https://example.com/existing.git".to_string()),
        )
        .expect("connect existing");
        assert_eq!(read_config(&existing), config);
        let spaces = space_config::read(project).unwrap().spaces.unwrap();
        assert_eq!(
            spaces[1].repo.as_deref(),
            Some("https://example.com/existing.git")
        );

        let inline = project.join("inline");
        std::fs::create_dir_all(&inline).expect("inline dir");
        connect_child(project, "inline", "Inline", "", None).expect("connect inline");
        assert!(raw_config(&inline).get("assets").is_none());
    }

    #[test]
    fn connecting_refuses_a_folder_that_is_not_one_segment_or_not_there() {
        let project_dir = tempfile::tempdir().expect("project dir");
        let project = project_dir.path();
        root(project);
        for folder in ["a/b", "../x", "поддержка"] {
            assert!(matches!(
                connect_child(project, folder, "X", "", None),
                Err(ProjectError::InvalidFolder(_))
            ));
        }
        assert!(matches!(
            connect_child(project, "absent", "X", "", None),
            Err(ProjectError::PathNotAccessible(_))
        ));
    }

    #[test]
    fn opening_an_existing_scope_keeps_its_readme() {
        let project_dir = tempfile::tempdir().expect("project dir");
        let project = project_dir.path();
        root(project);
        std::fs::write(project.join(README_FILE), "custom home").expect("readme");

        open(project, "Ignored", "", "", Storage::Own).expect("open");

        assert_eq!(
            std::fs::read_to_string(project.join(README_FILE)).expect("readme"),
            "custom home"
        );
    }

    #[test]
    fn scope_readme_takes_the_config_name_or_the_fallback() {
        let project_dir = tempfile::tempdir().expect("project dir");
        let project = project_dir.path();
        root(project);
        std::fs::remove_file(project.join(README_FILE)).unwrap();
        assert!(ensure_scope_readme(project, "Fallback").unwrap());
        let (meta, _) =
            frontmatter::parse(&std::fs::read_to_string(project.join(README_FILE)).unwrap())
                .unwrap();
        assert_eq!(meta.title, "Root");

        let bare = project.join("bare");
        std::fs::create_dir_all(&bare).unwrap();
        assert!(ensure_scope_readme(&bare, "Fallback").unwrap());
        let (meta, _) =
            frontmatter::parse(&std::fs::read_to_string(bare.join(README_FILE)).unwrap()).unwrap();
        assert_eq!(meta.title, "Fallback");
        assert!(!ensure_scope_readme(&bare, "Again").unwrap());
    }
}

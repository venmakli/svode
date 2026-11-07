//! Creation and opening of a Project, the root space of its folder (Stage 11
//! 05 «Операции»): one operation for every host. Creating takes a new folder
//! or an existing one without `.svode/config.json`, Git repositories
//! included; it checks the request and an existing repository before the
//! first write, scaffolds the Project with its own storage policy, gives a
//! folder without Git a repository when Git is found and registers the
//! Project in the list of the device. A failure after the first write
//! removes only what the operation created. It never commits: a new Project
//! has the default, manual flags.

use std::path::{Path, PathBuf};

use super::ProjectError;
use super::registry;
use super::scaffold::{self, Storage, folder_name};
use super::space::{AppliedStorage, CreationCommit, RepositoryOutcome, current_branch};
use crate::git::host::GitHost;
use crate::git::state::GitRuntime;
use crate::git::{local_repair, ops, upstream};
use crate::space_config::{SpaceConfig, SpaceConfigError, Unreadable};
use crate::system_path;

const CONFIG_FILE: &str = ".svode/config.json";
const LOCAL_FILE: &str = ".svode/local.json";

/// A request to create a Project in `path`.
#[derive(Debug, Clone)]
pub struct ProjectCreate {
    /// The folder of the Project, absolute; created when missing.
    pub path: PathBuf,
    /// The name of the Project, also the title of its README; the name of
    /// its folder when absent or blank.
    pub name: Option<String>,
    pub icon: Option<String>,
    pub description: Option<String>,
}

/// The settings a created Project received (05 «Ответ с применёнными
/// настройками»); each host projects them in its own vocabulary.
#[derive(Debug, Clone)]
pub struct ProjectCreated {
    pub registration: Registration,
    pub name: String,
    pub icon: String,
    pub description: String,
    /// The folder of the Project.
    pub path: PathBuf,
    pub repository: ProjectRepository,
    /// A Project owns its storage policy.
    pub storage: AppliedStorage,
    /// The files the creation wrote, absolute.
    pub changed_paths: Vec<PathBuf>,
}

/// Whether the Project is in the list of Projects of the device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Registration {
    Registered {
        id: String,
    },
    /// The OS gives the user no config directory, so the device has no list
    /// to register in; opening the folder in Svode Desktop registers it.
    NoDeviceDirectory,
}

/// The Git repository of a created Project.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectRepository {
    /// The folder of the Project is a repository: created now (`created`)
    /// or existing. The creation is committed manually: a new Project has
    /// the default, manual flags.
    Repository(RepositoryOutcome),
    /// No Git was found, so the Project has no repository.
    GitNotFound,
}

/// Create the Project `request` describes and register it in the list in
/// `registry_dir`, when there is one.
pub async fn create(
    runtime: &GitRuntime,
    host: &dyn GitHost,
    registry_dir: Option<&Path>,
    request: ProjectCreate,
) -> Result<ProjectCreated, ProjectError> {
    let path = request.path.clone();
    let shown = system_path::user_facing_path(&path);
    let exists = match path.symlink_metadata() {
        Ok(_) if path.is_dir() => true,
        Ok(_) => return Err(ProjectError::PathNotAccessible(shown)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => return Err(ProjectError::PathNotAccessible(shown)),
    };
    if path.join(CONFIG_FILE).symlink_metadata().is_ok() {
        return Err(ProjectError::ProjectAlreadyExists(shown));
    }
    if let Some(project) = enclosing_project(&path) {
        return Err(ProjectError::ProjectNested {
            path: shown,
            project: system_path::user_facing_path(&project),
        });
    }
    if exists && tempfile::tempfile_in(&path).is_err() {
        return Err(ProjectError::PathNotAccessible(shown));
    }
    let name = request
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| folder_name(&path));

    let existing_repository = exists && path.join(".git").symlink_metadata().is_ok();
    if existing_repository {
        host.authorize_repository(&path).await?;
        // Preparing the repository (local repair) is not part of the
        // creation and is not rolled back.
        local_repair::require_scope_repair(runtime, host, &path, &path).await?;
    }

    let mut journal = Journal::new(&path, exists);
    match write(
        &mut journal,
        runtime,
        registry_dir,
        &request,
        &name,
        existing_repository,
    )
    .await
    {
        Ok(created) => Ok(created),
        // Another creator scaffolded the folder first; it owns everything
        // there.
        Err(ProjectError::Config(SpaceConfigError::Exists)) => {
            Err(ProjectError::ProjectAlreadyExists(shown))
        }
        Err(error) => Err(journal.rollback(error)),
    }
}

async fn write(
    journal: &mut Journal,
    runtime: &GitRuntime,
    registry_dir: Option<&Path>,
    request: &ProjectCreate,
    name: &str,
    existing_repository: bool,
) -> Result<ProjectCreated, ProjectError> {
    let path = &request.path;
    if !journal.existed {
        journal.created_root = first_missing(path);
        std::fs::create_dir_all(path)
            .map_err(|_| ProjectError::PathNotAccessible(system_path::user_facing_path(path)))?;
    }
    journal.note_existing();

    let scaffolded = scaffold::scaffold(
        path,
        name,
        request.icon.as_deref().unwrap_or(""),
        request.description.as_deref().unwrap_or(""),
        Storage::Own,
    );
    journal.config = path.join(CONFIG_FILE).is_file();
    let config = match scaffolded {
        Ok(config) => config,
        Err(ProjectError::Config(SpaceConfigError::Exists)) => {
            journal.config = false;
            return Err(ProjectError::Config(SpaceConfigError::Exists));
        }
        Err(error) => return Err(error),
    };
    let mut changed = vec![path.join(CONFIG_FILE)];
    if journal.local.is_none() {
        changed.push(path.join(LOCAL_FILE));
    }
    if !journal.readme {
        changed.push(path.join(scaffold::README_FILE));
    }

    let repository = if existing_repository {
        let upstream = match runtime.detected() {
            Some(cli) => matches!(upstream::of_current_branch(cli, path).await, Ok(Some(_))),
            None => false,
        };
        ProjectRepository::Repository(RepositoryOutcome {
            path: ".".to_string(),
            created: false,
            initial_branch: None,
            upstream,
            commit: CreationCommit::Manual,
        })
    } else if let Some(cli) = runtime.detected() {
        journal.keep_gitignore()?;
        journal.git = true;
        ops::init_with_optional_scaffold_commit(cli, path, false).await?;
        if journal.gitignore_changed() {
            changed.push(path.join(".gitignore"));
        }
        ProjectRepository::Repository(RepositoryOutcome {
            path: ".".to_string(),
            created: true,
            initial_branch: current_branch(cli, path).await,
            upstream: false,
            commit: CreationCommit::Manual,
        })
    } else {
        ProjectRepository::GitNotFound
    };

    let registration = match registry_dir {
        Some(dir) => Registration::Registered {
            id: registry::register(dir, path)?,
        },
        None => Registration::NoDeviceDirectory,
    };
    Ok(ProjectCreated {
        registration,
        name: config.name,
        icon: config.icon,
        description: config.description,
        path: path.clone(),
        repository,
        storage: AppliedStorage {
            inherited: false,
            assets: config.assets,
        },
        changed_paths: changed,
    })
}

/// The outermost Svode Project whose folder holds `path`, `path` itself
/// excluded.
fn enclosing_project(path: &Path) -> Option<PathBuf> {
    let resolved = resolve(path);
    resolved
        .ancestors()
        .skip(1)
        .filter(|ancestor| ancestor.join(CONFIG_FILE).symlink_metadata().is_ok())
        .last()
        .map(Path::to_path_buf)
}

/// `path` with its nearest existing ancestor resolved, so a symbolic link
/// into a Project is seen as the Project.
fn resolve(path: &Path) -> PathBuf {
    let mut missing = Vec::new();
    let mut existing = path;
    loop {
        if let Ok(canonical) = existing.canonicalize() {
            return missing
                .iter()
                .rev()
                .fold(canonical, |path: PathBuf, part| path.join(part));
        }
        match (existing.file_name(), existing.parent()) {
            (Some(name), Some(parent)) => {
                missing.push(name.to_os_string());
                existing = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
}

/// The outermost missing folder `create_dir_all(path)` creates.
fn first_missing(path: &Path) -> Option<PathBuf> {
    path.ancestors()
        .take_while(|ancestor| ancestor.symlink_metadata().is_err())
        .last()
        .map(Path::to_path_buf)
}

/// What a creation wrote, so that a failure removes exactly that.
struct Journal {
    path: PathBuf,
    /// The folder was there before the creation.
    existed: bool,
    /// The outermost folder the creation made.
    created_root: Option<PathBuf>,
    svode_dir: bool,
    /// The contents of `.svode/local.json` before the creation.
    local: Option<Vec<u8>>,
    readme: bool,
    /// The creation wrote `.svode/config.json`.
    config: bool,
    /// The creation initialized the repository.
    git: bool,
    gitignore: Option<Option<Vec<u8>>>,
}

impl Journal {
    fn new(path: &Path, existed: bool) -> Self {
        Self {
            path: path.to_path_buf(),
            existed,
            created_root: None,
            svode_dir: false,
            local: None,
            readme: false,
            config: false,
            git: false,
            gitignore: None,
        }
    }

    /// Remember which scaffold files were there before.
    fn note_existing(&mut self) {
        self.svode_dir = self.path.join(".svode").symlink_metadata().is_ok();
        self.local = std::fs::read(self.path.join(LOCAL_FILE)).ok();
        self.readme = self
            .path
            .join(scaffold::README_FILE)
            .symlink_metadata()
            .is_ok();
    }

    fn keep_gitignore(&mut self) -> Result<(), std::io::Error> {
        self.gitignore = Some(match std::fs::read(self.path.join(".gitignore")) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        });
        Ok(())
    }

    fn gitignore_changed(&self) -> bool {
        self.gitignore
            .as_ref()
            .is_some_and(|before| std::fs::read(self.path.join(".gitignore")).ok() != *before)
    }

    /// Remove what the creation wrote and return `cause`, or the paths that
    /// stayed when something could not be removed.
    fn rollback(self, cause: ProjectError) -> ProjectError {
        let mut remaining = Vec::new();
        if let Some(root) = &self.created_root {
            remove(root, true, &mut remaining);
        } else {
            if self.git {
                remove(&self.path.join(".git"), true, &mut remaining);
            }
            if let Some(before) = &self.gitignore {
                let path = self.path.join(".gitignore");
                let restored = match before {
                    Some(bytes) => std::fs::write(&path, bytes),
                    None => match std::fs::remove_file(&path) {
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                        other => other,
                    },
                };
                if restored.is_err() {
                    remaining.push(system_path::user_facing_path(&path));
                }
            }
            if self.config {
                if !self.readme {
                    remove(
                        &self.path.join(scaffold::README_FILE),
                        false,
                        &mut remaining,
                    );
                }
                if self.svode_dir {
                    let local = self.path.join(LOCAL_FILE);
                    match &self.local {
                        Some(bytes) => {
                            if std::fs::write(&local, bytes).is_err() {
                                remaining.push(system_path::user_facing_path(&local));
                            }
                        }
                        None => remove(&local, false, &mut remaining),
                    }
                    remove(&self.path.join(CONFIG_FILE), false, &mut remaining);
                } else {
                    remove(&self.path.join(".svode"), true, &mut remaining);
                }
            } else if !self.svode_dir {
                // Only an empty `.svode` the scaffold made before it failed.
                let _ = std::fs::remove_dir(self.path.join(".svode"));
            }
        }
        if remaining.is_empty() {
            cause
        } else {
            ProjectError::RollbackIncomplete {
                cause: Box::new(cause),
                remaining,
            }
        }
    }
}

/// Remove a path the creation wrote; one that stays joins `remaining`.
fn remove(path: &Path, dir: bool, remaining: &mut Vec<String>) {
    let removed = if dir {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    if let Err(error) = removed
        && error.kind() != std::io::ErrorKind::NotFound
    {
        remaining.push(system_path::user_facing_path(path));
    }
}

/// A Project folder opened in Svode and registered in the list of the
/// device.
#[derive(Debug, Clone)]
pub struct OpenedProject {
    pub id: String,
    pub config: SpaceConfig,
    /// Why its existing config cannot be read; `config` then holds only the
    /// name of its folder.
    pub config_unreadable: Option<Unreadable>,
}

/// Open an existing folder as a Project: scaffold it when it has no config,
/// give it a home README, and register it in the list in `registry_dir`
/// unless the list has it, whose id it keeps.
pub fn open_folder(registry_dir: &Path, path: &Path) -> Result<OpenedProject, ProjectError> {
    if !path.is_dir() {
        return Err(ProjectError::PathNotAccessible(
            system_path::user_facing_path(path),
        ));
    }
    let opened = scaffold::open(path, &folder_name(path), "", "", Storage::Own)?;
    let id = registry::register(registry_dir, path)?;
    Ok(OpenedProject {
        id,
        config: opened.config,
        config_unreadable: opened.config_unreadable,
    })
}

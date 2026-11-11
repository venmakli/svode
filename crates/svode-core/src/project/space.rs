//! Creation of a child Space of a Project (Stage 11 05 «Операции»): one
//! operation for every host. It checks the request and every repository it
//! touches before the first write, then, holding the write guard of the
//! Project repository and of the new repository from the first write to the
//! last, creates the folder, its scaffold by the requested Git type, the Git
//! effects of the type and finally the `SpaceRef`. A failure after the first
//! write removes only what the operation created. It never commits: the
//! creation commit belongs to Desktop ([`crate::git::space_creation`]).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use super::ProjectError;
use super::scaffold::{self, Storage};
use crate::git::cli::GitCli;
use crate::git::host::GitHost;
use crate::git::path::normalize_space_folder;
use crate::git::space_creation::creation_message;
use crate::git::state::GitRuntime;
use crate::git::{GitError, access, local_repair, ops, policy, upstream, write_guard};
use crate::space_config::{self, SpaceConfig, SpaceConfigError, SpaceRef};
use crate::storage::config::{AssetsSpaceConfig, SpaceGitType};
use crate::system_path;

/// A request to create a child Space of `project`.
#[derive(Debug, Clone)]
pub struct SpaceCreate {
    pub project: PathBuf,
    /// The name of the Space, also the title of its README.
    pub name: String,
    /// One ASCII segment in the Project root.
    pub folder: String,
    pub git_type: SpaceGitType,
    pub icon: Option<String>,
    pub description: Option<String>,
}

/// The settings a created Space received (05 «Ответ с применёнными
/// настройками»); each host projects them in its own vocabulary.
#[derive(Debug, Clone)]
pub struct SpaceCreated {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub description: String,
    /// The folder, relative to the Project.
    pub folder: String,
    pub git_type: SpaceGitType,
    /// The absolute folder of the Space.
    pub path: PathBuf,
    /// Every repository the creation touched: the Project repository and
    /// the new one of an Independent or Submodule Space.
    pub repositories: Vec<RepositoryOutcome>,
    pub storage: AppliedStorage,
    /// The files the creation wrote, absolute.
    pub changed_paths: Vec<PathBuf>,
}

/// One repository a creation touched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepositoryOutcome {
    /// Relative to the Project; `.` is the Project repository.
    pub path: String,
    /// The creation initialized this repository.
    pub created: bool,
    /// The initial branch of a new repository.
    pub initial_branch: Option<String>,
    /// The branch of the repository has an upstream.
    pub upstream: bool,
    pub commit: CreationCommit,
}

/// Who commits the creation in a repository. The operation itself never
/// commits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CreationCommit {
    /// Desktop makes the creation commit: structural commits are on.
    Desktop { message: String },
    /// The changes wait for a manual commit: structural commits are off, as
    /// in every new repository.
    Manual,
}

/// The storage policy the Space follows.
#[derive(Debug, Clone)]
pub struct AppliedStorage {
    /// An Inline Space inherits the policy of the Project.
    pub inherited: bool,
    /// The policy in effect: the own block of a repository Space, the
    /// Project block of an Inline Space.
    pub assets: Option<AssetsSpaceConfig>,
}

/// Create the child Space `request` describes.
pub async fn create(
    runtime: &GitRuntime,
    host: &dyn GitHost,
    request: SpaceCreate,
) -> Result<SpaceCreated, ProjectError> {
    let name = request.name.trim().to_string();
    if name.is_empty() {
        return Err(ProjectError::NameRequired);
    }
    let folder = normalize_space_folder(&request.folder)
        .map_err(|_| ProjectError::InvalidFolder(request.folder.clone()))?;
    let project = request.project.clone();
    if !project.is_dir() {
        return Err(ProjectError::PathNotAccessible(
            system_path::user_facing_path(&project),
        ));
    }
    let space_dir = project.join(&folder);
    ensure_free(&space_config::read(&project)?, &space_dir, &folder)?;

    let project_repository = project.join(".git").symlink_metadata().is_ok();
    let own_repository = request.git_type != SpaceGitType::Inline;
    if request.git_type == SpaceGitType::Submodule && !project_repository {
        return Err(ProjectError::NoProjectRepository);
    }
    let cli = if own_repository {
        Some(runtime.require_cli()?)
    } else {
        None
    };
    if project_repository {
        host.authorize_repository(&project).await?;
    }

    let guarded = if project_repository {
        access::local_repository_root(&project)?
    } else {
        project.canonicalize()?
    };
    let targets = [space_dir.clone()];
    write_guard::scope(
        BTreeSet::from([guarded]),
        &targets,
        async {
            // Preparing the Project repository (local repair) is not part of
            // the creation and is not rolled back, but its changes are
            // reported.
            let prepared = project_repository
                && local_repair::require_scope_repair(runtime, host, &project, &project).await?
                    == local_repair::RepairOutcome::Changed;
            // Another writer may have taken the folder meanwhile.
            ensure_free(&space_config::read(&project)?, &space_dir, &folder)?;
            let mut journal = Journal::new(&project, &space_dir);
            let written = write(
                &mut journal,
                runtime,
                cli.as_ref(),
                &request,
                &name,
                &folder,
                project_repository,
            )
            .await;
            match written {
                Ok(mut created) => {
                    let gitignore = project.join(".gitignore");
                    if prepared && !created.changed_paths.contains(&gitignore) {
                        created.changed_paths.push(gitignore);
                    }
                    Ok(created)
                }
                Err(error) => Err(journal.rollback(cli.as_ref(), error).await),
            }
        },
        ProjectError::from,
    )
    .await
}

/// The folder is free: nothing is at its path and the Project registers no
/// Space there.
fn ensure_free(project: &SpaceConfig, space_dir: &Path, folder: &str) -> Result<(), ProjectError> {
    if space_dir.symlink_metadata().is_ok()
        || project
            .spaces
            .iter()
            .flatten()
            .any(|entry| entry.path == folder)
    {
        return Err(ProjectError::FileAlreadyExists(
            system_path::user_facing_path(space_dir),
        ));
    }
    Ok(())
}

async fn write(
    journal: &mut Journal,
    runtime: &GitRuntime,
    cli: Option<&GitCli>,
    request: &SpaceCreate,
    name: &str,
    folder: &str,
    project_repository: bool,
) -> Result<SpaceCreated, ProjectError> {
    let project = &request.project;
    let space_dir = project.join(folder);
    match std::fs::create_dir(&space_dir) {
        Ok(()) => journal.folder = true,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(ProjectError::FileAlreadyExists(
                system_path::user_facing_path(&space_dir),
            ));
        }
        Err(error) => return Err(error.into()),
    }
    // The new repository is guarded as well, from its first file on.
    let _space_guard = match cli {
        Some(_) => {
            Some(write_guard::acquire(&BTreeSet::from([space_dir.canonicalize()?]), &[]).await?)
        }
        None => None,
    };

    let config = scaffold::scaffold(
        &space_dir,
        name,
        request.icon.as_deref().unwrap_or(""),
        request.description.as_deref().unwrap_or(""),
        Storage::of(request.git_type),
    )?;
    let mut changed = vec![
        space_dir.join(".svode/config.json"),
        space_dir.join(".svode/local.json"),
        space_dir.join(scaffold::README_FILE),
    ];

    let mut initial_branch = None;
    if let Some(cli) = cli {
        ops::init_with_optional_scaffold_commit(cli, &space_dir, false).await?;
        crate::storage::local_rules::repair_local_rules(cli, &space_dir).await?;
        changed.push(space_dir.join(".gitignore"));
        initial_branch = current_branch(cli, &space_dir).await;
        if project_repository
            && let Err(error) = ops::copy_local_identity(cli, project, &space_dir).await
        {
            tracing::warn!(
                kind = error.kind(),
                "local identity of the project not copied to the new space"
            );
        }
    }

    if project_repository {
        match request.git_type {
            SpaceGitType::Inline => {
                journal.keep(".gitignore")?;
                ops::ensure_inline_gitignore(project)?;
            }
            SpaceGitType::Independent => {
                journal.keep(".gitignore")?;
                ops::add_independent_gitignore(project, folder)?;
            }
            SpaceGitType::Submodule => {
                let cli = cli.ok_or(GitError::GitNotFound)?;
                journal.keep(".gitmodules")?;
                journal.submodule = submodule_section_absent(cli, project, folder).await?;
                journal.folder_name = folder.to_string();
                ops::register_local_submodule_metadata(cli, project, folder).await?;
            }
        }
        changed.extend(journal.changed_kept_files());
    }

    let id = scaffold::new_space_id();
    space_config::mutate(project, |config| {
        config.spaces.get_or_insert_with(Vec::new).push(SpaceRef {
            id: id.clone(),
            path: folder.to_string(),
            repo: None,
            extensions: Default::default(),
        });
        Ok::<_, SpaceConfigError>(())
    })?;
    journal.space_ref = Some(id.clone());
    changed.push(project.join(".svode/config.json"));

    let mut repositories = Vec::new();
    if project_repository {
        repositories.push(project_outcome(runtime, project, request.git_type, folder).await);
    }
    if cli.is_some() {
        repositories.push(RepositoryOutcome {
            path: folder.to_string(),
            created: true,
            initial_branch,
            upstream: false,
            commit: CreationCommit::Manual,
        });
    }
    let storage = match request.git_type {
        SpaceGitType::Inline => AppliedStorage {
            inherited: true,
            assets: space_config::read(project)
                .ok()
                .and_then(|config| config.assets),
        },
        SpaceGitType::Independent | SpaceGitType::Submodule => AppliedStorage {
            inherited: false,
            assets: config.assets.clone(),
        },
    };
    Ok(SpaceCreated {
        id,
        name: config.name,
        icon: config.icon,
        description: config.description,
        folder: folder.to_string(),
        git_type: request.git_type,
        path: space_dir,
        repositories,
        storage,
        changed_paths: changed,
    })
}

/// Who commits the creation in the Project repository, and its upstream.
async fn project_outcome(
    runtime: &GitRuntime,
    project: &Path,
    git_type: SpaceGitType,
    folder: &str,
) -> RepositoryOutcome {
    let upstream = match runtime.detected() {
        Some(cli) => matches!(upstream::of_current_branch(cli, project).await, Ok(Some(_))),
        None => false,
    };
    RepositoryOutcome {
        path: ".".to_string(),
        created: false,
        initial_branch: None,
        upstream,
        commit: if policy::effective_user_policy(project).auto_commit_structural {
            CreationCommit::Desktop {
                message: creation_message(git_type, folder),
            }
        } else {
            CreationCommit::Manual
        },
    }
}

pub(super) async fn current_branch(cli: &GitCli, repo: &Path) -> Option<String> {
    let out = cli
        .exec(repo, &["symbolic-ref", "--short", "HEAD"])
        .await
        .ok()?;
    let branch = out.stdout.trim();
    (out.exit_code == 0 && !branch.is_empty()).then(|| branch.to_string())
}

/// The Project repository config has no section of this submodule yet, so a
/// rollback may remove the one the creation writes.
async fn submodule_section_absent(
    cli: &GitCli,
    project: &Path,
    folder: &str,
) -> Result<bool, GitError> {
    let out = cli
        .exec(
            project,
            &[
                "config",
                "--local",
                "--get-regexp",
                &format!("^submodule\\.{}\\.", regex::escape(folder)),
            ],
        )
        .await?;
    Ok(out.exit_code != 0)
}

/// What a creation wrote, so that a failure removes exactly that.
struct Journal {
    project: PathBuf,
    space_dir: PathBuf,
    folder: bool,
    /// Project files the creation changed, with their contents before.
    kept: Vec<(&'static str, Option<Vec<u8>>)>,
    submodule: bool,
    folder_name: String,
    space_ref: Option<String>,
}

impl Journal {
    fn new(project: &Path, space_dir: &Path) -> Self {
        Self {
            project: project.to_path_buf(),
            space_dir: space_dir.to_path_buf(),
            folder: false,
            kept: Vec::new(),
            submodule: false,
            folder_name: String::new(),
            space_ref: None,
        }
    }

    /// Remember the contents of a Project file before the creation changes it.
    fn keep(&mut self, file: &'static str) -> Result<(), std::io::Error> {
        let before = match std::fs::read(self.project.join(file)) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        };
        self.kept.push((file, before));
        Ok(())
    }

    /// The kept Project files the creation actually changed.
    fn changed_kept_files(&self) -> Vec<PathBuf> {
        self.kept
            .iter()
            .filter(|(file, before)| std::fs::read(self.project.join(file)).ok() != *before)
            .map(|(file, _)| self.project.join(file))
            .collect()
    }

    /// Remove what the creation wrote, newest first, and return `cause`, or
    /// the paths that stayed when something could not be removed.
    async fn rollback(self, cli: Option<&GitCli>, cause: ProjectError) -> ProjectError {
        let mut remaining = Vec::new();
        if let Some(id) = &self.space_ref {
            let removed = space_config::mutate(&self.project, |config| {
                if let Some(spaces) = config.spaces.as_mut() {
                    spaces.retain(|entry| &entry.id != id);
                }
                Ok::<_, SpaceConfigError>(())
            });
            if removed.is_err() {
                remaining.push(system_path::user_facing_path(
                    &self.project.join(".svode/config.json"),
                ));
            }
        }
        if self.submodule
            && let Some(cli) = cli
        {
            let section = format!("submodule.{}", self.folder_name);
            let removed = cli
                .exec(
                    &self.project,
                    &["config", "--local", "--remove-section", &section],
                )
                .await;
            if !matches!(removed, Ok(out) if out.exit_code == 0) {
                remaining.push(system_path::user_facing_path(
                    &self.project.join(".git/config"),
                ));
            }
        }
        for (file, before) in self.kept.iter().rev() {
            let path = self.project.join(file);
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
        if self.folder && std::fs::remove_dir_all(&self.space_dir).is_err() {
            remaining.push(system_path::user_facing_path(&self.space_dir));
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

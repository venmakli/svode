//! Desktop host adapter for the shared Routine definition owner: Git target
//! selection and repository authorization of the current runtime.

use std::path::{Path, PathBuf};

use svode_core::routines::model::ResolvedRoutineOwner;
use svode_core::routines::service::{RoutineMutationHost, RoutineRepositoryTarget};

use crate::AppError;
use crate::git::access::{RepositoryAccessState, ensure_mutation_paths_were_authorized};
use crate::git::{GitState, require_cli};

/// Git target selection of a Routine owner.
pub(crate) struct RoutineGitTarget<'a> {
    git_state: &'a GitState,
}

impl<'a> RoutineGitTarget<'a> {
    pub(crate) fn new(git_state: &'a GitState) -> Self {
        Self { git_state }
    }
}

impl RoutineRepositoryTarget for RoutineGitTarget<'_> {
    type Error = AppError;

    async fn mutation_repository(&self, owner: &ResolvedRoutineOwner) -> Result<PathBuf, AppError> {
        mutation_repository(self.git_state, owner).await
    }
}

/// The host capabilities of one managed Routine mutation.
pub(crate) struct RoutineMutationRuntime<'a> {
    git_state: &'a GitState,
    access_state: &'a RepositoryAccessState,
    access_store_path: &'a Path,
}

impl<'a> RoutineMutationRuntime<'a> {
    pub(crate) fn new(
        git_state: &'a GitState,
        access_state: &'a RepositoryAccessState,
        access_store_path: &'a Path,
    ) -> Self {
        Self {
            git_state,
            access_state,
            access_store_path,
        }
    }
}

impl RoutineRepositoryTarget for RoutineMutationRuntime<'_> {
    type Error = AppError;

    async fn mutation_repository(&self, owner: &ResolvedRoutineOwner) -> Result<PathBuf, AppError> {
        mutation_repository(self.git_state, owner).await
    }
}

impl RoutineMutationHost for RoutineMutationRuntime<'_> {
    async fn authorize_mutation(&self, repository: &Path) -> Result<(), AppError> {
        authorize_mutation(
            self.git_state,
            self.access_state,
            self.access_store_path,
            repository,
        )
        .await
    }
}

/// The Git repository a Routine owner commits into.
pub(crate) async fn mutation_repository(
    git_state: &GitState,
    owner: &ResolvedRoutineOwner,
) -> Result<PathBuf, AppError> {
    let cli = require_cli(git_state)?;
    let (_, repository) =
        crate::git::ops::resolve_target_repo(&cli, &owner.project_path, &owner.space_path).await?;
    Ok(repository)
}

pub(crate) async fn authorize_mutation(
    git_state: &GitState,
    access_state: &RepositoryAccessState,
    access_store_path: &Path,
    repository: &Path,
) -> Result<(), AppError> {
    ensure_mutation_paths_were_authorized(&[repository.to_path_buf()])?;
    let cli = require_cli(git_state)?;
    access_state
        .require_mutation(&cli, repository, access_store_path)
        .await?;
    Ok(())
}

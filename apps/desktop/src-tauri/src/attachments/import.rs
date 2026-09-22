//! Desktop host adapter for the core managed import: supplies the shared
//! runtime handles, the live Git LFS readiness evidence and the autocommit
//! sink, and maps the result to the Desktop error type.

use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;

use svode_core::attachments::import::{ImportRuntime, LfsReadiness};
use svode_core::storage::config::AssetsSpaceConfig;

use crate::error::AppError;
use crate::git::GitState;
use crate::index::{IndexState, update::IndexUpdateState};
use crate::storage::lfs::{LfsState, probe_lfs_config_with_git};
use svode_core::git::autocommit::AutocommitService;

pub(crate) use svode_core::attachments::import::{
    ManagedImportDelivery, ManagedImportPlan, ManagedImportResult, ManagedImportSourceInfo,
    MutationOrigin,
};

/// Answers the import with the current readiness of the configured Git LFS
/// backend. Credentials and the installed transfer agent stay behind the
/// existing Desktop storage boundary.
struct GitLfsReadiness<'a>(&'a GitState);

impl LfsReadiness for GitLfsReadiness<'_> {
    fn lfs_ready<'a>(
        &'a self,
        repo_dir: &'a Path,
        config: &'a AssetsSpaceConfig,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
        Box::pin(lfs_ready(self.0, repo_dir, config))
    }
}

/// Whether the configured Git LFS backend of `repo_dir` is ready for a
/// managed import.
pub(crate) async fn lfs_ready(
    git_state: &GitState,
    repo_dir: &Path,
    config: &AssetsSpaceConfig,
) -> bool {
    probe_lfs_config_with_git(git_state, repo_dir, config).await == LfsState::Ready
}

pub(crate) fn inspect_import_source(
    source_path: &str,
) -> Result<ManagedImportSourceInfo, AppError> {
    Ok(svode_core::attachments::import::inspect_import_source(
        source_path,
    )?)
}

pub(crate) async fn plan_managed_import(
    index_state: &IndexState,
    project_path: &Path,
    space_id: Option<&str>,
    content_path: &str,
    source_path: &Path,
    file_name: Option<&str>,
) -> Result<ManagedImportPlan, AppError> {
    Ok(svode_core::attachments::import::plan_managed_import(
        &index_state.core,
        project_path,
        space_id,
        content_path,
        source_path,
        file_name,
    )
    .await?)
}

pub(crate) async fn execute_managed_import(
    git_state: &GitState,
    index_state: &IndexState,
    index_updates: &IndexUpdateState,
    autocommit: Option<&Arc<AutocommitService>>,
    origin: MutationOrigin,
    plan: ManagedImportPlan,
) -> Result<ManagedImportResult, AppError> {
    let cli = git_state.detected().cloned();
    let sink = crate::structure::sink(autocommit.map(AsRef::as_ref));
    let readiness = GitLfsReadiness(git_state);
    let runtime = ImportRuntime {
        index: &index_state.core,
        updates: index_updates.core(),
        repository: git_state.repository(),
        cli: cli.as_ref(),
        commits: sink
            .as_ref()
            .map(|sink| sink as &dyn svode_core::structure::StructuralCommitSink),
        lfs: Some(&readiness),
    };
    Ok(svode_core::attachments::import::execute_managed_import(runtime, origin, plan).await?)
}

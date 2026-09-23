//! Desktop host adapter for the core managed import: supplies the shared
//! runtime handles, the core Git LFS readiness probe of the Git runtime and
//! the autocommit sink, and maps the result to the Desktop error type.

use std::path::Path;
use std::sync::Arc;

use svode_core::attachments::import::ImportRuntime;

use crate::error::AppError;
use crate::git::GitState;
use crate::index::{IndexState, update::IndexUpdateState};
use svode_core::git::autocommit::AutocommitService;

pub(crate) use svode_core::attachments::import::{
    ManagedImportDelivery, ManagedImportPlan, ManagedImportResult, ManagedImportSourceInfo,
    MutationOrigin,
};

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
    let runtime = ImportRuntime {
        index: &index_state.core,
        updates: index_updates.core(),
        repository: git_state.repository(),
        cli: cli.as_ref(),
        commits: sink
            .as_ref()
            .map(|sink| sink as &dyn svode_core::structure::StructuralCommitSink),
        lfs: Some(git_state.runtime().as_ref()),
    };
    Ok(svode_core::attachments::import::execute_managed_import(runtime, origin, plan).await?)
}

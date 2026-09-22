//! Desktop host adapter for core structural operations: supplies the shared
//! runtime handles and Git date provider, and delivers the resulting history to
//! the autocommit service.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;

use svode_core::git::pending::StructuralOp;
use svode_core::page::entry::Entry;
use svode_core::structure::{StructuralCommitSink, StructureRuntime};

use crate::error::AppError;
use crate::index::{IndexState, update::IndexUpdateState};
use svode_core::git::autocommit::AutocommitService;
use svode_core::git::cli::GitCli;

pub use svode_core::structure::delete_mutation_paths;
pub use svode_core::structure::{
    CollectionCreate, CollectionCreateOutcome, ConvertToCollectionOutcome, DeleteOutcome,
    abs_entry_path, basename, entry_commit_name, entry_history_name, entry_in_sensitive_collection,
    entry_paths_with_order, entry_rename_op, grouped_abs_paths_by_space, order_path,
    root_path_for_head,
};
use svode_core::structure::{
    backlink_mutation_paths as core_backlink_mutation_paths,
    move_mutation_paths as core_move_mutation_paths,
};

/// Queue a structural change for the pending batch of `space_path`. A Space
/// outside an open Project records no history.
pub(crate) fn maybe_autocommit_structural_paths(
    autocommit: &AutocommitService,
    project_path: Option<&str>,
    space_path: &str,
    op: StructuralOp,
    paths: Vec<PathBuf>,
) {
    let Some(project) = project_path.filter(|path| !path.is_empty()) else {
        return;
    };
    autocommit.schedule_structural_paths(
        PathBuf::from(project),
        PathBuf::from(space_path),
        op,
        paths,
    );
}

/// Delivers a structural operation's history to the Desktop autocommit service.
pub(crate) struct AutocommitSink<'a>(pub(crate) &'a AutocommitService);

impl StructuralCommitSink for AutocommitSink<'_> {
    fn schedule(&self, project: &Path, space: &Path, op: StructuralOp, paths: Vec<PathBuf>) {
        self.0
            .schedule_structural_paths(project.to_path_buf(), space.to_path_buf(), op, paths);
    }

    fn commit_now<'a>(
        &'a self,
        project: &'a Path,
        space: &'a Path,
        paths: Vec<PathBuf>,
        message: String,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            if let Err(error) = self
                .0
                .commit_paths_now(project.to_path_buf(), space.to_path_buf(), paths, message)
                .await
            {
                tracing::warn!("schema autocommit failed: {error}");
            }
        })
    }
}

pub(crate) fn sink(autocommit: Option<&AutocommitService>) -> Option<AutocommitSink<'_>> {
    autocommit.map(AutocommitSink)
}

fn runtime<'a>(
    state: &'a IndexState,
    updates: &'a IndexUpdateState,
    git_dates: Option<&'a GitCli>,
    sink: Option<&'a AutocommitSink<'a>>,
) -> StructureRuntime<'a, GitCli> {
    StructureRuntime {
        index: &state.core,
        updates: updates.core(),
        git_dates,
        commits: sink.map(|sink| sink as &dyn StructuralCommitSink),
    }
}

pub async fn move_mutation_paths(
    state: &IndexState,
    space: &str,
    project_path: Option<&str>,
    from: &str,
    to: &str,
) -> Result<Vec<PathBuf>, AppError> {
    Ok(core_move_mutation_paths(&state.core, space, project_path, from, to).await?)
}

pub async fn backlink_mutation_paths(
    state: &IndexState,
    space: &str,
    project_path: Option<&str>,
    from: &str,
    folder_rename: bool,
) -> Result<Vec<PathBuf>, AppError> {
    Ok(core_backlink_mutation_paths(&state.core, space, project_path, from, folder_rename).await?)
}

pub async fn delete(
    space: &str,
    path: &str,
    project_path: Option<&str>,
    state: &IndexState,
    updates: &IndexUpdateState,
    autocommit: Option<&AutocommitService>,
) -> Result<DeleteOutcome, AppError> {
    let cli = crate::git::dates::detected_cli();
    let sink = sink(autocommit);
    Ok(svode_core::structure::delete(
        space,
        path,
        project_path,
        runtime(state, updates, cli.as_ref(), sink.as_ref()),
    )
    .await?)
}

pub fn create_folder(
    space: &str,
    parent_path: Option<&str>,
    name: &str,
    project_path: Option<&str>,
    autocommit: Option<&AutocommitService>,
) -> Result<String, AppError> {
    let sink = sink(autocommit);
    Ok(svode_core::structure::create_folder(
        space,
        parent_path,
        name,
        project_path,
        sink.as_ref().map(|sink| sink as &dyn StructuralCommitSink),
    )?)
}

pub async fn create_collection<F, Fut>(
    request: CollectionCreate,
    state: &IndexState,
    updates: &IndexUpdateState,
    autocommit: Option<&AutocommitService>,
    authorize: F,
) -> Result<CollectionCreateOutcome, AppError>
where
    F: FnOnce(Vec<PathBuf>) -> Fut,
    Fut: Future<Output = Result<Vec<PathBuf>, AppError>>,
{
    let cli = crate::git::dates::detected_cli();
    let sink = sink(autocommit);
    svode_core::structure::create_collection(
        request,
        runtime(state, updates, cli.as_ref(), sink.as_ref()),
        authorize,
    )
    .await
}

pub async fn convert_to_folder(
    space: &str,
    file_path: &str,
    project_path: Option<&str>,
    state: &IndexState,
    updates: &IndexUpdateState,
    autocommit: Option<&AutocommitService>,
) -> Result<Entry, AppError> {
    let cli = crate::git::dates::detected_cli();
    let sink = sink(autocommit);
    Ok(svode_core::structure::convert_to_folder(
        space,
        file_path,
        project_path,
        runtime(state, updates, cli.as_ref(), sink.as_ref()),
    )
    .await?)
}

pub async fn convert_to_leaf(
    space: &str,
    file_path: &str,
    project_path: Option<&str>,
    state: &IndexState,
    updates: &IndexUpdateState,
    autocommit: Option<&AutocommitService>,
) -> Result<Entry, AppError> {
    let cli = crate::git::dates::detected_cli();
    let sink = sink(autocommit);
    Ok(svode_core::structure::convert_to_leaf(
        space,
        file_path,
        project_path,
        runtime(state, updates, cli.as_ref(), sink.as_ref()),
    )
    .await?)
}

pub async fn convert_to_collection(
    space: &str,
    path: &str,
    project_path: Option<&str>,
    state: &IndexState,
    updates: &IndexUpdateState,
    autocommit: Option<&AutocommitService>,
) -> Result<ConvertToCollectionOutcome, AppError> {
    let cli = crate::git::dates::detected_cli();
    let sink = sink(autocommit);
    Ok(svode_core::structure::convert_to_collection(
        space,
        path,
        project_path,
        runtime(state, updates, cli.as_ref(), sink.as_ref()),
    )
    .await?)
}

pub async fn rename(
    space: &str,
    from: &str,
    to: &str,
    project_path: Option<&str>,
    state: &IndexState,
    updates: &IndexUpdateState,
    autocommit: Option<&AutocommitService>,
) -> Result<Vec<String>, AppError> {
    let cli = crate::git::dates::detected_cli();
    let sink = sink(autocommit);
    Ok(svode_core::structure::rename(
        space,
        from,
        to,
        project_path,
        runtime(state, updates, cli.as_ref(), sink.as_ref()),
    )
    .await?)
}

pub async fn move_entry(
    space: &str,
    from: &str,
    to_parent: &str,
    project_path: Option<&str>,
    state: &IndexState,
    updates: &IndexUpdateState,
    autocommit: Option<&AutocommitService>,
) -> Result<String, AppError> {
    let cli = crate::git::dates::detected_cli();
    let sink = sink(autocommit);
    Ok(svode_core::structure::move_entry(
        space,
        from,
        to_parent,
        project_path,
        runtime(state, updates, cli.as_ref(), sink.as_ref()),
    )
    .await?)
}

pub async fn nest(
    space: &str,
    path: &str,
    project_path: Option<&str>,
    state: &IndexState,
    updates: &IndexUpdateState,
    autocommit: Option<&AutocommitService>,
) -> Result<String, AppError> {
    let cli = crate::git::dates::detected_cli();
    let sink = sink(autocommit);
    Ok(svode_core::structure::nest(
        space,
        path,
        project_path,
        runtime(state, updates, cli.as_ref(), sink.as_ref()),
    )
    .await?)
}

pub async fn unnest(
    space: &str,
    path: &str,
    project_path: Option<&str>,
    state: &IndexState,
    updates: &IndexUpdateState,
    autocommit: Option<&AutocommitService>,
) -> Result<String, AppError> {
    let cli = crate::git::dates::detected_cli();
    let sink = sink(autocommit);
    Ok(svode_core::structure::unnest(
        space,
        path,
        project_path,
        runtime(state, updates, cli.as_ref(), sink.as_ref()),
    )
    .await?)
}

pub async fn duplicate(
    space: &str,
    file_path: &str,
    project_path: Option<&str>,
    state: &IndexState,
    updates: &IndexUpdateState,
    autocommit: Option<&AutocommitService>,
) -> Result<Entry, AppError> {
    let cli = crate::git::dates::detected_cli();
    let sink = sink(autocommit);
    Ok(svode_core::structure::duplicate(
        space,
        file_path,
        project_path,
        runtime(state, updates, cli.as_ref(), sink.as_ref()),
    )
    .await?)
}

/// Schedule the structural history of a Page rename, split across the Spaces
/// that own the changed paths.
pub(crate) fn schedule_rename(
    autocommit: Option<&AutocommitService>,
    project: Option<&str>,
    space: &str,
    from: &str,
    to: &str,
    changed_paths: &[PathBuf],
) {
    let Some(service) = autocommit.filter(|_| !changed_paths.is_empty()) else {
        return;
    };
    let operation = entry_rename_op(space, from, to);
    for (owner, paths) in grouped_abs_paths_by_space(project, space, changed_paths) {
        maybe_autocommit_structural_paths(
            service,
            project,
            &owner.to_string_lossy(),
            operation.clone(),
            paths,
        );
    }
}

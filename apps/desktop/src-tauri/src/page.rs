//! Desktop host adapter for core Page operations: supplies the shared runtime
//! handles and Git date provider, and triggers autocommit for applied renames.

use std::future::Future;
use std::path::PathBuf;

use svode_core::page::create::{PageCreate, PageCreateOutcome};
use svode_core::page::fields::{PageFieldOutcome, PageFieldUpdate};
use svode_core::page::nonce::WriteNonceRegistry;
use svode_core::page::write::{PageRuntime, PageWrite, PageWriteOutcome};

use crate::error::AppError;
use crate::index::{IndexState, update::IndexUpdateState};
use crate::structure::schedule_rename;
use svode_core::git::autocommit::AutocommitService;
use svode_core::git::cli::GitCli;

fn runtime<'a>(
    state: &'a IndexState,
    updates: &'a IndexUpdateState,
    nonces: &'a WriteNonceRegistry,
    git_dates: Option<&'a GitCli>,
) -> PageRuntime<'a, GitCli> {
    PageRuntime {
        index: &state.core,
        updates: updates.core(),
        nonces,
        git_dates,
    }
}

pub(crate) async fn write<F, Fut>(
    request: PageWrite<'_>,
    state: &IndexState,
    updates: &IndexUpdateState,
    nonces: &WriteNonceRegistry,
    autocommit: Option<&AutocommitService>,
    authorize: F,
) -> Result<PageWriteOutcome, AppError>
where
    F: FnOnce(Vec<PathBuf>) -> Fut,
    Fut: Future<Output = Result<Vec<PathBuf>, AppError>>,
{
    let space = request.space.to_string();
    let path = request.path.to_string();
    let project = request.project.map(str::to_string);
    let cli = crate::git::dates::detected_cli();
    let outcome = svode_core::page::write::write(
        request,
        runtime(state, updates, nonces, cli.as_ref()),
        authorize,
    )
    .await?;
    if let Some(new_path) = outcome.result.new_path.as_deref() {
        schedule_rename(
            autocommit,
            project.as_deref(),
            &space,
            &path,
            new_path,
            &outcome.changed_paths,
        );
    }
    Ok(outcome)
}

pub(crate) async fn update_fields<F, Fut>(
    request: PageFieldUpdate<'_>,
    state: &IndexState,
    updates: &IndexUpdateState,
    nonces: &WriteNonceRegistry,
    autocommit: Option<&AutocommitService>,
    authorize: F,
) -> Result<PageFieldOutcome, AppError>
where
    F: FnOnce(Vec<PathBuf>) -> Fut,
    Fut: Future<Output = Result<Vec<PathBuf>, AppError>>,
{
    let space = request.space.to_string();
    let path = request.path.to_string();
    let project = request.project.map(str::to_string);
    let cli = crate::git::dates::detected_cli();
    let outcome = svode_core::page::fields::update(
        request,
        runtime(state, updates, nonces, cli.as_ref()),
        authorize,
    )
    .await?;
    if outcome.page.path != path {
        schedule_rename(
            autocommit,
            project.as_deref(),
            &space,
            &path,
            &outcome.page.path,
            &outcome.changed_paths,
        );
    }
    Ok(outcome)
}

pub(crate) async fn create<F, Fut>(
    request: PageCreate,
    state: &IndexState,
    updates: &IndexUpdateState,
    authorize: F,
) -> Result<PageCreateOutcome, AppError>
where
    F: FnOnce(Vec<PathBuf>) -> Fut,
    Fut: Future<Output = Result<Vec<PathBuf>, AppError>>,
{
    let cli = crate::git::dates::detected_cli();
    svode_core::page::create::create(
        request,
        &state.core,
        updates.core(),
        cli.as_ref(),
        authorize,
    )
    .await
}

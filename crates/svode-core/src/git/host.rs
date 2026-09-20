//! Host capabilities of the Git save/sync services.
//!
//! The services own planning, locking, staging, publication and policy; the
//! host only authorizes the repository, delivers prepared notifications and
//! runs the runtime effects that follow a landed commit or a successful sync.
//! A host never re-executes a domain operation on behalf of the service.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;

use super::GitError;
use super::cli::GitCli;
use super::flow::{ParentPublication, SyncReport};
use super::operations::SharedError;

pub type HostFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait GitHost: Send + Sync {
    /// Authorize a mutation of the whole repository that owns `repository`.
    fn authorize_repository<'a>(
        &'a self,
        repository: &'a Path,
    ) -> HostFuture<'a, Result<(), GitError>>;

    /// Authorize a mutation of every repository the given paths belong to.
    fn authorize_paths<'a>(&'a self, paths: Vec<PathBuf>) -> HostFuture<'a, Result<(), GitError>>;

    /// Drop cached access evidence after a remote failure and publish it.
    fn invalidate_repository_access<'a>(
        &'a self,
        cli: &'a GitCli,
        repository: &'a Path,
    ) -> HostFuture<'a, ()>;

    /// Record proof that the repository is writable and publish it.
    fn record_write_evidence<'a>(
        &'a self,
        cli: &'a GitCli,
        repository: &'a Path,
    ) -> HostFuture<'a, ()>;

    /// Run the runtime effects of a successful sync: write evidence, reindex
    /// the pulled paths, refresh open pools and publish the domain events.
    fn refresh_synced_repository<'a>(
        &'a self,
        cli: &'a GitCli,
        repository: &'a Path,
    ) -> HostFuture<'a, ()>;

    /// Invalidate Actor catalogs cached for a Space after a Git operation.
    fn invalidate_actor_space<'a>(&'a self, space: &'a Path) -> HostFuture<'a, ()>;

    /// Deliver a landed commit to the runtime.
    fn publish_commit(&self, space: &Path, repository: &Path);

    /// Start the background sync that follows a commit when policy allows it.
    fn schedule_auto_sync(&self, repository: &Path);

    /// Publish the active/finished state of one publication operation.
    fn publish_sync_state(
        &self,
        repository: &Path,
        active: bool,
        report: Option<&SyncReport>,
        error: Option<&SharedError>,
    );

    /// Publish the result of a child publication and its parent pointer step.
    fn publish_publication(
        &self,
        repository: &Path,
        child_head: &str,
        parent: Option<&ParentPublication>,
    );
}

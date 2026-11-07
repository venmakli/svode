//! A Git host and CLI for the creation tests: the host records commits and
//! refuses the repositories named as denied.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::git::GitError;
use crate::git::cli::GitCli;
use crate::git::flow::{ParentPublication, SyncReport};
use crate::git::host::{GitHost, HostFuture};
use crate::git::operations::SharedError;

/// Records commits; refuses repositories named as denied.
#[derive(Default)]
pub(super) struct Host {
    pub(super) denied: Vec<PathBuf>,
    pub(super) commits: Mutex<Vec<PathBuf>>,
}

impl GitHost for Host {
    fn authorize_repository<'a>(
        &'a self,
        repository: &'a Path,
    ) -> HostFuture<'a, Result<(), GitError>> {
        Box::pin(async move {
            if self.denied.iter().any(|denied| denied == repository) {
                return Err(GitError::RepositoryAccessDenied {
                    repository_id: "denied".into(),
                    status: "read_only".into(),
                    reason: "fixture".into(),
                });
            }
            Ok(())
        })
    }

    fn authorize_paths<'a>(&'a self, _paths: Vec<PathBuf>) -> HostFuture<'a, Result<(), GitError>> {
        Box::pin(async { Ok(()) })
    }

    fn invalidate_repository_access<'a>(
        &'a self,
        _cli: &'a GitCli,
        _repository: &'a Path,
    ) -> HostFuture<'a, ()> {
        Box::pin(async {})
    }

    fn record_write_evidence<'a>(
        &'a self,
        _cli: &'a GitCli,
        _repository: &'a Path,
    ) -> HostFuture<'a, ()> {
        Box::pin(async {})
    }

    fn refresh_synced_repository<'a>(
        &'a self,
        _cli: &'a GitCli,
        _repository: &'a Path,
    ) -> HostFuture<'a, ()> {
        Box::pin(async {})
    }

    fn invalidate_actor_space<'a>(&'a self, _space: &'a Path) -> HostFuture<'a, ()> {
        Box::pin(async {})
    }

    fn publish_commit(&self, _space: &Path, repository: &Path) {
        self.commits.lock().unwrap().push(repository.to_path_buf());
    }

    fn schedule_auto_sync(&self, _repository: &Path) {}

    fn publish_sync_state(
        &self,
        _repository: &Path,
        _active: bool,
        _background: bool,
        _report: Option<&SyncReport>,
        _error: Option<&SharedError>,
    ) {
    }

    fn publish_publication(
        &self,
        _repository: &Path,
        _child_head: &str,
        _parent: Option<&ParentPublication>,
    ) {
    }
}

pub(super) fn cli() -> GitCli {
    #[cfg(target_os = "macos")]
    {
        GitCli::for_test("/usr/bin/git".into())
    }
    #[cfg(not(target_os = "macos"))]
    {
        GitCli::detect().unwrap()
    }
}

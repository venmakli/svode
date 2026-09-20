use std::path::Path;
use std::sync::Arc;

use super::cli::GitCli;
use crate::AppError;
use svode_core::git::ops::GitStatus;
use svode_core::git::state::GitRuntime;

/// Tauri-managed handle to the shared Git runtime.
///
/// The runtime owns repository locks, pending paths and in-flight operation
/// coordination; this adapter only hands them to commands and maps failures
/// to the existing IPC error.
pub struct GitState(Arc<GitRuntime>);

impl GitState {
    pub fn new() -> Self {
        Self(Arc::new(GitRuntime::new()))
    }

    #[cfg(test)]
    pub(crate) fn without_cli() -> Self {
        Self(Arc::new(GitRuntime::without_cli()))
    }

    pub(crate) fn runtime(&self) -> &Arc<GitRuntime> {
        &self.0
    }

    pub(crate) fn detected(&self) -> Option<&GitCli> {
        self.0.detected()
    }

    pub(crate) fn cli(&self) -> Result<&GitCli, AppError> {
        Ok(self.0.cli()?)
    }

    pub(crate) fn require_cli(&self) -> Result<GitCli, AppError> {
        Ok(self.0.require_cli()?)
    }

    pub(crate) async fn get_lock(&self, path: &Path) -> Arc<tokio::sync::Mutex<()>> {
        self.0.get_lock(path).await
    }

    pub(crate) fn repository(&self) -> &svode_core::git::state::GitRepositoryState {
        self.0.repository()
    }

    pub(crate) async fn status(
        &self,
        path: &Path,
        remote_counts: bool,
    ) -> Result<GitStatus, AppError> {
        Ok(self.0.status(path, remote_counts).await?)
    }
}

impl Default for GitState {
    fn default() -> Self {
        Self::new()
    }
}

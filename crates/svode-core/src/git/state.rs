use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use super::GitError;
use super::cli::GitCli;
use super::operations::Operations;
use super::pending::PendingPaths;
use super::status::GitStatus;

static DETECTED_CLI: OnceLock<Option<GitCli>> = OnceLock::new();

/// One process-wide Git CLI detection shared by every runtime and caller.
pub fn detected_cli() -> Option<GitCli> {
    DETECTED_CLI.get_or_init(|| GitCli::detect().ok()).clone()
}

#[derive(Default)]
pub struct GitRepositoryState {
    pending: Arc<PendingPaths>,
    locks: tokio::sync::Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>,
}

impl GitRepositoryState {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn get_lock(&self, path: &Path) -> Arc<tokio::sync::Mutex<()>> {
        let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| {
            path.parent()
                .and_then(|parent| std::fs::canonicalize(parent).ok())
                .zip(path.file_name())
                .map(|(parent, name)| parent.join(name))
                .unwrap_or_else(|| path.to_path_buf())
        });
        let mut locks = self.locks.lock().await;
        locks
            .entry(canonical)
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    pub fn pending(&self) -> Arc<PendingPaths> {
        self.pending.clone()
    }
}

/// Process-local Git runtime shared by commands, services, and background work.
///
/// Repository locks and in-flight operation coordination deliberately remain
/// process-local. Cross-process writer coordination is a separate runtime
/// contract.
pub struct GitRuntime {
    cli: Option<GitCli>,
    operations: Arc<Operations>,
    repository: GitRepositoryState,
}

impl GitRuntime {
    pub fn new() -> Self {
        let cli = detected_cli();
        if cli.is_none() {
            tracing::warn!("Git not available");
        }
        Self {
            cli,
            operations: Arc::default(),
            repository: GitRepositoryState::new(),
        }
    }

    /// A runtime whose Git executable is unavailable, for fixtures that
    /// assert the typed `GitNotFound` path.
    pub fn without_cli() -> Self {
        Self {
            cli: None,
            operations: Arc::default(),
            repository: GitRepositoryState::new(),
        }
    }

    pub fn detected(&self) -> Option<&GitCli> {
        self.cli.as_ref()
    }

    pub fn cli(&self) -> Result<&GitCli, GitError> {
        self.cli.as_ref().ok_or(GitError::GitNotFound)
    }

    pub fn require_cli(&self) -> Result<GitCli, GitError> {
        self.cli.clone().ok_or(GitError::GitNotFound)
    }

    pub fn repository(&self) -> &GitRepositoryState {
        &self.repository
    }

    pub fn operations(&self) -> &Arc<Operations> {
        &self.operations
    }

    pub async fn get_lock(&self, path: &Path) -> Arc<tokio::sync::Mutex<()>> {
        self.repository.get_lock(path).await
    }

    pub fn pending(&self) -> Arc<PendingPaths> {
        self.repository.pending()
    }

    pub async fn status(&self, path: &Path, remote_counts: bool) -> Result<GitStatus, GitError> {
        let repository = super::access::resolve_repository(self.cli()?, path).await?;
        let lock = self.get_lock(&repository).await;
        let _guard = lock.lock().await;
        let mut status = if remote_counts {
            super::ops::status_with_remote_counts(self.cli()?, path).await?
        } else {
            super::ops::status(self.cli()?, path).await?
        };
        status.repository = Some(repository.to_string_lossy().into_owned());
        Ok(status)
    }
}

impl Default for GitRuntime {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn status_resolves_the_effective_repository_and_preserves_files() {
        let runtime = GitRuntime::new();
        let Ok(cli) = runtime.require_cli() else {
            return;
        };
        let repository = tempfile::tempdir().unwrap();
        cli.exec(repository.path(), &["init"]).await.unwrap();
        std::fs::write(repository.path().join("note.md"), "body").unwrap();

        let status = runtime.status(repository.path(), false).await.unwrap();

        assert_eq!(
            status.repository.as_deref(),
            repository.path().canonicalize().unwrap().to_str()
        );
        assert!(status.files.iter().any(|file| file.path == "note.md"));
    }

    #[tokio::test]
    async fn unavailable_git_preserves_the_typed_error() {
        let runtime = GitRuntime::without_cli();

        assert!(matches!(runtime.require_cli(), Err(GitError::GitNotFound)));
        assert!(matches!(
            runtime.status(Path::new("."), false).await,
            Err(GitError::GitNotFound)
        ));
    }

    #[tokio::test]
    async fn canonical_repository_aliases_share_one_lock() {
        let state = GitRepositoryState::new();
        let repository = tempfile::tempdir().unwrap();
        let direct = state.get_lock(repository.path()).await;
        let aliased = state.get_lock(&repository.path().join(".")).await;
        assert!(Arc::ptr_eq(&direct, &aliased));
    }
}

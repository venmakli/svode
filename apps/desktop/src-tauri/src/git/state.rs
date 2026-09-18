use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use super::cli::GitCli;
use super::operations::Operations;
use super::ops::GitStatus;
use crate::AppError;

static DETECTED_CLI: OnceLock<Option<GitCli>> = OnceLock::new();

pub(super) fn detected_cli() -> Option<GitCli> {
    DETECTED_CLI.get_or_init(|| GitCli::detect().ok()).clone()
}

/// Process-local Git runtime shared by commands, services, and background work.
///
/// Repository locks and in-flight operation coordination deliberately remain
/// process-local. Cross-process writer coordination is a separate runtime
/// contract.
pub struct GitState {
    pub(crate) cli: Option<GitCli>,
    pub(crate) operations: Arc<Operations>,
    locks: tokio::sync::Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>,
}

impl GitState {
    pub fn new() -> Self {
        let cli = detected_cli();
        if cli.is_none() {
            tracing::warn!("Git not available");
        }
        Self {
            cli,
            operations: Arc::default(),
            locks: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn cli(&self) -> Result<&GitCli, AppError> {
        self.cli.as_ref().ok_or(AppError::GitNotFound)
    }

    pub(crate) fn require_cli(&self) -> Result<GitCli, AppError> {
        self.cli.clone().ok_or(AppError::GitNotFound)
    }

    pub(crate) async fn get_lock(&self, path: &Path) -> Arc<tokio::sync::Mutex<()>> {
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

    pub(crate) async fn status(
        &self,
        path: &Path,
        remote_counts: bool,
    ) -> Result<GitStatus, AppError> {
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

impl Default for GitState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn canonical_repository_aliases_share_one_lock() {
        let state = GitState::new();
        let repository = tempfile::tempdir().unwrap();

        let direct = state.get_lock(repository.path()).await;
        let aliased = state.get_lock(&repository.path().join(".")).await;

        assert!(Arc::ptr_eq(&direct, &aliased));
    }

    #[tokio::test]
    async fn status_resolves_the_effective_repository_and_preserves_files() {
        let state = GitState::new();
        let Ok(cli) = state.require_cli() else {
            return;
        };
        let repository = tempfile::tempdir().unwrap();
        cli.exec(repository.path(), &["init"]).await.unwrap();
        std::fs::write(repository.path().join("note.md"), "body").unwrap();

        let status = state.status(repository.path(), false).await.unwrap();

        assert_eq!(
            status.repository.as_deref(),
            repository.path().canonicalize().unwrap().to_str()
        );
        assert!(status.files.iter().any(|file| file.path == "note.md"));
    }

    #[tokio::test]
    async fn unavailable_git_preserves_the_typed_error() {
        let state = GitState {
            cli: None,
            operations: Arc::default(),
            locks: tokio::sync::Mutex::new(HashMap::new()),
        };

        assert!(matches!(state.require_cli(), Err(AppError::GitNotFound)));
        assert!(matches!(
            state.status(Path::new("."), false).await,
            Err(AppError::GitNotFound)
        ));
    }
}

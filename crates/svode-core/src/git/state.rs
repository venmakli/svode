use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use super::GitError;
use super::cli::GitCli;
use super::operations::Operations;
use super::pending::PendingPaths;
use super::status::GitStatus;
use super::sync::SyncResult;

static DETECTED_CLI: OnceLock<Option<GitCli>> = OnceLock::new();

/// One process-wide Git CLI detection shared by every runtime and caller,
/// whatever its release.
fn installed_cli() -> Option<GitCli> {
    DETECTED_CLI.get_or_init(|| GitCli::detect().ok()).clone()
}

/// The detected Git CLI when Svode may run it: a Git older than the minimum
/// is treated like a missing one.
pub fn detected_cli() -> Option<GitCli> {
    installed_cli().filter(|cli| cli.ensure_supported().is_ok())
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
        let cli = installed_cli();
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

    #[cfg(test)]
    pub(crate) fn with_cli(cli: GitCli) -> Self {
        Self {
            cli: Some(cli),
            operations: Arc::default(),
            repository: GitRepositoryState::new(),
        }
    }

    /// The Git CLI when Svode may run it; `None` also for a Git older than
    /// the minimum, which [`Self::cli`] refuses with its release.
    pub fn detected(&self) -> Option<&GitCli> {
        self.cli
            .as_ref()
            .filter(|cli| cli.ensure_supported().is_ok())
    }

    /// The Git CLI whatever its release, for availability checks only.
    pub fn installed(&self) -> Option<&GitCli> {
        self.cli.as_ref()
    }

    pub fn cli(&self) -> Result<&GitCli, GitError> {
        let cli = self.cli.as_ref().ok_or(GitError::GitNotFound)?;
        cli.ensure_supported()?;
        Ok(cli)
    }

    pub fn require_cli(&self) -> Result<GitCli, GitError> {
        self.cli().cloned()
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

    /// What stops sync of the repository at `path` right now, as sync reports it.
    pub async fn sync_preflight(&self, path: &Path) -> Result<Option<SyncResult>, GitError> {
        let repository = super::access::resolve_repository(self.cli()?, path).await?;
        let lock = self.get_lock(&repository).await;
        let _guard = lock.lock().await;
        super::sync::preflight(self.cli()?, path).await
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

    #[cfg(unix)]
    #[tokio::test]
    async fn git_older_than_the_minimum_is_refused_with_its_release_until_updated_in_place() {
        let temp = tempfile::tempdir().unwrap();
        let release = temp.path().join("release");
        let script = temp.path().join("git");
        std::fs::write(&release, "git version 2.30.1\n").unwrap();
        svode_testkit::write_executable(
            &script,
            format!(
                "#!/bin/sh\nfor arg in \"$@\"; do if [ \"$arg\" = --version ]; then cat '{}'; exit 0; fi; done\nexit 1\n",
                release.display()
            ),
        )
        .unwrap();
        let cli = GitCli::for_test(script);

        let availability = cli.check_availability().await;
        assert!(availability.git && !availability.git_version_supported);
        assert_eq!(availability.git_version.as_deref(), Some("2.30.1"));
        assert_eq!(availability.git_minimum_version, "2.31.0");
        let runtime = GitRuntime::with_cli(cli.clone());
        let refusal = runtime.require_cli().unwrap_err();
        assert!(
            matches!(&refusal, GitError::GitUnsupported { version } if version == "2.30.1"),
            "{refusal:?}"
        );
        assert_eq!(
            refusal.to_string(),
            "Git 2.30.1 is older than 2.31.0, the oldest Git Svode supports. Update Git, then retry."
        );
        assert!(runtime.detected().is_none());
        assert!(runtime.installed().is_some());
        assert!(matches!(
            runtime.status(Path::new("."), false).await,
            Err(GitError::GitUnsupported { .. })
        ));

        std::fs::write(&release, "git version 2.37.7\n").unwrap();
        assert!(cli.check_availability().await.git_version_supported);
        assert!(!runtime.cli().unwrap().background_merge());
        std::fs::write(&release, "git version 2.38.0 (Apple Git-200)\n").unwrap();
        cli.refresh_version().await;
        assert!(runtime.detected().unwrap().background_merge());
    }

    /// The Git answers its release only to the exact arguments of Svode's
    /// read; a read with other arguments gets another release.
    #[cfg(unix)]
    #[tokio::test]
    async fn start_and_the_availability_check_read_the_release_with_one_command() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("git");
        svode_testkit::write_executable(
            &script,
            format!(
                "#!/bin/sh\nif [ \"$*\" = '{}' ]; then echo 'git version 2.37.0'; exit 0; fi\n\
                 for arg in \"$@\"; do if [ \"$arg\" = --version ]; then echo 'git version 2.55.0'; exit 0; fi; done\nexit 1\n",
                crate::git::cli::VERSION_ARGS.join(" ")
            ),
        )
        .unwrap();
        let start = crate::git::version::GitVersion::new(2, 37, 0);

        let cli = GitCli::detect_at(script);
        assert_eq!(cli.version(), Some(start));
        let availability = cli.check_availability().await;
        assert_eq!(availability.git_version.as_deref(), Some("2.37.0"));
        assert_eq!(cli.version(), Some(start));
        assert!(!cli.background_merge());
        assert_eq!(cli.refresh_version().await, Some(start));
        assert_eq!(cli.version(), Some(start));
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

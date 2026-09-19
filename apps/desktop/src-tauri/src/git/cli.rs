use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;
use std::time::Duration;

use tokio::process::Command;

use crate::AppError;

pub use svode_core::git::cli::{GitAvailability, GitOutput};

#[derive(Debug, Clone)]
pub struct GitCli(svode_core::git::cli::GitCli);

impl GitCli {
    #[cfg(test)]
    pub(crate) fn for_test(git_path: PathBuf) -> Self {
        Self(svode_core::git::cli::GitCli::for_test(git_path))
    }

    pub fn detect() -> Result<Self, AppError> {
        Ok(Self(svode_core::git::cli::GitCli::detect()?))
    }

    pub fn git_path(&self) -> &Path {
        self.0.git_path()
    }

    pub fn lfs_available(&self) -> bool {
        self.0.lfs_available()
    }

    pub(crate) fn configure_process_env(&self, command: &mut Command) {
        self.0.configure_process_env(command);
    }

    pub async fn exec(&self, dir: &Path, args: &[&str]) -> Result<GitOutput, AppError> {
        Ok(self.0.exec(dir, args).await?)
    }

    pub async fn exec_with_env(
        &self,
        dir: &Path,
        args: &[&str],
        env: &[(&str, &str)],
    ) -> Result<GitOutput, AppError> {
        Ok(self.0.exec_with_env(dir, args, env).await?)
    }

    pub(crate) async fn exec_redacted(
        &self,
        dir: &Path,
        args: &[&str],
    ) -> Result<GitOutput, AppError> {
        Ok(self.0.exec_redacted(dir, args).await?)
    }

    pub(crate) async fn exec_sensitive_with_stdin(
        &self,
        dir: &Path,
        args: &[&str],
        env: &[(&str, &str)],
        stdin: Option<&str>,
        timeout: Duration,
    ) -> Result<GitOutput, AppError> {
        Ok(self
            .0
            .exec_sensitive_with_stdin(dir, args, env, stdin, timeout)
            .await?)
    }

    pub async fn exec_no_dir(&self, args: &[&str]) -> Result<GitOutput, AppError> {
        Ok(self.0.exec_no_dir(args).await?)
    }

    pub async fn exec_no_dir_with_stdin(
        &self,
        args: &[&str],
        stdin: &str,
    ) -> Result<GitOutput, AppError> {
        Ok(self.0.exec_no_dir_with_stdin(args, stdin).await?)
    }

    pub async fn check_availability(&self) -> GitAvailability {
        self.0.check_availability().await
    }

    pub fn core(&self) -> &svode_core::git::cli::GitCli {
        &self.0
    }
}

pub(crate) async fn read_bounded(
    cli: &GitCli,
    repo: &Path,
    args: &[&str],
    max_bytes: usize,
) -> Result<(bool, Vec<u8>), AppError> {
    Ok(svode_core::git::cli::read_bounded(cli.core(), repo, args, max_bytes).await?)
}

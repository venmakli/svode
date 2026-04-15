use std::path::{Path, PathBuf};

use serde::Serialize;
use tokio::process::Command;

use crate::AppError;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitAvailability {
    pub git: bool,
    pub git_lfs: bool,
    pub git_version: Option<String>,
}

#[derive(Debug, Clone)]
pub struct GitOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[derive(Debug, Clone)]
pub struct GitCli {
    git_path: PathBuf,
    lfs_available: bool,
}

impl GitCli {
    /// Detect git binary and LFS availability.
    pub fn detect() -> Result<Self, AppError> {
        let git_path =
            which::which("git").map_err(|_| AppError::GitNotFound)?;

        tracing::info!("Found git at: {}", git_path.display());

        let lfs_available = which::which("git-lfs").is_ok();
        if lfs_available {
            tracing::info!("Git LFS is available");
        } else {
            tracing::debug!("Git LFS not found");
        }

        Ok(Self {
            git_path,
            lfs_available,
        })
    }

    /// Path to the git binary.
    pub fn git_path(&self) -> &Path {
        &self.git_path
    }

    /// Whether git-lfs is installed and available on PATH.
    pub fn lfs_available(&self) -> bool {
        self.lfs_available
    }

    /// Execute a git command in the given space directory.
    pub async fn exec(
        &self,
        space_dir: &Path,
        args: &[&str],
    ) -> Result<GitOutput, AppError> {
        tracing::debug!(
            "git {} (in {})",
            args.join(" "),
            space_dir.display()
        );

        let output = Command::new(&self.git_path)
            .args(args)
            .current_dir(space_dir)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C.UTF-8")
            .output()
            .await
            .map_err(|e| {
                AppError::GitCommandFailed(format!("Failed to spawn git: {e}"))
            })?;

        let result = GitOutput {
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            exit_code: output.status.code().unwrap_or(-1),
        };

        if result.exit_code != 0 {
            tracing::debug!(
                "git {} exited with code {}: {}",
                args.join(" "),
                result.exit_code,
                result.stderr.trim()
            );
        }

        Ok(result)
    }

    /// Execute a git command without a working directory (e.g. clone).
    #[allow(dead_code)]
    pub async fn exec_no_dir(
        &self,
        args: &[&str],
    ) -> Result<GitOutput, AppError> {
        tracing::debug!("git {}", args.join(" "));

        let output = Command::new(&self.git_path)
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C.UTF-8")
            .output()
            .await
            .map_err(|e| {
                AppError::GitCommandFailed(format!("Failed to spawn git: {e}"))
            })?;

        let result = GitOutput {
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            exit_code: output.status.code().unwrap_or(-1),
        };

        Ok(result)
    }

    /// Check git and git-lfs availability with version info.
    pub async fn check_availability(&self) -> GitAvailability {
        let version_output = Command::new(&self.git_path)
            .args(["--version"])
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .await;

        let git_version = version_output.ok().map(|o| {
            String::from_utf8_lossy(&o.stdout).trim().to_string()
        });

        GitAvailability {
            git: true,
            git_lfs: self.lfs_available,
            git_version,
        }
    }
}

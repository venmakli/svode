use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;

use serde::Serialize;
use tokio::process::Command;

use crate::{AppError, process};

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
        let git_path = resolve_git_binary()?;

        tracing::info!("Found git at: {}", git_path.display());

        let lfs_available = detect_lfs_extension(&git_path);
        if lfs_available {
            tracing::info!("Git LFS is available via git lfs version");
        } else {
            tracing::debug!("Git LFS extension not available");
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
    pub async fn exec(&self, space_dir: &Path, args: &[&str]) -> Result<GitOutput, AppError> {
        self.exec_with_env(space_dir, args, &[]).await
    }

    /// Execute a git command with extra environment variables. Used e.g. for
    /// `submodule update` calls that need `GIT_LFS_SKIP_SMUDGE=1` to defer
    /// LFS content fetches to the explicit Repair flow.
    pub async fn exec_with_env(
        &self,
        space_dir: &Path,
        args: &[&str],
        extra_env: &[(&str, &str)],
    ) -> Result<GitOutput, AppError> {
        tracing::debug!("git {} (in {})", args.join(" "), space_dir.display());

        let git_args = args_with_quote_path(args);
        let mut cmd = Command::new(&self.git_path);
        process::hide_tokio_window(&mut cmd);
        cmd.args(&git_args)
            .current_dir(space_dir)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C.UTF-8");
        for (k, v) in extra_env {
            cmd.env(k, v);
        }

        let output = cmd
            .output()
            .await
            .map_err(|e| AppError::GitCommandFailed(format!("Failed to spawn git: {e}")))?;

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

    /// Execute a git command without a working directory (e.g. clone, or
    /// `--global` config writes).
    pub async fn exec_no_dir(&self, args: &[&str]) -> Result<GitOutput, AppError> {
        tracing::debug!("git {}", args.join(" "));

        let git_args = args_with_quote_path(args);
        let mut cmd = Command::new(&self.git_path);
        process::hide_tokio_window(&mut cmd);
        let output = cmd
            .args(&git_args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C.UTF-8")
            .output()
            .await
            .map_err(|e| AppError::GitCommandFailed(format!("Failed to spawn git: {e}")))?;

        let result = GitOutput {
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            exit_code: output.status.code().unwrap_or(-1),
        };

        Ok(result)
    }

    /// Check git and git-lfs availability with version info.
    pub async fn check_availability(&self) -> GitAvailability {
        let mut cmd = Command::new(&self.git_path);
        process::hide_tokio_window(&mut cmd);
        let version_output = cmd
            .args(["-c", "core.quotePath=false", "--version"])
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .await;

        let git_version = version_output
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());

        GitAvailability {
            git: true,
            git_lfs: self.lfs_available,
            git_version,
        }
    }
}

fn args_with_quote_path<'a>(args: &'a [&'a str]) -> Vec<&'a str> {
    let mut out = Vec::with_capacity(args.len() + 2);
    out.push("-c");
    out.push("core.quotePath=false");
    out.extend_from_slice(args);
    out
}

fn resolve_git_binary() -> Result<PathBuf, AppError> {
    if let Ok(path) = which::which("git") {
        return Ok(path);
    }

    for candidate in git_fallback_candidates() {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    Err(AppError::GitNotFound)
}

fn detect_lfs_extension(git_path: &Path) -> bool {
    let mut cmd = StdCommand::new(git_path);
    process::hide_window(&mut cmd);
    cmd.args(["-c", "core.quotePath=false", "lfs", "version"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C.UTF-8")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(windows)]
fn git_fallback_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(root) = std::env::var_os("ProgramFiles") {
        out.push(PathBuf::from(&root).join("Git").join("cmd").join("git.exe"));
        out.push(PathBuf::from(root).join("Git").join("bin").join("git.exe"));
    }
    if let Some(root) = std::env::var_os("ProgramFiles(x86)") {
        out.push(PathBuf::from(root).join("Git").join("cmd").join("git.exe"));
    }
    if let Some(root) = std::env::var_os("LOCALAPPDATA") {
        out.push(
            PathBuf::from(root)
                .join("Programs")
                .join("Git")
                .join("cmd")
                .join("git.exe"),
        );
    }
    if let Some(root) = std::env::var_os("USERPROFILE") {
        out.push(
            PathBuf::from(root)
                .join("scoop")
                .join("shims")
                .join("git.exe"),
        );
    }
    out.push(PathBuf::from("C:/ProgramData/chocolatey/bin/git.exe"));
    out
}

#[cfg(not(windows))]
fn git_fallback_candidates() -> Vec<PathBuf> {
    [
        "/usr/bin/git",
        "/usr/local/bin/git",
        "/opt/homebrew/bin/git",
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect()
}

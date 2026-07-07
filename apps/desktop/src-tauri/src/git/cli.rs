use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};

use serde::Serialize;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::{AppError, process};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitAvailability {
    pub git: bool,
    pub git_lfs: bool,
    pub git_version: Option<String>,
    pub git_lfs_version: Option<String>,
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
}

impl GitCli {
    /// Detect git binary and LFS availability.
    pub fn detect() -> Result<Self, AppError> {
        let git_path = resolve_git_binary()?;

        tracing::info!("Found git at: {}", git_path.display());

        let lfs = detect_lfs_extension(&git_path);
        if lfs.available {
            tracing::info!("Git LFS is available via git lfs version");
        } else {
            tracing::debug!("Git LFS extension not available");
        }

        Ok(Self { git_path })
    }

    /// Path to the git binary.
    pub fn git_path(&self) -> &Path {
        &self.git_path
    }

    /// Whether git-lfs is installed and available on PATH.
    pub fn lfs_available(&self) -> bool {
        detect_lfs_extension(&self.git_path).available
    }

    /// Apply the environment Svode expects for direct git subprocesses.
    pub(crate) fn configure_process_env(&self, cmd: &mut Command) {
        apply_common_git_env(cmd);
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
        apply_common_git_env(&mut cmd);
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
        apply_common_git_env(&mut cmd);
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

    /// Execute a git command without a working directory and write a payload to
    /// stdin. Used for `git credential approve`; callers must keep secrets out
    /// of args and tracing.
    pub async fn exec_no_dir_with_stdin(
        &self,
        args: &[&str],
        stdin_payload: &str,
    ) -> Result<GitOutput, AppError> {
        tracing::debug!("git {}", args.join(" "));

        let git_args = args_with_quote_path(args);
        let mut cmd = Command::new(&self.git_path);
        process::hide_tokio_window(&mut cmd);
        apply_common_git_env(&mut cmd);
        cmd.args(&git_args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C.UTF-8")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| AppError::GitCommandFailed(format!("Failed to spawn git: {e}")))?;

        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(stdin_payload.as_bytes())
                .await
                .map_err(|e| {
                    AppError::GitCommandFailed(format!("Failed to write git stdin: {e}"))
                })?;
            stdin.flush().await.map_err(|e| {
                AppError::GitCommandFailed(format!("Failed to flush git stdin: {e}"))
            })?;
        }

        let output = child
            .wait_with_output()
            .await
            .map_err(|e| AppError::GitCommandFailed(format!("Failed to wait for git: {e}")))?;

        Ok(GitOutput {
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            exit_code: output.status.code().unwrap_or(-1),
        })
    }

    /// Check git and git-lfs availability with version info.
    pub async fn check_availability(&self) -> GitAvailability {
        let mut cmd = Command::new(&self.git_path);
        process::hide_tokio_window(&mut cmd);
        apply_common_git_env(&mut cmd);
        let version_output = cmd
            .args(["-c", "core.quotePath=false", "--version"])
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .await;

        let git_version = version_output
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());

        let lfs = detect_lfs_extension(&self.git_path);

        GitAvailability {
            git: true,
            git_lfs: lfs.available,
            git_version,
            git_lfs_version: lfs.version,
        }
    }
}

fn apply_common_git_env(cmd: &mut Command) {
    // Do not inherit editor askpass helpers into backend IPC commands. Svode
    // needs git to fail fast with AuthRequired instead of waiting on another UI.
    cmd.env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .env("SSH_ASKPASS_REQUIRE", "never")
        .env("GCM_INTERACTIVE", "never")
        .env("LC_ALL", "C.UTF-8");
    if let Some(path) = git_subprocess_path_env() {
        cmd.env("PATH", path);
    }
}

fn apply_common_std_git_env(cmd: &mut StdCommand) {
    // Keep sync and blocking detection paths consistent with async git calls.
    cmd.env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .env("SSH_ASKPASS_REQUIRE", "never")
        .env("GCM_INTERACTIVE", "never")
        .env("LC_ALL", "C.UTF-8");
    if let Some(path) = git_subprocess_path_env() {
        cmd.env("PATH", path);
    }
}

fn args_with_quote_path<'a>(args: &'a [&'a str]) -> Vec<&'a str> {
    let mut out = Vec::with_capacity(args.len() + 4);
    out.push("-c");
    out.push("core.quotePath=false");
    out.push("-c");
    out.push("core.askPass=");
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

#[derive(Debug, Clone, Default)]
struct LfsDetection {
    available: bool,
    version: Option<String>,
}

fn detect_lfs_extension(git_path: &Path) -> LfsDetection {
    let mut cmd = StdCommand::new(git_path);
    process::hide_window(&mut cmd);
    apply_common_std_git_env(&mut cmd);
    let output = cmd
        .args(["-c", "core.quotePath=false", "lfs", "version"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C.UTF-8")
        .output();
    match output {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            LfsDetection {
                available: true,
                version: parse_lfs_version(stdout.trim()),
            }
        }
        _ => LfsDetection::default(),
    }
}

fn parse_lfs_version(output: &str) -> Option<String> {
    let first_line = output.lines().next()?.trim();
    if first_line.is_empty() {
        return None;
    }
    first_line
        .strip_prefix("git-lfs/")
        .and_then(|rest| rest.split_whitespace().next())
        .map(str::to_string)
        .or_else(|| Some(first_line.to_string()))
}

fn git_subprocess_path_env() -> Option<OsString> {
    let mut current_paths: Vec<PathBuf> = std::env::var_os("PATH")
        .as_deref()
        .map(std::env::split_paths)
        .map(Iterator::collect)
        .unwrap_or_default();

    let mut extra_dirs = Vec::new();
    for dir in git_lfs_candidate_dirs() {
        if !current_paths.iter().any(|path| path == &dir)
            && !extra_dirs.iter().any(|path| path == &dir)
        {
            extra_dirs.push(dir);
        }
    }
    if extra_dirs.is_empty() {
        return None;
    }

    extra_dirs.append(&mut current_paths);
    std::env::join_paths(extra_dirs).ok()
}

fn git_lfs_candidate_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(path) = which::which("git-lfs") {
        push_parent_dir(&mut dirs, path);
    }
    for candidate in git_lfs_fallback_candidates() {
        if candidate.is_file() {
            push_parent_dir(&mut dirs, candidate);
        }
    }
    dirs
}

fn push_parent_dir(out: &mut Vec<PathBuf>, path: PathBuf) {
    let Some(parent) = path.parent() else {
        return;
    };
    let parent = parent.to_path_buf();
    if !out.iter().any(|existing| existing == &parent) {
        out.push(parent);
    }
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

#[cfg(windows)]
fn git_lfs_fallback_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(root) = std::env::var_os("ProgramFiles") {
        let root = PathBuf::from(root);
        out.push(root.join("Git").join("cmd").join("git-lfs.exe"));
        out.push(
            root.join("Git")
                .join("mingw64")
                .join("bin")
                .join("git-lfs.exe"),
        );
        out.push(root.join("Git LFS").join("git-lfs.exe"));
    }
    if let Some(root) = std::env::var_os("ProgramFiles(x86)") {
        let root = PathBuf::from(root);
        out.push(root.join("Git").join("cmd").join("git-lfs.exe"));
        out.push(
            root.join("Git")
                .join("mingw64")
                .join("bin")
                .join("git-lfs.exe"),
        );
        out.push(root.join("Git LFS").join("git-lfs.exe"));
    }
    if let Some(root) = std::env::var_os("USERPROFILE") {
        out.push(
            PathBuf::from(root)
                .join("scoop")
                .join("shims")
                .join("git-lfs.exe"),
        );
    }
    out.push(PathBuf::from("C:/ProgramData/chocolatey/bin/git-lfs.exe"));
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

#[cfg(not(windows))]
fn git_lfs_fallback_candidates() -> Vec<PathBuf> {
    [
        "/opt/homebrew/bin/git-lfs",
        "/usr/local/bin/git-lfs",
        "/usr/bin/git-lfs",
        "/bin/git-lfs",
        "/snap/bin/git-lfs",
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect()
}

#[cfg(test)]
mod tests {
    use super::{args_with_quote_path, parse_lfs_version};

    #[test]
    fn parses_git_lfs_version_prefix() {
        assert_eq!(
            parse_lfs_version("git-lfs/3.7.1 (GitHub; darwin arm64; go 1.25.3)").as_deref(),
            Some("3.7.1")
        );
    }

    #[test]
    fn falls_back_to_full_lfs_output_when_format_is_unknown() {
        assert_eq!(
            parse_lfs_version("git-lfs version custom").as_deref(),
            Some("git-lfs version custom")
        );
    }

    #[test]
    fn git_args_disable_core_askpass() {
        assert_eq!(
            args_with_quote_path(&["credential", "fill"]),
            vec![
                "-c",
                "core.quotePath=false",
                "-c",
                "core.askPass=",
                "credential",
                "fill",
            ]
        );
    }
}

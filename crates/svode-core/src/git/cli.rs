use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{Semaphore, SemaphorePermit};

use super::GitError;
use super::version::{GitVersion, release_label};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The most Git processes the app runs at once. Each holds descriptors for
/// its pipes while it runs; the bound keeps a burst of concurrent reads, such
/// as the eleven processes of every operation snapshot, within the default
/// descriptor limit of macOS (256).
pub const GIT_PROCESS_LIMIT: usize = 16;

static GIT_PROCESSES: Semaphore = Semaphore::const_new(GIT_PROCESS_LIMIT);

/// A place for one Git process, held until the process has exited and its
/// pipes are closed. Waiting for a place never fails, and the timeout of a
/// process starts only once it has one. Every asynchronous Git process takes
/// one; blocking ones (the release read at start, the LFS detection and the
/// removal of publication evidence) run one at a time on the thread of their
/// caller, which must not wait for a place held by tasks of its runtime.
pub(crate) async fn process_slot() -> SemaphorePermit<'static> {
    GIT_PROCESSES
        .acquire()
        .await
        .expect("the Git process limit is never closed")
}

pub(crate) fn hide_window(command: &mut StdCommand) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

fn hide_tokio_window(command: &mut Command) {
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    #[cfg(not(windows))]
    let _ = command;
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitAvailability {
    pub git: bool,
    pub git_lfs: bool,
    /// `git version` output without its fixed prefix, e.g. `2.50.1 (Apple Git-155)`.
    pub git_version: Option<String>,
    pub git_lfs_version: Option<String>,
    /// False only for a recognised release older than [`GitVersion::MINIMUM`].
    pub git_version_supported: bool,
    pub git_minimum_version: String,
}

impl GitAvailability {
    pub fn missing() -> Self {
        Self {
            git: false,
            git_lfs: false,
            git_version: None,
            git_lfs_version: None,
            git_version_supported: false,
            git_minimum_version: GitVersion::MINIMUM.to_string(),
        }
    }
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
    /// Last observed release, shared by every clone so that an availability
    /// check after a Git update applies to the whole process.
    version: Arc<RwLock<Option<GitVersion>>>,
}

impl GitCli {
    /// A CLI whose release is unknown until [`Self::refresh_version`].
    pub fn for_test(git_path: PathBuf) -> Self {
        Self {
            git_path,
            version: Arc::default(),
        }
    }
    /// Detect git binary and LFS availability.
    pub fn detect() -> Result<Self, GitError> {
        Ok(Self::detect_at(resolve_git_binary()?))
    }

    /// [`Self::detect`] of the Git executable at `git_path`.
    pub(crate) fn detect_at(git_path: PathBuf) -> Self {
        tracing::info!("Found git at: {}", git_path.display());

        let version = read_version_blocking(&git_path)
            .as_deref()
            .and_then(GitVersion::parse);
        match version {
            Some(version) if !version.supported() => {
                tracing::warn!("Git {version} is older than {}", GitVersion::MINIMUM)
            }
            Some(version) => tracing::info!("Git version {version}"),
            None => tracing::warn!("Git version not recognised"),
        }

        let lfs = detect_lfs_extension(&git_path);
        if lfs.available {
            tracing::info!("Git LFS is available via git lfs version");
        } else {
            tracing::debug!("Git LFS extension not available");
        }

        Self {
            git_path,
            version: Arc::new(RwLock::new(version)),
        }
    }

    /// Last observed release; `None` when `git version` was not recognised.
    pub fn version(&self) -> Option<GitVersion> {
        *self
            .version
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn observe_version(&self, version: Option<GitVersion>) {
        let mut current = self
            .version
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(change) = version_change(*current, version) {
            tracing::warn!("{change}");
        }
        *current = version;
    }

    /// Read the release again, e.g. after the user updated Git in place.
    pub async fn refresh_version(&self) -> Option<GitVersion> {
        let output = self.version_output().await;
        let version = output.as_deref().and_then(GitVersion::parse);
        self.observe_version(version);
        version
    }

    /// Refuse a Git older than [`GitVersion::MINIMUM`] with the release found.
    /// An unrecognised release is not refused: nothing proves it too old.
    pub fn ensure_supported(&self) -> Result<(), GitError> {
        match self.version() {
            Some(version) if !version.supported() => Err(GitError::GitUnsupported {
                version: version.to_string(),
            }),
            _ => Ok(()),
        }
    }

    /// Whether background integration may merge (`merge-tree --write-tree`);
    /// otherwise it only fast-forwards. An unknown release cannot.
    pub fn background_merge(&self) -> bool {
        self.version().is_some_and(GitVersion::background_merge)
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
    pub fn configure_process_env(&self, cmd: &mut Command) {
        apply_common_git_env(cmd);
    }

    /// Execute a git command in the given space directory.
    pub async fn exec(&self, space_dir: &Path, args: &[&str]) -> Result<GitOutput, GitError> {
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
    ) -> Result<GitOutput, GitError> {
        self.exec_logged(space_dir, args, extra_env, true).await
    }

    /// Hooks and filters may print private config data even with nonsecret arguments.
    pub async fn exec_redacted(
        &self,
        space_dir: &Path,
        args: &[&str],
    ) -> Result<GitOutput, GitError> {
        self.exec_logged(space_dir, args, &[], false).await
    }

    /// [`Self::exec_redacted`] with extra environment variables.
    pub async fn exec_redacted_with_env(
        &self,
        space_dir: &Path,
        args: &[&str],
        extra_env: &[(&str, &str)],
    ) -> Result<GitOutput, GitError> {
        self.exec_logged(space_dir, args, extra_env, false).await
    }

    async fn exec_logged(
        &self,
        space_dir: &Path,
        args: &[&str],
        extra_env: &[(&str, &str)],
        log_output: bool,
    ) -> Result<GitOutput, GitError> {
        if log_output {
            tracing::debug!("git {} (in {})", args.join(" "), space_dir.display());
        }

        let git_args = args_with_quote_path(args);
        let mut cmd = Command::new(&self.git_path);
        hide_tokio_window(&mut cmd);
        apply_common_git_env(&mut cmd);
        cmd.args(&git_args)
            .current_dir(space_dir)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C.UTF-8");
        for (k, v) in extra_env {
            cmd.env(k, v);
        }

        let _slot = process_slot().await;
        let output = cmd
            .output()
            .await
            .map_err(|e| GitError::GitCommandFailed(format!("Failed to spawn git: {e}")))?;

        let result = GitOutput {
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            exit_code: output.status.code().unwrap_or(-1),
        };

        if log_output && result.exit_code != 0 {
            tracing::debug!(
                "git {} exited with code {}: {}",
                args.join(" "),
                result.exit_code,
                result.stderr.trim()
            );
        }

        Ok(result)
    }

    /// Execute a bounded Git command whose arguments may contain credentials.
    /// The command and its arguments are intentionally omitted from tracing.
    pub async fn exec_sensitive_with_stdin(
        &self,
        space_dir: &Path,
        args: &[&str],
        extra_env: &[(&str, &str)],
        stdin_payload: Option<&str>,
        timeout: Duration,
    ) -> Result<GitOutput, GitError> {
        tracing::debug!("running redacted git command (in {})", space_dir.display());

        let git_args = args_with_quote_path(args);
        let mut cmd = Command::new(&self.git_path);
        hide_tokio_window(&mut cmd);
        apply_common_git_env(&mut cmd);
        cmd.args(&git_args)
            .current_dir(space_dir)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C.UTF-8")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for (key, value) in extra_env {
            cmd.env(key, value);
        }

        let _slot = process_slot().await;
        let mut child = cmd
            .spawn()
            .map_err(|error| GitError::GitCommandFailed(format!("Failed to spawn git: {error}")))?;
        if let Some(mut stdin) = child.stdin.take() {
            if let Some(payload) = stdin_payload {
                stdin.write_all(payload.as_bytes()).await.map_err(|error| {
                    GitError::GitCommandFailed(format!("Failed to write git stdin: {error}"))
                })?;
                stdin.flush().await.map_err(|error| {
                    GitError::GitCommandFailed(format!("Failed to flush git stdin: {error}"))
                })?;
            }
        }

        let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
            Ok(result) => result.map_err(|error| {
                GitError::GitCommandFailed(format!("Failed to wait for git: {error}"))
            })?,
            Err(_) => {
                return Ok(GitOutput {
                    stdout: String::new(),
                    stderr: "git command timed out".to_string(),
                    exit_code: -2,
                });
            }
        };

        Ok(GitOutput {
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            exit_code: output.status.code().unwrap_or(-1),
        })
    }

    /// Execute a git command that reads `input` from stdin, such as a path set
    /// through `--pathspec-from-file=-` or `--stdin`. The input is written
    /// while the output is read, so neither side waits on a full pipe; like
    /// [`Self::exec_redacted`], nothing of the call reaches tracing.
    pub async fn exec_with_input(
        &self,
        space_dir: &Path,
        args: &[&str],
        extra_env: &[(&str, &str)],
        input: &[u8],
    ) -> Result<GitOutput, GitError> {
        let git_args = args_with_quote_path(args);
        let mut cmd = Command::new(&self.git_path);
        hide_tokio_window(&mut cmd);
        apply_common_git_env(&mut cmd);
        cmd.args(&git_args)
            .current_dir(space_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for (key, value) in extra_env {
            cmd.env(key, value);
        }
        let _slot = process_slot().await;
        let mut child = cmd
            .spawn()
            .map_err(|error| GitError::GitCommandFailed(format!("Failed to spawn git: {error}")))?;
        let stdin = child.stdin.take();
        let write = async move {
            if let Some(mut stdin) = stdin {
                // A Git that stops reading early exits with the code that says why.
                let _ = stdin.write_all(input).await;
            }
        };
        let (_, output) = tokio::join!(write, child.wait_with_output());
        let output = output.map_err(|error| {
            GitError::GitCommandFailed(format!("Failed to wait for git: {error}"))
        })?;
        Ok(GitOutput {
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            exit_code: output.status.code().unwrap_or(-1),
        })
    }

    /// Upper bound of the command line of a Git call with `args` on every OS:
    /// the program, the arguments Svode adds and `args`.
    pub fn command_line_cost(&self, args: &[&str]) -> usize {
        command_line_cost(&self.git_path, &args_with_quote_path(args))
    }

    /// Argument lists of one Git call each for a command that takes a path
    /// set only as arguments: `args` followed by consecutive `paths`, every
    /// list within [`PATH_SET_COMMAND_LINE_BUDGET`]. A path set of any size
    /// then needs one call per budget, never one command line.
    pub fn path_batches<'a>(&self, args: &[&'a str], paths: &'a [String]) -> Vec<Vec<&'a str>> {
        path_batches_after(self.command_line_cost(args), args, paths)
    }

    /// Execute a git command without a working directory (e.g. clone, or
    /// `--global` config writes).
    pub async fn exec_no_dir(&self, args: &[&str]) -> Result<GitOutput, GitError> {
        tracing::debug!("git {}", args.join(" "));

        let git_args = args_with_quote_path(args);
        let mut cmd = Command::new(&self.git_path);
        hide_tokio_window(&mut cmd);
        apply_common_git_env(&mut cmd);
        let _slot = process_slot().await;
        let output = cmd
            .args(&git_args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C.UTF-8")
            .output()
            .await
            .map_err(|e| GitError::GitCommandFailed(format!("Failed to spawn git: {e}")))?;

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
    ) -> Result<GitOutput, GitError> {
        tracing::debug!("git {}", args.join(" "));

        let git_args = args_with_quote_path(args);
        let mut cmd = Command::new(&self.git_path);
        hide_tokio_window(&mut cmd);
        apply_common_git_env(&mut cmd);
        cmd.args(&git_args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C.UTF-8")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let _slot = process_slot().await;
        let mut child = cmd
            .spawn()
            .map_err(|e| GitError::GitCommandFailed(format!("Failed to spawn git: {e}")))?;

        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(stdin_payload.as_bytes())
                .await
                .map_err(|e| {
                    GitError::GitCommandFailed(format!("Failed to write git stdin: {e}"))
                })?;
            stdin.flush().await.map_err(|e| {
                GitError::GitCommandFailed(format!("Failed to flush git stdin: {e}"))
            })?;
        }

        let output = child
            .wait_with_output()
            .await
            .map_err(|e| GitError::GitCommandFailed(format!("Failed to wait for git: {e}")))?;

        Ok(GitOutput {
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            exit_code: output.status.code().unwrap_or(-1),
        })
    }

    async fn version_output(&self) -> Option<String> {
        let _slot = process_slot().await;
        let output = Command::from(version_command(&self.git_path))
            .output()
            .await
            .ok()?;
        Some(version_stdout(&output))
    }

    /// Check git and git-lfs availability with version info. The release read
    /// here becomes the one every clone of this CLI checks against.
    pub async fn check_availability(&self) -> GitAvailability {
        let output = self.version_output().await;
        let version = output.as_deref().and_then(GitVersion::parse);
        self.observe_version(version);

        let lfs = detect_lfs_extension(&self.git_path);

        GitAvailability {
            git: true,
            git_lfs: lfs.available,
            git_version: output.as_deref().and_then(release_label),
            git_lfs_version: lfs.version,
            git_version_supported: version.is_none_or(GitVersion::supported),
            git_minimum_version: GitVersion::MINIMUM.to_string(),
        }
    }
}

/// The one command of every read of the Git release: at start, by the
/// availability check and by "Check again". Two reads that differ in their
/// arguments could get different answers from one executable, and the last
/// one would decide for the whole process.
pub(crate) const VERSION_ARGS: [&str; 1] = ["--version"];

fn version_command(git_path: &Path) -> StdCommand {
    let mut cmd = StdCommand::new(git_path);
    hide_window(&mut cmd);
    apply_common_std_git_env(&mut cmd);
    cmd.args(VERSION_ARGS);
    cmd
}

fn version_stdout(output: &std::process::Output) -> String {
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn read_version_blocking(git_path: &Path) -> Option<String> {
    let output = version_command(git_path).output().ok()?;
    Some(version_stdout(&output))
}

/// The log line of a release that differs from the one read before.
fn version_change(previous: Option<GitVersion>, observed: Option<GitVersion>) -> Option<String> {
    let label = |version: Option<GitVersion>| {
        version.map_or_else(|| "unrecognised".to_string(), |version| version.to_string())
    };
    (previous != observed).then(|| {
        format!(
            "Git version changed from {} to {}",
            label(previous),
            label(observed)
        )
    })
}

/// Every Git process Svode starts runs without optional locks: a read never
/// writes the index, so it neither blocks nor fails a concurrent Git process
/// of the user, an agent or a terminal. A command whose operation needs a
/// lock still takes it.
const OPTIONAL_LOCKS: (&str, &str) = ("GIT_OPTIONAL_LOCKS", "0");

fn apply_common_git_env(cmd: &mut Command) {
    // Do not inherit editor askpass helpers into backend IPC commands. Svode
    // needs git to fail fast with AuthRequired instead of waiting on another UI.
    cmd.env(OPTIONAL_LOCKS.0, OPTIONAL_LOCKS.1)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .env("SSH_ASKPASS_REQUIRE", "never")
        .env("GCM_INTERACTIVE", "never")
        .env("LC_ALL", "C.UTF-8");
    if let Some(path) = git_subprocess_path_env() {
        cmd.env("PATH", path);
    }
}

/// The environment of [`GitCli`] for a blocking Git process.
pub(crate) fn configure_std_process_env(cmd: &mut StdCommand) {
    apply_common_std_git_env(cmd);
}

fn apply_common_std_git_env(cmd: &mut StdCommand) {
    // Keep sync and blocking detection paths consistent with async git calls.
    cmd.env(OPTIONAL_LOCKS.0, OPTIONAL_LOCKS.1)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .env("SSH_ASKPASS_REQUIRE", "never")
        .env("GCM_INTERACTIVE", "never")
        .env("LC_ALL", "C.UTF-8");
    if let Some(path) = git_subprocess_path_env() {
        cmd.env("PATH", path);
    }
}

/// Longest command line a Git call with a path set may take: the Windows
/// limit of 32 767 UTF-16 units, the smallest of the supported OSes, less a
/// margin for the Git for Windows launcher, which starts the real binary under
/// a longer program path.
pub const PATH_SET_COMMAND_LINE_BUDGET: usize = 30_000;

/// Upper bound of what `arg` adds to a command line: its UTF-8 bytes bound the
/// UTF-16 units Windows counts, plus quotes, escapes of quotes and
/// backslashes, and the separator.
fn command_line_arg_cost(arg: &str) -> usize {
    arg.len()
        + arg
            .bytes()
            .filter(|byte| matches!(byte, b'"' | b'\\'))
            .count()
        + 3
}

/// Upper bound of the command line of `program` with exactly `args` on every OS.
pub(crate) fn command_line_cost(program: &Path, args: &[&str]) -> usize {
    command_line_arg_cost(&program.to_string_lossy())
        + args
            .iter()
            .map(|arg| command_line_arg_cost(arg))
            .sum::<usize>()
}

/// [`GitCli::path_batches`] of a call whose command line costs `base` without
/// the paths.
pub(crate) fn path_batches_after<'a>(
    base: usize,
    args: &[&'a str],
    paths: &'a [String],
) -> Vec<Vec<&'a str>> {
    let mut batches = Vec::new();
    let mut batch = args.to_vec();
    let mut cost = base;
    for path in paths {
        let next = command_line_arg_cost(path);
        if batch.len() > args.len() && cost + next > PATH_SET_COMMAND_LINE_BUDGET {
            batches.push(std::mem::replace(&mut batch, args.to_vec()));
            cost = base;
        }
        batch.push(path);
        cost += next;
    }
    if batch.len() > args.len() {
        batches.push(batch);
    }
    batches
}

/// `paths` as pathspecs Git matches as written, without pathspec magic.
pub fn literal_pathspecs(paths: &[String]) -> Vec<String> {
    paths
        .iter()
        .map(|path| format!(":(literal){path}"))
        .collect()
}

/// Literal pathspecs of `paths` for `--pathspec-from-file=- --pathspec-file-nul`.
pub fn literal_pathspec_input(paths: &[String]) -> Vec<u8> {
    let mut input = Vec::new();
    for path in paths {
        input.extend_from_slice(b":(literal)");
        input.extend_from_slice(path.as_bytes());
        input.push(0);
    }
    input
}

/// NUL-terminated `paths` for `--stdin -z` of commands that take plain paths.
pub fn nul_paths_input<'a>(paths: impl IntoIterator<Item = &'a String>) -> Vec<u8> {
    let mut input = Vec::new();
    for path in paths {
        input.extend_from_slice(path.as_bytes());
        input.push(0);
    }
    input
}

/// `paths` one per line for `--stdin-paths`. A path a line cannot hold as is
/// (a line break, a trailing carriage return, a leading quote) is quoted in
/// the C style Git unquotes there.
pub fn stdin_paths_input<'a>(paths: impl IntoIterator<Item = &'a str>) -> Vec<u8> {
    let mut input = Vec::new();
    for path in paths {
        if path.starts_with('"') || path.bytes().any(|byte| byte < 0x20 || byte == 0x7f) {
            input.push(b'"');
            for byte in path.bytes() {
                match byte {
                    b'"' | b'\\' => input.extend_from_slice(&[b'\\', byte]),
                    0..0x20 | 0x7f => input.extend_from_slice(format!("\\{byte:03o}").as_bytes()),
                    _ => input.push(byte),
                }
            }
            input.push(b'"');
        } else {
            input.extend_from_slice(path.as_bytes());
        }
        input.push(b'\n');
    }
    input
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

fn resolve_git_binary() -> Result<PathBuf, GitError> {
    crate::page::dates::detect_git_binary().ok_or(GitError::GitNotFound)
}

#[derive(Debug, Clone, Default)]
struct LfsDetection {
    available: bool,
    version: Option<String>,
}

fn detect_lfs_extension(git_path: &Path) -> LfsDetection {
    let mut cmd = StdCommand::new(git_path);
    hide_window(&mut cmd);
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
    use super::{
        GIT_PROCESS_LIMIT, GitCli, GitVersion, PATH_SET_COMMAND_LINE_BUDGET, args_with_quote_path,
        command_line_arg_cost, parse_lfs_version, version_change,
    };

    #[test]
    fn a_release_that_differs_from_the_last_read_is_logged_with_both() {
        let old = GitVersion::new(2, 37, 0);
        let new = GitVersion::new(2, 55, 0);
        assert_eq!(version_change(Some(old), Some(old)), None);
        assert_eq!(version_change(None, None), None);
        assert_eq!(
            version_change(Some(old), Some(new)).as_deref(),
            Some("Git version changed from 2.37.0 to 2.55.0")
        );
        assert_eq!(
            version_change(Some(new), None).as_deref(),
            Some("Git version changed from 2.55.0 to unrecognised")
        );
    }

    /// UTF-16 units of the command line Windows builds for `args`, with the
    /// quoting of the Rust standard library: arguments with spaces, tabs or
    /// quotes in quotes, backslashes before a quote doubled.
    fn windows_command_line(args: &[&str]) -> usize {
        args.iter()
            .map(|arg| {
                let quoted = arg.is_empty() || arg.contains([' ', '\t', '"']);
                let mut units = arg.encode_utf16().count() + if quoted { 2 } else { 0 };
                let mut backslashes = 0;
                for c in arg.chars() {
                    match c {
                        '\\' => backslashes += 1,
                        '"' => {
                            units += backslashes + 1;
                            backslashes = 0;
                        }
                        _ => backslashes = 0,
                    }
                }
                if quoted {
                    units += backslashes;
                }
                units + 1
            })
            .sum()
    }

    #[test]
    fn path_batches_keep_every_call_of_any_set_within_the_budget() {
        let cli = GitCli::for_test(r"C:\Program Files\Git\cmd\git.exe".into());
        let paths = (0..20_000)
            .map(|index| match index % 4 {
                0 => format!(":(literal)Папка/{index} {}.md", "ж".repeat(120)),
                1 => format!(":(literal)emoji/{index}-{}.md", "😀".repeat(60)),
                2 => format!(":(literal)quotes/{index}\\\"{}\".md", "\\".repeat(40)),
                _ => format!(":(literal)ascii/{index}-{}.md", "x".repeat(200)),
            })
            .collect::<Vec<_>>();
        let args = ["diff", "--cached", "--name-status", "-z", "--"];
        let batches = cli.path_batches(&args, &paths);
        assert!(batches.len() > 1);
        let mut joined = Vec::new();
        for batch in &batches {
            assert_eq!(&batch[..args.len()], args);
            let mut line = vec![r"C:\Program Files\Git\cmd\git.exe"];
            line.extend(args_with_quote_path(batch));
            assert!(windows_command_line(&line) <= PATH_SET_COMMAND_LINE_BUDGET);
            assert!(cli.command_line_cost(batch) <= PATH_SET_COMMAND_LINE_BUDGET);
            joined.extend(batch[args.len()..].iter().copied());
        }
        assert_eq!(joined, paths.iter().map(String::as_str).collect::<Vec<_>>());
        // Batches are full: one call per budget, not per path.
        let total = paths
            .iter()
            .map(|path| command_line_arg_cost(path))
            .sum::<usize>();
        assert!(
            batches.len()
                <= total / (PATH_SET_COMMAND_LINE_BUDGET - cli.command_line_cost(&args) - 1_000)
                    + 1
        );
    }

    #[test]
    fn a_set_within_the_budget_is_one_call_and_an_empty_set_none() {
        let cli = GitCli::for_test("/usr/bin/git".into());
        let paths = vec![":(literal)a.md".to_string(), ":(literal)b.md".to_string()];
        assert_eq!(
            cli.path_batches(&["ls-tree", "-r", "-z", "HEAD", "--"], &paths),
            vec![vec![
                "ls-tree",
                "-r",
                "-z",
                "HEAD",
                "--",
                ":(literal)a.md",
                ":(literal)b.md"
            ]]
        );
        assert!(cli.path_batches(&["ls-tree", "--"], &[]).is_empty());
    }

    /// Names a line holds only quoted reach `--stdin-paths` as the same files.
    #[cfg(unix)]
    #[tokio::test]
    async fn stdin_paths_name_the_files_hash_object_names_as_arguments() {
        let dir = tempfile::TempDir::new().unwrap();
        let cli = GitCli::detect().unwrap();
        let names = [
            "plain.md",
            "\"quoted\".md",
            "line\nbreak.md",
            "carriage\r",
            "tab\there.md",
            "back\\slash \"in\" name.md",
            "Папка.md",
        ];
        let mut expected = String::new();
        for (index, name) in names.iter().enumerate() {
            std::fs::write(dir.path().join(name), format!("{index}\n")).unwrap();
            let out = cli
                .exec(dir.path(), &["hash-object", "--", name])
                .await
                .unwrap();
            assert_eq!(out.exit_code, 0, "{name:?}: {}", out.stderr);
            expected.push_str(&out.stdout);
        }

        let out = cli
            .exec_with_input(
                dir.path(),
                &["hash-object", "--stdin-paths"],
                &[],
                &super::stdin_paths_input(names),
            )
            .await
            .unwrap();

        assert_eq!(out.exit_code, 0, "{}", out.stderr);
        assert_eq!(out.stdout, expected);
    }

    /// Every way [`GitCli`] starts Git runs it without optional locks.
    #[cfg(unix)]
    #[tokio::test]
    async fn every_git_process_runs_without_optional_locks() {
        let dir = tempfile::TempDir::new().unwrap();
        let log = dir.path().join("log");
        let recorder = dir.path().join("git");
        svode_testkit::write_executable(
            &recorder,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"${{GIT_OPTIONAL_LOCKS-unset}}\" >> '{}'\nprintf 'a\\0'\n",
                log.display()
            ),
        )
        .unwrap();
        let cli = GitCli::for_test(recorder);
        let repo = dir.path();
        let timeout = std::time::Duration::from_secs(5);
        cli.exec(repo, &["status"]).await.unwrap();
        cli.exec_with_env(repo, &["status"], &[]).await.unwrap();
        cli.exec_redacted(repo, &["status"]).await.unwrap();
        cli.exec_redacted_with_env(repo, &["status"], &[])
            .await
            .unwrap();
        cli.exec_with_input(repo, &["status"], &[], b"")
            .await
            .unwrap();
        cli.exec_sensitive_with_stdin(repo, &["status"], &[], None, timeout)
            .await
            .unwrap();
        cli.exec_no_dir(&["status"]).await.unwrap();
        cli.exec_no_dir_with_stdin(&["status"], "").await.unwrap();
        super::read_records(&cli, repo, &["status"], Some(timeout), |_| Ok(()))
            .await
            .unwrap();
        super::read_bounded(&cli, repo, &["status"], 16)
            .await
            .unwrap();
        super::write_within(&cli, repo, &["status"], timeout)
            .await
            .unwrap();
        let mut blocking = std::process::Command::new(cli.git_path());
        super::configure_std_process_env(&mut blocking);
        blocking.current_dir(repo).output().unwrap();
        let mut direct = tokio::process::Command::new(cli.git_path());
        cli.configure_process_env(&mut direct);
        direct.current_dir(repo).output().await.unwrap();

        let recorded = std::fs::read_to_string(&log).unwrap();
        assert_eq!(recorded.lines().collect::<Vec<_>>(), vec!["0"; 13]);
    }

    /// Inventory of Git processes: production code starts Git only through
    /// [`GitCli`] and the few owners below, each with its environment, so no
    /// read takes optional locks.
    #[test]
    fn git_processes_start_only_through_the_cli_environment() {
        let app = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        // Owner → how it applies the environment of every Git process.
        let owners = [
            ("crates/svode-core/src/git/cli.rs", "apply_common_git_env"),
            (
                "crates/svode-core/src/git/publication.rs",
                "configure_std_process_env",
            ),
            ("crates/svode-core/src/page/dates.rs", "GIT_OPTIONAL_LOCKS"),
            ("crates/svode-lfs/src/download.rs", "GIT_OPTIONAL_LOCKS"),
            (
                "apps/desktop/src-tauri/src/git/clone.rs",
                "configure_process_env",
            ),
        ];
        let mut found = Vec::new();
        let mut stack = vec![app.join("crates"), app.join("apps/desktop/src-tauri/src")];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).unwrap().flatten() {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().into_owned();
                if path.is_dir() {
                    if !matches!(name.as_str(), "target" | "tests" | "node_modules" | "gen") {
                        stack.push(path);
                    }
                    continue;
                }
                if !name.ends_with(".rs") || name.ends_with("tests.rs") {
                    continue;
                }
                // A Windows checkout may have CRLF line endings.
                let source = std::fs::read_to_string(&path)
                    .unwrap()
                    .replace("\r\n", "\n");
                // Inline test modules sit after the production code.
                let production = source.split("#[cfg(test)]\nmod tests {").next().unwrap();
                let starts_git = production.lines().any(|line| {
                    line.split_once("Command::new(")
                        .is_some_and(|(before, program)| {
                            // `ToolCommand::new(…)` and the like start no process.
                            !before.ends_with(|c: char| c.is_alphanumeric() || c == '_')
                                && (program.to_ascii_lowercase().contains("git")
                                    || (program.starts_with("binary")
                                        && production.contains("detect_git_binary")))
                        })
                });
                if starts_git {
                    let relative = path
                        .strip_prefix(&app)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/");
                    found.push((relative, production.to_string()));
                }
            }
        }
        found.sort();
        let mut names = found
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>();
        let mut expected = owners.iter().map(|(name, _)| *name).collect::<Vec<_>>();
        names.sort_unstable();
        expected.sort_unstable();
        assert_eq!(
            names, expected,
            "a new Git process owner must apply the GitCli environment"
        );
        for (name, marker) in owners {
            let (_, source) = found.iter().find(|(found, _)| found == name).unwrap();
            assert!(source.contains(marker), "{name} does not apply {marker}");
        }
        // Asynchronous Git processes of the app wait for a place. Outside the
        // bound: the blocking removal of publication evidence, the LFS
        // transfer agent (a process of its own) and the clone or Submodule
        // Space add of Desktop, one long process per person's gesture.
        for name in [
            "crates/svode-core/src/git/cli.rs",
            "crates/svode-core/src/page/dates.rs",
        ] {
            let (_, source) = found.iter().find(|(found, _)| found == name).unwrap();
            assert!(
                source.contains("process_slot().await"),
                "{name} starts Git without a place"
            );
        }
    }

    /// N concurrent Git processes started every asynchronous way of
    /// [`GitCli`] never run more than [`GIT_PROCESS_LIMIT`] at once.
    #[cfg(unix)]
    #[tokio::test]
    async fn at_most_the_limit_of_git_processes_run_at_once() {
        let dir = tempfile::TempDir::new().unwrap();
        let running = dir.path().join("running");
        std::fs::create_dir(&running).unwrap();
        let counts = dir.path().join("counts");
        let recorder = dir.path().join("git");
        svode_testkit::write_executable(
            &recorder,
            format!(
                "#!/bin/sh\ntouch '{running}/'$$\nls '{running}' | wc -l >> '{counts}'\nsleep 0.05\nrm '{running}/'$$\nprintf 'a\\0'\n",
                running = running.display(),
                counts = counts.display(),
            ),
        )
        .unwrap();
        let cli = GitCli::for_test(recorder);
        let repo = dir.path().to_path_buf();
        let timeout = std::time::Duration::from_secs(30);
        let mut tasks = tokio::task::JoinSet::new();
        for _ in 0..4 {
            let (cli, repo) = (cli.clone(), repo.clone());
            tasks.spawn(async move {
                let repo = repo.as_path();
                let results = tokio::join!(
                    cli.exec(repo, &["status"]),
                    cli.exec_redacted(repo, &["status"]),
                    cli.exec_with_input(repo, &["status"], &[], b""),
                    cli.exec_sensitive_with_stdin(repo, &["status"], &[], None, timeout),
                    cli.exec_no_dir(&["status"]),
                    cli.exec_no_dir_with_stdin(&["status"], ""),
                    super::read_records(&cli, repo, &["status"], Some(timeout), |_| Ok(())),
                    super::read_bounded(&cli, repo, &["status"], 16),
                    super::read_with_input(&cli, repo, &["status"], b"", 16, timeout),
                    super::write_within(&cli, repo, &["status"], timeout),
                    cli.refresh_version(),
                );
                for exit_code in [
                    results.0.unwrap().exit_code,
                    results.1.unwrap().exit_code,
                    results.2.unwrap().exit_code,
                    results.3.unwrap().exit_code,
                    results.4.unwrap().exit_code,
                    results.5.unwrap().exit_code,
                ] {
                    assert_eq!(exit_code, 0);
                }
                assert_eq!(results.6.unwrap(), Some(true));
                assert!(results.7.unwrap().0);
                assert!(results.8.unwrap().is_some());
                assert_eq!(results.9.unwrap(), Some(true));
            });
        }
        tasks.join_all().await;
        let counts = std::fs::read_to_string(&counts).unwrap();
        let counts = counts
            .lines()
            .map(|line| line.trim().parse::<usize>().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(counts.len(), 44);
        let most = counts.into_iter().max().unwrap();
        assert!(
            most <= GIT_PROCESS_LIMIT,
            "{most} Git processes ran at once"
        );
    }

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

pub async fn read_bounded(
    cli: &GitCli,
    repo: &Path,
    args: &[&str],
    max_bytes: usize,
) -> Result<(bool, Vec<u8>), GitError> {
    let mut command = Command::new(cli.git_path());
    hide_tokio_window(&mut command);
    cli.configure_process_env(&mut command);
    command
        .args(args)
        .current_dir(repo)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let _slot = process_slot().await;
    let mut child = command.spawn()?;
    let result = tokio::time::timeout(Duration::from_secs(3), async {
        let mut bytes = Vec::new();
        child
            .stdout
            .take()
            .unwrap()
            .take((max_bytes + 1) as u64)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() > max_bytes {
            child.kill().await?;
            return Ok((false, bytes));
        }
        Ok::<_, std::io::Error>((child.wait().await?.success(), bytes))
    })
    .await
    .map_err(|_| GitError::GitCommandFailed("Diff read timed out".into()))??;
    Ok(result)
}

/// The UTF-8 blobs at `paths` in `revision` (`""` for the index), by path
/// relative to the repository; a path missing there, binary or over the
/// limits is left out.
pub async fn blobs_at(
    cli: &GitCli,
    repo: &Path,
    revision: &str,
    paths: &[String],
    max_bytes: usize,
    timeout: Duration,
) -> std::collections::HashMap<String, String> {
    let mut blobs = std::collections::HashMap::new();
    if paths.is_empty() {
        return blobs;
    }
    let input = paths
        .iter()
        .map(|path| format!("{revision}:{path}\n"))
        .collect::<String>();
    let Ok(Some(output)) = read_with_input(
        cli,
        repo,
        &["cat-file", "--batch"],
        input.as_bytes(),
        max_bytes,
        timeout,
    )
    .await
    else {
        return blobs;
    };
    let mut rest = output.as_slice();
    for path in paths {
        let Some(end) = rest.iter().position(|byte| *byte == b'\n') else {
            break;
        };
        let header = String::from_utf8_lossy(&rest[..end]).into_owned();
        rest = &rest[end + 1..];
        if header.ends_with(" missing") || header.ends_with(" ambiguous") {
            continue;
        }
        let mut fields = header.split(' ');
        let (Some(_), Some(kind), Some(size)) = (fields.next(), fields.next(), fields.next())
        else {
            break;
        };
        let Ok(size) = size.parse::<usize>() else {
            break;
        };
        if rest.len() < size + 1 {
            break;
        }
        if kind == "blob"
            && let Ok(text) = std::str::from_utf8(&rest[..size])
        {
            blobs.insert(path.clone(), text.to_string());
        }
        rest = &rest[size + 1..];
    }
    blobs
}

/// Run a Git read that takes `input` on stdin and
/// return its raw output, or `None` when Git failed, the output exceeded
/// `max_bytes` or the read did not finish within `timeout`.
pub async fn read_with_input(
    cli: &GitCli,
    repo: &Path,
    args: &[&str],
    input: &[u8],
    max_bytes: usize,
    timeout: Duration,
) -> Result<Option<Vec<u8>>, GitError> {
    let mut command = Command::new(cli.git_path());
    hide_tokio_window(&mut command);
    cli.configure_process_env(&mut command);
    command
        .args(args)
        .current_dir(repo)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let _slot = process_slot().await;
    let mut child = command.spawn()?;
    let stdin = child.stdin.take();
    let mut stdout = child.stdout.take().unwrap();
    let read = async {
        let write = async move {
            if let Some(mut stdin) = stdin {
                // A Git that stops reading early exits with the code that says why.
                let _ = stdin.write_all(input).await;
            }
        };
        let collect = async {
            let mut bytes = Vec::new();
            (&mut stdout)
                .take((max_bytes + 1) as u64)
                .read_to_end(&mut bytes)
                .await
                .map(|_| bytes)
        };
        let (_, bytes) = tokio::join!(write, collect);
        let bytes = bytes?;
        if bytes.len() > max_bytes {
            child.kill().await?;
            return Ok::<_, std::io::Error>(None);
        }
        Ok(child.wait().await?.success().then_some(bytes))
    };
    match tokio::time::timeout(timeout, read).await {
        Ok(result) => Ok(result?),
        Err(_) => Ok(None),
    }
}

/// Run a Git read and hand each NUL-terminated record of
/// its output to `record` as it arrives, so no output size is ever buffered.
/// Returns whether Git succeeded, or `None` when `timeout` passed first; the
/// process is killed then and on a `record` error.
pub async fn read_records(
    cli: &GitCli,
    repo: &Path,
    args: &[&str],
    timeout: Option<Duration>,
    mut record: impl FnMut(&[u8]) -> Result<(), GitError>,
) -> Result<Option<bool>, GitError> {
    let mut command = Command::new(cli.git_path());
    hide_tokio_window(&mut command);
    cli.configure_process_env(&mut command);
    command
        .args(args)
        .current_dir(repo)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let _slot = process_slot().await;
    let mut child = command.spawn()?;
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let read = async {
        let mut buffer = Vec::new();
        loop {
            buffer.clear();
            if stdout.read_until(0, &mut buffer).await? == 0 {
                break;
            }
            if buffer.last() == Some(&0) {
                buffer.pop();
            }
            record(&buffer)?;
        }
        Ok::<_, GitError>(child.wait().await?.success())
    };
    match timeout {
        Some(timeout) => match tokio::time::timeout(timeout, read).await {
            Ok(success) => success.map(Some),
            Err(_) => Ok(None),
        },
        None => read.await.map(Some),
    }
}

/// Run a Git write and wait for it up to `timeout`. A command still running
/// then is left to finish on its own rather than killed while it may hold a
/// Git lock. Returns whether Git succeeded, or `None` when the wait ended first.
pub async fn write_within(
    cli: &GitCli,
    repo: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<Option<bool>, GitError> {
    let mut command = Command::new(cli.git_path());
    hide_tokio_window(&mut command);
    cli.configure_process_env(&mut command);
    command
        .args(args)
        .current_dir(repo)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let slot = process_slot().await;
    let mut child = command.spawn()?;
    match tokio::time::timeout(timeout, child.wait()).await {
        Ok(status) => Ok(Some(status?.success())),
        Err(_) => {
            // The command left running keeps its place until it exits.
            tokio::spawn(async move {
                let _ = child.wait().await;
                drop(slot);
            });
            Ok(None)
        }
    }
}

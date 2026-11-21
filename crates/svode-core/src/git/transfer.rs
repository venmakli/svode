//! The one way Svode runs a Git command that moves file contents over the
//! network (DF-369 R1, R5): the command runs as a process tree (DF-370), it
//! has no overall time limit and stops only after [`IDLE_LIMIT`] without
//! progress, and its progress goes to the [`TransferObserver`] of the
//! [`GitCli`] that runs it.
//!
//! Progress is a new line of the git-lfs report (`GIT_LFS_PROGRESS`, a file
//! of its own per run) with another file or byte count, or new progress
//! output of Git itself on stderr, such as `Writing objects` of a push with
//! `--progress`. Only the git-lfs report reaches the observer; Git's own
//! progress only keeps the transfer alive.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::time::Instant;

use super::GitError;
use super::cli::{GitCli, GitOutput};
use crate::process::ProcessTree;

/// How long a transfer may go without progress before Svode stops it.
pub const IDLE_LIMIT: Duration = Duration::from_secs(120);

/// How often the git-lfs report is read: the observer hears of a transfer at
/// most this often.
const REPORT_INTERVAL: Duration = Duration::from_millis(250);

/// How long the output a stopped root left in its pipes is still read.
const DRAIN_LIMIT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferDirection {
    Upload,
    Download,
}

/// Where a transfer is, from the last line of its git-lfs report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub direction: TransferDirection,
    /// The number of the current file, from 1.
    pub file: u64,
    /// The files of the transfer git-lfs knows of so far.
    pub files: u64,
    /// The current file, relative to the repository.
    pub path: String,
    /// Bytes of the current file transferred so far.
    pub bytes: u64,
    /// The size of the current file.
    pub size: u64,
}

/// A transfer Svode stopped after [`IDLE_LIMIT`] without progress, with the
/// last file its report named, if any.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferStall {
    pub direction: TransferDirection,
    /// The last file the report named, relative to the repository.
    pub path: Option<String>,
    pub size: Option<u64>,
    /// The time without progress after which the transfer was stopped.
    #[serde(skip)]
    pub idle_limit: Duration,
}

/// Where the host shows the progress of transfers.
pub trait TransferObserver: Send + Sync {
    /// `progress` of the transfer running for `repository`, at most every
    /// [`REPORT_INTERVAL`]; `None` once a transfer that reported has ended.
    fn transfer_progress(&self, _repository: &Path, _progress: Option<&TransferProgress>) {}
}

pub enum TransferOutcome {
    /// The command ended by itself; its stderr is without Git's progress lines.
    Finished(GitOutput),
    Stalled(TransferStall),
}

/// One transfer of `repository` in `direction`.
pub struct Transfer<'a> {
    repository: &'a Path,
    direction: TransferDirection,
    idle_limit: Duration,
}

impl<'a> Transfer<'a> {
    pub fn new(repository: &'a Path, direction: TransferDirection) -> Self {
        Self {
            repository,
            direction,
            idle_limit: IDLE_LIMIT,
        }
    }

    /// The same transfer stopped after `idle_limit` without progress.
    pub fn idle_limit(self, idle_limit: Duration) -> Self {
        Self { idle_limit, ..self }
    }

    /// Run `git args` in the repository as this transfer. Like
    /// [`GitCli::exec_sensitive_with_stdin`], nothing of the command reaches
    /// tracing, and the whole process tree ends with it.
    pub async fn run(
        &self,
        cli: &GitCli,
        args: &[&str],
        env: &[(&str, &str)],
    ) -> Result<TransferOutcome, GitError> {
        let failed = |action: &str, error: std::io::Error| {
            GitError::GitCommandFailed(format!("Failed to {action} git: {error}"))
        };
        let report_path = tempfile::NamedTempFile::new()?.into_temp_path();
        let mut command = cli.transfer_command(self.repository, args, env).await;
        command.env("GIT_LFS_PROGRESS", &report_path);
        let _slot = super::cli::process_slot().await;
        let mut tree = ProcessTree::spawn_without_terminal(&mut command)
            .map_err(|error| failed("spawn", error))?;
        let child = tree.child();
        let (mut stdout, mut stderr) = (child.stdout.take(), child.stderr.take());
        let root_exit = tree.root_exit();
        tokio::pin!(root_exit);

        let mut report = Report::new(self.direction);
        let mut out = Vec::new();
        let mut git_progress = GitProgress::default();
        let mut last_progress = Instant::now();
        let mut ticks = tokio::time::interval(REPORT_INTERVAL);
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let (mut out_buffer, mut err_buffer) = ([0u8; 8192], [0u8; 8192]);
        let stalled = loop {
            tokio::select! {
                read = read_some(stdout.as_mut(), &mut out_buffer) => match read {
                    Some(bytes) => out.extend_from_slice(bytes),
                    None => stdout = None,
                },
                read = read_some(stderr.as_mut(), &mut err_buffer) => match read {
                    Some(bytes) => {
                        if git_progress.push(bytes) {
                            last_progress = Instant::now();
                        }
                    }
                    None => stderr = None,
                },
                () = &mut root_exit => break false,
                _ = ticks.tick() => {
                    if let Some(progress) = report.read(&report_path).await {
                        last_progress = Instant::now();
                        self.observe(cli, Some(&progress));
                    }
                    if last_progress.elapsed() >= self.idle_limit {
                        break true;
                    }
                }
            }
        };
        if stalled {
            tree.kill().await;
            report.read(&report_path).await;
            if report.observed {
                self.observe(cli, None);
            }
            return Ok(TransferOutcome::Stalled(TransferStall {
                direction: self.direction,
                path: report.last.as_ref().map(|last| last.path.clone()),
                size: report.last.as_ref().map(|last| last.size),
                idle_limit: self.idle_limit,
            }));
        }
        let status = tree
            .wait()
            .await
            .map_err(|error| failed("wait for", error))?;
        // What the root and the rest of the tree wrote before they ended.
        let _ = tokio::time::timeout(DRAIN_LIMIT, async {
            if let Some(pipe) = stdout.as_mut() {
                let _ = pipe.read_to_end(&mut out).await;
            }
            if let Some(pipe) = stderr.as_mut() {
                let mut rest = Vec::new();
                let _ = pipe.read_to_end(&mut rest).await;
                git_progress.push(&rest);
            }
        })
        .await;
        if report.observed {
            self.observe(cli, None);
        }
        Ok(TransferOutcome::Finished(GitOutput {
            stdout: String::from_utf8_lossy(&out).into_owned(),
            stderr: without_progress_lines(&String::from_utf8_lossy(&git_progress.stderr)),
            exit_code: status.code().unwrap_or(-1),
        }))
    }

    fn observe(&self, cli: &GitCli, progress: Option<&TransferProgress>) {
        if let Some(observer) = cli.transfer_observer() {
            observer.transfer_progress(self.repository, progress);
        }
    }
}

/// The next bytes of `pipe`, or `None` once it closed; a closed pipe never
/// resolves, so the caller stops polling it.
async fn read_some<'b, R: AsyncRead + Unpin>(
    pipe: Option<&mut R>,
    buffer: &'b mut [u8],
) -> Option<&'b [u8]> {
    let Some(pipe) = pipe else {
        return std::future::pending().await;
    };
    match pipe.read(buffer).await {
        Ok(0) | Err(_) => None,
        Ok(read) => Some(&buffer[..read]),
    }
}

/// The git-lfs report of one transfer, read as it grows.
struct Report {
    direction: TransferDirection,
    offset: u64,
    partial: Vec<u8>,
    last: Option<TransferProgress>,
    /// Whether the observer heard of this transfer.
    observed: bool,
}

impl Report {
    fn new(direction: TransferDirection) -> Self {
        Self {
            direction,
            offset: 0,
            partial: Vec::new(),
            last: None,
            observed: false,
        }
    }

    /// The new state of the transfer when the report gained a line with
    /// another file or byte count since the last read.
    async fn read(&mut self, path: &Path) -> Option<TransferProgress> {
        use tokio::io::AsyncSeekExt;
        let mut file = tokio::fs::File::open(path).await.ok()?;
        file.seek(std::io::SeekFrom::Start(self.offset))
            .await
            .ok()?;
        let mut grown = Vec::new();
        file.read_to_end(&mut grown).await.ok()?;
        self.offset += grown.len() as u64;
        self.partial.extend_from_slice(&grown);
        let complete = self.partial.iter().rposition(|byte| *byte == b'\n')?;
        let lines = self.partial.drain(..=complete).collect::<Vec<_>>();
        let latest = String::from_utf8_lossy(&lines)
            .lines()
            .rev()
            .find_map(|line| parse_report_line(line, self.direction))?;
        if self.last.as_ref() == Some(&latest) {
            return None;
        }
        self.last = Some(latest.clone());
        self.observed = true;
        Some(latest)
    }
}

/// One line of the git-lfs report, `<direction> <file>/<files>
/// <bytes>/<size> <path>` (git-lfs-config(5)). Lines of a local checkout
/// count as progress of the transfer they belong to.
fn parse_report_line(line: &str, direction: TransferDirection) -> Option<TransferProgress> {
    let mut fields = line.splitn(4, ' ');
    let kind = fields.next()?;
    if !matches!(kind, "upload" | "download" | "checkout") {
        return None;
    }
    let pair = |field: Option<&str>| {
        let (current, total) = field?.split_once('/')?;
        Some((current.parse::<u64>().ok()?, total.parse::<u64>().ok()?))
    };
    let (file, files) = pair(fields.next())?;
    let (bytes, size) = pair(fields.next())?;
    let path = fields.next()?.trim_end_matches('\r');
    if path.is_empty() {
        return None;
    }
    Some(TransferProgress {
        direction,
        file,
        files,
        path: path.to_owned(),
        bytes,
        size,
    })
}

/// Git's stderr of a transfer, and whether its newest bytes show progress:
/// a progress line Git redraws with `\r` counts only when it changes.
#[derive(Default)]
struct GitProgress {
    stderr: Vec<u8>,
    /// The line being written, since the last `\r` or `\n`.
    current: Vec<u8>,
    /// The last line Git finished or redrew.
    shown: Vec<u8>,
}

impl GitProgress {
    fn push(&mut self, bytes: &[u8]) -> bool {
        self.stderr.extend_from_slice(bytes);
        let mut progressed = false;
        for byte in bytes {
            if matches!(byte, b'\r' | b'\n') {
                if !self.current.is_empty() && self.current != self.shown {
                    progressed = true;
                    self.shown = std::mem::take(&mut self.current);
                }
                self.current.clear();
            } else {
                self.current.push(*byte);
            }
        }
        progressed
    }
}

/// `stderr` as without `--progress`: the lines Git's progress meters draw
/// are left out, so the recognition of refusals and errors reads what it
/// read before (DF-369 R6).
pub(crate) fn without_progress_lines(stderr: &str) -> String {
    const METERS: [&str; 9] = [
        "Enumerating objects:",
        "Counting objects:",
        "Delta compression using up to ",
        "Compressing objects:",
        "Writing objects:",
        "Resolving deltas:",
        "Receiving objects:",
        "Unpacking objects:",
        "Checking connectivity",
    ];
    let mut kept = String::with_capacity(stderr.len());
    for line in stderr.split_inclusive('\n') {
        let shown = line.rsplit('\r').find(|part| !part.trim().is_empty());
        let Some(shown) = shown else {
            if !line.contains('\r') {
                kept.push_str(line);
            }
            continue;
        };
        let text = shown.trim_end_matches('\n');
        let meter = text.strip_prefix("remote: ").unwrap_or(text);
        let total = meter
            .strip_prefix("Total ")
            .is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit()));
        if total || METERS.iter().any(|prefix| meter.starts_with(prefix)) {
            continue;
        }
        kept.push_str(text);
        if line.ends_with('\n') {
            kept.push('\n');
        }
    }
    kept
}

#[cfg(test)]
#[path = "transfer_tests.rs"]
mod tests;

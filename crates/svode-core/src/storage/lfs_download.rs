//! Download of the Git LFS content of the current version of a repository
//! (DF-368): which files of the working copy are still pointers, the
//! download of their objects outside the repository lock, smaller files
//! first, with the transfer mechanism of [`crate::git::transfer`], the
//! short layout of the downloaded files into the working copy under the
//! lock, and why a download stopped.
//!
//! When a host downloads (after a clone, after a sync, on request) and that
//! it runs one download per repository is the host's; what a download does
//! and what its outcome means for the LFS state is this module's.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use serde::Serialize;

use super::config::AssetsSpaceConfig;
use super::lfs::{LfsState, probe_readiness};
use super::policy::strategy_uses_lfs_policy;
use crate::git::GitError;
use crate::git::cli::GitCli;
use crate::git::state::GitRuntime;
use crate::git::transfer::{
    IDLE_LIMIT, Transfer, TransferDirection, TransferObserver, TransferOutcome, TransferProgress,
};

const POINTER_PREFIX: &str = "version https://git-lfs.github.com/spec/v1";
/// A pointer file is well under this size; a larger file is content.
pub(crate) const POINTER_MAX_BYTES: u64 = 200;

/// Files up to this size share one fetch whatever their sizes.
const SMALL_FILE: u64 = 256 * 1024;
/// A fetch takes files up to this many times the size of its smallest one,
/// so a small file never waits for a much larger one.
const GROUP_RATIO: u64 = 4;
/// The patterns of one command stay well inside the command line limit of
/// every system Svode runs on.
const PATTERNS_BUDGET: usize = 8 * 1024;
/// The longest text of an unrecognized stop a host shows.
const DETAIL_MAX_CHARS: usize = 600;

/// An LFS file of the current version, relative to the repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsFile {
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Pointer {
    file: LfsFile,
    oid: String,
    /// Whether the object is in the local LFS store already, so laying the
    /// file out needs no network.
    local: bool,
}

/// The LFS files of the current version whose working copy file is still a
/// pointer, smallest first.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MissingFiles(Vec<Pointer>);

impl MissingFiles {
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn files(&self) -> Vec<LfsFile> {
        self.0.iter().map(|pointer| pointer.file.clone()).collect()
    }

    pub fn bytes(&self) -> u64 {
        self.0.iter().map(|pointer| pointer.file.size).sum()
    }

    /// Whether a file is missing that was not missing in `previous`: a new
    /// file, or a file whose content changed since.
    pub fn adds_to(&self, previous: &MissingFiles) -> bool {
        self.0.iter().any(|pointer| {
            !previous
                .0
                .iter()
                .any(|known| known.file.path == pointer.file.path && known.oid == pointer.oid)
        })
    }

    fn needing_network(&self) -> Vec<&Pointer> {
        self.0.iter().filter(|pointer| !pointer.local).collect()
    }
}

/// Why a download stopped with files still missing (DF-368 R6).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum DownloadStop {
    /// The storage refused the credentials of this device.
    NoAccess,
    /// The server could not be reached.
    Unreachable,
    /// No data moved for the idle limit of the transfer.
    Stalled,
    /// The server has no object for a file.
    NotOnServer,
    /// Anything else, with the text of git-lfs without credentials.
    Other { detail: String },
}

/// The files a download left without content and why it stopped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsMissing {
    pub files: Vec<LfsFile>,
    pub bytes: u64,
    pub stop: DownloadStop,
}

impl LfsMissing {
    fn of(missing: &MissingFiles, stop: DownloadStop) -> Option<Self> {
        (!missing.is_empty()).then(|| Self {
            files: missing.files(),
            bytes: missing.bytes(),
            stop,
        })
    }
}

/// What a host shows of the LFS content of one repository: its state and,
/// when files of the current version are without content, which and why.
///
/// `state` is `Pulling` while a download runs, `MissingCreds` when the
/// readiness check or the storage refused this device; with `Ready`, a
/// `missing` set means not every file is downloaded. `unsent` is the send
/// queue of the repository (DF-377 R5), which a download does not change:
/// the transitions below leave it to the host.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsStatus {
    pub state: LfsState,
    pub missing: Option<LfsMissing>,
    pub unsent: Option<super::lfs_unsent::LfsUnsent>,
}

impl LfsStatus {
    /// After a readiness check outside a download answered `state`: a
    /// running download keeps its state until it ends, and the files it
    /// left stay missing until a download lays them out.
    pub fn probed(&self, state: LfsState) -> Self {
        match (state, self.state) {
            (LfsState::NotApplicable, _) => Self::default(),
            (_, LfsState::Pulling) => self.clone(),
            (state, _) => Self {
                state,
                missing: self.missing.clone(),
                unsent: None,
            },
        }
    }

    /// After `plan`: `Pulling` when the download starts.
    pub fn planned(&self, plan: &DownloadPlan) -> Self {
        match plan {
            DownloadPlan::NotApplicable => Self::default(),
            DownloadPlan::NothingMissing => Self {
                state: match self.state {
                    LfsState::Pulling => LfsState::Ready,
                    state => state,
                },
                missing: None,
                unsent: None,
            },
            DownloadPlan::NotReady { state, missing } => Self {
                state: *state,
                missing: LfsMissing::of(missing, DownloadStop::NoAccess),
                unsent: None,
            },
            DownloadPlan::Download(_) => Self {
                state: LfsState::Pulling,
                missing: None,
                unsent: None,
            },
        }
    }

    /// After a download ended with `outcome`.
    pub fn downloaded(outcome: &DownloadOutcome) -> Self {
        let stop = outcome.stop.clone().unwrap_or(DownloadStop::Other {
            detail: String::new(),
        });
        let state = if stop == DownloadStop::NoAccess && !outcome.missing.is_empty() {
            LfsState::MissingCreds
        } else {
            LfsState::Ready
        };
        Self {
            state,
            missing: LfsMissing::of(&outcome.missing, stop),
            unsent: None,
        }
    }
}

/// What a download of a repository would do now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DownloadPlan {
    /// The assets strategy keeps no content in Git LFS.
    NotApplicable,
    /// Every LFS file of the current version has its content.
    NothingMissing,
    /// The readiness check refused with `state`; nothing is transferred.
    NotReady {
        state: LfsState,
        missing: MissingFiles,
    },
    Download(MissingFiles),
}

/// How a download ended: the files still missing after it and, when some
/// are, why it stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadOutcome {
    pub missing: MissingFiles,
    pub stop: Option<DownloadStop>,
}

/// The LFS files of the current version of `repo_dir` whose working copy
/// file is still a pointer, read locally without the network. A file the
/// user changed or deleted is not missing. Only the long listing of
/// `git lfs ls-files` is read, which every git-lfs 3 release prints; size
/// and object come from the pointer itself.
pub async fn missing_files(cli: &GitCli, repo_dir: &Path) -> Result<MissingFiles, GitError> {
    let out = cli
        .exec_redacted(repo_dir, &["lfs", "ls-files", "--long"])
        .await?;
    if out.exit_code != 0 {
        return Err(GitError::GitCommandFailed(format!(
            "git lfs ls-files failed: {}",
            out.stderr.trim()
        )));
    }
    let store = object_store(cli, repo_dir).await;
    let mut missing = out
        .stdout
        .lines()
        .filter_map(|line| {
            // `<oid> <* or -> <path>`
            let (_, rest) = line.split_once(' ')?;
            let (_, path) = rest.split_once(' ')?;
            let (oid, size) = read_pointer(&repo_dir.join(path))?;
            let local = store
                .as_deref()
                .is_some_and(|store| stored_locally(store, &oid, size));
            Some(Pointer {
                file: LfsFile {
                    path: path.to_owned(),
                    size,
                },
                oid,
                local,
            })
        })
        .collect::<Vec<_>>();
    missing.sort_by(|a, b| (a.file.size, &a.file.path).cmp(&(b.file.size, &b.file.path)));
    missing.dedup_by(|a, b| a.file.path == b.file.path);
    Ok(MissingFiles(missing))
}

/// The local object store of git-lfs, `<common Git dir>/lfs/objects`.
pub(crate) async fn object_store(cli: &GitCli, repo_dir: &Path) -> Option<PathBuf> {
    let out = cli
        .exec_redacted(repo_dir, &["rev-parse", "--git-common-dir"])
        .await
        .ok()?;
    let dir = out.stdout.trim();
    (out.exit_code == 0 && !dir.is_empty()).then(|| repo_dir.join(dir).join("lfs/objects"))
}

/// Whether the local object store `store` holds the whole object `oid`.
pub(crate) fn stored_locally(store: &Path, oid: &str, size: u64) -> bool {
    oid.len() > 4
        && std::fs::metadata(store.join(&oid[..2]).join(&oid[2..4]).join(oid))
            .is_ok_and(|object| object.len() == size)
}

/// The object and size of the LFS pointer file at `path`, when it is one:
/// small, starting with the pointer version line and naming a sha256
/// object. A file that cannot be read is not.
fn read_pointer(path: &Path) -> Option<(String, u64)> {
    use std::io::Read;
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() >= POINTER_MAX_BYTES {
        return None;
    }
    let mut head = [0u8; POINTER_MAX_BYTES as usize];
    let read = std::fs::File::open(path)
        .and_then(|mut file| file.read(&mut head))
        .ok()?;
    parse_pointer(std::str::from_utf8(&head[..read]).ok()?)
}

/// The object and size named by the LFS pointer `text`, when it is one.
pub(crate) fn parse_pointer(text: &str) -> Option<(String, u64)> {
    if text.len() >= POINTER_MAX_BYTES as usize {
        return None;
    }
    let mut lines = text.lines();
    if lines.next() != Some(POINTER_PREFIX) {
        return None;
    }
    let (mut oid, mut size) = (None, None);
    for line in lines {
        if let Some(hex) = line.strip_prefix("oid sha256:") {
            oid = (hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()))
                .then(|| hex.to_owned());
        } else if let Some(value) = line.strip_prefix("size ") {
            size = value.parse().ok();
        }
    }
    Some((oid?, size?))
}

fn is_pointer(path: &Path) -> bool {
    read_pointer(path).is_some()
}

/// What a download of `repo_dir` with the assets strategy `config` would
/// do now (DF-368 R1, R7): nothing without an LFS strategy or with every
/// file in place; the readiness check runs only when an object has to come
/// over the network.
pub async fn plan_download(
    git: &GitRuntime,
    repo_dir: &Path,
    config: &AssetsSpaceConfig,
) -> Result<DownloadPlan, GitError> {
    if !strategy_uses_lfs_policy(&config.strategy) {
        return Ok(DownloadPlan::NotApplicable);
    }
    let missing = match missing_files(git.cli()?, repo_dir).await {
        Ok(missing) => missing,
        Err(error) => {
            // Without a working git-lfs the readiness check says why.
            return match probe_readiness(git, repo_dir, config).await {
                LfsState::Ready => Err(error),
                state => Ok(DownloadPlan::NotReady {
                    state,
                    missing: MissingFiles::default(),
                }),
            };
        }
    };
    if missing.is_empty() {
        return Ok(DownloadPlan::NothingMissing);
    }
    if missing.needing_network().is_empty() {
        return Ok(DownloadPlan::Download(missing));
    }
    Ok(match probe_readiness(git, repo_dir, config).await {
        LfsState::Ready => DownloadPlan::Download(missing),
        state => DownloadPlan::NotReady { state, missing },
    })
}

/// Download `missing` into `repo_dir` (DF-368 R2–R4): objects come smaller
/// files first, in groups of similar size, without the repository lock and
/// with the progress of [`Transfer`] reported to the observer of `cli` as
/// one transfer; after each group its files are laid out under the lock.
/// A group without progress for [`IDLE_LIMIT`] stops the download, a missing
/// object only its own file.
pub async fn download(
    git: &GitRuntime,
    cli: &GitCli,
    repo_dir: &Path,
    missing: &MissingFiles,
) -> DownloadOutcome {
    download_with(git, cli, repo_dir, missing, IDLE_LIMIT).await
}

pub(crate) async fn download_with(
    git: &GitRuntime,
    cli: &GitCli,
    repo_dir: &Path,
    missing: &MissingFiles,
    idle_limit: Duration,
) -> DownloadOutcome {
    let remote = missing.needing_network();
    let overall = cli.transfer_observer_handle().map(|inner| {
        Arc::new(Overall {
            inner,
            before: AtomicU64::new(0),
            total: remote.len() as u64,
            observed: AtomicBool::new(false),
        })
    });
    let fetch_cli = match &overall {
        Some(overall) => cli.reporting_transfers_to(overall.clone()),
        None => cli.clone(),
    };

    let mut stop = None;
    let mut detail = None;
    let local = missing.0.iter().filter(|pointer| pointer.local);
    if let Err(text) = lay_out(git, cli, repo_dir, local).await {
        detail = Some(text);
    }
    for group in groups(&remote) {
        let include = format!("--include={}", patterns(&group).join(","));
        let fetched = Transfer::new(repo_dir, TransferDirection::Download)
            .idle_limit(idle_limit)
            .run(&fetch_cli, &["lfs", "fetch", &include], &[])
            .await;
        match fetched {
            Ok(TransferOutcome::Finished(out)) if out.exit_code == 0 => {}
            Ok(TransferOutcome::Finished(out)) => stop = Some(stop_cause(&out.stderr)),
            Ok(TransferOutcome::Stalled(_)) => stop = Some(DownloadStop::Stalled),
            Err(error) => stop = Some(other(&error.to_string())),
        }
        if let Err(text) = lay_out(git, cli, repo_dir, group.iter().copied()).await {
            detail = Some(text);
        }
        if let Some(overall) = &overall {
            overall
                .before
                .fetch_add(group.len() as u64, Ordering::Relaxed);
        }
        if matches!(
            stop,
            Some(DownloadStop::NoAccess | DownloadStop::Unreachable | DownloadStop::Stalled)
        ) {
            break;
        }
    }
    if let Some(overall) = &overall
        && overall.observed.load(Ordering::Relaxed)
    {
        overall.inner.transfer_progress(repo_dir, None);
    }

    let remaining = match missing_files(cli, repo_dir).await {
        Ok(remaining) => remaining,
        Err(error) => {
            tracing::warn!("LFS download: reading the missing files failed: {error}");
            MissingFiles(
                missing
                    .0
                    .iter()
                    .filter(|pointer| is_pointer(&repo_dir.join(&pointer.file.path)))
                    .cloned()
                    .collect(),
            )
        }
    };
    let stop = (!remaining.is_empty()).then(|| {
        stop.unwrap_or_else(|| DownloadStop::Other {
            detail: detail.unwrap_or_default(),
        })
    });
    DownloadOutcome {
        missing: remaining,
        stop,
    }
}

/// Lay the downloaded objects of `pointers` out into the working copy under
/// the repository lock: only files that are still pointers, so a file the
/// user changed meanwhile stays as it is; git-lfs refreshes the index, so
/// the files do not show as changed. The text of a failure, if any.
async fn lay_out<'a>(
    git: &GitRuntime,
    cli: &GitCli,
    repo_dir: &Path,
    pointers: impl Iterator<Item = &'a Pointer>,
) -> Result<(), String> {
    let lock = git.get_lock(repo_dir).await;
    let _guard = lock.lock().await;
    let still = pointers
        .filter(|pointer| is_pointer(&repo_dir.join(&pointer.file.path)))
        .collect::<Vec<_>>();
    for chunk in chunks(&still) {
        let mut args = vec!["lfs".to_owned(), "checkout".to_owned()];
        args.extend(patterns(&chunk));
        let args = args.iter().map(String::as_str).collect::<Vec<_>>();
        match cli.exec_redacted(repo_dir, &args).await {
            Ok(out) if out.exit_code == 0 => {}
            Ok(out) => return Err(detail_text(&out.stderr)),
            Err(error) => return Err(detail_text(&error.to_string())),
        }
    }
    Ok(())
}

/// The files of one fetch each: ascending size, a new group when a file is
/// more than [`GROUP_RATIO`] times the smallest of the group (files up to
/// [`SMALL_FILE`] together) or the patterns outgrow [`PATTERNS_BUDGET`].
fn groups<'a>(files: &[&'a Pointer]) -> Vec<Vec<&'a Pointer>> {
    let mut groups: Vec<Vec<&Pointer>> = Vec::new();
    let mut length = 0;
    for &pointer in files {
        let pattern = pattern(&pointer.file.path).len() + 1;
        let joins = groups.last().is_some_and(|group| {
            let smallest = group[0].file.size.max(SMALL_FILE);
            pointer.file.size <= smallest.saturating_mul(GROUP_RATIO)
                && length + pattern <= PATTERNS_BUDGET
        });
        if joins {
            length += pattern;
            groups.last_mut().expect("joined a group").push(pointer);
        } else {
            length = pattern;
            groups.push(vec![pointer]);
        }
    }
    groups
}

/// `pointers` in commands of at most [`PATTERNS_BUDGET`] pattern bytes.
fn chunks<'a>(pointers: &[&'a Pointer]) -> Vec<Vec<&'a Pointer>> {
    let mut chunks: Vec<Vec<&Pointer>> = Vec::new();
    let mut length = 0;
    for &pointer in pointers {
        let pattern = pattern(&pointer.file.path).len() + 1;
        match chunks.last_mut() {
            Some(chunk) if length + pattern <= PATTERNS_BUDGET => {
                length += pattern;
                chunk.push(pointer);
            }
            _ => {
                length = pattern;
                chunks.push(vec![pointer]);
            }
        }
    }
    chunks
}

fn patterns(pointers: &[&Pointer]) -> Vec<String> {
    pointers
        .iter()
        .map(|pointer| pattern(&pointer.file.path))
        .collect()
}

/// The git-lfs path pattern (gitignore(5) wildcards) of exactly the file at
/// the repository path `path`: anchored at the root, so it neither matches
/// a file of the same name elsewhere nor reads as an option; a character
/// the pattern syntax or the comma list of `--include` would read is a `?`
/// wildcard, which matches it on every system where a backslash escape
/// would not.
fn pattern(path: &str) -> String {
    let mut pattern = String::with_capacity(path.len() + 1);
    pattern.push('/');
    for character in path.chars() {
        pattern.push(match character {
            '\\' | '*' | '?' | '[' | ']' | ',' => '?',
            other => other,
        });
    }
    if pattern.ends_with(' ') {
        pattern.pop();
        pattern.push('?');
    }
    pattern
}

/// Why a fetch that git-lfs ended with an error stopped, from its stderr.
fn stop_cause(stderr: &str) -> DownloadStop {
    let lower = stderr.to_ascii_lowercase();
    if crate::git::ops::is_git_auth_error(stderr)
        || [
            "repository or object not found",
            // svode-lfs: the S3 storage refused the keys of this device.
            "permissiondenied",
            "accessdenied",
        ]
        .iter()
        .any(|marker| lower.contains(marker))
    {
        DownloadStop::NoAccess
    } else if is_network_failure(&lower) {
        DownloadStop::Unreachable
    } else if [
        "does not exist on the server",
        "remote missing object",
        "object not found",
        "notfound",
        "[404]",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
    {
        DownloadStop::NotOnServer
    } else {
        other(stderr)
    }
}

/// Whether lower-cased git-lfs output says the server was out of reach:
/// the network failures of Git and those of git-lfs and SSH.
pub(crate) fn is_network_failure(lower: &str) -> bool {
    crate::git::diagnostics::is_network_failure(lower)
        || [
            "no such host",
            "no route to host",
            "i/o timeout",
            "dial tcp",
            "could not connect",
        ]
        .iter()
        .any(|marker| lower.contains(marker))
}

fn other(text: &str) -> DownloadStop {
    DownloadStop::Other {
        detail: detail_text(text),
    }
}

/// The lines of git-lfs that say what went wrong, without credentials in
/// URLs and without its own progress, at most [`DETAIL_MAX_CHARS`].
pub(crate) fn detail_text(text: &str) -> String {
    let redacted = crate::git::auth::redact_url_credentials(text);
    let lines = redacted
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("Fetching reference"))
        .collect::<Vec<_>>()
        .join("\n");
    if lines.chars().count() <= DETAIL_MAX_CHARS {
        return lines;
    }
    let mut cut = lines.chars().take(DETAIL_MAX_CHARS).collect::<String>();
    cut.push('…');
    cut
}

/// The progress of every fetch of one download as one transfer: files are
/// numbered across the groups, and the end is reported once, by the
/// download.
struct Overall {
    inner: Arc<dyn TransferObserver>,
    /// Files of the groups before the running one.
    before: AtomicU64,
    total: u64,
    observed: AtomicBool,
}

impl TransferObserver for Overall {
    fn transfer_progress(&self, repository: &Path, progress: Option<&TransferProgress>) {
        let Some(progress) = progress else {
            return;
        };
        let before = self.before.load(Ordering::Relaxed);
        let overall = TransferProgress {
            file: before + progress.file,
            files: self.total.max(before + progress.files),
            ..progress.clone()
        };
        self.observed.store(true, Ordering::Relaxed);
        self.inner.transfer_progress(repository, Some(&overall));
    }
}

#[cfg(test)]
#[path = "lfs_download_tests.rs"]
mod tests;

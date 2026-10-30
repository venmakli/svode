use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use unicode_normalization::UnicodeNormalization;

use super::GitError;
use super::cli::{GitCli, read_records, write_within};
use super::path::{RootMode, normalize_repo_relative};

/// Most paths a listed status carries; flags and totals still cover every path.
pub const STATUS_LIST_LIMIT: usize = 20_000;
/// How long a listed status read waits for Git.
pub const STATUS_READ_TIMEOUT: Duration = Duration::from_secs(30);
/// A listed read slower than this updates the cached stat data of the index.
const SLOW_STATUS_READ: Duration = Duration::from_secs(1);
/// Least time between two index stat updates of one repository.
const INDEX_REFRESH_INTERVAL: Duration = Duration::from_secs(10 * 60);

/// When Svode last updated the stat data of each index, by its absolute path.
static INDEX_REFRESHED: OnceLock<Mutex<HashMap<PathBuf, Instant>>> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub has_staged: bool,
    pub has_unstaged: bool,
    pub has_conflicts: bool,
    pub tracking: Option<String>,
    pub files: Vec<FileGitStatus>,
    /// Changed paths of the repository, listed in `files` or not.
    pub total_files: usize,
    /// Changed paths left out of `files` by [`STATUS_LIST_LIMIT`].
    pub omitted_files: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileGitStatus {
    pub path: String,
    /// "modified" | "untracked" | "deleted" | "conflict"
    pub state: String,
}

pub async fn get_remote(cli: &GitCli, space_dir: &Path) -> Result<Option<String>, GitError> {
    let out = cli
        .exec(space_dir, &["config", "--get", "remote.origin.url"])
        .await?;
    if out.exit_code != 0 {
        return Ok(None);
    }
    let url = out.stdout.trim().to_string();
    if url.is_empty() {
        Ok(None)
    } else {
        Ok(Some(url))
    }
}

/// Status as Desktop, MCP and CLI present it: every path counts toward the
/// flags and totals, `files` holds at most [`STATUS_LIST_LIMIT`] paths with the
/// conflicts first, and Git gets [`STATUS_READ_TIMEOUT`] to answer.
///
/// The caller holds the Svode lock of the repository: a slow read updates the
/// cached stat data of its index.
pub async fn status(cli: &GitCli, space_dir: &Path) -> Result<GitStatus, GitError> {
    listed_status(
        cli,
        space_dir,
        STATUS_READ_TIMEOUT,
        SLOW_STATUS_READ,
        INDEX_REFRESH_INTERVAL,
    )
    .await
}

async fn listed_status(
    cli: &GitCli,
    space_dir: &Path,
    timeout: Duration,
    slow: Duration,
    interval: Duration,
) -> Result<GitStatus, GitError> {
    let started = Instant::now();
    let read = read_status(cli, space_dir, Some(timeout)).await;
    if started.elapsed() > slow || matches!(read, Err(GitError::StatusTimedOut { .. })) {
        refresh_index_stat(cli, space_dir, interval).await;
    }
    let mut status = read?;
    limit_files(&mut status, STATUS_LIST_LIMIT);
    Ok(status)
}

/// Reads run without optional locks, so Git never writes the stat data it
/// refreshes, and after a copy, restore or cloud sync touches every file each
/// read rehashes them all again. This explicit write records that stat data
/// once, without changing any index entry. It runs only under the Svode lock
/// of the repository, with no Git operation in progress, `index.lock` free and
/// HEAD on a branch, at most once per `interval` per repository. The lock is
/// held at most [`STATUS_READ_TIMEOUT`]; an update still running then finishes
/// under `index.lock` alone. A failure is silent and the next slow read tries
/// again.
async fn refresh_index_stat(cli: &GitCli, space_dir: &Path, interval: Duration) {
    let Ok(index) = cli
        .exec(
            space_dir,
            &["rev-parse", "--path-format=absolute", "--git-path", "index"],
        )
        .await
    else {
        return;
    };
    if index.exit_code != 0 {
        return;
    }
    let index = PathBuf::from(index.stdout.trim_end());
    let refreshed = INDEX_REFRESHED.get_or_init(Default::default);
    if refreshed
        .lock()
        .ok()
        .and_then(|refreshed| refreshed.get(&index).map(Instant::elapsed))
        .is_some_and(|since| since < interval)
    {
        return;
    }
    if !matches!(
        super::branch::operation_in_progress(cli, space_dir).await,
        Ok(None)
    ) {
        return;
    }
    if !matches!(
        cli.exec(space_dir, &["symbolic-ref", "-q", "HEAD"]).await,
        Ok(head) if head.exit_code == 0
    ) {
        return;
    }
    if index.with_file_name("index.lock").exists() {
        return;
    }
    if let Ok(Some(true)) = write_within(
        cli,
        space_dir,
        &["update-index", "-q", "--refresh"],
        STATUS_READ_TIMEOUT,
    )
    .await
        && let Ok(mut refreshed) = refreshed.lock()
    {
        refreshed.insert(index, Instant::now());
    }
}

/// Status an operation decides by: every path, with no limit on their number,
/// the output size or the time Git takes.
pub async fn full_status(cli: &GitCli, space_dir: &Path) -> Result<GitStatus, GitError> {
    read_status(cli, space_dir, None).await
}

/// Parse `git status --porcelain=v2 --branch -z` as Git writes it.
async fn read_status(
    cli: &GitCli,
    space_dir: &Path,
    timeout: Option<Duration>,
) -> Result<GitStatus, GitError> {
    let prefix = status_path_prefix(cli, space_dir).await?;
    let mut parser = StatusParser::default();
    let read = read_records(
        cli,
        space_dir,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=all",
            "--ignore-submodules=dirty",
            "-z",
            "--",
            ".",
        ],
        timeout,
        |record| {
            let record = std::str::from_utf8(record).map_err(|_| {
                GitError::GitCommandFailed("Repository paths have invalid encoding".into())
            })?;
            parser.record(record)
        },
    )
    .await?;
    match (read, timeout) {
        (Some(true), _) => {}
        (Some(false), _) => {
            return Err(GitError::GitCommandFailed(
                "Repository status unavailable".into(),
            ));
        }
        (None, timeout) => {
            return Err(GitError::StatusTimedOut {
                repository: repository_name(space_dir),
                seconds: timeout.unwrap_or_default().as_secs(),
            });
        }
    }
    let mut status = parser.finish();
    strip_status_path_prefix(&mut status, &prefix)?;
    let relocations = case_relocations(cli, space_dir, &status.files).await?;
    if !relocations.is_empty() {
        status.has_unstaged = true;
        status.files.extend(relocations);
    }
    let local_conflicts = status
        .files
        .iter()
        .any(|file| super::policy::contains(&file.path) && file.state == "conflict");
    status.files.retain(|file| {
        if super::policy::contains(&file.path) {
            return false;
        }
        let mut ancestor = space_dir.to_path_buf();
        let parts: Vec<_> = file.path.split('/').collect();
        for (index, part) in parts.iter().enumerate() {
            ancestor.push(part);
            if ancestor.join(".git").exists() {
                return index + 1 == parts.len() && file.state != "untracked";
            }
        }
        true
    });
    if status.files.is_empty() {
        status.has_staged = false;
        status.has_unstaged = false;
        status.has_conflicts = local_conflicts;
    }
    status.total_files = status.files.len();
    Ok(status)
}

/// Keep at most `limit` paths: every conflict first, then the rest in Git order.
fn limit_files(status: &mut GitStatus, limit: usize) {
    if status.files.len() > limit {
        let (mut files, rest): (Vec<_>, Vec<_>) = std::mem::take(&mut status.files)
            .into_iter()
            .partition(|file| file.state == "conflict");
        files.extend(rest);
        files.truncate(limit);
        status.files = files;
    }
    status.omitted_files = status.total_files - status.files.len();
}

/// The repository a status error names: its Space or project name, else its
/// folder name, never an absolute path.
fn repository_name(space_dir: &Path) -> String {
    crate::storage::config::read_space_assets_config(space_dir)
        .map(|config| config.name)
        .ok()
        .filter(|name| !name.trim().is_empty())
        .or_else(|| {
            std::fs::canonicalize(space_dir).ok().and_then(|path| {
                path.file_name()
                    .map(|name| name.to_string_lossy().into_owned())
            })
        })
        .unwrap_or_else(|| "repository".into())
}

/// Git folding names on a case-insensitive file system reports nothing for a
/// case-only relocation: the new spelling counts as its tracked old one. Such a
/// relocation is listed as the deleted old spelling and the untracked new one.
async fn case_relocations(
    cli: &GitCli,
    space_dir: &Path,
    reported: &[FileGitStatus],
) -> Result<Vec<FileGitStatus>, GitError> {
    let folding = cli
        .exec(space_dir, &["config", "--bool", "core.ignorecase"])
        .await?;
    if folding.stdout.trim() != "true" {
        return Ok(Vec::new());
    }
    let listed = async |args: &[&str]| -> Result<Vec<String>, GitError> {
        let out = cli.exec(space_dir, args).await?;
        if out.exit_code != 0 {
            return Err(GitError::GitCommandFailed(
                "Repository status unavailable".into(),
            ));
        }
        out.stdout
            .split('\0')
            .filter(|path| !path.is_empty())
            .map(|path| normalize_repo_relative(path.trim_end_matches('/'), RootMode::Reject))
            .collect()
    };
    let reported = reported
        .iter()
        .map(|file| file.path.as_str())
        .collect::<HashSet<_>>();
    let spelled = listed(&[
        "-c",
        "core.ignorecase=false",
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        ".",
    ])
    .await?
    .into_iter()
    .filter(|path| !reported.contains(path.as_str()))
    .collect::<Vec<_>>();
    if spelled.is_empty() {
        return Ok(Vec::new());
    }
    let fold = |path: &str| path.nfc().collect::<String>().to_lowercase();
    let tracked = listed(&["ls-files", "--cached", "-z", "--", "."])
        .await?
        .into_iter()
        .map(|path| (fold(&path), path))
        .collect::<HashMap<_, _>>();
    let mut presence = super::staging::Presence::new(space_dir);
    let mut relocations = Vec::new();
    let mut deleted = HashSet::new();
    for path in spelled {
        let Some(old) = tracked.get(&fold(&path)) else {
            continue;
        };
        if *old == path || presence.exact(old) {
            continue;
        }
        if deleted.insert(old.clone()) && !reported.contains(old.as_str()) {
            relocations.push(FileGitStatus {
                path: old.clone(),
                state: "deleted".into(),
            });
        }
        relocations.push(FileGitStatus {
            path,
            state: "untracked".into(),
        });
    }
    Ok(relocations)
}

pub async fn status_with_remote_counts(
    cli: &GitCli,
    space_dir: &Path,
) -> Result<GitStatus, GitError> {
    let mut status = status(cli, space_dir).await?;
    if get_remote(cli, space_dir).await?.is_none() {
        return Ok(status);
    }

    let branch = match current_branch(cli, space_dir).await {
        Ok(branch) if branch != "HEAD" && !branch.is_empty() => branch,
        _ => return Ok(status),
    };

    let remote_ref = format!("refs/remotes/origin/{branch}");
    if ref_exists(cli, space_dir, &remote_ref).await? {
        status.behind = count_rev_list(cli, space_dir, &format!("HEAD..{remote_ref}")).await?;
        status.ahead = count_rev_list(cli, space_dir, &format!("{remote_ref}..HEAD")).await?;
    } else {
        status.behind = 0;
        status.ahead = count_rev_list(cli, space_dir, "HEAD").await.unwrap_or(0);
    }

    Ok(status)
}
pub async fn ref_exists(cli: &GitCli, space_dir: &Path, reference: &str) -> Result<bool, GitError> {
    let out = cli
        .exec(space_dir, &["rev-parse", "--verify", reference])
        .await?;
    Ok(out.exit_code == 0)
}

async fn count_rev_list(cli: &GitCli, space_dir: &Path, rev: &str) -> Result<u32, GitError> {
    let out = cli.exec(space_dir, &["rev-list", "--count", rev]).await?;
    if out.exit_code != 0 {
        return Err(GitError::GitCommandFailed(format!(
            "git rev-list failed: {}",
            out.stderr.trim()
        )));
    }
    Ok(out.stdout.trim().parse().unwrap_or(0))
}

async fn status_path_prefix(cli: &GitCli, space_dir: &Path) -> Result<String, GitError> {
    let out = cli.exec(space_dir, &["rev-parse", "--show-prefix"]).await?;
    if out.exit_code != 0 {
        return Err(GitError::GitCommandFailed(format!(
            "git rev-parse failed: {}",
            out.stderr
        )));
    }
    Ok(out.stdout.trim().replace('\\', "/"))
}

pub fn strip_status_path_prefix(status: &mut GitStatus, prefix: &str) -> Result<(), GitError> {
    let normalized = prefix.trim_matches('/');
    if normalized.is_empty() {
        return Ok(());
    }
    let with_slash = format!("{normalized}/");
    status.files = status
        .files
        .drain(..)
        .filter_map(|file| {
            file.path.strip_prefix(&with_slash).map(|path| {
                normalize_repo_relative(path, RootMode::Reject).map(|path| FileGitStatus {
                    path,
                    state: file.state,
                })
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(())
}

pub fn parse_status_porcelain_v2_z(stdout: &str) -> Result<GitStatus, GitError> {
    let mut parser = StatusParser::default();
    for record in stdout.split('\0') {
        parser.record(record)?;
    }
    Ok(parser.finish())
}

/// Porcelain v2 records one at a time, so the output is never held whole.
#[derive(Default)]
struct StatusParser {
    branch: Option<String>,
    ahead: u32,
    behind: u32,
    has_staged: bool,
    has_unstaged: bool,
    has_conflicts: bool,
    tracking: Option<String>,
    files: Vec<FileGitStatus>,
    /// The previous record was a rename, whose next record is its source.
    rename_source: bool,
}

impl StatusParser {
    fn record(&mut self, record: &str) -> Result<(), GitError> {
        if std::mem::take(&mut self.rename_source) && !record.is_empty() {
            self.files.push(FileGitStatus {
                path: normalize_git_path(record)?,
                state: "deleted".to_string(),
            });
            return Ok(());
        }
        if record.is_empty() {
            return Ok(());
        }

        if let Some(rest) = record.strip_prefix("# branch.head ") {
            self.branch = Some(rest.to_string());
            return Ok(());
        }
        if let Some(rest) = record.strip_prefix("# branch.upstream ") {
            self.tracking = Some(rest.to_string());
            return Ok(());
        }
        if let Some(rest) = record.strip_prefix("# branch.ab ") {
            for part in rest.split_whitespace() {
                if let Some(n) = part.strip_prefix('+') {
                    self.ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix('-') {
                    self.behind = n.parse().unwrap_or(0);
                }
            }
            return Ok(());
        }

        if record.starts_with("u ") {
            self.has_conflicts = true;
            if let Some(path) = split_status_fields(record, 11).get(10) {
                self.files.push(FileGitStatus {
                    path: normalize_git_path(path)?,
                    state: "conflict".to_string(),
                });
            }
            return Ok(());
        }

        if record.starts_with("1 ") {
            let fields = split_status_fields(record, 9);
            if fields.len() >= 9 {
                update_staged_flags(fields[1], &mut self.has_staged, &mut self.has_unstaged);
                self.files.push(FileGitStatus {
                    path: normalize_git_path(fields[8])?,
                    state: status_state_for_xy(fields[1]).to_string(),
                });
            }
            return Ok(());
        }

        if record.starts_with("2 ") {
            let fields = split_status_fields(record, 10);
            if fields.len() >= 10 {
                update_staged_flags(fields[1], &mut self.has_staged, &mut self.has_unstaged);
                self.files.push(FileGitStatus {
                    path: normalize_git_path(fields[9])?,
                    state: status_state_for_xy(fields[1]).to_string(),
                });
                self.rename_source = true;
            }
            return Ok(());
        }

        if let Some(rest) = record.strip_prefix("? ") {
            self.has_unstaged = true;
            self.files.push(FileGitStatus {
                path: normalize_git_path(rest)?,
                state: "untracked".to_string(),
            });
        }
        Ok(())
    }

    fn finish(self) -> GitStatus {
        let total_files = self.files.len();
        GitStatus {
            repository: None,
            branch: self.branch.unwrap_or_else(|| "HEAD".to_string()),
            ahead: self.ahead,
            behind: self.behind,
            has_staged: self.has_staged,
            has_unstaged: self.has_unstaged,
            has_conflicts: self.has_conflicts,
            tracking: self.tracking,
            files: self.files,
            total_files,
            omitted_files: 0,
        }
    }
}

fn split_status_fields(record: &str, fields: usize) -> Vec<&str> {
    record.splitn(fields, ' ').collect()
}

fn update_staged_flags(xy: &str, has_staged: &mut bool, has_unstaged: &mut bool) {
    if xy.len() < 2 {
        return;
    }
    let x = xy.as_bytes()[0];
    let y = xy.as_bytes()[1];
    if x != b'.' {
        *has_staged = true;
    }
    if y != b'.' {
        *has_unstaged = true;
    }
}

fn status_state_for_xy(xy: &str) -> &'static str {
    if xy.as_bytes().iter().any(|status| *status == b'D') {
        return "deleted";
    }
    "modified"
}

pub fn normalize_git_path(path: &str) -> Result<String, GitError> {
    let normalized = path.replace('\\', "/");
    let trimmed = normalized.trim_end_matches('/');
    normalize_repo_relative(trimmed, RootMode::Reject)
}
pub async fn current_branch(cli: &GitCli, space_dir: &Path) -> Result<String, GitError> {
    let out = cli
        .exec(space_dir, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await?;
    if out.exit_code != 0 {
        return Err(GitError::GitCommandFailed(format!(
            "git rev-parse failed: {}",
            out.stderr
        )));
    }
    Ok(out.stdout.trim().to_string())
}

#[cfg(test)]
pub(super) fn untracked_bulk(root: &Path, range: std::ops::Range<usize>) {
    // Long names keep the status output of 21 000 paths above 4 MB.
    let folder = root.join("bulk");
    std::fs::create_dir_all(&folder).unwrap();
    for index in range {
        std::fs::write(
            folder.join(format!("{index:05}-{}.md", "x".repeat(190))),
            "",
        )
        .unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::staging_tests::{cli, git, repo, write};

    fn file(path: &str, state: &str) -> FileGitStatus {
        FileGitStatus {
            path: path.into(),
            state: state.into(),
        }
    }

    #[test]
    fn listed_files_keep_every_conflict_first_and_count_the_rest() {
        let mut status = parse_status_porcelain_v2_z("").unwrap();
        status.files = vec![
            file("a.md", "modified"),
            file("b.md", "untracked"),
            file("c.md", "untracked"),
            file("late.md", "conflict"),
            file("d.md", "untracked"),
        ];
        status.total_files = 5;
        limit_files(&mut status, 3);
        assert_eq!(
            status.files,
            vec![
                file("late.md", "conflict"),
                file("a.md", "modified"),
                file("b.md", "untracked"),
            ]
        );
        assert_eq!((status.total_files, status.omitted_files), (5, 2));

        let mut within = parse_status_porcelain_v2_z("").unwrap();
        within.files = vec![file("a.md", "modified"), file("b.md", "conflict")];
        within.total_files = 2;
        limit_files(&mut within, 3);
        assert_eq!(
            within.files,
            vec![file("a.md", "modified"), file("b.md", "conflict")]
        );
        assert_eq!(within.omitted_files, 0);
    }

    #[test]
    fn streamed_rename_records_keep_their_source() {
        let status = parse_status_porcelain_v2_z(
            "# branch.head main\0\
2 R. N... 100644 100644 100644 abc abc R100 new.md\0old.md\0\
? notes.md\0",
        )
        .unwrap();
        assert_eq!(
            status.files,
            vec![
                file("new.md", "modified"),
                file("old.md", "deleted"),
                file("notes.md", "untracked"),
            ]
        );
        assert_eq!(status.total_files, 3);
    }

    #[tokio::test]
    async fn listed_status_of_a_large_repository_has_the_limit_and_exact_totals() {
        let cli = cli();
        let root = repo(&cli, true).await;
        write(root.path(), "baseline.md", "changed\n");
        untracked_bulk(root.path(), 0..18_999);
        let within = status(&cli, root.path()).await.unwrap();
        assert_eq!(within.files.len(), 19_000);
        assert_eq!((within.total_files, within.omitted_files), (19_000, 0));

        untracked_bulk(root.path(), 18_999..21_000);
        let listed = status(&cli, root.path()).await.unwrap();
        assert_eq!(listed.files.len(), STATUS_LIST_LIMIT);
        assert_eq!((listed.total_files, listed.omitted_files), (21_001, 1_001));
        assert!(!listed.has_staged && listed.has_unstaged && !listed.has_conflicts);
        assert_eq!(listed.files[0], file("baseline.md", "modified"));
        let full = full_status(&cli, root.path()).await.unwrap();
        assert_eq!(full.files.len(), 21_001);
        assert_eq!((full.total_files, full.omitted_files), (21_001, 0));
        // The output exceeds the former 4 MB read limit.
        let output = cli
            .exec(
                root.path(),
                &["status", "--porcelain=v2", "--untracked-files=all", "-z"],
            )
            .await
            .unwrap();
        assert!(output.stdout.len() > 4 * 1024 * 1024);
    }

    #[tokio::test]
    async fn listed_status_keeps_a_conflict_beyond_the_limit() {
        let cli = cli();
        let root = repo(&cli, true).await;
        git(&cli, root.path(), &["checkout", "-b", "other"]).await;
        write(root.path(), "zz-last.md", "other\n");
        git(&cli, root.path(), &["add", "."]).await;
        git(&cli, root.path(), &["commit", "-m", "Other"]).await;
        git(&cli, root.path(), &["checkout", "-"]).await;
        write(root.path(), "zz-last.md", "current\n");
        git(&cli, root.path(), &["add", "."]).await;
        git(&cli, root.path(), &["commit", "-m", "Current"]).await;
        assert_ne!(
            cli.exec(root.path(), &["merge", "other"])
                .await
                .unwrap()
                .exit_code,
            0
        );
        untracked_bulk(root.path(), 0..21_000);
        let listed = status(&cli, root.path()).await.unwrap();
        assert!(listed.has_conflicts);
        assert_eq!(listed.files[0], file("zz-last.md", "conflict"));
        assert_eq!((listed.total_files, listed.omitted_files), (21_001, 1_001));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_slow_status_read_names_the_repository_and_its_time_limit() {
        let cli = cli();
        let root = repo(&cli, true).await;
        write(
            root.path(),
            ".svode/config.json",
            "{\"name\": \"Research\"}\n",
        );
        let hook = root.path().join(".git/slow-fsmonitor");
        svode_testkit::write_executable(&hook, "#!/bin/sh\nsleep 4\nexit 1\n").unwrap();
        git(
            &cli,
            root.path(),
            &["config", "core.fsmonitor", hook.to_str().unwrap()],
        )
        .await;

        let error = read_status(&cli, root.path(), Some(Duration::from_secs(1)))
            .await
            .unwrap_err();
        assert!(
            matches!(&error, GitError::StatusTimedOut { repository, seconds: 1 } if repository == "Research"),
            "{error:?}"
        );
        assert_eq!(
            error.to_string(),
            "Git did not return the status of Research within 1 seconds"
        );
        assert_eq!(
            STATUS_READ_TIMEOUT,
            Duration::from_secs(30),
            "the listed read waits 30 seconds"
        );
        // Diff reads keep their own limit and wording.
        let diff = super::super::cli::read_bounded(&cli, root.path(), &["diff"], 1024)
            .await
            .unwrap_err();
        assert_eq!(diff.to_string(), "Git command failed: Diff read timed out");
    }

    /// Give each file the modification time `seconds` after the epoch, as a
    /// copy, restore or cloud sync does to every file of a repository.
    fn touch(root: &Path, paths: &[&str], seconds: u64) {
        let time = std::time::UNIX_EPOCH + Duration::from_secs(seconds);
        for path in paths {
            std::fs::File::options()
                .write(true)
                .open(root.join(path))
                .unwrap()
                .set_modified(time)
                .unwrap();
        }
    }

    /// Modification second the index caches for `path`.
    async fn cached_mtime(cli: &GitCli, root: &Path, path: &str) -> u64 {
        let debug = git(cli, root, &["ls-files", "--debug", "--", path]).await;
        let line = debug
            .lines()
            .find_map(|line| line.trim().strip_prefix("mtime: "))
            .unwrap();
        line.split(':').next().unwrap().parse().unwrap()
    }

    const NEVER: Duration = Duration::from_secs(3600);

    #[tokio::test]
    async fn a_slow_listed_read_updates_the_index_stat_once_per_interval() {
        let cli = cli();
        let root = repo(&cli, true).await;
        write(root.path(), "notes.md", "notes\n");
        git(&cli, root.path(), &["add", "."]).await;
        git(&cli, root.path(), &["commit", "-m", "Notes"]).await;
        let tracked = ["baseline.md", "notes.md"];
        let interval = Duration::from_secs(600);

        // A fast read writes nothing: reads run without optional locks.
        touch(root.path(), &tracked, 1_000_000_000);
        let fast = listed_status(&cli, root.path(), STATUS_READ_TIMEOUT, NEVER, interval)
            .await
            .unwrap();
        assert_eq!(fast.total_files, 0);
        assert_ne!(
            cached_mtime(&cli, root.path(), "notes.md").await,
            1_000_000_000
        );

        // A slow read records the stat data, so the next read rehashes nothing.
        let slow = listed_status(
            &cli,
            root.path(),
            STATUS_READ_TIMEOUT,
            Duration::ZERO,
            interval,
        )
        .await
        .unwrap();
        assert_eq!(slow.total_files, 0);
        for path in tracked {
            assert_eq!(cached_mtime(&cli, root.path(), path).await, 1_000_000_000);
        }
        let entries = git(&cli, root.path(), &["ls-files", "--stage"]).await;

        // Within the interval another slow read leaves the index alone.
        touch(root.path(), &tracked, 1_100_000_000);
        listed_status(
            &cli,
            root.path(),
            STATUS_READ_TIMEOUT,
            Duration::ZERO,
            interval,
        )
        .await
        .unwrap();
        assert_eq!(
            cached_mtime(&cli, root.path(), "notes.md").await,
            1_000_000_000
        );

        // Past the interval it updates the stat data again.
        listed_status(
            &cli,
            root.path(),
            STATUS_READ_TIMEOUT,
            Duration::ZERO,
            Duration::ZERO,
        )
        .await
        .unwrap();
        assert_eq!(
            cached_mtime(&cli, root.path(), "notes.md").await,
            1_100_000_000
        );
        // Only stat data changed: the staged entries are the same.
        assert_eq!(
            git(&cli, root.path(), &["ls-files", "--stage"]).await,
            entries
        );
        assert_eq!(INDEX_REFRESH_INTERVAL, Duration::from_secs(600));
        assert_eq!(SLOW_STATUS_READ, Duration::from_secs(1));
    }

    #[tokio::test]
    async fn a_held_index_lock_skips_the_update_silently_and_the_next_slow_read_retries() {
        let cli = cli();
        let root = repo(&cli, true).await;
        let interval = Duration::from_secs(600);
        touch(root.path(), &["baseline.md"], 1_000_000_000);
        let lock = root.path().join(".git/index.lock");
        std::fs::write(&lock, "").unwrap();

        let status = listed_status(
            &cli,
            root.path(),
            STATUS_READ_TIMEOUT,
            Duration::ZERO,
            interval,
        )
        .await
        .unwrap();
        assert_eq!(status.total_files, 0);
        assert_ne!(
            cached_mtime(&cli, root.path(), "baseline.md").await,
            1_000_000_000
        );
        assert!(lock.exists(), "the lock of another writer stays");

        // A skipped update does not count toward the interval.
        std::fs::remove_file(&lock).unwrap();
        listed_status(
            &cli,
            root.path(),
            STATUS_READ_TIMEOUT,
            Duration::ZERO,
            interval,
        )
        .await
        .unwrap();
        assert_eq!(
            cached_mtime(&cli, root.path(), "baseline.md").await,
            1_000_000_000
        );
    }

    #[tokio::test]
    async fn a_merge_or_a_detached_head_gets_no_index_update_and_no_error() {
        let cli = cli();
        let merging = repo(&cli, true).await;
        git(&cli, merging.path(), &["checkout", "-b", "other"]).await;
        write(merging.path(), "page.md", "other\n");
        git(&cli, merging.path(), &["add", "."]).await;
        git(&cli, merging.path(), &["commit", "-m", "Other"]).await;
        git(&cli, merging.path(), &["checkout", "-"]).await;
        write(merging.path(), "page.md", "current\n");
        git(&cli, merging.path(), &["add", "."]).await;
        git(&cli, merging.path(), &["commit", "-m", "Current"]).await;
        assert_ne!(
            cli.exec(merging.path(), &["merge", "other"])
                .await
                .unwrap()
                .exit_code,
            0
        );

        let detached = repo(&cli, true).await;
        git(&cli, detached.path(), &["checkout", "--detach"]).await;

        for root in [&merging, &detached] {
            touch(root.path(), &["baseline.md"], 1_000_000_000);
            let status = listed_status(
                &cli,
                root.path(),
                STATUS_READ_TIMEOUT,
                Duration::ZERO,
                Duration::ZERO,
            )
            .await
            .unwrap();
            assert!(!status.files.iter().any(|file| file.path == "baseline.md"));
            assert_ne!(
                cached_mtime(&cli, root.path(), "baseline.md").await,
                1_000_000_000
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_timed_out_listed_read_still_updates_the_index_stat() {
        let cli = cli();
        let root = repo(&cli, true).await;
        let hook = root.path().join(".git/slow-fsmonitor");
        svode_testkit::write_executable(&hook, "#!/bin/sh\nsleep 2\nexit 1\n").unwrap();
        git(
            &cli,
            root.path(),
            &["config", "core.fsmonitor", hook.to_str().unwrap()],
        )
        .await;
        touch(root.path(), &["baseline.md"], 1_000_000_000);

        let error = listed_status(
            &cli,
            root.path(),
            Duration::from_secs(1),
            NEVER,
            Duration::from_secs(600),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(error, GitError::StatusTimedOut { seconds: 1, .. }),
            "{error:?}"
        );
        assert_eq!(
            cached_mtime(&cli, root.path(), "baseline.md").await,
            1_000_000_000
        );
    }

    #[tokio::test]
    async fn reads_status_without_desktop_or_mutating_repository() {
        let repository = tempfile::tempdir().unwrap();
        let cli = GitCli::detect().unwrap();
        assert_eq!(
            cli.exec(repository.path(), &["init"])
                .await
                .unwrap()
                .exit_code,
            0
        );
        std::fs::write(repository.path().join("note.md"), "body").unwrap();
        let before = std::fs::read(repository.path().join("note.md")).unwrap();
        let state = status(&cli, repository.path()).await.unwrap();
        assert!(
            state
                .files
                .iter()
                .any(|file| file.path == "note.md" && file.state == "untracked")
        );
        assert_eq!(
            std::fs::read(repository.path().join("note.md")).unwrap(),
            before
        );
    }
}

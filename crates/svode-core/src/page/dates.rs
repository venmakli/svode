use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};

use super::PageSource;

const GIT_DATE_TIMEOUT_SECS: u64 = 3;
const GIT_DATE_CHUNK_SIZE: usize = 256;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EntryDateOverride {
    pub created: Option<String>,
    pub updated: Option<String>,
}

pub type EntryDateOverrides = HashMap<String, EntryDateOverride>;

pub struct GitDateOutput {
    pub stdout: String,
    pub exit_code: i32,
}

#[allow(async_fn_in_trait)]
pub trait GitDateExecutor {
    async fn exec(&self, directory: &Path, args: &[&str]) -> Option<GitDateOutput>;
}

/// The detected Git CLI is already a date source; a host that holds one does
/// not need a second executor.
impl GitDateExecutor for crate::git::cli::GitCli {
    async fn exec(&self, directory: &Path, args: &[&str]) -> Option<GitDateOutput> {
        let output = crate::git::cli::GitCli::exec(self, directory, args)
            .await
            .ok()?;
        Some(GitDateOutput {
            stdout: output.stdout,
            exit_code: output.exit_code,
        })
    }
}

pub struct SystemGitDateExecutor;

impl GitDateExecutor for SystemGitDateExecutor {
    async fn exec(&self, directory: &Path, args: &[&str]) -> Option<GitDateOutput> {
        let binary = detect_git_binary()?;
        let output = tokio::process::Command::new(binary)
            .args(args)
            .current_dir(directory)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("LC_ALL", "C.UTF-8")
            .kill_on_drop(true)
            .output()
            .await
            .ok()?;
        Some(GitDateOutput {
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            exit_code: output.status.code().unwrap_or(-1),
        })
    }
}

pub fn detect_git_binary() -> Option<PathBuf> {
    if let Ok(path) = which::which("git") {
        return Some(path);
    }
    git_fallback_candidates()
        .into_iter()
        .find(|path| path.is_file())
}

#[cfg(windows)]
fn git_fallback_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(root) = std::env::var_os("ProgramFiles") {
        out.push(PathBuf::from(&root).join("Git/cmd/git.exe"));
        out.push(PathBuf::from(root).join("Git/bin/git.exe"));
    }
    if let Some(root) = std::env::var_os("ProgramFiles(x86)") {
        out.push(PathBuf::from(root).join("Git/cmd/git.exe"));
    }
    if let Some(root) = std::env::var_os("LOCALAPPDATA") {
        out.push(PathBuf::from(root).join("Programs/Git/cmd/git.exe"));
    }
    if let Some(root) = std::env::var_os("USERPROFILE") {
        out.push(PathBuf::from(root).join("scoop/shims/git.exe"));
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

pub fn apply_date_override(
    created: &mut String,
    updated: &mut String,
    override_dates: Option<&EntryDateOverride>,
) {
    if let Some(dates) = override_dates {
        if let Some(value) = &dates.created {
            *created = value.clone();
        }
        if let Some(value) = &dates.updated {
            *updated = value.clone();
        }
    }
}

pub async fn enrich_source_git_dates(source: &mut PageSource) {
    let overrides = derive_date_overrides(
        &SystemGitDateExecutor,
        &source.target.space,
        &[source.target.path.clone()],
    )
    .await;
    apply_date_override(
        &mut source.created,
        &mut source.updated,
        overrides.get(&source.target.path),
    );
}

pub async fn derive_date_overrides<E: GitDateExecutor>(
    executor: &E,
    space: &Path,
    paths: &[String],
) -> EntryDateOverrides {
    let mut paths = paths
        .iter()
        .filter_map(|path| normalized_path(path))
        .collect::<Vec<_>>();
    paths.sort();
    paths.dedup();
    if paths.is_empty() {
        return EntryDateOverrides::new();
    }
    let Some(prefix) = run(executor, space, &["rev-parse", "--show-prefix"])
        .await
        .filter(|out| out.exit_code == 0)
        .map(|out| out.stdout.trim().replace('\\', "/"))
    else {
        return EntryDateOverrides::new();
    };
    let shallow = run(executor, space, &["rev-parse", "--is-shallow-repository"]).await;
    if shallow.is_none_or(|out| out.exit_code == 0 && out.stdout.trim() == "true") {
        return EntryDateOverrides::new();
    }
    let Some(dirty) = dirty_status(executor, space, &prefix, &paths).await else {
        return EntryDateOverrides::new();
    };
    log_dates(executor, space, &paths, &dirty).await
}

async fn run<E: GitDateExecutor>(
    executor: &E,
    space: &Path,
    args: &[&str],
) -> Option<GitDateOutput> {
    tokio::time::timeout(
        Duration::from_secs(GIT_DATE_TIMEOUT_SECS),
        executor.exec(space, args),
    )
    .await
    .ok()
    .flatten()
}

async fn dirty_status<E: GitDateExecutor>(
    executor: &E,
    space: &Path,
    prefix: &str,
    paths: &[String],
) -> Option<HashSet<String>> {
    let mut dirty = HashSet::new();
    for chunk in paths.chunks(GIT_DATE_CHUNK_SIZE) {
        let mut args = vec!["status", "--porcelain=v2", "-z", "--"];
        args.extend(chunk.iter().map(String::as_str));
        let output = run(executor, space, &args).await?;
        if output.exit_code != 0 {
            return None;
        }
        parse_status_paths(&output.stdout, prefix, &mut dirty);
    }
    Some(dirty)
}

async fn log_dates<E: GitDateExecutor>(
    executor: &E,
    space: &Path,
    paths: &[String],
    dirty: &HashSet<String>,
) -> EntryDateOverrides {
    let mut overrides = EntryDateOverrides::new();
    for chunk in paths.chunks(GIT_DATE_CHUNK_SIZE) {
        let mut args = vec![
            "log",
            "--relative",
            "--date=iso-strict",
            "--format=format:%x1e%cI%x00",
            "--name-only",
            "-z",
            "--",
        ];
        args.extend(chunk.iter().map(String::as_str));
        let Some(output) = run(executor, space, &args).await else {
            break;
        };
        if output.exit_code == 0 {
            parse_log_paths(&output.stdout, dirty, &mut overrides);
        }
    }
    overrides
}

fn parse_status_paths(stdout: &str, prefix: &str, dirty: &mut HashSet<String>) {
    let records = stdout.split('\0').collect::<Vec<_>>();
    let mut index = 0;
    while index < records.len() {
        let record = records[index];
        index += 1;
        if record.is_empty() || record.starts_with("# ") {
            continue;
        }
        let path = if let Some(path) = record.strip_prefix("? ") {
            Some(path)
        } else if record.starts_with("1 ") {
            record.splitn(9, ' ').nth(8)
        } else if record.starts_with("2 ") {
            let path = record.splitn(10, ' ').nth(9);
            if index < records.len() && !records[index].is_empty() {
                index += 1;
            }
            path
        } else if record.starts_with("u ") {
            record.splitn(11, ' ').nth(10)
        } else {
            None
        };
        if let Some(path) = path.and_then(|path| strip_git_prefix(path, prefix)) {
            dirty.insert(path);
        }
    }
}

fn strip_git_prefix(path: &str, prefix: &str) -> Option<String> {
    let path = path.replace('\\', "/");
    let path = path.trim_end_matches('/');
    let path = if prefix.is_empty() {
        path
    } else {
        path.strip_prefix(prefix)?
    };
    normalized_path(path)
}

fn parse_log_paths(stdout: &str, dirty: &HashSet<String>, overrides: &mut EntryDateOverrides) {
    for segment in stdout.split('\x1e').skip(1) {
        let mut records = segment.split('\0');
        let Some(date) = records
            .next()
            .and_then(|date| normalize_git_date(date.trim()))
        else {
            continue;
        };
        for path in records {
            let Some(path) = normalized_path(path.trim_matches('\n')) else {
                continue;
            };
            let dates = overrides.entry(path.clone()).or_default();
            dates.created = Some(date.clone());
            if !dirty.contains(&path) && dates.updated.is_none() {
                dates.updated = Some(date.clone());
            }
        }
    }
}

fn normalized_path(path: &str) -> Option<String> {
    let path = path.replace('\\', "/");
    if path.is_empty()
        || path.starts_with('/')
        || path.as_bytes().get(1) == Some(&b':')
        || path
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        None
    } else {
        Some(path)
    }
}

fn normalize_git_date(value: &str) -> Option<String> {
    DateTime::parse_from_rfc3339(value).ok().map(|date| {
        date.with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Secs, true)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_dirty_status_relative_to_inline_space() {
        let stdout = concat!(
            "1 .M N... 100644 100644 100644 abc abc child/a.md\0",
            "? child/new.md\0",
            "2 R. N... 100644 100644 100644 abc abc R100 child/renamed.md\0child/old.md\0",
        );
        let mut dirty = HashSet::new();
        parse_status_paths(stdout, "child/", &mut dirty);
        assert!(dirty.contains("a.md"));
        assert!(dirty.contains("new.md"));
        assert!(dirty.contains("renamed.md"));
        assert!(!dirty.contains("child/a.md"));
    }

    #[test]
    fn uses_first_commit_for_created_and_skips_dirty_updated() {
        let stdout = concat!(
            "\x1e2026-02-02T12:00:00+02:00\0\nb.md\0a.md\0\0",
            "\x1e2026-01-01T05:00:00+02:00\0\na.md\0\0",
        );
        let dirty = HashSet::from(["a.md".to_string()]);
        let mut dates = EntryDateOverrides::new();
        parse_log_paths(stdout, &dirty, &mut dates);
        assert_eq!(
            dates.get("a.md").unwrap().created.as_deref(),
            Some("2026-01-01T03:00:00Z")
        );
        assert_eq!(dates.get("a.md").unwrap().updated, None);
        assert_eq!(
            dates.get("b.md").unwrap().updated.as_deref(),
            Some("2026-02-02T10:00:00Z")
        );
    }
}

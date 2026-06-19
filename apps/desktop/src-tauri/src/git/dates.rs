use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};

use super::cli::{GitCli, GitOutput};
use crate::repo_path::{RootMode, normalize_repo_relative};

const GIT_DATE_TIMEOUT_SECS: u64 = 3;
const GIT_DATE_CHUNK_SIZE: usize = 256;

static GIT_CLI: OnceLock<Option<GitCli>> = OnceLock::new();

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct EntryDateOverride {
    pub created: Option<String>,
    pub updated: Option<String>,
}

pub(crate) type EntryDateOverrides = HashMap<String, EntryDateOverride>;

#[derive(Default)]
struct DirtyStatus {
    dirty: HashSet<String>,
}

pub(crate) async fn derive_date_overrides(
    space_dir: &Path,
    rel_paths: &[String],
) -> EntryDateOverrides {
    let Some(cli) = cached_git_cli() else {
        return EntryDateOverrides::new();
    };
    derive_date_overrides_with_cli(&cli, space_dir, rel_paths).await
}

fn cached_git_cli() -> Option<GitCli> {
    GIT_CLI.get_or_init(|| GitCli::detect().ok()).clone()
}

pub(crate) async fn derive_date_overrides_with_cli(
    cli: &GitCli,
    space_dir: &Path,
    rel_paths: &[String],
) -> EntryDateOverrides {
    let rel_paths = normalize_rel_paths(rel_paths);
    if rel_paths.is_empty() {
        return EntryDateOverrides::new();
    }

    let Some(prefix) = git_prefix(cli, space_dir).await else {
        return EntryDateOverrides::new();
    };
    let use_git_created = !is_shallow_repository(cli, space_dir).await.unwrap_or(false);
    let Some(status) = dirty_status(cli, space_dir, &prefix, &rel_paths).await else {
        return EntryDateOverrides::new();
    };

    log_date_overrides(cli, space_dir, &rel_paths, &status.dirty, use_git_created).await
}

fn normalize_rel_paths(rel_paths: &[String]) -> Vec<String> {
    let mut out = rel_paths
        .iter()
        .filter_map(|path| normalize_repo_relative(path, RootMode::Reject).ok())
        .collect::<Vec<_>>();
    out.sort();
    out.dedup();
    out
}

async fn git_prefix(cli: &GitCli, space_dir: &Path) -> Option<String> {
    let args = vec!["rev-parse".to_string(), "--show-prefix".to_string()];
    let out = exec_timeout(cli, space_dir, &args).await?;
    if out.exit_code != 0 {
        return None;
    }
    Some(out.stdout.trim().replace('\\', "/"))
}

async fn is_shallow_repository(cli: &GitCli, space_dir: &Path) -> Option<bool> {
    let args = vec![
        "rev-parse".to_string(),
        "--is-shallow-repository".to_string(),
    ];
    let out = exec_timeout(cli, space_dir, &args).await?;
    if out.exit_code != 0 {
        return Some(false);
    }
    Some(out.stdout.trim() == "true")
}

async fn dirty_status(
    cli: &GitCli,
    space_dir: &Path,
    prefix: &str,
    rel_paths: &[String],
) -> Option<DirtyStatus> {
    let mut status = DirtyStatus::default();
    for chunk in rel_paths.chunks(GIT_DATE_CHUNK_SIZE) {
        let mut args = vec![
            "status".to_string(),
            "--porcelain=v2".to_string(),
            "-z".to_string(),
            "--".to_string(),
        ];
        args.extend(chunk.iter().cloned());
        let out = exec_timeout(cli, space_dir, &args).await?;
        if out.exit_code != 0 {
            return None;
        }
        parse_status_paths(&out.stdout, prefix, &mut status);
    }
    Some(status)
}

async fn log_date_overrides(
    cli: &GitCli,
    space_dir: &Path,
    rel_paths: &[String],
    dirty_paths: &HashSet<String>,
    use_git_created: bool,
) -> EntryDateOverrides {
    let mut overrides = EntryDateOverrides::new();
    for chunk in rel_paths.chunks(GIT_DATE_CHUNK_SIZE) {
        let mut args = vec![
            "log".to_string(),
            "--relative".to_string(),
            "--date=iso-strict".to_string(),
            "--format=format:%x1e%cI%x00".to_string(),
            "--name-only".to_string(),
            "-z".to_string(),
            "--".to_string(),
        ];
        args.extend(chunk.iter().cloned());
        let Some(out) = exec_timeout(cli, space_dir, &args).await else {
            break;
        };
        if out.exit_code != 0 {
            continue;
        }
        parse_log_paths(&out.stdout, dirty_paths, use_git_created, &mut overrides);
    }
    overrides
}

async fn exec_timeout(cli: &GitCli, space_dir: &Path, args: &[String]) -> Option<GitOutput> {
    let arg_refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    match tokio::time::timeout(
        Duration::from_secs(GIT_DATE_TIMEOUT_SECS),
        cli.exec(space_dir, &arg_refs),
    )
    .await
    {
        Ok(Ok(out)) => Some(out),
        Ok(Err(error)) => {
            tracing::debug!(
                "git date command failed in {}: {error}",
                space_dir.display()
            );
            None
        }
        Err(_) => {
            tracing::warn!("git date command timed out in {}", space_dir.display());
            None
        }
    }
}

fn parse_status_paths(stdout: &str, prefix: &str, status: &mut DirtyStatus) {
    let records = stdout.split('\0').collect::<Vec<_>>();
    let mut idx = 0;
    while idx < records.len() {
        let record = records[idx];
        idx += 1;
        if record.is_empty() || record.starts_with("# ") {
            continue;
        }

        if let Some(path) = status_path(record, &mut idx, &records) {
            if let Some(path) = strip_git_prefix(path, prefix) {
                status.dirty.insert(path);
            }
        }
    }
}

fn status_path<'a>(record: &'a str, idx: &mut usize, records: &[&'a str]) -> Option<&'a str> {
    if let Some(path) = record.strip_prefix("? ") {
        return Some(path);
    }
    if record.starts_with("1 ") {
        return record.splitn(9, ' ').nth(8);
    }
    if record.starts_with("2 ") {
        let path = record.splitn(10, ' ').nth(9);
        if *idx < records.len() && !records[*idx].is_empty() {
            *idx += 1;
        }
        return path;
    }
    if record.starts_with("u ") {
        return record.splitn(11, ' ').nth(10);
    }
    None
}

fn strip_git_prefix(path: &str, prefix: &str) -> Option<String> {
    let path = path.replace('\\', "/");
    let path = path.trim_end_matches('/');
    let path = if prefix.is_empty() {
        path
    } else {
        path.strip_prefix(prefix)?
    };
    normalize_repo_relative(path, RootMode::Reject).ok()
}

fn parse_log_paths(
    stdout: &str,
    dirty_paths: &HashSet<String>,
    use_git_created: bool,
    overrides: &mut EntryDateOverrides,
) {
    for segment in stdout.split('\x1e').skip(1) {
        let mut records = segment.split('\0');
        let Some(raw_date) = records.next() else {
            continue;
        };
        let Some(date) = normalize_git_date(raw_date.trim()) else {
            continue;
        };

        for raw_path in records {
            let raw_path = raw_path.trim_start_matches('\n').trim_end_matches('\n');
            if raw_path.is_empty() {
                continue;
            }
            let Ok(path) = normalize_repo_relative(raw_path, RootMode::Reject) else {
                continue;
            };
            let date_override = overrides.entry(path.clone()).or_default();
            if use_git_created {
                date_override.created = Some(date.clone());
            }
            if !dirty_paths.contains(&path) && date_override.updated.is_none() {
                date_override.updated = Some(date.clone());
            }
        }
    }
}

fn normalize_git_date(value: &str) -> Option<String> {
    DateTime::parse_from_rfc3339(value).ok().map(|dt| {
        dt.with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Secs, true)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn parses_dirty_status_relative_to_space_dir() {
        let stdout = concat!(
            "1 .M N... 100644 100644 100644 abc abc child/a.md\0",
            "? child/new.md\0",
            "2 R. N... 100644 100644 100644 abc abc R100 child/renamed.md\0child/old.md\0"
        );
        let mut status = DirtyStatus::default();

        parse_status_paths(stdout, "child/", &mut status);

        assert!(status.dirty.contains("a.md"));
        assert!(status.dirty.contains("new.md"));
        assert!(status.dirty.contains("renamed.md"));
        assert!(!status.dirty.contains("child/a.md"));
    }

    #[test]
    fn parses_log_dates_as_utc_and_preserves_dirty_updated_fallback() {
        let stdout = concat!(
            "\x1e2026-02-02T12:00:00+02:00\0\nb.md\0a.md\0\0",
            "\x1e2026-01-01T05:00:00+02:00\0\na.md\0\0"
        );
        let dirty_paths = HashSet::from(["a.md".to_string()]);
        let mut overrides = EntryDateOverrides::new();

        parse_log_paths(stdout, &dirty_paths, true, &mut overrides);

        assert_eq!(
            overrides.get("b.md"),
            Some(&EntryDateOverride {
                created: Some("2026-02-02T10:00:00Z".to_string()),
                updated: Some("2026-02-02T10:00:00Z".to_string()),
            })
        );
        assert_eq!(
            overrides.get("a.md"),
            Some(&EntryDateOverride {
                created: Some("2026-01-01T03:00:00Z".to_string()),
                updated: None,
            })
        );
    }

    #[tokio::test]
    async fn derives_dates_from_git_history_for_clean_tracked_files() {
        let Ok(cli) = GitCli::detect() else {
            return;
        };
        let tmp = TempDir::new().unwrap();
        let first = "2026-01-01T00:00:00Z";
        let second = "2026-02-03T04:05:06Z";

        assert_eq!(cli.exec(tmp.path(), &["init"]).await.unwrap().exit_code, 0);
        assert_eq!(
            cli.exec(tmp.path(), &["config", "user.email", "test@example.com"])
                .await
                .unwrap()
                .exit_code,
            0
        );
        assert_eq!(
            cli.exec(tmp.path(), &["config", "user.name", "Test User"])
                .await
                .unwrap()
                .exit_code,
            0
        );

        fs::write(tmp.path().join("note.md"), "one").unwrap();
        assert_eq!(
            cli.exec(tmp.path(), &["add", "note.md"])
                .await
                .unwrap()
                .exit_code,
            0
        );
        assert_eq!(
            cli.exec_with_env(
                tmp.path(),
                &["commit", "-m", "Add note"],
                &[("GIT_AUTHOR_DATE", first), ("GIT_COMMITTER_DATE", first)],
            )
            .await
            .unwrap()
            .exit_code,
            0
        );

        fs::write(tmp.path().join("note.md"), "two").unwrap();
        assert_eq!(
            cli.exec(tmp.path(), &["add", "note.md"])
                .await
                .unwrap()
                .exit_code,
            0
        );
        assert_eq!(
            cli.exec_with_env(
                tmp.path(),
                &["commit", "-m", "Update note"],
                &[("GIT_AUTHOR_DATE", second), ("GIT_COMMITTER_DATE", second)],
            )
            .await
            .unwrap()
            .exit_code,
            0
        );

        let overrides =
            derive_date_overrides_with_cli(&cli, tmp.path(), &["note.md".to_string()]).await;

        assert_eq!(
            overrides.get("note.md"),
            Some(&EntryDateOverride {
                created: Some(first.to_string()),
                updated: Some(second.to_string()),
            })
        );
    }
}

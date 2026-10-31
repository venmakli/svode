//! The changes a version commits, as Git sees the prepared index against
//! HEAD, and the two versions of the sources facts are read from.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::super::GitError;
use super::super::cli::{GitCli, literal_pathspecs, read_with_input};
use super::super::diagnostics::GitStage;
use super::super::staging;

/// Largest source a fact is read from.
const SOURCE_BYTES: u64 = 1024 * 1024;
/// Sources one commit reads from HEAD for its facts.
const HEAD_SOURCES: usize = 400;
const HEAD_BYTES: usize = 32 * 1024 * 1024;
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

/// One changed path; a rename carries the path it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathChange {
    pub status: ChangeStatus,
    pub path: String,
    pub from: Option<String>,
    /// A Space pointer: a submodule entry on either side.
    pub gitlink: bool,
}

impl PathChange {
    /// Every path the change touches: its own and a rename's source.
    pub fn paths(&self) -> impl Iterator<Item = &str> {
        std::iter::once(self.path.as_str()).chain(self.from.as_deref())
    }
}

/// The staged changes at `paths`, with renames paired among them.
pub(crate) async fn staged(
    cli: &GitCli,
    repo: &Path,
    paths: &[String],
) -> Result<Vec<PathChange>, GitError> {
    let literals = literal_pathspecs(paths);
    let mut changes = Vec::new();
    // Renames pair within one batch; a path set within the budget is one.
    for args in cli.path_batches(
        &[
            "diff",
            "--cached",
            "--raw",
            "-z",
            "-M",
            "--no-ext-diff",
            "--",
        ],
        &literals,
    ) {
        let out = staging::exec(cli, repo, &args, GitStage::Commit, paths).await?;
        if out.exit_code != 0 {
            return Err(staging::failure(
                repo,
                GitStage::Commit,
                "inventory_failed",
                Some(out.exit_code),
                paths,
            ));
        }
        changes.extend(parse_raw(&out.stdout));
    }
    Ok(changes)
}

/// Records of `git diff --raw -z`: `:<mode> <mode> <oid> <oid> <status>`,
/// then the path, and for a rename or copy the source before it.
pub(crate) fn parse_raw(stdout: &str) -> Vec<PathChange> {
    let mut tokens = stdout.split('\0').filter(|token| !token.is_empty());
    let mut changes = Vec::new();
    while let Some(header) = tokens.next() {
        let Some(header) = header.strip_prefix(':') else {
            continue;
        };
        let fields = header.split(' ').collect::<Vec<_>>();
        let (Some(old_mode), Some(new_mode), Some(status)) =
            (fields.first(), fields.get(1), fields.get(4))
        else {
            continue;
        };
        let gitlink = *old_mode == "160000" || *new_mode == "160000";
        let Some(first) = tokens.next() else {
            break;
        };
        let change = match status.chars().next() {
            Some('R') => {
                let Some(path) = tokens.next() else {
                    break;
                };
                PathChange {
                    status: ChangeStatus::Renamed,
                    path: path.to_string(),
                    from: Some(first.to_string()),
                    gitlink,
                }
            }
            Some('C') => {
                let Some(path) = tokens.next() else {
                    break;
                };
                PathChange {
                    status: ChangeStatus::Added,
                    path: path.to_string(),
                    from: None,
                    gitlink,
                }
            }
            Some('A') => PathChange {
                status: ChangeStatus::Added,
                path: first.to_string(),
                from: None,
                gitlink,
            },
            Some('D') => PathChange {
                status: ChangeStatus::Deleted,
                path: first.to_string(),
                from: None,
                gitlink,
            },
            _ => PathChange {
                status: ChangeStatus::Modified,
                path: first.to_string(),
                from: None,
                gitlink,
            },
        };
        changes.push(change);
    }
    changes
}

/// The sources facts compare: HEAD's, read once for a commit, and the
/// working tree's, which the verified index holds.
pub(crate) struct Sources {
    repo: PathBuf,
    head: HashMap<String, String>,
}

impl Sources {
    /// Read the HEAD versions of the Pages and schemas `changes` touch and of
    /// the folder READMEs that name their places.
    pub(crate) async fn read(cli: &GitCli, repo: &Path, changes: &[PathChange]) -> Self {
        let mut wanted = Vec::<String>::new();
        let mut want = |path: String| {
            if !wanted.contains(&path) && !path.contains('\n') {
                wanted.push(path);
            }
        };
        for change in changes {
            for path in change.paths() {
                if path.ends_with(".md") || path.ends_with("schema.yaml") {
                    want(path.to_string());
                }
            }
        }
        wanted.truncate(HEAD_SOURCES);
        let head = head_blobs(cli, repo, &wanted).await;
        Self {
            repo: repo.to_path_buf(),
            head,
        }
    }

    #[cfg(test)]
    pub(crate) fn of(repo: &Path, head: HashMap<String, String>) -> Self {
        Self {
            repo: repo.to_path_buf(),
            head,
        }
    }

    pub(crate) fn head(&self, path: &str) -> Option<&str> {
        self.head.get(path).map(String::as_str)
    }

    pub(crate) fn work(&self, path: &str) -> Option<String> {
        let file = self.repo.join(path);
        let metadata = std::fs::symlink_metadata(&file).ok()?;
        if !metadata.is_file() || metadata.len() > SOURCE_BYTES {
            return None;
        }
        std::fs::read_to_string(file).ok()
    }
}

/// The UTF-8 HEAD blobs at `paths`; a path missing in HEAD, binary or over
/// the limits is left out.
async fn head_blobs(cli: &GitCli, repo: &Path, paths: &[String]) -> HashMap<String, String> {
    let mut blobs = HashMap::new();
    if paths.is_empty() {
        return blobs;
    }
    let input = paths
        .iter()
        .map(|path| format!("HEAD:{path}\n"))
        .collect::<String>();
    let Ok(Some(output)) = read_with_input(
        cli,
        repo,
        &["cat-file", "--batch"],
        input.as_bytes(),
        HEAD_BYTES,
        HEAD_TIMEOUT,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_records_carry_status_rename_source_and_gitlinks() {
        let stdout = ":100644 100644 a b M\0notes/a.md\0\
                      :000000 100644 0 c A\0new.md\0\
                      :100644 000000 d 0 D\0old.md\0\
                      :100644 100644 e f R087\0Draft.md\0Final.md\0\
                      :160000 160000 g h M\0spaces/docs\0";
        let changes = parse_raw(stdout);
        assert_eq!(changes.len(), 5);
        assert_eq!(changes[0].status, ChangeStatus::Modified);
        assert_eq!(changes[1].status, ChangeStatus::Added);
        assert_eq!(changes[2].status, ChangeStatus::Deleted);
        assert_eq!(changes[3].status, ChangeStatus::Renamed);
        assert_eq!(changes[3].path, "Final.md");
        assert_eq!(changes[3].from.as_deref(), Some("Draft.md"));
        assert!(changes[4].gitlink);
        assert!(!changes[0].gitlink);
    }
}

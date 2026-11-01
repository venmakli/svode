//! A conflicted path merged again from its index stages (module 01, 1.F
//! п. 1): the versions of the base (stage 1), mine (2) and the incoming side
//! (3) merged as text by `git merge-file` with the conflict markers of the
//! size of the path. The working file takes no part, so an edit of it — a
//! resolution not finished yet, a choice the editor wrote — does not change
//! the result while the stages stand.
//!
//! Git merges with the histogram diff by default (merge-ort); `merge-file`
//! takes it from Git 2.44, an older Git merges with its own default. A merge
//! with other strategy options, renormalization, a merge driver or a filter
//! besides line endings is not repeated exactly.

use std::path::Path;
use std::time::Duration;

use super::GitError;
use super::cli::{GitCli, read_with_input};
use super::service_merge::{ConflictedPath, StageEntry};
use super::version::GitVersion;

/// A version of a side larger than this is not merged.
pub const MAX_STAGE: usize = 4 * 1024 * 1024;
/// How long reading the versions of a path may take.
const READ_TIMEOUT: Duration = Duration::from_secs(10);
/// `git merge-file --diff-algorithm` arrived in Git 2.44.
const DIFF_ALGORITHM: GitVersion = GitVersion::new(2, 44, 0);

/// How the merge writes the sides of a conflict.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictStyle {
    /// Mine, then the incoming side.
    Merge,
    /// Mine, the base after a `|` line, then the incoming side.
    Diff3,
}

impl ConflictStyle {
    fn config(self) -> &'static str {
        match self {
            Self::Merge => "merge.conflictStyle=merge",
            Self::Diff3 => "merge.conflictStyle=diff3",
        }
    }
}

/// The versions of the sides of a conflicted path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageTexts {
    /// The base; `None` when both sides added the path (add/add).
    pub base: Option<Vec<u8>>,
    pub ours: Vec<u8>,
    pub theirs: Vec<u8>,
}

/// The versions of the stages of `conflict` in `repo`, `None` when a side
/// lacks the path, a stage is not a regular file, or a version is larger
/// than [`MAX_STAGE`] or cannot be read in time.
pub async fn read_stages(
    cli: &GitCli,
    repo: &Path,
    conflict: &ConflictedPath,
) -> Result<Option<StageTexts>, GitError> {
    let (Some(ours), Some(theirs)) = (&conflict.ours, &conflict.theirs) else {
        return Ok(None);
    };
    let stages: Vec<&StageEntry> = conflict.base.iter().chain([ours, theirs]).collect();
    if !stages.iter().all(|stage| stage.is_regular_file()) {
        return Ok(None);
    }
    let input: String = stages
        .iter()
        .map(|stage| format!("{}\n", stage.oid))
        .collect();
    let Some(output) = read_with_input(
        cli,
        repo,
        &["cat-file", "--batch"],
        input.as_bytes(),
        stages.len() * (MAX_STAGE + 128),
        READ_TIMEOUT,
    )
    .await?
    else {
        return Ok(None);
    };
    let mut rest = output.as_slice();
    let mut versions = Vec::with_capacity(stages.len());
    for stage in &stages {
        let malformed = || {
            GitError::GitCommandFailed(format!(
                "git cat-file returned no blob for {} of {}",
                stage.oid, conflict.path
            ))
        };
        let end = rest
            .iter()
            .position(|byte| *byte == b'\n')
            .ok_or_else(malformed)?;
        let header = String::from_utf8_lossy(&rest[..end]).into_owned();
        rest = &rest[end + 1..];
        let size = match header.split(' ').collect::<Vec<_>>()[..] {
            [_, "blob", size] => size.parse::<usize>().map_err(|_| malformed())?,
            _ => return Err(malformed()),
        };
        if size > MAX_STAGE {
            return Ok(None);
        }
        if rest.len() <= size {
            return Err(malformed());
        }
        versions.push(rest[..size].to_vec());
        rest = &rest[size + 1..];
    }
    let theirs = versions.pop().ok_or_else(|| missing(conflict))?;
    let ours = versions.pop().ok_or_else(|| missing(conflict))?;
    Ok(Some(StageTexts {
        base: versions.pop(),
        ours,
        theirs,
    }))
}

fn missing(conflict: &ConflictedPath) -> GitError {
    GitError::GitCommandFailed(format!("No versions of {} were read", conflict.path))
}

/// `texts` merged as Git merges a path of `repo`: conflict markers of
/// `size` in `style`, an empty base when the sides added the path.
pub async fn merge_texts(
    cli: &GitCli,
    repo: &Path,
    texts: &StageTexts,
    size: usize,
    style: ConflictStyle,
) -> Result<Vec<u8>, GitError> {
    let dir = tempfile::tempdir()?;
    let file = |name: &str, content: &[u8]| -> Result<String, GitError> {
        let path = dir.path().join(name);
        std::fs::write(&path, content)?;
        path.into_os_string()
            .into_string()
            .map_err(|path| GitError::PathNotAccessible(Path::new(&path).display().to_string()))
    };
    let ours = file("ours", &texts.ours)?;
    let base = file("base", texts.base.as_deref().unwrap_or_default())?;
    let theirs = file("theirs", &texts.theirs)?;
    let marker_size = format!("--marker-size={size}");
    // The style of the config of the repository would win over no flag.
    let mut args = vec![
        "-c",
        style.config(),
        "merge-file",
        marker_size.as_str(),
        "-L",
        "ours",
        "-L",
        "base",
        "-L",
        "theirs",
    ];
    if cli
        .version()
        .is_some_and(|version| version >= DIFF_ALGORITHM)
    {
        args.push("--diff-algorithm=histogram");
    }
    args.extend([ours.as_str(), base.as_str(), theirs.as_str()]);
    // The result replaces mine; the exit code is the number of conflicts,
    // capped at 127, and a negative one is an error.
    let out = cli.exec(repo, &args).await?;
    if !(0..=127).contains(&out.exit_code) {
        return Err(GitError::GitCommandFailed(format!(
            "git merge-file failed: {}",
            out.stderr.trim()
        )));
    }
    Ok(std::fs::read(&ours)?)
}

/// The stages of `conflict` in `repo` merged by [`merge_texts`], `None`
/// when [`read_stages`] gives no versions.
pub async fn merge_stages(
    cli: &GitCli,
    repo: &Path,
    conflict: &ConflictedPath,
    size: usize,
    style: ConflictStyle,
) -> Result<Option<Vec<u8>>, GitError> {
    let Some(texts) = read_stages(cli, repo, conflict).await? else {
        return Ok(None);
    };
    merge_texts(cli, repo, &texts, size, style).await.map(Some)
}

#[cfg(all(test, unix))]
#[path = "stage_merge_tests.rs"]
pub(crate) mod tests;

//! What a failed Git save or sync tells the user: the repository by its name,
//! the stage and the recognized cause. Stderr, absolute paths and secrets stay
//! out of the value; a caller that keeps stderr for diagnosis logs it redacted.

use std::fmt;
use std::path::Path;

use serde::Serialize;

/// The step of a save or sync that failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitStage {
    /// Staging the selected paths into the index.
    Prepare,
    /// Checking that the index holds what was prepared.
    Verify,
    /// Writing a commit: a save, or the merge commit of a resolved sync.
    Commit,
    /// Receiving the remote branch.
    Fetch,
    /// Bringing the received revision into the current branch.
    Integrate,
    /// Publishing the current branch.
    Push,
    /// Aborting a stopped rebase, cherry-pick, revert or sequencer (1.F).
    Abort,
}

impl GitStage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Prepare => "prepare",
            Self::Verify => "verify",
            Self::Commit => "commit",
            Self::Fetch => "fetch",
            Self::Integrate => "integrate",
            Self::Push => "push",
            Self::Abort => "abort",
        }
    }
}

impl fmt::Display for GitStage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Why a Git command failed, recognized from its output. An unrecognized
/// failure has no cause rather than a guessed one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitFailureCause {
    /// A hook of the repository declined: pre-commit, commit-msg, pre-push…
    Hook,
    /// Commit signing failed.
    Signing,
    /// Git has no author or committer name and email.
    Identity,
    /// Another Git process holds `index.lock`, or a stale one is left behind.
    IndexLocked,
    /// The file system refused Git a file of the repository.
    FileSystemDenied,
    /// The remote could not be reached.
    Network,
    /// Git refused to overwrite changes of the working tree: files edited
    /// after an operation stopped, or untracked files in its way.
    LocalChanges,
    /// HEAD moved after a sequence of cherry-picks or reverts stopped, so
    /// Git would not rewind the branch; found by Svode before Git runs.
    HeadMoved,
}

impl GitFailureCause {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hook => "hook",
            Self::Signing => "signing",
            Self::Identity => "identity",
            Self::IndexLocked => "index_locked",
            Self::FileSystemDenied => "file_system_denied",
            Self::Network => "network",
            Self::LocalChanges => "local_changes",
            Self::HeadMoved => "head_moved",
        }
    }

    /// A cause of this device that says nothing about access to the remote.
    pub fn is_local(self) -> bool {
        !matches!(self, Self::Network)
    }
}

/// The reusable description of a failed save or sync step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFailure {
    /// The Space or project name of the repository, never a path.
    pub repository: String,
    pub stage: GitStage,
    pub cause: Option<GitFailureCause>,
}

impl GitFailure {
    /// The failure of `stage` in `repo` whose Git command wrote `stderr`;
    /// `hook_failed` is what a [`HookTrace`] of the command observed.
    pub fn from_output(repo: &Path, stage: GitStage, stderr: &str, hook_failed: bool) -> Self {
        Self {
            repository: repository_name(repo),
            stage,
            cause: cause(stderr, hook_failed),
        }
    }
}

impl fmt::Display for GitFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} during {}", self.repository, self.stage)?;
        if let Some(cause) = self.cause {
            write!(f, " ({})", cause.as_str())?;
        }
        Ok(())
    }
}

/// The repository a Git error names: its Space or project name, else its
/// folder name, never an absolute path.
pub fn repository_name(repo: &Path) -> String {
    crate::storage::config::read_space_assets_config(repo)
        .map(|config| config.name)
        .ok()
        .filter(|name| !name.trim().is_empty())
        .or_else(|| {
            std::fs::canonicalize(repo).ok().and_then(|path| {
                path.file_name()
                    .map(|name| name.to_string_lossy().into_owned())
            })
        })
        .unwrap_or_else(|| "repository".into())
}

/// The cause of a failed Git command from its stderr, read with `LC_ALL=C`.
/// A failed hook is decisive: Git stops right after it and prints nothing of
/// its own, while the hook may print anything. Only an unreachable remote is
/// told apart, since the git-lfs transfer of a push runs in its pre-push hook.
pub fn cause(stderr: &str, hook_failed: bool) -> Option<GitFailureCause> {
    let lower = stderr.to_ascii_lowercase();
    if hook_failed {
        return Some(if is_network_failure(&lower) {
            GitFailureCause::Network
        } else {
            GitFailureCause::Hook
        });
    }
    if lower.contains("index.lock") && lower.contains("file exists") {
        Some(GitFailureCause::IndexLocked)
    } else if is_file_system_denial(&lower) {
        Some(GitFailureCause::FileSystemDenied)
    } else if [
        "author identity unknown",
        "committer identity unknown",
        "please tell me who you are",
        "empty ident name",
        "unable to auto-detect email address",
        "no email was given and auto-detection is disabled",
        "no name was given and auto-detection is disabled",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
    {
        Some(GitFailureCause::Identity)
    } else if [
        "gpg failed to sign",
        "failed to sign the data",
        "couldn't load public key",
        "ssh-keygen -y sign",
        // Git's own last word when a signature could not be made.
        "failed to write commit object",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
    {
        Some(GitFailureCause::Signing)
    } else if is_network_failure(&lower) {
        Some(GitFailureCause::Network)
    } else if [
        "not uptodate. cannot merge",
        "would be overwritten by",
        "would be removed by",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
    {
        Some(GitFailureCause::LocalChanges)
    } else {
        None
    }
}

/// The remote could not be reached; `detail` is lowercase.
pub fn is_network_failure(detail: &str) -> bool {
    [
        "could not resolve host",
        "connection timed out",
        "operation timed out",
        "network is unreachable",
        "connection refused",
        "connection reset",
        "remote end hung up unexpectedly",
    ]
    .iter()
    .any(|marker| detail.contains(marker))
}

/// A line where Git reports that the file system refused it a file: Git
/// appends the OS error to a local diagnostic, so the line ends with it. SSH
/// (`Permission denied (publickey).`) and remote (`remote: Permission
/// denied`) refusals are authorization, not the file system.
fn is_file_system_line(line: &str) -> bool {
    let line = line.trim().to_ascii_lowercase();
    !line.starts_with("remote:")
        && (line.ends_with(": permission denied")
            || line.ends_with(": operation not permitted")
            || line.contains("insufficient permission for adding an object"))
}

/// Whether any line of `stderr` is a file system refusal.
pub fn is_file_system_denial(stderr: &str) -> bool {
    stderr.lines().any(is_file_system_line)
}

/// Whether `stderr` holds a "permission denied" of authorization: any such
/// line that is not a file system refusal.
pub fn is_authorization_denial(stderr: &str) -> bool {
    stderr.lines().any(|line| {
        line.to_ascii_lowercase().contains("permission denied") && !is_file_system_line(line)
    })
}

/// Records whether a hook of a Git command declined, through trace2 events
/// in a temporary file: Git prints nothing of its own when a hook fails.
pub struct HookTrace {
    path: Option<tempfile::TempPath>,
}

impl HookTrace {
    pub fn new() -> Self {
        Self {
            path: tempfile::NamedTempFile::new()
                .ok()
                .map(tempfile::NamedTempFile::into_temp_path),
        }
    }

    /// `env` plus the variable that sends the command's trace2 events to the trace.
    pub fn env<'a>(&'a self, env: &[(&'a str, &'a str)]) -> Vec<(&'a str, &'a str)> {
        let mut all = env.to_vec();
        if let Some(path) = self.path.as_ref().and_then(|path| path.to_str()) {
            all.push(("GIT_TRACE2_EVENT", path));
        }
        all
    }

    /// Whether a hook the traced command ran exited with a failure. Git
    /// processes a hook starts append their own events under nested session
    /// ids; only the command's own session, the first event, counts.
    pub fn hook_failed(&self) -> bool {
        let Some(contents) = self
            .path
            .as_ref()
            .and_then(|path| std::fs::read_to_string(path).ok())
        else {
            return false;
        };
        let mut session = None;
        let mut hooks = Vec::new();
        for event in contents
            .lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        {
            let Some(sid) = event["sid"].as_str() else {
                continue;
            };
            if *session.get_or_insert_with(|| sid.to_string()) != sid {
                continue;
            }
            match event["event"].as_str() {
                Some("child_start") if event["child_class"] == "hook" => {
                    hooks.push(event["child_id"].as_i64());
                }
                Some("child_exit")
                    if hooks.contains(&event["child_id"].as_i64())
                        && event["code"].as_i64() != Some(0) =>
                {
                    return true;
                }
                _ => {}
            }
        }
        false
    }
}

impl Default for HookTrace {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
#[path = "diagnostics_tests.rs"]
mod tests;

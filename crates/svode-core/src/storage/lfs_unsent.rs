//! The LFS objects of published commits whose content the file server may
//! not have yet (DF-377 R3–R5): a publication that could not send the LFS
//! content of a repository publishes its commits without it and queues
//! their objects here, and every later sync of the repository sends the
//! queue before the repository lock with the transfer mechanism of
//! [`crate::git::transfer`].
//!
//! The queue is a state of this device per repository: a file in the Git
//! directory of the repository, never in its portable files, read by every
//! host, so it outlives the process that wrote it.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::lfs_download::{
    LfsFile, POINTER_MAX_BYTES, detail_text, is_network_failure, object_store, parse_pointer,
    stored_locally,
};
use crate::git::GitError;
use crate::git::cli::GitCli;
use crate::git::transfer::{Transfer, TransferDirection, TransferOutcome, TransferStall};

/// The queue, relative to the common Git directory of the repository.
const QUEUE_FILE: &str = "svode/lfs-unsent.json";

/// How long the local reads of the objects a push publishes may take.
const READ_LIMIT: std::time::Duration = std::time::Duration::from_secs(60);

/// Updates of every queue of this process: a send outside the repository
/// lock and a publication under it change the same file.
static QUEUE_UPDATES: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Why the LFS content of a repository was not sent (DF-377 R5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SendStop {
    /// The file server could not be reached over the network (DF-378 R5).
    Unreachable,
    /// The file server refused the credentials of this device.
    NoAccess,
    /// No data moved for the idle limit of the transfer (DF-369 R1), with
    /// the last file its report named.
    #[serde(rename_all = "camelCase")]
    Stalled {
        path: Option<String>,
        size: Option<u64>,
    },
    /// The content of a queued object is no longer on this device.
    NotOnDevice,
    /// Anything else, with the text of git-lfs without credentials.
    Other { detail: String },
}

impl SendStop {
    /// Why a git-lfs send that ended with `stderr` failed.
    pub(crate) fn of_failure(stderr: &str) -> Self {
        let lower = stderr.to_ascii_lowercase();
        // A refused key is authorization, never an unreachable server.
        if crate::git::ops::is_git_auth_error(stderr) {
            Self::NoAccess
        } else if is_network_failure(&lower) {
            Self::Unreachable
        } else {
            Self::Other {
                detail: detail_text(stderr),
            }
        }
    }

    pub(crate) fn of_stall(stall: &TransferStall) -> Self {
        Self::Stalled {
            path: stall.path.clone(),
            size: stall.size,
        }
    }
}

/// What a host shows of the queue of a repository: the files whose content
/// was not sent, their size and why the last send failed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsUnsent {
    pub files: Vec<LfsFile>,
    pub bytes: u64,
    pub stop: SendStop,
}

/// One LFS object of a published commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct UnsentObject {
    pub(crate) oid: String,
    /// The path of the file in the commit that brought the object.
    pub(crate) path: String,
    pub(crate) size: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct Queue {
    /// The remote whose file server the objects go to.
    remote: String,
    objects: Vec<UnsentObject>,
    stop: SendStop,
}

/// The queue file of `repo`, when Git names its common directory.
async fn queue_path(cli: &GitCli, repo: &Path) -> Option<PathBuf> {
    let out = cli
        .exec_redacted(repo, &["rev-parse", "--git-common-dir"])
        .await
        .ok()?;
    let dir = out.stdout.trim();
    (out.exit_code == 0 && !dir.is_empty()).then(|| repo.join(dir).join(QUEUE_FILE))
}

fn load(path: &Path) -> Option<Queue> {
    let text = match std::fs::read(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            tracing::warn!(path = %path.display(), "LFS send queue unreadable: {error}");
            return None;
        }
    };
    match serde_json::from_slice::<Queue>(&text) {
        Ok(queue) => Some(queue),
        Err(error) => {
            tracing::warn!(path = %path.display(), "LFS send queue unreadable: {error}");
            None
        }
    }
}

/// Write `queue` in place of the file at `path` in one step; an empty
/// queue removes the file.
fn store(path: &Path, queue: &Queue) -> Result<(), GitError> {
    if queue.objects.is_empty() {
        return match std::fs::remove_file(path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
            _ => Ok(()),
        };
    }
    let dir = path.parent().expect("the queue file is in a directory");
    std::fs::create_dir_all(dir)?;
    let mut file = tempfile::NamedTempFile::new_in(dir)?;
    serde_json::to_writer_pretty(&mut file, queue)
        .map_err(|error| GitError::General(format!("LFS send queue: {error}")))?;
    file.persist(path)
        .map_err(|error| GitError::from(error.error))?;
    Ok(())
}

/// The queue of `repo` as a host shows it, or `None` while it is empty.
pub async fn unsent(cli: &GitCli, repo: &Path) -> Option<LfsUnsent> {
    let queue = load(&queue_path(cli, repo).await?)?;
    if queue.objects.is_empty() {
        return None;
    }
    let files = queue
        .objects
        .iter()
        .map(|object| LfsFile {
            path: object.path.clone(),
            size: object.size,
        })
        .collect::<Vec<_>>();
    Some(LfsUnsent {
        bytes: files.iter().map(|file| file.size).sum(),
        files,
        stop: queue.stop,
    })
}

/// The LFS objects of the commits a push of `revisions` to `remote`
/// publishes: those of every commit that no remote-tracking ref of `remote`
/// contains, read locally before the push under the repository lock.
pub(crate) async fn objects_to_publish(
    cli: &GitCli,
    repo: &Path,
    remote: &str,
    revisions: &[&str],
) -> Result<Vec<UnsentObject>, GitError> {
    let filter = format!("--filter=blob:limit={POINTER_MAX_BYTES}");
    let remotes = format!("--remotes={remote}");
    let mut args = vec!["rev-list", "--objects", &filter];
    args.extend(revisions);
    args.extend(["--not", &remotes, "--"]);
    let listed = cli.exec_redacted(repo, &args).await?;
    if listed.exit_code != 0 {
        return Err(GitError::GitCommandFailed(format!(
            "git rev-list failed: {}",
            listed.stderr.trim()
        )));
    }
    // `<oid> <path>` for trees and blobs; commits have no path.
    let named = listed
        .stdout
        .lines()
        .filter_map(|line| line.split_once(' '))
        .filter(|(_, path)| !path.is_empty())
        .collect::<Vec<_>>();
    if named.is_empty() {
        return Ok(Vec::new());
    }
    let input = named
        .iter()
        .map(|(oid, _)| format!("{oid}\n"))
        .collect::<String>();
    let kinds = cli
        .exec_with_input(
            repo,
            &["cat-file", "--batch-check=%(objectname) %(objecttype)"],
            &[],
            input.as_bytes(),
        )
        .await?;
    let blobs = kinds
        .stdout
        .lines()
        .filter_map(|line| line.strip_suffix(" blob"))
        .collect::<BTreeSet<_>>();
    let candidates = named
        .iter()
        .filter(|(oid, _)| blobs.contains(oid))
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    let input = candidates
        .iter()
        .map(|(oid, _)| format!("{oid}\n"))
        .collect::<String>();
    let limit = candidates.len() * (POINTER_MAX_BYTES as usize + 100);
    let Some(contents) = crate::git::cli::read_with_input(
        cli,
        repo,
        &["cat-file", "--batch"],
        input.as_bytes(),
        limit,
        READ_LIMIT,
    )
    .await?
    else {
        return Err(GitError::GitCommandFailed(
            "git cat-file did not read the published objects".into(),
        ));
    };
    let mut objects = Vec::new();
    let mut seen = BTreeSet::new();
    let mut rest = contents.as_slice();
    for (_, path) in candidates {
        // `<oid> blob <size>\n<content>\n`
        let Some(end) = rest.iter().position(|byte| *byte == b'\n') else {
            break;
        };
        let header = String::from_utf8_lossy(&rest[..end]);
        let Some(size) = header
            .rsplit(' ')
            .next()
            .and_then(|size| size.parse::<usize>().ok())
        else {
            break;
        };
        let body = &rest[end + 1..];
        let Some(content) = body.get(..size) else {
            break;
        };
        rest = body.get(size + 1..).unwrap_or_default();
        if let Some((oid, size)) = std::str::from_utf8(content).ok().and_then(parse_pointer)
            && seen.insert(oid.clone())
        {
            objects.push(UnsentObject {
                oid,
                path: (*path).to_owned(),
                size,
            });
        }
    }
    Ok(objects)
}

/// Add `objects`, which a push to `remote` just published without their
/// content, to the queue of `repo`, which now says `stop`.
pub(crate) async fn enqueue(
    cli: &GitCli,
    repo: &Path,
    remote: &str,
    objects: Vec<UnsentObject>,
    stop: SendStop,
) -> Result<(), GitError> {
    let path = queue_path(cli, repo).await.ok_or_else(|| {
        GitError::General("the Git directory of the repository is unknown".into())
    })?;
    let _update = QUEUE_UPDATES.lock().await;
    let mut queue = load(&path).unwrap_or_else(|| Queue {
        remote: remote.to_owned(),
        objects: Vec::new(),
        stop: stop.clone(),
    });
    let known = queue
        .objects
        .iter()
        .map(|object| object.oid.clone())
        .collect::<BTreeSet<_>>();
    queue.objects.extend(
        objects
            .into_iter()
            .filter(|object| !known.contains(&object.oid)),
    );
    queue.remote = remote.to_owned();
    queue.stop = stop;
    store(&path, &queue)
}

/// What sending the queue of a repository left.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Resend {
    /// Nothing failed: every object with content on this device was sent or
    /// found on the server.
    Done,
    /// The send failed; the rest of the queue stays with this reason.
    Failed(SendStop),
}

/// Send the queue of `repo` (DF-377 R4), without the repository lock: one
/// transfer per command line of objects, each sent or found on the server
/// leaves the queue. An object without its content on this device stays,
/// with [`SendStop::NotOnDevice`] unless the send failed otherwise.
pub(crate) async fn resend(cli: &GitCli, repo: &Path) -> Resend {
    let Some(path) = queue_path(cli, repo).await else {
        return Resend::Done;
    };
    let queue = {
        let _update = QUEUE_UPDATES.lock().await;
        match load(&path) {
            Some(queue) if !queue.objects.is_empty() => queue,
            _ => return Resend::Done,
        }
    };
    let store_dir = object_store(cli, repo).await;
    let (local, absent): (Vec<_>, Vec<_>) = queue.objects.iter().partition(|object| {
        store_dir
            .as_deref()
            .is_some_and(|store| stored_locally(store, &object.oid, object.size))
    });
    let oids = local
        .iter()
        .map(|object| object.oid.clone())
        .collect::<Vec<_>>();
    let absent = absent
        .iter()
        .map(|object| object.oid.clone())
        .collect::<BTreeSet<_>>();
    let mut sent = BTreeSet::new();
    let mut failure = None;
    let args = ["lfs", "push", "--object-id", "--", queue.remote.as_str()];
    for batch in cli.path_batches(&args, &oids) {
        let outcome = Transfer::new(repo, TransferDirection::Upload)
            .run(cli, &batch, &[])
            .await;
        let stop = match outcome {
            Ok(TransferOutcome::Finished(out)) if out.exit_code == 0 => {
                sent.extend(batch[args.len()..].iter().map(|oid| (*oid).to_owned()));
                continue;
            }
            Ok(TransferOutcome::Finished(out)) => SendStop::of_failure(&out.stderr),
            Ok(TransferOutcome::Stalled(stall)) => SendStop::of_stall(&stall),
            Err(error) => SendStop::Other {
                detail: detail_text(&error.to_string()),
            },
        };
        tracing::warn!(
            repository = %repo.display(),
            step = "LFS send of the queue",
            reason = ?stop,
            "queued LFS content was not sent"
        );
        failure = Some(stop);
        break;
    }
    if !absent.is_empty() {
        tracing::warn!(
            repository = %repo.display(),
            objects = absent.len(),
            "queued LFS content is no longer on this device"
        );
    }
    let _update = QUEUE_UPDATES.lock().await;
    // A publication may have queued more meanwhile.
    let mut current = load(&path).unwrap_or(queue);
    current.objects.retain(|object| !sent.contains(&object.oid));
    if let Some(stop) = &failure {
        current.stop = stop.clone();
    } else if !current.objects.is_empty()
        && current
            .objects
            .iter()
            .all(|object| absent.contains(&object.oid))
    {
        current.stop = SendStop::NotOnDevice;
    }
    if let Err(error) = store(&path, &current) {
        tracing::warn!(repository = %repo.display(), "LFS send queue not written: {error}");
    }
    match failure {
        Some(stop) => Resend::Failed(stop),
        None => Resend::Done,
    }
}

#[cfg(test)]
#[path = "lfs_unsent_tests.rs"]
mod tests;

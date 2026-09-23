//! Per-repository write guard of managed source mutations.
//!
//! A managed source mutation holds an advisory lock on a device-local lock
//! file in `.svode/` of every effective repository it touches, from the
//! recheck of its target until its source effects or rollback are complete.
//! Locks are taken in canonical order with a bounded wait, so a writer of
//! another Svode process gets `SourceBusy` instead of waiting behind a long
//! operation. The operating system releases a lock when its holder exits, so
//! a crash leaves no stale lock. A nested scope of the same task reuses the
//! locks the task already holds.

use std::collections::BTreeSet;
use std::fs::{File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use tokio::sync::Notify;

use super::GitError;

/// Lock file of one repository, excluded from Git by the device-local
/// policy.
pub const WRITE_LOCK_FILE: &str = ".svode/write.lock";

/// Longest wait for a lock held by another writer. Not a public contract.
const WAIT: Duration = Duration::from_millis(1500);
const RETRY: Duration = Duration::from_millis(10);

tokio::task_local! {
    static HELD: Arc<BTreeSet<PathBuf>>;
}

static ACTIVE: AtomicUsize = AtomicUsize::new(0);
static IDLE: Notify = Notify::const_new();

/// Locks held by one scope; dropping it releases them.
pub struct WriteGuard {
    locks: Vec<File>,
}

impl Drop for WriteGuard {
    fn drop(&mut self) {
        if self.locks.is_empty() {
            return;
        }
        self.locks.clear();
        if ACTIVE.fetch_sub(1, Ordering::SeqCst) == 1 {
            IDLE.notify_waiters();
        }
    }
}

/// Acquires the guards of `repositories` in canonical order, skipping the
/// ones this task already holds. `SourceBusy` names the first path of
/// `paths` inside the repository that stayed locked.
pub async fn acquire(
    repositories: &BTreeSet<PathBuf>,
    paths: &[PathBuf],
) -> Result<WriteGuard, GitError> {
    let held = HELD.try_with(Arc::clone).unwrap_or_default();
    let mut locks = Vec::new();
    for repository in repositories.difference(&held) {
        locks.push(lock(repository, paths).await?);
    }
    if !locks.is_empty() {
        ACTIVE.fetch_add(1, Ordering::SeqCst);
    }
    Ok(WriteGuard { locks })
}

/// Runs `future` holding the guards of `repositories`; nested scopes of the
/// same task see them as held.
pub async fn scope<F, T, E>(
    repositories: BTreeSet<PathBuf>,
    paths: &[PathBuf],
    future: F,
    map_error: impl Fn(GitError) -> E,
) -> Result<T, E>
where
    F: std::future::Future<Output = Result<T, E>>,
{
    let guard = acquire(&repositories, paths).await.map_err(map_error)?;
    let mut held = HELD.try_with(|held| (**held).clone()).unwrap_or_default();
    held.extend(repositories);
    let result = HELD.scope(Arc::new(held), future).await;
    drop(guard);
    result
}

/// Resolves once no source phase of this process holds a guard. A process
/// that stops on a signal waits for it, so a started source phase completes
/// or rolls back before exit.
pub async fn idle() {
    loop {
        let notified = IDLE.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if ACTIVE.load(Ordering::SeqCst) == 0 {
            return;
        }
        notified.await;
    }
}

async fn lock(repository: &Path, paths: &[PathBuf]) -> Result<File, GitError> {
    let file = repository.join(WRITE_LOCK_FILE);
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(file)?;
    let deadline = Instant::now() + WAIT;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                tokio::time::sleep(RETRY).await;
            }
            Err(TryLockError::WouldBlock) => {
                let path = paths
                    .iter()
                    .find(|path| path.starts_with(repository))
                    .unwrap_or(&repository.to_path_buf())
                    .display()
                    .to_string();
                return Err(GitError::SourceBusy { path });
            }
            Err(TryLockError::Error(error)) => return Err(error.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repositories(paths: &[&Path]) -> BTreeSet<PathBuf> {
        paths.iter().map(|path| path.to_path_buf()).collect()
    }

    #[tokio::test]
    async fn a_held_repository_is_busy_after_the_bounded_wait_and_free_after_release() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().to_path_buf();
        let target = repo.join("Page.md");
        let held = acquire(&repositories(&[&repo]), std::slice::from_ref(&target))
            .await
            .unwrap();

        // A second writer uses its own lock file handle, like another process.
        let started = Instant::now();
        let busy = tokio::spawn({
            let repo = repo.clone();
            let target = target.clone();
            async move {
                acquire(&repositories(&[&repo]), &[target])
                    .await
                    .map(|_| ())
            }
        })
        .await
        .unwrap();
        assert!(started.elapsed() >= WAIT);
        assert!(matches!(
            busy,
            Err(GitError::SourceBusy { path }) if path == target.display().to_string()
        ));

        drop(held);
        acquire(&repositories(&[&repo]), &[target]).await.unwrap();
        assert!(repo.join(WRITE_LOCK_FILE).is_file());
    }

    #[tokio::test]
    async fn a_nested_scope_reuses_the_guards_of_its_task() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().to_path_buf();
        let outer = repositories(&[&repo]);
        let nested = scope(
            outer.clone(),
            &[],
            async { scope(outer.clone(), &[], async { Ok::<_, GitError>(7) }, |e| e).await },
            |e| e,
        )
        .await
        .unwrap();
        assert_eq!(nested, 7);
    }

    #[tokio::test]
    async fn idle_waits_for_a_held_guard() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().to_path_buf();
        let guard = acquire(&repositories(&[&repo]), &[]).await.unwrap();
        let waiter = tokio::spawn(idle());
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!waiter.is_finished());
        drop(guard);
        // Other tests of this process may hold guards meanwhile.
        tokio::time::timeout(Duration::from_secs(10), waiter)
            .await
            .unwrap()
            .unwrap();
    }
}

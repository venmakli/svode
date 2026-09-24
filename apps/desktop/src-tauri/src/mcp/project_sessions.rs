//! Runtime sessions of the projects the bridge serves without a window.
//!
//! An index-backed read of a project that no window has open is served by a
//! core `ProjectSession` of that project inside the desktop process, with
//! the headless freshness rule: the first read builds or reconciles the
//! pools before it answers, a later one checks them again once the last
//! check is older than a short window. A session starts no watcher, Routine
//! scheduler or run and delivers nothing to windows. Only an index-backed
//! read creates it; while it exists, source reads get its index dates and
//! managed mutations of the project publish into it.
//!
//! A request picks its runtime once and finishes on it. A session is closed
//! when a window opens its project, after a period without requests and at
//! exit; closing waits a bounded time for the requests still using it.

use std::collections::HashMap;
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, OnceLock, Weak};
use std::time::{Duration, Instant};

use sqlx::SqlitePool;
use svode_core::index::IndexKey;
use svode_core::index::freshness::IndexFreshness;
use svode_core::index::knowledge::KnowledgeScope;
use svode_core::index::state::IndexRuntimeState;
use svode_core::runtime::session::ProjectSession;
use svode_tools::error::ToolError;
use svode_tools::host::{MutationRuntime, open_index_freshness};
use tokio::sync::{Mutex, OwnedRwLockReadGuard, RwLock};

/// Period without requests after which a session is closed. Not a public
/// contract.
const IDLE_CLOSE: Duration = Duration::from_secs(300);

/// Upper bound of waiting for the requests still using a closing session.
const CLOSE_WAIT: Duration = Duration::from_secs(5);

pub struct ProjectSessions {
    inner: Arc<Inner>,
}

struct Inner {
    idle: Duration,
    sessions: Mutex<HashMap<PathBuf, Entry>>,
}

#[derive(Clone)]
struct Entry {
    session: Arc<ProjectSession>,
    /// Held shared by every request on the session, exclusively by close.
    in_use: Arc<RwLock<()>>,
    last_use: Arc<StdMutex<Instant>>,
}

/// Use of a session by one request; the session stays open while it lives.
pub(crate) struct SessionLease {
    session: Arc<ProjectSession>,
    last_use: Arc<StdMutex<Instant>>,
    _in_use: OwnedRwLockReadGuard<()>,
}

impl Deref for SessionLease {
    type Target = ProjectSession;

    fn deref(&self) -> &ProjectSession {
        &self.session
    }
}

impl Drop for SessionLease {
    fn drop(&mut self) {
        touch(&self.last_use);
    }
}

fn touch(last_use: &StdMutex<Instant>) {
    *last_use.lock().unwrap_or_else(|error| error.into_inner()) = Instant::now();
}

fn idle_for(last_use: &StdMutex<Instant>) -> Duration {
    last_use
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .elapsed()
}

fn project_key(project: &Path) -> PathBuf {
    std::fs::canonicalize(project).unwrap_or_else(|_| project.to_path_buf())
}

impl Default for ProjectSessions {
    fn default() -> Self {
        Self::new()
    }
}

impl ProjectSessions {
    pub fn new() -> Self {
        Self::with_idle(IDLE_CLOSE)
    }

    fn with_idle(idle: Duration) -> Self {
        Self {
            inner: Arc::new(Inner {
                idle,
                sessions: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Lease of the session of `project`, if one exists and no window has
    /// the project open in `desktop`.
    async fn existing(&self, project: &Path, desktop: &IndexRuntimeState) -> Option<SessionLease> {
        let key = project_key(project);
        let sessions = self.inner.sessions.lock().await;
        if desktop.is_project_open(project).await {
            return None;
        }
        sessions.get(&key).map(Entry::lease)
    }

    /// Lease of the session of `project`, created when none exists; `None`
    /// when a window has the project open in `desktop`. The check runs under
    /// the registry lock, so a session is never created after the window's
    /// handover closed the previous one.
    async fn get_or_create(
        &self,
        project: &Path,
        desktop: &IndexRuntimeState,
    ) -> Option<SessionLease> {
        let key = project_key(project);
        let mut sessions = self.inner.sessions.lock().await;
        if desktop.is_project_open(project).await {
            return None;
        }
        if let Some(entry) = sessions.get(&key) {
            return Some(entry.lease());
        }
        let entry = Entry {
            session: Arc::new(ProjectSession::new()),
            in_use: Arc::new(RwLock::new(())),
            last_use: Arc::new(StdMutex::new(Instant::now())),
        };
        let lease = entry.lease();
        tokio::spawn(close_when_idle(
            Arc::downgrade(&self.inner),
            key.clone(),
            entry.clone(),
        ));
        sessions.insert(key, entry);
        Some(lease)
    }

    /// Closes the session of `project`, if any: a window took the project
    /// over or the project is going away.
    pub async fn close(&self, project: &Path) {
        let entry = self
            .inner
            .sessions
            .lock()
            .await
            .remove(&project_key(project));
        if let Some(entry) = entry {
            entry.close().await;
        }
    }

    /// Closes every session at exit.
    pub async fn close_all(&self) {
        let entries = std::mem::take(&mut *self.inner.sessions.lock().await);
        for entry in entries.into_values() {
            entry.close().await;
        }
    }

    #[cfg(test)]
    async fn projects(&self) -> Vec<PathBuf> {
        self.inner.sessions.lock().await.keys().cloned().collect()
    }
}

impl Entry {
    /// Taken under the registry lock: a closing entry has already left the
    /// registry, so the shared lock is always free here.
    fn lease(&self) -> SessionLease {
        touch(&self.last_use);
        SessionLease {
            session: self.session.clone(),
            last_use: self.last_use.clone(),
            _in_use: self
                .in_use
                .clone()
                .try_read_owned()
                .expect("a registered session is not being closed"),
        }
    }

    /// Waits a bounded time for the requests still using the session, then
    /// closes its pools and Routine stores. A request that outlives the wait
    /// keeps the session until it finishes; its pools are released with it.
    async fn close(self) {
        let closed = tokio::time::timeout(CLOSE_WAIT, async {
            let _exclusive = self.in_use.clone().write_owned().await;
            self.session.close().await;
        })
        .await;
        if closed.is_err() {
            tracing::warn!("closing the index session of a project without a window timed out");
        }
    }
}

async fn close_when_idle(registry: Weak<Inner>, project: PathBuf, entry: Entry) {
    loop {
        let Some(inner) = registry.upgrade() else {
            return;
        };
        let idle = inner.idle;
        let remaining = idle.saturating_sub(idle_for(&entry.last_use));
        if !remaining.is_zero() {
            drop(inner);
            tokio::time::sleep(remaining).await;
            continue;
        }
        let mut sessions = inner.sessions.lock().await;
        if !sessions
            .get(&project)
            .is_some_and(|current| Arc::ptr_eq(&current.session, &entry.session))
        {
            return;
        }
        let Ok(_exclusive) = entry.in_use.clone().try_write_owned() else {
            drop(sessions);
            drop(inner);
            tokio::time::sleep(idle).await;
            continue;
        };
        if idle_for(&entry.last_use) < idle {
            continue;
        }
        sessions.remove(&project);
        drop(sessions);
        entry.session.close().await;
        return;
    }
}

/// Runtime of one bridge request of a project without a window: the
/// session it picked, once. A request started before a window opens the
/// project finishes on it; one without a session uses the desktop runtime.
#[derive(Default)]
pub(crate) struct RequestSession(OnceLock<SessionLease>);

impl RequestSession {
    /// Picks the existing session of the target project, so source reads
    /// get its index dates and managed mutations publish into it. It never
    /// creates one.
    pub(crate) async fn attach_existing(
        &self,
        sessions: &ProjectSessions,
        desktop: &IndexRuntimeState,
        project: &Path,
    ) {
        if let Some(lease) = sessions.existing(project, desktop).await {
            let _ = self.0.set(lease);
        }
    }

    /// Prepares the pools of an index-backed read. A project a window has
    /// open reports the pools its runtime keeps; any other one is served by
    /// its session, created on the first index-backed read.
    pub(crate) async fn prepare_index(
        &self,
        sessions: &ProjectSessions,
        desktop: &IndexRuntimeState,
        project: &Path,
        scope: &KnowledgeScope,
    ) -> Result<IndexFreshness, ToolError> {
        let session = match self.0.get() {
            Some(session) => session,
            None => match sessions.get_or_create(project, desktop).await {
                Some(lease) => self.0.get_or_init(|| lease),
                None => return open_index_freshness(desktop, project, scope).await,
            },
        };
        let project = session.open_project(project).await?;
        let keys = session.index().keys_for_scope(project, scope).await?;
        Ok(session.prepare_index(&keys).await?)
    }

    /// Brings the session pools a managed mutation publishes into in line
    /// with the files, as a headless session does. The desktop runtime of an
    /// open project is kept current by its watcher.
    pub(crate) async fn prepare_mutation(&self, paths: &[PathBuf]) {
        if let Some(session) = self.0.get()
            && let Err(error) = session.prepare_mutation(paths).await
        {
            tracing::warn!("the index a mutation publishes into could not be prepared: {error}");
        }
    }

    /// Index state the request reads from.
    pub(crate) fn index<'a>(&'a self, desktop: &'a IndexRuntimeState) -> &'a IndexRuntimeState {
        self.0.get().map_or(desktop, |session| session.index())
    }

    /// Runtime a managed mutation of the request publishes into.
    pub(crate) fn mutation_runtime<'a>(
        &'a self,
        desktop: MutationRuntime<'a>,
    ) -> MutationRuntime<'a> {
        match self.0.get() {
            Some(session) => MutationRuntime {
                index: session.index(),
                updates: session.index_updates(),
                nonces: session.nonces(),
            },
            None => desktop,
        }
    }

    /// Open pool of a read target; the request never creates one here.
    pub(crate) async fn index_pool(
        &self,
        desktop: &IndexRuntimeState,
        key: &IndexKey,
        space_path: &Path,
    ) -> Option<SqlitePool> {
        let index = self.index(desktop);
        if let Some(pool) = index.existing_pool(key).await {
            return Some(pool);
        }
        let fallback = index.key_for_space_dir(space_path).await?;
        index.existing_pool(&fallback).await
    }
}

#[cfg(test)]
#[path = "project_sessions_tests.rs"]
mod tests;

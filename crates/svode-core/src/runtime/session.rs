//! Runtime session of one explicitly selected Project.
//!
//! A session is bound to one Project before its first operation and never
//! switches. Binding reads the portable config into the Space cache and
//! opens nothing else: index pools, Routine stores and the Git runtime are
//! opened by the operations that need them and live until [`close`].
//!
//! Without a watcher, an index-backed read first brings its pools in line
//! with the files: the first read of a pool runs the reconciliation cycle
//! (a full rebuild for a cold or replaced index), and a later read runs it
//! again once the last completed check is older than a short window.
//! Concurrent reads of one pool wait for the check in progress instead of
//! starting another.
//!
//! [`close`]: ProjectSession::close

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use tokio::sync::{Mutex, OnceCell};

use crate::actors::resolver::ActorCatalogState;
use crate::git::GitError;
use crate::git::access::{RepositoryAccessSnapshot, RepositoryAccessState};
use crate::git::state::GitRuntime;
use crate::index::IndexKey;
use crate::index::freshness::{IndexFreshness, IndexUnavailable};
use crate::index::resolver::ProjectSpacesCache;
use crate::index::state::IndexRuntimeState;
use crate::index::update::IndexUpdateState;
use crate::page::PageSourceError;
use crate::page::nonce::WriteNonceRegistry;
use crate::routines::store_state::RoutineStoreState;

/// Age after which a completed check of a pool no longer answers a read
/// without checking the files again. Not a public contract.
const INDEX_RECHECK_WINDOW: Duration = Duration::from_secs(2);

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error(transparent)]
    Project(#[from] PageSourceError),
    #[error("the runtime session serves project {bound}, not {requested}")]
    OtherProject { bound: String, requested: String },
}

pub struct ProjectSession {
    project: OnceCell<PathBuf>,
    index: IndexRuntimeState,
    updates: IndexUpdateState,
    routines: Arc<RoutineStoreState>,
    nonces: WriteNonceRegistry,
    actors: ActorCatalogState,
    git: OnceLock<GitRuntime>,
    access: RepositoryAccessState,
    index_checks: Mutex<HashMap<IndexKey, Arc<Mutex<()>>>>,
}

impl Default for ProjectSession {
    fn default() -> Self {
        Self::new()
    }
}

impl ProjectSession {
    /// Unbound session; constructing it touches no file or process.
    pub fn new() -> Self {
        let routines = Arc::new(RoutineStoreState::new());
        Self {
            project: OnceCell::new(),
            index: IndexRuntimeState::default(),
            updates: IndexUpdateState::new(routines.clone()),
            routines,
            nonces: WriteNonceRegistry::new(),
            actors: ActorCatalogState::new(),
            git: OnceLock::new(),
            access: RepositoryAccessState::new(),
            index_checks: Mutex::new(HashMap::new()),
        }
    }

    /// Binds the session to `project` on first use, reading its portable
    /// config into the Space cache. Later calls for the same Project are
    /// free; another Project is refused.
    pub async fn open_project(&self, project: &Path) -> Result<&Path, SessionError> {
        let requested = std::fs::canonicalize(project).map_err(|error| {
            PageSourceError::InvalidPath(format!("Project {}: {error}", project.display()))
        })?;
        let bound = self
            .project
            .get_or_try_init(|| async {
                let cache = ProjectSpacesCache::from_project(&requested)?;
                self.index.replace_project_cache(&requested, cache).await;
                Ok::<_, PageSourceError>(requested.clone())
            })
            .await?;
        if *bound != requested {
            return Err(SessionError::OtherProject {
                bound: bound.display().to_string(),
                requested: requested.display().to_string(),
            });
        }
        Ok(bound)
    }

    /// Bound Project, if any.
    pub fn project(&self) -> Option<&Path> {
        self.project.get().map(PathBuf::as_path)
    }

    pub fn index(&self) -> &IndexRuntimeState {
        &self.index
    }

    pub fn index_updates(&self) -> &IndexUpdateState {
        &self.updates
    }

    pub fn routine_stores(&self) -> &RoutineStoreState {
        &self.routines
    }

    pub fn nonces(&self) -> &WriteNonceRegistry {
        &self.nonces
    }

    pub fn actors(&self) -> &ActorCatalogState {
        &self.actors
    }

    /// Git runtime of the session; the Git CLI is detected on first use.
    pub fn git(&self) -> &GitRuntime {
        self.git.get_or_init(GitRuntime::new)
    }

    /// Prepares the pools of `keys` for an index-backed read and reports
    /// their freshness. A pool whose last completed check is older than the
    /// recheck window is opened if needed and reconciled with its sources;
    /// a pool that cannot be prepared makes the read unavailable.
    pub async fn prepare_index(
        &self,
        keys: &[IndexKey],
    ) -> Result<IndexFreshness, IndexUnavailable> {
        let mut failures = Vec::new();
        for key in keys {
            if let Err(error) = self.check_index(key).await {
                failures.push(IndexUnavailable::failed(key, error));
            }
        }
        if !failures.is_empty() {
            return Err(IndexUnavailable::new(failures));
        }
        self.index.freshness(keys).await
    }

    async fn check_index(
        &self,
        key: &IndexKey,
    ) -> Result<(), crate::index::update::IndexUpdateError> {
        let gate = self
            .index_checks
            .lock()
            .await
            .entry(key.clone())
            .or_default()
            .clone();
        let _check = gate.lock().await;
        if self.index.verified_within(key, INDEX_RECHECK_WINDOW).await {
            return Ok(());
        }
        self.index.get_or_create(key).await?;
        self.updates
            .reconcile_space(&self.index, key, self.git().cli().ok())
            .await
    }

    /// Repository access of the Space at `space_path` from the evidence
    /// store the install shares with the desktop app. It never probes the
    /// remote; a repository without evidence is `unknown / not_checked`.
    pub async fn repository_access(
        &self,
        space_path: &Path,
    ) -> Result<RepositoryAccessSnapshot, GitError> {
        self.access
            .snapshot(self.git().cli()?, space_path, &access_store()?)
            .await
    }

    /// Authorizes a managed mutation of `repository` from the shared
    /// evidence store without a probe: only `local` and fresh `writable`
    /// evidence allow it.
    pub async fn require_mutation(&self, repository: &Path) -> Result<(), GitError> {
        self.access
            .require_mutation(self.git().cli()?, repository, &access_store()?)
            .await
            .map(|_| ())
    }

    /// Closes every Routine store and index pool the session opened. The
    /// session stays bound; closing twice is harmless.
    pub async fn close(&self) {
        if let Some(project) = self.project() {
            self.routines.close_project(project).await;
            self.index.close_project(project).await;
        }
    }
}

fn access_store() -> Result<PathBuf, GitError> {
    super::device::repository_access_store().ok_or_else(|| {
        GitError::General("the device-local Svode settings directory is unavailable".into())
    })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::git::access::{RepositoryAccessReason, RepositoryAccessStatus};
    use crate::index::freshness::IndexFreshnessStatus;

    fn project(root: &Path) {
        fs::create_dir_all(root.join(".svode")).unwrap();
        fs::write(
            root.join(".svode/config.json"),
            r#"{"name":"Project","spaces":[{"id":"child","path":"child","repo":null}]}"#,
        )
        .unwrap();
        fs::create_dir_all(root.join("child/.svode")).unwrap();
        fs::write(root.join("child/.svode/config.json"), r#"{"name":"Child"}"#).unwrap();
    }

    fn files(root: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for entry in fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    stack.push(path);
                } else {
                    out.push(path);
                }
            }
        }
        out.sort();
        out
    }

    #[tokio::test]
    async fn binding_reads_the_space_cache_and_opens_no_store() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        project(&root);
        let before = files(&root);

        let session = ProjectSession::new();
        assert_eq!(session.project(), None);
        let bound = session.open_project(&root).await.unwrap().to_path_buf();

        assert_eq!(bound, root);
        let child = IndexKey::Space {
            project: root.clone(),
            space_id: "child".to_string(),
        };
        assert_eq!(
            session.index().dir_for_key(&child).await.unwrap(),
            root.join("child")
        );
        assert!(session.index().existing_pool(&child).await.is_none());
        session.close().await;
        assert_eq!(files(&root), before);
    }

    #[tokio::test]
    async fn a_bound_session_never_switches_project() {
        let temp = tempfile::tempdir().unwrap();
        let first = temp.path().join("first");
        let second = temp.path().join("second");
        project(&first);
        project(&second);

        let session = ProjectSession::new();
        session.open_project(&first).await.unwrap();
        session.open_project(&first.join("child/..")).await.unwrap();
        assert!(matches!(
            session.open_project(&second).await,
            Err(SessionError::OtherProject { .. })
        ));
        assert_eq!(
            session.project(),
            Some(first.canonicalize().unwrap().as_path())
        );
    }

    #[tokio::test]
    async fn invalid_project_leaves_the_session_unbound() {
        let temp = tempfile::tempdir().unwrap();
        let session = ProjectSession::new();
        assert!(matches!(
            session.open_project(temp.path()).await,
            Err(SessionError::Project(PageSourceError::Missing(_)))
        ));
        assert_eq!(session.project(), None);
        project(temp.path());
        session.open_project(temp.path()).await.unwrap();
    }

    #[tokio::test]
    async fn close_releases_pools_opened_on_demand() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        project(&root);
        let session = ProjectSession::new();
        session.open_project(&root).await.unwrap();
        let key = IndexKey::Root(root.clone());
        let index = session.index().get_or_create(&key).await.unwrap();
        let routines = session
            .routine_stores()
            .get_or_create(&key, &root)
            .await
            .unwrap();

        session.close().await;

        assert!(index.is_closed());
        assert!(routines.is_closed());
        assert!(session.index().existing_pool(&key).await.is_none());
        session.close().await;
    }

    async fn entries(session: &ProjectSession, key: &IndexKey) -> Vec<String> {
        let pool = session.index().existing_pool(key).await.unwrap();
        sqlx::query_scalar("SELECT file_path FROM entries ORDER BY file_path")
            .fetch_all(&pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn an_index_backed_read_builds_a_cold_index_and_joins_a_recent_check() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        project(&root);
        fs::write(root.join("note.md"), "# Note\n").unwrap();
        fs::write(root.join("child/inner.md"), "# Inner\n").unwrap();
        let session = ProjectSession::new();
        session.open_project(&root).await.unwrap();
        let root_key = IndexKey::Root(root.clone());
        let child_key = IndexKey::Space {
            project: root.clone(),
            space_id: "child".to_string(),
        };

        let first = session
            .prepare_index(&[root_key.clone(), child_key.clone()])
            .await
            .unwrap();
        assert_eq!(first.status, IndexFreshnessStatus::Fresh);
        assert!(first.verified_at.is_some());
        assert_eq!(entries(&session, &root_key).await, ["note.md"]);
        assert_eq!(entries(&session, &child_key).await, ["inner.md"]);

        // Two reads inside the recheck window share one completed check:
        // an edit made meanwhile waits for the next check.
        fs::write(root.join("later.md"), "# Later\n").unwrap();
        let (again, concurrent) = tokio::join!(
            session.prepare_index(std::slice::from_ref(&root_key)),
            session.prepare_index(std::slice::from_ref(&root_key)),
        );
        assert_eq!(again.unwrap().verified_at, first.verified_at);
        assert_eq!(concurrent.unwrap().verified_at, first.verified_at);
        assert_eq!(entries(&session, &root_key).await, ["note.md"]);

        tokio::time::sleep(INDEX_RECHECK_WINDOW).await;
        let rechecked = session
            .prepare_index(std::slice::from_ref(&root_key))
            .await
            .unwrap();
        assert!(rechecked.verified_at > first.verified_at);
        assert_eq!(entries(&session, &root_key).await, ["later.md", "note.md"]);
        session.close().await;
    }

    #[tokio::test]
    async fn an_index_that_cannot_be_prepared_is_unavailable() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        project(&root);
        let session = ProjectSession::new();
        session.open_project(&root).await.unwrap();
        // The index location is taken by a directory, so no pool opens.
        fs::create_dir_all(root.join(".svode/index.db")).unwrap();

        let error = session
            .prepare_index(&[IndexKey::Root(root.clone())])
            .await
            .unwrap_err();
        assert_eq!(error.diagnostics.len(), 1);
        assert_eq!(error.diagnostics[0].code, "index_unavailable");
        assert_eq!(error.diagnostics[0].space_id, None);
        session.close().await;
    }

    #[tokio::test]
    async fn repository_access_without_evidence_is_read_without_a_probe() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        project(&root);
        let session = ProjectSession::new();
        if session.git().cli().is_err() {
            return;
        }
        let git = |args: &[&str]| {
            assert!(
                std::process::Command::new("git")
                    .args(args)
                    .current_dir(&root)
                    .status()
                    .unwrap()
                    .success()
            );
        };
        git(&["init", "-q"]);
        let local = session.repository_access(&root).await.unwrap();
        assert_eq!(local.status, RepositoryAccessStatus::Local);
        git(&[
            "remote",
            "add",
            "origin",
            "https://example.invalid/never.git",
        ]);
        let session = ProjectSession::new();
        let remote = session.repository_access(&root).await.unwrap();
        assert_eq!(remote.status, RepositoryAccessStatus::Unknown);
        assert_eq!(remote.reason, Some(RepositoryAccessReason::NotChecked));
    }
}

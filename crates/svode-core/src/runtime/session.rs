//! Runtime session of one explicitly selected Project.
//!
//! A session is bound to one Project before its first operation and never
//! switches. Binding reads the portable config into the Space cache and
//! opens nothing else: index pools, Routine stores and the Git runtime are
//! opened by the operations that need them and live until [`close`].
//!
//! [`close`]: ProjectSession::close

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use tokio::sync::OnceCell;

use crate::actors::resolver::ActorCatalogState;
use crate::git::state::GitRuntime;
use crate::index::resolver::ProjectSpacesCache;
use crate::index::state::IndexRuntimeState;
use crate::index::update::IndexUpdateState;
use crate::page::PageSourceError;
use crate::page::nonce::WriteNonceRegistry;
use crate::routines::store_state::RoutineStoreState;

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

    /// Closes every Routine store and index pool the session opened. The
    /// session stays bound; closing twice is harmless.
    pub async fn close(&self) {
        if let Some(project) = self.project() {
            self.routines.close_project(project).await;
            self.index.close_project(project).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::index::IndexKey;

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
}

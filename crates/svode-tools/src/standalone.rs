//! Standalone host of the `svode` and `svode-mcp --project` processes.
//!
//! One implementation of the host seam over the `svode-core` project
//! runtime session, shared by both entrypoints. The process freezes its
//! target before the first operation; the session binds to that Project on
//! first need and opens stores only for the capabilities that need them. An
//! MCP session started without a Project takes the Project it creates.
//! Index-backed reads reconcile their pools with the files first, since no
//! watcher keeps them current; a managed mutation does the same for the
//! pools it publishes into before its source phase, so its Routine events
//! describe only its own change. A mutation is authorized from the access
//! evidence the install shares and publishes into the index and Routine
//! stores of this process; a managed import proves Git LFS readiness with
//! the core probe of the process Git runtime. Routine definitions use the
//! operational store of their owner, opened on the first Routine operation;
//! the process has no execution evidence and never runs a Routine.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use sqlx::SqlitePool;
use svode_core::attachments::import::{LfsReadiness, ManagedImportDelivery};
use svode_core::git::GitError;
use svode_core::git::access::{RepositoryAccessSnapshot, local_repository_root};
use svode_core::git::cli::GitCli;
use svode_core::git::flow::{ParentPublication, SyncReport};
use svode_core::git::host::{GitHost, HostFuture};
use svode_core::git::operations::SharedError;
use svode_core::index::IndexKey;
use svode_core::index::freshness::IndexFreshness;
use svode_core::index::knowledge::KnowledgeScope;
use svode_core::page::ResolvedSpaceTarget;
use svode_core::project::root::ProjectCreated;
use svode_core::project::space::SpaceCreated;
use svode_core::routines::model::{ResolvedRoutineOwner, RoutineLiveEvidence};
use svode_core::runtime::session::ProjectSession;

use crate::error::ToolError;
use crate::host::{
    MutationRuntime, NextRequests, ROUTINE_CALLER_TOKEN_ENV, ReadRuntime, RequestTarget,
    RoutineCaller, RoutineRunner, RoutineRuntime, ToolHost,
};

/// Catalog tools a standalone process serves: every data and guidance
/// capability. An explicit Routine launch and App process state and control
/// need the Desktop execution owner and are never served.
const SERVED_TOOLS: [&str; 58] = [
    "get_svode_guide",
    "validate_app_manifest",
    "list_apps",
    "get_app",
    "get_project_info",
    "list_spaces",
    "list_pages",
    "list_collections",
    "get_collection_schema",
    "read_page",
    "read_space_readme",
    "read_collection_readme",
    "read_collection_item",
    "validate_collection_integrity",
    "query_collection_items",
    "list_actors",
    "list_agent_actors",
    "search_pages",
    "search_knowledge",
    "get_knowledge_node",
    "get_knowledge_neighbors",
    "get_related_context",
    "get_knowledge_status",
    "get_git_status",
    "write_page",
    "update_collection_item_body",
    "write_space_readme",
    "write_collection_readme",
    "update_page_metadata",
    "update_space_metadata",
    "update_collection_metadata",
    "update_collection_item_metadata",
    "update_collection_item_fields",
    "add_collection_column",
    "update_collection_column",
    "delete_collection_column",
    "add_collection_view",
    "update_collection_view",
    "delete_collection_view",
    "create_page",
    "create_collection",
    "delete_page",
    "delete_collection_item",
    "delete_collection",
    "rename_content",
    "move_content",
    "reorder_content",
    "reorder_spaces",
    "create_space",
    "create_project",
    "convert_to_collection",
    "convert_page_to_leaf",
    "import_asset",
    "list_routines",
    "get_routine",
    "create_routine",
    "update_routine",
    "delete_routine",
];

/// Upper bound of closing session-owned resources at process exit.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

/// Request target of a standalone process whose default Space is `space`.
/// A process started from a managed Routine launch inherits its caller
/// token; nothing here can verify it against the launch, so the caller only
/// keeps the Routine origin restrictions.
pub fn request_target(space: &ResolvedSpaceTarget) -> RequestTarget {
    let claimed =
        std::env::var(ROUTINE_CALLER_TOKEN_ENV).is_ok_and(|token| !token.trim().is_empty());
    RequestTarget {
        project_path: space.project_path.to_string_lossy().to_string(),
        default_space_id: space.space_id.clone(),
        default_space_path: space.space_path.to_string_lossy().to_string(),
        routine_caller: claimed.then_some(RoutineCaller::Claimed),
    }
}

/// How the requests of a standalone process are addressed.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Addressing {
    /// Each command of the `svode` CLI resolves its own target.
    PerCommand,
    /// An MCP session keeps one target; a session without one takes the
    /// Project it creates (Stage 11 05 «Сессия MCP после создания проекта»).
    Session,
}

pub struct StandaloneHost {
    version: &'static str,
    session: ProjectSession,
    addressing: Addressing,
    /// Directory of the list of Projects of the device; `None` for the
    /// device config directory.
    project_list: Option<PathBuf>,
}

impl StandaloneHost {
    /// Host of `svode` commands reporting `version` as the build version of
    /// its binary. It opens nothing until an operation needs the Project.
    pub fn new(version: &'static str) -> Self {
        Self {
            version,
            session: ProjectSession::new(),
            addressing: Addressing::PerCommand,
            project_list: None,
        }
    }

    /// Host of one headless MCP session: a session started without a
    /// Project works with the Project it creates.
    pub fn session(version: &'static str) -> Self {
        Self {
            addressing: Addressing::Session,
            ..Self::new(version)
        }
    }

    /// The same host registering created Projects in the list in `dir`
    /// instead of the device config directory.
    pub fn with_project_list_dir(self, dir: PathBuf) -> Self {
        Self {
            project_list: Some(dir),
            ..self
        }
    }

    /// The Project the runtime session is bound to, if any.
    pub fn project(&self) -> Option<&Path> {
        self.session.project()
    }

    /// Closes every session-owned resource within a bounded wait.
    pub async fn close(&self) {
        if tokio::time::timeout(CLOSE_TIMEOUT, self.session.close())
            .await
            .is_err()
        {
            tracing::warn!("closing the Svode runtime session timed out");
        }
    }
}

impl ToolHost for StandaloneHost {
    fn version(&self) -> &str {
        self.version
    }

    fn serves_tool(&self, name: &str) -> bool {
        SERVED_TOOLS.contains(&name)
    }

    /// Binds the runtime session to the frozen target Project. A session
    /// never switches to another Project.
    async fn open_project(&self, project: &Path) -> Result<(), ToolError> {
        self.session
            .open_project(project)
            .await
            .map(|_| ())
            .map_err(ToolError::from)
    }

    async fn prepare_mutation(&self, paths: &[PathBuf]) {
        if let Err(error) = self.session.prepare_mutation(paths).await {
            tracing::warn!("the index a mutation publishes into could not be prepared: {error}");
        }
    }

    async fn verify_repository_access(
        &self,
        space_path: &Path,
    ) -> Result<RepositoryAccessSnapshot, ToolError> {
        Ok(self.session.verify_repository_access(space_path).await?)
    }

    async fn prepare_index(
        &self,
        project: &Path,
        scope: &KnowledgeScope,
    ) -> Result<IndexFreshness, ToolError> {
        let project = self
            .session
            .open_project(project)
            .await
            .map_err(ToolError::from)?;
        let keys = self.session.index().keys_for_scope(project, scope).await?;
        Ok(self.session.prepare_index(&keys).await?)
    }

    async fn index_pool(&self, key: &IndexKey, _space_path: &Path) -> Option<SqlitePool> {
        self.session.open_project(key.project()).await.ok()?;
        self.session.index().existing_pool(key).await
    }

    async fn repository_access(
        &self,
        space_path: &Path,
    ) -> Result<RepositoryAccessSnapshot, ToolError> {
        Ok(self.session.repository_access(space_path).await?)
    }

    async fn require_mutation_access(&self, repository: &Path) -> Result<(), ToolError> {
        Ok(self.session.require_mutation(repository).await?)
    }

    fn mutation_runtime(&self) -> MutationRuntime<'_> {
        MutationRuntime {
            index: self.session.index(),
            updates: self.session.index_updates(),
            nonces: self.session.nonces(),
        }
    }

    fn read_runtime(&self) -> ReadRuntime<'_> {
        ReadRuntime {
            index: self.session.index(),
            actors: self.session.actors(),
            git: self.session.git(),
        }
    }

    fn lfs_readiness(&self) -> Option<&dyn LfsReadiness> {
        Some(self.session.git())
    }

    /// A headless process has no invalidation consumers.
    fn deliver_managed_import(&self, _delivery: &ManagedImportDelivery) {}

    /// Operational stores of the session. Without execution evidence the
    /// last run of a Routine is projected only from its persisted facts.
    fn routine_runtime(&self) -> Result<RoutineRuntime<'_>, ToolError> {
        Ok(RoutineRuntime {
            stores: self.session.routine_stores(),
            live_evidence: RoutineLiveEvidence::default(),
        })
    }

    /// A headless process has no invalidation consumers.
    fn deliver_routine_invalidation(&self, _owner: &ResolvedRoutineOwner) {}

    fn routine_runner(&self) -> Option<&dyn RoutineRunner> {
        None
    }

    fn git_host(&self) -> Option<&dyn GitHost> {
        Some(self)
    }

    /// The session resolves paths of the new Space to its own index from
    /// now on; nothing else in the process shows Spaces.
    async fn space_created(&self, _project: &Path, _created: &SpaceCreated) {
        if let Err(error) = self.session.reload_spaces().await {
            tracing::warn!("the Spaces of the project could not be read again: {error}");
        }
    }

    fn project_list_dir(&self) -> Option<PathBuf> {
        self.project_list
            .clone()
            .or_else(svode_core::runtime::device::config_dir)
    }

    /// A session without a target binds its runtime to the created Project,
    /// so its next requests address it; a session with a target keeps it.
    async fn project_created(
        &self,
        target: Option<&RequestTarget>,
        created: &ProjectCreated,
    ) -> NextRequests {
        match (self.addressing, target) {
            (Addressing::PerCommand, _) => NextRequests::PerCommand,
            (Addressing::Session, Some(target)) => {
                NextRequests::KeptProject(Some(PathBuf::from(&target.project_path)))
            }
            (Addressing::Session, None) => match self.session.open_project(&created.path).await {
                Ok(_) => NextRequests::BoundToCreated,
                Err(error) => {
                    tracing::warn!("the session could not take up the created project: {error}");
                    NextRequests::KeptProject(self.project().map(Path::to_path_buf))
                }
            },
        }
    }
}

/// Git host of an operation that applies the shared Git policy itself in a
/// standalone process: repositories are authorized from the access
/// evidence the install shares, without a network probe. The process has
/// no window or event consumers, never syncs and runs no background
/// publication, so notifications have nobody to reach.
impl GitHost for StandaloneHost {
    fn authorize_repository<'a>(
        &'a self,
        repository: &'a Path,
    ) -> HostFuture<'a, Result<(), GitError>> {
        Box::pin(self.session.require_mutation(repository))
    }

    fn authorize_paths<'a>(&'a self, paths: Vec<PathBuf>) -> HostFuture<'a, Result<(), GitError>> {
        Box::pin(async move {
            let mut repositories = HashSet::new();
            for path in paths {
                let repository = local_repository_root(&path)?;
                if repositories.insert(repository.clone()) {
                    self.session.require_mutation(&repository).await?;
                }
            }
            Ok(())
        })
    }

    fn invalidate_repository_access<'a>(
        &'a self,
        _cli: &'a GitCli,
        repository: &'a Path,
    ) -> HostFuture<'a, ()> {
        Box::pin(async move {
            if let Err(error) = self.session.invalidate_repository_access(repository).await {
                tracing::warn!("repository access evidence not invalidated: {error}");
            }
        })
    }

    fn record_write_evidence<'a>(
        &'a self,
        _cli: &'a GitCli,
        repository: &'a Path,
    ) -> HostFuture<'a, ()> {
        Box::pin(async move {
            if let Err(error) = self.session.record_writable_evidence(repository).await {
                tracing::warn!("repository write evidence not recorded: {error}");
            }
        })
    }

    /// A pulled change reaches the index through the check every
    /// index-backed read runs first; only the write evidence is recorded.
    fn refresh_synced_repository<'a>(
        &'a self,
        cli: &'a GitCli,
        repository: &'a Path,
    ) -> HostFuture<'a, ()> {
        self.record_write_evidence(cli, repository)
    }

    fn invalidate_actor_space<'a>(&'a self, space: &'a Path) -> HostFuture<'a, ()> {
        Box::pin(async move {
            let marked = match self.session.git().cli() {
                Ok(cli) => match svode_core::actors::resolver::resolve_repository(cli, space).await
                {
                    Ok(repository) => self
                        .session
                        .actors()
                        .mark_repository_dirty(&repository)
                        .map(|_| ()),
                    Err(error) => Err(error),
                },
                Err(error) => Err(error.into()),
            };
            if let Err(error) = marked {
                tracing::warn!("actor catalog not invalidated: {error}");
            }
        })
    }

    fn publish_commit(&self, _space: &Path, _repository: &Path) {}

    fn schedule_auto_sync(&self, _repository: &Path) {}

    fn publish_sync_state(
        &self,
        _repository: &Path,
        _active: bool,
        _background: bool,
        _report: Option<&SyncReport>,
        _error: Option<&SharedError>,
    ) {
    }

    fn publish_publication(
        &self,
        _repository: &Path,
        _child_head: &str,
        _parent: Option<&ParentPublication>,
    ) {
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog;
    use crate::dispatch::{check_tool, served_definitions};

    #[test]
    fn every_data_capability_is_served_and_the_explicit_run_is_unknown() {
        let host = StandaloneHost::new("test");
        let served = served_definitions(&host)
            .into_iter()
            .map(|definition| definition.name)
            .collect::<Vec<_>>();
        assert_eq!(served.len(), SERVED_TOOLS.len());
        assert_eq!(served.len() + 3, catalog::definitions().len());
        let session = StandaloneHost::session("test");
        assert_eq!(served_definitions(&session).len(), SERVED_TOOLS.len());
        for name in served {
            assert!(check_tool(&host, name).is_ok());
        }
        for name in [
            "run_routine",
            "get_app_status",
            "control_app",
            "no_such_tool",
        ] {
            assert_eq!(check_tool(&host, name).unwrap_err().code, "UNKNOWN_TOOL");
        }
    }

    #[tokio::test]
    async fn the_session_keeps_the_first_project() {
        let temp = tempfile::tempdir().unwrap();
        for name in ["a", "b"] {
            let dir = temp.path().join(name).join(".svode");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("config.json"), r#"{"name":"P"}"#).unwrap();
        }
        let host = StandaloneHost::new("test");
        host.open_project(&temp.path().join("a")).await.unwrap();
        let error = host.open_project(&temp.path().join("b")).await.unwrap_err();
        assert_eq!(error.code, "PROJECT_UNAVAILABLE");
        let error = StandaloneHost::new("test")
            .open_project(&temp.path().join("missing"))
            .await
            .unwrap_err();
        assert_eq!(error.code, "PROJECT_UNAVAILABLE");
        host.close().await;
    }
}

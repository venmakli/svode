//! Standalone host of the `svode` and `svode-mcp --project` processes.
//!
//! One implementation of the host seam over the `svode-core` project
//! runtime session, shared by both entrypoints. The process freezes its
//! target before the first operation; the session binds to that Project on
//! first need and opens stores only for the capabilities that need them.
//! Index-backed reads reconcile their pools with the files first, since no
//! watcher keeps them current. Capabilities of the headless catalog that
//! this build does not serve yet answer `MODE_UNAVAILABLE` before any
//! effect.

use std::path::Path;
use std::time::Duration;

use sqlx::SqlitePool;
use svode_core::attachments::import::{LfsReadiness, ManagedImportDelivery};
use svode_core::git::access::RepositoryAccessSnapshot;
use svode_core::index::IndexKey;
use svode_core::index::freshness::IndexFreshness;
use svode_core::index::knowledge::KnowledgeScope;
use svode_core::routines::model::ResolvedRoutineOwner;
use svode_core::runtime::session::{ProjectSession, SessionError};

use crate::catalog;
use crate::error::ToolError;
use crate::host::{MutationRuntime, ReadRuntime, RoutineRunner, RoutineRuntime, ToolHost};
use crate::target::context_error;

/// Catalog tools a standalone process serves: reads answered from project
/// sources, the index reconciled with them, Git or the Actor catalog, and
/// tools answered from their input.
const SERVED_TOOLS: [&str; 21] = [
    "get_svode_guide",
    "validate_app_manifest",
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
    "search_pages",
    "search_knowledge",
    "get_knowledge_node",
    "get_knowledge_neighbors",
    "get_related_context",
    "get_knowledge_status",
    "get_git_status",
];

/// Capability that is never headless: an explicit Routine launch needs the
/// Desktop execution owner.
const DESKTOP_ONLY_TOOL: &str = "run_routine";

/// Upper bound of closing session-owned resources at process exit.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

/// A capability of the headless catalog this build does not serve yet.
pub fn mode_unavailable(what: &str) -> ToolError {
    ToolError::new(
        "MODE_UNAVAILABLE",
        format!("{what} is not available in the Svode headless runtime of this build yet"),
    )
}

pub struct StandaloneHost {
    version: &'static str,
    session: ProjectSession,
}

impl StandaloneHost {
    /// Host reporting `version` as the build version of its binary. It
    /// opens nothing until an operation needs the Project.
    pub fn new(version: &'static str) -> Self {
        Self {
            version,
            session: ProjectSession::new(),
        }
    }

    /// Binds the runtime session to the frozen target Project. A session
    /// never switches to another Project.
    pub async fn open_project(&self, project: &Path) -> Result<(), ToolError> {
        self.session
            .open_project(project)
            .await
            .map(|_| ())
            .map_err(session_error)
    }

    /// Rejects a call of a headless capability that this build does not
    /// serve yet. Tools outside the headless catalog pass through to the
    /// shared `UNKNOWN_TOOL` check.
    pub fn check_call(&self, name: &str) -> Result<(), ToolError> {
        if !self.serves_tool(name)
            && name != DESKTOP_ONLY_TOOL
            && catalog::is_mutating_tool(name).is_some()
        {
            return Err(mode_unavailable(&format!("`{name}`")));
        }
        Ok(())
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

fn session_error(error: SessionError) -> ToolError {
    match error {
        SessionError::Project(error) => context_error(error, "PROJECT_UNAVAILABLE"),
        error @ SessionError::OtherProject { .. } => {
            ToolError::new("PROJECT_UNAVAILABLE", error.to_string())
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

    async fn prepare_index(
        &self,
        project: &Path,
        scope: &KnowledgeScope,
    ) -> Result<IndexFreshness, ToolError> {
        let project = self
            .session
            .open_project(project)
            .await
            .map_err(session_error)?;
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

    async fn require_mutation_access(&self, _repository: &Path) -> Result<(), ToolError> {
        Err(mode_unavailable("A managed mutation"))
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
        None
    }

    /// A headless process has no invalidation consumers.
    fn deliver_managed_import(&self, _delivery: &ManagedImportDelivery) {}

    fn routine_runtime(&self) -> Result<RoutineRuntime<'_>, ToolError> {
        Err(mode_unavailable("Routine definitions"))
    }

    /// A headless process has no invalidation consumers.
    fn deliver_routine_invalidation(&self, _owner: &ResolvedRoutineOwner) {}

    fn routine_runner(&self) -> Option<&dyn RoutineRunner> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch::{check_tool, served_definitions};

    #[test]
    fn unserved_headless_capabilities_are_mode_unavailable_and_others_unknown() {
        let host = StandaloneHost::new("test");
        let served = served_definitions(&host)
            .into_iter()
            .map(|definition| definition.name)
            .collect::<Vec<_>>();
        assert_eq!(served.len(), SERVED_TOOLS.len());
        for name in served {
            assert!(host.check_call(name).is_ok());
            assert!(check_tool(&host, name).is_ok());
        }

        let pending = host.check_call("write_page").unwrap_err();
        assert_eq!(pending.code, "MODE_UNAVAILABLE");
        for name in [DESKTOP_ONLY_TOOL, "no_such_tool"] {
            assert!(host.check_call(name).is_ok());
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

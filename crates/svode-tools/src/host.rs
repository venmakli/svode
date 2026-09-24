//! Host seam of the shared tool surface.
//!
//! A host decides the project and default Space of a request before dispatch
//! and owns every runtime handle (index pools, repository access, Routine
//! runtime). The library resolves public selectors inside that frozen target
//! and calls `svode-core`; it never opens stores or looks up a window.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;

use sqlx::SqlitePool;
use svode_core::actors::resolver::ActorCatalogState;
use svode_core::attachments::import::{LfsReadiness, ManagedImportDelivery};
use svode_core::git::access::RepositoryAccessSnapshot;
use svode_core::git::state::GitRuntime;
use svode_core::index::IndexKey;
use svode_core::index::freshness::IndexFreshness;
use svode_core::index::knowledge::KnowledgeScope;
use svode_core::index::state::IndexRuntimeState;
use svode_core::index::update::IndexUpdateState;
use svode_core::page::nonce::WriteNonceRegistry;
use svode_core::routines::model::{
    ResolvedRoutineOwner, RoutineDispatchResult, RoutineLiveEvidence,
};
use svode_core::routines::store_state::RoutineStoreState;

use crate::error::ToolError;

/// Host-owned runtime a managed mutation publishes into: the Project index,
/// Routine observation updates and watcher echo nonces. One instance per
/// host, shared with its other writers.
#[derive(Clone, Copy)]
pub struct MutationRuntime<'a> {
    pub index: &'a IndexRuntimeState,
    pub updates: &'a IndexUpdateState,
    pub nonces: &'a WriteNonceRegistry,
}

/// Host-owned runtime shared by index-backed reads: the Project index state
/// with its pools and knowledge snapshots, the Actor catalog and the Git
/// runtime. The library reads through them and never opens its own.
#[derive(Clone, Copy)]
pub struct ReadRuntime<'a> {
    pub index: &'a IndexRuntimeState,
    pub actors: &'a ActorCatalogState,
    pub git: &'a GitRuntime,
}

/// Host-owned Routine runtime of one call: the shared operational stores and
/// the live execution evidence observed by the host when the call started.
pub struct RoutineRuntime<'a> {
    pub stores: &'a RoutineStoreState,
    pub live_evidence: RoutineLiveEvidence,
}

/// Environment variable that carries the opaque caller token of a managed
/// Routine launch into the processes it starts.
pub const ROUTINE_CALLER_TOKEN_ENV: &str = "SVODE_MCP_ROUTINE_CALLER_TOKEN";

/// Routine-launched caller of a request. The library only distinguishes
/// Routine origin and never takes caller identity from public arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoutineCaller {
    /// Provenance the host verified against a live managed launch before
    /// dispatch.
    Launch {
        routine_run_id: String,
        launch_id: String,
        pty_id: String,
    },
    /// Routine origin claimed by the environment of a standalone process
    /// started from a Routine launch. No host there can verify it, so it
    /// only restricts the caller.
    Claimed,
}

/// Explicit launch of a manual or schedule Routine by the host execution
/// owner. It returns once the launch is decided, without waiting for the run.
pub trait RoutineRunner: Sync {
    fn run(
        &self,
        owner: ResolvedRoutineOwner,
        routine_id: String,
        expected_fingerprint: String,
    ) -> Pin<Box<dyn Future<Output = Result<RoutineDispatchResult, ToolError>> + Send + '_>>;
}

/// Project, default Space and caller provenance frozen by the host for one
/// request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestTarget {
    pub project_path: String,
    /// Registered child Space id of the default Space; `None` means the root.
    pub default_space_id: Option<String>,
    pub default_space_path: String,
    /// Routine origin of the caller; `None` for an ordinary external caller.
    pub routine_caller: Option<RoutineCaller>,
}

pub trait ToolHost: Sync {
    /// Build version of the host process, reported as `serverInfo.version`.
    fn version(&self) -> &str;

    /// Whether this host serves a catalog tool. Tools outside the declared
    /// set are neither published nor dispatched.
    fn serves_tool(&self, name: &str) -> bool;

    /// Binds the host runtime to the frozen target Project of a process
    /// before its first operation. A host whose runtime already serves its
    /// open Projects needs nothing.
    fn open_project(&self, _project: &Path) -> impl Future<Output = Result<(), ToolError>> + Send {
        async { Ok(()) }
    }

    /// Prepares the index pools and Routine observation a managed mutation
    /// of `paths` publishes into, once its repositories are authorized and
    /// before its source phase. A host whose watcher keeps its open pools
    /// current needs nothing; a failure leaves the mutation to publish with
    /// a projection warning.
    fn prepare_mutation(&self, _paths: &[PathBuf]) -> impl Future<Output = ()> + Send {
        async {}
    }

    /// Explicit verification of the repository access of a Space through
    /// the shared service-ref probe, recorded in the evidence store of the
    /// install. It is CLI diagnostics, not a catalog tool; a host that does
    /// not run it refuses.
    fn verify_repository_access(
        &self,
        _space_path: &Path,
    ) -> impl Future<Output = Result<RepositoryAccessSnapshot, ToolError>> + Send {
        async {
            Err(ToolError::new(
                "MODE_UNAVAILABLE",
                "This Svode host does not verify repository access",
            ))
        }
    }

    /// Prepares the index pools of an index-backed read in `scope` and
    /// reports their freshness; an index that cannot answer fails with
    /// `INDEX_UNAVAILABLE`, never as an empty result. By default the host
    /// reports the pools its runtime keeps open without preparing them.
    fn prepare_index(
        &self,
        project: &Path,
        scope: &KnowledgeScope,
    ) -> impl Future<Output = Result<IndexFreshness, ToolError>> + Send {
        open_index_freshness(self.read_runtime().index, project, scope)
    }

    /// Existing index pool for a read target. `None` leaves filesystem
    /// facts intact; the host never rebuilds an index for this call.
    fn index_pool(
        &self,
        key: &IndexKey,
        space_path: &Path,
    ) -> impl Future<Output = Option<SqlitePool>> + Send;

    /// Current repository access state of a Space directory.
    fn repository_access(
        &self,
        space_path: &Path,
    ) -> impl Future<Output = Result<RepositoryAccessSnapshot, ToolError>> + Send;

    /// Authorizes a managed mutation of one local repository from its
    /// current access state, without a network probe.
    fn require_mutation_access(
        &self,
        repository: &Path,
    ) -> impl Future<Output = Result<(), ToolError>> + Send;

    /// Shared runtime handles of managed mutations.
    fn mutation_runtime(&self) -> MutationRuntime<'_>;

    /// Shared runtime handles of index-backed reads.
    fn read_runtime(&self) -> ReadRuntime<'_>;

    /// Live Git LFS readiness of the host storage backend. `None` means the
    /// host cannot prove readiness, so a managed import refuses LFS routes.
    fn lfs_readiness(&self) -> Option<&dyn LfsReadiness>;

    /// Delivers the invalidation of a successful managed import to the host
    /// consumers. The source result does not depend on it.
    fn deliver_managed_import(&self, delivery: &ManagedImportDelivery);

    /// Shared Routine runtime of one call.
    fn routine_runtime(&self) -> Result<RoutineRuntime<'_>, ToolError>;

    /// Delivers the invalidation of an applied Routine definition change to
    /// the host consumers of that owner. The source result does not depend
    /// on it.
    fn deliver_routine_invalidation(&self, owner: &ResolvedRoutineOwner);

    /// Explicit Routine launch of the host. `None` means the host cannot run
    /// Routines, so `run_routine` is neither published nor dispatched.
    fn routine_runner(&self) -> Option<&dyn RoutineRunner>;
}

/// Freshness of the pools `index` already holds open for a read in `scope`,
/// without opening or checking them: a pool that is not open makes the read
/// unavailable.
pub async fn open_index_freshness(
    index: &IndexRuntimeState,
    project: &Path,
    scope: &KnowledgeScope,
) -> Result<IndexFreshness, ToolError> {
    let keys = index.keys_for_scope(project, scope).await?;
    Ok(index.freshness(&keys).await?)
}

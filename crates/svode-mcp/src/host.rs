//! Host seam of the shared MCP mapping.
//!
//! A host decides the project and default Space of a request before dispatch
//! and owns every runtime handle (index pools, repository access, Routine
//! runtime). The library resolves public selectors inside that frozen target
//! and calls `svode-core`; it never opens stores or looks up a window.

use std::future::Future;
use std::path::Path;
use std::pin::Pin;

use sqlx::SqlitePool;
use svode_core::actors::resolver::ActorCatalogState;
use svode_core::attachments::import::{LfsReadiness, ManagedImportDelivery};
use svode_core::git::access::RepositoryAccessSnapshot;
use svode_core::git::state::GitRuntime;
use svode_core::index::IndexKey;
use svode_core::index::state::IndexRuntimeState;
use svode_core::index::update::IndexUpdateState;
use svode_core::page::nonce::WriteNonceRegistry;
use svode_core::routines::model::{
    ResolvedRoutineOwner, RoutineDispatchResult, RoutineLiveEvidence,
};
use svode_core::routines::store_state::RoutineStoreState;

use crate::error::McpBusinessError;

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

/// Routine-launched caller of a request. The host verifies it against a live
/// managed launch before dispatch; the library only distinguishes Routine
/// origin and never takes caller identity from public arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoutineCaller {
    pub routine_run_id: String,
    pub launch_id: String,
    pub pty_id: String,
}

/// Explicit launch of a manual or schedule Routine by the host execution
/// owner. It returns once the launch is decided, without waiting for the run.
pub trait RoutineRunner: Sync {
    fn run(
        &self,
        owner: ResolvedRoutineOwner,
        routine_id: String,
        expected_fingerprint: String,
    ) -> Pin<Box<dyn Future<Output = Result<RoutineDispatchResult, McpBusinessError>> + Send + '_>>;
}

/// Project, default Space and caller provenance frozen by the host for one
/// request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestTarget {
    pub project_path: String,
    /// Registered child Space id of the default Space; `None` means the root.
    pub default_space_id: Option<String>,
    pub default_space_path: String,
    /// Verified Routine provenance; `None` for an ordinary external caller.
    pub routine_caller: Option<RoutineCaller>,
}

pub trait McpHost: Sync {
    /// Build version of the host process, reported as `serverInfo.version`.
    fn version(&self) -> &str;

    /// Whether this host serves a catalog tool. Tools outside the declared
    /// set are neither published nor dispatched.
    fn serves_tool(&self, name: &str) -> bool;

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
    ) -> impl Future<Output = Result<RepositoryAccessSnapshot, McpBusinessError>> + Send;

    /// Authorizes a managed mutation of one local repository from its
    /// current access state, without a network probe.
    fn require_mutation_access(
        &self,
        repository: &Path,
    ) -> impl Future<Output = Result<(), McpBusinessError>> + Send;

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
    fn routine_runtime(&self) -> Result<RoutineRuntime<'_>, McpBusinessError>;

    /// Delivers the invalidation of an applied Routine definition change to
    /// the host consumers of that owner. The source result does not depend
    /// on it.
    fn deliver_routine_invalidation(&self, owner: &ResolvedRoutineOwner);

    /// Explicit Routine launch of the host. `None` means the host cannot run
    /// Routines, so `run_routine` is neither published nor dispatched.
    fn routine_runner(&self) -> Option<&dyn RoutineRunner>;
}

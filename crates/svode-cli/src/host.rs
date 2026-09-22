//! Standalone host of the `svode` process until the headless runtime is
//! connected: it serves only the reads answered from project sources and
//! opens no index, Git runtime, repository access store or Routine store.

use std::path::Path;

use sqlx::SqlitePool;
use svode_core::attachments::import::{LfsReadiness, ManagedImportDelivery};
use svode_core::git::access::RepositoryAccessSnapshot;
use svode_core::index::IndexKey;
use svode_core::routines::model::ResolvedRoutineOwner;
use svode_tools::error::ToolError;
use svode_tools::host::{MutationRuntime, ReadRuntime, RoutineRunner, RoutineRuntime, ToolHost};

/// Catalog tools answered from project sources alone, or from their input.
const SOURCE_TOOLS: [&str; 11] = [
    "get_svode_guide",
    "validate_app_manifest",
    "get_project_info",
    "list_spaces",
    "list_pages",
    "list_collections",
    "get_collection_schema",
    "read_space_readme",
    "read_collection_readme",
    "read_collection_item",
    "validate_collection_integrity",
];

pub struct SourceHost;

pub fn mode_unavailable(what: &str) -> ToolError {
    ToolError::new(
        "MODE_UNAVAILABLE",
        format!("{what} needs the Svode headless runtime, which this build does not include"),
    )
}

impl ToolHost for SourceHost {
    fn version(&self) -> &str {
        env!("CARGO_PKG_VERSION")
    }

    fn serves_tool(&self, name: &str) -> bool {
        SOURCE_TOOLS.contains(&name)
    }

    async fn index_pool(&self, _key: &IndexKey, _space_path: &Path) -> Option<SqlitePool> {
        None
    }

    async fn repository_access(
        &self,
        _space_path: &Path,
    ) -> Result<RepositoryAccessSnapshot, ToolError> {
        Err(mode_unavailable("Repository access state"))
    }

    async fn require_mutation_access(&self, _repository: &Path) -> Result<(), ToolError> {
        Err(mode_unavailable("A managed mutation"))
    }

    fn mutation_runtime(&self) -> MutationRuntime<'_> {
        unreachable!("the source host serves no mutating tool")
    }

    fn read_runtime(&self) -> ReadRuntime<'_> {
        unreachable!("the source host serves no index-backed read")
    }

    fn lfs_readiness(&self) -> Option<&dyn LfsReadiness> {
        None
    }

    fn deliver_managed_import(&self, _delivery: &ManagedImportDelivery) {
        unreachable!("the source host serves no managed import")
    }

    fn routine_runtime(&self) -> Result<RoutineRuntime<'_>, ToolError> {
        Err(mode_unavailable("Routine definitions"))
    }

    fn deliver_routine_invalidation(&self, _owner: &ResolvedRoutineOwner) {
        unreachable!("the source host serves no Routine mutation")
    }

    fn routine_runner(&self) -> Option<&dyn RoutineRunner> {
        None
    }
}

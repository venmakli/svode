//! Host seam of the shared MCP mapping.
//!
//! A host decides the project and default Space of a request before dispatch
//! and owns every runtime handle (index pools, repository access, Routine
//! runtime). The library resolves public selectors inside that frozen target
//! and calls `svode-core`; it never opens stores or looks up a window.

use std::future::Future;
use std::path::Path;

use serde_json::Value;
use sqlx::SqlitePool;
use svode_core::git::access::RepositoryAccessSnapshot;
use svode_core::index::IndexKey;

use crate::error::McpBusinessError;
use crate::protocol::ToolCallResult;

/// Project and default Space frozen by the host for one request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestTarget {
    pub project_path: String,
    /// Registered child Space id of the default Space; `None` means the root.
    pub default_space_id: Option<String>,
    pub default_space_path: String,
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

    /// Temporary routing of tool families not yet mapped by the library.
    /// Removed together with the last host-owned handlers in slice 3.2.5.
    fn call_host_tool(
        &self,
        name: &str,
        args: Value,
    ) -> impl Future<Output = Result<ToolCallResult, McpBusinessError>> + Send;
}

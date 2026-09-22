//! MCP control plane over the shared tool surface: protocol version,
//! instructions, the published catalog and routing of bridge methods. The
//! host here only declares its catalog; tool execution is covered by the
//! `svode-tools` fixture host tests.

use std::future::Future;
use std::path::Path;
use std::pin::Pin;

use serde_json::{Value, json};
use sqlx::SqlitePool;
use svode_core::attachments::import::{LfsReadiness, ManagedImportDelivery};
use svode_core::git::access::RepositoryAccessSnapshot;
use svode_core::index::IndexKey;
use svode_core::routines::model::{ResolvedRoutineOwner, RoutineDispatchResult};
use svode_mcp::control::{self, BridgeCall, MCP_PROTOCOL_VERSION};
use svode_mcp::protocol::IpcResponse;
use svode_tools::error::ToolError;
use svode_tools::host::{MutationRuntime, ReadRuntime, RoutineRunner, RoutineRuntime, ToolHost};

const LIMITED_CATALOG: [&str; 3] = ["read_page", "list_spaces", "get_svode_guide"];

struct CatalogHost {
    served: Option<&'static [&'static str]>,
    runner: Option<NoRunner>,
}

impl CatalogHost {
    fn full() -> Self {
        Self {
            served: None,
            runner: Some(NoRunner),
        }
    }
}

struct NoRunner;

impl RoutineRunner for NoRunner {
    fn run(
        &self,
        _owner: ResolvedRoutineOwner,
        _routine_id: String,
        _expected_fingerprint: String,
    ) -> Pin<Box<dyn Future<Output = Result<RoutineDispatchResult, ToolError>> + Send + '_>> {
        unreachable!("the control plane never launches a Routine")
    }
}

impl ToolHost for CatalogHost {
    fn version(&self) -> &str {
        "9.9.9-fixture"
    }

    fn serves_tool(&self, name: &str) -> bool {
        self.served.is_none_or(|served| served.contains(&name))
    }

    async fn index_pool(&self, _key: &IndexKey, _space_path: &Path) -> Option<SqlitePool> {
        unreachable!("the control plane never reads an index")
    }

    async fn repository_access(
        &self,
        _space_path: &Path,
    ) -> Result<RepositoryAccessSnapshot, ToolError> {
        unreachable!("the control plane never reads repository access")
    }

    async fn require_mutation_access(&self, _repository: &Path) -> Result<(), ToolError> {
        unreachable!("the control plane never mutates")
    }

    fn mutation_runtime(&self) -> MutationRuntime<'_> {
        unreachable!("the control plane never mutates")
    }

    fn read_runtime(&self) -> ReadRuntime<'_> {
        unreachable!("the control plane never reads project data")
    }

    fn lfs_readiness(&self) -> Option<&dyn LfsReadiness> {
        None
    }

    fn deliver_managed_import(&self, _delivery: &ManagedImportDelivery) {}

    fn routine_runtime(&self) -> Result<RoutineRuntime<'_>, ToolError> {
        unreachable!("the control plane never opens Routine stores")
    }

    fn deliver_routine_invalidation(&self, _owner: &ResolvedRoutineOwner) {}

    fn routine_runner(&self) -> Option<&dyn RoutineRunner> {
        self.runner
            .as_ref()
            .map(|runner| runner as &dyn RoutineRunner)
    }
}

fn tool_names(host: &CatalogHost) -> Vec<String> {
    control::tools_list(host)["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap().to_string())
        .collect()
}

fn respond(host: &CatalogHost, method: &str, params: Value) -> IpcResponse {
    match control::bridge_request(host, method, &params) {
        BridgeCall::Respond(response) => response,
        BridgeCall::CallTool { name, .. } => panic!("unexpected tool call {name}"),
    }
}

#[test]
fn control_plane_reports_host_version_and_filtered_catalog() {
    let host = CatalogHost::full();
    let initialize = control::initialize(host.version());
    assert_eq!(initialize["protocolVersion"], MCP_PROTOCOL_VERSION);
    assert_eq!(initialize["protocolVersion"], "2025-06-18");
    assert_eq!(initialize["serverInfo"]["version"], "9.9.9-fixture");
    assert!(initialize["instructions"].as_str().is_some_and(|value| {
        value.contains("Call get_svode_guide")
            && value.contains("Routine-launched")
            && value.contains("canonical contentPath")
            && value.contains("validate_app_manifest")
    }));

    assert_eq!(tool_names(&host).len(), 54);
    let limited = CatalogHost {
        served: Some(&LIMITED_CATALOG),
        ..CatalogHost::full()
    };
    assert_eq!(tool_names(&limited), LIMITED_CATALOG_ORDER);
}

/// Catalog order of `LIMITED_CATALOG`: `tools/list` keeps catalog order, not
/// the order a host declares.
const LIMITED_CATALOG_ORDER: [&str; 3] = ["list_spaces", "read_page", "get_svode_guide"];

#[test]
fn bridge_methods_keep_protocol_and_business_envelopes_apart() {
    let host = CatalogHost::full();
    assert_eq!(
        respond(&host, "initialize", json!({})).result.unwrap()["serverInfo"]["version"],
        "9.9.9-fixture"
    );
    assert_eq!(
        respond(&host, "ping", json!({})).result.unwrap()["ok"],
        true
    );
    assert_eq!(
        respond(&host, "tools/call", json!({ "name": "legacy_tool" }))
            .error
            .unwrap()
            .code,
        "UNKNOWN_TOOL"
    );
    assert_eq!(
        respond(&host, "tools/call", json!({})).error.unwrap().code,
        "INVALID_REQUEST"
    );
    assert_eq!(
        respond(&host, "resources/list", json!({}))
            .error
            .unwrap()
            .code,
        "UNKNOWN_METHOD"
    );
    match control::bridge_request(&host, "tools/call", &json!({ "name": "read_page" })) {
        BridgeCall::CallTool { name, args } => {
            assert_eq!(name, "read_page");
            assert_eq!(args, json!({}));
        }
        BridgeCall::Respond(_) => panic!("known tool must reach the host request context"),
    }
}

#[test]
fn run_routine_is_neither_published_nor_routed_without_a_host_runner() {
    let host = CatalogHost {
        runner: None,
        ..CatalogHost::full()
    };
    let names = tool_names(&host);
    assert_eq!(names.len(), 53);
    assert!(!names.contains(&"run_routine".to_string()));
    assert_eq!(
        respond(&host, "tools/call", json!({ "name": "run_routine" }))
            .error
            .unwrap()
            .code,
        "UNKNOWN_TOOL"
    );
}

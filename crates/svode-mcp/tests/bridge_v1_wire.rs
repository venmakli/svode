use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use svode_mcp::protocol::{DiscoveryFile, IpcRequest, IpcResponse};
use svode_mcp::{
    MCP_BRIDGE_PROTOCOL, MCP_DISCOVERY_ENV, MCP_MANAGED_MARKER_ENV, MCP_MANAGED_MARKER_VALUE,
    MCP_PROJECT_PATH_ENV, MCP_ROUTINE_CALLER_TOKEN_ENV,
};
use svode_tools::error::ToolError;
use svode_tools::result::ToolCallResult;

fn fixture(name: &str) -> String {
    std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/bridge-v1")
            .join(name),
    )
    .expect("fixture")
}

fn assert_round_trip<T: DeserializeOwned + Serialize>(name: &str) -> T {
    let raw = fixture(name);
    let expected: Value = serde_json::from_str(&raw).expect("fixture json");
    let decoded: T = serde_json::from_str(&raw).expect("fixture decodes");
    assert_eq!(
        serde_json::to_value(&decoded).expect("encode"),
        expected,
        "{name} must keep its bridge-v1 wire shape"
    );
    decoded
}

#[test]
fn bridge_identity_env_names_and_managed_marker_are_unchanged() {
    assert_eq!(MCP_BRIDGE_PROTOCOL, "svode-desktop-bridge-v1");
    assert_eq!(MCP_MANAGED_MARKER_ENV, "SVODE_MCP_MANAGED");
    assert_eq!(MCP_MANAGED_MARKER_VALUE, "svode-desktop-bridge-v1");
    assert_eq!(MCP_DISCOVERY_ENV, "SVODE_MCP_DISCOVERY");
    assert_eq!(MCP_PROJECT_PATH_ENV, "SVODE_MCP_PROJECT_PATH");
    assert_eq!(
        MCP_ROUTINE_CALLER_TOKEN_ENV,
        "SVODE_MCP_ROUTINE_CALLER_TOKEN"
    );
}

#[test]
fn requests_keep_bridge_v1_shape() {
    let request: IpcRequest = assert_round_trip("request.json");
    let context = request.context.expect("context override");
    assert_eq!(context.project_path.as_deref(), Some("/work/project"));
    assert_eq!(context.caller_cwd.as_deref(), Some("/work/project/space"));
    assert_eq!(
        context.routine_caller_token.as_deref(),
        Some("opaque-token")
    );

    let minimal: IpcRequest = assert_round_trip("request-minimal.json");
    assert!(minimal.context.is_none());
}

#[test]
fn responses_keep_bridge_v1_shape() {
    assert_round_trip::<IpcResponse>("response-result.json");
    assert_round_trip::<IpcResponse>("response-tool-result.json");
    assert_round_trip::<IpcResponse>("response-error.json");

    let business: IpcResponse = assert_round_trip("response-tool-business-error.json");
    let expected = ToolCallResult::business_error(ToolError::new(
        "REPOSITORY_ACCESS_DENIED",
        "repository is read only",
    ));
    assert_eq!(
        serde_json::to_value(business.tool_result).unwrap(),
        serde_json::to_value(Some(expected)).unwrap()
    );
}

#[test]
fn discovery_keeps_bridge_v1_shape() {
    let discovery: DiscoveryFile = assert_round_trip("discovery.json");
    assert_eq!(discovery.bridge_protocol, MCP_BRIDGE_PROTOCOL);
}

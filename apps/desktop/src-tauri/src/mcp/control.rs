use serde_json::{Value, json};

use super::MCP_VERSION;

pub const MCP_PROTOCOL_VERSION: &str = "2025-06-18";

const MCP_INSTRUCTIONS: &str = "Use Svode MCP as a product API, not as raw filesystem access. Discover explicit Routine owners with list_spaces/list_collections and read fingerprints with list_routines/get_routine. Use managed create_routine/update_routine/delete_routine for definitions and run_routine only for an explicit manual/schedule launch. Routine actions do not autocommit; enabled schedule/event writes require confirmAutomaticExecution=true without changing device authority, and Routine-launched agents cannot recurse. Create Collections for structured repeated data and Pages for narrative knowledge. Use owner README and Collection item tools for those contexts. Import new local binary files with import_asset and continue with its returned canonical contentPath after any managed Page conversion. Call get_svode_guide when unsure.";

pub fn initialize() -> Value {
    json!({
        "protocolVersion": MCP_PROTOCOL_VERSION,
        "serverInfo": { "name": "svode", "version": MCP_VERSION },
        "capabilities": { "tools": {} },
        "instructions": MCP_INSTRUCTIONS,
    })
}

pub fn tools_list() -> Value {
    json!({ "tools": super::tools::definitions() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_control_plane_owns_initialize_and_catalog() {
        let initialize = initialize();
        let tools = tools_list();

        assert_eq!(initialize["protocolVersion"], MCP_PROTOCOL_VERSION);
        assert_eq!(initialize["serverInfo"]["version"], MCP_VERSION);
        assert!(initialize["instructions"].as_str().is_some_and(|value| {
            value.contains("Call get_svode_guide")
                && value.contains("Routine-launched")
                && value.contains("canonical contentPath")
        }));
        assert!(
            tools["tools"]
                .as_array()
                .is_some_and(|tools| tools.iter().any(|tool| tool["name"] == "get_svode_guide"))
        );
    }
}

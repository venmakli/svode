//! MCP calls inside ACP tool calls (Stage 10 `08` R7). ACP has no MCP call
//! of its own: each agent sends one in its own form, so a call is
//! recognized only by the form of the agent that sent it, live and in
//! replay alike, and never by a title that merely looks like one.

use serde_json::Value;
use svode_core::agent_adapters::AgentAdapterKind;

use super::normalize::bounded;

/// Longer server and tool names are cut, like other agent labels.
const NAME_LIMIT: usize = 128;
/// The name the connection of `03` gives the Svode MCP server in an
/// agent's config.
const SVODE_SERVER: &str = "svode";
/// The Svode MCP server of the Svode plugin in Claude Code.
const CLAUDE_CODE_PLUGIN_SERVER: &str = "plugin_svode_svode";

/// What one ACP tool call update says that an agent's form of an MCP call
/// is made of. Fields the update does not carry are `None`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct CallFacts {
    pub title: Option<String>,
    pub raw_input: Option<Value>,
    pub raw_output: Option<Value>,
    pub meta: Option<Value>,
}

/// The server and tool of a recognized call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct McpTool {
    pub server: String,
    pub tool: String,
}

/// One MCP call of a tool call as one update states it: its arguments and
/// result when this update carries them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct McpCall {
    pub tool: McpTool,
    pub arguments: Option<Value>,
    pub result: Option<McpResult>,
}

/// A result the agent sent in a machine-readable form.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum McpResult {
    /// The structured content of the result, or its JSON text parsed.
    Value(Value),
    /// The server or the agent reported the call as failed.
    Error,
}

/// The MCP calls of a tool call update of `agent`, in order. `known` are
/// the calls earlier updates of the same tool call were recognized as: an
/// update of a recognized call may carry only its result. Empty when the
/// tool call is not an MCP call in a form of this agent.
pub(crate) fn recognize(
    agent: Option<AgentAdapterKind>,
    facts: &CallFacts,
    known: &[McpTool],
) -> Vec<McpCall> {
    match agent {
        Some(AgentAdapterKind::Codex) => codex(facts, known),
        Some(AgentAdapterKind::ClaudeCode) => claude_code(facts),
        _ => Vec::new(),
    }
}

/// Whether `server` is the Svode MCP server of `agent`'s connection.
pub(crate) fn is_svode_server(agent: Option<AgentAdapterKind>, server: &str) -> bool {
    server == SVODE_SERVER
        || (agent == Some(AgentAdapterKind::ClaudeCode) && server == CLAUDE_CODE_PLUGIN_SERVER)
}

/// Codex: kind `execute`, title `mcp.<server>.<tool>` and
/// `_meta.is_mcp_tool_call`; `rawInput` holds `server`, `tool` and
/// `arguments`, `rawOutput` the `CallToolResult` and an `error`.
fn codex(facts: &CallFacts, known: &[McpTool]) -> Vec<McpCall> {
    let flagged = facts
        .meta
        .as_ref()
        .and_then(|meta| meta.get("is_mcp_tool_call"))
        .and_then(Value::as_bool)
        == Some(true);
    let input = facts.raw_input.as_ref();
    let tool = match flagged {
        true => named(
            input.and_then(|input| input.get("server")),
            input.and_then(|input| input.get("tool")),
        )
        .or_else(|| {
            let (server, tool) = facts
                .title
                .as_deref()?
                .strip_prefix("mcp.")?
                .rsplit_once('.')?;
            tool_of(server, tool)
        }),
        false => None,
    };
    let Some(tool) = tool.or_else(|| known.first().cloned()) else {
        return Vec::new();
    };
    let result = facts.raw_output.as_ref().map(|output| {
        let failed = output.get("error").is_some_and(|error| !error.is_null());
        match output.get("result") {
            Some(result) if !failed => call_tool_result(result),
            _ => McpResult::Error,
        }
    });
    vec![McpCall {
        tool,
        arguments: input
            .filter(|_| flagged)
            .and_then(|input| input.get("arguments"))
            .cloned(),
        result: result.filter(|result| *result != McpResult::Value(Value::Null)),
    }]
}

/// Claude Code: kind `other`, title and `_meta.claudeCode.toolName`
/// `mcp__<server>__<tool>`; `rawInput` is the arguments, `rawOutput` the
/// result as JSON text.
fn claude_code(facts: &CallFacts) -> Vec<McpCall> {
    let Some(tool) = facts
        .meta
        .as_ref()
        .and_then(|meta| meta.pointer("/claudeCode/toolName"))
        .and_then(Value::as_str)
        .and_then(|name| name.strip_prefix("mcp__"))
        .and_then(|name| name.split_once("__"))
        .and_then(|(server, tool)| tool_of(server, tool))
    else {
        return Vec::new();
    };
    vec![McpCall {
        tool,
        arguments: facts.raw_input.clone(),
        result: facts.raw_output.as_ref().and_then(json_text),
    }]
}

fn named(server: Option<&Value>, tool: Option<&Value>) -> Option<McpTool> {
    tool_of(server?.as_str()?, tool?.as_str()?)
}

fn tool_of(server: &str, tool: &str) -> Option<McpTool> {
    (!server.is_empty() && !tool.is_empty()).then(|| McpTool {
        server: bounded(server, NAME_LIMIT),
        tool: bounded(tool, NAME_LIMIT),
    })
}

/// An MCP `CallToolResult`: its structured content, else its one JSON text
/// block; a result with `isError` failed.
fn call_tool_result(result: &Value) -> McpResult {
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        return McpResult::Error;
    }
    match result.get("structuredContent") {
        Some(structured) if !structured.is_null() => McpResult::Value(structured.clone()),
        _ => result
            .get("content")
            .and_then(json_text)
            .unwrap_or(McpResult::Value(Value::Null)),
    }
}

/// A result sent as JSON text, alone or as the only text block of content.
fn json_text(output: &Value) -> Option<McpResult> {
    let text = match output {
        Value::String(text) => text.as_str(),
        Value::Array(blocks) => match blocks.as_slice() {
            [block] if block.get("type").and_then(Value::as_str) == Some("text") => {
                block.get("text")?.as_str()?
            }
            _ => return None,
        },
        _ => return None,
    };
    let value: Value = serde_json::from_str(text).ok()?;
    Some(match value.get("error") {
        Some(error) if error.is_object() => McpResult::Error,
        _ => McpResult::Value(value),
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const CODEX: Option<AgentAdapterKind> = Some(AgentAdapterKind::Codex);
    const CLAUDE_CODE: Option<AgentAdapterKind> = Some(AgentAdapterKind::ClaudeCode);

    fn facts(update: Value) -> CallFacts {
        CallFacts {
            title: update["title"].as_str().map(str::to_string),
            raw_input: update.get("rawInput").cloned(),
            raw_output: update.get("rawOutput").cloned(),
            meta: update.get("_meta").cloned(),
        }
    }

    fn svode(tool: &str) -> McpTool {
        McpTool {
            server: "svode".into(),
            tool: tool.into(),
        }
    }

    #[test]
    fn a_codex_call_is_recognized_by_its_form_and_its_result_by_the_known_call() {
        let call = facts(json!({
            "kind": "execute",
            "title": "mcp.svode.create_page",
            "rawInput": { "server": "svode", "tool": "create_page", "arguments": { "parentPath": "notes", "title": "A" } },
            "_meta": { "is_mcp_tool_call": true }
        }));
        assert_eq!(
            recognize(CODEX, &call, &[]),
            vec![McpCall {
                tool: svode("create_page"),
                arguments: Some(json!({ "parentPath": "notes", "title": "A" })),
                result: None,
            }]
        );
        let result = facts(json!({
            "rawOutput": { "result": { "content": [{ "type": "text", "text": "Created" }], "structuredContent": { "path": "notes/A.md" } }, "error": null }
        }));
        assert_eq!(
            recognize(CODEX, &result, &[svode("create_page")]),
            vec![McpCall {
                tool: svode("create_page"),
                arguments: None,
                result: Some(McpResult::Value(json!({ "path": "notes/A.md" }))),
            }]
        );
        assert!(recognize(CODEX, &result, &[]).is_empty());
        let failed = facts(json!({ "rawOutput": { "result": null, "error": "denied" } }));
        assert_eq!(
            recognize(CODEX, &failed, &[svode("write_page")])[0].result,
            Some(McpResult::Error)
        );
        let refused =
            facts(json!({ "rawOutput": { "result": { "content": [], "isError": true } } }));
        assert_eq!(
            recognize(CODEX, &refused, &[svode("write_page")])[0].result,
            Some(McpResult::Error)
        );
    }

    #[test]
    fn a_claude_code_call_names_its_server_and_tool_and_parses_its_json_result() {
        let call = facts(json!({
            "kind": "other",
            "title": "mcp__plugin_svode_svode__create_page",
            "rawInput": { "spaceId": "root", "parentPath": "notes" },
            "rawOutput": "{\"path\":\"notes/E06 page.md\",\"changedPaths\":[]}",
            "_meta": { "claudeCode": { "toolName": "mcp__plugin_svode_svode__create_page" } }
        }));
        let [recognized] = recognize(CLAUDE_CODE, &call, &[]).try_into().unwrap();
        assert_eq!(recognized.tool.server, "plugin_svode_svode");
        assert_eq!(recognized.tool.tool, "create_page");
        assert_eq!(
            recognized.arguments,
            Some(json!({ "spaceId": "root", "parentPath": "notes" }))
        );
        assert_eq!(
            recognized.result,
            Some(McpResult::Value(
                json!({ "path": "notes/E06 page.md", "changedPaths": [] })
            ))
        );
        assert!(is_svode_server(CLAUDE_CODE, &recognized.tool.server));
        assert!(!is_svode_server(CODEX, "plugin_svode_svode"));
        assert!(is_svode_server(CODEX, "svode"));

        let blocks = facts(json!({
            "rawOutput": [{ "type": "text", "text": "probe" }, { "type": "image", "data": "x" }],
            "_meta": { "claudeCode": { "toolName": "mcp__svode_probe__probe_media" } }
        }));
        assert_eq!(recognize(CLAUDE_CODE, &blocks, &[])[0].result, None);
        let error = facts(json!({
            "rawOutput": "{\"error\":{\"code\":\"PAGE_NAME_CONFLICT\"}}",
            "_meta": { "claudeCode": { "toolName": "mcp__svode__create_page" } }
        }));
        assert_eq!(
            recognize(CLAUDE_CODE, &error, &[])[0].result,
            Some(McpResult::Error)
        );
    }

    #[test]
    fn a_title_without_the_form_or_of_another_agent_is_not_an_mcp_call() {
        let codex_title = facts(json!({
            "kind": "execute",
            "title": "mcp.svode.write_page",
            "rawInput": { "server": "svode", "tool": "write_page", "arguments": {} }
        }));
        assert!(recognize(CODEX, &codex_title, &[]).is_empty());
        let claude_title = facts(json!({ "kind": "other", "title": "mcp__svode__write_page" }));
        assert!(recognize(CLAUDE_CODE, &claude_title, &[]).is_empty());
        let builtin = facts(json!({ "_meta": { "claudeCode": { "toolName": "Edit" } } }));
        assert!(recognize(CLAUDE_CODE, &builtin, &[]).is_empty());
        let unknown_form = facts(json!({
            "title": "mcp__svode__write_page",
            "_meta": { "claudeCode": { "toolName": "mcp__svode__write_page" }, "is_mcp_tool_call": true }
        }));
        assert!(recognize(Some(AgentAdapterKind::Opencode), &unknown_form, &[]).is_empty());
        assert!(recognize(None, &unknown_form, &[]).is_empty());
    }
}

//! MCP calls inside ACP tool calls (Stage 10 `08` R7). ACP has no MCP call
//! of its own: each agent sends one in its own form, some through a
//! meta-tool, so a call is recognized only by the form of the agent that
//! sent it, live and in replay alike, and never by a title that merely
//! looks like one. Meta-tools that search tools are not MCP calls.

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
    /// The text blocks of the update's content, joined by line breaks, when
    /// the agent's form has its result there.
    pub text: Option<String>,
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
        Some(AgentAdapterKind::Opencode) => opencode(facts),
        Some(AgentAdapterKind::QwenCode) => qwen_code(facts, known),
        Some(AgentAdapterKind::KimiCode) => kimi_code(facts, known),
        Some(AgentAdapterKind::Hermes) => hermes(facts),
        Some(AgentAdapterKind::GrokBuild) => grok_build(facts, known),
        Some(AgentAdapterKind::Cursor) => cursor(facts),
        Some(AgentAdapterKind::Pi) | None => Vec::new(),
    }
}

/// The text of the text blocks of a tool call's content, joined by line
/// breaks, for an agent whose form of an MCP call has its result there;
/// `None` for another agent or without any text.
pub(crate) fn result_text(agent: Option<AgentAdapterKind>, content: &[Value]) -> Option<String> {
    match agent {
        Some(AgentAdapterKind::Opencode | AgentAdapterKind::KimiCode) => text_of(content),
        _ => None,
    }
}

fn text_of(content: &[Value]) -> Option<String> {
    let texts: Vec<&str> = content
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("content"))
        .filter_map(|item| item.get("content"))
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|block| block.get("text")?.as_str())
        .collect();
    (!texts.is_empty()).then(|| texts.join("\n"))
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
        .and_then(prefixed)
    else {
        return Vec::new();
    };
    vec![McpCall {
        tool,
        arguments: facts.raw_input.clone(),
        result: facts.raw_output.as_ref().and_then(json_text),
    }]
}

/// opencode: the Code Mode `execute` tool, kind `other`, whose code may call
/// several MCP tools; they come in order in `rawOutput.metadata.toolCalls`
/// as `{tool: "<server>.<tool>", status, input}`. The content's text is the
/// value the code returned: the result of the call only when it made one.
fn opencode(facts: &CallFacts) -> Vec<McpCall> {
    let Some(calls) = facts
        .raw_output
        .as_ref()
        .and_then(|output| output.pointer("/metadata/toolCalls"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let mut recognized: Vec<McpCall> = calls
        .iter()
        .filter_map(|call| {
            let (server, tool) = call.get("tool")?.as_str()?.split_once('.')?;
            let failed = call
                .get("status")
                .and_then(Value::as_str)
                .is_some_and(|status| status != "completed");
            Some(McpCall {
                tool: tool_of(server, tool)?,
                arguments: call.get("input").cloned(),
                result: failed.then_some(McpResult::Error),
            })
        })
        .collect();
    if let [call] = recognized.as_mut_slice()
        && call.result.is_none()
    {
        call.result = facts.text.as_deref().and_then(json_value);
    }
    recognized
}

/// Qwen Code. Live: `_meta.toolName` `mcp__<server>__<tool>` with
/// `_meta.provenance` `mcp` and `_meta.serverId`, `rawInput` the arguments.
/// Replay: the meta-tool `_meta.toolName` `tool_call` with `rawInput.name`
/// and `rawInput.arguments`. The result is JSON text in `rawOutput`, which
/// may be followed by a line of prose.
fn qwen_code(facts: &CallFacts, known: &[McpTool]) -> Vec<McpCall> {
    let meta = facts.meta.as_ref();
    let input = facts.raw_input.as_ref();
    let result = facts
        .raw_output
        .as_ref()
        .and_then(Value::as_str)
        .and_then(leading_json);
    let call = match meta
        .and_then(|meta| meta.get("toolName"))
        .and_then(Value::as_str)
    {
        Some("tool_call") => input
            .and_then(|input| input.get("name"))
            .and_then(Value::as_str)
            .and_then(prefixed)
            .map(|tool| {
                (
                    tool,
                    input.and_then(|input| input.get("arguments")).cloned(),
                )
            }),
        Some(name)
            if meta
                .and_then(|meta| meta.get("provenance"))
                .is_none_or(|provenance| provenance == "mcp") =>
        {
            let server = meta
                .and_then(|meta| meta.get("serverId"))
                .and_then(Value::as_str);
            server
                .and_then(|server| {
                    let tool = name.strip_prefix("mcp__")?.strip_prefix(server)?;
                    tool_of(server, tool.strip_prefix("__")?)
                })
                .or_else(|| prefixed(name))
                .map(|tool| (tool, facts.raw_input.clone()))
        }
        _ => None,
    };
    match call {
        Some((tool, arguments)) => vec![McpCall {
            tool,
            arguments,
            result,
        }],
        None => result_of_known(known, result),
    }
}

/// Kimi Code: kind `other`, title `mcp__<server>__<tool>`, `rawInput` the
/// arguments. The result is the content's text with the structured content
/// in a `<mcp-result-extras>` block; replay has no `rawOutput`.
fn kimi_code(facts: &CallFacts, known: &[McpTool]) -> Vec<McpCall> {
    let result = facts.text.as_deref().and_then(result_extras);
    match facts.title.as_deref().and_then(prefixed) {
        Some(tool) => vec![McpCall {
            tool,
            arguments: facts.raw_input.clone(),
            result,
        }],
        None => result_of_known(known, result),
    }
}

/// Hermes. Live: kind `other`, title `mcp__<server>__<tool>`, `rawInput`
/// the arguments. Replay: the meta-tool, title `tool_call: …` with
/// `rawInput.calls[]` `{name, arguments}`. Its results are markdown text,
/// so no call has a result.
fn hermes(facts: &CallFacts) -> Vec<McpCall> {
    let title = facts.title.as_deref();
    if let Some(tool) = title.and_then(prefixed) {
        return vec![McpCall {
            tool,
            arguments: facts.raw_input.clone(),
            result: None,
        }];
    }
    let Some(calls) = facts
        .raw_input
        .as_ref()
        .filter(|_| title.is_some_and(|title| title.starts_with("tool_call:")))
        .and_then(|input| input.get("calls"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    calls
        .iter()
        .filter_map(|call| {
            Some(McpCall {
                tool: prefixed(call.get("name")?.as_str()?)?,
                arguments: call.get("arguments").cloned(),
                result: None,
            })
        })
        .collect()
}

/// Grok Build: the meta-tool `_meta["x.ai/tool"].name` `use_tool` with
/// `rawInput.tool_name` `<server>__<tool>` and `rawInput.tool_input` the
/// arguments. The result is `rawOutput` `{type: "MCP", server_name,
/// tool_name, output}`, whose `OkayOutput` is a line of text, then JSON.
fn grok_build(facts: &CallFacts, known: &[McpTool]) -> Vec<McpCall> {
    let result = facts.raw_output.as_ref().and_then(grok_result);
    let input = facts.raw_input.as_ref();
    let tool = facts
        .meta
        .as_ref()
        .and_then(|meta| meta.pointer("/x.ai~1tool/name"))
        .filter(|name| *name == "use_tool")
        .and_then(|_| input?.get("tool_name")?.as_str()?.split_once("__"))
        .and_then(|(server, tool)| tool_of(server, tool));
    match tool {
        Some(tool) => vec![McpCall {
            tool,
            arguments: input.and_then(|input| input.get("tool_input")).cloned(),
            result,
        }],
        None => result_of_known(known, result),
    }
}

/// Cursor: kind `other`, title `<server>: <tool>`, `rawInput`
/// `{providerIdentifier, toolName, args}`. Its result `{"success": true}`
/// carries nothing of the call's, so no call has a result.
fn cursor(facts: &CallFacts) -> Vec<McpCall> {
    let input = facts.raw_input.as_ref();
    let Some(tool) =
        input.and_then(|input| named(input.get("providerIdentifier"), input.get("toolName")))
    else {
        return Vec::new();
    };
    vec![McpCall {
        tool,
        arguments: input.and_then(|input| input.get("args")).cloned(),
        result: None,
    }]
}

/// The one call earlier updates were recognized as, with the result an
/// update without the agent's form of the call carries.
fn result_of_known(known: &[McpTool], result: Option<McpResult>) -> Vec<McpCall> {
    match (known, result) {
        ([tool], Some(result)) => vec![McpCall {
            tool: tool.clone(),
            arguments: None,
            result: Some(result),
        }],
        _ => Vec::new(),
    }
}

/// `mcp__<server>__<tool>`, the name several agents give an MCP tool.
fn prefixed(name: &str) -> Option<McpTool> {
    let (server, tool) = name.strip_prefix("mcp__")?.split_once("__")?;
    tool_of(server, tool)
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
    json_value(text)
}

/// A result that is JSON text; a JSON `error` object is a failed call.
fn json_value(text: &str) -> Option<McpResult> {
    value_result(serde_json::from_str(text).ok()?)
}

/// A JSON object or array at the start of `text`, before any other text.
fn leading_json(text: &str) -> Option<McpResult> {
    let value = serde_json::Deserializer::from_str(text)
        .into_iter::<Value>()
        .next()?
        .ok()?;
    match value {
        Value::Object(_) | Value::Array(_) => value_result(value),
        _ => None,
    }
}

fn value_result(value: Value) -> Option<McpResult> {
    Some(match value.get("error") {
        Some(error) if error.is_object() => McpResult::Error,
        _ => McpResult::Value(value),
    })
}

/// The structured content of the `<mcp-result-extras>` block of Kimi Code's
/// result text.
fn result_extras(text: &str) -> Option<McpResult> {
    let (_, extras) = text.split_once("<mcp-result-extras>")?;
    let (extras, _) = extras.split_once("</mcp-result-extras>")?;
    let extras: Value = serde_json::from_str(extras.trim()).ok()?;
    if extras.get("isError").and_then(Value::as_bool) == Some(true) {
        return Some(McpResult::Error);
    }
    value_result(extras.get("structuredContent")?.clone())
}

/// Grok Build's MCP result: the JSON after the first line of its
/// `OkayOutput`, or the whole text when it is JSON; any other output is a
/// failed call.
fn grok_result(output: &Value) -> Option<McpResult> {
    if output.get("type").and_then(Value::as_str) != Some("MCP") {
        return None;
    }
    let output = output.get("output")?;
    let Some(text) = output.get("OkayOutput") else {
        return Some(McpResult::Error);
    };
    let text = text.as_str()?;
    json_value(text).or_else(|| json_value(text.split_once('\n')?.1))
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
            text: update["content"]
                .as_array()
                .and_then(|content| text_of(content)),
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

    fn call(tool: McpTool, arguments: Option<Value>, result: Option<McpResult>) -> McpCall {
        McpCall {
            tool,
            arguments,
            result,
        }
    }

    fn page(path: &str) -> Option<McpResult> {
        Some(McpResult::Value(json!({ "path": path })))
    }

    #[test]
    fn opencode_execute_holds_its_calls_in_order_and_the_result_of_a_single_one() {
        const OPENCODE: Option<AgentAdapterKind> = Some(AgentAdapterKind::Opencode);
        let running = facts(json!({
            "kind": "other", "title": "execute",
            "rawInput": { "code": "return await tools[\"svode\"][\"create_page\"]({})" }
        }));
        assert!(recognize(OPENCODE, &running, &[]).is_empty());
        let two = facts(json!({
            "content": [{ "type": "content", "content": { "type": "text", "text": "{\"path\":\"b.md\"}" } }],
            "rawOutput": { "metadata": { "toolCalls": [
                { "tool": "svode.write_page", "status": "completed", "input": { "path": "a.md" } },
                { "tool": "svode.create_page", "status": "completed", "input": { "parentPath": "" } }
            ] } }
        }));
        assert_eq!(
            recognize(OPENCODE, &two, &[]),
            vec![
                call(svode("write_page"), Some(json!({ "path": "a.md" })), None),
                call(
                    svode("create_page"),
                    Some(json!({ "parentPath": "" })),
                    None
                ),
            ]
        );
        let one = facts(json!({
            "content": [{ "type": "content", "content": { "type": "text", "text": "{\"path\":\"b.md\"}" } }],
            "rawOutput": { "metadata": { "toolCalls": [
                { "tool": "svode.create_page", "status": "completed", "input": {} }
            ] } }
        }));
        assert_eq!(
            recognize(OPENCODE, &one, &[]),
            vec![call(svode("create_page"), Some(json!({})), page("b.md"))]
        );
        let failed = facts(json!({ "rawOutput": { "metadata": { "toolCalls": [
            { "tool": "svode.write_page", "status": "error", "input": { "path": "a.md" } }
        ] } } }));
        assert_eq!(
            recognize(OPENCODE, &failed, &[])[0].result,
            Some(McpResult::Error)
        );
        let unknown = facts(json!({
            "rawOutput": { "metadata": { "toolCalls": [], "error": true } }
        }));
        assert!(recognize(OPENCODE, &unknown, &[]).is_empty());
    }

    #[test]
    fn qwen_code_calls_live_and_in_the_replay_meta_form_take_the_leading_json() {
        const QWEN: Option<AgentAdapterKind> = Some(AgentAdapterKind::QwenCode);
        let output = "{\"path\":\"notes/A.md\"}\nCreated Page notes/A.md.";
        let live = facts(json!({
            "kind": "other",
            "rawInput": { "parentPath": "notes" },
            "rawOutput": output,
            "_meta": { "toolName": "mcp__svode__create_page", "provenance": "mcp", "serverId": "svode" }
        }));
        assert_eq!(
            recognize(QWEN, &live, &[]),
            vec![call(
                svode("create_page"),
                Some(json!({ "parentPath": "notes" })),
                page("notes/A.md")
            )]
        );
        let preparing = facts(json!({ "rawInput": {}, "_meta": { "toolName": "tool_call" } }));
        assert!(recognize(QWEN, &preparing, &[]).is_empty());
        let replay = facts(json!({
            "title": "ToolCall: mcp__svode__create_page",
            "rawInput": { "name": "mcp__svode__create_page", "arguments": { "parentPath": "notes" } },
            "_meta": { "toolName": "tool_call", "provenance": "builtin" }
        }));
        assert_eq!(
            recognize(QWEN, &replay, &[]),
            vec![call(
                svode("create_page"),
                Some(json!({ "parentPath": "notes" })),
                None
            )]
        );
        let result = facts(json!({
            "rawOutput": output, "_meta": { "toolName": "tool_call", "provenance": "builtin" }
        }));
        assert_eq!(
            recognize(QWEN, &result, &[svode("create_page")]),
            vec![call(svode("create_page"), None, page("notes/A.md"))]
        );
        let builtin = facts(json!({
            "rawInput": { "query": "create_page" },
            "_meta": { "toolName": "tool_search", "provenance": "builtin" }
        }));
        assert!(recognize(QWEN, &builtin, &[]).is_empty());
        let not_mcp =
            facts(json!({ "_meta": { "toolName": "mcp__svode__x", "provenance": "builtin" } }));
        assert!(recognize(QWEN, &not_mcp, &[]).is_empty());
    }

    #[test]
    fn a_kimi_code_call_takes_its_structured_content_from_the_result_extras() {
        const KIMI: Option<AgentAdapterKind> = Some(AgentAdapterKind::KimiCode);
        let call_facts = facts(json!({
            "kind": "other", "title": "mcp__svode__create_page", "rawInput": { "parentPath": "notes" }
        }));
        assert_eq!(
            recognize(KIMI, &call_facts, &[]),
            vec![call(
                svode("create_page"),
                Some(json!({ "parentPath": "notes" })),
                None
            )]
        );
        let text = |text: &str| {
            facts(
                json!({ "content": [{ "type": "content", "content": { "type": "text", "text": text } }] }),
            )
        };
        // The one result E06 captured live: the Svode MCP error of a name
        // conflict, in live and replay alike.
        let conflict = text(
            "Page name is already used in this container\n<mcp-result-extras>\n{\"structuredContent\":{\"error\":{\"code\":\"PAGE_NAME_CONFLICT\"}}}\n</mcp-result-extras>",
        );
        assert_eq!(
            recognize(KIMI, &conflict, &[svode("create_page")]),
            vec![call(svode("create_page"), None, Some(McpResult::Error))]
        );
        let created = text(
            "Created Page notes/A.md.\n<mcp-result-extras>\n{\"structuredContent\":{\"path\":\"notes/A.md\"}}\n</mcp-result-extras>",
        );
        assert_eq!(
            recognize(KIMI, &created, &[svode("create_page")])[0].result,
            page("notes/A.md")
        );
        assert!(
            recognize(
                KIMI,
                &text("{\"parentPath\":\"notes\"}"),
                &[svode("create_page")]
            )
            .is_empty()
        );
    }

    #[test]
    fn hermes_calls_live_and_in_the_replay_meta_form_have_no_result() {
        const HERMES: Option<AgentAdapterKind> = Some(AgentAdapterKind::Hermes);
        let live = facts(json!({
            "kind": "other", "title": "mcp__svode__write_page", "rawInput": { "path": "a.md" }
        }));
        assert_eq!(
            recognize(HERMES, &live, &[]),
            vec![call(
                svode("write_page"),
                Some(json!({ "path": "a.md" })),
                None
            )]
        );
        let replay = facts(json!({
            "kind": "other",
            "title": "tool_call: Svode · write page",
            "rawInput": { "calls": [
                { "name": "mcp__svode__write_page", "arguments": { "path": "a.md" } },
                { "name": "terminal", "arguments": {} },
                { "name": "mcp__svode__write_page", "arguments": { "path": "b.md" } }
            ] }
        }));
        assert_eq!(
            recognize(HERMES, &replay, &[]),
            vec![
                call(svode("write_page"), Some(json!({ "path": "a.md" })), None),
                call(svode("write_page"), Some(json!({ "path": "b.md" })), None),
            ]
        );
        let markdown = facts(json!({
            "status": "completed",
            "content": [{ "type": "content", "content": { "type": "text", "text": "mcp__svode__write_page result\n- **path:** a.md" } }]
        }));
        assert!(recognize(HERMES, &markdown, &[svode("write_page")]).is_empty());
        let describe = facts(json!({
            "kind": "other",
            "title": "tool_describe: Reading tool details · 1 tool",
            "rawInput": { "names": ["mcp__svode__create_page"] }
        }));
        assert!(recognize(HERMES, &describe, &[]).is_empty());
    }

    #[test]
    fn a_grok_build_use_tool_call_takes_the_json_after_the_first_line_of_its_output() {
        const GROK: Option<AgentAdapterKind> = Some(AgentAdapterKind::GrokBuild);
        let meta = |name: &str| json!({ "x.ai/tool": { "name": name, "kind": name } });
        let use_tool = facts(json!({
            "title": "svode__create_page",
            "rawInput": { "variant": "UseTool", "tool_name": "svode__create_page", "tool_input": { "parentPath": "notes" } },
            "_meta": meta("use_tool")
        }));
        assert_eq!(
            recognize(GROK, &use_tool, &[]),
            vec![call(
                svode("create_page"),
                Some(json!({ "parentPath": "notes" })),
                None
            )]
        );
        let output = |output: Value| {
            facts(
                json!({ "rawOutput": { "type": "MCP", "tool_name": "create_page", "server_name": "svode", "output": output } }),
            )
        };
        assert_eq!(
            recognize(
                GROK,
                &output(
                    json!({ "OkayOutput": "Created Page notes/A.md.\n{\"path\":\"notes/A.md\"}" })
                ),
                &[svode("create_page")]
            ),
            vec![call(svode("create_page"), None, page("notes/A.md"))]
        );
        assert_eq!(
            recognize(
                GROK,
                &output(json!({ "ErrorOutput": "denied" })),
                &[svode("create_page")]
            )[0]
            .result,
            Some(McpResult::Error)
        );
        assert!(
            recognize(
                GROK,
                &output(json!({ "OkayOutput": "done" })),
                &[svode("create_page")]
            )
            .is_empty()
        );
        let search = facts(json!({
            "title": "search_tool",
            "rawInput": { "query": "svode create_page", "tool_name": "svode__create_page" },
            "_meta": meta("search_tool")
        }));
        assert!(recognize(GROK, &search, &[]).is_empty());
    }

    #[test]
    fn a_cursor_call_names_its_provider_and_tool_and_has_no_result() {
        const CURSOR: Option<AgentAdapterKind> = Some(AgentAdapterKind::Cursor);
        let named = facts(json!({
            "title": "svode: create_page",
            "rawInput": { "providerIdentifier": "svode", "toolName": "create_page", "args": { "parentPath": "notes" } }
        }));
        assert_eq!(
            recognize(CURSOR, &named, &[]),
            vec![call(
                svode("create_page"),
                Some(json!({ "parentPath": "notes" })),
                None
            )]
        );
        let success = facts(json!({ "status": "completed", "rawOutput": { "success": true } }));
        assert!(recognize(CURSOR, &success, &[svode("create_page")]).is_empty());
        let title_only =
            facts(json!({ "kind": "other", "title": "svode: create_page", "rawInput": {} }));
        assert!(recognize(CURSOR, &title_only, &[]).is_empty());
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
        assert!(recognize(Some(AgentAdapterKind::Pi), &unknown_form, &[]).is_empty());
        assert!(recognize(None, &unknown_form, &[]).is_empty());
    }
}

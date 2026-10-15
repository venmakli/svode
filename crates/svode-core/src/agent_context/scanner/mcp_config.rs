//! MCP servers as the agents' configs declare them (Stage 10 `05`,
//! «MCP-сервер»): JSON with or without comments, the global config of
//! Claude Code, TOML, the opencode config and YAML. Only an allowlist of
//! fields is kept — the name, the command with its arguments, the URL and
//! the declared switch. `env`, headers, references to variables, helpers,
//! OAuth and every other key of the file, its neighbouring secrets too, are
//! dropped while parsing; failures never quote the file.

use std::path::{Path, PathBuf};

use crate::agent_adapters::{AgentAdapterKind, McpConfigFormat};

use super::super::model::{AgentContextDiagnostic, ContextMcpFacts};
use super::io::{diagnostic, read_config_text_within};

/// The largest MCP config the scanner reads. The global config of Claude
/// Code also keeps the history of its projects, so it is larger than the
/// other configs.
const CLAUDE_GLOBAL_BYTES: u64 = 4 * 1024 * 1024;
const CONFIG_BYTES: u64 = 256 * 1024;
/// What replaces a hidden argument.
const HIDDEN: &str = "••••";
/// A flag or key with one of these in its name hides its value.
const SECRET_WORDS: [&str; 5] = ["token", "key", "secret", "password", "auth"];
/// Fields that hold the URL of a remote server, in the order they count:
/// `httpUrl` and `tcp` of Qwen Code, `urlTemplate` of Grok Build.
const URL_FIELDS: [&str; 4] = ["url", "httpUrl", "urlTemplate", "tcp"];

/// One server of a config.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct McpDeclaration {
    pub name: String,
    pub facts: ContextMcpFacts,
    /// `enabled` or the negation of `disabled`, when declared.
    pub switch: Option<bool>,
    /// Why the declaration starts no server.
    pub problem: Option<String>,
    /// It declares neither a command nor a URL: a client that merges
    /// declarations by fields may take them from another file.
    pub incomplete: bool,
}

impl McpDeclaration {
    /// `enabled: false` or `disabled: true`.
    pub fn declared_off(&self) -> bool {
        self.switch == Some(false)
    }
}

/// A `projects` entry of the global config of Claude Code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ClaudeProject {
    pub key: PathBuf,
    pub servers: Vec<McpDeclaration>,
    /// `disabledMcpServers`.
    pub disabled: Vec<String>,
}

/// The servers of one config file.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct McpConfig {
    pub servers: Vec<McpDeclaration>,
    /// Only the entries of the project keys asked for.
    pub projects: Vec<ClaudeProject>,
}

impl McpConfig {
    pub fn project(&self, key: &Path) -> Option<&ClaudeProject> {
        self.projects.iter().find(|project| project.key == key)
    }
}

/// How a file is parsed; the formats of one file share one parse.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum McpSyntax {
    Json { comments: bool },
    ClaudeGlobal,
    Toml,
    Opencode,
    Yaml,
}

impl McpSyntax {
    pub fn of(format: McpConfigFormat) -> Self {
        match format {
            McpConfigFormat::JsonServers { comments } => Self::Json { comments },
            McpConfigFormat::ClaudeUser | McpConfigFormat::ClaudeLocal(_) => Self::ClaudeGlobal,
            McpConfigFormat::TomlServers => Self::Toml,
            McpConfigFormat::Opencode => Self::Opencode,
            McpConfigFormat::YamlServers => Self::Yaml,
        }
    }
}

/// The servers of `path`, `None` when it is missing or unreadable. For the
/// global config of Claude Code, only the `projects` entries of
/// `project_keys` are read.
pub(super) fn read(
    path: &Path,
    syntax: McpSyntax,
    project_keys: &[PathBuf],
    adapter_id: AgentAdapterKind,
    diagnostics: &mut Vec<AgentContextDiagnostic>,
) -> Option<McpConfig> {
    let limit = if syntax == McpSyntax::ClaudeGlobal {
        CLAUDE_GLOBAL_BYTES
    } else {
        CONFIG_BYTES
    };
    let text = read_config_text_within(
        path,
        limit,
        Some(adapter_id),
        "mcp_config",
        "MCP config",
        diagnostics,
    )?;
    let Some(root) = parse(&text, syntax) else {
        diagnostics.push(diagnostic(
            path,
            Some(adapter_id),
            "mcp_config_parse",
            format!("Could not parse the MCP servers of {}", path.display()),
        ));
        return None;
    };
    let mut config = McpConfig::default();
    let servers = match syntax {
        McpSyntax::Json { .. } | McpSyntax::ClaudeGlobal => root.get("mcpServers"),
        McpSyntax::Toml | McpSyntax::Yaml => root.get("mcp_servers"),
        McpSyntax::Opencode => root.get("mcp").map(|mcp| mcp.get("servers").unwrap_or(mcp)),
    };
    config.servers = declarations(servers, syntax == McpSyntax::Opencode);
    if syntax == McpSyntax::ClaudeGlobal
        && let Some(projects) = root.get("projects").and_then(|value| value.as_object())
    {
        for (key, project) in projects {
            let canonical = Path::new(key)
                .canonicalize()
                .unwrap_or_else(|_| PathBuf::from(key));
            if !project_keys.contains(&canonical)
                || config.projects.iter().any(|known| known.key == canonical)
            {
                continue;
            }
            config.projects.push(ClaudeProject {
                key: canonical,
                servers: declarations(project.get("mcpServers"), false),
                disabled: strings(project.get("disabledMcpServers")),
            });
        }
    }
    for server in config
        .servers
        .iter()
        .chain(config.projects.iter().flat_map(|project| &project.servers))
    {
        if let Some(problem) = server.problem.as_ref().filter(|_| !server.incomplete) {
            diagnostics.push(diagnostic(
                path,
                Some(adapter_id),
                "mcp_server_invalid",
                format!("{problem} in {}", path.display()),
            ));
        }
    }
    Some(config)
}

/// The servers of an MCP file of a plugin: `{ "mcpServers": { … } }` or a
/// map of servers by name.
pub(super) fn plugin_file_servers(text: &str) -> Option<Vec<McpDeclaration>> {
    let root = serde_json::from_str::<serde_json::Value>(text).ok()?;
    let servers = root.as_object()?;
    Some(match servers.get("mcpServers") {
        Some(servers) => declarations(Some(servers), false),
        None => declarations(Some(&root), true),
    })
}

/// The servers of an inline `mcpServers` object of a plugin manifest.
pub(super) fn inline_servers(servers: &serde_json::Value) -> Vec<McpDeclaration> {
    declarations(Some(servers), false)
}

fn parse(text: &str, syntax: McpSyntax) -> Option<serde_json::Value> {
    let root = match syntax {
        McpSyntax::Json { comments: false } | McpSyntax::ClaudeGlobal => {
            serde_json::from_str::<serde_json::Value>(text).ok()?
        }
        McpSyntax::Json { comments: true } | McpSyntax::Opencode => {
            jsonc_parser::parse_to_serde_value::<Option<serde_json::Value>>(
                text,
                &jsonc_parser::ParseOptions::default(),
            )
            .ok()?
            .unwrap_or_else(|| serde_json::Value::Object(Default::default()))
        }
        McpSyntax::Toml => serde_json::to_value(toml::from_str::<toml::Table>(text).ok()?).ok()?,
        McpSyntax::Yaml => {
            // Only the servers become JSON: other keys of the YAML may not
            // be strings.
            let document = serde_norway::from_str::<serde_norway::Value>(text).ok()?;
            let mut root = serde_json::Map::new();
            if let Some(servers) = document.get("mcp_servers") {
                root.insert(
                    "mcp_servers".to_string(),
                    serde_json::to_value(servers).ok()?,
                );
            }
            serde_json::Value::Object(root)
        }
    };
    root.is_object().then_some(root)
}

/// The servers of a map by name. `skip_other_values` skips values that are
/// no objects, as the keys of a flat plugin file or opencode's `timeout`.
fn declarations(
    servers: Option<&serde_json::Value>,
    skip_other_values: bool,
) -> Vec<McpDeclaration> {
    let Some(servers) = servers.and_then(|servers| servers.as_object()) else {
        return Vec::new();
    };
    servers
        .iter()
        .filter(|(name, value)| {
            !skip_other_values || (value.is_object() && name.as_str() != "timeout")
        })
        .map(|(name, value)| declaration(name, value))
        .collect()
}

fn declaration(name: &str, value: &serde_json::Value) -> McpDeclaration {
    let mut declared = McpDeclaration {
        name: name.to_string(),
        facts: ContextMcpFacts::default(),
        switch: None,
        problem: None,
        incomplete: false,
    };
    let Some(entry) = value.as_object() else {
        declared.problem = Some(format!("MCP server {name} is not an object"));
        return declared;
    };
    declared.switch = entry
        .get("enabled")
        .and_then(|value| value.as_bool())
        .or_else(|| {
            entry
                .get("disabled")
                .and_then(|value| value.as_bool())
                .map(|disabled| !disabled)
        });
    // opencode declares the command and its arguments as one list.
    let mut command = match entry.get("command") {
        Some(serde_json::Value::String(command)) if !command.trim().is_empty() => {
            vec![command.clone()]
        }
        Some(serde_json::Value::Array(_)) => strings(entry.get("command")),
        _ => Vec::new(),
    };
    if !command.is_empty() {
        command.extend(strings(entry.get("args")));
        declared.facts.command = hide_secrets(command);
    } else if let Some(url) = URL_FIELDS
        .iter()
        .find_map(|field| entry.get(*field).and_then(|value| value.as_str()))
        .filter(|url| !url.trim().is_empty())
    {
        declared.facts.url = Some(bare_url(url.trim()));
    } else {
        declared.incomplete = true;
        declared.problem = Some(format!(
            "MCP server {name} declares neither a command nor a URL"
        ));
    }
    declared
}

fn strings(value: Option<&serde_json::Value>) -> Vec<String> {
    match value {
        Some(serde_json::Value::Array(values)) => values
            .iter()
            .filter_map(|value| value.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    }
}

fn names_secret(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    SECRET_WORDS.iter().any(|word| name.contains(word))
}

/// Hides the argument of a secret flag (`--token value`), the value of a
/// secret key (`--api-key=value`, `API_KEY=value`, `Authorization: value`)
/// and the userinfo, query and fragment of a URL argument.
fn hide_secrets(parts: Vec<String>) -> Vec<String> {
    let mut hidden = Vec::with_capacity(parts.len());
    let mut hide_next = false;
    for part in parts {
        if std::mem::take(&mut hide_next) && !part.starts_with('-') {
            hidden.push(HIDDEN.to_string());
            continue;
        }
        if part.contains("://") {
            hidden.push(bare_url(&part));
            continue;
        }
        if let Some(at) = part.find(['=', ':']) {
            let key = &part[..at];
            if !key.is_empty() && !key.contains(['/', '\\']) && names_secret(key) {
                hidden.push(format!("{}{HIDDEN}", &part[..=at]));
                continue;
            }
        }
        if part.starts_with('-') && names_secret(part.trim_start_matches('-')) {
            hide_next = true;
        }
        hidden.push(part);
    }
    hidden
}

/// A URL without userinfo, query and fragment.
fn bare_url(url: &str) -> String {
    let url = url.split(['?', '#']).next().unwrap_or_default();
    let (scheme, rest) = match url.split_once("://") {
        Some((scheme, rest)) => (Some(scheme), rest),
        None => (None, url),
    };
    let end = rest.find('/').unwrap_or(rest.len());
    let (authority, path) = rest.split_at(end);
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    match scheme {
        Some(scheme) => format!("{scheme}://{host}{path}"),
        None => format!("{host}{path}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owned(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|part| part.to_string()).collect()
    }

    #[test]
    fn secret_arguments_are_hidden_and_others_kept() {
        assert_eq!(
            hide_secrets(owned(&[
                "npx",
                "-y",
                "@modelcontextprotocol/server-github",
                "--api-key",
                "sk-live",
                "--token=abc",
                "GITHUB_TOKEN=ghp",
                "Authorization: Bearer xyz",
                "--verbose",
                "https://user:pass@example.com/sse?key=1#top",
            ])),
            owned(&[
                "npx",
                "-y",
                "@modelcontextprotocol/server-github",
                "--api-key",
                HIDDEN,
                &format!("--token={HIDDEN}"),
                &format!("GITHUB_TOKEN={HIDDEN}"),
                &format!("Authorization:{HIDDEN}"),
                "--verbose",
                "https://example.com/sse",
            ])
        );
        // A flag that follows a secret flag is no value of it.
        assert_eq!(
            hide_secrets(owned(&["server", "--auth", "--port", "8080"])),
            owned(&["server", "--auth", "--port", "8080"])
        );
    }

    #[test]
    fn urls_lose_userinfo_query_and_fragment() {
        assert_eq!(
            bare_url("https://u:t@mcp.example.com:8443/v1/sse?token=x#a"),
            "https://mcp.example.com:8443/v1/sse"
        );
        assert_eq!(bare_url("user@localhost:9000"), "localhost:9000");
    }

    #[test]
    fn only_allowlisted_fields_are_kept() {
        let servers = plugin_file_servers(
            r#"{"mcpServers":{
                "db":{"command":"db-mcp","args":["--password","hunter2"],"env":{"DB_TOKEN":"env-secret"},"cwd":"/secret/dir"},
                "remote":{"type":"http","url":"https://mcp.example.com/mcp?key=q","headers":{"Authorization":"Bearer header-secret"},"enabled":false},
                "broken":{"type":"sdk"}
            }}"#,
        )
        .unwrap();
        let debug = format!("{servers:?}");
        for secret in [
            "hunter2",
            "env-secret",
            "DB_TOKEN",
            "header-secret",
            "/secret/dir",
            "key=q",
        ] {
            assert!(!debug.contains(secret), "{secret} in {debug}");
        }
        let db = servers.iter().find(|server| server.name == "db").unwrap();
        assert_eq!(db.facts.command, owned(&["db-mcp", "--password", HIDDEN]));
        let remote = servers
            .iter()
            .find(|server| server.name == "remote")
            .unwrap();
        assert_eq!(
            remote.facts.url.as_deref(),
            Some("https://mcp.example.com/mcp")
        );
        assert!(remote.declared_off());
        let broken = servers
            .iter()
            .find(|server| server.name == "broken")
            .unwrap();
        assert!(broken.problem.is_some());
    }

    #[test]
    fn formats_name_their_servers_where_each_client_declares_them() {
        let toml = r#"api_key = "toml-secret"
[mcp_servers.docs]
command = "docs-mcp"
args = ["serve"]
enabled = false
[mcp_servers.docs.env]
KEY = "toml-env"
"#;
        let root = parse(toml, McpSyntax::Toml).unwrap();
        let servers = declarations(root.get("mcp_servers"), false);
        assert_eq!(servers[0].facts.command, owned(&["docs-mcp", "serve"]));
        assert!(servers[0].declared_off());

        let opencode = r#"{ // v2
  "provider": { "key": "opencode-secret" },
  "mcp": { "timeout": { "startup": 5 }, "servers": { "fs": { "type": "local", "command": ["bunx", "fs-mcp"], "disabled": true } } },
}"#;
        let root = parse(opencode, McpSyntax::Opencode).unwrap();
        let mcp = root.get("mcp").unwrap();
        let servers = declarations(Some(mcp.get("servers").unwrap()), true);
        assert_eq!(servers[0].facts.command, owned(&["bunx", "fs-mcp"]));
        assert!(servers[0].declared_off());
        // opencode 1 keeps servers right in `mcp`.
        let v1 = r#"{"mcp":{"timeout":{"startup":5},"web":{"type":"remote","url":"https://web.example.com/mcp","enabled":false}}}"#;
        let root = parse(v1, McpSyntax::Opencode).unwrap();
        let servers = declarations(root.get("mcp"), true);
        assert_eq!(servers.len(), 1);
        assert!(servers[0].declared_off());

        let yaml = "api_key: yaml-secret\nmcp_servers:\n  notes:\n    url: https://notes.example.com/mcp\n    headers:\n      X-Key: yaml-header\n";
        let root = parse(yaml, McpSyntax::Yaml).unwrap();
        let servers = declarations(root.get("mcp_servers"), false);
        assert_eq!(
            servers[0].facts.url.as_deref(),
            Some("https://notes.example.com/mcp")
        );
        assert!(!format!("{root:?}").contains("yaml-secret"));
    }

    #[test]
    fn a_parse_failure_does_not_quote_the_file() {
        let directory = tempfile::TempDir::new().unwrap();
        let path = directory.path().join(".mcp.json");
        std::fs::write(&path, r#"{"mcpServers":{"x":{"env":{"K":"quoted-secret"}}"#).unwrap();
        let mut diagnostics = Vec::new();

        let config = read(
            &path,
            McpSyntax::Json { comments: false },
            &[],
            AgentAdapterKind::ClaudeCode,
            &mut diagnostics,
        );

        assert!(config.is_none());
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].code, "mcp_config_parse");
        assert!(!format!("{diagnostics:?}").contains("quoted-secret"));
    }
}

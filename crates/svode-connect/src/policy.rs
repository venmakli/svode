//! What a client does with the connection beyond its artifacts: settings
//! and policies that switch the chosen mechanism off, and the Claude Code
//! cache that keeps a failed plugin MCP server from starting for a while.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::agent_mcp::{self, CommandMcp};
use crate::entry::read_text;
use crate::machine::{Client, Kit, Machine};

/// Claude Code keeps a plugin stdio server that failed to start out of new
/// sessions for this long unless the entry names its own TTL.
const CLAUDE_NEEDS_AUTH_TTL_MS: u64 = 900_000;
const CLAUDE_CLOCK_SKEW_MS: u64 = 60_000;

/// A setting that keeps the connection of `client` from working, with the
/// file that holds it.
pub(crate) fn blocking(machine: &Machine, client: Client) -> Vec<String> {
    match client.kit {
        Kit::ClaudePlugin => claude(machine),
        Kit::CodexMcp => codex(machine),
        Kit::CommandMcp(CommandMcp::QwenCode) => qwen(machine),
        Kit::CommandMcp(CommandMcp::Pi) => pi(machine),
        Kit::CommandMcp(CommandMcp::Opencode) | Kit::SharedSkillOnly => Vec::new(),
    }
}

/// `mcp.allowed` and `mcp.excluded` of the user and system settings of
/// Qwen Code decide which configured servers it starts.
fn qwen(machine: &Machine) -> Vec<String> {
    let mut found = Vec::new();
    let user = machine.home.join(".qwen").join("settings.json");
    for file in [&user, &machine.qwen_system_settings] {
        let Ok(settings) = agent_mcp::jsonc_value(file) else {
            continue;
        };
        let at = file.display();
        let names = |key: &str| {
            settings["mcp"][key]
                .as_array()
                .map(|names| names.iter().any(|name| name.as_str() == Some("svode")))
        };
        if names("allowed") == Some(false) {
            found.push(format!(
                "mcp.allowed in {at} does not allow the svode MCP server"
            ));
        }
        if names("excluded") == Some(true) {
            found.push(format!(
                "mcp.excluded in {at} excludes the svode MCP server"
            ));
        }
    }
    found
}

/// pi reads `mcp.json` through its built-in MCP support, which an extension
/// such as `pi-mcp-adapter` replaces and `-builtin:mcp` turns off.
fn pi(machine: &Machine) -> Vec<String> {
    let file = machine.home.join(".pi").join("agent").join("settings.json");
    let Ok(settings) = agent_mcp::jsonc_value(&file) else {
        return Vec::new();
    };
    let at = file.display();
    let mut found = Vec::new();
    let adapter = settings["packages"].as_array().is_some_and(|packages| {
        packages.iter().any(|package| {
            package
                .as_str()
                .or_else(|| package["source"].as_str())
                .is_some_and(|source| source.contains("pi-mcp-adapter"))
        })
    });
    if adapter {
        found.push(format!(
            "pi-mcp-adapter in {at} replaces the built-in MCP support of pi, so pi does not read the Svode MCP entry of mcp.json"
        ));
    }
    let off = settings["extensions"].as_array().is_some_and(|extensions| {
        extensions
            .iter()
            .any(|extension| extension.as_str() == Some("-builtin:mcp"))
    });
    if off {
        found.push(format!(
            "-builtin:mcp in {at} turns off the built-in MCP support of pi"
        ));
    }
    found
}

fn claude(machine: &Machine) -> Vec<String> {
    let mut found = Vec::new();
    for file in &machine.claude_policies {
        let Some(settings) = json(file) else {
            continue;
        };
        let at = file.display();
        let skills_dir = |list: &Value| {
            list.as_array().is_some_and(|sources| {
                sources
                    .iter()
                    .any(|source| source["source"].as_str() == Some("skills-dir"))
            })
        };
        if settings["strictKnownMarketplaces"].is_array()
            && !skills_dir(&settings["strictKnownMarketplaces"])
        {
            found.push(format!(
                "strictKnownMarketplaces in {at} does not allow skills-dir plugins"
            ));
        }
        if skills_dir(&settings["blockedMarketplaces"]) {
            found.push(format!(
                "blockedMarketplaces in {at} blocks skills-dir plugins"
            ));
        }
        let strict = &settings["strictPluginOnlyCustomization"];
        if strict.as_bool() == Some(true)
            || strict
                .as_array()
                .is_some_and(|kinds| kinds.iter().any(|kind| kind.as_str() == Some("skills")))
        {
            found.push(format!(
                "strictPluginOnlyCustomization in {at} turns off skills from ~/.claude/skills"
            ));
        }
    }
    let manifest = machine.claude_dir().join("skills").join("manifest.json");
    if let Ok(content) = std::fs::read_to_string(&manifest)
        && serde_json::from_str::<Value>(&content).is_err()
    {
        found.push(format!(
            "{} is not valid JSON, so Claude Code loads no plugin from ~/.claude/skills",
            manifest.display()
        ));
    }
    found
}

fn codex(machine: &Machine) -> Vec<String> {
    let mut found = Vec::new();
    let launcher = machine.launcher_mcp();
    let requirements = &machine.codex_requirements;
    if let Some(root) = toml_table(requirements)
        && let Some(servers) = root.get("mcp_servers").and_then(toml::Value::as_table)
    {
        let at = requirements.display();
        match servers.get("svode") {
            None => found.push(format!(
                "mcp_servers in {at} does not allow the svode MCP server"
            )),
            Some(allowed) => {
                let mut commands = Vec::new();
                collect_commands(allowed, &mut commands);
                if !commands.is_empty()
                    && !commands.iter().any(|command| {
                        launcher.is_some_and(|launcher| Path::new(command) == launcher)
                    })
                {
                    found.push(format!(
                        "mcp_servers.svode in {at} allows another command than the Svode launcher"
                    ));
                }
            }
        }
    }
    let config = machine.codex_config();
    if let Some(root) = toml_table(&config) {
        let disabled = root
            .get("skills")
            .and_then(|skills| skills.get("config"))
            .and_then(toml::Value::as_array)
            .into_iter()
            .flatten()
            .any(|entry| {
                entry.get("enabled").and_then(toml::Value::as_bool) == Some(false)
                    && ["name", "path"].iter().any(|key| {
                        entry
                            .get(key)
                            .and_then(toml::Value::as_str)
                            .is_some_and(|value| {
                                matches!(value, "svode" | "svode:svode")
                                    || value.contains("/skills/svode")
                            })
                    })
            });
        if disabled {
            found.push(format!(
                "skills.config in {} disables the Svode skill",
                config.display()
            ));
        }
    }
    found
}

fn collect_commands(value: &toml::Value, commands: &mut Vec<String>) {
    match value {
        toml::Value::Table(table) => {
            for (key, value) in table {
                match (key.as_str(), value) {
                    ("command", toml::Value::String(command)) => commands.push(command.clone()),
                    _ => collect_commands(value, commands),
                }
            }
        }
        toml::Value::Array(values) => {
            for value in values {
                collect_commands(value, commands);
            }
        }
        _ => {}
    }
}

/// Seconds until Claude Code starts the plugin MCP server of Svode in a new
/// session again, when a failed start put it into its needs-auth cache.
pub(crate) fn claude_mcp_blocked_for(machine: &Machine) -> Option<u64> {
    let cache = json(&machine.claude_dir().join("mcp-needs-auth-cache.json"))?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    cache
        .as_object()?
        .iter()
        .filter(|(name, _)| name.starts_with("plugin:svode:"))
        .filter_map(|(_, entry)| {
            let at = entry["timestamp"].as_f64()? as u64;
            let ttl = entry["ttlMs"].as_u64().unwrap_or(CLAUDE_NEEDS_AUTH_TTL_MS);
            let until = at.checked_add(ttl)?;
            (now + CLAUDE_CLOCK_SKEW_MS > at && now < until).then(|| (until - now).div_ceil(1000))
        })
        .max()
}

fn json(path: &Path) -> Option<Value> {
    let content = read_text(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn toml_table(path: &Path) -> Option<toml::Table> {
    let content = read_text(path).ok()?;
    toml::from_str(&content).ok()
}

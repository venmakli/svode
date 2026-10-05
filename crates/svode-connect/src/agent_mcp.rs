//! The `svode` MCP entry in the JSON config of an agent (Stage 10 `03` A9,
//! E03). Where the agent's own command is non-interactive and idempotent —
//! `opencode mcp add --global`, `qwen mcp add -s user` and `pi mcp add` — it
//! writes the entry, keeping comments and foreign keys in the config format
//! of its version. Kimi Code has no such command, so the manager writes its
//! entry into the JSON itself. The manager reads the entry from the config,
//! which may be JSONC, and removes it by editing that JSONC in place, since
//! opencode has no remove command.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use jsonc_parser::ParseOptions;
use jsonc_parser::cst::{CstInputValue, CstRootNode};
use serde_json::{Map, Value};

use svode_core::agent_adapters::AgentAdapterKind;

use crate::entry::{self, Entry, Launch, MARKER, MARKER_ENV};
use crate::error::ConnectError;
use crate::machine::Machine;

/// An agent whose MCP entry lives in its JSON config.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AgentMcp {
    Opencode,
    QwenCode,
    Pi,
    KimiCode,
}

/// An agent command that has not finished by then is stopped.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);

impl AgentMcp {
    fn agent(self) -> AgentAdapterKind {
        match self {
            Self::Opencode => AgentAdapterKind::Opencode,
            Self::QwenCode => AgentAdapterKind::QwenCode,
            Self::Pi => AgentAdapterKind::Pi,
            Self::KimiCode => AgentAdapterKind::KimiCode,
        }
    }

    /// Whether the agent's own command writes the entry; the manager writes
    /// it otherwise.
    pub fn by_command(self) -> bool {
        self != Self::KimiCode
    }

    /// Keys of the object that holds the MCP servers by name.
    fn servers(self) -> &'static [&'static str] {
        match self {
            Self::Opencode => &["mcp", "servers"],
            Self::QwenCode | Self::Pi | Self::KimiCode => &["mcpServers"],
        }
    }

    /// The user config the command writes to. opencode writes
    /// `opencode.json`, or `opencode.jsonc` when only that one exists.
    pub fn config(self, machine: &Machine) -> PathBuf {
        match self {
            Self::Opencode => {
                let dir = machine.home.join(".config").join("opencode");
                let json = dir.join("opencode.json");
                let jsonc = dir.join("opencode.jsonc");
                if !json.exists() && jsonc.exists() {
                    jsonc
                } else {
                    json
                }
            }
            Self::QwenCode => machine.home.join(".qwen").join("settings.json"),
            Self::Pi => machine.home.join(".pi").join("agent").join("mcp.json"),
            Self::KimiCode => machine.home.join(".kimi-code").join("mcp.json"),
        }
    }

    /// User configs the agent also reads besides [`Self::config`]: an entry
    /// there is not Svode's.
    fn other_configs(self, machine: &Machine) -> Vec<PathBuf> {
        match self {
            Self::Opencode => {
                let dir = machine.home.join(".config").join("opencode");
                let jsonc = dir.join("opencode.jsonc");
                if self.config(machine) == jsonc {
                    Vec::new()
                } else {
                    vec![jsonc]
                }
            }
            Self::QwenCode | Self::Pi | Self::KimiCode => Vec::new(),
        }
    }

    /// Project configs whose `svode` entry overrides the user one.
    fn project_configs(self, project: &Path) -> Vec<PathBuf> {
        match self {
            Self::Opencode => vec![
                project.join("opencode.json"),
                project.join("opencode.jsonc"),
                project.join(".opencode").join("opencode.json"),
                project.join(".opencode").join("opencode.jsonc"),
            ],
            Self::QwenCode => vec![project.join(".qwen").join("settings.json")],
            Self::Pi => vec![project.join(".pi").join("mcp.json")],
            // The Claude-compatible file of the project root and the Kimi
            // file of the directory Kimi Code starts in.
            Self::KimiCode => vec![
                project.join(".mcp.json"),
                project.join(".kimi-code").join("mcp.json"),
            ],
        }
    }

    /// The command that writes the managed entry: the stable launcher with
    /// the marker, at user scope, without approval settings. `None` for an
    /// agent without such a command.
    fn add_args(self, launcher: &Path) -> Option<Vec<String>> {
        let marker = format!("{MARKER_ENV}={MARKER}");
        let launcher = launcher.display().to_string();
        let args: &[&str] = match self {
            Self::Opencode => &[
                "mcp", "add", "--global", "--env", &marker, "svode", "--", &launcher,
            ],
            Self::QwenCode => &[
                "mcp", "add", "-s", "user", "-e", &marker, "svode", &launcher,
            ],
            Self::Pi => &["mcp", "add", "svode", "--env", &marker, "--", &launcher],
            Self::KimiCode => return None,
        };
        Some(args.iter().map(|arg| arg.to_string()).collect())
    }

    /// The same command without the marker, for configuring the agent by
    /// hand; `None` for an agent without such a command.
    pub fn manual(self, launcher: &str) -> Option<String> {
        Some(match self {
            Self::Opencode => format!("opencode mcp add --global svode -- {launcher}"),
            Self::QwenCode => format!("qwen mcp add -s user svode {launcher}"),
            Self::Pi => format!("pi mcp add svode -- {launcher}"),
            Self::KimiCode => return None,
        })
    }

    fn command_name(self) -> String {
        format!("{} mcp add", self.agent().executable())
    }
}

pub(crate) fn read(machine: &Machine, kind: AgentMcp) -> Entry {
    let root = match jsonc_value(&kind.config(machine)) {
        Ok(root) => root,
        Err(error) => return Entry::Unreadable(error.message),
    };
    let entry = entry_of(kind, &root);
    if entry != Entry::Absent {
        return entry;
    }
    for other in kind.other_configs(machine) {
        match jsonc_value(&other) {
            Ok(root) if entry_of(kind, &root) != Entry::Absent => return Entry::Custom,
            Ok(_) => {}
            Err(error) => return Entry::Unreadable(error.message),
        }
    }
    Entry::Absent
}

fn entry_of(kind: AgentMcp, root: &Value) -> Entry {
    let servers = kind
        .servers()
        .iter()
        .try_fold(root, |value, key| value.get(key));
    match servers.and_then(|servers| servers.get("svode")) {
        Some(Value::Object(entry)) => classify(kind, entry),
        Some(_) => Entry::Custom,
        // A `mcp.svode` of the opencode 1.x form is not Svode's either.
        None if kind == AgentMcp::Opencode && root["mcp"].get("svode").is_some() => Entry::Custom,
        None => Entry::Absent,
    }
}

fn classify(kind: AgentMcp, entry: &Map<String, Value>) -> Entry {
    let env = match kind {
        AgentMcp::Opencode => "environment",
        AgentMcp::QwenCode | AgentMcp::Pi | AgentMcp::KimiCode => "env",
    };
    let marker = entry
        .get(env)
        .and_then(|env| env.get(MARKER_ENV))
        .and_then(Value::as_str);
    let strings = |value: &Value| {
        value
            .as_array()?
            .iter()
            .map(|arg| arg.as_str().map(str::to_string))
            .collect::<Option<Vec<_>>>()
    };
    let launch = match kind {
        AgentMcp::Opencode => entry.get("command").and_then(strings).and_then(|command| {
            let (command, args) = command.split_first()?;
            Some(Launch {
                command: command.clone(),
                args: args.to_vec(),
                env_vars: Vec::new(),
            })
        }),
        AgentMcp::QwenCode | AgentMcp::Pi | AgentMcp::KimiCode => {
            let command = entry.get("command").and_then(Value::as_str);
            let args = match entry.get("args") {
                None => Some(Vec::new()),
                Some(args) => strings(args),
            };
            command.zip(args).map(|(command, args)| Launch {
                command: command.to_string(),
                args,
                env_vars: Vec::new(),
            })
        }
    };
    // Svode never wrote an unmarked entry for these agents.
    entry::classify(marker, launch, false)
}

/// Writes the managed entry with the agent's own command, or into its JSON
/// where it has none, and checks that the config holds it afterwards.
pub(crate) fn write(
    machine: &Machine,
    kind: AgentMcp,
    launcher: &Path,
) -> Result<(), ConnectError> {
    let Some(args) = kind.add_args(launcher) else {
        return write_entry(machine, kind, launcher);
    };
    let executable = machine
        .find(kind.agent())
        .ok_or_else(|| not_found(kind.agent()))?;
    run(machine, &executable, &args, &kind.command_name())?;
    if !entry::is_canonical(&read(machine, kind), launcher) {
        return Err(ConnectError::new(
            "AGENT_COMMAND_FAILED",
            format!(
                "`{}` did not write the Svode MCP entry to {}",
                kind.command_name(),
                kind.config(machine).display()
            ),
        ));
    }
    Ok(())
}

pub(crate) fn not_found(agent: AgentAdapterKind) -> ConnectError {
    ConnectError::new(
        "AGENT_NOT_FOUND",
        format!(
            "{} is not found on this machine: Svode adds its MCP entry with the `{}` command",
            agent.display_name(),
            agent.executable()
        ),
    )
}

/// Writes the managed entry into the JSON config, keeping every comment and
/// every other byte; a managed entry of another form is replaced in place.
fn write_entry(machine: &Machine, kind: AgentMcp, launcher: &Path) -> Result<(), ConnectError> {
    let path = kind.config(machine);
    let before = entry::read_text(&path)?;
    let source = if before.trim().is_empty() {
        "{}\n"
    } else {
        &before
    };
    let root = CstRootNode::parse(source, &ParseOptions::default())
        .map_err(|error| unreadable(&path, error))?;
    let mut servers = root.object_value_or_create();
    for key in kind.servers() {
        servers = servers.and_then(|object| object.object_value_or_create(key));
    }
    let servers = servers.ok_or_else(|| entry::unsupported_form(&path))?;
    let entry = CstInputValue::Object(vec![
        (
            "command".into(),
            CstInputValue::String(launcher.display().to_string()),
        ),
        ("args".into(), CstInputValue::Array(Vec::new())),
        (
            "env".into(),
            CstInputValue::Object(vec![(
                MARKER_ENV.into(),
                CstInputValue::String(MARKER.into()),
            )]),
        ),
    ]);
    match servers.get("svode") {
        Some(current) => current.set_value(entry),
        None => {
            servers.append("svode", entry);
        }
    }
    let after = root.to_string();
    let parsed = jsonc_parser::parse_to_serde_value::<Value>(&after, &ParseOptions::default())
        .map_err(|error| unreadable(&path, error))?;
    if !entry::is_canonical(&entry_of(kind, &parsed), launcher) {
        return Err(entry::unsupported_form(&path));
    }
    entry::write_if_unchanged(&path, &before, &after)
}

/// Removes the `svode` entry from the JSONC config, keeping every comment
/// and every other byte.
pub(crate) fn remove(machine: &Machine, kind: AgentMcp) -> Result<(), ConnectError> {
    let path = kind.config(machine);
    let before = entry::read_text(&path)?;
    let root = CstRootNode::parse(&before, &ParseOptions::default())
        .map_err(|error| unreadable(&path, error))?;
    let mut servers = root.object_value();
    for key in kind.servers() {
        servers = servers.and_then(|object| object.object_value(key));
    }
    if let Some(entry) = servers.and_then(|servers| servers.get("svode")) {
        entry.remove();
    }
    let after = root.to_string();
    let parsed = jsonc_parser::parse_to_serde_value::<Value>(&after, &ParseOptions::default())
        .map_err(|error| unreadable(&path, error))?;
    if entry_of(kind, &parsed) != Entry::Absent {
        return Err(entry::unsupported_form(&path));
    }
    entry::write_if_unchanged(&path, &before, &after)
}

/// A project config of `project` with a `svode` entry, which overrides the
/// user one.
pub(crate) fn higher_precedence(
    project: &Path,
    kind: AgentMcp,
) -> Result<Option<PathBuf>, ConnectError> {
    for path in kind.project_configs(project) {
        if entry_of(kind, &jsonc_value(&path)?) != Entry::Absent {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

/// A JSON config that may carry comments and trailing commas; `null` when
/// it is missing or empty.
pub(crate) fn jsonc_value(path: &Path) -> Result<Value, ConnectError> {
    let content = entry::read_text(path)?;
    if content.trim().is_empty() {
        return Ok(Value::Null);
    }
    jsonc_parser::parse_to_serde_value(&content, &ParseOptions::default())
        .map_err(|error| unreadable(path, error))
}

fn unreadable(path: &Path, error: impl std::fmt::Display) -> ConnectError {
    ConnectError::new("CONFIG_UNREADABLE", format!("{}: {error}", path.display()))
}

/// Runs an agent command for the user of `machine`, in the home directory,
/// with the PATH the agents are found on.
fn run(
    machine: &Machine,
    executable: &Path,
    args: &[String],
    name: &str,
) -> Result<(), ConnectError> {
    let failed = |message: String| ConnectError::new("AGENT_COMMAND_FAILED", message);
    let mut command = Command::new(executable);
    command
        .args(args)
        .current_dir(&machine.home)
        .env("HOME", &machine.home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if let Some(path) = &machine.search_path {
        command.env("PATH", path);
    }
    let mut child = command
        .spawn()
        .map_err(|error| failed(format!("`{name}` did not start: {error}")))?;
    let mut stderr = child.stderr.take();
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(stderr) = stderr.as_mut() {
            let _ = stderr.read_to_string(&mut text);
        }
        text
    });
    let deadline = Instant::now() + COMMAND_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let stderr = reader.join().unwrap_or_default();
    match status {
        Some(status) if status.success() => Ok(()),
        Some(status) => Err(failed(format!(
            "`{name}` failed ({status}){}",
            stderr
                .lines()
                .rev()
                .find(|line| !line.trim().is_empty())
                .map(|line| format!(": {}", line.trim()))
                .unwrap_or_default()
        ))),
        None => Err(failed(format!(
            "`{name}` did not finish in {} s",
            COMMAND_TIMEOUT.as_secs()
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LAUNCHER: &str = "/home/u/.svode/bin/svode-mcp";

    fn parse(text: &str) -> Value {
        jsonc_parser::parse_to_serde_value(text, &ParseOptions::default()).unwrap()
    }

    #[test]
    fn entries_of_each_form_are_read() {
        let managed = Entry::Managed(Some(Launch {
            command: LAUNCHER.into(),
            args: Vec::new(),
            env_vars: Vec::new(),
        }));
        let opencode = format!(
            r#"{{
  // mine
  "mcp": {{ "servers": {{ "svode": {{ "type": "local", "command": ["{LAUNCHER}"], "environment": {{ "{MARKER_ENV}": "{MARKER}" }} }} }} }},
}}"#
        );
        assert_eq!(entry_of(AgentMcp::Opencode, &parse(&opencode)), managed);
        let qwen = format!(
            r#"{{ "mcpServers": {{ "svode": {{ "command": "{LAUNCHER}", "args": [], "env": {{ "{MARKER_ENV}": "{MARKER}" }} }} }} }}"#
        );
        assert_eq!(entry_of(AgentMcp::QwenCode, &parse(&qwen)), managed);
        let pi = format!(
            r#"{{ "mcpServers": {{ "svode": {{ "command": "{LAUNCHER}", "env": {{ "{MARKER_ENV}": "{MARKER}" }} }} }} }}"#
        );
        assert_eq!(entry_of(AgentMcp::Pi, &parse(&pi)), managed);
    }

    #[test]
    fn unmarked_and_legacy_entries_are_custom() {
        let unmarked =
            format!(r#"{{ "mcpServers": {{ "svode": {{ "command": "{LAUNCHER}" }} }} }}"#);
        assert_eq!(entry_of(AgentMcp::Pi, &parse(&unmarked)), Entry::Custom);
        let previous_launch = r#"{ "mcpServers": { "svode": { "command": "/x/svode-mcp", "args": ["--app", "desktop"] } } }"#;
        assert_eq!(
            entry_of(AgentMcp::QwenCode, &parse(previous_launch)),
            Entry::Custom
        );
        let legacy = r#"{ "mcp": { "svode": { "type": "local", "command": ["x"] } } }"#;
        assert_eq!(entry_of(AgentMcp::Opencode, &parse(legacy)), Entry::Custom);
        assert_eq!(
            entry_of(
                AgentMcp::Opencode,
                &parse(r#"{ "mcp": { "servers": {} } }"#)
            ),
            Entry::Absent
        );
    }

    #[test]
    fn the_marker_and_the_launcher_go_into_every_add_command() {
        let launcher = Path::new(LAUNCHER);
        for kind in [AgentMcp::Opencode, AgentMcp::QwenCode, AgentMcp::Pi] {
            let args = kind.add_args(launcher).unwrap();
            assert_eq!(&args[..2], ["mcp", "add"]);
            assert!(args.contains(&format!("{MARKER_ENV}={MARKER}")), "{args:?}");
            assert_eq!(args.last().map(String::as_str), Some(LAUNCHER));
            assert!(
                !args
                    .iter()
                    .any(|arg| arg.contains("trust") || arg.contains("approv"))
            );
        }
        assert!(
            AgentMcp::Opencode
                .add_args(launcher)
                .unwrap()
                .contains(&"--global".to_string())
        );
        assert!(
            AgentMcp::QwenCode
                .add_args(launcher)
                .unwrap()
                .contains(&"user".to_string())
        );
        assert_eq!(AgentMcp::KimiCode.add_args(launcher), None);
    }
}

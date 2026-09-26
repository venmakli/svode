//! Status and diagnostics of the connections, the runtime they use and the
//! manual MCP config for users who configure a client by hand.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

use crate::entry::{self, Entry};
use crate::error::ConnectError;
use crate::link::Link;
use crate::machine::{ActiveRuntime, Client, Machine};
use crate::manager::{self, Inspection};
use crate::policy;

/// Said wherever a connection changes: an open agent session keeps its
/// skill and MCP server until it restarts, while `svode` switches at once.
pub const RESTART_NOTICE: &str = "Agent sessions that are already open get the new skill and MCP server after a restart; svode itself runs the new version at once.";

/// The runtime the connections start, under the name `server` that the
/// settings of the desktop app read.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    /// `installed` when the launchers start a runtime, else `not_found`.
    pub status: String,
    /// Stable `svode-mcp` launcher that client configs start.
    pub command: Option<String>,
    pub version: Option<String>,
    pub message: Option<String>,
    pub runtime: Option<ActiveRuntime>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactStatus {
    /// `skill` or `mcp-entry`.
    pub kind: String,
    pub path: String,
    /// `absent`, `managed`, `previous`, `foreign`, `custom` or `unreadable`.
    pub state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientStatus {
    pub id: String,
    pub name: String,
    /// The client CLI or its user config exists.
    pub found: bool,
    /// Connected: at least one artifact carries the Svode marker.
    pub installed: bool,
    /// Every connection is managed; kept equal to `installed`.
    pub managed: bool,
    /// `not_found`, `mcp_not_installed`, `installed` or `attention`.
    pub status: String,
    /// The most important issue when `status` is `attention`.
    pub attention_code: Option<String>,
    /// Path of the client CLI.
    pub path: Option<String>,
    /// User config that holds its MCP entry.
    pub config_path: Option<String>,
    pub message: Option<String>,
    /// Every artifact of a connected client is in place.
    pub complete: bool,
    /// Version of the connected payload.
    pub version: Option<String>,
    pub issues: Vec<Issue>,
    pub artifacts: Vec<ArtifactStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualConfig {
    pub name: String,
    pub transport: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
}

/// The desktop bridge as the host that asks for a doctor report sees it.
#[derive(Debug, Clone)]
pub struct BridgeProbe {
    pub protocol: String,
    pub discovery_file: Option<String>,
    pub discovery_present: bool,
    pub desktop_reachable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub ok: bool,
    /// Stable `svode-mcp` launcher.
    pub command: Option<String>,
    pub discovery_file: Option<String>,
    pub messages: Vec<String>,
    pub errors: Vec<String>,
    /// `svode-mcp` of the active runtime.
    pub binary_path: String,
    pub binary_exists: bool,
    pub binary_executable: bool,
    /// Version of the active runtime.
    pub version: String,
    pub bridge_protocol: String,
    /// `svode-mcp` of the runtime speaks the bridge protocol of the host that
    /// asked; unknown without a bridge probe or a runtime.
    pub bridge_compatible: Option<bool>,
    pub discovery_present: bool,
    pub desktop_reachable: bool,
    pub issues: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub server: RuntimeInfo,
    pub clients: Vec<ClientStatus>,
    pub manual_config: ManualConfig,
    pub doctor: DoctorReport,
}

pub fn runtime_info(machine: &Machine) -> RuntimeInfo {
    let Some(stable) = &machine.stable else {
        return RuntimeInfo {
            status: "not_found".into(),
            command: None,
            version: None,
            message: Some(
                "connecting agent clients through ~/.svode is supported on macOS and Linux only"
                    .into(),
            ),
            runtime: None,
        };
    };
    let command = Some(stable.launcher_mcp.display().to_string());
    match (&stable.runtime, stable.installed()) {
        (Some(runtime), true) => RuntimeInfo {
            status: "installed".into(),
            command,
            version: Some(runtime.version.clone()),
            message: None,
            runtime: Some(runtime.clone()),
        },
        _ => RuntimeInfo {
            status: "not_found".into(),
            command,
            version: None,
            message: Some(
                "the Svode runtime is not installed in ~/.svode: start Svode Desktop once or run the standalone Svode installer"
                    .into(),
            ),
            runtime: None,
        },
    }
}

/// Status of every client. `failed` carries what a reconcile just before
/// could not repair.
pub fn client_statuses(machine: &Machine, failed: &[(Client, ConnectError)]) -> Vec<ClientStatus> {
    Client::ALL
        .into_iter()
        .map(|client| {
            let error = failed
                .iter()
                .find(|(candidate, _)| *candidate == client)
                .map(|(_, error)| error);
            client_status(machine, client, error)
        })
        .collect()
}

fn client_status(
    machine: &Machine,
    client: Client,
    repair_error: Option<&ConnectError>,
) -> ClientStatus {
    let inspection = manager::inspect(machine, client);
    let connected = inspection.connected();
    let complete = connected && manager::complete(machine, client, &inspection);
    let command = find_command(client.command());
    let config = machine.mcp_config(client);
    let found = command.is_some() || config.is_file() || connected;
    let issues = issues(
        machine,
        client,
        &inspection,
        connected,
        complete,
        repair_error,
    );
    let attention = issues.first();
    ClientStatus {
        id: client.as_str().into(),
        name: client.name().into(),
        found,
        installed: connected,
        managed: connected,
        status: match (attention, connected, found) {
            (Some(_), _, _) => "attention",
            (None, true, _) => "installed",
            (None, false, true) => "mcp_not_installed",
            (None, false, false) => "not_found",
        }
        .into(),
        attention_code: attention.map(|issue| issue.code.clone()),
        path: command.map(|path| path.display().to_string()),
        config_path: Some(config.display().to_string()),
        message: attention.map(|issue| issue.message.clone()),
        complete,
        version: connected
            .then(|| machine.stable.as_ref()?.payload_version())
            .flatten(),
        issues,
        artifacts: artifacts(machine, client, &inspection),
    }
}

/// Issues of one client, the most important first.
fn issues(
    machine: &Machine,
    client: Client,
    inspection: &Inspection,
    connected: bool,
    complete: bool,
    repair_error: Option<&ConnectError>,
) -> Vec<Issue> {
    let mut issues = Vec::new();
    let mut push = |code: &str, message: String| {
        issues.push(Issue {
            code: code.into(),
            message,
        })
    };
    if let Entry::Unreadable(message) = &inspection.entry {
        push("config_unreadable", message.clone());
    }
    match &inspection.higher {
        Err(error) => push("config_unreadable", error.message.clone()),
        Ok(Some(path)) => push(
            "higher_precedence_conflict",
            format!(
                "a project or local svode MCP entry in {} overrides the user one",
                path.display()
            ),
        ),
        Ok(None) => {}
    }
    if inspection.entry == Entry::Custom {
        push(
            "custom_conflict",
            format!(
                "{} holds a custom svode MCP entry; Svode does not replace it",
                machine.mcp_config(client).display()
            ),
        );
    }
    if inspection.skill == Link::Foreign {
        push(
            "skill_conflict",
            format!(
                "{} is not the Svode skill; Svode does not replace it",
                machine.skill_link(client).display()
            ),
        );
    }
    for policy in policy::blocking(machine, client) {
        push("client_policy_blocked", policy);
    }
    if connected {
        let runtime = runtime_info(machine);
        if runtime.status != "installed" {
            push("runtime_unavailable", runtime.message.unwrap_or_default());
        }
        if let Some(error) = repair_error {
            push("repair_failed", error.message.clone());
        } else if !complete {
            push(
                "incomplete",
                format!(
                    "part of the Svode connection of {} is missing; reconcile restores it",
                    client.name()
                ),
            );
        }
        if client == Client::ClaudeCode
            && let Some(seconds) = policy::claude_mcp_blocked_for(machine)
        {
            push(
                "mcp_start_failed",
                format!(
                    "Claude Code will not start the Svode MCP server in new sessions for about {} min after it failed to start; start a new session after that",
                    seconds.div_ceil(60)
                ),
            );
        }
    }
    issues
}

fn artifacts(machine: &Machine, client: Client, inspection: &Inspection) -> Vec<ArtifactStatus> {
    let skill = match inspection.skill {
        Link::Absent => "absent",
        Link::Managed => "managed",
        Link::Foreign => "foreign",
    };
    let entry = match &inspection.entry {
        Entry::Absent => "absent",
        Entry::Managed(_) => "managed",
        Entry::Previous => "previous",
        Entry::Custom => "custom",
        Entry::Unreadable(_) => "unreadable",
    };
    vec![
        ArtifactStatus {
            kind: "skill".into(),
            path: machine.skill_link(client).display().to_string(),
            state: skill.into(),
        },
        ArtifactStatus {
            kind: "mcp-entry".into(),
            path: machine.mcp_config(client).display().to_string(),
            state: entry.into(),
        },
    ]
}

/// MCP config for a client configured by hand: the stable launcher in
/// automatic mode, without the marker, so the manager never takes it over.
pub fn manual_config(machine: &Machine) -> ManualConfig {
    ManualConfig {
        name: "svode".into(),
        transport: "stdio".into(),
        command: manual_command(machine),
        args: Vec::new(),
        env: HashMap::new(),
    }
}

/// The manual config in the form of `client`.
pub fn manual_config_text(machine: &Machine, client: Client) -> String {
    let command = manual_command(machine);
    match client {
        Client::ClaudeCode => format!(
            "claude mcp add --transport stdio --scope user svode -- {}",
            shell_quote(&command)
        ),
        Client::Codex => entry::codex_block(Path::new(&command), false),
    }
}

fn manual_command(machine: &Machine) -> String {
    machine
        .launcher_mcp()
        .map_or_else(|| "svode-mcp".into(), |path| path.display().to_string())
}

/// Diagnostics of the runtime, every client and, when given, the desktop
/// bridge.
pub fn doctor(machine: &Machine, bridge: Option<&BridgeProbe>) -> DoctorReport {
    doctor_with(machine, bridge, &client_statuses(machine, &[]))
}

pub(crate) fn doctor_with(
    machine: &Machine,
    bridge: Option<&BridgeProbe>,
    clients: &[ClientStatus],
) -> DoctorReport {
    let runtime = runtime_info(machine);
    let mut messages = Vec::new();
    let mut issues = Vec::new();
    let mut bridge_compatible = None;
    let binary = runtime
        .runtime
        .as_ref()
        .map(|runtime| runtime.mcp_binary.clone());
    let binary_exists = binary.as_ref().is_some_and(|binary| binary.exists());
    let binary_executable = binary.as_ref().is_some_and(|binary| is_executable(binary));
    match &runtime.runtime {
        Some(active) => messages.push(format!(
            "Svode runtime {} ({}) behind {}",
            active.version,
            active.kind,
            runtime.command.as_deref().unwrap_or_default()
        )),
        None => issues.push(runtime.message.clone().unwrap_or_default()),
    }
    if let Some(bridge) = bridge {
        messages.push(format!("Bridge protocol: {}", bridge.protocol));
        if let Some(binary) = &binary {
            let protocol = bridge_protocol_of(binary);
            bridge_compatible = Some(protocol.as_deref() == Some(bridge.protocol.as_str()));
            match protocol {
                Some(protocol) if protocol == bridge.protocol => {
                    messages.push("svode-mcp of the runtime speaks this bridge protocol".into())
                }
                Some(protocol) => issues.push(format!(
                    "svode-mcp of the runtime speaks bridge protocol {protocol}, not {}",
                    bridge.protocol
                )),
                None => issues.push(format!(
                    "{} did not report its bridge protocol",
                    binary.display()
                )),
            }
        }
        if !bridge.discovery_present {
            messages.push("Svode Desktop is not running: sessions use the headless runtime".into());
        } else if bridge.desktop_reachable {
            messages.push("Svode Desktop IPC is reachable".into());
        } else {
            issues.push(
                "Svode desktop discovery file exists but desktop IPC is not reachable".into(),
            );
        }
    }
    for client in clients {
        let state = if client.installed {
            format!(
                "connected{}",
                client
                    .version
                    .as_deref()
                    .map(|version| format!(" ({version})"))
                    .unwrap_or_default()
            )
        } else if client.found {
            "not connected".into()
        } else {
            "not found".into()
        };
        messages.push(format!("{}: {state}", client.name));
        for issue in &client.issues {
            issues.push(format!("{}: {}", client.name, issue.message));
        }
    }
    DoctorReport {
        ok: issues.is_empty(),
        command: runtime.command.clone(),
        discovery_file: bridge.and_then(|bridge| bridge.discovery_file.clone()),
        messages,
        errors: issues.clone(),
        binary_path: binary
            .map(|binary| binary.display().to_string())
            .unwrap_or_default(),
        binary_exists,
        binary_executable,
        version: runtime.version.unwrap_or_default(),
        bridge_protocol: bridge
            .map(|bridge| bridge.protocol.clone())
            .unwrap_or_default(),
        bridge_compatible,
        discovery_present: bridge.is_some_and(|bridge| bridge.discovery_present),
        desktop_reachable: bridge.is_some_and(|bridge| bridge.desktop_reachable),
        issues,
    }
}

fn bridge_protocol_of(binary: &Path) -> Option<String> {
    let output = Command::new(binary)
        .arg("--bridge-protocol")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn find_command(command: &str) -> Option<PathBuf> {
    if let Ok(path) = which::which(command) {
        return Some(path);
    }
    let mut dirs = Vec::new();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for suffix in [
            ".local/bin",
            ".volta/bin",
            ".cargo/bin",
            ".bun/bin",
            ".npm-global/bin",
            ".pnpm",
            "Library/pnpm",
            "Library/Application Support/pnpm",
        ] {
            dirs.push(home.join(suffix));
        }
    }
    if cfg!(target_os = "macos") {
        for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"] {
            dirs.push(PathBuf::from(dir));
        }
    }
    dirs.into_iter()
        .map(|dir| dir.join(command))
        .find(|candidate| is_executable(candidate))
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

fn shell_quote(raw: &str) -> String {
    format!("'{}'", raw.replace('\'', "'\\''"))
}

use std::collections::HashMap;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::process;

use super::error::McpBusinessError;
use super::{MCP_BRIDGE_PROTOCOL, MCP_MANAGED_MARKER_ENV, MCP_MANAGED_MARKER_VALUE, MCP_VERSION};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum McpClient {
    ClaudeCode,
    Codex,
}

impl McpClient {
    pub fn parse(value: &str) -> Result<Self, McpBusinessError> {
        match value {
            "claude-code" | "claude" => Ok(Self::ClaudeCode),
            "codex" => Ok(Self::Codex),
            _ => Err(McpBusinessError::new(
                "UNSUPPORTED_CLIENT",
                format!("unsupported MCP client: {value}"),
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::ClaudeCode => "Claude Code",
            Self::Codex => "Codex",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientConfigResult {
    pub client: String,
    pub command: String,
    pub args: Vec<String>,
    pub manual_config: String,
    pub installed: bool,
    pub message: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInfo {
    pub status: String,
    pub command: Option<String>,
    pub version: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpClientStatus {
    pub id: String,
    pub name: String,
    pub found: bool,
    pub installed: bool,
    pub managed: bool,
    pub status: String,
    pub attention_code: Option<String>,
    pub path: Option<String>,
    pub config_path: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub server: McpServerInfo,
    pub clients: Vec<McpClientStatus>,
    pub manual_config: ManualConfig,
    pub doctor: DoctorReport,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub ok: bool,
    pub command: Option<String>,
    pub discovery_file: Option<String>,
    pub messages: Vec<String>,
    pub errors: Vec<String>,
    pub binary_path: String,
    pub binary_exists: bool,
    pub binary_executable: bool,
    pub version: String,
    pub bridge_protocol: String,
    pub discovery_present: bool,
    pub desktop_reachable: bool,
    pub issues: Vec<String>,
}

pub struct ConfigMaintenanceResult {
    pub status: McpStatus,
    pub changed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LaunchEntry {
    command: String,
    args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum EntryState {
    Absent,
    Legacy(LaunchEntry),
    Managed(LaunchEntry),
    ManagedInvalid,
    Custom,
    Unreadable(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BridgeCompatibility {
    Compatible,
    Missing,
    Incompatible,
}

#[derive(Debug, Clone)]
struct ConfigPaths {
    claude_user: PathBuf,
    codex_user: PathBuf,
    project: Option<PathBuf>,
}

impl ConfigPaths {
    fn system(project: Option<&Path>) -> Result<Self, McpBusinessError> {
        let home = home_path()?;
        Ok(Self {
            claude_user: home.join(".claude.json"),
            codex_user: home.join(".codex").join("config.toml"),
            project: project.map(Path::to_path_buf),
        })
    }

    fn user_path(&self, client: McpClient) -> &Path {
        match client {
            McpClient::ClaudeCode => &self.claude_user,
            McpClient::Codex => &self.codex_user,
        }
    }
}

pub fn mcp_binary_name() -> &'static str {
    mcp_binary_name_for(cfg!(windows))
}

fn mcp_binary_name_for(windows: bool) -> &'static str {
    if windows {
        "svode-mcp.exe"
    } else {
        "svode-mcp"
    }
}

pub fn resolve_binary_path() -> PathBuf {
    if let Ok(current) = env::current_exe() {
        if current
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name == mcp_binary_name())
        {
            return current;
        }
        if cfg!(target_os = "macos") {
            if let Some(contents) = current.ancestors().find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name == "Contents")
            }) {
                let candidate = contents.join("Resources").join(mcp_binary_name());
                if candidate.exists() {
                    return candidate;
                }
            }
        }
        if let Some(parent) = current.parent() {
            let sibling = parent.join(mcp_binary_name());
            if sibling.exists() {
                return sibling;
            }
        }
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(triple) = env::var("TARGET").ok().or_else(rustc_host_triple) {
        let candidate = manifest_dir
            .join("binaries")
            .join(mcp_suffixed_name(&triple));
        if candidate.exists() {
            return candidate;
        }
    }
    for profile in ["release", "debug"] {
        let candidate = manifest_dir
            .join("target")
            .join(profile)
            .join(mcp_binary_name());
        if candidate.exists() {
            return candidate;
        }
    }
    PathBuf::from(mcp_binary_name())
}

pub fn manual_config_object() -> ManualConfig {
    manual_config_for_path(&resolve_binary_path())
}

pub fn manual_config(client: McpClient, command: &Path) -> String {
    match client {
        McpClient::ClaudeCode => format!(
            "claude mcp add --transport stdio --scope user --env {MCP_MANAGED_MARKER_ENV}={MCP_MANAGED_MARKER_VALUE} svode -- {} --app desktop",
            shell_quote(command)
        ),
        McpClient::Codex => canonical_codex_block(command),
    }
}

pub fn print_config(client: McpClient) -> ClientConfigResult {
    let command = resolve_binary_path();
    ClientConfigResult {
        client: client.as_str().to_string(),
        command: command.to_string_lossy().to_string(),
        args: canonical_args(),
        manual_config: manual_config(client, &command),
        installed: false,
        message: "Manual MCP config generated".to_string(),
    }
}

pub fn install_client(client: McpClient) -> Result<ClientConfigResult, McpBusinessError> {
    install_client_for_project(client, None)
}

pub fn install_client_for_project(
    client: McpClient,
    project_path: Option<&Path>,
) -> Result<ClientConfigResult, McpBusinessError> {
    let paths = ConfigPaths::system(project_path)?;
    let command = resolve_binary_path();
    connect_client_at(client, &paths, &command, &probe_bridge)?;
    let mut result = print_config(client);
    result.installed = true;
    result.message = format!("Connected Svode MCP in {} user scope", client.name());
    Ok(result)
}

pub fn remove_client(client: McpClient) -> Result<ClientConfigResult, McpBusinessError> {
    let paths = ConfigPaths::system(None)?;
    disconnect_client_at(client, &paths)?;
    let mut result = print_config(client);
    result.message = format!("Disconnected Svode MCP from {} user scope", client.name());
    Ok(result)
}

pub fn maintain_and_status(
    discovery_present: bool,
    desktop_reachable: bool,
    project_path: Option<&Path>,
) -> ConfigMaintenanceResult {
    let current_binary = resolve_binary_path();
    let paths = match ConfigPaths::system(project_path) {
        Ok(paths) => paths,
        Err(error) => {
            return ConfigMaintenanceResult {
                status: unavailable_status(discovery_present, desktop_reachable, error.message),
                changed: false,
            };
        }
    };
    maintain_and_status_at(
        &paths,
        &current_binary,
        &probe_bridge,
        &find_client_command,
        discovery_present,
        desktop_reachable,
    )
}

fn maintain_and_status_at(
    paths: &ConfigPaths,
    current_binary: &Path,
    bridge_probe: &dyn Fn(&Path) -> BridgeCompatibility,
    client_command: &dyn Fn(McpClient) -> Option<PathBuf>,
    discovery_present: bool,
    desktop_reachable: bool,
) -> ConfigMaintenanceResult {
    let mut changed = false;
    let mut maintenance_errors = Vec::new();

    for client in [McpClient::ClaudeCode, McpClient::Codex] {
        let result = match has_higher_precedence_entry(client, paths) {
            Ok(true) => Ok(false),
            Ok(false) => maintain_client_at(client, paths, current_binary, bridge_probe),
            Err(error) => Err(error),
        };
        match result {
            Ok(client_changed) => changed |= client_changed,
            Err(error) => maintenance_errors.push((client, error)),
        }
    }

    let doctor = doctor_with_probe(discovery_present, desktop_reachable, bridge_probe);
    let server_compatible =
        bridge_probe(Path::new(&doctor.binary_path)) == BridgeCompatibility::Compatible;
    let clients = [McpClient::ClaudeCode, McpClient::Codex]
        .into_iter()
        .map(|client| {
            let error = maintenance_errors
                .iter()
                .find(|(candidate, _)| *candidate == client)
                .map(|(_, error)| error);
            client_status_at(client, paths, bridge_probe, client_command(client), error)
        })
        .collect();

    ConfigMaintenanceResult {
        status: McpStatus {
            server: McpServerInfo {
                status: if server_compatible {
                    "installed".to_string()
                } else {
                    "not_found".to_string()
                },
                command: Some(doctor.binary_path.clone()),
                version: Some(doctor.version.clone()),
                message: (!server_compatible)
                    .then(|| "svode-mcp bridge was not found or is incompatible".to_string()),
            },
            clients,
            manual_config: manual_config_for_path(current_binary),
            doctor,
        },
        changed,
    }
}

fn unavailable_status(
    discovery_present: bool,
    desktop_reachable: bool,
    message: String,
) -> McpStatus {
    let doctor = doctor(discovery_present, desktop_reachable);
    let clients = [McpClient::ClaudeCode, McpClient::Codex]
        .into_iter()
        .map(|client| McpClientStatus {
            id: client.as_str().to_string(),
            name: client.name().to_string(),
            found: false,
            installed: false,
            managed: false,
            status: "attention".to_string(),
            attention_code: Some("config_unreadable".to_string()),
            path: None,
            config_path: None,
            message: Some(message.clone()),
        })
        .collect();
    McpStatus {
        server: McpServerInfo {
            status: "not_found".to_string(),
            command: doctor.command.clone(),
            version: Some(doctor.version.clone()),
            message: Some(message),
        },
        clients,
        manual_config: manual_config_object(),
        doctor,
    }
}

fn manual_config_for_path(command: &Path) -> ManualConfig {
    ManualConfig {
        name: "svode".to_string(),
        transport: "stdio".to_string(),
        command: command.to_string_lossy().to_string(),
        args: canonical_args(),
        env: HashMap::from([(
            MCP_MANAGED_MARKER_ENV.to_string(),
            MCP_MANAGED_MARKER_VALUE.to_string(),
        )]),
    }
}

pub fn doctor(discovery_present: bool, desktop_reachable: bool) -> DoctorReport {
    doctor_with_probe(discovery_present, desktop_reachable, &probe_bridge)
}

fn doctor_with_probe(
    discovery_present: bool,
    desktop_reachable: bool,
    bridge_probe: &dyn Fn(&Path) -> BridgeCompatibility,
) -> DoctorReport {
    let binary = resolve_binary_path();
    let exists = binary.exists();
    let executable = is_executable(&binary);
    let compatibility = bridge_probe(&binary);
    let mut issues = Vec::new();
    if !exists {
        issues.push("svode-mcp binary was not found at the resolved path".to_string());
    } else if !executable {
        issues.push("svode-mcp exists but is not executable".to_string());
    } else if compatibility != BridgeCompatibility::Compatible {
        issues.push(format!(
            "svode-mcp does not support bridge protocol {MCP_BRIDGE_PROTOCOL}"
        ));
    }
    if !discovery_present {
        issues.push("Svode desktop discovery file is not present".to_string());
    }
    if discovery_present && !desktop_reachable {
        issues.push(
            "Svode desktop discovery file exists but desktop IPC is not reachable".to_string(),
        );
    }
    let command = binary.to_string_lossy().to_string();
    let discovery_file = super::ipc::default_discovery_path()
        .ok()
        .map(|path| path.to_string_lossy().to_string());
    let mut messages = vec![
        format!("svode-mcp command: {command}"),
        format!("Svode MCP version: {MCP_VERSION}"),
        format!("Bridge protocol: {MCP_BRIDGE_PROTOCOL}"),
    ];
    if compatibility == BridgeCompatibility::Compatible {
        messages.push("svode-mcp bridge is present and compatible".to_string());
    }
    if discovery_present && desktop_reachable {
        messages.push("Svode desktop IPC is reachable".to_string());
    }
    let errors = issues.clone();
    DoctorReport {
        ok: errors.is_empty(),
        command: Some(command.clone()),
        discovery_file,
        messages,
        errors,
        binary_path: command,
        binary_exists: exists,
        binary_executable: executable,
        version: MCP_VERSION.to_string(),
        bridge_protocol: MCP_BRIDGE_PROTOCOL.to_string(),
        discovery_present,
        desktop_reachable,
        issues,
    }
}

fn maintain_client_at(
    client: McpClient,
    paths: &ConfigPaths,
    current_binary: &Path,
    bridge_probe: &dyn Fn(&Path) -> BridgeCompatibility,
) -> Result<bool, McpBusinessError> {
    match read_user_entry(client, paths) {
        EntryState::Legacy(entry) => {
            let command = if launch_is_compatible(&entry, bridge_probe) {
                PathBuf::from(entry.command)
            } else {
                require_current_bridge(current_binary, bridge_probe)?
            };
            write_managed_entry(client, paths, &command)?;
            Ok(true)
        }
        EntryState::Managed(entry) if launch_is_compatible(&entry, bridge_probe) => Ok(false),
        EntryState::Managed(_) | EntryState::ManagedInvalid => {
            let command = require_current_bridge(current_binary, bridge_probe)?;
            write_managed_entry(client, paths, &command)?;
            Ok(true)
        }
        EntryState::Absent | EntryState::Custom => Ok(false),
        EntryState::Unreadable(message) => {
            Err(McpBusinessError::new("MCP_CONFIG_UNREADABLE", message))
        }
    }
}

fn connect_client_at(
    client: McpClient,
    paths: &ConfigPaths,
    current_binary: &Path,
    bridge_probe: &dyn Fn(&Path) -> BridgeCompatibility,
) -> Result<bool, McpBusinessError> {
    if has_higher_precedence_entry(client, paths)? {
        return Err(McpBusinessError::new(
            "MCP_HIGHER_PRECEDENCE_CONFLICT",
            format!(
                "{} has a project/local svode MCP entry that overrides user scope",
                client.name()
            ),
        ));
    }
    match read_user_entry(client, paths) {
        EntryState::Managed(entry) if launch_is_compatible(&entry, bridge_probe) => Ok(false),
        EntryState::Absent
        | EntryState::Legacy(_)
        | EntryState::Managed(_)
        | EntryState::ManagedInvalid => {
            let command = require_current_bridge(current_binary, bridge_probe)?;
            write_managed_entry(client, paths, &command)?;
            Ok(true)
        }
        EntryState::Custom => Err(McpBusinessError::new(
            "MCP_CUSTOM_CONFIG_CONFLICT",
            format!(
                "{} already has a custom svode MCP entry; Svode did not replace it",
                client.name()
            ),
        )),
        EntryState::Unreadable(message) => {
            Err(McpBusinessError::new("MCP_CONFIG_UNREADABLE", message))
        }
    }
}

fn disconnect_client_at(client: McpClient, paths: &ConfigPaths) -> Result<bool, McpBusinessError> {
    match read_user_entry(client, paths) {
        EntryState::Absent => Ok(false),
        EntryState::Legacy(_) | EntryState::Managed(_) | EntryState::ManagedInvalid => {
            remove_managed_entry(client, paths)?;
            Ok(true)
        }
        EntryState::Custom => Err(McpBusinessError::new(
            "MCP_CUSTOM_CONFIG_CONFLICT",
            format!(
                "{} svode MCP entry is custom; Svode did not remove it",
                client.name()
            ),
        )),
        EntryState::Unreadable(message) => {
            Err(McpBusinessError::new("MCP_CONFIG_UNREADABLE", message))
        }
    }
}

fn require_current_bridge(
    current_binary: &Path,
    bridge_probe: &dyn Fn(&Path) -> BridgeCompatibility,
) -> Result<PathBuf, McpBusinessError> {
    if bridge_probe(current_binary) != BridgeCompatibility::Compatible {
        return Err(McpBusinessError::new(
            "MCP_BRIDGE_UNAVAILABLE",
            format!("current svode-mcp does not support bridge protocol {MCP_BRIDGE_PROTOCOL}"),
        ));
    }
    Ok(current_binary.to_path_buf())
}

fn client_status_at(
    client: McpClient,
    paths: &ConfigPaths,
    bridge_probe: &dyn Fn(&Path) -> BridgeCompatibility,
    client_command: Option<PathBuf>,
    maintenance_error: Option<&McpBusinessError>,
) -> McpClientStatus {
    let config_path = paths.user_path(client).to_string_lossy().to_string();
    let found = client_command.is_some() || paths.user_path(client).is_file();
    let path = client_command.map(|path| path.to_string_lossy().to_string());

    if let Some(error) = maintenance_error {
        let state = read_user_entry(client, paths);
        let attention_code = if error.code == "MCP_CONFIG_UNREADABLE" {
            "config_unreadable"
        } else {
            "repair_failed"
        };
        return attention_status(
            client,
            found,
            matches!(
                state,
                EntryState::Managed(_) | EntryState::ManagedInvalid | EntryState::Legacy(_)
            ),
            matches!(state, EntryState::Managed(_) | EntryState::ManagedInvalid),
            attention_code,
            path,
            config_path,
            Some(error.message.clone()),
        );
    }

    match has_higher_precedence_entry(client, paths) {
        Err(error) => attention_status(
            client,
            found,
            false,
            false,
            "config_unreadable",
            path,
            config_path,
            Some(error.message),
        ),
        Ok(true) => attention_status(
            client,
            found,
            false,
            false,
            "higher_precedence_conflict",
            path,
            config_path,
            None,
        ),
        Ok(false) => match read_user_entry(client, paths) {
            EntryState::Absent => McpClientStatus {
                id: client.as_str().to_string(),
                name: client.name().to_string(),
                found,
                installed: false,
                managed: false,
                status: if found {
                    "mcp_not_installed".to_string()
                } else {
                    "not_found".to_string()
                },
                attention_code: None,
                path,
                config_path: Some(config_path),
                message: None,
            },
            EntryState::Managed(entry) if launch_is_compatible(&entry, bridge_probe) => {
                McpClientStatus {
                    id: client.as_str().to_string(),
                    name: client.name().to_string(),
                    found: true,
                    installed: true,
                    managed: true,
                    status: "installed".to_string(),
                    attention_code: None,
                    path,
                    config_path: Some(config_path),
                    message: None,
                }
            }
            EntryState::Legacy(entry) if launch_is_compatible(&entry, bridge_probe) => {
                McpClientStatus {
                    id: client.as_str().to_string(),
                    name: client.name().to_string(),
                    found: true,
                    installed: true,
                    managed: false,
                    status: "installed".to_string(),
                    attention_code: None,
                    path,
                    config_path: Some(config_path),
                    message: None,
                }
            }
            EntryState::Managed(entry) | EntryState::Legacy(entry) => {
                let code = match bridge_probe(Path::new(&entry.command)) {
                    BridgeCompatibility::Missing => "bridge_missing",
                    BridgeCompatibility::Compatible | BridgeCompatibility::Incompatible => {
                        "bridge_incompatible"
                    }
                };
                let managed = matches!(
                    read_user_entry(client, paths),
                    EntryState::Managed(_) | EntryState::ManagedInvalid
                );
                attention_status(client, true, true, managed, code, path, config_path, None)
            }
            EntryState::ManagedInvalid => attention_status(
                client,
                true,
                true,
                true,
                "bridge_incompatible",
                path,
                config_path,
                None,
            ),
            EntryState::Custom => attention_status(
                client,
                found,
                false,
                false,
                "custom_conflict",
                path,
                config_path,
                None,
            ),
            EntryState::Unreadable(message) => attention_status(
                client,
                found,
                false,
                false,
                "config_unreadable",
                path,
                config_path,
                Some(message),
            ),
        },
    }
}

#[allow(clippy::too_many_arguments)]
fn attention_status(
    client: McpClient,
    found: bool,
    installed: bool,
    managed: bool,
    code: &str,
    path: Option<String>,
    config_path: String,
    message: Option<String>,
) -> McpClientStatus {
    McpClientStatus {
        id: client.as_str().to_string(),
        name: client.name().to_string(),
        found,
        installed,
        managed,
        status: "attention".to_string(),
        attention_code: Some(code.to_string()),
        path,
        config_path: Some(config_path),
        message,
    }
}

fn read_user_entry(client: McpClient, paths: &ConfigPaths) -> EntryState {
    let content = match read_config_text(paths.user_path(client)) {
        Ok(content) => content,
        Err(error) => return EntryState::Unreadable(error.message),
    };
    match client {
        McpClient::ClaudeCode => claude_entry_state(&content),
        McpClient::Codex => codex_entry_state(&content),
    }
}

fn claude_entry_state(content: &str) -> EntryState {
    if content.trim().is_empty() {
        return EntryState::Absent;
    }
    let root: Value = match serde_json::from_str(content) {
        Ok(root) => root,
        Err(error) => return EntryState::Unreadable(error.to_string()),
    };
    let Some(entry) = root
        .get("mcpServers")
        .and_then(Value::as_object)
        .and_then(|servers| servers.get("svode"))
        .and_then(Value::as_object)
    else {
        return EntryState::Absent;
    };
    classify_json_entry(entry)
}

fn classify_json_entry(entry: &Map<String, Value>) -> EntryState {
    let marker = entry
        .get("env")
        .and_then(Value::as_object)
        .and_then(|env| env.get(MCP_MANAGED_MARKER_ENV))
        .and_then(Value::as_str);
    let launch = json_launch_entry(entry);

    if marker == Some(MCP_MANAGED_MARKER_VALUE) {
        return launch.map_or(EntryState::ManagedInvalid, EntryState::Managed);
    }
    if marker.is_some() {
        return EntryState::Custom;
    }
    if launch.as_ref().is_some_and(|launch| {
        is_exact_legacy_launch(launch)
            && entry
                .keys()
                .all(|key| matches!(key.as_str(), "type" | "command" | "args" | "env"))
            && entry
                .get("type")
                .and_then(Value::as_str)
                .is_none_or(|kind| kind == "stdio")
            && entry
                .get("env")
                .and_then(Value::as_object)
                .is_none_or(Map::is_empty)
    }) {
        return EntryState::Legacy(launch.expect("checked legacy launch"));
    }
    EntryState::Custom
}

fn json_launch_entry(entry: &Map<String, Value>) -> Option<LaunchEntry> {
    let command = entry.get("command")?.as_str()?.to_string();
    let args = entry
        .get("args")?
        .as_array()?
        .iter()
        .map(Value::as_str)
        .collect::<Option<Vec<_>>>()?
        .into_iter()
        .map(str::to_string)
        .collect();
    Some(LaunchEntry { command, args })
}

fn codex_entry_state(content: &str) -> EntryState {
    if content.trim().is_empty() {
        return EntryState::Absent;
    }
    let root: toml::Value = match toml::from_str(content) {
        Ok(root) => root,
        Err(error) => return EntryState::Unreadable(error.to_string()),
    };
    let Some(entry) = root
        .get("mcp_servers")
        .and_then(toml::Value::as_table)
        .and_then(|servers| servers.get("svode"))
        .and_then(toml::Value::as_table)
    else {
        return EntryState::Absent;
    };
    classify_toml_entry(entry)
}

fn classify_toml_entry(entry: &toml::Table) -> EntryState {
    let marker = entry
        .get("env")
        .and_then(toml::Value::as_table)
        .and_then(|env| env.get(MCP_MANAGED_MARKER_ENV))
        .and_then(toml::Value::as_str);
    let launch = toml_launch_entry(entry);

    if marker == Some(MCP_MANAGED_MARKER_VALUE) {
        return launch.map_or(EntryState::ManagedInvalid, EntryState::Managed);
    }
    if marker.is_some() {
        return EntryState::Custom;
    }
    if launch.as_ref().is_some_and(|launch| {
        is_exact_legacy_launch(launch)
            && entry
                .keys()
                .all(|key| matches!(key.as_str(), "command" | "args" | "env"))
            && entry
                .get("env")
                .and_then(toml::Value::as_table)
                .is_none_or(toml::Table::is_empty)
    }) {
        return EntryState::Legacy(launch.expect("checked legacy launch"));
    }
    EntryState::Custom
}

fn toml_launch_entry(entry: &toml::Table) -> Option<LaunchEntry> {
    let command = entry.get("command")?.as_str()?.to_string();
    let args = entry
        .get("args")?
        .as_array()?
        .iter()
        .map(toml::Value::as_str)
        .collect::<Option<Vec<_>>>()?
        .into_iter()
        .map(str::to_string)
        .collect();
    Some(LaunchEntry { command, args })
}

fn is_exact_legacy_launch(entry: &LaunchEntry) -> bool {
    entry.args == canonical_args()
        && Path::new(&entry.command)
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case(mcp_binary_name()))
}

fn launch_is_compatible(
    entry: &LaunchEntry,
    bridge_probe: &dyn Fn(&Path) -> BridgeCompatibility,
) -> bool {
    entry.args == canonical_args()
        && bridge_probe(Path::new(&entry.command)) == BridgeCompatibility::Compatible
}

fn has_higher_precedence_entry(
    client: McpClient,
    paths: &ConfigPaths,
) -> Result<bool, McpBusinessError> {
    let Some(project) = paths.project.as_deref() else {
        return Ok(false);
    };
    match client {
        McpClient::ClaudeCode => {
            if json_has_root_svode_entry(&project.join(".mcp.json"))? {
                return Ok(true);
            }
            let content = read_config_text(&paths.claude_user)?;
            if content.trim().is_empty() {
                return Ok(false);
            }
            let root: Value = serde_json::from_str(&content)?;
            let project_key = project.to_string_lossy();
            Ok(root
                .get("projects")
                .and_then(Value::as_object)
                .and_then(|projects| projects.get(project_key.as_ref()))
                .and_then(|project| project.get("mcpServers"))
                .and_then(Value::as_object)
                .is_some_and(|servers| servers.contains_key("svode")))
        }
        McpClient::Codex => {
            let content = read_config_text(&project.join(".codex").join("config.toml"))?;
            if content.trim().is_empty() {
                return Ok(false);
            }
            let root: toml::Value = toml::from_str(&content).map_err(|error| {
                McpBusinessError::new("MCP_CONFIG_UNREADABLE", error.to_string())
            })?;
            Ok(root
                .get("mcp_servers")
                .and_then(toml::Value::as_table)
                .is_some_and(|servers| servers.contains_key("svode")))
        }
    }
}

fn json_has_root_svode_entry(path: &Path) -> Result<bool, McpBusinessError> {
    let content = read_config_text(path)?;
    if content.trim().is_empty() {
        return Ok(false);
    }
    let root: Value = serde_json::from_str(&content)?;
    Ok(root
        .get("mcpServers")
        .and_then(Value::as_object)
        .is_some_and(|servers| servers.contains_key("svode")))
}

fn write_managed_entry(
    client: McpClient,
    paths: &ConfigPaths,
    command: &Path,
) -> Result<(), McpBusinessError> {
    let path = paths.user_path(client);
    let before = read_config_text(path)?;
    let after = match client {
        McpClient::ClaudeCode => set_claude_entry(&before, command)?,
        McpClient::Codex => set_codex_entry(&before, command),
    };
    write_if_unchanged(path, &before, &after)
}

fn remove_managed_entry(client: McpClient, paths: &ConfigPaths) -> Result<(), McpBusinessError> {
    let path = paths.user_path(client);
    let before = read_config_text(path)?;
    let after = match client {
        McpClient::ClaudeCode => remove_claude_entry(&before)?,
        McpClient::Codex => remove_toml_block(&before),
    };
    write_if_unchanged(path, &before, &after)
}

fn set_claude_entry(content: &str, command: &Path) -> Result<String, McpBusinessError> {
    let mut root: Value = if content.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(content)?
    };
    let root = root.as_object_mut().ok_or_else(|| {
        McpBusinessError::new(
            "MCP_CONFIG_UNREADABLE",
            "Claude config root must be an object",
        )
    })?;
    let servers = root
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| {
            McpBusinessError::new(
                "MCP_CONFIG_UNREADABLE",
                "Claude mcpServers must be an object",
            )
        })?;
    servers.insert(
        "svode".to_string(),
        json!({
            "type": "stdio",
            "command": command.to_string_lossy(),
            "args": canonical_args(),
            "env": { MCP_MANAGED_MARKER_ENV: MCP_MANAGED_MARKER_VALUE },
        }),
    );
    Ok(format!("{}\n", serde_json::to_string_pretty(&root)?))
}

fn remove_claude_entry(content: &str) -> Result<String, McpBusinessError> {
    if content.trim().is_empty() {
        return Ok(content.to_string());
    }
    let mut root: Value = serde_json::from_str(content)?;
    if let Some(servers) = root.get_mut("mcpServers").and_then(Value::as_object_mut) {
        servers.remove("svode");
    }
    Ok(format!("{}\n", serde_json::to_string_pretty(&root)?))
}

fn set_codex_entry(content: &str, command: &Path) -> String {
    let cleaned = remove_toml_block(content);
    let block = canonical_codex_block(command);
    if cleaned.trim().is_empty() {
        block
    } else {
        format!("{}\n\n{}", cleaned.trim_end(), block)
    }
}

fn canonical_codex_block(command: &Path) -> String {
    format!(
        "[mcp_servers.svode]\ncommand = \"{}\"\nargs = [\"--app\", \"desktop\"]\n\n[mcp_servers.svode.env]\n{MCP_MANAGED_MARKER_ENV} = \"{MCP_MANAGED_MARKER_VALUE}\"\n",
        toml_escape(&command.to_string_lossy())
    )
}

fn remove_toml_block(input: &str) -> String {
    let mut output = Vec::new();
    let mut skipping = false;
    for line in input.lines() {
        let trimmed = line.trim();
        if is_svode_toml_table(trimmed) {
            skipping = true;
            continue;
        }
        if skipping && trimmed.starts_with('[') {
            skipping = false;
        }
        if !skipping {
            output.push(line);
        }
    }
    output.join("\n")
}

fn is_svode_toml_table(trimmed: &str) -> bool {
    if !trimmed.starts_with('[') || !trimmed.ends_with(']') {
        return false;
    }
    let table = trimmed.trim_start_matches('[').trim_end_matches(']').trim();
    table == "mcp_servers.svode" || table.starts_with("mcp_servers.svode.")
}

fn read_config_text(path: &Path) -> Result<String, McpBusinessError> {
    match fs::read_to_string(path) {
        Ok(content) => Ok(content),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error.into()),
    }
}

fn write_if_unchanged(path: &Path, before: &str, after: &str) -> Result<(), McpBusinessError> {
    let current = read_config_text(path)?;
    if current != before {
        return Err(McpBusinessError::new(
            "MCP_CONFIG_CONFLICT",
            format!(
                "MCP config {} changed during mutation; no Svode changes were written",
                path.display()
            ),
        ));
    }
    atomic_write(path, after.as_bytes())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), McpBusinessError> {
    let parent = path.parent().ok_or_else(|| {
        McpBusinessError::new("MCP_CONFIG_WRITE_FAILED", "MCP config has no parent")
    })?;
    fs::create_dir_all(parent)?;
    let temp = parent.join(format!(".svode-mcp-{}.tmp", ulid::Ulid::new()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        Ok::<_, std::io::Error>(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(Into::into)
}

fn canonical_args() -> Vec<String> {
    vec!["--app".to_string(), "desktop".to_string()]
}

fn probe_bridge(path: &Path) -> BridgeCompatibility {
    if !path.is_file() || !is_executable(path) {
        return BridgeCompatibility::Missing;
    }
    let mut command = Command::new(path);
    process::hide_window(&mut command);
    match command.arg("--bridge-protocol").output() {
        Ok(output)
            if output.status.success()
                && String::from_utf8_lossy(&output.stdout).trim() == MCP_BRIDGE_PROTOCOL =>
        {
            BridgeCompatibility::Compatible
        }
        Ok(_) | Err(_) => BridgeCompatibility::Incompatible,
    }
}

fn find_client_command(client: McpClient) -> Option<PathBuf> {
    find_agent_command(match client {
        McpClient::ClaudeCode => "claude",
        McpClient::Codex => "codex",
    })
}

fn find_agent_command(command: &str) -> Option<PathBuf> {
    if let Ok(path) = which::which(command) {
        return Some(path);
    }

    let names = command_candidate_names(command);
    for dir in agent_command_search_dirs() {
        for name in &names {
            let candidate = dir.join(name);
            if is_executable(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

fn command_candidate_names(command: &str) -> Vec<String> {
    if !cfg!(windows) || Path::new(command).extension().is_some() {
        return vec![command.to_string()];
    }
    ["exe", "cmd", "bat"]
        .into_iter()
        .map(|extension| format!("{command}.{extension}"))
        .chain(std::iter::once(command.to_string()))
        .collect()
}

fn agent_command_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(path) = env::var_os("PATH") {
        for dir in env::split_paths(&path) {
            push_unique_path(&mut dirs, dir);
        }
    }
    if let Ok(home) = home_path() {
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
            push_unique_path(&mut dirs, home.join(suffix));
        }
        if cfg!(windows) {
            for suffix in [
                "AppData/Roaming/npm",
                "AppData/Local/pnpm",
                "AppData/Local/Programs/pnpm",
            ] {
                push_unique_path(&mut dirs, home.join(suffix));
            }
        }
    }
    if cfg!(target_os = "macos") {
        for path in [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/opt/local/bin",
            "/usr/bin",
            "/bin",
        ] {
            push_unique_path(&mut dirs, PathBuf::from(path));
        }
    }
    if cfg!(windows) {
        if let Some(appdata) = env::var_os("APPDATA") {
            push_unique_path(&mut dirs, PathBuf::from(appdata).join("npm"));
        }
        if let Some(local_appdata) = env::var_os("LOCALAPPDATA") {
            let local_appdata = PathBuf::from(local_appdata);
            push_unique_path(&mut dirs, local_appdata.join("pnpm"));
            push_unique_path(&mut dirs, local_appdata.join("Programs").join("pnpm"));
        }
    }
    dirs
}

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.iter().any(|existing| existing == &path) {
        paths.push(path);
    }
}

fn mcp_suffixed_name(triple: &str) -> String {
    mcp_suffixed_name_for(triple, cfg!(windows))
}

fn mcp_suffixed_name_for(triple: &str, windows: bool) -> String {
    if windows {
        format!("svode-mcp-{triple}.exe")
    } else {
        format!("svode-mcp-{triple}")
    }
}

fn rustc_host_triple() -> Option<String> {
    let mut command = Command::new("rustc");
    process::hide_window(&mut command);
    let output = command.arg("-vV").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8(output.stdout).ok()?;
    stdout.lines().find_map(|line| {
        line.strip_prefix("host:")
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

fn home_path() -> Result<PathBuf, McpBusinessError> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| McpBusinessError::new("HOME_NOT_FOUND", "could not resolve home directory"))
}

fn toml_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn shell_quote(path: &Path) -> String {
    let raw = path.to_string_lossy();
    if cfg!(windows) {
        format!("\"{}\"", raw.replace('"', "\\\""))
    } else {
        format!("'{}'", raw.replace('\'', "'\\''"))
    }
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_paths(root: &Path, project: Option<&Path>) -> ConfigPaths {
        ConfigPaths {
            claude_user: root.join(".claude.json"),
            codex_user: root.join("config.toml"),
            project: project.map(Path::to_path_buf),
        }
    }

    fn compatibility(path: &Path) -> BridgeCompatibility {
        match path.to_string_lossy().as_ref() {
            "/compatible/svode-mcp" | "/current/svode-mcp" => BridgeCompatibility::Compatible,
            "/missing/svode-mcp" => BridgeCompatibility::Missing,
            _ => BridgeCompatibility::Incompatible,
        }
    }

    #[test]
    fn desktop_bridge_protocol_is_independent_from_package_version() {
        assert_eq!(MCP_BRIDGE_PROTOCOL, MCP_MANAGED_MARKER_VALUE);
        assert_ne!(MCP_BRIDGE_PROTOCOL, MCP_VERSION);
    }

    #[test]
    fn adopts_compatible_codex_legacy_entry_without_rewriting_its_path() {
        let root = tempfile::tempdir().unwrap();
        let paths = test_paths(root.path(), None);
        fs::write(
            &paths.codex_user,
            "# keep comment\n[other]\nvalue = 1\n\n[mcp_servers.svode]\ncommand = \"/compatible/svode-mcp\"\nargs = [\"--app\", \"desktop\"]\n",
        )
        .unwrap();

        assert!(
            maintain_client_at(
                McpClient::Codex,
                &paths,
                Path::new("/current/svode-mcp"),
                &compatibility,
            )
            .unwrap()
        );

        let content = fs::read_to_string(&paths.codex_user).unwrap();
        assert!(content.contains("# keep comment"));
        assert!(content.contains("[other]"));
        assert!(content.contains("/compatible/svode-mcp"));
        assert!(content.contains(MCP_MANAGED_MARKER_ENV));
        assert!(matches!(
            codex_entry_state(&content),
            EntryState::Managed(_)
        ));
    }

    #[test]
    fn repairs_only_managed_missing_bridge_and_preserves_unrelated_codex_config() {
        let root = tempfile::tempdir().unwrap();
        let paths = test_paths(root.path(), None);
        fs::write(
            &paths.codex_user,
            format!(
                "[other]\nvalue = \"keep\"\n\n[mcp_servers.svode]\ncommand = \"/missing/svode-mcp\"\nargs = [\"--app\", \"desktop\"]\n\n[mcp_servers.svode.env]\n{MCP_MANAGED_MARKER_ENV} = \"{MCP_MANAGED_MARKER_VALUE}\"\n"
            ),
        )
        .unwrap();

        assert!(
            maintain_client_at(
                McpClient::Codex,
                &paths,
                Path::new("/current/svode-mcp"),
                &compatibility,
            )
            .unwrap()
        );
        let content = fs::read_to_string(&paths.codex_user).unwrap();
        assert!(content.contains("value = \"keep\""));
        assert!(content.contains("/current/svode-mcp"));
        assert!(!content.contains("/missing/svode-mcp"));
    }

    #[test]
    fn compatible_managed_bridge_from_another_build_is_write_free() {
        let root = tempfile::tempdir().unwrap();
        let paths = test_paths(root.path(), None);
        let original = canonical_codex_block(Path::new("/compatible/svode-mcp"));
        fs::write(&paths.codex_user, &original).unwrap();

        assert!(
            !maintain_client_at(
                McpClient::Codex,
                &paths,
                Path::new("/current/svode-mcp"),
                &compatibility,
            )
            .unwrap()
        );
        assert_eq!(fs::read_to_string(&paths.codex_user).unwrap(), original);
    }

    #[test]
    fn adopts_claude_legacy_entry_and_preserves_unrelated_json_values() {
        let root = tempfile::tempdir().unwrap();
        let paths = test_paths(root.path(), None);
        fs::write(
            &paths.claude_user,
            r#"{
  "theme": "dark",
  "mcpServers": {
    "other": { "type": "http", "url": "https://example.com" },
    "svode": {
      "type": "stdio",
      "command": "/compatible/svode-mcp",
      "args": ["--app", "desktop"],
      "env": {}
    }
  }
}"#,
        )
        .unwrap();

        assert!(
            maintain_client_at(
                McpClient::ClaudeCode,
                &paths,
                Path::new("/current/svode-mcp"),
                &compatibility,
            )
            .unwrap()
        );
        let content = fs::read_to_string(&paths.claude_user).unwrap();
        let value: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(value["theme"], "dark");
        assert_eq!(value["mcpServers"]["other"]["url"], "https://example.com");
        assert_eq!(
            value["mcpServers"]["svode"]["command"],
            "/compatible/svode-mcp"
        );
        assert_eq!(
            value["mcpServers"]["svode"]["env"][MCP_MANAGED_MARKER_ENV],
            MCP_MANAGED_MARKER_VALUE
        );
    }

    #[test]
    fn custom_entries_are_not_adopted_repaired_or_removed() {
        let root = tempfile::tempdir().unwrap();
        let paths = test_paths(root.path(), None);
        let custom = "[mcp_servers.svode]\ncommand = \"custom-wrapper\"\nargs = []\n";
        fs::write(&paths.codex_user, custom).unwrap();

        assert!(
            !maintain_client_at(
                McpClient::Codex,
                &paths,
                Path::new("/current/svode-mcp"),
                &compatibility,
            )
            .unwrap()
        );
        assert!(
            connect_client_at(
                McpClient::Codex,
                &paths,
                Path::new("/current/svode-mcp"),
                &compatibility,
            )
            .is_err()
        );
        assert!(disconnect_client_at(McpClient::Codex, &paths).is_err());
        assert_eq!(fs::read_to_string(&paths.codex_user).unwrap(), custom);
    }

    #[test]
    fn project_and_local_entries_block_user_scope_mutation() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        fs::create_dir_all(&project).unwrap();
        fs::write(
            project.join(".mcp.json"),
            r#"{"mcpServers":{"svode":{"command":"custom","args":[]}}}"#,
        )
        .unwrap();
        let paths = test_paths(root.path(), Some(&project));

        assert!(has_higher_precedence_entry(McpClient::ClaudeCode, &paths).unwrap());
        assert!(
            connect_client_at(
                McpClient::ClaudeCode,
                &paths,
                Path::new("/current/svode-mcp"),
                &compatibility,
            )
            .is_err()
        );

        fs::create_dir_all(project.join(".codex")).unwrap();
        fs::write(
            project.join(".codex").join("config.toml"),
            "[mcp_servers.svode]\ncommand = \"custom\"\n",
        )
        .unwrap();
        assert!(has_higher_precedence_entry(McpClient::Codex, &paths).unwrap());
    }

    #[test]
    fn fingerprint_recheck_rejects_concurrent_external_edit() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("config.toml");
        fs::write(&path, "before").unwrap();
        let before = read_config_text(&path).unwrap();
        fs::write(&path, "external").unwrap();

        let error = write_if_unchanged(&path, &before, "svode").unwrap_err();
        assert_eq!(error.code, "MCP_CONFIG_CONFLICT");
        assert_eq!(fs::read_to_string(path).unwrap(), "external");
    }

    #[test]
    fn generated_configs_escape_paths_and_include_managed_marker() {
        let command = Path::new(r#"C:\Program Files\Svode "A"\svode-mcp.exe"#);
        let codex = manual_config(McpClient::Codex, command);
        let claude = set_claude_entry("{}", command).unwrap();

        assert!(codex.contains(r#"C:\\Program Files\\Svode \"A\"\\svode-mcp.exe"#));
        assert!(codex.contains(MCP_MANAGED_MARKER_ENV));
        let claude: Value = serde_json::from_str(&claude).unwrap();
        assert_eq!(
            claude["mcpServers"]["svode"]["command"],
            command.to_string_lossy().as_ref()
        );
        assert_eq!(
            claude["mcpServers"]["svode"]["env"][MCP_MANAGED_MARKER_ENV],
            MCP_MANAGED_MARKER_VALUE
        );
    }

    #[test]
    fn platform_binary_names_are_deterministic() {
        assert_eq!(mcp_binary_name_for(false), "svode-mcp");
        assert_eq!(mcp_binary_name_for(true), "svode-mcp.exe");
        assert_eq!(
            mcp_suffixed_name_for("x86_64-unknown-linux-gnu", false),
            "svode-mcp-x86_64-unknown-linux-gnu"
        );
        assert_eq!(
            mcp_suffixed_name_for("x86_64-pc-windows-msvc", true),
            "svode-mcp-x86_64-pc-windows-msvc.exe"
        );
    }

    #[test]
    fn removes_only_svode_toml_tables() {
        let input = "[x]\na=1\n[mcp_servers.svode]\ncommand=\"old\"\nargs=[]\n[mcp_servers.svode.env]\nSVODE_MCP_MANAGED=\"old\"\n[y]\nb=2\n";
        assert_eq!(remove_toml_block(input), "[x]\na=1\n[y]\nb=2");
    }

    #[test]
    fn installed_client_status_wins_without_cli_path() {
        let root = tempfile::tempdir().unwrap();
        let paths = test_paths(root.path(), None);
        fs::write(
            &paths.codex_user,
            canonical_codex_block(Path::new("/compatible/svode-mcp")),
        )
        .unwrap();
        let status = client_status_at(McpClient::Codex, &paths, &compatibility, None, None);
        assert!(status.found);
        assert!(status.installed);
        assert_eq!(status.status, "installed");
    }

    #[cfg(not(windows))]
    #[test]
    fn unix_command_candidates_do_not_add_windows_extensions() {
        assert_eq!(command_candidate_names("codex"), vec!["codex".to_string()]);
    }
}

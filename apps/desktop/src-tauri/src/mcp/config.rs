use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use super::MCP_VERSION;
use super::error::McpBusinessError;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
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
    pub status: String,
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
    pub discovery_present: bool,
    pub desktop_reachable: bool,
    pub issues: Vec<String>,
}

pub fn mcp_binary_name() -> &'static str {
    if cfg!(windows) {
        "combai-mcp.exe"
    } else {
        "combai-mcp"
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
            if let Some(contents) = current.ancestors().find(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n == "Contents")
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
    let command = resolve_binary_path();
    ManualConfig {
        name: "combai".to_string(),
        transport: "stdio".to_string(),
        command: command.to_string_lossy().to_string(),
        args: vec!["--app".to_string(), "desktop".to_string()],
        env: HashMap::new(),
    }
}

pub fn manual_config(client: McpClient, command: &Path) -> String {
    match client {
        McpClient::ClaudeCode => {
            format!(
                "claude mcp add --transport stdio --scope user combai -- {} --app desktop",
                shell_quote(command)
            )
        }
        McpClient::Codex => {
            format!(
                "[mcp_servers.combai]\ncommand = \"{}\"\nargs = [\"--app\", \"desktop\"]\n",
                toml_escape(&command.to_string_lossy())
            )
        }
    }
}

pub fn print_config(client: McpClient) -> ClientConfigResult {
    let command = resolve_binary_path();
    ClientConfigResult {
        client: client.as_str().to_string(),
        command: command.to_string_lossy().to_string(),
        args: vec!["--app".to_string(), "desktop".to_string()],
        manual_config: manual_config(client, &command),
        installed: false,
        message: "Manual MCP config generated".to_string(),
    }
}

pub fn install_client(client: McpClient) -> Result<ClientConfigResult, McpBusinessError> {
    let command = resolve_binary_path();
    let mut result = print_config(client);
    match client {
        McpClient::ClaudeCode => {
            if which::which("claude").is_ok() {
                let status = Command::new("claude")
                    .args([
                        "mcp",
                        "add",
                        "--transport",
                        "stdio",
                        "--scope",
                        "user",
                        "combai",
                        "--",
                    ])
                    .arg(&command)
                    .args(["--app", "desktop"])
                    .status()?;
                if status.success() {
                    result.installed = true;
                    result.message = "Installed CombAI MCP in Claude Code user scope".to_string();
                } else {
                    result.message =
                        "Claude Code CLI returned an error; use manual config".to_string();
                }
            } else {
                result.message = "Claude Code CLI not found; use manual config".to_string();
            }
        }
        McpClient::Codex => {
            install_codex_config(&command)?;
            result.installed = true;
            result.message = "Installed CombAI MCP in ~/.codex/config.toml".to_string();
        }
    }
    Ok(result)
}

pub fn remove_client(client: McpClient) -> Result<ClientConfigResult, McpBusinessError> {
    let mut result = print_config(client);
    match client {
        McpClient::ClaudeCode => {
            if which::which("claude").is_ok() {
                let status = Command::new("claude")
                    .args(["mcp", "remove", "combai"])
                    .status()?;
                result.message = if status.success() {
                    "Removed CombAI MCP from Claude Code".to_string()
                } else {
                    "Claude Code CLI returned an error while removing CombAI MCP".to_string()
                };
            } else {
                result.message =
                    "Claude Code CLI not found; remove the combai MCP server manually".to_string();
            }
        }
        McpClient::Codex => {
            remove_codex_config()?;
            result.message = "Removed CombAI MCP block from ~/.codex/config.toml".to_string();
        }
    }
    Ok(result)
}

pub fn status(discovery_present: bool, desktop_reachable: bool) -> McpStatus {
    let doctor = doctor(discovery_present, desktop_reachable);
    let server_installed = doctor.binary_exists && doctor.binary_executable;
    McpStatus {
        server: McpServerInfo {
            status: if server_installed {
                "installed".to_string()
            } else {
                "not_found".to_string()
            },
            command: Some(doctor.binary_path.clone()),
            version: Some(doctor.version.clone()),
            message: if server_installed {
                None
            } else {
                Some("combai-mcp binary was not found or is not executable".to_string())
            },
        },
        clients: vec![
            client_status(McpClient::ClaudeCode),
            client_status(McpClient::Codex),
        ],
        manual_config: manual_config_object(),
        doctor,
    }
}

pub fn doctor(discovery_present: bool, desktop_reachable: bool) -> DoctorReport {
    let binary = resolve_binary_path();
    let exists = binary.exists();
    let executable = is_executable(&binary);
    let mut issues = Vec::new();
    if !exists {
        issues.push("combai-mcp binary was not found at the resolved path".to_string());
    }
    if exists && !executable {
        issues.push("combai-mcp exists but is not executable".to_string());
    }
    if !discovery_present {
        issues.push("CombAI desktop discovery file is not present".to_string());
    }
    if discovery_present && !desktop_reachable {
        issues.push(
            "CombAI desktop discovery file exists but desktop IPC is not reachable".to_string(),
        );
    }
    let command = binary.to_string_lossy().to_string();
    let discovery_file = super::ipc::default_discovery_path()
        .ok()
        .map(|path| path.to_string_lossy().to_string());
    let mut messages = vec![
        format!("combai-mcp command: {command}"),
        format!("CombAI MCP version: {MCP_VERSION}"),
    ];
    if exists && executable {
        messages.push("combai-mcp binary is present and executable".to_string());
    }
    if discovery_present && desktop_reachable {
        messages.push("CombAI desktop IPC is reachable".to_string());
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
        discovery_present,
        desktop_reachable,
        issues,
    }
}

fn client_status(client: McpClient) -> McpClientStatus {
    match client {
        McpClient::ClaudeCode => {
            let path = which::which("claude").ok();
            let found = path.is_some();
            let installed = found && command_success("claude", &["mcp", "get", "combai"]);
            McpClientStatus {
                id: client.as_str().to_string(),
                name: "Claude Code".to_string(),
                found,
                installed,
                status: client_status_name(found, installed),
                path: path.map(|path| path.to_string_lossy().to_string()),
                config_path: home_path()
                    .ok()
                    .map(|home| home.join(".claude.json").to_string_lossy().to_string()),
                message: if found {
                    None
                } else {
                    Some("Claude Code CLI was not found in PATH".to_string())
                },
            }
        }
        McpClient::Codex => {
            let path = which::which("codex").ok();
            let found = path.is_some();
            let config_path = codex_config_path().ok();
            let installed = config_path
                .as_ref()
                .and_then(|path| fs::read_to_string(path).ok())
                .is_some_and(|content| content.contains("[mcp_servers.combai]"));
            McpClientStatus {
                id: client.as_str().to_string(),
                name: "Codex".to_string(),
                found,
                installed,
                status: client_status_name(found, installed),
                path: path.map(|path| path.to_string_lossy().to_string()),
                config_path: config_path.map(|path| path.to_string_lossy().to_string()),
                message: if found {
                    None
                } else {
                    Some("Codex CLI was not found in PATH".to_string())
                },
            }
        }
    }
}

fn client_status_name(found: bool, installed: bool) -> String {
    if !found {
        "not_found".to_string()
    } else if installed {
        "installed".to_string()
    } else {
        "mcp_not_installed".to_string()
    }
}

fn command_success(command: &str, args: &[&str]) -> bool {
    Command::new(command)
        .args(args)
        .output()
        .is_ok_and(|output| output.status.success())
}

fn mcp_suffixed_name(triple: &str) -> String {
    if cfg!(windows) {
        format!("combai-mcp-{triple}.exe")
    } else {
        format!("combai-mcp-{triple}")
    }
}

fn rustc_host_triple() -> Option<String> {
    let output = Command::new("rustc").arg("-vV").output().ok()?;
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

fn install_codex_config(command: &Path) -> Result<(), McpBusinessError> {
    let path = codex_config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let cleaned = remove_toml_block(&existing);
    let block = format!(
        "\n[mcp_servers.combai]\ncommand = \"{}\"\nargs = [\"--app\", \"desktop\"]\n",
        toml_escape(&command.to_string_lossy())
    );
    fs::write(path, format!("{}{}", cleaned.trim_end(), block))?;
    Ok(())
}

fn remove_codex_config() -> Result<(), McpBusinessError> {
    let path = codex_config_path()?;
    if path.exists() {
        let existing = fs::read_to_string(&path)?;
        fs::write(path, remove_toml_block(&existing))?;
    }
    Ok(())
}

fn codex_config_path() -> Result<PathBuf, McpBusinessError> {
    Ok(home_path()?.join(".codex").join("config.toml"))
}

fn home_path() -> Result<PathBuf, McpBusinessError> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| McpBusinessError::new("HOME_NOT_FOUND", "could not resolve home directory"))
}

fn remove_toml_block(input: &str) -> String {
    let mut output = Vec::new();
    let mut skipping = false;
    for line in input.lines() {
        let trimmed = line.trim();
        if trimmed == "[mcp_servers.combai]" {
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
        .map(|m| m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_only_combai_toml_block() {
        let input = "[x]\na=1\n[mcp_servers.combai]\ncommand=\"old\"\nargs=[]\n[y]\nb=2\n";
        assert_eq!(remove_toml_block(input), "[x]\na=1\n[y]\nb=2");
    }

    #[test]
    fn escapes_toml_paths() {
        assert_eq!(
            toml_escape(r#"C:\Program Files\CombAI "A""#),
            r#"C:\\Program Files\\CombAI \"A\""#
        );
    }
}

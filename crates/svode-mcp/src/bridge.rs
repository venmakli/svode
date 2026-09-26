use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::{Value, json};
use svode_tools::error::ToolError;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

use crate::protocol::{DiscoveryFile, IpcContextOverride, IpcRequest, IpcResponse};
use crate::{
    MCP_BRIDGE_PROTOCOL, MCP_DISCOVERY_ENV, MCP_PROJECT_PATH_ENV, MCP_ROUTINE_CALLER_TOKEN_ENV,
};

pub fn default_discovery_path() -> Result<PathBuf, ToolError> {
    if cfg!(target_os = "macos") {
        return discovery_path_for_platform("macos", Some(home_path()?), None, None);
    }
    if cfg!(windows) {
        let appdata = std::env::var_os("APPDATA")
            .ok_or_else(|| ToolError::new("APPDATA_NOT_FOUND", "could not resolve APPDATA"))?;
        return discovery_path_for_platform("windows", None, Some(PathBuf::from(appdata)), None);
    }
    discovery_path_for_platform(
        "linux",
        Some(home_path()?),
        None,
        std::env::var_os("XDG_DATA_HOME").map(PathBuf::from),
    )
}

fn home_path() -> Result<PathBuf, ToolError> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| ToolError::new("HOME_NOT_FOUND", "could not resolve home directory"))
}

fn discovery_path_for_platform(
    platform: &str,
    home: Option<PathBuf>,
    appdata: Option<PathBuf>,
    xdg_data_home: Option<PathBuf>,
) -> Result<PathBuf, ToolError> {
    let base = match platform {
        "macos" => home
            .ok_or_else(|| ToolError::new("HOME_NOT_FOUND", "missing home"))?
            .join("Library")
            .join("Application Support"),
        "windows" => {
            appdata.ok_or_else(|| ToolError::new("APPDATA_NOT_FOUND", "missing APPDATA"))?
        }
        _ => match xdg_data_home {
            Some(path) => path,
            None => home
                .ok_or_else(|| ToolError::new("HOME_NOT_FOUND", "missing home"))?
                .join(".local")
                .join("share"),
        },
    };
    Ok(base.join("app.svode.desktop").join("desktop-mcp.json"))
}

pub async fn desktop_request(method: &str, params: Value) -> Result<IpcResponse, ToolError> {
    let discovery = read_discovery()?;
    if discovery.host != "127.0.0.1" {
        return Err(ToolError::new(
            "DISCOVERY_INVALID",
            "Svode desktop discovery host is not loopback",
        ));
    }
    let stream = TcpStream::connect((discovery.host.as_str(), discovery.port)).await?;
    let mut stream = stream;
    let request = IpcRequest {
        token: discovery.token,
        bridge_protocol: MCP_BRIDGE_PROTOCOL.to_string(),
        method: method.to_string(),
        params,
        context: process_context_override(),
    };
    stream
        .write_all(serde_json::to_string(&request)?.as_bytes())
        .await?;
    stream.write_all(b"\n").await?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).await?;
    if line.is_empty() {
        return Err(ToolError::new(
            "DESKTOP_CLOSED",
            "Svode desktop closed the IPC connection",
        ));
    }
    Ok(serde_json::from_str(&line)?)
}

fn process_context_override() -> Option<IpcContextOverride> {
    let project_path = std::env::var(MCP_PROJECT_PATH_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let caller_cwd = std::env::current_dir()
        .ok()
        .map(|path| path.to_string_lossy().to_string())
        .filter(|value| !value.is_empty());
    let routine_caller_token = std::env::var(MCP_ROUTINE_CALLER_TOKEN_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    context_override(project_path, caller_cwd, routine_caller_token)
}

fn context_override(
    project_path: Option<String>,
    caller_cwd: Option<String>,
    routine_caller_token: Option<String>,
) -> Option<IpcContextOverride> {
    if project_path.is_none() && caller_cwd.is_none() && routine_caller_token.is_none() {
        return None;
    }

    Some(IpcContextOverride {
        project_path,
        caller_cwd,
        routine_caller_token,
    })
}

pub fn discovery_exists() -> bool {
    read_discovery_path().is_some_and(|path| path.exists())
}

/// The desktop bridge as a doctor report of the connection manager shows it.
pub async fn probe() -> svode_connect::BridgeProbe {
    svode_connect::BridgeProbe {
        protocol: MCP_BRIDGE_PROTOCOL.to_string(),
        discovery_file: read_discovery_path()
            .or_else(|| default_discovery_path().ok())
            .map(|path| path.to_string_lossy().to_string()),
        discovery_present: discovery_exists(),
        desktop_reachable: desktop_reachable().await,
    }
}

/// Upper bound of probing the desktop app; a live one answers at once.
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// Whether a compatible desktop app answers the bridge `ping`.
pub async fn desktop_reachable() -> bool {
    tokio::time::timeout(PROBE_TIMEOUT, desktop_request("ping", json!({})))
        .await
        .is_ok_and(|response| response.is_ok_and(|response| response.error.is_none()))
}

fn read_discovery() -> Result<DiscoveryFile, ToolError> {
    let path = read_discovery_path().ok_or_else(|| {
        ToolError::new(
            "DESKTOP_NOT_RUNNING",
            "Svode desktop discovery file was not found",
        )
    })?;
    let content = fs::read_to_string(path)?;
    let discovery: DiscoveryFile = serde_json::from_str(&content)?;
    if discovery.bridge_protocol != MCP_BRIDGE_PROTOCOL {
        return Err(ToolError::new(
            "BRIDGE_PROTOCOL_INCOMPATIBLE",
            "Svode desktop discovery uses an incompatible bridge protocol",
        ));
    }
    Ok(discovery)
}

fn read_discovery_path() -> Option<PathBuf> {
    if let Ok(path) = std::env::var(MCP_DISCOVERY_ENV) {
        let path = PathBuf::from(path);
        if path.exists() {
            return Some(path);
        }
    }
    default_discovery_path().ok().filter(|path| path.exists())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_context_carries_routine_token_without_public_tool_arguments() {
        let context = context_override(
            Some("/project".to_string()),
            Some("/project/space".to_string()),
            Some("opaque-token".to_string()),
        )
        .unwrap();

        assert_eq!(context.project_path.as_deref(), Some("/project"));
        assert_eq!(context.caller_cwd.as_deref(), Some("/project/space"));
        assert_eq!(
            context.routine_caller_token.as_deref(),
            Some("opaque-token")
        );
    }

    #[test]
    fn discovery_paths_are_deterministic_across_supported_platforms() {
        let home = PathBuf::from("/home/test");
        assert_eq!(
            discovery_path_for_platform("macos", Some(home.clone()), None, None).unwrap(),
            PathBuf::from(
                "/home/test/Library/Application Support/app.svode.desktop/desktop-mcp.json"
            )
        );
        assert_eq!(
            discovery_path_for_platform(
                "windows",
                None,
                Some(PathBuf::from(r"C:\Users\test\AppData\Roaming")),
                None,
            )
            .unwrap(),
            PathBuf::from(r"C:\Users\test\AppData\Roaming")
                .join("app.svode.desktop")
                .join("desktop-mcp.json")
        );
        assert_eq!(
            discovery_path_for_platform(
                "linux",
                Some(home.clone()),
                None,
                Some(PathBuf::from("/xdg")),
            )
            .unwrap(),
            PathBuf::from("/xdg/app.svode.desktop/desktop-mcp.json")
        );
        assert_eq!(
            discovery_path_for_platform("linux", Some(home), None, None).unwrap(),
            PathBuf::from("/home/test/.local/share/app.svode.desktop/desktop-mcp.json")
        );
    }
}

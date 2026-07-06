use std::fs;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

use super::MCP_VERSION;
use super::error::McpBusinessError;
use super::protocol::{IpcContextOverride, IpcRequest, IpcResponse};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryFile {
    pub host: String,
    pub port: u16,
    pub token: String,
    pub pid: u32,
    pub version: String,
}

pub fn discovery_path_for_app(app: &AppHandle) -> Result<PathBuf, McpBusinessError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| McpBusinessError::new("APP_DIR_ERROR", error.to_string()))?;
    Ok(dir.join("desktop-mcp.json"))
}

pub fn default_discovery_path() -> Result<PathBuf, McpBusinessError> {
    if cfg!(target_os = "macos") {
        let home = home_dir()?;
        return Ok(home
            .join("Library")
            .join("Application Support")
            .join("app.svode.desktop")
            .join("desktop-mcp.json"));
    }
    if cfg!(windows) {
        let appdata = std::env::var_os("APPDATA").ok_or_else(|| {
            McpBusinessError::new("APPDATA_NOT_FOUND", "could not resolve APPDATA")
        })?;
        return Ok(PathBuf::from(appdata)
            .join("app.svode.desktop")
            .join("desktop-mcp.json"));
    }
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or(home_dir()?.join(".local").join("share"));
    Ok(base.join("app.svode.desktop").join("desktop-mcp.json"))
}

fn home_dir() -> Result<PathBuf, McpBusinessError> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| McpBusinessError::new("HOME_NOT_FOUND", "could not resolve home directory"))
}

pub async fn start_desktop_ipc(app: AppHandle) -> Result<(), McpBusinessError> {
    let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0)).await?;
    let port = listener.local_addr()?.port();
    let token = ulid::Ulid::new().to_string().to_lowercase();
    let discovery = DiscoveryFile {
        host: "127.0.0.1".to_string(),
        port,
        token: token.clone(),
        pid: std::process::id(),
        version: MCP_VERSION.to_string(),
    };
    write_discovery_file(&app, &discovery)?;
    tauri::async_runtime::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let app = app.clone();
                    let token = token.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(error) = handle_connection(app, stream, token).await {
                            tracing::warn!("mcp ipc connection failed: {}", error.message);
                        }
                    });
                }
                Err(error) => {
                    tracing::warn!("mcp ipc accept failed: {error}");
                    break;
                }
            }
        }
    });
    Ok(())
}

fn write_discovery_file(
    app: &AppHandle,
    discovery: &DiscoveryFile,
) -> Result<(), McpBusinessError> {
    let path = discovery_path_for_app(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(discovery)?;
    write_user_only(&path, &bytes)?;
    Ok(())
}

#[cfg(unix)]
fn write_user_only(path: &PathBuf, bytes: &[u8]) -> Result<(), McpBusinessError> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(true).write(true).mode(0o600);
    use std::io::Write;
    let mut file = options.open(path)?;
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    file.write_all(bytes)?;
    Ok(())
}

#[cfg(not(unix))]
fn write_user_only(path: &PathBuf, bytes: &[u8]) -> Result<(), McpBusinessError> {
    fs::write(path, bytes)?;
    Ok(())
}

async fn handle_connection(
    app: AppHandle,
    stream: TcpStream,
    expected_token: String,
) -> Result<(), McpBusinessError> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).await?;
    let request: IpcRequest = serde_json::from_str(&line)?;
    let response = if request.token != expected_token {
        IpcResponse {
            result: None,
            tool_result: None,
            error: Some(McpBusinessError::new(
                "AUTH_FAILED",
                "invalid Svode desktop IPC token",
            )),
        }
    } else {
        dispatch(app, request).await
    };
    let mut stream = reader.into_inner();
    stream
        .write_all(serde_json::to_string(&response)?.as_bytes())
        .await?;
    stream.write_all(b"\n").await?;
    Ok(())
}

async fn dispatch(app: AppHandle, request: IpcRequest) -> IpcResponse {
    match request.method.as_str() {
        "tools/list" => IpcResponse {
            result: Some(json!({ "tools": super::tools::definitions() })),
            tool_result: None,
            error: None,
        },
        "tools/call" => {
            let Some(name) = request.params.get("name").and_then(Value::as_str) else {
                return IpcResponse {
                    result: None,
                    tool_result: None,
                    error: Some(McpBusinessError::new(
                        "INVALID_REQUEST",
                        "tools/call requires name",
                    )),
                };
            };
            let args = request
                .params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let tool_result =
                super::service::call_tool_with_context(app, name, args, request.context).await;
            IpcResponse {
                result: None,
                tool_result: Some(tool_result),
                error: None,
            }
        }
        "ping" => IpcResponse {
            result: Some(json!({ "ok": true })),
            tool_result: None,
            error: None,
        },
        _ => IpcResponse {
            result: None,
            tool_result: None,
            error: Some(McpBusinessError::new(
                "UNKNOWN_METHOD",
                "unknown desktop IPC method",
            )),
        },
    }
}

pub async fn desktop_request(method: &str, params: Value) -> Result<IpcResponse, McpBusinessError> {
    let discovery = read_discovery()?;
    if discovery.host != "127.0.0.1" {
        return Err(McpBusinessError::new(
            "DISCOVERY_INVALID",
            "Svode desktop discovery host is not loopback",
        ));
    }
    let stream = TcpStream::connect((discovery.host.as_str(), discovery.port)).await?;
    let mut stream = stream;
    let request = IpcRequest {
        token: discovery.token,
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
        return Err(McpBusinessError::new(
            "DESKTOP_CLOSED",
            "Svode desktop closed the IPC connection",
        ));
    }
    Ok(serde_json::from_str(&line)?)
}

fn process_context_override() -> Option<IpcContextOverride> {
    let project_path = std::env::var(super::MCP_PROJECT_PATH_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let caller_cwd = std::env::current_dir()
        .ok()
        .map(|path| path.to_string_lossy().to_string())
        .filter(|value| !value.is_empty());

    if project_path.is_none() && caller_cwd.is_none() {
        return None;
    }

    Some(IpcContextOverride {
        project_path,
        caller_cwd,
    })
}

pub fn discovery_exists() -> bool {
    read_discovery_path().is_some_and(|path| path.exists())
}

pub async fn desktop_reachable() -> bool {
    desktop_request("ping", json!({}))
        .await
        .map(|response| response.error.is_none())
        .unwrap_or(false)
}

fn read_discovery() -> Result<DiscoveryFile, McpBusinessError> {
    let path = read_discovery_path().ok_or_else(|| {
        McpBusinessError::new(
            "DESKTOP_NOT_RUNNING",
            "Svode desktop discovery file was not found",
        )
    })?;
    let content = fs::read_to_string(path)?;
    Ok(serde_json::from_str(&content)?)
}

fn read_discovery_path() -> Option<PathBuf> {
    if let Ok(path) = std::env::var(super::MCP_DISCOVERY_ENV) {
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

    #[cfg(unix)]
    #[test]
    fn write_user_only_resets_existing_file_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("desktop-mcp.json");
        fs::write(&path, "{}").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

        write_user_only(&path, br#"{"ok":true}"#).unwrap();

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert_eq!(fs::read(&path).unwrap(), br#"{"ok":true}"#);
    }
}

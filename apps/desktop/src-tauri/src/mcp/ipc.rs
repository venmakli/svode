use std::fs;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;

use svode_mcp::MCP_BRIDGE_PROTOCOL;
use svode_mcp::control::{BridgeCall, bridge_request};
use svode_mcp::protocol::{DiscoveryFile, IpcRequest, IpcResponse};
use svode_tools::error::ToolError;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

pub fn discovery_path_for_app(app: &AppHandle) -> Result<PathBuf, ToolError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| ToolError::new("APP_DIR_ERROR", error.to_string()))?;
    Ok(dir.join("desktop-mcp.json"))
}

pub async fn start_desktop_ipc(app: AppHandle) -> Result<(), ToolError> {
    let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0)).await?;
    let port = listener.local_addr()?.port();
    let token = ulid::Ulid::new().to_string().to_lowercase();
    let discovery = DiscoveryFile {
        host: "127.0.0.1".to_string(),
        port,
        token: token.clone(),
        pid: std::process::id(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        bridge_protocol: MCP_BRIDGE_PROTOCOL.to_string(),
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

fn write_discovery_file(app: &AppHandle, discovery: &DiscoveryFile) -> Result<(), ToolError> {
    let path = discovery_path_for_app(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(discovery)?;
    write_user_only(&path, &bytes)?;
    Ok(())
}

#[cfg(unix)]
fn write_user_only(path: &PathBuf, bytes: &[u8]) -> Result<(), ToolError> {
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
fn write_user_only(path: &PathBuf, bytes: &[u8]) -> Result<(), ToolError> {
    fs::write(path, bytes)?;
    Ok(())
}

async fn handle_connection(
    app: AppHandle,
    stream: TcpStream,
    expected_token: String,
) -> Result<(), ToolError> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).await?;
    let request: IpcRequest = serde_json::from_str(&line)?;
    let response = if request.token != expected_token {
        IpcResponse {
            result: None,
            tool_result: None,
            error: Some(ToolError::new(
                "AUTH_FAILED",
                "invalid Svode desktop IPC token",
            )),
        }
    } else if request.bridge_protocol != MCP_BRIDGE_PROTOCOL {
        IpcResponse {
            result: None,
            tool_result: None,
            error: Some(ToolError::new(
                "BRIDGE_PROTOCOL_INCOMPATIBLE",
                "svode-mcp bridge protocol is not compatible with this Svode desktop",
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
    let host = super::service::DesktopMcpHost::new(app.clone());
    match bridge_request(&host, &request.method, &request.params) {
        BridgeCall::Respond(response) => response,
        BridgeCall::CallTool { name, args } => IpcResponse {
            result: None,
            tool_result: Some(
                super::service::call_tool_with_context(app, &name, args, request.context).await,
            ),
            error: None,
        },
    }
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

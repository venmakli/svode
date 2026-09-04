use std::collections::HashMap;
use std::fs;
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Semaphore, oneshot};
use tokio::time::timeout;
use ulid::Ulid;

use crate::repo_path::{RootMode, normalize_repo_relative};

const MAX_REQUEST_HEAD_BYTES: usize = 16 * 1024;
const MAX_CONNECTIONS: usize = 32;
const REQUEST_HEAD_TIMEOUT: Duration = Duration::from_secs(5);

struct StaticAppServer {
    shutdown: Option<oneshot::Sender<()>>,
}

pub(crate) struct AppSourceState {
    servers: Mutex<HashMap<String, StaticAppServer>>,
}

impl AppSourceState {
    pub(crate) fn new() -> Self {
        Self {
            servers: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) async fn issue(
        &self,
        public_root: PathBuf,
        entry: &str,
    ) -> std::io::Result<(String, String)> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let address = listener.local_addr()?;
        let token = format!("{}{}", Ulid::new(), Ulid::new()).to_ascii_lowercase();
        let (shutdown, shutdown_rx) = oneshot::channel();
        self.servers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(
                token.clone(),
                StaticAppServer {
                    shutdown: Some(shutdown),
                },
            );

        let entry = entry.to_string();
        let mut url = tauri::Url::parse(&format!("http://{address}/"))
            .map_err(|error| std::io::Error::other(error.to_string()))?;
        url.set_path(&entry);
        let viewport_url = url.to_string();
        tauri::async_runtime::spawn(async move {
            run_server(listener, public_root, entry, shutdown_rx).await;
        });

        Ok((token, viewport_url))
    }

    pub(crate) fn revoke(&self, token: &str) {
        if let Some(mut server) = self
            .servers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(token)
        {
            if let Some(shutdown) = server.shutdown.take() {
                let _ = shutdown.send(());
            }
        }
    }

    #[cfg(test)]
    fn contains(&self, token: &str) -> bool {
        self.servers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .contains_key(token)
    }
}

impl Drop for AppSourceState {
    fn drop(&mut self) {
        let servers = self
            .servers
            .get_mut()
            .unwrap_or_else(|error| error.into_inner());
        for (_, mut server) in servers.drain() {
            if let Some(shutdown) = server.shutdown.take() {
                let _ = shutdown.send(());
            }
        }
    }
}

async fn run_server(
    listener: TcpListener,
    public_root: PathBuf,
    entry: String,
    mut shutdown: oneshot::Receiver<()>,
) {
    let public_root = Arc::new(public_root);
    let entry = Arc::new(entry);
    let connections = Arc::new(Semaphore::new(MAX_CONNECTIONS));

    loop {
        tokio::select! {
            _ = &mut shutdown => break,
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { break };
                let Ok(permit) = connections.clone().try_acquire_owned() else {
                    drop(stream);
                    continue;
                };
                let public_root = Arc::clone(&public_root);
                let entry = Arc::clone(&entry);
                tauri::async_runtime::spawn(async move {
                    let _permit = permit;
                    let _ = serve_connection(stream, &public_root, &entry).await;
                });
            }
        }
    }
}

async fn serve_connection(
    mut stream: TcpStream,
    public_root: &Path,
    entry: &str,
) -> std::io::Result<()> {
    let request = match timeout(REQUEST_HEAD_TIMEOUT, read_request(&mut stream)).await {
        Ok(Ok(request)) => request,
        Ok(Err(failure)) => return write_failure(&mut stream, failure).await,
        Err(_) => return write_failure(&mut stream, HttpFailure::RequestTimeout).await,
    };
    let source = match resolve_source(public_root, entry, &request.target) {
        Ok(source) => source,
        Err(failure) => return write_failure(&mut stream, failure).await,
    };
    let metadata = match fs::metadata(&source) {
        Ok(metadata) if metadata.is_file() => metadata,
        _ => return write_failure(&mut stream, HttpFailure::NotFound).await,
    };
    let header = success_header(metadata.len(), mime_type(&source));
    stream.write_all(header.as_bytes()).await?;
    if request.method == RequestMethod::Get {
        let mut file = tokio::fs::File::open(source).await?;
        tokio::io::copy(&mut file, &mut stream).await?;
    }
    stream.shutdown().await
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RequestMethod {
    Get,
    Head,
}

struct StaticRequest {
    method: RequestMethod,
    target: String,
}

async fn read_request(stream: &mut TcpStream) -> Result<StaticRequest, HttpFailure> {
    let mut request = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 1024];
    loop {
        let read = stream
            .read(&mut chunk)
            .await
            .map_err(|_| HttpFailure::BadRequest)?;
        if read == 0 {
            return Err(HttpFailure::BadRequest);
        }
        request.extend_from_slice(&chunk[..read]);
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        if request.len() > MAX_REQUEST_HEAD_BYTES {
            return Err(HttpFailure::HeaderTooLarge);
        }
    }
    if request.len() > MAX_REQUEST_HEAD_BYTES {
        return Err(HttpFailure::HeaderTooLarge);
    }

    let head = std::str::from_utf8(&request).map_err(|_| HttpFailure::BadRequest)?;
    let mut parts = head
        .lines()
        .next()
        .ok_or(HttpFailure::BadRequest)?
        .split_ascii_whitespace();
    let method = match parts.next() {
        Some("GET") => RequestMethod::Get,
        Some("HEAD") => RequestMethod::Head,
        Some(_) => return Err(HttpFailure::MethodNotAllowed),
        None => return Err(HttpFailure::BadRequest),
    };
    let target = parts.next().ok_or(HttpFailure::BadRequest)?;
    let version = parts.next().ok_or(HttpFailure::BadRequest)?;
    if parts.next().is_some() || !matches!(version, "HTTP/1.0" | "HTTP/1.1") {
        return Err(HttpFailure::BadRequest);
    }
    Ok(StaticRequest {
        method,
        target: target.to_string(),
    })
}

fn resolve_source(public_root: &Path, entry: &str, target: &str) -> Result<PathBuf, HttpFailure> {
    let encoded_path = target
        .split_once('?')
        .map_or(target, |(path, _)| path)
        .strip_prefix('/')
        .ok_or(HttpFailure::BadRequest)?;
    let decoded = percent_decode(encoded_path).ok_or(HttpFailure::BadRequest)?;
    let requested_path = if decoded.is_empty() { entry } else { &decoded };
    let relative = normalize_repo_relative(requested_path, RootMode::Reject)
        .map_err(|_| HttpFailure::BadRequest)?;
    let requested = public_root.join(relative);
    let metadata = fs::symlink_metadata(&requested).map_err(|_| HttpFailure::NotFound)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(HttpFailure::NotFound);
    }
    let canonical = fs::canonicalize(requested).map_err(|_| HttpFailure::NotFound)?;
    if !canonical.starts_with(public_root) {
        return Err(HttpFailure::BadRequest);
    }
    Ok(canonical)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HttpFailure {
    BadRequest,
    NotFound,
    MethodNotAllowed,
    HeaderTooLarge,
    RequestTimeout,
}

async fn write_failure(stream: &mut TcpStream, failure: HttpFailure) -> std::io::Result<()> {
    let (status, message) = match failure {
        HttpFailure::BadRequest => ("400 Bad Request", "Bad Request"),
        HttpFailure::NotFound => ("404 Not Found", "Not Found"),
        HttpFailure::MethodNotAllowed => ("405 Method Not Allowed", "Method Not Allowed"),
        HttpFailure::HeaderTooLarge => (
            "431 Request Header Fields Too Large",
            "Request Header Fields Too Large",
        ),
        HttpFailure::RequestTimeout => ("408 Request Timeout", "Request Timeout"),
    };
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n{message}",
        message.len()
    );
    stream.write_all(response.as_bytes()).await?;
    stream.shutdown().await
}

fn success_header(content_length: u64, mime_type: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {mime_type}\r\nContent-Length: {content_length}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'self' data: blob: http: https:; script-src 'self' 'unsafe-inline' 'unsafe-eval' http: https:; style-src 'self' 'unsafe-inline' http: https:; connect-src 'self' http: https: ws: wss:; img-src 'self' data: blob: http: https:; font-src 'self' data: http: https:; media-src 'self' blob: http: https:; worker-src 'self' blob:; frame-src http: https:; object-src 'none'; base-uri 'self'\r\nConnection: close\r\n\r\n"
    )
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            decoded.push(bytes[index]);
            index += 1;
            continue;
        }
        let high = *bytes.get(index + 1)?;
        let low = *bytes.get(index + 2)?;
        decoded.push((hex(high)? << 4) | hex(low)?);
        index += 3;
    }
    String::from_utf8(decoded).ok()
}

fn hex(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn mime_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("json" | "map") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("wasm") => "application/wasm",
        Some("xml") => "application/xml",
        Some("txt") => "text/plain; charset=utf-8",
        Some("mp3") => "audio/mpeg",
        Some("mp4") => "video/mp4",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_resolution_is_contained_and_rejects_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("public");
        fs::create_dir_all(root.join("assets")).unwrap();
        fs::write(root.join("index.html"), "index").unwrap();
        fs::write(root.join("assets/main.js"), "export {};").unwrap();
        fs::write(temp.path().join("secret.txt"), "secret").unwrap();
        let root = fs::canonicalize(root).unwrap();

        assert_eq!(
            resolve_source(&root, "index.html", "/").unwrap(),
            root.join("index.html")
        );
        assert_eq!(
            resolve_source(&root, "index.html", "/assets/main.js?v=1").unwrap(),
            root.join("assets/main.js")
        );
        assert!(matches!(
            resolve_source(&root, "index.html", "/%2e%2e/secret.txt"),
            Err(HttpFailure::BadRequest)
        ));

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(temp.path().join("secret.txt"), root.join("linked.txt"))
                .unwrap();
            assert!(matches!(
                resolve_source(&root, "index.html", "/linked.txt"),
                Err(HttpFailure::NotFound)
            ));
        }
    }

    #[test]
    fn percent_decoder_rejects_malformed_and_non_utf8_paths() {
        assert_eq!(
            percent_decode("assets/main%20file.js").as_deref(),
            Some("assets/main file.js")
        );
        assert!(percent_decode("%ZZ").is_none());
        assert!(percent_decode("%FF").is_none());
    }

    #[test]
    fn server_capability_has_explicit_lifecycle() {
        let state = AppSourceState::new();
        let token = "test-capability".to_string();
        let (shutdown, mut shutdown_rx) = oneshot::channel();
        state.servers.lock().unwrap().insert(
            token.clone(),
            StaticAppServer {
                shutdown: Some(shutdown),
            },
        );
        assert!(state.contains(&token));
        state.revoke(&token);
        assert!(!state.contains(&token));
        assert!(matches!(
            shutdown_rx.try_recv(),
            Ok(()) | Err(oneshot::error::TryRecvError::Closed)
        ));
    }
}

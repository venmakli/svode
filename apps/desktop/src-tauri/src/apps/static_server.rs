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

/// A file of a served static source changed; the payload names its token.
pub(crate) const APP_SOURCE_CHANGED_EVENT: &str = "app:source-changed";

const MAX_REQUEST_HEAD_BYTES: usize = 16 * 1024;
const MAX_CONNECTIONS: usize = 32;
const REQUEST_HEAD_TIMEOUT: Duration = Duration::from_secs(5);

struct StaticAppServer {
    shutdown: Option<oneshot::Sender<()>>,
    public_root: PathBuf,
    manifest: PathBuf,
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

    /// `public_root` is canonical; `manifest` is the owner's `app.yaml`,
    /// which its own inspection handles even inside `public_root`.
    pub(crate) async fn issue(
        &self,
        public_root: PathBuf,
        manifest: PathBuf,
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
                    public_root: public_root.clone(),
                    manifest,
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

    pub(crate) fn is_serving(&self) -> bool {
        !self
            .servers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .is_empty()
    }

    /// Tokens of the served sources whose files a change of `path` may
    /// alter: a regular file inside the canonical public root, or a path
    /// that is gone and was not a directory. Git ignore plays no part; Git
    /// metadata and the manifest are not App source.
    pub(crate) fn sources_changed_by(&self, path: &Path, removed_directory: bool) -> Vec<String> {
        let servers = self
            .servers
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        servers
            .iter()
            .filter(|(_, server)| {
                is_source_change(
                    &server.public_root,
                    &server.manifest,
                    path,
                    removed_directory,
                )
            })
            .map(|(token, _)| token.clone())
            .collect()
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

fn is_source_change(
    public_root: &Path,
    manifest: &Path,
    path: &Path,
    removed_directory: bool,
) -> bool {
    let Ok(relative) = path.strip_prefix(public_root) else {
        return false;
    };
    if relative.as_os_str().is_empty()
        || path == manifest
        || relative.components().any(|part| part.as_os_str() == ".git")
    {
        return false;
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) => metadata.is_file(),
        Err(_) => !removed_directory,
    }
}

async fn run_server(
    listener: TcpListener,
    public_root: PathBuf,
    entry: String,
    mut shutdown: oneshot::Receiver<()>,
) {
    // DNS rebinding guard: only the authority this source is served at.
    let Ok(authority) = listener.local_addr().map(|address| address.to_string()) else {
        return;
    };
    let authority = Arc::new(authority);
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
                let authority = Arc::clone(&authority);
                tauri::async_runtime::spawn(async move {
                    let _permit = permit;
                    let _ = serve_connection(stream, &authority, &public_root, &entry).await;
                });
            }
        }
    }
}

async fn serve_connection(
    mut stream: TcpStream,
    authority: &str,
    public_root: &Path,
    entry: &str,
) -> std::io::Result<()> {
    let request = match timeout(REQUEST_HEAD_TIMEOUT, read_request(&mut stream)).await {
        Ok(Ok(request)) => request,
        Ok(Err(failure)) => return write_failure(&mut stream, failure).await,
        Err(_) => return write_failure(&mut stream, HttpFailure::RequestTimeout).await,
    };
    match request.host.as_deref() {
        Some(host) if host == authority => {}
        Some(_) => return write_failure(&mut stream, HttpFailure::MisdirectedRequest).await,
        None => return write_failure(&mut stream, HttpFailure::BadRequest).await,
    }
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
    host: Option<String>,
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
    let mut lines = head.lines();
    let mut parts = lines
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
    let mut host = None;
    for line in lines.take_while(|line| !line.is_empty()) {
        let Some((name, value)) = line.split_once(':') else {
            return Err(HttpFailure::BadRequest);
        };
        if name.eq_ignore_ascii_case("host")
            && host
                .replace(value.trim_matches([' ', '\t']).to_string())
                .is_some()
        {
            return Err(HttpFailure::BadRequest);
        }
    }
    Ok(StaticRequest {
        method,
        target: target.to_string(),
        host,
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
    MisdirectedRequest,
    HeaderTooLarge,
    RequestTimeout,
}

async fn write_failure(stream: &mut TcpStream, failure: HttpFailure) -> std::io::Result<()> {
    let (status, message) = match failure {
        HttpFailure::BadRequest => ("400 Bad Request", "Bad Request"),
        HttpFailure::NotFound => ("404 Not Found", "Not Found"),
        HttpFailure::MethodNotAllowed => ("405 Method Not Allowed", "Method Not Allowed"),
        HttpFailure::MisdirectedRequest => ("421 Misdirected Request", "Misdirected Request"),
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

    async fn exchange(port: u16, head: &str) -> String {
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port))
            .await
            .unwrap();
        stream.write_all(head.as_bytes()).await.unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        response
    }

    fn request(path: &str, host: Option<&str>) -> String {
        let host = host.map_or(String::new(), |host| format!("Host: {host}\r\n"));
        format!("GET {path} HTTP/1.1\r\n{host}Accept: */*\r\n\r\n")
    }

    fn status(response: &str) -> &str {
        response.lines().next().unwrap_or_default()
    }

    #[test]
    fn server_answers_only_the_host_of_its_own_address() {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap().join("public");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("index.html"), "entry").unwrap();
        fs::write(temp.path().join("secret.txt"), "secret").unwrap();
        let state = AppSourceState::new();

        tauri::async_runtime::block_on(async {
            let (token, url) = state
                .issue(root.clone(), temp.path().join("app.yaml"), "index.html")
                .await
                .unwrap();
            let port = tauri::Url::parse(&url).unwrap().port().unwrap();
            let own = format!("127.0.0.1:{port}");
            let other_port = format!("127.0.0.1:{}", port.checked_add(1).unwrap_or(port - 1));

            let served = exchange(port, &request("/", Some(&own))).await;
            assert_eq!(status(&served), "HTTP/1.1 200 OK");
            assert!(served.ends_with("\r\n\r\nentry"));
            let head = exchange(port, &request("/", Some(&own)).replacen("GET", "HEAD", 1)).await;
            assert_eq!(status(&head), "HTTP/1.1 200 OK");
            assert!(head.ends_with("\r\n\r\n"));
            // Header names are case-insensitive and the value may carry spaces.
            let lowercase =
                exchange(port, &format!("GET / HTTP/1.1\r\nhost:  {own} \r\n\r\n")).await;
            assert_eq!(status(&lowercase), "HTTP/1.1 200 OK");

            for host in [
                format!("localhost:{port}"),
                "example.com".to_string(),
                format!("example.com:{port}"),
                other_port,
                "127.0.0.1".to_string(),
            ] {
                // A refused host learns nothing about the path: the missing
                // file, the escape and the served entry all get the same 421.
                for path in ["/", "/index.html", "/missing.html", "/%2e%2e/secret.txt"] {
                    let refused = exchange(port, &request(path, Some(&host))).await;
                    assert_eq!(
                        status(&refused),
                        "HTTP/1.1 421 Misdirected Request",
                        "{host} {path}"
                    );
                    assert!(!refused.contains("entry") && !refused.contains("secret"));
                }
            }
            for path in ["/", "/missing.html", "/%2e%2e/secret.txt"] {
                let missing = exchange(port, &request(path, None)).await;
                assert_eq!(status(&missing), "HTTP/1.1 400 Bad Request", "{path}");
                assert!(!missing.contains("entry"));
            }
            let duplicate = exchange(
                port,
                &format!("GET / HTTP/1.1\r\nHost: {own}\r\nHost: {own}\r\n\r\n"),
            )
            .await;
            assert_eq!(status(&duplicate), "HTTP/1.1 400 Bad Request");

            state.revoke(&token);
        });
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

    fn observe(state: &AppSourceState, token: &str, public_root: &Path, manifest: &Path) {
        state.servers.lock().unwrap().insert(
            token.to_string(),
            StaticAppServer {
                shutdown: None,
                public_root: public_root.to_path_buf(),
                manifest: manifest.to_path_buf(),
            },
        );
    }

    #[test]
    fn source_changes_are_regular_files_inside_the_public_root() {
        let temp = tempfile::tempdir().unwrap();
        let owner = fs::canonicalize(temp.path()).unwrap();
        let root = owner.join("graphify-out");
        fs::create_dir_all(root.join("data/nested")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(owner.join(".gitignore"), "graphify-out/\n").unwrap();
        fs::write(owner.join("app.yaml"), "runtime: static").unwrap();
        fs::write(owner.join("notes.md"), "outside").unwrap();
        fs::write(root.join("graph.html"), "entry").unwrap();
        fs::write(root.join("data/nested/graph.json"), "{}").unwrap();
        fs::write(root.join(".git/HEAD"), "ref").unwrap();
        let state = AppSourceState::new();
        assert!(!state.is_serving());
        observe(&state, "graph", &root, &owner.join("app.yaml"));
        assert!(state.is_serving());

        // Git ignore does not hide the files the App serves.
        assert_eq!(
            state.sources_changed_by(&root.join("graph.html"), false),
            ["graph"]
        );
        assert_eq!(
            state.sources_changed_by(&root.join("data/nested/graph.json"), false),
            ["graph"]
        );
        // A removed file is gone and still a change; a removed directory is not.
        assert_eq!(
            state.sources_changed_by(&root.join("old.json"), false),
            ["graph"]
        );
        assert!(state.sources_changed_by(&root.join("old"), true).is_empty());
        assert!(
            state
                .sources_changed_by(&root.join("data"), false)
                .is_empty()
        );
        assert!(state.sources_changed_by(&root, false).is_empty());
        assert!(
            state
                .sources_changed_by(&root.join(".git/HEAD"), false)
                .is_empty()
        );
        assert!(
            state
                .sources_changed_by(&owner.join("notes.md"), false)
                .is_empty()
        );
        assert!(
            state
                .sources_changed_by(&owner.join("app.yaml"), false)
                .is_empty()
        );
        assert!(
            state
                .sources_changed_by(&owner.join("graphify-out-old/graph.html"), false)
                .is_empty()
        );
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(owner.join("notes.md"), root.join("linked.md")).unwrap();
            assert!(
                state
                    .sources_changed_by(&root.join("linked.md"), false)
                    .is_empty()
            );
        }

        state.revoke("graph");
        assert!(!state.is_serving());
        assert!(
            state
                .sources_changed_by(&root.join("graph.html"), false)
                .is_empty()
        );
    }

    #[test]
    fn manifest_inside_a_root_public_root_is_not_a_source_change() {
        let temp = tempfile::tempdir().unwrap();
        let owner = fs::canonicalize(temp.path()).unwrap();
        let nested = owner.join("dashboard");
        fs::create_dir_all(&nested).unwrap();
        for directory in [&owner, &nested] {
            fs::write(directory.join("app.yaml"), "runtime: static").unwrap();
            fs::write(directory.join("index.html"), "entry").unwrap();
        }
        let state = AppSourceState::new();
        observe(&state, "space", &owner, &owner.join("app.yaml"));
        observe(&state, "dashboard", &nested, &nested.join("app.yaml"));

        assert!(
            state
                .sources_changed_by(&owner.join("app.yaml"), false)
                .is_empty()
        );
        assert_eq!(
            state.sources_changed_by(&owner.join("index.html"), false),
            ["space"]
        );
        // The nested manifest is a file the outer App serves.
        assert_eq!(
            state.sources_changed_by(&nested.join("app.yaml"), false),
            ["space"]
        );
        let mut both = state.sources_changed_by(&nested.join("index.html"), false);
        both.sort();
        assert_eq!(both, ["dashboard", "space"]);
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
                public_root: PathBuf::from("/public"),
                manifest: PathBuf::from("/app.yaml"),
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

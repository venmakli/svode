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

use crate::document::html::{
    HTML_DOCUMENT_LIMIT, HtmlTheme, has_hidden_component, is_document_change, render_entry,
};
use crate::repo_path::{RootMode, normalize_repo_relative};

/// A file of a served static source changed; the payload names its token.
pub(crate) const APP_SOURCE_CHANGED_EVENT: &str = "app:source-changed";
/// A file of a served HTML Document root changed; the payload names its token.
pub(crate) const DOCUMENT_SOURCE_CHANGED_EVENT: &str = "document:html-source-changed";

const MAX_REQUEST_HEAD_BYTES: usize = 16 * 1024;
const MAX_CONNECTIONS: usize = 32;
const REQUEST_HEAD_TIMEOUT: Duration = Duration::from_secs(5);

struct ServedSource {
    shutdown: Option<oneshot::Sender<()>>,
    /// Canonical.
    root: PathBuf,
    kind: SourceKind,
}

enum SourceKind {
    App {
        manifest: PathBuf,
    },
    Document {
        profile: Arc<DocumentProfile>,
        /// The observation of a root outside the project; a root inside a
        /// Space reports through the Space watcher.
        observer: Option<notify::RecommendedWatcher>,
    },
}

/// How an HTML Document root is answered (Stage 11 `06` A2).
pub(crate) struct DocumentProfile {
    /// The canonical entry file.
    pub entry: PathBuf,
    /// The root is wide: only the entry file is served.
    pub single_file: bool,
    theme: Mutex<HtmlTheme>,
}

impl DocumentProfile {
    pub(crate) fn new(entry: PathBuf, single_file: bool, theme: HtmlTheme) -> Self {
        Self {
            entry,
            single_file,
            theme: Mutex::new(theme),
        }
    }

    fn theme(&self) -> HtmlTheme {
        *self.theme.lock().unwrap_or_else(|error| error.into_inner())
    }
}

enum ServeProfile {
    App { entry: String },
    Document(Arc<DocumentProfile>),
}

pub(crate) struct AppSourceState {
    servers: Mutex<HashMap<String, ServedSource>>,
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
        self.serve(
            public_root,
            SourceKind::App { manifest },
            ServeProfile::App {
                entry: entry.to_string(),
            },
            entry,
        )
        .await
    }

    /// Serves an HTML Document from its canonical `root`; the entry file is
    /// a direct child of it.
    pub(crate) async fn issue_document(
        &self,
        root: PathBuf,
        profile: DocumentProfile,
    ) -> std::io::Result<(String, String)> {
        let entry_name = profile
            .entry
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .ok_or_else(|| std::io::Error::other("the entry file has no name"))?;
        let profile = Arc::new(profile);
        self.serve(
            root,
            SourceKind::Document {
                profile: Arc::clone(&profile),
                observer: None,
            },
            ServeProfile::Document(profile),
            &entry_name,
        )
        .await
    }

    async fn serve(
        &self,
        root: PathBuf,
        kind: SourceKind,
        profile: ServeProfile,
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
                ServedSource {
                    shutdown: Some(shutdown),
                    root: root.clone(),
                    kind,
                },
            );

        let mut url = tauri::Url::parse(&format!("http://{address}/"))
            .map_err(|error| std::io::Error::other(error.to_string()))?;
        url.set_path(entry);
        let viewport_url = url.to_string();
        tauri::async_runtime::spawn(async move {
            run_server(listener, root, profile, shutdown_rx).await;
        });

        Ok((token, viewport_url))
    }

    /// Keeps `observer` for as long as the Document `token` is served; its
    /// changes no longer come from a Space watcher.
    pub(crate) fn observe_document(&self, token: &str, observer: notify::RecommendedWatcher) {
        if let Some(ServedSource {
            kind: SourceKind::Document { observer: slot, .. },
            ..
        }) = self
            .servers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get_mut(token)
        {
            *slot = Some(observer);
        }
    }

    /// The theme the entry of the Document `token` is answered with.
    pub(crate) fn set_document_theme(&self, token: &str, theme: HtmlTheme) {
        let servers = self
            .servers
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let Some(ServedSource {
            kind: SourceKind::Document { profile, .. },
            ..
        }) = servers.get(token)
        else {
            return;
        };
        *profile
            .theme
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = theme;
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
            .filter(|(_, server)| match &server.kind {
                SourceKind::App { manifest } => {
                    is_source_change(&server.root, manifest, path, removed_directory)
                }
                SourceKind::Document { .. } => false,
            })
            .map(|(token, _)| token.clone())
            .collect()
    }

    /// Tokens of the HTML Documents inside a Space whose root a change of
    /// `path` alters.
    pub(crate) fn documents_changed_by(&self, path: &Path, removed_directory: bool) -> Vec<String> {
        let servers = self
            .servers
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        servers
            .iter()
            .filter(|(_, server)| match &server.kind {
                SourceKind::Document {
                    profile,
                    observer: None,
                } => is_document_change(
                    &server.root,
                    &profile.entry,
                    profile.single_file,
                    path,
                    removed_directory,
                ),
                _ => false,
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
    root: PathBuf,
    profile: ServeProfile,
    mut shutdown: oneshot::Receiver<()>,
) {
    // DNS rebinding guard: only the authority this source is served at.
    let Ok(authority) = listener.local_addr().map(|address| address.to_string()) else {
        return;
    };
    let authority = Arc::new(authority);
    let root = Arc::new(root);
    let profile = Arc::new(profile);
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
                let root = Arc::clone(&root);
                let profile = Arc::clone(&profile);
                let authority = Arc::clone(&authority);
                tauri::async_runtime::spawn(async move {
                    let _permit = permit;
                    let _ = serve_connection(stream, &authority, &root, &profile).await;
                });
            }
        }
    }
}

async fn serve_connection(
    mut stream: TcpStream,
    authority: &str,
    root: &Path,
    profile: &ServeProfile,
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
    let resolved = match profile {
        ServeProfile::App { entry } => resolve_source(root, entry, &request.target),
        ServeProfile::Document(profile) => {
            resolve_document_resource(root, profile, &request.target)
        }
    };
    let source = match resolved {
        Ok(source) => source,
        Err(failure) => return write_failure(&mut stream, failure).await,
    };
    if let ServeProfile::Document(profile) = profile
        && source == profile.entry
    {
        let Ok(bytes) = read_document_entry(&source).await else {
            return write_failure(&mut stream, HttpFailure::NotFound).await;
        };
        let rendered = render_entry(&bytes, profile.theme());
        let header = success_header(
            rendered.body.len() as u64,
            &format!("text/html; charset={}", rendered.charset),
        );
        stream.write_all(header.as_bytes()).await?;
        if request.method == RequestMethod::Get {
            stream.write_all(&rendered.body).await?;
        }
        return stream.shutdown().await;
    }
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

/// The entry file within the HTML Document limit.
async fn read_document_entry(path: &Path) -> std::io::Result<Vec<u8>> {
    let file = tokio::fs::File::open(path).await?;
    let mut bytes = Vec::new();
    file.take(HTML_DOCUMENT_LIMIT + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() as u64 > HTML_DOCUMENT_LIMIT {
        return Err(std::io::Error::other("the entry file exceeds the limit"));
    }
    Ok(bytes)
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

/// The decoded path of a request target without its leading slash.
fn request_path(target: &str) -> Result<String, HttpFailure> {
    let encoded_path = target
        .split_once('?')
        .map_or(target, |(path, _)| path)
        .strip_prefix('/')
        .ok_or(HttpFailure::BadRequest)?;
    percent_decode(encoded_path).ok_or(HttpFailure::BadRequest)
}

fn resolve_source(public_root: &Path, entry: &str, target: &str) -> Result<PathBuf, HttpFailure> {
    let decoded = request_path(target)?;
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

/// As `resolve_source`, and besides: no hidden components, no symbolic
/// link on the way, and for a wide root only the entry file.
fn resolve_document_resource(
    root: &Path,
    profile: &DocumentProfile,
    target: &str,
) -> Result<PathBuf, HttpFailure> {
    let decoded = request_path(target)?;
    let relative = if decoded.is_empty() {
        profile
            .entry
            .strip_prefix(root)
            .map_err(|_| HttpFailure::NotFound)?
            .to_path_buf()
    } else {
        PathBuf::from(
            normalize_repo_relative(&decoded, RootMode::Reject)
                .map_err(|_| HttpFailure::BadRequest)?,
        )
    };
    let requested = root.join(&relative);
    // The entry file is served even when its own name is hidden.
    if requested != profile.entry && (profile.single_file || has_hidden_component(&relative)) {
        return Err(HttpFailure::NotFound);
    }
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&current).map_err(|_| HttpFailure::NotFound)?;
        if metadata.file_type().is_symlink() {
            return Err(HttpFailure::NotFound);
        }
    }
    if !fs::symlink_metadata(&requested).is_ok_and(|metadata| metadata.is_file()) {
        return Err(HttpFailure::NotFound);
    }
    let canonical = fs::canonicalize(requested).map_err(|_| HttpFailure::NotFound)?;
    if !canonical.starts_with(root) {
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

    fn body(response: &str) -> &str {
        response.split_once("\r\n\r\n").map_or("", |(_, body)| body)
    }

    #[test]
    fn a_document_root_serves_its_directory_without_hidden_files_or_links() {
        let temp = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(temp.path()).unwrap();
        let root = base.join("report");
        fs::create_dir_all(root.join("data/nested")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("sub/.hidden")).unwrap();
        fs::write(root.join("index.html"), "<p>fragment").unwrap();
        fs::write(root.join("data/nested/a.csv"), "csv").unwrap();
        fs::write(root.join("other.html"), "<p>other").unwrap();
        fs::write(root.join(".git/config"), "git").unwrap();
        fs::write(root.join(".env"), "KEY=1").unwrap();
        fs::write(root.join("sub/.hidden/x"), "hidden").unwrap();
        fs::write(base.join("secret.txt"), "secret").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(base.join("secret.txt"), root.join("linked.txt")).unwrap();
            std::os::unix::fs::symlink(root.join("data"), root.join("alias")).unwrap();
        }
        let state = AppSourceState::new();

        tauri::async_runtime::block_on(async {
            let (token, url) = state
                .issue_document(
                    root.clone(),
                    DocumentProfile::new(root.join("index.html"), false, HtmlTheme::Light),
                )
                .await
                .unwrap();
            let url = tauri::Url::parse(&url).unwrap();
            assert_eq!(url.path(), "/index.html");
            let port = url.port().unwrap();
            let own = format!("127.0.0.1:{port}");
            let get = |path: &str| {
                let request = request(path, Some(&own));
                async move { exchange(port, &request).await }
            };

            let entry = get("/index.html").await;
            assert_eq!(status(&entry), "HTTP/1.1 200 OK");
            assert!(entry.contains("Content-Type: text/html; charset=utf-8\r\n"));
            assert!(entry.contains("Content-Security-Policy: default-src"));
            assert!(body(&entry).starts_with("<!doctype html>\n<html data-theme=\"light\">"));
            assert!(body(&entry).ends_with("<p>fragment"));
            assert_eq!(body(&get("/").await), body(&entry));
            // Other files of the root are served as they are.
            assert_eq!(body(&get("/other.html").await), "<p>other");
            assert_eq!(body(&get("/data/nested/a.csv?v=2").await), "csv");

            for path in [
                "/.git/config",
                "/.env",
                "/sub/.hidden/x",
                "/%2egit/config",
                "/linked.txt",
                "/alias/nested/a.csv",
                "/missing.html",
            ] {
                assert_eq!(status(&get(path).await), "HTTP/1.1 404 Not Found", "{path}");
            }
            for path in [
                "/../secret.txt",
                "/%2e%2e/secret.txt",
                "/./index.html",
                "/data//nested/a.csv",
            ] {
                assert_eq!(
                    status(&get(path).await),
                    "HTTP/1.1 400 Bad Request",
                    "{path}"
                );
            }
            let foreign = exchange(
                port,
                &request("/index.html", Some(&format!("localhost:{port}"))),
            )
            .await;
            assert_eq!(status(&foreign), "HTTP/1.1 421 Misdirected Request");

            // The theme of the next load.
            state.set_document_theme(&token, HtmlTheme::Dark);
            assert!(
                body(&get("/").await).starts_with("<!doctype html>\n<html data-theme=\"dark\">")
            );

            state.revoke(&token);
            let mut closed = false;
            for _ in 0..50 {
                if TcpStream::connect((Ipv4Addr::LOCALHOST, port))
                    .await
                    .is_err()
                {
                    closed = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            assert!(closed, "the port still answers after revocation");
        });
    }

    #[test]
    fn a_wide_document_root_serves_only_its_file() {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        fs::write(root.join("page.html"), "<html><p>").unwrap();
        fs::write(root.join("notes.md"), "notes").unwrap();
        fs::write(root.join(".hidden.html"), "<p>").unwrap();
        let state = AppSourceState::new();

        tauri::async_runtime::block_on(async {
            let (token, url) = state
                .issue_document(
                    root.clone(),
                    DocumentProfile::new(root.join("page.html"), true, HtmlTheme::Dark),
                )
                .await
                .unwrap();
            let port = tauri::Url::parse(&url).unwrap().port().unwrap();
            let own = format!("127.0.0.1:{port}");
            let page = exchange(port, &request("/page.html", Some(&own))).await;
            assert_eq!(body(&page), "<html data-theme=\"dark\"><p>");
            assert_eq!(
                body(&exchange(port, &request("/", Some(&own))).await),
                body(&page)
            );
            for path in ["/notes.md", "/.hidden.html"] {
                let sibling = exchange(port, &request(path, Some(&own))).await;
                assert_eq!(status(&sibling), "HTTP/1.1 404 Not Found", "{path}");
            }
            state.revoke(&token);

            // A hidden name of the entry itself does not hide it.
            let (token, url) = state
                .issue_document(
                    root.clone(),
                    DocumentProfile::new(root.join(".hidden.html"), false, HtmlTheme::Dark),
                )
                .await
                .unwrap();
            let port = tauri::Url::parse(&url).unwrap().port().unwrap();
            let own = format!("127.0.0.1:{port}");
            assert_eq!(
                status(&exchange(port, &request("/", Some(&own))).await),
                "HTTP/1.1 200 OK"
            );
            state.revoke(&token);
        });
    }

    #[test]
    fn documents_inside_a_space_change_through_its_watcher() {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap().join("report");
        fs::create_dir_all(root.join("data")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join("index.html"), "<p>").unwrap();
        fs::write(root.join("data/a.csv"), "1").unwrap();
        fs::write(root.join(".git/HEAD"), "ref").unwrap();
        let sibling = temp.path().join("report-old");
        fs::create_dir_all(&sibling).unwrap();
        fs::write(sibling.join("index.html"), "<p>").unwrap();
        let state = AppSourceState::new();
        let profile = |entry: &str| {
            Arc::new(DocumentProfile::new(
                root.join(entry),
                false,
                HtmlTheme::Light,
            ))
        };
        state.servers.lock().unwrap().insert(
            "space".to_string(),
            ServedSource {
                shutdown: None,
                root: root.clone(),
                kind: SourceKind::Document {
                    profile: profile("index.html"),
                    observer: None,
                },
            },
        );

        assert_eq!(
            state.documents_changed_by(&root.join("data/a.csv"), false),
            ["space"]
        );
        assert_eq!(
            state.documents_changed_by(&root.join("index.html"), false),
            ["space"]
        );
        assert!(
            state
                .documents_changed_by(&root.join(".git/HEAD"), false)
                .is_empty()
        );
        assert!(
            state
                .documents_changed_by(&sibling.join("index.html"), false)
                .is_empty()
        );
        // Documents are not App sources.
        assert!(
            state
                .sources_changed_by(&root.join("data/a.csv"), false)
                .is_empty()
        );

        // A Document with its own observation does not report twice.
        let observer = crate::document::html::observe_outside(
            root.clone(),
            root.join("index.html"),
            false,
            || {},
        )
        .unwrap();
        state.observe_document("space", observer);
        assert!(
            state
                .documents_changed_by(&root.join("data/a.csv"), false)
                .is_empty()
        );
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
            ServedSource {
                shutdown: None,
                root: public_root.to_path_buf(),
                kind: SourceKind::App {
                    manifest: manifest.to_path_buf(),
                },
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
            ServedSource {
                shutdown: Some(shutdown),
                root: PathBuf::from("/public"),
                kind: SourceKind::App {
                    manifest: PathBuf::from("/app.yaml"),
                },
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

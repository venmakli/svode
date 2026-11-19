//! Loopback S3 stand for process tests: a path-style object store over
//! HTTP/1.1 on 127.0.0.1 that accepts requests signed with one access key id
//! and answers `AccessDenied` for any other. Signatures are not verified;
//! the stand records each request as `METHOD /bucket/key`.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct State {
    objects: BTreeMap<String, Vec<u8>>,
    requests: Vec<String>,
}

pub struct S3Stand {
    pub endpoint: String,
    state: Arc<Mutex<State>>,
}

impl S3Stand {
    /// Starts the stand; requests must be signed with `access_key`.
    pub fn start(access_key: &str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(Mutex::new(State::default()));
        let credential = format!("Credential={access_key}/");
        let shared = Arc::clone(&state);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let state = Arc::clone(&shared);
                let credential = credential.clone();
                std::thread::spawn(move || serve(stream, &state, &credential));
            }
        });
        Self { endpoint, state }
    }

    pub fn put(&self, path: &str, bytes: &[u8]) {
        self.state
            .lock()
            .unwrap()
            .objects
            .insert(path.to_string(), bytes.to_vec());
    }

    pub fn get(&self, path: &str) -> Option<Vec<u8>> {
        self.state.lock().unwrap().objects.get(path).cloned()
    }

    pub fn keys(&self) -> Vec<String> {
        self.state.lock().unwrap().objects.keys().cloned().collect()
    }

    pub fn requests(&self) -> Vec<String> {
        self.state.lock().unwrap().requests.clone()
    }
}

fn serve(stream: TcpStream, state: &Mutex<State>, credential: &str) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut writer = stream;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        let mut parts = line.split_whitespace();
        let (Some(method), Some(target)) = (parts.next(), parts.next()) else {
            return;
        };
        let (method, target) = (method.to_string(), target.to_string());
        let mut headers = BTreeMap::new();
        loop {
            let mut header = String::new();
            if reader.read_line(&mut header).unwrap_or(0) == 0 {
                return;
            }
            let header = header.trim_end();
            if header.is_empty() {
                break;
            }
            if let Some((name, value)) = header.split_once(':') {
                headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
            }
        }
        let length = headers
            .get("content-length")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        let mut body = vec![0; length];
        if reader.read_exact(&mut body).is_err() {
            return;
        }
        let path = target.split('?').next().unwrap_or_default().to_string();
        let authorized = headers
            .get("authorization")
            .is_some_and(|value| value.contains(credential));
        let mut state = state.lock().unwrap();
        state.requests.push(format!("{method} {path}"));
        let (status, extra, payload): (&str, Vec<String>, Vec<u8>) = if !authorized {
            (
                "403 Forbidden",
                vec!["Content-Type: application/xml".into()],
                b"<?xml version=\"1.0\" encoding=\"UTF-8\"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>".to_vec(),
            )
        } else {
            match method.as_str() {
                "PUT" => {
                    state.objects.insert(path, body);
                    ("200 OK", vec!["ETag: \"stand\"".into()], Vec::new())
                }
                "GET" | "HEAD" => match state.objects.get(&path) {
                    Some(data) => {
                        let (status, slice, range) = ranged(data, headers.get("range"));
                        let mut extra = vec!["ETag: \"stand\"".into()];
                        extra.extend(range);
                        (status, extra, slice)
                    }
                    None => (
                        "404 Not Found",
                        vec!["Content-Type: application/xml".into()],
                        b"<?xml version=\"1.0\" encoding=\"UTF-8\"?><Error><Code>NoSuchKey</Code><Message>missing</Message></Error>".to_vec(),
                    ),
                },
                "DELETE" => {
                    state.objects.remove(&path);
                    ("204 No Content", Vec::new(), Vec::new())
                }
                _ => ("405 Method Not Allowed", Vec::new(), Vec::new()),
            }
        };
        drop(state);
        let mut response = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: keep-alive\r\n",
            payload.len()
        );
        for header in extra {
            response.push_str(&header);
            response.push_str("\r\n");
        }
        response.push_str("\r\n");
        let mut bytes = response.into_bytes();
        if method != "HEAD" {
            bytes.extend(payload);
        }
        if writer
            .write_all(&bytes)
            .and_then(|()| writer.flush())
            .is_err()
        {
            return;
        }
    }
}

/// Body of a GET with an optional `bytes=a-b` range.
fn ranged(data: &[u8], range: Option<&String>) -> (&'static str, Vec<u8>, Vec<String>) {
    let Some(spec) = range.and_then(|range| range.strip_prefix("bytes=")) else {
        return ("200 OK", data.to_vec(), Vec::new());
    };
    let (start, end) = spec.split_once('-').unwrap_or((spec, ""));
    let start = start.parse::<usize>().unwrap_or(0).min(data.len());
    let end = end
        .parse::<usize>()
        .map(|end| end + 1)
        .unwrap_or(data.len())
        .min(data.len());
    let end = end.max(start);
    (
        "206 Partial Content",
        data[start..end].to_vec(),
        vec![format!(
            "Content-Range: bytes {start}-{}/{}",
            end.saturating_sub(1),
            data.len()
        )],
    )
}

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::sync::Mutex;

use tauri::http::header::{
    ACCEPT_RANGES, ACCESS_CONTROL_ALLOW_ORIGIN, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE,
    CONTENT_SECURITY_POLICY, CONTENT_TYPE, HeaderValue,
};
use tauri::http::{Method, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime, UriSchemeResponder};
use ulid::Ulid;

use super::source::{
    FULL_RESPONSE_LIMIT, MediaSourceDescriptor, MediaSourceError, MediaSourceTarget,
    RANGE_RESPONSE_LIMIT, ResolvedMediaSource, resolve_capability_source,
};

#[derive(Debug, Clone)]
pub(crate) struct MediaSourceCapability {
    pub target: MediaSourceTarget,
    pub descriptor: MediaSourceDescriptor,
}

pub(crate) struct MediaSourceState {
    capabilities: Mutex<HashMap<String, MediaSourceCapability>>,
}

impl MediaSourceState {
    pub(crate) fn new() -> Self {
        Self {
            capabilities: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn issue(&self, source: &ResolvedMediaSource) -> String {
        let mut hasher = sha2::Sha256::new();
        use sha2::Digest;
        hasher.update(Ulid::new().to_bytes());
        hasher.update(Ulid::new().to_bytes());
        let token = hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        self.capabilities
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(
                token.clone(),
                MediaSourceCapability {
                    target: source.target.clone(),
                    descriptor: source.descriptor.clone(),
                },
            );
        token
    }

    pub(crate) fn revoke(&self, token: &str) {
        self.capabilities
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(token);
    }

    fn get(&self, token: &str) -> Option<MediaSourceCapability> {
        self.capabilities
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(token)
            .cloned()
    }

    #[cfg(test)]
    fn contains(&self, token: &str) -> bool {
        self.capabilities
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .contains_key(token)
    }
}

pub(crate) fn handle_media_protocol<R: Runtime>(
    app: AppHandle<R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    std::thread::spawn(move || {
        let path = request.uri().path().trim_start_matches('/');
        let token = (!path.is_empty() && !path.contains('/'))
            .then_some(path)
            .unwrap_or_default()
            .to_string();
        let state = app.state::<MediaSourceState>();
        let response = state
            .get(&token)
            .ok_or(ProtocolFailure::NotFound)
            .and_then(|capability| {
                serve_capability(&request, &capability).map_err(|error| {
                    if matches!(
                        error,
                        ProtocolFailure::Source(MediaSourceError::SourceChanged)
                            | ProtocolFailure::Source(MediaSourceError::SourceMissing)
                            | ProtocolFailure::Source(MediaSourceError::SourceUnavailable)
                    ) {
                        state.revoke(&token);
                    }
                    error
                })
            })
            .unwrap_or_else(protocol_error_response);
        responder.respond(response);
    });
}

#[derive(Debug)]
enum ProtocolFailure {
    NotFound,
    MethodNotAllowed,
    RangeNotSatisfiable(u64),
    FullResponseTooLarge,
    Io,
    Source(MediaSourceError),
}

fn serve_capability(
    request: &Request<Vec<u8>>,
    capability: &MediaSourceCapability,
) -> Result<Response<Vec<u8>>, ProtocolFailure> {
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return Err(ProtocolFailure::MethodNotAllowed);
    }
    let path = resolve_capability_source(&capability.target, &capability.descriptor)
        .map_err(ProtocolFailure::Source)?;
    let len = capability.descriptor.size_bytes;
    let range = request
        .headers()
        .get("range")
        .map(|value| {
            value
                .to_str()
                .map_err(|_| ProtocolFailure::RangeNotSatisfiable(len))
        })
        .transpose()?
        .map(|value| parse_single_range(value, len))
        .transpose()?;
    let (status, start, end) = match range {
        Some((start, end)) => (StatusCode::PARTIAL_CONTENT, start, end),
        None if len <= FULL_RESPONSE_LIMIT => (StatusCode::OK, 0, len.saturating_sub(1)),
        None => return Err(ProtocolFailure::FullResponseTooLarge),
    };
    let content_length = if len == 0 { 0 } else { end + 1 - start };
    let mut response = base_response(capability.descriptor.mime_type)
        .status(status)
        .header(CONTENT_LENGTH, content_length.to_string());
    if status == StatusCode::PARTIAL_CONTENT {
        response = response.header(CONTENT_RANGE, format!("bytes {start}-{end}/{len}"));
    }
    if request.method() == Method::HEAD || content_length == 0 {
        return response.body(Vec::new()).map_err(|_| ProtocolFailure::Io);
    }

    let mut file = File::open(path).map_err(|_| ProtocolFailure::Io)?;
    file.seek(SeekFrom::Start(start))
        .map_err(|_| ProtocolFailure::Io)?;
    let mut bytes = Vec::with_capacity(content_length as usize);
    file.take(content_length)
        .read_to_end(&mut bytes)
        .map_err(|_| ProtocolFailure::Io)?;
    if bytes.len() as u64 != content_length {
        return Err(ProtocolFailure::Source(MediaSourceError::SourceChanged));
    }
    resolve_capability_source(&capability.target, &capability.descriptor)
        .map_err(ProtocolFailure::Source)?;
    response.body(bytes).map_err(|_| ProtocolFailure::Io)
}

fn base_response(mime_type: &'static str) -> tauri::http::response::Builder {
    Response::builder()
        .header(CONTENT_TYPE, mime_type)
        .header(ACCEPT_RANGES, "bytes")
        .header(CACHE_CONTROL, "no-store")
        .header(ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header("X-Content-Type-Options", "nosniff")
        .header(
            CONTENT_SECURITY_POLICY,
            "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        )
}

fn parse_single_range(value: &str, len: u64) -> Result<(u64, u64), ProtocolFailure> {
    if len == 0 {
        return Err(ProtocolFailure::RangeNotSatisfiable(len));
    }
    let value = value
        .strip_prefix("bytes=")
        .filter(|value| !value.contains(','))
        .ok_or(ProtocolFailure::RangeNotSatisfiable(len))?;
    let (start, end) = value
        .split_once('-')
        .ok_or(ProtocolFailure::RangeNotSatisfiable(len))?;
    let (start, requested_end) = if start.is_empty() {
        let suffix = end
            .parse::<u64>()
            .ok()
            .filter(|suffix| *suffix > 0)
            .ok_or(ProtocolFailure::RangeNotSatisfiable(len))?;
        (len.saturating_sub(suffix.min(len)), len - 1)
    } else {
        let start = start
            .parse::<u64>()
            .map_err(|_| ProtocolFailure::RangeNotSatisfiable(len))?;
        if start >= len {
            return Err(ProtocolFailure::RangeNotSatisfiable(len));
        }
        let end = if end.is_empty() {
            len - 1
        } else {
            end.parse::<u64>()
                .map_err(|_| ProtocolFailure::RangeNotSatisfiable(len))?
                .min(len - 1)
        };
        if end < start {
            return Err(ProtocolFailure::RangeNotSatisfiable(len));
        }
        (start, end)
    };
    let end = requested_end.min(start + RANGE_RESPONSE_LIMIT - 1);
    Ok((start, end))
}

fn protocol_error_response(error: ProtocolFailure) -> Response<Vec<u8>> {
    let (status, content_range) = match error {
        ProtocolFailure::NotFound => (StatusCode::NOT_FOUND, None),
        ProtocolFailure::MethodNotAllowed => (StatusCode::METHOD_NOT_ALLOWED, None),
        ProtocolFailure::RangeNotSatisfiable(len) => (
            StatusCode::RANGE_NOT_SATISFIABLE,
            Some(format!("bytes */{len}")),
        ),
        ProtocolFailure::FullResponseTooLarge => (StatusCode::PAYLOAD_TOO_LARGE, None),
        ProtocolFailure::Source(MediaSourceError::SourceChanged) => (StatusCode::CONFLICT, None),
        ProtocolFailure::Source(MediaSourceError::SourceMissing) => (StatusCode::NOT_FOUND, None),
        ProtocolFailure::Source(MediaSourceError::SourceUnavailable) => (StatusCode::GONE, None),
        ProtocolFailure::Source(_) => (StatusCode::BAD_REQUEST, None),
        ProtocolFailure::Io => (StatusCode::INTERNAL_SERVER_ERROR, None),
    };
    let mut response = base_response("text/plain").status(status);
    if let Some(content_range) = content_range {
        response = response.header(CONTENT_RANGE, content_range);
    }
    response
        .header(CONTENT_LENGTH, HeaderValue::from_static("0"))
        .body(Vec::new())
        .expect("static media protocol response")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn byte_ranges_are_single_and_bounded() {
        assert_eq!(parse_single_range("bytes=10-19", 100).unwrap(), (10, 19));
        assert_eq!(parse_single_range("bytes=-10", 100).unwrap(), (90, 99));
        assert_eq!(parse_single_range("bytes=95-", 100).unwrap(), (95, 99));
        assert_eq!(
            parse_single_range("bytes=0-99999999", 100_000_000).unwrap(),
            (0, RANGE_RESPONSE_LIMIT - 1)
        );
        assert!(parse_single_range("bytes=0-1,4-5", 100).is_err());
        assert!(parse_single_range("bytes=100-", 100).is_err());
    }

    #[test]
    fn protocol_response_blocks_active_svg_document_capabilities() {
        let response = base_response("image/svg+xml")
            .body(Vec::<u8>::new())
            .unwrap();
        assert_eq!(
            response.headers().get(CONTENT_SECURITY_POLICY).unwrap(),
            "default-src 'none'; style-src 'unsafe-inline'; sandbox"
        );
        assert_eq!(
            response.headers().get("X-Content-Type-Options").unwrap(),
            "nosniff"
        );
    }

    #[test]
    fn capability_tokens_are_revocable() {
        let state = MediaSourceState::new();
        let source = ResolvedMediaSource {
            target: MediaSourceTarget {
                project_path: "project".into(),
                space_id: None,
                target_path: "photo.png".into(),
            },
            descriptor: MediaSourceDescriptor {
                animated: false,
                family: super::super::source::MediaFamily::Image,
                format: super::super::source::MediaFormat::Png,
                generation: "generation".into(),
                height: Some(1),
                inline_preview: true,
                intrinsic_oversized: false,
                mime_type: "image/png",
                size_bytes: 24,
                width: Some(1),
            },
        };
        let token = state.issue(&source);
        assert!(state.contains(&token));
        assert_eq!(token.len(), 64);
        assert!(!token.contains("photo"));
        state.revoke(&token);
        assert!(!state.contains(&token));
    }
}

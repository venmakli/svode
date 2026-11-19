//! HTTP transport of the S3 operator that counts the body of each object
//! upload request as the connection takes it. OpenDAL buffers an upload in
//! S3 parts of at least 5 MiB and sends one part while it fills the next, so
//! only the request body shows how far the upload went. Every other request
//! goes through the transport the operator had.

use std::convert::Infallible;
use std::pin::Pin;
use std::task::{Context, Poll};

use bytes::Bytes;
use http::{Method, Request, Response, Uri};
use http_body::{Frame, SizeHint};
use opendal::{Buffer, Error, ErrorKind, HttpBody, HttpTransport, HttpTransporter};

use crate::progress::Counter;

/// Largest body frame handed to the connection, so the count follows the
/// socket rather than whole parts.
const FRAME: usize = 64 * 1024;

pub(crate) struct UploadCounting {
    client: reqwest::Client,
    sent: Counter,
    previous: HttpTransporter,
}

impl UploadCounting {
    pub(crate) fn new(previous: HttpTransporter, sent: Counter) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .build()
            .map_err(|error| format!("HTTP client: {error}"))?;
        Ok(Self {
            client,
            sent,
            previous,
        })
    }
}

impl HttpTransport for UploadCounting {
    async fn fetch(&self, req: Request<Buffer>) -> opendal::Result<Response<HttpBody>> {
        if req.method() != Method::PUT || req.body().is_empty() {
            return self.previous.fetch(req).await;
        }
        let (parts, body) = req.into_parts();
        let uri = parts.uri;
        let response = self
            .client
            .request(parts.method, uri.to_string())
            .headers(parts.headers)
            .version(parts.version)
            .body(reqwest::Body::wrap(Counted {
                body,
                frame: Bytes::new(),
                sent: self.sent.clone(),
            }))
            .send()
            .await
            .map_err(|error| failure("send http request", &uri, error))?;
        let mut head = Response::builder()
            .status(response.status())
            .version(response.version())
            .extension(uri.clone());
        if let Some(headers) = head.headers_mut() {
            *headers = response.headers().clone();
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|error| failure("read data from http response", &uri, error))?;
        let size = bytes.len() as u64;
        let body = HttpBody::new(futures::stream::iter([Ok(Buffer::from(bytes))]), Some(size));
        head.body(body).map_err(|error| {
            Error::new(ErrorKind::Unexpected, "build http response").set_source(error)
        })
    }
}

fn failure(action: &'static str, uri: &Uri, error: reqwest::Error) -> Error {
    let temporary = error.is_request() || error.is_body() || error.is_decode();
    Error::new(ErrorKind::Unexpected, action)
        .with_operation("svode-lfs::upload")
        .with_context("url", uri.to_string())
        .with_temporary(temporary)
        .set_source(error)
}

/// Upload body that counts each frame as the connection asks for it.
struct Counted {
    body: Buffer,
    frame: Bytes,
    sent: Counter,
}

impl http_body::Body for Counted {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        _: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        if self.frame.is_empty() {
            match self.body.next() {
                Some(part) => self.frame = part,
                None => return Poll::Ready(None),
            }
        }
        let size = self.frame.len().min(FRAME);
        let frame = self.frame.split_to(size);
        self.sent.add(size as u64);
        Poll::Ready(Some(Ok(Frame::data(frame))))
    }

    fn is_end_stream(&self) -> bool {
        self.frame.is_empty() && self.body.is_empty()
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::with_exact((self.frame.len() + self.body.len()) as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body::Body as _;

    #[test]
    fn the_body_keeps_bytes_and_size_and_counts_each_frame() {
        let parts = vec![
            Bytes::from(vec![1u8; FRAME * 2 + 7]),
            Bytes::from_static(b"tail"),
        ];
        let expected: Vec<u8> = parts.iter().flat_map(|part| part.to_vec()).collect();
        let sent = Counter::new();
        let mut seen = sent.start();
        let mut body = Counted {
            body: Buffer::from(parts),
            frame: Bytes::new(),
            sent,
        };
        assert_eq!(body.size_hint().exact(), Some(expected.len() as u64));
        let waker = futures::task::noop_waker();
        let mut context = Context::from_waker(&waker);
        let mut received = Vec::new();
        let mut frames = 0;
        while let Poll::Ready(Some(frame)) = Pin::new(&mut body).poll_frame(&mut context) {
            let data = frame.unwrap().into_data().unwrap();
            assert!(data.len() <= FRAME);
            received.extend_from_slice(&data);
            frames += 1;
            assert_eq!(*seen.borrow_and_update(), received.len() as u64);
            assert_eq!(
                body.size_hint().exact(),
                Some((expected.len() - received.len()) as u64)
            );
        }
        assert!(body.is_end_stream());
        assert_eq!(received, expected);
        assert_eq!(frames, 4);
    }
}

//! Newline-delimited JSON-RPC 2.0 over an agent's stdio.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

/// A replay can be one large update; anything longer is a broken peer.
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
const METHOD_NOT_FOUND: i64 = -32601;
/// ACP `auth_required`.
pub(crate) const AUTH_REQUIRED: i64 = -32000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RpcError {
    Remote { code: i64, message: String },
    Timeout,
    Closed,
}

#[derive(Debug)]
pub(crate) enum Incoming {
    /// Params stay raw text: a typed parse keeps the agent's key order.
    Request {
        id: Value,
        method: String,
        params: Box<RawValue>,
    },
    Notification {
        method: String,
        params: Value,
    },
    /// Resolved once everything received before it has been handled.
    Barrier(oneshot::Sender<()>),
}

type Waiters = Mutex<Option<HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>>>;

pub(crate) struct RpcClient {
    outgoing: mpsc::UnboundedSender<String>,
    /// Weak, so the incoming channel still closes when the peer is gone.
    incoming: mpsc::WeakUnboundedSender<Incoming>,
    /// `None` once the peer is gone: new requests fail as closed.
    waiters: Arc<Waiters>,
    next_id: AtomicU64,
}

impl RpcClient {
    /// Starts the reader and writer tasks. The incoming channel closes when
    /// the peer's output ends; every in-flight request then fails as closed.
    pub(crate) fn start<R, W>(
        reader: R,
        writer: W,
    ) -> (Arc<Self>, mpsc::UnboundedReceiver<Incoming>)
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (outgoing, mut outgoing_rx) = mpsc::unbounded_channel::<String>();
        let (incoming_tx, incoming_rx) = mpsc::unbounded_channel();
        let waiters: Arc<Waiters> = Arc::new(Mutex::new(Some(HashMap::new())));
        let client = Arc::new(Self {
            outgoing,
            incoming: incoming_tx.downgrade(),
            waiters: waiters.clone(),
            next_id: AtomicU64::new(1),
        });

        tokio::spawn(async move {
            let mut writer = writer;
            while let Some(line) = outgoing_rx.recv().await {
                if writer.write_all(line.as_bytes()).await.is_err()
                    || writer.write_all(b"\n").await.is_err()
                    || writer.flush().await.is_err()
                {
                    break;
                }
            }
        });

        tokio::spawn(async move {
            let mut reader = BufReader::new(reader);
            let mut line = Vec::new();
            loop {
                line.clear();
                let read = (&mut reader)
                    .take(MAX_LINE_BYTES as u64 + 1)
                    .read_until(b'\n', &mut line)
                    .await;
                match read {
                    Ok(0) | Err(_) => break,
                    Ok(_) if line.len() > MAX_LINE_BYTES => break,
                    Ok(_) => {}
                }
                let Ok(message) = serde_json::from_slice::<Message>(&line) else {
                    continue;
                };
                route(message, &waiters, &incoming_tx);
            }
            let pending = waiters.lock().unwrap().take();
            for (_, waiter) in pending.into_iter().flatten() {
                let _ = waiter.send(Err(RpcError::Closed));
            }
        });

        (client, incoming_rx)
    }

    pub(crate) async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Option<Duration>,
    ) -> Result<Value, RpcError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        match self.waiters.lock().unwrap().as_mut() {
            Some(waiters) => waiters.insert(id, sender),
            None => return Err(RpcError::Closed),
        };
        let line = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if self.outgoing.send(line.to_string()).is_err() {
            self.forget(id);
            return Err(RpcError::Closed);
        }
        let response = match timeout {
            Some(timeout) => match tokio::time::timeout(timeout, receiver).await {
                Ok(response) => response,
                Err(_) => {
                    self.forget(id);
                    return Err(RpcError::Timeout);
                }
            },
            None => receiver.await,
        };
        response.unwrap_or(Err(RpcError::Closed))
    }

    /// Waits until the consumer of incoming messages has handled every
    /// message that arrived before this call. A response is routed as soon
    /// as it is read, while the notifications before it may still wait in
    /// the incoming channel.
    pub(crate) async fn barrier(&self) {
        let Some(incoming) = self.incoming.upgrade() else {
            return;
        };
        let (done, handled) = oneshot::channel();
        let sent = incoming.send(Incoming::Barrier(done)).is_ok();
        drop(incoming);
        if sent {
            let _ = handled.await;
        }
    }

    pub(crate) fn notify(&self, method: &str, params: Value) {
        let line = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        let _ = self.outgoing.send(line.to_string());
    }

    pub(crate) fn respond(&self, id: Value, result: Value) {
        let line = json!({ "jsonrpc": "2.0", "id": id, "result": result });
        let _ = self.outgoing.send(line.to_string());
    }

    pub(crate) fn respond_method_not_found(&self, id: Value, method: &str) {
        let line = json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": METHOD_NOT_FOUND, "message": format!("{method} is not supported") }
        });
        let _ = self.outgoing.send(line.to_string());
    }

    fn forget(&self, id: u64) {
        if let Some(waiters) = self.waiters.lock().unwrap().as_mut() {
            waiters.remove(&id);
        }
    }
}

#[derive(Deserialize)]
struct Message {
    #[serde(default)]
    id: Value,
    method: Option<String>,
    params: Option<Box<RawValue>>,
    result: Option<Value>,
    error: Option<Value>,
}

fn route(message: Message, waiters: &Waiters, incoming: &mpsc::UnboundedSender<Incoming>) {
    let id = Some(message.id).filter(|id| !id.is_null());
    match (message.method, id) {
        (Some(method), Some(id)) => {
            let params = message
                .params
                .unwrap_or_else(|| RawValue::from_string("null".into()).expect("valid JSON"));
            let _ = incoming.send(Incoming::Request { id, method, params });
        }
        (Some(method), None) => {
            let params = message
                .params
                .and_then(|params| serde_json::from_str(params.get()).ok())
                .unwrap_or(Value::Null);
            let _ = incoming.send(Incoming::Notification { method, params });
        }
        (None, Some(id)) => {
            let Some(id) = id.as_u64() else {
                return;
            };
            let waiter = waiters
                .lock()
                .unwrap()
                .as_mut()
                .and_then(|waiters| waiters.remove(&id));
            let Some(waiter) = waiter else {
                return;
            };
            let result = match message.error {
                Some(error) => Err(RpcError::Remote {
                    code: error
                        .get("code")
                        .and_then(Value::as_i64)
                        .unwrap_or_default(),
                    message: remote_message(&error),
                }),
                None => Ok(message.result.unwrap_or(Value::Null)),
            };
            let _ = waiter.send(result);
        }
        (None, None) => {}
    }
}

/// The agent's error message with its `data.details` when it sends one,
/// bounded: agents put the actionable reason there.
fn remote_message(error: &Value) -> String {
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let details = error
        .get("data")
        .and_then(|data| data.get("details").or(Some(data)))
        .and_then(Value::as_str);
    let message = match details {
        Some(details) if !details.is_empty() => format!("{message}: {details}"),
        _ => message.to_string(),
    };
    super::normalize::bounded(&message, 512)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use tokio::io::AsyncWriteExt;

    use super::*;

    #[tokio::test]
    async fn a_barrier_waits_for_the_notifications_read_before_a_response() {
        let (client, agent) = tokio::io::duplex(64 * 1024);
        let (client_read, client_write) = tokio::io::split(client);
        let (mut agent_read, mut agent_write) = tokio::io::split(agent);
        let (rpc, mut incoming) = RpcClient::start(client_read, client_write);

        let request = tokio::spawn({
            let rpc = rpc.clone();
            async move { rpc.request("session/load", json!({}), None).await }
        });
        let mut sent = vec![0u8; 256];
        let _ = agent_read.read(&mut sent).await.unwrap();
        for update in 0..3 {
            let line =
                json!({ "jsonrpc": "2.0", "method": "session/update", "params": { "n": update } });
            agent_write
                .write_all(format!("{line}\n").as_bytes())
                .await
                .unwrap();
        }
        agent_write
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n")
            .await
            .unwrap();
        request.await.unwrap().unwrap();

        // A slow consumer has not handled the notifications yet.
        let handled = Arc::new(AtomicUsize::new(0));
        tokio::spawn({
            let handled = handled.clone();
            async move {
                while let Some(message) = incoming.recv().await {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    match message {
                        Incoming::Barrier(done) => {
                            let _ = done.send(());
                        }
                        _ => {
                            handled.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                }
            }
        });
        assert_eq!(handled.load(Ordering::Relaxed), 0);
        rpc.barrier().await;
        assert_eq!(handled.load(Ordering::Relaxed), 3);
    }

    #[tokio::test]
    async fn a_barrier_after_the_peer_is_gone_returns_at_once() {
        let (client, agent) = tokio::io::duplex(1024);
        let (client_read, client_write) = tokio::io::split(client);
        let (rpc, incoming) = RpcClient::start(client_read, client_write);
        drop(agent);
        drop(incoming);
        tokio::time::timeout(Duration::from_secs(1), rpc.barrier())
            .await
            .expect("no one handles the barrier");
    }
}

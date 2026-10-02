//! Desktop host of the `svode-agents` runtime: one runtime per app process
//! and delivery of session snapshots and deltas to webviews. Work of the
//! runtime does not depend on a window; a subscription only delivers it.

pub mod commands;
pub mod connections;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use svode_agents::activity::{SessionDelta, SessionSnapshot};
use svode_agents::identity::SessionKey;
use svode_agents::{AgentRuntime, AgentRuntimeError, SessionSubscription};
use tauri::async_runtime::JoinHandle;
use tokio::sync::broadcast::error::RecvError;

/// One message of a subscription channel: the snapshot first, then the
/// deltas after it in seq order.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum ActivityMessage {
    Snapshot(SessionSnapshot),
    Delta(SessionDelta),
}

pub struct AgentRuntimeState {
    runtime: AgentRuntime,
    subscriptions: Arc<Subscriptions>,
}

#[derive(Default)]
struct Subscriptions {
    next: AtomicU64,
    active: Mutex<HashMap<u64, Delivery>>,
}

struct Delivery {
    webview: String,
    task: JoinHandle<()>,
}

impl AgentRuntimeState {
    pub fn new() -> Self {
        Self {
            runtime: AgentRuntime::default(),
            subscriptions: Arc::default(),
        }
    }

    pub fn runtime(&self) -> &AgentRuntime {
        &self.runtime
    }

    /// Delivers the session's snapshot and deltas through `send` until the
    /// subscription is dropped, its webview reloads or `send` fails.
    fn subscribe(
        &self,
        webview: &str,
        session: &SessionKey,
        send: impl FnMut(ActivityMessage) -> bool + Send + 'static,
    ) -> Result<u64, AgentRuntimeError> {
        let subscription = self.runtime.subscribe(session)?;
        Ok(self.deliver(webview, subscription, send))
    }

    fn deliver(
        &self,
        webview: &str,
        subscription: SessionSubscription,
        send: impl FnMut(ActivityMessage) -> bool + Send + 'static,
    ) -> u64 {
        let id = self.subscriptions.next.fetch_add(1, Ordering::Relaxed) + 1;
        // Held until the delivery is registered, so a delivery that ends at
        // once still finds and removes its entry.
        let mut active = self.subscriptions.active.lock().unwrap();
        let subscriptions = self.subscriptions.clone();
        let task = tauri::async_runtime::spawn(async move {
            forward(subscription, send).await;
            subscriptions.active.lock().unwrap().remove(&id);
        });
        active.insert(
            id,
            Delivery {
                webview: webview.to_string(),
                task,
            },
        );
        id
    }

    /// Stops a delivery; an unknown id is already gone.
    fn unsubscribe(&self, id: u64) {
        if let Some(delivery) = self.subscriptions.active.lock().unwrap().remove(&id) {
            delivery.task.abort();
        }
    }

    /// Drops the deliveries of a webview that reloads or closes: its page
    /// no longer listens and subscribes again after load.
    pub fn release_webview(&self, webview: &str) {
        self.subscriptions
            .active
            .lock()
            .unwrap()
            .retain(|_, delivery| {
                let keep = delivery.webview != webview;
                if !keep {
                    delivery.task.abort();
                }
                keep
            });
    }

    #[cfg(test)]
    fn subscription_count(&self) -> usize {
        self.subscriptions.active.lock().unwrap().len()
    }
}

async fn forward(subscription: SessionSubscription, mut send: impl FnMut(ActivityMessage) -> bool) {
    let SessionSubscription {
        snapshot,
        mut deltas,
    } = subscription;
    if !send(ActivityMessage::Snapshot(snapshot)) {
        return;
    }
    loop {
        match deltas.recv().await {
            Ok(delta) => {
                if !send(ActivityMessage::Delta(delta)) {
                    return;
                }
            }
            // The next delta arrives after a seq gap; the consumer drops its
            // state and subscribes again.
            Err(RecvError::Lagged(_)) => continue,
            Err(RecvError::Closed) => return,
        }
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

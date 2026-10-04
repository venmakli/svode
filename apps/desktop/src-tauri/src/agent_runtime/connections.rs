//! Desktop owner of agent connections (Stage 10 `02` C1/C3, `03` A1). An
//! agent's ACP entrypoint starts only at a lifecycle boundary and only for
//! an available agent: an open Sessions collection for the agents whose
//! catalogue is their ACP list, the user's explicit check, an agent chosen
//! in a new session draft and the creation of a session; opening a session
//! and a Routine/Actor launch acquire through the same planner in their
//! slices. Sharing by launch plan, the provenance split and closing for
//! idleness belong to the runtime.

use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use svode_agents::adapters::LaunchUnavailable;
use svode_agents::custom::CustomAgentDefinition;
use svode_agents::identity::SessionKey;
use svode_agents::{
    AcpLaunch, AgentCheck, AgentRuntime, AgentRuntimeError, ConnectionLease, SettingValue,
};

pub(crate) type PlanFuture<'a> =
    Pin<Box<dyn Future<Output = Result<AcpLaunch, LaunchUnavailable>> + Send + 'a>>;

/// What the host knows about agents: which ones list their catalogue over
/// ACP and how an available one launches.
pub(crate) trait LaunchPlanner: Send + Sync {
    /// Agents whose `session/list` is their declared catalogue source.
    fn catalog_agents(&self) -> Vec<String>;
    /// The launch plan of an available agent, or why it is not available;
    /// starts nothing.
    fn plan<'a>(&'a self, agent: &'a str) -> PlanFuture<'a>;
    /// The launch plan of a custom agent the user is adding (`agent: None`)
    /// or editing, before it is saved.
    fn plan_draft<'a>(
        &'a self,
        agent: Option<&'a str>,
        definition: CustomAgentDefinition,
    ) -> PlanFuture<'a>;
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum ConnectRefusal {
    #[error(transparent)]
    Unavailable(LaunchUnavailable),
    #[error(transparent)]
    Failed(AgentRuntimeError),
}

pub struct AgentConnections {
    runtime: AgentRuntime,
    planner: Box<dyn LaunchPlanner>,
    next_hold: AtomicU64,
    catalog: Mutex<CatalogDemand>,
    /// Hold id → the new session draft that chose the agent of the lease.
    drafts: Mutex<HashMap<u64, DraftHold>>,
}

struct DraftHold {
    webview: String,
    _lease: ConnectionLease,
}

/// What creating a session from a draft did.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(
    tag = "outcome",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum SessionStart {
    /// The agent created the session and the runtime accepted its first
    /// prompt as turn `turn_id`.
    Started {
        session: SessionKey,
        turn_id: String,
    },
    /// The agent is no longer available; nothing started.
    Unavailable { reason: LaunchUnavailable },
}

/// Open Sessions collections and the catalogue connections they keep.
#[derive(Default)]
struct CatalogDemand {
    /// Hold id → webview label.
    holds: HashMap<u64, String>,
    leases: HashMap<String, ConnectionLease>,
}

impl CatalogDemand {
    fn release_if_unheld(&mut self) {
        if self.holds.is_empty() {
            self.leases.clear();
        }
    }
}

impl AgentConnections {
    pub(crate) fn new(runtime: AgentRuntime, planner: impl LaunchPlanner + 'static) -> Self {
        Self {
            runtime,
            planner: Box::new(planner),
            next_hold: AtomicU64::new(0),
            catalog: Mutex::default(),
            drafts: Mutex::default(),
        }
    }

    async fn acquire(&self, agent: &str) -> Result<ConnectionLease, ConnectRefusal> {
        let launch = self
            .planner
            .plan(agent)
            .await
            .map_err(ConnectRefusal::Unavailable)?;
        self.runtime
            .acquire(launch)
            .await
            .map_err(ConnectRefusal::Failed)
    }

    /// The user's explicit check: start, `initialize`, close unless the
    /// connection has another reason to live.
    pub async fn check(&self, agent: &str) -> AgentCheck {
        match self.planner.plan(agent).await {
            Ok(launch) => self.runtime.check(launch).await,
            Err(reason) => AgentCheck::Unavailable { reason },
        }
    }

    /// A new session draft chose `agent` (Stage 10 `04`, a C1 boundary): its
    /// connection starts and stays while the hold lives, and the outcome is
    /// what the draft shows before the first prompt. Only a ready agent
    /// gets a hold.
    pub async fn hold_draft(&self, webview: &str, agent: &str) -> (Option<u64>, AgentCheck) {
        let lease = match self.acquire(agent).await {
            Ok(lease) => lease,
            Err(ConnectRefusal::Unavailable(reason)) => {
                return (None, AgentCheck::Unavailable { reason });
            }
            Err(ConnectRefusal::Failed(AgentRuntimeError::AuthRequired { message })) => {
                return (None, AgentCheck::AuthRequired { message });
            }
            Err(ConnectRefusal::Failed(error)) => {
                return (
                    None,
                    AgentCheck::FailedToStart {
                        message: error.to_string(),
                    },
                );
            }
        };
        let Some(info) = self
            .runtime
            .connection_status(lease.connection())
            .and_then(|status| status.agent)
        else {
            return (
                None,
                AgentCheck::FailedToStart {
                    message: AgentRuntimeError::ConnectionClosed.to_string(),
                },
            );
        };
        let hold = self.next_hold.fetch_add(1, Ordering::Relaxed) + 1;
        self.drafts.lock().unwrap().insert(
            hold,
            DraftHold {
                webview: webview.to_string(),
                _lease: lease,
            },
        );
        (Some(hold), AgentCheck::Ready { agent: info })
    }

    /// The draft closed, chose another agent or became a session.
    pub fn release_draft(&self, hold: u64) {
        self.drafts.lock().unwrap().remove(&hold);
    }

    /// Creates a session of `agent` in `cwd` with the draft's setting values
    /// and sends its first prompt: the first send of a new session draft.
    /// The session enters the catalogue once the prompt is accepted.
    pub async fn start_session(
        &self,
        agent: &str,
        cwd: &Path,
        settings: &[SettingValue],
        prompt: &str,
    ) -> Result<SessionStart, AgentRuntimeError> {
        let lease = match self.acquire(agent).await {
            Ok(lease) => lease,
            Err(ConnectRefusal::Unavailable(reason)) => {
                return Ok(SessionStart::Unavailable { reason });
            }
            Err(ConnectRefusal::Failed(error)) => return Err(error),
        };
        let session = self
            .runtime
            .new_session(lease.connection(), cwd, settings)
            .await?;
        let turn_id = self.runtime.prompt(&session, prompt)?;
        Ok(SessionStart::Started { session, turn_id })
    }

    /// The user's check of a custom agent's definition before it is saved.
    pub async fn check_draft(
        &self,
        agent: Option<&str>,
        definition: CustomAgentDefinition,
    ) -> AgentCheck {
        match self.planner.plan_draft(agent, definition).await {
            Ok(launch) => self.runtime.check(launch).await,
            Err(reason) => AgentCheck::Unavailable { reason },
        }
    }

    /// A Sessions collection opened in `webview`; the caller raises the
    /// catalogue connections.
    pub fn hold_catalog(&self, webview: &str) -> u64 {
        let hold = self.next_hold.fetch_add(1, Ordering::Relaxed) + 1;
        self.catalog
            .lock()
            .unwrap()
            .holds
            .insert(hold, webview.to_string());
        hold
    }

    /// The collection closed; with the last one its connections are left
    /// to close after their idle time.
    pub fn release_catalog(&self, hold: u64) {
        let mut catalog = self.catalog.lock().unwrap();
        catalog.holds.remove(&hold);
        catalog.release_if_unheld();
    }

    /// A reloading or closing webview no longer shows its collections and
    /// drafts.
    pub fn release_webview(&self, webview: &str) {
        let mut catalog = self.catalog.lock().unwrap();
        catalog.holds.retain(|_, label| label != webview);
        catalog.release_if_unheld();
        drop(catalog);
        self.drafts
            .lock()
            .unwrap()
            .retain(|_, draft| draft.webview != webview);
    }

    /// A disabled agent's catalogue is no longer kept.
    pub fn forget_agent(&self, agent: &str) {
        self.catalog.lock().unwrap().leases.remove(agent);
    }

    /// Agents whose catalogue connection an open collection needs; none
    /// while no collection is open. An agent that declared no list in this
    /// process is not started for it again.
    pub(crate) fn held_catalog_agents(&self) -> Vec<String> {
        if self.catalog.lock().unwrap().holds.is_empty() {
            return Vec::new();
        }
        self.planner
            .catalog_agents()
            .into_iter()
            .filter(|agent| {
                self.runtime
                    .declared(agent)
                    .is_none_or(|info| info.capabilities.list_sessions)
            })
            .collect()
    }

    /// Starts the agent's catalogue connection unless it is open; true when
    /// it is open for an open collection.
    pub(crate) async fn raise_catalog_agent(&self, agent: &str) -> bool {
        {
            let catalog = self.catalog.lock().unwrap();
            if catalog.holds.is_empty() {
                return false;
            }
            if catalog
                .leases
                .get(agent)
                .is_some_and(ConnectionLease::is_open)
            {
                return true;
            }
        }
        match self.acquire(agent).await {
            Ok(lease) => {
                let mut catalog = self.catalog.lock().unwrap();
                // The collection may have closed meanwhile.
                if catalog.holds.is_empty() {
                    return false;
                }
                catalog.leases.insert(agent.to_string(), lease);
                true
            }
            Err(refusal) => {
                tracing::warn!("catalogue connection of {agent} was not started: {refusal}");
                false
            }
        }
    }
}

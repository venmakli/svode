//! Desktop owner of agent connections (Stage 10 `02` C1/C3, `03` A1). An
//! agent's ACP entrypoint starts only at a lifecycle boundary and only for
//! an available agent: an open Sessions collection for the agents whose
//! catalogue is their ACP list, and the user's explicit check; opening or
//! creating a session and a Routine/Actor launch acquire through the same
//! planner in their slices. Sharing by launch plan, the provenance split
//! and closing for idleness belong to the runtime.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use svode_agents::adapters::LaunchUnavailable;
use svode_agents::custom::CustomAgentDefinition;
use svode_agents::{AcpLaunch, AgentCheck, AgentRuntime, AgentRuntimeError, ConnectionLease};

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

    /// A reloading or closing webview no longer shows its collections.
    pub fn release_webview(&self, webview: &str) {
        let mut catalog = self.catalog.lock().unwrap();
        catalog.holds.retain(|_, label| label != webview);
        catalog.release_if_unheld();
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

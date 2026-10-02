//! ACP list source of the Sessions read-model (Stage 10 `02` C3). The last
//! good `session/list` of every agent whose declared catalogue source it is
//! lives here; reads run off the list response path. A failed or slow read
//! leaves the other sources and its own last good list untouched and only
//! marks its source `stale`; an agent without a live connection keeps its
//! last good list, since closing an idle connection is normal.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use chrono::{DateTime, SecondsFormat, Utc};
use svode_agents::catalog::{CatalogConnection, ListedSession, SessionList};
use svode_agents::{AgentRuntime, AgentRuntimeError, ConnectionId};
use svode_core::agent_adapters::AgentId;
use tauri::async_runtime::JoinHandle;
use tokio::sync::broadcast::error::RecvError;

use crate::agent_runtime::connections::AgentConnections;

use super::types::{
    AgentSessionDiagnosticSeverity, AgentSessionSourceKind, AgentSessionSourceReport,
    AgentSessionSourceStatus,
};

/// What the read-model needs from the agent runtime to read catalogues.
pub(crate) trait CatalogLister: Clone + Send + Sync + 'static {
    fn catalog_connections(&self) -> Vec<CatalogConnection>;
    fn list_sessions(
        &self,
        connection: ConnectionId,
    ) -> impl Future<Output = Result<SessionList, AgentRuntimeError>> + Send;
}

impl CatalogLister for AgentRuntime {
    fn catalog_connections(&self) -> Vec<CatalogConnection> {
        AgentRuntime::catalog_connections(self)
    }

    fn list_sessions(
        &self,
        connection: ConnectionId,
    ) -> impl Future<Output = Result<SessionList, AgentRuntimeError>> + Send {
        AgentRuntime::list_sessions(self, connection)
    }
}

#[derive(Default)]
pub(crate) struct AcpListSources {
    agents: Mutex<HashMap<String, AgentList>>,
}

#[derive(Default)]
struct AgentList {
    last_good: Option<LastGood>,
    /// Why the last good list may be out of date.
    problem: Option<String>,
    reading: bool,
}

struct LastGood {
    list: SessionList,
    read_at: DateTime<Utc>,
    duration_ms: u128,
}

/// One agent's catalogue as the read-model merges it.
pub(crate) struct AcpListRead {
    pub source: AgentId,
    pub sessions: Vec<ListedSession>,
    pub report: AgentSessionSourceReport,
}

impl AcpListSources {
    /// Starts a read of every listing agent not being read already and
    /// returns at once. Only live connections are read; no agent process is
    /// started.
    pub(crate) fn refresh(self: &Arc<Self>, lister: &impl CatalogLister) -> Vec<JoinHandle<()>> {
        self.start(lister, None)
    }

    /// Starts the catalogue connections an open Sessions collection needs
    /// and reads each list once its connection is open. Agents start on
    /// their own, so a slow agent never delays another.
    pub(crate) fn raise(
        self: &Arc<Self>,
        connections: &Arc<AgentConnections>,
        lister: &impl CatalogLister,
    ) -> Vec<JoinHandle<()>> {
        connections
            .held_catalog_agents()
            .into_iter()
            .map(|agent| {
                let (sources, connections, lister) =
                    (self.clone(), connections.clone(), lister.clone());
                tauri::async_runtime::spawn(async move {
                    if connections.raise_catalog_agent(&agent).await {
                        for read in sources.refresh_agent(&lister, &agent) {
                            let _ = read.await;
                        }
                    }
                })
            })
            .collect()
    }

    /// Reads one agent's list again after the runtime's own work changed it.
    pub(crate) fn refresh_agent(
        self: &Arc<Self>,
        lister: &impl CatalogLister,
        agent: &str,
    ) -> Vec<JoinHandle<()>> {
        self.start(lister, Some(agent))
    }

    fn start(
        self: &Arc<Self>,
        lister: &impl CatalogLister,
        only: Option<&str>,
    ) -> Vec<JoinHandle<()>> {
        let connections = lister.catalog_connections();
        let mut agents = self.agents.lock().unwrap();
        let mut reads = Vec::new();
        for CatalogConnection { connection, agent } in connections {
            if only.is_some_and(|only| only != agent) {
                continue;
            }
            let list = agents.entry(agent.clone()).or_default();
            if list.reading {
                continue;
            }
            list.reading = true;
            let sources = self.clone();
            let lister = lister.clone();
            reads.push(tauri::async_runtime::spawn(async move {
                let started = Instant::now();
                let result = lister.list_sessions(connection).await;
                sources.apply(&agent, result, started.elapsed().as_millis());
            }));
        }
        reads
    }

    pub(super) fn apply(
        &self,
        agent: &str,
        result: Result<SessionList, AgentRuntimeError>,
        duration_ms: u128,
    ) {
        let mut agents = self.agents.lock().unwrap();
        let list = agents.entry(agent.to_string()).or_default();
        list.reading = false;
        match result {
            Ok(sessions) => {
                list.last_good = Some(LastGood {
                    list: sessions,
                    read_at: Utc::now(),
                    duration_ms,
                });
                list.problem = None;
            }
            Err(error) => list.problem = Some(error.to_string()),
        }
    }

    /// The last good list of every agent read so far, with its source
    /// report. An agent Svode has no Sessions source for is left out.
    pub(crate) fn reads(&self) -> Vec<AcpListRead> {
        let agents = self.agents.lock().unwrap();
        let mut reads: Vec<_> = agents
            .iter()
            .filter(|(_, list)| list.last_good.is_some() || list.problem.is_some())
            .filter_map(|(agent, list)| {
                let Some(source) = session_source(agent) else {
                    tracing::warn!(agent, "agent id is malformed; its list is not shown");
                    return None;
                };
                Some(read_of(source, list))
            })
            .collect();
        reads.sort_by(|left, right| left.source.cmp(&right.source));
        reads
    }
}

/// Any agent with a session list is a Sessions source under its own id,
/// a built-in, custom or test agent alike.
fn session_source(agent: &str) -> Option<AgentId> {
    AgentId::parse(agent).ok()
}

fn read_of(source: AgentId, list: &AgentList) -> AcpListRead {
    let mut report = AgentSessionSourceReport::new(source.clone(), "session/list".to_string());
    report.kind = AgentSessionSourceKind::AcpList;
    // Always served from the last good read, never on the response path.
    report.cache_hit = true;
    let mut sessions = Vec::new();
    if let Some(last_good) = &list.last_good {
        report.scanned_at = last_good.read_at.to_rfc3339_opts(SecondsFormat::Secs, true);
        report.duration_ms = Some(last_good.duration_ms);
        report.counts.records_read = last_good.list.sessions.len() + last_good.list.skipped;
        report.counts.candidates = last_good.list.sessions.len();
        if last_good.list.skipped > 0 {
            report.push_diagnostic(
                AgentSessionDiagnosticSeverity::Info,
                "acp-list-skipped",
                format!(
                    "{} entries of the agent's session list were malformed, out of bounds or repeated",
                    last_good.list.skipped
                ),
                None,
                None,
            );
        }
        if last_good.list.truncated {
            report.push_diagnostic(
                AgentSessionDiagnosticSeverity::Warning,
                "acp-list-truncated",
                "The agent's session list is longer than Svode reads; older sessions are not shown",
                None,
                None,
            );
        }
        sessions = last_good.list.sessions.clone();
    }
    if let Some(problem) = &list.problem {
        report.status = AgentSessionSourceStatus::Stale;
        report.push_diagnostic(
            AgentSessionDiagnosticSeverity::Warning,
            "acp-list-stale",
            if list.last_good.is_some() {
                format!("Showing the last session list of the agent: {problem}")
            } else {
                format!("The agent's session list is unavailable: {problem}")
            },
            None,
            None,
        );
    }
    AcpListRead {
        source,
        sessions,
        report,
    }
}

/// Reads an agent's list again whenever the runtime's own work changed it,
/// for as long as the runtime lives.
pub(crate) async fn follow_catalog_changes(sources: Arc<AcpListSources>, runtime: AgentRuntime) {
    let mut changes = runtime.catalog_changes();
    loop {
        match changes.recv().await {
            Ok(change) => {
                sources.refresh_agent(&runtime, &change.agent);
            }
            Err(RecvError::Lagged(_)) => {
                sources.refresh(&runtime);
            }
            Err(RecvError::Closed) => return,
        }
    }
}

#[cfg(all(test, unix))]
#[path = "acp_list_connections_tests.rs"]
mod connections_tests;

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use std::sync::atomic::{AtomicUsize, Ordering};
    use svode_core::agent_adapters::AgentAdapterKind;

    use svode_agents::identity::SessionKey;
    use tokio::sync::Notify;

    use super::*;

    #[derive(Clone, Default)]
    pub(crate) struct FakeLister {
        pub connections: Arc<Mutex<Vec<CatalogConnection>>>,
        pub results: Arc<Mutex<HashMap<String, Result<SessionList, AgentRuntimeError>>>>,
        pub calls: Arc<AtomicUsize>,
        pub gate: Option<Arc<Notify>>,
    }

    impl FakeLister {
        pub(crate) fn connect(&self, agent: &str, result: Result<SessionList, AgentRuntimeError>) {
            let mut connections = self.connections.lock().unwrap();
            let connection = ConnectionId(connections.len() as u64 + 1);
            connections.push(CatalogConnection {
                connection,
                agent: agent.into(),
            });
            self.results.lock().unwrap().insert(agent.into(), result);
        }
    }

    impl CatalogLister for FakeLister {
        fn catalog_connections(&self) -> Vec<CatalogConnection> {
            self.connections.lock().unwrap().clone()
        }

        fn list_sessions(
            &self,
            connection: ConnectionId,
        ) -> impl Future<Output = Result<SessionList, AgentRuntimeError>> + Send {
            let this = self.clone();
            async move {
                this.calls.fetch_add(1, Ordering::Relaxed);
                if let Some(gate) = &this.gate {
                    gate.notified().await;
                }
                let agent = this
                    .connections
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|known| known.connection == connection)
                    .map(|known| known.agent.clone())
                    .unwrap();
                this.results.lock().unwrap()[&agent].clone()
            }
        }
    }

    pub(crate) fn listed(agent: &str, id: &str, cwd: &str, native: bool) -> ListedSession {
        ListedSession {
            key: SessionKey::from_acp(agent, id, native),
            cwd: PathBuf::from(cwd),
            title: Some(format!("{id} title")),
            updated_at: Some("2026-09-30T10:00:00Z".into()),
        }
    }

    pub(crate) fn list_of(sessions: Vec<ListedSession>) -> SessionList {
        SessionList {
            sessions,
            ..SessionList::default()
        }
    }

    async fn settle(reads: Vec<JoinHandle<()>>) {
        for read in reads {
            read.await.unwrap();
        }
    }

    #[tokio::test]
    async fn a_failed_read_keeps_the_last_good_list_and_marks_only_its_source_stale() {
        let sources = Arc::new(AcpListSources::default());
        let lister = FakeLister::default();
        lister.connect(
            "codex",
            Ok(list_of(vec![listed("codex", "s1", "/w", false)])),
        );
        lister.connect(
            "claude-code",
            Ok(list_of(vec![listed("claude-code", "c1", "/w", false)])),
        );
        settle(sources.refresh(&lister)).await;

        lister
            .results
            .lock()
            .unwrap()
            .insert("codex".into(), Err(AgentRuntimeError::Timeout));
        settle(sources.refresh(&lister)).await;

        let reads = sources.reads();
        let codex = reads
            .iter()
            .find(|read| read.source == AgentAdapterKind::Codex.id())
            .unwrap();
        assert_eq!(codex.report.status, AgentSessionSourceStatus::Stale);
        assert_eq!(codex.report.kind, AgentSessionSourceKind::AcpList);
        assert_eq!(codex.sessions.len(), 1, "last good list survives");
        assert_eq!(codex.report.diagnostics[0].code, "acp-list-stale");
        let claude = reads
            .iter()
            .find(|read| read.source == AgentAdapterKind::ClaudeCode.id())
            .unwrap();
        assert_eq!(claude.report.status, AgentSessionSourceStatus::Ok);

        lister
            .results
            .lock()
            .unwrap()
            .insert("codex".into(), Ok(list_of(Vec::new())));
        settle(sources.refresh_agent(&lister, "codex")).await;
        let codex = sources
            .reads()
            .into_iter()
            .find(|read| read.source == AgentAdapterKind::Codex.id())
            .unwrap();
        assert_eq!(codex.report.status, AgentSessionSourceStatus::Ok);
        assert!(codex.sessions.is_empty());
    }

    #[tokio::test]
    async fn refresh_returns_before_the_agent_answers_and_never_reads_one_agent_twice_at_once() {
        let sources = Arc::new(AcpListSources::default());
        let gate = Arc::new(Notify::new());
        let lister = FakeLister {
            gate: Some(gate.clone()),
            ..FakeLister::default()
        };
        lister.connect(
            "codex",
            Ok(list_of(vec![listed("codex", "s1", "/w", false)])),
        );

        let first = sources.refresh(&lister);
        let second = sources.refresh(&lister);
        assert_eq!(first.len(), 1);
        assert!(second.is_empty(), "a read in flight is not repeated");
        assert!(
            sources.reads().is_empty(),
            "nothing is known before the answer"
        );

        gate.notify_one();
        settle(first).await;
        assert_eq!(lister.calls.load(Ordering::Relaxed), 1);
        assert_eq!(sources.reads()[0].sessions.len(), 1);
    }

    #[tokio::test]
    async fn a_closed_connection_keeps_the_last_list_without_starting_the_agent() {
        let sources = Arc::new(AcpListSources::default());
        let lister = FakeLister::default();
        lister.connect(
            "codex",
            Ok(list_of(vec![listed("codex", "s1", "/w", false)])),
        );
        settle(sources.refresh(&lister)).await;

        lister.connections.lock().unwrap().clear();
        let reads = sources.refresh(&lister);
        assert!(reads.is_empty());
        let read = &sources.reads()[0];
        assert_eq!(read.report.status, AgentSessionSourceStatus::Ok);
        assert_eq!(read.sessions.len(), 1);
        assert_eq!(lister.calls.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn every_agent_with_a_list_is_a_source_and_a_malformed_id_is_not_shown() {
        let sources = Arc::new(AcpListSources::default());
        let lister = FakeLister::default();
        lister.connect(
            "hermes",
            Ok(list_of(vec![listed("hermes", "h1", "/w", false)])),
        );
        lister.connect(
            "Not An Id",
            Ok(list_of(vec![listed("Not An Id", "x1", "/w", false)])),
        );
        settle(sources.refresh(&lister)).await;
        let reads = sources.reads();
        assert_eq!(reads.len(), 1);
        assert_eq!(reads[0].source.as_str(), "hermes");
        assert_eq!(reads[0].sessions.len(), 1);
    }
}

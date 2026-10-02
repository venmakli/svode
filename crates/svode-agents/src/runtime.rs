//! Session runtime: agent connections and their sessions, turns, cancel and
//! pending interactions, independent of any mounted UI surface or window.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use serde_json::value::RawValue;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite};
use tokio::process::Child;
use tokio::sync::{broadcast, mpsc};
use tokio::time::Instant;

use crate::acp::normalize::{self, Normalized};
use crate::acp::rpc::{AUTH_REQUIRED, Incoming, RpcClient, RpcError};
use crate::acp::{self};
use crate::activity::{
    Change, ConnectionState, DetailOutcome, HistorySource, HistoryState, InteractionOption,
    InteractionState, PendingInteraction, QuestionField, SessionDelta, SessionSnapshot, TurnPhase,
    WriterState,
};
use crate::catalog::{
    self, CatalogChanged, CatalogConnection, CatalogNotices, ListBounds, SessionList,
};
use crate::error::{AgentRuntimeError, SettingRefusal};
use crate::identity::SessionKey;
use crate::interaction::{self, AnswerOutcome, InteractionAnswer};
use crate::process;
use crate::projection::Projection;
use crate::status::{InteractionKind, StopReason};
use crate::writer::{
    ExternalLiveness, UnknownLiveness, Writer, WriterClaim, WriterRefusal, WriterRegistry,
};

/// Kept stderr of a starting agent, shown only when it fails to initialize.
const STDERR_TAIL_BYTES: usize = 4 * 1024;

/// Tunables of the runtime, not part of its contract.
#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    /// Bound for every agent call except a prompt, which runs until the agent
    /// answers or the user cancels.
    pub request_timeout: Duration,
    /// Bound of the whole stop sequence when the host process exits.
    pub shutdown_budget: Duration,
    pub retention: Retention,
    pub list: ListBounds,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            request_timeout: Duration::from_secs(60),
            shutdown_budget: Duration::from_secs(3),
            retention: Retention::default(),
            list: ListBounds::default(),
        }
    }
}

/// Retention bounds of session activity (Stage 10 `02` C4). Tunables with
/// provisional values until E01 measures real replays.
#[derive(Debug, Clone, Copy)]
pub struct Retention {
    /// Items one session keeps; beyond it the oldest turns are evicted.
    pub session_items: usize,
    /// Bytes of the compact items one session keeps.
    pub session_bytes: usize,
    /// Detail of one item; beyond it the detail is `too_large`.
    pub item_detail: usize,
    /// Detail of all open sessions; beyond it the least recently opened
    /// sessions release theirs.
    pub process_detail: usize,
    /// How long a session without a writer, a live turn or a subscriber is
    /// kept before it is released; opening it again replays it anew.
    pub idle_release: Duration,
}

impl Default for Retention {
    fn default() -> Self {
        Self {
            session_items: 2_000,
            session_bytes: 2 * 1024 * 1024,
            item_detail: 1024 * 1024,
            process_detail: 128 * 1024 * 1024,
            idle_release: Duration::from_secs(5 * 60),
        }
    }
}

/// How to start one agent's ACP entrypoint. One launch provenance per
/// connection: a Routine caller token in `env` never serves sessions of
/// another origin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpLaunch {
    /// Stable agent id; the identity namespace of its sessions.
    pub agent: String,
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Added to the inherited environment.
    pub env: BTreeMap<String, String>,
    pub cwd: PathBuf,
    /// Recorded evidence that ACP session ids are the agent's native ids.
    pub acp_id_is_native: bool,
    /// Recorded decision that the agent's `session/list` is its one
    /// declared catalogue source.
    pub lists_catalog: bool,
    /// Recorded evidence that `session/load` and `session/close` add no
    /// turns or messages to the agent's conversation, so its history is
    /// read without becoming the session's writer.
    pub read_only_open: bool,
    /// The error `data.reason` with which the agent refuses to attach a
    /// session another of its clients writes to.
    pub writer_refusal: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ConnectionId(pub u64);

/// A value for one declared session setting, such as the agent mode an
/// Actor approval maps to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingValue {
    pub setting: String,
    pub value: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    pub load_session: bool,
    pub list_sessions: bool,
    pub resume_session: bool,
    pub close_session: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub name: Option<String>,
    pub version: Option<String>,
    pub capabilities: AgentCapabilities,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    pub state: ConnectionState,
    pub agent: Option<AgentInfo>,
}

/// A consumer's view: the snapshot and the deltas after it. A lagging
/// receiver or a seq gap means: drop local state and subscribe again.
pub struct SessionSubscription {
    pub snapshot: SessionSnapshot,
    pub deltas: broadcast::Receiver<SessionDelta>,
}

/// Handle to the runtime; clones share one set of connections and sessions.
#[derive(Clone, Default)]
pub struct AgentRuntime {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    config: RuntimeConfig,
    next_connection: AtomicU64,
    connections: Mutex<HashMap<ConnectionId, Arc<Connection>>>,
    sessions: Mutex<HashMap<SessionKey, Arc<Session>>>,
    writers: WriterRegistry,
    /// Detail bytes held by every session of the process.
    detail_bytes: Arc<AtomicUsize>,
    /// Orders sessions by when they were last opened.
    next_open: AtomicU64,
    sweeping: AtomicBool,
    catalog: CatalogNotices,
}

struct Connection {
    runtime: Weak<Inner>,
    agent: String,
    acp_id_is_native: bool,
    lists_catalog: bool,
    read_only_open: bool,
    writer_refusal: Option<String>,
    rpc: Arc<RpcClient>,
    state: Mutex<ConnectionState>,
    info: Mutex<Option<AgentInfo>>,
    child: Mutex<Option<Child>>,
    stderr: Arc<Mutex<Vec<u8>>>,
    /// Sessions by the agent's ACP session id.
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

struct Session {
    acp_id: String,
    connection: Arc<Connection>,
    projection: Mutex<Projection>,
    /// Locked before `projection` wherever both are held.
    interactions: Mutex<Interactions>,
    next_interaction: AtomicU64,
    /// The ACP writer slot of the session while this runtime drives it;
    /// none for a session read without a writer.
    writer: Mutex<Option<WriterClaim>>,
    /// When the session was last opened, in `Inner::next_open` order.
    opened: AtomicU64,
    /// Since when nothing holds the session's data.
    idle_since: Mutex<Option<Instant>>,
}

#[derive(Default)]
struct Interactions {
    open: Option<OpenRequest>,
    /// Outcome of every resolved interaction of the session, so a repeated
    /// or stale answer learns it without a side effect.
    resolved: HashMap<String, InteractionState>,
}

/// The agent request behind the pending interaction.
struct OpenRequest {
    interaction: String,
    rpc_id: Value,
    kind: InteractionKind,
}

impl Interactions {
    fn close(&mut self, state: InteractionState) -> Option<OpenRequest> {
        let open = self.open.take()?;
        self.resolved.insert(open.interaction.clone(), state);
        Some(open)
    }
}

impl AgentRuntime {
    pub fn new(config: RuntimeConfig) -> Self {
        Self {
            inner: Arc::new(Inner {
                config,
                ..Inner::default()
            }),
        }
    }

    /// Starts the agent process and runs `initialize`. Only called on an
    /// explicit lifecycle boundary for an agent the user connected.
    pub async fn connect(&self, launch: AcpLaunch) -> Result<ConnectionId, AgentRuntimeError> {
        let mut command = tokio::process::Command::new(&launch.program);
        command
            .args(&launch.args)
            .envs(&launch.env)
            .current_dir(&launch.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        process::hide_window(&mut command);
        let mut child = command.spawn().map_err(|error| AgentRuntimeError::Spawn {
            message: error.to_string(),
        })?;
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let id = self.attach(&launch, stdout, stdin, Some(child));
        let connection = self.connection(id)?;
        let mut stderr_task = tokio::spawn(collect_stderr(stderr, connection.stderr.clone()));
        if let Err(error) = self.initialize(&connection).await {
            if error == AgentRuntimeError::ConnectionClosed {
                // An exiting agent's last words are its reason.
                let _ = tokio::time::timeout(Duration::from_millis(200), &mut stderr_task).await;
            }
            let mut message = error.to_string();
            let tail = process::bounded_text(&connection.stderr.lock().unwrap(), STDERR_TAIL_BYTES);
            if !tail.is_empty() {
                message.push_str(": ");
                message.push_str(&tail);
            }
            return Err(AgentRuntimeError::Initialize {
                connection: id,
                message,
            });
        }
        Ok(id)
    }

    /// Registers a connection over an already open transport.
    fn attach<R, W>(
        &self,
        launch: &AcpLaunch,
        reader: R,
        writer: W,
        child: Option<Child>,
    ) -> ConnectionId
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let id = ConnectionId(self.inner.next_connection.fetch_add(1, Ordering::Relaxed) + 1);
        let (rpc, incoming) = RpcClient::start(reader, writer);
        let connection = Arc::new(Connection {
            runtime: Arc::downgrade(&self.inner),
            agent: launch.agent.clone(),
            acp_id_is_native: launch.acp_id_is_native,
            lists_catalog: launch.lists_catalog,
            read_only_open: launch.read_only_open,
            writer_refusal: launch.writer_refusal.clone(),
            rpc,
            state: Mutex::new(ConnectionState::Starting),
            info: Mutex::new(None),
            child: Mutex::new(child),
            stderr: Arc::new(Mutex::new(Vec::new())),
            sessions: Mutex::new(HashMap::new()),
        });
        self.inner
            .connections
            .lock()
            .unwrap()
            .insert(id, connection.clone());
        tokio::spawn(dispatch(Arc::downgrade(&connection), incoming));
        self.start_idle_sweep();
        id
    }

    /// Releases idle sessions in the background while the runtime lives.
    fn start_idle_sweep(&self) {
        if self.inner.sweeping.swap(true, Ordering::Relaxed) {
            return;
        }
        let idle = self.inner.config.retention.idle_release;
        let every = (idle / 4).max(Duration::from_millis(10));
        let inner = Arc::downgrade(&self.inner);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(every).await;
                let Some(inner) = inner.upgrade() else {
                    return;
                };
                inner.release_idle_sessions(idle);
            }
        });
    }

    /// The process-wide writer registry; a host registers its managed PTYs
    /// here, so ACP and PTY never write to one session at once.
    pub fn writers(&self) -> WriterRegistry {
        self.inner.writers.clone()
    }

    /// One open connection per agent whose `session/list` is its declared
    /// catalogue source. Listing never starts an agent: only connections a
    /// lifecycle boundary already opened are offered.
    pub fn catalog_connections(&self) -> Vec<CatalogConnection> {
        let connections = self.inner.connections.lock().unwrap();
        let mut ids: Vec<_> = connections
            .iter()
            .filter(|(_, connection)| connection.lists_catalog && connection.is_open())
            .map(|(id, connection)| (*id, connection.agent.clone()))
            .collect();
        ids.sort();
        let mut offered: Vec<CatalogConnection> = Vec::new();
        for (connection, agent) in ids {
            if !offered.iter().any(|known| known.agent == agent) {
                offered.push(CatalogConnection { connection, agent });
            }
        }
        offered
    }

    /// Reads every page of the agent's `session/list` within the list
    /// bounds. The read shares the connection's error model: a failure or
    /// timeout degrades the connection, a lost peer closes it.
    pub async fn list_sessions(&self, id: ConnectionId) -> Result<SessionList, AgentRuntimeError> {
        let connection = self.connection(id)?;
        connection.require_open()?;
        if connection.info.lock().unwrap().is_none() {
            self.initialize(&connection).await?;
        }
        let declares_list = connection
            .info
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|info| info.capabilities.list_sessions);
        if !declares_list {
            return Err(AgentRuntimeError::ListUnsupported);
        }
        let bounds = self.inner.config.list;
        let deadline = Instant::now() + bounds.timeout;
        let mut list = SessionList::default();
        let mut keys = HashSet::new();
        let mut cursors = HashSet::new();
        let mut cursor: Option<String> = None;
        for page in 1.. {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                connection.set_state(ConnectionState::Degraded);
                return Err(AgentRuntimeError::Timeout);
            }
            let response = connection
                .call(
                    acp::SESSION_LIST,
                    acp::list_request(cursor.as_deref()),
                    Some(remaining),
                )
                .await?;
            let received = acp::list_page(response).map_err(|message| {
                connection.set_state(ConnectionState::Degraded);
                AgentRuntimeError::Protocol { message }
            })?;
            list.skipped += received.malformed;
            for entry in received.entries {
                if list.sessions.len() >= bounds.sessions {
                    list.truncated = true;
                    break;
                }
                match catalog::listed(
                    entry,
                    &connection.agent,
                    connection.acp_id_is_native,
                    &bounds,
                ) {
                    Some(session) if keys.insert(session.key.clone()) => {
                        list.sessions.push(session)
                    }
                    _ => list.skipped += 1,
                }
            }
            match received.next_cursor {
                Some(next) if !list.truncated => {
                    // A repeated cursor would page forever.
                    if page >= bounds.pages || !cursors.insert(next.clone()) {
                        list.truncated = true;
                        break;
                    }
                    cursor = Some(next);
                }
                _ => break,
            }
        }
        Ok(list)
    }

    /// Follows catalogue changes the runtime's own work causes.
    pub fn catalog_changes(&self) -> broadcast::Receiver<CatalogChanged> {
        self.inner.catalog.subscribe()
    }

    pub fn connection_status(&self, id: ConnectionId) -> Option<ConnectionStatus> {
        let connection = self.connection(id).ok()?;
        let state = *connection.state.lock().unwrap();
        let agent = connection.info.lock().unwrap().clone();
        Some(ConnectionStatus { state, agent })
    }

    /// Creates a session in `cwd` and applies `settings` before the session
    /// is handed out, so no prompt can precede them. A value the new session
    /// does not declare, or one the agent refuses, closes the session and
    /// refuses the creation. A connection that failed to initialize retries
    /// it here, at the next lifecycle boundary.
    pub async fn new_session(
        &self,
        id: ConnectionId,
        cwd: &Path,
        settings: &[SettingValue],
    ) -> Result<SessionKey, AgentRuntimeError> {
        let connection = self.connection(id)?;
        connection.require_open()?;
        if connection.info.lock().unwrap().is_none() {
            self.initialize(&connection).await?;
        }
        let response = connection
            .call(
                acp::SESSION_NEW,
                acp::new_session_request(cwd),
                self.timeout(),
            )
            .await?;
        let (acp_id, declared) = acp::new_session(response).map_err(|message| {
            connection.set_state(ConnectionState::Degraded);
            AgentRuntimeError::Protocol { message }
        })?;
        let key = SessionKey::from_acp(&connection.agent, &acp_id, connection.acp_id_is_native);
        // The agent has just created the session: no process outside this
        // connection writes to it.
        let claim = self
            .inner
            .writers
            .claim(
                &key,
                Writer::Acp,
                ExternalLiveness::Free,
                UnknownLiveness::NotConfirmed,
            )
            .map_err(|refusal| AgentRuntimeError::WriterRefused { refusal })?;
        let session = self.session_entry(
            &connection,
            &acp_id,
            key.clone(),
            Projection::live_history(),
            false,
            Some(claim),
        );
        session.projection.lock().unwrap().set_settings(declared);
        for value in settings {
            if let Err(error) = self.apply_setting(&session, value).await {
                self.close_session(&session).await;
                return Err(error);
            }
        }
        self.inner.register(key.clone(), session);
        self.inner.catalog.changed(&connection.agent);
        Ok(key)
    }

    /// Sets one declared setting and waits for the agent to confirm it.
    async fn apply_setting(
        &self,
        session: &Session,
        value: &SettingValue,
    ) -> Result<(), AgentRuntimeError> {
        let refused = |reason| AgentRuntimeError::SettingRefused {
            setting: value.setting.clone(),
            value: value.value.clone(),
            reason,
        };
        let legacy = {
            let projection = session.projection.lock().unwrap();
            let declared = projection.settings().iter().any(|setting| {
                setting.id == value.setting
                    && setting
                        .options
                        .iter()
                        .any(|option| option.value == value.value)
            });
            if !declared {
                return Err(refused(SettingRefusal::NotDeclared));
            }
            projection.legacy_modes()
        };
        let agent_refused = |error: AgentRuntimeError| match error {
            AgentRuntimeError::Agent { message } | AgentRuntimeError::Protocol { message } => {
                refused(SettingRefusal::Agent { message })
            }
            other => other,
        };
        if legacy {
            session
                .connection
                .call(
                    acp::SESSION_SET_MODE,
                    acp::set_mode_request(&session.acp_id, &value.value),
                    self.timeout(),
                )
                .await
                .map_err(agent_refused)?;
            session
                .projection
                .lock()
                .unwrap()
                .set_legacy_mode(&value.value);
        } else {
            let response = session
                .connection
                .call(
                    acp::SESSION_SET_CONFIG_OPTION,
                    acp::set_config_option_request(&session.acp_id, &value.setting, &value.value),
                    self.timeout(),
                )
                .await
                .map_err(agent_refused)?;
            let settings = acp::set_config_option_settings(response)
                .map_err(|message| refused(SettingRefusal::Agent { message }))?;
            session
                .projection
                .lock()
                .unwrap()
                .set_settings(normalize::DeclaredSettings {
                    settings,
                    legacy_modes: false,
                });
        }
        let confirmed = session
            .projection
            .lock()
            .unwrap()
            .settings()
            .iter()
            .any(|setting| setting.id == value.setting && setting.current_value == value.value);
        if confirmed {
            Ok(())
        } else {
            Err(refused(SettingRefusal::Agent {
                message: "the agent did not confirm the value".into(),
            }))
        }
    }

    /// Closes a session the runtime does not hand out: `session/close` where
    /// the agent declares it, then the session stops holding its writer.
    async fn close_session(&self, session: &Arc<Session>) {
        if session.connection.declares_close() {
            let _ = session
                .connection
                .call(
                    acp::SESSION_CLOSE,
                    acp::close_request(&session.acp_id),
                    self.timeout(),
                )
                .await;
        }
        session.end();
        session.connection.forget(&session.acp_id, session);
    }

    /// Opens an existing session of the agent on this connection so the
    /// runtime drives it: `session/load` replays its history through the
    /// one normalizer; an agent with `resume` only continues it without
    /// history. Opening never sends a prompt. The ACP writer is claimed
    /// before the agent attaches the session, with the host's evidence
    /// about external writers. A session this connection already drives is
    /// left as it is.
    pub async fn open_session(
        &self,
        id: ConnectionId,
        key: &SessionKey,
        cwd: &Path,
        liveness: ExternalLiveness,
        unknown: UnknownLiveness,
    ) -> Result<(), AgentRuntimeError> {
        let connection = self.connection(id)?;
        connection.require_open()?;
        if *key
            != SessionKey::from_acp(
                &connection.agent,
                &key.session_id,
                connection.acp_id_is_native,
            )
        {
            return Err(AgentRuntimeError::SessionNotFound);
        }
        if let Ok(open) = self.session(key)
            && Arc::ptr_eq(&open.connection, &connection)
            && open.writer.lock().unwrap().is_some()
        {
            open.opened.store(self.next_open(), Ordering::Relaxed);
            return Ok(());
        }
        if connection.info.lock().unwrap().is_none() {
            self.initialize(&connection).await?;
        }
        let capabilities = connection
            .info
            .lock()
            .unwrap()
            .as_ref()
            .map(|info| info.capabilities)
            .unwrap_or_default();
        let (method, history) = if capabilities.load_session {
            (
                acp::SESSION_LOAD,
                HistoryState {
                    source: HistorySource::Replay,
                    available: true,
                    truncated_items: None,
                },
            )
        } else if capabilities.resume_session {
            (
                acp::SESSION_RESUME,
                HistoryState {
                    source: HistorySource::None,
                    available: false,
                    truncated_items: None,
                },
            )
        } else {
            return Err(AgentRuntimeError::OpenUnsupported);
        };
        let claim = self
            .inner
            .writers
            .claim(key, Writer::Acp, liveness, unknown)
            .map_err(|refusal| AgentRuntimeError::WriterRefused { refusal })?;
        let acp_id = key.session_id.clone();
        let session = self.session_entry(
            &connection,
            &acp_id,
            key.clone(),
            history,
            method == acp::SESSION_LOAD,
            Some(claim),
        );
        let result = connection
            .call(
                method,
                acp::open_session_request(&acp_id, cwd),
                self.timeout(),
            )
            .await;
        // The replay arrives before the answer; apply all of it first.
        connection.rpc.barrier().await;
        match result {
            Ok(response) => {
                let mut projection = session.projection.lock().unwrap();
                projection.end_replay();
                if let Some(declared) = acp::opened_session_settings(response) {
                    projection.set_settings(declared);
                }
                drop(projection);
                self.inner.register(key.clone(), session);
                Ok(())
            }
            Err(error) => {
                connection.forget(&acp_id, &session);
                Err(error)
            }
        }
    }

    /// Reads the history of an existing session without becoming its
    /// writer: `session/load` replays it through the one normalizer, then
    /// `session/close` detaches it where the agent declares `close`. No
    /// prompt is sent. Only for an agent with recorded evidence that load
    /// and close add no turns or messages; another process writing to the
    /// session does not prevent it unless the agent itself refuses. The
    /// snapshot does not follow the session afterwards: reading it again
    /// replays it anew. A session this runtime drives is left as it is.
    pub async fn read_session(
        &self,
        id: ConnectionId,
        key: &SessionKey,
        cwd: &Path,
    ) -> Result<(), AgentRuntimeError> {
        let connection = self.connection(id)?;
        connection.require_open()?;
        if *key
            != SessionKey::from_acp(
                &connection.agent,
                &key.session_id,
                connection.acp_id_is_native,
            )
        {
            return Err(AgentRuntimeError::SessionNotFound);
        }
        if let Ok(open) = self.session(key)
            && open.writer.lock().unwrap().is_some()
        {
            open.opened.store(self.next_open(), Ordering::Relaxed);
            return Ok(());
        }
        if !connection.read_only_open {
            return Err(AgentRuntimeError::ReadOnlyUnsupported);
        }
        if connection.info.lock().unwrap().is_none() {
            self.initialize(&connection).await?;
        }
        let loads = connection
            .info
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|info| info.capabilities.load_session);
        if !loads {
            return Err(AgentRuntimeError::ReadOnlyUnsupported);
        }
        let acp_id = key.session_id.clone();
        let session = self.session_entry(
            &connection,
            &acp_id,
            key.clone(),
            HistoryState {
                source: HistorySource::Replay,
                available: true,
                truncated_items: None,
            },
            true,
            None,
        );
        let result = connection
            .call(
                acp::SESSION_LOAD,
                acp::open_session_request(&acp_id, cwd),
                self.timeout(),
            )
            .await;
        connection.rpc.barrier().await;
        // Nothing the agent sends after the replay belongs to this reading.
        connection.forget(&acp_id, &session);
        let response = result?;
        {
            let mut projection = session.projection.lock().unwrap();
            projection.end_replay();
            if let Some(declared) = acp::opened_session_settings(response) {
                projection.set_settings(declared);
            }
        }
        if connection.declares_close() {
            // A failed close leaves the session attached and idle, as an
            // agent without `close` does; the history is read either way.
            let _ = connection
                .call(
                    acp::SESSION_CLOSE,
                    acp::close_request(&acp_id),
                    self.timeout(),
                )
                .await;
        }
        self.inner.register(key.clone(), session);
        Ok(())
    }

    /// A session of `connection` that holds `claim`, if any, and receives
    /// its updates from now on.
    fn session_entry(
        &self,
        connection: &Arc<Connection>,
        acp_id: &str,
        key: SessionKey,
        history: HistoryState,
        replay: bool,
        claim: Option<WriterClaim>,
    ) -> Arc<Session> {
        let state = *connection.state.lock().unwrap();
        let writer = if claim.is_some() {
            WriterState::Acp
        } else {
            WriterState::None
        };
        let session = Arc::new(Session {
            acp_id: acp_id.to_string(),
            connection: connection.clone(),
            projection: Mutex::new(Projection::new(
                key,
                state,
                history,
                replay,
                writer,
                self.inner.config.retention,
                self.inner.detail_bytes.clone(),
            )),
            interactions: Mutex::new(Interactions::default()),
            next_interaction: AtomicU64::new(0),
            writer: Mutex::new(claim),
            opened: AtomicU64::new(self.next_open()),
            idle_since: Mutex::new(None),
        });
        connection
            .sessions
            .lock()
            .unwrap()
            .insert(acp_id.to_string(), session.clone());
        session
    }

    fn next_open(&self) -> u64 {
        self.inner.next_open.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// Accepts a prompt and returns the turn id at once; the runtime owns the
    /// call, so a lost caller does not lose the prompt.
    pub fn prompt(&self, key: &SessionKey, text: &str) -> Result<String, AgentRuntimeError> {
        let session = self.session(key)?;
        session.connection.require_open()?;
        if session.writer.lock().unwrap().is_none() {
            return Err(AgentRuntimeError::WriterRequired);
        }
        let turn_id = ulid::Ulid::new().to_string().to_ascii_lowercase();
        session
            .projection
            .lock()
            .unwrap()
            .begin_turn(&turn_id, text)
            .ok_or(AgentRuntimeError::TurnActive)?;
        self.inner.enforce_detail_bound();
        let request = acp::prompt_request(&session.acp_id, text);
        let turn = turn_id.clone();
        tokio::spawn(async move {
            let (reason, error) = match session
                .connection
                .call(acp::SESSION_PROMPT, request, None)
                .await
            {
                Ok(response) => match normalize::stop_reason(response) {
                    Ok(reason) => (reason, None),
                    Err(message) => {
                        session.connection.set_state(ConnectionState::Degraded);
                        (StopReason::Error, Some(message))
                    }
                },
                Err(AgentRuntimeError::ConnectionClosed) => (StopReason::Interrupted, None),
                Err(error) => (StopReason::Error, Some(error.to_string())),
            };
            let mut interactions = session.interactions.lock().unwrap();
            interactions.close(Projection::pending_outcome(reason));
            session
                .projection
                .lock()
                .unwrap()
                .finish_turn(&turn, reason, error);
            drop(interactions);
            if let Some(inner) = session.connection.runtime.upgrade() {
                inner.catalog.changed(&session.connection.agent);
            }
        });
        Ok(turn_id)
    }

    /// Requests cancellation of the active turn: answers the pending request
    /// `cancelled` and keeps the turn `cancelling` until the agent answers
    /// the prompt or the connection drops. No-op without an active turn.
    pub fn cancel(&self, key: &SessionKey) -> Result<(), AgentRuntimeError> {
        self.session(key)?.cancel();
        Ok(())
    }

    /// Answers the pending interaction `interaction` once. Any other call —
    /// a repeat, a stale surface, an unknown id — gets `not_pending` with the
    /// interaction's state and sends nothing. An answer that does not fit
    /// the request is refused and the request stays pending.
    pub fn answer(
        &self,
        key: &SessionKey,
        interaction: &str,
        answer: InteractionAnswer,
    ) -> Result<AnswerOutcome, AgentRuntimeError> {
        let session = self.session(key)?;
        let mut interactions = session.interactions.lock().unwrap();
        if interactions
            .open
            .as_ref()
            .is_none_or(|open| open.interaction != interaction)
        {
            return Ok(AnswerOutcome::NotPending {
                state: interactions.resolved.get(interaction).copied(),
            });
        }
        let mut projection = session.projection.lock().unwrap();
        let pending = projection
            .pending()
            .expect("an open request is the pending interaction");
        interaction::validate(pending, &answer)
            .map_err(|message| AgentRuntimeError::InvalidAnswer { message })?;
        let open = interactions
            .close(InteractionState::Answered)
            .expect("checked above");
        session
            .connection
            .rpc
            .respond(open.rpc_id, acp::answer(&answer));
        projection.resolve_pending(&open.interaction, InteractionState::Answered);
        Ok(AnswerOutcome::Accepted)
    }

    /// Opening a session in a surface: it becomes the most recently opened
    /// one for the process detail bound.
    pub fn subscribe(&self, key: &SessionKey) -> Result<SessionSubscription, AgentRuntimeError> {
        let session = self.session(key)?;
        session.opened.store(self.next_open(), Ordering::Relaxed);
        let subscription = session.projection.lock().unwrap().subscribe();
        Ok(SessionSubscription {
            snapshot: subscription.snapshot,
            deltas: subscription.deltas,
        })
    }

    pub fn detail(&self, key: &SessionKey, item_id: &str) -> DetailOutcome {
        match self.session(key) {
            Ok(session) => session.projection.lock().unwrap().detail(item_id),
            Err(error) => DetailOutcome::Error {
                message: error.to_string(),
            },
        }
    }

    /// Stops the agent process; its sessions end their turns `interrupted`.
    pub async fn close_connection(&self, id: ConnectionId) -> Result<(), AgentRuntimeError> {
        self.connection(id)?.terminate().await;
        Ok(())
    }

    /// Stops every managed connection when the host process exits, within
    /// the shutdown budget: each live turn gets `session/cancel` and a
    /// bounded wait for the agent's answer, then every session is closed
    /// where the agent declared `close`, then the agent process ends.
    pub async fn shutdown(&self) {
        let deadline = Instant::now() + self.inner.config.shutdown_budget;
        let connections: Vec<_> = self
            .inner
            .connections
            .lock()
            .unwrap()
            .values()
            .filter(|connection| connection.is_open())
            .cloned()
            .collect();
        let live: Vec<_> = connections
            .iter()
            .flat_map(|connection| connection.sessions())
            .filter(|session| session.projection.lock().unwrap().turn_active())
            .collect();
        for session in &live {
            session.cancel();
        }
        for session in &live {
            let _ = tokio::time::timeout_at(deadline, session.turn_end()).await;
        }
        for connection in &connections {
            if connection.declares_close() {
                for session in connection.sessions() {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        break;
                    }
                    if connection
                        .call(
                            acp::SESSION_CLOSE,
                            acp::close_request(&session.acp_id),
                            Some(remaining),
                        )
                        .await
                        .is_ok()
                    {
                        session.end();
                    }
                }
            }
            connection.terminate().await;
        }
    }

    async fn initialize(&self, connection: &Connection) -> Result<(), AgentRuntimeError> {
        let response = connection
            .call(acp::INITIALIZE, acp::initialize_request(), self.timeout())
            .await?;
        let info = acp::agent_info(response).map_err(|message| {
            connection.set_state(ConnectionState::Degraded);
            AgentRuntimeError::Protocol { message }
        })?;
        *connection.info.lock().unwrap() = Some(info);
        connection.set_state(ConnectionState::Ready);
        Ok(())
    }

    fn timeout(&self) -> Option<Duration> {
        Some(self.inner.config.request_timeout)
    }

    fn connection(&self, id: ConnectionId) -> Result<Arc<Connection>, AgentRuntimeError> {
        self.inner
            .connections
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .ok_or(AgentRuntimeError::ConnectionNotFound)
    }

    fn session(&self, key: &SessionKey) -> Result<Arc<Session>, AgentRuntimeError> {
        self.inner
            .sessions
            .lock()
            .unwrap()
            .get(key)
            .cloned()
            .ok_or(AgentRuntimeError::SessionNotFound)
    }
}

impl Inner {
    /// Makes `session` the one the runtime serves under `key`; a replaced
    /// session of a closed connection stops holding its data.
    fn register(&self, key: SessionKey, session: Arc<Session>) {
        let replaced = self.sessions.lock().unwrap().insert(key, session.clone());
        if let Some(old) = replaced.filter(|old| !Arc::ptr_eq(old, &session)) {
            old.connection.forget(&old.acp_id, &old);
        }
    }

    /// Releases detail of the least recently opened sessions, oldest items
    /// first, while the process is over its detail bound.
    fn enforce_detail_bound(&self) {
        let bound = self.config.retention.process_detail;
        if self.detail_bytes.load(Ordering::Relaxed) <= bound {
            return;
        }
        let connections: Vec<_> = self.connections.lock().unwrap().values().cloned().collect();
        let mut sessions: Vec<_> = connections
            .iter()
            .flat_map(|connection| connection.sessions())
            .collect();
        sessions.sort_by_key(|session| session.opened.load(Ordering::Relaxed));
        for session in sessions {
            let over = self
                .detail_bytes
                .load(Ordering::Relaxed)
                .saturating_sub(bound);
            if over == 0 {
                return;
            }
            session.projection.lock().unwrap().release_detail(over);
        }
    }

    /// Drops sessions nothing has held for `idle`: no managed writer, no
    /// live turn and no subscriber.
    fn release_idle_sessions(&self, idle: Duration) {
        let now = Instant::now();
        let known: Vec<(SessionKey, Arc<Session>)> = self
            .sessions
            .lock()
            .unwrap()
            .iter()
            .map(|(key, session)| (key.clone(), session.clone()))
            .collect();
        for (key, session) in known {
            if session.idle_for(now) < idle {
                continue;
            }
            let mut sessions = self.sessions.lock().unwrap();
            if sessions
                .get(&key)
                .is_some_and(|known| Arc::ptr_eq(known, &session))
            {
                sessions.remove(&key);
            }
            drop(sessions);
            session.connection.forget(&session.acp_id, &session);
        }
    }
}

impl Session {
    /// How long nothing has held the session's data; zero while its writer,
    /// a live turn or a subscriber does.
    fn idle_for(&self, now: Instant) -> Duration {
        let writer = self.writer.lock().unwrap().is_some();
        let held = writer || {
            let projection = self.projection.lock().unwrap();
            projection.turn_active() || projection.subscribers() > 0
        };
        let mut idle_since = self.idle_since.lock().unwrap();
        if held {
            *idle_since = None;
            return Duration::ZERO;
        }
        now - *idle_since.get_or_insert(now)
    }

    /// Requests cancellation of the active turn: answers the pending request
    /// `cancelled` and keeps the turn `cancelling` until the agent answers
    /// the prompt or the connection drops. No-op without an active turn.
    fn cancel(&self) {
        let mut interactions = self.interactions.lock().unwrap();
        let mut projection = self.projection.lock().unwrap();
        if !projection.turn_active() {
            return;
        }
        projection.cancelling();
        if let Some(open) = interactions.close(InteractionState::Cancelled) {
            self.connection
                .rpc
                .respond(open.rpc_id, acp::cancelled(open.kind));
            projection.resolve_pending(&open.interaction, InteractionState::Cancelled);
        }
        drop(projection);
        drop(interactions);
        self.connection
            .rpc
            .notify(acp::SESSION_CANCEL, acp::cancel_notification(&self.acp_id));
    }

    /// Resolves once no turn is active.
    async fn turn_end(&self) {
        let mut deltas = {
            let projection = self.projection.lock().unwrap();
            if !projection.turn_active() {
                return;
            }
            projection.subscribe().deltas
        };
        loop {
            match deltas.recv().await {
                Ok(delta) => {
                    if matches!(delta.change, Change::Turn(ref turn) if turn.phase == TurnPhase::None)
                    {
                        return;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    if !self.projection.lock().unwrap().turn_active() {
                        return;
                    }
                }
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    }

    /// The connection or the session is gone: the active turn ends
    /// `interrupted`, an open request expires and the writer slot is free.
    fn end(&self) {
        let mut interactions = self.interactions.lock().unwrap();
        interactions.close(InteractionState::Expired);
        let mut projection = self.projection.lock().unwrap();
        projection.interrupt();
        self.writer.lock().unwrap().take();
        projection.set_writer(WriterState::None);
    }
}

impl Connection {
    /// One agent call. Success restores a degraded connection; an error or
    /// timeout degrades it; a lost peer closes it.
    async fn call(
        &self,
        method: &str,
        params: Value,
        timeout: Option<Duration>,
    ) -> Result<Value, AgentRuntimeError> {
        match self.rpc.request(method, params, timeout).await {
            Ok(value) => {
                self.set_state(ConnectionState::Ready);
                Ok(value)
            }
            // Auth is a recovery outcome of the connection, not a failure.
            Err(RpcError::Remote {
                code: AUTH_REQUIRED,
                message,
                ..
            }) => Err(AgentRuntimeError::AuthRequired { message }),
            // The agent's own evidence of another writer is a refusal like
            // Svode's, not a failure of the connection.
            Err(RpcError::Remote {
                reason: Some(reason),
                ..
            }) if self.writer_refusal.as_deref() == Some(reason.as_str()) => {
                self.set_state(ConnectionState::Ready);
                Err(AgentRuntimeError::WriterRefused {
                    refusal: WriterRefusal::ExternalActive,
                })
            }
            Err(RpcError::Remote { message, .. }) => {
                self.set_state(ConnectionState::Degraded);
                Err(AgentRuntimeError::Agent { message })
            }
            Err(RpcError::Timeout) => {
                self.set_state(ConnectionState::Degraded);
                Err(AgentRuntimeError::Timeout)
            }
            Err(RpcError::Closed) => {
                self.close();
                Err(AgentRuntimeError::ConnectionClosed)
            }
        }
    }

    fn is_open(&self) -> bool {
        *self.state.lock().unwrap() != ConnectionState::Closed
    }

    fn declares_close(&self) -> bool {
        self.info
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|info| info.capabilities.close_session)
    }

    /// Ends the agent process and closes the connection.
    async fn terminate(&self) {
        let child = self.child.lock().unwrap().take();
        if let Some(mut child) = child {
            let _ = child.kill().await;
        }
        self.close();
    }

    fn require_open(&self) -> Result<(), AgentRuntimeError> {
        match *self.state.lock().unwrap() {
            ConnectionState::Closed => Err(AgentRuntimeError::ConnectionClosed),
            _ => Ok(()),
        }
    }

    /// `closed` is final; a later success does not reopen the connection.
    fn set_state(&self, state: ConnectionState) {
        {
            let mut current = self.state.lock().unwrap();
            if *current == state || *current == ConnectionState::Closed {
                return;
            }
            *current = state;
        }
        for session in self.sessions() {
            session.projection.lock().unwrap().set_connection(state);
        }
    }

    /// The peer is gone: turns end `interrupted`, pending requests expire.
    fn close(&self) {
        {
            let mut current = self.state.lock().unwrap();
            if *current == ConnectionState::Closed {
                return;
            }
            *current = ConnectionState::Closed;
        }
        for session in self.sessions() {
            session
                .projection
                .lock()
                .unwrap()
                .set_connection(ConnectionState::Closed);
            session.end();
        }
    }

    fn sessions(&self) -> Vec<Arc<Session>> {
        self.sessions.lock().unwrap().values().cloned().collect()
    }

    fn session(&self, acp_id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().unwrap().get(acp_id).cloned()
    }

    /// Stops routing updates to `session` unless another session of the
    /// same id has replaced it.
    fn forget(&self, acp_id: &str, session: &Arc<Session>) {
        let mut sessions = self.sessions.lock().unwrap();
        if sessions
            .get(acp_id)
            .is_some_and(|known| Arc::ptr_eq(known, session))
        {
            sessions.remove(acp_id);
        }
    }
}

async fn dispatch(connection: Weak<Connection>, mut incoming: mpsc::UnboundedReceiver<Incoming>) {
    while let Some(message) = incoming.recv().await {
        let Some(connection) = connection.upgrade() else {
            return;
        };
        match message {
            Incoming::Notification { method, params } if method == acp::SESSION_UPDATE => {
                let Some((acp_id, normalized)) = normalize::session_update(params) else {
                    continue;
                };
                if let Some(session) = connection.session(&acp_id) {
                    apply(&session, normalized);
                    if let Some(runtime) = connection.runtime.upgrade() {
                        runtime.enforce_detail_bound();
                    }
                }
            }
            Incoming::Notification { .. } => {}
            Incoming::Barrier(done) => {
                let _ = done.send(());
            }
            Incoming::Request { id, method, params }
                if method == acp::SESSION_REQUEST_PERMISSION =>
            {
                request_permission(&connection, id, &params);
            }
            Incoming::Request { id, method, params } if method == acp::ELICITATION_CREATE => {
                request_question(&connection, id, &params);
            }
            Incoming::Request { id, method, .. } => {
                connection.rpc.respond_method_not_found(id, &method);
            }
        }
    }
    if let Some(connection) = connection.upgrade() {
        connection.close();
    }
}

fn apply(session: &Session, normalized: Normalized) {
    session.projection.lock().unwrap().apply(normalized);
}

fn request_permission(connection: &Connection, id: Value, params: &RawValue) {
    match normalize::permission_request(params.get()) {
        Ok(request) => open_interaction(
            connection,
            id,
            &request.session_id,
            InteractionKind::Permission,
            request.title,
            request.options,
            Vec::new(),
        ),
        Err(_) => connection.rpc.respond(id, acp::permission_cancelled()),
    }
}

/// A form the model does not express is answered `cancel` at once and
/// named in its session's activity.
fn request_question(connection: &Connection, id: Value, params: &RawValue) {
    match normalize::question_request(params.get()) {
        Ok(request) => open_interaction(
            connection,
            id,
            &request.session_id,
            InteractionKind::Question,
            request.title,
            Vec::new(),
            request.fields,
        ),
        Err(unsupported) => {
            connection.rpc.respond(id, acp::question_cancelled());
            if let Some(session) = unsupported
                .session_id
                .and_then(|session_id| connection.session(&session_id))
            {
                apply(&session, Normalized::Generic(unsupported.reason));
            }
        }
    }
}

/// Keeps an agent request pending in the session until the user answers
/// it, the turn is cancelled or the connection is lost. A second concurrent
/// request, or one for an unknown session, is answered `cancel`.
fn open_interaction(
    connection: &Connection,
    id: Value,
    session_id: &str,
    kind: InteractionKind,
    title: String,
    options: Vec<InteractionOption>,
    fields: Vec<QuestionField>,
) {
    let Some(session) = connection.session(session_id) else {
        connection.rpc.respond(id, acp::cancelled(kind));
        return;
    };
    let mut interactions = session.interactions.lock().unwrap();
    if interactions.open.is_some() {
        connection.rpc.respond(id, acp::cancelled(kind));
        return;
    }
    let interaction = format!(
        "interaction:{}",
        session.next_interaction.fetch_add(1, Ordering::Relaxed) + 1
    );
    interactions.open = Some(OpenRequest {
        interaction: interaction.clone(),
        rpc_id: id,
        kind,
    });
    session
        .projection
        .lock()
        .unwrap()
        .set_pending(PendingInteraction {
            id: interaction,
            kind,
            title,
            options,
            fields,
            state: InteractionState::Pending,
        });
}

async fn collect_stderr(stderr: impl AsyncRead + Unpin, tail: Arc<Mutex<Vec<u8>>>) {
    let mut stderr = stderr;
    let mut buffer = [0u8; 1024];
    while let Ok(read) = stderr.read(&mut buffer).await {
        if read == 0 {
            break;
        }
        let mut tail = tail.lock().unwrap();
        tail.extend_from_slice(&buffer[..read]);
        if tail.len() > STDERR_TAIL_BYTES {
            let excess = tail.len() - STDERR_TAIL_BYTES;
            tail.drain(..excess);
        }
    }
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;

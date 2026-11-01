//! Session runtime: agent connections and their sessions, turns, cancel and
//! pending interactions, independent of any mounted UI surface or window.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use serde_json::value::RawValue;
use svode_core::agent_adapters::AgentAdapterKind;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite};
use tokio::sync::{broadcast, mpsc};
use tokio::time::Instant;

use crate::acp::normalize::{self, Normalized};
use crate::acp::rpc::{AUTH_REQUIRED, Incoming, RpcClient, RpcError};
use crate::acp::{self};
use crate::activity::{
    Change, ConnectionState, DetailOutcome, HistorySource, HistoryState, InteractionOption,
    InteractionState, MediaOutcome, PendingInteraction, QuestionField, SessionDelta,
    SessionSnapshot, SettingCategory, TurnPhase, WriterState,
};
use crate::adapters::LaunchUnavailable;
use crate::catalog::{
    self, CatalogChanged, CatalogConnection, CatalogNotices, ListBounds, RuntimeSession,
    SessionList,
};
use crate::drafts::{AgentDeclaration, DraftHost, DraftSession, LastDeclarations, PendingDeletion};
use crate::error::{AgentRuntimeError, SettingRefusal};
use crate::identity::SessionKey;
use crate::interaction::{self, AnswerOutcome, InteractionAnswer};
use crate::process::{self, ProcessTree};
use crate::projection::Projection;
use crate::prompt::{self, PromptPart};
use crate::status::{InteractionKind, StopReason};
use crate::turns::{TurnBoundary, TurnEnded, TurnMark, TurnObserver};
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
    /// How long a connection nothing needs stays open before it closes: no
    /// lease, no live turn and no session open in a surface. An agent
    /// process with an open session takes 0.5–1.1 GiB (E01).
    pub connection_idle: Duration,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            request_timeout: Duration::from_secs(60),
            shutdown_budget: Duration::from_secs(3),
            retention: Retention::default(),
            list: ListBounds::default(),
            connection_idle: Duration::from_secs(2 * 60),
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
    /// Detail of one item; beyond it text keeps its head and tail and other
    /// detail is `too_large`. The text of an agent message is held whole.
    pub item_detail: usize,
    /// Data of one media segment without a file; beyond it the segment
    /// stays and its data is `too_large`.
    pub media_item: usize,
    /// Detail of all open sessions; beyond it the least recently opened
    /// sessions release theirs, except the text of agent messages.
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
            media_item: 16 * 1024 * 1024,
            process_detail: 128 * 1024 * 1024,
            idle_release: Duration::from_secs(5 * 60),
        }
    }
}

/// How to start one agent's ACP entrypoint. One launch provenance per
/// connection: a Routine caller token in `env` never serves sessions of
/// another origin.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpLaunch {
    /// Stable agent id; the identity namespace of its sessions.
    pub agent: String,
    pub program: PathBuf,
    pub args: Vec<String>,
    /// The whole environment of the process; `None` inherits the host's.
    #[serde(skip)]
    pub environment: Option<LaunchEnvironment>,
    /// Added on top of the environment: the variables of the agent's
    /// description and of the launch provenance.
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
    /// Recorded evidence that loading and closing a session while another
    /// process may run a turn in it write nothing to the agent's store and
    /// leave that turn as it is, or that the agent refuses without writing
    /// (DF-177 R1). Without it such a session is not read.
    pub reads_during_external_turn: bool,
    /// The error `data.reason` with which the agent refuses to attach a
    /// session another of its clients writes to.
    pub writer_refusal: Option<String>,
    /// Recorded evidence that the agent serves one session per connection
    /// and lists differently once a session ran on it: a connection that
    /// created, opened or read a session serves only that one and is no
    /// longer the plan's shared or catalogue connection.
    pub session_per_connection: bool,
    /// Recorded evidence that the agent keeps a session it created, opened
    /// or read in the memory of its process and serves or writes that copy
    /// on the next load of the session there (DF-177 R3). Its connection
    /// serves only that one session, so once Svode no longer drives the
    /// session it is loaded again only by another process.
    pub keeps_loaded_sessions: bool,
    /// What the agent's recorded evidence allows for a session created
    /// without a prompt (Stage 11 `03`, E6): a draft of a new session, an
    /// Actor binding or the device's default agent then shows the settings
    /// and commands the agent declares for it.
    pub draft_session: DraftSession,
}

/// The user's login shell environment a host captured for agent processes
/// (Stage 10 `03` A1). It lives only in memory; its debug output names no
/// variable, so it never reaches logs or diagnostics.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct LaunchEnvironment(Arc<BTreeMap<OsString, OsString>>);

impl LaunchEnvironment {
    pub fn new(variables: impl IntoIterator<Item = (OsString, OsString)>) -> Self {
        Self(Arc::new(variables.into_iter().collect()))
    }

    pub fn get(&self, name: &str) -> Option<&OsStr> {
        self.0.get(OsStr::new(name)).map(OsString::as_os_str)
    }
}

impl fmt::Debug for LaunchEnvironment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "LaunchEnvironment({} variables)", self.0.len())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ConnectionId(pub u64);

/// Keeps a connection open: while a lease lives the connection never
/// closes for idleness. A host holds one for as long as a lifecycle
/// boundary needs the agent, such as an open Sessions collection or a
/// running launch.
pub struct ConnectionLease {
    id: ConnectionId,
    connection: Arc<Connection>,
}

impl ConnectionLease {
    fn new(id: ConnectionId, connection: Arc<Connection>) -> Self {
        connection.holds.fetch_add(1, Ordering::SeqCst);
        Self { id, connection }
    }

    pub fn connection(&self) -> ConnectionId {
        self.id
    }

    pub fn is_open(&self) -> bool {
        self.connection.is_open()
    }
}

impl Drop for ConnectionLease {
    fn drop(&mut self) {
        self.connection.holds.fetch_sub(1, Ordering::SeqCst);
    }
}

impl fmt::Debug for ConnectionLease {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ConnectionLease")
            .field("connection", &self.id)
            .field("agent", &self.connection.agent)
            .finish()
    }
}

/// Result of the user's explicit check of an agent: start, `initialize`,
/// close. Each outcome is recoverable on its own (Stage 10 `03` A1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AgentCheck {
    /// The agent started and declared these capabilities.
    Ready { agent: AgentInfo },
    /// The agent is not available, so nothing was started.
    Unavailable { reason: LaunchUnavailable },
    /// The agent needs its own sign-in.
    AuthRequired { message: String },
    /// The process, `initialize` or its timeout failed; the message carries
    /// the bounded diagnostics.
    FailedToStart { message: String },
}

/// A value for one declared session setting, in the agent's terms.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingValue {
    pub setting: String,
    pub value: String,
}

/// The values a Routine launch applies to its session before the first
/// prompt (Stage 11 `03`, «Запуск Рутины»): the portable values of the
/// Actor's catalog, and those of this device — the Actor mode, or every
/// value of the device's default agent.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LaunchValues {
    pub portable: Vec<SettingValue>,
    pub device: Vec<SettingValue>,
}

/// A launch session refused before its first prompt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchRefused {
    pub error: AgentRuntimeError,
    /// The empty session the agent keeps in its list without an ACP
    /// deletion (Stage 11 `03`, E6): it stays the session of the launch.
    pub left: Option<SessionKey>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    pub load_session: bool,
    pub list_sessions: bool,
    pub resume_session: bool,
    pub close_session: bool,
    /// The agent declares ACP `session/delete`.
    #[serde(default)]
    pub delete_session: bool,
    /// The agent takes image blocks in a prompt.
    pub image_prompt: bool,
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
    /// The connection of each launch plan; acquiring and idle closing of
    /// one plan take its lock, other agents are never waited for.
    slots: Mutex<HashMap<AcpLaunch, Slot>>,
    /// What each agent declared in its last `initialize` of this process.
    declared: Mutex<HashMap<String, AgentInfo>>,
    /// The host that hears turn boundaries.
    turns: Mutex<Option<Arc<dyn TurnObserver>>>,
    /// What the agents declared last on this device, per agent and model.
    declarations: Mutex<LastDeclarations>,
    /// Draft sessions to delete once their agent connects again.
    pending_deletions: Mutex<Vec<PendingDeletion>>,
    /// The host that keeps declarations and pending deletions.
    draft_host: Mutex<Option<Arc<dyn DraftHost>>>,
}

type Slot = Arc<tokio::sync::Mutex<Option<ConnectionId>>>;

struct Connection {
    runtime: Weak<Inner>,
    agent: String,
    acp_id_is_native: bool,
    lists_catalog: bool,
    read_only_open: bool,
    reads_during_external_turn: bool,
    writer_refusal: Option<String>,
    session_per_connection: bool,
    draft_session: DraftSession,
    /// A connection of an agent with one session per connection that has
    /// served its session.
    taken: AtomicBool,
    rpc: Arc<RpcClient>,
    state: Mutex<ConnectionState>,
    info: Mutex<Option<AgentInfo>>,
    /// The agent process with its descendants until the connection closes.
    process: tokio::sync::Mutex<Option<ProcessTree>>,
    stderr: Arc<Mutex<Vec<u8>>>,
    /// Sessions by the agent's ACP session id.
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    /// Leases a host holds.
    holds: AtomicUsize,
    /// Since when nothing needs the connection.
    idle_since: Mutex<Option<Instant>>,
    /// The launch plan slot of a connection a host acquired.
    slot: Mutex<Option<Slot>>,
}

struct Session {
    acp_id: String,
    connection: Arc<Connection>,
    cwd: PathBuf,
    started_at: SystemTime,
    /// The first prompt of a session this runtime created, once accepted;
    /// an opened session is in the catalogue without one.
    first_prompt: Mutex<Option<String>>,
    /// A session this runtime created enters the catalogue with its first
    /// accepted prompt, an opened one from its opening.
    listed: AtomicBool,
    /// This runtime created the session and no prompt went to it yet.
    unprompted: AtomicBool,
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
        if let Some(environment) = &launch.environment {
            command.env_clear().envs(environment.0.iter());
        }
        command
            .args(&launch.args)
            .envs(&launch.env)
            .current_dir(&launch.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut tree =
            ProcessTree::spawn(&mut command).map_err(|error| AgentRuntimeError::Spawn {
                message: error.to_string(),
            })?;
        let child = tree.child();
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let id = self.attach(&launch, stdout, stdin, Some(tree));
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
        process: Option<ProcessTree>,
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
            reads_during_external_turn: launch.reads_during_external_turn,
            writer_refusal: launch.writer_refusal.clone(),
            // A process that keeps its loaded sessions never loads one of
            // them again (DF-177 R3).
            session_per_connection: launch.session_per_connection || launch.keeps_loaded_sessions,
            draft_session: launch.draft_session,
            taken: AtomicBool::new(false),
            rpc,
            state: Mutex::new(ConnectionState::Starting),
            info: Mutex::new(None),
            process: tokio::sync::Mutex::new(process),
            stderr: Arc::new(Mutex::new(Vec::new())),
            sessions: Mutex::new(HashMap::new()),
            holds: AtomicUsize::new(0),
            idle_since: Mutex::new(None),
            slot: Mutex::new(None),
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

    /// Releases idle sessions and closes idle connections in the
    /// background while the runtime lives.
    fn start_idle_sweep(&self) {
        if self.inner.sweeping.swap(true, Ordering::Relaxed) {
            return;
        }
        let idle = self.inner.config.retention.idle_release;
        let connection_idle = self.inner.config.connection_idle;
        let every = (idle.min(connection_idle) / 4).max(Duration::from_millis(10));
        let inner = Arc::downgrade(&self.inner);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(every).await;
                let Some(inner) = inner.upgrade() else {
                    return;
                };
                inner.release_idle_sessions(idle);
                inner.close_idle_connections(connection_idle).await;
            }
        });
    }

    /// A connection for `launch`, held while the lease lives: the open one
    /// started from the same launch plan, or a new one. Launch provenance
    /// is part of the plan, so a launch with its own caller token or
    /// executable never shares a connection with sessions of another
    /// origin. Only called on an explicit lifecycle boundary for an
    /// available agent. An agent that fails to start leaves no process.
    pub async fn acquire(&self, launch: AcpLaunch) -> Result<ConnectionLease, AgentRuntimeError> {
        let slot = self.slot(&launch);
        let mut current = slot.lock().await;
        self.acquire_in(&slot, &mut current, launch).await
    }

    /// The user's explicit check of an agent: starts it unless its launch
    /// plan already has an open connection, runs `initialize` and closes
    /// the connection right away unless something else needs it.
    pub async fn check(&self, launch: AcpLaunch) -> AgentCheck {
        let slot = self.slot(&launch);
        let mut current = slot.lock().await;
        let lease = match self.acquire_in(&slot, &mut current, launch).await {
            Ok(lease) => lease,
            Err(AgentRuntimeError::AuthRequired { message }) => {
                return AgentCheck::AuthRequired { message };
            }
            Err(error) => {
                return AgentCheck::FailedToStart {
                    message: error.to_string(),
                };
            }
        };
        let info = lease.connection.info.lock().unwrap().clone();
        let connection = lease.connection.clone();
        drop(lease);
        if !connection.needed() {
            connection.terminate().await;
        }
        match info {
            Some(agent) => AgentCheck::Ready { agent },
            None => AgentCheck::FailedToStart {
                message: AgentRuntimeError::ConnectionClosed.to_string(),
            },
        }
    }

    fn slot(&self, launch: &AcpLaunch) -> Slot {
        self.inner
            .slots
            .lock()
            .unwrap()
            .entry(launch.clone())
            .or_default()
            .clone()
    }

    async fn acquire_in(
        &self,
        slot: &Slot,
        current: &mut Option<ConnectionId>,
        launch: AcpLaunch,
    ) -> Result<ConnectionLease, AgentRuntimeError> {
        if let Some(id) = *current
            && let Ok(connection) = self.connection(id)
            && connection.is_open()
        {
            return Ok(ConnectionLease::new(id, connection));
        }
        match self.connect(launch).await {
            Ok(id) => {
                let connection = self.connection(id)?;
                *connection.slot.lock().unwrap() = Some(slot.clone());
                *current = Some(id);
                Ok(ConnectionLease::new(id, connection))
            }
            Err(error) => {
                if let AgentRuntimeError::Initialize { connection, .. } = &error {
                    let _ = self.close_connection(*connection).await;
                }
                Err(error)
            }
        }
    }

    /// Gives the connection of an agent with one session per connection,
    /// or of one that keeps its loaded sessions in memory, to the session
    /// about to start on it: once taken, its plan's next acquire starts
    /// another connection, its list no longer stands for the catalogue and
    /// it loads no session again.
    async fn take_for_session(
        &self,
        id: ConnectionId,
        connection: &Connection,
    ) -> Result<(), AgentRuntimeError> {
        if !connection.session_per_connection {
            return Ok(());
        }
        if connection.taken.swap(true, Ordering::Relaxed) {
            return Err(AgentRuntimeError::ConnectionTaken);
        }
        let slot = connection.slot.lock().unwrap().clone();
        if let Some(slot) = slot {
            let mut current = slot.lock().await;
            if *current == Some(id) {
                *current = None;
            }
        }
        Ok(())
    }

    /// The process-wide writer registry; a host registers its managed PTYs
    /// here, so ACP and PTY never write to one session at once.
    pub fn writers(&self) -> WriterRegistry {
        self.inner.writers.clone()
    }

    /// What the agent declared in its last `initialize` in this process,
    /// whichever boundary started it; `None` before it first started.
    pub fn declared(&self, agent: &str) -> Option<AgentInfo> {
        self.inner.declared.lock().unwrap().get(agent).cloned()
    }

    /// Sets what the agent declared to what the host keeps of it: on start,
    /// and when its definition changed; `None` forgets it.
    pub fn restore_declared(&self, agent: &str, declared: Option<AgentInfo>) {
        let mut known = self.inner.declared.lock().unwrap();
        match declared {
            Some(info) => known.insert(agent.to_string(), info),
            None => known.remove(agent),
        };
    }

    /// One open connection per agent whose `session/list` is its declared
    /// catalogue source, unless its `initialize` declared no list. Listing
    /// never starts an agent: only connections a lifecycle boundary already
    /// opened are offered.
    pub fn catalog_connections(&self) -> Vec<CatalogConnection> {
        let connections = self.inner.connections.lock().unwrap();
        let mut ids: Vec<_> = connections
            .iter()
            .filter(|(_, connection)| {
                connection.lists_catalog
                    && connection.is_open()
                    && !connection.taken.load(Ordering::Relaxed)
                    && connection
                        .info
                        .lock()
                        .unwrap()
                        .as_ref()
                        .is_none_or(|info| info.capabilities.list_sessions)
            })
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
        self.read_list(id, None).await
    }

    /// The same read with the `cwd` filter, for an agent whose list covers
    /// one directory per request (`AdapterRuntimeRegistry::lists_by_folder`).
    pub async fn list_folder_sessions(
        &self,
        id: ConnectionId,
        folder: &Path,
    ) -> Result<SessionList, AgentRuntimeError> {
        self.read_list(id, Some(folder)).await
    }

    async fn read_list(
        &self,
        id: ConnectionId,
        folder: Option<&Path>,
    ) -> Result<SessionList, AgentRuntimeError> {
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
                    acp::list_request(cursor.as_deref(), folder),
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
        self.create_session(id, cwd, settings, None).await
    }

    /// Creates the session of a Routine launch whose ACP writer was claimed
    /// by its launch id before the agent started (C7) and applies its values
    /// before the session is handed out (Stage 11 `03`, «Запуск Рутины»):
    /// the model first, then the others in the order the agent declares them
    /// after the model. Each value must be declared at that moment and
    /// confirmed; a portable value of a setting the agent declares in
    /// category `mode` is refused, the mode coming only from this device. A
    /// refusal closes the session without a prompt, deletes it where the
    /// agent's draft evidence needs it, and releases the claim; the claim
    /// otherwise moves to the canonical key once the agent returns the id.
    pub async fn new_launch_session(
        &self,
        id: ConnectionId,
        cwd: &Path,
        values: &LaunchValues,
        claim: WriterClaim,
    ) -> Result<SessionKey, LaunchRefused> {
        let refused = |error| LaunchRefused { error, left: None };
        let session = self
            .start_session(id, cwd, Some(claim))
            .await
            .map_err(refused)?;
        let mut applied = 0;
        if let Err(error) = self
            .apply_launch_values(&session, values, &mut applied)
            .await
        {
            let reached_agent = applied > 0
                || matches!(
                    error,
                    AgentRuntimeError::SettingRefused {
                        reason: SettingRefusal::Agent { .. },
                        ..
                    }
                );
            self.close_session(&session).await;
            self.delete_unprompted(&session).await;
            let left = match session.connection.draft_session {
                DraftSession::Unsupported => true,
                DraftSession::FixedValues => reached_agent,
                DraftSession::Traceless | DraftSession::Deleted => false,
            };
            return Err(LaunchRefused {
                error,
                left: left.then(|| {
                    SessionKey::from_acp(
                        &session.connection.agent,
                        &session.acp_id,
                        session.connection.acp_id_is_native,
                    )
                }),
            });
        }
        Ok(self.register_created(session))
    }

    /// Applies the values of a launch in its order and counts those the
    /// agent confirmed.
    async fn apply_launch_values(
        &self,
        session: &Session,
        values: &LaunchValues,
        applied: &mut usize,
    ) -> Result<(), AgentRuntimeError> {
        let declared = |setting: &str| {
            let projection = session.projection.lock().unwrap();
            projection
                .settings()
                .iter()
                .enumerate()
                .find(|(_, declared)| declared.id == setting)
                .map(|(position, declared)| (position, declared.category))
        };
        let mut pending: Vec<(&SettingValue, bool)> = values
            .portable
            .iter()
            .map(|value| (value, true))
            .chain(values.device.iter().map(|value| (value, false)))
            .collect();
        if let Some(model) = pending.iter().position(|(value, _)| {
            declared(&value.setting).is_some_and(|(_, category)| category == SettingCategory::Model)
        }) {
            let (value, portable) = pending.remove(model);
            self.apply_launch_value(session, value, portable).await?;
            *applied += 1;
        }
        // The order the agent declares after the model; a value it does not
        // declare at all is refused before any other is sent.
        let mut ordered = Vec::with_capacity(pending.len());
        for (value, portable) in pending {
            let Some((position, _)) = declared(&value.setting) else {
                return Err(AgentRuntimeError::SettingRefused {
                    setting: value.setting.clone(),
                    value: value.value.clone(),
                    reason: SettingRefusal::NotDeclared,
                });
            };
            ordered.push((position, value, portable));
        }
        ordered.sort_by_key(|(position, _, _)| *position);
        for (_, value, portable) in ordered {
            self.apply_launch_value(session, value, portable).await?;
            *applied += 1;
        }
        Ok(())
    }

    async fn apply_launch_value(
        &self,
        session: &Session,
        value: &SettingValue,
        portable: bool,
    ) -> Result<(), AgentRuntimeError> {
        let mode = portable
            && session
                .projection
                .lock()
                .unwrap()
                .settings()
                .iter()
                .any(|declared| {
                    declared.id == value.setting && declared.category == SettingCategory::Mode
                });
        if mode {
            return Err(AgentRuntimeError::SettingRefused {
                setting: value.setting.clone(),
                value: value.value.clone(),
                reason: SettingRefusal::ModeFromCatalog,
            });
        }
        self.apply_setting(session, value).await
    }

    async fn create_session(
        &self,
        id: ConnectionId,
        cwd: &Path,
        settings: &[SettingValue],
        launch_claim: Option<WriterClaim>,
    ) -> Result<SessionKey, AgentRuntimeError> {
        let session = self.start_session(id, cwd, launch_claim).await?;
        for value in settings {
            if let Err(error) = self.apply_setting(&session, value).await {
                self.close_session(&session).await;
                self.delete_unprompted(&session).await;
                return Err(error);
            }
        }
        Ok(self.register_created(session))
    }

    /// Creates a session on the agent and holds its writer, before any
    /// value applies and before it is handed out.
    async fn start_session(
        &self,
        id: ConnectionId,
        cwd: &Path,
        launch_claim: Option<WriterClaim>,
    ) -> Result<Arc<Session>, AgentRuntimeError> {
        let connection = self.connection(id)?;
        connection.require_open()?;
        if connection.info.lock().unwrap().is_none() {
            self.initialize(&connection).await?;
        }
        self.take_for_session(id, &connection).await?;
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
        let claim = match launch_claim {
            Some(mut claim) => claim.bind(&key).map(|()| claim),
            None => self.inner.writers.claim(
                &key,
                Writer::Acp,
                ExternalLiveness::Free,
                UnknownLiveness::NotConfirmed,
            ),
        }
        .map_err(|refusal| AgentRuntimeError::WriterRefused { refusal })?;
        let session = self.session_entry(
            &connection,
            &acp_id,
            key,
            cwd,
            Projection::live_history(),
            false,
            Some(claim),
        );
        session.unprompted.store(true, Ordering::Relaxed);
        session.projection.lock().unwrap().set_settings(declared);
        self.inner.note_declared(&session);
        Ok(session)
    }

    fn register_created(&self, session: Arc<Session>) -> SessionKey {
        let key = SessionKey::from_acp(
            &session.connection.agent,
            &session.acp_id,
            session.connection.acp_id_is_native,
        );
        let agent = session.connection.agent.clone();
        self.inner.register(key.clone(), session);
        self.inner.catalog.changed(&agent);
        key
    }

    /// Creates a session in `cwd` without a prompt, to show and check the
    /// values the agent declares before a session starts (Stage 11 `03`):
    /// for a new session draft, an Actor binding or the device's default
    /// agent. Only an agent whose recorded evidence allows a draft session
    /// gets one, and one whose draft must be deleted only while it declares
    /// `session/delete`; such a draft is kept as a pending deletion of the
    /// device until a prompt makes it the user's session or its release
    /// deletes it. Values of an agent whose draft keeps them until the first
    /// prompt do not change before it ([`Self::apply_before_first_prompt`]).
    pub async fn new_draft_session(
        &self,
        id: ConnectionId,
        cwd: &Path,
    ) -> Result<SessionKey, AgentRuntimeError> {
        let connection = self.connection(id)?;
        connection.require_open()?;
        if connection.info.lock().unwrap().is_none() {
            self.initialize(&connection).await?;
        }
        let draft = connection.draft_session;
        if !draft.opens() || (draft.deletes() && !connection.declares_delete()) {
            return Err(AgentRuntimeError::DraftUnsupported);
        }
        let key = self.create_session(id, cwd, &[], None).await?;
        if draft.deletes()
            && let Ok(session) = self.session(&key)
        {
            self.inner
                .add_pending_deletion(&connection.agent, &session.acp_id);
        }
        Ok(key)
    }

    /// Applies the values a new session draft chose to its draft session
    /// right before its first prompt: for an agent whose draft keeps its
    /// values until the first prompt they apply only now. A value the
    /// session already has is not sent again; a refused one keeps the
    /// session without a prompt.
    pub async fn apply_before_first_prompt(
        &self,
        key: &SessionKey,
        settings: &[SettingValue],
    ) -> Result<(), AgentRuntimeError> {
        let session = self.session(key)?;
        session.connection.require_open()?;
        if session.writer.lock().unwrap().is_none() {
            return Err(AgentRuntimeError::WriterRequired);
        }
        for value in settings {
            let current = session
                .projection
                .lock()
                .unwrap()
                .settings()
                .iter()
                .any(|setting| setting.id == value.setting && setting.current_value == value.value);
            if !current {
                self.apply_setting(&session, value).await?;
            }
        }
        Ok(())
    }

    /// What the agent declared last on this device, per model, the latest
    /// first: values of an agent without a draft session or a connection.
    pub fn last_declarations(&self, agent: &str) -> Vec<AgentDeclaration> {
        self.inner.declarations.lock().unwrap().of(agent)
    }

    /// The host that keeps the agents' last declarations and the draft
    /// sessions to delete on the device, with what it kept of them before.
    pub fn host_drafts(
        &self,
        host: Arc<dyn DraftHost>,
        declarations: Vec<AgentDeclaration>,
        pending: Vec<PendingDeletion>,
    ) {
        self.inner
            .declarations
            .lock()
            .unwrap()
            .restore(declarations);
        *self.inner.pending_deletions.lock().unwrap() = pending;
        *self.inner.draft_host.lock().unwrap() = Some(host);
    }

    /// Deletes a session this runtime created that never got a prompt, for
    /// an agent whose draft sessions stay in its list until deleted: kept as
    /// a pending deletion until the agent confirms it.
    async fn delete_unprompted(&self, session: &Session) {
        let connection = &session.connection;
        if !connection.draft_session.deletes() || !session.unprompted.swap(false, Ordering::Relaxed)
        {
            return;
        }
        self.inner
            .add_pending_deletion(&connection.agent, &session.acp_id);
        if !connection.declares_delete() {
            return;
        }
        if connection
            .call(
                acp::SESSION_DELETE,
                acp::delete_request(&session.acp_id),
                self.timeout(),
            )
            .await
            .is_ok()
        {
            self.inner
                .remove_pending_deletion(&connection.agent, &session.acp_id);
        }
    }

    /// Deletes the pending draft sessions of the agent of a connection that
    /// just initialized, but for those a connection of this runtime still
    /// serves. A deletion the agent answers, deleted or refused, leaves the
    /// list; a lost or timed-out call leaves it for the next connection.
    fn delete_pending(&self, connection: &Connection) {
        if !connection.draft_session.deletes() || !connection.declares_delete() {
            return;
        }
        let Some(connection) = self
            .inner
            .connections
            .lock()
            .unwrap()
            .values()
            .find(|known| std::ptr::eq(known.as_ref(), connection))
            .cloned()
        else {
            return;
        };
        let served: HashSet<String> = self
            .inner
            .connections
            .lock()
            .unwrap()
            .values()
            .filter(|known| known.agent == connection.agent)
            .flat_map(|known| {
                known
                    .sessions
                    .lock()
                    .unwrap()
                    .keys()
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .collect();
        let pending: Vec<PendingDeletion> = self
            .inner
            .pending_deletions
            .lock()
            .unwrap()
            .iter()
            .filter(|entry| entry.agent == connection.agent && !served.contains(&entry.session_id))
            .cloned()
            .collect();
        if pending.is_empty() {
            return;
        }
        let timeout = self.timeout();
        let inner = self.inner.clone();
        tokio::spawn(async move {
            for entry in pending {
                match connection
                    .call(
                        acp::SESSION_DELETE,
                        acp::delete_request(&entry.session_id),
                        timeout,
                    )
                    .await
                {
                    Ok(_) | Err(AgentRuntimeError::Agent { .. }) => {
                        inner.remove_pending_deletion(&entry.agent, &entry.session_id)
                    }
                    Err(_) => {}
                }
            }
        });
    }

    /// Changes one declared setting of a session the runtime drives (C6)
    /// and returns once the agent confirmed the value, which also reaches
    /// subscribers as a settings delta. A value the session does not
    /// declare, or one the agent refuses, is refused and the setting keeps
    /// its value.
    pub async fn set_setting(
        &self,
        key: &SessionKey,
        value: &SettingValue,
    ) -> Result<(), AgentRuntimeError> {
        let session = self.session(key)?;
        session.connection.require_open()?;
        if session.writer.lock().unwrap().is_none() {
            return Err(AgentRuntimeError::WriterRequired);
        }
        if session.connection.draft_session == DraftSession::FixedValues
            && session.unprompted.load(Ordering::Relaxed)
        {
            return Err(AgentRuntimeError::SettingRefused {
                setting: value.setting.clone(),
                value: value.value.clone(),
                reason: SettingRefusal::BeforeFirstPrompt,
            });
        }
        self.apply_setting(&session, value).await
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
        let (legacy, unstable_model) = {
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
            (
                projection.legacy_modes() && value.setting == normalize::LEGACY_MODE_SETTING,
                projection.unstable_models() && value.setting == normalize::UNSTABLE_MODEL_SETTING,
            )
        };
        let agent_refused = |error: AgentRuntimeError| match error {
            AgentRuntimeError::Agent { message } | AgentRuntimeError::Protocol { message } => {
                refused(SettingRefusal::Agent { message })
            }
            other => other,
        };
        if unstable_model {
            session
                .connection
                .call(
                    acp::SESSION_SET_MODEL,
                    acp::set_model_request(&session.acp_id, &value.value),
                    self.timeout(),
                )
                .await
                .map_err(agent_refused)?;
            session
                .projection
                .lock()
                .unwrap()
                .set_unstable_model(&value.value);
        } else if legacy {
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
                .set_config_settings(settings);
        }
        self.inner.note_declared(session);
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
    /// about external writers. `settings` is the plan of values the host
    /// attaches the session with (C6, DF-171 R1): they apply after the
    /// session is attached and before it is handed out, as for a new
    /// session; a value the session does not declare, or one the agent
    /// refuses, closes the session again and refuses the opening. A
    /// session this connection already drives is left as it is, with the
    /// plan applied to it.
    pub async fn open_session(
        &self,
        id: ConnectionId,
        key: &SessionKey,
        cwd: &Path,
        liveness: ExternalLiveness,
        unknown: UnknownLiveness,
        settings: &[SettingValue],
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
            for value in settings {
                self.apply_setting(&open, value).await?;
            }
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
                    truncated_turns: None,
                },
            )
        } else if capabilities.resume_session {
            (
                acp::SESSION_RESUME,
                HistoryState {
                    source: HistorySource::None,
                    available: false,
                    truncated_items: None,
                    truncated_turns: None,
                },
            )
        } else {
            return Err(AgentRuntimeError::OpenUnsupported);
        };
        // A refused claim leaves the connection to the next session.
        let claim = self
            .inner
            .writers
            .claim(key, Writer::Acp, liveness, unknown)
            .map_err(|refusal| AgentRuntimeError::WriterRefused { refusal })?;
        self.take_for_session(id, &connection).await?;
        let acp_id = key.session_id.clone();
        let session = self.session_entry(
            &connection,
            &acp_id,
            key.clone(),
            cwd,
            history,
            method == acp::SESSION_LOAD,
            Some(claim),
        );
        session.listed.store(true, Ordering::Relaxed);
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
                {
                    let mut projection = session.projection.lock().unwrap();
                    projection.end_replay();
                    if let Some(declared) = acp::opened_session_settings(response) {
                        projection.set_settings(declared);
                    }
                }
                self.inner.note_declared(&session);
                for value in settings {
                    if let Err(error) = self.apply_setting(&session, value).await {
                        self.close_session(&session).await;
                        return Err(error);
                    }
                }
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
    /// and close add no turns or messages. While another process may run a
    /// turn of the session — `liveness` tells of an external writer, or is
    /// unknown with a `turn_open` by the agent's native status — it is read
    /// only by an agent with evidence that loading then leaves that turn
    /// and its store alone or that it refuses such a load (DF-177 R1). The
    /// snapshot does not follow the session afterwards: reading it again
    /// replays it anew. A session this runtime drives is left as it is.
    pub async fn read_session(
        &self,
        id: ConnectionId,
        key: &SessionKey,
        cwd: &Path,
        liveness: ExternalLiveness,
        turn_open: bool,
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
        let external_turn = match liveness {
            ExternalLiveness::ExternalActive => true,
            ExternalLiveness::Unknown => turn_open,
            ExternalLiveness::Free => false,
        };
        if !connection.read_only_open || (external_turn && !connection.reads_during_external_turn) {
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
        self.take_for_session(id, &connection).await?;
        let acp_id = key.session_id.clone();
        let session = self.session_entry(
            &connection,
            &acp_id,
            key.clone(),
            cwd,
            HistoryState {
                source: HistorySource::Replay,
                available: true,
                truncated_items: None,
                truncated_turns: None,
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
        self.inner.note_declared(&session);
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
        cwd: &Path,
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
            cwd: cwd.to_path_buf(),
            started_at: SystemTime::now(),
            first_prompt: Mutex::new(None),
            listed: AtomicBool::new(false),
            unprompted: AtomicBool::new(false),
            projection: Mutex::new(Projection::new(
                key,
                cwd.to_path_buf(),
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

    /// Stops driving a session between turns so another writer may take
    /// it: `session/close` where the agent declares it, then the writer slot
    /// is free and the session leaves the catalogue of runtime sessions. Its
    /// snapshot stays readable until it is released for idleness. A turn in
    /// progress refuses with `turn_active`; a session the runtime does not
    /// drive is already released.
    pub async fn release_session(&self, key: &SessionKey) -> Result<(), AgentRuntimeError> {
        let Ok(session) = self.session(key) else {
            return Ok(());
        };
        if session.writer.lock().unwrap().is_none() {
            return Ok(());
        }
        if session.projection.lock().unwrap().turn_active() {
            return Err(AgentRuntimeError::TurnActive);
        }
        self.close_session(&session).await;
        self.delete_unprompted(&session).await;
        self.inner.catalog.changed(&session.connection.agent);
        Ok(())
    }

    /// The host that hears the start and end of every turn this runtime
    /// drives from now on (Stage 11 1.E «Ходы агентов»).
    pub fn observe_turns(&self, observer: Arc<dyn TurnObserver>) {
        *self.inner.turns.lock().unwrap() = Some(observer);
    }

    /// Accepts a prompt — text and links to files in order — and returns the
    /// turn id at once; the runtime owns the call, so a lost caller does not
    /// lose the prompt. A link to a missing file is refused before anything
    /// is sent.
    pub fn prompt(
        &self,
        key: &SessionKey,
        parts: &[PromptPart],
    ) -> Result<String, AgentRuntimeError> {
        self.prompt_with(key, parts, None)
    }

    /// [`Self::prompt`] whose turn carries `mark` to the turn observer. The
    /// prompt reaches the agent after the observer prepared for the turn; a
    /// cancel requested meanwhile ends the turn `cancelled` without it.
    pub fn prompt_with(
        &self,
        key: &SessionKey,
        parts: &[PromptPart],
        mark: Option<TurnMark>,
    ) -> Result<String, AgentRuntimeError> {
        let session = self.session(key)?;
        session.connection.require_open()?;
        if session.writer.lock().unwrap().is_none() {
            return Err(AgentRuntimeError::WriterRequired);
        }
        let images = session
            .connection
            .info
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|info| info.capabilities.image_prompt);
        let blocks = prompt::blocks(parts, images)?;
        let (text, segments) = prompt::message(parts);
        let turn_id = ulid::Ulid::new().to_string().to_ascii_lowercase();
        session
            .projection
            .lock()
            .unwrap()
            .begin_turn(&turn_id, &text, segments)
            .ok_or(AgentRuntimeError::TurnActive)?;
        session.first_prompt.lock().unwrap().get_or_insert(text);
        if session.unprompted.swap(false, Ordering::Relaxed)
            && session.connection.draft_session.deletes()
        {
            self.inner
                .remove_pending_deletion(&session.connection.agent, &session.acp_id);
        }
        if !session.listed.swap(true, Ordering::Relaxed) {
            self.inner.catalog.changed(&session.connection.agent);
        }
        self.inner.enforce_detail_bound();
        let request = acp::prompt_request(&session.acp_id, &blocks);
        let turn = turn_id.clone();
        let observer = self.inner.turns.lock().unwrap().clone();
        let boundary = TurnBoundary {
            session: key.clone(),
            turn_id: turn_id.clone(),
            cwd: session.cwd.clone(),
            mark,
        };
        tokio::spawn(async move {
            let _ended = observer.clone().map(|observer| TurnEnded {
                observer,
                turn: boundary.clone(),
            });
            if let Some(observer) = &observer {
                observer.began(&boundary).await;
            }
            let cancelled = session.projection.lock().unwrap().cancel_requested();
            let (reason, error) = if cancelled {
                (StopReason::Cancelled, None)
            } else {
                match session
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
                }
            };
            // Updates the agent sent before its answer belong to this turn;
            // apply all of them before the turn ends.
            session.connection.rpc.barrier().await;
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
        projection.resolve_pending(&open.interaction, InteractionState::Answered, Some(&answer));
        Ok(AnswerOutcome::Accepted)
    }

    /// The sessions this runtime drives and lists by runtime evidence: a
    /// created one after its first accepted prompt, an opened one from its
    /// opening, while it holds its writer (Stage 10 `02` C3).
    pub fn sessions(&self) -> Vec<RuntimeSession> {
        let bounds = self.inner.config.list;
        let sessions: Vec<(SessionKey, Arc<Session>)> = self
            .inner
            .sessions
            .lock()
            .unwrap()
            .iter()
            .map(|(key, session)| (key.clone(), session.clone()))
            .collect();
        let mut listed: Vec<RuntimeSession> = sessions
            .into_iter()
            .filter(|(_, session)| {
                session.listed.load(Ordering::Relaxed) && session.writer.lock().unwrap().is_some()
            })
            .map(|(key, session)| {
                let projection = session.projection.lock().unwrap();
                let title = projection
                    .title()
                    .map(|title| normalize::bounded(title, bounds.title_bytes))
                    .or_else(|| {
                        session
                            .first_prompt
                            .lock()
                            .unwrap()
                            .as_deref()
                            .and_then(|prompt| catalog::prompt_title(prompt, &bounds))
                    });
                RuntimeSession {
                    key,
                    cwd: session.cwd.clone(),
                    title,
                    status: projection.status(),
                    started_at: session.started_at,
                    last_turn_at: projection.turn_at(),
                }
            })
            .collect();
        listed.sort_by(|left, right| left.key.session_id.cmp(&right.key.session_id));
        listed
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

    /// The session's snapshot and its deltas after it for a host that
    /// records the status elsewhere, such as a Routine run. Unlike
    /// [`AgentRuntime::subscribe`] it does not open the session in a
    /// surface; like any subscriber it keeps the connection while held.
    pub fn watch(&self, key: &SessionKey) -> Result<SessionSubscription, AgentRuntimeError> {
        let subscription = self.session(key)?.projection.lock().unwrap().subscribe();
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

    /// The data of media segment `segment_id` of item `item_id` (Stage 10
    /// `08` R1).
    pub fn media(&self, key: &SessionKey, item_id: &str, segment_id: &str) -> MediaOutcome {
        match self.session(key) {
            Ok(session) => session
                .projection
                .lock()
                .unwrap()
                .media(item_id, segment_id),
            Err(error) => MediaOutcome::Error {
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
        self.inner
            .declared
            .lock()
            .unwrap()
            .insert(connection.agent.clone(), info.clone());
        *connection.info.lock().unwrap() = Some(info);
        connection.set_state(ConnectionState::Ready);
        self.delete_pending(connection);
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
    /// Records what the session's agent declares now as its last
    /// declarations for the current model, and hands every change to the
    /// host.
    fn note_declared(&self, session: &Session) {
        let settings = session.projection.lock().unwrap().settings().to_vec();
        let version = session
            .connection
            .info
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|info| info.version.clone());
        let changed = {
            let mut declarations = self.declarations.lock().unwrap();
            declarations
                .record(
                    &session.connection.agent,
                    &settings,
                    version.as_deref(),
                    SystemTime::now(),
                )
                .then(|| declarations.all())
        };
        let host = self.draft_host.lock().unwrap().clone();
        if let (Some(all), Some(host)) = (changed, host) {
            host.declarations_changed(&all);
        }
    }

    fn add_pending_deletion(&self, agent: &str, session_id: &str) {
        let entry = PendingDeletion {
            agent: agent.to_string(),
            session_id: session_id.to_string(),
        };
        let pending = {
            let mut pending = self.pending_deletions.lock().unwrap();
            if pending.contains(&entry) {
                return;
            }
            pending.push(entry);
            pending.clone()
        };
        self.pending_deletions_changed(&pending);
    }

    fn remove_pending_deletion(&self, agent: &str, session_id: &str) {
        let pending = {
            let mut pending = self.pending_deletions.lock().unwrap();
            let before = pending.len();
            pending.retain(|entry| !(entry.agent == agent && entry.session_id == session_id));
            if pending.len() == before {
                return;
            }
            pending.clone()
        };
        self.pending_deletions_changed(&pending);
    }

    fn pending_deletions_changed(&self, pending: &[PendingDeletion]) {
        let host = self.draft_host.lock().unwrap().clone();
        if let Some(host) = host {
            host.pending_deletions_changed(pending);
        }
    }

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

    /// Closes connections nothing has needed for `idle`. A connection a
    /// host acquired closes under its launch plan lock, so an acquire of
    /// the same plan never receives a connection that is closing.
    async fn close_idle_connections(&self, idle: Duration) {
        let now = Instant::now();
        let open: Vec<_> = self
            .connections
            .lock()
            .unwrap()
            .values()
            .filter(|connection| connection.is_open())
            .cloned()
            .collect();
        for connection in open {
            if connection.idle_for(now) < idle {
                continue;
            }
            let slot = connection.slot.lock().unwrap().clone();
            match slot {
                Some(slot) => {
                    let Ok(_plan) = slot.try_lock() else {
                        continue;
                    };
                    if !connection.needed() {
                        connection.terminate().await;
                    }
                }
                None => connection.terminate().await,
            }
        }
        // Plans of closed connections, such as those of finished launches,
        // are not kept.
        let connections = self.connections.lock().unwrap();
        self.slots.lock().unwrap().retain(|_, slot| {
            let Ok(current) = slot.try_lock() else {
                return true;
            };
            match *current {
                Some(id) => connections
                    .get(&id)
                    .is_some_and(|connection| connection.is_open()),
                // Kept while an acquire is about to take it.
                None => Arc::strong_count(slot) > 1,
            }
        });
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
            projection.resolve_pending(&open.interaction, InteractionState::Cancelled, None);
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
                self.terminate().await;
                Err(AgentRuntimeError::ConnectionClosed)
            }
        }
    }

    fn is_open(&self) -> bool {
        *self.state.lock().unwrap() != ConnectionState::Closed
    }

    /// A host lease, a live turn (and with it a pending interaction) or a
    /// session open in a surface keeps the connection.
    fn needed(&self) -> bool {
        self.holds.load(Ordering::SeqCst) > 0
            || self.sessions().iter().any(|session| {
                let projection = session.projection.lock().unwrap();
                projection.turn_active() || projection.subscribers() > 0
            })
    }

    /// How long nothing has needed the connection; zero while something
    /// does.
    fn idle_for(&self, now: Instant) -> Duration {
        let needed = self.needed();
        let mut idle_since = self.idle_since.lock().unwrap();
        if needed {
            *idle_since = None;
            return Duration::ZERO;
        }
        now - *idle_since.get_or_insert(now)
    }

    fn declares_delete(&self) -> bool {
        self.info
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|info| info.capabilities.delete_session)
    }

    fn declares_close(&self) -> bool {
        self.info
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|info| info.capabilities.close_session)
    }

    /// Ends the agent process with its descendants, waits for it and
    /// closes the connection, on every path to `closed` (DF-218 R2, R3).
    /// The closed connection keeps its state, agent info and stderr tail but
    /// no process, I/O tasks or pipes: the tree's end brings stderr to EOF.
    /// A second caller waits until the first has ended the tree.
    async fn terminate(&self) {
        let mut process = self.process.lock().await;
        if let Some(process) = process.take() {
            process.kill().await;
        }
        self.rpc.close();
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

    /// The built-in agent of the connection, whose output forms the
    /// normalizer knows; none for a custom agent.
    fn adapter(&self) -> Option<AgentAdapterKind> {
        AgentAdapterKind::from_id(&self.agent)
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
                let Some((acp_id, normalized)) =
                    normalize::session_update(params, connection.adapter())
                else {
                    continue;
                };
                if let Some(session) = connection.session(&acp_id) {
                    let declares = matches!(
                        normalized,
                        Normalized::ConfigChange(_) | Normalized::ModeChange(_)
                    );
                    apply(&session, normalized);
                    if let Some(runtime) = connection.runtime.upgrade() {
                        if declares {
                            runtime.note_declared(&session);
                        }
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
    // The agent's output ended: whatever is left of its tree ends too.
    if let Some(connection) = connection.upgrade() {
        connection.terminate().await;
    }
}

fn apply(session: &Session, normalized: Normalized) {
    session.projection.lock().unwrap().apply(normalized);
}

fn request_permission(connection: &Connection, id: Value, params: &RawValue) {
    match normalize::permission_request(params.get(), connection.adapter()) {
        Ok(request) => open_interaction(
            connection,
            id,
            &request.session_id,
            InteractionKind::Permission,
            request.title,
            Some(request.tool_call),
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
            None,
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
/// request, or one for an unknown session, is answered `cancel`. The tool
/// call of a permission is merged into its timeline item first, so the
/// subject of the request is there when the request appears.
#[allow(clippy::too_many_arguments)]
fn open_interaction(
    connection: &Connection,
    id: Value,
    session_id: &str,
    kind: InteractionKind,
    title: String,
    tool_call: Option<normalize::ToolUpdate>,
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
    let mut projection = session.projection.lock().unwrap();
    let tool_call_id = tool_call.as_ref().map(|call| call.id.clone());
    if let Some(call) = tool_call {
        projection.merge_tool_call(call);
    }
    projection.set_pending(PendingInteraction {
        id: interaction,
        kind,
        title,
        tool_call_id,
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

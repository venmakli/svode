//! Session runtime: agent connections and their sessions, turns, cancel and
//! pending interactions, independent of any mounted UI surface or window.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use serde_json::value::RawValue;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite};
use tokio::process::Child;
use tokio::sync::{broadcast, mpsc};

use crate::acp::normalize::{self, Normalized};
use crate::acp::rpc::{AUTH_REQUIRED, Incoming, RpcClient, RpcError};
use crate::acp::{self};
use crate::activity::{
    ConnectionState, DetailOutcome, InteractionOption, InteractionState, PendingInteraction,
    QuestionField, SessionDelta, SessionSnapshot,
};
use crate::error::AgentRuntimeError;
use crate::identity::SessionKey;
use crate::interaction::{self, AnswerOutcome, InteractionAnswer};
use crate::process;
use crate::projection::Projection;
use crate::status::{InteractionKind, StopReason};

/// Kept stderr of a starting agent, shown only when it fails to initialize.
const STDERR_TAIL_BYTES: usize = 4 * 1024;

/// Tunables of the runtime, not part of its contract.
#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    /// Bound for every agent call except a prompt, which runs until the agent
    /// answers or the user cancels.
    pub request_timeout: Duration,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            request_timeout: Duration::from_secs(60),
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ConnectionId(pub u64);

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
}

struct Connection {
    agent: String,
    acp_id_is_native: bool,
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
            agent: launch.agent.clone(),
            acp_id_is_native: launch.acp_id_is_native,
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
        id
    }

    pub fn connection_status(&self, id: ConnectionId) -> Option<ConnectionStatus> {
        let connection = self.connection(id).ok()?;
        let state = *connection.state.lock().unwrap();
        let agent = connection.info.lock().unwrap().clone();
        Some(ConnectionStatus { state, agent })
    }

    /// Creates a session in `cwd`. A connection that failed to initialize
    /// retries it here, at the next lifecycle boundary.
    pub async fn new_session(
        &self,
        id: ConnectionId,
        cwd: &Path,
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
        let acp_id = acp::new_session_id(response).map_err(|message| {
            connection.set_state(ConnectionState::Degraded);
            AgentRuntimeError::Protocol { message }
        })?;
        let key = SessionKey::from_acp(&connection.agent, &acp_id, connection.acp_id_is_native);
        let state = *connection.state.lock().unwrap();
        let session = Arc::new(Session {
            acp_id: acp_id.clone(),
            connection: connection.clone(),
            projection: Mutex::new(Projection::new(key.clone(), state)),
            interactions: Mutex::new(Interactions::default()),
            next_interaction: AtomicU64::new(0),
        });
        connection
            .sessions
            .lock()
            .unwrap()
            .insert(acp_id, session.clone());
        self.inner
            .sessions
            .lock()
            .unwrap()
            .insert(key.clone(), session);
        Ok(key)
    }

    /// Accepts a prompt and returns the turn id at once; the runtime owns the
    /// call, so a lost caller does not lose the prompt.
    pub fn prompt(&self, key: &SessionKey, text: &str) -> Result<String, AgentRuntimeError> {
        let session = self.session(key)?;
        session.connection.require_open()?;
        let turn_id = ulid::Ulid::new().to_string().to_ascii_lowercase();
        session
            .projection
            .lock()
            .unwrap()
            .begin_turn(&turn_id, text)
            .ok_or(AgentRuntimeError::TurnActive)?;
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
        });
        Ok(turn_id)
    }

    /// Requests cancellation of the active turn: answers the pending request
    /// `cancelled` and keeps the turn `cancelling` until the agent answers
    /// the prompt or the connection drops. No-op without an active turn.
    pub fn cancel(&self, key: &SessionKey) -> Result<(), AgentRuntimeError> {
        let session = self.session(key)?;
        let mut interactions = session.interactions.lock().unwrap();
        let mut projection = session.projection.lock().unwrap();
        if !projection.turn_active() {
            return Ok(());
        }
        projection.cancelling();
        if let Some(open) = interactions.close(InteractionState::Cancelled) {
            session
                .connection
                .rpc
                .respond(open.rpc_id, acp::cancelled(open.kind));
            projection.resolve_pending(&open.interaction, InteractionState::Cancelled);
        }
        drop(projection);
        drop(interactions);
        session.connection.rpc.notify(
            acp::SESSION_CANCEL,
            acp::cancel_notification(&session.acp_id),
        );
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

    pub fn subscribe(&self, key: &SessionKey) -> Result<SessionSubscription, AgentRuntimeError> {
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

    /// Stops the agent process; its sessions end their turns `interrupted`.
    pub async fn close_connection(&self, id: ConnectionId) -> Result<(), AgentRuntimeError> {
        let connection = self.connection(id)?;
        let child = connection.child.lock().unwrap().take();
        if let Some(mut child) = child {
            let _ = child.kill().await;
        }
        connection.close();
        Ok(())
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
            }) => Err(AgentRuntimeError::AuthRequired { message }),
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
            let mut interactions = session.interactions.lock().unwrap();
            interactions.close(InteractionState::Expired);
            let mut projection = session.projection.lock().unwrap();
            projection.set_connection(ConnectionState::Closed);
            projection.interrupt();
        }
    }

    fn sessions(&self) -> Vec<Arc<Session>> {
        self.sessions.lock().unwrap().values().cloned().collect()
    }

    fn session(&self, acp_id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().unwrap().get(acp_id).cloned()
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
                }
            }
            Incoming::Notification { .. } => {}
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

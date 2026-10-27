//! Desktop owner of agent connections (Stage 10 `02` C1/C3, `03` A1). An
//! agent's ACP entrypoint starts only at a lifecycle boundary and only for
//! an available agent: an open Sessions collection for the agents whose
//! catalogue is their ACP list, the user's explicit check, an agent chosen
//! in a new session draft (with the session it creates early where the
//! agent has evidence for it), the creation of a session and opening one in
//! the chat; a Routine launch acquires a connection of its own provenance
//! in `routines::acp_launch`. Sharing by launch plan, the provenance split
//! and closing for idleness belong to the runtime.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use svode_agents::activity::WriterState;
use svode_agents::adapters::LaunchUnavailable;
use svode_agents::custom::CustomAgentDefinition;
use svode_agents::identity::SessionKey;
use svode_agents::native_settings::{NativeSessionSettings, SessionValues, session_values};
use svode_agents::prompt::PromptPart;
use svode_agents::writer::{ExternalLiveness, UnknownLiveness, Writer, WriterRefusal};
use svode_agents::{
    AcpLaunch, AgentCheck, AgentInfo, AgentRuntime, AgentRuntimeError, ConnectionLease,
    SettingValue,
};
use svode_core::agent_adapters::AgentAdapterKind;

pub(crate) type PlanFuture<'a> =
    Pin<Box<dyn Future<Output = Result<AcpLaunch, LaunchUnavailable>> + Send + 'a>>;
pub(crate) type KeepFuture<'a> = Pin<Box<dyn Future<Output = ()> + Send + 'a>>;

/// What the host knows about agents: which ones list their catalogue over
/// ACP, how an available one launches and what it keeps of what agents
/// declared.
pub(crate) trait LaunchPlanner: Send + Sync {
    /// Agents whose `session/list` is their declared catalogue source.
    fn catalog_agents(&self) -> Vec<String>;
    /// The launch plan of an available agent, or why it is not available;
    /// starts nothing.
    fn plan<'a>(&'a self, agent: &'a str) -> PlanFuture<'a>;
    /// The launch plan of a custom agent's definition before it is saved;
    /// what it declares is no saved agent's.
    fn plan_draft(&self, definition: CustomAgentDefinition) -> PlanFuture<'_>;
    /// What the host keeps of what agents declared: the runtime knows it
    /// before they start.
    fn declarations(&self) -> Vec<(String, AgentInfo)>;
    /// The agent declared `info` in an `initialize` of `launch`; a host that
    /// keeps it does so while `launch` is still the agent's plan.
    fn keep_declared<'a>(&'a self, launch: &'a AcpLaunch, info: &'a AgentInfo) -> KeepFuture<'a>;
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
    agent: String,
    _lease: ConnectionLease,
    /// The session the draft created before its first prompt.
    session: Option<DraftSession>,
}

struct DraftSession {
    key: SessionKey,
    cwd: PathBuf,
}

/// What a new session draft shows for its agent.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftAgent {
    /// Present while a ready agent's connection is held for the draft.
    pub hold: Option<u64>,
    pub check: AgentCheck,
    /// The session the draft created without a prompt, for an agent with
    /// evidence that this leaves nothing in its native store: its settings
    /// and commands show in the draft, and the first send goes to it.
    pub session: Option<SessionKey>,
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

/// What opening an existing session in the chat is for (Stage 10 `04`,
/// opening and continuing).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpenIntent {
    /// Show the history: read it without a writer where the agent has
    /// evidence for it, else attach it once the user confirms.
    Read,
    /// Attach the session for its first send, which is itself the user's
    /// explicit action, unless the native status tells a turn open that
    /// another process may run (DF-231 R1, R2).
    Send,
    /// Attach the session: the user confirmed this one attempt.
    Confirmed,
}

/// What opening an existing session in the chat did (Stage 10 `04`,
/// opening and continuing).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(
    tag = "outcome",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum SessionOpening {
    /// The chat follows the session: the runtime drives it, attached it or
    /// read its history; the snapshot's writer tells which. `liveness` is
    /// what Svode knows about other writers before the chat continues it.
    Opened {
        session: SessionKey,
        liveness: ExternalLiveness,
        /// A session read without a writer: the values its own last turn
        /// gives attaching it where the user chose none (DF-171 R2).
        #[serde(skip_serializing_if = "Option::is_none")]
        session_values: Option<SessionValues>,
    },
    /// Attaching the session needs the user's confirmation of this attempt:
    /// nothing tells whether another process writes to it. `turn_open`:
    /// the agent's native status tells a turn open, which attaching may
    /// interrupt if another process still runs it (DF-177 R2).
    ConfirmationRequired {
        turn_open: bool,
    },
    /// Another process writes to the session; manual fallback only.
    ExternalActive,
    /// A managed terminal of Svode drives the session.
    TerminalActive,
    /// The agent opens neither this session nor existing sessions at all.
    Unsupported,
    Unavailable {
        reason: LaunchUnavailable,
    },
    AuthRequired {
        message: String,
    },
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
        for (agent, info) in planner.declarations() {
            runtime.restore_declared(&agent, Some(info));
        }
        Self {
            runtime,
            planner: Box::new(planner),
            next_hold: AtomicU64::new(0),
            catalog: Mutex::default(),
            drafts: Mutex::default(),
        }
    }

    async fn acquire(&self, agent: &str) -> Result<ConnectionLease, ConnectRefusal> {
        Ok(self.acquire_launch(agent).await?.0)
    }

    /// The lease and the evidence of the launch plan it was acquired for.
    async fn acquire_launch(
        &self,
        agent: &str,
    ) -> Result<(ConnectionLease, AcpLaunch), ConnectRefusal> {
        let launch = self
            .planner
            .plan(agent)
            .await
            .map_err(ConnectRefusal::Unavailable)?;
        let lease = self
            .runtime
            .acquire(launch.clone())
            .await
            .map_err(ConnectRefusal::Failed)?;
        if let Some(info) = self
            .runtime
            .connection_status(lease.connection())
            .and_then(|status| status.agent)
        {
            self.planner.keep_declared(&launch, &info).await;
        }
        Ok((lease, launch))
    }

    /// The user's explicit check: start, `initialize`, close unless the
    /// connection has another reason to live.
    pub async fn check(&self, agent: &str) -> AgentCheck {
        let launch = match self.planner.plan(agent).await {
            Ok(launch) => launch,
            Err(reason) => return AgentCheck::Unavailable { reason },
        };
        let check = self.runtime.check(launch.clone()).await;
        if let AgentCheck::Ready { agent: info } = &check {
            self.planner.keep_declared(&launch, info).await;
        }
        check
    }

    /// A new session draft chose `agent` (Stage 10 `04`, a C1 boundary): its
    /// connection starts and stays while the hold lives, and the outcome is
    /// what the draft shows before the first prompt. Only a ready agent
    /// gets a hold. For an agent with evidence that `session/new` without a
    /// prompt leaves nothing in its native store, the draft's session is
    /// created in `cwd` now, so its settings and commands show in the
    /// draft; the catalogue lists it only after its first prompt.
    pub async fn hold_draft(&self, webview: &str, agent: &str, cwd: &Path) -> DraftAgent {
        let refused = |check| DraftAgent {
            hold: None,
            check,
            session: None,
        };
        let (lease, launch) = match self.acquire_launch(agent).await {
            Ok(acquired) => acquired,
            Err(ConnectRefusal::Unavailable(reason)) => {
                return refused(AgentCheck::Unavailable { reason });
            }
            Err(ConnectRefusal::Failed(AgentRuntimeError::AuthRequired { message })) => {
                return refused(AgentCheck::AuthRequired { message });
            }
            Err(ConnectRefusal::Failed(error)) => {
                return refused(AgentCheck::FailedToStart {
                    message: error.to_string(),
                });
            }
        };
        let Some(info) = self
            .runtime
            .connection_status(lease.connection())
            .and_then(|status| status.agent)
        else {
            return refused(AgentCheck::FailedToStart {
                message: AgentRuntimeError::ConnectionClosed.to_string(),
            });
        };
        let mut session = None;
        if launch.draft_session {
            match self.runtime.new_session(lease.connection(), cwd, &[]).await {
                Ok(key) => {
                    session = Some(DraftSession {
                        key,
                        cwd: cwd.to_path_buf(),
                    })
                }
                Err(AgentRuntimeError::AuthRequired { message }) => {
                    return refused(AgentCheck::AuthRequired { message });
                }
                // The settings then show after the first send.
                Err(error) => {
                    tracing::warn!("the draft session of {agent} was not created: {error}")
                }
            }
        }
        let key = session.as_ref().map(|session| session.key.clone());
        let hold = self.next_hold.fetch_add(1, Ordering::Relaxed) + 1;
        self.drafts.lock().unwrap().insert(
            hold,
            DraftHold {
                webview: webview.to_string(),
                agent: agent.to_string(),
                _lease: lease,
                session,
            },
        );
        DraftAgent {
            hold: Some(hold),
            check: AgentCheck::Ready { agent: info },
            session: key,
        }
    }

    /// The draft closed, chose another agent or Space, or became a session.
    pub fn release_draft(&self, hold: u64) {
        let draft = self.drafts.lock().unwrap().remove(&hold);
        if let Some(draft) = draft {
            self.close_draft(draft);
        }
    }

    /// A draft session that never got its prompt is closed; one that became
    /// the user's session is not the draft's any more.
    fn close_draft(&self, draft: DraftHold) {
        let Some(session) = draft.session else {
            return;
        };
        let runtime = self.runtime.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = runtime.release_session(&session.key).await {
                tracing::warn!("a draft session was not closed: {error}");
            }
        });
    }

    /// Creates a session of `agent` in `cwd` with the draft's setting values
    /// and sends its first prompt: the first send of a new session draft.
    /// A session the draft `hold` created for this agent and `cwd` takes the
    /// prompt instead, with the values the agent confirmed in the draft; if
    /// it is gone, a new one is created. The session enters the catalogue
    /// once the prompt is accepted; a prompt linking a missing file creates
    /// no session.
    pub async fn start_session(
        &self,
        agent: &str,
        cwd: &Path,
        settings: &[SettingValue],
        prompt: &[PromptPart],
        hold: Option<u64>,
    ) -> Result<SessionStart, AgentRuntimeError> {
        svode_agents::prompt::check(prompt)?;
        if let Some(hold) = hold
            && let Some(session) = self.draft_session_for(hold, agent, cwd)
        {
            match self.runtime.prompt(&session, prompt) {
                Ok(turn_id) => {
                    if let Some(draft) = self.drafts.lock().unwrap().get_mut(&hold) {
                        draft.session = None;
                    }
                    return Ok(SessionStart::Started { session, turn_id });
                }
                Err(
                    AgentRuntimeError::ConnectionClosed
                    | AgentRuntimeError::ConnectionNotFound
                    | AgentRuntimeError::SessionNotFound
                    | AgentRuntimeError::WriterRequired,
                ) => {}
                Err(error) => return Err(error),
            }
        }
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

    /// The session the draft `hold` created for `agent` in `cwd`.
    pub(crate) fn draft_session_for(
        &self,
        hold: u64,
        agent: &str,
        cwd: &Path,
    ) -> Option<SessionKey> {
        let drafts = self.drafts.lock().unwrap();
        let draft = drafts.get(&hold)?;
        let session = draft.session.as_ref()?;
        (draft.agent == agent && session.cwd == cwd).then(|| session.key.clone())
    }

    /// Opens an existing session of `agent` in the chat, a C1 boundary: a
    /// session the runtime drives is followed as it is; otherwise its
    /// history is read without a writer where the agent has evidence for
    /// it, also while another process may run a turn of it (`turn_open` by
    /// the native status, DF-177 R1), else the session is attached with the
    /// writer. `intent` other than reading attaches it right away; with
    /// unknown liveness a send attaches it unless a turn is open, and a
    /// confirmation always does (DF-231). `liveness` and `turn_open` are
    /// read for this call. `settings` is the plan the session
    /// is attached with (DF-171 R1); reading it takes none, and a session
    /// read without a writer carries the values its `native` settings match
    /// (R2). Opening never sends a prompt, and a session a managed terminal
    /// drives is left to it.
    pub async fn open_session(
        &self,
        agent: &str,
        session: &SessionKey,
        cwd: &Path,
        liveness: ExternalLiveness,
        turn_open: bool,
        intent: OpenIntent,
        settings: &[SettingValue],
        native: Option<&NativeSessionSettings>,
    ) -> Result<SessionOpening, AgentRuntimeError> {
        if self.runtime.writers().writer(session) == Some(Writer::Pty) {
            return Ok(SessionOpening::TerminalActive);
        }
        let lease = match self.acquire(agent).await {
            Ok(lease) => lease,
            Err(ConnectRefusal::Unavailable(reason)) => {
                return Ok(SessionOpening::Unavailable { reason });
            }
            Err(ConnectRefusal::Failed(error)) => {
                return opening(Err(error), session, liveness, turn_open);
            }
        };
        if intent == OpenIntent::Read {
            match self
                .runtime
                .read_session(lease.connection(), session, cwd, liveness, turn_open)
                .await
            {
                Err(AgentRuntimeError::ReadOnlyUnsupported) => {}
                read => {
                    let read = opening(read, session, liveness, turn_open)?;
                    return Ok(self.with_session_values(read, agent, native));
                }
            }
        }
        let unknown = match intent {
            OpenIntent::Read => UnknownLiveness::NotConfirmed,
            // A turn another process may still run is attached only once
            // the user confirms it.
            OpenIntent::Send if turn_open => UnknownLiveness::NotConfirmed,
            OpenIntent::Send | OpenIntent::Confirmed => UnknownLiveness::Confirmed,
        };
        let attached = self
            .runtime
            .open_session(
                lease.connection(),
                session,
                cwd,
                liveness,
                unknown,
                settings,
            )
            .await;
        opening(attached, session, liveness, turn_open)
    }

    /// A session the opening read without a writer, with the declared values
    /// its native settings match by the agent's dialect.
    fn with_session_values(
        &self,
        opening: SessionOpening,
        agent: &str,
        native: Option<&NativeSessionSettings>,
    ) -> SessionOpening {
        let (
            SessionOpening::Opened {
                session, liveness, ..
            },
            Some(native),
            Some(adapter),
        ) = (&opening, native, AgentAdapterKind::from_id(agent))
        else {
            return opening;
        };
        let Ok(read) = self.runtime.watch(session) else {
            return opening;
        };
        if read.snapshot.writer != WriterState::None {
            return opening;
        }
        let values = session_values(adapter, &read.snapshot.settings, native);
        SessionOpening::Opened {
            session: session.clone(),
            liveness: *liveness,
            session_values: (values != SessionValues::default()).then_some(values),
        }
    }

    /// The chat no longer drives the session, e.g. to continue it in the
    /// terminal; refused during a turn.
    pub async fn release_session(&self, session: &SessionKey) -> Result<(), AgentRuntimeError> {
        self.runtime.release_session(session).await
    }

    /// The user's check of a custom agent's definition before it is saved.
    pub async fn check_draft(&self, definition: CustomAgentDefinition) -> AgentCheck {
        match self.planner.plan_draft(definition).await {
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
        let released: Vec<DraftHold> = {
            let mut drafts = self.drafts.lock().unwrap();
            let holds: Vec<u64> = drafts
                .iter()
                .filter(|(_, draft)| draft.webview == webview)
                .map(|(hold, _)| *hold)
                .collect();
            holds
                .into_iter()
                .filter_map(|hold| drafts.remove(&hold))
                .collect()
        };
        for draft in released {
            self.close_draft(draft);
        }
    }

    /// A disabled agent's catalogue is no longer kept.
    pub fn forget_agent(&self, agent: &str) {
        self.catalog.lock().unwrap().leases.remove(agent);
    }

    /// Agents whose catalogue connection an open collection needs; none
    /// while no collection is open. An agent that declared no list, in this
    /// process or as the host keeps it, is not started for it again.
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

/// The opening outcome of a runtime call; refusals the chat shows as states
/// are outcomes, other errors stay errors.
fn opening(
    result: Result<(), AgentRuntimeError>,
    session: &SessionKey,
    liveness: ExternalLiveness,
    turn_open: bool,
) -> Result<SessionOpening, AgentRuntimeError> {
    match result {
        Ok(()) => Ok(SessionOpening::Opened {
            session: session.clone(),
            liveness,
            session_values: None,
        }),
        Err(AgentRuntimeError::WriterRefused { refusal }) => Ok(match refusal {
            WriterRefusal::ConfirmationRequired => {
                SessionOpening::ConfirmationRequired { turn_open }
            }
            WriterRefusal::ExternalActive => SessionOpening::ExternalActive,
            WriterRefusal::WriterActive {
                writer: Writer::Pty,
            } => SessionOpening::TerminalActive,
            // Another connection of the runtime drives it; the chat follows
            // it by its key.
            WriterRefusal::WriterActive {
                writer: Writer::Acp,
            } => SessionOpening::Opened {
                session: session.clone(),
                liveness,
                session_values: None,
            },
        }),
        Err(AgentRuntimeError::OpenUnsupported | AgentRuntimeError::SessionNotFound) => {
            Ok(SessionOpening::Unsupported)
        }
        Err(AgentRuntimeError::AuthRequired { message }) => {
            Ok(SessionOpening::AuthRequired { message })
        }
        Err(error) => Err(error),
    }
}

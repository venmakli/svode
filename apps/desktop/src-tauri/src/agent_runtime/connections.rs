//! Desktop owner of agent connections (Stage 10 `02` C1/C3, `03` A1). An
//! agent's ACP entrypoint starts only at a lifecycle boundary and only for
//! an available agent: an open Sessions collection for the agents whose
//! catalogue is their ACP list, the user's explicit check, an agent chosen
//! in a new session draft (with the session it creates early where the
//! agent has evidence for it), the creation of a session and opening one in
//! the chat; a Routine/Actor launch acquires through the same planner in its
//! slice. Sharing by launch plan, the provenance split and closing for
//! idleness belong to the runtime.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use svode_agents::adapters::LaunchUnavailable;
use svode_agents::custom::CustomAgentDefinition;
use svode_agents::identity::SessionKey;
use svode_agents::prompt::PromptPart;
use svode_agents::writer::{ExternalLiveness, UnknownLiveness, Writer, WriterRefusal};
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
    },
    /// Attaching the session needs the user's confirmation of this attempt:
    /// nothing tells whether another process writes to it.
    ConfirmationRequired,
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
        Ok((lease, launch))
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
    /// it, else the session is attached with the writer. `attach` attaches
    /// it right away and is the user's confirmation of this one attempt.
    /// Opening never sends a prompt, and a session a managed terminal
    /// drives is left to it.
    pub async fn open_session(
        &self,
        agent: &str,
        session: &SessionKey,
        cwd: &Path,
        liveness: ExternalLiveness,
        attach: bool,
    ) -> Result<SessionOpening, AgentRuntimeError> {
        if self.runtime.writers().writer(session) == Some(Writer::Pty) {
            return Ok(SessionOpening::TerminalActive);
        }
        let lease = match self.acquire(agent).await {
            Ok(lease) => lease,
            Err(ConnectRefusal::Unavailable(reason)) => {
                return Ok(SessionOpening::Unavailable { reason });
            }
            Err(ConnectRefusal::Failed(error)) => return opening(Err(error), session, liveness),
        };
        if !attach {
            match self
                .runtime
                .read_session(lease.connection(), session, cwd)
                .await
            {
                Err(AgentRuntimeError::ReadOnlyUnsupported) => {}
                read => return opening(read, session, liveness),
            }
        }
        let unknown = if attach {
            UnknownLiveness::Confirmed
        } else {
            UnknownLiveness::NotConfirmed
        };
        let attached = self
            .runtime
            .open_session(lease.connection(), session, cwd, liveness, unknown)
            .await;
        opening(attached, session, liveness)
    }

    /// The chat no longer drives the session, e.g. to continue it in the
    /// terminal; refused during a turn.
    pub async fn release_session(&self, session: &SessionKey) -> Result<(), AgentRuntimeError> {
        self.runtime.release_session(session).await
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

/// The opening outcome of a runtime call; refusals the chat shows as states
/// are outcomes, other errors stay errors.
fn opening(
    result: Result<(), AgentRuntimeError>,
    session: &SessionKey,
    liveness: ExternalLiveness,
) -> Result<SessionOpening, AgentRuntimeError> {
    match result {
        Ok(()) => Ok(SessionOpening::Opened {
            session: session.clone(),
            liveness,
        }),
        Err(AgentRuntimeError::WriterRefused { refusal }) => Ok(match refusal {
            WriterRefusal::ConfirmationRequired => SessionOpening::ConfirmationRequired,
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

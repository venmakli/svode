//! In-memory projection of one session: the snapshot, its monotonic seq,
//! delivery of deltas and item detail. Lives in the runtime owner process
//! only; nothing here is persisted.

use std::collections::HashMap;

use tokio::sync::broadcast;

use crate::acp::normalize::{self, MessageRole, Normalized, ToolUpdate};
use crate::activity::{
    ActivityItem, Change, ConnectionState, DetailBlock, DetailOutcome, HistorySource, HistoryState,
    InteractionState, ItemKind, ItemStatus, PendingInteraction, SessionDelta, SessionSnapshot,
    TurnPhase, TurnState, UnavailableReason, WriterState,
};
use crate::identity::SessionKey;
use crate::status::{SessionState, SessionStatus, StopReason};

/// Summary bound of one item; longer content is the item detail.
const SUMMARY_LIMIT: usize = 4 * 1024;
/// Per-item detail bound (C4); beyond it the detail is `too_large`.
/// Tunable, not contract.
pub(crate) const DETAIL_LIMIT: usize = 1024 * 1024;
/// Deltas a slow subscriber may lag before it sees a seq gap.
const DELTA_BUFFER: usize = 1024;

enum Detail {
    Blocks(Vec<DetailBlock>),
    TooLarge,
}

pub(crate) struct Subscription {
    pub snapshot: SessionSnapshot,
    pub deltas: broadcast::Receiver<SessionDelta>,
}

pub(crate) struct Projection {
    snapshot: SessionSnapshot,
    sender: broadcast::Sender<SessionDelta>,
    details: HashMap<String, Detail>,
    /// Item that chunks without a `messageId` extend, with its role.
    open_message: Option<(MessageRole, String)>,
    next_local_id: u64,
}

impl Projection {
    pub(crate) fn new(session: SessionKey, connection: ConnectionState) -> Self {
        let (sender, _) = broadcast::channel(DELTA_BUFFER);
        Self {
            snapshot: SessionSnapshot {
                seq: 0,
                session,
                connection,
                turn: TurnState {
                    turn_id: None,
                    phase: TurnPhase::None,
                    last_outcome: None,
                    status: SessionStatus::runtime(SessionState::Idle { stop_reason: None }),
                },
                items: Vec::new(),
                plan: None,
                pending: None,
                history: HistoryState {
                    source: HistorySource::Live,
                    available: true,
                    truncated_items: None,
                },
                writer: WriterState::Acp,
            },
            sender,
            details: HashMap::new(),
            open_message: None,
            next_local_id: 0,
        }
    }

    pub(crate) fn subscribe(&self) -> Subscription {
        Subscription {
            snapshot: self.snapshot.clone(),
            deltas: self.sender.subscribe(),
        }
    }

    pub(crate) fn turn_active(&self) -> bool {
        self.snapshot.turn.phase != TurnPhase::None
    }

    /// Starts a turn with the user's prompt; `None` while a turn is active.
    pub(crate) fn begin_turn(&mut self, turn_id: &str, prompt: &str) -> Option<()> {
        if self.turn_active() {
            return None;
        }
        self.open_message = None;
        self.set_turn(Some(turn_id.to_string()), TurnPhase::Running, None);
        self.put_text_item(
            format!("user:{turn_id}"),
            ItemKind::UserMessage,
            prompt.to_string(),
        );
        Some(())
    }

    pub(crate) fn cancelling(&mut self) {
        if self.snapshot.turn.phase == TurnPhase::Running {
            let turn = self.snapshot.turn.turn_id.clone();
            self.set_turn(turn, TurnPhase::Cancelling, self.snapshot.turn.last_outcome);
        }
    }

    /// Ends the active turn once; later calls for the same turn are ignored.
    pub(crate) fn finish_turn(&mut self, turn_id: &str, reason: StopReason, error: Option<String>) {
        if !self.turn_active() || self.snapshot.turn.turn_id.as_deref() != Some(turn_id) {
            return;
        }
        if let Some(pending) = self.snapshot.pending.clone() {
            self.resolve_pending(&pending.id, Self::pending_outcome(reason));
        }
        self.open_message = None;
        if let Some(message) = error {
            let id = self.local_id(turn_id, "error");
            self.put_text_item(id, ItemKind::Error, message);
        }
        let kind = if reason == StopReason::Interrupted {
            ItemKind::Interrupted
        } else {
            ItemKind::TurnOutcome { reason }
        };
        self.upsert(ActivityItem {
            id: format!("outcome:{turn_id}"),
            turn_id: Some(turn_id.to_string()),
            kind,
            status: None,
            summary: String::new(),
            has_detail: false,
        });
        self.set_turn(Some(turn_id.to_string()), TurnPhase::None, Some(reason));
    }

    /// The connection is gone: the active turn ends `interrupted` and an open
    /// request expires.
    pub(crate) fn interrupt(&mut self) {
        match self.current_turn() {
            Some(turn_id) => self.finish_turn(&turn_id, StopReason::Interrupted, None),
            None => {
                if let Some(pending) = self.snapshot.pending.clone() {
                    self.resolve_pending(&pending.id, InteractionState::Expired);
                }
            }
        }
    }

    /// What a request still pending when a turn ends with `reason` becomes.
    pub(crate) fn pending_outcome(reason: StopReason) -> InteractionState {
        match reason {
            StopReason::Cancelled => InteractionState::Cancelled,
            _ => InteractionState::Expired,
        }
    }

    pub(crate) fn pending(&self) -> Option<&PendingInteraction> {
        self.snapshot.pending.as_ref()
    }

    pub(crate) fn set_pending(&mut self, pending: PendingInteraction) {
        self.emit(Change::Pending(pending));
        self.refresh_status();
    }

    pub(crate) fn resolve_pending(&mut self, id: &str, state: InteractionState) {
        let Some(mut pending) = self
            .snapshot
            .pending
            .clone()
            .filter(|pending| pending.id == id)
        else {
            return;
        };
        pending.state = state;
        self.emit(Change::Pending(pending));
        self.refresh_status();
    }

    pub(crate) fn set_connection(&mut self, connection: ConnectionState) {
        if self.snapshot.connection != connection {
            self.emit(Change::Connection(connection));
        }
    }

    pub(crate) fn set_writer(&mut self, writer: WriterState) {
        if self.snapshot.writer != writer {
            self.emit(Change::Writer(writer));
        }
    }

    pub(crate) fn apply(&mut self, normalized: Normalized) {
        match normalized {
            Normalized::Message {
                role,
                message_id,
                text,
            } => self.append_message(role, message_id, &text),
            Normalized::Tool(update) => self.upsert_tool(update),
            Normalized::Plan(plan) => {
                self.open_message = None;
                self.emit(Change::Plan(plan));
            }
            Normalized::ModeChange(mode) => {
                let id = self.local_id("session", "mode");
                self.put_text_item(id, ItemKind::ModeChange, mode);
            }
            Normalized::ConfigChange => {
                let id = self.local_id("session", "config");
                self.put_text_item(id, ItemKind::ConfigChange, String::new());
            }
            Normalized::Usage { used, size } => {
                self.upsert(ActivityItem {
                    id: "usage".into(),
                    turn_id: self.snapshot.turn.turn_id.clone(),
                    kind: ItemKind::Usage,
                    status: None,
                    summary: format!("{used}/{size}"),
                    has_detail: false,
                });
            }
            Normalized::None => {}
            Normalized::Generic(label) => {
                let id = self.local_id("session", "generic");
                self.upsert(ActivityItem {
                    id,
                    turn_id: self.current_turn(),
                    kind: ItemKind::Generic { label },
                    status: None,
                    summary: String::new(),
                    has_detail: false,
                });
            }
        }
    }

    pub(crate) fn detail(&self, item_id: &str) -> DetailOutcome {
        match self.details.get(item_id) {
            Some(Detail::Blocks(blocks)) => DetailOutcome::Available {
                blocks: blocks.clone(),
            },
            Some(Detail::TooLarge) => DetailOutcome::Unavailable {
                reason: UnavailableReason::TooLarge,
            },
            None if self.snapshot.items.iter().any(|item| item.id == item_id) => {
                DetailOutcome::Unavailable {
                    reason: UnavailableReason::NotProvided,
                }
            }
            None => DetailOutcome::Error {
                message: format!("no item {item_id} in this session"),
            },
        }
    }

    fn append_message(&mut self, role: MessageRole, message_id: Option<String>, text: &str) {
        let id = match message_id {
            Some(id) => id,
            None => match &self.open_message {
                Some((open_role, id)) if *open_role == role => id.clone(),
                _ => {
                    let turn = self.current_turn().unwrap_or_else(|| "session".into());
                    self.local_id(&turn, "message")
                }
            },
        };
        self.open_message = Some((role, id.clone()));
        let mut full = match self.details.get(&id) {
            Some(Detail::Blocks(blocks)) => match blocks.first() {
                Some(DetailBlock::Text { text }) => text.clone(),
                _ => String::new(),
            },
            Some(Detail::TooLarge) => return,
            None => String::new(),
        };
        full.push_str(text);
        let kind = match role {
            MessageRole::User => ItemKind::UserMessage,
            MessageRole::Agent => ItemKind::AgentMessage,
            MessageRole::Reasoning => ItemKind::Reasoning,
        };
        self.put_text_item(id, kind, full);
    }

    fn upsert_tool(&mut self, update: ToolUpdate) {
        self.open_message = None;
        let known = self
            .snapshot
            .items
            .iter()
            .find(|item| item.id == update.id)
            .cloned();
        let (kind, status, summary) = match &known {
            Some(item) => (item.kind.clone(), item.status, item.summary.clone()),
            None => (
                ItemKind::ToolCall {
                    tool: crate::activity::ToolKind::Other,
                },
                Some(ItemStatus::Pending),
                String::new(),
            ),
        };
        let kind = match update.tool {
            Some(tool) => ItemKind::ToolCall { tool },
            None => kind,
        };
        let mut has_detail = known.as_ref().is_some_and(|item| item.has_detail);
        if let Some(blocks) = update.blocks {
            has_detail = !blocks.is_empty();
            self.store_detail(&update.id, blocks);
        }
        self.upsert(ActivityItem {
            id: update.id,
            turn_id: match known {
                Some(item) => item.turn_id,
                None => self.current_turn(),
            },
            kind,
            status: update.status.or(status),
            summary: update
                .title
                .map(|title| normalize::bounded(&title, SUMMARY_LIMIT))
                .unwrap_or(summary),
            has_detail,
        });
    }

    fn put_text_item(&mut self, id: String, kind: ItemKind, text: String) {
        let has_detail = text.len() > SUMMARY_LIMIT;
        let summary = normalize::bounded(&text, SUMMARY_LIMIT);
        if has_detail {
            self.store_detail(&id, vec![DetailBlock::Text { text }]);
        } else {
            self.details
                .insert(id.clone(), Detail::Blocks(vec![DetailBlock::Text { text }]));
        }
        let turn_id = self
            .snapshot
            .items
            .iter()
            .find(|item| item.id == id)
            .map(|item| item.turn_id.clone())
            .unwrap_or_else(|| self.current_turn());
        self.upsert(ActivityItem {
            id,
            turn_id,
            kind,
            status: None,
            summary,
            has_detail,
        });
    }

    fn store_detail(&mut self, id: &str, blocks: Vec<DetailBlock>) {
        let size: usize = blocks.iter().map(block_size).sum();
        let detail = if size > DETAIL_LIMIT {
            Detail::TooLarge
        } else {
            Detail::Blocks(blocks)
        };
        self.details.insert(id.to_string(), detail);
    }

    fn upsert(&mut self, item: ActivityItem) {
        self.emit(Change::Item(item));
    }

    fn set_turn(&mut self, turn_id: Option<String>, phase: TurnPhase, outcome: Option<StopReason>) {
        let status = status_of(phase, outcome, self.snapshot.pending.as_ref());
        self.emit(Change::Turn(TurnState {
            turn_id,
            phase,
            last_outcome: outcome,
            status,
        }));
    }

    fn refresh_status(&mut self) {
        let turn = &self.snapshot.turn;
        let status = status_of(
            turn.phase,
            turn.last_outcome,
            self.snapshot.pending.as_ref(),
        );
        if status != turn.status {
            let (turn_id, phase, outcome) = (turn.turn_id.clone(), turn.phase, turn.last_outcome);
            self.set_turn(turn_id, phase, outcome);
        }
    }

    fn emit(&mut self, change: Change) {
        let delta = SessionDelta {
            seq: self.snapshot.seq + 1,
            change,
        };
        self.snapshot.apply(&delta);
        let _ = self.sender.send(delta);
    }

    fn current_turn(&self) -> Option<String> {
        self.turn_active()
            .then(|| self.snapshot.turn.turn_id.clone())
            .flatten()
    }

    fn local_id(&mut self, scope: &str, kind: &str) -> String {
        self.next_local_id += 1;
        format!("{scope}:{kind}:{}", self.next_local_id)
    }
}

fn status_of(
    phase: TurnPhase,
    outcome: Option<StopReason>,
    pending: Option<&PendingInteraction>,
) -> SessionStatus {
    SessionStatus::runtime(match (phase, pending) {
        (TurnPhase::None, _) => SessionState::Idle {
            stop_reason: outcome,
        },
        (_, Some(pending)) => SessionState::RequiresAction {
            request: pending.kind,
        },
        (_, None) => SessionState::Running,
    })
}

fn block_size(block: &DetailBlock) -> usize {
    match block {
        DetailBlock::Text { text } => text.len(),
        DetailBlock::Diff {
            path,
            old_text,
            new_text,
        } => path.len() + old_text.as_ref().map_or(0, String::len) + new_text.len(),
        DetailBlock::Terminal { terminal_id } => terminal_id.len(),
    }
}

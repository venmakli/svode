//! In-memory projection of one session: the snapshot, its monotonic seq,
//! delivery of deltas, item detail and their retention bounds (Stage 10 `02`
//! C4). Lives in the runtime owner process only; nothing here is persisted.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Instant, SystemTime};

use tokio::sync::broadcast;

use crate::acp::normalize::{self, DeclaredSettings, MessageRole, Normalized, ToolUpdate};
use crate::activity::{
    ActivityItem, Change, ConnectionState, DetailBlock, DetailOutcome, HistorySource, HistoryState,
    InteractionState, ItemKind, ItemStatus, MessageSegment, PendingInteraction, PlanEntry,
    SessionDelta, SessionSetting, SessionSnapshot, Truncation, TurnPhase, TurnState,
    UnavailableReason, WriterState,
};
use crate::identity::SessionKey;
use crate::interaction::InteractionAnswer;
use crate::runtime::Retention;
use crate::status::{SessionState, SessionStatus, StopReason};

/// Summary bound of one item; longer content is the item detail.
const SUMMARY_LIMIT: usize = 4 * 1024;
/// Deltas a slow subscriber may lag before it sees a seq gap.
const DELTA_BUFFER: usize = 1024;
/// Fixed share of one item in the compact bound besides its texts.
const ITEM_OVERHEAD: usize = 64;

enum Detail {
    /// The content with its size in bytes.
    Blocks(Vec<DetailBlock>, usize),
    /// Detail other than text beyond the per-item bound; never kept.
    TooLarge,
    /// Released under the process bound; the summary stays.
    Released,
}

impl Detail {
    fn size(&self) -> usize {
        match self {
            Detail::Blocks(_, size) => *size,
            Detail::TooLarge | Detail::Released => 0,
        }
    }
}

/// A `session/load` replay in progress. ACP v1 replays turns without
/// delimiters, so each user message starts the next replay turn: whole
/// turns are what retention evicts.
#[derive(Default)]
struct Replay {
    turns: u64,
    turn: Option<String>,
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
    retention: Retention,
    /// Detail bytes of every open session of the process.
    process_detail: Arc<AtomicUsize>,
    /// This session's share of `process_detail`.
    detail_bytes: usize,
    compact_bytes: usize,
    replay: Option<Replay>,
    /// The settings are legacy session modes, changed by `session/set_mode`.
    legacy_modes: bool,
    /// When the runtime accepted the prompt of the live turn.
    turn_started: Option<Instant>,
    /// When the session last changed.
    updated_at: SystemTime,
}

impl Projection {
    /// A projection whose history is `history`; a `replay` one numbers
    /// replay turns until [`Projection::end_replay`].
    pub(crate) fn new(
        session: SessionKey,
        connection: ConnectionState,
        history: HistoryState,
        replay: bool,
        writer: WriterState,
        retention: Retention,
        process_detail: Arc<AtomicUsize>,
    ) -> Self {
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
                pending: None,
                history,
                writer,
                settings: Vec::new(),
                commands: Vec::new(),
                usage: None,
                title: None,
            },
            sender,
            details: HashMap::new(),
            open_message: None,
            next_local_id: 0,
            retention,
            process_detail,
            detail_bytes: 0,
            compact_bytes: 0,
            replay: replay.then(Replay::default),
            legacy_modes: false,
            turn_started: None,
            updated_at: SystemTime::now(),
        }
    }

    /// History of a new session the runtime starts: live from its first turn.
    pub(crate) fn live_history() -> HistoryState {
        HistoryState {
            source: HistorySource::Live,
            available: true,
            truncated_items: None,
        }
    }

    /// The agent answered `session/load`: the replay is complete.
    pub(crate) fn end_replay(&mut self) {
        self.replay = None;
        self.open_message = None;
    }

    /// Consumers holding a delivery of this session.
    pub(crate) fn subscribers(&self) -> usize {
        self.sender.receiver_count()
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

    /// Starts a turn with the user's prompt, its text and its segments;
    /// `None` while a turn is active.
    pub(crate) fn begin_turn(
        &mut self,
        turn_id: &str,
        text: &str,
        segments: Vec<MessageSegment>,
    ) -> Option<()> {
        if self.turn_active() {
            return None;
        }
        self.open_message = None;
        self.turn_started = Some(Instant::now());
        self.set_turn(Some(turn_id.to_string()), TurnPhase::Running, None);
        self.put_text_item(
            format!("user:{turn_id}"),
            ItemKind::UserMessage {
                segments: bounded_segments(segments),
            },
            text.to_string(),
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
            self.resolve_pending(&pending.id, Self::pending_outcome(reason), None);
        }
        self.open_message = None;
        if let Some(message) = error {
            let id = self.local_id(turn_id, "error");
            self.put_text_item(id, ItemKind::Error, message);
        }
        let duration_ms = self
            .turn_started
            .take()
            .map(|started| started.elapsed().as_millis() as u64);
        let kind = if reason == StopReason::Interrupted {
            ItemKind::Interrupted { duration_ms }
        } else {
            ItemKind::TurnOutcome {
                reason,
                duration_ms,
            }
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
                    self.resolve_pending(&pending.id, InteractionState::Expired, None);
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

    /// Closes the pending interaction with `state` and records it in the
    /// timeline with the answer that closed it.
    pub(crate) fn resolve_pending(
        &mut self,
        id: &str,
        state: InteractionState,
        answer: Option<&InteractionAnswer>,
    ) {
        let Some(mut pending) = self
            .snapshot
            .pending
            .clone()
            .filter(|pending| pending.id == id)
        else {
            return;
        };
        pending.state = state;
        let option = match answer {
            Some(InteractionAnswer::Option { option_id }) => pending
                .options
                .iter()
                .find(|option| &option.id == option_id)
                .map(|option| option.label.clone()),
            _ => None,
        };
        let record = ActivityItem {
            id: pending.id.clone(),
            turn_id: self.current_turn(),
            kind: ItemKind::Interaction {
                request: pending.kind,
                state,
                tool_call_id: pending.tool_call_id.clone(),
                option,
                declined: matches!(answer, Some(InteractionAnswer::Decline)),
            },
            status: None,
            summary: normalize::bounded(&pending.title, SUMMARY_LIMIT),
            has_detail: false,
        };
        self.emit(Change::Pending(pending));
        self.upsert(record);
        self.refresh_status();
    }

    /// The tool call a permission request is for, merged into its timeline
    /// item like any update of that call.
    pub(crate) fn merge_tool_call(&mut self, update: ToolUpdate) {
        self.upsert_tool(update);
    }

    pub(crate) fn title(&self) -> Option<&str> {
        self.snapshot.title.as_deref()
    }

    pub(crate) fn status(&self) -> SessionStatus {
        self.snapshot.turn.status
    }

    pub(crate) fn updated_at(&self) -> SystemTime {
        self.updated_at
    }

    pub(crate) fn set_connection(&mut self, connection: ConnectionState) {
        if self.snapshot.connection != connection {
            self.emit(Change::Connection(connection));
        }
    }

    pub(crate) fn settings(&self) -> &[SessionSetting] {
        &self.snapshot.settings
    }

    pub(crate) fn legacy_modes(&self) -> bool {
        self.legacy_modes
    }

    /// The settings the agent declared or confirmed.
    pub(crate) fn set_settings(&mut self, declared: DeclaredSettings) {
        self.legacy_modes = declared.legacy_modes;
        if self.snapshot.settings != declared.settings {
            self.emit(Change::Settings(declared.settings));
        }
    }

    /// The agent confirmed `mode` as the current legacy session mode.
    pub(crate) fn set_legacy_mode(&mut self, mode: &str) {
        if !self.legacy_modes {
            return;
        }
        let mut settings = self.snapshot.settings.clone();
        let Some(setting) = settings
            .iter_mut()
            .find(|setting| setting.id == normalize::LEGACY_MODE_SETTING)
        else {
            return;
        };
        if setting.current_value != mode {
            setting.current_value = mode.to_string();
            self.emit(Change::Settings(settings));
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
                segments,
            } => self.append_message(role, message_id, &text, segments),
            Normalized::Tool(update) => self.upsert_tool(update),
            Normalized::Plan(entries) => self.put_plan(entries),
            Normalized::ModeChange(mode) => {
                self.set_legacy_mode(&mode);
                let id = self.local_id("session", "mode");
                self.put_text_item(id, ItemKind::ModeChange, mode);
            }
            Normalized::ConfigChange(settings) => {
                self.set_settings(DeclaredSettings {
                    settings,
                    legacy_modes: false,
                });
                let id = self.local_id("session", "config");
                self.put_text_item(id, ItemKind::ConfigChange, String::new());
            }
            Normalized::Commands(commands) => {
                if self.snapshot.commands != commands {
                    self.emit(Change::Commands(commands));
                }
            }
            Normalized::Usage(usage) => {
                if self.snapshot.usage.as_ref() != Some(&usage) {
                    self.emit(Change::Usage(usage));
                }
            }
            Normalized::Title(title) => {
                if self.snapshot.title.as_deref() != Some(title.as_str()) {
                    self.emit(Change::Title(title));
                }
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
            Some(Detail::Blocks(blocks, _)) => DetailOutcome::Available {
                blocks: blocks.clone(),
            },
            Some(Detail::TooLarge) => DetailOutcome::Unavailable {
                reason: UnavailableReason::TooLarge,
            },
            Some(Detail::Released) => DetailOutcome::Unavailable {
                reason: UnavailableReason::Released,
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

    /// Releases the detail of the oldest items outside the current turn
    /// until `need` bytes are freed; summaries stay. Returns the bytes freed.
    pub(crate) fn release_detail(&mut self, need: usize) -> usize {
        let current = self.current_turn();
        let candidates: Vec<String> = self
            .snapshot
            .items
            .iter()
            .filter(|item| current.is_none() || item.turn_id != current)
            .map(|item| item.id.clone())
            .collect();
        let mut freed = 0;
        for id in candidates {
            if freed >= need {
                break;
            }
            if self
                .details
                .get(&id)
                .is_some_and(|detail| detail.size() > 0)
            {
                freed += self.set_detail(&id, Detail::Released);
            }
        }
        freed
    }

    fn append_message(
        &mut self,
        role: MessageRole,
        message_id: Option<String>,
        text: &str,
        segments: Vec<MessageSegment>,
    ) {
        if role == MessageRole::User && self.replay.is_some() {
            let continues = match (&self.open_message, &message_id) {
                (Some((MessageRole::User, open)), Some(id)) => open == id,
                (Some((MessageRole::User, _)), None) => true,
                _ => false,
            };
            if !continues {
                self.next_replay_turn();
            }
        }
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
        let known = match self.details.get(&id) {
            Some(Detail::Blocks(blocks, _)) => match blocks.first() {
                Some(block @ (DetailBlock::Text { .. } | DetailBlock::Excerpt { .. })) => {
                    block.clone()
                }
                _ => DetailBlock::Text {
                    text: String::new(),
                },
            },
            Some(Detail::TooLarge | Detail::Released) => return,
            None => DetailBlock::Text {
                text: String::new(),
            },
        };
        let kind = match role {
            MessageRole::User => ItemKind::UserMessage {
                segments: self.extend_segments(&id, &known, text, segments),
            },
            MessageRole::Agent => ItemKind::AgentMessage,
            MessageRole::Reasoning => ItemKind::Reasoning,
        };
        let block = extend_text(known, text, self.retention.item_detail);
        self.put_text_block(id, kind, block);
    }

    /// The segments of user message `id` with the next chunk, `text` or its
    /// own segments: a message turns into segments with its first link or
    /// image, after the text so far.
    fn extend_segments(
        &self,
        id: &str,
        known: &DetailBlock,
        text: &str,
        chunk: Vec<MessageSegment>,
    ) -> Vec<MessageSegment> {
        let mut segments = match self.snapshot.items.iter().find(|item| item.id == id) {
            Some(ActivityItem {
                kind: ItemKind::UserMessage { segments },
                ..
            }) => segments.clone(),
            _ => Vec::new(),
        };
        if chunk.is_empty() {
            if !segments.is_empty() {
                segments.push(MessageSegment::Text {
                    text: text.to_string(),
                });
            }
            return bounded_segments(segments);
        }
        if segments.is_empty() {
            let before = match known {
                DetailBlock::Text { text } => text.as_str(),
                DetailBlock::Excerpt { head, .. } => head.as_str(),
                DetailBlock::Diff { .. } | DetailBlock::Terminal { .. } => "",
            };
            segments.push(MessageSegment::Text {
                text: before.to_string(),
            });
        }
        segments.extend(chunk);
        bounded_segments(segments)
    }

    /// One plan item per turn at the place the turn's first plan appeared;
    /// a later plan of the turn replaces it in place.
    fn put_plan(&mut self, entries: Vec<PlanEntry>) {
        self.open_message = None;
        let turn_id = self.current_turn();
        let id = format!("plan:{}", turn_id.as_deref().unwrap_or("session"));
        self.upsert(ActivityItem {
            id,
            turn_id,
            kind: ItemKind::Plan { entries },
            status: None,
            summary: String::new(),
            has_detail: false,
        });
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
        let block = excerpt(text, self.retention.item_detail);
        self.put_text_block(id, kind, block);
    }

    /// Puts a text item whose detail `block` — text or its excerpt — is
    /// already within the per-item bound.
    fn put_text_block(&mut self, id: String, kind: ItemKind, block: DetailBlock) {
        let (head, excerpted) = match &block {
            DetailBlock::Text { text } => (text.as_str(), false),
            DetailBlock::Excerpt { head, .. } => (head.as_str(), true),
            DetailBlock::Diff { .. } | DetailBlock::Terminal { .. } => ("", false),
        };
        let has_detail = excerpted || head.len() > SUMMARY_LIMIT;
        let summary = normalize::bounded(head, SUMMARY_LIMIT);
        let size = block_size(&block);
        self.set_detail(&id, Detail::Blocks(vec![block], size));
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
        let detail = bounded_detail(blocks, self.retention.item_detail);
        self.set_detail(id, detail);
    }

    /// Replaces the item's detail; returns the bytes the old one held.
    fn set_detail(&mut self, id: &str, detail: Detail) -> usize {
        self.track_detail(detail.size());
        let old = self
            .details
            .insert(id.to_string(), detail)
            .map_or(0, |old| old.size());
        self.untrack_detail(old);
        old
    }

    fn track_detail(&mut self, bytes: usize) {
        self.detail_bytes += bytes;
        self.process_detail.fetch_add(bytes, Ordering::Relaxed);
    }

    fn untrack_detail(&mut self, bytes: usize) {
        self.detail_bytes -= bytes;
        self.process_detail.fetch_sub(bytes, Ordering::Relaxed);
    }

    fn upsert(&mut self, item: ActivityItem) {
        let old = self
            .snapshot
            .items
            .iter()
            .find(|known| known.id == item.id)
            .map_or(0, compact_size);
        self.compact_bytes = self.compact_bytes - old + compact_size(&item);
        self.emit(Change::Item(item));
        self.enforce_session_bounds();
    }

    /// Evicts the oldest turns whole while the session is over its item or
    /// compact bound. The current turn — and with it the pending
    /// interaction — is never evicted.
    fn enforce_session_bounds(&mut self) {
        while self.snapshot.items.len() > self.retention.session_items
            || self.compact_bytes > self.retention.session_bytes
        {
            let current = self.current_turn();
            let Some(oldest) = self
                .snapshot
                .items
                .iter()
                .find(|item| item.turn_id.is_none() || item.turn_id != current)
            else {
                return;
            };
            let ids: Vec<String> = match &oldest.turn_id {
                Some(turn) => self
                    .snapshot
                    .items
                    .iter()
                    .filter(|item| item.turn_id.as_ref() == Some(turn))
                    .map(|item| item.id.clone())
                    .collect(),
                None => vec![oldest.id.clone()],
            };
            self.evict(ids);
        }
    }

    fn evict(&mut self, item_ids: Vec<String>) {
        for item in &self.snapshot.items {
            if item_ids.contains(&item.id) {
                self.compact_bytes -= compact_size(item);
            }
        }
        for id in &item_ids {
            if let Some(detail) = self.details.remove(id) {
                self.untrack_detail(detail.size());
            }
        }
        if self
            .open_message
            .as_ref()
            .is_some_and(|(_, id)| item_ids.contains(id))
        {
            self.open_message = None;
        }
        let evicted = self.snapshot.history.truncated_items.unwrap_or(0) + item_ids.len() as u64;
        let history = HistoryState {
            truncated_items: Some(evicted),
            ..self.snapshot.history
        };
        self.emit(Change::Truncated(Truncation { item_ids, history }));
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
        self.updated_at = SystemTime::now();
        let delta = SessionDelta {
            seq: self.snapshot.seq + 1,
            change,
        };
        self.snapshot.apply(&delta);
        let _ = self.sender.send(delta);
    }

    /// The live turn, or the replay turn a `session/load` is replaying.
    fn current_turn(&self) -> Option<String> {
        if self.turn_active() {
            return self.snapshot.turn.turn_id.clone();
        }
        self.replay.as_ref().and_then(|replay| replay.turn.clone())
    }

    fn next_replay_turn(&mut self) {
        if let Some(replay) = &mut self.replay {
            replay.turns += 1;
            replay.turn = Some(format!("replay:{}", replay.turns));
        }
        self.open_message = None;
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

impl Drop for Projection {
    fn drop(&mut self) {
        self.process_detail
            .fetch_sub(self.detail_bytes, Ordering::Relaxed);
    }
}

/// Segments of one user message within the summary bound: adjacent texts
/// are joined, empty ones dropped, and text beyond the bound and parts
/// after it are cut.
fn bounded_segments(segments: Vec<MessageSegment>) -> Vec<MessageSegment> {
    let mut bounded: Vec<MessageSegment> = Vec::with_capacity(segments.len());
    let mut size = 0;
    for segment in segments {
        if size >= SUMMARY_LIMIT {
            break;
        }
        match segment {
            MessageSegment::Text { text } if text.is_empty() => {}
            MessageSegment::Text { text } => {
                let text = normalize::bounded(&text, SUMMARY_LIMIT - size);
                size += text.len();
                match bounded.last_mut() {
                    Some(MessageSegment::Text { text: last }) => last.push_str(&text),
                    _ => bounded.push(MessageSegment::Text { text }),
                }
            }
            other => {
                size += segment_size(&other);
                bounded.push(other);
            }
        }
    }
    bounded
}

fn segment_size(segment: &MessageSegment) -> usize {
    match segment {
        MessageSegment::Text { text } => text.len(),
        MessageSegment::Link { uri, name } => uri.len() + name.len(),
        MessageSegment::Image { uri, name } => {
            uri.as_ref().map_or(0, String::len) + name.as_ref().map_or(0, String::len)
        }
    }
}

/// Size of an item in the compact bound.
fn compact_size(item: &ActivityItem) -> usize {
    let label = match &item.kind {
        ItemKind::UserMessage { segments } => segments.iter().map(segment_size).sum(),
        ItemKind::Generic { label } => label.len(),
        ItemKind::Plan { entries } => entries.iter().map(|entry| entry.content.len()).sum(),
        ItemKind::Interaction { option, .. } => option.as_ref().map_or(0, String::len),
        _ => 0,
    };
    ITEM_OVERHEAD
        + item.id.len()
        + item.turn_id.as_ref().map_or(0, String::len)
        + item.summary.len()
        + label
}

/// The per-item bound: text beyond it keeps its head and tail, any other
/// detail beyond it is `too_large`. Several text blocks beyond it become
/// one excerpt of their joined text.
fn bounded_detail(blocks: Vec<DetailBlock>, limit: usize) -> Detail {
    let size: usize = blocks.iter().map(block_size).sum();
    if size <= limit {
        return Detail::Blocks(blocks, size);
    }
    let mut texts = Vec::new();
    let mut terminals = Vec::new();
    for block in blocks {
        match block {
            DetailBlock::Text { text } => texts.push(text),
            DetailBlock::Terminal { .. } => terminals.push(block),
            DetailBlock::Excerpt { .. } | DetailBlock::Diff { .. } => return Detail::TooLarge,
        }
    }
    let budget = limit.saturating_sub(terminals.iter().map(block_size).sum());
    if texts.is_empty() || budget == 0 {
        return Detail::TooLarge;
    }
    let mut blocks = vec![excerpt(texts.join("\n"), budget)];
    blocks.extend(terminals);
    let size = blocks.iter().map(block_size).sum();
    Detail::Blocks(blocks, size)
}

/// `text` within `limit` bytes: itself, or beyond it its head and tail with
/// the characters omitted between them.
fn excerpt(text: String, limit: usize) -> DetailBlock {
    if text.len() <= limit {
        return DetailBlock::Text { text };
    }
    let head_end = floor_char_boundary(&text, head_budget(limit));
    let tail_start = ceil_char_boundary(&text, text.len() - tail_budget(limit));
    DetailBlock::Excerpt {
        head: text[..head_end].to_string(),
        omitted_chars: text[head_end..tail_start].chars().count() as u64,
        tail: text[tail_start..].to_string(),
    }
}

/// Appends live `more` to a text detail: within `limit` the head stays
/// fixed and the tail follows the newest text.
fn extend_text(block: DetailBlock, more: &str, limit: usize) -> DetailBlock {
    match block {
        DetailBlock::Text { mut text } => {
            text.push_str(more);
            excerpt(text, limit)
        }
        DetailBlock::Excerpt {
            head,
            omitted_chars,
            mut tail,
        } => {
            tail.push_str(more);
            let cut = ceil_char_boundary(&tail, tail.len().saturating_sub(tail_budget(limit)));
            DetailBlock::Excerpt {
                head,
                omitted_chars: omitted_chars + tail[..cut].chars().count() as u64,
                tail: tail[cut..].to_string(),
            }
        }
        other => other,
    }
}

fn head_budget(limit: usize) -> usize {
    limit / 2
}

fn tail_budget(limit: usize) -> usize {
    limit - head_budget(limit)
}

fn floor_char_boundary(text: &str, mut index: usize) -> usize {
    while !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ceil_char_boundary(text: &str, mut index: usize) -> usize {
    while !text.is_char_boundary(index) {
        index += 1;
    }
    index
}

fn block_size(block: &DetailBlock) -> usize {
    match block {
        DetailBlock::Text { text } => text.len(),
        DetailBlock::Excerpt { head, tail, .. } => head.len() + tail.len(),
        DetailBlock::Diff {
            path,
            old_text,
            new_text,
        } => path.len() + old_text.as_ref().map_or(0, String::len) + new_text.len(),
        DetailBlock::Terminal { terminal_id } => terminal_id.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parts(block: &DetailBlock) -> (&str, u64, &str) {
        match block {
            DetailBlock::Excerpt {
                head,
                omitted_chars,
                tail,
            } => (head, *omitted_chars, tail),
            other => panic!("expected an excerpt, got {other:?}"),
        }
    }

    #[test]
    fn text_within_the_bound_is_unchanged() {
        let text = "a".repeat(16);
        assert_eq!(
            excerpt(text.clone(), 16),
            DetailBlock::Text { text: text.clone() }
        );
        assert_eq!(
            bounded_detail(vec![DetailBlock::Text { text: text.clone() }], 16).size(),
            16
        );
    }

    #[test]
    fn text_beyond_the_bound_keeps_head_and_tail_with_the_omitted_count() {
        let block = excerpt("0123456789abcdefXYZ".into(), 16);
        assert_eq!(parts(&block), ("01234567", 3, "bcdefXYZ"));
        assert!(block_size(&block) <= 16);
    }

    #[test]
    fn an_excerpt_never_splits_a_utf8_character() {
        let text = "й🙂".repeat(40);
        for limit in 1..64 {
            let block = excerpt(text.clone(), limit);
            let (head, omitted, tail) = parts(&block);
            assert!(head.len() + tail.len() <= limit, "limit {limit}");
            assert!(text.starts_with(head) && text.ends_with(tail));
            assert_eq!(
                head.chars().count() as u64 + omitted + tail.chars().count() as u64,
                text.chars().count() as u64
            );
        }
    }

    #[test]
    fn live_text_keeps_its_head_and_its_tail_matches_the_whole_text() {
        let chunks = ["01234", "5678й", "🙂abc", "def", "", "🙂🙂🙂🙂XYZ", "-more"];
        let mut block = DetailBlock::Text {
            text: String::new(),
        };
        let mut whole = String::new();
        let mut first_head: Option<String> = None;
        for chunk in chunks {
            block = extend_text(block, chunk, 16);
            whole.push_str(chunk);
            assert_eq!(block, excerpt(whole.clone(), 16), "after {whole:?}");
            if let DetailBlock::Excerpt { head, .. } = &block {
                assert_eq!(first_head.get_or_insert_with(|| head.clone()), head);
            }
        }
        assert!(first_head.is_some());
    }

    #[test]
    fn a_diff_beyond_the_bound_is_too_large() {
        let diff = DetailBlock::Diff {
            path: "a.rs".into(),
            old_text: None,
            new_text: "x".repeat(32),
        };
        let text = DetailBlock::Text {
            text: "y".repeat(32),
        };
        assert!(matches!(
            bounded_detail(vec![diff.clone()], 16),
            Detail::TooLarge
        ));
        assert!(matches!(
            bounded_detail(vec![text, diff], 16),
            Detail::TooLarge
        ));
    }

    #[test]
    fn text_blocks_beside_a_terminal_share_the_bound() {
        let detail = bounded_detail(
            vec![
                DetailBlock::Text {
                    text: "a".repeat(20),
                },
                DetailBlock::Terminal {
                    terminal_id: "t1".into(),
                },
                DetailBlock::Text {
                    text: "b".repeat(20),
                },
            ],
            18,
        );
        let Detail::Blocks(blocks, size) = detail else {
            panic!("text stays");
        };
        assert!(size <= 18);
        assert_eq!(parts(&blocks[0]), ("aaaaaaaa", 25, "bbbbbbbb"));
        assert_eq!(
            blocks[1],
            DetailBlock::Terminal {
                terminal_id: "t1".into()
            }
        );
    }
}

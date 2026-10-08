//! In-memory projection of one session: the snapshot, its monotonic seq,
//! delivery of deltas, item detail and their retention bounds (Stage 10 `02`
//! C4). Lives in the runtime owner process only; nothing here is persisted.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Instant, SystemTime};

use svode_core::agent_adapters::AgentAdapterKind;
use tokio::sync::broadcast;

use crate::acp::mcp;
use crate::acp::media::{self, MediaPart};
use crate::acp::normalize::{self, DeclaredSettings, MessageRole, Normalized, ToolUpdate};
use crate::activity::{
    ActivityItem, Change, ConnectionState, DetailBlock, DetailOutcome, HistorySource, HistoryState,
    InteractionState, ItemKind, ItemStatus, MediaKind, MediaOutcome, MediaSegment, MessageSegment,
    PendingInteraction, PlanEntry, SessionDelta, SessionSetting, SessionSnapshot, ToolKind,
    Truncation, TurnPhase, TurnState, UnavailableReason, WriterState,
};
use crate::changes::ToolPaths;
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

/// The data of one media segment (Stage 10 `08` R1); counted in the detail
/// bounds like any detail.
enum MediaData {
    Held {
        mime_type: String,
        data: String,
    },
    /// The segment is a file or a link.
    None,
    /// Beyond the per-item media bound; never kept.
    TooLarge,
    /// Released under the process bound; the segment stays.
    Released,
}

impl MediaData {
    fn size(&self) -> usize {
        match self {
            MediaData::Held { data, .. } => data.len(),
            MediaData::None | MediaData::TooLarge | MediaData::Released => 0,
        }
    }
}

/// What the media segments of a tool call are made of; its locations and
/// MCP form are the call's [`ToolPaths`].
#[derive(Default)]
struct ToolMedia {
    /// Without their data, which is held by segment index.
    parts: Vec<MediaPart>,
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
    /// Media data of items by segment index.
    media: HashMap<String, Vec<MediaData>>,
    tool_media: HashMap<String, ToolMedia>,
    /// What the updates of each tool call said about its files.
    tool_paths: HashMap<String, ToolPaths>,
    /// The session's directory; Svode MCP paths are resolved from it.
    cwd: PathBuf,
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
        cwd: PathBuf,
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
            media: HashMap::new(),
            tool_media: HashMap::new(),
            tool_paths: HashMap::new(),
            cwd,
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
                media,
            } => self.append_message(role, message_id, &text, segments, media),
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

    pub(crate) fn media(&self, item_id: &str, segment_id: &str) -> MediaOutcome {
        let Some(item) = self.snapshot.items.iter().find(|item| item.id == item_id) else {
            return MediaOutcome::Error {
                message: format!("no item {item_id} in this session"),
            };
        };
        let Some(segment) = media_of(&item.kind)
            .iter()
            .find(|segment| segment.id == segment_id)
        else {
            return MediaOutcome::Error {
                message: format!("no media {segment_id} in item {item_id}"),
            };
        };
        let held = segment
            .has_data
            .then(|| segment_id.parse::<usize>().ok())
            .flatten()
            .and_then(|index| self.media.get(item_id)?.get(index));
        match held {
            Some(MediaData::Held { mime_type, data }) => MediaOutcome::Available {
                mime_type: mime_type.clone(),
                data: data.clone(),
            },
            Some(MediaData::TooLarge) => MediaOutcome::Unavailable {
                reason: UnavailableReason::TooLarge,
            },
            Some(MediaData::Released) => MediaOutcome::Unavailable {
                reason: UnavailableReason::Released,
            },
            Some(MediaData::None) | None => MediaOutcome::Unavailable {
                reason: UnavailableReason::NotProvided,
            },
        }
    }

    /// Releases the detail and media data of the oldest items outside the
    /// current turn until `need` bytes are freed; summaries and segments
    /// stay. Returns the bytes freed.
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
            freed += self.release_media(&id);
        }
        freed
    }

    fn release_media(&mut self, id: &str) -> usize {
        let Some(data) = self.media.get_mut(id) else {
            return 0;
        };
        let mut freed = 0;
        for datum in data.iter_mut() {
            if let MediaData::Held { .. } = datum {
                freed += datum.size();
                *datum = MediaData::Released;
            }
        }
        self.untrack_detail(freed);
        freed
    }

    fn append_message(
        &mut self,
        role: MessageRole,
        message_id: Option<String>,
        text: &str,
        segments: Vec<MessageSegment>,
        media: Vec<MediaPart>,
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
            MessageRole::Agent => ItemKind::AgentMessage {
                media: self.extend_message_media(&id, &known, text, media),
            },
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

    /// The media of agent message `id` with the next chunk's, placed after
    /// the text so far and the chunk's `text`.
    fn extend_message_media(
        &mut self,
        id: &str,
        known: &DetailBlock,
        text: &str,
        parts: Vec<MediaPart>,
    ) -> Vec<MediaSegment> {
        let mut segments = match self.snapshot.items.iter().find(|item| item.id == id) {
            Some(ActivityItem {
                kind: ItemKind::AgentMessage { media },
                ..
            }) => media.clone(),
            _ => Vec::new(),
        };
        if parts.is_empty() {
            return segments;
        }
        let offset = utf16_len(known) + text.encode_utf16().count() as u64;
        let mut data = self.take_media(id);
        for part in parts {
            let (part, datum) = self.hold(part);
            let has_data = !matches!(datum, MediaData::None);
            data.push(datum);
            segments.push(segment(segments.len(), part, has_data, Some(offset)));
        }
        self.put_media(id, data);
        segments
    }

    /// The part without its data, and the data it holds within the per-item
    /// media bound.
    fn hold(&self, mut part: MediaPart) -> (MediaPart, MediaData) {
        let datum = match part.data.take() {
            None => MediaData::None,
            Some(data) if data.len() > self.retention.media_item => MediaData::TooLarge,
            Some(data) => MediaData::Held {
                mime_type: part
                    .mime_type
                    .clone()
                    .unwrap_or_else(|| "application/octet-stream".into()),
                data,
            },
        };
        (part, datum)
    }

    /// Takes the media data of item `id` out of the detail bounds.
    fn take_media(&mut self, id: &str) -> Vec<MediaData> {
        let data = self.media.remove(id).unwrap_or_default();
        self.untrack_detail(data.iter().map(MediaData::size).sum());
        data
    }

    fn put_media(&mut self, id: &str, data: Vec<MediaData>) {
        self.track_detail(data.iter().map(MediaData::size).sum());
        if let Some(old) = self.media.insert(id.to_string(), data) {
            self.untrack_detail(old.iter().map(MediaData::size).sum());
        }
    }

    /// The media segments of tool call `id` of kind `tool` after `update`.
    fn tool_segments(
        &mut self,
        id: &str,
        tool: ToolKind,
        status: Option<ItemStatus>,
        paths: &ToolPaths,
        update: &mut ToolUpdate,
    ) -> Vec<MediaSegment> {
        let mut state = self.tool_media.remove(id).unwrap_or_default();
        let mcp = paths.is_mcp();
        let mut has_data = Vec::new();
        if let Some(parts) = update.media.take() {
            self.take_media(id);
            let mut data = Vec::new();
            state.parts.clear();
            for part in parts.into_iter().filter(|part| mcp || !part.mcp_only) {
                let (part, datum) = self.hold(part);
                state.parts.push(part);
                data.push(datum);
            }
            self.put_media(id, data);
        }
        if let Some(data) = self.media.get(id) {
            has_data = data
                .iter()
                .map(|datum| !matches!(datum, MediaData::None))
                .collect();
        }
        let mut segments: Vec<MediaSegment> = state
            .parts
            .iter()
            .enumerate()
            .map(|(index, part)| {
                let mut part = part.clone();
                // A read tool call names the image it read in `locations`.
                if tool == ToolKind::Read
                    && part.kind == MediaKind::Image
                    && part.path.is_none()
                    && let Some(path) = paths.agent_locations().first()
                {
                    part.name = part.name.or_else(|| {
                        std::path::Path::new(path)
                            .file_name()
                            .and_then(|name| name.to_str())
                            .map(str::to_string)
                    });
                    part.path = Some(path.clone());
                }
                segment(index, part, has_data.get(index) == Some(&true), None)
            })
            .collect();
        if segments.is_empty() && tool == ToolKind::Read && status != Some(ItemStatus::Failed) {
            for part in paths
                .agent_locations()
                .iter()
                .filter_map(|path| media::read_file(path))
            {
                if segments.iter().all(|known| known.path != part.path) {
                    segments.push(segment(segments.len(), part, false, None));
                }
            }
        }
        self.tool_media.insert(id.to_string(), state);
        segments
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

    fn upsert_tool(&mut self, mut update: ToolUpdate) {
        self.open_message = None;
        let known = self
            .snapshot
            .items
            .iter()
            .find(|item| item.id == update.id)
            .cloned();
        let (known_tool, status, summary) = match &known {
            Some(ActivityItem {
                kind: ItemKind::ToolCall { tool, .. },
                status,
                summary,
                ..
            }) => (*tool, *status, summary.clone()),
            Some(item) => (ToolKind::Other, item.status, item.summary.clone()),
            None => (ToolKind::Other, Some(ItemStatus::Pending), String::new()),
        };
        let tool = update.tool.unwrap_or(known_tool);
        let status = update.status.or(status);
        let agent = AgentAdapterKind::from_id(&self.snapshot.session.agent);
        let mut paths = self.tool_paths.remove(&update.id).unwrap_or_default();
        let calls = mcp::recognize(agent, &update.facts, &paths.tools());
        paths.update(
            agent,
            &self.cwd,
            update.locations.take(),
            update.blocks.as_deref(),
            calls,
        );
        let media = self.tool_segments(&update.id.clone(), tool, status, &paths, &mut update);
        let kind = ItemKind::ToolCall {
            tool,
            media,
            locations: paths.locations(tool, status),
            mcp_calls: paths.call_refs(),
        };
        self.tool_paths.insert(update.id.clone(), paths);
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
            status,
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
            self.take_media(id);
            self.tool_media.remove(id);
            self.tool_paths.remove(id);
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

/// The media segments an item kind carries.
fn media_of(kind: &ItemKind) -> &[MediaSegment] {
    match kind {
        ItemKind::AgentMessage { media } | ItemKind::ToolCall { media, .. } => media,
        _ => &[],
    }
}

fn segment(index: usize, part: MediaPart, has_data: bool, offset: Option<u64>) -> MediaSegment {
    MediaSegment {
        id: index.to_string(),
        kind: part.kind,
        name: part.name,
        mime_type: part.mime_type,
        path: part.path,
        size: part.size,
        has_data,
        offset,
    }
}

/// Length of a message text in UTF-16 code units; an excerpt counts the
/// omitted characters as one unit each.
fn utf16_len(block: &DetailBlock) -> u64 {
    match block {
        DetailBlock::Text { text } => text.encode_utf16().count() as u64,
        DetailBlock::Excerpt {
            head,
            omitted_chars,
            tail,
        } => (head.encode_utf16().count() + tail.encode_utf16().count()) as u64 + omitted_chars,
        DetailBlock::Diff { .. } | DetailBlock::Terminal { .. } => 0,
    }
}

/// Size of an item in the compact bound.
fn compact_size(item: &ActivityItem) -> usize {
    let media: usize = media_of(&item.kind)
        .iter()
        .map(|segment| {
            ITEM_OVERHEAD
                + segment.id.len()
                + segment.name.as_ref().map_or(0, String::len)
                + segment.mime_type.as_ref().map_or(0, String::len)
                + segment.path.as_ref().map_or(0, String::len)
        })
        .sum();
    let label = media
        + match &item.kind {
            ItemKind::UserMessage { segments } => segments.iter().map(segment_size).sum::<usize>(),
            ItemKind::Generic { label } => label.len(),
            ItemKind::Plan { entries } => entries.iter().map(|entry| entry.content.len()).sum(),
            ItemKind::Interaction { option, .. } => option.as_ref().map_or(0, String::len),
            ItemKind::ToolCall {
                locations,
                mcp_calls,
                ..
            } => {
                locations
                    .iter()
                    .map(|location| location.path.len() + ITEM_OVERHEAD / 4)
                    .sum::<usize>()
                    + mcp_calls
                        .iter()
                        .map(|call| call.server.len() + call.tool.len())
                        .sum::<usize>()
            }
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
    use std::path::Path;

    use serde_json::{Value, json};

    use crate::activity::{FileChange, McpCallRef, ToolLocation};
    use crate::identity::IdentityNamespace;

    /// A Svode project to resolve the paths of Svode MCP calls in.
    fn project() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join(".svode")).unwrap();
        std::fs::write(root.join(".svode/config.json"), "{}").unwrap();
        (dir, root)
    }

    /// The tool call items a session of `agent` in `cwd` has after
    /// `updates`, live or as a `session/load` replay.
    fn tool_calls(agent: &str, cwd: &Path, replay: bool, updates: &[Value]) -> Vec<ItemKind> {
        let mut projection = Projection::new(
            SessionKey {
                agent: agent.into(),
                namespace: IdentityNamespace::Acp,
                session_id: "s1".into(),
            },
            cwd.to_path_buf(),
            ConnectionState::Ready,
            Projection::live_history(),
            replay,
            WriterState::None,
            Retention::default(),
            Arc::new(AtomicUsize::new(0)),
        );
        for update in updates {
            let (_, normalized) = normalize::session_update(
                json!({ "sessionId": "s1", "update": update }),
                AgentAdapterKind::from_id(agent),
            )
            .unwrap();
            projection.apply(normalized);
        }
        projection
            .snapshot
            .items
            .iter()
            .filter(|item| matches!(item.kind, ItemKind::ToolCall { .. }))
            .map(|item| item.kind.clone())
            .collect()
    }

    fn svode_call(server: &str, tool: &str, changes_project: bool) -> Vec<McpCallRef> {
        vec![McpCallRef {
            server: server.into(),
            tool: tool.into(),
            changes_project,
        }]
    }

    fn location(path: PathBuf, change: FileChange) -> Vec<ToolLocation> {
        vec![ToolLocation {
            path: path.to_string_lossy().into_owned(),
            change: Some(change),
            lines: None,
        }]
    }

    fn codex_call(id: &str, tool: &str, arguments: Value) -> Value {
        json!({
            "sessionUpdate": "tool_call",
            "toolCallId": id,
            "kind": "execute",
            "title": format!("mcp.svode.{tool}"),
            "status": "in_progress",
            "rawInput": { "server": "svode", "tool": tool, "arguments": arguments },
            "_meta": { "is_mcp_tool_call": true }
        })
    }

    fn codex_result(id: &str, structured: Value) -> Value {
        json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": id,
            "status": "completed",
            "rawOutput": { "result": { "content": [{ "type": "text", "text": "Done." }], "structuredContent": structured, "_meta": null }, "error": null }
        })
    }

    #[test]
    fn a_codex_mcp_call_names_its_server_and_tool_and_its_svode_paths_live_and_in_replay() {
        let (_dir, root) = project();
        let live = [
            codex_call(
                "exec-1",
                "write_page",
                json!({ "path": "notes/a.md", "content": "x", "sourceVersion": "v", "spaceId": "root" }),
            ),
            codex_result(
                "exec-1",
                json!({ "path": "notes/a.md", "changedPaths": ["notes/a.md"] }),
            ),
            codex_call(
                "exec-2",
                "create_page",
                json!({ "parentPath": "notes", "title": "B" }),
            ),
            codex_result(
                "exec-2",
                json!({ "path": "notes/B.md", "changedPaths": [".svode/order.json", "notes/B.md"] }),
            ),
        ];
        let expected = vec![
            ItemKind::ToolCall {
                tool: ToolKind::Execute,
                media: Vec::new(),
                locations: location(root.join("notes/a.md"), FileChange::Modified),
                mcp_calls: svode_call("svode", "write_page", true),
            },
            ItemKind::ToolCall {
                tool: ToolKind::Execute,
                media: Vec::new(),
                locations: location(root.join("notes/B.md"), FileChange::Created),
                mcp_calls: svode_call("svode", "create_page", true),
            },
        ];
        assert_eq!(tool_calls("codex", &root, false, &live), expected);

        // A replay sends each call whole.
        let mut replayed = Vec::new();
        for pair in live.chunks(2) {
            let mut call = pair[0].clone();
            call["status"] = json!("completed");
            call["rawOutput"] = pair[1]["rawOutput"].clone();
            replayed.push(call);
        }
        assert_eq!(tool_calls("codex", &root, true, &replayed), expected);

        // The path only the result names is not known before it.
        assert_eq!(
            tool_calls("codex", &root, false, &live[2..3]),
            vec![ItemKind::ToolCall {
                tool: ToolKind::Execute,
                media: Vec::new(),
                locations: Vec::new(),
                mcp_calls: svode_call("svode", "create_page", true),
            }]
        );
    }

    #[test]
    fn a_claude_code_mcp_call_streams_its_arguments_and_names_its_result_path() {
        let (_dir, root) = project();
        let meta = |tool: &str| json!({ "claudeCode": { "toolName": tool } });
        let created = "mcp__plugin_svode_svode__create_page";
        let written = "mcp__svode__write_page";
        let updates = [
            json!({ "sessionUpdate": "tool_call", "toolCallId": "toolu_1", "title": created, "kind": "other", "status": "pending", "rawInput": {}, "content": [], "_meta": meta(created) }),
            json!({ "sessionUpdate": "tool_call_update", "toolCallId": "toolu_1", "rawInput": { "spaceId": "root", "parentPath": "notes" }, "_meta": meta(created) }),
            json!({ "sessionUpdate": "tool_call_update", "toolCallId": "toolu_1", "status": "completed",
                "rawOutput": "{\"changedPaths\":[\".svode/order.json\",\"notes/E06 page.md\"],\"path\":\"notes/E06 page.md\"}",
                "content": [{ "type": "content", "content": { "type": "text", "text": "{\"path\":\"notes/E06 page.md\"}" } }],
                "_meta": meta(created) }),
            json!({ "sessionUpdate": "tool_call", "toolCallId": "toolu_2", "title": written, "kind": "other", "status": "pending", "rawInput": { "path": "notes/a.md", "content": "x", "sourceVersion": "v" }, "_meta": meta(written) }),
        ];
        assert_eq!(
            tool_calls("claude-code", &root, false, &updates),
            vec![
                ItemKind::ToolCall {
                    tool: ToolKind::Other,
                    media: Vec::new(),
                    locations: location(root.join("notes/E06 page.md"), FileChange::Created),
                    mcp_calls: svode_call("plugin_svode_svode", "create_page", true),
                },
                ItemKind::ToolCall {
                    tool: ToolKind::Other,
                    media: Vec::new(),
                    locations: location(root.join("notes/a.md"), FileChange::Modified),
                    mcp_calls: svode_call("svode", "write_page", true),
                },
            ]
        );
    }

    #[test]
    fn a_failed_svode_call_and_a_read_change_nothing() {
        let (_dir, root) = project();
        let failed_codex = [
            codex_call(
                "exec-1",
                "write_page",
                json!({ "path": "notes/a.md", "content": "x", "sourceVersion": "v" }),
            ),
            json!({ "sessionUpdate": "tool_call_update", "toolCallId": "exec-1", "status": "failed", "rawOutput": { "result": null, "error": "SOURCE_STALE" } }),
            codex_call("exec-2", "read_page", json!({ "path": "notes/a.md" })),
        ];
        assert_eq!(
            tool_calls("codex", &root, false, &failed_codex),
            vec![
                ItemKind::ToolCall {
                    tool: ToolKind::Execute,
                    media: Vec::new(),
                    locations: Vec::new(),
                    mcp_calls: svode_call("svode", "write_page", true),
                },
                ItemKind::ToolCall {
                    tool: ToolKind::Execute,
                    media: Vec::new(),
                    locations: Vec::new(),
                    mcp_calls: svode_call("svode", "read_page", false),
                },
            ]
        );
        let tool = "mcp__svode__delete_page";
        let failed_claude = [
            json!({ "sessionUpdate": "tool_call", "toolCallId": "toolu_1", "title": tool, "kind": "other", "status": "pending", "rawInput": { "path": "notes/a.md" }, "_meta": { "claudeCode": { "toolName": tool } } }),
            json!({ "sessionUpdate": "tool_call_update", "toolCallId": "toolu_1", "status": "failed", "rawOutput": "MCP error -32602: not found", "_meta": { "claudeCode": { "toolName": tool } } }),
        ];
        assert_eq!(
            tool_calls("claude-code", &root, false, &failed_claude),
            vec![ItemKind::ToolCall {
                tool: ToolKind::Other,
                media: Vec::new(),
                locations: Vec::new(),
                mcp_calls: svode_call("svode", "delete_page", true),
            }]
        );
    }

    #[test]
    fn an_unknown_form_and_a_lookalike_title_stay_items_of_their_kind() {
        let (_dir, root) = project();
        let lookalike = json!({
            "sessionUpdate": "tool_call", "toolCallId": "t1", "kind": "execute",
            "title": "mcp.svode.write_page", "status": "completed",
            "rawInput": { "server": "svode", "tool": "write_page", "arguments": { "path": "notes/a.md" } }
        });
        assert_eq!(
            tool_calls("codex", &root, false, &[lookalike]),
            vec![ItemKind::ToolCall {
                tool: ToolKind::Execute,
                media: Vec::new(),
                locations: Vec::new(),
                mcp_calls: Vec::new(),
            }]
        );
        let other_agent = json!({
            "sessionUpdate": "tool_call", "toolCallId": "t1", "kind": "other",
            "title": "mcp__svode__write_page", "status": "completed",
            "rawInput": { "path": "notes/a.md" },
            "_meta": { "claudeCode": { "toolName": "mcp__svode__write_page" } }
        });
        assert_eq!(
            tool_calls("opencode", &root, false, &[other_agent]),
            vec![ItemKind::ToolCall {
                tool: ToolKind::Other,
                media: Vec::new(),
                locations: Vec::new(),
                mcp_calls: Vec::new(),
            }]
        );
    }

    #[test]
    fn an_edit_names_its_files_with_the_lines_its_diff_changes() {
        let (_dir, root) = project();
        let path = root.join("edit-me.txt").to_string_lossy().into_owned();
        let updates = [
            json!({ "sessionUpdate": "tool_call", "toolCallId": "toolu_1", "title": "Edit edit-me.txt", "kind": "edit", "status": "pending", "locations": [{ "path": path }] }),
            json!({ "sessionUpdate": "tool_call_update", "toolCallId": "toolu_1", "status": "completed",
                "content": [{ "type": "diff", "path": path, "oldText": "line one\nline two", "newText": "line one\nline 2" }] }),
        ];
        assert_eq!(
            tool_calls("claude-code", &root, false, &updates),
            vec![ItemKind::ToolCall {
                tool: ToolKind::Edit,
                media: Vec::new(),
                locations: vec![ToolLocation {
                    path,
                    change: Some(FileChange::Modified),
                    lines: Some(crate::activity::LineChanges {
                        added: 1,
                        removed: 1
                    }),
                }],
                mcp_calls: Vec::new(),
            }]
        );
    }

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

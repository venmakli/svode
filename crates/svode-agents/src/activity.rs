//! Agent Activity projection contract (Stage 10 `02` C5): what the runtime
//! hands to consumers as a session snapshot and ordered deltas. Svode owns
//! this model; ACP wire types stay inside the ACP client.

use serde::{Deserialize, Serialize};

use crate::identity::SessionKey;
use crate::status::{InteractionKind, SessionStatus, StopReason};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionState {
    /// The user has not connected the agent.
    NotConnected,
    /// The agent process is starting and `initialize` is in flight.
    Starting,
    /// Capabilities are known.
    Ready,
    /// The last call failed or timed out; sessions keep their state and the
    /// next explicit lifecycle boundary retries.
    Degraded,
    /// The agent process exited or the app is shutting down.
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WriterState {
    None,
    Acp,
    Pty,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HistorySource {
    Live,
    Replay,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryState {
    pub source: HistorySource,
    pub available: bool,
    /// Number of evicted items when the retained history is truncated.
    pub truncated_items: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnPhase {
    None,
    Running,
    /// Cancel was requested; the turn runs until the agent answers the prompt.
    Cancelling,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnState {
    /// The current turn, or the last one once it ended.
    pub turn_id: Option<String>,
    pub phase: TurnPhase,
    pub last_outcome: Option<StopReason>,
    pub status: SessionStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    Read,
    Edit,
    Delete,
    Move,
    Search,
    Execute,
    Think,
    Fetch,
    SwitchMode,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ItemKind {
    /// The summary and detail are the message text; `segments` is the
    /// whole message in order once it holds a link or an image, and empty
    /// for a text-only message.
    UserMessage {
        segments: Vec<MessageSegment>,
    },
    AgentMessage,
    Reasoning,
    ToolCall {
        tool: ToolKind,
    },
    ModeChange,
    ConfigChange,
    /// The agent's plan as it stands in this turn; later plans of the turn
    /// replace it in place.
    Plan {
        entries: Vec<PlanEntry>,
    },
    /// A resolved pending interaction. A permission is shown in the row of
    /// its tool call; the summary is the request title.
    Interaction {
        request: InteractionKind,
        state: InteractionState,
        tool_call_id: Option<String>,
        /// Label of the chosen permission option.
        option: Option<String>,
        /// The user declined to answer the question.
        declined: bool,
    },
    TurnOutcome {
        reason: StopReason,
        /// From the accepted prompt to the turn result; unknown for a turn
        /// this process did not run.
        duration_ms: Option<u64>,
    },
    Error,
    Interrupted {
        duration_ms: Option<u64>,
    },
    /// An update or extension this runtime does not model.
    Generic {
        label: String,
    },
}

/// One part of a user message in the order it was written. Image data is
/// never kept, only its name and URI when the agent sent them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum MessageSegment {
    Text {
        text: String,
    },
    /// A link to a file the agent reads with its own tools.
    Link {
        uri: String,
        name: String,
    },
    Image {
        uri: Option<String>,
        name: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityItem {
    /// The agent's id (`messageId`, `toolCallId`) when it has one, else
    /// assigned by the runtime.
    pub id: String,
    pub turn_id: Option<String>,
    #[serde(flatten)]
    pub kind: ItemKind,
    pub status: Option<ItemStatus>,
    /// Bounded compact text; the full content is the detail.
    pub summary: String,
    pub has_detail: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanEntryStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanEntryPriority {
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanEntry {
    pub content: String,
    pub priority: PlanEntryPriority,
    pub status: PlanEntryStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InteractionState {
    Pending,
    Answered,
    Cancelled,
    Expired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InteractionOptionKind {
    AllowOnce,
    AllowAlways,
    RejectOnce,
    RejectAlways,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionOption {
    pub id: String,
    pub label: String,
    pub kind: InteractionOptionKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChoiceOption {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
}

/// Input of one question field with the defaults and bounds the agent
/// declared.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum FieldInput {
    /// Free text; `format` and `pattern` are the agent's hints, checked by
    /// the agent itself.
    Text {
        default: Option<String>,
        min_length: Option<u32>,
        max_length: Option<u32>,
        format: Option<String>,
        pattern: Option<String>,
    },
    Number {
        default: Option<f64>,
        minimum: Option<f64>,
        maximum: Option<f64>,
    },
    Integer {
        default: Option<i64>,
        minimum: Option<i64>,
        maximum: Option<i64>,
    },
    Boolean {
        default: Option<bool>,
    },
    /// One of the options.
    SingleChoice {
        options: Vec<ChoiceOption>,
        default: Option<String>,
    },
    /// Any number of the options within the bounds.
    MultipleChoice {
        options: Vec<ChoiceOption>,
        default: Vec<String>,
        min_items: Option<u64>,
        max_items: Option<u64>,
    },
}

// `f64` fields rule out a derived `Eq`; the agent never sends NaN in JSON.
impl Eq for FieldInput {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionField {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub required: bool,
    pub input: FieldInput,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingInteraction {
    /// Runtime-assigned, unique within the session.
    pub id: String,
    pub kind: InteractionKind,
    /// The tool call a permission is for, or the question message.
    pub title: String,
    /// The agent's tool call a permission is for; its item and detail carry
    /// the subject of the request. None for a question.
    pub tool_call_id: Option<String>,
    /// Permission options; empty for a question.
    pub options: Vec<InteractionOption>,
    /// Question fields in the agent's order; empty for a permission.
    pub fields: Vec<QuestionField>,
    pub state: InteractionState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SettingCategory {
    Mode,
    Model,
    ThoughtLevel,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingOption {
    pub value: String,
    pub name: String,
    pub description: Option<String>,
}

/// A session setting the agent declared, in its order. Legacy session modes
/// of an agent without config options are one setting of category `mode`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSetting {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub category: SettingCategory,
    /// Confirmed by the agent; a requested value is not applied before.
    pub current_value: String,
    pub options: Vec<SettingOption>,
}

/// A slash command the agent declared; it goes to the agent as prompt text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCommand {
    pub name: String,
    pub description: String,
    /// The agent's hint for the input after the command.
    pub hint: Option<String>,
}

/// Cumulative cost of the session as the agent reported it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageCost {
    pub amount: f64,
    /// ISO 4217 code.
    pub currency: String,
}

/// The agent's last report of its context window.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    /// Tokens currently in the context.
    pub used: u64,
    /// Size of the context window.
    pub size: u64,
    pub cost: Option<UsageCost>,
}

// `f64` rules out a derived `Eq`; the agent never sends NaN in JSON.
impl Eq for SessionUsage {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub seq: u64,
    pub session: SessionKey,
    pub connection: ConnectionState,
    pub turn: TurnState,
    pub items: Vec<ActivityItem>,
    pub pending: Option<PendingInteraction>,
    pub history: HistoryState,
    pub writer: WriterState,
    pub settings: Vec<SessionSetting>,
    /// The slash commands the agent offers now.
    pub commands: Vec<SessionCommand>,
    pub usage: Option<SessionUsage>,
    /// The session title the agent reported.
    pub title: Option<String>,
}

/// Exactly one change; applying deltas with consecutive `seq` to the
/// snapshot reproduces the runtime state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "change", content = "value", rename_all = "snake_case")]
pub enum Change {
    /// Insert or replace the item with this id.
    Item(ActivityItem),
    Turn(TurnState),
    /// Set the pending interaction; a non-`pending` state clears it with
    /// that outcome.
    Pending(PendingInteraction),
    History(HistoryState),
    /// Retention evicted these items; the history carries the truncation
    /// marker.
    Truncated(Truncation),
    Connection(ConnectionState),
    Writer(WriterState),
    /// Replaces the whole set of session settings.
    Settings(Vec<SessionSetting>),
    /// Replaces the whole set of slash commands.
    Commands(Vec<SessionCommand>),
    Usage(SessionUsage),
    Title(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Truncation {
    pub item_ids: Vec<String>,
    pub history: HistoryState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDelta {
    pub seq: u64,
    #[serde(flatten)]
    pub change: Change,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum DetailBlock {
    Text {
        text: String,
    },
    /// Text beyond the per-item bound: its head and tail within the bound
    /// and the number of characters omitted between them.
    Excerpt {
        head: String,
        omitted_chars: u64,
        tail: String,
    },
    Diff {
        path: String,
        old_text: Option<String>,
        new_text: String,
    },
    /// An agent-side terminal; display only.
    Terminal {
        terminal_id: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnavailableReason {
    TooLarge,
    NotProvided,
    Released,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "outcome",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum DetailOutcome {
    Available { blocks: Vec<DetailBlock> },
    Unavailable { reason: UnavailableReason },
    Error { message: String },
}

impl SessionSnapshot {
    /// Applies a delta. Returns false on a seq gap: the consumer drops its
    /// state and resubscribes.
    pub fn apply(&mut self, delta: &SessionDelta) -> bool {
        if delta.seq != self.seq + 1 {
            return false;
        }
        self.seq = delta.seq;
        match &delta.change {
            Change::Item(item) => match self.items.iter_mut().find(|known| known.id == item.id) {
                Some(known) => *known = item.clone(),
                None => self.items.push(item.clone()),
            },
            Change::Turn(turn) => self.turn = turn.clone(),
            Change::Pending(pending) => {
                self.pending = (pending.state == InteractionState::Pending).then(|| pending.clone())
            }
            Change::History(history) => self.history = *history,
            Change::Truncated(truncation) => {
                self.items
                    .retain(|item| !truncation.item_ids.contains(&item.id));
                self.history = truncation.history;
            }
            Change::Connection(connection) => self.connection = *connection,
            Change::Writer(writer) => self.writer = *writer,
            Change::Settings(settings) => self.settings = settings.clone(),
            Change::Commands(commands) => self.commands = commands.clone(),
            Change::Usage(usage) => self.usage = Some(usage.clone()),
            Change::Title(title) => self.title = Some(title.clone()),
        }
        true
    }
}

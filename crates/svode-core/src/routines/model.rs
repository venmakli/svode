use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::agent_actors::executor::{ExecutorResolution, ExecutorSource};
use crate::index::IndexKey;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RoutineRunTerminalStatus {
    Done,
    Failed,
    Stopped,
    Unknown,
}

impl RoutineRunTerminalStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Stopped => "stopped",
            Self::Unknown => "unknown",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "done" => Some(Self::Done),
            "failed" => Some(Self::Failed),
            "stopped" => Some(Self::Stopped),
            "unknown" => Some(Self::Unknown),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoutineRunRow {
    pub routine_run_id: String,
    pub routine_id: String,
    pub owner_path: String,
    pub launch_id: String,
    pub source: String,
    pub source_session_id: Option<String>,
    pub agent_session_id: String,
    pub created_at: String,
    pub terminal_status: Option<RoutineRunTerminalStatus>,
    pub terminal_exit_code: Option<i32>,
    pub terminal_reason: Option<String>,
    pub terminal_observed_at: Option<String>,
    pub session_status: Option<String>,
    pub launch: RoutineRunLaunch,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_refusal: Option<RoutineLaunchRefusal>,
}

/// Why a run's agent was launched in a managed terminal instead of ACP: a
/// closed set (Stage 10 `02` "Routine launch through ACP"). Runs of earlier
/// versions keep it; a Routine of an Agent Actor runs only over ACP now
/// (Stage 11 `03`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RoutineTerminalChoice {
    /// The chat is not available to the agent (Stage 10 `04`).
    ChatUnavailable,
    /// The binding has no ACP equivalent of its approval, model or effort.
    BindingNotAcp,
    /// The ACP launch failed before its first prompt.
    AcpFailedBeforePrompt,
}

impl RoutineTerminalChoice {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ChatUnavailable => "chat_unavailable",
            Self::BindingNotAcp => "binding_not_acp",
            Self::AcpFailedBeforePrompt => "acp_failed_before_prompt",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "chat_unavailable" => Some(Self::ChatUnavailable),
            "binding_not_acp" => Some(Self::BindingNotAcp),
            "acp_failed_before_prompt" => Some(Self::AcpFailedBeforePrompt),
            _ => None,
        }
    }
}

/// How a run's agent was launched. Local operational evidence of the run,
/// never portable; a run recorded without it reads as a terminal launch
/// without a reason.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "transport",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum RoutineRunLaunch {
    Acp,
    Terminal {
        reason: Option<RoutineTerminalChoice>,
        /// Bounded text of the agent or connection behind the reason.
        detail: Option<String>,
    },
}

impl RoutineRunLaunch {
    pub fn transport(&self) -> &'static str {
        match self {
            Self::Acp => "acp",
            Self::Terminal { .. } => "terminal",
        }
    }

    /// Reads the persisted columns; unknown values read as a terminal
    /// launch without a reason.
    pub fn from_columns(
        transport: Option<&str>,
        reason: Option<&str>,
        detail: Option<String>,
    ) -> Self {
        match transport {
            Some("acp") => Self::Acp,
            _ => Self::Terminal {
                reason: reason.and_then(RoutineTerminalChoice::parse),
                detail,
            },
        }
    }
}

/// Why a Routine launch of an Agent Actor was refused before its first
/// prompt (Stage 11 `03`, «Запуск Рутины»): no prompt went out, and no other
/// agent and no terminal started instead.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RoutineLaunchRefusalReason {
    /// The Actor runs the participant's agent and this device chose no
    /// default agent.
    DefaultAgentNotSet,
    /// The binding names an agent this version does not know, or a custom
    /// agent a V1 catalog kept.
    UnknownAgent,
    /// The device mode of the Actor cannot be read.
    ModeUnavailable,
    /// The agent is not ready on this device: disabled, not installed, not
    /// signed in or not startable.
    AgentNotReady,
    /// The connection or the session failed before the first prompt.
    ConnectionFailed,
    /// The agent did not declare the value at launch.
    SettingNotDeclared,
    /// A catalog value of a setting the agent declares as its mode, which
    /// only this device chooses.
    SettingIsMode,
    /// The agent refused the value or did not confirm it.
    SettingRefused,
}

/// Where the user fixes a refused launch: the Actor's binding or the agent
/// settings of the device, which hold the default agent and the agents'
/// readiness.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RoutineLaunchRecovery {
    ActorEditor,
    AgentSettings,
}

/// A refused launch with its reason: the setting and value when the reason
/// is in them, the agent, and the bounded text behind it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoutineLaunchRefusal {
    pub reason: RoutineLaunchRefusalReason,
    pub recovery: RoutineLaunchRecovery,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setting: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Bound of the agent, connection or device text a refusal keeps.
const REFUSAL_DETAIL_BYTES: usize = 512;

impl RoutineLaunchRefusal {
    /// A refusal of a launch whose values come from `source`: a value of
    /// the Actor's binding is fixed in the Actor editor, one of the default
    /// agent in the agent settings.
    pub fn new(
        reason: RoutineLaunchRefusalReason,
        source: Option<ExecutorSource>,
        agent: Option<String>,
    ) -> Self {
        use RoutineLaunchRefusalReason as Reason;
        let recovery = match reason {
            Reason::DefaultAgentNotSet | Reason::AgentNotReady | Reason::ConnectionFailed => {
                RoutineLaunchRecovery::AgentSettings
            }
            Reason::UnknownAgent | Reason::ModeUnavailable => RoutineLaunchRecovery::ActorEditor,
            Reason::SettingNotDeclared | Reason::SettingIsMode | Reason::SettingRefused => {
                match source {
                    Some(ExecutorSource::DefaultAgent) => RoutineLaunchRecovery::AgentSettings,
                    Some(ExecutorSource::Binding) | None => RoutineLaunchRecovery::ActorEditor,
                }
            }
        };
        Self {
            reason,
            recovery,
            agent,
            setting: None,
            value: None,
            detail: None,
        }
    }

    pub fn with_value(mut self, setting: &str, value: &str) -> Self {
        self.setting = Some(setting.into());
        self.value = Some(value.into());
        self
    }

    pub fn with_detail(mut self, detail: &str) -> Self {
        let detail = detail.trim();
        let mut end = detail.len().min(REFUSAL_DETAIL_BYTES);
        while !detail.is_char_boundary(end) {
            end -= 1;
        }
        self.detail = Some(detail[..end].to_string()).filter(|detail| !detail.is_empty());
        self
    }

    /// The refusal of an executor the resolver could not resolve to an
    /// agent: `None` for a resolved one, and for a missing executor, Actor or
    /// an ambiguous reference, which the Routine's own diagnostics name.
    pub fn from_resolution(resolution: &ExecutorResolution) -> Option<Self> {
        use RoutineLaunchRefusalReason as Reason;
        Some(match resolution {
            ExecutorResolution::DefaultAgentNotSet { .. } => Self::new(
                Reason::DefaultAgentNotSet,
                Some(ExecutorSource::DefaultAgent),
                None,
            ),
            ExecutorResolution::UnknownAgent { agent, .. } => Self::new(
                Reason::UnknownAgent,
                Some(ExecutorSource::Binding),
                Some(agent.as_str().into()),
            ),
            ExecutorResolution::ModeUnavailable { message, .. } => {
                Self::new(Reason::ModeUnavailable, Some(ExecutorSource::Binding), None)
                    .with_detail(message)
            }
            ExecutorResolution::MissingExecutor
            | ExecutorResolution::MissingActor { .. }
            | ExecutorResolution::AmbiguousActor { .. }
            | ExecutorResolution::Resolved(_) => return None,
        })
    }

    /// The reason in words for the run's outcome, MCP and logs.
    pub fn message(&self) -> String {
        use RoutineLaunchRefusalReason as Reason;
        let agent = self.agent.as_deref().unwrap_or("the agent");
        let value = match (&self.setting, &self.value) {
            (Some(setting), Some(value)) => format!("{setting}={value}"),
            _ => "a value".into(),
        };
        let reason = match self.reason {
            Reason::DefaultAgentNotSet => {
                "the Actor runs the participant's agent and no default agent is chosen on this device".into()
            }
            Reason::UnknownAgent => format!("{agent} cannot run an Agent Actor in this version"),
            Reason::ModeUnavailable => "the mode of the Actor on this device cannot be read".into(),
            Reason::AgentNotReady => format!("{agent} is not ready on this device"),
            Reason::ConnectionFailed => format!("{agent} failed before the first prompt"),
            Reason::SettingNotDeclared => format!("{agent} does not declare {value}"),
            Reason::SettingIsMode => format!(
                "{agent} declares {value} as its mode, which only the device chooses, not the catalog"
            ),
            Reason::SettingRefused => format!("{agent} did not confirm {value}"),
        };
        match &self.detail {
            Some(detail) => format!("Routine launch refused: {reason}: {detail}"),
            None => format!("Routine launch refused: {reason}"),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum CollectionEvent {
    #[serde(rename = "collection.entry_created")]
    ItemCreated,
    #[serde(rename = "collection.field_changed")]
    FieldChanged,
    #[serde(rename = "collection.entry_deleted")]
    ItemDeleted,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CollectionEventSourceKind {
    Managed,
    Watcher,
    GitSync,
}

impl CollectionEventSourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Managed => "managed",
            Self::Watcher => "watcher",
            Self::GitSync => "git_sync",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollectionEventOrigin {
    pub source_kind: CollectionEventSourceKind,
    pub origin: Option<String>,
    pub routine_run_id: Option<String>,
}

impl CollectionEventOrigin {
    pub fn managed() -> Self {
        Self {
            source_kind: CollectionEventSourceKind::Managed,
            origin: Some("managed".to_string()),
            routine_run_id: None,
        }
    }

    pub fn watcher() -> Self {
        Self {
            source_kind: CollectionEventSourceKind::Watcher,
            origin: None,
            routine_run_id: None,
        }
    }

    pub fn git_sync() -> Self {
        Self {
            source_kind: CollectionEventSourceKind::GitSync,
            origin: None,
            routine_run_id: None,
        }
    }
}

impl CollectionEvent {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ItemCreated => "collection.entry_created",
            Self::FieldChanged => "collection.field_changed",
            Self::ItemDeleted => "collection.entry_deleted",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct EventMatch {
    pub field: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RoutineOwnerKind {
    Project,
    Space,
    Collection,
}

impl RoutineOwnerKind {
    /// The owner kind of a `.routines` directory addressed by its Space-relative
    /// owner path.
    pub fn for_owner_path(owner_path: &str, space_is_project_root: bool) -> Self {
        if owner_path != "." {
            Self::Collection
        } else if space_is_project_root {
            Self::Project
        } else {
            Self::Space
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RoutineOwnerInputKind {
    RegisteredSpace,
    CollectionDirectory,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoutineOwnerDescriptor {
    pub kind: RoutineOwnerKind,
    pub space_id: String,
    pub owner_path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoutineInvalidationPayload {
    pub project_path: String,
    pub space_path: String,
    pub owner_kind: RoutineOwnerKind,
    pub owner_path: String,
}

impl RoutineInvalidationPayload {
    pub fn from_owner(owner: &ResolvedRoutineOwner) -> Self {
        Self {
            project_path: owner.project_path.to_string_lossy().into_owned(),
            space_path: owner.space_path.to_string_lossy().into_owned(),
            owner_kind: owner.descriptor.kind,
            owner_path: owner.descriptor.owner_path.clone(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ResolvedRoutineOwner {
    pub descriptor: RoutineOwnerDescriptor,
    pub project_path: PathBuf,
    pub space_path: PathBuf,
    pub owner_root: PathBuf,
    pub index_key: IndexKey,
}

impl ResolvedRoutineOwner {
    pub fn routines_dir(&self) -> PathBuf {
        self.owner_root.join(".routines")
    }

    pub fn identity(&self) -> String {
        let portable_space_id = if self.project_path == self.space_path {
            "root"
        } else {
            &self.descriptor.space_id
        };
        format!(
            "{}\0{:?}\0{}",
            portable_space_id, self.descriptor.kind, self.descriptor.owner_path
        )
    }

    pub fn indexed_collection_identity(index_key: &IndexKey, owner_path: &str) -> String {
        let portable_space_id = match index_key {
            IndexKey::Root(_) => "root",
            IndexKey::Space { space_id, .. } => space_id,
        };
        format!(
            "{}\0{:?}\0{}",
            portable_space_id,
            RoutineOwnerKind::Collection,
            owner_path
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutineDefinition {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    pub trigger: RoutineTrigger,
    pub action: RoutineAction,
    #[serde(default)]
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RoutineTrigger {
    Manual,
    Schedule {
        cron: String,
        time_basis: RoutineTimeBasis,
        missed_runs: MissedRuns,
    },
    Event {
        event: CollectionEvent,
        #[serde(default, rename = "match", skip_serializing_if = "Option::is_none")]
        match_: Option<EventMatch>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "mode",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RoutineTimeBasis {
    Local,
    Fixed { timezone: String },
}

impl RoutineTimeBasis {
    pub fn identity(&self) -> String {
        match self {
            Self::Local => "local".to_string(),
            Self::Fixed { timezone } => format!("fixed:{timezone}"),
        }
    }
}

impl RoutineTrigger {
    pub fn kind(&self) -> RoutineTriggerType {
        match self {
            Self::Manual => RoutineTriggerType::Manual,
            Self::Schedule { .. } => RoutineTriggerType::Schedule,
            Self::Event { .. } => RoutineTriggerType::Event,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RoutineTriggerType {
    Manual,
    Schedule,
    Event,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MissedRuns {
    Skip,
    RunOnce,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RoutineAction {
    RunAgent {
        executor: String,
    },
    UpdateProperties {
        target: RoutineActionTarget,
        set: BTreeMap<String, serde_json::Value>,
    },
}

impl RoutineAction {
    pub fn kind(&self) -> RoutineActionType {
        match self {
            Self::RunAgent { .. } => RoutineActionType::RunAgent,
            Self::UpdateProperties { .. } => RoutineActionType::UpdateProperties,
        }
    }

    pub fn executor(&self) -> Option<&str> {
        match self {
            Self::RunAgent { executor } => Some(executor),
            Self::UpdateProperties { .. } => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RoutineActionType {
    RunAgent,
    UpdateProperties,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoutineRunRecord {
    pub routine_run_id: String,
    pub routine_id: String,
    pub owner_path: String,
    pub launch_id: String,
    pub source: String,
    pub source_session_id: Option<String>,
    pub agent_session_id: String,
    pub created_at: String,
    pub terminal_status: Option<RoutineRunTerminalStatus>,
    pub terminal_exit_code: Option<i32>,
    pub terminal_reason: Option<String>,
    pub terminal_observed_at: Option<String>,
    pub session_status: Option<String>,
    pub launch: RoutineRunLaunch,
    pub launch_refusal: Option<RoutineLaunchRefusal>,
}

/// The host's evidence of live launches: runs whose ACP session holds its
/// writer in the writer registry.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RoutineLiveEvidence {
    live_acp_run_ids: HashSet<String>,
}

impl RoutineLiveEvidence {
    pub fn new(live_acp_run_ids: HashSet<String>) -> Self {
        Self { live_acp_run_ids }
    }
}

impl RoutineRunRecord {
    /// A live ACP session of this run's launch. A terminal run of an
    /// earlier version has no live writer: its terminal ended with that app.
    pub fn has_live_writer(&self, live: &RoutineLiveEvidence) -> bool {
        match self.launch {
            RoutineRunLaunch::Acp => live.live_acp_run_ids.contains(&self.routine_run_id),
            RoutineRunLaunch::Terminal { .. } => false,
        }
    }

    pub fn blocks_relaunch(&self, live: &RoutineLiveEvidence) -> bool {
        match self.session_status.as_deref() {
            Some("done" | "failed" | "stopped") => false,
            Some(_) => self.has_live_writer(live),
            None => match self.terminal_status {
                Some(
                    RoutineRunTerminalStatus::Done
                    | RoutineRunTerminalStatus::Failed
                    | RoutineRunTerminalStatus::Stopped,
                ) => false,
                Some(RoutineRunTerminalStatus::Unknown) | None => self.has_live_writer(live),
            },
        }
    }

    pub fn to_ref(&self, live: &RoutineLiveEvidence) -> RoutineRunRef {
        RoutineRunRef {
            routine_run_id: self.routine_run_id.clone(),
            launch_id: self.launch_id.clone(),
            agent_session_id: self.agent_session_id.clone(),
            source_session_id: self.source_session_id.clone(),
            active: self.blocks_relaunch(live),
            refusal: self.launch_refusal.clone(),
        }
    }
}

/// The Routine that launched a session, resolved by the launch identity of
/// the session: its launch id or, for an ACP launch, its catalog id.
/// `name` is the current definition name; once the definition can no
/// longer be read it is the last known name and `definition_present` is
/// false.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoutineLaunchLink {
    pub launch_id: String,
    /// The catalog id the run recorded for its session.
    pub agent_session_id: String,
    /// How the run's agent was launched, with the reason for a terminal.
    pub launch: RoutineRunLaunch,
    pub routine_id: String,
    pub owner_kind: RoutineOwnerKind,
    /// Registered Space of the owner; `None` for the project root.
    pub space_id: Option<String>,
    pub owner_path: String,
    pub name: String,
    pub definition_present: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoutineRunRef {
    pub routine_run_id: String,
    pub launch_id: String,
    pub agent_session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_session_id: Option<String>,
    pub active: bool,
    /// The run's launch was refused before its first prompt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refusal: Option<RoutineLaunchRefusal>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RoutineDispatchBlockedCode {
    InvalidRoutine,
    RoutineNotFound,
    FingerprintConflict,
    RecursionGuard,
    NonManualTrigger,
    UnsupportedAction,
    MissingExecutor,
    MissingActorId,
    AmbiguousActorId,
    UnavailableExecutor,
    RepositoryAccessDenied,
}

impl RoutineDispatchBlockedCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidRoutine => "invalid_routine",
            Self::RoutineNotFound => "ROUTINE_NOT_FOUND",
            Self::FingerprintConflict => "ROUTINE_FINGERPRINT_CONFLICT",
            Self::RecursionGuard => "ROUTINE_RECURSION_GUARD",
            Self::NonManualTrigger => "non_manual_trigger",
            Self::UnsupportedAction => "unsupported_action",
            Self::MissingExecutor => "missing_executor",
            Self::MissingActorId => "missing_actor_id",
            Self::AmbiguousActorId => "ambiguous_actor_id",
            Self::UnavailableExecutor => "unavailable_executor",
            Self::RepositoryAccessDenied => "repository_access_denied",
        }
    }
}

#[derive(Debug, Clone)]
pub enum RoutineDispatchResult {
    Started {
        routine_id: String,
        routine_run_id: String,
        launch_id: String,
        agent_session_id: String,
        source_session_id: Option<String>,
    },
    AlreadyRunning {
        routine_id: String,
        routine_run_id: String,
        launch_id: String,
        agent_session_id: String,
        source_session_id: Option<String>,
    },
    Completed,
    Blocked {
        routine_id: String,
        code: RoutineDispatchBlockedCode,
        message: String,
        current_fingerprint: Option<String>,
        /// The executor is not ready to launch (Stage 11 `03`).
        refusal: Option<RoutineLaunchRefusal>,
    },
    Failed {
        routine_id: String,
        routine_run_id: String,
        launch_id: String,
        agent_session_id: String,
        source_session_id: Option<String>,
        message: String,
        /// The launch was refused before its first prompt (Stage 11 `03`).
        refusal: Option<RoutineLaunchRefusal>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum RoutineManualDispatchResult {
    Started {
        routine_id: String,
        routine_run_id: String,
        launch_id: String,
        agent_session_id: String,
        source_session_id: Option<String>,
    },
    Focused {
        routine_id: String,
        routine_run_id: String,
        launch_id: String,
        agent_session_id: String,
        source_session_id: Option<String>,
    },
    Blocked {
        routine_id: String,
        code: RoutineDispatchBlockedCode,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        refusal: Option<RoutineLaunchRefusal>,
    },
    Failed {
        routine_id: String,
        routine_run_id: String,
        launch_id: String,
        agent_session_id: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        refusal: Option<RoutineLaunchRefusal>,
    },
}

impl RoutineManualDispatchResult {
    pub fn from_dispatch(result: RoutineDispatchResult) -> Self {
        match result {
            RoutineDispatchResult::Started {
                routine_id,
                routine_run_id,
                launch_id,
                agent_session_id,
                source_session_id,
            } => Self::Started {
                routine_id,
                routine_run_id,
                launch_id,
                agent_session_id,
                source_session_id,
            },
            RoutineDispatchResult::AlreadyRunning {
                routine_id,
                routine_run_id,
                launch_id,
                agent_session_id,
                source_session_id,
            } => Self::Focused {
                routine_id,
                routine_run_id,
                launch_id,
                agent_session_id,
                source_session_id,
            },
            RoutineDispatchResult::Blocked {
                routine_id,
                code,
                message,
                refusal,
                ..
            } => Self::Blocked {
                routine_id,
                code,
                message,
                refusal,
            },
            RoutineDispatchResult::Failed {
                routine_id,
                routine_run_id,
                launch_id,
                agent_session_id,
                message,
                refusal,
                ..
            } => Self::Failed {
                routine_id,
                routine_run_id,
                launch_id,
                agent_session_id,
                message,
                refusal,
            },
            RoutineDispatchResult::Completed => {
                unreachable!("manual Routine dispatch cannot complete without an Agent Session")
            }
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum RoutineActionTarget {
    #[serde(rename = "trigger.entry")]
    TriggerItem,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoutineDiagnostic {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl RoutineDiagnostic {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            field: None,
            path: None,
        }
    }

    pub fn field(mut self, field: &str) -> Self {
        self.field = Some(field.to_string());
        self
    }

    pub fn path(mut self, path: impl Into<String>) -> Self {
        self.path = Some(path.into());
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoutineNameConflictProjection {
    pub conflicting_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoutineNameConflictEvidence {
    pub routine_id: Option<String>,
    pub name: String,
    pub filename: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoutineNameConflict {
    pub owner: RoutineOwnerDescriptor,
    pub conflicts: Vec<RoutineNameConflictEvidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoutineRow {
    pub routine_id: Option<String>,
    #[serde(skip)]
    pub portable_id: Option<String>,
    pub filename: String,
    pub path: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_conflict: Option<RoutineNameConflictProjection>,
    pub description: Option<String>,
    pub enabled: Option<bool>,
    pub trigger_type: Option<RoutineTriggerType>,
    pub trigger_summary: Option<String>,
    pub action_type: Option<RoutineActionType>,
    pub action_summary: Option<String>,
    pub executor: Option<String>,
    pub last_run_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_origin: Option<RoutineRunOrigin>,
    pub next_run_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run: Option<RoutineRunRef>,
    pub fingerprint: String,
    pub execution_fingerprint: String,
    pub definition: Option<RoutineDefinition>,
    pub diagnostics: Vec<RoutineDiagnostic>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RoutineRunOrigin {
    Local,
    Remote,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoutineCatalogSnapshot {
    pub owner: RoutineOwnerDescriptor,
    pub routines: Vec<RoutineRow>,
    pub diagnostics: Vec<RoutineDiagnostic>,
    pub catalog_fingerprint: String,
    pub refreshed_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum RoutineMutationResult {
    Applied {
        routine_id: String,
        snapshot: RoutineCatalogSnapshot,
        changed_paths: Vec<String>,
        warnings: Vec<RoutineDiagnostic>,
    },
    Stale {
        #[serde(skip_serializing_if = "Option::is_none")]
        current_fingerprint: Option<String>,
    },
    NameConflict {
        conflict: RoutineNameConflict,
    },
    Blocked {
        message: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoutineAutomaticConsent {
    pub enabled: bool,
    pub storage_reset_pending: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_adapters::AgentId;

    #[test]
    fn a_refused_value_leads_to_where_it_was_chosen_and_readiness_to_the_agent_settings() {
        use RoutineLaunchRecovery::{ActorEditor, AgentSettings};
        use RoutineLaunchRefusalReason as Reason;
        let binding = Some(ExecutorSource::Binding);
        let default = Some(ExecutorSource::DefaultAgent);
        for (reason, source, recovery) in [
            (Reason::SettingNotDeclared, binding, ActorEditor),
            (Reason::SettingIsMode, binding, ActorEditor),
            (Reason::SettingRefused, binding, ActorEditor),
            (Reason::SettingNotDeclared, default, AgentSettings),
            (Reason::SettingRefused, default, AgentSettings),
            (Reason::AgentNotReady, binding, AgentSettings),
            (Reason::ConnectionFailed, binding, AgentSettings),
            (Reason::ConnectionFailed, default, AgentSettings),
        ] {
            assert_eq!(
                RoutineLaunchRefusal::new(reason, source, None).recovery,
                recovery,
                "{reason:?} {source:?}"
            );
        }

        let stale =
            RoutineLaunchRefusal::new(Reason::SettingNotDeclared, binding, Some("codex".into()))
                .with_value("model", "gpt-5.6");
        assert_eq!(
            stale.message(),
            "Routine launch refused: codex does not declare model=gpt-5.6"
        );
        let json = serde_json::to_value(&stale).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "reason": "setting_not_declared",
                "recovery": "actor_editor",
                "agent": "codex",
                "setting": "model",
                "value": "gpt-5.6"
            })
        );
        let long = RoutineLaunchRefusal::new(Reason::ConnectionFailed, binding, None)
            .with_detail(&"é".repeat(600));
        assert!(long.detail.unwrap().len() <= REFUSAL_DETAIL_BYTES);
    }

    #[test]
    fn an_unresolved_executor_is_a_refusal_only_where_an_agent_would_have_run() {
        let reference = "agent:01arz3ndektsv4rrffq69g5fav".to_string();
        let owner = "/project".to_string();
        let refusal = |resolution| RoutineLaunchRefusal::from_resolution(&resolution);
        let participant = refusal(ExecutorResolution::DefaultAgentNotSet {
            reference: reference.clone(),
            actor_owner_path: owner.clone(),
        })
        .unwrap();
        assert_eq!(
            participant.reason,
            RoutineLaunchRefusalReason::DefaultAgentNotSet
        );
        assert_eq!(participant.recovery, RoutineLaunchRecovery::AgentSettings);
        let unknown = refusal(ExecutorResolution::UnknownAgent {
            reference: reference.clone(),
            actor_owner_path: owner.clone(),
            agent: AgentId::parse("custom-hermes").unwrap(),
        })
        .unwrap();
        assert_eq!(unknown.reason, RoutineLaunchRefusalReason::UnknownAgent);
        assert_eq!(unknown.recovery, RoutineLaunchRecovery::ActorEditor);
        assert_eq!(unknown.agent.as_deref(), Some("custom-hermes"));
        assert_eq!(
            refusal(ExecutorResolution::ModeUnavailable {
                reference: reference.clone(),
                actor_owner_path: owner,
                message: "unreadable".into(),
            })
            .unwrap()
            .recovery,
            RoutineLaunchRecovery::ActorEditor
        );
        assert_eq!(refusal(ExecutorResolution::MissingExecutor), None);
        assert_eq!(
            refusal(ExecutorResolution::AmbiguousActor { reference }),
            None
        );
    }

    #[test]
    fn root_owner_identity_is_portable_between_clones() {
        let owner = |path: &str, local_id: &str| ResolvedRoutineOwner {
            descriptor: RoutineOwnerDescriptor {
                kind: RoutineOwnerKind::Project,
                space_id: local_id.into(),
                owner_path: ".".into(),
            },
            project_path: PathBuf::from(path),
            space_path: PathBuf::from(path),
            owner_root: PathBuf::from(path),
            index_key: IndexKey::Root(PathBuf::from(path)),
        };
        assert_eq!(
            owner("/clone-one", "local-one").identity(),
            owner("/clone-two", "local-two").identity()
        );
    }

    #[test]
    fn indexed_collection_identity_matches_resolved_owner_identity() {
        let project = PathBuf::from("/project");
        let owner = ResolvedRoutineOwner {
            descriptor: RoutineOwnerDescriptor {
                kind: RoutineOwnerKind::Collection,
                space_id: "space-a".into(),
                owner_path: "tasks".into(),
            },
            project_path: project.clone(),
            space_path: project.join("space-a"),
            owner_root: project.join("space-a/tasks"),
            index_key: IndexKey::Space {
                project,
                space_id: "space-a".into(),
            },
        };
        assert_eq!(
            ResolvedRoutineOwner::indexed_collection_identity(&owner.index_key, "tasks"),
            owner.identity()
        );
    }
}

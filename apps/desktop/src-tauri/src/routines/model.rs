use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::index::IndexKey;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RoutineOwnerKind {
    Project,
    Space,
    Collection,
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

#[derive(Debug, Clone)]
pub(crate) struct ResolvedRoutineOwner {
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
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutineDefinition {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
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
        timezone: String,
        missed_runs: MissedRuns,
    },
    Event {
        event: CollectionEvent,
        #[serde(default, rename = "match", skip_serializing_if = "Option::is_none")]
        match_: Option<EventMatch>,
    },
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum CollectionEvent {
    #[serde(rename = "collection.entry_created")]
    EntryCreated,
    #[serde(rename = "collection.field_changed")]
    FieldChanged,
    #[serde(rename = "collection.entry_deleted")]
    EntryDeleted,
}

impl CollectionEvent {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::EntryCreated => "collection.entry_created",
            Self::FieldChanged => "collection.field_changed",
            Self::EntryDeleted => "collection.entry_deleted",
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RoutineRunTerminalStatus {
    Done,
    Failed,
    Stopped,
    Unknown,
}

impl RoutineRunTerminalStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Stopped => "stopped",
            Self::Unknown => "unknown",
        }
    }

    pub(crate) fn from_str(value: &str) -> Option<Self> {
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
pub(crate) struct RoutineRunRecord {
    pub routine_run_id: String,
    pub routine_id: String,
    pub owner_path: String,
    pub launch_id: String,
    pub pty_id: Option<String>,
    pub source: String,
    pub source_session_id: Option<String>,
    pub agent_session_id: String,
    pub created_at: String,
    pub terminal_status: Option<RoutineRunTerminalStatus>,
    pub terminal_exit_code: Option<i32>,
    pub terminal_reason: Option<String>,
    pub terminal_observed_at: Option<String>,
    pub session_status: Option<String>,
}

impl RoutineRunRecord {
    pub(crate) fn has_live_pty(&self, live_pty_ids: &std::collections::HashSet<String>) -> bool {
        self.pty_id
            .as_ref()
            .is_some_and(|pty_id| live_pty_ids.contains(pty_id))
    }

    pub(crate) fn blocks_relaunch(&self, live_pty_ids: &std::collections::HashSet<String>) -> bool {
        match self.session_status.as_deref() {
            Some("active") => self.has_live_pty(live_pty_ids),
            Some("done" | "failed" | "stopped") => false,
            Some("unknown") => self.has_live_pty(live_pty_ids),
            Some(_) => self.has_live_pty(live_pty_ids),
            None => match self.terminal_status {
                Some(
                    RoutineRunTerminalStatus::Done
                    | RoutineRunTerminalStatus::Failed
                    | RoutineRunTerminalStatus::Stopped,
                ) => false,
                Some(RoutineRunTerminalStatus::Unknown) => self.has_live_pty(live_pty_ids),
                None => self.has_live_pty(live_pty_ids),
            },
        }
    }

    pub(crate) fn to_ref(&self, live_pty_ids: &std::collections::HashSet<String>) -> RoutineRunRef {
        RoutineRunRef {
            routine_run_id: self.routine_run_id.clone(),
            launch_id: self.launch_id.clone(),
            agent_session_id: self.agent_session_id.clone(),
            source_session_id: self.source_session_id.clone(),
            pty_id: self.pty_id.clone(),
            active: self.blocks_relaunch(live_pty_ids),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoutineRunRef {
    pub routine_run_id: String,
    pub launch_id: String,
    pub agent_session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pty_id: Option<String>,
    pub active: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RoutineDispatchBlockedCode {
    InvalidRoutine,
    NonManualTrigger,
    UnsupportedAction,
    MissingExecutor,
    MissingActorId,
    AmbiguousActorId,
    UnavailableExecutor,
    RepositoryAccessDenied,
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
        pty_id: String,
    },
    Focused {
        routine_id: String,
        routine_run_id: String,
        launch_id: String,
        agent_session_id: String,
        source_session_id: Option<String>,
        pty_id: Option<String>,
    },
    Blocked {
        routine_id: String,
        code: RoutineDispatchBlockedCode,
        message: String,
    },
    Failed {
        routine_id: String,
        routine_run_id: String,
        launch_id: String,
        agent_session_id: String,
        message: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum RoutineActionTarget {
    #[serde(rename = "trigger.entry")]
    TriggerEntry,
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
    pub(crate) fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            field: None,
            path: None,
        }
    }

    pub(crate) fn field(mut self, field: &str) -> Self {
        self.field = Some(field.to_string());
        self
    }

    pub(crate) fn path(mut self, path: impl Into<String>) -> Self {
        self.path = Some(path.into());
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoutineRow {
    pub routine_id: String,
    pub filename: String,
    pub path: String,
    pub title: String,
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
    },
    Stale {
        #[serde(skip_serializing_if = "Option::is_none")]
        current_fingerprint: Option<String>,
    },
    Blocked {
        message: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoutineAutomaticConsent {
    pub enabled: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

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
}

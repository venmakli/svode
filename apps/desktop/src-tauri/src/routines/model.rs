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
        format!(
            "{}\0{:?}\0{}",
            self.descriptor.space_id, self.descriptor.kind, self.descriptor.owner_path
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
    pub next_run_at: Option<String>,
    pub fingerprint: String,
    pub definition: Option<RoutineDefinition>,
    pub diagnostics: Vec<RoutineDiagnostic>,
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

//! Shared Routine dispatch eligibility: which definition of an owner catalog a
//! manual, scheduled or event dispatch may run, and the stable run slot keys
//! its claims are recorded under.
//!
//! The host keeps the scheduler loop, the agent launch and the PTY lifecycle;
//! it asks this owner which Routine is eligible instead of repeating the rule.

use super::model::{
    MissedRuns, RoutineAction, RoutineCatalogSnapshot, RoutineDefinition,
    RoutineDispatchBlockedCode, RoutineTimeBasis, RoutineTrigger,
};

/// The dispatch a caller is preparing for one owner catalog.
#[derive(Debug, Clone, Copy)]
pub enum RoutineDispatchRequest<'a> {
    Manual {
        routine_id: &'a str,
        expected_fingerprint: Option<&'a str>,
    },
    Scheduled {
        routine_id: &'a str,
    },
    Event {
        routine_id: &'a str,
        definition_fingerprint: &'a str,
    },
}

impl RoutineDispatchRequest<'_> {
    pub fn routine_id(&self) -> &str {
        match self {
            Self::Manual { routine_id, .. }
            | Self::Scheduled { routine_id }
            | Self::Event { routine_id, .. } => routine_id,
        }
    }

    fn trigger_allowed(&self, definition: &RoutineDefinition) -> bool {
        match self {
            Self::Manual { .. } => !matches!(definition.trigger, RoutineTrigger::Event { .. }),
            Self::Scheduled { .. } => {
                matches!(definition.trigger, RoutineTrigger::Schedule { .. })
                    && definition.enabled == Some(true)
            }
            Self::Event { .. } => {
                matches!(definition.trigger, RoutineTrigger::Event { .. })
                    && definition.enabled == Some(true)
            }
        }
    }

    fn trigger_block_message(&self) -> &'static str {
        match self {
            Self::Manual { .. } => "event routines require a concrete Collection event",
            Self::Scheduled { .. } => "routine is not an enabled schedule",
            Self::Event { .. } => "routine is not an enabled event routine",
        }
    }
}

/// An eligible Routine of the requested dispatch.
#[derive(Debug, Clone)]
pub struct RoutineDispatchCandidate {
    pub routine_id: String,
    pub name: String,
    pub execution_fingerprint: String,
    pub definition: RoutineDefinition,
    /// The Agent Actor reference of a `run_agent` dispatch.
    pub executor: Option<String>,
}

/// The outcome of the shared eligibility rule.
#[derive(Debug, Clone)]
pub enum RoutineDispatchSelection {
    Ready(Box<RoutineDispatchCandidate>),
    Blocked {
        code: RoutineDispatchBlockedCode,
        message: String,
        current_fingerprint: Option<String>,
    },
}

fn blocked(
    code: RoutineDispatchBlockedCode,
    message: impl Into<String>,
) -> RoutineDispatchSelection {
    RoutineDispatchSelection::Blocked {
        code,
        message: message.into(),
        current_fingerprint: None,
    }
}

/// The Routine of `snapshot` the requested dispatch may launch.
pub fn select_dispatch_candidate(
    snapshot: &RoutineCatalogSnapshot,
    request: &RoutineDispatchRequest<'_>,
) -> RoutineDispatchSelection {
    let routine_id = request.routine_id();
    let Some(row) = snapshot
        .routines
        .iter()
        .find(|row| row.routine_id.as_deref() == Some(routine_id))
    else {
        let code = match request {
            RoutineDispatchRequest::Manual {
                expected_fingerprint: Some(_),
                ..
            } => RoutineDispatchBlockedCode::RoutineNotFound,
            _ => RoutineDispatchBlockedCode::InvalidRoutine,
        };
        return blocked(code, "routine definition was not found for this owner");
    };
    if let RoutineDispatchRequest::Manual {
        expected_fingerprint: Some(expected_fingerprint),
        ..
    } = request
        && *expected_fingerprint != row.fingerprint
    {
        return RoutineDispatchSelection::Blocked {
            code: RoutineDispatchBlockedCode::FingerprintConflict,
            message: "routine definition changed after it was read".to_string(),
            current_fingerprint: Some(row.fingerprint.clone()),
        };
    }
    if let RoutineDispatchRequest::Event {
        definition_fingerprint,
        ..
    } = request
        && *definition_fingerprint != row.execution_fingerprint
    {
        return blocked(
            RoutineDispatchBlockedCode::InvalidRoutine,
            "queued event definition is stale",
        );
    }
    let Some(definition) = row.definition.clone() else {
        return blocked(
            RoutineDispatchBlockedCode::InvalidRoutine,
            "routine definition is invalid and cannot be launched",
        );
    };
    if !row.diagnostics.is_empty() {
        return blocked(
            RoutineDispatchBlockedCode::InvalidRoutine,
            row.diagnostics
                .first()
                .map(|diagnostic| diagnostic.message.as_str())
                .unwrap_or("routine definition is invalid"),
        );
    }
    if !request.trigger_allowed(&definition) {
        return blocked(
            RoutineDispatchBlockedCode::NonManualTrigger,
            request.trigger_block_message(),
        );
    }
    let executor = match &definition.action {
        RoutineAction::RunAgent { executor } => Some(executor.clone()),
        RoutineAction::UpdateProperties { .. }
            if matches!(request, RoutineDispatchRequest::Event { .. }) =>
        {
            None
        }
        RoutineAction::UpdateProperties { .. } => {
            return blocked(
                RoutineDispatchBlockedCode::UnsupportedAction,
                "manual update_properties routines are not supported",
            );
        }
    };
    RoutineDispatchSelection::Ready(Box::new(RoutineDispatchCandidate {
        routine_id: routine_id.to_string(),
        name: row.name.clone(),
        execution_fingerprint: row.execution_fingerprint.clone(),
        definition,
        executor,
    }))
}

/// A Routine of `snapshot` whose schedule the host must evaluate on this tick.
#[derive(Debug, Clone)]
pub struct RoutineScheduleCandidate {
    pub routine_id: String,
    pub execution_fingerprint: String,
    pub cron: String,
    pub time_basis: RoutineTimeBasis,
    pub missed_runs: MissedRuns,
    pub definition: RoutineDefinition,
}

/// The enabled, valid schedule Routines of one owner catalog.
pub fn schedule_candidates(snapshot: &RoutineCatalogSnapshot) -> Vec<RoutineScheduleCandidate> {
    snapshot
        .routines
        .iter()
        .filter_map(|row| {
            let routine_id = row.routine_id.as_deref()?;
            if !row.diagnostics.is_empty() {
                return None;
            }
            let definition = row
                .definition
                .as_ref()
                .filter(|definition| definition.enabled == Some(true))?;
            let RoutineTrigger::Schedule {
                cron,
                time_basis,
                missed_runs,
            } = &definition.trigger
            else {
                return None;
            };
            Some(RoutineScheduleCandidate {
                routine_id: routine_id.to_string(),
                execution_fingerprint: row.execution_fingerprint.clone(),
                cron: cron.clone(),
                time_basis: time_basis.clone(),
                missed_runs: *missed_runs,
                definition: definition.clone(),
            })
        })
        .collect()
}

/// The run slot a scheduled occurrence is claimed under across devices.
pub fn scheduled_run_key(
    repository_id: &str,
    routine_id: &str,
    time_basis_identity: &str,
    nominal_civil_time: &str,
) -> String {
    let value =
        format!("{repository_id}\0{routine_id}\0{time_basis_identity}\0{nominal_civil_time}");
    format!("schedule-{:016x}", fnv1a(&value))
}

/// The run slot a queued Collection event is claimed under across devices.
pub fn event_run_key(repository_id: &str, routine_id: &str, event_key: &str) -> String {
    let value = format!("{repository_id}\0{routine_id}\0{event_key}");
    format!("event-{:016x}", fnv1a(&value))
}

fn fnv1a(value: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routines::model::{
        CollectionEvent, RoutineActionTarget, RoutineDiagnostic, RoutineOwnerDescriptor,
        RoutineOwnerKind, RoutineRow,
    };
    use std::collections::BTreeMap;

    fn definition(
        trigger: RoutineTrigger,
        action: RoutineAction,
        enabled: Option<bool>,
    ) -> RoutineDefinition {
        RoutineDefinition {
            name: Some("Review".into()),
            description: None,
            enabled,
            trigger,
            action,
            body: "Review the backlog".into(),
        }
    }

    fn run_agent() -> RoutineAction {
        RoutineAction::RunAgent {
            executor: "agent:01arz3ndektsv4rrffq69g5fav".into(),
        }
    }

    fn update_properties() -> RoutineAction {
        RoutineAction::UpdateProperties {
            target: RoutineActionTarget::TriggerEntry,
            set: BTreeMap::from([("reviewed".into(), serde_json::Value::Bool(true))]),
        }
    }

    fn row(id: &str, definition: Option<RoutineDefinition>) -> RoutineRow {
        RoutineRow {
            routine_id: Some(id.into()),
            portable_id: Some("01arz3ndektsv4rrffq69g5fav".into()),
            filename: format!("{id}.md"),
            path: format!("tasks/.routines/{id}.md"),
            name: id.into(),
            name_conflict: None,
            description: None,
            enabled: definition.as_ref().and_then(|value| value.enabled),
            trigger_type: None,
            trigger_summary: None,
            action_type: None,
            action_summary: None,
            executor: None,
            last_run_at: None,
            last_run_origin: None,
            next_run_at: None,
            last_run: None,
            fingerprint: format!("fingerprint:{id}"),
            execution_fingerprint: format!("execution:{id}"),
            definition,
            diagnostics: Vec::new(),
        }
    }

    fn snapshot(rows: Vec<RoutineRow>) -> RoutineCatalogSnapshot {
        RoutineCatalogSnapshot {
            owner: RoutineOwnerDescriptor {
                kind: RoutineOwnerKind::Collection,
                space_id: "root".into(),
                owner_path: "tasks".into(),
            },
            routines: rows,
            diagnostics: Vec::new(),
            catalog_fingerprint: "catalog".into(),
            refreshed_at: "2026-08-06T00:00:00Z".into(),
        }
    }

    fn blocked_code(selection: RoutineDispatchSelection) -> RoutineDispatchBlockedCode {
        match selection {
            RoutineDispatchSelection::Blocked { code, .. } => code,
            RoutineDispatchSelection::Ready(_) => panic!("expected a blocked selection"),
        }
    }

    #[test]
    fn manual_dispatch_distinguishes_missing_routine_from_stale_fingerprint() {
        let catalog = snapshot(vec![row(
            "one",
            Some(definition(RoutineTrigger::Manual, run_agent(), None)),
        )]);

        assert_eq!(
            blocked_code(select_dispatch_candidate(
                &catalog,
                &RoutineDispatchRequest::Manual {
                    routine_id: "missing",
                    expected_fingerprint: Some("fingerprint:one"),
                },
            )),
            RoutineDispatchBlockedCode::RoutineNotFound
        );
        assert_eq!(
            blocked_code(select_dispatch_candidate(
                &catalog,
                &RoutineDispatchRequest::Manual {
                    routine_id: "missing",
                    expected_fingerprint: None,
                },
            )),
            RoutineDispatchBlockedCode::InvalidRoutine
        );
        let RoutineDispatchSelection::Blocked {
            code,
            current_fingerprint,
            ..
        } = select_dispatch_candidate(
            &catalog,
            &RoutineDispatchRequest::Manual {
                routine_id: "one",
                expected_fingerprint: Some("stale"),
            },
        )
        else {
            panic!("expected a fingerprint conflict");
        };
        assert_eq!(code, RoutineDispatchBlockedCode::FingerprintConflict);
        assert_eq!(current_fingerprint.as_deref(), Some("fingerprint:one"));
    }

    #[test]
    fn invalid_definitions_and_diagnostics_block_before_the_trigger_rule() {
        let mut diagnosed = row(
            "one",
            Some(definition(RoutineTrigger::Manual, run_agent(), None)),
        );
        diagnosed
            .diagnostics
            .push(RoutineDiagnostic::new("routine_invalid", "broken executor"));
        let catalog = snapshot(vec![row("two", None), diagnosed]);

        let RoutineDispatchSelection::Blocked { message, .. } = select_dispatch_candidate(
            &catalog,
            &RoutineDispatchRequest::Manual {
                routine_id: "two",
                expected_fingerprint: None,
            },
        ) else {
            panic!("expected an invalid routine block");
        };
        assert_eq!(
            message,
            "routine definition is invalid and cannot be launched"
        );

        let RoutineDispatchSelection::Blocked { message, code, .. } = select_dispatch_candidate(
            &catalog,
            &RoutineDispatchRequest::Manual {
                routine_id: "one",
                expected_fingerprint: None,
            },
        ) else {
            panic!("expected a diagnostics block");
        };
        assert_eq!(code, RoutineDispatchBlockedCode::InvalidRoutine);
        assert_eq!(message, "broken executor");
    }

    #[test]
    fn each_trigger_only_answers_its_own_dispatch() {
        let event_trigger = RoutineTrigger::Event {
            event: CollectionEvent::EntryCreated,
            match_: None,
        };
        let catalog = snapshot(vec![
            row(
                "manual",
                Some(definition(RoutineTrigger::Manual, run_agent(), None)),
            ),
            row(
                "event",
                Some(definition(event_trigger.clone(), run_agent(), Some(true))),
            ),
            row(
                "paused-event",
                Some(definition(event_trigger, run_agent(), Some(false))),
            ),
        ]);

        assert_eq!(
            blocked_code(select_dispatch_candidate(
                &catalog,
                &RoutineDispatchRequest::Manual {
                    routine_id: "event",
                    expected_fingerprint: None,
                },
            )),
            RoutineDispatchBlockedCode::NonManualTrigger
        );
        assert_eq!(
            blocked_code(select_dispatch_candidate(
                &catalog,
                &RoutineDispatchRequest::Scheduled {
                    routine_id: "manual",
                },
            )),
            RoutineDispatchBlockedCode::NonManualTrigger
        );
        assert_eq!(
            blocked_code(select_dispatch_candidate(
                &catalog,
                &RoutineDispatchRequest::Event {
                    routine_id: "paused-event",
                    definition_fingerprint: "execution:paused-event",
                },
            )),
            RoutineDispatchBlockedCode::NonManualTrigger
        );
        assert_eq!(
            blocked_code(select_dispatch_candidate(
                &catalog,
                &RoutineDispatchRequest::Event {
                    routine_id: "event",
                    definition_fingerprint: "execution:stale",
                },
            )),
            RoutineDispatchBlockedCode::InvalidRoutine
        );
        let RoutineDispatchSelection::Ready(candidate) = select_dispatch_candidate(
            &catalog,
            &RoutineDispatchRequest::Event {
                routine_id: "event",
                definition_fingerprint: "execution:event",
            },
        ) else {
            panic!("expected an eligible event routine");
        };
        assert_eq!(
            candidate.executor.as_deref(),
            Some("agent:01arz3ndektsv4rrffq69g5fav")
        );
        assert_eq!(candidate.execution_fingerprint, "execution:event");
    }

    #[test]
    fn update_properties_runs_only_from_a_collection_event() {
        let catalog = snapshot(vec![row(
            "one",
            Some(definition(
                RoutineTrigger::Event {
                    event: CollectionEvent::FieldChanged,
                    match_: None,
                },
                update_properties(),
                Some(true),
            )),
        )]);

        assert_eq!(
            blocked_code(select_dispatch_candidate(
                &catalog,
                &RoutineDispatchRequest::Manual {
                    routine_id: "one",
                    expected_fingerprint: None,
                },
            )),
            RoutineDispatchBlockedCode::NonManualTrigger
        );
        let RoutineDispatchSelection::Ready(candidate) = select_dispatch_candidate(
            &catalog,
            &RoutineDispatchRequest::Event {
                routine_id: "one",
                definition_fingerprint: "execution:one",
            },
        ) else {
            panic!("expected an eligible update_properties routine");
        };
        assert!(candidate.executor.is_none());
    }

    #[test]
    fn manual_update_properties_is_unsupported_even_for_a_manual_trigger() {
        let catalog = snapshot(vec![row(
            "one",
            Some(definition(
                RoutineTrigger::Manual,
                update_properties(),
                None,
            )),
        )]);

        assert_eq!(
            blocked_code(select_dispatch_candidate(
                &catalog,
                &RoutineDispatchRequest::Manual {
                    routine_id: "one",
                    expected_fingerprint: None,
                },
            )),
            RoutineDispatchBlockedCode::UnsupportedAction
        );
    }

    #[test]
    fn schedule_candidates_keep_only_enabled_valid_schedules() {
        let schedule = RoutineTrigger::Schedule {
            cron: "0 9 * * *".into(),
            time_basis: RoutineTimeBasis::Local,
            missed_runs: MissedRuns::RunOnce,
        };
        let mut diagnosed = row(
            "diagnosed",
            Some(definition(schedule.clone(), run_agent(), Some(true))),
        );
        diagnosed
            .diagnostics
            .push(RoutineDiagnostic::new("routine_invalid", "broken"));
        let mut anonymous = row(
            "anonymous",
            Some(definition(schedule.clone(), run_agent(), Some(true))),
        );
        anonymous.routine_id = None;
        let catalog = snapshot(vec![
            row(
                "enabled",
                Some(definition(schedule.clone(), run_agent(), Some(true))),
            ),
            row(
                "paused",
                Some(definition(schedule.clone(), run_agent(), Some(false))),
            ),
            row(
                "manual",
                Some(definition(RoutineTrigger::Manual, run_agent(), Some(true))),
            ),
            diagnosed,
            anonymous,
            row("invalid", None),
        ]);

        assert_eq!(
            schedule_candidates(&catalog)
                .into_iter()
                .map(|candidate| candidate.routine_id)
                .collect::<Vec<_>>(),
            vec!["enabled".to_string()]
        );
    }

    #[test]
    fn run_keys_are_stable_and_slot_specific() {
        let first = scheduled_run_key("repo-1", "routine-1", "local", "2026-08-07T09:00");
        assert_eq!(
            first,
            scheduled_run_key("repo-1", "routine-1", "local", "2026-08-07T09:00")
        );
        assert_ne!(
            first,
            scheduled_run_key("repo-1", "routine-1", "local", "2026-08-08T09:00")
        );
        assert_ne!(
            first,
            scheduled_run_key("repo-1", "routine-1", "fixed:UTC", "2026-08-07T09:00")
        );

        let event = event_run_key("repo-1", "routine-1", "event-1");
        assert_eq!(event, event_run_key("repo-1", "routine-1", "event-1"));
        assert_ne!(event, event_run_key("repo-1", "routine-1", "event-2"));
        assert_ne!(event, event_run_key("repo-2", "routine-1", "event-1"));
        assert!(event.starts_with("event-"));
        assert!(first.starts_with("schedule-"));
    }
}

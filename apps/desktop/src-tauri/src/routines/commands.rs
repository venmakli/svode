use std::path::Path;
use tauri::{AppHandle, State};

use super::model::{
    CollectionEvent, MissedRuns, ResolvedRoutineOwner, RoutineAction, RoutineAutomaticConsent,
    RoutineCatalogSnapshot, RoutineDefinition, RoutineManualDispatchResult, RoutineMutationResult,
    RoutineOwnerInputKind, RoutineOwnerKind, RoutineTrigger, RoutineTriggerType,
};
use super::{authority, dispatch, service};
#[cfg(test)]
use super::{
    cache,
    dispatch::{EventDispatchPreflight, event_dispatch_preflight},
    parser,
};
use crate::AppError;
use crate::git::access::RepositoryAccessState;
use crate::git::commands::GitState;
use crate::index::{IndexKey, IndexState};
use crate::terminal::TerminalManager;

const DEFAULT_SCHEDULE_CRON: &str = "0 9 * * 1-5";

#[derive(Debug)]
struct RoutineOwnerInput {
    project_path: String,
    space_path: String,
    space_id: String,
    owner_path: String,
    owner_kind: RoutineOwnerInputKind,
}

impl RoutineOwnerInput {
    fn resolve(self) -> Result<ResolvedRoutineOwner, AppError> {
        service::resolve_owner(
            Path::new(&self.project_path),
            Path::new(&self.space_path),
            &self.space_id,
            &self.owner_path,
            self.owner_kind,
        )
    }
}

#[tauri::command]
pub async fn routines_list(
    project_path: String,
    space_path: String,
    space_id: String,
    owner_path: String,
    owner_kind: RoutineOwnerInputKind,
    index_state: State<'_, IndexState>,
    terminal_manager: State<'_, TerminalManager>,
) -> Result<RoutineCatalogSnapshot, AppError> {
    let owner = RoutineOwnerInput {
        project_path,
        space_path,
        space_id,
        owner_path,
        owner_kind,
    }
    .resolve()?;
    service::read_catalog(&index_state, &terminal_manager, &owner).await
}

#[tauri::command]
pub async fn routines_refresh(
    project_path: String,
    space_path: String,
    space_id: String,
    owner_path: String,
    owner_kind: RoutineOwnerInputKind,
    index_state: State<'_, IndexState>,
    terminal_manager: State<'_, TerminalManager>,
) -> Result<RoutineCatalogSnapshot, AppError> {
    routines_list(
        project_path,
        space_path,
        space_id,
        owner_path,
        owner_kind,
        index_state,
        terminal_manager,
    )
    .await
}

#[tauri::command]
pub async fn routines_get_automatic_consent(
    project_path: String,
    space_path: String,
    space_id: String,
    owner_path: String,
    owner_kind: RoutineOwnerInputKind,
    index_state: State<'_, IndexState>,
) -> Result<RoutineAutomaticConsent, AppError> {
    let owner = RoutineOwnerInput {
        project_path,
        space_path,
        space_id,
        owner_path,
        owner_kind,
    }
    .resolve()?;
    Ok(RoutineAutomaticConsent {
        enabled: service::read_automatic_authority(&index_state, &owner).await?,
    })
}

#[tauri::command]
pub async fn routines_set_automatic_consent(
    project_path: String,
    space_path: String,
    space_id: String,
    owner_path: String,
    owner_kind: RoutineOwnerInputKind,
    enabled: bool,
    index_state: State<'_, IndexState>,
) -> Result<RoutineAutomaticConsent, AppError> {
    let owner = RoutineOwnerInput {
        project_path,
        space_path,
        space_id,
        owner_path,
        owner_kind,
    }
    .resolve()?;
    let pool = index_state
        .get_or_create(&IndexKey::Root(owner.project_path.clone()))
        .await?;
    authority::migrate_legacy_for_project(&pool, &index_state, &owner.project_path).await?;
    Ok(RoutineAutomaticConsent {
        enabled: authority::set(&pool, &owner, enabled).await?,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn routines_create(
    app: AppHandle,
    project_path: String,
    space_path: String,
    space_id: String,
    owner_path: String,
    owner_kind: RoutineOwnerInputKind,
    title: String,
    description: Option<String>,
    trigger_type: RoutineTriggerType,
    timezone: Option<String>,
    git_state: State<'_, GitState>,
    access_state: State<'_, RepositoryAccessState>,
    index_state: State<'_, IndexState>,
    terminal_manager: State<'_, TerminalManager>,
) -> Result<RoutineMutationResult, AppError> {
    let owner = RoutineOwnerInput {
        project_path,
        space_path,
        space_id,
        owner_path,
        owner_kind,
    }
    .resolve()?;
    let definition = match create_definition(
        &title,
        description.as_deref(),
        trigger_type,
        timezone.as_deref(),
        owner.descriptor.kind,
    ) {
        Ok(definition) => definition,
        Err(message) => return Ok(RoutineMutationResult::Blocked { message }),
    };
    Ok(desktop_mutation_result(
        service::create_managed(
            &app,
            owner,
            definition,
            service::RoutineMutationPolicy::desktop(),
            &git_state,
            &access_state,
            &index_state,
            &terminal_manager,
        )
        .await?,
    ))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn routines_update(
    app: AppHandle,
    project_path: String,
    space_path: String,
    space_id: String,
    owner_path: String,
    owner_kind: RoutineOwnerInputKind,
    routine_id: String,
    expected_fingerprint: String,
    definition: RoutineDefinition,
    git_state: State<'_, GitState>,
    access_state: State<'_, RepositoryAccessState>,
    index_state: State<'_, IndexState>,
    terminal_manager: State<'_, TerminalManager>,
) -> Result<RoutineMutationResult, AppError> {
    let owner = RoutineOwnerInput {
        project_path,
        space_path,
        space_id,
        owner_path,
        owner_kind,
    }
    .resolve()?;
    Ok(desktop_mutation_result(
        service::update_managed(
            &app,
            owner,
            routine_id,
            expected_fingerprint,
            definition,
            service::RoutineMutationPolicy::desktop(),
            &git_state,
            &access_state,
            &index_state,
            &terminal_manager,
        )
        .await?,
    ))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn routines_delete(
    app: AppHandle,
    project_path: String,
    space_path: String,
    space_id: String,
    owner_path: String,
    owner_kind: RoutineOwnerInputKind,
    routine_id: String,
    expected_fingerprint: String,
    git_state: State<'_, GitState>,
    access_state: State<'_, RepositoryAccessState>,
    index_state: State<'_, IndexState>,
    terminal_manager: State<'_, TerminalManager>,
) -> Result<RoutineMutationResult, AppError> {
    let owner = RoutineOwnerInput {
        project_path,
        space_path,
        space_id,
        owner_path,
        owner_kind,
    }
    .resolve()?;
    Ok(desktop_mutation_result(
        service::delete_managed(
            &app,
            owner,
            routine_id,
            expected_fingerprint,
            &git_state,
            &access_state,
            &index_state,
            &terminal_manager,
        )
        .await?,
    ))
}

fn desktop_mutation_result(result: service::ManagedRoutineMutationResult) -> RoutineMutationResult {
    match result {
        service::ManagedRoutineMutationResult::Applied {
            routine_id,
            snapshot,
            ..
        } => RoutineMutationResult::Applied {
            routine_id,
            snapshot,
        },
        service::ManagedRoutineMutationResult::Conflict {
            current_fingerprint,
        } => RoutineMutationResult::Stale {
            current_fingerprint,
        },
        service::ManagedRoutineMutationResult::Blocked { message, .. } => {
            RoutineMutationResult::Blocked { message }
        }
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn routines_dispatch_manual(
    app: AppHandle,
    project_path: String,
    space_path: String,
    space_id: String,
    owner_path: String,
    owner_kind: RoutineOwnerInputKind,
    routine_id: String,
    git_state: State<'_, GitState>,
    access_state: State<'_, RepositoryAccessState>,
    index_state: State<'_, IndexState>,
    terminal_manager: State<'_, TerminalManager>,
) -> Result<RoutineManualDispatchResult, AppError> {
    let owner = RoutineOwnerInput {
        project_path,
        space_path,
        space_id,
        owner_path,
        owner_kind,
    }
    .resolve()?;
    dispatch::dispatch_explicit(
        &app,
        owner,
        routine_id,
        None,
        &git_state,
        &access_state,
        &index_state,
        &terminal_manager,
    )
    .await
    .map(RoutineManualDispatchResult::from_dispatch)
}

fn create_definition(
    title: &str,
    description: Option<&str>,
    trigger_type: RoutineTriggerType,
    timezone: Option<&str>,
    owner_kind: RoutineOwnerKind,
) -> Result<RoutineDefinition, String> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 240 {
        return Err("routine title must contain 1 to 240 characters".into());
    }
    let description = description.map(str::trim).filter(|value| !value.is_empty());
    if description.is_some_and(|value| value.chars().count() > 2_000) {
        return Err("routine description must contain at most 2000 characters".into());
    }
    let (enabled, trigger) = match trigger_type {
        RoutineTriggerType::Manual => (None, RoutineTrigger::Manual),
        RoutineTriggerType::Schedule => {
            let timezone = timezone
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "schedule routines require an explicit IANA timezone".to_string())?;
            (
                Some(false),
                RoutineTrigger::Schedule {
                    cron: DEFAULT_SCHEDULE_CRON.into(),
                    timezone: timezone.into(),
                    missed_runs: MissedRuns::Skip,
                },
            )
        }
        RoutineTriggerType::Event if owner_kind == RoutineOwnerKind::Collection => (
            Some(false),
            RoutineTrigger::Event {
                event: CollectionEvent::EntryCreated,
                match_: None,
            },
        ),
        RoutineTriggerType::Event => {
            return Err("event routines require a Collection owner".into());
        }
    };
    Ok(RoutineDefinition {
        title: Some(title.into()),
        description: description.map(str::to_owned),
        enabled,
        trigger,
        action: RoutineAction::RunAgent {
            executor: String::new(),
        },
        body: String::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::fs;

    use crate::space::config::write_space_config;
    use crate::space::types::{SpaceConfig, SpaceRef};

    fn space_config(name: &str, spaces: Option<Vec<SpaceRef>>) -> SpaceConfig {
        SpaceConfig {
            name: name.into(),
            description: String::new(),
            icon: "folder".into(),
            spaces,
            agent: None,
            defaults: None,
            git: None,
            assets: None,
            tree: None,
        }
    }

    #[test]
    fn create_defaults_are_disabled_until_an_executor_is_chosen() {
        let definition = create_definition(
            "Weekly review",
            Some("  Summarizes weekly changes.  "),
            RoutineTriggerType::Schedule,
            Some("Europe/Paris"),
            RoutineOwnerKind::Space,
        )
        .unwrap();
        assert_eq!(definition.enabled, Some(false));
        assert_eq!(
            definition.description.as_deref(),
            Some("Summarizes weekly changes.")
        );
        assert!(matches!(
            definition.trigger,
            RoutineTrigger::Schedule {
                missed_runs: MissedRuns::Skip,
                ..
            }
        ));
        assert_eq!(definition.action.executor(), Some(""));
    }

    #[test]
    fn event_create_is_collection_only() {
        assert!(
            create_definition(
                "Event",
                None,
                RoutineTriggerType::Event,
                None,
                RoutineOwnerKind::Project,
            )
            .is_err()
        );
    }

    #[tokio::test]
    async fn event_property_preflight_carries_the_exact_mutation_plan() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path();
        let collection = project.join("tasks");
        fs::create_dir_all(&collection).unwrap();
        write_space_config(project, &space_config("Project", None)).unwrap();
        fs::write(
            collection.join("schema.yaml"),
            "columns:\n  - { name: reviewed, type: checkbox }\nviews: []\n",
        )
        .unwrap();
        fs::write(
            collection.join("item.md"),
            "---\ntitle: Item\nreviewed: false\n---\n",
        )
        .unwrap();
        let owner = service::resolve_owner(
            project,
            project,
            "root-id",
            "tasks",
            RoutineOwnerInputKind::CollectionDirectory,
        )
        .unwrap();
        let definition = RoutineDefinition {
            title: Some("Review item".into()),
            description: None,
            enabled: Some(true),
            trigger: RoutineTrigger::Event {
                event: CollectionEvent::FieldChanged,
                match_: Some(super::super::model::EventMatch {
                    field: "reviewed".into(),
                    from: Some(serde_json::Value::Bool(false)),
                    to: Some(serde_json::Value::Bool(true)),
                }),
            },
            action: RoutineAction::UpdateProperties {
                target: super::super::model::RoutineActionTarget::TriggerEntry,
                set: BTreeMap::from([("reviewed".into(), serde_json::Value::Bool(true))]),
            },
            body: String::new(),
        };
        fs::create_dir_all(owner.routines_dir()).unwrap();
        fs::write(
            owner.routines_dir().join("review-item.md"),
            parser::serialize_definition(&definition).unwrap(),
        )
        .unwrap();
        let row = parser::discover_owner(&owner).routines.remove(0);
        let snapshot = super::super::events::IndexedEntrySnapshot {
            repository_path: project.to_string_lossy().into_owned(),
            collection_path: "tasks".into(),
            entry_path: "tasks/item.md".into(),
            title: "Item".into(),
            fields: BTreeMap::from([("reviewed".into(), serde_json::Value::Bool(false))]),
            created: "2026-08-08T00:00:00Z".into(),
            updated: "2026-08-08T00:00:00Z".into(),
        };
        let payload = super::super::events::CollectionEventPayload {
            repository_path: snapshot.repository_path.clone(),
            collection_path: snapshot.collection_path.clone(),
            entry_path: snapshot.entry_path.clone(),
            event_type: CollectionEvent::FieldChanged.as_str().into(),
            property_key: Some("reviewed".into()),
            old_value: Some(serde_json::Value::Bool(false)),
            new_value: Some(serde_json::Value::Bool(true)),
            old_entry: Some(snapshot.clone()),
            new_entry: Some(snapshot),
            observed_at: "2026-08-08T00:00:01Z".into(),
            source_kind: "watcher".into(),
            origin: None,
            routine_run_id: None,
            lineage_depth: 0,
            execution_run_id: None,
        };
        let event = cache::QueuedRoutineEvent {
            queue_key: "queue".into(),
            event_key: "event".into(),
            owner_path: "tasks".into(),
            routine_id: row.routine_id,
            definition_fingerprint: row.fingerprint,
            payload_json: serde_json::to_string(&payload).unwrap(),
        };

        let Some(EventDispatchPreflight::UpdateProperties { mutation_paths }) =
            event_dispatch_preflight(&owner, &event).await
        else {
            panic!("expected update_properties preflight");
        };
        assert_eq!(
            mutation_paths,
            vec![collection.join("item.md").canonicalize().unwrap()]
        );
    }
}

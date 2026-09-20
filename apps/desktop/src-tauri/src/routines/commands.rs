use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, State};

#[cfg(test)]
use super::dispatch::{EventDispatchPreflight, event_dispatch_preflight};
use super::host::RoutineMutationRuntime;
use super::model::{
    ResolvedRoutineOwner, RoutineAutomaticConsent, RoutineCatalogSnapshot, RoutineDefinition,
    RoutineManualDispatchResult, RoutineMutationResult, RoutineOwnerInputKind,
};
use super::{RoutineStoreState, dispatch};
use crate::AppError;
use crate::git::GitState;
use crate::git::access::{RepositoryAccessState, access_store_path};
use crate::index::IndexState;
use crate::terminal::TerminalManager;
use svode_core::routines::authority;
#[cfg(test)]
use svode_core::routines::operational::QueuedRoutineEvent;
#[cfg(test)]
use svode_core::routines::parser;
use svode_core::routines::service::{
    self, ManagedRoutineMutationResult, RoutineMutationContext, RoutineMutationIntent,
    RoutineMutationOrigin, RoutineMutationPolicyContext, RoutineNamingIntent,
    RoutineValidationIntent,
};

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
        Ok(service::resolve_owner(
            Path::new(&self.project_path),
            Path::new(&self.space_path),
            &self.space_id,
            &self.owner_path,
            self.owner_kind,
        )?)
    }
}

#[tauri::command]
pub async fn routines_list(
    project_path: String,
    space_path: String,
    space_id: String,
    owner_path: String,
    owner_kind: RoutineOwnerInputKind,
    routine_stores: State<'_, Arc<RoutineStoreState>>,
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
    let live_evidence = super::runtime::live_evidence(&terminal_manager)?;
    Ok(service::read_catalog(
        routine_stores.core(),
        &index_state.core,
        &live_evidence,
        &owner,
    )
    .await?)
}

#[tauri::command]
pub async fn routines_refresh(
    project_path: String,
    space_path: String,
    space_id: String,
    owner_path: String,
    owner_kind: RoutineOwnerInputKind,
    routine_stores: State<'_, Arc<RoutineStoreState>>,
    index_state: State<'_, IndexState>,
    terminal_manager: State<'_, TerminalManager>,
) -> Result<RoutineCatalogSnapshot, AppError> {
    routines_list(
        project_path,
        space_path,
        space_id,
        owner_path,
        owner_kind,
        routine_stores,
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
    routine_stores: State<'_, Arc<RoutineStoreState>>,
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
        enabled: service::read_automatic_authority(
            routine_stores.core(),
            &index_state.core,
            &owner,
        )
        .await?,
        storage_reset_pending: authority::recovery_required(&owner.space_path)?,
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
    routine_stores: State<'_, Arc<RoutineStoreState>>,
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
    routine_stores
        .get_or_create_for_index(&index_state, &owner.index_key)
        .await?;
    Ok(RoutineAutomaticConsent {
        enabled: authority::set_key(&owner.space_path, &owner.identity(), enabled)?,
        storage_reset_pending: authority::recovery_required(&owner.space_path)?,
    })
}

#[tauri::command]
pub async fn routines_acknowledge_storage_recovery(space_path: String) -> Result<(), AppError> {
    Ok(authority::acknowledge_recovery(Path::new(&space_path))?)
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
    definition: RoutineDefinition,
    git_state: State<'_, GitState>,
    access_state: State<'_, RepositoryAccessState>,
    routine_stores: State<'_, Arc<RoutineStoreState>>,
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
    let definition = match service::normalize_create_candidate(definition) {
        Ok(definition) => definition,
        Err(message) => return Ok(RoutineMutationResult::Blocked { message }),
    };
    let access_store_path = access_store_path(&app)?;
    let live_evidence = super::runtime::live_evidence(&terminal_manager)?;
    let host = RoutineMutationRuntime::new(&git_state, &access_state, &access_store_path);
    let context = RoutineMutationContext {
        repositories: git_state.repository(),
        routine_stores: routine_stores.core(),
        index_state: &index_state.core,
        live_evidence: &live_evidence,
    };
    let result = service::create_managed(
        owner.clone(),
        definition,
        RoutineMutationIntent {
            validation: RoutineValidationIntent::CompleteDefinition,
            naming: RoutineNamingIntent::MaterializeCanonicalFilename,
        },
        desktop_policy_context(),
        &context,
        &host,
    )
    .await?;
    emit_applied_invalidation(&app, &owner, &result);
    Ok(desktop_mutation_result(result))
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
    materialize_filename: bool,
    definition: RoutineDefinition,
    git_state: State<'_, GitState>,
    access_state: State<'_, RepositoryAccessState>,
    routine_stores: State<'_, Arc<RoutineStoreState>>,
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
    let access_store_path = access_store_path(&app)?;
    let live_evidence = super::runtime::live_evidence(&terminal_manager)?;
    let host = RoutineMutationRuntime::new(&git_state, &access_state, &access_store_path);
    let context = RoutineMutationContext {
        repositories: git_state.repository(),
        routine_stores: routine_stores.core(),
        index_state: &index_state.core,
        live_evidence: &live_evidence,
    };
    let result = service::update_managed(
        owner.clone(),
        routine_id,
        expected_fingerprint,
        definition,
        RoutineMutationIntent {
            validation: RoutineValidationIntent::IntermediateEdit,
            naming: if materialize_filename {
                RoutineNamingIntent::MaterializeCanonicalFilename
            } else {
                RoutineNamingIntent::PreserveCurrentFilename
            },
        },
        desktop_policy_context(),
        &context,
        &host,
    )
    .await?;
    emit_applied_invalidation(&app, &owner, &result);
    Ok(desktop_mutation_result(result))
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
    routine_stores: State<'_, Arc<RoutineStoreState>>,
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
    let access_store_path = access_store_path(&app)?;
    let live_evidence = super::runtime::live_evidence(&terminal_manager)?;
    let host = RoutineMutationRuntime::new(&git_state, &access_state, &access_store_path);
    let context = RoutineMutationContext {
        repositories: git_state.repository(),
        routine_stores: routine_stores.core(),
        index_state: &index_state.core,
        live_evidence: &live_evidence,
    };
    let result = service::delete_managed(
        owner.clone(),
        routine_id,
        expected_fingerprint,
        &context,
        &host,
    )
    .await?;
    emit_applied_invalidation(&app, &owner, &result);
    Ok(desktop_mutation_result(result))
}

fn desktop_policy_context() -> RoutineMutationPolicyContext {
    RoutineMutationPolicyContext {
        origin: RoutineMutationOrigin::User,
        automatic_execution_acknowledged: true,
    }
}

fn emit_applied_invalidation(
    app: &AppHandle,
    owner: &ResolvedRoutineOwner,
    result: &ManagedRoutineMutationResult,
) {
    if matches!(result, ManagedRoutineMutationResult::Applied { .. }) {
        super::emit_owner_invalidation(app, owner);
    }
}

fn desktop_mutation_result(result: ManagedRoutineMutationResult) -> RoutineMutationResult {
    match result {
        ManagedRoutineMutationResult::Applied {
            routine_id,
            snapshot,
            changed_paths,
            warnings,
        } => RoutineMutationResult::Applied {
            routine_id,
            snapshot,
            changed_paths,
            warnings,
        },
        ManagedRoutineMutationResult::Conflict {
            current_fingerprint,
        } => RoutineMutationResult::Stale {
            current_fingerprint,
        },
        ManagedRoutineMutationResult::NameConflict { conflict } => {
            RoutineMutationResult::NameConflict { conflict }
        }
        ManagedRoutineMutationResult::Blocked { message, .. } => {
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
    routine_stores: State<'_, Arc<RoutineStoreState>>,
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
        &routine_stores,
        &index_state,
        &terminal_manager,
    )
    .await
    .map(RoutineManualDispatchResult::from_dispatch)
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

    use crate::routines::model::{CollectionEvent, RoutineAction, RoutineTrigger};

    #[tokio::test]
    async fn event_property_preflight_carries_the_exact_mutation_plan() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path();
        let collection = project.join("tasks");
        fs::create_dir_all(&collection).unwrap();
        write_space_config(project, &space_config("Project", None)).unwrap();
        fs::write(
            collection.join("schema.yaml"),
            "columns:\n  - { name: reviewed, type: boolean }\nviews: []\n",
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
            name: Some("Review item".into()),
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
            parser::serialize_definition(&definition, "01arz3ndektsv4rrffq69g5fav").unwrap(),
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
        let event = QueuedRoutineEvent {
            queue_key: "queue".into(),
            event_key: "event".into(),
            owner_path: "tasks".into(),
            routine_id: row.routine_id.expect("valid routine identity"),
            definition_fingerprint: row.execution_fingerprint,
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

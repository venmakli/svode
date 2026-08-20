pub(crate) mod authority;
mod cache;
pub mod commands;
pub(crate) mod events;
mod model;
mod parser;
mod schedule;
mod scheduler;
pub(crate) mod service;

pub(crate) use scheduler::RoutineSchedulerState;

pub(crate) use model::ResolvedRoutineOwner;
pub(crate) use model::{CollectionEventOrigin, CollectionEventSourceKind};
#[cfg(test)]
pub(crate) use model::{
    RoutineAction, RoutineDiagnostic, RoutineOwnerDescriptor, RoutineRunOrigin, RoutineTrigger,
    RoutineTriggerType,
};
pub(crate) use model::{
    RoutineCatalogSnapshot, RoutineDefinition, RoutineInvalidationPayload, RoutineOwnerInputKind,
    RoutineOwnerKind, RoutineRow,
};

pub(crate) const INVALIDATED_EVENT: &str = "routines:invalidated";

pub(crate) fn emit_invalidation(app: &tauri::AppHandle, payload: RoutineInvalidationPayload) {
    use tauri::Emitter;

    if let Err(error) = app.emit(INVALIDATED_EVENT, payload) {
        tracing::warn!("failed to emit {INVALIDATED_EVENT}: {error}");
    }
}

pub(crate) fn emit_owner_invalidation(app: &tauri::AppHandle, owner: &ResolvedRoutineOwner) {
    emit_invalidation(app, RoutineInvalidationPayload::from_owner(owner));
}

mod cache;
pub mod commands;
pub(crate) mod events;
mod model;
mod parser;
mod schedule;
mod scheduler;

pub(crate) use scheduler::RoutineSchedulerState;

pub(crate) use cache::automatic_consent;
pub(crate) use model::ResolvedRoutineOwner;
pub(crate) use model::{CollectionEventOrigin, CollectionEventSourceKind};
pub(crate) use model::{RoutineInvalidationPayload, RoutineOwnerKind};

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

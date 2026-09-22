pub mod commands;
pub(crate) mod dispatch;
pub(crate) mod host;
pub(crate) mod lifecycle;
pub(crate) mod runtime;
mod scheduler;
mod store_state;

pub(crate) use scheduler::RoutineSchedulerState;
pub(crate) use store_state::RoutineStoreState;

pub(crate) use svode_core::routines::model::ResolvedRoutineOwner;
pub(crate) use svode_core::routines::model::{CollectionEventOrigin, CollectionEventSourceKind};
pub(crate) use svode_core::routines::model::{RoutineInvalidationPayload, RoutineOwnerKind};

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

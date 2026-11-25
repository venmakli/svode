mod acp_launch;
pub mod commands;
pub(crate) mod dispatch;
pub(crate) mod host;
pub(crate) mod lifecycle;
mod scheduler;
mod store_state;

use svode_core::system_path::user_facing_path_str;

pub(crate) use acp_launch::RoutineAcpLaunches;
pub(crate) use scheduler::RoutineSchedulerState;
pub(crate) use store_state::RoutineStoreState;

pub(crate) use svode_core::routines::model::ResolvedRoutineOwner;
pub(crate) use svode_core::routines::model::{CollectionEventOrigin, CollectionEventSourceKind};
pub(crate) use svode_core::routines::model::{RoutineInvalidationPayload, RoutineOwnerKind};

pub(crate) const INVALIDATED_EVENT: &str = "routines:invalidated";

pub(crate) fn emit_invalidation<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    mut payload: RoutineInvalidationPayload,
) {
    use tauri::Emitter;

    payload.project_path = user_facing_path_str(&payload.project_path);
    payload.space_path = user_facing_path_str(&payload.space_path);
    if let Err(error) = app.emit(INVALIDATED_EVENT, payload) {
        tracing::warn!("failed to emit {INVALIDATED_EVENT}: {error}");
    }
}

pub(crate) fn emit_owner_invalidation(app: &tauri::AppHandle, owner: &ResolvedRoutineOwner) {
    emit_invalidation(app, RoutineInvalidationPayload::from_owner(owner));
}

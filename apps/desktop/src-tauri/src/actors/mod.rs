pub mod commands;
mod mailmap;
mod mutations;
mod resolver;

pub(crate) use resolver::ActorInvalidationPayload;
pub use resolver::{ActorActivity, ActorCandidate, ActorCatalog, ActorCatalogState, ActorSnapshot};

pub(crate) const INVALIDATED_EVENT: &str = "actors:invalidated";

fn emit_invalidation(app: &tauri::AppHandle, payload: ActorInvalidationPayload) {
    use tauri::Emitter;

    if let Err(error) = app.emit(INVALIDATED_EVENT, payload) {
        tracing::warn!("failed to emit {INVALIDATED_EVENT}: {error}");
    }
}

pub(crate) fn invalidate_repository(
    app: &tauri::AppHandle,
    repository: &std::path::Path,
) -> Result<(), crate::AppError> {
    use tauri::Manager;

    let payload = app
        .state::<ActorCatalogState>()
        .mark_repository_dirty(repository)?;
    emit_invalidation(app, payload);
    Ok(())
}

pub(crate) async fn invalidate_space(
    app: &tauri::AppHandle,
    space_path: &std::path::Path,
) -> Result<(), crate::AppError> {
    use tauri::Manager;

    let git_state = app.state::<crate::git::commands::GitState>();
    let cli = crate::git::commands::require_cli(&git_state)?;
    let repository = resolver::resolve_repository(&cli, space_path).await?;
    invalidate_repository(app, &repository)
}

pub(crate) fn emit_published(
    app: &tauri::AppHandle,
    repository: &std::path::Path,
    generation: u64,
) {
    use tauri::Manager;

    let payload = match app
        .state::<ActorCatalogState>()
        .published_invalidation(repository, generation)
    {
        Ok(payload) => payload,
        Err(error) => {
            tracing::warn!(
                repository = %repository.display(),
                "failed to prepare published actor invalidation: {error}"
            );
            return;
        }
    };
    emit_invalidation(app, payload);
}

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use crate::error::AppError;

pub use svode_core::page::naming::DocumentNameConflict;
#[cfg(test)]
pub use svode_core::page::naming::DocumentNameConflictEvidence;
pub(crate) use svode_core::page::naming::{display_name_key, is_user_document};

static DOCUMENT_NAME_LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();

pub(crate) fn with_document_name_lock<T>(
    space: &str,
    operation: impl FnOnce() -> Result<T, AppError>,
) -> Result<T, AppError> {
    let lock = {
        let locks = DOCUMENT_NAME_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
        let mut locks = locks
            .lock()
            .map_err(|_| AppError::General("document name lock is poisoned".into()))?;
        locks
            .entry(space.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    let _guard = lock
        .lock()
        .map_err(|_| AppError::General("document name lock is poisoned".into()))?;
    operation()
}

pub(crate) fn document_name_conflict(
    space: &Path,
    path: &str,
    title: &str,
) -> Result<Option<DocumentNameConflict>, AppError> {
    svode_core::page::naming::document_name_conflict(space, path, title).map_err(Into::into)
}

pub(crate) fn ensure_document_name_available(
    space: &Path,
    path: &str,
    title: &str,
) -> Result<(), AppError> {
    if let Some(conflict) = document_name_conflict(space, path, title)? {
        return Err(AppError::DocumentNameConflict(conflict));
    }
    Ok(())
}

pub(crate) fn allocate_document_title(
    space: &Path,
    path_for_scope: &str,
    requested: &str,
) -> Result<String, AppError> {
    if !is_user_document(path_for_scope)
        || document_name_conflict(space, path_for_scope, requested)?.is_none()
    {
        return Ok(requested.to_string());
    }
    for index in 2..=10_000 {
        let candidate = format!("{requested} {index}");
        if document_name_conflict(space, path_for_scope, &candidate)?.is_none() {
            return Ok(candidate);
        }
    }
    Err(AppError::General(
        "could not allocate a unique document title".into(),
    ))
}

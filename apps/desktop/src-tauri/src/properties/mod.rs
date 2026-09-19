//! Desktop adapter over the core Collections engine: Entry hydration, Tauri
//! read targets, actor catalog commands and Page write orchestration.

use std::collections::BTreeMap;

use crate::error::AppError;
use svode_core::page::entry;

pub use svode_core::collections::engine::*;

mod actors;
pub use actors::{ActorCandidate, ActorCatalogState, list_actors, refresh_actors};

mod query;
pub use query::{list_entries_for_view, query_entries};

pub(crate) mod read;

/// Applies a routine property batch through the ordinary entry/property
/// mutation services while keeping relation reverse writes all-or-nothing.
pub(crate) fn update_entry_properties_atomic(
    space: &str,
    project_path: Option<&str>,
    file_path: &str,
    values: &BTreeMap<String, serde_json::Value>,
) -> Result<entry::Entry, AppError> {
    if values.is_empty() {
        return Err(svode_core::collections::CollectionError::Schema(
            "property batch cannot be empty".to_string(),
        )
        .into());
    }
    let batch = prepare_entry_field_batch(
        space,
        project_path,
        file_path,
        values,
        EntryFieldBatchIntent::Routine,
    )?;
    let paths = batch.mutation_paths().to_vec();
    with_rollback_as(paths, || -> Result<entry::Entry, AppError> {
        apply_prepared_entry_field_relations(&batch)?;
        let current = entry::read(space, file_path)?;
        entry::write_under_name_lock(
            space,
            file_path,
            &current.body,
            None,
            None,
            None,
            Some(batch.into_metadata()),
            None,
            None,
            true,
            project_path,
            None,
        )?;
        Ok(entry::read(space, file_path)?)
    })
}

#[cfg(test)]
mod tests;

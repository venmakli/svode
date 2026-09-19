use super::*;
pub use svode_core::collections::query::reorder_visible_entry_names;
pub(super) use svode_core::collections::query::{
    entry_order_name, entry_parent_dir, query_entry_rows, validate_ad_hoc_query,
};

pub(super) fn entries_from_rows(
    space: &str,
    collection_path: &str,
    rows: Vec<svode_core::collections::query::EntryQueryRow>,
    include_nested: bool,
    manual_order: bool,
) -> Result<Vec<entry::Entry>, AppError> {
    let collection = svode_core::collections::query::collection_root_for_sql(collection_path);
    let rows = rows
        .into_iter()
        .filter(|row| include_nested || entry_parent_dir(&row.file_path) == collection)
        .collect();
    let rows = if manual_order {
        svode_core::collections::query::order_rows(space, collection_path, rows, include_nested)
    } else {
        rows
    };
    rows.into_iter()
        .map(|row| {
            let mut entry = entry::read(space, &row.file_path)?;
            entry.meta.created = row.created;
            entry.meta.updated = row.updated;
            Ok(entry)
        })
        .collect()
}

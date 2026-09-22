//! Collection item reads over a prepared index pool: view and ad-hoc
//! queries hydrated into source Entries with indexed dates.

use std::path::Path;

use sqlx::SqlitePool;

use super::CollectionError;
use super::engine::{Filter, Sort, View, read_collection_schema, resolve_query_filters};
use super::query::{
    EntryQueryRow, collection_root_for_sql, entry_parent_dir, order_rows, query_entry_rows,
    validate_ad_hoc_query,
};
use crate::actors::resolver::ActorCatalogState;
use crate::git::cli::GitCli;
use crate::page::PageError;
use crate::page::entry::{self, Entry};

pub async fn list_entries_for_view(
    pool: &SqlitePool,
    actor_catalog: &ActorCatalogState,
    git_cli: Option<&GitCli>,
    space: &str,
    collection_path: &str,
    view_name: &str,
    include_nested: Option<bool>,
) -> Result<Vec<Entry>, PageError> {
    let schema = read_collection_schema(space, collection_path)?;
    let view = schema
        .views
        .iter()
        .find(|view| view.name() == view_name)
        .ok_or_else(|| CollectionError::Schema(format!("view '{view_name}' not found")))?;
    let include_nested = include_nested.unwrap_or_else(|| match view {
        View::Table { show_nested, .. } => show_nested.unwrap_or(true),
        _ => false,
    });
    let filters = resolve_query_filters(
        actor_catalog,
        git_cli,
        Path::new(space),
        &schema,
        view.filters(),
    )
    .await?;
    let rows = query_entry_rows(
        pool,
        &schema,
        collection_path,
        &filters,
        view.sorts(),
        None,
        None,
    )
    .await?;
    entries_from_rows(
        space,
        collection_path,
        rows,
        include_nested,
        view.sorts().is_empty(),
    )
}

#[allow(clippy::too_many_arguments)]
pub async fn query_entries(
    pool: &SqlitePool,
    actor_catalog: &ActorCatalogState,
    git_cli: Option<&GitCli>,
    space: &str,
    collection_path: &str,
    filters: Option<Vec<Filter>>,
    sort: Option<Vec<Sort>>,
    include_nested: Option<bool>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<Entry>, PageError> {
    let schema = read_collection_schema(space, collection_path)?;
    let filters = filters.unwrap_or_default();
    let sort = sort.unwrap_or_default();
    let include_nested = include_nested.unwrap_or(false);
    validate_ad_hoc_query(&schema, &filters, &sort)?;
    let filters =
        resolve_query_filters(actor_catalog, git_cli, Path::new(space), &schema, &filters).await?;
    let rows = query_entry_rows(
        pool,
        &schema,
        collection_path,
        &filters,
        &sort,
        limit,
        offset,
    )
    .await?;
    entries_from_rows(
        space,
        collection_path,
        rows,
        include_nested,
        sort.is_empty(),
    )
}

pub fn entries_from_rows(
    space: &str,
    collection_path: &str,
    rows: Vec<EntryQueryRow>,
    include_nested: bool,
    manual_order: bool,
) -> Result<Vec<Entry>, PageError> {
    let collection = collection_root_for_sql(collection_path);
    let rows = rows
        .into_iter()
        .filter(|row| include_nested || entry_parent_dir(&row.file_path) == collection)
        .collect();
    let rows = if manual_order {
        order_rows(space, collection_path, rows, include_nested)
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

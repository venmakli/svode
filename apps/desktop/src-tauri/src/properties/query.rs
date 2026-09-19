use std::path::Path;

use sqlx::SqlitePool;

use super::{ActorCatalogState, Filter, Sort, View, read_collection_schema, resolve_query_filters};
use crate::error::AppError;
use crate::files::entry;
use crate::git::cli::GitCli;
use svode_core::collections::query::{entry_parent_dir, query_entry_rows, validate_ad_hoc_query};

pub async fn list_entries_for_view(
    pool: &SqlitePool,
    actor_catalog: &ActorCatalogState,
    git_cli: Option<&GitCli>,
    space: &str,
    collection_path: &str,
    view_name: &str,
    include_nested: Option<bool>,
) -> Result<Vec<entry::Entry>, AppError> {
    let schema = read_collection_schema(space, collection_path)?;
    let view = schema
        .views
        .iter()
        .find(|view| view.name() == view_name)
        .ok_or_else(|| {
            AppError::from(svode_core::collections::CollectionError::Schema(format!(
                "view '{view_name}' not found"
            )))
        })?;
    let include_nested = include_nested.unwrap_or_else(|| match view {
        View::Table { show_nested, .. } => show_nested.unwrap_or(true),
        _ => false,
    });
    let filters = resolve_query_filters(
        actor_catalog,
        git_cli.map(GitCli::core),
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
) -> Result<Vec<entry::Entry>, AppError> {
    let schema = read_collection_schema(space, collection_path)?;
    let filters = filters.unwrap_or_default();
    let sort = sort.unwrap_or_default();
    let include_nested = include_nested.unwrap_or(false);
    validate_ad_hoc_query(&schema, &filters, &sort)?;
    let filters = resolve_query_filters(
        actor_catalog,
        git_cli.map(GitCli::core),
        Path::new(space),
        &schema,
        &filters,
    )
    .await?;
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

//! Collection schema, item queries, actor catalog, schema/view changes and
//! integrity through the shared core Collections engine.

use std::path::Path;

use serde::Deserialize;
use serde_json::{Value, json};
use svode_core::collections::engine::{
    self, CollectionSchema, Column, Filter, PreparedCollectionMutation, Sort, View,
};
use svode_core::index::knowledge::KnowledgeScope;
use svode_core::index::state::IndexRuntimeState;
use svode_core::page::metadata::relative_changed_paths;

use crate::args::{CollectionArgs, clamp_limit};
use crate::error::ToolError;
use crate::host::{RequestTarget, ToolHost};
use crate::mutation::authorize;
use crate::path::{ensure_inside, validate_public_rel_path};
use crate::result::ToolCallResult;
use crate::target::{index_key, resolve_space};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QueryCollectionItemsArgs {
    #[serde(default)]
    space_id: Option<String>,
    collection_path: String,
    #[serde(default, alias = "filters")]
    filter: Vec<Filter>,
    #[serde(default)]
    sort: Vec<Sort>,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    offset: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListActorsArgs {
    #[serde(default)]
    space_id: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    all_time: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntegrityArgs {
    #[serde(default)]
    space_id: Option<String>,
    #[serde(default)]
    collection_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AddCollectionColumnArgs {
    #[serde(default)]
    space_id: Option<String>,
    collection_path: String,
    column: Column,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateCollectionColumnArgs {
    #[serde(default)]
    space_id: Option<String>,
    collection_path: String,
    column_name: String,
    patch: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteCollectionColumnArgs {
    #[serde(default)]
    space_id: Option<String>,
    collection_path: String,
    column_name: String,
    #[serde(default)]
    delete_values: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AddCollectionViewArgs {
    #[serde(default)]
    space_id: Option<String>,
    collection_path: String,
    view: View,
    #[serde(default)]
    position: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateCollectionViewArgs {
    #[serde(default)]
    space_id: Option<String>,
    collection_path: String,
    view_name: String,
    patch: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteCollectionViewArgs {
    #[serde(default)]
    space_id: Option<String>,
    collection_path: String,
    view_name: String,
}

/// Space directory and validated Collection path of a Collection request.
fn collection_target(
    target: &RequestTarget,
    space_id: Option<&str>,
    collection_path: &str,
) -> Result<(String, String), ToolError> {
    let space = resolve_space(target, space_id)?;
    let collection_path = validate_public_rel_path(collection_path, true)?;
    ensure_inside(Path::new(&space), &collection_path)?;
    Ok((space, collection_path))
}

pub(crate) fn get_collection_schema(
    target: &RequestTarget,
    args: CollectionArgs,
) -> Result<ToolCallResult, ToolError> {
    let (space, collection_path) =
        collection_target(target, args.space_id.as_deref(), &args.collection_path)?;
    let schema = engine::read_collection_schema(&space, &collection_path)?;
    Ok(ToolCallResult::ok(
        format!("Read schema for collection {collection_path}."),
        json!({ "collectionPath": collection_path, "schema": schema }),
    ))
}

pub(crate) async fn query_collection_items(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: QueryCollectionItemsArgs,
) -> Result<ToolCallResult, ToolError> {
    let (space, collection_path) =
        collection_target(target, args.space_id.as_deref(), &args.collection_path)?;
    let limit = clamp_limit(args.limit);
    let offset = args.offset.unwrap_or(0).max(0);
    let key = index_key(target, args.space_id.as_deref());
    let index = host
        .prepare_index(
            Path::new(&target.project_path),
            &KnowledgeScope::Space {
                space_id: IndexRuntimeState::space_id_for_key(&key),
            },
        )
        .await?;
    let pool = host
        .index_pool(&key, Path::new(&space))
        .await
        .ok_or_else(|| {
            ToolError::new(
                "INDEX_UNAVAILABLE",
                "The Svode index of this Space is not open",
            )
        })?;
    let runtime = host.read_runtime();
    let git_cli = runtime.git.require_cli().ok();
    let items = svode_core::collections::entries::query_entries(
        &pool,
        runtime.actors,
        git_cli.as_ref(),
        &space,
        &collection_path,
        Some(args.filter),
        Some(args.sort),
        Some(false),
        Some(limit),
        Some(offset),
    )
    .await?;
    Ok(ToolCallResult::ok(
        format!("Returned {} Collection items.", items.len()),
        json!({ "items": items, "limit": limit, "offset": offset, "index": index }),
    ))
}

pub(crate) async fn list_actors(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: ListActorsArgs,
) -> Result<ToolCallResult, ToolError> {
    let space = resolve_space(target, args.space_id.as_deref())?;
    let runtime = host.read_runtime();
    let cli = runtime.git.require_cli()?;
    let snapshot = runtime.actors.snapshot(&cli, Path::new(&space)).await?;
    let actors = snapshot
        .candidates()
        .into_iter()
        .map(|actor| {
            json!({
                "email": actor.email,
                "name": actor.name,
                "lastCommitAt": actor.last_commit_at,
                "commitCount": actor.commit_count,
                "isMe": actor.is_me,
            })
        })
        .collect::<Vec<_>>();
    Ok(ToolCallResult::ok(
        format!("Found {} actors.", actors.len()),
        json!({ "actors": actors }),
    ))
}

pub(crate) fn validate_collection_integrity(
    target: &RequestTarget,
    args: IntegrityArgs,
) -> Result<ToolCallResult, ToolError> {
    let space = resolve_space(target, args.space_id.as_deref())?;
    let collection_path = args
        .collection_path
        .as_deref()
        .map(|path| validate_public_rel_path(path, true))
        .transpose()?;
    if let Some(path) = collection_path.as_deref() {
        ensure_inside(Path::new(&space), path)?;
    }
    let report = engine::validate_collection_integrity_with_project(
        &space,
        collection_path.as_deref(),
        Some(target.project_path.as_str()),
    )?;
    let error_count = report.errors.len();
    let warning_count = report.warnings.len();
    Ok(ToolCallResult::ok(
        format!(
            "Collection integrity check completed: {error_count} errors, {warning_count} warnings."
        ),
        json!({
            "collectionPath": collection_path,
            "issuesBySeverity": report,
            "errorCount": error_count,
            "warningCount": warning_count,
        }),
    ))
}

pub(crate) async fn add_collection_column(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: AddCollectionColumnArgs,
) -> Result<ToolCallResult, ToolError> {
    let (space, collection_path) =
        collection_target(target, args.space_id.as_deref(), &args.collection_path)?;
    let mutation = engine::prepare_add_schema_column(
        &space,
        &collection_path,
        args.column,
        Some(target.project_path.as_str()),
    )?;
    apply_schema_mutation(
        host,
        &space,
        &collection_path,
        mutation,
        format!("Added column to collection {collection_path}."),
    )
    .await
}

pub(crate) async fn update_collection_column(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: UpdateCollectionColumnArgs,
) -> Result<ToolCallResult, ToolError> {
    let (space, collection_path) =
        collection_target(target, args.space_id.as_deref(), &args.collection_path)?;
    let mutation = engine::prepare_update_schema_column(
        &space,
        &collection_path,
        &args.column_name,
        json_to_yaml(args.patch)?,
        Some(target.project_path.as_str()),
    )?;
    apply_schema_mutation(
        host,
        &space,
        &collection_path,
        mutation,
        format!(
            "Updated column {} in collection {collection_path}.",
            args.column_name
        ),
    )
    .await
}

pub(crate) async fn delete_collection_column(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: DeleteCollectionColumnArgs,
) -> Result<ToolCallResult, ToolError> {
    let (space, collection_path) =
        collection_target(target, args.space_id.as_deref(), &args.collection_path)?;
    let mutation = engine::prepare_delete_schema_column(
        &space,
        &collection_path,
        &args.column_name,
        args.delete_values.unwrap_or(false),
        Some(target.project_path.as_str()),
    )?;
    apply_schema_mutation(
        host,
        &space,
        &collection_path,
        mutation,
        format!(
            "Deleted column {} from collection {collection_path}.",
            args.column_name
        ),
    )
    .await
}

pub(crate) async fn add_collection_view(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: AddCollectionViewArgs,
) -> Result<ToolCallResult, ToolError> {
    let (space, collection_path) =
        collection_target(target, args.space_id.as_deref(), &args.collection_path)?;
    let mutation = engine::prepare_add_view(&space, &collection_path, args.view, args.position)?;
    apply_schema_mutation(
        host,
        &space,
        &collection_path,
        mutation,
        format!("Added view to collection {collection_path}."),
    )
    .await
}

pub(crate) async fn update_collection_view(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: UpdateCollectionViewArgs,
) -> Result<ToolCallResult, ToolError> {
    let (space, collection_path) =
        collection_target(target, args.space_id.as_deref(), &args.collection_path)?;
    let mutation = engine::prepare_update_view(
        &space,
        &collection_path,
        &args.view_name,
        json_to_yaml(args.patch)?,
    )?;
    apply_schema_mutation(
        host,
        &space,
        &collection_path,
        mutation,
        format!(
            "Updated view {} in collection {collection_path}.",
            args.view_name
        ),
    )
    .await
}

pub(crate) async fn delete_collection_view(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: DeleteCollectionViewArgs,
) -> Result<ToolCallResult, ToolError> {
    let (space, collection_path) =
        collection_target(target, args.space_id.as_deref(), &args.collection_path)?;
    let mutation = engine::prepare_delete_view(&space, &collection_path, &args.view_name)?;
    apply_schema_mutation(
        host,
        &space,
        &collection_path,
        mutation,
        format!(
            "Deleted view {} from collection {collection_path}.",
            args.view_name
        ),
    )
    .await
}

/// Authorizes the planned schema touched-set, including reverse-relation
/// schemas and cleaned item sources, then applies it with the engine
/// rollback.
async fn apply_schema_mutation(
    host: &impl ToolHost,
    space: &str,
    collection_path: &str,
    mutation: PreparedCollectionMutation<CollectionSchema>,
    message: String,
) -> Result<ToolCallResult, ToolError> {
    authorize(host, space, mutation.paths().to_vec()).await?;
    let outcome = mutation.apply()?;
    let changed_paths = relative_changed_paths(space, &outcome.changed_paths);
    Ok(ToolCallResult::ok(
        message,
        json!({ "collectionPath": collection_path, "schema": outcome.value, "changedPaths": changed_paths }),
    ))
}

fn json_to_yaml(value: Value) -> Result<serde_yml::Value, ToolError> {
    serde_yml::to_value(value)
        .map_err(|error| ToolError::new("INVALID_YAML_VALUE", error.to_string()))
}

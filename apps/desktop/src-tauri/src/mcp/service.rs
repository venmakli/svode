use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use super::active::{ActiveProjectContext, ActiveProjectState};
use super::error::McpBusinessError;
use super::path::{
    ensure_inside, normalize_create_document_path, validate_document_path, validate_public_rel_path,
};
use super::protocol::ToolCallResult;
use crate::files::{entry, tree};
use crate::git::{self, commands::GitState};
use crate::index::{IndexKey, IndexState, search};
use crate::properties::{self, Filter, Sort};
use crate::space::{config as space_config, project};

const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 200;

#[derive(Debug, Clone, Copy)]
pub enum MutationOrigin {
    Mcp,
}

#[derive(Debug, Clone, Copy)]
pub enum CommitPolicy {
    NoAutocommit,
}

#[derive(Debug, Clone, Copy)]
struct McpMutationPolicy {
    _origin: MutationOrigin,
    _commit_policy: CommitPolicy,
}

const MCP_MUTATION_POLICY: McpMutationPolicy = McpMutationPolicy {
    _origin: MutationOrigin::Mcp,
    _commit_policy: CommitPolicy::NoAutocommit,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpaceArgs {
    #[serde(default)]
    space_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathArgs {
    #[serde(default)]
    space_id: Option<String>,
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListDocumentsArgs {
    #[serde(default)]
    space_id: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    offset: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteDocumentArgs {
    #[serde(default)]
    space_id: Option<String>,
    path: String,
    content: String,
    #[serde(default)]
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateDocumentArgs {
    #[serde(default)]
    space_id: Option<String>,
    path: String,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchArgs {
    #[serde(default)]
    space_id: Option<String>,
    query: String,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    offset: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CollectionArgs {
    #[serde(default)]
    space_id: Option<String>,
    collection_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueryEntriesArgs {
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
struct CreateEntryArgs {
    #[serde(default)]
    space_id: Option<String>,
    collection_path: String,
    title: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    fields: Option<HashMap<String, Value>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateFieldsArgs {
    #[serde(default)]
    space_id: Option<String>,
    path: String,
    fields: HashMap<String, Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateBodyArgs {
    #[serde(default)]
    space_id: Option<String>,
    path: String,
    body: String,
}

pub async fn call_tool(app: AppHandle, name: &str, args: Value) -> ToolCallResult {
    match call_tool_inner(app, name, args).await {
        Ok(result) => result,
        Err(error) => ToolCallResult::business_error(error),
    }
}

async fn call_tool_inner(
    app: AppHandle,
    name: &str,
    args: Value,
) -> Result<ToolCallResult, McpBusinessError> {
    match name {
        "get_project_info" => get_project_info(&app).await,
        "list_spaces" => list_spaces(&app).await,
        "list_documents" => list_documents(&app, decode(args)?).await,
        "read_document" => read_document(&app, decode(args)?).await,
        "write_document" => write_document(&app, decode(args)?).await,
        "create_document" => create_document(&app, decode(args)?).await,
        "search_documents" => search_documents(&app, decode(args)?).await,
        "list_collections" => list_collections(&app, decode(args)?).await,
        "get_collection_schema" => get_collection_schema(&app, decode(args)?).await,
        "query_entries" => query_entries(&app, decode(args)?).await,
        "get_entry" => get_entry(&app, decode(args)?).await,
        "create_entry" => create_entry(&app, decode(args)?).await,
        "update_entry_fields" => update_entry_fields(&app, decode(args)?).await,
        "update_entry_body" => update_entry_body(&app, decode(args)?).await,
        "get_git_status" => get_git_status(&app, decode(args)?).await,
        _ => Err(McpBusinessError::new(
            "UNKNOWN_TOOL",
            format!("unknown CombAI MCP tool: {name}"),
        )),
    }
}

fn decode<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, McpBusinessError> {
    serde_json::from_value(value).map_err(Into::into)
}

fn active_context(app: &AppHandle) -> Result<ActiveProjectContext, McpBusinessError> {
    app.state::<ActiveProjectState>()
        .get()
        .ok_or_else(McpBusinessError::no_active_project)
}

async fn resolve_space(
    app: &AppHandle,
    requested_space_id: Option<String>,
) -> Result<(ActiveProjectContext, String), McpBusinessError> {
    let context = active_context(app)?;
    if let Some(space_id) = requested_space_id {
        let state = app.state::<IndexState>();
        let path = state
            .space_path_of(Path::new(&context.project_path), Some(&space_id))
            .await?;
        Ok((context, path.to_string_lossy().to_string()))
    } else {
        Ok((context.clone(), context.active_space_path))
    }
}

fn clamp_limit(limit: Option<i64>) -> i64 {
    limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)
}

fn offset(offset: Option<i64>) -> usize {
    offset.unwrap_or(0).max(0) as usize
}

async fn get_project_info(app: &AppHandle) -> Result<ToolCallResult, McpBusinessError> {
    let context = active_context(app)?;
    let spaces = project::list_spaces(Path::new(&context.project_path))?;
    let cfg = space_config::read_space_config(Path::new(&context.project_path))?;
    let structured = json!({
        "projectPath": context.project_path,
        "activeSpaceId": context.active_space_id,
        "activeSpacePath": context.active_space_path,
        "projectName": cfg.name,
        "spaces": spaces,
        "capabilities": {
            "documents": true,
            "collections": true,
            "gitStatus": true,
            "commitChanges": false,
            "autocommit": false
        }
    });
    Ok(ToolCallResult::ok(
        "Active CombAI project information.",
        structured,
    ))
}

async fn list_spaces(app: &AppHandle) -> Result<ToolCallResult, McpBusinessError> {
    let context = active_context(app)?;
    let spaces = project::list_spaces(Path::new(&context.project_path))?;
    let structured = json!({
        "activeSpaceId": context.active_space_id,
        "spaces": spaces
    });
    Ok(ToolCallResult::ok(
        format!("Found {} spaces.", spaces.len()),
        structured,
    ))
}

async fn list_documents(
    app: &AppHandle,
    args: ListDocumentsArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let (_, space) = resolve_space(app, args.space_id).await?;
    let root = args
        .path
        .as_deref()
        .map(|p| validate_public_rel_path(p, true))
        .transpose()?
        .unwrap_or_default();
    ensure_inside(Path::new(&space), &root)?;
    let mut nodes = tree::build_tree(&space).map_err(McpBusinessError::from)?;
    if !root.is_empty() {
        let prefix = format!("{root}/");
        nodes.retain(|node| node.path == root || node.path.starts_with(&prefix));
    }
    let total = nodes.len();
    let start = offset(args.offset);
    let limit = clamp_limit(args.limit) as usize;
    let items = nodes
        .into_iter()
        .skip(start)
        .take(limit)
        .collect::<Vec<_>>();
    Ok(ToolCallResult::ok(
        format!("Found {total} documents."),
        json!({ "items": items, "total": total, "limit": limit, "offset": start }),
    ))
}

async fn read_document(
    app: &AppHandle,
    args: PathArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let (_, space) = resolve_space(app, args.space_id).await?;
    let path = validate_document_path(&args.path)?;
    ensure_inside(Path::new(&space), &path)?;
    let entry = entry::read(&space, &path)?;
    Ok(ToolCallResult::ok(
        format!("Read document {path}."),
        json!({ "document": entry }),
    ))
}

async fn write_document(
    app: &AppHandle,
    args: WriteDocumentArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (_, space) = resolve_space(app, args.space_id).await?;
    let path = validate_document_path(&args.path)?;
    ensure_inside(Path::new(&space), &path)?;
    let result = entry::write(
        &space,
        &path,
        &args.content,
        args.title.as_deref(),
        None,
        None,
        None,
        None,
        true,
    )?;
    let changed = vec![result.new_path.clone().unwrap_or(path.clone())];
    Ok(ToolCallResult::ok(
        format!("Updated document {path}."),
        json!({ "path": path, "newPath": result.new_path, "changedPaths": changed }),
    ))
}

async fn create_document(
    app: &AppHandle,
    args: CreateDocumentArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (_, space) = resolve_space(app, args.space_id).await?;
    let path = normalize_create_document_path(&args.path)?;
    let abs = ensure_inside(Path::new(&space), &path)?;
    if abs.exists() {
        return Err(McpBusinessError::new(
            "FILE_ALREADY_EXISTS",
            format!("File already exists: {path}"),
        ));
    }
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent)?;
    }
    let title = args.title.unwrap_or_else(|| {
        Path::new(&path)
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("Untitled")
            .replace(['-', '_'], " ")
    });
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let meta = entry::EntryMeta {
        id: ulid::Ulid::new().to_string().to_lowercase(),
        title,
        icon: None,
        description: None,
        cover: None,
        created: now.clone(),
        updated: now,
        extra: HashMap::new(),
    };
    fs::write(
        &abs,
        crate::files::frontmatter::serialize(&meta, args.content.as_deref().unwrap_or("")),
    )?;
    Ok(ToolCallResult::ok(
        format!("Created document {path}."),
        json!({ "path": path, "changedPaths": [path] }),
    ))
}

async fn search_documents(
    app: &AppHandle,
    args: SearchArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let (context, space) = resolve_space(app, args.space_id.clone()).await?;
    let state = app.state::<IndexState>();
    let key = index_key_for_context(&context, args.space_id.as_deref());
    let limit = clamp_limit(args.limit);
    let start = offset(args.offset);
    let pool = match state.get_or_create(&key).await {
        Ok(pool) => pool,
        Err(_) => {
            let key = state
                .key_for_space_dir(Path::new(&space))
                .await
                .unwrap_or(IndexKey::Root(PathBuf::from(&space)));
            state.get_or_create(&key).await?
        }
    };
    let mut results =
        search::search_fts(&pool, &args.query, None, None, limit + start as i64).await?;
    let total = results.len();
    results = results
        .into_iter()
        .skip(start)
        .take(limit as usize)
        .collect();
    Ok(ToolCallResult::ok(
        format!("Found {} matching documents.", results.len()),
        json!({ "items": results, "total": total, "limit": limit, "offset": start }),
    ))
}

async fn list_collections(
    app: &AppHandle,
    args: SpaceArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let (_, space) = resolve_space(app, args.space_id).await?;
    let collections = properties::list_collections(&space)?;
    Ok(ToolCallResult::ok(
        format!("Found {} collections.", collections.len()),
        json!({ "collections": collections }),
    ))
}

async fn get_collection_schema(
    app: &AppHandle,
    args: CollectionArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let (_, space) = resolve_space(app, args.space_id).await?;
    let collection_path = validate_public_rel_path(&args.collection_path, true)?;
    ensure_inside(Path::new(&space), &collection_path)?;
    let schema = properties::read_collection_schema(&space, &collection_path)?;
    Ok(ToolCallResult::ok(
        format!("Read schema for collection {collection_path}."),
        json!({ "collectionPath": collection_path, "schema": schema }),
    ))
}

async fn query_entries(
    app: &AppHandle,
    args: QueryEntriesArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let (context, space) = resolve_space(app, args.space_id.clone()).await?;
    let collection_path = validate_public_rel_path(&args.collection_path, true)?;
    ensure_inside(Path::new(&space), &collection_path)?;
    let limit = clamp_limit(args.limit);
    let offset = args.offset.unwrap_or(0).max(0);
    let pool = pool_for_space(app, &context, args.space_id.as_deref(), &space).await?;
    let git_state = app.state::<GitState>();
    let git_cli = git::commands::require_cli(&git_state).ok();
    let entries = properties::query_entries(
        &pool,
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
        format!("Returned {} entries.", entries.len()),
        json!({ "items": entries, "limit": limit, "offset": offset }),
    ))
}

async fn get_entry(app: &AppHandle, args: PathArgs) -> Result<ToolCallResult, McpBusinessError> {
    read_document(app, args).await
}

async fn create_entry(
    app: &AppHandle,
    args: CreateEntryArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (_, space) = resolve_space(app, args.space_id).await?;
    let collection_path = validate_public_rel_path(&args.collection_path, true)?;
    ensure_inside(Path::new(&space), &collection_path)?;
    let fields = args
        .fields
        .map(|fields| {
            fields
                .into_iter()
                .map(|(key, value)| {
                    serde_yml::to_value(value)
                        .map(|value| (key, value))
                        .map_err(|error| {
                            McpBusinessError::new("INVALID_FIELD_VALUE", error.to_string())
                        })
                })
                .collect::<Result<HashMap<_, _>, _>>()
        })
        .transpose()?;
    let parent = if collection_path == "." {
        None
    } else {
        Some(collection_path.as_str())
    };
    let mut created = entry::create_with_contextual_defaults(&space, parent, &args.title, fields)?;
    if let Some(body) = args.body {
        let written = entry::write(
            &space,
            &created.path,
            &body,
            None,
            None,
            None,
            None,
            None,
            true,
        )?;
        if let Some(new_path) = written.new_path {
            created.path = new_path;
        }
        created.body = body;
    }
    Ok(ToolCallResult::ok(
        format!("Created entry {}.", created.path),
        json!({ "entry": created, "changedPaths": [created.path] }),
    ))
}

async fn update_entry_fields(
    app: &AppHandle,
    args: UpdateFieldsArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (_, space) = resolve_space(app, args.space_id).await?;
    let path = validate_document_path(&args.path)?;
    ensure_inside(Path::new(&space), &path)?;
    let mut updated = None;
    for (field, value) in args.fields {
        updated = Some(entry::update_field(&space, &path, &field, value)?);
    }
    let entry = match updated {
        Some(entry) => entry,
        None => entry::read(&space, &path)?,
    };
    Ok(ToolCallResult::ok(
        format!("Updated fields for {path}."),
        json!({ "entry": entry, "changedPaths": [path] }),
    ))
}

async fn update_entry_body(
    app: &AppHandle,
    args: UpdateBodyArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (_, space) = resolve_space(app, args.space_id).await?;
    let path = validate_document_path(&args.path)?;
    ensure_inside(Path::new(&space), &path)?;
    let current = entry::read(&space, &path)?;
    let result = entry::write(
        &space,
        &path,
        &args.body,
        Some(&current.meta.title),
        current.meta.icon.as_deref(),
        Some(current.meta.extra),
        Some(&current.meta.id),
        None,
        true,
    )?;
    Ok(ToolCallResult::ok(
        format!("Updated body for {path}."),
        json!({ "path": path, "newPath": result.new_path, "changedPaths": [path] }),
    ))
}

async fn get_git_status(
    app: &AppHandle,
    args: SpaceArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let (_, space) = resolve_space(app, args.space_id).await?;
    let state = app.state::<GitState>();
    let cli = git::commands::require_cli(&state)?;
    let lock = state.get_lock(Path::new(&space)).await;
    let _guard = lock.lock().await;
    let status = git::ops::status(&cli, Path::new(&space)).await?;
    Ok(ToolCallResult::ok(
        "Git status for active CombAI space.",
        json!({ "status": status }),
    ))
}

async fn pool_for_space(
    app: &AppHandle,
    context: &ActiveProjectContext,
    space_id: Option<&str>,
    space: &str,
) -> Result<sqlx::SqlitePool, McpBusinessError> {
    let state = app.state::<IndexState>();
    let key = index_key_for_context(context, space_id);
    match state.get_or_create(&key).await {
        Ok(pool) => Ok(pool),
        Err(_) => {
            let fallback = state
                .key_for_space_dir(Path::new(space))
                .await
                .unwrap_or(IndexKey::Root(PathBuf::from(space)));
            Ok(state.get_or_create(&fallback).await?)
        }
    }
}

fn index_key_for_context(context: &ActiveProjectContext, space_id: Option<&str>) -> IndexKey {
    if let Some(space_id) = space_id {
        IndexKey::Space {
            project: PathBuf::from(&context.project_path),
            space_id: space_id.to_string(),
        }
    } else if let Some(space_id) = context.active_space_id.as_ref() {
        IndexKey::Space {
            project: PathBuf::from(&context.project_path),
            space_id: space_id.clone(),
        }
    } else {
        IndexKey::Root(PathBuf::from(&context.project_path))
    }
}

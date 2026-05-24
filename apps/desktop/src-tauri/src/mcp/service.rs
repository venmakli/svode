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
use crate::properties::{
    self, CollectionSchema, Column, DocumentConfig, Filter, PropertyType, Sort, View,
};
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
    #[serde(default)]
    icon: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    cover: Option<entry::Cover>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateDocumentMetadataArgs {
    #[serde(default)]
    space_id: Option<String>,
    path: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    icon: Option<Option<String>>,
    #[serde(default)]
    description: Option<Option<String>>,
    #[serde(default)]
    cover: Option<Option<entry::Cover>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateCollectionArgs {
    #[serde(default)]
    space_id: Option<String>,
    path: String,
    title: String,
    #[serde(default)]
    icon: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    cover: Option<entry::Cover>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    columns: Option<Vec<Column>>,
    #[serde(default)]
    views: Option<Vec<View>>,
    #[serde(default)]
    document_label: Option<String>,
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
    icon: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    cover: Option<entry::Cover>,
    #[serde(default)]
    fields: Option<HashMap<String, Value>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddCollectionColumnArgs {
    #[serde(default)]
    space_id: Option<String>,
    collection_path: String,
    column: Column,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCollectionColumnArgs {
    #[serde(default)]
    space_id: Option<String>,
    collection_path: String,
    column_name: String,
    patch: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteCollectionColumnArgs {
    #[serde(default)]
    space_id: Option<String>,
    collection_path: String,
    column_name: String,
    #[serde(default)]
    delete_values: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddCollectionViewArgs {
    #[serde(default)]
    space_id: Option<String>,
    collection_path: String,
    view: View,
    #[serde(default)]
    position: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCollectionViewArgs {
    #[serde(default)]
    space_id: Option<String>,
    collection_path: String,
    view_name: String,
    patch: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteCollectionViewArgs {
    #[serde(default)]
    space_id: Option<String>,
    collection_path: String,
    view_name: String,
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
        "update_document_metadata" => update_document_metadata(&app, decode(args)?).await,
        "create_collection" => create_collection(&app, decode(args)?).await,
        "convert_to_collection" => convert_to_collection(&app, decode(args)?).await,
        "search_documents" => search_documents(&app, decode(args)?).await,
        "list_collections" => list_collections(&app, decode(args)?).await,
        "get_collection_schema" => get_collection_schema(&app, decode(args)?).await,
        "query_entries" => query_entries(&app, decode(args)?).await,
        "get_entry" => get_entry(&app, decode(args)?).await,
        "create_entry" => create_entry(&app, decode(args)?).await,
        "update_entry_fields" => update_entry_fields(&app, decode(args)?).await,
        "update_entry_body" => update_entry_body(&app, decode(args)?).await,
        "add_collection_column" => add_collection_column(&app, decode(args)?).await,
        "update_collection_column" => update_collection_column(&app, decode(args)?).await,
        "delete_collection_column" => delete_collection_column(&app, decode(args)?).await,
        "add_collection_view" => add_collection_view(&app, decode(args)?).await,
        "update_collection_view" => update_collection_view(&app, decode(args)?).await,
        "delete_collection_view" => delete_collection_view(&app, decode(args)?).await,
        "get_git_status" => get_git_status(&app, decode(args)?).await,
        "get_combai_guide" => get_combai_guide().await,
        _ => Err(McpBusinessError::new(
            "UNKNOWN_TOOL",
            format!("unknown CombAI MCP tool: {name}"),
        )),
    }
}

fn decode<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, McpBusinessError> {
    serde_json::from_value(value).map_err(Into::into)
}

fn json_to_yaml(value: Value) -> Result<serde_yml::Value, McpBusinessError> {
    serde_yml::to_value(value)
        .map_err(|error| McpBusinessError::new("INVALID_YAML_VALUE", error.to_string()))
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

fn rel_path_from_space(space: &str, path: &Path) -> String {
    path.strip_prefix(space)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn rel_paths_from_space(space: &str, paths: Vec<PathBuf>) -> Vec<String> {
    paths
        .into_iter()
        .map(|path| rel_path_from_space(space, &path))
        .collect()
}

fn schema_path_rel(collection_path: &str) -> String {
    if collection_path.is_empty() {
        "schema.yaml".to_string()
    } else {
        format!("{collection_path}/schema.yaml")
    }
}

fn collection_readme_path(collection_path: &str) -> String {
    format!("{collection_path}/README.md")
}

fn fallback_collection_title(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Collection")
        .replace(['-', '_'], " ")
}

fn schema_for_create_collection(args: &CreateCollectionArgs) -> CollectionSchema {
    let mut schema = properties::default_collection_schema();
    if let Some(columns) = args.columns.clone() {
        let fields = std::iter::once("title".to_string())
            .chain(columns.iter().map(|column| column.name.clone()))
            .collect::<Vec<_>>();
        schema.columns = columns;
        if args.views.is_none()
            && let Some(View::Table { visible_fields, .. }) = schema.views.first_mut()
        {
            *visible_fields = fields;
        }
    }
    if let Some(views) = args.views.clone() {
        schema.views = views;
    }
    if let Some(label) = args
        .document_label
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        schema.document = Some(DocumentConfig {
            label: Some(label.to_string()),
        });
    }
    schema
}

fn write_metadata_frontmatter(
    space: &str,
    path: &str,
    title: Option<String>,
    icon: Option<Option<String>>,
    description: Option<Option<String>>,
    cover: Option<Option<entry::Cover>>,
) -> Result<entry::Entry, McpBusinessError> {
    let current = entry::read(space, path)?;
    let mut meta = current.meta;
    if let Some(title) = title {
        let title = title.trim();
        if title.is_empty() {
            return Err(McpBusinessError::new(
                "INVALID_METADATA",
                "title must not be empty",
            ));
        }
        meta.title = title.to_string();
    }
    if let Some(icon) = icon {
        meta.icon = icon;
    }
    if let Some(description) = description {
        meta.description = description.and_then(|value| {
            let trimmed = value.trim().to_string();
            (!trimmed.is_empty()).then_some(trimmed)
        });
    }
    if let Some(cover) = cover {
        meta.cover = cover;
    }
    meta.updated = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    fs::write(
        Path::new(space).join(path),
        crate::files::frontmatter::serialize(&meta, &current.body),
    )?;
    entry::read(space, path).map_err(Into::into)
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
    let (_, space) = resolve_space(app, args.space_id.clone()).await?;
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
    let (_, space) = resolve_space(app, args.space_id.clone()).await?;
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
        icon: args.icon,
        description: args
            .description
            .and_then(|value| (!value.trim().is_empty()).then_some(value)),
        cover: args.cover,
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

async fn update_document_metadata(
    app: &AppHandle,
    args: UpdateDocumentMetadataArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (_, space) = resolve_space(app, args.space_id).await?;
    let path = validate_document_path(&args.path)?;
    ensure_inside(Path::new(&space), &path)?;
    let document = write_metadata_frontmatter(
        &space,
        &path,
        args.title,
        args.icon,
        args.description,
        args.cover,
    )?;
    Ok(ToolCallResult::ok(
        format!("Updated metadata for {path}."),
        json!({ "document": document, "changedPaths": [path] }),
    ))
}

async fn create_collection(
    app: &AppHandle,
    args: CreateCollectionArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (_, space) = resolve_space(app, args.space_id.clone()).await?;
    let collection_path = validate_public_rel_path(&args.path, false)?;
    if Path::new(&collection_path).extension().is_some() {
        return Err(McpBusinessError::new(
            "INVALID_PATH",
            "collection path must be a directory path without a file extension",
        ));
    }
    let collection_abs = ensure_inside(Path::new(&space), &collection_path)?;
    if collection_abs.join("schema.yaml").exists() {
        return Err(McpBusinessError::new(
            "COLLECTION_ALREADY_EXISTS",
            format!("Collection already exists: {collection_path}"),
        ));
    }
    let readme_path = collection_readme_path(&collection_path);
    let readme_abs = ensure_inside(Path::new(&space), &readme_path)?;
    if readme_abs.exists() {
        return Err(McpBusinessError::new(
            "FILE_ALREADY_EXISTS",
            format!("README already exists; use convert_to_collection instead: {readme_path}"),
        ));
    }

    let schema = schema_for_create_collection(&args);
    properties::write_collection_schema(&space, &collection_path, &schema)?;
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let meta = entry::EntryMeta {
        id: ulid::Ulid::new().to_string().to_lowercase(),
        title: if args.title.trim().is_empty() {
            fallback_collection_title(&collection_path)
        } else {
            args.title
        },
        icon: args.icon,
        description: args
            .description
            .and_then(|value| (!value.trim().is_empty()).then_some(value)),
        cover: args.cover,
        created: now.clone(),
        updated: now,
        extra: HashMap::new(),
    };
    if let Some(parent) = readme_abs.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(
        &readme_abs,
        crate::files::frontmatter::serialize(&meta, args.body.as_deref().unwrap_or("")),
    )?;
    let collection = entry::read(&space, &readme_path)?;
    Ok(ToolCallResult::ok(
        format!("Created collection {collection_path}."),
        json!({
            "collectionPath": collection_path,
            "entry": collection,
            "schema": schema,
            "changedPaths": [readme_path, schema_path_rel(&collection_path)]
        }),
    ))
}

async fn convert_to_collection(
    app: &AppHandle,
    args: PathArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (_, space) = resolve_space(app, args.space_id).await?;
    let raw_path = validate_public_rel_path(&args.path, false)?;
    let abs = ensure_inside(Path::new(&space), &raw_path)?;
    let collection_path;
    let entry_result;
    let mut changed_paths = Vec::new();

    if abs.is_dir() {
        let readme_rel = collection_readme_path(&raw_path);
        let readme_abs = Path::new(&space).join(&readme_rel);
        if readme_abs.exists() {
            let entry = entry::read(&space, &readme_rel)?;
            collection_path =
                entry::convert_entry_to_nested_collection(Path::new(&space), &entry.meta.id)?;
            changed_paths.push(schema_path_rel(&collection_path));
            entry_result = entry::read(&space, &readme_rel)?;
        } else {
            entry_result = entry::convert_bare_folder_to_collection(Path::new(&space), &raw_path)?;
            collection_path = raw_path.clone();
            changed_paths.push(collection_readme_path(&collection_path));
            changed_paths.push(schema_path_rel(&collection_path));
        }
    } else {
        let path = validate_document_path(&raw_path)?;
        let entry = entry::read(&space, &path)?;
        let folder_entry = entry::convert_entry_to_folder(Path::new(&space), &entry.meta.id, None)?;
        let converted_collection_path = Path::new(&folder_entry.path)
            .parent()
            .map(|parent| parent.to_string_lossy().replace('\\', "/"))
            .ok_or_else(|| {
                McpBusinessError::new("INVALID_PATH", "converted entry has no folder path")
            })?;
        entry::convert_entry_to_nested_collection(Path::new(&space), &folder_entry.meta.id)?;
        collection_path = converted_collection_path;
        changed_paths.push(path);
        changed_paths.push(collection_readme_path(&collection_path));
        changed_paths.push(schema_path_rel(&collection_path));
        entry_result = entry::read(&space, &collection_readme_path(&collection_path))?;
    }

    Ok(ToolCallResult::ok(
        format!("Converted {raw_path} to collection {collection_path}."),
        json!({
            "collectionPath": collection_path,
            "entry": entry_result,
            "changedPaths": changed_paths
        }),
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
    let parent = if collection_path.is_empty() {
        None
    } else {
        Some(collection_path.as_str())
    };
    let mut created = entry::create_with_contextual_defaults(&space, parent, &args.title, fields)?;
    if args.icon.is_some() || args.description.is_some() || args.cover.is_some() {
        created = write_metadata_frontmatter(
            &space,
            &created.path,
            None,
            args.icon.map(Some),
            args.description.map(Some),
            args.cover.map(Some),
        )?;
    }
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

async fn add_collection_column(
    app: &AppHandle,
    args: AddCollectionColumnArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (_, space) = resolve_space(app, args.space_id).await?;
    let collection_path = validate_public_rel_path(&args.collection_path, true)?;
    ensure_inside(Path::new(&space), &collection_path)?;
    let include_markdown = args.column.type_ == PropertyType::UniqueId;
    let paths = properties::schema_column_mutation_paths(
        &space,
        &collection_path,
        &args.column,
        include_markdown,
    )?;
    let schema = properties::add_schema_column(&space, &collection_path, args.column)?;
    let changed_paths = rel_paths_from_space(&space, paths);
    Ok(ToolCallResult::ok(
        format!("Added column to collection {collection_path}."),
        json!({ "collectionPath": collection_path, "schema": schema, "changedPaths": changed_paths }),
    ))
}

async fn update_collection_column(
    app: &AppHandle,
    args: UpdateCollectionColumnArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (_, space) = resolve_space(app, args.space_id).await?;
    let collection_path = validate_public_rel_path(&args.collection_path, true)?;
    ensure_inside(Path::new(&space), &collection_path)?;
    let paths = properties::schema_column_name_mutation_paths(
        &space,
        &collection_path,
        &args.column_name,
        true,
    )?;
    let schema = properties::update_schema_column(
        &space,
        &collection_path,
        &args.column_name,
        json_to_yaml(args.patch)?,
    )?;
    let changed_paths = rel_paths_from_space(&space, paths);
    Ok(ToolCallResult::ok(
        format!(
            "Updated column {} in collection {collection_path}.",
            args.column_name
        ),
        json!({ "collectionPath": collection_path, "schema": schema, "changedPaths": changed_paths }),
    ))
}

async fn delete_collection_column(
    app: &AppHandle,
    args: DeleteCollectionColumnArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (_, space) = resolve_space(app, args.space_id).await?;
    let collection_path = validate_public_rel_path(&args.collection_path, true)?;
    ensure_inside(Path::new(&space), &collection_path)?;
    let delete_values = args.delete_values.unwrap_or(false);
    let paths = properties::schema_mutation_paths(&space, &collection_path, delete_values)?;
    let schema = properties::delete_schema_column(
        &space,
        &collection_path,
        &args.column_name,
        delete_values,
    )?;
    let changed_paths = rel_paths_from_space(&space, paths);
    Ok(ToolCallResult::ok(
        format!(
            "Deleted column {} from collection {collection_path}.",
            args.column_name
        ),
        json!({ "collectionPath": collection_path, "schema": schema, "changedPaths": changed_paths }),
    ))
}

async fn add_collection_view(
    app: &AppHandle,
    args: AddCollectionViewArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (_, space) = resolve_space(app, args.space_id).await?;
    let collection_path = validate_public_rel_path(&args.collection_path, true)?;
    ensure_inside(Path::new(&space), &collection_path)?;
    let paths = properties::schema_mutation_paths(&space, &collection_path, false)?;
    let schema = properties::add_view(&space, &collection_path, args.view, args.position)?;
    let changed_paths = rel_paths_from_space(&space, paths);
    Ok(ToolCallResult::ok(
        format!("Added view to collection {collection_path}."),
        json!({ "collectionPath": collection_path, "schema": schema, "changedPaths": changed_paths }),
    ))
}

async fn update_collection_view(
    app: &AppHandle,
    args: UpdateCollectionViewArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (_, space) = resolve_space(app, args.space_id).await?;
    let collection_path = validate_public_rel_path(&args.collection_path, true)?;
    ensure_inside(Path::new(&space), &collection_path)?;
    let paths = properties::schema_mutation_paths(&space, &collection_path, false)?;
    let schema = properties::update_view(
        &space,
        &collection_path,
        &args.view_name,
        json_to_yaml(args.patch)?,
    )?;
    let changed_paths = rel_paths_from_space(&space, paths);
    Ok(ToolCallResult::ok(
        format!(
            "Updated view {} in collection {collection_path}.",
            args.view_name
        ),
        json!({ "collectionPath": collection_path, "schema": schema, "changedPaths": changed_paths }),
    ))
}

async fn delete_collection_view(
    app: &AppHandle,
    args: DeleteCollectionViewArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (_, space) = resolve_space(app, args.space_id).await?;
    let collection_path = validate_public_rel_path(&args.collection_path, true)?;
    ensure_inside(Path::new(&space), &collection_path)?;
    let paths = properties::schema_mutation_paths(&space, &collection_path, false)?;
    let schema = properties::delete_view(&space, &collection_path, &args.view_name)?;
    let changed_paths = rel_paths_from_space(&space, paths);
    Ok(ToolCallResult::ok(
        format!(
            "Deleted view {} from collection {collection_path}.",
            args.view_name
        ),
        json!({ "collectionPath": collection_path, "schema": schema, "changedPaths": changed_paths }),
    ))
}

async fn get_combai_guide() -> Result<ToolCallResult, McpBusinessError> {
    Ok(ToolCallResult::ok(
        "CombAI MCP guide.",
        json!({ "guide": super::tools::guide_text() }),
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

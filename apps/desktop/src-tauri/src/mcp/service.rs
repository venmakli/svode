use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use super::active::{self, ActiveProjectContext, ActiveProjectState};
use super::error::McpBusinessError;
use super::path::{
    ensure_inside, normalize_create_document_path, validate_document_path, validate_public_rel_path,
};
use super::protocol::{IpcContextOverride, ToolCallResult};
use crate::commands::files as files_commands;
use crate::files::{entry, tree};
use crate::git::{self, commands::GitState};
use crate::index::{IndexKey, IndexState, search};
use crate::properties::{self, CollectionSchema, Column, Filter, PropertyType, Sort, View};
use crate::repo_path::{RootMode, normalize_repo_relative, repo_relative_from_base};
use crate::space::{config as space_config, project, registry};
use crate::storage::{assets, scope::resolve_effective_storage_scope_for_key};

const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 200;
const MCP_ROOT_SPACE_ID: &str = "root";

tokio::task_local! {
    static MCP_CONTEXT_OVERRIDE: Option<ActiveProjectContext>;
}

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
struct RenameEntryArgs {
    #[serde(default)]
    space_id: Option<String>,
    from: String,
    to: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoveEntryArgs {
    #[serde(default)]
    space_id: Option<String>,
    from: String,
    to_parent: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IntegrityArgs {
    #[serde(default)]
    space_id: Option<String>,
    #[serde(default)]
    collection_path: Option<String>,
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
#[serde(deny_unknown_fields)]
struct ImportAssetArgs {
    #[serde(default)]
    space_id: Option<String>,
    document_path: String,
    source_path: String,
    #[serde(default)]
    file_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListActorsArgs {
    #[serde(default)]
    space_id: Option<String>,
    #[serde(default)]
    all_time: Option<bool>,
}

pub async fn call_tool(app: AppHandle, name: &str, args: Value) -> ToolCallResult {
    call_tool_with_context(app, name, args, None).await
}

pub async fn call_tool_with_context(
    app: AppHandle,
    name: &str,
    args: Value,
    context_override: Option<IpcContextOverride>,
) -> ToolCallResult {
    let resolved_context = match resolve_context_override(&app, context_override.as_ref()) {
        Ok(context) => context,
        Err(error) => return ToolCallResult::business_error(error),
    };

    if let Some(context) = resolved_context {
        return match MCP_CONTEXT_OVERRIDE
            .scope(Some(context), call_tool_inner(app, name, args))
            .await
        {
            Ok(result) => result,
            Err(error) => ToolCallResult::business_error(error),
        };
    }

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
        "import_asset" => import_asset(&app, decode(args)?).await,
        "create_collection" => create_collection(&app, decode(args)?).await,
        "convert_to_collection" => convert_to_collection(&app, decode(args)?).await,
        "search_documents" => search_documents(&app, decode(args)?).await,
        "list_collections" => list_collections(&app, decode(args)?).await,
        "get_collection_schema" => get_collection_schema(&app, decode(args)?).await,
        "query_entries" => query_entries(&app, decode(args)?).await,
        "create_entry" => create_entry(&app, decode(args)?).await,
        "update_entry_fields" => update_entry_fields(&app, decode(args)?).await,
        "update_entry_body" => update_entry_body(&app, decode(args)?).await,
        "delete_entry" => delete_entry(&app, decode(args)?).await,
        "rename_entry" => rename_entry(&app, decode(args)?).await,
        "move_entry" => move_entry(&app, decode(args)?).await,
        "unnest_entry" => unnest_entry(&app, decode(args)?).await,
        "convert_to_leaf" => convert_to_leaf(&app, decode(args)?).await,
        "validate_collection_integrity" => validate_collection_integrity(&app, decode(args)?).await,
        "add_collection_column" => add_collection_column(&app, decode(args)?).await,
        "update_collection_column" => update_collection_column(&app, decode(args)?).await,
        "delete_collection_column" => delete_collection_column(&app, decode(args)?).await,
        "add_collection_view" => add_collection_view(&app, decode(args)?).await,
        "update_collection_view" => update_collection_view(&app, decode(args)?).await,
        "delete_collection_view" => delete_collection_view(&app, decode(args)?).await,
        "list_actors" => list_actors(&app, decode(args)?).await,
        "get_git_status" => get_git_status(&app, decode(args)?).await,
        "get_svode_guide" => get_svode_guide().await,
        _ => Err(McpBusinessError::new(
            "UNKNOWN_TOOL",
            format!("unknown Svode MCP tool: {name}"),
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
    if let Ok(Some(context)) = MCP_CONTEXT_OVERRIDE.try_with(Clone::clone) {
        return Ok(context);
    }

    app.state::<ActiveProjectState>()
        .get()
        .ok_or_else(McpBusinessError::no_active_project)
}

fn resolve_context_override(
    app: &AppHandle,
    context_override: Option<&IpcContextOverride>,
) -> Result<Option<ActiveProjectContext>, McpBusinessError> {
    let Some(context_override) = context_override else {
        return Ok(None);
    };

    if let Some(project_path) = context_override
        .project_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(Some(root_context(Path::new(project_path))?));
    }

    let Some(caller_cwd) = context_override
        .caller_cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };

    let cwd = PathBuf::from(caller_cwd).canonicalize().map_err(|error| {
        McpBusinessError::new(
            "CALLER_CWD_NOT_ACCESSIBLE",
            format!("caller cwd '{caller_cwd}' is not accessible: {error}"),
        )
    })?;
    let config_dir = app.path().app_data_dir().ok();
    let root = match resolve_project_root_for_cwd(config_dir.as_deref(), &cwd) {
        Ok(root) => root,
        Err(error) if error.code == "PROJECT_CONTEXT_NOT_FOUND" => return Ok(None),
        Err(error) => return Err(error),
    };
    Ok(Some(root_context(&root)?))
}

fn root_context(project_path: &Path) -> Result<ActiveProjectContext, McpBusinessError> {
    let project = project_path.canonicalize().map_err(|error| {
        McpBusinessError::new(
            "PROJECT_PATH_NOT_ACCESSIBLE",
            format!(
                "project path '{}' is not accessible: {error}",
                project_path.display()
            ),
        )
    })?;
    active::build_context(
        project.to_string_lossy().to_string(),
        None,
        Some(project.to_string_lossy().to_string()),
    )
    .map_err(Into::into)
}

fn resolve_project_root_for_cwd(
    config_dir: Option<&Path>,
    cwd: &Path,
) -> Result<PathBuf, McpBusinessError> {
    if let Some(config_dir) = config_dir
        && let Some(root) = registry_project_root_for_cwd(config_dir, cwd)?
    {
        return Ok(root);
    }

    ancestor_svode_project_root(cwd).ok_or_else(|| {
        McpBusinessError::new(
            "PROJECT_CONTEXT_NOT_FOUND",
            format!(
                "could not resolve a Svode project root from caller cwd '{}'",
                cwd.display()
            ),
        )
    })
}

fn registry_project_root_for_cwd(
    config_dir: &Path,
    cwd: &Path,
) -> Result<Option<PathBuf>, McpBusinessError> {
    let registry = registry::read_registry(config_dir)?;
    let mut best: Option<PathBuf> = None;

    for entry in registry.spaces {
        let Ok(root) = PathBuf::from(entry.path).canonicalize() else {
            continue;
        };
        if !cwd.starts_with(&root) || space_config::read_space_config(&root).is_err() {
            continue;
        }
        let replace = best
            .as_ref()
            .is_none_or(|current| root.components().count() > current.components().count());
        if replace {
            best = Some(root);
        }
    }

    Ok(best)
}

fn ancestor_svode_project_root(cwd: &Path) -> Option<PathBuf> {
    let mut root = None;
    for candidate in cwd.ancestors() {
        if space_config::read_space_config(candidate).is_ok() {
            root = Some(candidate.to_path_buf());
        }
    }
    root
}

async fn resolve_space(
    app: &AppHandle,
    requested_space_id: Option<String>,
) -> Result<(ActiveProjectContext, String), McpBusinessError> {
    let context = active_context(app)?;
    if let Some(space_id) = requested_space_id {
        if is_mcp_root_space_id(&space_id) {
            return Ok((context.clone(), context.project_path.clone()));
        }
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

fn validate_regular_source_path(source_path: &str) -> Result<PathBuf, McpBusinessError> {
    let path = PathBuf::from(source_path);
    if !path.is_absolute() {
        return Err(McpBusinessError::new(
            "INVALID_SOURCE_PATH",
            "sourcePath must be an absolute path to a readable local regular file",
        ));
    }
    let metadata = fs::symlink_metadata(&path).map_err(|error| {
        McpBusinessError::new(
            "SOURCE_FILE_NOT_FOUND",
            format!("sourcePath could not be inspected: {error}"),
        )
    })?;
    if !metadata.file_type().is_file() {
        return Err(McpBusinessError::new(
            "SOURCE_NOT_REGULAR_FILE",
            "sourcePath must point to a regular file, not a directory or symbolic link",
        ));
    }
    Ok(path)
}

fn document_id_for_asset_scope(document_abs: &Path, pool_dir: &Path, fallback: &str) -> String {
    repo_relative_from_base(pool_dir, document_abs, RootMode::Reject)
        .unwrap_or_else(|_| fallback.to_string())
}

fn asset_reference_paths(
    document_abs: &Path,
    space_dir: &Path,
    asset_abs: &Path,
) -> (String, String) {
    (
        crate::files::backlinks::make_relative_link_between(document_abs, asset_abs),
        crate::files::backlinks::make_relative_path(space_dir, asset_abs),
    )
}

fn schema_path_rel(collection_path: &str) -> String {
    if collection_path.is_empty() {
        "schema.yaml".to_string()
    } else {
        format!("{collection_path}/schema.yaml")
    }
}

fn is_mcp_root_space_id(space_id: &str) -> bool {
    space_id == MCP_ROOT_SPACE_ID
}

fn active_mcp_space_id(context: &ActiveProjectContext) -> String {
    context
        .active_space_id
        .clone()
        .unwrap_or_else(|| MCP_ROOT_SPACE_ID.to_string())
}

fn mcp_spaces_payload(project_path: &Path) -> Result<Vec<Value>, McpBusinessError> {
    let cfg = space_config::read_space_config(project_path)?;
    let child_spaces = project::list_spaces(project_path)?;
    let mut spaces = Vec::with_capacity(child_spaces.len() + 1);
    spaces.push(json!({
        "id": MCP_ROOT_SPACE_ID,
        "name": cfg.name,
        "icon": cfg.icon,
        "description": cfg.description,
        "path": project_path.to_string_lossy().to_string(),
        "kind": "root",
        "isRoot": true,
        "spaceId": MCP_ROOT_SPACE_ID,
        "hasSpaces": !child_spaces.is_empty(),
        "status": "ready",
        "capabilities": mcp_space_capabilities("root"),
        "addressing": {
            "spaceId": MCP_ROOT_SPACE_ID,
            "nullBehavior": "active-default"
        }
    }));
    for space in child_spaces {
        spaces.push(json!({
            "id": space.id,
            "name": space.name,
            "icon": space.icon,
            "description": space.description,
            "path": space.path,
            "kind": "child",
            "isRoot": false,
            "spaceId": space.id,
            "hasSpaces": space.has_spaces,
            "lastOpened": space.last_opened,
            "status": space.status,
            "lfsState": space.lfs_state,
            "capabilities": mcp_space_capabilities("child"),
            "addressing": {
                "spaceId": space.id,
                "nullBehavior": "active-default"
            }
        }));
    }
    Ok(spaces)
}

fn mcp_space_capabilities(kind: &str) -> Value {
    json!({
        "kind": kind,
        "documents": true,
        "collections": true,
        "gitStatus": true,
        "commitChanges": false,
        "autocommit": false
    })
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
    let abs = Path::new(space).join(path);
    let raw = fs::read_to_string(&abs)?;
    let (mut meta, body) = match crate::files::frontmatter::parse_status(&raw) {
        crate::files::frontmatter::ParseStatus::Valid { meta, body } => (meta, body),
        crate::files::frontmatter::ParseStatus::Missing { body } => {
            let fallback = Path::new(path)
                .file_stem()
                .and_then(|stem| stem.to_str())
                .map(entry::title_from_stem)
                .unwrap_or_else(|| "Untitled".to_string());
            (
                entry::EntryMeta::synthesized(fallback, String::new(), String::new()),
                body,
            )
        }
        crate::files::frontmatter::ParseStatus::Malformed { message, .. } => {
            return Err(McpBusinessError::new(
                "MALFORMED_FRONTMATTER",
                format!("cannot update metadata while frontmatter is malformed: {message}"),
            ));
        }
    };
    if let Some(title) = title {
        let title = title.trim();
        if title.is_empty() {
            return Err(McpBusinessError::new(
                "INVALID_METADATA",
                "title must not be empty",
            ));
        }
        meta.title = title.to_string();
        meta.mark_title_present();
    }
    if let Some(icon) = icon {
        meta.icon = icon;
        if meta.icon.is_some() {
            meta.mark_icon_present();
        }
    }
    if let Some(description) = description {
        meta.description = description.and_then(|value| {
            let trimmed = value.trim().to_string();
            (!trimmed.is_empty()).then_some(trimmed)
        });
        if meta.description.is_some() {
            meta.mark_description_present();
        }
    }
    if let Some(cover) = cover {
        meta.cover = cover;
        if meta.cover.is_some() {
            meta.mark_cover_present();
        }
    }
    fs::write(abs, crate::files::frontmatter::serialize(&meta, &body))?;
    entry::read(space, path).map_err(Into::into)
}

async fn get_project_info(app: &AppHandle) -> Result<ToolCallResult, McpBusinessError> {
    let context = active_context(app)?;
    let project_path = Path::new(&context.project_path);
    let spaces = mcp_spaces_payload(project_path)?;
    let cfg = space_config::read_space_config(Path::new(&context.project_path))?;
    let structured = json!({
        "projectPath": context.project_path,
        "rootSpaceId": MCP_ROOT_SPACE_ID,
        "activeSpaceId": context.active_space_id,
        "activeMcpSpaceId": active_mcp_space_id(&context),
        "activeSpacePath": context.active_space_path,
        "projectName": cfg.name,
        "spaces": spaces,
        "spaceAddressing": {
            "root": MCP_ROOT_SPACE_ID,
            "null": "active/default space"
        },
        "capabilities": {
            "documents": true,
            "collections": true,
            "gitStatus": true,
            "commitChanges": false,
            "autocommit": false
        }
    });
    Ok(ToolCallResult::ok(
        "Active Svode project information.",
        structured,
    ))
}

async fn list_spaces(app: &AppHandle) -> Result<ToolCallResult, McpBusinessError> {
    let context = active_context(app)?;
    let spaces = mcp_spaces_payload(Path::new(&context.project_path))?;
    let structured = json!({
        "rootSpaceId": MCP_ROOT_SPACE_ID,
        "activeSpaceId": context.active_space_id,
        "activeMcpSpaceId": active_mcp_space_id(&context),
        "spaceAddressing": {
            "root": MCP_ROOT_SPACE_ID,
            "null": "active/default space"
        },
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
    let (context, space) = resolve_space(app, args.space_id.clone()).await?;
    let path = validate_document_path(&args.path)?;
    ensure_inside(Path::new(&space), &path)?;
    let mut entry = entry::read(&space, &path)?;
    apply_indexed_entry_dates(
        app,
        &context,
        args.space_id.as_deref(),
        &space,
        &path,
        &mut entry,
    )
    .await;
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
    let mut meta = entry::EntryMeta::new_persisted(title);
    meta.icon = args.icon;
    if meta.icon.is_some() {
        meta.mark_icon_present();
    }
    meta.description = args
        .description
        .and_then(|value| (!value.trim().is_empty()).then_some(value));
    if meta.description.is_some() {
        meta.mark_description_present();
    }
    meta.cover = args.cover;
    if meta.cover.is_some() {
        meta.mark_cover_present();
    }
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

async fn import_asset(
    app: &AppHandle,
    args: ImportAssetArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (context, space) = resolve_space(app, args.space_id.clone()).await?;
    let document_path = validate_document_path(&args.document_path)?;
    let document_abs = ensure_inside(Path::new(&space), &document_path)?;
    let document_metadata = fs::metadata(&document_abs).map_err(|error| {
        McpBusinessError::new(
            "DOCUMENT_NOT_FOUND",
            format!("documentPath must be an existing markdown document: {error}"),
        )
    })?;
    if !document_metadata.is_file() {
        return Err(McpBusinessError::new(
            "INVALID_DOCUMENT_PATH",
            "documentPath must reference an existing markdown file, including a collection README.md when applicable",
        ));
    }

    let source_path = validate_regular_source_path(&args.source_path)?;
    let file_name = args.file_name.unwrap_or_else(|| {
        source_path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "file".to_string())
    });

    let index_state = app.state::<IndexState>();
    let requested_key = index_key_for_context(&context, args.space_id.as_deref());
    let scope = resolve_effective_storage_scope_for_key(
        &index_state,
        Path::new(&context.project_path),
        requested_key,
    )
    .await?;
    let pool = index_state.get_or_create(&scope.pool_key).await?;
    let scoped_document_id =
        document_id_for_asset_scope(&document_abs, &scope.pool_dir, &document_path);
    let asset = assets::import_file(
        &pool,
        &scope.pool_dir,
        &source_path,
        &file_name,
        Some(&scoped_document_id),
    )
    .await?;

    let asset_abs = scope.pool_dir.join(&asset.rel_path);
    let (markdown_url, cover_path) =
        asset_reference_paths(&document_abs, Path::new(&space), &asset_abs);
    let owner_space_id = IndexState::space_id_for_key(&scope.pool_key)
        .unwrap_or_else(|| MCP_ROOT_SPACE_ID.to_string());

    Ok(ToolCallResult::ok(
        format!(
            "Imported asset {} for document {document_path}.",
            asset.file_name
        ),
        json!({
            "spaceId": owner_space_id,
            "assetPath": asset.rel_path,
            "markdownUrl": markdown_url,
            "coverPath": cover_path,
            "fileName": asset.file_name,
            "mime": asset.mime,
            "sizeBytes": asset.size_bytes,
            "changedPaths": [asset.rel_path],
        }),
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
    let mut meta = entry::EntryMeta::new_persisted(if args.title.trim().is_empty() {
        fallback_collection_title(&collection_path)
    } else {
        args.title
    });
    meta.icon = args.icon;
    if meta.icon.is_some() {
        meta.mark_icon_present();
    }
    meta.description = args
        .description
        .and_then(|value| (!value.trim().is_empty()).then_some(value));
    if meta.description.is_some() {
        meta.mark_description_present();
    }
    meta.cover = args.cover;
    if meta.cover.is_some() {
        meta.mark_cover_present();
    }
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
            collection_path =
                entry::convert_entry_to_nested_collection(Path::new(&space), &readme_rel)?;
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
        let folder_entry = entry::convert_entry_to_folder(Path::new(&space), &path, None)?;
        let converted_collection_path = Path::new(&folder_entry.path)
            .parent()
            .map(|parent| parent.to_string_lossy().replace('\\', "/"))
            .ok_or_else(|| {
                McpBusinessError::new("INVALID_PATH", "converted entry has no folder path")
            })?;
        entry::convert_entry_to_nested_collection(Path::new(&space), &folder_entry.path)?;
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

async fn create_entry(
    app: &AppHandle,
    args: CreateEntryArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (context, space) = resolve_space(app, args.space_id).await?;
    let collection_path = validate_public_rel_path(&args.collection_path, true)?;
    ensure_inside(Path::new(&space), &collection_path)?;
    let fields = args.fields;
    let parent = if collection_path.is_empty() {
        None
    } else {
        Some(collection_path.as_str())
    };
    let mut created = entry::create_with_contextual_defaults(&space, parent, &args.title, None)?;
    if let Some(fields) = fields {
        for (field, value) in fields {
            created = entry::update_field(
                &space,
                Some(context.project_path.as_str()),
                &created.path,
                &field,
                value,
            )?;
        }
    }
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
    let (context, space) = resolve_space(app, args.space_id).await?;
    let path = validate_document_path(&args.path)?;
    ensure_inside(Path::new(&space), &path)?;
    let mut updated = None;
    for (field, value) in args.fields {
        updated = Some(entry::update_field(
            &space,
            Some(context.project_path.as_str()),
            &path,
            &field,
            value,
        )?);
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
    let result = entry::write(
        &space, &path, &args.body, None, None, None, None, None, true,
    )?;
    Ok(ToolCallResult::ok(
        format!("Updated body for {path}."),
        json!({ "path": path, "newPath": result.new_path, "changedPaths": [path] }),
    ))
}

async fn delete_entry(app: &AppHandle, args: PathArgs) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (context, space) = resolve_space(app, args.space_id).await?;
    let path = validate_document_path(&args.path)?;
    ensure_inside(Path::new(&space), &path)?;
    let index_state = app.state::<IndexState>();
    let deleted = files_commands::delete_entry_shared(
        &space,
        &path,
        Some(context.project_path.as_str()),
        &index_state,
        None,
    )
    .await?;
    Ok(ToolCallResult::ok(
        format!("Deleted entry {path}."),
        json!({
            "deletedRoot": deleted.deleted_root,
            "deletedPaths": deleted.deleted_paths,
            "cascadeTouched": deleted.cascade_touched,
            "changedPaths": deleted.changed_paths
        }),
    ))
}

async fn rename_entry(
    app: &AppHandle,
    args: RenameEntryArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (context, space) = resolve_space(app, args.space_id.clone()).await?;
    let from = validate_public_rel_path(&args.from, false)?;
    let to = validate_public_rel_path(&args.to, false)?;
    ensure_inside(Path::new(&space), &from)?;
    ensure_inside(Path::new(&space), &to)?;
    let before = snapshot_structural_paths(Path::new(&space))?;
    let before_project = snapshot_structural_paths(Path::new(&context.project_path))?;
    let index_state = app.state::<IndexState>();
    files_commands::rename_entry_shared(
        &space,
        &from,
        &to,
        Some(context.project_path.as_str()),
        &index_state,
        None,
    )
    .await?;
    let changed_paths = changed_structural_paths(before, Path::new(&space))?;
    let affected_project_paths =
        changed_structural_paths(before_project, Path::new(&context.project_path))?;
    Ok(structural_operation_result(
        "Renamed entry",
        &from,
        &to,
        changed_paths,
        affected_project_paths,
    ))
}

async fn move_entry(
    app: &AppHandle,
    args: MoveEntryArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (context, space) = resolve_space(app, args.space_id.clone()).await?;
    let from = validate_public_rel_path(&args.from, false)?;
    let to_parent = validate_public_rel_path(&args.to_parent, true)?;
    ensure_inside(Path::new(&space), &from)?;
    ensure_inside(Path::new(&space), &to_parent)?;
    let before = snapshot_structural_paths(Path::new(&space))?;
    let before_project = snapshot_structural_paths(Path::new(&context.project_path))?;
    let index_state = app.state::<IndexState>();
    let new_path = files_commands::move_entry_shared(
        &space,
        &from,
        &to_parent,
        Some(context.project_path.as_str()),
        &index_state,
        None,
    )
    .await?;
    let changed_paths = changed_structural_paths(before, Path::new(&space))?;
    let affected_project_paths =
        changed_structural_paths(before_project, Path::new(&context.project_path))?;
    Ok(structural_operation_result(
        "Moved entry",
        &from,
        &new_path,
        changed_paths,
        affected_project_paths,
    ))
}

async fn unnest_entry(app: &AppHandle, args: PathArgs) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (context, space) = resolve_space(app, args.space_id.clone()).await?;
    let path = validate_document_path(&args.path)?;
    ensure_inside(Path::new(&space), &path)?;
    let before = snapshot_structural_paths(Path::new(&space))?;
    let before_project = snapshot_structural_paths(Path::new(&context.project_path))?;
    let index_state = app.state::<IndexState>();
    let new_path = files_commands::unnest_entry_shared(
        &space,
        &path,
        Some(context.project_path.as_str()),
        &index_state,
        None,
    )
    .await?;
    let changed_paths = changed_structural_paths(before, Path::new(&space))?;
    let affected_project_paths =
        changed_structural_paths(before_project, Path::new(&context.project_path))?;
    Ok(structural_operation_result(
        "Unnested entry",
        &path,
        &new_path,
        changed_paths,
        affected_project_paths,
    ))
}

async fn convert_to_leaf(
    app: &AppHandle,
    args: PathArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (context, space) = resolve_space(app, args.space_id.clone()).await?;
    let path = validate_document_path(&args.path)?;
    ensure_inside(Path::new(&space), &path)?;
    let before = snapshot_structural_paths(Path::new(&space))?;
    let before_project = snapshot_structural_paths(Path::new(&context.project_path))?;
    let index_state = app.state::<IndexState>();
    let entry = files_commands::convert_entry_to_leaf_shared(
        &space,
        &path,
        Some(context.project_path.as_str()),
        &index_state,
        None,
    )
    .await?;
    let changed_paths = changed_structural_paths(before, Path::new(&space))?;
    let affected_project_paths =
        changed_structural_paths(before_project, Path::new(&context.project_path))?;
    let mut result = structural_operation_result(
        "Converted folder document to leaf",
        &path,
        &entry.path,
        changed_paths,
        affected_project_paths,
    );
    if let Some(structured_content) = result.structured_content.as_mut() {
        structured_content["entry"] = json!(entry);
    }
    Ok(result)
}

async fn validate_collection_integrity(
    app: &AppHandle,
    args: IntegrityArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let (context, space) = resolve_space(app, args.space_id).await?;
    let collection_path = args
        .collection_path
        .as_deref()
        .map(|path| validate_public_rel_path(path, true))
        .transpose()?;
    if let Some(path) = collection_path.as_deref() {
        ensure_inside(Path::new(&space), path)?;
    }
    let report = properties::validate_collection_integrity_with_project(
        &space,
        collection_path.as_deref(),
        Some(context.project_path.as_str()),
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

fn structural_operation_result(
    action: &str,
    old_path: &str,
    new_path: &str,
    changed_paths: Vec<String>,
    affected_project_paths: Vec<String>,
) -> ToolCallResult {
    let order_paths = affected_project_paths
        .iter()
        .filter(|path| path.as_str() == ".svode/order.json")
        .cloned()
        .collect::<Vec<_>>();
    let markdown_paths = affected_project_paths
        .iter()
        .filter(|path| path.ends_with(".md"))
        .cloned()
        .collect::<Vec<_>>();
    let relation_paths = affected_project_paths
        .iter()
        .filter(|path| path.ends_with(".md") || path.ends_with("schema.yaml"))
        .cloned()
        .collect::<Vec<_>>();
    ToolCallResult::ok(
        format!("{action}: {old_path} → {new_path}."),
        json!({
            "oldPath": old_path,
            "newPath": new_path,
            "changedPaths": changed_paths,
            "affectedProjectPaths": affected_project_paths,
            "touchedPaths": {
                "backlinks": markdown_paths,
                "relations": relation_paths,
                "order": order_paths,
                "index": [old_path, new_path],
            },
        }),
    )
}

fn snapshot_structural_paths(root: &Path) -> Result<HashMap<String, u64>, McpBusinessError> {
    let mut snapshot = HashMap::new();
    snapshot_structural_paths_inner(root, root, &mut snapshot)?;
    Ok(snapshot)
}

fn snapshot_structural_paths_inner(
    root: &Path,
    directory: &Path,
    snapshot: &mut HashMap<String, u64>,
) -> Result<(), McpBusinessError> {
    for item in fs::read_dir(directory)? {
        let item = item?;
        let path = item.path();
        let file_name = item.file_name();
        let file_name = file_name.to_string_lossy();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            if file_name == ".git" || file_name == "node_modules" {
                continue;
            }
            snapshot_structural_paths_inner(root, &path, snapshot)?;
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        let is_relevant = path.extension().is_some_and(|extension| extension == "md")
            || file_name == "schema.yaml"
            || (file_name == "order.json"
                && path
                    .parent()
                    .is_some_and(|parent| parent.file_name().is_some_and(|name| name == ".svode")));
        if !is_relevant {
            continue;
        }
        let content = fs::read(&path)?;
        let hash = content.iter().fold(0xcbf29ce484222325_u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        });
        let root_string = root.to_string_lossy();
        let rel = rel_path_from_space(root_string.as_ref(), &path);
        snapshot.insert(rel, hash);
    }
    Ok(())
}

fn changed_structural_paths(
    before: HashMap<String, u64>,
    root: &Path,
) -> Result<Vec<String>, McpBusinessError> {
    let after = snapshot_structural_paths(root)?;
    let mut paths = before
        .keys()
        .chain(after.keys())
        .filter(|path| before.get(*path) != after.get(*path))
        .cloned()
        .collect::<Vec<_>>();
    paths.sort();
    paths.dedup();
    Ok(paths)
}

async fn add_collection_column(
    app: &AppHandle,
    args: AddCollectionColumnArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (context, space) = resolve_space(app, args.space_id).await?;
    let collection_path = validate_public_rel_path(&args.collection_path, true)?;
    ensure_inside(Path::new(&space), &collection_path)?;
    let include_markdown = args.column.type_ == PropertyType::UniqueId;
    let paths = properties::schema_column_mutation_paths_with_project(
        &space,
        &collection_path,
        &args.column,
        include_markdown,
        Some(context.project_path.as_str()),
    )?;
    let schema = properties::add_schema_column_with_project(
        &space,
        &collection_path,
        args.column,
        Some(context.project_path.as_str()),
    )?;
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
    let (context, space) = resolve_space(app, args.space_id).await?;
    let collection_path = validate_public_rel_path(&args.collection_path, true)?;
    ensure_inside(Path::new(&space), &collection_path)?;
    let paths = properties::schema_column_name_mutation_paths_with_project(
        &space,
        &collection_path,
        &args.column_name,
        true,
        Some(context.project_path.as_str()),
    )?;
    let schema = properties::update_schema_column_with_project(
        &space,
        &collection_path,
        &args.column_name,
        json_to_yaml(args.patch)?,
        Some(context.project_path.as_str()),
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
    let (context, space) = resolve_space(app, args.space_id).await?;
    let collection_path = validate_public_rel_path(&args.collection_path, true)?;
    ensure_inside(Path::new(&space), &collection_path)?;
    let delete_values = args.delete_values.unwrap_or(false);
    let paths = properties::schema_mutation_paths(&space, &collection_path, delete_values)?;
    let schema = properties::delete_schema_column_with_project(
        &space,
        &collection_path,
        &args.column_name,
        delete_values,
        Some(context.project_path.as_str()),
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

async fn get_svode_guide() -> Result<ToolCallResult, McpBusinessError> {
    Ok(ToolCallResult::ok(
        "Svode MCP guide.",
        json!({ "guide": super::tools::guide_text() }),
    ))
}

async fn list_actors(
    app: &AppHandle,
    args: ListActorsArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let (_, space) = resolve_space(app, args.space_id).await?;
    let git_state = app.state::<GitState>();
    let cli = git::commands::require_cli(&git_state)?;
    let actor_catalog = app.state::<properties::ActorCatalogState>();
    let actors = properties::list_actors(
        &actor_catalog,
        &cli,
        Path::new(&space),
        args.all_time.unwrap_or(false),
    )
    .await?;
    Ok(ToolCallResult::ok(
        format!("Found {} actors.", actors.len()),
        json!({ "actors": actors }),
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
        "Git status for active Svode space.",
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

async fn apply_indexed_entry_dates(
    app: &AppHandle,
    context: &ActiveProjectContext,
    space_id: Option<&str>,
    space: &str,
    path: &str,
    entry: &mut entry::Entry,
) {
    let Ok(normalized) = normalize_repo_relative(path, RootMode::Reject) else {
        return;
    };
    let Ok(pool) = pool_for_space(app, context, space_id, space).await else {
        return;
    };
    let Ok(Some((created, updated))) = sqlx::query_as::<_, (String, String)>(
        "SELECT created, updated FROM entries WHERE file_path = ?",
    )
    .bind(normalized)
    .fetch_optional(&pool)
    .await
    else {
        return;
    };
    entry.meta.created = created;
    entry.meta.updated = updated;
}

fn index_key_for_context(context: &ActiveProjectContext, space_id: Option<&str>) -> IndexKey {
    if let Some(space_id) = space_id {
        if is_mcp_root_space_id(space_id) {
            return IndexKey::Root(PathBuf::from(&context.project_path));
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn scaffold_test_space(path: &Path, name: &str) {
        crate::space::scaffold::scaffold_space(path, name, "", "").expect("scaffold space");
    }

    fn context(active_space_id: Option<&str>) -> ActiveProjectContext {
        ActiveProjectContext {
            project_path: "/project".to_string(),
            active_space_id: active_space_id.map(ToString::to_string),
            active_space_path: active_space_id
                .map(|id| format!("/project/spaces/{id}"))
                .unwrap_or_else(|| "/project".to_string()),
        }
    }

    #[test]
    fn root_space_id_targets_root_even_when_child_space_is_active() {
        assert_eq!(
            index_key_for_context(&context(Some("child")), Some(MCP_ROOT_SPACE_ID)),
            IndexKey::Root(PathBuf::from("/project"))
        );
    }

    #[test]
    fn null_space_id_still_targets_active_default_space() {
        assert_eq!(
            index_key_for_context(&context(Some("child")), None),
            IndexKey::Space {
                project: PathBuf::from("/project"),
                space_id: "child".to_string()
            }
        );
        assert_eq!(
            index_key_for_context(&context(None), None),
            IndexKey::Root(PathBuf::from("/project"))
        );
    }

    #[test]
    fn create_collection_rejects_removed_document_label_argument() {
        let args = json!({
            "path": "tasks",
            "title": "Tasks",
            "documentLabel": "Documents"
        });
        assert!(decode::<CreateCollectionArgs>(args).is_err());
    }

    #[test]
    fn import_asset_paths_follow_document_and_cover_semantics() {
        let (root_markdown, root_cover) = asset_reference_paths(
            Path::new("/project/note.md"),
            Path::new("/project"),
            Path::new("/project/.assets/cover.png"),
        );
        assert_eq!(root_markdown, ".assets/cover.png");
        assert_eq!(root_cover, ".assets/cover.png");

        let (inline_markdown, inline_cover) = asset_reference_paths(
            Path::new("/project/inline/docs/note.md"),
            Path::new("/project/inline"),
            Path::new("/project/.assets/cover.png"),
        );
        assert_eq!(inline_markdown, "../../.assets/cover.png");
        assert_eq!(inline_cover, "../.assets/cover.png");
    }

    #[test]
    fn import_asset_requires_an_absolute_regular_file_source() {
        assert!(validate_regular_source_path("relative.png").is_err());

        let temp = tempfile::tempdir().expect("temp dir");
        assert!(validate_regular_source_path(temp.path().to_string_lossy().as_ref()).is_err());
    }

    #[test]
    fn registry_context_resolution_uses_registered_root_for_child_space_cwd() {
        let temp = tempfile::tempdir().expect("temp dir");
        let config_dir = temp.path().join("app-data");
        let project = temp.path().join("project");
        let child = project.join("child");
        let nested = child.join("nested");
        std::fs::create_dir_all(&nested).expect("nested dir");
        scaffold_test_space(&project, "Project");
        scaffold_test_space(&child, "Child");
        registry::add_space(&config_dir, "project", &project.to_string_lossy())
            .expect("register project");

        let root =
            resolve_project_root_for_cwd(Some(&config_dir), &nested).expect("resolve project root");

        assert_eq!(
            root.canonicalize().expect("root canonical"),
            project.canonicalize().expect("project canonical")
        );
    }

    #[test]
    fn ancestor_context_resolution_uses_highest_svode_space_without_registry() {
        let temp = tempfile::tempdir().expect("temp dir");
        let project = temp.path().join("project");
        let child = project.join("child");
        let nested = child.join("nested");
        std::fs::create_dir_all(&nested).expect("nested dir");
        scaffold_test_space(&project, "Project");
        scaffold_test_space(&child, "Child");

        let root = resolve_project_root_for_cwd(None, &nested).expect("resolve project root");

        assert_eq!(root, project);
    }
}

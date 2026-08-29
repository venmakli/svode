use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use super::active::{self, ActiveProjectContext, ActiveProjectState};
use super::error::McpBusinessError;
use super::path::{
    ensure_inside, normalize_create_page_path, validate_markdown_path, validate_public_rel_path,
};
use super::protocol::{IpcContextOverride, ToolCallResult};
use crate::artifact::identity::{
    ContentOwnerKind, MarkdownIdentityFacts, PageRole, SemanticIdentity, SourceShape,
    resolve_markdown_identity,
};
use crate::commands::files as files_commands;
use crate::files::{entry, tree};
use crate::git::access::{ensure_mutation_paths_were_authorized, repository_access_snapshot};
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

tokio::task_local! {
    static MCP_ROUTINE_CALLER: Option<crate::terminal::RoutineMcpCallerProvenance>;
}

mod collections;
mod context;
mod dispatch;
mod documents;
mod knowledge;
#[path = "service/project.rs"]
mod project_tools;
mod routines;

#[cfg(test)]
use context::resolve_project_root_for_cwd;
use context::{active_context, resolve_space};
#[cfg(test)]
use dispatch::decode;
pub use dispatch::{call_tool, call_tool_with_context};

pub(crate) fn routine_caller_provenance() -> Option<crate::terminal::RoutineMcpCallerProvenance> {
    MCP_ROUTINE_CALLER.try_with(Clone::clone).ok().flatten()
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
struct RenameContentArgs {
    #[serde(default)]
    space_id: Option<String>,
    from: String,
    to: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoveContentArgs {
    #[serde(default)]
    space_id: Option<String>,
    from: String,
    to_parent: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReorderContentArgs {
    #[serde(default)]
    space_id: Option<String>,
    parent_path: String,
    ordered_children: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReorderSpacesArgs {
    ordered_space_ids: Vec<String>,
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
struct ListPagesArgs {
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
struct WritePageArgs {
    #[serde(default)]
    space_id: Option<String>,
    path: String,
    content: String,
    #[serde(default)]
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreatePageArgs {
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
struct UpdatePageMetadataArgs {
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
struct WriteSpaceReadmeArgs {
    #[serde(default)]
    space_id: Option<String>,
    content: String,
    #[serde(default)]
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateSpaceMetadataArgs {
    #[serde(default)]
    space_id: Option<String>,
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
struct WriteCollectionReadmeArgs {
    #[serde(default)]
    space_id: Option<String>,
    collection_path: String,
    content: String,
    #[serde(default)]
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCollectionMetadataArgs {
    #[serde(default)]
    space_id: Option<String>,
    collection_path: String,
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
    content_path: String,
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
struct QueryCollectionItemsArgs {
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
struct CreateCollectionItemArgs {
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
struct UpdateCollectionItemFieldsArgs {
    #[serde(default)]
    space_id: Option<String>,
    path: String,
    fields: HashMap<String, Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCollectionItemBodyArgs {
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

fn json_to_yaml(value: Value) -> Result<serde_yml::Value, McpBusinessError> {
    serde_yml::to_value(value)
        .map_err(|error| McpBusinessError::new("INVALID_YAML_VALUE", error.to_string()))
}

fn clamp_limit(limit: Option<i64>) -> i64 {
    limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)
}

fn offset(offset: Option<i64>) -> usize {
    offset.unwrap_or(0).max(0) as usize
}

fn semantic_identity_for_path(
    space: &str,
    path: &str,
) -> Result<SemanticIdentity, McpBusinessError> {
    let direct_collection_root = Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| name.eq_ignore_ascii_case("README.md"))
        .and_then(|_| Path::new(path).parent())
        .filter(|parent| Path::new(space).join(parent).join("schema.yaml").is_file())
        .map(|parent| {
            if parent.as_os_str().is_empty() {
                ".".to_string()
            } else {
                parent.to_string_lossy().replace('\\', "/")
            }
        });
    let collection_root = match direct_collection_root {
        Some(root) => Some(root),
        None => properties::resolve_collection_schema_result(space, path)?
            .map(|(_, root)| root.to_string_lossy().replace('\\', "/")),
    };
    let source_shape = if Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("README.md"))
    {
        SourceShape::Directory
    } else {
        SourceShape::File
    };
    Ok(resolve_markdown_identity(MarkdownIdentityFacts {
        path,
        source_shape,
        collection_root: collection_root.as_deref(),
        agent_context: crate::index::knowledge::is_agent_context_source(path),
    }))
}

fn require_standalone_page(space: &str, path: &str) -> Result<(), McpBusinessError> {
    let identity = semantic_identity_for_path(space, path)?;
    if identity.is_page() && identity.page_role == Some(PageRole::Standalone) {
        return Ok(());
    }
    Err(McpBusinessError::new(
        "NOT_A_STANDALONE_PAGE",
        "path belongs to owner content or a Collection item; use its canonical owner-specific tool",
    ))
}

fn require_collection_item(space: &str, path: &str) -> Result<(), McpBusinessError> {
    if semantic_identity_for_path(space, path)?.is_collection_item() {
        return Ok(());
    }
    Err(McpBusinessError::new(
        "NOT_A_COLLECTION_ITEM",
        "path is not an item inside a schema-backed Collection",
    ))
}

fn require_owner(
    space: &str,
    path: &str,
    expected: ContentOwnerKind,
) -> Result<(), McpBusinessError> {
    if semantic_identity_for_path(space, path)?.owner_kind == Some(expected) {
        return Ok(());
    }
    Err(McpBusinessError::new(
        "CONTENT_OWNER_MISMATCH",
        "path does not belong to the requested content owner",
    ))
}

fn collection_readme_path(collection_path: &str) -> String {
    if collection_path.is_empty() || collection_path == "." {
        "README.md".to_string()
    } else {
        format!("{}/README.md", collection_path.trim_end_matches('/'))
    }
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

fn content_id_for_asset_scope(content_abs: &Path, pool_dir: &Path, fallback: &str) -> String {
    repo_relative_from_base(pool_dir, content_abs, RootMode::Reject)
        .unwrap_or_else(|_| fallback.to_string())
}

fn asset_reference_paths(
    content_abs: &Path,
    space_dir: &Path,
    asset_abs: &Path,
) -> (String, String) {
    (
        crate::files::backlinks::make_relative_link_between(content_abs, asset_abs),
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

async fn mcp_spaces_payload(
    app: &AppHandle,
    project_path: &Path,
) -> Result<Vec<Value>, McpBusinessError> {
    let cfg = space_config::read_space_config(project_path)?;
    let child_spaces = project::list_spaces(project_path)?;
    let mut spaces = Vec::with_capacity(child_spaces.len() + 1);
    let (root_access, root_access_diagnostic) = mcp_repository_access(app, project_path).await;
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
        "repositoryAccess": root_access,
        "repositoryAccessDiagnostic": root_access_diagnostic,
        "capabilities": mcp_space_capabilities("root"),
        "addressing": {
            "spaceId": MCP_ROOT_SPACE_ID,
            "nullBehavior": "active-default"
        }
    }));
    for space in child_spaces {
        let (repository_access, repository_access_diagnostic) =
            mcp_repository_access(app, Path::new(&space.path)).await;
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
            "repositoryAccess": repository_access,
            "repositoryAccessDiagnostic": repository_access_diagnostic,
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

async fn mcp_repository_access(
    app: &AppHandle,
    path: &Path,
) -> (
    Option<git::access::RepositoryAccessSnapshot>,
    Option<McpBusinessError>,
) {
    match repository_access_snapshot(app, path).await {
        Ok(snapshot) => (Some(snapshot), None),
        Err(error) => (None, Some(error.into())),
    }
}

fn mcp_space_capabilities(kind: &str) -> Value {
    json!({
        "kind": kind,
        "pages": true,
        "collections": true,
        "gitStatus": true,
        "commitChanges": false,
        "autocommit": false
    })
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
) -> Result<entry::Entry, crate::error::AppError> {
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
            return Err(crate::error::AppError::FrontmatterParse(format!(
                "cannot update metadata while frontmatter is malformed: {message}"
            )));
        }
    };
    let title_requested = title.is_some();
    if let Some(title) = title {
        if title.trim().is_empty() {
            return Err(crate::error::AppError::General(
                "title must not be empty".to_string(),
            ));
        }
        meta.title = title;
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
    if title_requested {
        crate::files::naming::ensure_document_name_available(Path::new(space), path, &meta.title)?;
    }
    fs::write(abs, crate::files::frontmatter::serialize(&meta, &body))?;
    entry::read(space, path)
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
    fn semantic_identity_distinguishes_collection_owner_readme_from_item_page() {
        let temp = tempfile::tempdir().expect("temp dir");
        let collection = temp.path().join("tasks");
        std::fs::create_dir_all(&collection).expect("collection dir");
        std::fs::write(collection.join("schema.yaml"), "columns: []\nviews: []\n").expect("schema");

        let owner =
            semantic_identity_for_path(temp.path().to_string_lossy().as_ref(), "tasks/README.md")
                .expect("owner identity");
        let item =
            semantic_identity_for_path(temp.path().to_string_lossy().as_ref(), "tasks/item.md")
                .expect("item identity");

        assert_eq!(owner.owner_kind, Some(ContentOwnerKind::Collection));
        assert!(!owner.is_page());
        assert_eq!(item.page_role, Some(PageRole::CollectionItem));
        assert!(item.is_page());
    }

    #[test]
    fn collection_conversion_maps_validation_errors_to_stable_code() {
        let error = collections::collection_conversion_error(crate::AppError::General(
            "document is already a collection".to_string(),
        ));

        assert_eq!(error.code, "INVALID_COLLECTION_CONVERSION");
        assert_eq!(error.message, "Page is already a collection");
    }

    #[test]
    fn import_asset_paths_follow_content_and_cover_semantics() {
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

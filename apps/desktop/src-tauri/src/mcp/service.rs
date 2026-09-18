use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Deserializer};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use super::active::{self, ActiveProjectContext, ActiveProjectState};
use super::error::McpBusinessError;
use super::path::{ensure_inside, validate_markdown_path, validate_public_rel_path};
use super::protocol::{IpcContextOverride, ToolCallResult};
use crate::artifact::identity::{
    ContentOwnerKind, PageRole, SemanticIdentity, resolve_markdown_identity_for_path,
};
use crate::commands::files as files_commands;
use crate::files::{entry, tree};
use crate::git::access::repository_access_snapshot;
use crate::git::{self, GitState};
use crate::index::update::IndexUpdateState;
use crate::index::{IndexKey, IndexState};
use crate::properties::{self, CollectionSchema, Column, Filter, Sort, View};
use crate::repo_path::{RootMode, normalize_repo_relative};
use crate::space::{config as space_config, project, registry};

const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 200;
const MCP_ROOT_SPACE_ID: &str = "root";

tokio::task_local! {
    static MCP_CONTEXT_OVERRIDE: Option<ActiveProjectContext>;
}

tokio::task_local! {
    static MCP_ROUTINE_CALLER: Option<crate::terminal::RoutineMcpCallerProvenance>;
}

mod apps;
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
pub enum CommitPolicy {
    NoAutocommit,
}

#[derive(Debug, Clone, Copy)]
struct McpMutationPolicy {
    _origin: crate::attachments::managed_import::MutationOrigin,
    _commit_policy: CommitPolicy,
}

const MCP_MUTATION_POLICY: McpMutationPolicy = McpMutationPolicy {
    _origin: crate::attachments::managed_import::MutationOrigin::Mcp,
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
struct ValidateAppManifestArgs {
    yaml: String,
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
#[serde(deny_unknown_fields)]
struct CreatePageArgs {
    #[serde(default)]
    space_id: Option<String>,
    parent_path: String,
    title: String,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    icon: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    cover: Option<entry::Cover>,
    #[serde(default)]
    properties: Option<HashMap<String, Value>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdatePageMetadataArgs {
    #[serde(default)]
    space_id: Option<String>,
    path: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default, deserialize_with = "deserialize_present")]
    icon: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_present")]
    description: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_present")]
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
    #[serde(default, deserialize_with = "deserialize_present")]
    icon: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_present")]
    description: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_present")]
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
    #[serde(default, deserialize_with = "deserialize_present")]
    icon: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_present")]
    description: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_present")]
    cover: Option<Option<entry::Cover>>,
}

fn deserialize_present<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
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
    fields: std::collections::BTreeMap<String, Value>,
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
    resolve_markdown_identity_for_path(
        Path::new(space),
        path,
        crate::index::knowledge::is_agent_context_source(path),
    )
    .map_err(Into::into)
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
    crate::index::page_dates::apply_indexed_dates(&pool, &normalized, entry).await;
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

    #[tokio::test]
    async fn body_write_json_intent_and_canonical_result_use_shared_operation() {
        for title in [None, Some(Value::Null), Some(json!("New"))] {
            for path in ["Old.md", "README.md", "Old/README.md", "Tasks/item.md"] {
                let temp = tempfile::tempdir().unwrap();
                let root = temp.path();
                fs::create_dir_all(root.join(".git")).unwrap();
                fs::create_dir_all(root.join(path).parent().unwrap()).unwrap();
                fs::write(root.join(path), "---\ntitle: Old\n---\nOriginal").unwrap();
                if path.starts_with("Tasks/") {
                    fs::write(root.join("Tasks/schema.yaml"), "columns: []\n").unwrap();
                }
                let mut json_args = json!({"path": path, "content": "New body"});
                if let Some(value) = &title {
                    json_args["title"] = value.clone();
                }
                let args: WritePageArgs = decode(json_args.clone()).unwrap();
                let space_args: WriteSpaceReadmeArgs = decode(json_args.clone()).unwrap();
                json_args["collectionPath"] = json!("Old");
                let collection_args: WriteCollectionReadmeArgs = decode(json_args).unwrap();
                assert_eq!(args.title, space_args.title);
                assert_eq!(args.title, collection_args.title);
                let state = IndexState::new();
                let nonces = crate::files::WriteNonceRegistry::new();
                let outcome = crate::page::write::write(
                    crate::page::write::PageWrite {
                        space: root.to_str().unwrap(),
                        path,
                        content: &args.content,
                        title: args.title.as_deref(),
                        icon: None,
                        extra: None,
                        metadata: None,
                        field_batch: None,
                        skip_rename: args.title.is_none(),
                        project: None,
                    },
                    &state,
                    crate::index::update::test_update_state(),
                    &nonces,
                    None,
                    |mut paths| async move {
                        paths.push(root.to_path_buf());
                        Ok(paths)
                    },
                )
                .await
                .unwrap();
                let response = page_write_response(root.to_str().unwrap(), path, outcome);
                let expected = if args.title.is_none() || path == "README.md" {
                    path
                } else if path == "Old/README.md" {
                    "New/README.md"
                } else if path == "Tasks/item.md" {
                    "Tasks/New.md"
                } else {
                    "New.md"
                };
                assert_eq!(response["path"], expected);
                assert!(
                    response["changedPaths"]
                        .as_array()
                        .unwrap()
                        .contains(&json!(path))
                );
                assert!(
                    response["changedPaths"]
                        .as_array()
                        .unwrap()
                        .contains(&json!(expected))
                );
                assert_eq!(
                    entry::read(root.to_str().unwrap(), expected).unwrap().body,
                    "New body"
                );
                if expected != path {
                    assert_eq!(response["newPath"], expected);
                } else {
                    assert_eq!(response["newPath"], Value::Null);
                }
            }
        }
    }

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
    fn create_page_requires_parent_and_title_and_rejects_legacy_inputs() {
        let args: CreatePageArgs = decode(json!({
            "parentPath": "tasks",
            "title": "First",
            "content": "Body",
            "properties": { "Status": "Todo" }
        }))
        .unwrap();
        assert_eq!(args.parent_path, "tasks");
        assert_eq!(args.title, "First");
        assert!(decode::<CreatePageArgs>(json!({ "path": "tasks/first.md" })).is_err());
        assert!(
            decode::<CreatePageArgs>(json!({
                "parentPath": "tasks",
                "title": "First",
                "fields": { "Status": "Todo" }
            }))
            .is_err()
        );
    }

    #[test]
    fn metadata_decode_preserves_missing_null_and_value() {
        let missing: UpdatePageMetadataArgs = decode(json!({ "path": "Page.md" })).unwrap();
        let nulls: UpdatePageMetadataArgs = decode(json!({
            "path": "Page.md",
            "title": null,
            "icon": null,
            "description": null,
            "cover": null
        }))
        .unwrap();
        let values: UpdatePageMetadataArgs = decode(json!({
            "path": "Page.md",
            "title": "New",
            "icon": "star",
            "description": "  preserved  ",
            "cover": { "type": "color", "value": "blue" }
        }))
        .unwrap();
        assert!(missing.icon.is_none());
        assert_eq!(nulls.title, None);
        assert_eq!(nulls.icon, Some(None));
        assert_eq!(nulls.description, Some(None));
        assert_eq!(nulls.cover, Some(None));
        assert_eq!(values.title.as_deref(), Some("New"));
        assert_eq!(values.icon, Some(Some("star".into())));
        assert_eq!(values.description, Some(Some("  preserved  ".into())));
        assert!(values.cover.flatten().is_some());
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

    #[tokio::test]
    async fn page_read_dates_preserve_mcp_roles_and_source_facts() {
        let temp = tempfile::tempdir().unwrap();
        let space = temp.path().to_str().unwrap();
        fs::create_dir_all(temp.path().join("tasks")).unwrap();
        fs::create_dir_all(temp.path().join("folder")).unwrap();
        fs::write(
            temp.path().join("tasks/schema.yaml"),
            "columns: []\nviews: []\n",
        )
        .unwrap();
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            "CREATE TABLE entries (file_path TEXT PRIMARY KEY, created TEXT, updated TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        for path in [
            "leaf.md",
            "folder/README.md",
            "tasks/item.md",
            "tasks/README.md",
            "README.md",
        ] {
            let source = "---\ntitle: [malformed\n---\nOriginal body\n";
            fs::write(temp.path().join(path), source).unwrap();
            let normalized = validate_markdown_path(path).unwrap();
            ensure_inside(temp.path(), &normalized).unwrap();
            match path {
                "tasks/item.md" => require_collection_item(space, path).unwrap(),
                "tasks/README.md" => {
                    require_owner(space, path, ContentOwnerKind::Collection).unwrap()
                }
                "README.md" => require_owner(space, path, ContentOwnerKind::Space).unwrap(),
                _ => require_standalone_page(space, path).unwrap(),
            }
            if path.starts_with("tasks/") || path == "README.md" {
                assert_eq!(
                    require_standalone_page(space, path).unwrap_err().code,
                    "NOT_A_STANDALONE_PAGE"
                );
            }
            let mut page = entry::read(space, path).unwrap();
            let mut expected = serde_json::to_value(&page).unwrap();
            sqlx::query("INSERT INTO entries VALUES (?, 'indexed-created', 'indexed-updated')")
                .bind(path)
                .execute(&pool)
                .await
                .unwrap();
            crate::index::page_dates::apply_indexed_dates(&pool, &normalized, &mut page).await;
            expected["meta"]["created"] = "indexed-created".into();
            expected["meta"]["updated"] = "indexed-updated".into();
            assert_eq!(serde_json::to_value(page).unwrap(), expected);
            assert_eq!(fs::read_to_string(temp.path().join(path)).unwrap(), source);
        }
        assert!(validate_markdown_path("../outside.md").is_err());
        assert!(entry::read(space, "missing.md").is_err());
        assert!(!temp.path().join(".svode").exists());
        assert!(!temp.path().join(".git").exists());
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

async fn write_page_content(
    app: &AppHandle,
    context: &ActiveProjectContext,
    space: &str,
    path: &str,
    content: &str,
    title: Option<&str>,
) -> Result<crate::page::write::PageWriteOutcome, crate::error::AppError> {
    let state = app.state::<IndexState>();
    let updates = app.state::<IndexUpdateState>();
    let nonces = app.state::<std::sync::Arc<crate::files::WriteNonceRegistry>>();
    crate::page::write::write(
        crate::page::write::PageWrite {
            space,
            path,
            content,
            title,
            icon: None,
            extra: None,
            metadata: None,
            field_batch: None,
            skip_rename: title.is_none(),
            project: Some(&context.project_path),
        },
        &state,
        &updates,
        &nonces,
        None,
        |mut paths| async move {
            paths.push(PathBuf::from(space));
            crate::git::access::require_repository_mutation_paths(app, paths.clone()).await?;
            Ok(paths)
        },
    )
    .await
}

fn page_write_response(
    space: &str,
    original: &str,
    outcome: crate::page::write::PageWriteOutcome,
) -> Value {
    let canonical = outcome.result.new_path.as_deref().unwrap_or(original);
    let changed = outcome
        .changed_paths
        .iter()
        .map(|path| {
            path.strip_prefix(space)
                .unwrap_or(path)
                .to_string_lossy()
                .replace('\\', "/")
        })
        .collect::<Vec<_>>();
    json!({ "path": canonical, "newPath": outcome.result.new_path,
        "changedPaths": changed, "warnings": outcome.result.warnings })
}

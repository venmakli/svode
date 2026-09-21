use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use super::active::{self, ActiveProjectContext, ActiveProjectState};
use crate::AppError;
use crate::git::{self, GitState};
use crate::index::IndexState;
use crate::index::update::IndexUpdateState;
use crate::properties::read;
use crate::repo_path::{RootMode, normalize_repo_relative};
use crate::space::{config as space_config, content_tree, project, registry};
use svode_core::collections::engine::{
    self as engine, CollectionSchema, Column, EntryFieldBatchIntent, Filter, Sort, View,
};
use svode_core::page::entry;
use svode_core::page::fields::PageFieldUpdate;
use svode_core::page::identity::ContentOwnerKind;
use svode_mcp::args::{
    CollectionArgs, PathArgs, SpaceArgs, clamp_limit, deserialize_present, offset,
};
use svode_mcp::error::McpBusinessError;
use svode_mcp::host::RequestTarget;
use svode_mcp::owner::{
    collection_readme_path, require_collection_item, require_owner, require_standalone_page,
};
use svode_mcp::path::{ensure_inside, validate_markdown_path, validate_public_rel_path};
use svode_mcp::protocol::{IpcContextOverride, ToolCallResult};
use svode_mcp::target::{ROOT_SPACE_ID, default_space_id, is_root_space_id};

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
pub(crate) use dispatch::DesktopMcpHost;
#[cfg(test)]
use dispatch::decode;
pub use dispatch::{call_tool, call_tool_with_context};

/// Frozen target of a request in the public MCP addressing vocabulary.
fn request_target(context: &ActiveProjectContext) -> RequestTarget {
    RequestTarget {
        project_path: context.project_path.clone(),
        default_space_id: context.active_space_id.clone(),
        default_space_path: context.active_space_path.clone(),
    }
}

pub(crate) fn routine_caller_provenance() -> Option<crate::terminal::RoutineMcpCallerProvenance> {
    MCP_ROUTINE_CALLER.try_with(Clone::clone).ok().flatten()
}

#[derive(Debug, Clone, Copy)]
pub enum CommitPolicy {
    NoAutocommit,
}

#[derive(Debug, Clone, Copy)]
struct McpMutationPolicy {
    _origin: crate::attachments::import::MutationOrigin,
    _commit_policy: CommitPolicy,
}

const MCP_MUTATION_POLICY: McpMutationPolicy = McpMutationPolicy {
    _origin: crate::attachments::import::MutationOrigin::Mcp,
    _commit_policy: CommitPolicy::NoAutocommit,
};

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
    parent_path: String,
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

fn schema_for_create_collection(args: &CreateCollectionArgs) -> CollectionSchema {
    let mut schema = engine::default_collection_schema();
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
                let nonces = svode_core::page::nonce::WriteNonceRegistry::new();
                let outcome = crate::page::write(
                    svode_core::page::write::PageWrite {
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

    #[test]
    fn create_collection_rejects_removed_document_label_argument() {
        let args = json!({
            "parentPath": "",
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
) -> Result<svode_core::page::write::PageWriteOutcome, crate::error::AppError> {
    let state = app.state::<IndexState>();
    let updates = app.state::<IndexUpdateState>();
    let nonces = app.state::<std::sync::Arc<svode_core::page::nonce::WriteNonceRegistry>>();
    crate::page::write(
        svode_core::page::write::PageWrite {
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
    outcome: svode_core::page::write::PageWriteOutcome,
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

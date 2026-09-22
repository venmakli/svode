//! Structural content actions through the shared core workflows: delete,
//! rename, move, reorder, shape conversions and Collection create.
//!
//! Every action authorizes the planned touched-set of its core plan before
//! the first write and runs without a commit sink.

use std::collections::HashMap;
use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::json;
use svode_core::collections::engine::{self, CollectionSchema, Column, View};
use svode_core::git::cli::GitCli;
use svode_core::page::PageError;
use svode_core::page::entry::Cover;
use svode_core::page::identity::ContentOwnerKind;
use svode_core::page::metadata::relative_changed_paths;
use svode_core::structure::{self, CollectionCreate, ConvertToCollectionOutcome, StructureRuntime};

use crate::args::{CollectionArgs, PathArgs};
use crate::error::McpBusinessError;
use crate::host::{McpHost, RequestTarget};
use crate::mutation::{PageHandles, authorize, failure, within_authorized};
use crate::owner::{
    collection_readme_path, require_collection_item, require_owner, require_standalone_page,
};
use crate::path::{ensure_inside, validate_markdown_path, validate_public_rel_path};
use crate::protocol::ToolCallResult;
use crate::target::{is_root_space_id, resolve_space};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenameContentArgs {
    #[serde(default)]
    space_id: Option<String>,
    from: String,
    to: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MoveContentArgs {
    #[serde(default)]
    space_id: Option<String>,
    from: String,
    to_parent: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReorderContentArgs {
    #[serde(default)]
    space_id: Option<String>,
    parent_path: String,
    ordered_children: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReorderSpacesArgs {
    ordered_space_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub(crate) struct CreateCollectionArgs {
    #[serde(default)]
    space_id: Option<String>,
    parent_path: String,
    title: String,
    #[serde(default)]
    icon: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    cover: Option<Cover>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    columns: Option<Vec<Column>>,
    #[serde(default)]
    views: Option<Vec<View>>,
}

/// Core structure runtime over the host mutation runtime, without history.
fn structure_runtime<'a>(handles: &'a PageHandles<'a>) -> StructureRuntime<'a, GitCli> {
    StructureRuntime {
        index: handles.runtime.index,
        updates: handles.runtime.updates,
        git_dates: handles.git_dates(),
        commits: None,
    }
}

pub(crate) async fn create_collection(
    host: &impl McpHost,
    target: &RequestTarget,
    args: CreateCollectionArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let space = resolve_space(target, args.space_id.as_deref())?;
    let parent_path = validate_public_rel_path(&args.parent_path, true)?;
    ensure_inside(Path::new(&space), &parent_path)?;
    let schema = schema_for_create_collection(args.columns, args.views);
    let handles = PageHandles::of(host);
    let outcome = match Box::pin(structure::create_collection(
        CollectionCreate {
            space: space.clone(),
            parent_path: (!parent_path.is_empty()).then_some(parent_path),
            title: args.title,
            body: args.body,
            icon: args.icon,
            description: args.description,
            cover: args.cover,
            schema,
            allocate_unique_title: false,
            project: Some(target.project_path.clone()),
        },
        structure_runtime(&handles),
        |paths| authorize(host, &space, paths),
    ))
    .await
    {
        Ok(outcome) => outcome,
        Err(error) => return failure(error),
    };
    let changed_paths = relative_changed_paths(&space, &outcome.changed_paths);
    Ok(ToolCallResult::ok(
        format!("Created collection {}.", outcome.collection_path),
        json!({
            "collectionPath": outcome.collection_path,
            "collection": outcome.collection,
            "schema": outcome.schema,
            "changedPaths": changed_paths
        }),
    ))
}

/// Initial schema of a created Collection: explicit columns replace the
/// defaults and, without explicit views, become the default table fields.
fn schema_for_create_collection(
    columns: Option<Vec<Column>>,
    views: Option<Vec<View>>,
) -> CollectionSchema {
    let mut schema = engine::default_collection_schema();
    if let Some(columns) = columns {
        let fields = std::iter::once("title".to_string())
            .chain(columns.iter().map(|column| column.name.clone()))
            .collect::<Vec<_>>();
        schema.columns = columns;
        if views.is_none()
            && let Some(View::Table { visible_fields, .. }) = schema.views.first_mut()
        {
            *visible_fields = fields;
        }
    }
    if let Some(views) = views {
        schema.views = views;
    }
    schema
}

pub(crate) async fn convert_to_collection(
    host: &impl McpHost,
    target: &RequestTarget,
    args: PathArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let space = resolve_space(target, args.space_id.as_deref())?;
    let path = validate_public_rel_path(&args.path, false)?;
    ensure_inside(Path::new(&space), &path)?;
    let handles = PageHandles::of(host);
    let project = target.project_path.as_str();
    let source = Path::new(&space).join(&path);
    let moves_leaf = source.is_file()
        && !source
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("README.md"));
    let planned = if moves_leaf {
        structure::backlink_mutation_paths(
            handles.runtime.index,
            &space,
            Some(project),
            &path,
            false,
        )
        .await?
    } else {
        Vec::new()
    };
    let authorized = authorize(host, &space, planned).await?;
    let (conversion, changes) = within_authorized(
        authorized,
        observe_structural_change(&space, project, async {
            Box::pin(structure::convert_to_collection(
                &space,
                &path,
                Some(project),
                structure_runtime(&handles),
            ))
            .await
            .map_err(collection_conversion_error)
        }),
    )
    .await?;
    Ok(collection_conversion_result(conversion, changes))
}

pub(crate) async fn delete_page(
    host: &impl McpHost,
    target: &RequestTarget,
    args: PathArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let space = resolve_space(target, args.space_id.as_deref())?;
    let path = validate_markdown_path(&args.path)?;
    ensure_inside(Path::new(&space), &path)?;
    require_standalone_page(&space, &path)?;
    delete_markdown_content(host, target, &space, path, "Page").await
}

pub(crate) async fn delete_collection_item(
    host: &impl McpHost,
    target: &RequestTarget,
    args: PathArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let space = resolve_space(target, args.space_id.as_deref())?;
    let path = validate_markdown_path(&args.path)?;
    ensure_inside(Path::new(&space), &path)?;
    require_collection_item(&space, &path)?;
    delete_markdown_content(host, target, &space, path, "Collection item").await
}

pub(crate) async fn delete_collection(
    host: &impl McpHost,
    target: &RequestTarget,
    args: CollectionArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let space = resolve_space(target, args.space_id.as_deref())?;
    let collection_path = validate_public_rel_path(&args.collection_path, true)?;
    let path = collection_readme_path(&collection_path);
    ensure_inside(Path::new(&space), &path)?;
    require_owner(&space, &path, ContentOwnerKind::Collection)?;
    delete_markdown_content(host, target, &space, path, "Collection").await
}

/// Deletes an entry with its relation cleanup; the touched-set includes every
/// source whose relations reference a deleted entry.
async fn delete_markdown_content(
    host: &impl McpHost,
    target: &RequestTarget,
    space: &str,
    path: String,
    label: &str,
) -> Result<ToolCallResult, McpBusinessError> {
    let project = target.project_path.as_str();
    let planned = structure::delete_mutation_paths(space, Some(project), &path)?;
    let authorized = authorize(host, space, planned).await?;
    let handles = PageHandles::of(host);
    let deleted = within_authorized(authorized, async {
        Ok(Box::pin(structure::delete(
            space,
            &path,
            Some(project),
            structure_runtime(&handles),
        ))
        .await?)
    })
    .await?;
    Ok(ToolCallResult::ok(
        format!("Deleted {label} {path}."),
        json!({
            "deletedRoot": deleted.deleted_root,
            "deletedPaths": deleted.deleted_paths,
            "cascadeTouched": deleted.cascade_touched,
            "changedPaths": deleted.changed_paths
        }),
    ))
}

pub(crate) async fn rename_content(
    host: &impl McpHost,
    target: &RequestTarget,
    args: RenameContentArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let space = resolve_space(target, args.space_id.as_deref())?;
    let from = validate_public_rel_path(&args.from, false)?;
    let to = validate_public_rel_path(&args.to, false)?;
    ensure_inside(Path::new(&space), &from)?;
    ensure_inside(Path::new(&space), &to)?;
    let project = target.project_path.as_str();
    let handles = PageHandles::of(host);
    let planned =
        structure::move_mutation_paths(handles.runtime.index, &space, Some(project), &from, &to)
            .await?;
    let authorized = authorize(host, &space, planned).await?;
    let (_, changes) = within_authorized(
        authorized,
        observe_structural_change(&space, project, async {
            Ok(Box::pin(structure::rename(
                &space,
                &from,
                &to,
                Some(project),
                structure_runtime(&handles),
            ))
            .await?)
        }),
    )
    .await?;
    Ok(structural_operation_result(
        "Renamed content",
        &from,
        &to,
        changes,
    ))
}

pub(crate) async fn move_content(
    host: &impl McpHost,
    target: &RequestTarget,
    args: MoveContentArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let space = resolve_space(target, args.space_id.as_deref())?;
    let from = validate_public_rel_path(&args.from, false)?;
    let to_parent = validate_public_rel_path(&args.to_parent, true)?;
    ensure_inside(Path::new(&space), &from)?;
    ensure_inside(Path::new(&space), &to_parent)?;
    let file_name = Path::new(&from)
        .file_name()
        .ok_or_else(|| McpBusinessError::new("INVALID_PATH", "invalid source path"))?
        .to_string_lossy();
    let planned_to = if to_parent.is_empty() {
        file_name.to_string()
    } else {
        format!("{to_parent}/{file_name}")
    };
    let project = target.project_path.as_str();
    let handles = PageHandles::of(host);
    let planned = structure::move_mutation_paths(
        handles.runtime.index,
        &space,
        Some(project),
        &from,
        &planned_to,
    )
    .await?;
    let authorized = authorize(host, &space, planned).await?;
    let (new_path, changes) = within_authorized(
        authorized,
        observe_structural_change(&space, project, async {
            Ok(Box::pin(structure::move_entry(
                &space,
                &from,
                &to_parent,
                Some(project),
                structure_runtime(&handles),
            ))
            .await?)
        }),
    )
    .await?;
    Ok(structural_operation_result(
        "Moved content",
        &from,
        &new_path,
        changes,
    ))
}

pub(crate) async fn reorder_content(
    host: &impl McpHost,
    target: &RequestTarget,
    args: ReorderContentArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let space = resolve_space(target, args.space_id.as_deref())?;
    let parent_path = validate_public_rel_path(&args.parent_path, true)?;
    ensure_inside(Path::new(&space), &parent_path)?;
    authorize(host, &space, Vec::new()).await?;
    let result =
        svode_core::content_tree::reorder_content(&space, &parent_path, args.ordered_children)?;
    let changed_paths = if result.changed {
        vec![".svode/order.json"]
    } else {
        Vec::new()
    };
    Ok(ToolCallResult::ok(
        format!("Reordered {} direct children.", result.previous_order.len()),
        json!({
            "parentPath": result.parent_path,
            "previousOrder": result.previous_order,
            "orderedChildren": result.ordered_children,
            "changedPaths": changed_paths,
        }),
    ))
}

pub(crate) async fn reorder_spaces(
    host: &impl McpHost,
    target: &RequestTarget,
    args: ReorderSpacesArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    if args.ordered_space_ids.iter().any(|id| is_root_space_id(id)) {
        return Err(McpBusinessError::new(
            "INVALID_SPACE_ORDER",
            "the root space is pinned and must not be included",
        ));
    }
    authorize(host, &target.project_path, Vec::new()).await?;
    let outcome =
        structure::reorder_child_spaces(Path::new(&target.project_path), args.ordered_space_ids)?;
    let changed_paths = if outcome.changed {
        vec![".svode/config.json"]
    } else {
        Vec::new()
    };
    Ok(ToolCallResult::ok(
        format!(
            "Reordered {} child spaces.",
            outcome.ordered_space_ids.len()
        ),
        json!({
            "previousOrder": outcome.previous_order,
            "orderedSpaceIds": outcome.ordered_space_ids,
            "changedPaths": changed_paths,
        }),
    ))
}

pub(crate) async fn convert_page_to_leaf(
    host: &impl McpHost,
    target: &RequestTarget,
    args: PathArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let space = resolve_space(target, args.space_id.as_deref())?;
    let path = validate_markdown_path(&args.path)?;
    ensure_inside(Path::new(&space), &path)?;
    require_standalone_page(&space, &path)?;
    let project = target.project_path.as_str();
    let handles = PageHandles::of(host);
    let planned = structure::backlink_mutation_paths(
        handles.runtime.index,
        &space,
        Some(project),
        &path,
        false,
    )
    .await?;
    let authorized = authorize(host, &space, planned).await?;
    let (page, changes) = within_authorized(
        authorized,
        observe_structural_change(&space, project, async {
            Ok(Box::pin(structure::convert_to_leaf(
                &space,
                &path,
                Some(project),
                structure_runtime(&handles),
            ))
            .await?)
        }),
    )
    .await?;
    let mut result = structural_operation_result(
        "Converted directory-backed Page to leaf Page",
        &path,
        &page.path,
        changes,
    );
    if let Some(structured_content) = result.structured_content.as_mut() {
        structured_content["page"] = json!(page);
    }
    Ok(result)
}

/// Source paths a structural action changed, relative to its Space and to
/// its Project.
struct StructuralChanges {
    space: Vec<String>,
    project: Vec<String>,
}

/// Runs a structural action and reports the structural sources whose content
/// differs afterwards: Markdown, schemas, order files and the Space root Git
/// attribute files.
async fn observe_structural_change<T>(
    space: &str,
    project: &str,
    operation: impl Future<Output = Result<T, McpBusinessError>>,
) -> Result<(T, StructuralChanges), McpBusinessError> {
    let before = snapshot_structural_paths(Path::new(space))?;
    let before_project = snapshot_structural_paths(Path::new(project))?;
    let value = operation.await?;
    let changes = StructuralChanges {
        space: changed_structural_paths(before, Path::new(space))?,
        project: changed_structural_paths(before_project, Path::new(project))?,
    };
    Ok((value, changes))
}

struct TouchedPaths {
    backlinks: Vec<String>,
    relations: Vec<String>,
    order: Vec<String>,
}

fn touched_paths(affected_project_paths: &[String]) -> TouchedPaths {
    let select = |keep: fn(&str) -> bool| {
        affected_project_paths
            .iter()
            .filter(|path| keep(path))
            .cloned()
            .collect::<Vec<_>>()
    };
    TouchedPaths {
        backlinks: select(|path| path.ends_with(".md")),
        relations: select(|path| path.ends_with(".md") || path.ends_with("schema.yaml")),
        order: select(|path| path.ends_with(".svode/order.json")),
    }
}

fn structural_operation_result(
    action: &str,
    old_path: &str,
    new_path: &str,
    changes: StructuralChanges,
) -> ToolCallResult {
    let touched = touched_paths(&changes.project);
    ToolCallResult::ok(
        format!("{action}: {old_path} → {new_path}."),
        json!({
            "oldPath": old_path,
            "newPath": new_path,
            "changedPaths": changes.space,
            "affectedProjectPaths": changes.project,
            "touchedPaths": {
                "backlinks": touched.backlinks,
                "relations": touched.relations,
                "order": touched.order,
                "index": [old_path, new_path],
            },
        }),
    )
}

fn collection_conversion_result(
    conversion: ConvertToCollectionOutcome,
    changes: StructuralChanges,
) -> ToolCallResult {
    let touched = touched_paths(&changes.project);
    let old_path = conversion.old_path;
    let collection_path = conversion.collection_path;
    let readme_path = conversion.readme_path;
    let index_paths = vec![old_path.clone(), readme_path.clone()];
    let warnings = conversion.entry.warnings.clone();

    ToolCallResult::ok(
        format!("Converted {} to collection {}.", old_path, collection_path),
        json!({
            "oldPath": old_path,
            "collectionPath": collection_path,
            "readmePath": readme_path,
            "schemaPath": conversion.schema_path,
            "collection": conversion.entry,
            "changedPaths": changes.space,
            "affectedProjectPaths": changes.project,
            "touchedPaths": {
                "backlinks": touched.backlinks,
                "relations": touched.relations,
                "order": touched.order,
                "index": index_paths,
            },
            "warnings": warnings,
        }),
    )
}

/// Conversion rule violations keep their own stable code in the public
/// Page vocabulary.
fn collection_conversion_error(error: PageError) -> McpBusinessError {
    match error {
        PageError::General(message) => McpBusinessError::new(
            "INVALID_COLLECTION_CONVERSION",
            message
                .replace("folder document", "directory-backed Page")
                .replace("document", "Page"),
        ),
        other => other.into(),
    }
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
            || (directory == root && matches!(file_name.as_ref(), ".gitignore" | ".gitattributes"))
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
        let rel = path
            .strip_prefix(root)
            .map(PathBuf::from)
            .unwrap_or(path.clone())
            .to_string_lossy()
            .replace('\\', "/");
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch::decode;

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
    fn collection_conversion_maps_validation_errors_to_stable_code() {
        let error = collection_conversion_error(PageError::General(
            "document is already a collection".to_string(),
        ));

        assert_eq!(error.code, "INVALID_COLLECTION_CONVERSION");
        assert_eq!(error.message, "Page is already a collection");
    }
}

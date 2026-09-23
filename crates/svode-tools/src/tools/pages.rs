//! Page, owner README and Collection item writes through the shared core
//! Page operations.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use serde::Deserialize;
use serde_json::{Value, json};
use svode_core::collections::engine::EntryFieldBatchIntent;
use svode_core::page::SourceVersion;
use svode_core::page::create::PageCreate;
use svode_core::page::entry::{self, Cover};
use svode_core::page::fields::PageFieldUpdate;
use svode_core::page::identity::ContentOwnerKind;
use svode_core::page::metadata::{PageMetadataPatch, relative_changed_paths};
use svode_core::page::write::{PageWrite, PageWriteOutcome};

use crate::args::deserialize_present;
use crate::error::ToolError;
use crate::host::{RequestTarget, ToolHost};
use crate::mutation::{MutationError, PageHandles, authorize, failure, space_relative_busy};
use crate::owner::{
    collection_readme_path, require_collection_item, require_owner, require_standalone_page,
};
use crate::path::{ensure_inside, validate_markdown_path, validate_public_rel_path};
use crate::result::{ToolCallResult, source_version};
use crate::target::resolve_space;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WritePageArgs {
    #[serde(default)]
    space_id: Option<String>,
    path: String,
    content: String,
    #[serde(default)]
    title: Option<String>,
    source_version: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub(crate) struct CreatePageArgs {
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
    cover: Option<Cover>,
    #[serde(default)]
    properties: Option<HashMap<String, Value>>,
}

/// Metadata patch of a Page or Collection item: missing keeps a field,
/// `null` clears icon/description/cover.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdatePageMetadataArgs {
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
    cover: Option<Option<Cover>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WriteSpaceReadmeArgs {
    #[serde(default)]
    space_id: Option<String>,
    content: String,
    #[serde(default)]
    title: Option<String>,
    source_version: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateSpaceMetadataArgs {
    #[serde(default)]
    space_id: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default, deserialize_with = "deserialize_present")]
    icon: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_present")]
    description: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_present")]
    cover: Option<Option<Cover>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WriteCollectionReadmeArgs {
    #[serde(default)]
    space_id: Option<String>,
    collection_path: String,
    content: String,
    #[serde(default)]
    title: Option<String>,
    source_version: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateCollectionMetadataArgs {
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
    cover: Option<Option<Cover>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateCollectionItemFieldsArgs {
    #[serde(default)]
    space_id: Option<String>,
    path: String,
    fields: BTreeMap<String, Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateCollectionItemBodyArgs {
    #[serde(default)]
    space_id: Option<String>,
    path: String,
    body: String,
    source_version: String,
}

pub(crate) async fn write_page(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: WritePageArgs,
) -> Result<ToolCallResult, ToolError> {
    let space = resolve_space(target, args.space_id.as_deref())?;
    let path = validate_markdown_path(&args.path)?;
    ensure_inside(Path::new(&space), &path)?;
    require_standalone_page(&space, &path)?;
    let outcome = match write_body(
        host,
        target,
        &space,
        &path,
        &args.content,
        args.title.as_deref(),
        &args.source_version,
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(error) => return failure(error),
    };
    Ok(ToolCallResult::ok(
        format!("Updated Page {path}."),
        write_response(&space, &path, outcome),
    ))
}

pub(crate) async fn create_page(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: CreatePageArgs,
) -> Result<ToolCallResult, ToolError> {
    let space = resolve_space(target, args.space_id.as_deref())?;
    let parent_path = validate_public_rel_path(&args.parent_path, true)?;
    ensure_inside(Path::new(&space), &parent_path)?;
    let handles = PageHandles::of(host);
    let outcome = match svode_core::page::create::create(
        PageCreate {
            space: space.clone(),
            parent_path: (!parent_path.is_empty()).then_some(parent_path),
            title: args.title,
            body: args.content,
            icon: args.icon,
            description: args.description,
            cover: args.cover,
            properties: args.properties,
            contextual_defaults: false,
            allocate_unique_title: false,
            as_readme: false,
            project: Some(target.project_path.clone()),
            publish_projection: true,
        },
        handles.runtime.index,
        handles.runtime.updates,
        handles.git_dates(),
        |paths| authorize(host, &space, paths),
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(error) => return failure(error).map_err(|error| space_relative_busy(&space, error)),
    };
    let changed_paths = relative_changed_paths(&space, &outcome.changed_paths);
    let warnings = outcome.page.warnings.clone();
    Ok(ToolCallResult::ok(
        format!("Created Page {}.", outcome.page.path),
        json!({ "path": outcome.page.path, "sourceVersion": source_version(&outcome.page), "page": outcome.page, "changedPaths": changed_paths, "warnings": warnings }),
    ))
}

pub(crate) async fn update_page_metadata(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: UpdatePageMetadataArgs,
) -> Result<ToolCallResult, ToolError> {
    let space = resolve_space(target, args.space_id.as_deref())?;
    let path = validate_markdown_path(&args.path)?;
    ensure_inside(Path::new(&space), &path)?;
    require_standalone_page(&space, &path)?;
    let patch = PageMetadataPatch {
        title: args.title,
        icon: args.icon,
        description: args.description,
        cover: args.cover,
    };
    let outcome = match patch_metadata(host, target, &space, &path, patch).await {
        Ok(outcome) => outcome,
        Err(error) => return failure(error),
    };
    let changed_paths = relative_changed_paths(&space, &outcome.changed_paths);
    let warnings = outcome.page.warnings.clone();
    Ok(ToolCallResult::ok(
        format!("Updated metadata for {path}."),
        json!({ "sourceVersion": source_version(&outcome.page), "page": outcome.page, "changedPaths": changed_paths, "warnings": warnings }),
    ))
}

pub(crate) async fn write_space_readme(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: WriteSpaceReadmeArgs,
) -> Result<ToolCallResult, ToolError> {
    let space = resolve_space(target, args.space_id.as_deref())?;
    let path = "README.md";
    ensure_inside(Path::new(&space), path)?;
    require_owner(&space, path, ContentOwnerKind::Space)?;
    let outcome = match write_body(
        host,
        target,
        &space,
        path,
        &args.content,
        args.title.as_deref(),
        &args.source_version,
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(error) => return failure(error),
    };
    Ok(ToolCallResult::ok(
        "Updated Space README.",
        write_response(&space, path, outcome),
    ))
}

pub(crate) async fn update_space_metadata(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: UpdateSpaceMetadataArgs,
) -> Result<ToolCallResult, ToolError> {
    let space = resolve_space(target, args.space_id.as_deref())?;
    let path = "README.md";
    ensure_inside(Path::new(&space), path)?;
    require_owner(&space, path, ContentOwnerKind::Space)?;
    let patch = PageMetadataPatch {
        title: args.title,
        icon: args.icon,
        description: args.description,
        cover: args.cover,
    };
    let outcome = match patch_metadata(host, target, &space, path, patch).await {
        Ok(outcome) => outcome,
        Err(error) => return failure(error),
    };
    let changed_paths = relative_changed_paths(&space, &outcome.changed_paths);
    let warnings = outcome.page.warnings.clone();
    Ok(ToolCallResult::ok(
        "Updated Space metadata.",
        json!({ "sourceVersion": source_version(&outcome.page), "spaceReadme": outcome.page, "changedPaths": changed_paths, "warnings": warnings }),
    ))
}

pub(crate) async fn write_collection_readme(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: WriteCollectionReadmeArgs,
) -> Result<ToolCallResult, ToolError> {
    let space = resolve_space(target, args.space_id.as_deref())?;
    let collection_path = validate_public_rel_path(&args.collection_path, true)?;
    let path = collection_readme_path(&collection_path);
    ensure_inside(Path::new(&space), &path)?;
    require_owner(&space, &path, ContentOwnerKind::Collection)?;
    let outcome = match write_body(
        host,
        target,
        &space,
        &path,
        &args.content,
        args.title.as_deref(),
        &args.source_version,
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(error) => return failure(error),
    };
    let mut response = write_response(&space, &path, outcome);
    response["collectionPath"] = json!(parent_dir(response["path"].as_str().unwrap_or(&path)));
    Ok(ToolCallResult::ok(
        format!("Updated Collection README for {collection_path}."),
        response,
    ))
}

pub(crate) async fn update_collection_metadata(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: UpdateCollectionMetadataArgs,
) -> Result<ToolCallResult, ToolError> {
    let space = resolve_space(target, args.space_id.as_deref())?;
    let collection_path = validate_public_rel_path(&args.collection_path, true)?;
    let path = collection_readme_path(&collection_path);
    ensure_inside(Path::new(&space), &path)?;
    require_owner(&space, &path, ContentOwnerKind::Collection)?;
    let patch = PageMetadataPatch {
        title: args.title,
        icon: args.icon,
        description: args.description,
        cover: args.cover,
    };
    let outcome = match patch_metadata(host, target, &space, &path, patch).await {
        Ok(outcome) => outcome,
        Err(error) => return failure(error),
    };
    let collection_path = parent_dir(&outcome.page.path);
    let changed_paths = relative_changed_paths(&space, &outcome.changed_paths);
    let warnings = outcome.page.warnings.clone();
    Ok(ToolCallResult::ok(
        format!("Updated Collection metadata for {collection_path}."),
        json!({ "collectionPath": collection_path, "sourceVersion": source_version(&outcome.page), "collectionReadme": outcome.page, "changedPaths": changed_paths, "warnings": warnings }),
    ))
}

pub(crate) async fn update_collection_item_metadata(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: UpdatePageMetadataArgs,
) -> Result<ToolCallResult, ToolError> {
    let space = resolve_space(target, args.space_id.as_deref())?;
    let path = validate_markdown_path(&args.path)?;
    ensure_inside(Path::new(&space), &path)?;
    require_collection_item(&space, &path)?;
    let patch = PageMetadataPatch {
        title: args.title,
        icon: args.icon,
        description: args.description,
        cover: args.cover,
    };
    let outcome = match patch_metadata(host, target, &space, &path, patch).await {
        Ok(outcome) => outcome,
        Err(error) => return failure(error),
    };
    let changed_paths = relative_changed_paths(&space, &outcome.changed_paths);
    let warnings = outcome.page.warnings.clone();
    Ok(ToolCallResult::ok(
        format!("Updated metadata for Collection item {path}."),
        json!({ "sourceVersion": source_version(&outcome.page), "item": outcome.page, "changedPaths": changed_paths, "warnings": warnings }),
    ))
}

pub(crate) async fn update_collection_item_fields(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: UpdateCollectionItemFieldsArgs,
) -> Result<ToolCallResult, ToolError> {
    let space = resolve_space(target, args.space_id.as_deref())?;
    let path = validate_markdown_path(&args.path)?;
    ensure_inside(Path::new(&space), &path)?;
    require_collection_item(&space, &path)?;
    if args.fields.is_empty() {
        let item = entry::read(&space, &path)?;
        return Ok(ToolCallResult::ok(
            format!("No field changes for {path}."),
            json!({ "sourceVersion": source_version(&item), "item": item, "changedPaths": [] }),
        ));
    }
    let handles = PageHandles::of(host);
    let outcome = match svode_core::page::fields::update(
        PageFieldUpdate {
            space: &space,
            path: &path,
            project: Some(&target.project_path),
            values: &args.fields,
            intent: EntryFieldBatchIntent::Literal,
        },
        handles.page(),
        |paths| authorize(host, &space, paths),
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(error) => return failure(error),
    };
    let changed_paths = relative_changed_paths(&space, &outcome.changed_paths);
    Ok(ToolCallResult::ok(
        format!("Updated fields for {path}."),
        json!({ "sourceVersion": source_version(&outcome.page), "item": outcome.page, "changedPaths": changed_paths }),
    ))
}

pub(crate) async fn update_collection_item_body(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: UpdateCollectionItemBodyArgs,
) -> Result<ToolCallResult, ToolError> {
    let space = resolve_space(target, args.space_id.as_deref())?;
    let path = validate_markdown_path(&args.path)?;
    ensure_inside(Path::new(&space), &path)?;
    require_collection_item(&space, &path)?;
    let outcome = match write_body(
        host,
        target,
        &space,
        &path,
        &args.body,
        None,
        &args.source_version,
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(error) => return failure(error),
    };
    Ok(ToolCallResult::ok(
        format!("Updated body for {path}."),
        write_response(&space, &path, outcome),
    ))
}

/// Body write from the source version the caller read, with an optional
/// explicit title intent; a missing title is body-only and never renames.
async fn write_body(
    host: &impl ToolHost,
    target: &RequestTarget,
    space: &str,
    path: &str,
    content: &str,
    title: Option<&str>,
    source_version: &str,
) -> Result<PageWriteOutcome, MutationError> {
    let handles = PageHandles::of(host);
    let source_version = SourceVersion::from_token(source_version);
    svode_core::page::write::write(
        PageWrite {
            space,
            path,
            content,
            title,
            icon: None,
            extra: None,
            metadata: None,
            field_batch: None,
            skip_rename: title.is_none(),
            project: Some(&target.project_path),
            source_version: Some(&source_version),
        },
        handles.page(),
        |paths| authorize(host, space, paths),
    )
    .await
}

async fn patch_metadata(
    host: &impl ToolHost,
    target: &RequestTarget,
    space: &str,
    path: &str,
    patch: PageMetadataPatch,
) -> Result<svode_core::page::metadata::PageMetadataOutcome, MutationError> {
    let handles = PageHandles::of(host);
    svode_core::page::metadata::patch(
        space,
        path,
        patch,
        Some(&target.project_path),
        handles.page(),
        |paths| authorize(host, space, paths),
    )
    .await
}

/// Write result projected from the actual outcome: `path` after the
/// operation, `newPath` only for a performed rename.
fn write_response(space: &str, original: &str, outcome: PageWriteOutcome) -> Value {
    let canonical = outcome.result.new_path.as_deref().unwrap_or(original);
    json!({
        "path": canonical,
        "newPath": outcome.result.new_path,
        "sourceVersion": outcome.result.source_version,
        "changedPaths": relative_changed_paths(space, &outcome.changed_paths),
        "warnings": outcome.result.warnings,
    })
}

fn parent_dir(path: &str) -> String {
    Path::new(path)
        .parent()
        .unwrap_or(Path::new(""))
        .to_string_lossy()
        .replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch::decode;

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
        for legacy in [
            json!({ "path": "tasks/first.md" }),
            json!({ "parentPath": "tasks", "title": "First", "path": "tasks/first.md" }),
            json!({ "parentPath": "tasks", "title": "First", "fields": { "Status": "Todo" } }),
            json!({ "parentPath": "tasks", "title": "First", "collectionPath": "tasks" }),
            json!({ "parentPath": "tasks", "title": "First", "body": "Body" }),
            json!({ "parentPath": "tasks" }),
        ] {
            assert!(
                decode::<CreatePageArgs>(legacy.clone()).is_err(),
                "{legacy}"
            );
        }
    }

    #[test]
    fn body_write_decode_keeps_missing_null_and_string_title() {
        for (title, expected) in [
            (None, None),
            (Some(Value::Null), None),
            (Some(json!("New")), Some("New")),
        ] {
            let mut raw = json!({ "path": "Old.md", "collectionPath": "Old", "content": "Body", "sourceVersion": "v1" });
            if let Some(title) = title {
                raw["title"] = title;
            }
            let page: WritePageArgs = decode(raw.clone()).unwrap();
            let space: WriteSpaceReadmeArgs = decode(raw.clone()).unwrap();
            let collection: WriteCollectionReadmeArgs = decode(raw).unwrap();
            assert_eq!(page.title.as_deref(), expected);
            assert_eq!(space.title.as_deref(), expected);
            assert_eq!(collection.title.as_deref(), expected);
        }
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
        assert!(missing.description.is_none());
        assert!(missing.cover.is_none());
        assert_eq!(nulls.title, None);
        assert_eq!(nulls.icon, Some(None));
        assert_eq!(nulls.description, Some(None));
        assert_eq!(nulls.cover, Some(None));
        assert_eq!(values.title.as_deref(), Some("New"));
        assert_eq!(values.icon, Some(Some("star".into())));
        assert_eq!(values.description, Some(Some("  preserved  ".into())));
        assert!(values.cover.flatten().is_some());
    }
}

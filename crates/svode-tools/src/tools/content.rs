use std::path::Path;

use serde::Deserialize;
use serde_json::json;
use svode_core::collections::engine;
use svode_core::git::path::{RootMode, normalize_repo_relative};
use svode_core::page::entry::{self, Entry};
use svode_core::page::identity::ContentOwnerKind;
use svode_core::page::{PageSourceError, ResolvedSpaceTarget, resolve_owned_page_target};

use crate::args::{CollectionArgs, PathArgs, SpaceArgs, clamp_limit, offset};
use crate::error::ToolError;
use crate::host::{RequestTarget, ToolHost};
use crate::owner::{
    collection_readme_path, require_collection_item, require_owner, require_standalone_page,
};
use crate::path::{ensure_inside, validate_markdown_path, validate_public_rel_path};
use crate::result::{ToolCallResult, source_version};
use crate::target::{index_key, resolve_space};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListPagesArgs {
    #[serde(default)]
    space_id: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    offset: Option<i64>,
}

pub(crate) fn list_pages(
    target: &RequestTarget,
    args: ListPagesArgs,
) -> Result<ToolCallResult, ToolError> {
    let space = resolve_space(target, args.space_id.as_deref())?;
    let root = args
        .path
        .as_deref()
        .map(|p| validate_public_rel_path(p, true))
        .transpose()?
        .unwrap_or_default();
    ensure_inside(Path::new(&space), &root)?;
    let mut nodes = svode_core::content_tree::build_tree(&space)?;
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
        format!("Found {total} Page-tree items."),
        json!({ "items": items, "total": total, "limit": limit, "offset": start }),
    ))
}

pub(crate) fn list_collections(
    target: &RequestTarget,
    args: SpaceArgs,
) -> Result<ToolCallResult, ToolError> {
    let space = resolve_space(target, args.space_id.as_deref())?;
    let collections = engine::list_collections(&space)?;
    Ok(ToolCallResult::ok(
        format!("Found {} collections.", collections.len()),
        json!({ "collections": collections }),
    ))
}

pub(crate) async fn read_page(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: PathArgs,
) -> Result<ToolCallResult, ToolError> {
    let space = resolve_space(target, args.space_id.as_deref())?;
    let path = validate_markdown_path(&args.path)?;
    ensure_inside(Path::new(&space), &path)?;
    require_standalone_page(&space, &path)?;
    require_owned_page(target, &space, &path)?;
    let page = read_source(host, target, args.space_id.as_deref(), &space, &path).await?;
    Ok(ToolCallResult::ok(
        format!("Read Page {path}."),
        json!({ "sourceVersion": source_version(&page), "page": page }),
    ))
}

pub(crate) async fn read_space_readme(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: SpaceArgs,
) -> Result<ToolCallResult, ToolError> {
    let space = resolve_space(target, args.space_id.as_deref())?;
    let path = "README.md";
    ensure_inside(Path::new(&space), path)?;
    require_owner(&space, path, ContentOwnerKind::Space)?;
    let readme = read_source(host, target, args.space_id.as_deref(), &space, path).await?;
    Ok(ToolCallResult::ok(
        "Read Space README.",
        json!({ "sourceVersion": source_version(&readme), "spaceReadme": readme }),
    ))
}

pub(crate) async fn read_collection_readme(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: CollectionArgs,
) -> Result<ToolCallResult, ToolError> {
    let space = resolve_space(target, args.space_id.as_deref())?;
    let collection_path = validate_public_rel_path(&args.collection_path, true)?;
    let path = collection_readme_path(&collection_path);
    ensure_inside(Path::new(&space), &path)?;
    require_owner(&space, &path, ContentOwnerKind::Collection)?;
    let readme = read_source(host, target, args.space_id.as_deref(), &space, &path).await?;
    Ok(ToolCallResult::ok(
        format!("Read Collection README for {collection_path}."),
        json!({ "collectionPath": collection_path, "sourceVersion": source_version(&readme), "collectionReadme": readme }),
    ))
}

pub(crate) async fn read_collection_item(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: PathArgs,
) -> Result<ToolCallResult, ToolError> {
    let space = resolve_space(target, args.space_id.as_deref())?;
    let path = validate_markdown_path(&args.path)?;
    ensure_inside(Path::new(&space), &path)?;
    require_collection_item(&space, &path)?;
    let item = read_source(host, target, args.space_id.as_deref(), &space, &path).await?;
    Ok(ToolCallResult::ok(
        format!("Read Collection item {path}."),
        json!({ "sourceVersion": source_version(&item), "item": item }),
    ))
}

/// A standalone Page source of the root Space never lies inside a
/// registered child Space or under a hidden directory, also through a
/// symlink.
fn require_owned_page(target: &RequestTarget, space: &str, path: &str) -> Result<(), ToolError> {
    let project = Path::new(&target.project_path);
    let space_target = ResolvedSpaceTarget {
        project_path: project.to_path_buf(),
        space_id: (Path::new(space) != project).then(|| space.to_string()),
        space_path: space.into(),
    };
    match resolve_owned_page_target(&space_target, path) {
        Ok(_) => Ok(()),
        Err(PageSourceError::InvalidOwner(_)) => Err(ToolError::new(
            "NOT_A_STANDALONE_PAGE",
            "path belongs to another Space or to hidden content; read it in its own Space",
        )),
        Err(error) => Err(error.into()),
    }
}

/// One source read with indexed dates from the host-owned pool, or with
/// dates from Git history when the host has no pool for the Space.
async fn read_source(
    host: &impl ToolHost,
    target: &RequestTarget,
    requested_space_id: Option<&str>,
    space: &str,
    path: &str,
) -> Result<Entry, ToolError> {
    let pool = host
        .index_pool(&index_key(target, requested_space_id), Path::new(space))
        .await;
    let Some(pool) = pool else {
        return Ok(entry::read_with_git_dates(space, path).await?);
    };
    let mut source = entry::read(space, path)?;
    if let Ok(normalized) = normalize_repo_relative(path, RootMode::Reject) {
        svode_core::page::indexed_dates::apply_indexed_dates(&pool, &normalized, &mut source).await;
    }
    Ok(source)
}

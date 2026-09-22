use super::*;

pub(super) async fn create_collection(
    app: &AppHandle,
    args: CreateCollectionArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (context, space) = resolve_space(app, args.space_id.clone()).await?;
    let parent_path = validate_public_rel_path(&args.parent_path, true)?;
    ensure_inside(Path::new(&space), &parent_path)?;
    let schema = schema_for_create_collection(&args);
    let outcome = crate::structure::create_collection(
        crate::structure::CollectionCreate {
            space: space.clone(),
            parent_path: (!parent_path.is_empty()).then_some(parent_path),
            title: args.title,
            body: args.body,
            icon: args.icon,
            description: args.description,
            cover: args.cover,
            schema,
            allocate_unique_title: false,
            project: Some(context.project_path),
        },
        &app.state::<IndexState>(),
        &app.state::<IndexUpdateState>(),
        None,
        |paths| async move {
            crate::git::access::ensure_mutation_paths_were_authorized(&paths)?;
            Ok(paths)
        },
    )
    .await?;
    let changed_paths =
        svode_core::page::metadata::relative_changed_paths(&space, &outcome.changed_paths);
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

pub(super) async fn convert_to_collection(
    app: &AppHandle,
    args: PathArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (context, space) = resolve_space(app, args.space_id.clone()).await?;
    let path = validate_public_rel_path(&args.path, false)?;
    ensure_inside(Path::new(&space), &path)?;
    let before = snapshot_structural_paths(Path::new(&space))?;
    let before_project = snapshot_structural_paths(Path::new(&context.project_path))?;
    let index_state = app.state::<IndexState>();
    let conversion = crate::structure::convert_to_collection(
        &space,
        &path,
        Some(context.project_path.as_str()),
        &index_state,
        &app.state::<IndexUpdateState>(),
        None,
    )
    .await
    .map_err(collection_conversion_error)?;
    let changed_paths = changed_structural_paths(before, Path::new(&space))?;
    let affected_project_paths =
        changed_structural_paths(before_project, Path::new(&context.project_path))?;
    Ok(collection_conversion_result(
        conversion,
        changed_paths,
        affected_project_paths,
    ))
}

pub(super) async fn delete_page(
    app: &AppHandle,
    args: PathArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let (_, space) = resolve_space(app, args.space_id.clone()).await?;
    let path = validate_markdown_path(&args.path)?;
    ensure_inside(Path::new(&space), &path)?;
    require_standalone_page(&space, &path)?;
    delete_markdown_content(app, args.space_id, path, "Page").await
}

pub(super) async fn delete_collection_item(
    app: &AppHandle,
    args: PathArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let (_, space) = resolve_space(app, args.space_id.clone()).await?;
    let path = validate_markdown_path(&args.path)?;
    ensure_inside(Path::new(&space), &path)?;
    require_collection_item(&space, &path)?;
    delete_markdown_content(app, args.space_id, path, "Collection item").await
}

pub(super) async fn delete_collection(
    app: &AppHandle,
    args: CollectionArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let (_, space) = resolve_space(app, args.space_id.clone()).await?;
    let collection_path = validate_public_rel_path(&args.collection_path, true)?;
    let path = collection_readme_path(&collection_path);
    ensure_inside(Path::new(&space), &path)?;
    require_owner(&space, &path, ContentOwnerKind::Collection)?;
    delete_markdown_content(app, args.space_id, path, "Collection").await
}

async fn delete_markdown_content(
    app: &AppHandle,
    space_id: Option<String>,
    path: String,
    label: &str,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (context, space) = resolve_space(app, space_id).await?;
    let index_state = app.state::<IndexState>();
    let deleted = crate::structure::delete(
        &space,
        &path,
        Some(context.project_path.as_str()),
        &index_state,
        &app.state::<IndexUpdateState>(),
        None,
    )
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

pub(super) async fn rename_content(
    app: &AppHandle,
    args: RenameContentArgs,
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
    crate::structure::rename(
        &space,
        &from,
        &to,
        Some(context.project_path.as_str()),
        &index_state,
        &app.state::<IndexUpdateState>(),
        None,
    )
    .await?;
    let changed_paths = changed_structural_paths(before, Path::new(&space))?;
    let affected_project_paths =
        changed_structural_paths(before_project, Path::new(&context.project_path))?;
    Ok(structural_operation_result(
        "Renamed content",
        &from,
        &to,
        changed_paths,
        affected_project_paths,
    ))
}

pub(super) async fn move_content(
    app: &AppHandle,
    args: MoveContentArgs,
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
    let new_path = crate::structure::move_entry(
        &space,
        &from,
        &to_parent,
        Some(context.project_path.as_str()),
        &index_state,
        &app.state::<IndexUpdateState>(),
        None,
    )
    .await?;
    let changed_paths = changed_structural_paths(before, Path::new(&space))?;
    let affected_project_paths =
        changed_structural_paths(before_project, Path::new(&context.project_path))?;
    Ok(structural_operation_result(
        "Moved content",
        &from,
        &new_path,
        changed_paths,
        affected_project_paths,
    ))
}

pub(super) async fn reorder_content(
    app: &AppHandle,
    args: ReorderContentArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (_context, space) = resolve_space(app, args.space_id).await?;
    let parent_path = validate_public_rel_path(&args.parent_path, true)?;
    ensure_inside(Path::new(&space), &parent_path)?;
    crate::git::access::require_repository_mutation(app, Path::new(&space)).await?;
    let result = content_tree::reorder_content(&space, &parent_path, args.ordered_children)?;
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

pub(super) async fn reorder_spaces(
    app: &AppHandle,
    args: ReorderSpacesArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let context = active_context(app)?;
    if args.ordered_space_ids.iter().any(|id| is_root_space_id(id)) {
        return Err(McpBusinessError::new(
            "INVALID_SPACE_ORDER",
            "the root space is pinned and must not be included",
        ));
    }
    crate::git::access::require_repository_mutation(app, Path::new(&context.project_path)).await?;
    let outcome = content_tree::reorder_child_spaces(
        Path::new(&context.project_path),
        args.ordered_space_ids,
    )?;
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

pub(super) async fn convert_page_to_leaf(
    app: &AppHandle,
    args: PathArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (context, space) = resolve_space(app, args.space_id.clone()).await?;
    let path = validate_markdown_path(&args.path)?;
    ensure_inside(Path::new(&space), &path)?;
    require_standalone_page(&space, &path)?;
    let before = snapshot_structural_paths(Path::new(&space))?;
    let before_project = snapshot_structural_paths(Path::new(&context.project_path))?;
    let index_state = app.state::<IndexState>();
    let page = crate::structure::convert_to_leaf(
        &space,
        &path,
        Some(context.project_path.as_str()),
        &index_state,
        &app.state::<IndexUpdateState>(),
        None,
    )
    .await?;
    let changed_paths = changed_structural_paths(before, Path::new(&space))?;
    let affected_project_paths =
        changed_structural_paths(before_project, Path::new(&context.project_path))?;
    let mut result = structural_operation_result(
        "Converted directory-backed Page to leaf Page",
        &path,
        &page.path,
        changed_paths,
        affected_project_paths,
    );
    if let Some(structured_content) = result.structured_content.as_mut() {
        structured_content["page"] = json!(page);
    }
    Ok(result)
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
        .filter(|path| path.ends_with(".svode/order.json"))
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

fn collection_conversion_result(
    conversion: crate::structure::ConvertToCollectionOutcome,
    changed_paths: Vec<String>,
    affected_project_paths: Vec<String>,
) -> ToolCallResult {
    let order_paths = affected_project_paths
        .iter()
        .filter(|path| path.ends_with(".svode/order.json"))
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
    let old_path = conversion.old_path;
    let collection_path = conversion.collection_path;
    let readme_path = conversion.readme_path;
    let schema_path = conversion.schema_path;
    let index_paths = vec![old_path.clone(), readme_path.clone()];
    let warnings = conversion.entry.warnings.clone();

    ToolCallResult::ok(
        format!("Converted {} to collection {}.", old_path, collection_path),
        json!({
            "oldPath": old_path,
            "collectionPath": collection_path,
            "readmePath": readme_path,
            "schemaPath": schema_path,
            "collection": conversion.entry,
            "changedPaths": changed_paths,
            "affectedProjectPaths": affected_project_paths,
            "touchedPaths": {
                "backlinks": markdown_paths,
                "relations": relation_paths,
                "order": order_paths,
                "index": index_paths,
            },
            "warnings": warnings,
        }),
    )
}

pub(super) fn collection_conversion_error(error: crate::AppError) -> McpBusinessError {
    match error {
        crate::AppError::General(message) => McpBusinessError::new(
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

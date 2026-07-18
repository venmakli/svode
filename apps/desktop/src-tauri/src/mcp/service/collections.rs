use super::*;

pub(super) async fn create_collection(
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
    let conversion = files_commands::convert_to_collection_shared(
        &space,
        &path,
        Some(context.project_path.as_str()),
        &index_state,
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

pub(super) async fn list_collections(
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

pub(super) async fn get_collection_schema(
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

pub(super) async fn query_entries(
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

pub(super) async fn create_entry(
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

pub(super) async fn update_entry_fields(
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

pub(super) async fn update_entry_body(
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

pub(super) async fn delete_entry(
    app: &AppHandle,
    args: PathArgs,
) -> Result<ToolCallResult, McpBusinessError> {
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

pub(super) async fn rename_entry(
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

pub(super) async fn move_entry(
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

pub(super) async fn reorder_entries(
    app: &AppHandle,
    args: ReorderEntriesArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (_context, space) = resolve_space(app, args.space_id).await?;
    let parent_path = validate_public_rel_path(&args.parent_path, true)?;
    ensure_inside(Path::new(&space), &parent_path)?;
    let result =
        files_commands::reorder_entries_shared(&space, &parent_path, args.ordered_children)?;
    Ok(ToolCallResult::ok(
        format!("Reordered {} direct children.", result.previous_order.len()),
        json!({
            "parentPath": result.parent_path,
            "previousOrder": result.previous_order,
            "orderedChildren": result.ordered_children,
            "changedPaths": [".svode/order.json"],
        }),
    ))
}

pub(super) async fn reorder_spaces(
    app: &AppHandle,
    args: ReorderSpacesArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let context = active_context(app)?;
    if args
        .ordered_space_ids
        .iter()
        .any(|id| is_mcp_root_space_id(id))
    {
        return Err(McpBusinessError::new(
            "INVALID_SPACE_ORDER",
            "the root space is pinned and must not be included",
        ));
    }
    let previous_order = project::list_spaces(Path::new(&context.project_path))?
        .into_iter()
        .map(|space| space.id)
        .collect::<Vec<_>>();
    project::reorder_spaces(
        Path::new(&context.project_path),
        args.ordered_space_ids.clone(),
    )?;
    Ok(ToolCallResult::ok(
        format!("Reordered {} child spaces.", args.ordered_space_ids.len()),
        json!({
            "previousOrder": previous_order,
            "orderedSpaceIds": args.ordered_space_ids,
            "changedPaths": [".svode/config.json"],
        }),
    ))
}

pub(super) async fn unnest_entry(
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
pub(super) async fn convert_to_leaf(
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

pub(super) async fn validate_collection_integrity(
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
    conversion: files_commands::ConvertToCollectionCommandResult,
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
            "entry": conversion.entry,
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
        crate::AppError::General(message) => {
            McpBusinessError::new("INVALID_COLLECTION_CONVERSION", message)
        }
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

pub(super) async fn add_collection_column(
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

pub(super) async fn update_collection_column(
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

pub(super) async fn delete_collection_column(
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

pub(super) async fn add_collection_view(
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

pub(super) async fn update_collection_view(
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

pub(super) async fn delete_collection_view(
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

use super::*;

pub(super) async fn list_pages(
    app: &AppHandle,
    args: ListPagesArgs,
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
        format!("Found {total} Page-tree items."),
        json!({ "items": items, "total": total, "limit": limit, "offset": start }),
    ))
}

pub(super) async fn read_page(
    app: &AppHandle,
    args: PathArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let (context, space) = resolve_space(app, args.space_id.clone()).await?;
    let path = validate_markdown_path(&args.path)?;
    ensure_inside(Path::new(&space), &path)?;
    require_standalone_page(&space, &path)?;
    let mut page = entry::read(&space, &path)?;
    apply_indexed_entry_dates(
        app,
        &context,
        args.space_id.as_deref(),
        &space,
        &path,
        &mut page,
    )
    .await;
    Ok(ToolCallResult::ok(
        format!("Read Page {path}."),
        json!({ "page": page }),
    ))
}

pub(super) async fn write_page(
    app: &AppHandle,
    args: WritePageArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (context, space) = resolve_space(app, args.space_id).await?;
    let path = validate_markdown_path(&args.path)?;
    ensure_inside(Path::new(&space), &path)?;
    require_standalone_page(&space, &path)?;
    let result = match write_page_content(
        app,
        &context,
        &space,
        &path,
        &args.content,
        args.title.as_deref(),
    )
    .await
    {
        Ok(result) => result,
        Err(crate::error::AppError::DocumentNameConflict(conflict)) => {
            return Ok(page_name_conflict_result(conflict));
        }
        Err(error) => return Err(error.into()),
    };
    Ok(ToolCallResult::ok(
        format!("Updated Page {path}."),
        page_write_response(&space, &path, result),
    ))
}

pub(super) async fn create_page(
    app: &AppHandle,
    args: CreatePageArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (context, space) = resolve_space(app, args.space_id).await?;
    let parent_path = validate_public_rel_path(&args.parent_path, true)?;
    ensure_inside(Path::new(&space), &parent_path)?;
    let authorization_space = space.clone();
    let outcome = match crate::page::create::create(
        crate::page::create::PageCreate {
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
            project: Some(context.project_path.clone()),
        },
        &app.state::<IndexState>(),
        &app.state::<IndexUpdateState>(),
        |mut paths| async move {
            paths.push(PathBuf::from(&authorization_space));
            crate::git::access::require_repository_mutation_paths(app, paths.clone()).await?;
            Ok(paths)
        },
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(error) => {
            return match error {
                crate::error::AppError::DocumentNameConflict(conflict) => {
                    Ok(page_name_conflict_result(conflict))
                }
                error => Err(error.into()),
            };
        }
    };
    let changed_paths =
        crate::page::metadata::relative_changed_paths(&space, &outcome.changed_paths);
    let warnings = outcome.page.warnings.clone();
    Ok(ToolCallResult::ok(
        format!("Created Page {}.", outcome.page.path),
        json!({ "path": outcome.page.path, "page": outcome.page, "changedPaths": changed_paths, "warnings": warnings }),
    ))
}

pub(super) async fn update_page_metadata(
    app: &AppHandle,
    args: UpdatePageMetadataArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (context, space) = resolve_space(app, args.space_id).await?;
    let path = validate_markdown_path(&args.path)?;
    ensure_inside(Path::new(&space), &path)?;
    require_standalone_page(&space, &path)?;
    let outcome = match patch_page_metadata(
        app,
        &context,
        &space,
        &path,
        args.title,
        args.icon,
        args.description,
        args.cover,
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(crate::error::AppError::DocumentNameConflict(conflict)) => {
            return Ok(page_name_conflict_result(conflict));
        }
        Err(error) => return Err(error.into()),
    };
    let changed_paths =
        crate::page::metadata::relative_changed_paths(&space, &outcome.changed_paths);
    let warnings = outcome.page.warnings.clone();
    Ok(ToolCallResult::ok(
        format!("Updated metadata for {path}."),
        json!({ "page": outcome.page, "changedPaths": changed_paths, "warnings": warnings }),
    ))
}

pub(super) async fn read_space_readme(
    app: &AppHandle,
    args: SpaceArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let (context, space) = resolve_space(app, args.space_id.clone()).await?;
    let path = "README.md".to_string();
    ensure_inside(Path::new(&space), &path)?;
    require_owner(&space, &path, ContentOwnerKind::Space)?;
    let mut readme = entry::read(&space, &path)?;
    apply_indexed_entry_dates(
        app,
        &context,
        args.space_id.as_deref(),
        &space,
        &path,
        &mut readme,
    )
    .await;
    Ok(ToolCallResult::ok(
        "Read Space README.",
        json!({ "spaceReadme": readme }),
    ))
}

pub(super) async fn write_space_readme(
    app: &AppHandle,
    args: WriteSpaceReadmeArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (context, space) = resolve_space(app, args.space_id).await?;
    let path = "README.md".to_string();
    ensure_inside(Path::new(&space), &path)?;
    require_owner(&space, &path, ContentOwnerKind::Space)?;
    let result = write_page_content(
        app,
        &context,
        &space,
        &path,
        &args.content,
        args.title.as_deref(),
    )
    .await?;
    Ok(ToolCallResult::ok(
        "Updated Space README.",
        page_write_response(&space, &path, result),
    ))
}

pub(super) async fn update_space_metadata(
    app: &AppHandle,
    args: UpdateSpaceMetadataArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (context, space) = resolve_space(app, args.space_id).await?;
    let path = "README.md".to_string();
    ensure_inside(Path::new(&space), &path)?;
    require_owner(&space, &path, ContentOwnerKind::Space)?;
    let outcome = patch_page_metadata(
        app,
        &context,
        &space,
        &path,
        args.title,
        args.icon,
        args.description,
        args.cover,
    )
    .await?;
    let changed_paths =
        crate::page::metadata::relative_changed_paths(&space, &outcome.changed_paths);
    let warnings = outcome.page.warnings.clone();
    Ok(ToolCallResult::ok(
        "Updated Space metadata.",
        json!({ "spaceReadme": outcome.page, "changedPaths": changed_paths, "warnings": warnings }),
    ))
}

pub(super) async fn read_collection_readme(
    app: &AppHandle,
    args: CollectionArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let (context, space) = resolve_space(app, args.space_id.clone()).await?;
    let collection_path = validate_public_rel_path(&args.collection_path, true)?;
    let path = collection_readme_path(&collection_path);
    ensure_inside(Path::new(&space), &path)?;
    require_owner(&space, &path, ContentOwnerKind::Collection)?;
    let mut readme = entry::read(&space, &path)?;
    apply_indexed_entry_dates(
        app,
        &context,
        args.space_id.as_deref(),
        &space,
        &path,
        &mut readme,
    )
    .await;
    Ok(ToolCallResult::ok(
        format!("Read Collection README for {collection_path}."),
        json!({ "collectionPath": collection_path, "collectionReadme": readme }),
    ))
}

pub(super) async fn write_collection_readme(
    app: &AppHandle,
    args: WriteCollectionReadmeArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (context, space) = resolve_space(app, args.space_id).await?;
    let collection_path = validate_public_rel_path(&args.collection_path, true)?;
    let path = collection_readme_path(&collection_path);
    ensure_inside(Path::new(&space), &path)?;
    require_owner(&space, &path, ContentOwnerKind::Collection)?;
    let result = write_page_content(
        app,
        &context,
        &space,
        &path,
        &args.content,
        args.title.as_deref(),
    )
    .await?;
    let mut response = page_write_response(&space, &path, result);
    response["collectionPath"] = json!(
        Path::new(response["path"].as_str().unwrap())
            .parent()
            .unwrap_or(Path::new(""))
            .to_string_lossy()
    );
    Ok(ToolCallResult::ok(
        format!("Updated Collection README for {collection_path}."),
        response,
    ))
}

pub(super) async fn update_collection_metadata(
    app: &AppHandle,
    args: UpdateCollectionMetadataArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (context, space) = resolve_space(app, args.space_id).await?;
    let collection_path = validate_public_rel_path(&args.collection_path, true)?;
    let path = collection_readme_path(&collection_path);
    ensure_inside(Path::new(&space), &path)?;
    require_owner(&space, &path, ContentOwnerKind::Collection)?;
    let outcome = patch_page_metadata(
        app,
        &context,
        &space,
        &path,
        args.title,
        args.icon,
        args.description,
        args.cover,
    )
    .await?;
    let collection_path = Path::new(&outcome.page.path)
        .parent()
        .unwrap_or(Path::new(""))
        .to_string_lossy()
        .replace('\\', "/");
    let changed_paths =
        crate::page::metadata::relative_changed_paths(&space, &outcome.changed_paths);
    let warnings = outcome.page.warnings.clone();
    Ok(ToolCallResult::ok(
        format!("Updated Collection metadata for {collection_path}."),
        json!({ "collectionPath": collection_path, "collectionReadme": outcome.page, "changedPaths": changed_paths, "warnings": warnings }),
    ))
}

pub(super) async fn patch_page_metadata(
    app: &AppHandle,
    context: &ActiveProjectContext,
    space: &str,
    path: &str,
    title: Option<String>,
    icon: Option<Option<String>>,
    description: Option<Option<String>>,
    cover: Option<Option<entry::Cover>>,
) -> Result<crate::page::metadata::PageMetadataOutcome, crate::error::AppError> {
    let state = app.state::<IndexState>();
    let updates = app.state::<IndexUpdateState>();
    let nonces = app.state::<std::sync::Arc<crate::files::WriteNonceRegistry>>();
    crate::page::metadata::patch(
        space,
        path,
        crate::page::metadata::PageMetadataPatch {
            title,
            icon,
            description,
            cover,
        },
        Some(&context.project_path),
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

fn page_name_conflict_result(
    conflict: crate::files::naming::DocumentNameConflict,
) -> ToolCallResult {
    let message = "Page name is already used in this container";
    ToolCallResult {
        content: vec![crate::mcp::protocol::ContentBlock::text(message)],
        structured_content: Some(json!({
            "error": {
                "code": "PAGE_NAME_CONFLICT",
                "message": message,
                "parentPath": conflict.parent_path,
                "conflicts": conflict.conflicts,
            }
        })),
        is_error: true,
    }
}

pub(super) async fn import_asset(
    app: &AppHandle,
    args: ImportAssetArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (context, space) = resolve_space(app, args.space_id.clone()).await?;
    let content_path = validate_markdown_path(&args.content_path)?;
    ensure_inside(Path::new(&space), &content_path)?;
    let index_state = app.state::<IndexState>();
    let index_updates = app.state::<IndexUpdateState>();
    let selected_space_id = args
        .space_id
        .as_deref()
        .filter(|space_id| !is_mcp_root_space_id(space_id));
    let plan = crate::attachments::managed_import::plan_managed_import(
        &index_state,
        Path::new(&context.project_path),
        selected_space_id,
        &content_path,
        Path::new(&args.source_path),
        args.file_name.as_deref(),
    )
    .await?;
    let result = crate::attachments::managed_import::execute_managed_import(
        app,
        &index_state,
        &index_updates,
        None,
        crate::attachments::managed_import::MutationOrigin::Mcp,
        plan,
    )
    .await?;
    let owner_space_id = args
        .space_id
        .unwrap_or_else(|| active_mcp_space_id(&context));

    Ok(ToolCallResult::ok(
        format!(
            "Imported asset {} for content {content_path}.",
            result.file_name
        ),
        json!({
            "spaceId": owner_space_id,
            "contentPath": result.content_path,
            "attachmentPath": result.attachment_path,
            "markdownUrl": result.markdown_url,
            "coverPath": result.cover_path,
            "fileName": result.file_name,
            "mime": result.mime,
            "sizeBytes": result.size_bytes,
            "changedPaths": result.changed_paths,
        }),
    ))
}

pub(super) async fn search_pages(
    app: &AppHandle,
    args: SearchArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let (context, _) = resolve_space(app, args.space_id.clone()).await?;
    let state = app.state::<IndexState>();
    let key = index_key_for_context(&context, args.space_id.as_deref());
    let limit = clamp_limit(args.limit);
    let start = offset(args.offset);
    let response = crate::index::service::search_content(
        &state,
        PathBuf::from(&context.project_path),
        args.query,
        None,
        None,
        Some(crate::index::service::SearchScope::Space {
            space_id: IndexState::space_id_for_key(&key),
        }),
        Some(limit.saturating_add(start as i64)),
    )
    .await?;
    let total = response.items.len();
    let results = response
        .items
        .into_iter()
        .skip(start)
        .take(limit as usize)
        .collect::<Vec<_>>();
    Ok(ToolCallResult::ok(
        format!("Found {} matching Pages.", results.len()),
        json!({ "items": results, "total": total, "limit": limit, "offset": start }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_conflict_result_preserves_container_and_conflicting_page_evidence() {
        let result = page_name_conflict_result(crate::files::naming::DocumentNameConflict {
            parent_path: Some("docs".to_string()),
            conflicts: vec![crate::files::naming::DocumentNameConflictEvidence {
                path: "docs/existing.md".to_string(),
                title: "Existing".to_string(),
            }],
        });

        assert!(result.is_error);
        let error = &result.structured_content.unwrap()["error"];
        assert_eq!(error["code"], "PAGE_NAME_CONFLICT");
        assert_eq!(error["parentPath"], "docs");
        assert_eq!(error["conflicts"][0]["path"], "docs/existing.md");
        assert_eq!(error["conflicts"][0]["title"], "Existing");
    }
}

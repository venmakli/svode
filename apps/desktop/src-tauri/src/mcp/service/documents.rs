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
    let (_, space) = resolve_space(app, args.space_id).await?;
    let path = validate_markdown_path(&args.path)?;
    ensure_inside(Path::new(&space), &path)?;
    require_standalone_page(&space, &path)?;
    let result = match entry::write(
        &space,
        &path,
        &args.content,
        args.title.as_deref(),
        None,
        None,
        None,
        None,
        true,
    ) {
        Ok(result) => result,
        Err(crate::error::AppError::DocumentNameConflict(conflict)) => {
            return Ok(page_name_conflict_result(conflict));
        }
        Err(error) => return Err(error.into()),
    };
    let changed = vec![result.new_path.clone().unwrap_or(path.clone())];
    Ok(ToolCallResult::ok(
        format!("Updated Page {path}."),
        json!({ "path": path, "newPath": result.new_path, "changedPaths": changed }),
    ))
}

pub(super) async fn create_page(
    app: &AppHandle,
    args: CreatePageArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (_, space) = resolve_space(app, args.space_id).await?;
    let path = normalize_create_page_path(&args.path)?;
    let abs = ensure_inside(Path::new(&space), &path)?;
    require_standalone_page(&space, &path)?;
    if abs.exists() {
        return Err(McpBusinessError::new(
            "FILE_ALREADY_EXISTS",
            format!("File already exists: {path}"),
        ));
    }
    let title = args.title.unwrap_or_else(|| {
        Path::new(&path)
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("Untitled")
            .replace(['-', '_'], " ")
    });
    let mutation = crate::files::naming::with_document_name_lock(&space, || {
        if abs.exists() {
            return Err(crate::error::AppError::FileAlreadyExists(path.clone()));
        }
        crate::files::naming::ensure_document_name_available(Path::new(&space), &path, &title)?;
        if let Some(parent) = abs.parent() {
            fs::create_dir_all(parent)?;
        }
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
        Ok(())
    });
    if let Err(error) = mutation {
        return match error {
            crate::error::AppError::DocumentNameConflict(conflict) => {
                Ok(page_name_conflict_result(conflict))
            }
            error => Err(error.into()),
        };
    }
    Ok(ToolCallResult::ok(
        format!("Created Page {path}."),
        json!({ "path": path, "changedPaths": [path] }),
    ))
}

pub(super) async fn update_page_metadata(
    app: &AppHandle,
    args: UpdatePageMetadataArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (_, space) = resolve_space(app, args.space_id).await?;
    let path = validate_markdown_path(&args.path)?;
    ensure_inside(Path::new(&space), &path)?;
    require_standalone_page(&space, &path)?;
    let page = match crate::files::naming::with_document_name_lock(&space, || {
        write_metadata_frontmatter(
            &space,
            &path,
            args.title,
            args.icon,
            args.description,
            args.cover,
        )
    }) {
        Ok(page) => page,
        Err(crate::error::AppError::DocumentNameConflict(conflict)) => {
            return Ok(page_name_conflict_result(conflict));
        }
        Err(error) => return Err(error.into()),
    };
    Ok(ToolCallResult::ok(
        format!("Updated metadata for {path}."),
        json!({ "page": page, "changedPaths": [path] }),
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
    let (_, space) = resolve_space(app, args.space_id).await?;
    let path = "README.md".to_string();
    ensure_inside(Path::new(&space), &path)?;
    require_owner(&space, &path, ContentOwnerKind::Space)?;
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
    Ok(ToolCallResult::ok(
        "Updated Space README.",
        json!({ "path": path, "newPath": result.new_path, "changedPaths": [path] }),
    ))
}

pub(super) async fn update_space_metadata(
    app: &AppHandle,
    args: UpdateSpaceMetadataArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (_, space) = resolve_space(app, args.space_id).await?;
    let path = "README.md".to_string();
    ensure_inside(Path::new(&space), &path)?;
    require_owner(&space, &path, ContentOwnerKind::Space)?;
    let readme = write_metadata_frontmatter(
        &space,
        &path,
        args.title,
        args.icon,
        args.description,
        args.cover,
    )?;
    Ok(ToolCallResult::ok(
        "Updated Space metadata.",
        json!({ "spaceReadme": readme, "changedPaths": [path] }),
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
    let (_, space) = resolve_space(app, args.space_id).await?;
    let collection_path = validate_public_rel_path(&args.collection_path, true)?;
    let path = collection_readme_path(&collection_path);
    ensure_inside(Path::new(&space), &path)?;
    require_owner(&space, &path, ContentOwnerKind::Collection)?;
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
    Ok(ToolCallResult::ok(
        format!("Updated Collection README for {collection_path}."),
        json!({ "collectionPath": collection_path, "path": path, "newPath": result.new_path, "changedPaths": [path] }),
    ))
}

pub(super) async fn update_collection_metadata(
    app: &AppHandle,
    args: UpdateCollectionMetadataArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (_, space) = resolve_space(app, args.space_id).await?;
    let collection_path = validate_public_rel_path(&args.collection_path, true)?;
    let path = collection_readme_path(&collection_path);
    ensure_inside(Path::new(&space), &path)?;
    require_owner(&space, &path, ContentOwnerKind::Collection)?;
    let readme = write_metadata_frontmatter(
        &space,
        &path,
        args.title,
        args.icon,
        args.description,
        args.cover,
    )?;
    Ok(ToolCallResult::ok(
        format!("Updated Collection metadata for {collection_path}."),
        json!({ "collectionPath": collection_path, "collectionReadme": readme, "changedPaths": [path] }),
    ))
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

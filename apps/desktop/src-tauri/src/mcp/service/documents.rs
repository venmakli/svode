use super::*;

pub(super) async fn list_documents(
    app: &AppHandle,
    args: ListDocumentsArgs,
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
        format!("Found {total} documents."),
        json!({ "items": items, "total": total, "limit": limit, "offset": start }),
    ))
}

pub(super) async fn read_document(
    app: &AppHandle,
    args: PathArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let (context, space) = resolve_space(app, args.space_id.clone()).await?;
    let path = validate_document_path(&args.path)?;
    ensure_inside(Path::new(&space), &path)?;
    let mut entry = entry::read(&space, &path)?;
    apply_indexed_entry_dates(
        app,
        &context,
        args.space_id.as_deref(),
        &space,
        &path,
        &mut entry,
    )
    .await;
    Ok(ToolCallResult::ok(
        format!("Read document {path}."),
        json!({ "document": entry }),
    ))
}

pub(super) async fn write_document(
    app: &AppHandle,
    args: WriteDocumentArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (_, space) = resolve_space(app, args.space_id).await?;
    let path = validate_document_path(&args.path)?;
    ensure_inside(Path::new(&space), &path)?;
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
    let changed = vec![result.new_path.clone().unwrap_or(path.clone())];
    Ok(ToolCallResult::ok(
        format!("Updated document {path}."),
        json!({ "path": path, "newPath": result.new_path, "changedPaths": changed }),
    ))
}

pub(super) async fn create_document(
    app: &AppHandle,
    args: CreateDocumentArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (_, space) = resolve_space(app, args.space_id).await?;
    let path = normalize_create_document_path(&args.path)?;
    let abs = ensure_inside(Path::new(&space), &path)?;
    if abs.exists() {
        return Err(McpBusinessError::new(
            "FILE_ALREADY_EXISTS",
            format!("File already exists: {path}"),
        ));
    }
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent)?;
    }
    let title = args.title.unwrap_or_else(|| {
        Path::new(&path)
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("Untitled")
            .replace(['-', '_'], " ")
    });
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
    Ok(ToolCallResult::ok(
        format!("Created document {path}."),
        json!({ "path": path, "changedPaths": [path] }),
    ))
}

pub(super) async fn update_document_metadata(
    app: &AppHandle,
    args: UpdateDocumentMetadataArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (_, space) = resolve_space(app, args.space_id).await?;
    let path = validate_document_path(&args.path)?;
    ensure_inside(Path::new(&space), &path)?;
    let document = write_metadata_frontmatter(
        &space,
        &path,
        args.title,
        args.icon,
        args.description,
        args.cover,
    )?;
    Ok(ToolCallResult::ok(
        format!("Updated metadata for {path}."),
        json!({ "document": document, "changedPaths": [path] }),
    ))
}

pub(super) async fn import_asset(
    app: &AppHandle,
    args: ImportAssetArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let _policy = MCP_MUTATION_POLICY;
    let (context, space) = resolve_space(app, args.space_id.clone()).await?;
    let document_path = validate_document_path(&args.document_path)?;
    let document_abs = ensure_inside(Path::new(&space), &document_path)?;
    let document_metadata = fs::metadata(&document_abs).map_err(|error| {
        McpBusinessError::new(
            "DOCUMENT_NOT_FOUND",
            format!("documentPath must be an existing markdown document: {error}"),
        )
    })?;
    if !document_metadata.is_file() {
        return Err(McpBusinessError::new(
            "INVALID_DOCUMENT_PATH",
            "documentPath must reference an existing markdown file, including a collection README.md when applicable",
        ));
    }

    let source_path = validate_regular_source_path(&args.source_path)?;
    let file_name = args.file_name.unwrap_or_else(|| {
        source_path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "file".to_string())
    });

    let index_state = app.state::<IndexState>();
    let requested_key = index_key_for_context(&context, args.space_id.as_deref());
    let scope = resolve_effective_storage_scope_for_key(
        &index_state,
        Path::new(&context.project_path),
        requested_key,
    )
    .await?;
    let pool = index_state.get_or_create(&scope.pool_key).await?;
    let scoped_document_id =
        document_id_for_asset_scope(&document_abs, &scope.pool_dir, &document_path);
    let asset = assets::import_file(
        &pool,
        &scope.pool_dir,
        &source_path,
        &file_name,
        Some(&scoped_document_id),
    )
    .await?;

    let asset_abs = scope.pool_dir.join(&asset.rel_path);
    let (markdown_url, cover_path) =
        asset_reference_paths(&document_abs, Path::new(&space), &asset_abs);
    let owner_space_id = IndexState::space_id_for_key(&scope.pool_key)
        .unwrap_or_else(|| MCP_ROOT_SPACE_ID.to_string());

    Ok(ToolCallResult::ok(
        format!(
            "Imported asset {} for document {document_path}.",
            asset.file_name
        ),
        json!({
            "spaceId": owner_space_id,
            "assetPath": asset.rel_path,
            "markdownUrl": markdown_url,
            "coverPath": cover_path,
            "fileName": asset.file_name,
            "mime": asset.mime,
            "sizeBytes": asset.size_bytes,
            "changedPaths": [asset.rel_path],
        }),
    ))
}

pub(super) async fn search_documents(
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
        format!("Found {} matching documents.", results.len()),
        json!({ "items": results, "total": total, "limit": limit, "offset": start }),
    ))
}

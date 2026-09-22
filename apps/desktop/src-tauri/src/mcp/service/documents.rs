use super::*;

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
        .filter(|space_id| !is_root_space_id(space_id));
    let plan = crate::attachments::import::plan_managed_import(
        &index_state,
        Path::new(&context.project_path),
        selected_space_id,
        &content_path,
        Path::new(&args.source_path),
        args.file_name.as_deref(),
    )
    .await?;
    let result = crate::attachments::import::execute_managed_import(
        &app.state::<GitState>(),
        &index_state,
        &index_updates,
        None,
        crate::attachments::import::MutationOrigin::Mcp,
        plan,
    )
    .await?;
    crate::attachments::delivery::emit_managed_import_invalidations(app, &result.delivery);
    let owner_space_id = args
        .space_id
        .unwrap_or_else(|| default_space_id(&request_target(&context)));

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

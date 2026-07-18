use super::*;

pub(super) async fn get_project_info(app: &AppHandle) -> Result<ToolCallResult, McpBusinessError> {
    let context = active_context(app)?;
    let project_path = Path::new(&context.project_path);
    let spaces = mcp_spaces_payload(project_path)?;
    let cfg = space_config::read_space_config(Path::new(&context.project_path))?;
    let structured = json!({
        "projectPath": context.project_path,
        "rootSpaceId": MCP_ROOT_SPACE_ID,
        "activeSpaceId": context.active_space_id,
        "activeMcpSpaceId": active_mcp_space_id(&context),
        "activeSpacePath": context.active_space_path,
        "projectName": cfg.name,
        "spaces": spaces,
        "spaceAddressing": {
            "root": MCP_ROOT_SPACE_ID,
            "null": "active/default space"
        },
        "capabilities": {
            "documents": true,
            "collections": true,
            "gitStatus": true,
            "commitChanges": false,
            "autocommit": false
        }
    });
    Ok(ToolCallResult::ok(
        "Active Svode project information.",
        structured,
    ))
}
pub(super) async fn list_spaces(app: &AppHandle) -> Result<ToolCallResult, McpBusinessError> {
    let context = active_context(app)?;
    let spaces = mcp_spaces_payload(Path::new(&context.project_path))?;
    let structured = json!({
        "rootSpaceId": MCP_ROOT_SPACE_ID,
        "activeSpaceId": context.active_space_id,
        "activeMcpSpaceId": active_mcp_space_id(&context),
        "spaceAddressing": {
            "root": MCP_ROOT_SPACE_ID,
            "null": "active/default space"
        },
        "spaces": spaces
    });
    Ok(ToolCallResult::ok(
        format!("Found {} spaces.", spaces.len()),
        structured,
    ))
}

pub(super) async fn get_svode_guide() -> Result<ToolCallResult, McpBusinessError> {
    Ok(ToolCallResult::ok(
        "Svode MCP guide.",
        json!({ "guide": crate::mcp::tools::guide_text() }),
    ))
}

pub(super) async fn list_actors(
    app: &AppHandle,
    args: ListActorsArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let (_, space) = resolve_space(app, args.space_id).await?;
    let git_state = app.state::<GitState>();
    let cli = git::commands::require_cli(&git_state)?;
    let actor_catalog = app.state::<properties::ActorCatalogState>();
    let actors = properties::list_actors(
        &actor_catalog,
        &cli,
        Path::new(&space),
        args.all_time.unwrap_or(false),
    )
    .await?;
    Ok(ToolCallResult::ok(
        format!("Found {} actors.", actors.len()),
        json!({ "actors": actors }),
    ))
}

pub(super) async fn get_git_status(
    app: &AppHandle,
    args: SpaceArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let (_, space) = resolve_space(app, args.space_id).await?;
    let state = app.state::<GitState>();
    let cli = git::commands::require_cli(&state)?;
    let lock = state.get_lock(Path::new(&space)).await;
    let _guard = lock.lock().await;
    let status = git::ops::status(&cli, Path::new(&space)).await?;
    Ok(ToolCallResult::ok(
        "Git status for active Svode space.",
        json!({ "status": status }),
    ))
}

use super::*;

pub(super) async fn list_actors(
    app: &AppHandle,
    args: ListActorsArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let (_, space) = resolve_space(app, args.space_id).await?;
    let git_state = app.state::<GitState>();
    let cli = git::require_cli(&git_state)?;
    let actor_catalog = app.state::<crate::actors::ActorCatalogState>();
    let actors = read::actors(
        &actor_catalog,
        &cli,
        Path::new(&space),
        args.all_time.unwrap_or(false),
    )
    .await?;
    let actors = actors
        .into_iter()
        .map(|actor| {
            json!({
                "email": actor.email,
                "name": actor.name,
                "lastCommitAt": actor.last_commit_at,
                "commitCount": actor.commit_count,
                "isMe": actor.is_me,
            })
        })
        .collect::<Vec<_>>();
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
    let status = state.status(Path::new(&space), false).await?;
    Ok(ToolCallResult::ok(
        "Git status for active Svode space.",
        json!({ "status": status }),
    ))
}

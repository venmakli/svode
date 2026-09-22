use super::*;

pub async fn call_tool(app: AppHandle, name: &str, args: Value) -> ToolCallResult {
    call_tool_with_context(app, name, args, None).await
}

pub async fn call_tool_with_context(
    app: AppHandle,
    name: &str,
    args: Value,
    context_override: Option<IpcContextOverride>,
) -> ToolCallResult {
    let resolved_context =
        match super::context::resolve_context_override(&app, context_override.as_ref()) {
            Ok(context) => context,
            Err(error) => return ToolCallResult::business_error(error),
        };

    // Freeze the desktop active context for the whole request. Authorization
    // and the handler must resolve the same active Space even if the user
    // changes selection while the tool call is in flight.
    let request_context =
        freeze_request_context(resolved_context, &app.state::<ActiveProjectState>());

    let routine_caller =
        match resolve_routine_caller(&app, context_override.as_ref(), request_context.as_ref()) {
            Ok(provenance) => provenance,
            Err(error) => return ToolCallResult::business_error(error),
        };
    let target = request_context.as_ref().map(request_target);
    let host = DesktopMcpHost { app };
    let execute =
        async { svode_mcp::dispatch::call_tool(&host, target.as_ref(), name, args).await };
    MCP_ROUTINE_CALLER
        .scope(
            routine_caller,
            MCP_CONTEXT_OVERRIDE.scope(request_context, execute),
        )
        .await
}

/// Desktop host of the shared MCP mapping: active-context resolution happens
/// before dispatch, runtime handles come from managed state.
pub(crate) struct DesktopMcpHost {
    pub(crate) app: AppHandle,
}

impl svode_mcp::host::McpHost for DesktopMcpHost {
    fn version(&self) -> &str {
        env!("CARGO_PKG_VERSION")
    }

    fn serves_tool(&self, _name: &str) -> bool {
        true
    }

    async fn index_pool(
        &self,
        key: &svode_core::index::IndexKey,
        space_path: &Path,
    ) -> Option<sqlx::SqlitePool> {
        let state = self.app.state::<IndexState>();
        if let Ok(pool) = state.get_or_create(key).await {
            return Some(pool);
        }
        let fallback = state
            .key_for_space_dir(space_path)
            .await
            .unwrap_or_else(|| svode_core::index::IndexKey::Root(space_path.to_path_buf()));
        state.get_or_create(&fallback).await.ok()
    }

    async fn repository_access(
        &self,
        space_path: &Path,
    ) -> Result<svode_core::git::access::RepositoryAccessSnapshot, McpBusinessError> {
        crate::git::access::repository_access_snapshot(&self.app, space_path)
            .await
            .map_err(Into::into)
    }

    async fn require_mutation_access(&self, repository: &Path) -> Result<(), McpBusinessError> {
        crate::git::access::require_repository_mutation(&self.app, repository)
            .await
            .map(|_| ())
            .map_err(Into::into)
    }

    fn read_runtime(&self) -> svode_mcp::host::ReadRuntime<'_> {
        svode_mcp::host::ReadRuntime {
            index: &self.app.state::<IndexState>().inner().core,
            actors: self.app.state::<crate::actors::ActorCatalogState>().inner(),
            git: self.app.state::<GitState>().inner().runtime(),
        }
    }

    fn mutation_runtime(&self) -> svode_mcp::host::MutationRuntime<'_> {
        svode_mcp::host::MutationRuntime {
            index: &self.app.state::<IndexState>().inner().core,
            updates: self.app.state::<IndexUpdateState>().inner().core(),
            nonces: self
                .app
                .state::<std::sync::Arc<svode_core::page::nonce::WriteNonceRegistry>>()
                .inner(),
        }
    }

    async fn call_host_tool(
        &self,
        name: &str,
        args: Value,
    ) -> Result<ToolCallResult, McpBusinessError> {
        call_host_tool(self.app.clone(), name, args).await
    }
}

fn resolve_routine_caller(
    app: &AppHandle,
    context_override: Option<&IpcContextOverride>,
    request_context: Option<&ActiveProjectContext>,
) -> Result<Option<crate::terminal::RoutineMcpCallerProvenance>, McpBusinessError> {
    let Some(token) = context_override
        .and_then(|context| context.routine_caller_token.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let context = request_context.ok_or_else(|| {
        McpBusinessError::new(
            "ROUTINE_CALLER_PROVENANCE_INVALID",
            "routine caller provenance has no frozen Svode project context",
        )
    })?;
    app.state::<crate::terminal::TerminalManager>()
        .resolve_routine_mcp_caller(token, Path::new(&context.project_path))?
        .ok_or_else(|| {
            McpBusinessError::new(
                "ROUTINE_CALLER_PROVENANCE_INVALID",
                "routine caller provenance is not attached to a live managed Routine launch in this project",
            )
        })
        .map(Some)
}

fn freeze_request_context(
    resolved_context: Option<ActiveProjectContext>,
    active_state: &ActiveProjectState,
) -> Option<ActiveProjectContext> {
    resolved_context.or_else(|| active_state.get())
}

async fn call_host_tool(
    app: AppHandle,
    name: &str,
    args: Value,
) -> Result<ToolCallResult, McpBusinessError> {
    let authorized_paths = authorize_mutating_tool(&app, name, &args).await?;
    let execute = async {
        match name {
            "delete_page" => collections::delete_page(&app, decode(args)?).await,
            "import_asset" => documents::import_asset(&app, decode(args)?).await,
            "create_collection" => collections::create_collection(&app, decode(args)?).await,
            "convert_to_collection" => {
                collections::convert_to_collection(&app, decode(args)?).await
            }
            "list_routines" => routines::list_routines(&app, decode(args)?).await,
            "get_routine" => routines::get_routine(&app, decode(args)?).await,
            "create_routine" => routines::create_routine(&app, decode(args)?).await,
            "update_routine" => routines::update_routine(&app, decode(args)?).await,
            "delete_routine" => routines::delete_routine(&app, decode(args)?).await,
            "run_routine" => routines::run_routine(&app, decode(args)?).await,
            "delete_collection_item" => {
                collections::delete_collection_item(&app, decode(args)?).await
            }
            "delete_collection" => collections::delete_collection(&app, decode(args)?).await,
            "rename_content" => collections::rename_content(&app, decode(args)?).await,
            "move_content" => collections::move_content(&app, decode(args)?).await,
            "reorder_content" => collections::reorder_content(&app, decode(args)?).await,
            "reorder_spaces" => collections::reorder_spaces(&app, decode(args)?).await,
            "convert_page_to_leaf" => collections::convert_page_to_leaf(&app, decode(args)?).await,
            _ => Err(McpBusinessError::new(
                "UNKNOWN_TOOL",
                format!("unknown Svode MCP tool: {name}"),
            )),
        }
    };
    if let Some(paths) = authorized_paths {
        crate::git::access::scope_authorized_mutation_paths(paths, execute).await
    } else {
        execute.await
    }
}

async fn authorize_mutating_tool(
    app: &AppHandle,
    name: &str,
    args: &Value,
) -> Result<Option<Vec<PathBuf>>, McpBusinessError> {
    if svode_mcp::catalog::is_mutating_tool(name) != Some(true) {
        return Ok(None);
    }
    if matches!(name, "create_routine" | "update_routine" | "run_routine")
        && crate::mcp::service::routine_caller_provenance().is_some()
    {
        return Ok(None);
    }

    if name == "reorder_spaces" {
        let paths = vec![PathBuf::from(active_context(app)?.project_path)];
        crate::git::access::require_repository_mutation_paths(app, paths.clone()).await?;
        return Ok(Some(paths));
    }

    let requested_space_id = match args.get("spaceId") {
        None | Some(Value::Null) => None,
        Some(Value::String(space_id)) => Some(space_id.clone()),
        Some(_) => {
            return Err(McpBusinessError::new(
                "SERIALIZATION_ERROR",
                "spaceId must be a string or null",
            ));
        }
    };
    let (context, space) = resolve_space(app, requested_space_id.clone()).await?;
    let mut paths = vec![PathBuf::from(&space)];

    match name {
        "create_collection" => {
            let decoded: CreateCollectionArgs = decode(args.clone())?;
            let parent_path = validate_public_rel_path(&decoded.parent_path, true)?;
            paths.extend(crate::structure::collection_create_schema_paths(
                &space,
                (!parent_path.is_empty()).then_some(parent_path.as_str()),
                &decoded.title,
                schema_for_create_collection(&decoded),
                false,
                Some(&context.project_path),
            )?);
        }
        "import_asset" => {
            let decoded: ImportAssetArgs = decode(args.clone())?;
            let index_state = app.state::<IndexState>();
            let selected_space_id = requested_space_id
                .as_deref()
                .filter(|space_id| !is_root_space_id(space_id));
            let plan = crate::attachments::import::plan_managed_import(
                &index_state,
                Path::new(&context.project_path),
                selected_space_id,
                &decoded.content_path,
                Path::new(&decoded.source_path),
                decoded.file_name.as_deref(),
            )
            .await?;
            paths = plan.affected_paths().to_vec();
        }
        "delete_page" | "delete_collection_item" => {
            let decoded: PathArgs = decode(args.clone())?;
            let deleted = entry::planned_deleted_entry_paths(&space, &decoded.path)
                .map_err(AppError::from)?;
            paths.extend(
                engine::cascade_clean_deleted_entries_mutation_paths_with_project(
                    &space,
                    Some(&context.project_path),
                    &deleted,
                )
                .map_err(AppError::from)?,
            );
        }
        "delete_collection" => {
            let decoded: CollectionArgs = decode(args.clone())?;
            let path = collection_readme_path(&decoded.collection_path);
            let deleted =
                entry::planned_deleted_entry_paths(&space, &path).map_err(AppError::from)?;
            paths.extend(
                engine::cascade_clean_deleted_entries_mutation_paths_with_project(
                    &space,
                    Some(&context.project_path),
                    &deleted,
                )
                .map_err(AppError::from)?,
            );
        }
        "rename_content" => {
            let decoded: RenameContentArgs = decode(args.clone())?;
            extend_entry_move_plan(
                app,
                &context,
                &space,
                &decoded.from,
                &decoded.to,
                &mut paths,
            )
            .await?;
        }
        "move_content" => {
            let decoded: MoveContentArgs = decode(args.clone())?;
            let file_name = Path::new(&decoded.from)
                .file_name()
                .ok_or_else(|| McpBusinessError::new("INVALID_PATH", "invalid source path"))?
                .to_string_lossy();
            let to = if decoded.to_parent.is_empty() {
                file_name.to_string()
            } else {
                format!("{}/{file_name}", decoded.to_parent)
            };
            extend_entry_move_plan(app, &context, &space, &decoded.from, &to, &mut paths).await?;
        }
        "convert_page_to_leaf" => {
            let decoded: PathArgs = decode(args.clone())?;
            extend_backlink_plan(app, &context, &space, &decoded.path, false, &mut paths).await?;
        }
        "convert_to_collection" => {
            let decoded: PathArgs = decode(args.clone())?;
            let source = Path::new(&space).join(&decoded.path);
            if source.is_file()
                && !source
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.eq_ignore_ascii_case("README.md"))
            {
                extend_backlink_plan(app, &context, &space, &decoded.path, false, &mut paths)
                    .await?;
            }
        }
        _ => {}
    }

    paths.sort();
    paths.dedup();
    crate::git::access::require_repository_mutation_paths(app, paths.clone()).await?;
    Ok(Some(paths))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(space_id: &str) -> ActiveProjectContext {
        ActiveProjectContext {
            project_path: "/project".to_string(),
            active_space_id: Some(space_id.to_string()),
            active_space_path: format!("/project/{space_id}"),
        }
    }

    #[tokio::test]
    async fn desktop_selection_change_does_not_replace_frozen_request_context() {
        let state = ActiveProjectState::new();
        state.set(context("first"));
        let frozen = freeze_request_context(None, &state);

        MCP_CONTEXT_OVERRIDE
            .scope(frozen, async {
                state.set(context("second"));
                assert_eq!(
                    MCP_CONTEXT_OVERRIDE
                        .try_with(Clone::clone)
                        .unwrap()
                        .unwrap()
                        .active_space_id
                        .as_deref(),
                    Some("first")
                );
                assert_eq!(
                    state.get().unwrap().active_space_id.as_deref(),
                    Some("second")
                );
            })
            .await;
    }

    #[test]
    fn explicit_caller_context_wins_over_desktop_selection() {
        let state = ActiveProjectState::new();
        state.set(context("desktop"));

        let frozen = freeze_request_context(Some(context("caller")), &state).unwrap();

        assert_eq!(frozen.active_space_id.as_deref(), Some("caller"));
    }
}

async fn extend_entry_move_plan(
    app: &AppHandle,
    context: &ActiveProjectContext,
    space: &str,
    from: &str,
    to: &str,
    paths: &mut Vec<PathBuf>,
) -> Result<(), McpBusinessError> {
    paths.extend(
        crate::structure::move_mutation_paths(
            &app.state::<IndexState>(),
            space,
            Some(&context.project_path),
            from,
            to,
        )
        .await?,
    );
    Ok(())
}

async fn extend_backlink_plan(
    app: &AppHandle,
    context: &ActiveProjectContext,
    space: &str,
    from: &str,
    folder_rename: bool,
    paths: &mut Vec<PathBuf>,
) -> Result<(), McpBusinessError> {
    paths.extend(
        crate::structure::backlink_mutation_paths(
            &app.state::<IndexState>(),
            space,
            Some(&context.project_path),
            from,
            folder_rename,
        )
        .await?,
    );
    Ok(())
}

pub(super) fn decode<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, McpBusinessError> {
    serde_json::from_value(value).map_err(Into::into)
}

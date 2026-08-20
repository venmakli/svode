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
    let execute = async move {
        if let Some(context) = request_context {
            MCP_CONTEXT_OVERRIDE
                .scope(Some(context), call_tool_inner(app, name, args))
                .await
        } else {
            call_tool_inner(app, name, args).await
        }
    };

    match MCP_ROUTINE_CALLER.scope(routine_caller, execute).await {
        Ok(result) => result,
        Err(error) => ToolCallResult::business_error(error),
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

async fn call_tool_inner(
    app: AppHandle,
    name: &str,
    args: Value,
) -> Result<ToolCallResult, McpBusinessError> {
    let authorized_paths = authorize_mutating_tool(&app, name, &args).await?;
    let execute = async {
        match name {
            "get_project_info" => project_tools::get_project_info(&app).await,
            "list_spaces" => project_tools::list_spaces(&app).await,
            "list_documents" => documents::list_documents(&app, decode(args)?).await,
            "read_document" => documents::read_document(&app, decode(args)?).await,
            "write_document" => documents::write_document(&app, decode(args)?).await,
            "create_document" => documents::create_document(&app, decode(args)?).await,
            "update_document_metadata" => {
                documents::update_document_metadata(&app, decode(args)?).await
            }
            "import_asset" => documents::import_asset(&app, decode(args)?).await,
            "create_collection" => collections::create_collection(&app, decode(args)?).await,
            "convert_to_collection" => {
                collections::convert_to_collection(&app, decode(args)?).await
            }
            "search_documents" => documents::search_documents(&app, decode(args)?).await,
            "search_knowledge" => knowledge::search_knowledge(&app, decode(args)?).await,
            "get_knowledge_node" => knowledge::get_knowledge_node(&app, decode(args)?).await,
            "get_knowledge_neighbors" => {
                knowledge::get_knowledge_neighbors(&app, decode(args)?).await
            }
            "get_related_context" => knowledge::get_related_context(&app, decode(args)?).await,
            "get_knowledge_status" => knowledge::get_knowledge_status(&app, decode(args)?).await,
            "list_routines" => routines::list_routines(&app, decode(args)?).await,
            "get_routine" => routines::get_routine(&app, decode(args)?).await,
            "create_routine" => routines::create_routine(&app, decode(args)?).await,
            "update_routine" => routines::update_routine(&app, decode(args)?).await,
            "delete_routine" => routines::delete_routine(&app, decode(args)?).await,
            "run_routine" => routines::run_routine(&app, decode(args)?).await,
            "list_collections" => collections::list_collections(&app, decode(args)?).await,
            "get_collection_schema" => {
                collections::get_collection_schema(&app, decode(args)?).await
            }
            "query_entries" => collections::query_entries(&app, decode(args)?).await,
            "create_entry" => collections::create_entry(&app, decode(args)?).await,
            "update_entry_fields" => collections::update_entry_fields(&app, decode(args)?).await,
            "update_entry_body" => collections::update_entry_body(&app, decode(args)?).await,
            "delete_entry" => collections::delete_entry(&app, decode(args)?).await,
            "rename_entry" => collections::rename_entry(&app, decode(args)?).await,
            "move_entry" => collections::move_entry(&app, decode(args)?).await,
            "reorder_entries" => collections::reorder_entries(&app, decode(args)?).await,
            "reorder_spaces" => collections::reorder_spaces(&app, decode(args)?).await,
            "unnest_entry" => collections::unnest_entry(&app, decode(args)?).await,
            "convert_to_leaf" => collections::convert_to_leaf(&app, decode(args)?).await,
            "validate_collection_integrity" => {
                collections::validate_collection_integrity(&app, decode(args)?).await
            }
            "add_collection_column" => {
                collections::add_collection_column(&app, decode(args)?).await
            }
            "update_collection_column" => {
                collections::update_collection_column(&app, decode(args)?).await
            }
            "delete_collection_column" => {
                collections::delete_collection_column(&app, decode(args)?).await
            }
            "add_collection_view" => collections::add_collection_view(&app, decode(args)?).await,
            "update_collection_view" => {
                collections::update_collection_view(&app, decode(args)?).await
            }
            "delete_collection_view" => {
                collections::delete_collection_view(&app, decode(args)?).await
            }
            "list_actors" => project_tools::list_actors(&app, decode(args)?).await,
            "get_git_status" => project_tools::get_git_status(&app, decode(args)?).await,
            "get_svode_guide" => project_tools::get_svode_guide().await,
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
    if crate::mcp::tools::is_mutating_tool(name) != Some(true) {
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
        "import_asset" => {
            let requested_key = index_key_for_context(&context, requested_space_id.as_deref());
            let index_state = app.state::<IndexState>();
            paths = vec![
                resolve_effective_storage_scope_for_key(
                    &index_state,
                    Path::new(&context.project_path),
                    requested_key,
                )
                .await?
                .repo_dir,
            ];
        }
        "update_entry_fields" => {
            let decoded: UpdateFieldsArgs = decode(args.clone())?;
            let path = validate_document_path(&decoded.path)?;
            for (field, value) in decoded.fields {
                paths.extend(
                    properties::relation_entry_field_mutation_paths_with_project(
                        &space,
                        Some(&context.project_path),
                        &path,
                        &field,
                        json_to_yaml(value)?,
                    )?,
                );
            }
        }
        "create_entry" => {
            let decoded: CreateEntryArgs = decode(args.clone())?;
            if let Some(fields) = decoded.fields {
                for (field, value) in fields {
                    paths.extend(
                        properties::relation_field_target_mutation_paths_for_value_with_project(
                            &space,
                            Some(&context.project_path),
                            &decoded.collection_path,
                            &field,
                            json_to_yaml(value)?,
                        )?,
                    );
                }
            }
        }
        "delete_entry" => {
            let decoded: PathArgs = decode(args.clone())?;
            let deleted = entry::planned_deleted_entry_paths(&space, &decoded.path)?;
            paths.extend(
                properties::cascade_clean_deleted_entries_mutation_paths_with_project(
                    &space,
                    Some(&context.project_path),
                    &deleted,
                )?,
            );
        }
        "rename_entry" => {
            let decoded: RenameEntryArgs = decode(args.clone())?;
            extend_entry_move_plan(
                app,
                &context,
                &space,
                &decoded.from,
                &decoded.to,
                &mut paths,
                true,
            )
            .await?;
        }
        "move_entry" => {
            let decoded: MoveEntryArgs = decode(args.clone())?;
            let file_name = Path::new(&decoded.from)
                .file_name()
                .ok_or_else(|| McpBusinessError::new("INVALID_PATH", "invalid source path"))?
                .to_string_lossy();
            let to = if decoded.to_parent.is_empty() {
                file_name.to_string()
            } else {
                format!("{}/{file_name}", decoded.to_parent)
            };
            extend_entry_move_plan(app, &context, &space, &decoded.from, &to, &mut paths, true)
                .await?;
        }
        "unnest_entry" | "convert_to_leaf" => {
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
        "add_collection_column" => {
            let decoded: AddCollectionColumnArgs = decode(args.clone())?;
            paths.extend(properties::schema_column_mutation_paths_with_project(
                &space,
                &decoded.collection_path,
                &decoded.column,
                decoded.column.type_ == PropertyType::UniqueId,
                Some(&context.project_path),
            )?);
        }
        "update_collection_column" => {
            let decoded: UpdateCollectionColumnArgs = decode(args.clone())?;
            let patch = json_to_yaml(decoded.patch)?;
            paths.extend(properties::schema_column_name_mutation_paths_with_project(
                &space,
                &decoded.collection_path,
                &decoded.column_name,
                true,
                Some(&context.project_path),
            )?);
            paths.extend(
                properties::schema_column_patch_target_mutation_paths_with_project(
                    &space,
                    &decoded.collection_path,
                    &decoded.column_name,
                    &patch,
                    Some(&context.project_path),
                )?,
            );
        }
        "delete_collection_column" => {
            let decoded: DeleteCollectionColumnArgs = decode(args.clone())?;
            paths.extend(properties::schema_column_name_mutation_paths_with_project(
                &space,
                &decoded.collection_path,
                &decoded.column_name,
                decoded.delete_values.unwrap_or(false),
                Some(&context.project_path),
            )?);
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
    include_relations: bool,
) -> Result<(), McpBusinessError> {
    if include_relations {
        paths.extend(properties::relation_move_mutation_paths_with_project(
            space,
            Some(&context.project_path),
            from,
            to,
        )?);
    }
    extend_backlink_plan(
        app,
        context,
        space,
        from,
        Path::new(space).join(from).is_dir(),
        paths,
    )
    .await
}

async fn extend_backlink_plan(
    app: &AppHandle,
    context: &ActiveProjectContext,
    space: &str,
    from: &str,
    folder_rename: bool,
    paths: &mut Vec<PathBuf>,
) -> Result<(), McpBusinessError> {
    let index_state = app.state::<IndexState>();
    let target_space_id = index_state
        .key_for_space_dir(Path::new(space))
        .await
        .and_then(|key| IndexState::space_id_for_key(&key));
    let plan = if folder_rename {
        index_state
            .plan_links_on_folder_rename_project(
                Path::new(&context.project_path),
                target_space_id.as_deref(),
                from,
            )
            .await?
    } else {
        index_state
            .plan_links_on_rename_project(
                Path::new(&context.project_path),
                target_space_id.as_deref(),
                from,
            )
            .await?
    };
    paths.extend_from_slice(plan.mutation_paths());
    Ok(())
}

pub(super) fn decode<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, McpBusinessError> {
    serde_json::from_value(value).map_err(Into::into)
}

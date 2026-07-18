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

    if let Some(context) = resolved_context {
        return match MCP_CONTEXT_OVERRIDE
            .scope(Some(context), call_tool_inner(app, name, args))
            .await
        {
            Ok(result) => result,
            Err(error) => ToolCallResult::business_error(error),
        };
    }

    match call_tool_inner(app, name, args).await {
        Ok(result) => result,
        Err(error) => ToolCallResult::business_error(error),
    }
}

async fn call_tool_inner(
    app: AppHandle,
    name: &str,
    args: Value,
) -> Result<ToolCallResult, McpBusinessError> {
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
        "convert_to_collection" => collections::convert_to_collection(&app, decode(args)?).await,
        "search_documents" => documents::search_documents(&app, decode(args)?).await,
        "list_collections" => collections::list_collections(&app, decode(args)?).await,
        "get_collection_schema" => collections::get_collection_schema(&app, decode(args)?).await,
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
        "add_collection_column" => collections::add_collection_column(&app, decode(args)?).await,
        "update_collection_column" => {
            collections::update_collection_column(&app, decode(args)?).await
        }
        "delete_collection_column" => {
            collections::delete_collection_column(&app, decode(args)?).await
        }
        "add_collection_view" => collections::add_collection_view(&app, decode(args)?).await,
        "update_collection_view" => collections::update_collection_view(&app, decode(args)?).await,
        "delete_collection_view" => collections::delete_collection_view(&app, decode(args)?).await,
        "list_actors" => project_tools::list_actors(&app, decode(args)?).await,
        "get_git_status" => project_tools::get_git_status(&app, decode(args)?).await,
        "get_svode_guide" => project_tools::get_svode_guide().await,
        _ => Err(McpBusinessError::new(
            "UNKNOWN_TOOL",
            format!("unknown Svode MCP tool: {name}"),
        )),
    }
}

pub(super) fn decode<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, McpBusinessError> {
    serde_json::from_value(value).map_err(Into::into)
}

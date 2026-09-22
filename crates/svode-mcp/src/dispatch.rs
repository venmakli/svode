//! Execution of catalog tools against a host.

use serde::Deserialize;
use serde_json::Value;

use crate::control::check_tool;
use crate::error::McpBusinessError;
use crate::host::{McpHost, RequestTarget};
use crate::protocol::ToolCallResult;
use crate::tools::{apps, collections, content, import, pages, project, search, structure};

/// Executes one tool within a request target frozen by the host. `None`
/// means the host has no open project for this request.
pub async fn call_tool(
    host: &impl McpHost,
    target: Option<&RequestTarget>,
    name: &str,
    args: Value,
) -> ToolCallResult {
    match call(host, target, name, args).await {
        Ok(result) => result,
        Err(error) => ToolCallResult::business_error(error),
    }
}

async fn call(
    host: &impl McpHost,
    target: Option<&RequestTarget>,
    name: &str,
    args: Value,
) -> Result<ToolCallResult, McpBusinessError> {
    check_tool(host, name)?;
    match name {
        "get_svode_guide" => project::get_svode_guide(),
        "validate_app_manifest" => apps::validate_app_manifest(decode(args)?),
        "get_project_info" => project::get_project_info(host, require(target)?).await,
        "list_spaces" => project::list_spaces(host, require(target)?).await,
        "list_pages" => {
            let args = decode(args)?;
            content::list_pages(require(target)?, args)
        }
        "list_collections" => {
            let args = decode(args)?;
            content::list_collections(require(target)?, args)
        }
        "read_page" => {
            let args = decode(args)?;
            content::read_page(host, require(target)?, args).await
        }
        "read_space_readme" => {
            let args = decode(args)?;
            content::read_space_readme(host, require(target)?, args).await
        }
        "read_collection_readme" => {
            let args = decode(args)?;
            content::read_collection_readme(host, require(target)?, args).await
        }
        "read_collection_item" => {
            let args = decode(args)?;
            content::read_collection_item(host, require(target)?, args).await
        }
        "write_page" => {
            let args = decode(args)?;
            pages::write_page(host, require(target)?, args).await
        }
        "create_page" => {
            let args = decode(args)?;
            pages::create_page(host, require(target)?, args).await
        }
        "update_page_metadata" => {
            let args = decode(args)?;
            pages::update_page_metadata(host, require(target)?, args).await
        }
        "write_space_readme" => {
            let args = decode(args)?;
            pages::write_space_readme(host, require(target)?, args).await
        }
        "update_space_metadata" => {
            let args = decode(args)?;
            pages::update_space_metadata(host, require(target)?, args).await
        }
        "write_collection_readme" => {
            let args = decode(args)?;
            pages::write_collection_readme(host, require(target)?, args).await
        }
        "update_collection_metadata" => {
            let args = decode(args)?;
            pages::update_collection_metadata(host, require(target)?, args).await
        }
        "update_collection_item_fields" => {
            let args = decode(args)?;
            pages::update_collection_item_fields(host, require(target)?, args).await
        }
        "update_collection_item_body" => {
            let args = decode(args)?;
            pages::update_collection_item_body(host, require(target)?, args).await
        }
        "update_collection_item_metadata" => {
            let args = decode(args)?;
            pages::update_collection_item_metadata(host, require(target)?, args).await
        }
        "get_git_status" => {
            let args = decode(args)?;
            project::get_git_status(host, require(target)?, args).await
        }
        "get_collection_schema" => {
            let args = decode(args)?;
            collections::get_collection_schema(require(target)?, args)
        }
        "query_collection_items" => {
            let args = decode(args)?;
            collections::query_collection_items(host, require(target)?, args).await
        }
        "list_actors" => {
            let args = decode(args)?;
            collections::list_actors(host, require(target)?, args).await
        }
        "validate_collection_integrity" => {
            let args = decode(args)?;
            collections::validate_collection_integrity(require(target)?, args)
        }
        "add_collection_column" => {
            let args = decode(args)?;
            collections::add_collection_column(host, require(target)?, args).await
        }
        "update_collection_column" => {
            let args = decode(args)?;
            collections::update_collection_column(host, require(target)?, args).await
        }
        "delete_collection_column" => {
            let args = decode(args)?;
            collections::delete_collection_column(host, require(target)?, args).await
        }
        "add_collection_view" => {
            let args = decode(args)?;
            collections::add_collection_view(host, require(target)?, args).await
        }
        "update_collection_view" => {
            let args = decode(args)?;
            collections::update_collection_view(host, require(target)?, args).await
        }
        "delete_collection_view" => {
            let args = decode(args)?;
            collections::delete_collection_view(host, require(target)?, args).await
        }
        "search_pages" => {
            let args = decode(args)?;
            search::search_pages(host, require(target)?, args).await
        }
        "search_knowledge" => {
            let args = decode(args)?;
            search::search_knowledge(host, require(target)?, args).await
        }
        "get_knowledge_node" => {
            let args = decode(args)?;
            search::get_knowledge_node(host, require(target)?, args).await
        }
        "get_knowledge_neighbors" => {
            let args = decode(args)?;
            search::get_knowledge_neighbors(host, require(target)?, args).await
        }
        "get_related_context" => {
            let args = decode(args)?;
            search::get_related_context(host, require(target)?, args).await
        }
        "get_knowledge_status" => {
            let args = decode(args)?;
            search::get_knowledge_status(host, require(target)?, args).await
        }
        "create_collection" => {
            let args = decode(args)?;
            structure::create_collection(host, require(target)?, args).await
        }
        "convert_to_collection" => {
            let args = decode(args)?;
            structure::convert_to_collection(host, require(target)?, args).await
        }
        "convert_page_to_leaf" => {
            let args = decode(args)?;
            structure::convert_page_to_leaf(host, require(target)?, args).await
        }
        "delete_page" => {
            let args = decode(args)?;
            structure::delete_page(host, require(target)?, args).await
        }
        "delete_collection_item" => {
            let args = decode(args)?;
            structure::delete_collection_item(host, require(target)?, args).await
        }
        "delete_collection" => {
            let args = decode(args)?;
            structure::delete_collection(host, require(target)?, args).await
        }
        "rename_content" => {
            let args = decode(args)?;
            structure::rename_content(host, require(target)?, args).await
        }
        "move_content" => {
            let args = decode(args)?;
            structure::move_content(host, require(target)?, args).await
        }
        "reorder_content" => {
            let args = decode(args)?;
            structure::reorder_content(host, require(target)?, args).await
        }
        "reorder_spaces" => {
            let args = decode(args)?;
            structure::reorder_spaces(host, require(target)?, args).await
        }
        "import_asset" => {
            let args = decode(args)?;
            import::import_asset(host, require(target)?, args).await
        }
        _ => host.call_host_tool(name, args).await,
    }
}

fn require(target: Option<&RequestTarget>) -> Result<&RequestTarget, McpBusinessError> {
    target.ok_or_else(McpBusinessError::no_active_project)
}

pub fn decode<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, McpBusinessError> {
    serde_json::from_value(value).map_err(Into::into)
}

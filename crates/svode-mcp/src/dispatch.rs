//! Execution of catalog tools against a host.

use serde::Deserialize;
use serde_json::Value;

use crate::control::check_tool;
use crate::error::McpBusinessError;
use crate::host::{McpHost, RequestTarget};
use crate::protocol::ToolCallResult;
use crate::tools::{apps, content, pages, project};

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
        _ => host.call_host_tool(name, args).await,
    }
}

fn require(target: Option<&RequestTarget>) -> Result<&RequestTarget, McpBusinessError> {
    target.ok_or_else(McpBusinessError::no_active_project)
}

pub fn decode<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, McpBusinessError> {
    serde_json::from_value(value).map_err(Into::into)
}

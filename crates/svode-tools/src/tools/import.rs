//! Managed asset import through the shared core import workflow.

use std::path::Path;

use serde::Deserialize;
use serde_json::json;
use svode_core::attachments::import::{
    ImportRuntime, MutationOrigin, execute_managed_import, plan_managed_import,
};

use crate::error::ToolError;
use crate::host::{RequestTarget, ToolHost};
use crate::mutation::{authorize_paths, space_relative_busy, within_authorized};
use crate::path::{ensure_inside, validate_markdown_path};
use crate::result::ToolCallResult;
use crate::target::{default_space_id, is_root_space_id, resolve_space};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub(crate) struct ImportAssetArgs {
    #[serde(default)]
    space_id: Option<String>,
    content_path: String,
    source_path: String,
    #[serde(default)]
    file_name: Option<String>,
}

/// Imports a file for a content owner. The plan fixes routing and the
/// repositories of the actual asset owner, which are authorized before the
/// first write; the host delivers the invalidation after source success.
pub(crate) async fn import_asset(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: ImportAssetArgs,
) -> Result<ToolCallResult, ToolError> {
    let space = resolve_space(target, args.space_id.as_deref())?;
    let content_path = validate_markdown_path(&args.content_path)?;
    ensure_inside(Path::new(&space), &content_path)?;
    let mutation = host.mutation_runtime();
    let git = host.read_runtime().git;
    // Child Space of the plan: the requested one, otherwise the frozen
    // default of the request, as `resolve_space` selected it above.
    let selected_space_id = match args.space_id.as_deref() {
        Some(space_id) => Some(space_id).filter(|space_id| !is_root_space_id(space_id)),
        None => target.default_space_id.as_deref(),
    };
    let plan = plan_managed_import(
        mutation.index,
        Path::new(&target.project_path),
        selected_space_id,
        &content_path,
        Path::new(&args.source_path),
        args.file_name.as_deref(),
    )
    .await?;
    let authorized = authorize_paths(host, plan.affected_paths().to_vec()).await?;
    let runtime = ImportRuntime {
        index: mutation.index,
        updates: mutation.updates,
        repository: git.repository(),
        cli: git.detected(),
        commits: None,
        lfs: host.lfs_readiness(),
    };
    let result = within_authorized(authorized, async {
        Ok(Box::pin(execute_managed_import(runtime, MutationOrigin::Mcp, plan)).await?)
    })
    .await
    .map_err(|error| space_relative_busy(&space, error))?;
    host.deliver_managed_import(&result.delivery);
    let owner_space_id = args.space_id.unwrap_or_else(|| default_space_id(target));

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

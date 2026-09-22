use std::path::Path;

use serde_json::{Value, json};

use crate::args::SpaceArgs;
use crate::catalog;
use crate::error::McpBusinessError;
use crate::host::{McpHost, RequestTarget};
use crate::protocol::ToolCallResult;
use crate::target::{ROOT_SPACE_ID, default_space_id, resolve_space};

pub(crate) async fn get_project_info(
    host: &impl McpHost,
    target: &RequestTarget,
) -> Result<ToolCallResult, McpBusinessError> {
    let project_path = Path::new(&target.project_path);
    let spaces = spaces_payload(host, project_path).await?;
    let project = svode_core::content_tree::read_space_display(project_path)?;
    let structured = json!({
        "projectPath": target.project_path,
        "rootSpaceId": ROOT_SPACE_ID,
        "activeSpaceId": target.default_space_id,
        "activeMcpSpaceId": default_space_id(target),
        "activeSpacePath": target.default_space_path,
        "projectName": project.name,
        "spaces": spaces,
        "spaceAddressing": {
            "root": ROOT_SPACE_ID,
            "null": "active/default space"
        },
        "capabilities": {
            "pages": true,
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

pub(crate) async fn list_spaces(
    host: &impl McpHost,
    target: &RequestTarget,
) -> Result<ToolCallResult, McpBusinessError> {
    let spaces = spaces_payload(host, Path::new(&target.project_path)).await?;
    let structured = json!({
        "rootSpaceId": ROOT_SPACE_ID,
        "activeSpaceId": target.default_space_id,
        "activeMcpSpaceId": default_space_id(target),
        "spaceAddressing": {
            "root": ROOT_SPACE_ID,
            "null": "active/default space"
        },
        "spaces": spaces
    });
    Ok(ToolCallResult::ok(
        format!("Found {} spaces.", spaces.len()),
        structured,
    ))
}

pub(crate) fn get_svode_guide() -> Result<ToolCallResult, McpBusinessError> {
    Ok(ToolCallResult::ok(
        "Svode MCP guide.",
        json!({ "guide": catalog::guide_text() }),
    ))
}

async fn spaces_payload(
    host: &impl McpHost,
    project_path: &Path,
) -> Result<Vec<Value>, McpBusinessError> {
    let root = svode_core::content_tree::read_space_display(project_path)?;
    let children = svode_core::content_tree::list_project_children(project_path)?;
    let mut spaces = Vec::with_capacity(children.len() + 1);
    let (root_access, root_access_diagnostic) = repository_access(host, project_path).await;
    spaces.push(json!({
        "id": ROOT_SPACE_ID,
        "name": root.name,
        "icon": root.icon,
        "description": root.description,
        "path": project_path.to_string_lossy().to_string(),
        "kind": "root",
        "isRoot": true,
        "spaceId": ROOT_SPACE_ID,
        "hasSpaces": !children.is_empty(),
        "status": "ready",
        "repositoryAccess": root_access,
        "repositoryAccessDiagnostic": root_access_diagnostic,
        "capabilities": space_capabilities("root"),
        "addressing": {
            "spaceId": ROOT_SPACE_ID,
            "nullBehavior": "active-default"
        }
    }));
    for child in children {
        let (repository_access, repository_access_diagnostic) =
            repository_access(host, &child.path).await;
        let status = match child.status {
            svode_core::page::SpaceReadiness::Ready => "ready",
            svode_core::page::SpaceReadiness::Missing => "missing",
            svode_core::page::SpaceReadiness::Broken => "broken",
        };
        spaces.push(json!({
            "id": child.id,
            "name": child.name,
            "icon": child.icon,
            "description": child.description,
            "path": child.path.to_string_lossy().to_string(),
            "kind": "child",
            "isRoot": false,
            "spaceId": child.id,
            "hasSpaces": child.has_spaces,
            // The MCP listing never reports device-local open history or a
            // probed LFS runtime state.
            "lastOpened": null,
            "status": status,
            "repositoryAccess": repository_access,
            "repositoryAccessDiagnostic": repository_access_diagnostic,
            "lfsState": "n/a",
            "capabilities": space_capabilities("child"),
            "addressing": {
                "spaceId": child.id,
                "nullBehavior": "active-default"
            }
        }));
    }
    Ok(spaces)
}

async fn repository_access(host: &impl McpHost, path: &Path) -> (Option<Value>, Option<Value>) {
    match host.repository_access(path).await {
        Ok(snapshot) => (serde_json::to_value(snapshot).ok(), None),
        Err(error) => (None, serde_json::to_value(error).ok()),
    }
}

fn space_capabilities(kind: &str) -> Value {
    json!({
        "kind": kind,
        "pages": true,
        "collections": true,
        "gitStatus": true,
        "commitChanges": false,
        "autocommit": false
    })
}

pub(crate) async fn get_git_status(
    host: &impl McpHost,
    target: &RequestTarget,
    args: SpaceArgs,
) -> Result<ToolCallResult, McpBusinessError> {
    let space = resolve_space(target, args.space_id.as_deref())?;
    let status = host
        .read_runtime()
        .git
        .status(Path::new(&space), false)
        .await?;
    Ok(ToolCallResult::ok(
        "Git status for active Svode space.",
        json!({ "status": status }),
    ))
}

//! Headless MCP stdio sessions served in-process on the shared standalone
//! host, without the desktop app: `svode-mcp --project` and the automatic
//! mode when no desktop app answers at session start.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use serde_json::Value;
use svode_tools::dispatch::{call_tool, requires_project};
use svode_tools::error::ToolError;
use svode_tools::host::{RequestTarget, ToolHost};
use svode_tools::result::ToolCallResult;
use svode_tools::standalone::{StandaloneHost, request_target};
use svode_tools::target::{project_for_cwd, resolve_default_space, resolve_project};

use crate::control::{BridgeCall, bridge_request};
use crate::protocol::IpcResponse;
use crate::{MCP_VERSION, stdio};

/// Next step of a session whose launch directory gives no usable Project.
const CWD_PROJECT_HINT: &str = "Start the agent session inside a Svode project, or open Svode Desktop before starting it; `svode-mcp --project <path>` selects a project explicitly. create_project starts a new project, which this session then works with.";

/// Freezes the explicit target before the first request, serves the
/// session and closes every session-owned resource when it ends. An
/// unusable target fails before the session starts.
pub(crate) async fn run(project: &str, space: Option<&str>) -> Result<(), ToolError> {
    let cwd = std::env::current_dir()?;
    let host = StandaloneHost::session(MCP_VERSION);
    let target = open_target(&host, &cwd.join(project), space, &cwd).await?;
    serve(host, Ok(target), cwd).await
}

/// Automatic mode without the desktop app: the Project containing the
/// launch directory, with its Space by the cwd rule. Without a usable
/// Project the session still starts: Project-free tools are served, every
/// other tool call answers with the reason instead of the server failing,
/// and a Project the session creates becomes its target.
pub(crate) async fn run_in_cwd() -> Result<(), ToolError> {
    let cwd = std::env::current_dir()?;
    let host = StandaloneHost::session(MCP_VERSION);
    let target = match project_for_cwd(&cwd) {
        Ok(project) => open_target(&host, &project, None, &cwd).await,
        Err(error) => Err(error),
    }
    .map_err(|error| error.with_evidence("hint", CWD_PROJECT_HINT.into()));
    serve(host, target, cwd).await
}

async fn open_target(
    host: &StandaloneHost,
    project: &Path,
    space: Option<&str>,
    cwd: &Path,
) -> Result<RequestTarget, ToolError> {
    let project = resolve_project(project)?;
    let target = request_target(&resolve_default_space(project, space, cwd)?);
    host.open_project(Path::new(&target.project_path)).await?;
    Ok(target)
}

/// Target of a session: frozen before the first request, except that a
/// session without one takes the Project its host bound by creating it
/// (Stage 11 05 «Сессия MCP после создания проекта»).
struct SessionTarget {
    target: Mutex<Result<RequestTarget, ToolError>>,
    cwd: PathBuf,
}

impl SessionTarget {
    fn current(&self, host: &StandaloneHost) -> Result<RequestTarget, ToolError> {
        let mut target = self.target.lock().unwrap_or_else(PoisonError::into_inner);
        if target.is_err()
            && let Some(project) = host.project()
        {
            match resolve_project(project)
                .and_then(|project| resolve_default_space(project, None, &self.cwd))
            {
                Ok(space) => *target = Ok(request_target(&space)),
                Err(error) => {
                    tracing::warn!(
                        "the created project cannot be the session target: {}",
                        error.message
                    )
                }
            }
        }
        target.clone()
    }
}

async fn serve(
    host: StandaloneHost,
    target: Result<RequestTarget, ToolError>,
    cwd: PathBuf,
) -> Result<(), ToolError> {
    let target = SessionTarget {
        target: Mutex::new(target),
        cwd,
    };
    let (host_ref, target_ref) = (&host, &target);
    let served =
        stdio::serve(move |method, params| request(host_ref, target_ref, method, params)).await;
    host.close().await;
    served
}

async fn request(
    host: &StandaloneHost,
    target: &SessionTarget,
    method: String,
    params: Value,
) -> Result<IpcResponse, ToolError> {
    Ok(match bridge_request(host, &method, &params) {
        BridgeCall::Respond(response) => response,
        BridgeCall::CallTool { name, args } => tool_response(match target.current(host) {
            Ok(target) => call_tool(host, Some(&target), &name, args).await,
            Err(_) if !requires_project(&name) => call_tool(host, None, &name, args).await,
            Err(error) => ToolCallResult::business_error(error),
        }),
    })
}

fn tool_response(result: ToolCallResult) -> IpcResponse {
    IpcResponse {
        result: None,
        tool_result: Some(result),
        error: None,
    }
}

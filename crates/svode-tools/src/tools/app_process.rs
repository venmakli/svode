//! State and control of a process App through the host execution owner.
//! Bridge-only: a host serves them only with an App process runtime, the
//! one the App surface uses, and only for a Project open in its window.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{Value, json};
use svode_core::apps::catalog::AppCatalogError;
use svode_core::apps::manifest::{
    AppManifestDiagnostic, AppManifestError, AppProcessRuntime, ValidatedRuntime,
    read_and_validate_manifest, resolve_owner_in_space,
};
use svode_core::page::resolve_space_target;

use crate::error::ToolError;
use crate::host::{
    AppControlOutcome, AppProcessAction, AppProcessHost, AppProcessPhase, AppProcessReport,
    AppProcessTarget, RequestTarget, ToolHost,
};
use crate::result::ToolCallResult;
use crate::target::{ROOT_SPACE_ID, is_root_space_id};

pub const APP_MANIFEST_INVALID: &str = "APP_MANIFEST_INVALID";
pub const APP_RUNTIME_WITHOUT_PROCESS: &str = "APP_RUNTIME_WITHOUT_PROCESS";
pub const APP_PROJECT_NOT_OPEN: &str = "APP_PROJECT_NOT_OPEN";
pub const APP_VARIABLES_BLOCKED: &str = "APP_VARIABLES_BLOCKED";
pub const APP_LAUNCH_FAILED: &str = "APP_LAUNCH_FAILED";

const VARIABLES_HINT: &str = "Ask the user to set them in Settings → Variables, then call control_app again. An agent cannot set Variable values.";
const PROJECT_HINT: &str = "Open the project in Svode, then retry.";
const LAUNCH_HINT: &str = "Read logs, fix the recipe or the App code, then call control_app with restart, or rerun_setup when setup failed.";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GetAppStatusArgs {
    #[serde(default)]
    space_id: Option<String>,
    owner_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ControlAppArgs {
    #[serde(default)]
    space_id: Option<String>,
    owner_path: String,
    action: AppProcessAction,
}

/// App owner of a request with its current manifest.
struct ResolvedApp {
    project_path: PathBuf,
    space_id: Option<String>,
    owner_path: PathBuf,
    owner_relative: String,
    manifest: Result<ValidatedRuntime, Vec<AppManifestDiagnostic>>,
}

impl ResolvedApp {
    fn process_target(&self, runtime: &AppProcessRuntime) -> AppProcessTarget {
        AppProcessTarget {
            project_path: self.project_path.clone(),
            space_id: self.space_id.clone(),
            owner_path: self.owner_path.clone(),
            runtime: runtime.clone(),
        }
    }

    fn public_space_id(&self) -> &str {
        self.space_id.as_deref().unwrap_or(ROOT_SPACE_ID)
    }
}

pub(crate) async fn get_app_status(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: GetAppStatusArgs,
) -> Result<ToolCallResult, ToolError> {
    let apps = app_process_host(host, "get_app_status")?;
    require_open_project(apps, target).await?;
    let app = resolve_app(target, args.space_id.as_deref(), &args.owner_path)?;
    let status = match &app.manifest {
        Ok(ValidatedRuntime::Process(runtime)) => {
            let report = apps.status(app.process_target(runtime)).await?;
            process_status(&app, runtime, &report)
        }
        Ok(ValidatedRuntime::Static { .. }) => without_process(&app, Some("static"), None, &[]),
        Ok(ValidatedRuntime::Url { url }) => without_process(&app, Some("url"), Some(url), &[]),
        Err(diagnostics) => without_process(&app, None, None, diagnostics),
    };
    Ok(status_result(status))
}

pub(crate) async fn control_app(
    host: &impl ToolHost,
    target: &RequestTarget,
    args: ControlAppArgs,
) -> Result<ToolCallResult, ToolError> {
    let apps = app_process_host(host, "control_app")?;
    require_open_project(apps, target).await?;
    let app = resolve_app(target, args.space_id.as_deref(), &args.owner_path)?;
    let runtime = match &app.manifest {
        Ok(ValidatedRuntime::Process(runtime)) => runtime,
        Ok(runtime) => {
            return Err(ToolError::new(
                APP_RUNTIME_WITHOUT_PROCESS,
                format!(
                    "App {} has runtime {}: Svode manages no process for it",
                    app.owner_relative,
                    runtime.runtime_type().as_str()
                ),
            )
            .with_evidence("runtimeType", runtime.runtime_type().as_str().into()));
        }
        Err(diagnostics) => {
            return Err(ToolError::new(
                APP_MANIFEST_INVALID,
                format!(
                    "app.yaml of {} is invalid; fix its diagnostics before control_app",
                    app.owner_relative
                ),
            )
            .with_evidence("diagnostics", json!(diagnostics)));
        }
    };
    match apps
        .control(app.process_target(runtime), args.action)
        .await?
    {
        AppControlOutcome::Process(report) => {
            let status = process_status(&app, runtime, &report);
            let failed = matches!(
                report.phase,
                AppProcessPhase::Failed | AppProcessPhase::Exited
            );
            if failed && args.action != AppProcessAction::Stop {
                return Err(ToolError::new(
                    APP_LAUNCH_FAILED,
                    format!(
                        "App {} failed to launch: {}",
                        app.owner_relative,
                        report.reason.as_deref().unwrap_or("process exited")
                    ),
                )
                .with_evidence("status", status)
                .with_evidence("hint", LAUNCH_HINT.into()));
            }
            Ok(status_result(status))
        }
        AppControlOutcome::VariablesMissing(missing) => Err(ToolError::new(
            APP_VARIABLES_BLOCKED,
            format!(
                "App {} cannot launch: Variables {} have no value",
                app.owner_relative,
                missing
                    .iter()
                    .map(|variable| variable.entry_name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        )
        .with_evidence("reason", "missing".into())
        .with_evidence("missingVariables", json!(missing))
        .with_evidence("hint", VARIABLES_HINT.into())),
        AppControlOutcome::VariablesUnreadable(problem) => Err(ToolError::new(
            APP_VARIABLES_BLOCKED,
            format!(
                "App {} cannot launch: its Variables cannot be read",
                app.owner_relative
            ),
        )
        .with_evidence("reason", "unreadable".into())
        .with_evidence("variablesProblem", problem)
        .with_evidence("hint", VARIABLES_HINT.into())),
    }
}

fn app_process_host<'a>(
    host: &'a impl ToolHost,
    name: &str,
) -> Result<&'a dyn AppProcessHost, ToolError> {
    host.app_process()
        .ok_or_else(|| ToolError::new("UNKNOWN_TOOL", format!("unknown Svode MCP tool: {name}")))
}

async fn require_open_project(
    apps: &dyn AppProcessHost,
    target: &RequestTarget,
) -> Result<(), ToolError> {
    if apps.project_open(Path::new(&target.project_path)).await {
        return Ok(());
    }
    Err(ToolError::new(
        APP_PROJECT_NOT_OPEN,
        "App processes exist only for a project open in a Svode window",
    )
    .with_evidence("hint", PROJECT_HINT.into()))
}

fn resolve_app(
    target: &RequestTarget,
    requested_space_id: Option<&str>,
    owner_path: &str,
) -> Result<ResolvedApp, ToolError> {
    let space_id = match requested_space_id {
        None => target.default_space_id.clone(),
        Some(space_id) if is_root_space_id(space_id) => None,
        Some(space_id) => Some(space_id.to_string()),
    };
    let space = resolve_space_target(Path::new(&target.project_path), space_id.as_deref())?;
    let space_path = space.space_path.canonicalize().unwrap_or(space.space_path);
    let owner = match resolve_owner_in_space(&space_path, owner_path) {
        Ok(owner) => owner,
        Err(AppManifestError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(AppCatalogError::OwnerNotFound(owner_path.to_string()).into());
        }
        Err(error) => return Err(AppCatalogError::Manifest(error).into()),
    };
    let owner_relative = relative_owner(&space_path, &owner);
    let manifest = read_and_validate_manifest(&owner)
        .map_err(AppCatalogError::Manifest)?
        .ok_or_else(|| AppCatalogError::NotAnApp(owner_relative.clone()))?;
    Ok(ResolvedApp {
        project_path: space.project_path,
        space_id,
        owner_path: owner,
        owner_relative,
        manifest,
    })
}

fn relative_owner(space_path: &Path, owner_path: &Path) -> String {
    let relative = owner_path
        .strip_prefix(space_path)
        .ok()
        .map(|path| {
            path.components()
                .map(|component| component.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_default();
    if relative.is_empty() {
        ".".to_string()
    } else {
        relative
    }
}

fn process_status(
    app: &ResolvedApp,
    runtime: &AppProcessRuntime,
    report: &AppProcessReport,
) -> Value {
    json!({
        "spaceId": app.public_space_id(),
        "ownerPath": app.owner_relative,
        "runtimeType": "process",
        "manifestValid": true,
        "diagnostics": [],
        "state": report.phase,
        "reason": report.reason,
        "url": runtime.url,
        "urlReachable": report.url_reachable,
        "managed": report.managed,
        "hasSetup": runtime.setup.is_some(),
        "logs": { "stdout": report.stdout, "stderr": report.stderr },
        "variables": runtime.settings_references(),
    })
}

fn without_process(
    app: &ResolvedApp,
    runtime_type: Option<&str>,
    url: Option<&str>,
    diagnostics: &[AppManifestDiagnostic],
) -> Value {
    json!({
        "spaceId": app.public_space_id(),
        "ownerPath": app.owner_relative,
        "runtimeType": runtime_type,
        "manifestValid": runtime_type.is_some(),
        "diagnostics": diagnostics,
        "state": "no_process",
        "reason": null,
        "url": url,
        "urlReachable": null,
        "managed": false,
        "hasSetup": false,
        "logs": { "stdout": "", "stderr": "" },
        "variables": [],
    })
}

fn status_result(status: Value) -> ToolCallResult {
    let text = match status["runtimeType"].as_str() {
        Some("process") => format!(
            "App {} process state: {}.",
            status["ownerPath"].as_str().unwrap_or("."),
            status["state"].as_str().unwrap_or("unknown")
        ),
        Some(runtime) => format!(
            "App {} has runtime {runtime}: Svode manages no process for it.",
            status["ownerPath"].as_str().unwrap_or(".")
        ),
        None => format!(
            "App {} has an invalid app.yaml.",
            status["ownerPath"].as_str().unwrap_or(".")
        ),
    };
    ToolCallResult::ok(text, status)
}

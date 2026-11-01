//! Launch steps of a process App shared by the App surface commands and the
//! agent bridge: Variables give the process its environment or block it, and
//! the one `AppProcessState` launches it with setup reuse and URL readiness.

use std::path::Path;

use tauri::{AppHandle, Emitter, Manager};

use super::AppProcessState;
use super::process_runtime::{AppProcessAction, AppProcessSnapshot};
use crate::AppError;
use crate::commands::app_variables::{APP_VARIABLES_CHANGED_EVENT, run_locked};
use crate::space::app_variables::{
    AppEnvironment, AppVariableOwnerContext, KeyringSecretStore, MissingAppVariable, VariableScope,
    VariablesProblem, resolve_environment,
};
use crate::space::settings::AppSettingsState;
use svode_core::apps::manifest::AppProcessRuntime;
use svode_core::system_path;

/// Why Variables keep a process App from launching.
#[derive(Debug)]
pub(crate) enum VariablesBlock {
    Missing(Vec<MissingAppVariable>),
    Unreadable(VariablesProblem),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LaunchRequest {
    /// Opening the App: the current process if its declaration is
    /// unchanged, else a launch.
    InspectOrLaunch,
    Control(AppProcessAction),
}

#[derive(Debug)]
pub(crate) enum LaunchOutcome {
    Process(AppProcessSnapshot),
    Blocked(VariablesBlock),
}

/// Gives the process its environment, or reports what Variables block.
pub(crate) fn apply_environment(
    mut runtime: AppProcessRuntime,
    environment: AppEnvironment,
) -> Result<AppProcessRuntime, VariablesBlock> {
    match environment {
        AppEnvironment::Ready(environment) => {
            runtime.environment = environment;
            Ok(runtime)
        }
        AppEnvironment::Missing(missing) => Err(VariablesBlock::Missing(missing)),
        AppEnvironment::Unreadable(problem) => Err(VariablesBlock::Unreadable(problem)),
    }
}

/// Launches `runtime` with its resolved `environment`. A blocked App keeps
/// no process or stale snapshot, so the next check resolves Variables anew.
pub(crate) fn launch(
    process_state: &AppProcessState,
    project_path: &Path,
    owner_path: &Path,
    runtime: AppProcessRuntime,
    environment: AppEnvironment,
    request: LaunchRequest,
) -> LaunchOutcome {
    let runtime = match apply_environment(runtime, environment) {
        Ok(runtime) => runtime,
        Err(blocked) => {
            process_state.remove_owner(project_path, owner_path);
            return LaunchOutcome::Blocked(blocked);
        }
    };
    LaunchOutcome::Process(match request {
        LaunchRequest::InspectOrLaunch => {
            process_state.inspect_or_launch(project_path, owner_path, runtime)
        }
        LaunchRequest::Control(action) => {
            process_state.control(project_path, owner_path, runtime, action)
        }
    })
}

/// Environment of a process App from Variables, recording its usage.
pub(crate) async fn resolve_runtime_environment(
    app: &AppHandle,
    project_path: &Path,
    space_id: Option<&str>,
    owner_path: &Path,
    runtime: &AppProcessRuntime,
) -> Result<AppEnvironment, AppError> {
    let owner_directory = system_path::user_facing_path(owner_path);
    let context = AppVariableOwnerContext {
        scope: VariableScope {
            project_path: project_path.to_string_lossy().into(),
            space_id: space_id.map(str::to_string),
        },
        owner_key: owner_directory.clone(),
        owner_directory,
        references: runtime.settings_references(),
    };
    let declaration = runtime.environment_declaration.clone();
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| AppError::General(error.to_string()))?;
    let resolved = run_locked(&app.state::<AppSettingsState>(), move || {
        Ok(resolve_environment(
            &config_dir,
            &context,
            &declaration,
            &KeyringSecretStore,
        ))
    })
    .await?;
    if resolved.usage_changed {
        let _ = app.emit(APP_VARIABLES_CHANGED_EVENT, ());
    }
    Ok(resolved.environment)
}

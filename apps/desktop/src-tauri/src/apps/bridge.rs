//! Agent bridge of process Apps: `get_app_status` and `control_app` over the
//! one `AppProcessState` with the launch steps of the App surface. A status
//! read never launches the App or touches Variables; a control action tells
//! the open App surface about the change it made.

use std::future::Future;
use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use svode_core::apps::manifest::AppProcessRuntime;
use svode_tools::host::{
    AppControlOutcome, AppMissingVariable, AppProcessAction as AgentAction,
    AppProcessPhase as AgentPhase, AppProcessReport, AppProcessTarget,
};
use tokio::time::{Instant, sleep};

use super::AppProcessState;
use super::launch::{LaunchOutcome, LaunchRequest, VariablesBlock, launch};
use super::process_runtime::{
    AppProcessAction, AppProcessLogs, AppProcessPhase, AppProcessSnapshot,
};
use crate::AppError;
use crate::space::app_variables::AppEnvironment;

/// Event of a process change made through the bridge; the open App surface
/// of `ownerDirectory` inspects its App again.
pub(crate) const APP_PROCESS_CHANGED_EVENT: &str = "app-process:changed";

/// Upper bound of waiting for a launch to settle before `control_app`
/// returns the launching state; below the default tool timeout of clients.
pub(crate) const CONTROL_SETTLE_TIMEOUT: Duration = Duration::from_secs(30);

const SETTLE_POLL: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppProcessChanged {
    pub owner_directory: String,
}

/// Current process state of the App, read without launching it.
pub(crate) async fn status(state: &AppProcessState, target: &AppProcessTarget) -> AppProcessReport {
    let snapshot =
        state.inspect_existing(&target.project_path, &target.owner_path, &target.runtime);
    report(state, &target.runtime.url, snapshot).await
}

/// Applies `action` like the App surface does and waits up to `settle` for
/// a launch to leave its launching phases. `resolve_environment` runs only
/// when the action launches; `changed` runs once the process state changed.
pub(crate) async fn control<Resolve, Resolved>(
    state: &AppProcessState,
    target: AppProcessTarget,
    action: AgentAction,
    resolve_environment: Resolve,
    settle: Duration,
    changed: impl FnOnce(),
) -> Result<AppControlOutcome, AppError>
where
    Resolve: FnOnce(&AppProcessRuntime) -> Resolved,
    Resolved: Future<Output = Result<AppEnvironment, AppError>>,
{
    let AppProcessTarget {
        project_path,
        owner_path,
        runtime,
        ..
    } = target;
    let url = runtime.url.clone();
    let request = match action {
        AgentAction::Stop => {
            let snapshot = state.stop_managed(&project_path, &owner_path);
            if matches!(snapshot, Some(AppProcessSnapshot::Stopped { .. })) {
                changed();
            }
            return Ok(AppControlOutcome::Process(
                report(state, &url, snapshot).await,
            ));
        }
        AgentAction::Start => {
            if let Some(AppProcessSnapshot::Launching { .. } | AppProcessSnapshot::Ready { .. }) =
                state.inspect_existing(&project_path, &owner_path, &runtime)
            {
                let snapshot = settled(state, &project_path, &owner_path, &runtime, settle).await;
                return Ok(AppControlOutcome::Process(
                    report(state, &url, snapshot).await,
                ));
            }
            AppProcessAction::Retry
        }
        AgentAction::Restart => AppProcessAction::Restart,
        AgentAction::RerunSetup => AppProcessAction::RerunSetup,
    };
    let environment = resolve_environment(&runtime).await?;
    let outcome = launch(
        state,
        &project_path,
        &owner_path,
        runtime.clone(),
        environment,
        LaunchRequest::Control(request),
    );
    changed();
    Ok(match outcome {
        LaunchOutcome::Blocked(VariablesBlock::Missing(missing)) => {
            AppControlOutcome::VariablesMissing(
                missing
                    .into_iter()
                    .map(|variable| AppMissingVariable {
                        reference_name: variable.reference_name,
                        entry_name: variable.entry_name,
                    })
                    .collect(),
            )
        }
        LaunchOutcome::Blocked(VariablesBlock::Unreadable(problem)) => {
            AppControlOutcome::VariablesUnreadable(
                serde_json::to_value(problem)
                    .map_err(|error| AppError::General(error.to_string()))?,
            )
        }
        LaunchOutcome::Process(_) => {
            let snapshot = settled(state, &project_path, &owner_path, &runtime, settle).await;
            AppControlOutcome::Process(report(state, &url, snapshot).await)
        }
    })
}

async fn settled(
    state: &AppProcessState,
    project_path: &Path,
    owner_path: &Path,
    runtime: &AppProcessRuntime,
    timeout: Duration,
) -> Option<AppProcessSnapshot> {
    let deadline = Instant::now() + timeout;
    loop {
        let snapshot = state.inspect_existing(project_path, owner_path, runtime);
        if !matches!(snapshot, Some(AppProcessSnapshot::Launching { .. }))
            || Instant::now() >= deadline
        {
            return snapshot;
        }
        sleep(SETTLE_POLL).await;
    }
}

async fn report(
    state: &AppProcessState,
    url: &str,
    snapshot: Option<AppProcessSnapshot>,
) -> AppProcessReport {
    let url_reachable = state.url_reachable(url).await;
    let (phase, reason, managed, logs) = match snapshot {
        None => (
            AgentPhase::NotRunning,
            None,
            false,
            AppProcessLogs::default(),
        ),
        Some(AppProcessSnapshot::Launching { phase, logs, .. }) => {
            let phase = match phase {
                AppProcessPhase::Setup => AgentPhase::Setup,
                AppProcessPhase::Starting => AgentPhase::Starting,
                AppProcessPhase::WaitingForUrl => AgentPhase::WaitingForUrl,
            };
            (phase, None, true, logs)
        }
        Some(AppProcessSnapshot::Ready {
            managed: true,
            logs,
            ..
        }) => (AgentPhase::Ready, None, true, logs),
        Some(AppProcessSnapshot::Ready { logs, .. }) => (AgentPhase::External, None, false, logs),
        Some(AppProcessSnapshot::Failed { reason, logs, .. }) => {
            let phase = if reason == "process_exited" {
                AgentPhase::Exited
            } else {
                AgentPhase::Failed
            };
            (phase, Some(reason.to_string()), false, logs)
        }
        Some(AppProcessSnapshot::Stopped { logs, .. }) => (AgentPhase::Stopped, None, false, logs),
    };
    AppProcessReport {
        phase,
        reason,
        managed,
        url_reachable,
        stdout: logs.stdout,
        stderr: logs.stderr,
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use svode_core::apps::manifest::AppCommandRecipe;

    use super::*;
    use crate::space::app_variables::MissingAppVariable;

    const SETTLE: Duration = Duration::from_secs(10);

    struct Fixture {
        _temp: tempfile::TempDir,
        project: PathBuf,
        owner: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let project = temp.path().canonicalize().unwrap();
            let owner = project.join("app");
            std::fs::create_dir(&owner).unwrap();
            Self {
                _temp: temp,
                project,
                owner,
            }
        }

        fn target(&self, setup: Option<&str>, start: &str) -> AppProcessTarget {
            AppProcessTarget {
                project_path: self.project.clone(),
                space_id: None,
                owner_path: self.owner.clone(),
                runtime: AppProcessRuntime {
                    setup: setup.map(shell),
                    start: shell(start),
                    url: "http://127.0.0.1:3210/".to_string(),
                    environment: BTreeMap::new(),
                    environment_declaration: BTreeMap::new(),
                },
            }
        }

        fn lines(&self, file: &str) -> usize {
            std::fs::read_to_string(self.owner.join(file))
                .map(|text| text.lines().count())
                .unwrap_or(0)
        }

        /// Line count of a log the App commands append to, once the probe
        /// that answers at once let the launch settle before they ran.
        async fn lines_reach(&self, file: &str, expected: usize) -> usize {
            let deadline = Instant::now() + Duration::from_secs(5);
            while self.lines(file) < expected && Instant::now() < deadline {
                sleep(Duration::from_millis(20)).await;
            }
            self.lines(file)
        }
    }

    fn shell(script: &str) -> AppCommandRecipe {
        AppCommandRecipe {
            argv: vec!["sh".to_string(), "-c".to_string(), script.to_string()],
            cwd: None,
            inputs: Vec::new(),
        }
    }

    /// Environment resolver that counts its calls and gives no Variables.
    fn ready_environment(
        calls: &Arc<AtomicUsize>,
    ) -> impl FnOnce(&AppProcessRuntime) -> std::future::Ready<Result<AppEnvironment, AppError>>
    {
        let calls = Arc::clone(calls);
        move |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            std::future::ready(Ok(AppEnvironment::Ready(BTreeMap::new())))
        }
    }

    fn untouched_environment(
        _: &AppProcessRuntime,
    ) -> std::future::Ready<Result<AppEnvironment, AppError>> {
        panic!("this action must not resolve Variables");
    }

    /// Status once the runtime saw what the command did: a probe that
    /// answers at once reports a short-lived command ready first.
    async fn status_reaches(
        state: &AppProcessState,
        target: &AppProcessTarget,
        phase: AgentPhase,
    ) -> AppProcessReport {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let report = status(state, target).await;
            if report.phase == phase || Instant::now() >= deadline {
                return report;
            }
            sleep(Duration::from_millis(20)).await;
        }
    }

    async fn act(
        state: &AppProcessState,
        target: &AppProcessTarget,
        action: AgentAction,
        calls: &Arc<AtomicUsize>,
    ) -> (AppProcessReport, bool) {
        let mut changed = false;
        let outcome = control(
            state,
            target.clone(),
            action,
            ready_environment(calls),
            SETTLE,
            || changed = true,
        )
        .await
        .unwrap();
        let AppControlOutcome::Process(report) = outcome else {
            panic!("expected a process outcome: {outcome:?}");
        };
        (report, changed)
    }

    #[tokio::test]
    async fn status_of_an_app_that_is_not_running_launches_nothing() {
        let fixture = Fixture::new();
        let state = AppProcessState::for_tests(false);
        let target = fixture.target(None, "printf 'start\\n' >> starts.log; sleep 10");

        let report = status(&state, &target).await;

        assert_eq!(report.phase, AgentPhase::NotRunning);
        assert!(!report.url_reachable);
        assert!(!report.managed);
        assert!(
            state
                .inspect_existing(&fixture.project, &fixture.owner, &target.runtime)
                .is_none()
        );
        sleep(Duration::from_millis(200)).await;
        assert_eq!(fixture.lines("starts.log"), 0);
    }

    #[tokio::test]
    async fn start_launches_once_and_returns_a_ready_app_without_restarting_it() {
        let fixture = Fixture::new();
        let state = AppProcessState::for_tests(true);
        let target = fixture.target(None, "printf 'start\\n' >> starts.log; sleep 10");
        let calls = Arc::new(AtomicUsize::new(0));

        let (started, changed) = act(&state, &target, AgentAction::Start, &calls).await;
        assert_eq!(started.phase, AgentPhase::Ready);
        assert!(started.managed && started.url_reachable && changed);
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        let mut changed = false;
        let outcome = control(
            &state,
            target.clone(),
            AgentAction::Start,
            untouched_environment,
            SETTLE,
            || changed = true,
        )
        .await
        .unwrap();
        assert!(matches!(
            outcome,
            AppControlOutcome::Process(AppProcessReport {
                phase: AgentPhase::Ready,
                ..
            })
        ));
        assert!(!changed);
        assert_eq!(fixture.lines_reach("starts.log", 1).await, 1);
        assert_eq!(status(&state, &target).await.phase, AgentPhase::Ready);
    }

    #[tokio::test]
    async fn start_after_stop_and_after_a_failure_launches_again() {
        let fixture = Fixture::new();
        let state = AppProcessState::for_tests(true);
        let target = fixture.target(None, "printf 'start\\n' >> starts.log; sleep 10");
        let calls = Arc::new(AtomicUsize::new(0));
        act(&state, &target, AgentAction::Start, &calls).await;
        assert_eq!(fixture.lines_reach("starts.log", 1).await, 1);

        let (stopped, changed) = act(&state, &target, AgentAction::Stop, &calls).await;
        assert_eq!(stopped.phase, AgentPhase::Stopped);
        assert!(changed);
        let (started, _) = act(&state, &target, AgentAction::Start, &calls).await;
        assert_eq!(started.phase, AgentPhase::Ready);
        assert_eq!(fixture.lines_reach("starts.log", 2).await, 2);

        let failing = fixture.target(
            None,
            "printf 'start\\n' >> fails.log; echo broken >&2; exit 3",
        );
        act(&state, &failing, AgentAction::Start, &calls).await;
        let failed = status_reaches(&state, &failing, AgentPhase::Failed).await;
        assert_eq!(failed.phase, AgentPhase::Failed);
        assert_eq!(failed.reason.as_deref(), Some("start_exit_non_zero"));
        assert!(failed.stderr.contains("broken"), "{}", failed.stderr);
        assert!(
            failed.stderr.contains("start command exited"),
            "{}",
            failed.stderr
        );

        act(&state, &failing, AgentAction::Start, &calls).await;
        assert_eq!(fixture.lines_reach("fails.log", 2).await, 2);
    }

    #[tokio::test]
    async fn setup_failure_keeps_its_logs_and_restart_and_rerun_setup_start_anew() {
        let fixture = Fixture::new();
        let state = AppProcessState::for_tests(true);
        let calls = Arc::new(AtomicUsize::new(0));
        let broken = fixture.target(Some("echo setup-broke >&2; exit 2"), "sleep 10");
        let (failed, _) = act(&state, &broken, AgentAction::Start, &calls).await;
        assert_eq!(failed.phase, AgentPhase::Failed);
        assert_eq!(failed.reason.as_deref(), Some("setup_exit_non_zero"));
        assert!(failed.stderr.contains("setup-broke"), "{}", failed.stderr);

        let target = fixture.target(
            Some("printf 'setup\\n' >> setup.log"),
            "printf 'start\\n' >> starts.log; sleep 10",
        );
        act(&state, &target, AgentAction::Start, &calls).await;
        assert_eq!(fixture.lines_reach("starts.log", 1).await, 1);
        let (restarted, changed) = act(&state, &target, AgentAction::Restart, &calls).await;
        assert_eq!(restarted.phase, AgentPhase::Ready);
        assert!(changed);
        assert_eq!(fixture.lines_reach("setup.log", 1).await, 1);
        assert_eq!(fixture.lines_reach("starts.log", 2).await, 2);

        let (rerun, _) = act(&state, &target, AgentAction::RerunSetup, &calls).await;
        assert_eq!(rerun.phase, AgentPhase::Ready);
        assert_eq!(fixture.lines_reach("setup.log", 2).await, 2);
        assert_eq!(fixture.lines_reach("starts.log", 3).await, 3);
    }

    #[tokio::test]
    async fn stop_leaves_an_external_service_running() {
        let fixture = Fixture::new();
        let state = AppProcessState::for_tests(true);
        let target = fixture.target(None, "exit 0");
        let calls = Arc::new(AtomicUsize::new(0));
        act(&state, &target, AgentAction::Start, &calls).await;
        let external = status_reaches(&state, &target, AgentPhase::External).await;
        assert_eq!(external.phase, AgentPhase::External);
        assert!(!external.managed);

        let (stopped, changed) = act(&state, &target, AgentAction::Stop, &calls).await;
        assert_eq!(stopped.phase, AgentPhase::External);
        assert!(!changed);
        assert_eq!(status(&state, &target).await.phase, AgentPhase::External);

        let (nothing, changed) = act(
            &state,
            &fixture.target(None, "sleep 10"),
            AgentAction::Stop,
            &calls,
        )
        .await;
        assert_eq!(nothing.phase, AgentPhase::External);
        assert!(!changed);
        state.remove_owner(&fixture.project, &fixture.owner);
        let (nothing, changed) = act(&state, &target, AgentAction::Stop, &calls).await;
        assert_eq!(nothing.phase, AgentPhase::NotRunning);
        assert!(!changed);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn blocking_variables_return_names_and_drop_the_process_like_the_surface() {
        let fixture = Fixture::new();
        let state = AppProcessState::for_tests(true);
        let target = fixture.target(None, "sleep 10");
        let calls = Arc::new(AtomicUsize::new(0));
        act(&state, &target, AgentAction::Start, &calls).await;

        let mut changed = false;
        let outcome = control(
            &state,
            target.clone(),
            AgentAction::Restart,
            |_| {
                std::future::ready(Ok(AppEnvironment::Missing(vec![MissingAppVariable {
                    reference_name: "API_TOKEN".into(),
                    entry_name: "SHARED_TOKEN".into(),
                }])))
            },
            SETTLE,
            || changed = true,
        )
        .await
        .unwrap();

        assert_eq!(
            outcome,
            AppControlOutcome::VariablesMissing(vec![AppMissingVariable {
                reference_name: "API_TOKEN".into(),
                entry_name: "SHARED_TOKEN".into(),
            }])
        );
        assert!(changed);
        assert_eq!(status(&state, &target).await.phase, AgentPhase::NotRunning);
    }
}

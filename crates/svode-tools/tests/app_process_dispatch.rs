//! `get_app_status` and `control_app` through the shared dispatch on a host
//! whose App process runtime is a recording stand-in: owner resolution,
//! manifest rules, the window gate and stable codes belong to the library;
//! the process itself is the host effect.

use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use sqlx::SqlitePool;
use svode_core::actors::resolver::ActorCatalogState;
use svode_core::attachments::import::{LfsReadiness, ManagedImportDelivery};
use svode_core::git::access::RepositoryAccessSnapshot;
use svode_core::git::state::GitRuntime;
use svode_core::index::IndexKey;
use svode_core::index::state::IndexRuntimeState;
use svode_core::index::update::IndexUpdateState;
use svode_core::page::nonce::WriteNonceRegistry;
use svode_core::routines::model::{ResolvedRoutineOwner, RoutineLiveEvidence};
use svode_core::routines::store_state::RoutineStoreState;
use svode_tools::dispatch::{call_tool, check_tool, served_definitions};
use svode_tools::error::ToolError;
use svode_tools::host::{
    AppControlOutcome, AppMissingVariable, AppProcessAction, AppProcessHost, AppProcessPhase,
    AppProcessReport, AppProcessTarget, MutationRuntime, ReadRuntime, RequestTarget, RoutineRunner,
    RoutineRuntime, ToolHost,
};
use svode_tools::result::ToolCallResult;

const PROCESS_APP: &str = "runtime:\n  type: process\n  setup:\n    argv: [bun, install]\n  start:\n    argv: [bun, run, dev]\n  url: http://127.0.0.1:3210\nenvironment:\n  TOKEN: Bearer ${API_TOKEN}\n";

/// Stand-in for the host App process runtime: records what it was asked
/// and answers with the configured outcome.
struct FakeApps {
    open: bool,
    report: AppProcessReport,
    outcome: Mutex<Option<AppControlOutcome>>,
    statuses: Mutex<Vec<AppProcessTarget>>,
    controls: Mutex<Vec<(AppProcessTarget, AppProcessAction)>>,
}

impl FakeApps {
    fn new(open: bool) -> Self {
        Self {
            open,
            report: report(AppProcessPhase::Ready, None),
            outcome: Mutex::new(None),
            statuses: Mutex::new(Vec::new()),
            controls: Mutex::new(Vec::new()),
        }
    }

    fn answering(outcome: AppControlOutcome) -> Self {
        let apps = Self::new(true);
        *apps.outcome.lock().unwrap() = Some(outcome);
        apps
    }

    fn calls(&self) -> (usize, usize) {
        (
            self.statuses.lock().unwrap().len(),
            self.controls.lock().unwrap().len(),
        )
    }
}

fn report(phase: AppProcessPhase, reason: Option<&str>) -> AppProcessReport {
    AppProcessReport {
        phase,
        reason: reason.map(str::to_string),
        managed: phase == AppProcessPhase::Ready,
        url_reachable: phase == AppProcessPhase::Ready,
        stdout: "listening\n".to_string(),
        stderr: "warn: dev build\n".to_string(),
    }
}

impl AppProcessHost for FakeApps {
    fn project_open<'a>(
        &'a self,
        _project: &'a Path,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
        let open = self.open;
        Box::pin(async move { open })
    }

    fn status(
        &self,
        target: AppProcessTarget,
    ) -> Pin<Box<dyn Future<Output = Result<AppProcessReport, ToolError>> + Send + '_>> {
        self.statuses.lock().unwrap().push(target);
        let report = self.report.clone();
        Box::pin(async move { Ok(report) })
    }

    fn control(
        &self,
        target: AppProcessTarget,
        action: AppProcessAction,
    ) -> Pin<Box<dyn Future<Output = Result<AppControlOutcome, ToolError>> + Send + '_>> {
        self.controls.lock().unwrap().push((target, action));
        let outcome = self
            .outcome
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| AppControlOutcome::Process(self.report.clone()));
        Box::pin(async move { Ok(outcome) })
    }
}

struct Host {
    apps: Option<FakeApps>,
    routines: Arc<RoutineStoreState>,
    index: IndexRuntimeState,
    updates: IndexUpdateState,
    nonces: WriteNonceRegistry,
    actors: ActorCatalogState,
    git: GitRuntime,
}

impl Host {
    fn new(apps: Option<FakeApps>) -> Self {
        let routines = Arc::new(RoutineStoreState::new());
        Self {
            apps,
            updates: IndexUpdateState::new(routines.clone()),
            routines,
            index: IndexRuntimeState::default(),
            nonces: WriteNonceRegistry::new(),
            actors: ActorCatalogState::new(),
            git: GitRuntime::new(),
        }
    }

    fn apps(&self) -> &FakeApps {
        self.apps.as_ref().unwrap()
    }
}

impl ToolHost for Host {
    fn version(&self) -> &str {
        "test"
    }

    fn serves_tool(&self, _name: &str) -> bool {
        true
    }

    async fn index_pool(&self, _key: &IndexKey, _space_path: &Path) -> Option<SqlitePool> {
        None
    }

    async fn repository_access(
        &self,
        _space_path: &Path,
    ) -> Result<RepositoryAccessSnapshot, ToolError> {
        Err(ToolError::new("GIT_NOT_FOUND", "unused"))
    }

    async fn require_mutation_access(&self, _repository: &Path) -> Result<(), ToolError> {
        Err(ToolError::new(
            "REPOSITORY_ACCESS_DENIED",
            "App tools write nothing",
        ))
    }

    fn mutation_runtime(&self) -> MutationRuntime<'_> {
        MutationRuntime {
            index: &self.index,
            updates: &self.updates,
            nonces: &self.nonces,
        }
    }

    fn read_runtime(&self) -> ReadRuntime<'_> {
        ReadRuntime {
            index: &self.index,
            actors: &self.actors,
            git: &self.git,
        }
    }

    fn lfs_readiness(&self) -> Option<&dyn LfsReadiness> {
        None
    }

    fn deliver_managed_import(&self, _delivery: &ManagedImportDelivery) {}

    fn routine_runtime(&self) -> Result<RoutineRuntime<'_>, ToolError> {
        Ok(RoutineRuntime {
            stores: &self.routines,
            live_evidence: RoutineLiveEvidence::default(),
        })
    }

    fn deliver_routine_invalidation(&self, _owner: &ResolvedRoutineOwner) {}

    fn routine_runner(&self) -> Option<&dyn RoutineRunner> {
        None
    }

    fn app_process(&self) -> Option<&dyn AppProcessHost> {
        self.apps.as_ref().map(|apps| apps as &dyn AppProcessHost)
    }
}

struct Fixture {
    _temp: tempfile::TempDir,
    project: PathBuf,
}

impl Fixture {
    fn target(&self) -> RequestTarget {
        RequestTarget {
            project_path: self.project.to_string_lossy().to_string(),
            default_space_id: None,
            default_space_path: self.project.to_string_lossy().to_string(),
            routine_caller: None,
        }
    }
}

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().canonicalize().unwrap().join("project");
    write(
        &project.join(".svode/config.json"),
        &json!({
            "name": "Project",
            "spaces": [{ "id": "child", "path": "child", "repo": null }]
        })
        .to_string(),
    );
    write(
        &project.join("child/.svode/config.json"),
        &json!({ "name": "Child" }).to_string(),
    );
    write(&project.join("apps/dev/app.yaml"), PROCESS_APP);
    write(&project.join("child/tool/app.yaml"), PROCESS_APP);
    write(
        &project.join("apps/site/app.yaml"),
        "runtime:\n  type: static\n  publicRoot: public\n  entry: index.html\n",
    );
    write(
        &project.join("apps/remote/app.yaml"),
        "runtime:\n  type: url\n  url: https://example.com/tool\n",
    );
    write(
        &project.join("apps/broken/app.yaml"),
        "runtime:\n  type: process\n",
    );
    write(&project.join("notes/README.md"), "# Notes\n");
    Fixture {
        _temp: temp,
        project,
    }
}

async fn call(host: &Host, fixture: &Fixture, name: &str, args: Value) -> ToolCallResult {
    call_tool(host, Some(&fixture.target()), name, args).await
}

fn ok(result: &ToolCallResult) -> &Value {
    assert!(!result.is_error, "{:?}", result.structured_content);
    result.structured_content.as_ref().unwrap()
}

fn error(result: &ToolCallResult) -> &Value {
    assert!(result.is_error, "{:?}", result.structured_content);
    &result.structured_content.as_ref().unwrap()["error"]
}

fn served_names(host: &Host) -> Vec<&'static str> {
    served_definitions(host)
        .into_iter()
        .map(|definition| definition.name)
        .collect()
}

#[test]
fn app_process_tools_are_served_only_by_a_host_with_an_app_process_runtime() {
    let without = Host::new(None);
    let names = served_names(&without);
    for name in ["get_app_status", "control_app"] {
        assert!(!names.contains(&name));
        assert_eq!(check_tool(&without, name).unwrap_err().code, "UNKNOWN_TOOL");
    }

    let with = Host::new(Some(FakeApps::new(true)));
    let names = served_names(&with);
    for name in ["get_app_status", "control_app"] {
        assert!(names.contains(&name));
        assert!(check_tool(&with, name).is_ok());
    }
}

#[tokio::test]
async fn status_of_a_process_app_reads_the_host_state_with_declared_variable_names() {
    let fixture = fixture();
    let host = Host::new(Some(FakeApps::new(true)));

    let result = call(
        &host,
        &fixture,
        "get_app_status",
        json!({ "ownerPath": "apps/dev" }),
    )
    .await;
    let status = ok(&result);

    assert_eq!(status["spaceId"], "root");
    assert_eq!(status["ownerPath"], "apps/dev");
    assert_eq!(status["runtimeType"], "process");
    assert_eq!(status["manifestValid"], true);
    assert_eq!(status["state"], "ready");
    assert_eq!(status["url"], "http://127.0.0.1:3210");
    assert_eq!(status["urlReachable"], true);
    assert_eq!(status["managed"], true);
    assert_eq!(status["hasSetup"], true);
    assert_eq!(
        status["logs"],
        json!({ "stdout": "listening\n", "stderr": "warn: dev build\n" })
    );
    assert_eq!(status["variables"], json!(["API_TOKEN"]));
    assert!(!status.to_string().contains("Bearer"));

    let statuses = host.apps().statuses.lock().unwrap();
    assert_eq!(statuses.len(), 1);
    assert_eq!(statuses[0].project_path, fixture.project);
    assert_eq!(statuses[0].space_id, None);
    assert_eq!(statuses[0].owner_path, fixture.project.join("apps/dev"));
    assert_eq!(statuses[0].runtime.url, "http://127.0.0.1:3210");
    assert_eq!(
        statuses[0].runtime.environment_declaration["TOKEN"],
        "Bearer ${API_TOKEN}"
    );
    drop(statuses);
    assert_eq!(host.apps().calls().1, 0);
}

#[tokio::test]
async fn status_reports_runtime_without_a_process_and_manifest_diagnostics() {
    let fixture = fixture();
    let host = Host::new(Some(FakeApps::new(true)));

    let site = call(
        &host,
        &fixture,
        "get_app_status",
        json!({ "ownerPath": "apps/site" }),
    )
    .await;
    let site = ok(&site);
    assert_eq!(site["runtimeType"], "static");
    assert_eq!(site["state"], "no_process");
    assert_eq!(site["url"], Value::Null);

    let remote = call(
        &host,
        &fixture,
        "get_app_status",
        json!({ "ownerPath": "apps/remote" }),
    )
    .await;
    let remote = ok(&remote);
    assert_eq!(remote["runtimeType"], "url");
    assert_eq!(remote["state"], "no_process");
    assert_eq!(remote["url"], "https://example.com/tool");
    assert_eq!(remote["urlReachable"], Value::Null);

    let broken = call(
        &host,
        &fixture,
        "get_app_status",
        json!({ "ownerPath": "apps/broken" }),
    )
    .await;
    let broken = ok(&broken);
    assert_eq!(broken["manifestValid"], false);
    assert_eq!(broken["runtimeType"], Value::Null);
    assert!(!broken["diagnostics"].as_array().unwrap().is_empty());

    assert_eq!(host.apps().calls(), (0, 0));
}

#[tokio::test]
async fn an_app_is_addressed_by_owner_path_in_the_selected_space() {
    let fixture = fixture();
    let host = Host::new(Some(FakeApps::new(true)));

    let child = call(
        &host,
        &fixture,
        "get_app_status",
        json!({ "spaceId": "child", "ownerPath": "tool" }),
    )
    .await;
    let child = ok(&child);
    assert_eq!(child["spaceId"], "child");
    assert_eq!(child["ownerPath"], "tool");
    {
        let statuses = host.apps().statuses.lock().unwrap();
        assert_eq!(statuses[0].space_id.as_deref(), Some("child"));
        assert_eq!(statuses[0].owner_path, fixture.project.join("child/tool"));
    }

    let not_app = call(
        &host,
        &fixture,
        "get_app_status",
        json!({ "ownerPath": "notes" }),
    )
    .await;
    assert_eq!(error(&not_app)["code"], "NOT_AN_APP");
    let missing = call(
        &host,
        &fixture,
        "control_app",
        json!({ "ownerPath": "nowhere", "action": "start" }),
    )
    .await;
    assert_eq!(error(&missing)["code"], "FILE_NOT_FOUND");
    let crossing = call(
        &host,
        &fixture,
        "get_app_status",
        json!({ "ownerPath": "child/tool" }),
    )
    .await;
    assert_eq!(error(&crossing)["code"], "PATH_NOT_ACCESSIBLE");
    assert_eq!(host.apps().calls(), (1, 0));
}

#[tokio::test]
async fn a_project_without_a_window_has_no_app_processes() {
    let fixture = fixture();
    let host = Host::new(Some(FakeApps::new(false)));

    for (name, args) in [
        ("get_app_status", json!({ "ownerPath": "apps/dev" })),
        (
            "control_app",
            json!({ "ownerPath": "apps/dev", "action": "start" }),
        ),
    ] {
        let result = call(&host, &fixture, name, args).await;
        let error = error(&result);
        assert_eq!(error["code"], "APP_PROJECT_NOT_OPEN");
        assert!(
            error["hint"]
                .as_str()
                .unwrap()
                .contains("Open the project in Svode")
        );
    }
    assert_eq!(host.apps().calls(), (0, 0));
}

#[tokio::test]
async fn control_passes_each_action_and_returns_the_status_after_it() {
    let fixture = fixture();
    let host = Host::new(Some(FakeApps::new(true)));

    for (action, expected) in [
        ("start", AppProcessAction::Start),
        ("restart", AppProcessAction::Restart),
        ("stop", AppProcessAction::Stop),
        ("rerun_setup", AppProcessAction::RerunSetup),
    ] {
        let result = call(
            &host,
            &fixture,
            "control_app",
            json!({ "ownerPath": "apps/dev", "action": action }),
        )
        .await;
        assert_eq!(ok(&result)["state"], "ready");
        let controls = host.apps().controls.lock().unwrap();
        assert_eq!(controls.last().unwrap().1, expected);
        assert_eq!(
            controls.last().unwrap().0.owner_path,
            fixture.project.join("apps/dev")
        );
    }

    let unknown = call(
        &host,
        &fixture,
        "control_app",
        json!({ "ownerPath": "apps/dev", "action": "kill" }),
    )
    .await;
    assert!(unknown.is_error);
    assert_eq!(host.apps().calls(), (0, 4));
}

#[tokio::test]
async fn control_refuses_apps_without_a_managed_process_and_invalid_manifests() {
    let fixture = fixture();
    let host = Host::new(Some(FakeApps::new(true)));

    for (owner, runtime) in [("apps/site", "static"), ("apps/remote", "url")] {
        let result = call(
            &host,
            &fixture,
            "control_app",
            json!({ "ownerPath": owner, "action": "start" }),
        )
        .await;
        let error = error(&result);
        assert_eq!(error["code"], "APP_RUNTIME_WITHOUT_PROCESS");
        assert_eq!(error["runtimeType"], runtime);
    }
    let broken = call(
        &host,
        &fixture,
        "control_app",
        json!({ "ownerPath": "apps/broken", "action": "restart" }),
    )
    .await;
    let broken = error(&broken);
    assert_eq!(broken["code"], "APP_MANIFEST_INVALID");
    assert!(!broken["diagnostics"].as_array().unwrap().is_empty());
    assert_eq!(host.apps().calls(), (0, 0));
}

#[tokio::test]
async fn blocking_variables_are_named_without_values() {
    let fixture = fixture();
    let missing = Host::new(Some(FakeApps::answering(
        AppControlOutcome::VariablesMissing(vec![AppMissingVariable {
            reference_name: "API_TOKEN".into(),
            entry_name: "SHARED_TOKEN".into(),
        }]),
    )));
    let result = call(
        &missing,
        &fixture,
        "control_app",
        json!({ "ownerPath": "apps/dev", "action": "start" }),
    )
    .await;
    let error_value = error(&result);
    assert_eq!(error_value["code"], "APP_VARIABLES_BLOCKED");
    assert_eq!(error_value["reason"], "missing");
    assert_eq!(
        error_value["missingVariables"],
        json!([{ "referenceName": "API_TOKEN", "entryName": "SHARED_TOKEN" }])
    );
    assert!(
        error_value["hint"]
            .as_str()
            .unwrap()
            .contains("Settings → Variables")
    );

    let unreadable = Host::new(Some(FakeApps::answering(
        AppControlOutcome::VariablesUnreadable(json!({ "category": "legacy_format" })),
    )));
    let result = call(
        &unreadable,
        &fixture,
        "control_app",
        json!({ "ownerPath": "apps/dev", "action": "restart" }),
    )
    .await;
    let error_value = error(&result);
    assert_eq!(error_value["code"], "APP_VARIABLES_BLOCKED");
    assert_eq!(error_value["reason"], "unreadable");
    assert_eq!(error_value["variablesProblem"]["category"], "legacy_format");
}

#[tokio::test]
async fn a_failed_launch_returns_its_status_with_logs_and_stop_does_not_fail() {
    let fixture = fixture();
    let failed =
        AppControlOutcome::Process(report(AppProcessPhase::Failed, Some("setup_exit_non_zero")));
    let host = Host::new(Some(FakeApps::answering(failed)));

    for action in ["start", "restart", "rerun_setup"] {
        let result = call(
            &host,
            &fixture,
            "control_app",
            json!({ "ownerPath": "apps/dev", "action": action }),
        )
        .await;
        let error = error(&result);
        assert_eq!(error["code"], "APP_LAUNCH_FAILED");
        assert_eq!(error["status"]["state"], "failed");
        assert_eq!(error["status"]["reason"], "setup_exit_non_zero");
        assert_eq!(error["status"]["logs"]["stderr"], "warn: dev build\n");
        assert!(error["hint"].as_str().unwrap().contains("restart"));
    }

    let exited = Host::new(Some(FakeApps::answering(AppControlOutcome::Process(
        report(AppProcessPhase::Exited, Some("process_exited")),
    ))));
    let result = call(
        &exited,
        &fixture,
        "control_app",
        json!({ "ownerPath": "apps/dev", "action": "start" }),
    )
    .await;
    assert_eq!(error(&result)["code"], "APP_LAUNCH_FAILED");
    let result = call(
        &exited,
        &fixture,
        "control_app",
        json!({ "ownerPath": "apps/dev", "action": "stop" }),
    )
    .await;
    assert_eq!(ok(&result)["state"], "exited");
}

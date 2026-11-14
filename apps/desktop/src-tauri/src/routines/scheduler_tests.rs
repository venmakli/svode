use std::collections::BTreeMap;
use std::fs;
use std::future::pending;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::{SecondsFormat, TimeDelta, Utc};
use svode_core::collections::engine::ItemFieldBatchIntent;
use svode_core::git::cli::GitCli;
use svode_core::index::IndexKey;
use svode_core::index::state::IndexRuntimeState;
use svode_core::page::PageError;
use svode_core::page::fields::PageFieldUpdate;
use svode_core::page::write::PageRuntime;
use svode_core::routines::model::RoutineOwnerInputKind;
use svode_core::runtime::session::ProjectSession;
use tokio::sync::oneshot;

use super::*;

const ACTOR: &str = "01arz3ndektsv4rrffq69g5fav";

/// Records what a tick dispatches; every check before dispatch passes.
#[derive(Default)]
struct RecordingHost {
    stores: RoutineStores,
    scheduled: Mutex<Vec<String>>,
    scheduled_spaces: Mutex<Vec<String>>,
    events: Mutex<Vec<QueuedRoutineEvent>>,
}

impl RecordingHost {
    fn scheduled(&self) -> Vec<String> {
        self.scheduled.lock().unwrap().clone()
    }

    /// The Space id of the owner of each scheduled dispatch.
    fn scheduled_spaces(&self) -> Vec<String> {
        self.scheduled_spaces.lock().unwrap().clone()
    }

    fn events(&self) -> Vec<QueuedRoutineEvent> {
        self.events.lock().unwrap().clone()
    }
}

impl SchedulerHost for RecordingHost {
    type Gate = ();

    fn routine_stores(&self) -> &RoutineStores {
        &self.stores
    }

    fn live_evidence(&self) -> Result<RoutineLiveEvidence, AppError> {
        Ok(RoutineLiveEvidence::default())
    }

    async fn dispatch_ready(&self, _: &ResolvedRoutineOwner, _: &RoutineDefinition) -> bool {
        true
    }

    async fn event_preflight(
        &self,
        _: &ResolvedRoutineOwner,
        _: &QueuedRoutineEvent,
    ) -> Option<EventDispatchPreflight> {
        Some(EventDispatchPreflight::RunAgent)
    }

    async fn mutation_paths_ready(&self, _: Vec<PathBuf>) -> bool {
        true
    }

    async fn repository_gate(&self, _: &ResolvedRoutineOwner) -> Result<Option<()>, AppError> {
        Ok(Some(()))
    }

    async fn claim(
        &self,
        _: &(),
        _: &str,
        _: &str,
        _: i64,
        run_key: impl FnOnce(&str) -> String + Send,
    ) -> Result<Option<(String, RoutineClaimResult)>, AppError> {
        Ok(Some((run_key("repository"), RoutineClaimResult::Local)))
    }

    async fn dispatch_scheduled(
        &self,
        owner: ResolvedRoutineOwner,
        routine_id: String,
    ) -> Result<RoutineDispatchResult, AppError> {
        self.scheduled.lock().unwrap().push(routine_id);
        self.scheduled_spaces
            .lock()
            .unwrap()
            .push(owner.descriptor.space_id);
        Ok(RoutineDispatchResult::Completed)
    }

    async fn dispatch_event(
        &self,
        _: ResolvedRoutineOwner,
        event: QueuedRoutineEvent,
        _: String,
    ) -> Result<RoutineDispatchResult, AppError> {
        self.events.lock().unwrap().push(event);
        Ok(RoutineDispatchResult::Completed)
    }

    fn invalidate(&self, _: &ResolvedRoutineOwner) {}
}

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

/// A project with one Agent Actor, as the project registry lists it.
fn project(temp: &tempfile::TempDir, name: &str) -> PathBuf {
    let root = temp.path().canonicalize().unwrap().join(name);
    write(
        &root.join(".svode/config.json"),
        &format!(r#"{{"name":"{name}"}}"#),
    );
    write(
        &root.join(".svode/agent-actors.json"),
        &format!(
            r#"{{"schemaVersion":1,"actors":[{{"id":"{ACTOR}","name":"Agent","adapters":[{{"adapter":"claude"}}]}}]}}"#
        ),
    );
    fs::create_dir_all(root.join(".git")).unwrap();
    root
}

fn schedule_routine(root: &Path) {
    schedule_routine_with_id(root, "01arz3ndektsv4rrffq69g5fb0");
}

fn schedule_routine_with_id(root: &Path, id: &str) {
    write(
        &root.join(".routines/minute.md"),
        &format!(
            "---\nid: {id}\nname: Every minute\nenabled: true\ntrigger:\n  type: schedule\n  cron: '* * * * *'\n  time_basis:\n    mode: fixed\n    timezone: UTC\n  missed_runs: run_once\naction:\n  type: run_agent\n  executor: agent:{ACTOR}\n---\nCheck.\n"
        ),
    );
}

fn owner(root: &Path, owner_path: &str, kind: RoutineOwnerInputKind) -> ResolvedRoutineOwner {
    service::resolve_owner(root, root, "root", owner_path, kind).unwrap()
}

async fn set_authority(host: &RecordingHost, owner: &ResolvedRoutineOwner, enabled: bool) {
    host.stores
        .get_or_create(&owner.index_key, &owner.space_path)
        .await
        .unwrap();
    authority::set_key(&owner.space_path, &owner.identity(), enabled).unwrap();
}

/// Moves the schedule checkpoint of every Routine of the owner into the
/// past, so the next check has a due slot.
async fn backdate_schedule(host: &RecordingHost, owner: &ResolvedRoutineOwner) {
    let pool = host
        .stores
        .get_or_create(&owner.index_key, &owner.space_path)
        .await
        .unwrap();
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT routine_id, definition_fingerprint, next_run_at FROM routine_schedule_state",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert!(!rows.is_empty(), "the first check records the schedule");
    let past = (Utc::now() - TimeDelta::minutes(3)).to_rfc3339_opts(SecondsFormat::Secs, true);
    for (routine_id, fingerprint, next_run_at) in rows {
        write_schedule_state(
            &pool,
            &owner.descriptor.owner_path,
            &routine_id,
            &fingerprint,
            &past,
            &next_run_at,
        )
        .await
        .unwrap();
    }
}

/// Stage 10 `09`, Routines of every project: a project no window has open
/// is checked by its schedule. The host has no index runtime at all.
#[tokio::test]
async fn a_project_without_a_window_runs_its_due_schedule() {
    let temp = tempfile::tempdir().unwrap();
    let root = project(&temp, "project");
    schedule_routine(&root);
    let host = RecordingHost::default();
    let root_owner = owner(&root, ".", RoutineOwnerInputKind::RegisteredSpace);
    set_authority(&host, &root_owner, true).await;

    tick_project(&host, &root).await.unwrap();
    assert!(
        host.scheduled().is_empty(),
        "the first check sets the baseline"
    );

    backdate_schedule(&host, &root_owner).await;
    tick_project(&host, &root).await.unwrap();

    assert_eq!(host.scheduled().len(), 1);
}

#[tokio::test]
async fn automatic_authority_off_runs_no_schedule() {
    let temp = tempfile::tempdir().unwrap();
    let root = project(&temp, "project");
    schedule_routine(&root);
    let host = RecordingHost::default();
    let root_owner = owner(&root, ".", RoutineOwnerInputKind::RegisteredSpace);
    set_authority(&host, &root_owner, false).await;

    tick_project(&host, &root).await.unwrap();
    backdate_schedule(&host, &root_owner).await;
    tick_project(&host, &root).await.unwrap();

    assert!(host.scheduled().is_empty());
}

#[tokio::test]
async fn an_unavailable_project_does_not_hold_up_the_others() {
    let temp = tempfile::tempdir().unwrap();
    let root = project(&temp, "project");
    schedule_routine(&root);
    let missing = temp.path().join("missing");
    let host = RecordingHost::default();
    let root_owner = owner(&root, ".", RoutineOwnerInputKind::RegisteredSpace);
    set_authority(&host, &root_owner, true).await;
    tick_project(&host, &root).await.unwrap();
    backdate_schedule(&host, &root_owner).await;

    tick_project(&host, &missing).await.unwrap();
    tick_project(&host, &root).await.unwrap();

    assert!(!missing.exists(), "the check creates nothing in its place");
    assert_eq!(host.scheduled().len(), 1);
}

const BROKEN_ROUTINE: &str = "01arz3ndektsv4rrffq69g5fb2";
const OTHER_ROUTINE: &str = "01arz3ndektsv4rrffq69g5fb3";

/// A project with two inline child Spaces, `broken` and `other`, and a
/// minute schedule with automatic authority in the root and in each Space.
async fn project_with_spaces(
    temp: &tempfile::TempDir,
    host: &RecordingHost,
) -> (PathBuf, Vec<ResolvedRoutineOwner>) {
    let root = project(temp, "project");
    write(
        &root.join(".svode/config.json"),
        r#"{"name":"project","spaces":[{"id":"broken","path":"broken"},{"id":"other","path":"other"}]}"#,
    );
    schedule_routine(&root);
    let mut owners = vec![owner(&root, ".", RoutineOwnerInputKind::RegisteredSpace)];
    for (space_id, routine) in [("broken", BROKEN_ROUTINE), ("other", OTHER_ROUTINE)] {
        let space = root.join(space_id);
        write(
            &space.join(".svode/config.json"),
            &format!(r#"{{"name":"{space_id}"}}"#),
        );
        schedule_routine_with_id(&space, routine);
        owners.push(
            service::resolve_owner(
                &root,
                &space,
                space_id,
                ".",
                RoutineOwnerInputKind::RegisteredSpace,
            )
            .unwrap(),
        );
    }
    for owner in &owners {
        set_authority(host, owner, true).await;
    }
    (root, owners)
}

async fn schedule_rows(host: &RecordingHost, owner: &ResolvedRoutineOwner) -> i64 {
    let pool = host
        .stores
        .get_or_create(&owner.index_key, &owner.space_path)
        .await
        .unwrap();
    sqlx::query_scalar("SELECT COUNT(*) FROM routine_schedule_state")
        .fetch_one(&pool)
        .await
        .unwrap()
}

/// DF-279 R1, R2: a Space whose config has no `name` is left out, while the
/// due schedules of the root and of another Space run; it takes no slot,
/// and once `name` is back the next check covers its Routines again.
#[tokio::test]
async fn a_space_with_an_unreadable_config_does_not_hold_up_the_project() {
    let temp = tempfile::tempdir().unwrap();
    let host = RecordingHost::default();
    let (root, owners) = project_with_spaces(&temp, &host).await;
    let broken_config = root.join("broken/.svode/config.json");
    fs::write(&broken_config, r#"{"description":""}"#).unwrap();

    tick_project(&host, &root).await.unwrap();
    backdate_schedule(&host, &owners[0]).await;
    backdate_schedule(&host, &owners[2]).await;
    let check = tick_project(&host, &root).await.unwrap();

    let mut scheduled = host.scheduled_spaces();
    scheduled.sort();
    assert_eq!(scheduled, ["other", "root"]);
    assert_eq!(
        schedule_rows(&host, &owners[1]).await,
        0,
        "the left-out Space takes no slot"
    );
    let ProjectCheck::Checked { spaces, excluded } = check else {
        panic!("the project is checked");
    };
    assert_eq!(spaces, ["other"]);
    assert_eq!(
        excluded,
        [ExcludedRoutineSpace {
            space_id: "broken".into(),
            reason: ExcludedSpaceReason::Config(Unreadable::Field {
                field: "name".into(),
            }),
        }]
    );

    fs::write(&broken_config, r#"{"name":"broken"}"#).unwrap();
    tick_project(&host, &root).await.unwrap();
    backdate_schedule(&host, &owners[1]).await;
    tick_project(&host, &root).await.unwrap();

    let scheduled = host.scheduled_spaces();
    assert!(
        scheduled.iter().any(|space| space == "broken"),
        "{scheduled:?}"
    );
}

/// Log lines a test writes through the default subscriber of its thread.
#[derive(Clone, Default)]
struct CapturedLog(std::sync::Arc<Mutex<Vec<u8>>>);

impl CapturedLog {
    fn take(&self) -> Vec<String> {
        let bytes = std::mem::take(&mut *self.0.lock().unwrap());
        String::from_utf8(bytes)
            .unwrap()
            .lines()
            .filter(|line| line.contains(" svode_"))
            .map(str::to_owned)
            .collect()
    }
}

impl std::io::Write for CapturedLog {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for CapturedLog {
    type Writer = CapturedLog;

    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

/// DF-279 R3: an unchanged exclusion is logged once, not on every check,
/// and its end once; the folder name of the left-out Space is taken without
/// a warning. The same holds for a project whose config cannot be read.
#[tokio::test]
async fn an_exclusion_is_logged_when_it_changes() {
    let log = CapturedLog::default();
    let _subscriber = tracing::subscriber::set_default(
        tracing_subscriber::fmt()
            .with_writer(log.clone())
            .with_ansi(false)
            .finish(),
    );
    let temp = tempfile::tempdir().unwrap();
    let host = RecordingHost::default();
    let (root, _) = project_with_spaces(&temp, &host).await;
    let mut exclusions = ExclusionLog::default();
    log.take();

    fs::write(
        root.join("broken/.svode/config.json"),
        r#"{"description":""}"#,
    )
    .unwrap();
    for _ in 0..3 {
        check_project(&host, &root, &mut exclusions).await;
    }
    let lines = log.take();
    assert_eq!(lines.len(), 1, "{lines:#?}");
    assert!(lines[0].contains("WARN"), "{lines:#?}");
    assert!(
        lines[0].contains("leaves out the Space")
            && lines[0].contains("broken")
            && lines[0].contains("Svode cannot read the field `name`"),
        "{lines:#?}"
    );

    fs::write(
        root.join("broken/.svode/config.json"),
        r#"{"name":"broken"}"#,
    )
    .unwrap();
    for _ in 0..2 {
        check_project(&host, &root, &mut exclusions).await;
    }
    let lines = log.take();
    assert_eq!(lines.len(), 1, "{lines:#?}");
    assert!(
        lines[0].contains("checks the Space again") && lines[0].contains("broken"),
        "{lines:#?}"
    );

    let config = root.join(".svode/config.json");
    let readable = fs::read_to_string(&config).unwrap();
    fs::write(&config, "<<<<<<< ours\n{}\n=======\n{}\n>>>>>>> theirs\n").unwrap();
    for _ in 0..3 {
        check_project(&host, &root, &mut exclusions).await;
    }
    let lines = log.take();
    assert_eq!(lines.len(), 1, "{lines:#?}");
    assert!(
        lines[0].contains("WARN")
            && lines[0].contains("skips the project")
            && lines[0].contains("it is in a conflict after sync"),
        "{lines:#?}"
    );

    fs::write(&config, readable).unwrap();
    for _ in 0..2 {
        check_project(&host, &root, &mut exclusions).await;
    }
    let lines = log.take();
    assert_eq!(lines.len(), 1, "{lines:#?}");
    assert!(lines[0].contains("checks the project again"), "{lines:#?}");
}

/// An event a Svode MCP write records in a project no window has open is
/// dispatched by the scheduler of that project.
#[tokio::test]
async fn an_event_written_by_svode_mcp_without_a_window_is_dispatched() {
    let temp = tempfile::tempdir().unwrap();
    let root = project(&temp, "project");
    write(
        &root.join("tasks/schema.yaml"),
        "columns:\n  - { name: Status, type: text }\nviews: []\n",
    );
    write(
        &root.join("tasks/alpha.md"),
        "---\ntitle: Alpha\nStatus: Todo\n---\nAlpha body\n",
    );
    write(
        &root.join("tasks/.routines/status.md"),
        "---\nid: 01arz3ndektsv4rrffq69g5fb1\nname: On Status\nenabled: true\ntrigger:\n  type: event\n  event: collection.field_changed\n  match:\n    field: Status\naction:\n  type: update_properties\n  target: trigger.entry\n  set:\n    Status: Checked\n---\nReview.\n",
    );
    let host = RecordingHost::default();
    let tasks = owner(&root, "tasks", RoutineOwnerInputKind::CollectionDirectory);
    // The desktop app had read the Routines of the Collection, and automatic
    // Routines are enabled for it on this device.
    service::read_catalog(
        &host.stores,
        &IndexRuntimeState::default(),
        &RoutineLiveEvidence::default(),
        &tasks,
    )
    .await
    .unwrap();
    set_authority(&host, &tasks, true).await;

    // Svode MCP serves the project without a window through its session.
    let session = ProjectSession::new();
    session.open_project(&root).await.unwrap();
    session
        .prepare_index(&[IndexKey::Root(root.clone())])
        .await
        .unwrap();
    let space = root.to_string_lossy().into_owned();
    let values = BTreeMap::from([("Status".to_string(), serde_json::json!("Done"))]);
    svode_core::page::fields::update(
        PageFieldUpdate {
            space: &space,
            path: "tasks/alpha.md",
            project: Some(&space),
            values: &values,
            intent: ItemFieldBatchIntent::Literal,
        },
        PageRuntime {
            index: session.index(),
            updates: session.index_updates(),
            nonces: session.nonces(),
            git_dates: None::<&GitCli>,
        },
        |paths| async {
            session.prepare_mutation(&paths).await.unwrap();
            Ok::<_, PageError>(paths)
        },
    )
    .await
    .unwrap();
    session.close().await;

    tick_project(&host, &root).await.unwrap();

    let events = host.events();
    assert_eq!(events.len(), 1);
    let payload: svode_core::routines::observation::CollectionEventPayload =
        serde_json::from_str(&events[0].payload_json).unwrap();
    assert_eq!(payload.item_path, "tasks/alpha.md");
    let pool = host
        .stores
        .get_or_create(&tasks.index_key, &tasks.space_path)
        .await
        .unwrap();
    let state: String = sqlx::query_scalar("SELECT state FROM routine_event_queue")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(state, "completed");
}

struct DropSignal(Option<oneshot::Sender<()>>);

impl Drop for DropSignal {
    fn drop(&mut self) {
        if let Some(sender) = self.0.take() {
            let _ = sender.send(());
        }
    }
}

fn pending_task(stopped: &mut Vec<oneshot::Receiver<()>>) -> tauri::async_runtime::JoinHandle<()> {
    let (sender, receiver) = oneshot::channel();
    stopped.push(receiver);
    // Created before spawning so an abort before the first poll still
    // signals: the task runs on the Tauri runtime, not the test's.
    let signal = DropSignal(Some(sender));
    tauri::async_runtime::spawn(async move {
        let _signal = signal;
        pending::<()>().await;
    })
}

/// One scheduler per listed project: another sync, such as after a window
/// opened or released a project, starts no second one; a project leaving
/// the list loses its scheduler and the others keep theirs.
#[tokio::test]
async fn the_registry_keeps_one_scheduler_per_listed_project() {
    let schedulers = RoutineSchedulerState::new();
    let first = (String::from("first"), PathBuf::from("/first"));
    let second = (String::from("second"), PathBuf::from("/second"));
    let mut tasks = Vec::new();

    let mut started = Vec::new();
    schedulers.sync_projects(vec![first.clone(), second.clone()], |path| {
        started.push(path);
        pending_task(&mut tasks)
    });
    assert_eq!(started, [first.1.clone(), second.1.clone()]);

    let removed = schedulers.sync_projects(vec![first.clone(), second.clone()], |path| {
        panic!("{} already has a scheduler", path.display())
    });
    assert!(removed.is_empty());

    let removed = schedulers.sync_projects(vec![second.clone()], |path| {
        panic!("{} already has a scheduler", path.display())
    });
    assert_eq!(removed, [first.1.clone()]);
    let mut tasks = tasks.into_iter();
    tasks.next().unwrap().await.unwrap();
    let mut second_task = tasks.next().unwrap();
    tokio::task::yield_now().await;
    assert!(second_task.try_recv().is_err());

    schedulers.stop_all();
    second_task.await.unwrap();
}

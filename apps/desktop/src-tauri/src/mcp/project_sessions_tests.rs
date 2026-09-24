//! Bridge requests of a project without a window, on the desktop index
//! runtime and the session registry, through the shared tool dispatch
//! against real fixture projects.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use svode_core::actors::resolver::ActorCatalogState;
use svode_core::attachments::import::{LfsReadiness, ManagedImportDelivery};
use svode_core::git::access::{RepositoryAccessSnapshot, RepositoryAccessStatus};
use svode_core::git::cli::GitCli;
use svode_core::git::state::GitRuntime;
use svode_core::index::IndexKey;
use svode_core::index::knowledge::KnowledgeScope;
use svode_core::index::reindex::full_reindex;
use svode_core::index::resolver::ProjectSpacesCache;
use svode_core::index::update::IndexUpdateState;
use svode_core::page::nonce::WriteNonceRegistry;
use svode_core::routines::model::{ResolvedRoutineOwner, RoutineLiveEvidence};
use svode_core::routines::store_state::RoutineStoreState;
use svode_tools::dispatch::call_tool;
use svode_tools::host::{
    MutationRuntime, ReadRuntime, RequestTarget, RoutineRunner, RoutineRuntime, ToolHost,
};
use svode_tools::result::ToolCallResult;

use super::*;

/// Recheck window of the core session, waited out to see a later check.
const RECHECK: Duration = Duration::from_millis(2100);

/// Desktop process state a bridge request reads: the index runtime of the
/// windows and the registry of on-demand sessions.
struct Desktop {
    index: IndexRuntimeState,
    updates: IndexUpdateState,
    nonces: WriteNonceRegistry,
    actors: ActorCatalogState,
    git: GitRuntime,
    routines: Arc<RoutineStoreState>,
    sessions: ProjectSessions,
}

impl Desktop {
    fn new() -> Self {
        Self::with_idle(IDLE_CLOSE)
    }

    fn with_idle(idle: Duration) -> Self {
        let routines = Arc::new(RoutineStoreState::new());
        Self {
            index: IndexRuntimeState::default(),
            updates: IndexUpdateState::new(routines.clone()),
            nonces: WriteNonceRegistry::new(),
            actors: ActorCatalogState::new(),
            git: GitRuntime::new(),
            routines,
            sessions: ProjectSessions::with_idle(idle),
        }
    }

    /// One bridge request, picking its runtime as the desktop host does.
    async fn call(&self, project: &Path, name: &str, arguments: Value) -> ToolCallResult {
        let host = BridgeHost {
            desktop: self,
            session: RequestSession::default(),
        };
        host.session
            .attach_existing(&self.sessions, &self.index, project)
            .await;
        call_tool(&host, Some(&target(project)), name, arguments).await
    }

    async fn ok(&self, project: &Path, name: &str, arguments: Value) -> Value {
        let result = self.call(project, name, arguments).await;
        assert!(!result.is_error, "{name}: {:?}", result.structured_content);
        result.structured_content.unwrap()
    }

    async fn error(&self, project: &Path, name: &str, arguments: Value) -> Value {
        let result = self.call(project, name, arguments).await;
        assert!(result.is_error, "{name}: {:?}", result.structured_content);
        result.structured_content.unwrap()["error"].clone()
    }

    /// A window opens the project: the project runtime opens its pools,
    /// then hands the bridge session over.
    async fn open_window(&self, project: &Path) {
        self.index
            .replace_project_cache(project, ProjectSpacesCache::from_project(project).unwrap())
            .await;
        for key in self.index.keys_for_project(project).await {
            self.index.get_or_create(&key).await.unwrap();
        }
        self.sessions.close(project).await;
    }

    async fn close_window(&self, project: &Path) {
        self.index.close_project(project).await;
        self.sessions.close(project).await;
    }

    async fn lease(&self, project: &Path) -> SessionLease {
        self.sessions.existing(project, &self.index).await.unwrap()
    }
}

struct BridgeHost<'a> {
    desktop: &'a Desktop,
    session: RequestSession,
}

impl ToolHost for BridgeHost<'_> {
    fn version(&self) -> &str {
        "test"
    }

    fn serves_tool(&self, _name: &str) -> bool {
        true
    }

    async fn prepare_mutation(&self, paths: &[PathBuf]) {
        self.session.prepare_mutation(paths).await;
    }

    async fn prepare_index(
        &self,
        project: &Path,
        scope: &KnowledgeScope,
    ) -> Result<IndexFreshness, ToolError> {
        self.session
            .prepare_index(&self.desktop.sessions, &self.desktop.index, project, scope)
            .await
    }

    async fn index_pool(&self, key: &IndexKey, space_path: &Path) -> Option<SqlitePool> {
        self.session
            .index_pool(&self.desktop.index, key, space_path)
            .await
    }

    async fn repository_access(
        &self,
        _space_path: &Path,
    ) -> Result<RepositoryAccessSnapshot, ToolError> {
        Ok(RepositoryAccessSnapshot {
            repository_id: "fixture".to_string(),
            generation: 1,
            status: RepositoryAccessStatus::Local,
            reason: None,
            checked_at: None,
            expires_at: None,
            last_known_status: None,
        })
    }

    async fn require_mutation_access(&self, _repository: &Path) -> Result<(), ToolError> {
        Ok(())
    }

    fn mutation_runtime(&self) -> MutationRuntime<'_> {
        self.session.mutation_runtime(MutationRuntime {
            index: &self.desktop.index,
            updates: &self.desktop.updates,
            nonces: &self.desktop.nonces,
        })
    }

    fn read_runtime(&self) -> ReadRuntime<'_> {
        ReadRuntime {
            index: self.session.index(&self.desktop.index),
            actors: &self.desktop.actors,
            git: &self.desktop.git,
        }
    }

    fn lfs_readiness(&self) -> Option<&dyn LfsReadiness> {
        None
    }

    fn deliver_managed_import(&self, _delivery: &ManagedImportDelivery) {}

    fn routine_runtime(&self) -> Result<RoutineRuntime<'_>, ToolError> {
        Ok(RoutineRuntime {
            stores: &self.desktop.routines,
            live_evidence: RoutineLiveEvidence::default(),
        })
    }

    fn deliver_routine_invalidation(&self, _owner: &ResolvedRoutineOwner) {}

    fn routine_runner(&self) -> Option<&dyn RoutineRunner> {
        None
    }
}

fn target(project: &Path) -> RequestTarget {
    RequestTarget {
        project_path: project.to_string_lossy().to_string(),
        default_space_id: None,
        default_space_path: project.to_string_lossy().to_string(),
        routine_caller: None,
    }
}

struct Fixture {
    _temp: tempfile::TempDir,
    project: PathBuf,
}

fn write(path: &Path, contents: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

fn git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(output.status.success(), "git {args:?}");
    String::from_utf8(output.stdout).unwrap()
}

/// Committed project with a `tasks` Collection, Pages mentioning "Needle"
/// and a child Space, as in the observation of the bridge.
fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let project = project.canonicalize().unwrap();
    write(
        &project.join(".svode/config.json"),
        &json!({
            "name": "Project",
            "spaces": [
                { "id": "child", "path": "child", "repo": null },
                { "id": "ghost", "path": "ghost", "repo": null }
            ]
        })
        .to_string(),
    );
    write(
        &project.join("child/.svode/config.json"),
        &json!({ "name": "Child" }).to_string(),
    );
    write(&project.join("README.md"), "---\ntitle: Project\n---\n");
    write(
        &project.join("notes.md"),
        "---\ntitle: Notes\n---\nNeedle root body [Alpha](tasks/alpha.md)\n",
    );
    write(
        &project.join("tasks/schema.yaml"),
        "columns:\n  - name: Status\n    type: text\nviews:\n  - type: table\n    name: Table\n",
    );
    write(&project.join("tasks/README.md"), "---\ntitle: Tasks\n---\n");
    write(
        &project.join("tasks/alpha.md"),
        "---\ntitle: Alpha\nStatus: Todo\n---\nAlpha body\n",
    );
    write(
        &project.join("tasks/beta.md"),
        "---\ntitle: Beta\nStatus: Done\n---\nBeta body\n",
    );
    write(&project.join("child/README.md"), "---\ntitle: Child\n---\n");
    write(
        &project.join("child/brief.md"),
        "---\ntitle: Brief\n---\nNeedle child body\n",
    );
    git(&project, &["init", "-q"]);
    git(&project, &["config", "user.email", "agent@example.com"]);
    git(&project, &["config", "user.name", "Agent"]);
    git(&project, &["add", "-A"]);
    git(&project, &["commit", "-q", "-m", "fixture"]);
    Fixture {
        _temp: temp,
        project,
    }
}

/// Every source file outside `.svode` with its bytes.
fn sources(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy();
            if name == ".svode" || name == ".git" {
                continue;
            }
            if path.is_dir() {
                stack.push(path);
            } else {
                out.push((path.clone(), fs::read(&path).unwrap()));
            }
        }
    }
    out.sort();
    out
}

fn verified_at(value: &Value) -> String {
    assert_eq!(value["index"]["status"], "fresh", "{value}");
    value["index"]["verifiedAt"]
        .as_str()
        .unwrap_or_else(|| panic!("no verifiedAt: {value}"))
        .to_string()
}

fn paths(value: &Value) -> Vec<String> {
    let mut paths = value["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["path"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

fn titles(value: &Value) -> Vec<String> {
    let mut titles = value["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["meta"]["title"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    titles.sort();
    titles
}

fn root(project: &Path) -> IndexKey {
    IndexKey::Root(project.to_path_buf())
}

fn assert_released(space: &Path) {
    for name in ["index.db-wal", "routines.db-wal"] {
        assert!(!space.join(".svode").join(name).exists(), "{name}");
    }
}

#[tokio::test]
async fn an_unopened_project_is_served_by_an_on_demand_session() {
    let fixture = fixture();
    let project = &fixture.project;
    let desktop = Desktop::new();
    let head = git(project, &["rev-parse", "HEAD"]);
    let before = sources(project);

    let items = desktop
        .ok(
            project,
            "query_collection_items",
            json!({ "collectionPath": "tasks" }),
        )
        .await;
    verified_at(&items);
    assert_eq!(titles(&items), ["Alpha", "Beta"]);
    let search = desktop
        .ok(project, "search_pages", json!({ "query": "Needle" }))
        .await;
    verified_at(&search);
    assert_eq!(paths(&search), ["notes.md"]);
    let child = desktop
        .ok(
            project,
            "search_pages",
            json!({ "query": "Needle", "spaceId": "child" }),
        )
        .await;
    verified_at(&child);
    assert_eq!(paths(&child), ["brief.md"]);

    let status = desktop
        .ok(
            project,
            "get_knowledge_status",
            json!({ "scope": "project" }),
        )
        .await;
    verified_at(&status);
    assert_eq!(status["counts"]["readablePools"], 2);
    let knowledge = desktop
        .ok(
            project,
            "search_knowledge",
            json!({ "query": "Needle", "scope": "project" }),
        )
        .await;
    verified_at(&knowledge);
    assert!(
        !knowledge["items"].as_array().unwrap().is_empty(),
        "{knowledge}"
    );
    let node = desktop
        .ok(
            project,
            "get_knowledge_node",
            json!({ "nodeId": "page:root:notes.md" }),
        )
        .await;
    verified_at(&node);
    assert_eq!(node["node"]["title"], "Notes");
    let neighbors = desktop
        .ok(
            project,
            "get_knowledge_neighbors",
            json!({ "nodeId": "page:root:notes.md" }),
        )
        .await;
    verified_at(&neighbors);
    let related = desktop
        .ok(project, "get_related_context", json!({ "query": "Needle" }))
        .await;
    verified_at(&related);

    // The session is not a window runtime and leaves sources and Git alone;
    // it writes only derived and device-local stores under `.svode`.
    assert!(!desktop.index.is_project_open(project).await);
    assert!(desktop.index.existing_pool(&root(project)).await.is_none());
    assert_eq!(desktop.sessions.projects().await, [project.clone()]);
    assert_eq!(sources(project), before);
    assert_eq!(git(project, &["rev-parse", "HEAD"]), head);
    assert_eq!(
        git(project, &["status", "--porcelain", "--untracked-files=no"]),
        ""
    );
    desktop.sessions.close_all().await;
    assert_released(project);
    assert_released(&project.join("child"));
}

#[tokio::test]
async fn the_session_follows_the_headless_freshness_rule() {
    let fixture = fixture();
    let project = &fixture.project;
    let desktop = Desktop::new();
    fs::create_dir_all(project.join(".svode")).unwrap();
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(project.join(".svode/index.db"))
        .create_if_missing(true);
    let foreign = SqlitePool::connect_with(options).await.unwrap();
    sqlx::query("CREATE TABLE foreign_cache (value TEXT)")
        .execute(&foreign)
        .await
        .unwrap();
    foreign.close().await;

    // Two first reads share one check, which quarantines the foreign cache
    // and rebuilds the index before either answers.
    let (search, items) = tokio::join!(
        desktop.ok(project, "search_pages", json!({ "query": "Needle" })),
        desktop.ok(
            project,
            "query_collection_items",
            json!({ "collectionPath": "tasks" })
        ),
    );
    let first = verified_at(&search);
    assert_eq!(verified_at(&items), first);
    assert_eq!(paths(&search), ["notes.md"]);
    let quarantined = fs::read_dir(project.join(".svode"))
        .unwrap()
        .filter(|entry| {
            entry
                .as_ref()
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("index.db.incompatible-")
        })
        .count();
    assert_eq!(quarantined, 1);

    // An external edit is seen once the window has passed.
    write(
        &project.join("extra.md"),
        "---\ntitle: Extra\n---\nNeedle extra\n",
    );
    write(
        &project.join("archive/old.md"),
        "---\ntitle: Old\n---\nNeedle archive\n",
    );
    tokio::time::sleep(RECHECK).await;
    let later = desktop
        .ok(project, "search_pages", json!({ "query": "Needle" }))
        .await;
    assert!(verified_at(&later) > first);
    assert_eq!(paths(&later), ["archive/old.md", "extra.md", "notes.md"]);

    // A folder the scan cannot read keeps the earlier rows of its sources.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let archive = project.join("archive");
        fs::set_permissions(&archive, fs::Permissions::from_mode(0o000)).unwrap();
        tokio::time::sleep(RECHECK).await;
        let partial = desktop
            .ok(project, "search_pages", json!({ "query": "Needle" }))
            .await;
        fs::set_permissions(&archive, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(partial["index"]["status"], "partial", "{partial}");
        assert_eq!(
            partial["index"]["diagnostics"][0]["code"], "scan_incomplete",
            "{partial}"
        );
        assert_eq!(paths(&partial), ["archive/old.md", "extra.md", "notes.md"]);
    }
    desktop.sessions.close_all().await;
}

#[tokio::test]
async fn managed_mutations_publish_into_an_existing_session_only() {
    let fixture = fixture();
    let project = &fixture.project;
    let desktop = Desktop::new();

    // Without a session a mutation neither creates one nor waits for it.
    desktop
        .ok(
            project,
            "update_collection_item_fields",
            json!({ "path": "tasks/alpha.md", "fields": { "Status": "Doing" } }),
        )
        .await;
    assert!(desktop.sessions.projects().await.is_empty());

    let done = json!({
        "collectionPath": "tasks",
        "filter": [{ "field": "Status", "op": "eq", "value": "Done" }]
    });
    let first = desktop
        .ok(project, "query_collection_items", done.clone())
        .await;
    assert_eq!(titles(&first), ["Beta"]);
    desktop
        .ok(
            project,
            "update_collection_item_fields",
            json!({ "path": "tasks/alpha.md", "fields": { "Status": "Done" } }),
        )
        .await;
    // The mutation published into the session pool itself, so the next read
    // sees it whether or not it checks the files again.
    let pool = desktop
        .lease(project)
        .await
        .index()
        .existing_pool(&root(project))
        .await
        .unwrap();
    let fields: String =
        sqlx::query_scalar("SELECT fields FROM entries WHERE file_path = 'tasks/alpha.md'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(fields.contains("Done"), "{fields}");
    let next = desktop.ok(project, "query_collection_items", done).await;
    assert_eq!(titles(&next), ["Alpha", "Beta"]);
    desktop.sessions.close_all().await;
}

#[tokio::test]
async fn source_reads_take_index_dates_only_from_an_existing_session() {
    let fixture = fixture();
    let project = &fixture.project;
    let desktop = Desktop::new();
    let read = json!({ "path": "notes.md" });

    let dated = desktop.ok(project, "read_page", read.clone()).await;
    let git_updated = dated["page"]["meta"]["updated"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(desktop.sessions.projects().await.is_empty());

    desktop
        .ok(project, "search_pages", json!({ "query": "Needle" }))
        .await;
    let pool = desktop
        .lease(project)
        .await
        .index()
        .existing_pool(&root(project))
        .await
        .unwrap();
    sqlx::query("UPDATE entries SET updated = 'indexed-updated' WHERE file_path = 'notes.md'")
        .execute(&pool)
        .await
        .unwrap();
    let indexed = desktop.ok(project, "read_page", read).await;
    assert_eq!(indexed["page"]["meta"]["updated"], "indexed-updated");
    assert_ne!(git_updated, "indexed-updated");
    desktop.sessions.close_all().await;
}

#[tokio::test]
async fn a_window_takes_the_project_over_and_hands_it_back() {
    let fixture = fixture();
    let project = &fixture.project;
    let desktop = Desktop::new();
    desktop
        .ok(project, "search_pages", json!({ "query": "Needle" }))
        .await;

    // A request that holds the session finishes on it while a window opens
    // the project; the handover closes the session after it.
    let in_flight = desktop.lease(project).await;
    let session_pool = in_flight
        .index()
        .existing_pool(&root(project))
        .await
        .unwrap();
    let handover = desktop.open_window(project);
    let finish = async {
        tokio::task::yield_now().await;
        let keys = [root(project)];
        in_flight.prepare_index(&keys).await.unwrap();
        drop(in_flight);
    };
    tokio::join!(handover, finish);
    assert!(session_pool.is_closed());
    assert!(desktop.sessions.projects().await.is_empty());

    // The window runtime answers as in 5.2: from the index it opened, not
    // checked by this process while its reconciliation cycle runs.
    desktop
        .index
        .reconcile_active_flag(&root(project))
        .await
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let open = desktop
        .ok(project, "search_pages", json!({ "query": "Needle" }))
        .await;
    assert_eq!(open["index"]["verifiedAt"], Value::Null);
    assert_eq!(open["index"]["diagnostics"][0]["code"], "pool_checking");
    assert_eq!(paths(&open), ["notes.md"]);
    assert!(desktop.sessions.projects().await.is_empty());

    // After the window closes, the next read creates a new session.
    desktop.close_window(project).await;
    let again = desktop
        .ok(project, "search_pages", json!({ "query": "Needle" }))
        .await;
    verified_at(&again);
    assert_eq!(desktop.sessions.projects().await, [project.clone()]);
    desktop.sessions.close_all().await;
    assert!(desktop.sessions.projects().await.is_empty());
    assert_released(project);
}

#[tokio::test]
async fn an_idle_session_is_closed_and_reopened_by_the_next_read() {
    let fixture = fixture();
    let project = &fixture.project;
    let desktop = Desktop::with_idle(Duration::from_millis(200));
    desktop
        .ok(project, "search_pages", json!({ "query": "Needle" }))
        .await;
    assert_eq!(desktop.sessions.projects().await, [project.clone()]);

    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    // The closer leaves the registry first, then releases the pools.
    while !desktop.sessions.projects().await.is_empty()
        || project.join(".svode/index.db-wal").exists()
    {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the idle session stays open"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_released(project);
    let again = desktop
        .ok(project, "search_pages", json!({ "query": "Needle" }))
        .await;
    verified_at(&again);
    assert_eq!(paths(&again), ["notes.md"]);
    desktop.sessions.close_all().await;
}

#[tokio::test]
async fn a_cancelled_cold_build_leaves_no_completed_check() {
    let fixture = fixture();
    let project = &fixture.project;
    let desktop = Desktop::new();
    let cancelled = tokio::time::timeout(
        Duration::from_micros(1),
        desktop.call(
            project,
            "query_collection_items",
            json!({ "collectionPath": "tasks" }),
        ),
    )
    .await;
    assert!(cancelled.is_err());
    let session = desktop.lease(project).await;
    assert!(
        !session
            .index()
            .verified_within(&root(project), RECHECK)
            .await
    );
    drop(session);

    let items = desktop
        .ok(
            project,
            "query_collection_items",
            json!({ "collectionPath": "tasks" }),
        )
        .await;
    verified_at(&items);
    assert_eq!(titles(&items), ["Alpha", "Beta"]);
    desktop.sessions.close_all().await;
}

#[tokio::test]
async fn an_index_that_cannot_be_prepared_is_unavailable_for_its_space_only() {
    let broken = fixture();
    let project = &broken.project;
    let desktop = Desktop::new();
    fs::create_dir_all(project.join(".svode/index.db")).unwrap();

    for (name, arguments) in [
        ("search_pages", json!({ "query": "Needle" })),
        (
            "query_collection_items",
            json!({ "collectionPath": "tasks" }),
        ),
        ("get_knowledge_status", json!({})),
    ] {
        let error = desktop.error(project, name, arguments).await;
        assert_eq!(error["code"], "INDEX_UNAVAILABLE", "{name}");
        assert_eq!(
            error["diagnostics"][0]["code"], "index_unavailable",
            "{name}"
        );
    }
    let child = desktop
        .ok(
            project,
            "search_pages",
            json!({ "query": "Needle", "spaceId": "child" }),
        )
        .await;
    verified_at(&child);
    assert_eq!(paths(&child), ["brief.md"]);

    // A registered child Space that is not ready is a Space error, not an
    // empty result.
    let ghost = desktop
        .error(
            project,
            "search_pages",
            json!({ "query": "Needle", "spaceId": "ghost" }),
        )
        .await;
    assert_ne!(ghost["code"], "INDEX_UNAVAILABLE", "{ghost}");
    desktop.sessions.close_all().await;

    // A project a window opened before its first build is unavailable, not
    // empty, until its runtime builds the index.
    let fresh = fixture();
    let project = &fresh.project;
    desktop.open_window(project).await;
    let unbuilt = desktop
        .error(project, "search_pages", json!({ "query": "Needle" }))
        .await;
    assert_eq!(unbuilt["code"], "INDEX_UNAVAILABLE");
    assert_eq!(unbuilt["diagnostics"][0]["code"], "snapshot_unavailable");
    let pool = desktop.index.existing_pool(&root(project)).await.unwrap();
    full_reindex::<GitCli>(None, &pool, project, &["child".to_string()])
        .await
        .unwrap();
    let built = desktop
        .ok(project, "search_pages", json!({ "query": "Needle" }))
        .await;
    assert_eq!(paths(&built), ["notes.md"]);
    assert!(desktop.sessions.projects().await.is_empty());
    desktop.close_window(project).await;
}

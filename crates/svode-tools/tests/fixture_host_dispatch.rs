//! The shared dispatch runs on a host without Tauri against a real
//! `svode-core` fixture project. This proves the host seam, not a headless
//! capability.

use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Command;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use sqlx::SqlitePool;
use svode_core::actors::resolver::ActorCatalogState;
use svode_core::attachments::import::{LfsReadiness, ManagedImportDelivery};
use svode_core::git::access::{RepositoryAccessSnapshot, RepositoryAccessStatus};
use svode_core::git::cli::GitCli;
use svode_core::git::state::GitRuntime;
use svode_core::index::IndexKey;
use svode_core::index::reindex::full_reindex;
use svode_core::index::resolver::SpaceStatus;
use svode_core::index::state::IndexRuntimeState;
use svode_core::index::update::IndexUpdateState;
use svode_core::page::nonce::WriteNonceRegistry;
use svode_core::routines::model::{
    ResolvedRoutineOwner, RoutineDispatchResult, RoutineLiveEvidence, RoutineOwnerDescriptor,
};
use svode_core::routines::store_state::RoutineStoreState;
use svode_core::storage::config::AssetsSpaceConfig;
use svode_tools::catalog;
use svode_tools::dispatch::{call_tool, check_tool, served_definitions};
use svode_tools::error::ToolError;
use svode_tools::host::{
    MutationRuntime, ReadRuntime, RequestTarget, RoutineCaller, RoutineRunner, RoutineRuntime,
    ToolHost,
};
use svode_tools::result::ToolCallResult;

const FIRST_SLICE_TOOLS: [&str; 10] = [
    "get_project_info",
    "list_spaces",
    "list_pages",
    "list_collections",
    "read_page",
    "read_space_readme",
    "read_collection_readme",
    "read_collection_item",
    "get_svode_guide",
    "validate_app_manifest",
];

struct FixtureHost {
    served: Option<Vec<&'static str>>,
    pool: Option<SqlitePool>,
    pool_keys: Mutex<Vec<IndexKey>>,
    deny_mutations: bool,
    authorized: Mutex<Vec<PathBuf>>,
    lfs_ready: Option<bool>,
    lfs_probes: Mutex<Vec<PathBuf>>,
    deliveries: Mutex<Vec<ManagedImportDelivery>>,
    routine_invalidations: Mutex<Vec<RoutineOwnerDescriptor>>,
    runner: Option<FixtureRunner>,
    routines: Arc<RoutineStoreState>,
    index: IndexRuntimeState,
    updates: IndexUpdateState,
    nonces: WriteNonceRegistry,
    actors: ActorCatalogState,
    git: GitRuntime,
}

impl FixtureHost {
    fn new(pool: Option<SqlitePool>) -> Self {
        let routines = Arc::new(RoutineStoreState::new());
        Self {
            served: None,
            pool,
            pool_keys: Mutex::new(Vec::new()),
            deny_mutations: false,
            authorized: Mutex::new(Vec::new()),
            lfs_ready: None,
            lfs_probes: Mutex::new(Vec::new()),
            deliveries: Mutex::new(Vec::new()),
            routine_invalidations: Mutex::new(Vec::new()),
            runner: Some(FixtureRunner::default()),
            updates: IndexUpdateState::new(routines.clone()),
            routines,
            index: IndexRuntimeState::default(),
            nonces: WriteNonceRegistry::new(),
            actors: ActorCatalogState::new(),
            git: GitRuntime::new(),
        }
    }

    fn denying_mutations() -> Self {
        Self {
            deny_mutations: true,
            ..Self::new(None)
        }
    }

    fn authorized(&self) -> Vec<PathBuf> {
        self.authorized.lock().unwrap().clone()
    }

    fn serving(served: &[&'static str]) -> Self {
        Self {
            served: Some(served.to_vec()),
            ..Self::new(None)
        }
    }

    fn without_runner() -> Self {
        Self {
            runner: None,
            ..Self::new(None)
        }
    }

    fn runs(&self) -> Vec<(String, String, String)> {
        self.runner
            .as_ref()
            .map(|runner| runner.runs.lock().unwrap().clone())
            .unwrap_or_default()
    }
}

/// Stand-in for the host Routine execution owner: records the launch it
/// was handed and reports it as started. Routine execution is a host effect,
/// so the fixture replaces only this step.
#[derive(Default)]
struct FixtureRunner {
    runs: Mutex<Vec<(String, String, String)>>,
}

impl RoutineRunner for FixtureRunner {
    fn run(
        &self,
        owner: ResolvedRoutineOwner,
        routine_id: String,
        expected_fingerprint: String,
    ) -> Pin<Box<dyn Future<Output = Result<RoutineDispatchResult, ToolError>> + Send + '_>> {
        self.runs.lock().unwrap().push((
            owner.descriptor.owner_path.clone(),
            routine_id.clone(),
            expected_fingerprint,
        ));
        Box::pin(async move {
            Ok(RoutineDispatchResult::Started {
                routine_id,
                routine_run_id: "run-fixture".to_string(),
                launch_id: "launch-fixture".to_string(),
                agent_session_id: "agent:fixture".to_string(),
                source_session_id: None,
                pty_id: "pty-fixture".to_string(),
            })
        })
    }
}

impl ToolHost for FixtureHost {
    fn version(&self) -> &str {
        "9.9.9-fixture"
    }

    fn serves_tool(&self, name: &str) -> bool {
        self.served
            .as_ref()
            .is_none_or(|served| served.contains(&name))
    }

    async fn index_pool(&self, key: &IndexKey, _space_path: &Path) -> Option<SqlitePool> {
        self.pool_keys.lock().unwrap().push(key.clone());
        match &self.pool {
            Some(pool) => Some(pool.clone()),
            None => self.index.existing_pool(key).await,
        }
    }

    async fn repository_access(
        &self,
        space_path: &Path,
    ) -> Result<RepositoryAccessSnapshot, ToolError> {
        if space_path.ends_with("child") {
            return Err(ToolError::new("GIT_NOT_FOUND", "Git not found"));
        }
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

    async fn require_mutation_access(&self, repository: &Path) -> Result<(), ToolError> {
        self.authorized
            .lock()
            .unwrap()
            .push(repository.to_path_buf());
        if self.deny_mutations {
            return Err(ToolError::new(
                "REPOSITORY_ACCESS_DENIED",
                "Repository access denied: status=read_only",
            ));
        }
        Ok(())
    }

    fn read_runtime(&self) -> ReadRuntime<'_> {
        ReadRuntime {
            index: &self.index,
            actors: &self.actors,
            git: &self.git,
        }
    }

    fn mutation_runtime(&self) -> MutationRuntime<'_> {
        MutationRuntime {
            index: &self.index,
            updates: &self.updates,
            nonces: &self.nonces,
        }
    }

    fn lfs_readiness(&self) -> Option<&dyn LfsReadiness> {
        self.lfs_ready.map(|_| self as &dyn LfsReadiness)
    }

    fn deliver_managed_import(&self, delivery: &ManagedImportDelivery) {
        self.deliveries.lock().unwrap().push(delivery.clone());
    }

    fn routine_runtime(&self) -> Result<RoutineRuntime<'_>, ToolError> {
        Ok(RoutineRuntime {
            stores: &self.routines,
            live_evidence: RoutineLiveEvidence::default(),
        })
    }

    fn deliver_routine_invalidation(&self, owner: &ResolvedRoutineOwner) {
        self.routine_invalidations
            .lock()
            .unwrap()
            .push(owner.descriptor.clone());
    }

    fn routine_runner(&self) -> Option<&dyn RoutineRunner> {
        self.runner
            .as_ref()
            .map(|runner| runner as &dyn RoutineRunner)
    }
}

impl LfsReadiness for FixtureHost {
    fn lfs_ready<'a>(
        &'a self,
        repo_dir: &'a Path,
        _config: &'a AssetsSpaceConfig,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
        self.lfs_probes.lock().unwrap().push(repo_dir.to_path_buf());
        let ready = self.lfs_ready.unwrap_or(false);
        Box::pin(async move { ready })
    }
}

struct Fixture {
    _temp: tempfile::TempDir,
    project: PathBuf,
}

const SOURCES: [(&str, &str); 7] = [
    ("README.md", "---\ntitle: Project\n---\nOwner body\n"),
    ("leaf.md", "---\ntitle: Leaf\n---\nLeaf body\n"),
    ("folder/README.md", "---\ntitle: Folder\n---\nFolder body\n"),
    (
        "tasks/README.md",
        "---\ntitle: Tasks\n---\nCollection body\n",
    ),
    ("tasks/item.md", "---\ntitle: [malformed\n---\nItem body\n"),
    ("child/README.md", "---\ntitle: Child\n---\nChild owner\n"),
    ("child/note.md", "---\ntitle: Note\n---\nChild note\n"),
];

fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project").canonicalize_or_create();
    write(
        &project.join(".svode/config.json"),
        &json!({
            "name": "Project",
            "icon": "P",
            "description": "Root project",
            "spaces": [
                { "id": "child", "path": "child", "repo": null },
                { "id": "missing", "path": "missing", "repo": "https://example.invalid/missing.git" }
            ]
        })
        .to_string(),
    );
    write(
        &project.join("child/.svode/config.json"),
        &json!({ "name": "Child", "icon": "C" }).to_string(),
    );
    write(
        &project.join("tasks/schema.yaml"),
        "columns: []\nviews: []\n",
    );
    for (path, source) in SOURCES {
        write(&project.join(path), source);
    }
    let outside = temp.path().join("outside");
    write(&outside.join("secret.md"), "secret");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, project.join("link")).unwrap();
    Fixture {
        _temp: temp,
        project,
    }
}

trait CanonicalizeOrCreate {
    fn canonicalize_or_create(self) -> PathBuf;
}

impl CanonicalizeOrCreate for PathBuf {
    fn canonicalize_or_create(self) -> PathBuf {
        fs::create_dir_all(&self).unwrap();
        self.canonicalize().unwrap()
    }
}

fn write(path: &Path, contents: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

fn root_target(fixture: &Fixture) -> RequestTarget {
    RequestTarget {
        project_path: fixture.project.to_string_lossy().to_string(),
        default_space_id: None,
        default_space_path: fixture.project.to_string_lossy().to_string(),
        routine_caller: None,
    }
}

fn child_target(fixture: &Fixture) -> RequestTarget {
    RequestTarget {
        default_space_id: Some("child".to_string()),
        default_space_path: fixture.project.join("child").to_string_lossy().to_string(),
        ..root_target(fixture)
    }
}

async fn dated_pool() -> SqlitePool {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::query("CREATE TABLE entries (file_path TEXT PRIMARY KEY, created TEXT, updated TEXT)")
        .execute(&pool)
        .await
        .unwrap();
    for (path, _) in SOURCES {
        sqlx::query("INSERT INTO entries VALUES (?, 'indexed-created', 'indexed-updated')")
            .bind(path)
            .execute(&pool)
            .await
            .unwrap();
    }
    pool
}

fn structured(result: &ToolCallResult) -> &Value {
    assert!(!result.is_error, "{:?}", result.structured_content);
    result.structured_content.as_ref().unwrap()
}

fn error_code(result: &ToolCallResult) -> String {
    assert!(result.is_error, "{:?}", result.structured_content);
    result.structured_content.as_ref().unwrap()["error"]["code"]
        .as_str()
        .unwrap()
        .to_string()
}

#[test]
fn served_catalog_is_filtered_by_host_declaration_and_capabilities() {
    let host = FixtureHost::new(None);
    assert_eq!(served_definitions(&host).len(), 54);
    assert_eq!(catalog::definitions().len(), 54);

    let limited = FixtureHost::serving(&FIRST_SLICE_TOOLS);
    let names = served_names(&limited);
    assert_eq!(names.len(), FIRST_SLICE_TOOLS.len());
    assert!(!names.contains(&"run_routine".to_string()));
    assert_eq!(
        check_tool(&limited, "run_routine").unwrap_err().code,
        "UNKNOWN_TOOL"
    );
    assert_eq!(
        check_tool(&host, "legacy_tool").unwrap_err().code,
        "UNKNOWN_TOOL"
    );
}

fn served_names(host: &FixtureHost) -> Vec<String> {
    served_definitions(host)
        .into_iter()
        .map(|definition| definition.name.to_string())
        .collect()
}

#[tokio::test]
async fn project_and_space_reads_use_the_frozen_target() {
    let fixture = fixture();
    let host = FixtureHost::new(None);
    let target = child_target(&fixture);

    let info = call_tool(&host, Some(&target), "get_project_info", json!({})).await;
    let info = structured(&info);
    assert_eq!(info["projectName"], "Project");
    assert_eq!(info["rootSpaceId"], "root");
    assert_eq!(info["activeSpaceId"], "child");
    assert_eq!(info["activeMcpSpaceId"], "child");
    assert_eq!(info["capabilities"]["autocommit"], false);

    let spaces = call_tool(&host, Some(&target), "list_spaces", json!({})).await;
    let spaces = structured(&spaces)["spaces"].as_array().unwrap().clone();
    let summary = spaces
        .iter()
        .map(|space| {
            (
                space["id"].as_str().unwrap(),
                space["status"].as_str().unwrap(),
                space["kind"].as_str().unwrap(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        summary,
        vec![
            ("root", "ready", "root"),
            ("child", "ready", "child"),
            ("missing", "missing", "child")
        ]
    );
    assert_eq!(spaces[0]["icon"], "P");
    assert_eq!(spaces[0]["description"], "Root project");
    assert_eq!(spaces[0]["hasSpaces"], true);
    assert_eq!(spaces[0]["repositoryAccess"]["status"], "local");
    assert_eq!(spaces[0]["repositoryAccessDiagnostic"], Value::Null);
    assert_eq!(spaces[1]["name"], "Child");
    assert_eq!(spaces[1]["repositoryAccess"], Value::Null);
    assert_eq!(
        spaces[1]["repositoryAccessDiagnostic"]["code"],
        "GIT_NOT_FOUND"
    );
    assert_eq!(spaces[1]["lfsState"], "n/a");
    assert_eq!(spaces[1]["lastOpened"], Value::Null);
    assert_eq!(spaces[2]["name"], "missing");
    assert_eq!(spaces[1]["addressing"]["nullBehavior"], "active-default");
}

#[tokio::test]
async fn native_content_reads_keep_owner_roles_dates_and_sources() {
    let fixture = fixture();
    let host = FixtureHost::new(Some(dated_pool().await));
    let target = root_target(&fixture);
    let call = |name: &'static str, args: Value| call_tool(&host, Some(&target), name, args);

    let page = call("read_page", json!({ "path": "leaf.md" })).await;
    let page = &structured(&page)["page"];
    assert_eq!(page["body"], "Leaf body\n");
    assert_eq!(page["meta"]["created"], "indexed-created");
    assert_eq!(page["meta"]["updated"], "indexed-updated");

    let readme = call("read_space_readme", json!({})).await;
    assert_eq!(structured(&readme)["spaceReadme"]["body"], "Owner body\n");
    let collection = call(
        "read_collection_readme",
        json!({ "collectionPath": "tasks" }),
    )
    .await;
    assert_eq!(structured(&collection)["collectionPath"], "tasks");
    assert_eq!(
        structured(&collection)["collectionReadme"]["meta"]["created"],
        "indexed-created"
    );
    let item = call("read_collection_item", json!({ "path": "tasks/item.md" })).await;
    let item = &structured(&item)["item"];
    // Malformed frontmatter is preserved as source, with a warning.
    assert_eq!(item["body"], SOURCES[4].1);
    assert!(!item["warnings"].as_array().unwrap().is_empty());

    for (name, args, code) in [
        (
            "read_page",
            json!({ "path": "tasks/item.md" }),
            "NOT_A_STANDALONE_PAGE",
        ),
        (
            "read_page",
            json!({ "path": "README.md" }),
            "NOT_A_STANDALONE_PAGE",
        ),
        (
            "read_collection_item",
            json!({ "path": "leaf.md" }),
            "NOT_A_COLLECTION_ITEM",
        ),
        (
            "read_collection_readme",
            json!({ "collectionPath": "folder" }),
            "CONTENT_OWNER_MISMATCH",
        ),
        (
            "read_page",
            json!({ "path": "absent.md" }),
            "FILE_NOT_FOUND",
        ),
        (
            "read_page",
            json!({ "spaceId": "missing", "path": "a.md" }),
            "SPACE_NOT_FOUND",
        ),
        ("read_page", json!({ "path": 7 }), "SERIALIZATION_ERROR"),
    ] {
        assert_eq!(error_code(&call(name, args).await), code, "{name}");
    }

    let child = call(
        "read_page",
        json!({ "spaceId": "child", "path": "note.md" }),
    )
    .await;
    assert_eq!(structured(&child)["page"]["body"], "Child note\n");
    let keys = host.pool_keys.lock().unwrap().clone();
    assert!(keys.contains(&IndexKey::Root(fixture.project.clone())));
    assert!(keys.contains(&IndexKey::Space {
        project: fixture.project.clone(),
        space_id: "child".to_string()
    }));

    for (path, source) in SOURCES {
        assert_eq!(
            fs::read_to_string(fixture.project.join(path)).unwrap(),
            source
        );
    }
    assert!(!fixture.project.join(".svode/index.db").exists());
    assert!(!fixture.project.join(".git").exists());
}

#[tokio::test]
async fn navigation_lists_tree_and_collections_of_the_selected_space() {
    let fixture = fixture();
    let host = FixtureHost::new(None);
    let target = root_target(&fixture);

    let pages = call_tool(&host, Some(&target), "list_pages", json!({})).await;
    let pages = structured(&pages);
    let paths = pages["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|node| node["path"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(paths, ["folder/README.md", "leaf.md", "tasks/README.md"]);
    assert_eq!(pages["limit"], 50);

    let folder = call_tool(
        &host,
        Some(&target),
        "list_pages",
        json!({ "path": "folder", "limit": 500 }),
    )
    .await;
    assert_eq!(structured(&folder)["limit"], 200);
    assert!(
        structured(&folder)["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|node| node["path"].as_str().unwrap().starts_with("folder"))
    );

    let collections = call_tool(&host, Some(&target), "list_collections", json!({})).await;
    let collections = structured(&collections)["collections"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(collections.len(), 1);
    let child = call_tool(
        &host,
        Some(&target),
        "list_collections",
        json!({ "spaceId": "child" }),
    )
    .await;
    assert!(
        structured(&child)["collections"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn public_path_policy_rejects_escapes_before_reading() {
    let fixture = fixture();
    let host = FixtureHost::new(None);
    let target = root_target(&fixture);
    let mut cases = vec![
        ("/etc/passwd.md", "INVALID_PATH"),
        ("C:/tmp/a.md", "INVALID_PATH"),
        ("folder/../leaf.md", "INVALID_PATH"),
        (".git/config.md", "PATH_FORBIDDEN"),
        (".svode/notes.md", "PATH_FORBIDDEN"),
        ("leaf.txt", "INVALID_PATH"),
    ];
    if cfg!(unix) {
        cases.push(("link/secret.md", "PATH_FORBIDDEN"));
    }
    for (path, code) in cases {
        let result = call_tool(&host, Some(&target), "read_page", json!({ "path": path })).await;
        assert_eq!(error_code(&result), code, "{path}");
    }
    let listing = call_tool(
        &host,
        Some(&target),
        "list_pages",
        json!({ "path": "../outside" }),
    )
    .await;
    assert_eq!(error_code(&listing), "INVALID_PATH");
}

#[tokio::test]
async fn requests_without_project_and_tools_outside_the_host_catalog() {
    let fixture = fixture();
    let host = FixtureHost::new(None);

    for name in ["get_project_info", "list_spaces", "read_space_readme"] {
        assert_eq!(
            error_code(&call_tool(&host, None, name, json!({})).await),
            "NO_ACTIVE_PROJECT"
        );
    }
    let guide = call_tool(&host, None, "get_svode_guide", json!({})).await;
    assert!(
        structured(&guide)["guide"]
            .as_str()
            .unwrap()
            .contains("Svode MCP guide")
    );
    let manifest = call_tool(
        &host,
        None,
        "validate_app_manifest",
        json!({ "yaml": "runtime:\n  type: url\n  url: https://example.com\n" }),
    )
    .await;
    assert_eq!(structured(&manifest)["valid"], true);

    assert_eq!(
        error_code(&call_tool(&host, None, "list_routines", json!({ "spaceId": "root" })).await),
        "NO_ACTIVE_PROJECT"
    );

    let target = root_target(&fixture);
    let unknown = call_tool(&host, Some(&target), "legacy_tool", json!({})).await;
    assert_eq!(error_code(&unknown), "UNKNOWN_TOOL");

    let limited = FixtureHost::serving(&FIRST_SLICE_TOOLS);
    let excluded = call_tool(&limited, Some(&target), "write_page", json!({})).await;
    assert_eq!(error_code(&excluded), "UNKNOWN_TOOL");
}

/// Writable fixture: one local repository with a standalone Page, a link
/// source, a schema-backed Collection and a child Space.
fn write_fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project").canonicalize_or_create();
    fs::create_dir_all(project.join(".git")).unwrap();
    write(
        &project.join(".svode/config.json"),
        &json!({ "name": "Project", "spaces": [{ "id": "child", "path": "child", "repo": null }] })
            .to_string(),
    );
    write(
        &project.join("child/.svode/config.json"),
        &json!({ "name": "Child" }).to_string(),
    );
    write(
        &project.join("tasks/schema.yaml"),
        "columns:\n  - { name: Status, type: text, default: Todo }\n  - { name: Points, type: number }\nviews: []\n",
    );
    for (path, source) in [
        ("README.md", "---\ntitle: Project\n---\nOwner body\n"),
        (
            "leaf.md",
            "---\ntitle: Leaf\nicon: L\ndescription: Kept\n---\nLeaf body\n",
        ),
        ("links.md", "---\ntitle: Links\n---\n[Leaf](leaf.md)\n"),
        (
            "tasks/README.md",
            "---\ntitle: Tasks\n---\nCollection body\n",
        ),
        (
            "tasks/a.md",
            "---\ntitle: A\nStatus: Todo\n---\nItem body\n",
        ),
        ("child/README.md", "---\ntitle: Child\n---\nChild owner\n"),
    ] {
        write(&project.join(path), source);
    }
    Fixture {
        _temp: temp,
        project,
    }
}

fn read(fixture: &Fixture, path: &str) -> String {
    fs::read_to_string(fixture.project.join(path)).unwrap()
}

/// Current `sourceVersion` of a source of the fixture project.
fn version(space: &Path, path: &str) -> String {
    svode_core::page::current_source_version(space, path)
        .unwrap()
        .as_str()
        .to_string()
}

fn changed(value: &Value) -> Vec<String> {
    let mut paths = value["changedPaths"]
        .as_array()
        .unwrap()
        .iter()
        .map(|path| path.as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

#[tokio::test]
async fn body_writes_project_actual_paths_through_the_shared_operation() {
    let fixture = write_fixture();
    let host = FixtureHost::new(None);
    let target = root_target(&fixture);
    let call = |name: &'static str, args: Value| call_tool(&host, Some(&target), name, args);

    let root = fixture.project.as_path();
    // Missing and null title are body-only; the path never changes.
    for mut args in [
        json!({ "path": "leaf.md", "content": "First body\n" }),
        json!({ "path": "leaf.md", "content": "Second body\n", "title": null }),
    ] {
        args["sourceVersion"] = json!(version(root, "leaf.md"));
        let result = call("write_page", args).await;
        let result = structured(&result);
        assert_eq!(result["path"], "leaf.md");
        assert_eq!(result["newPath"], Value::Null);
        assert_eq!(changed(result), ["leaf.md"]);
    }
    assert!(read(&fixture, "leaf.md").ends_with("Second body\n"));
    assert!(
        host.nonces
            .take_metadata(&fixture.project.join("leaf.md"))
            .is_some(),
        "watcher echo nonce is published into the host registry"
    );

    let noop = call(
        "write_page",
        json!({ "path": "leaf.md", "content": "Second body\n", "sourceVersion": version(root, "leaf.md") }),
    )
    .await;
    assert!(changed(structured(&noop)).is_empty());
    assert_eq!(structured(&noop)["sourceVersion"], version(root, "leaf.md"));

    // A title intent renames through Desktop naming and rewrites links.
    let renamed = call(
        "write_page",
        json!({ "path": "leaf.md", "content": "Renamed body\n", "title": "Renamed", "sourceVersion": version(root, "leaf.md") }),
    )
    .await;
    let renamed = structured(&renamed);
    assert_eq!(renamed["sourceVersion"], version(root, "Renamed.md"));
    assert_eq!(renamed["path"], "Renamed.md");
    assert_eq!(renamed["newPath"], "Renamed.md");
    assert_eq!(changed(renamed), ["Renamed.md", "leaf.md", "links.md"]);
    assert!(!fixture.project.join("leaf.md").exists());
    assert!(read(&fixture, "links.md").contains("(Renamed.md)"));

    // Root README keeps its path; a nested Collection README renames its
    // directory and reports the resulting owner.
    let space = call(
        "write_space_readme",
        json!({ "content": "New owner body\n", "title": "Renamed Project", "sourceVersion": version(root, "README.md") }),
    )
    .await;
    assert_eq!(structured(&space)["path"], "README.md");
    assert_eq!(structured(&space)["newPath"], Value::Null);
    assert!(read(&fixture, "README.md").contains("title: Renamed Project"));

    let collection = call(
        "write_collection_readme",
        json!({ "collectionPath": "tasks", "content": "Board\n", "title": "Backlog", "sourceVersion": version(root, "tasks/README.md") }),
    )
    .await;
    let collection = structured(&collection);
    assert_eq!(collection["path"], "Backlog/README.md");
    assert_eq!(collection["collectionPath"], "Backlog");
    assert!(fixture.project.join("Backlog/a.md").exists());

    let body = call(
        "update_collection_item_body",
        json!({ "path": "Backlog/a.md", "body": "Item update\n", "sourceVersion": version(root, "Backlog/a.md") }),
    )
    .await;
    assert_eq!(structured(&body)["path"], "Backlog/a.md");
    assert!(read(&fixture, "Backlog/a.md").contains("Status: Todo"));
    assert!(read(&fixture, "Backlog/a.md").ends_with("Item update\n"));

    let child = call(
        "write_space_readme",
        json!({ "spaceId": "child", "content": "Child update\n", "sourceVersion": version(&root.join("child"), "README.md") }),
    )
    .await;
    assert_eq!(changed(structured(&child)), ["README.md"]);
    assert!(read(&fixture, "child/README.md").ends_with("Child update\n"));

    for (name, args, code) in [
        (
            "write_page",
            json!({ "path": "Backlog/a.md", "content": "x", "sourceVersion": "v" }),
            "NOT_A_STANDALONE_PAGE",
        ),
        (
            "update_collection_item_body",
            json!({ "path": "Renamed.md", "body": "x", "sourceVersion": "v" }),
            "NOT_A_COLLECTION_ITEM",
        ),
        (
            "write_page",
            json!({ "path": ".svode/x.md", "content": "x", "sourceVersion": "v" }),
            "PATH_FORBIDDEN",
        ),
        (
            "write_page",
            json!({ "path": "Renamed.md" }),
            "SERIALIZATION_ERROR",
        ),
    ] {
        assert_eq!(error_code(&call(name, args).await), code, "{name}");
    }
    // Every body write requires the version of the source it replaces; the
    // decode fails before any effect.
    let before = read(&fixture, "Renamed.md");
    for (name, args) in [
        (
            "write_page",
            json!({ "path": "Renamed.md", "content": "x" }),
        ),
        ("write_space_readme", json!({ "content": "x" })),
        (
            "write_collection_readme",
            json!({ "collectionPath": "Backlog", "content": "x" }),
        ),
        (
            "update_collection_item_body",
            json!({ "path": "Backlog/a.md", "body": "x" }),
        ),
    ] {
        let result = call(name, args).await;
        assert_eq!(error_code(&result), "SERIALIZATION_ERROR", "{name}");
        assert!(result.content[0].text.contains("sourceVersion"), "{name}");
    }
    assert_eq!(read(&fixture, "Renamed.md"), before);

    // A version of other bytes is stale: nothing is written and no fresh
    // version is handed out, so the caller has to read again.
    let stale = call(
        "write_page",
        json!({ "path": "Renamed.md", "content": "Stale\n", "sourceVersion": "outdated" }),
    )
    .await;
    assert_eq!(error_code(&stale), "SOURCE_STALE");
    let error = &stale.structured_content.as_ref().unwrap()["error"];
    assert_eq!(error["path"], "Renamed.md");
    assert!(error.get("sourceVersion").is_none());
    assert_eq!(read(&fixture, "Renamed.md"), before);
}

#[tokio::test]
async fn metadata_patches_keep_missing_clear_null_and_read_on_empty_patch() {
    let fixture = write_fixture();
    let host = FixtureHost::new(None);
    let target = root_target(&fixture);
    let call = |name: &'static str, args: Value| call_tool(&host, Some(&target), name, args);

    let before = read(&fixture, "leaf.md");
    let empty = call("update_page_metadata", json!({ "path": "leaf.md" })).await;
    assert!(changed(structured(&empty)).is_empty());
    assert_eq!(structured(&empty)["page"]["meta"]["icon"], "L");
    assert_eq!(read(&fixture, "leaf.md"), before);

    let cleared = call(
        "update_page_metadata",
        json!({ "path": "leaf.md", "description": null, "icon": "N" }),
    )
    .await;
    let cleared = structured(&cleared);
    assert_eq!(cleared["page"]["meta"]["icon"], "N");
    assert!(
        cleared["page"]["meta"]
            .get("description")
            .is_none_or(Value::is_null)
    );
    assert!(!read(&fixture, "leaf.md").contains("description"));
    assert!(read(&fixture, "leaf.md").ends_with("Leaf body\n"));

    let item = call(
        "update_collection_item_metadata",
        json!({ "path": "tasks/a.md", "title": "Item B" }),
    )
    .await;
    assert_eq!(structured(&item)["item"]["path"], "tasks/Item B.md");
    assert!(read(&fixture, "tasks/Item B.md").contains("Status: Todo"));

    let collection = call(
        "update_collection_metadata",
        json!({ "collectionPath": "tasks", "title": "Board" }),
    )
    .await;
    let collection = structured(&collection);
    assert_eq!(collection["collectionPath"], "Board");
    assert_eq!(collection["collectionReadme"]["path"], "Board/README.md");

    let space = call(
        "update_space_metadata",
        json!({ "title": "Renamed Project", "icon": "R" }),
    )
    .await;
    assert_eq!(structured(&space)["spaceReadme"]["path"], "README.md");
    assert_eq!(structured(&space)["spaceReadme"]["meta"]["icon"], "R");

    assert_eq!(
        error_code(
            &call(
                "update_collection_item_metadata",
                json!({ "path": "leaf.md", "icon": "x" })
            )
            .await
        ),
        "NOT_A_COLLECTION_ITEM"
    );
}

#[tokio::test]
async fn create_page_uses_the_shared_create_and_rejects_legacy_arguments() {
    let fixture = write_fixture();
    let host = FixtureHost::new(None);
    let target = root_target(&fixture);
    let call = |name: &'static str, args: Value| call_tool(&host, Some(&target), name, args);

    let page = call(
        "create_page",
        json!({ "parentPath": "", "title": "Fresh", "content": "Hello\n", "icon": "F" }),
    )
    .await;
    let page = structured(&page);
    assert_eq!(page["path"], "Fresh.md");
    assert_eq!(page["page"]["meta"]["icon"], "F");
    assert!(changed(page).contains(&"Fresh.md".to_string()));
    assert!(read(&fixture, "Fresh.md").ends_with("Hello\n"));

    let item = call(
        "create_page",
        json!({ "parentPath": "tasks", "title": "Scheduled", "properties": { "Points": 3 } }),
    )
    .await;
    let item = structured(&item);
    assert_eq!(item["path"], "tasks/Scheduled.md");
    let source = read(&fixture, "tasks/Scheduled.md");
    assert!(source.contains("Status: Todo"), "{source}");
    assert!(source.contains("Points: 3"), "{source}");

    let conflict = call("create_page", json!({ "parentPath": "", "title": "Fresh" })).await;
    assert_eq!(error_code(&conflict), "PAGE_NAME_CONFLICT");
    let evidence = &conflict.structured_content.as_ref().unwrap()["error"];
    assert_eq!(evidence["conflicts"][0]["path"], "Fresh.md");

    for (args, code) in [
        (
            json!({ "parentPath": "", "title": "Legacy", "path": "Legacy.md" }),
            "SERIALIZATION_ERROR",
        ),
        (
            json!({ "parentPath": "tasks", "title": "Legacy", "fields": { "Status": "x" } }),
            "SERIALIZATION_ERROR",
        ),
        (json!({ "path": "Legacy.md" }), "SERIALIZATION_ERROR"),
        (
            json!({ "parentPath": "", "title": "Legacy", "properties": { "title": "x" } }),
            "SVODE_ERROR",
        ),
    ] {
        assert_eq!(
            error_code(&call("create_page", args.clone()).await),
            code,
            "{args}"
        );
    }
    assert!(!fixture.project.join("Legacy.md").exists());
    assert!(!fixture.project.join("tasks/Legacy.md").exists());
}

#[tokio::test]
async fn item_field_batch_is_one_action_with_the_shared_rename() {
    let fixture = write_fixture();
    let host = FixtureHost::new(None);
    let target = root_target(&fixture);
    let call = |name: &'static str, args: Value| call_tool(&host, Some(&target), name, args);

    let empty = call(
        "update_collection_item_fields",
        json!({ "path": "tasks/a.md", "fields": {} }),
    )
    .await;
    assert!(changed(structured(&empty)).is_empty());

    let before = read(&fixture, "tasks/a.md");
    let invalid = call(
        "update_collection_item_fields",
        json!({ "path": "tasks/a.md", "fields": { "Status": "Done", "Points": "many" } }),
    )
    .await;
    assert!(invalid.is_error);
    assert_eq!(read(&fixture, "tasks/a.md"), before);

    let updated = call(
        "update_collection_item_fields",
        json!({ "path": "tasks/a.md", "fields": { "Points": 5, "Status": "Done", "title": "Shipped" } }),
    )
    .await;
    let updated = structured(&updated);
    assert_eq!(updated["item"]["path"], "tasks/Shipped.md");
    assert_eq!(changed(updated), ["tasks/Shipped.md", "tasks/a.md"]);
    let source = read(&fixture, "tasks/Shipped.md");
    assert!(source.contains("Status: Done") && source.contains("Points: 5"));
}

#[tokio::test]
async fn mutations_authorize_every_repository_before_the_first_write() {
    let fixture = write_fixture();
    let denied = FixtureHost::denying_mutations();
    let target = root_target(&fixture);
    let sources = [
        "README.md",
        "leaf.md",
        "links.md",
        "tasks/a.md",
        "child/README.md",
    ]
    .map(|path| read(&fixture, path));
    for (name, args) in [
        (
            "write_page",
            json!({ "path": "leaf.md", "content": "x", "title": "Moved", "sourceVersion": "v" }),
        ),
        ("create_page", json!({ "parentPath": "", "title": "New" })),
        (
            "update_page_metadata",
            json!({ "path": "leaf.md", "icon": "x" }),
        ),
        (
            "write_space_readme",
            json!({ "content": "x", "sourceVersion": "v" }),
        ),
        ("update_space_metadata", json!({ "icon": "x" })),
        (
            "write_collection_readme",
            json!({ "collectionPath": "tasks", "content": "x", "sourceVersion": "v" }),
        ),
        (
            "update_collection_metadata",
            json!({ "collectionPath": "tasks", "icon": "x" }),
        ),
        (
            "update_collection_item_fields",
            json!({ "path": "tasks/a.md", "fields": { "Status": "x" } }),
        ),
        (
            "update_collection_item_body",
            json!({ "path": "tasks/a.md", "body": "x", "sourceVersion": "v" }),
        ),
        (
            "update_collection_item_metadata",
            json!({ "path": "tasks/a.md", "icon": "x" }),
        ),
        (
            "write_space_readme",
            json!({ "spaceId": "child", "content": "x", "sourceVersion": "v" }),
        ),
    ] {
        let result = call_tool(&denied, Some(&target), name, args).await;
        assert_eq!(error_code(&result), "REPOSITORY_ACCESS_DENIED", "{name}");
    }
    for (path, source) in [
        "README.md",
        "leaf.md",
        "links.md",
        "tasks/a.md",
        "child/README.md",
    ]
    .iter()
    .zip(&sources)
    {
        assert_eq!(&read(&fixture, path), source, "{path}");
    }
    assert!(!fixture.project.join("New.md").exists());
    assert!(
        denied
            .authorized()
            .iter()
            .all(|repository| repository == &fixture.project)
    );
}

#[tokio::test]
async fn filename_collision_is_an_applied_write_with_a_warning() {
    let fixture = write_fixture();
    write(
        &fixture.project.join("Taken.md"),
        "---\ntitle: Other\n---\nOccupied\n",
    );
    let host = FixtureHost::new(None);
    let target = root_target(&fixture);

    let result = call_tool(
        &host,
        Some(&target),
        "write_page",
        json!({ "path": "leaf.md", "content": "Body\n", "title": "Taken", "sourceVersion": version(&fixture.project, "leaf.md") }),
    )
    .await;
    let result = structured(&result);
    // The display name is saved; the occupied filename keeps the prior path
    // without a fictitious rename.
    assert_eq!(result["path"], "leaf.md");
    assert_eq!(result["newPath"], Value::Null);
    assert_eq!(result["warnings"][0]["kind"], "filename_rename_collision");
    assert_eq!(
        read(&fixture, "Taken.md"),
        "---\ntitle: Other\n---\nOccupied\n"
    );
    let source = read(&fixture, "leaf.md");
    assert!(source.contains("title: Taken") && source.ends_with("Body\n"));
}

#[cfg(unix)]
#[tokio::test]
async fn handled_source_failure_rolls_back_the_whole_request() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = write_fixture();
    let links = fixture.project.join("links.md");
    fs::set_permissions(&links, fs::Permissions::from_mode(0o444)).unwrap();
    let host = FixtureHost::new(None);
    let target = root_target(&fixture);
    let before = read(&fixture, "leaf.md");

    let result = call_tool(
        &host,
        Some(&target),
        "write_page",
        json!({ "path": "leaf.md", "content": "Lost body\n", "title": "Moved", "sourceVersion": version(&fixture.project, "leaf.md") }),
    )
    .await;
    fs::set_permissions(&links, fs::Permissions::from_mode(0o644)).unwrap();

    // The rejected write is a business failure with the source cause, not an
    // applied result or a recovery failure.
    assert_eq!(error_code(&result), "SVODE_ERROR");
    assert!(
        result.content[0].text.contains("ermission denied"),
        "{:?}",
        result.content
    );
    assert_eq!(read(&fixture, "leaf.md"), before);
    assert!(!fixture.project.join("Moved.md").exists());
    assert_eq!(
        read(&fixture, "links.md"),
        "---\ntitle: Links\n---\n[Leaf](leaf.md)\n"
    );
}

/// Indexed fixture in one Git repository: root Space with a linked Page,
/// a schema-backed Collection and a relation target Collection, and a
/// registered child Space with its own index pool.
fn index_fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project").canonicalize_or_create();
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
    write(&project.join("README.md"), "---\ntitle: Project\n---\n");
    write(
        &project.join("notes.md"),
        "---\ntitle: Root Needle\n---\nNeedle root body [Alpha](tasks/alpha.md)\n",
    );
    write(
        &project.join("tasks/schema.yaml"),
        "columns:\n  - name: Status\n    type: text\n  - name: Points\n    type: number\nviews:\n  - type: table\n    name: Table\n",
    );
    write(&project.join("tasks/README.md"), "---\ntitle: Tasks\n---\n");
    write(
        &project.join("tasks/alpha.md"),
        "---\ntitle: Alpha\nStatus: Todo\nPoints: 3\n---\nAlpha body\n",
    );
    write(
        &project.join("tasks/beta.md"),
        "---\ntitle: Beta\nStatus: Done\nPoints: 1\n---\nBeta body\n",
    );
    write(
        &project.join("sprints/schema.yaml"),
        "columns: []\nviews: []\n",
    );
    write(
        &project.join("sprints/README.md"),
        "---\ntitle: Sprints\n---\n",
    );
    write(&project.join("sprints/one.md"), "---\ntitle: One\n---\n");
    write(&project.join("child/README.md"), "---\ntitle: Child\n---\n");
    write(
        &project.join("child/brief.md"),
        "---\ntitle: Child Needle\n---\nNeedle child body\n",
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

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(dir)
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?}");
}

/// Host whose index state holds reindexed root and child pools, as the
/// Desktop host keeps them for an open project.
async fn indexed_host(fixture: &Fixture, host: FixtureHost) -> FixtureHost {
    let project = &fixture.project;
    host.index
        .upsert_space(
            project,
            "child",
            "child",
            SpaceStatus::Ready,
            Some("Child".to_string()),
        )
        .await;
    let root = host
        .index
        .get_or_create(&IndexKey::Root(project.clone()))
        .await
        .unwrap();
    full_reindex::<GitCli>(None, &root, project, &["child".to_string()])
        .await
        .unwrap();
    let child = host
        .index
        .get_or_create(&IndexKey::Space {
            project: project.clone(),
            space_id: "child".to_string(),
        })
        .await
        .unwrap();
    full_reindex::<GitCli>(None, &child, &project.join("child"), &[])
        .await
        .unwrap();
    host
}

fn titles(items: &Value) -> Vec<String> {
    items
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            item["title"]
                .as_str()
                .or_else(|| item["meta"]["title"].as_str())
                .unwrap()
                .to_string()
        })
        .collect()
}

const INDEX_BACKED_TOOLS: [&str; 17] = [
    "get_collection_schema",
    "query_collection_items",
    "list_actors",
    "search_pages",
    "search_knowledge",
    "get_knowledge_node",
    "get_knowledge_neighbors",
    "get_related_context",
    "get_knowledge_status",
    "get_git_status",
    "add_collection_column",
    "update_collection_column",
    "delete_collection_column",
    "add_collection_view",
    "update_collection_view",
    "delete_collection_view",
    "validate_collection_integrity",
];

#[tokio::test]
async fn collection_schema_and_query_read_the_host_index() {
    let fixture = index_fixture();
    let host = indexed_host(&fixture, FixtureHost::new(None)).await;
    let target = root_target(&fixture);

    let schema = call_tool(
        &host,
        Some(&target),
        "get_collection_schema",
        json!({ "collectionPath": "tasks" }),
    )
    .await;
    let columns = structured(&schema)["schema"]["columns"]
        .as_array()
        .unwrap()
        .iter()
        .map(|column| column["name"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(columns, vec!["Status", "Points"]);

    let sorted = call_tool(
        &host,
        Some(&target),
        "query_collection_items",
        json!({
            "collectionPath": "tasks",
            "sort": [{ "field": "Points", "desc": false }],
            "limit": 500,
            "offset": -3
        }),
    )
    .await;
    let sorted = structured(&sorted);
    assert_eq!(titles(&sorted["items"]), vec!["Beta", "Alpha"]);
    assert_eq!(sorted["limit"], 200);
    assert_eq!(sorted["offset"], 0);
    assert!(sorted["items"][0]["meta"]["created"].is_string());

    let filtered = call_tool(
        &host,
        Some(&target),
        "query_collection_items",
        json!({
            "collectionPath": "tasks",
            "filter": [{ "field": "Status", "op": "eq", "value": "Done" }],
            "limit": 1
        }),
    )
    .await;
    assert_eq!(titles(&structured(&filtered)["items"]), vec!["Beta"]);

    let unknown_field = call_tool(
        &host,
        Some(&target),
        "query_collection_items",
        json!({
            "collectionPath": "tasks",
            "filter": [{ "field": "Missing", "op": "eq", "value": "x" }]
        }),
    )
    .await;
    assert!(unknown_field.is_error);

    let escaped = call_tool(
        &host,
        Some(&target),
        "query_collection_items",
        json!({ "collectionPath": "../outside" }),
    )
    .await;
    assert!(escaped.is_error);
}

#[tokio::test]
async fn search_and_knowledge_stay_inside_the_frozen_scope() {
    let fixture = index_fixture();
    let host = indexed_host(&fixture, FixtureHost::new(None)).await;
    let root = root_target(&fixture);
    let child = child_target(&fixture);

    let paths = |result: &ToolCallResult| {
        structured(result)["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["path"].as_str().unwrap().to_string())
            .collect::<Vec<_>>()
    };
    let root_search = call_tool(
        &host,
        Some(&root),
        "search_pages",
        json!({ "query": "Needle" }),
    )
    .await;
    assert_eq!(paths(&root_search), vec!["notes.md"]);
    let child_search = call_tool(
        &host,
        Some(&child),
        "search_pages",
        json!({ "query": "Needle", "limit": 0 }),
    )
    .await;
    assert_eq!(paths(&child_search), vec!["brief.md"]);
    assert_eq!(structured(&child_search)["limit"], 1);
    let explicit_root = call_tool(
        &host,
        Some(&child),
        "search_pages",
        json!({ "query": "Needle", "spaceId": "root" }),
    )
    .await;
    assert_eq!(paths(&explicit_root), vec!["notes.md"]);

    let knowledge = call_tool(
        &host,
        Some(&child),
        "search_knowledge",
        json!({ "query": "Needle" }),
    )
    .await;
    let knowledge = structured(&knowledge);
    assert_eq!(
        knowledge["scope"],
        json!({ "kind": "space", "spaceId": "child" })
    );
    let node_ids = knowledge["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["nodeId"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert!(!node_ids.is_empty());
    assert!(
        node_ids.iter().all(|id| id.contains(":child:")),
        "{node_ids:?}"
    );
    assert!(knowledge["freshness"].is_array());
    assert!(knowledge["status"].is_string());

    let node = call_tool(
        &host,
        Some(&root),
        "get_knowledge_node",
        json!({ "nodeId": "page:root:notes.md" }),
    )
    .await;
    assert_eq!(structured(&node)["node"]["source"]["path"], "notes.md");
    let sibling = call_tool(
        &host,
        Some(&root),
        "get_knowledge_node",
        json!({ "nodeId": "page:child:brief.md" }),
    )
    .await;
    assert_eq!(error_code(&sibling), "KNOWLEDGE_NODE_NOT_FOUND");

    let neighbors = call_tool(
        &host,
        Some(&root),
        "get_knowledge_neighbors",
        json!({ "nodeId": "page:root:notes.md", "limit": 1 }),
    )
    .await;
    let neighbors = structured(&neighbors);
    assert_eq!(neighbors["limit"], 1);
    assert!(neighbors["neighbors"].as_array().unwrap().len() <= 1);

    let related = call_tool(
        &host,
        Some(&root),
        "get_related_context",
        json!({ "query": "Needle", "textBudget": 100 }),
    )
    .await;
    let related = structured(&related);
    assert_eq!(related["textBudget"], 100);
    assert!(related["usedBudget"].as_u64().unwrap() <= 100);

    let status = call_tool(
        &host,
        Some(&root),
        "get_knowledge_status",
        json!({ "scope": "project" }),
    )
    .await;
    let status = structured(&status);
    assert_eq!(status["scope"], json!({ "kind": "project" }));
    assert_eq!(status["counts"]["totalPools"], 2);
    assert_eq!(status["counts"]["readablePools"], 2);

    for (tool, args, code) in [
        (
            "search_knowledge",
            json!({ "query": "x", "scope": "project", "spaceId": "child" }),
            "INVALID_KNOWLEDGE_SCOPE",
        ),
        (
            "search_knowledge",
            json!({ "query": "x", "spaceId": "missing" }),
            "SPACE_NOT_FOUND",
        ),
        (
            "search_knowledge",
            json!({ "query": "x", "limit": 51 }),
            "INVALID_KNOWLEDGE_LIMIT",
        ),
        (
            "get_related_context",
            json!({ "query": "x", "textBudget": 16_001 }),
            "INVALID_KNOWLEDGE_LIMIT",
        ),
        (
            "get_knowledge_node",
            json!({ "nodeId": "page:root:../secret.md" }),
            "INVALID_KNOWLEDGE_NODE_ID",
        ),
        (
            "search_knowledge",
            json!({ "query": "   " }),
            "INVALID_KNOWLEDGE_QUERY",
        ),
    ] {
        let result = call_tool(&host, Some(&root), tool, args).await;
        assert_eq!(error_code(&result), code, "{tool}");
    }
}

#[tokio::test]
async fn schema_and_view_changes_authorize_the_planned_set_and_return_the_normalized_schema() {
    let fixture = index_fixture();
    let project = fixture.project.clone();
    let host = FixtureHost::new(None);
    let target = root_target(&fixture);

    let added = call_tool(
        &host,
        Some(&target),
        "add_collection_column",
        json!({
            "collectionPath": "tasks",
            "column": { "name": "Sprint", "type": "relation", "relation": "sprints", "two_way": "Tasks" }
        }),
    )
    .await;
    let added = structured(&added);
    assert!(changed(added).contains(&"sprints/schema.yaml".to_string()));
    assert!(changed(added).contains(&"tasks/schema.yaml".to_string()));
    assert!(
        added["schema"]["columns"]
            .as_array()
            .unwrap()
            .iter()
            .any(|column| column["name"] == "Sprint")
    );
    assert!(read(&fixture, "sprints/schema.yaml").contains("name: Tasks"));
    assert!(host.authorized().contains(&project));

    let updated = call_tool(
        &host,
        Some(&target),
        "update_collection_column",
        json!({ "collectionPath": "tasks", "columnName": "Points", "patch": { "min": 0 } }),
    )
    .await;
    assert!(read(&fixture, "tasks/schema.yaml").contains("min: 0"));
    assert_eq!(changed(structured(&updated)), vec!["tasks/schema.yaml"]);

    let deleted = call_tool(
        &host,
        Some(&target),
        "delete_collection_column",
        json!({ "collectionPath": "tasks", "columnName": "Points", "deleteValues": true }),
    )
    .await;
    assert!(changed(structured(&deleted)).contains(&"tasks/alpha.md".to_string()));
    assert!(!read(&fixture, "tasks/alpha.md").contains("Points"));

    let view = call_tool(
        &host,
        Some(&target),
        "add_collection_view",
        json!({
            "collectionPath": "tasks",
            "view": { "type": "table", "name": "Board" }
        }),
    )
    .await;
    let views = structured(&view)["schema"]["views"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(views.len(), 2);
    let before = read(&fixture, "tasks/schema.yaml");
    let incompatible = call_tool(
        &host,
        Some(&target),
        "add_collection_view",
        json!({
            "collectionPath": "tasks",
            "view": { "type": "board", "name": "Bad", "group_by": "Status" }
        }),
    )
    .await;
    assert!(incompatible.is_error);
    assert_eq!(before, read(&fixture, "tasks/schema.yaml"));
    let renamed = call_tool(
        &host,
        Some(&target),
        "update_collection_view",
        json!({ "collectionPath": "tasks", "viewName": "Board", "patch": { "name": "Kanban" } }),
    )
    .await;
    assert!(structured(&renamed)["schema"]["views"][1]["name"] == "Kanban");
    assert_ne!(before, read(&fixture, "tasks/schema.yaml"));
    let removed = call_tool(
        &host,
        Some(&target),
        "delete_collection_view",
        json!({ "collectionPath": "tasks", "viewName": "Kanban" }),
    )
    .await;
    assert_eq!(
        structured(&removed)["schema"]["views"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let schema_before = read(&fixture, "tasks/schema.yaml");
    let denied = FixtureHost::denying_mutations();
    for (tool, args) in [
        (
            "add_collection_column",
            json!({ "collectionPath": "tasks", "column": { "name": "Extra", "type": "text" } }),
        ),
        (
            "update_collection_column",
            json!({ "collectionPath": "tasks", "columnName": "Status", "patch": { "color": "red" } }),
        ),
        (
            "delete_collection_column",
            json!({ "collectionPath": "tasks", "columnName": "Status" }),
        ),
        (
            "add_collection_view",
            json!({ "collectionPath": "tasks", "view": { "type": "table", "name": "Other" } }),
        ),
        (
            "update_collection_view",
            json!({ "collectionPath": "tasks", "viewName": "Table", "patch": { "name": "T" } }),
        ),
        (
            "delete_collection_view",
            json!({ "collectionPath": "tasks", "viewName": "Table" }),
        ),
    ] {
        let result = call_tool(&denied, Some(&target), tool, args).await;
        assert_eq!(error_code(&result), "REPOSITORY_ACCESS_DENIED", "{tool}");
    }
    assert_eq!(schema_before, read(&fixture, "tasks/schema.yaml"));
}

#[tokio::test]
async fn integrity_git_status_and_actors_read_through_the_host_runtime() {
    let fixture = index_fixture();
    let host = FixtureHost::new(None);
    let target = root_target(&fixture);

    let integrity = call_tool(
        &host,
        Some(&target),
        "validate_collection_integrity",
        json!({}),
    )
    .await;
    let integrity = structured(&integrity);
    assert_eq!(integrity["errorCount"], 0);
    assert!(integrity["collectionPath"].is_null());
    let escaped = call_tool(
        &host,
        Some(&target),
        "validate_collection_integrity",
        json!({ "collectionPath": "../x" }),
    )
    .await;
    assert!(escaped.is_error);

    write(&fixture.project.join("notes.md"), "changed");
    let status = call_tool(&host, Some(&target), "get_git_status", json!({})).await;
    let status = &structured(&status)["status"];
    assert_eq!(status["hasUnstaged"], true);
    assert!(
        status["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|file| file["path"] == "notes.md")
    );

    let actors = call_tool(&host, Some(&target), "list_actors", json!({})).await;
    let actors = structured(&actors)["actors"].as_array().unwrap().clone();
    let agent = actors
        .iter()
        .find(|actor| actor["email"] == "agent@example.com")
        .unwrap();
    assert_eq!(agent["name"], "Agent");
    assert_eq!(agent["commitCount"], 1);
    assert_eq!(agent["isMe"], true);

    // None of the family routes through the host handlers any more.
    let limited = FixtureHost::serving(&FIRST_SLICE_TOOLS);
    for name in INDEX_BACKED_TOOLS {
        let result = call_tool(&limited, Some(&target), name, json!({})).await;
        assert_eq!(error_code(&result), "UNKNOWN_TOOL", "{name}");
    }
}

const STRUCTURAL_TOOLS: [&str; 11] = [
    "delete_page",
    "delete_collection_item",
    "delete_collection",
    "rename_content",
    "move_content",
    "reorder_content",
    "reorder_spaces",
    "convert_page_to_leaf",
    "convert_to_collection",
    "create_collection",
    "import_asset",
];

/// Committed fixture for structural actions: a link source, dir-backed
/// Pages, a Collection whose items relate to a second Collection and a
/// registered child Space.
fn structure_fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project").canonicalize_or_create();
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
    for (path, source) in [
        ("README.md", "---\ntitle: Project\n---\n"),
        ("leaf.md", "---\ntitle: Leaf\n---\nLeaf body\n"),
        ("notes.md", "---\ntitle: Notes\n---\n[Leaf](leaf.md)\n"),
        ("archive/README.md", "---\ntitle: Archive\n---\n"),
        ("archive/a.md", "---\ntitle: A\n---\n"),
        ("archive/b.md", "---\ntitle: B\n---\n"),
        ("solo/README.md", "---\ntitle: Solo\n---\nSolo body\n"),
        (
            "tasks/schema.yaml",
            "columns:\n  - name: Sprint\n    type: relation\n    relation: sprints\nviews: []\n",
        ),
        ("tasks/README.md", "---\ntitle: Tasks\n---\n"),
        (
            "tasks/alpha.md",
            "---\ntitle: Alpha\nSprint: one.md\n---\nAlpha body\n",
        ),
        ("sprints/schema.yaml", "columns: []\nviews: []\n"),
        ("sprints/README.md", "---\ntitle: Sprints\n---\n"),
        ("sprints/one.md", "---\ntitle: One\n---\n"),
        ("sprints/two.md", "---\ntitle: Two\n---\n"),
        ("child/README.md", "---\ntitle: Child\n---\n"),
    ] {
        write(&project.join(path), source);
    }
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

fn commit_count(fixture: &Fixture) -> String {
    let output = Command::new("git")
        .args(["rev-list", "--count", "HEAD"])
        .current_dir(&fixture.project)
        .output()
        .unwrap();
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}

/// Every source file of the project outside `.git` and the index, with its
/// contents.
fn source_snapshot(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut files = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy();
            if name == ".git" || name.starts_with("index.db") {
                continue;
            }
            if path.is_dir() {
                pending.push(path);
            } else {
                files.push((path.clone(), fs::read(&path).unwrap()));
            }
        }
    }
    files.sort();
    files
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|path| path.as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn structural_actions_keep_link_relation_order_and_conversion_effects() {
    let fixture = structure_fixture();
    let host = indexed_host(&fixture, FixtureHost::new(None)).await;
    let target = root_target(&fixture);

    let renamed = call_tool(
        &host,
        Some(&target),
        "rename_content",
        json!({ "from": "leaf.md", "to": "Renamed.md" }),
    )
    .await;
    let renamed = structured(&renamed);
    assert_eq!(renamed["newPath"], "Renamed.md");
    assert!(read(&fixture, "notes.md").contains("(Renamed.md)"));
    assert!(changed(renamed).contains(&"notes.md".to_string()));
    assert!(changed(renamed).contains(&"Renamed.md".to_string()));
    assert!(strings(&renamed["touchedPaths"]["backlinks"]).contains(&"notes.md".to_string()));

    let moved = call_tool(
        &host,
        Some(&target),
        "move_content",
        json!({ "from": "Renamed.md", "toParent": "archive" }),
    )
    .await;
    let moved = structured(&moved);
    assert_eq!(moved["newPath"], "archive/Renamed.md");
    assert!(fixture.project.join("archive/Renamed.md").is_file());
    assert!(read(&fixture, "notes.md").contains("archive/Renamed.md"));

    let reordered = call_tool(
        &host,
        Some(&target),
        "reorder_content",
        json!({
            "parentPath": "archive/README.md",
            "orderedChildren": ["archive/b.md", "archive/Renamed.md", "archive/a.md"]
        }),
    )
    .await;
    let reordered = structured(&reordered);
    assert_eq!(reordered["parentPath"], "archive");
    assert_eq!(changed(reordered), vec![".svode/order.json"]);
    let order = read(&fixture, ".svode/order.json");
    let invalid = call_tool(
        &host,
        Some(&target),
        "reorder_content",
        json!({ "parentPath": "archive/README.md", "orderedChildren": ["archive/a.md"] }),
    )
    .await;
    assert!(invalid.is_error);
    assert_eq!(read(&fixture, ".svode/order.json"), order);

    let leaf = call_tool(
        &host,
        Some(&target),
        "convert_page_to_leaf",
        json!({ "path": "solo/README.md" }),
    )
    .await;
    let leaf = structured(&leaf);
    assert_eq!(leaf["newPath"], "solo.md");
    assert_eq!(leaf["page"]["path"], "solo.md");
    assert!(read(&fixture, "solo.md").contains("Solo body"));

    let collection = call_tool(
        &host,
        Some(&target),
        "convert_to_collection",
        json!({ "path": "notes.md" }),
    )
    .await;
    let collection = structured(&collection);
    assert_eq!(collection["collectionPath"], "notes");
    assert_eq!(collection["readmePath"], "notes/README.md");
    assert_eq!(collection["schemaPath"], "notes/schema.yaml");
    assert!(fixture.project.join("notes/schema.yaml").is_file());
    let again = call_tool(
        &host,
        Some(&target),
        "convert_to_collection",
        json!({ "path": "notes/README.md" }),
    )
    .await;
    assert_eq!(error_code(&again), "INVALID_COLLECTION_CONVERSION");

    let wrong_owner = call_tool(
        &host,
        Some(&target),
        "delete_page",
        json!({ "path": "tasks/alpha.md" }),
    )
    .await;
    assert_eq!(error_code(&wrong_owner), "NOT_A_STANDALONE_PAGE");
    let item = call_tool(
        &host,
        Some(&target),
        "delete_collection_item",
        json!({ "path": "sprints/one.md" }),
    )
    .await;
    let item = structured(&item);
    assert!(strings(&item["deletedPaths"]).contains(&"sprints/one.md".to_string()));
    assert!(strings(&item["cascadeTouched"]).contains(&"tasks/alpha.md".to_string()));
    assert!(!read(&fixture, "tasks/alpha.md").contains("one.md"));

    let page = call_tool(
        &host,
        Some(&target),
        "delete_page",
        json!({ "path": "archive/a.md" }),
    )
    .await;
    assert_eq!(structured(&page)["deletedRoot"], "archive/a.md");
    let deleted = call_tool(
        &host,
        Some(&target),
        "delete_collection",
        json!({ "collectionPath": "sprints" }),
    )
    .await;
    assert!(!deleted.is_error, "{:?}", deleted.structured_content);
    assert!(!fixture.project.join("sprints/README.md").exists());

    let pinned_root = call_tool(
        &host,
        Some(&target),
        "reorder_spaces",
        json!({ "orderedSpaceIds": ["root"] }),
    )
    .await;
    assert_eq!(error_code(&pinned_root), "INVALID_SPACE_ORDER");
    let unknown = call_tool(
        &host,
        Some(&target),
        "reorder_spaces",
        json!({ "orderedSpaceIds": ["child", "ghost"] }),
    )
    .await;
    assert!(unknown.is_error);
    let same = call_tool(
        &host,
        Some(&target),
        "reorder_spaces",
        json!({ "orderedSpaceIds": ["child"] }),
    )
    .await;
    assert!(changed(structured(&same)).is_empty());

    assert_eq!(commit_count(&fixture), "1");
}

#[tokio::test]
async fn collection_create_is_one_action_without_an_empty_collection_on_invalid_data() {
    let fixture = write_fixture();
    let host = FixtureHost::new(None);
    let target = root_target(&fixture);

    let created = call_tool(
        &host,
        Some(&target),
        "create_collection",
        json!({
            "parentPath": "",
            "title": "Backlog",
            "columns": [{ "name": "Owner", "type": "text" }]
        }),
    )
    .await;
    let created = structured(&created);
    assert_eq!(created["collectionPath"], "Backlog");
    assert_eq!(created["collection"]["path"], "Backlog/README.md");
    assert_eq!(created["schema"]["columns"][0]["name"], "Owner");
    assert_eq!(
        created["schema"]["views"][0]["visible_fields"],
        json!(["title", "Owner"])
    );
    assert!(changed(created).contains(&"Backlog/schema.yaml".to_string()));

    let nested = call_tool(
        &host,
        Some(&target),
        "create_collection",
        json!({ "parentPath": "leaf.md", "title": "Inside", "columns": [], "views": [] }),
    )
    .await;
    let nested = structured(&nested);
    assert_eq!(nested["collectionPath"], "leaf/Inside");
    assert_eq!(nested["schema"]["views"], json!([]));

    let invalid = call_tool(
        &host,
        Some(&target),
        "create_collection",
        json!({
            "parentPath": "",
            "title": "Broken",
            "columns": [{ "name": "Link", "type": "relation", "relation": "missing" }]
        }),
    )
    .await;
    assert!(invalid.is_error);
    assert!(!fixture.project.join("Broken").exists());
    assert!(!fixture.project.join("Broken.md").exists());

    let legacy = call_tool(
        &host,
        Some(&target),
        "create_collection",
        json!({ "path": "Legacy", "parentPath": "", "title": "Legacy" }),
    )
    .await;
    assert_eq!(error_code(&legacy), "SERIALIZATION_ERROR");
    assert!(!fixture.project.join("Legacy").exists());
}

#[tokio::test]
async fn structural_and_import_actions_authorize_before_the_first_write() {
    let fixture = structure_fixture();
    let denied = indexed_host(&fixture, FixtureHost::denying_mutations()).await;
    let target = root_target(&fixture);
    let photo = fixture.project.parent().unwrap().join("photo.png");
    fs::write(&photo, b"image").unwrap();
    let before = source_snapshot(&fixture.project);

    for (name, args) in [
        ("delete_page", json!({ "path": "leaf.md" })),
        (
            "delete_collection_item",
            json!({ "path": "sprints/one.md" }),
        ),
        ("delete_collection", json!({ "collectionPath": "sprints" })),
        (
            "rename_content",
            json!({ "from": "leaf.md", "to": "Renamed.md" }),
        ),
        (
            "move_content",
            json!({ "from": "leaf.md", "toParent": "archive" }),
        ),
        (
            "reorder_content",
            json!({ "parentPath": "archive/README.md", "orderedChildren": ["archive/b.md", "archive/a.md"] }),
        ),
        ("reorder_spaces", json!({ "orderedSpaceIds": ["child"] })),
        ("convert_page_to_leaf", json!({ "path": "solo/README.md" })),
        ("convert_to_collection", json!({ "path": "notes.md" })),
        (
            "create_collection",
            json!({ "parentPath": "", "title": "Backlog" }),
        ),
        (
            "import_asset",
            json!({ "contentPath": "notes.md", "sourcePath": photo.to_string_lossy() }),
        ),
    ] {
        let result = call_tool(&denied, Some(&target), name, args).await;
        assert_eq!(error_code(&result), "REPOSITORY_ACCESS_DENIED", "{name}");
    }

    assert_eq!(source_snapshot(&fixture.project), before);
    assert!(
        denied
            .authorized()
            .iter()
            .all(|repository| repository == &fixture.project)
    );
    assert!(denied.deliveries.lock().unwrap().is_empty());

    let limited = FixtureHost::serving(&FIRST_SLICE_TOOLS);
    for name in STRUCTURAL_TOOLS {
        let result = call_tool(&limited, Some(&target), name, json!({})).await;
        assert_eq!(error_code(&result), "UNKNOWN_TOOL", "{name}");
    }
}

#[tokio::test]
async fn managed_import_uses_the_shared_plan_and_host_delivery() {
    let fixture = write_fixture();
    let target = root_target(&fixture);
    let photo = fixture.project.parent().unwrap().join("photo.png");
    fs::write(&photo, b"image").unwrap();
    write(
        &fixture.project.join(".svode/config.json"),
        &json!({
            "name": "Project",
            "assets": { "strategy": "in-git" },
            "spaces": [{ "id": "child", "path": "child", "repo": null }]
        })
        .to_string(),
    );
    let host = FixtureHost::new(None);

    let imported = call_tool(
        &host,
        Some(&target),
        "import_asset",
        json!({ "contentPath": "leaf.md", "sourcePath": photo.to_string_lossy() }),
    )
    .await;
    let imported = structured(&imported);
    assert_eq!(imported["contentPath"], "leaf/README.md");
    assert_eq!(imported["fileName"], "photo.png");
    let attachment = imported["attachmentPath"].as_str().unwrap();
    assert!(fixture.project.join(attachment).is_file());
    assert!(!changed(imported).is_empty());
    let deliveries = host.deliveries.lock().unwrap().clone();
    assert_eq!(deliveries.len(), 1);
    assert!(deliveries[0].converted_page);
    assert_eq!(deliveries[0].canonical_content_path, "leaf/README.md");

    // Without spaceId the frozen default child Space owns the import, not
    // the root Space with a README at the same relative path.
    host.index
        .upsert_space(
            &fixture.project,
            "child",
            "child",
            SpaceStatus::Ready,
            Some("Child".to_string()),
        )
        .await;
    let child = call_tool(
        &host,
        Some(&child_target(&fixture)),
        "import_asset",
        json!({ "contentPath": "README.md", "sourcePath": photo.to_string_lossy() }),
    )
    .await;
    let child = structured(&child);
    assert_eq!(child["spaceId"], "child");
    assert_eq!(child["contentPath"], "README.md");
    let attachment = child["attachmentPath"].as_str().unwrap();
    assert!(fixture.project.join("child").join(attachment).is_file());
    assert!(!fixture.project.join(attachment).exists());

    let escaped = call_tool(
        &host,
        Some(&target),
        "import_asset",
        json!({ "contentPath": ".git/config.md", "sourcePath": photo.to_string_lossy() }),
    )
    .await;
    assert_eq!(error_code(&escaped), "PATH_FORBIDDEN");
    let legacy = call_tool(
        &host,
        Some(&target),
        "import_asset",
        json!({ "contentPath": "links.md", "sourcePath": photo.to_string_lossy(), "path": "x" }),
    )
    .await;
    assert_eq!(error_code(&legacy), "SERIALIZATION_ERROR");

    write(
        &fixture.project.join(".svode/config.json"),
        &json!({
            "name": "Project",
            "assets": {
                "strategy": "lfs-remote",
                "binaryRouting": { "version": 1, "lfsExtensions": ["png"] }
            }
        })
        .to_string(),
    );
    let not_ready = FixtureHost {
        lfs_ready: Some(false),
        ..FixtureHost::new(None)
    };
    let refused = call_tool(
        &not_ready,
        Some(&target),
        "import_asset",
        json!({ "contentPath": "README.md", "sourcePath": photo.to_string_lossy() }),
    )
    .await;
    assert!(refused.is_error);
    assert!(
        refused.content[0]
            .text
            .contains("Git LFS route is not ready")
    );
    assert_eq!(not_ready.lfs_probes.lock().unwrap().len(), 1);
    assert!(!fixture.project.join("photo.png").exists());
    assert!(not_ready.deliveries.lock().unwrap().is_empty());
}

const ROUTINE_TOOLS: [&str; 6] = [
    "list_routines",
    "get_routine",
    "create_routine",
    "update_routine",
    "delete_routine",
    "run_routine",
];

fn review_routine(name: &str, enabled: bool) -> Value {
    json!({
        "name": name,
        "enabled": enabled,
        "trigger": { "type": "event", "event": "collection.entry_created" },
        "action": {
            "type": "update_properties",
            "target": "trigger.entry",
            "set": { "reviewed": true }
        },
        "body": "Managed by Svode."
    })
}

fn routine_caller() -> RoutineCaller {
    RoutineCaller {
        routine_run_id: "run-one".to_string(),
        launch_id: "launch-one".to_string(),
        pty_id: "pty-one".to_string(),
    }
}

fn routine_files(fixture: &Fixture) -> Vec<String> {
    let dir = fixture.project.join("tasks/.routines");
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names = entries
        .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
        .collect::<Vec<_>>();
    names.sort();
    names
}

#[tokio::test]
async fn routine_definitions_use_the_shared_owner_with_strict_candidate_cas_and_policy() {
    let fixture = structure_fixture();
    let host = FixtureHost::new(None);
    let target = root_target(&fixture);
    let call = |name: &'static str, args: Value| call_tool(&host, Some(&target), name, args);

    let empty = call(
        "list_routines",
        json!({ "spaceId": "root", "collectionPath": "tasks" }),
    )
    .await;
    assert_eq!(structured(&empty)["total"], 0);
    assert_eq!(structured(&empty)["automaticAuthorityEnabled"], false);
    assert_eq!(structured(&empty)["owner"]["ownerPath"], "tasks");

    let unknown_executor = call(
        "create_routine",
        json!({
            "spaceId": "root",
            "collectionPath": "tasks",
            "definition": {
                "name": "Agent task",
                "trigger": { "type": "manual" },
                "action": { "type": "run_agent", "executor": "agent:01arz3ndektsv4rrffq69g5fav" },
                "body": "Do it."
            }
        }),
    )
    .await;
    assert_eq!(error_code(&unknown_executor), "ROUTINE_INVALID");
    let unconfirmed = call(
        "create_routine",
        json!({
            "spaceId": "root",
            "collectionPath": "tasks",
            "definition": review_routine("Keep review state", true)
        }),
    )
    .await;
    assert_eq!(
        error_code(&unconfirmed),
        "ROUTINE_AUTOMATIC_CONFIRMATION_REQUIRED"
    );
    let routine_target = RequestTarget {
        routine_caller: Some(routine_caller()),
        ..root_target(&fixture)
    };
    let recursive = call_tool(
        &host,
        Some(&routine_target),
        "create_routine",
        json!({
            "spaceId": "root",
            "collectionPath": "tasks",
            "definition": review_routine("Keep review state", true),
            "confirmAutomaticExecution": true
        }),
    )
    .await;
    assert_eq!(error_code(&recursive), "ROUTINE_RECURSION_GUARD");
    assert!(routine_files(&fixture).is_empty());
    assert!(host.authorized().is_empty());
    assert!(host.routine_invalidations.lock().unwrap().is_empty());

    let created = call(
        "create_routine",
        json!({
            "spaceId": "root",
            "collectionPath": "tasks",
            "definition": review_routine("Keep review state", false)
        }),
    )
    .await;
    let created = structured(&created).clone();
    assert_eq!(created["path"], "tasks/.routines/Keep review state.md");
    assert_eq!(
        created["changedPaths"],
        json!(["tasks/.routines/Keep review state.md"])
    );
    assert_eq!(created["detail"]["valid"], true);
    assert_eq!(created["detail"]["definition"]["body"], "Managed by Svode.");
    assert_eq!(host.authorized(), vec![fixture.project.clone()]);
    assert_eq!(
        host.routine_invalidations.lock().unwrap()[0].owner_path,
        "tasks"
    );
    let routine_id = created["routineId"].as_str().unwrap().to_string();
    let fingerprint = created["fingerprint"].as_str().unwrap().to_string();

    let duplicate = call(
        "create_routine",
        json!({
            "spaceId": "root",
            "collectionPath": "tasks",
            "definition": review_routine("Keep review state", false)
        }),
    )
    .await;
    assert_eq!(error_code(&duplicate), "ROUTINE_NAME_CONFLICT");

    let detail = call(
        "get_routine",
        json!({ "spaceId": "root", "collectionPath": "tasks", "routineId": routine_id }),
    )
    .await;
    assert_eq!(structured(&detail)["fingerprint"], fingerprint.as_str());
    let listed = call(
        "list_routines",
        json!({ "spaceId": "root", "collectionPath": "tasks" }),
    )
    .await;
    assert_eq!(structured(&listed)["total"], 1);
    assert!(
        structured(&listed)["routines"][0]
            .get("definition")
            .is_none()
    );

    let source = read(&fixture, "tasks/.routines/Keep review state.md");
    let stale = call(
        "update_routine",
        json!({
            "spaceId": "root",
            "collectionPath": "tasks",
            "routineId": routine_id,
            "expectedFingerprint": "stale",
            "definition": review_routine("Review state", false)
        }),
    )
    .await;
    assert_eq!(error_code(&stale), "ROUTINE_FINGERPRINT_CONFLICT");
    assert_eq!(
        stale.structured_content.as_ref().unwrap()["error"]["currentFingerprint"],
        fingerprint.as_str()
    );
    let invalid = call(
        "update_routine",
        json!({
            "spaceId": "root",
            "collectionPath": "tasks",
            "routineId": routine_id,
            "expectedFingerprint": fingerprint,
            "definition": {
                "name": "Keep review state",
                "trigger": { "type": "manual" },
                "action": { "type": "run_agent", "executor": "agent:01arz3ndektsv4rrffq69g5fav" },
                "body": ""
            }
        }),
    )
    .await;
    assert_eq!(error_code(&invalid), "ROUTINE_INVALID");
    assert_eq!(
        read(&fixture, "tasks/.routines/Keep review state.md"),
        source
    );

    let updated = call(
        "update_routine",
        json!({
            "spaceId": "root",
            "collectionPath": "tasks",
            "routineId": routine_id,
            "expectedFingerprint": fingerprint,
            "definition": review_routine("Review state", false)
        }),
    )
    .await;
    let updated = structured(&updated).clone();
    assert_eq!(
        updated["changedPaths"],
        json!([
            "tasks/.routines/Keep review state.md",
            "tasks/.routines/Review state.md"
        ])
    );
    assert_eq!(routine_files(&fixture), vec!["Review state.md".to_string()]);

    let deleted = call(
        "delete_routine",
        json!({
            "spaceId": "root",
            "collectionPath": "tasks",
            "routineId": routine_id,
            "expectedFingerprint": updated["fingerprint"]
        }),
    )
    .await;
    assert_eq!(
        structured(&deleted)["path"],
        "tasks/.routines/Review state.md"
    );
    assert!(routine_files(&fixture).is_empty());
    assert_eq!(host.routine_invalidations.lock().unwrap().len(), 3);
    assert_eq!(commit_count(&fixture), "1");

    for (args, code) in [
        (json!({ "spaceId": " root" }), "INVALID_SPACE_ID"),
        (
            json!({ "spaceId": "root", "collectionPath": "tasks/.routines" }),
            "PATH_FORBIDDEN",
        ),
        (
            json!({ "spaceId": "root", "collectionPath": "../tasks" }),
            "INVALID_PATH",
        ),
    ] {
        assert_eq!(error_code(&call("list_routines", args).await), code);
    }
}

#[tokio::test]
async fn run_routine_goes_through_the_host_runner_and_is_blocked_for_routine_callers() {
    let fixture = structure_fixture();
    let host = FixtureHost::new(None);
    let target = root_target(&fixture);
    let run_args = json!({
        "spaceId": "root",
        "collectionPath": "tasks",
        "routineId": "routine:one",
        "expectedFingerprint": "fingerprint-one"
    });

    let started = call_tool(&host, Some(&target), "run_routine", run_args.clone()).await;
    assert_eq!(structured(&started)["status"], "started");
    assert_eq!(structured(&started)["routineRunId"], "run-fixture");
    assert_eq!(
        host.runs(),
        vec![(
            "tasks".to_string(),
            "routine:one".to_string(),
            "fingerprint-one".to_string()
        )]
    );
    assert_eq!(host.authorized(), vec![fixture.project.clone()]);

    let routine_target = RequestTarget {
        routine_caller: Some(routine_caller()),
        ..root_target(&fixture)
    };
    let recursive = call_tool(
        &host,
        Some(&routine_target),
        "run_routine",
        run_args.clone(),
    )
    .await;
    assert_eq!(structured(&recursive)["status"], "blocked");
    assert_eq!(structured(&recursive)["code"], "ROUTINE_RECURSION_GUARD");
    assert_eq!(host.runs().len(), 1);

    let denied = FixtureHost::denying_mutations();
    let denied_run = call_tool(&denied, Some(&target), "run_routine", run_args.clone()).await;
    assert_eq!(error_code(&denied_run), "REPOSITORY_ACCESS_DENIED");
    assert!(denied.runs().is_empty());
    for (tool, args) in [
        (
            "create_routine",
            json!({
                "spaceId": "root",
                "collectionPath": "tasks",
                "definition": review_routine("Keep review state", false)
            }),
        ),
        (
            "delete_routine",
            json!({
                "spaceId": "root",
                "collectionPath": "tasks",
                "routineId": "routine:one",
                "expectedFingerprint": "fingerprint-one"
            }),
        ),
    ] {
        let result = call_tool(&denied, Some(&target), tool, args).await;
        assert_eq!(error_code(&result), "REPOSITORY_ACCESS_DENIED", "{tool}");
    }
    assert!(routine_files(&fixture).is_empty());

    let without_runner = FixtureHost::without_runner();
    let names = served_names(&without_runner);
    assert_eq!(names.len(), 53);
    assert!(!names.contains(&"run_routine".to_string()));
    assert_eq!(
        error_code(&call_tool(&without_runner, Some(&target), "run_routine", run_args).await),
        "UNKNOWN_TOOL"
    );

    let limited = FixtureHost::serving(&FIRST_SLICE_TOOLS);
    for name in ROUTINE_TOOLS {
        let result = call_tool(&limited, Some(&target), name, json!({})).await;
        assert_eq!(error_code(&result), "UNKNOWN_TOOL", "{name}");
    }
}

/// Proof of the seam over the whole catalog: every published tool is
/// dispatched by the library on a host without Tauri; none falls through
/// to a host-owned handler.
#[tokio::test]
async fn every_catalog_tool_is_dispatched_by_the_library() {
    let fixture = fixture();
    let host = FixtureHost::new(None);
    let target = root_target(&fixture);
    let names = catalog::definitions()
        .into_iter()
        .map(|definition| definition.name)
        .collect::<Vec<_>>();
    assert_eq!(names.len(), 54);
    for name in names {
        let result = call_tool(&host, Some(&target), name, json!({})).await;
        if result.is_error {
            assert_ne!(error_code(&result), "UNKNOWN_TOOL", "{name}");
        }
    }
}

/// A host that reports only the pools its runtime keeps open (the default
/// seam) answers an index-backed read without an open pool with
/// `INDEX_UNAVAILABLE`, never an empty result, and creates no index.
#[tokio::test]
async fn index_backed_reads_without_an_open_index_are_unavailable() {
    let fixture = index_fixture();
    let host = FixtureHost::new(None);
    let target = root_target(&fixture);
    for (name, arguments) in [
        ("search_pages", json!({ "query": "Needle" })),
        (
            "query_collection_items",
            json!({ "collectionPath": "tasks" }),
        ),
        ("get_knowledge_status", json!({})),
        (
            "search_knowledge",
            json!({ "query": "Needle", "scope": "project" }),
        ),
        ("get_related_context", json!({ "query": "Needle" })),
    ] {
        let result = call_tool(&host, Some(&target), name, arguments).await;
        assert_eq!(error_code(&result), "INDEX_UNAVAILABLE", "{name}");
        let error = &result.structured_content.as_ref().unwrap()["error"];
        assert_eq!(
            error["diagnostics"][0]["code"], "pool_unavailable",
            "{name}"
        );
    }
    assert!(!fixture.project.join(".svode/index.db").exists());
    assert!(!fixture.project.join("child/.svode/index.db").exists());
}

/// The same host reports the state of an open index in `index`: fresh
/// without a completed check of this process until its reconciliation
/// cycle runs.
#[tokio::test]
async fn index_backed_reads_report_the_open_index_of_the_host() {
    let fixture = index_fixture();
    let host = indexed_host(&fixture, FixtureHost::new(None)).await;
    let target = root_target(&fixture);
    let search = call_tool(
        &host,
        Some(&target),
        "search_pages",
        json!({ "query": "Needle" }),
    )
    .await;
    let index = &structured(&search)["index"];
    assert_eq!(index["status"], "fresh");
    assert_eq!(index["verifiedAt"], Value::Null);

    let root = IndexKey::Root(fixture.project.clone());
    host.updates
        .reconcile_space(&host.index, &root, None::<&GitCli>)
        .await
        .unwrap();
    for (name, arguments) in [
        ("search_pages", json!({ "query": "Needle" })),
        (
            "query_collection_items",
            json!({ "collectionPath": "tasks" }),
        ),
        ("get_knowledge_status", json!({})),
    ] {
        let result = call_tool(&host, Some(&target), name, arguments).await;
        let index = &structured(&result)["index"];
        assert_eq!(index["status"], "fresh", "{name}");
        assert!(index["verifiedAt"].is_string(), "{name}");
    }
    host.routines.close_key(&root).await;
}

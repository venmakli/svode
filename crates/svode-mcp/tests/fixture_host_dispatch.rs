//! The shared dispatch runs on a host without Tauri against a real
//! `svode-core` fixture project. This proves the host seam, not a headless
//! capability.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use sqlx::SqlitePool;
use svode_core::git::access::{RepositoryAccessSnapshot, RepositoryAccessStatus};
use svode_core::index::IndexKey;
use svode_core::index::state::IndexRuntimeState;
use svode_core::index::update::IndexUpdateState;
use svode_core::page::nonce::WriteNonceRegistry;
use svode_core::routines::store_state::RoutineStoreState;
use svode_mcp::catalog;
use svode_mcp::control::{self, BridgeCall, MCP_PROTOCOL_VERSION};
use svode_mcp::dispatch::call_tool;
use svode_mcp::error::McpBusinessError;
use svode_mcp::host::{McpHost, MutationRuntime, RequestTarget};
use svode_mcp::protocol::ToolCallResult;

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
    host_calls: Mutex<Vec<String>>,
    deny_mutations: bool,
    authorized: Mutex<Vec<PathBuf>>,
    index: IndexRuntimeState,
    updates: IndexUpdateState,
    nonces: WriteNonceRegistry,
}

impl FixtureHost {
    fn new(pool: Option<SqlitePool>) -> Self {
        Self {
            served: None,
            pool,
            pool_keys: Mutex::new(Vec::new()),
            host_calls: Mutex::new(Vec::new()),
            deny_mutations: false,
            authorized: Mutex::new(Vec::new()),
            index: IndexRuntimeState::default(),
            updates: IndexUpdateState::new(Arc::new(RoutineStoreState::new())),
            nonces: WriteNonceRegistry::new(),
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

    fn host_calls(&self) -> Vec<String> {
        self.host_calls.lock().unwrap().clone()
    }
}

impl McpHost for FixtureHost {
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
        self.pool.clone()
    }

    async fn repository_access(
        &self,
        space_path: &Path,
    ) -> Result<RepositoryAccessSnapshot, McpBusinessError> {
        if space_path.ends_with("child") {
            return Err(McpBusinessError::new("GIT_NOT_FOUND", "Git not found"));
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

    async fn require_mutation_access(&self, repository: &Path) -> Result<(), McpBusinessError> {
        self.authorized
            .lock()
            .unwrap()
            .push(repository.to_path_buf());
        if self.deny_mutations {
            return Err(McpBusinessError::new(
                "REPOSITORY_ACCESS_DENIED",
                "Repository access denied: status=read_only",
            ));
        }
        Ok(())
    }

    fn mutation_runtime(&self) -> MutationRuntime<'_> {
        MutationRuntime {
            index: &self.index,
            updates: &self.updates,
            nonces: &self.nonces,
        }
    }

    async fn call_host_tool(
        &self,
        name: &str,
        _args: Value,
    ) -> Result<ToolCallResult, McpBusinessError> {
        self.host_calls.lock().unwrap().push(name.to_string());
        Ok(ToolCallResult::ok("host", json!({ "host": name })))
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
fn control_plane_reports_host_version_and_filtered_catalog() {
    let host = FixtureHost::new(None);
    let initialize = control::initialize(host.version());
    assert_eq!(initialize["protocolVersion"], MCP_PROTOCOL_VERSION);
    assert_eq!(initialize["protocolVersion"], "2025-06-18");
    assert_eq!(initialize["serverInfo"]["version"], "9.9.9-fixture");
    assert!(initialize["instructions"].as_str().is_some_and(|value| {
        value.contains("Call get_svode_guide")
            && value.contains("Routine-launched")
            && value.contains("canonical contentPath")
            && value.contains("validate_app_manifest")
    }));

    let all = control::tools_list(&host);
    assert_eq!(all["tools"].as_array().unwrap().len(), 54);
    assert_eq!(catalog::definitions().len(), 54);

    let limited = FixtureHost::serving(&FIRST_SLICE_TOOLS);
    let names = control::tools_list(&limited)["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(names.len(), FIRST_SLICE_TOOLS.len());
    assert!(!names.contains(&"run_routine".to_string()));
    assert_eq!(
        control::check_tool(&limited, "run_routine")
            .unwrap_err()
            .code,
        "UNKNOWN_TOOL"
    );
    assert_eq!(
        control::check_tool(&host, "legacy_tool").unwrap_err().code,
        "UNKNOWN_TOOL"
    );
}

#[test]
fn bridge_methods_keep_protocol_and_business_envelopes_apart() {
    let host = FixtureHost::new(None);
    let respond =
        |method: &str, params: Value| match control::bridge_request(&host, method, &params) {
            BridgeCall::Respond(response) => response,
            BridgeCall::CallTool { name, .. } => panic!("unexpected tool call {name}"),
        };

    assert_eq!(
        respond("initialize", json!({})).result.unwrap()["serverInfo"]["version"],
        "9.9.9-fixture"
    );
    assert_eq!(respond("ping", json!({})).result.unwrap()["ok"], true);
    assert_eq!(
        respond("tools/call", json!({ "name": "legacy_tool" }))
            .error
            .unwrap()
            .code,
        "UNKNOWN_TOOL"
    );
    assert_eq!(
        respond("tools/call", json!({})).error.unwrap().code,
        "INVALID_REQUEST"
    );
    assert_eq!(
        respond("resources/list", json!({})).error.unwrap().code,
        "UNKNOWN_METHOD"
    );
    match control::bridge_request(&host, "tools/call", &json!({ "name": "read_page" })) {
        BridgeCall::CallTool { name, args } => {
            assert_eq!(name, "read_page");
            assert_eq!(args, json!({}));
        }
        BridgeCall::Respond(_) => panic!("known tool must reach the host request context"),
    }
    assert!(host.host_calls().is_empty());
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
    assert!(host.host_calls().is_empty());
}

#[tokio::test]
async fn requests_without_project_and_unmapped_families() {
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

    let target = root_target(&fixture);
    let routed = call_tool(&host, Some(&target), "delete_page", json!({})).await;
    assert_eq!(structured(&routed)["host"], "delete_page");
    let unknown = call_tool(&host, Some(&target), "legacy_tool", json!({})).await;
    assert_eq!(error_code(&unknown), "UNKNOWN_TOOL");
    assert_eq!(host.host_calls(), vec!["delete_page".to_string()]);

    let limited = FixtureHost::serving(&FIRST_SLICE_TOOLS);
    let excluded = call_tool(&limited, Some(&target), "write_page", json!({})).await;
    assert_eq!(error_code(&excluded), "UNKNOWN_TOOL");
    assert!(limited.host_calls().is_empty());
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

    // Missing and null title are body-only; the path never changes.
    for args in [
        json!({ "path": "leaf.md", "content": "First body\n" }),
        json!({ "path": "leaf.md", "content": "Second body\n", "title": null }),
    ] {
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
        json!({ "path": "leaf.md", "content": "Second body\n" }),
    )
    .await;
    assert!(changed(structured(&noop)).is_empty());

    // A title intent renames through Desktop naming and rewrites links.
    let renamed = call(
        "write_page",
        json!({ "path": "leaf.md", "content": "Renamed body\n", "title": "Renamed" }),
    )
    .await;
    let renamed = structured(&renamed);
    assert_eq!(renamed["path"], "Renamed.md");
    assert_eq!(renamed["newPath"], "Renamed.md");
    assert_eq!(changed(renamed), ["Renamed.md", "leaf.md", "links.md"]);
    assert!(!fixture.project.join("leaf.md").exists());
    assert!(read(&fixture, "links.md").contains("(Renamed.md)"));

    // Root README keeps its path; a nested Collection README renames its
    // directory and reports the resulting owner.
    let space = call(
        "write_space_readme",
        json!({ "content": "New owner body\n", "title": "Renamed Project" }),
    )
    .await;
    assert_eq!(structured(&space)["path"], "README.md");
    assert_eq!(structured(&space)["newPath"], Value::Null);
    assert!(read(&fixture, "README.md").contains("title: Renamed Project"));

    let collection = call(
        "write_collection_readme",
        json!({ "collectionPath": "tasks", "content": "Board\n", "title": "Backlog" }),
    )
    .await;
    let collection = structured(&collection);
    assert_eq!(collection["path"], "Backlog/README.md");
    assert_eq!(collection["collectionPath"], "Backlog");
    assert!(fixture.project.join("Backlog/a.md").exists());

    let body = call(
        "update_collection_item_body",
        json!({ "path": "Backlog/a.md", "body": "Item update\n" }),
    )
    .await;
    assert_eq!(structured(&body)["path"], "Backlog/a.md");
    assert!(read(&fixture, "Backlog/a.md").contains("Status: Todo"));
    assert!(read(&fixture, "Backlog/a.md").ends_with("Item update\n"));

    let child = call(
        "write_space_readme",
        json!({ "spaceId": "child", "content": "Child update\n" }),
    )
    .await;
    assert_eq!(changed(structured(&child)), ["README.md"]);
    assert!(read(&fixture, "child/README.md").ends_with("Child update\n"));

    for (name, args, code) in [
        (
            "write_page",
            json!({ "path": "Backlog/a.md", "content": "x" }),
            "NOT_A_STANDALONE_PAGE",
        ),
        (
            "update_collection_item_body",
            json!({ "path": "Renamed.md", "body": "x" }),
            "NOT_A_COLLECTION_ITEM",
        ),
        (
            "write_page",
            json!({ "path": ".svode/x.md", "content": "x" }),
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
    assert!(host.host_calls().is_empty());
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
            json!({ "path": "leaf.md", "content": "x", "title": "Moved" }),
        ),
        ("create_page", json!({ "parentPath": "", "title": "New" })),
        (
            "update_page_metadata",
            json!({ "path": "leaf.md", "icon": "x" }),
        ),
        ("write_space_readme", json!({ "content": "x" })),
        ("update_space_metadata", json!({ "icon": "x" })),
        (
            "write_collection_readme",
            json!({ "collectionPath": "tasks", "content": "x" }),
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
            json!({ "path": "tasks/a.md", "body": "x" }),
        ),
        (
            "update_collection_item_metadata",
            json!({ "path": "tasks/a.md", "icon": "x" }),
        ),
        (
            "write_space_readme",
            json!({ "spaceId": "child", "content": "x" }),
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
    assert!(denied.host_calls().is_empty());
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
        json!({ "path": "leaf.md", "content": "Body\n", "title": "Taken" }),
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
        json!({ "path": "leaf.md", "content": "Lost body\n", "title": "Moved" }),
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

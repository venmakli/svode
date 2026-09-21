//! The shared dispatch runs on a host without Tauri against a real
//! `svode-core` fixture project. This proves the host seam, not a headless
//! capability.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{Value, json};
use sqlx::SqlitePool;
use svode_core::git::access::{RepositoryAccessSnapshot, RepositoryAccessStatus};
use svode_core::index::IndexKey;
use svode_mcp::catalog;
use svode_mcp::control::{self, BridgeCall, MCP_PROTOCOL_VERSION};
use svode_mcp::dispatch::call_tool;
use svode_mcp::error::McpBusinessError;
use svode_mcp::host::{McpHost, RequestTarget};
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
}

impl FixtureHost {
    fn new(pool: Option<SqlitePool>) -> Self {
        Self {
            served: None,
            pool,
            pool_keys: Mutex::new(Vec::new()),
            host_calls: Mutex::new(Vec::new()),
        }
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
    let routed = call_tool(&host, Some(&target), "write_page", json!({})).await;
    assert_eq!(structured(&routed)["host"], "write_page");
    let unknown = call_tool(&host, Some(&target), "legacy_tool", json!({})).await;
    assert_eq!(error_code(&unknown), "UNKNOWN_TOOL");
    assert_eq!(host.host_calls(), vec!["write_page".to_string()]);

    let limited = FixtureHost::serving(&FIRST_SLICE_TOOLS);
    let excluded = call_tool(&limited, Some(&target), "write_page", json!({})).await;
    assert_eq!(error_code(&excluded), "UNKNOWN_TOOL");
    assert!(limited.host_calls().is_empty());
}

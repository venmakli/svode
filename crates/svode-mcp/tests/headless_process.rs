//! `svode-mcp --project` as a real process with the desktop app closed: one
//! stdio session served in-process on the standalone host, the frozen
//! target, source reads that open no store and leave every byte of the
//! project unchanged, index-backed reads that reconcile the index with the
//! files first and again after the recheck window, and shutdown on EOF and
//! SIGTERM.

use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

const BIN: &str = env!("CARGO_BIN_EXE_svode-mcp");
const COMMIT_DATE: &str = "2020-01-02T03:04:05Z";

/// Tools a standalone process serves in this build.
const SERVED: [&str; 25] = [
    "get_collection_schema",
    "get_git_status",
    "get_knowledge_neighbors",
    "get_knowledge_node",
    "get_knowledge_status",
    "get_project_info",
    "get_related_context",
    "get_svode_guide",
    "list_actors",
    "list_collections",
    "list_pages",
    "list_spaces",
    "query_collection_items",
    "read_collection_item",
    "read_collection_readme",
    "read_page",
    "read_space_readme",
    "search_knowledge",
    "search_pages",
    "update_collection_item_body",
    "validate_app_manifest",
    "validate_collection_integrity",
    "write_collection_readme",
    "write_page",
    "write_space_readme",
];

/// Recheck window of the session plus a margin; not a public contract.
const RECHECK: Duration = Duration::from_millis(2_300);

struct Fixture {
    temp: tempfile::TempDir,
    project: PathBuf,
    git: bool,
}

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn git(dir: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_AUTHOR_DATE", COMMIT_DATE)
        .env("GIT_COMMITTER_DATE", COMMIT_DATE)
        .output()
        .is_ok_and(|output| output.status.success())
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
        &project.join("README.md"),
        "---\ntitle: Project\n---\nOwner\n",
    );
    write(
        &project.join("notes.md"),
        "---\ntitle: Notes\n---\nNotes body\n",
    );
    write(
        &project.join("tasks/schema.yaml"),
        "columns:\n  - name: Status\n    type: text\nviews:\n  - type: table\n    name: Table\n",
    );
    write(
        &project.join("tasks/README.md"),
        "---\ntitle: Tasks\n---\nTasks owner\n",
    );
    write(
        &project.join("tasks/alpha.md"),
        "---\ntitle: Alpha\nStatus: Todo\n---\nAlpha body\n",
    );
    write(
        &project.join("child/.svode/config.json"),
        r#"{"name":"Child"}"#,
    );
    write(&project.join("child/README.md"), "---\ntitle: Child\n---\n");
    write(
        &project.join("child/brief.md"),
        "---\ntitle: Brief\n---\nChild body\n",
    );
    let git = git(&project, &["init", "-q"])
        && git(&project, &["config", "user.email", "agent@example.com"])
        && git(&project, &["config", "user.name", "Agent"])
        && git(&project, &["add", "-A"])
        && git(&project, &["commit", "-q", "-m", "fixture"]);
    Fixture { temp, project, git }
}

fn snapshot(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn walk(dir: &Path, root: &Path, files: &mut BTreeMap<PathBuf, Vec<u8>>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            let key = path.strip_prefix(root).unwrap().to_path_buf();
            if path.is_dir() {
                files.insert(key, Vec::new());
                walk(&path, root, files);
            } else {
                files.insert(key, fs::read(&path).unwrap());
            }
        }
    }
    let mut files = BTreeMap::new();
    walk(root, root, &mut files);
    files
}

fn spawn(cwd: &Path, args: &[&str]) -> Child {
    Command::new(BIN)
        .args(args)
        .current_dir(cwd)
        // No desktop discovery can be reached from this process, and its
        // device-local settings are apart from the user's own.
        .env("SVODE_MCP_DISCOVERY", cwd.join("no-desktop.json"))
        .env("SVODE_PRODUCT_IDENTIFIER", "app.svode.desktop.test")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

fn wait(child: &mut Child) -> ExitStatus {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        assert!(Instant::now() < deadline, "svode-mcp did not exit");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn call(id: u64, name: &str, arguments: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "tools/call",
        "params": { "name": name, "arguments": arguments }
    })
}

/// Runs one whole session: sends `requests`, closes stdin and returns the
/// responses by id once the process has exited.
fn session(cwd: &Path, args: &[&str], requests: &[Value]) -> BTreeMap<u64, Value> {
    let mut child = spawn(cwd, args);
    let mut stdin = child.stdin.take().unwrap();
    for request in requests {
        writeln!(stdin, "{request}").unwrap();
    }
    drop(stdin);
    let status = wait(&mut child);
    let mut stderr = String::new();
    std::io::Read::read_to_string(&mut child.stderr.take().unwrap(), &mut stderr).unwrap();
    assert!(status.success(), "{status}: {stderr}");
    BufReader::new(child.stdout.take().unwrap())
        .lines()
        .map(|line| serde_json::from_str::<Value>(&line.unwrap()).unwrap())
        .map(|response| (response["id"].as_u64().unwrap(), response))
        .collect()
}

fn structured(response: &Value) -> &Value {
    assert_ne!(response["result"]["isError"], true, "{response}");
    assert!(response["result"].is_object(), "{response}");
    &response["result"]["structuredContent"]
}

fn business_code(response: &Value) -> &str {
    assert_eq!(response["result"]["isError"], true, "{response}");
    response["result"]["structuredContent"]["error"]["code"]
        .as_str()
        .unwrap()
}

#[test]
fn headless_session_serves_source_reads_without_desktop_and_changes_nothing() {
    let fixture = fixture();
    let before = snapshot(fixture.temp.path());
    let project = fixture.project.to_str().unwrap();
    let responses = session(
        fixture.temp.path(),
        &["--project", project],
        &[
            json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }),
            json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
            json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
            call(3, "read_page", json!({ "path": "notes.md" })),
            call(4, "list_pages", json!({})),
            call(5, "list_spaces", json!({})),
            call(6, "list_collections", json!({})),
            call(7, "read_space_readme", json!({ "spaceId": "child" })),
            call(
                8,
                "read_collection_readme",
                json!({ "collectionPath": "tasks" }),
            ),
            call(
                9,
                "read_collection_item",
                json!({ "path": "tasks/alpha.md" }),
            ),
            call(10, "get_project_info", json!({})),
            call(11, "list_routines", json!({ "spaceId": "root" })),
            call(
                12,
                "write_page",
                json!({ "path": "notes.md", "content": "overwritten" }),
            ),
            call(13, "run_routine", json!({})),
            call(14, "no_such_tool", json!({})),
            json!({ "jsonrpc": "2.0", "id": 15, "method": "ping" }),
            json!({ "jsonrpc": "2.0", "id": 16, "method": "resources/list" }),
            call(
                17,
                "update_page_metadata",
                json!({ "path": "notes.md", "icon": "x" }),
            ),
        ],
    );

    assert_eq!(responses.len(), 17, "{responses:?}");
    let info = &responses[&1]["result"];
    assert_eq!(info["serverInfo"]["version"], env!("CARGO_PKG_VERSION"));
    let mut tools = responses[&2]["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    tools.sort();
    assert_eq!(tools, SERVED);

    let page = &structured(&responses[&3])["page"];
    assert_eq!(page["body"], "Notes body\n");
    if fixture.git {
        // Dates of a source read without an index come from Git history.
        assert!(
            page["meta"]["updated"]
                .as_str()
                .is_some_and(|date| date.starts_with("2020-01-02")),
            "{page}"
        );
    }
    assert!(structured(&responses[&4])["total"].as_u64().unwrap() > 0);
    let spaces = structured(&responses[&5]);
    assert_eq!(spaces["activeMcpSpaceId"], "root");
    assert_eq!(spaces["spaces"].as_array().unwrap().len(), 2);
    assert_eq!(
        structured(&responses[&6])["collections"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        structured(&responses[&7])["spaceReadme"]["path"],
        "README.md"
    );
    assert_eq!(
        structured(&responses[&8])["collectionReadme"]["body"],
        "Tasks owner\n"
    );
    assert_eq!(structured(&responses[&9])["item"]["body"], "Alpha body\n");
    let project_info = structured(&responses[&10]);
    assert_eq!(project_info["projectPath"], project);
    assert_eq!(project_info["activeMcpSpaceId"], "root");
    if fixture.git {
        // Repository access comes from the shared evidence store without a
        // probe: a repository without a remote is local.
        assert_eq!(spaces["spaces"][0]["repositoryAccess"]["status"], "local");
        assert_eq!(
            spaces["spaces"][0]["repositoryAccessDiagnostic"],
            Value::Null
        );
    }

    assert_eq!(business_code(&responses[&11]), "MODE_UNAVAILABLE");
    assert_eq!(business_code(&responses[&17]), "MODE_UNAVAILABLE");
    // A body write of a client with the schema before `sourceVersion` is an
    // argument error before any effect, never a versionless overwrite.
    assert_eq!(business_code(&responses[&12]), "SERIALIZATION_ERROR");
    assert!(
        responses[&12]["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("sourceVersion"),
        "{}",
        responses[&12]
    );
    for id in [13, 14] {
        assert_eq!(
            responses[&id]["error"]["code"], -32602,
            "{}",
            responses[&id]
        );
    }
    assert_eq!(responses[&15]["result"]["ok"], true);
    assert_eq!(responses[&16]["error"]["code"], -32601);

    // No index, Routine store or source file was created or changed.
    assert_eq!(snapshot(fixture.temp.path()), before);
}

/// An open session: one request at a time, stdin kept open.
struct Live {
    child: Child,
    stdin: std::process::ChildStdin,
    stdout: BufReader<std::process::ChildStdout>,
    next: u64,
}

impl Live {
    fn start(cwd: &Path, args: &[&str]) -> Self {
        let mut child = spawn(cwd, args);
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Self {
            child,
            stdin,
            stdout,
            next: 1,
        }
    }

    fn call(&mut self, name: &str, arguments: Value) -> Value {
        let id = self.next;
        self.next += 1;
        writeln!(self.stdin, "{}", call(id, name, arguments)).unwrap();
        let mut line = String::new();
        self.stdout.read_line(&mut line).unwrap();
        let response: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(response["id"], id, "{response}");
        response
    }

    fn ok(&mut self, name: &str, arguments: Value) -> Value {
        let response = self.call(name, arguments);
        structured(&response).clone()
    }

    fn finish(mut self) {
        drop(self.stdin);
        let status = wait(&mut self.child);
        assert!(status.success(), "{status}");
    }
}

fn result_paths(value: &Value) -> Vec<String> {
    let mut paths = value["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["path"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

fn assert_fresh(value: &Value) -> String {
    assert_eq!(value["index"]["status"], "fresh", "{value}");
    assert_eq!(value["index"]["diagnostics"], json!([]), "{value}");
    value["index"]["verifiedAt"].as_str().unwrap().to_string()
}

/// No SQLite write-ahead log is left: the session closed its pools.
fn assert_closed(space: &Path) {
    for name in ["index.db-wal", "routines.db-wal"] {
        assert!(!space.join(".svode").join(name).exists(), "{name}");
    }
}

#[test]
fn index_backed_reads_prepare_the_index_and_recheck_it_after_the_window() {
    let fixture = fixture();
    let project = &fixture.project;
    assert!(!project.join(".svode/index.db").exists());
    let mut live = Live::start(
        fixture.temp.path(),
        &["--project", project.to_str().unwrap()],
    );

    // The first index-backed read builds the cold index before answering.
    let first = live.ok("search_pages", json!({ "query": "Notes" }));
    let verified = assert_fresh(&first);
    assert_eq!(result_paths(&first), ["notes.md"]);
    assert!(project.join(".svode/index.db").is_file());
    let query = live.ok(
        "query_collection_items",
        json!({ "collectionPath": "tasks" }),
    );
    assert_eq!(query["index"]["verifiedAt"], verified.as_str());
    assert_eq!(query["items"][0]["meta"]["title"], "Alpha");

    // An external edit inside the session is visible once the last check
    // is older than the window.
    write(
        &project.join("extra.md"),
        "---\ntitle: Extra\n---\nNotes appendix\n",
    );
    write(
        &project.join("tasks/alpha.md"),
        "---\ntitle: Alpha\nStatus: Done\n---\nAlpha body\n",
    );
    std::thread::sleep(RECHECK);
    let later = live.ok("search_pages", json!({ "query": "Notes" }));
    assert!(assert_fresh(&later) > verified);
    assert_eq!(result_paths(&later), ["extra.md", "notes.md"]);
    let done = live.ok(
        "query_collection_items",
        json!({
            "collectionPath": "tasks",
            "filter": [{ "field": "Status", "op": "eq", "value": "Done" }]
        }),
    );
    assert_eq!(done["items"].as_array().unwrap().len(), 1);

    // A child Space and the whole Project scope prepare their own pools.
    let child = live.ok(
        "search_pages",
        json!({ "spaceId": "child", "query": "Child" }),
    );
    assert_fresh(&child);
    assert_eq!(result_paths(&child), ["brief.md"]);
    let status = live.ok("get_knowledge_status", json!({ "scope": "project" }));
    assert_fresh(&status);
    assert_eq!(status["counts"]["readablePools"], 2);
    let node = live.ok(
        "get_knowledge_node",
        json!({ "nodeId": "page:root:extra.md" }),
    );
    assert_fresh(&node);
    assert_eq!(node["node"]["title"], "Extra");
    for (name, arguments) in [
        ("search_knowledge", json!({ "query": "Notes" })),
        (
            "get_knowledge_neighbors",
            json!({ "nodeId": "page:root:notes.md" }),
        ),
        ("get_related_context", json!({ "query": "Notes" })),
    ] {
        assert_fresh(&live.ok(name, arguments));
    }
    if fixture.git {
        let actors = live.ok("list_actors", json!({}));
        assert_eq!(actors["actors"][0]["email"], "agent@example.com");
        assert!(live.ok("get_git_status", json!({}))["status"].is_object());
    }
    live.finish();
    assert_closed(project);
    assert_closed(&project.join("child"));
}

#[test]
fn an_incompatible_index_is_quarantined_and_rebuilt() {
    let fixture = fixture();
    let project = &fixture.project;
    let db = project.join(".svode/index.db");
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&db)
            .create_if_missing(true);
        let pool = sqlx::SqlitePool::connect_with(options).await.unwrap();
        sqlx::query("CREATE TABLE foreign_cache (value TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
    });

    let responses = session(
        fixture.temp.path(),
        &["--project", project.to_str().unwrap()],
        &[call(1, "search_pages", json!({ "query": "Notes" }))],
    );
    let search = structured(&responses[&1]);
    assert_fresh(search);
    assert_eq!(result_paths(search), ["notes.md"]);
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
}

#[test]
fn an_index_that_cannot_be_prepared_is_a_business_error() {
    let fixture = fixture();
    let project = &fixture.project;
    fs::create_dir_all(project.join(".svode/index.db")).unwrap();
    let responses = session(
        fixture.temp.path(),
        &["--project", project.to_str().unwrap()],
        &[
            call(1, "search_pages", json!({ "query": "Notes" })),
            call(2, "get_knowledge_status", json!({})),
            call(
                3,
                "query_collection_items",
                json!({ "collectionPath": "tasks" }),
            ),
        ],
    );
    for id in 1..=3 {
        assert_eq!(business_code(&responses[&id]), "INDEX_UNAVAILABLE");
        let diagnostics = &responses[&id]["result"]["structuredContent"]["error"]["diagnostics"];
        assert_eq!(diagnostics[0]["code"], "index_unavailable", "{diagnostics}");
    }
}

fn default_space(cwd: &Path, args: &[&str]) -> Value {
    let responses = session(cwd, args, &[call(1, "get_project_info", json!({}))]);
    structured(&responses[&1])["activeMcpSpaceId"].clone()
}

#[test]
fn default_space_follows_the_cwd_rule_and_an_explicit_space_wins() {
    let fixture = fixture();
    let project = fixture.project.to_str().unwrap();
    let child = fixture.project.join("child");
    let outside = fixture.temp.path();

    assert_eq!(default_space(outside, &["--project", project]), "root");
    assert_eq!(default_space(&child, &["--project", project]), "child");
    assert_eq!(default_space(&child, &["--project", ".."]), "child");
    assert_eq!(
        default_space(&child, &["--project", project, "--space", "root"]),
        "root"
    );
    assert_eq!(
        default_space(outside, &["--space", "child", "--project", "project"]),
        "child"
    );
}

fn startup_failure(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new(BIN)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1), "{args:?}");
    assert!(output.stdout.is_empty(), "{args:?}");
    String::from_utf8(output.stderr).unwrap()
}

#[test]
fn an_unusable_target_fails_before_the_session_starts() {
    let fixture = fixture();
    let cwd = fixture.temp.path();
    let project = fixture.project.to_str().unwrap();
    assert!(startup_failure(cwd, &["--project", "missing"]).starts_with("PROJECT_UNAVAILABLE"));
    assert!(
        startup_failure(cwd, &["--project", project, "--space", "ghost"])
            .starts_with("SPACE_UNAVAILABLE")
    );
    assert!(startup_failure(cwd, &["--project"]).starts_with("INVALID_ARGUMENT"));
    write(&fixture.project.join(".svode/config.json"), "{");
    assert!(startup_failure(cwd, &["--project", project]).starts_with("INVALID_PROJECT_CONFIG"));
}

#[test]
fn usage_names_the_project_mode() {
    let output = Command::new(BIN).output().unwrap();
    let usage = String::from_utf8(output.stderr).unwrap();
    assert!(
        usage.contains("svode-mcp --project <path> [--space <root|space-id>]"),
        "{usage}"
    );
}

#[cfg(unix)]
#[test]
fn sigterm_ends_an_open_session() {
    let fixture = fixture();
    let before = snapshot(fixture.temp.path());
    let mut child = spawn(
        fixture.temp.path(),
        &["--project", fixture.project.to_str().unwrap()],
    );
    let mut stdin = child.stdin.take().unwrap();
    writeln!(
        stdin,
        "{}",
        call(1, "read_page", json!({ "path": "notes.md" }))
    )
    .unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    let response: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(structured(&response)["page"]["body"], "Notes body\n");

    let killed = Command::new("kill")
        .args(["-TERM", &child.id().to_string()])
        .status()
        .unwrap();
    assert!(killed.success());
    // stdin stays open: the signal alone ends the session.
    let status = wait(&mut child);
    assert!(status.success(), "{status}");
    drop(stdin);
    assert_eq!(snapshot(fixture.temp.path()), before);
}

fn write_args(path: &str, content: &str, version: &Value) -> Value {
    json!({ "path": path, "content": content, "sourceVersion": version })
}

#[test]
fn body_writes_of_two_sessions_use_the_read_version_and_refuse_stale_or_busy_writes() {
    let fixture = fixture();
    if !fixture.git {
        return;
    }
    let project = fixture.project.to_str().unwrap();
    let mut first = Live::start(fixture.temp.path(), &["--project", project]);
    let mut second = Live::start(fixture.temp.path(), &["--project", project]);

    // The published schema requires the version of the replaced source.
    let tools = {
        writeln!(
            first.stdin,
            "{}",
            json!({ "jsonrpc": "2.0", "id": 0, "method": "tools/list" })
        )
        .unwrap();
        let mut line = String::new();
        first.stdout.read_line(&mut line).unwrap();
        serde_json::from_str::<Value>(&line).unwrap()
    };
    for name in [
        "write_page",
        "update_collection_item_body",
        "write_space_readme",
        "write_collection_readme",
    ] {
        let tool = tools["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == name)
            .unwrap();
        assert!(
            tool["inputSchema"]["required"]
                .as_array()
                .unwrap()
                .contains(&json!("sourceVersion")),
            "{name}"
        );
        assert!(
            tool["description"].as_str().unwrap().contains("own tools"),
            "{name}"
        );
    }

    // Both sessions read the same source; the first write applies and
    // returns the version of its result.
    let read = first.ok("read_page", json!({ "path": "notes.md" }));
    let v1 = read["sourceVersion"].clone();
    assert_eq!(
        second.ok("read_page", json!({ "path": "notes.md" }))["sourceVersion"],
        v1
    );
    let written = first.ok("write_page", write_args("notes.md", "First session\n", &v1));
    assert_eq!(written["changedPaths"], json!(["notes.md"]));
    let v2 = written["sourceVersion"].clone();
    assert_ne!(v2, v1);

    // The second session wrote nothing meanwhile: its write from the old
    // read is stale, keeps the first write and hands out no version.
    let stale = second.call(
        "write_page",
        write_args("notes.md", "Second session\n", &v1),
    );
    assert_eq!(business_code(&stale), "SOURCE_STALE");
    let error = &stale["result"]["structuredContent"]["error"];
    assert_eq!(error["path"], "notes.md");
    assert!(error.get("sourceVersion").is_none(), "{stale}");
    let reread = second.ok("read_page", json!({ "path": "notes.md" }));
    assert_eq!(reread["page"]["body"], "First session\n");
    assert_eq!(reread["sourceVersion"], v2);
    let applied = second.ok(
        "write_page",
        write_args("notes.md", "Second session\n", &reread["sourceVersion"]),
    );
    let v3 = applied["sourceVersion"].clone();

    // While this test process holds the write guard, a session is busy and
    // writes nothing; after the release the same write applies.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let guard = runtime
        .block_on(svode_core::git::write_guard::acquire(
            &std::collections::BTreeSet::from([fixture.project.clone()]),
            &[],
        ))
        .unwrap();
    let busy = first.call("write_page", write_args("notes.md", "Busy\n", &v3));
    assert_eq!(business_code(&busy), "SOURCE_BUSY");
    assert_eq!(
        busy["result"]["structuredContent"]["error"]["path"],
        "notes.md"
    );
    assert!(
        fs::read_to_string(fixture.project.join("notes.md"))
            .unwrap()
            .ends_with("Second session\n")
    );
    drop(guard);
    first.ok("write_page", write_args("notes.md", "Released\n", &v3));

    // Owner and item bodies take the version of their own reads.
    let item = first.ok("read_collection_item", json!({ "path": "tasks/alpha.md" }));
    let item = first.ok(
        "update_collection_item_body",
        json!({ "path": "tasks/alpha.md", "body": "Item\n", "sourceVersion": item["sourceVersion"] }),
    );
    assert!(item["sourceVersion"].is_string());
    let readme = first.ok("read_space_readme", json!({ "spaceId": "child" }));
    first.ok(
        "write_space_readme",
        json!({ "spaceId": "child", "content": "Child owner\n", "sourceVersion": readme["sourceVersion"] }),
    );
    let readme = first.ok(
        "read_collection_readme",
        json!({ "collectionPath": "tasks" }),
    );
    first.ok(
        "write_collection_readme",
        json!({ "collectionPath": "tasks", "content": "Board\n", "sourceVersion": readme["sourceVersion"] }),
    );

    // The other session sees the writes in its index after the window.
    std::thread::sleep(RECHECK);
    let found = second.ok("search_pages", json!({ "query": "Released" }));
    assert_eq!(result_paths(&found), ["notes.md"]);
    first.finish();
    second.finish();
    assert_closed(&fixture.project);
}

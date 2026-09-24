//! `svode-mcp --project` as a real process with the desktop app closed: one
//! stdio session served in-process on the standalone host, the frozen
//! target, source reads that open no store and leave every byte of the
//! project unchanged, index-backed reads that reconcile the index with the
//! files first and again after the recheck window, writes of every family,
//! Routine definitions from the owner store without execution, every served
//! tool in one session, and shutdown on EOF and SIGTERM.

use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

const BIN: &str = env!("CARGO_BIN_EXE_svode-mcp");
const COMMIT_DATE: &str = "2020-01-02T03:04:05Z";
/// Caller token a Routine launch of the desktop app passes to its processes.
const ROUTINE_CALLER_TOKEN: &str = "SVODE_MCP_ROUTINE_CALLER_TOKEN";

/// Tools a standalone process serves in this build.
const SERVED: [&str; 53] = [
    "add_collection_column",
    "add_collection_view",
    "convert_page_to_leaf",
    "convert_to_collection",
    "create_collection",
    "create_page",
    "create_routine",
    "delete_collection",
    "delete_collection_column",
    "delete_collection_item",
    "delete_collection_view",
    "delete_page",
    "delete_routine",
    "get_collection_schema",
    "get_git_status",
    "get_knowledge_neighbors",
    "get_knowledge_node",
    "get_knowledge_status",
    "get_project_info",
    "get_related_context",
    "get_routine",
    "get_svode_guide",
    "import_asset",
    "list_actors",
    "list_collections",
    "list_pages",
    "list_routines",
    "list_spaces",
    "move_content",
    "query_collection_items",
    "read_collection_item",
    "read_collection_readme",
    "read_page",
    "read_space_readme",
    "rename_content",
    "reorder_content",
    "reorder_spaces",
    "search_knowledge",
    "search_pages",
    "update_collection_column",
    "update_collection_item_body",
    "update_collection_item_fields",
    "update_collection_item_metadata",
    "update_collection_metadata",
    "update_collection_view",
    "update_page_metadata",
    "update_routine",
    "update_space_metadata",
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
    spawn_with(cwd, args, &[])
}

fn spawn_with(cwd: &Path, args: &[&str], env: &[(&str, &str)]) -> Child {
    Command::new(BIN)
        .args(args)
        .current_dir(cwd)
        // No desktop discovery can be reached from this process, and its
        // device-local settings are apart from the user's own.
        .env("SVODE_MCP_DISCOVERY", cwd.join("no-desktop.json"))
        .env("SVODE_PRODUCT_IDENTIFIER", "app.svode.desktop.test")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env_remove(ROUTINE_CALLER_TOKEN)
        .envs(env.iter().copied())
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
    // Responses are drained while the process runs: a large `tools/list`
    // would otherwise fill the pipe and block its exit.
    let stdout = child.stdout.take().unwrap();
    let responses = std::thread::spawn(move || {
        BufReader::new(stdout)
            .lines()
            .map(|line| serde_json::from_str::<Value>(&line.unwrap()).unwrap())
            .map(|response| (response["id"].as_u64().unwrap(), response))
            .collect::<BTreeMap<_, _>>()
    });
    let status = wait(&mut child);
    let mut stderr = String::new();
    std::io::Read::read_to_string(&mut child.stderr.take().unwrap(), &mut stderr).unwrap();
    assert!(status.success(), "{status}: {stderr}");
    responses.join().unwrap()
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
            call(
                12,
                "write_page",
                json!({ "path": "notes.md", "content": "overwritten" }),
            ),
            call(13, "run_routine", json!({})),
            call(14, "no_such_tool", json!({})),
            json!({ "jsonrpc": "2.0", "id": 15, "method": "ping" }),
            json!({ "jsonrpc": "2.0", "id": 16, "method": "resources/list" }),
        ],
    );

    assert_eq!(responses.len(), 15, "{responses:?}");
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
        Self::start_with(cwd, args, &[])
    }

    fn start_with(cwd: &Path, args: &[&str], env: &[(&str, &str)]) -> Self {
        let mut child = spawn_with(cwd, args, env);
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

#[test]
fn metadata_field_schema_and_view_changes_are_served_with_their_shared_outcome() {
    let fixture = fixture();
    if !fixture.git {
        return;
    }
    let project = &fixture.project;
    let mut live = Live::start(
        fixture.temp.path(),
        &["--project", project.to_str().unwrap()],
    );

    let page = live.ok(
        "update_page_metadata",
        json!({ "path": "notes.md", "icon": "📝", "description": null }),
    );
    assert_eq!(page["page"]["meta"]["icon"], "📝");
    assert_eq!(
        page["sourceVersion"],
        live.ok("read_page", json!({ "path": "notes.md" }))["sourceVersion"]
    );
    live.ok(
        "update_space_metadata",
        json!({ "spaceId": "child", "description": "Child" }),
    );
    live.ok(
        "update_collection_metadata",
        json!({ "collectionPath": "tasks", "icon": "✅" }),
    );

    // A field change is published into the index of this session at once.
    let fields = live.ok(
        "update_collection_item_fields",
        json!({ "path": "tasks/alpha.md", "fields": { "Status": "Done" } }),
    );
    assert_eq!(fields["changedPaths"], json!(["tasks/alpha.md"]));
    let done = json!({
        "collectionPath": "tasks",
        "filter": [{ "field": "Status", "op": "eq", "value": "Done" }]
    });
    let query = live.ok("query_collection_items", done.clone());
    assert_eq!(result_paths(&query), ["tasks/alpha.md"]);
    let checked = assert_fresh(&query);

    // A schema change is not published by the change itself: the next
    // index-backed read checks the files again, even inside the window.
    let schema = live.ok(
        "add_collection_column",
        json!({ "collectionPath": "tasks", "column": { "name": "Stage", "type": "text" } }),
    );
    assert_eq!(schema["changedPaths"], json!(["tasks/schema.yaml"]));
    let requery = live.ok("query_collection_items", done);
    assert!(assert_fresh(&requery) > checked, "{requery}");
    assert_eq!(result_paths(&requery), ["tasks/alpha.md"]);
    live.ok(
        "update_collection_column",
        json!({ "collectionPath": "tasks", "columnName": "Stage", "patch": { "color": "blue" } }),
    );
    live.ok(
        "delete_collection_column",
        json!({ "collectionPath": "tasks", "columnName": "Stage" }),
    );
    live.ok(
        "add_collection_view",
        json!({ "collectionPath": "tasks", "view": { "type": "table", "name": "Board" } }),
    );
    live.ok(
        "update_collection_view",
        json!({ "collectionPath": "tasks", "viewName": "Board", "patch": { "name": "All" } }),
    );
    let views = live.ok(
        "delete_collection_view",
        json!({ "collectionPath": "tasks", "viewName": "Table" }),
    );
    assert_eq!(views["schema"]["views"][0]["name"], "All");
    let item = live.ok(
        "update_collection_item_metadata",
        json!({ "path": "tasks/alpha.md", "title": "Beta" }),
    );
    assert_eq!(item["item"]["path"], "tasks/Beta.md");
    live.finish();
    assert_closed(project);
    assert!(
        fs::read_to_string(project.join("tasks/Beta.md"))
            .unwrap()
            .contains("Status: Done")
    );
}

#[test]
fn a_change_without_access_evidence_is_a_typed_refusal_with_the_next_step() {
    let fixture = fixture();
    if !fixture.git
        || !git(
            &fixture.project,
            &[
                "remote",
                "add",
                "origin",
                "https://example.invalid/never.git",
            ],
        )
    {
        return;
    }
    let before = snapshot(&fixture.project);
    let responses = session(
        fixture.temp.path(),
        &["--project", fixture.project.to_str().unwrap()],
        &[
            call(
                1,
                "update_collection_item_fields",
                json!({ "path": "tasks/alpha.md", "fields": { "Status": "Done" } }),
            ),
            call(
                2,
                "add_collection_column",
                json!({ "collectionPath": "tasks", "column": { "name": "Stage", "type": "text" } }),
            ),
        ],
    );
    for id in [1, 2] {
        assert_eq!(business_code(&responses[&id]), "REPOSITORY_ACCESS_DENIED");
        let error = &responses[&id]["result"]["structuredContent"]["error"];
        assert_eq!(error["status"], "unknown", "{error}");
        assert_eq!(error["reason"], "not_checked", "{error}");
        assert!(
            error["hint"]
                .as_str()
                .unwrap()
                .contains("svode git access verify"),
            "{error}"
        );
    }
    let mut after = snapshot(&fixture.project);
    after.retain(|path, _| !path.starts_with(".svode") || path.ends_with("config.json"));
    let mut expected = before;
    expected.retain(|path, _| !path.starts_with(".svode") || path.ends_with("config.json"));
    assert_eq!(after, expected);
}

#[test]
fn create_structural_reorder_and_import_changes_are_served_in_one_session() {
    let fixture = fixture();
    if !fixture.git {
        return;
    }
    let project = &fixture.project;
    let head = String::from_utf8(
        Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(project)
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    let photo = fixture.temp.path().join("photo.png");
    fs::write(&photo, "image").unwrap();
    let mut live = Live::start(
        fixture.temp.path(),
        &["--project", project.to_str().unwrap()],
    );

    // A created Page is published into the index of this session at once.
    let created = live.ok(
        "create_page",
        json!({ "parentPath": "", "title": "Weekly", "content": "Weekly body\n" }),
    );
    assert_eq!(created["path"], "Weekly.md", "{created}");
    assert!(created["sourceVersion"].is_string());
    let found = live.ok("search_pages", json!({ "query": "Weekly body" }));
    assert_eq!(result_paths(&found), ["Weekly.md"]);
    assert_fresh(&found);

    // A Page under a leaf Page makes it directory-backed; move and order
    // inside it, then turn it back into a leaf.
    let sub = live.ok(
        "create_page",
        json!({ "parentPath": "Weekly", "title": "Sub" }),
    );
    assert_eq!(sub["path"], "Weekly/Sub.md", "{sub}");
    let moved = live.ok(
        "move_content",
        json!({ "from": "notes.md", "toParent": "Weekly" }),
    );
    assert_eq!(moved["newPath"], "Weekly/notes.md", "{moved}");
    let renamed = live.ok(
        "rename_content",
        json!({ "from": "Weekly/notes.md", "to": "Weekly/Journal.md" }),
    );
    assert_eq!(renamed["newPath"], "Weekly/Journal.md", "{renamed}");
    let ordered = live.ok(
        "reorder_content",
        json!({ "parentPath": "Weekly", "orderedChildren": ["Weekly/Journal.md", "Weekly/Sub.md"] }),
    );
    assert_eq!(
        ordered["changedPaths"],
        json!([".svode/order.json"]),
        "{ordered}"
    );
    live.ok("delete_page", json!({ "path": "Weekly/Sub.md" }));
    live.ok("delete_page", json!({ "path": "Weekly/Journal.md" }));
    let leaf = live.ok(
        "convert_page_to_leaf",
        json!({ "path": "Weekly/README.md" }),
    );
    assert_eq!(leaf["newPath"], "Weekly.md", "{leaf}");

    // Collections: convert, create, delete an item and a Collection.
    let converted = live.ok("convert_to_collection", json!({ "path": "Weekly.md" }));
    assert_eq!(converted["collectionPath"], "Weekly", "{converted}");
    let backlog = live.ok(
        "create_collection",
        json!({ "parentPath": "", "title": "Backlog", "columns": [{ "name": "Owner", "type": "text" }] }),
    );
    assert_eq!(backlog["collectionPath"], "Backlog", "{backlog}");
    live.ok(
        "delete_collection_item",
        json!({ "path": "tasks/alpha.md" }),
    );
    live.ok("delete_collection", json!({ "collectionPath": "Weekly" }));
    assert!(!project.join("Weekly").exists() && !project.join("tasks/alpha.md").exists());
    let spaces = live.ok("reorder_spaces", json!({ "orderedSpaceIds": ["child"] }));
    assert_eq!(spaces["orderedSpaceIds"], json!(["child"]), "{spaces}");

    // An import into the child Space by its local routing.
    let imported = live.ok(
        "import_asset",
        json!({ "spaceId": "child", "contentPath": "brief.md", "sourcePath": photo }),
    );
    let attachment = imported["attachmentPath"].as_str().unwrap();
    assert!(
        project.join("child").join(attachment).is_file(),
        "{imported}"
    );

    // A held repository refuses with the path inside the Space.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let guard = runtime
        .block_on(svode_core::git::write_guard::acquire(
            &std::collections::BTreeSet::from([project.clone()]),
            &[],
        ))
        .unwrap();
    let busy = live.call(
        "rename_content",
        json!({ "from": "Backlog/README.md", "to": "Backlog/Moved.md" }),
    );
    assert_eq!(business_code(&busy), "SOURCE_BUSY", "{busy}");
    let path = busy["result"]["structuredContent"]["error"]["path"]
        .as_str()
        .unwrap();
    assert!(!path.starts_with('/'), "{busy}");
    drop(guard);

    live.finish();
    assert_closed(project);
    let after = String::from_utf8(
        Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(project)
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    assert_eq!(after, head, "no commit");
}

const ACTOR: &str = "01arz3ndektsv4rrffq69g5fav";

/// Fixture whose Agent Actors catalog has the executor of the Routines the
/// tests save.
fn routine_fixture() -> Option<Fixture> {
    let fixture = fixture();
    write(
        &fixture.project.join(".svode/agent-actors.json"),
        &json!({
            "schemaVersion": 1,
            "actors": [{ "id": ACTOR, "name": "Reviewer", "adapters": [{ "adapter": "codex" }] }]
        })
        .to_string(),
    );
    // The catalog is committed so HEAD and the working tree start clean.
    (fixture.git
        && git(&fixture.project, &["add", "-A"])
        && git(&fixture.project, &["commit", "-q", "-m", "actors"]))
    .then_some(fixture)
}

fn manual(name: &str) -> Value {
    json!({
        "name": name,
        "trigger": { "type": "manual" },
        "action": { "type": "run_agent", "executor": format!("agent:{ACTOR}") },
        "body": "Review the tasks."
    })
}

fn on_created(name: &str) -> Value {
    json!({
        "name": name,
        "enabled": true,
        "trigger": { "type": "event", "event": "collection.entry_created" },
        "action": { "type": "update_properties", "target": "trigger.entry", "set": { "Status": "New" } },
        "body": "Managed by Svode."
    })
}

fn head(project: &Path) -> String {
    String::from_utf8(
        Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(project)
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
}

fn routine_files(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir.join(".routines")) else {
        return Vec::new();
    };
    let mut names = entries
        .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
        .collect::<Vec<_>>();
    names.sort();
    names
}

fn sqlite<T>(db: &Path, query: impl AsyncFnOnce(&sqlx::SqlitePool) -> T) -> T {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let pool = sqlx::SqlitePool::connect(&format!("sqlite:{}?mode=rwc", db.display()))
                .await
                .unwrap();
            let value = query(&pool).await;
            pool.close().await;
            value
        })
}

fn run_rows(db: &Path) -> i64 {
    sqlite(db, async |pool| {
        sqlx::query_scalar("SELECT COUNT(*) FROM routine_runs")
            .fetch_one(pool)
            .await
            .unwrap()
    })
}

#[test]
fn routine_definitions_are_served_from_the_owner_store_of_two_sessions_without_execution() {
    let Some(fixture) = routine_fixture() else {
        return;
    };
    let project = &fixture.project;
    let head_before = head(project);
    let args = ["--project", project.to_str().unwrap()];
    let tasks = json!({ "spaceId": "root", "collectionPath": "tasks" });
    let owner = |extra: Value| {
        let mut value = tasks.clone();
        value
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        value
    };

    let mut first = Live::start(fixture.temp.path(), &args);
    // Reads of Pages open no Routine store; the first Routine operation does.
    first.ok("read_page", json!({ "path": "notes.md" }));
    assert!(!project.join(".svode/routines.db").exists());
    let empty = first.ok("list_routines", tasks.clone());
    assert_eq!(empty["total"], 0, "{empty}");
    assert_eq!(empty["owner"]["ownerPath"], "tasks", "{empty}");
    assert_eq!(empty["automaticAuthorityEnabled"], false, "{empty}");
    assert!(project.join(".svode/routines.db").is_file());

    let created = first.ok(
        "create_routine",
        owner(json!({ "definition": manual("Review") })),
    );
    let id = created["routineId"].as_str().unwrap().to_string();
    let fingerprint = created["fingerprint"].as_str().unwrap().to_string();
    assert_eq!(created["path"], "tasks/.routines/Review.md", "{created}");
    assert_eq!(routine_files(&project.join("tasks")), ["Review.md"]);
    let read = first.ok("get_routine", owner(json!({ "routineId": id })));
    assert_eq!(read["definition"]["body"], "Review the tasks.", "{read}");
    assert_eq!(read["fingerprint"], fingerprint.as_str());

    // A second process opens the same store while the first holds it.
    let mut second = Live::start(fixture.temp.path(), &args);
    let seen = second.ok("list_routines", tasks.clone());
    assert_eq!(seen["routines"][0]["routineId"], id.as_str(), "{seen}");
    let updated = second.ok(
        "update_routine",
        owner(json!({
            "routineId": id,
            "expectedFingerprint": fingerprint,
            "definition": manual("Weekly review"),
        })),
    );
    let current = updated["fingerprint"].as_str().unwrap().to_string();
    assert_ne!(current, fingerprint);
    assert_eq!(routine_files(&project.join("tasks")), ["Weekly review.md"]);

    // The first session holds the old fingerprint: compare-and-set refuses.
    let stale = first.call(
        "update_routine",
        owner(json!({
            "routineId": id,
            "expectedFingerprint": fingerprint,
            "definition": manual("Lost update"),
        })),
    );
    assert_eq!(business_code(&stale), "ROUTINE_FINGERPRINT_CONFLICT");
    assert_eq!(
        stale["result"]["structuredContent"]["error"]["currentFingerprint"],
        current.as_str()
    );
    assert_eq!(routine_files(&project.join("tasks")), ["Weekly review.md"]);

    // Enabled automation needs acknowledgement; saving it grants no device
    // authority and starts nothing.
    let unconfirmed = second.call(
        "create_routine",
        owner(json!({ "definition": on_created("On created") })),
    );
    assert_eq!(
        business_code(&unconfirmed),
        "ROUTINE_AUTOMATIC_CONFIRMATION_REQUIRED"
    );
    let automatic = second.ok(
        "create_routine",
        owner(json!({
            "definition": on_created("On created"),
            "confirmAutomaticExecution": true,
        })),
    );
    assert_eq!(
        automatic["detail"]["definition"]["enabled"], true,
        "{automatic}"
    );
    assert_eq!(
        automatic["detail"]["automaticAuthorityEnabled"], false,
        "{automatic}"
    );
    let invalid = second.call(
        "create_routine",
        owner(json!({ "definition": { "name": "Nobody", "trigger": { "type": "manual" }, "action": { "type": "run_agent", "executor": "agent:01bx5zzkbkactav9wevgemmvrz" }, "body": "x" } })),
    );
    assert_eq!(business_code(&invalid), "ROUTINE_INVALID");
    assert_eq!(
        routine_files(&project.join("tasks")),
        ["On created.md", "Weekly review.md"]
    );

    let listed = first.ok("list_routines", tasks.clone());
    assert_eq!(listed["total"], 2, "{listed}");
    let deleted = first.ok(
        "delete_routine",
        owner(json!({ "routineId": id, "expectedFingerprint": current })),
    );
    assert_eq!(deleted["routineId"], id.as_str(), "{deleted}");
    let missing = second.call("get_routine", owner(json!({ "routineId": id })));
    assert_eq!(business_code(&missing), "ROUTINE_NOT_FOUND");

    // A child Space owner keeps its own Routine files and store.
    let child = first.ok(
        "create_routine",
        json!({ "spaceId": "child", "definition": manual("Child review") }),
    );
    assert_eq!(child["owner"]["spaceId"], "child", "{child}");
    assert_eq!(routine_files(&project.join("child")), ["Child review.md"]);
    assert!(project.join("child/.svode/routines.db").is_file());

    first.finish();
    second.finish();
    assert_closed(project);
    assert_closed(&project.join("child"));
    assert_eq!(head(project), head_before, "no commit");
    assert_eq!(run_rows(&project.join(".svode/routines.db")), 0, "no run");
    let local: Value =
        serde_json::from_str(&fs::read_to_string(project.join(".svode/local.json")).unwrap())
            .unwrap();
    assert!(
        local["routines"]["automaticAuthority"]
            .as_object()
            .is_none_or(serde_json::Map::is_empty),
        "{local}"
    );
}

#[test]
fn a_process_started_from_a_routine_launch_keeps_the_routine_origin() {
    let Some(fixture) = routine_fixture() else {
        return;
    };
    let project = &fixture.project;
    let args = ["--project", project.to_str().unwrap()];
    let tasks = json!({ "spaceId": "root", "collectionPath": "tasks" });
    let mut live = Live::start_with(
        fixture.temp.path(),
        &args,
        &[(ROUTINE_CALLER_TOKEN, "opaque-token")],
    );
    let listed = live.ok("list_routines", tasks.clone());
    assert_eq!(listed["total"], 0, "{listed}");
    let mut enabled = tasks.clone();
    enabled["definition"] = on_created("Nested automation");
    enabled["confirmAutomaticExecution"] = json!(true);
    let refused = live.call("create_routine", enabled);
    assert_eq!(business_code(&refused), "ROUTINE_RECURSION_GUARD");
    assert!(routine_files(&project.join("tasks")).is_empty());
    let mut manual_args = tasks.clone();
    manual_args["definition"] = manual("Manual from a Routine");
    live.ok("create_routine", manual_args);
    assert_eq!(
        routine_files(&project.join("tasks")),
        ["Manual from a Routine.md"]
    );
    live.finish();

    // An empty token claims nothing.
    let mut live = Live::start_with(fixture.temp.path(), &args, &[(ROUTINE_CALLER_TOKEN, " ")]);
    let mut enabled = tasks.clone();
    enabled["definition"] = on_created("External automation");
    enabled["confirmAutomaticExecution"] = json!(true);
    live.ok("create_routine", enabled);
    live.finish();
}

#[test]
fn the_last_run_is_projected_from_the_store_without_a_live_status() {
    let Some(fixture) = routine_fixture() else {
        return;
    };
    let project = &fixture.project;
    let args = ["--project", project.to_str().unwrap()];
    let root = json!({ "spaceId": "root" });
    let mut live = Live::start(fixture.temp.path(), &args);
    let mut create = root.clone();
    create["definition"] = manual("Review");
    let created = live.ok("create_routine", create);
    live.finish();
    let id = created["routineId"].as_str().unwrap().to_string();

    // A run of the desktop app that never recorded a terminal outcome.
    let db = project.join(".svode/routines.db");
    sqlite(&db, async |pool| {
        sqlx::query(
            "INSERT INTO routine_runs (routine_run_id, routine_id, owner_path, trigger_type, \
             definition_fingerprint, definition_json, launch_id, pty_id, source, \
             agent_session_id, created_at, updated_at) \
             VALUES ('run-1', ?, '.', 'manual', 'f', '{}', 'launch-1', 'pty-1', 'codex', \
             'codex:pending', '2026-09-24T10:00:00Z', '2026-09-24T10:00:00Z')",
        )
        .bind(&id)
        .execute(pool)
        .await
        .unwrap();
    });

    let mut live = Live::start(fixture.temp.path(), &args);
    let listed = live.ok("list_routines", root.clone());
    let row = &listed["routines"][0];
    assert_eq!(row["lastRunAt"], "2026-09-24T10:00:00Z", "{row}");
    assert_eq!(row["lastRunOrigin"], "local", "{row}");
    let mut get = root.clone();
    get["routineId"] = json!(id);
    let detail = live.ok("get_routine", get);
    assert_eq!(detail["lastRunAt"], "2026-09-24T10:00:00Z", "{detail}");
    for value in [&listed, &detail] {
        let text = value.to_string();
        assert!(
            !text.contains("running") && !text.contains("\"active\""),
            "{text}"
        );
    }
    live.finish();
    assert_eq!(run_rows(&db), 1);
}

#[test]
fn a_corrupt_store_is_quarantined_and_an_unsupported_one_is_left_untouched() {
    let Some(fixture) = routine_fixture() else {
        return;
    };
    let project = &fixture.project;
    let args = ["--project", project.to_str().unwrap()];
    let root = json!({ "spaceId": "root" });
    let mut create = root.clone();
    create["definition"] = manual("Review");
    let mut live = Live::start(fixture.temp.path(), &args);
    live.ok("create_routine", create);
    live.finish();

    // A store this install created before, now unreadable.
    let db = project.join(".svode/routines.db");
    fs::write(&db, "not a database").unwrap();
    let mut live = Live::start(fixture.temp.path(), &args);
    let listed = live.ok("list_routines", root.clone());
    assert_eq!(listed["total"], 1, "{listed}");
    assert_eq!(listed["diagnostics"], json!([]), "{listed}");
    live.finish();
    let quarantined = fs::read_dir(project.join(".svode"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
        .filter(|name| name.starts_with("routines.db.corrupt-"))
        .collect::<Vec<_>>();
    assert_eq!(quarantined.len(), 1, "{quarantined:?}");
    assert_eq!(
        fs::read(project.join(".svode").join(&quarantined[0])).unwrap(),
        b"not a database"
    );
    let local: Value =
        serde_json::from_str(&fs::read_to_string(project.join(".svode/local.json")).unwrap())
            .unwrap();
    assert_eq!(
        local["routines"]["recovery"]["reason"], "corrupt",
        "{local}"
    );

    // A store of a newer schema is never migrated or replaced.
    fs::remove_file(&db).unwrap();
    sqlite(&db, async |pool| {
        sqlx::query("CREATE TABLE schema_version (version INTEGER NOT NULL)")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO schema_version VALUES (99)")
            .execute(pool)
            .await
            .unwrap();
    });
    let mut live = Live::start(fixture.temp.path(), &args);
    let listed = live.ok("list_routines", root.clone());
    assert_eq!(listed["total"], 1, "{listed}");
    assert_eq!(
        listed["diagnostics"][0]["code"], "routine_cache_unavailable",
        "{listed}"
    );
    assert_eq!(listed["automaticAuthorityEnabled"], Value::Null, "{listed}");
    live.finish();
    // Only the journal mode of the connection changed: no table was added
    // and the version is the one the store had.
    let (tables, version) = sqlite(&db, async |pool| {
        let tables: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'")
                .fetch_one(pool)
                .await
                .unwrap();
        let version: i64 = sqlx::query_scalar("SELECT version FROM schema_version")
            .fetch_one(pool)
            .await
            .unwrap();
        (tables, version)
    });
    assert_eq!((tables, version), (1, 99));
}

/// The whole served catalog in one session: every one of the 53 tools
/// answers from the standalone host with a result, reads first, then each
/// family of changes on the sources the reads returned.
#[test]
fn every_served_tool_answers_with_a_result_in_one_session() {
    let Some(fixture) = routine_fixture() else {
        return;
    };
    let project = &fixture.project;
    let head_before = head(project);
    let photo = fixture.temp.path().join("photo.png");
    fs::write(&photo, "image").unwrap();
    let mut live = Live::start(
        fixture.temp.path(),
        &["--project", project.to_str().unwrap()],
    );
    writeln!(
        live.stdin,
        "{}",
        json!({ "jsonrpc": "2.0", "id": 0, "method": "tools/list" })
    )
    .unwrap();
    let mut line = String::new();
    live.stdout.read_line(&mut line).unwrap();
    let mut listed = serde_json::from_str::<Value>(&line).unwrap()["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    listed.sort();
    assert_eq!(listed, SERVED);

    let mut answered = std::collections::BTreeSet::new();
    let mut ok = |live: &mut Live, name: &'static str, arguments: Value| {
        answered.insert(name);
        live.ok(name, arguments)
    };

    // Reads and guidance.
    ok(&mut live, "get_svode_guide", json!({}));
    ok(&mut live, "get_project_info", json!({}));
    ok(&mut live, "list_spaces", json!({}));
    ok(&mut live, "list_pages", json!({}));
    ok(&mut live, "list_collections", json!({}));
    ok(
        &mut live,
        "get_collection_schema",
        json!({ "collectionPath": "tasks" }),
    );
    ok(
        &mut live,
        "query_collection_items",
        json!({ "collectionPath": "tasks" }),
    );
    let notes = ok(&mut live, "read_page", json!({ "path": "notes.md" }))["sourceVersion"].clone();
    let alpha = ok(
        &mut live,
        "read_collection_item",
        json!({ "path": "tasks/alpha.md" }),
    )["sourceVersion"]
        .clone();
    let readme = ok(&mut live, "read_space_readme", json!({}))["sourceVersion"].clone();
    let tasks_readme = ok(
        &mut live,
        "read_collection_readme",
        json!({ "collectionPath": "tasks" }),
    )["sourceVersion"]
        .clone();
    ok(&mut live, "search_pages", json!({ "query": "Notes body" }));
    ok(&mut live, "search_knowledge", json!({ "query": "Notes" }));
    ok(
        &mut live,
        "get_knowledge_node",
        json!({ "nodeId": "page:root:notes.md" }),
    );
    ok(
        &mut live,
        "get_knowledge_neighbors",
        json!({ "nodeId": "page:root:notes.md" }),
    );
    ok(
        &mut live,
        "get_related_context",
        json!({ "query": "Notes" }),
    );
    ok(
        &mut live,
        "get_knowledge_status",
        json!({ "scope": "project" }),
    );
    ok(&mut live, "get_git_status", json!({}));
    ok(&mut live, "list_actors", json!({}));
    let integrity = ok(
        &mut live,
        "validate_collection_integrity",
        json!({ "collectionPath": "tasks" }),
    );
    assert_eq!(integrity["errorCount"], 0, "{integrity}");
    let manifest = ok(
        &mut live,
        "validate_app_manifest",
        json!({ "yaml": "runtime:\n  type: url\n  url: https://example.com\n" }),
    );
    assert_eq!(manifest["valid"], true, "{manifest}");

    // Body writes from the versions of the reads.
    ok(
        &mut live,
        "write_page",
        write_args("notes.md", "Rewritten notes\n", &notes),
    );
    ok(
        &mut live,
        "update_collection_item_body",
        json!({ "path": "tasks/alpha.md", "body": "Rewritten alpha\n", "sourceVersion": alpha }),
    );
    ok(
        &mut live,
        "write_space_readme",
        json!({ "content": "Rewritten owner\n", "sourceVersion": readme }),
    );
    ok(
        &mut live,
        "write_collection_readme",
        json!({ "collectionPath": "tasks", "content": "Rewritten tasks\n", "sourceVersion": tasks_readme }),
    );

    // Metadata, fields, schema columns and views.
    ok(
        &mut live,
        "update_page_metadata",
        json!({ "path": "notes.md", "icon": "📝" }),
    );
    ok(
        &mut live,
        "update_space_metadata",
        json!({ "spaceId": "child", "description": "Child" }),
    );
    ok(
        &mut live,
        "update_collection_metadata",
        json!({ "collectionPath": "tasks", "icon": "✅" }),
    );
    ok(
        &mut live,
        "update_collection_item_fields",
        json!({ "path": "tasks/alpha.md", "fields": { "Status": "Done" } }),
    );
    ok(
        &mut live,
        "update_collection_item_metadata",
        json!({ "path": "tasks/alpha.md", "description": "First task" }),
    );
    ok(
        &mut live,
        "add_collection_column",
        json!({ "collectionPath": "tasks", "column": { "name": "Stage", "type": "text" } }),
    );
    ok(
        &mut live,
        "update_collection_column",
        json!({ "collectionPath": "tasks", "columnName": "Stage", "patch": { "color": "blue" } }),
    );
    ok(
        &mut live,
        "delete_collection_column",
        json!({ "collectionPath": "tasks", "columnName": "Stage" }),
    );
    ok(
        &mut live,
        "add_collection_view",
        json!({ "collectionPath": "tasks", "view": { "type": "table", "name": "Board" } }),
    );
    ok(
        &mut live,
        "update_collection_view",
        json!({ "collectionPath": "tasks", "viewName": "Board", "patch": { "name": "All" } }),
    );
    ok(
        &mut live,
        "delete_collection_view",
        json!({ "collectionPath": "tasks", "viewName": "Table" }),
    );

    // Creation, structure, order, import and deletion.
    ok(
        &mut live,
        "create_page",
        json!({ "parentPath": "", "title": "Weekly", "content": "Weekly body\n" }),
    );
    ok(
        &mut live,
        "create_page",
        json!({ "parentPath": "Weekly", "title": "Sub" }),
    );
    ok(
        &mut live,
        "create_collection",
        json!({ "parentPath": "", "title": "Backlog", "columns": [{ "name": "Owner", "type": "text" }] }),
    );
    ok(
        &mut live,
        "rename_content",
        json!({ "from": "notes.md", "to": "Journal.md" }),
    );
    ok(
        &mut live,
        "move_content",
        json!({ "from": "Journal.md", "toParent": "Weekly" }),
    );
    ok(
        &mut live,
        "reorder_content",
        json!({ "parentPath": "Weekly", "orderedChildren": ["Weekly/Journal.md", "Weekly/Sub.md"] }),
    );
    ok(
        &mut live,
        "import_asset",
        json!({ "spaceId": "child", "contentPath": "brief.md", "sourcePath": photo }),
    );
    ok(&mut live, "delete_page", json!({ "path": "Weekly/Sub.md" }));
    ok(
        &mut live,
        "delete_page",
        json!({ "path": "Weekly/Journal.md" }),
    );
    ok(
        &mut live,
        "convert_page_to_leaf",
        json!({ "path": "Weekly/README.md" }),
    );
    ok(
        &mut live,
        "convert_to_collection",
        json!({ "path": "Weekly.md" }),
    );
    ok(
        &mut live,
        "delete_collection_item",
        json!({ "path": "tasks/alpha.md" }),
    );
    ok(
        &mut live,
        "delete_collection",
        json!({ "collectionPath": "Weekly" }),
    );
    ok(
        &mut live,
        "reorder_spaces",
        json!({ "orderedSpaceIds": ["child"] }),
    );

    // Routine definitions, without execution.
    let tasks = json!({ "spaceId": "root", "collectionPath": "tasks" });
    let with = |extra: Value| {
        let mut value = tasks.clone();
        value
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        value
    };
    ok(&mut live, "list_routines", tasks.clone());
    let created = ok(
        &mut live,
        "create_routine",
        with(json!({ "definition": manual("Review") })),
    );
    let id = created["routineId"].clone();
    ok(&mut live, "get_routine", with(json!({ "routineId": id })));
    let updated = ok(
        &mut live,
        "update_routine",
        with(json!({
            "routineId": id,
            "expectedFingerprint": created["fingerprint"],
            "definition": manual("Weekly review"),
        })),
    );
    ok(
        &mut live,
        "delete_routine",
        with(json!({ "routineId": id, "expectedFingerprint": updated["fingerprint"] })),
    );
    live.finish();

    assert_eq!(
        answered.into_iter().collect::<Vec<_>>(),
        SERVED,
        "every served tool answered"
    );
    assert_closed(project);
    assert_eq!(head(project), head_before, "no commit");
    assert_eq!(run_rows(&project.join(".svode/routines.db")), 0);
}

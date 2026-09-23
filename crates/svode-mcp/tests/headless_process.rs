//! `svode-mcp --project` as a real process with the desktop app closed: one
//! stdio session served in-process on the standalone host, the frozen
//! target, source reads that open no store and leave every byte of the
//! project unchanged, and shutdown on EOF and SIGTERM.

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
const SERVED: [&str; 12] = [
    "get_collection_schema",
    "get_project_info",
    "get_svode_guide",
    "list_collections",
    "list_pages",
    "list_spaces",
    "read_collection_item",
    "read_collection_readme",
    "read_page",
    "read_space_readme",
    "validate_app_manifest",
    "validate_collection_integrity",
];

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
        // No desktop discovery can be reached from this process.
        .env("SVODE_MCP_DISCOVERY", cwd.join("no-desktop.json"))
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
            call(11, "search_pages", json!({ "query": "Notes" })),
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

    assert_eq!(responses.len(), 16, "{responses:?}");
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

    assert_eq!(business_code(&responses[&11]), "MODE_UNAVAILABLE");
    assert_eq!(business_code(&responses[&12]), "MODE_UNAVAILABLE");
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

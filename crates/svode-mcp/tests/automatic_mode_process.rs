//! `svode-mcp` without arguments as a real process: the mode is chosen once
//! at session start. A desktop app answering the bridge serves the session
//! with the launch directory as caller context; otherwise the Project
//! containing the launch directory is served headless, and outside a
//! Project the session still starts and tool calls answer
//! `PROJECT_UNAVAILABLE`.

use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

const BIN: &str = env!("CARGO_BIN_EXE_svode-mcp");
const ROUTINE_CALLER_TOKEN: &str = "SVODE_MCP_ROUTINE_CALLER_TOKEN";
const TOKEN: &str = "desktop-token";

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

/// Project with a child Space and a plain folder, inside a directory that
/// is not a Project.
fn fixture() -> (tempfile::TempDir, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().canonicalize().unwrap().join("project");
    write(
        &project.join(".svode/config.json"),
        &json!({ "name": "Project", "spaces": [{ "id": "child", "path": "child", "repo": null }] })
            .to_string(),
    );
    write(
        &project.join("notes.md"),
        "---\ntitle: Notes\n---\nNotes body\n",
    );
    write(&project.join("docs/guide.md"), "---\ntitle: Guide\n---\n");
    write(
        &project.join("child/.svode/config.json"),
        r#"{"name":"Child"}"#,
    );
    write(&project.join("child/README.md"), "---\ntitle: Child\n---\n");
    (temp, project)
}

fn call(id: u64, name: &str, arguments: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "tools/call",
        "params": { "name": name, "arguments": arguments }
    })
}

fn method(id: u64, method: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": {} })
}

/// Runs one whole session without arguments: sends `requests`, closes
/// stdin and returns the responses by id once the process has exited.
fn session(
    cwd: &Path,
    discovery: &Path,
    env: &[(&str, &str)],
    requests: &[Value],
) -> BTreeMap<u64, Value> {
    let mut child = Command::new(BIN)
        .current_dir(cwd)
        .env("SVODE_MCP_DISCOVERY", discovery)
        .env("SVODE_PRODUCT_IDENTIFIER", "app.svode.desktop.test")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env_remove(ROUTINE_CALLER_TOKEN)
        .env_remove("SVODE_MCP_PROJECT_PATH")
        .envs(env.iter().copied())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    for request in requests {
        writeln!(stdin, "{request}").unwrap();
    }
    drop(stdin);
    let stdout = child.stdout.take().unwrap();
    let responses = std::thread::spawn(move || {
        BufReader::new(stdout)
            .lines()
            .map(|line| serde_json::from_str::<Value>(&line.unwrap()).unwrap())
            .map(|response| (response["id"].as_u64().unwrap(), response))
            .collect::<BTreeMap<_, _>>()
    });
    let deadline = Instant::now() + Duration::from_secs(20);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < deadline, "svode-mcp did not exit");
        std::thread::sleep(Duration::from_millis(20));
    };
    let mut stderr = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    assert!(status.success(), "{status}: {stderr}");
    responses.join().unwrap()
}

fn structured(response: &Value) -> &Value {
    assert_ne!(response["result"]["isError"], true, "{response}");
    &response["result"]["structuredContent"]
}

fn tool_names(response: &Value) -> Vec<&str> {
    response["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect()
}

/// Discovery file of a desktop app listening on `port`.
fn discovery(dir: &Path, port: u16) -> PathBuf {
    let path = dir.join("desktop-mcp.json");
    write(
        &path,
        &json!({
            "host": "127.0.0.1",
            "port": port,
            "token": TOKEN,
            "pid": std::process::id(),
            "version": "desktop-build",
            "bridgeProtocol": "svode-desktop-bridge-v1",
        })
        .to_string(),
    );
    path
}

/// Discovery file of a desktop app with another bridge protocol. The
/// session never reaches it, and it keeps the process off the discovery
/// file of the user's own desktop app.
fn incompatible_desktop(dir: &Path) -> PathBuf {
    let path = dir.join("incompatible-desktop.json");
    write(
        &path,
        &json!({
            "host": "127.0.0.1",
            "port": 1,
            "token": TOKEN,
            "pid": 0,
            "version": "other",
            "bridgeProtocol": "svode-desktop-bridge-v0",
        })
        .to_string(),
    );
    path
}

/// Private bridge of a running desktop app that answers `connections`
/// requests, one per connection, and then closes, recording each request.
struct FakeDesktop {
    port: u16,
    requests: Arc<Mutex<Vec<Value>>>,
    thread: JoinHandle<()>,
}

impl FakeDesktop {
    fn start(connections: usize) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&requests);
        let thread = std::thread::spawn(move || {
            for stream in listener.incoming().take(connections) {
                let mut stream = stream.unwrap();
                let mut line = String::new();
                BufReader::new(&stream).read_line(&mut line).unwrap();
                let request: Value = serde_json::from_str(&line).unwrap();
                let response = match request["method"].as_str().unwrap() {
                    "ping" => json!({ "result": { "ok": true } }),
                    "initialize" => json!({
                        "result": { "serverInfo": { "name": "svode", "version": "desktop-build" } }
                    }),
                    "tools/list" => json!({ "result": { "tools": [{ "name": "run_routine" }] } }),
                    _ => json!({
                        "toolResult": {
                            "content": [{ "type": "text", "text": "desktop" }],
                            "structuredContent": { "servedBy": "desktop" }
                        }
                    }),
                };
                recorded.lock().unwrap().push(request);
                writeln!(stream, "{response}").unwrap();
            }
        });
        Self {
            port,
            requests,
            thread,
        }
    }

    fn finish(self) -> Vec<Value> {
        self.thread.join().unwrap();
        Arc::try_unwrap(self.requests)
            .unwrap()
            .into_inner()
            .unwrap()
    }
}

#[test]
fn without_desktop_the_session_serves_the_project_of_the_launch_directory() {
    let (temp, project) = fixture();
    let no_desktop = incompatible_desktop(temp.path());
    for (cwd, space) in [
        (project.join("child"), "child"),
        (project.join("docs"), "root"),
        (project.clone(), "root"),
    ] {
        let responses = session(
            &cwd,
            &no_desktop,
            &[],
            &[
                method(1, "initialize"),
                method(2, "tools/list"),
                call(3, "get_project_info", json!({})),
                call(
                    4,
                    "read_page",
                    json!({ "path": "notes.md", "spaceId": "root" }),
                ),
            ],
        );
        assert_eq!(
            responses[&1]["result"]["serverInfo"]["version"],
            env!("CARGO_PKG_VERSION")
        );
        let tools = tool_names(&responses[&2]);
        assert_eq!(tools.len(), 53);
        assert!(!tools.contains(&"run_routine"));
        let info = structured(&responses[&3]);
        assert_eq!(info["projectPath"], project.to_str().unwrap(), "{cwd:?}");
        assert_eq!(info["activeMcpSpaceId"], space, "{cwd:?}");
        assert_eq!(structured(&responses[&4])["page"]["body"], "Notes body\n");
    }
}

#[test]
fn outside_a_project_the_session_starts_and_tool_calls_answer_project_unavailable() {
    let (temp, _project) = fixture();
    let outside = temp.path();
    let no_desktop = incompatible_desktop(outside);
    let responses = session(
        outside,
        &no_desktop,
        &[],
        &[
            method(1, "initialize"),
            method(2, "tools/list"),
            call(3, "read_page", json!({ "path": "notes.md" })),
            method(4, "ping"),
        ],
    );
    assert_eq!(responses[&1]["result"]["serverInfo"]["name"], "svode");
    assert_eq!(tool_names(&responses[&2]).len(), 53);
    let refused = &responses[&3]["result"];
    assert_eq!(refused["isError"], true, "{refused}");
    let error = &refused["structuredContent"]["error"];
    assert_eq!(error["code"], "PROJECT_UNAVAILABLE");
    assert!(
        error["hint"]
            .as_str()
            .is_some_and(|hint| hint.contains("svode-mcp --project")),
        "{error}"
    );
    assert!(responses[&4]["result"].is_object());

    // A broken Project config is reported the same way, not as a crash.
    write(&outside.join(".svode/config.json"), "{");
    let responses = session(
        outside,
        &no_desktop,
        &[],
        &[call(1, "list_pages", json!({}))],
    );
    assert_eq!(
        responses[&1]["result"]["structuredContent"]["error"]["code"],
        "INVALID_PROJECT_CONFIG"
    );
}

#[test]
fn a_stale_discovery_file_starts_the_headless_session() {
    let (temp, project) = fixture();
    let closed_port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let stale = discovery(temp.path(), closed_port);
    let responses = session(
        &project,
        &stale,
        &[],
        &[call(1, "get_project_info", json!({}))],
    );
    assert_eq!(
        structured(&responses[&1])["projectPath"],
        project.to_str().unwrap()
    );
}

#[test]
fn with_the_desktop_app_running_the_session_bridges_with_its_launch_directory() {
    let (temp, project) = fixture();
    let cwd = project.join("child");
    // ping probe, initialize, tools/list and one tool call; the desktop app
    // then quits.
    let desktop = FakeDesktop::start(4);
    let discovery = discovery(temp.path(), desktop.port);
    let responses = session(
        &cwd,
        &discovery,
        &[(ROUTINE_CALLER_TOKEN, "opaque-launch")],
        &[
            method(1, "initialize"),
            method(2, "tools/list"),
            call(3, "read_page", json!({ "path": "notes.md" })),
            call(4, "read_page", json!({ "path": "notes.md" })),
        ],
    );
    let requests = desktop.finish();

    assert_eq!(
        responses[&1]["result"]["serverInfo"]["version"],
        "desktop-build"
    );
    assert_eq!(tool_names(&responses[&2]), ["run_routine"]);
    assert_eq!(structured(&responses[&3])["servedBy"], "desktop");
    // The mode stays fixed: with the desktop app gone the call fails
    // instead of switching to the headless project.
    assert_eq!(
        responses[&4]["result"]["isError"], true,
        "{}",
        responses[&4]
    );
    assert_ne!(
        responses[&4]["result"]["structuredContent"]["page"]["body"],
        "Notes body\n"
    );

    let methods: Vec<_> = requests
        .iter()
        .map(|request| request["method"].as_str().unwrap())
        .collect();
    assert_eq!(methods, ["ping", "initialize", "tools/list", "tools/call"]);
    for request in &requests {
        assert_eq!(request["token"], TOKEN);
        assert_eq!(request["bridgeProtocol"], "svode-desktop-bridge-v1");
        let context = &request["context"];
        assert_eq!(context["callerCwd"], cwd.to_str().unwrap());
        assert_eq!(context["routineCallerToken"], "opaque-launch");
        assert!(context.get("projectPath").is_none(), "{context}");
    }
}

#[test]
fn help_names_the_automatic_mode_next_to_the_explicit_ones() {
    let output = Command::new(BIN).arg("--help").output().unwrap();
    assert!(output.status.success());
    let usage = String::from_utf8(output.stdout).unwrap();
    for line in [
        "  svode-mcp\n      Automatic mode",
        "  svode-mcp --app desktop\n",
        "  svode-mcp --project <path> [--space <root|space-id>]\n",
    ] {
        assert!(usage.contains(line), "{usage}");
    }
}

//! Diagnostic log of `svode-mcp --project` as a real process with the
//! desktop app closed: `tracing` events of the libraries reach stderr
//! without ANSI escapes, `info` and above by default and what `RUST_LOG`
//! selects otherwise, while every stdout line stays a JSON-RPC message.

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

const BIN: &str = env!("CARGO_BIN_EXE_svode-mcp");
/// Caller token a Routine launch of the desktop app passes to its processes.
const ROUTINE_CALLER_TOKEN: &str = "SVODE_MCP_ROUTINE_CALLER_TOKEN";
const ORDER_WARNING: &str = "cannot be read, using default order";

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn git(root: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(root)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?}");
}

/// Committed project whose root page order file holds Git conflict markers.
fn fixture() -> (tempfile::TempDir, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap().join("project");
    write(&root.join(".svode/config.json"), r#"{"name":"Project"}"#);
    write(&root.join("README.md"), "---\ntitle: Project\n---\n");
    write(&root.join("notes.md"), "---\ntitle: Notes\n---\nBody\n");
    write(
        &root.join(".svode/order.json"),
        "<<<<<<< HEAD\n{\"\":[\"notes.md\"]}\n=======\n{}\n>>>>>>> other\n",
    );
    git(&root, &["init", "-q"]);
    git(&root, &["config", "user.email", "agent@example.com"]);
    git(&root, &["config", "user.name", "Agent"]);
    git(&root, &["config", "maintenance.auto", "false"]);
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-q", "-m", "fixture"]);
    (temp, root)
}

/// Runs one headless session that creates a Page and returns its stdout
/// lines and stderr once the process has exited.
fn session(cwd: &Path, project: &Path, rust_log: Option<&str>) -> (Vec<String>, String) {
    let mut command = Command::new(BIN);
    command
        .args(["--project", project.to_str().unwrap()])
        .current_dir(cwd)
        .env("SVODE_MCP_DISCOVERY", cwd.join("no-desktop.json"))
        .env("SVODE_PRODUCT_IDENTIFIER", "app.svode.desktop.test")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env_remove(ROUTINE_CALLER_TOKEN)
        .env_remove("NO_COLOR")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    match rust_log {
        Some(directives) => command.env("RUST_LOG", directives),
        None => command.env_remove("RUST_LOG"),
    };
    let mut child = command.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    for request in [
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }),
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
        json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "create_page",
                "arguments": { "parentPath": "", "title": "Logged" }
            }
        }),
    ] {
        writeln!(stdin, "{request}").unwrap();
    }
    drop(stdin);
    let stdout = child.stdout.take().unwrap();
    let stdout = std::thread::spawn(move || {
        BufReader::new(stdout)
            .lines()
            .map(Result::unwrap)
            .collect::<Vec<_>>()
    });
    let mut stderr = child.stderr.take().unwrap();
    let stderr = std::thread::spawn(move || {
        let mut text = String::new();
        stderr.read_to_string(&mut text).unwrap();
        text
    });
    let deadline = Instant::now() + Duration::from_secs(20);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < deadline, "svode-mcp did not exit");
        std::thread::sleep(Duration::from_millis(20));
    };
    let stderr = stderr.join().unwrap();
    assert!(status.success(), "{status}: {stderr}");
    (stdout.join().unwrap(), stderr)
}

/// Asserts that every stdout line is a JSON-RPC response and that the Page
/// was created.
fn assert_protocol(lines: &[String]) {
    assert_eq!(lines.len(), 2, "{lines:?}");
    for line in lines {
        let message: Value = serde_json::from_str(line).unwrap();
        assert_eq!(message["jsonrpc"], "2.0", "{line}");
    }
    let created: Value = serde_json::from_str(&lines[1]).unwrap();
    assert_eq!(created["id"], 2, "{created}");
    assert_ne!(created["result"]["isError"], true, "{created}");
    assert_eq!(
        created["result"]["structuredContent"]["path"], "Logged.md",
        "{created}"
    );
}

#[test]
fn library_events_reach_stderr_at_info_and_stdout_keeps_the_protocol() {
    let (temp, project) = fixture();
    let (stdout, stderr) = session(temp.path(), &project, None);
    assert_protocol(&stdout);
    assert!(
        stderr
            .lines()
            .any(|line| line.contains("WARN svode_core::content_tree:")
                && line.contains(ORDER_WARNING)),
        "{stderr}"
    );
    assert!(
        stderr.contains("INFO svode_core::git::cli: Found git at"),
        "{stderr}"
    );
    assert!(!stderr.contains("DEBUG"), "{stderr}");
    assert!(!stderr.contains('\u{1b}'), "{stderr}");
}

#[test]
fn rust_log_replaces_the_default_level() {
    let (temp, project) = fixture();
    let (stdout, stderr) = session(temp.path(), &project, Some("svode_core=debug"));
    assert_protocol(&stdout);
    assert!(stderr.contains("DEBUG svode_core"), "{stderr}");
    assert!(stderr.contains(ORDER_WARNING), "{stderr}");
}

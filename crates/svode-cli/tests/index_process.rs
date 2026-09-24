//! Index-backed reads through the real `svode` binary with the desktop app
//! closed: every command checks the index of its Spaces against the files
//! before answering (a cold index is built, an unreadable one moved aside),
//! reports that check in `index`, and never answers an index it could not
//! prepare with an empty result. Git status and actors read Git directly.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::Duration;

use serde_json::Value;

const BIN: &str = env!("CARGO_BIN_EXE_svode");

fn svode(cwd: &Path, args: &[&str]) -> Output {
    Command::new(BIN)
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap()
}

/// Runs a JSON command and returns (exit code, the single stdout object).
fn json(cwd: &Path, args: &[&str]) -> (i32, Value) {
    let mut args = args.to_vec();
    args.push("--json");
    let output = svode(cwd, &args);
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert_eq!(
        stdout.lines().count(),
        1,
        "{args:?}: one JSON line: {stdout}"
    );
    (
        output.status.code().unwrap(),
        serde_json::from_str(&stdout).unwrap(),
    )
}

/// A successful JSON command.
fn ok(cwd: &Path, args: &[&str]) -> Value {
    let (exit, value) = json(cwd, args);
    assert_eq!(exit, 0, "{args:?}: {value}");
    value
}

fn has_git() -> bool {
    Command::new("git").arg("--version").output().is_ok()
}

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(output.status.success(), "git {args:?}");
    String::from_utf8(output.stdout).unwrap()
}

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn paths(value: &Value, key: &str) -> Vec<String> {
    let mut paths = value[key]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["path"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

/// The index of a read that its own check prepared.
fn assert_fresh(value: &Value) {
    let index = &value["index"];
    assert_eq!(index["status"], "fresh", "{value}");
    assert!(index["verifiedAt"].is_string(), "{value}");
    assert_eq!(index["diagnostics"], Value::Array(Vec::new()), "{value}");
}

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
}

fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap().join("project");
    write(
        &root.join(".svode/config.json"),
        r#"{"name":"Project","spaces":[{"id":"child","path":"child","repo":null}]}"#,
    );
    write(&root.join("README.md"), "---\ntitle: Project\n---\n");
    write(
        &root.join("notes/needle.md"),
        "---\ntitle: Needle\n---\nHaystack needle body, see [other](other.md)\n",
    );
    write(
        &root.join("notes/other.md"),
        "---\ntitle: Other\n---\nOther body\n",
    );
    write(
        &root.join("tasks/schema.yaml"),
        "columns:\n  - name: Status\n    type: text\nviews:\n  - type: table\n    name: Table\n",
    );
    write(&root.join("tasks/README.md"), "---\ntitle: Tasks\n---\n");
    write(
        &root.join("tasks/alpha.md"),
        "---\ntitle: Alpha\nStatus: Todo\n---\nAlpha body\n",
    );
    write(
        &root.join("child/.svode/config.json"),
        r#"{"name":"Child"}"#,
    );
    write(&root.join("child/README.md"), "---\ntitle: Child\n---\n");
    write(
        &root.join("child/inner.md"),
        "---\ntitle: Inner\n---\nInner needle\n",
    );
    if has_git() {
        git(&root, &["init", "-q"]);
        git(&root, &["config", "user.email", "agent@example.com"]);
        git(&root, &["config", "user.name", "Agent"]);
        git(&root, &["config", "maintenance.auto", "false"]);
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-q", "-m", "fixture"]);
    }
    Fixture { _temp: temp, root }
}

/// No SQLite write-ahead log is left behind: every pool of the finished
/// process was closed.
fn assert_closed(space: &Path) {
    for name in ["index.db-wal", "routines.db-wal"] {
        assert!(
            !space.join(".svode").join(name).exists(),
            "{name} left open in {}",
            space.display()
        );
    }
}

#[test]
fn a_cold_index_is_built_and_each_command_sees_external_edits() {
    let fixture = fixture();
    let root = &fixture.root;
    let head = has_git().then(|| git(root, &["rev-parse", "HEAD"]));
    assert!(!root.join(".svode/index.db").exists());

    // Cold project: the first command builds the index before answering.
    let search = ok(root, &["search", "needle"]);
    assert_fresh(&search);
    assert_eq!(paths(&search, "items"), ["notes/needle.md"]);
    assert!(root.join(".svode/index.db").is_file());
    assert_closed(root);

    let query = ok(root, &["collection", "query", "--collection", "tasks"]);
    assert_fresh(&query);
    assert_eq!(query["items"][0]["meta"]["title"], "Alpha");

    // External edits between two commands are visible to the next one,
    // answered from the warm index.
    write(
        &root.join("notes/second.md"),
        "---\ntitle: Second\n---\nAnother needle\n",
    );
    fs::remove_file(root.join("notes/needle.md")).unwrap();
    write(
        &root.join("tasks/alpha.md"),
        "---\ntitle: Alpha\nStatus: Done\n---\nAlpha body\n",
    );
    let search = ok(root, &["search", "needle"]);
    assert_fresh(&search);
    assert_eq!(paths(&search, "items"), ["notes/second.md"]);
    let filter = root.join("filter.json");
    write(&filter, r#"[{"field":"Status","op":"eq","value":"Done"}]"#);
    let done = ok(
        root,
        &[
            "collection",
            "query",
            "--collection",
            "tasks",
            "--filter-file",
            filter.to_str().unwrap(),
        ],
    );
    assert_eq!(done["items"].as_array().unwrap().len(), 1);

    // A child Space has its own index, built by its first read.
    let child = ok(root, &["--space", "child", "search", "needle"]);
    assert_fresh(&child);
    assert_eq!(paths(&child, "items"), ["inner.md"]);
    assert!(root.join("child/.svode/index.db").is_file());
    let from_child = ok(&root.join("child"), &["search", "inner"]);
    assert_eq!(from_child["target"]["spaceId"], "child");
    assert_eq!(paths(&from_child, "items"), ["inner.md"]);
    assert_closed(&root.join("child"));

    // Knowledge reads over the same prepared pools.
    let status = ok(root, &["knowledge", "status", "--scope", "project"]);
    assert_fresh(&status);
    assert_eq!(status["counts"]["readablePools"], 2);
    let found = ok(root, &["knowledge", "search", "Second"]);
    assert_fresh(&found);
    assert_eq!(found["items"][0]["nodeId"], "page:root:notes/second.md");
    let node = ok(
        root,
        &["knowledge", "node", "--id", "page:root:notes/other.md"],
    );
    assert_fresh(&node);
    assert_eq!(node["node"]["title"], "Other");
    let neighbors = ok(
        root,
        &["knowledge", "neighbors", "--id", "page:root:notes/other.md"],
    );
    assert_fresh(&neighbors);
    let context = ok(root, &["knowledge", "context", "needle"]);
    assert_fresh(&context);
    assert!(!context["context"].as_array().unwrap().is_empty());

    if let Some(head) = head {
        // Git reads and actors run on the process Git runtime; no read
        // commits, fetches or changes the history.
        let status = ok(root, &["git", "status"]);
        assert!(status["status"].is_object(), "{status}");
        let actors = ok(root, &["actor", "list"]);
        assert_eq!(actors["actors"][0]["email"], "agent@example.com");
        assert_eq!(git(root, &["rev-parse", "HEAD"]), head);
    }
    assert_closed(root);
}

#[test]
fn an_unreadable_index_is_moved_aside_and_rebuilt() {
    let fixture = fixture();
    let root = &fixture.root;
    write(&root.join(".svode/index.db"), "this is not an index");

    let search = ok(root, &["search", "needle"]);
    assert_fresh(&search);
    assert_eq!(paths(&search, "items"), ["notes/needle.md"]);
    let quarantined = fs::read_dir(root.join(".svode"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
        .filter(|name| name.starts_with("index.db.corrupt-"))
        .collect::<Vec<_>>();
    assert_eq!(quarantined.len(), 1, "{quarantined:?}");
    assert_eq!(
        fs::read_to_string(root.join(".svode").join(&quarantined[0])).unwrap(),
        "this is not an index"
    );
}

#[test]
fn an_index_that_cannot_be_prepared_is_unavailable_not_empty() {
    let fixture = fixture();
    let root = &fixture.root;
    // The index location is taken by a directory, so no pool can open.
    fs::create_dir_all(root.join(".svode/index.db")).unwrap();

    for args in [
        vec!["search", "needle"],
        vec!["collection", "query", "--collection", "tasks"],
        vec!["knowledge", "status"],
        vec!["knowledge", "search", "needle"],
    ] {
        let (exit, value) = json(root, &args);
        assert_eq!(exit, 1, "{args:?}: {value}");
        assert_eq!(value["error"]["code"], "INDEX_UNAVAILABLE", "{args:?}");
        let diagnostic = &value["error"]["diagnostics"][0];
        assert_eq!(diagnostic["code"], "index_unavailable", "{value}");
        assert_eq!(diagnostic["spaceId"], Value::Null, "{value}");
        let human = svode(root, &args);
        assert!(human.stdout.is_empty(), "{args:?}");
        assert!(
            String::from_utf8(human.stderr)
                .unwrap()
                .contains("INDEX_UNAVAILABLE")
        );
    }
    // The child Space keeps its own index and still answers.
    let child = ok(root, &["--space", "child", "search", "needle"]);
    assert_eq!(paths(&child, "items"), ["inner.md"]);
}

#[cfg(unix)]
#[test]
fn a_partial_scan_is_reported_and_keeps_earlier_rows() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = fixture();
    let root = &fixture.root;
    write(
        &root.join("locked/hidden.md"),
        "---\ntitle: Hidden\n---\nLocked needle\n",
    );
    let search = ok(root, &["search", "needle"]);
    assert_eq!(
        paths(&search, "items"),
        ["locked/hidden.md", "notes/needle.md"]
    );

    let locked = root.join("locked");
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    if fs::read_dir(&locked).is_ok() {
        // A privileged user reads the directory anyway.
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        return;
    }
    let search = ok(root, &["search", "needle"]);
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(search["index"]["status"], "partial", "{search}");
    assert_eq!(search["index"]["diagnostics"][0]["code"], "scan_incomplete");
    assert_eq!(
        paths(&search, "items"),
        ["locked/hidden.md", "notes/needle.md"]
    );

    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    let human = svode(root, &["search", "needle"]);
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(human.status.code(), Some(0));
    assert!(
        String::from_utf8(human.stderr)
            .unwrap()
            .contains("index partial:")
    );

    // Once the directory is readable again the next check is complete.
    assert_fresh(&ok(root, &["search", "needle"]));
}

#[cfg(unix)]
#[test]
fn a_signal_during_an_index_build_closes_the_pools() {
    let fixture = fixture();
    let root = &fixture.root;
    for index in 0..1500 {
        write(
            &root.join(format!("bulk/page-{index}.md")),
            &format!("---\ntitle: Page {index}\n---\nBulk body {index} with [link](page-0.md)\n"),
        );
    }
    let mut child = Command::new(BIN)
        .args(["search", "needle", "--json"])
        .current_dir(root)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    // Signal once the command is building the index.
    let started = std::time::Instant::now();
    while !root.join(".svode/index.db").exists() && started.elapsed() < Duration::from_secs(20) {
        std::thread::sleep(Duration::from_millis(5));
    }
    let killed = Command::new("kill")
        .args(["-TERM", &child.id().to_string()])
        .status()
        .unwrap();
    assert!(killed.success());
    let status = child.wait().unwrap();
    // The command either finished first or ended on the signal; both
    // closed what they opened.
    assert!(matches!(status.code(), Some(0) | Some(143)), "{status}");
    assert_closed(root);

    let search = ok(root, &["search", "needle"]);
    assert_fresh(&search);
    assert_eq!(paths(&search, "items"), ["notes/needle.md"]);
}

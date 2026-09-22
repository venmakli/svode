//! Acceptance of the common frame and read families through the real
//! `svode` binary with the desktop app closed. Source reads run standalone;
//! index-backed reads answer `MODE_UNAVAILABLE` until the headless runtime
//! is connected.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

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

fn with_stdin(cwd: &Path, args: &[&str], stdin: &str) -> (i32, Value) {
    let mut child = Command::new(BIN)
        .args(args)
        .arg("--json")
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    (
        output.status.code().unwrap(),
        serde_json::from_slice(&output.stdout).unwrap(),
    )
}

fn code(value: &Value) -> &str {
    assert_eq!(value["ok"], false, "{value}");
    value["error"]["code"].as_str().unwrap()
}

fn has_git() -> bool {
    Command::new("git").arg("--version").output().is_ok()
}

fn git(root: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?}");
}

/// Every file under `root` with its bytes, to prove reads change nothing.
fn snapshot(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn walk(dir: &Path, root: &Path, files: &mut BTreeMap<PathBuf, Vec<u8>>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            let meta = fs::symlink_metadata(&path).unwrap();
            let key = path.strip_prefix(root).unwrap().to_path_buf();
            if meta.is_dir() {
                files.insert(key, Vec::new());
                walk(&path, root, files);
            } else if meta.is_file() {
                files.insert(key, fs::read(&path).unwrap());
            } else {
                files.insert(key, Vec::new());
            }
        }
    }
    let mut files = BTreeMap::new();
    walk(root, root, &mut files);
    files
}

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

struct Fixture {
    _temp: tempfile::TempDir,
    /// Canonical Project directory.
    root: PathBuf,
    /// Directory outside any Project.
    elsewhere: PathBuf,
}

fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    let root = base.join("project");
    write(
        &root.join(".svode/config.json"),
        r#"{"name":"Project","spaces":[{"id":"child","path":"child","repo":null},{"id":"gone","path":"gone","repo":"https://example.invalid/gone.git"}]}"#,
    );
    write(
        &root.join("README.md"),
        "---\ntitle: Project\n---\nRoot owner\n",
    );
    write(
        &root.join("notes/valid.md"),
        "---\ntitle: Valid\n---\nBody\n",
    );
    write(&root.join("notes/other.md"), "Other");
    write(&root.join("folder/README.md"), "Folder body");
    write(
        &root.join("tasks/schema.yaml"),
        "columns:\n  - name: Status\n    type: text\nviews:\n  - type: table\n    name: Table\n",
    );
    write(
        &root.join("tasks/README.md"),
        "---\ntitle: Tasks\n---\nTasks owner\n",
    );
    write(
        &root.join("tasks/alpha.md"),
        "---\ntitle: Alpha\nStatus: Todo\n---\nAlpha body\n",
    );
    write(
        &root.join("child/.svode/config.json"),
        r#"{"name":"Child"}"#,
    );
    write(
        &root.join("child/README.md"),
        "---\ntitle: Child\n---\nChild owner\n",
    );
    write(&root.join("child/note.md"), "Child body");
    write(&root.join("child/deep/.keep"), "");
    let elsewhere = base.join("elsewhere");
    fs::create_dir_all(&elsewhere).unwrap();
    Fixture {
        _temp: temp,
        root,
        elsewhere,
    }
}

fn root_str(fixture: &Fixture) -> &str {
    fixture.root.to_str().unwrap()
}

#[test]
fn target_falls_back_to_the_current_directory_and_explicit_selectors_win() {
    let fixture = fixture();
    let root = &fixture.root;
    let child = root.join("child");

    let (exit, value) = json(
        &root.join("notes"),
        &["page", "read", "--path", "notes/valid.md"],
    );
    assert_eq!(exit, 0, "{value}");
    assert_eq!(value["target"]["projectPath"], root_str(&fixture));
    assert_eq!(value["target"]["spaceId"], "root");
    assert_eq!(value["page"]["body"], "Body\n");

    // Inside a ready child Space the Project stays the parent and the child
    // Space is the default target of every command.
    let deep = child.join("deep");
    let (_, value) = json(&deep, &["page", "read", "--path", "note.md"]);
    assert_eq!(value["target"]["projectPath"], root_str(&fixture));
    assert_eq!(value["target"]["spaceId"], "child");
    assert_eq!(value["target"]["spacePath"], child.to_str().unwrap());
    let (_, listing) = json(&deep, &["page", "list"]);
    assert_eq!(listing["target"]["spaceId"], "child");
    let (_, info) = json(&deep, &["project", "info"]);
    assert_eq!(info["activeMcpSpaceId"], "child");

    let (_, value) = json(&deep, &["--space", "root", "page", "list"]);
    assert_eq!(value["target"]["spaceId"], "root");
    let (_, value) = json(
        &fixture.elsewhere,
        &["--project", "../project", "space", "readme", "read"],
    );
    assert_eq!(value["target"]["spaceId"], "root");
    assert_eq!(value["spaceReadme"]["body"], "Root owner\n");
    let (_, value) = json(
        &deep,
        &["--project", root_str(&fixture), "space", "readme", "read"],
    );
    assert_eq!(value["target"]["spaceId"], "child");
    assert_eq!(value["spaceReadme"]["body"], "Child owner\n");

    let (exit, value) = json(&fixture.elsewhere, &["page", "list"]);
    assert_eq!(exit, 1);
    assert_eq!(code(&value), "PROJECT_UNAVAILABLE");
    assert_eq!(value["error"]["target"], serde_json::json!({}));
    let (_, value) = json(&fixture.elsewhere, &["--space", "child", "page", "list"]);
    assert_eq!(
        value["error"]["target"],
        serde_json::json!({ "spaceId": "child" })
    );

    for space in ["gone", "unknown"] {
        let (exit, value) = json(root, &["--space", space, "page", "list"]);
        assert_eq!(exit, 1);
        assert_eq!(code(&value), "SPACE_UNAVAILABLE");
        assert_eq!(value["error"]["target"]["projectPath"], root_str(&fixture));
        assert!(value["error"]["target"].get("spacePath").is_none());
    }

    let broken = fixture.elsewhere.join("broken");
    write(&broken.join(".svode/config.json"), "{");
    write(&broken.join("inner/.keep"), "");
    let (exit, value) = json(&broken.join("inner"), &["space", "list"]);
    assert_eq!(exit, 1);
    assert_eq!(code(&value), "INVALID_PROJECT_CONFIG");
    assert_eq!(
        fs::read_to_string(broken.join(".svode/config.json")).unwrap(),
        "{"
    );
}

#[test]
fn source_reads_follow_the_shared_mapping_and_change_nothing() {
    let fixture = fixture();
    let root = &fixture.root;
    if has_git() {
        git(root, &["init", "-q"]);
        git(root, &["config", "user.email", "agent@example.com"]);
        git(root, &["config", "user.name", "Agent"]);
        git(root, &["add", "-A"]);
        git(root, &["commit", "-q", "-m", "fixture"]);
    }
    let before = snapshot(root);

    let (_, info) = json(root, &["project", "info"]);
    assert_eq!(info["projectName"], "Project");
    assert_eq!(info["rootSpaceId"], "root");
    let (_, spaces) = json(root, &["space", "list"]);
    let statuses = spaces["spaces"]
        .as_array()
        .unwrap()
        .iter()
        .map(|space| {
            (
                space["id"].as_str().unwrap().to_string(),
                space["status"].as_str().unwrap().to_string(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        statuses,
        [
            ("root".to_string(), "ready".to_string()),
            ("child".to_string(), "ready".to_string()),
            ("gone".to_string(), "missing".to_string()),
        ]
    );
    // Repository access state needs the device runtime of phase 5.
    assert_eq!(spaces["spaces"][0]["repositoryAccess"], Value::Null);
    assert_eq!(
        spaces["spaces"][0]["repositoryAccessDiagnostic"]["code"],
        "MODE_UNAVAILABLE"
    );

    let (_, pages) = json(root, &["page", "list", "--path", "notes", "--limit", "500"]);
    assert_eq!(pages["limit"], 200);
    assert_eq!(pages["offset"], 0);
    assert_eq!(pages["total"], 1);
    assert_eq!(pages["items"][0]["path"], "notes");
    let (_, window) = json(root, &["page", "list", "--limit", "1", "--offset", "1"]);
    assert_eq!(window["limit"], 1);
    assert_eq!(window["offset"], 1);
    assert_eq!(window["items"].as_array().unwrap().len(), 1);
    assert!(window["total"].as_u64().unwrap() > 2);

    let (_, collections) = json(root, &["collection", "list"]);
    assert_eq!(collections["collections"][0]["path"], "tasks");
    let (_, schema) = json(root, &["collection", "schema", "--collection", "tasks"]);
    assert_eq!(schema["collectionPath"], "tasks");
    assert_eq!(schema["schema"]["columns"][0]["name"], "Status");
    assert_eq!(schema["target"]["collection"], "tasks");
    let (_, readme) = json(
        root,
        &["collection", "readme", "read", "--collection", "tasks"],
    );
    assert_eq!(readme["collectionReadme"]["body"], "Tasks owner\n");
    let (_, item) = json(root, &["item", "read", "--path", "tasks/alpha.md"]);
    assert_eq!(item["item"]["meta"]["title"], "Alpha");
    assert_eq!(item["target"]["path"], "tasks/alpha.md");

    // Owner distinctions and path policy of the shared mapping.
    for (args, expected) in [
        (
            vec!["item", "read", "--path", "notes/valid.md"],
            "NOT_A_COLLECTION_ITEM",
        ),
        (vec!["item", "read", "--path", "../x.md"], "INVALID_PATH"),
        (
            vec!["item", "read", "--path", ".svode/x.md"],
            "PATH_FORBIDDEN",
        ),
        (
            vec!["collection", "readme", "read", "--collection", "notes"],
            "CONTENT_OWNER_MISMATCH",
        ),
        (vec!["page", "list", "--path", "../outside"], "INVALID_PATH"),
    ] {
        let (exit, value) = json(root, &args);
        assert_eq!(exit, 1, "{args:?}: {value}");
        assert_eq!(code(&value), expected, "{args:?}");
        assert_eq!(value["error"]["target"]["projectPath"], root_str(&fixture));
    }

    let human = svode(root, &["item", "read", "--path", "tasks/alpha.md"]);
    assert_eq!(human.status.code(), Some(0));
    assert_eq!(
        String::from_utf8(human.stdout).unwrap(),
        "tasks/alpha.md\n\nAlpha body\n"
    );
    let human = svode(root, &["collection", "list"]);
    assert_eq!(String::from_utf8(human.stdout).unwrap(), "tasks\tTasks\n");

    assert_eq!(snapshot(root), before);
    assert!(!root.join(".svode/index.db").exists());
    assert!(!root.join(".svode/routines.db").exists());
}

#[test]
fn index_backed_commands_are_mode_unavailable_and_run_nothing() {
    let fixture = fixture();
    let root = &fixture.root;
    let before = snapshot(root);
    for args in [
        vec!["collection", "query", "--collection", "tasks"],
        vec!["actor", "list"],
        vec!["search", "Body"],
        vec!["knowledge", "search", "Body"],
        vec!["knowledge", "node", "--id", "page:root:notes/valid.md"],
        vec!["knowledge", "neighbors", "--id", "page:root:notes/valid.md"],
        vec!["knowledge", "context", "Body"],
        vec!["knowledge", "status"],
        vec!["git", "status"],
    ] {
        let (exit, value) = json(root, &args);
        assert_eq!(exit, 1, "{args:?}");
        assert_eq!(code(&value), "MODE_UNAVAILABLE", "{args:?}");
        assert_eq!(value["error"]["target"]["spaceId"], "root", "{args:?}");
        let human = svode(root, &args);
        assert!(human.stdout.is_empty(), "{args:?}");
        let stderr = String::from_utf8(human.stderr).unwrap();
        assert!(stderr.contains("MODE_UNAVAILABLE"), "{args:?}");
    }
    assert_eq!(snapshot(root), before);
}

#[test]
fn structured_input_comes_from_a_file_or_one_stdin() {
    let fixture = fixture();
    let root = &fixture.root;
    write(
        &root.join("filter.json"),
        r#"[{"field":"Status","op":"eq","value":"Todo"}]"#,
    );
    write(&root.join("bad.json"), "{");
    let query = ["collection", "query", "--collection", "tasks"];
    let with = |extra: &[&'static str]| {
        let mut args = query.to_vec();
        args.extend_from_slice(extra);
        args
    };

    // Readable input passes on to the command, which needs phase 5.
    let (exit, value) = json(root, &with(&["--filter-file", "filter.json"]));
    assert_eq!((exit, code(&value)), (1, "MODE_UNAVAILABLE"));
    let (exit, value) = with_stdin(root, &with(&["--filter-file", "-"]), "[]");
    assert_eq!((exit, code(&value)), (1, "MODE_UNAVAILABLE"));

    for (args, expected) in [
        (with(&["--filter-file", "missing.json"]), "INPUT_UNREADABLE"),
        (with(&["--filter-file", "bad.json"]), "INVALID_ARGUMENT"),
        (
            with(&["--filter-file", "-", "--sort-file", "-"]),
            "INVALID_ARGUMENT",
        ),
    ] {
        let (exit, value) = json(root, &args);
        assert_eq!(exit, 2, "{args:?}: {value}");
        assert_eq!(code(&value), expected, "{args:?}");
    }
    let (exit, value) = with_stdin(root, &with(&["--sort-file", "-"]), "not json");
    assert_eq!((exit, code(&value)), (2, "INVALID_ARGUMENT"));
}

#[test]
fn doctor_reports_project_spaces_git_and_runtime_without_opening_stores() {
    let fixture = fixture();
    let root = &fixture.root;
    write(&root.join("child/.svode/index.db"), "not opened");
    let before = snapshot(root);

    let (exit, value) = json(&root.join("child/deep"), &["doctor"]);
    assert_eq!(exit, 0, "{value}");
    let doctor = &value["doctor"];
    assert_eq!(doctor["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(doctor["project"]["ok"], true);
    assert_eq!(value["target"]["spaceId"], "child");
    let spaces = doctor["spaces"].as_array().unwrap();
    assert_eq!(spaces.len(), 3);
    assert_eq!(spaces[0]["index"]["present"], false);
    assert_eq!(spaces[1]["index"]["present"], true);
    assert_eq!(spaces[2]["status"], "missing");
    assert_eq!(
        spaces[0]["repositoryAccessDiagnostic"]["code"],
        "MODE_UNAVAILABLE"
    );
    assert_eq!(doctor["git"]["available"], has_git());
    let served = doctor["runtime"]["servedTools"].as_array().unwrap();
    assert!(served.contains(&Value::from("list_pages")));
    assert!(!served.contains(&Value::from("query_collection_items")));
    assert_eq!(snapshot(root), before);

    // Target failures are part of the report, not a failed command.
    let (exit, value) = json(&fixture.elsewhere, &["doctor"]);
    assert_eq!(exit, 0);
    assert_eq!(value["ok"], true);
    assert_eq!(
        value["doctor"]["project"]["error"]["code"],
        "PROJECT_UNAVAILABLE"
    );
    let broken = fixture.elsewhere.join("broken");
    write(&broken.join(".svode/config.json"), "{");
    let (exit, value) = json(&fixture.elsewhere, &["doctor", "--project", "broken"]);
    assert_eq!(exit, 0);
    assert_eq!(
        value["doctor"]["project"]["error"]["code"],
        "INVALID_PROJECT_CONFIG"
    );
    assert_eq!(value["target"]["projectPath"], broken.to_str().unwrap());
    assert!(!broken.join(".svode/index.db").exists());
}

#[test]
fn guide_prints_the_shared_guide_and_files_first_rules_without_a_project() {
    let fixture = fixture();
    let (exit, value) = json(&fixture.elsewhere, &["guide"]);
    assert_eq!(exit, 0);
    assert!(value["guide"].as_str().unwrap().contains("Space targeting"));
    assert!(value["filesFirst"].as_str().unwrap().contains(".svode"));
    let human = svode(&fixture.elsewhere, &["guide"]);
    let text = String::from_utf8(human.stdout).unwrap();
    assert!(text.starts_with("Files-first rules"));
    assert!(text.contains("Space targeting"));
}

#[test]
fn help_of_every_command_works_without_a_project_or_runtime() {
    let temp = tempfile::tempdir().unwrap();
    let headless = [
        vec!["collection", "query"],
        vec!["actor", "list"],
        vec!["search"],
        vec!["knowledge", "search"],
        vec!["knowledge", "node"],
        vec!["knowledge", "neighbors"],
        vec!["knowledge", "context"],
        vec!["knowledge", "status"],
        vec!["git", "status"],
    ];
    let source = [
        vec!["project", "info"],
        vec!["space", "list"],
        vec!["space", "readme", "read"],
        vec!["page", "read"],
        vec!["page", "list"],
        vec!["collection", "list"],
        vec!["collection", "schema"],
        vec!["collection", "readme", "read"],
        vec!["item", "read"],
        vec!["guide"],
        vec!["doctor"],
    ];
    for (command, needs_runtime) in headless
        .iter()
        .map(|command| (command, true))
        .chain(source.iter().map(|command| (command, false)))
    {
        let mut args = vec!["--project", "/definitely/missing"];
        args.extend(command.iter().copied());
        args.push("--help");
        let output = svode(temp.path(), &args);
        assert_eq!(output.status.code(), Some(0), "{command:?}");
        let help = String::from_utf8(output.stdout).unwrap();
        assert!(help.contains("Example"), "{command:?}: {help}");
        assert_eq!(
            help.contains("MODE_UNAVAILABLE"),
            needs_runtime,
            "{command:?}"
        );
    }
    let root = svode(temp.path(), &["--help"]);
    let help = String::from_utf8(root.stdout).unwrap();
    for noun in [
        "project",
        "space",
        "page",
        "collection",
        "item",
        "actor",
        "search",
        "knowledge",
        "git",
        "guide",
        "doctor",
    ] {
        assert!(help.contains(noun), "{noun}");
    }
    assert!(fs::read_dir(temp.path()).unwrap().next().is_none());
}

//! Acceptance of `svode page read` through the real binary with the desktop
//! app closed: stdout is parsed as the public contract.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

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
    let output = svode(cwd, args);
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert_eq!(stdout.lines().count(), 1, "one JSON line: {stdout}");
    let value = serde_json::from_str(&stdout).unwrap();
    (output.status.code().unwrap(), value)
}

fn read(project: &Path, space: &str, path: &str) -> (i32, Value) {
    json(
        project.parent().unwrap(),
        &[
            "--project",
            project.to_str().unwrap(),
            "page",
            "read",
            "--space",
            space,
            "--path",
            path,
            "--json",
        ],
    )
}

fn error_code(value: &Value) -> &str {
    assert_eq!(value["ok"], false, "{value}");
    value["error"]["code"].as_str().unwrap()
}

fn git(root: &Path, args: &[&str], date: Option<&str>) {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0");
    if let Some(date) = date {
        command
            .env("GIT_AUTHOR_DATE", date)
            .env("GIT_COMMITTER_DATE", date);
    }
    assert!(command.output().unwrap().status.success(), "git {args:?}");
}

fn has_git() -> bool {
    Command::new("git").arg("--version").output().is_ok()
}

/// Every file under `root` with its bytes, to prove a read changes nothing.
fn snapshot(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn walk(dir: &Path, root: &Path, files: &mut BTreeMap<PathBuf, Vec<u8>>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            let meta = fs::symlink_metadata(&path).unwrap();
            if meta.is_dir() {
                walk(&path, root, files);
            } else if meta.is_file() {
                files.insert(
                    path.strip_prefix(root).unwrap().to_path_buf(),
                    fs::read(&path).unwrap(),
                );
            } else {
                files.insert(path.strip_prefix(root).unwrap().to_path_buf(), Vec::new());
            }
        }
    }
    let mut files = BTreeMap::new();
    walk(root, root, &mut files);
    files
}

fn fixture(root: &Path) {
    fs::create_dir_all(root.join(".svode")).unwrap();
    fs::write(
        root.join(".svode/config.json"),
        r#"{"name":"Project","spaces":[{"id":"child","path":"child","repo":null},{"id":"gone","path":"gone","repo":null}]}"#,
    )
    .unwrap();
    fs::create_dir_all(root.join("notes")).unwrap();
    fs::write(
        root.join("notes/valid.md"),
        "---\ntitle: Valid\nicon: \"📄\"\nid: custom\n---\nBody\n",
    )
    .unwrap();
    fs::write(root.join("notes/plain.md"), "Plain body").unwrap();
    fs::write(root.join("notes/empty.md"), "").unwrap();
    fs::write(
        root.join("notes/malformed.md"),
        "---\ntitle: [bad\n---\nBody",
    )
    .unwrap();
    fs::write(root.join("notes/binary.md"), [0xff, 0xfe]).unwrap();
    fs::create_dir_all(root.join("folder")).unwrap();
    fs::write(root.join("folder/README.md"), "Folder body").unwrap();
    fs::create_dir_all(root.join("tasks")).unwrap();
    fs::write(root.join("tasks/schema.yaml"), "name: Tasks").unwrap();
    fs::write(root.join("tasks/item.md"), "Item").unwrap();
    fs::create_dir_all(root.join("child")).unwrap();
    fs::write(root.join("child/note.md"), "Child body").unwrap();
    fs::write(root.join("README.md"), "Root owner").unwrap();
}

#[test]
fn reads_valid_pages_from_an_unrelated_cwd_with_relative_project() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("project");
    let elsewhere = temp.path().join("elsewhere");
    fs::create_dir_all(&elsewhere).unwrap();
    fixture(&root);
    let canonical = fs::canonicalize(&root).unwrap();

    let (code, value) = json(
        &elsewhere,
        &[
            "page",
            "read",
            "--json",
            "--path",
            "notes/valid.md",
            "--project",
            "../project",
            "--space",
            "root",
        ],
    );
    assert_eq!(code, 0);
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["ok"], true);
    assert_eq!(value["target"]["projectPath"], canonical.to_str().unwrap());
    assert_eq!(value["target"]["spacePath"], canonical.to_str().unwrap());
    assert_eq!(value["target"]["spaceId"], "root");
    assert_eq!(value["target"]["path"], "notes/valid.md");
    assert_eq!(value["page"]["path"], "notes/valid.md");
    assert_eq!(value["page"]["body"], "Body\n");
    assert_eq!(value["page"]["meta"]["title"], "Valid");
    assert_eq!(value["page"]["meta"]["icon"], "📄");
    assert_eq!(value["page"]["meta"]["extra"]["id"], "custom");
    assert!(
        !value["page"]["meta"]["created"]
            .as_str()
            .unwrap()
            .is_empty()
    );
    assert!(!value["sourceVersion"].as_str().unwrap().is_empty());
    let keys = value
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(
        keys,
        ["ok", "page", "schemaVersion", "sourceVersion", "target"]
    );

    let (_, plain) = read(&root, "root", "notes/plain.md");
    assert_eq!(plain["page"]["meta"]["title"], "Plain");
    assert_eq!(plain["page"]["body"], "Plain body");
    let (code, empty) = read(&root, "root", "notes/empty.md");
    assert_eq!(code, 0);
    assert_eq!(empty["page"]["body"], "");
    let (_, folder) = read(&root, "root", "folder/README.md");
    assert_eq!(folder["page"]["body"], "Folder body");
    let (_, child) = read(&root, "child", "note.md");
    assert_eq!(child["target"]["spaceId"], "child");
    assert_eq!(
        child["target"]["spacePath"],
        canonical.join("child").to_str().unwrap()
    );
    assert_eq!(child["page"]["body"], "Child body");
}

#[test]
fn malformed_frontmatter_is_a_successful_read_with_warning_on_stderr() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    fixture(root);
    let (code, value) = read(root, "root", "notes/malformed.md");
    assert_eq!(code, 0);
    assert_eq!(value["page"]["body"], "---\ntitle: [bad\n---\nBody");
    assert_eq!(
        value["page"]["warnings"][0]["kind"],
        "malformed_frontmatter"
    );
    assert_eq!(
        fs::read_to_string(root.join("notes/malformed.md")).unwrap(),
        "---\ntitle: [bad\n---\nBody"
    );

    let human = svode(
        root,
        &[
            "--project",
            root.to_str().unwrap(),
            "--space",
            "root",
            "page",
            "read",
            "--path",
            "notes/malformed.md",
        ],
    );
    assert_eq!(human.status.code(), Some(0));
    assert_eq!(
        String::from_utf8(human.stdout).unwrap(),
        format!(
            "notes/malformed.md\nsourceVersion: {}\n\n---\ntitle: [bad\n---\nBody\n",
            value["sourceVersion"].as_str().unwrap()
        )
    );
    assert!(
        String::from_utf8(human.stderr)
            .unwrap()
            .contains("malformed_frontmatter")
    );
}

#[test]
fn source_and_context_failures_have_stable_codes_and_exit_one() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("project");
    fixture(&root);
    let canonical = fs::canonicalize(&root).unwrap();
    for (space, path, code) in [
        ("root", "notes/missing.md", "FILE_NOT_FOUND"),
        ("root", "../outside.md", "INVALID_PATH"),
        ("root", "/etc/passwd.md", "INVALID_PATH"),
        ("root", "notes/plain.txt", "INVALID_PATH"),
        ("root", "notes", "INVALID_PATH"),
        ("root", ".git/config.md", "PATH_FORBIDDEN"),
        ("root", ".svode/notes.md", "PATH_FORBIDDEN"),
        ("root", "README.md", "NOT_A_STANDALONE_PAGE"),
        ("root", "tasks/item.md", "NOT_A_STANDALONE_PAGE"),
        ("root", "child/note.md", "NOT_A_STANDALONE_PAGE"),
        ("root", "notes/binary.md", "INVALID_SOURCE_ENCODING"),
        ("unknown", "note.md", "SPACE_UNAVAILABLE"),
        ("gone", "note.md", "SPACE_UNAVAILABLE"),
    ] {
        let (exit, value) = read(&root, space, path);
        assert_eq!(exit, 1, "{space}:{path} {value}");
        assert_eq!(error_code(&value), code, "{space}:{path}");
        assert_eq!(value["error"]["target"]["spaceId"], space);
        assert_eq!(
            value["error"]["target"]["projectPath"],
            canonical.to_str().unwrap()
        );
        assert!(!value["error"]["message"].as_str().unwrap().is_empty());
    }
    let (_, unknown) = read(&root, "unknown", "note.md");
    assert!(unknown["error"]["target"].get("spacePath").is_none());

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        fs::write(temp.path().join("outside.md"), "Outside").unwrap();
        symlink(temp.path().join("outside.md"), root.join("notes/escape.md")).unwrap();
        let (exit, value) = read(&root, "root", "notes/escape.md");
        assert_eq!(exit, 1);
        assert_eq!(error_code(&value), "PATH_FORBIDDEN");
        symlink(root.join("child/note.md"), root.join("notes/alias.md")).unwrap();
        let (_, value) = read(&root, "root", "notes/alias.md");
        assert_eq!(error_code(&value), "NOT_A_STANDALONE_PAGE");
    }

    let missing = temp.path().join("absent");
    let (exit, value) = read(&missing, "root", "note.md");
    assert_eq!(exit, 1);
    assert_eq!(error_code(&value), "PROJECT_UNAVAILABLE");
    assert!(value["error"]["target"].get("spacePath").is_none());

    let bare = temp.path().join("bare");
    fs::create_dir_all(&bare).unwrap();
    fs::write(bare.join("note.md"), "Body").unwrap();
    let (_, value) = read(&bare, "root", "note.md");
    assert_eq!(error_code(&value), "PROJECT_UNAVAILABLE");
    assert!(!bare.join(".svode").exists(), "no scaffold");

    fs::create_dir_all(bare.join(".svode")).unwrap();
    fs::write(bare.join(".svode/config.json"), "{").unwrap();
    let (exit, value) = read(&bare, "root", "note.md");
    assert_eq!(exit, 1);
    assert_eq!(error_code(&value), "INVALID_PROJECT_CONFIG");
    assert_eq!(
        fs::read_to_string(bare.join(".svode/config.json")).unwrap(),
        "{"
    );
}

#[test]
fn grammar_failures_exit_two_with_usage_on_stderr() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    fixture(root);
    let project = root.to_str().unwrap();
    for args in [
        vec![
            "--project",
            project,
            "--space",
            "root",
            "page",
            "read",
            "--json",
        ],
        vec!["--json", "page", "raed"],
        vec!["--json", "page", "read", "--path", "a.md", "--bogus"],
        vec!["--json", "note", "read"],
    ] {
        let output = svode(root, &args);
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(error_code(&value), "INVALID_ARGUMENT", "{args:?}");
        assert!(
            String::from_utf8(output.stderr).unwrap().contains("Usage:"),
            "{args:?}"
        );
    }
    let human = svode(root, &["page", "read"]);
    assert_eq!(human.status.code(), Some(2));
    assert!(human.stdout.is_empty());
}

#[test]
fn help_and_version_work_without_a_project() {
    let temp = tempfile::tempdir().unwrap();
    for args in [
        vec!["--help"],
        vec!["page", "read", "--help"],
        vec!["--project", "/definitely/missing", "page", "read", "--help"],
    ] {
        let output = svode(temp.path(), &args);
        assert_eq!(output.status.code(), Some(0), "{args:?}");
        let help = String::from_utf8(output.stdout).unwrap();
        assert!(help.contains("--project"), "{args:?}");
        assert!(help.contains("page read --space root --path"), "{args:?}");
    }
    let version = svode(temp.path(), &["--version"]);
    assert_eq!(version.status.code(), Some(0));
    assert_eq!(
        String::from_utf8(version.stdout).unwrap().trim(),
        format!("svode {}", env!("CARGO_PKG_VERSION"))
    );
    assert!(fs::read_dir(temp.path()).unwrap().next().is_none());
}

#[test]
fn external_edit_between_calls_is_read_fresh_with_a_new_version() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    fixture(root);
    let (_, first) = read(root, "root", "notes/valid.md");
    let (_, again) = read(root, "root", "notes/valid.md");
    assert_eq!(first["sourceVersion"], again["sourceVersion"]);
    fs::write(
        root.join("notes/valid.md"),
        "---\ntitle: Renamed\nicon: \"📄\"\nid: custom\n---\nBody\n",
    )
    .unwrap();
    let (_, second) = read(root, "root", "notes/valid.md");
    assert_eq!(second["page"]["meta"]["title"], "Renamed");
    assert_eq!(second["page"]["body"], "Body\n");
    assert_ne!(first["sourceVersion"], second["sourceVersion"]);
}

#[test]
fn read_creates_no_stores_files_or_git_changes() {
    if !has_git() {
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    fixture(root);
    git(root, &["init"], None);
    git(root, &["config", "user.name", "Test"], None);
    git(
        root,
        &["config", "user.email", "test@example.invalid"],
        None,
    );
    git(root, &["add", "."], None);
    git(
        root,
        &["commit", "-m", "fixture"],
        Some("2026-01-02T03:04:05Z"),
    );
    fs::write(root.join("notes/untracked.md"), "Untracked").unwrap();
    let before = snapshot(root);

    let (code, value) = read(root, "root", "notes/valid.md");
    assert_eq!(code, 0);
    assert_eq!(value["page"]["meta"]["created"], "2026-01-02T03:04:05Z");
    assert_eq!(value["page"]["meta"]["updated"], "2026-01-02T03:04:05Z");
    let (code, _) = read(root, "root", "notes/untracked.md");
    assert_eq!(code, 0);
    let (code, _) = read(root, "child", "note.md");
    assert_eq!(code, 0);
    let (code, _) = read(root, "root", "notes/missing.md");
    assert_eq!(code, 1);

    let after = snapshot(root);
    let changed = before
        .keys()
        .chain(after.keys())
        .filter(|path| before.get(*path) != after.get(*path))
        .collect::<std::collections::BTreeSet<_>>();
    assert!(changed.is_empty(), "reads changed {changed:?}");
    assert!(!root.join(".svode/index.db").exists());
    assert!(!root.join(".svode/routines.db").exists());
}

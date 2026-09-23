//! Create, delete, structural and reorder commands, Collection schema/views
//! and integrity through the real `svode` binary with the desktop app
//! closed. Structural changes apply the shared operation with its link,
//! relation, order and index effects across Spaces and repositories, hold
//! the write guard of every repository they touch, keep the existing
//! partial outcome when a link rewrite fails, and never commit; schema
//! column and view changes are covered by `metadata_schema_process`.
//! Grammar and input fail before any of them with exit 2.

mod common;

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use common::process::{code, json, snapshot, svode, write};
use serde_json::{Value, json};

fn fixture() -> (tempfile::TempDir, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap().join("project");
    write(
        &root.join(".svode/config.json"),
        r#"{"name":"Project","spaces":[{"id":"child","path":"child","repo":null}]}"#,
    );
    write(
        &root.join("child/.svode/config.json"),
        r#"{"name":"Child"}"#,
    );
    write(&root.join("README.md"), "---\ntitle: Project\n---\n");
    write(&root.join("notes.md"), "---\ntitle: Notes\n---\nBody\n");
    write(&root.join("solo/README.md"), "---\ntitle: Solo\n---\n");
    write(
        &root.join("tasks/schema.yaml"),
        "columns:\n  - name: Sprint\n    type: relation\n    relation: sprints\nviews:\n  - type: table\n    name: Table\n",
    );
    write(&root.join("tasks/README.md"), "---\ntitle: Tasks\n---\n");
    write(
        &root.join("tasks/alpha.md"),
        "---\ntitle: Alpha\nSprint: gone.md\n---\n",
    );
    write(
        &root.join("sprints/schema.yaml"),
        "columns: []\nviews: []\n",
    );
    write(
        &root.join("sprints/README.md"),
        "---\ntitle: Sprints\n---\n",
    );
    write(
        &root.join("input/columns.json"),
        r#"[{"name":"Owner","type":"text"}]"#,
    );
    write(
        &root.join("input/column.json"),
        r#"{"name":"Stage","type":"text"}"#,
    );
    write(&root.join("input/patch.json"), r#"{"name":"Renamed"}"#);
    write(
        &root.join("input/view.json"),
        r#"{"type":"table","name":"Board"}"#,
    );
    (temp, root)
}

fn git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stderr(Stdio::null())
        .output()
        .unwrap();
    assert!(output.status.success(), "git {args:?}");
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}

fn has_git() -> bool {
    Command::new("git").arg("--version").output().is_ok()
}

fn commit(dir: &Path) {
    git(dir, &["init", "-q"]);
    git(dir, &["config", "user.email", "agent@example.com"]);
    git(dir, &["config", "user.name", "Agent"]);
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", "fixture"]);
}

/// Committed Project whose root repository has an inline child Space
/// `wiki` and an independent child repository `child`: links from both
/// child Spaces into the root, a Collection with a relation into another
/// one, a directory-backed Page and a leaf Page to convert.
fn project() -> Option<(tempfile::TempDir, PathBuf)> {
    if !has_git() {
        return None;
    }
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap().join("project");
    write(
        &root.join(".svode/config.json"),
        &json!({
            "name": "Project",
            "spaces": [
                { "id": "child", "path": "child", "repo": null },
                { "id": "wiki", "path": "wiki", "repo": null }
            ]
        })
        .to_string(),
    );
    write(&root.join(".gitignore"), "child/\n");
    write(&root.join("README.md"), "---\ntitle: Project\n---\n");
    write(
        &root.join("notes.md"),
        "---\ntitle: Notes\n---\nSee [Plan](plan.md).\n",
    );
    write(&root.join("plan.md"), "---\ntitle: Plan\n---\nPlan body\n");
    write(&root.join("ideas.md"), "---\ntitle: Ideas\n---\nIdeas\n");
    write(
        &root.join("archive/README.md"),
        "---\ntitle: Archive\n---\n",
    );
    write(
        &root.join("solo/README.md"),
        "---\ntitle: Solo\n---\nSolo\n",
    );
    write(
        &root.join("tasks/schema.yaml"),
        "columns:\n  - name: Person\n    type: relation\n    relation: people\nviews:\n  - type: table\n    name: Table\n",
    );
    write(&root.join("tasks/README.md"), "---\ntitle: Tasks\n---\n");
    write(
        &root.join("tasks/alpha.md"),
        "---\ntitle: Alpha\nPerson:\n  - Ada.md\n---\n",
    );
    write(&root.join("people/schema.yaml"), "columns: []\nviews: []\n");
    write(&root.join("people/README.md"), "---\ntitle: People\n---\n");
    write(&root.join("people/Ada.md"), "---\ntitle: Ada\n---\n");
    write(&root.join("wiki/.svode/config.json"), r#"{"name":"Wiki"}"#);
    write(&root.join("wiki/README.md"), "---\ntitle: Wiki\n---\n");
    write(
        &root.join("wiki/links.md"),
        "---\ntitle: Links\n---\nSee [Plan](../plan.md).\n",
    );
    commit(&root);
    let child = root.join("child");
    write(&child.join(".svode/config.json"), r#"{"name":"Child"}"#);
    write(&child.join("README.md"), "---\ntitle: Child\n---\n");
    write(
        &child.join("ref.md"),
        "---\ntitle: Ref\n---\nSee [Plan](../plan.md).\n",
    );
    commit(&child);
    Some((temp, root))
}

/// Files of the project without Git internals, the derived index and the
/// device-local stores and lock next to it.
fn sources(root: &Path) -> std::collections::BTreeMap<PathBuf, Vec<u8>> {
    let mut files = snapshot(root);
    files.retain(|path, _| {
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        let derived = name.starts_with("index.db")
            || name.starts_with("routines.db")
            || name == "local.json"
            || name == "variables.lock"
            || name == "write.lock";
        !path.components().any(|part| part.as_os_str() == ".git")
            && !(derived
                && path
                    .parent()
                    .is_some_and(|parent| parent.ends_with(".svode")))
    });
    files
}

fn ok(cwd: &Path, args: &[&str]) -> Value {
    let (exit, value) = json(cwd, args, None);
    assert_eq!(exit, 0, "{args:?}: {value}");
    assert_eq!(value["ok"], true, "{args:?}");
    value
}

fn text(root: &Path, path: &str) -> String {
    fs::read_to_string(root.join(path)).unwrap()
}

fn strings(value: &Value) -> BTreeSet<String> {
    value
        .as_array()
        .unwrap_or_else(|| panic!("array: {value}"))
        .iter()
        .map(|item| item.as_str().unwrap().to_string())
        .collect()
}

#[test]
fn create_structural_and_reorder_commands_apply_across_spaces_without_a_commit() {
    let Some((_temp, root)) = project() else {
        return;
    };
    let root = &root;
    let child = root.join("child");
    let heads = (
        git(root, &["rev-parse", "HEAD"]),
        git(&child, &["rev-parse", "HEAD"]),
    );

    // Rename rewrites the links into the target from its own Space, the
    // inline child Space and the independent child repository.
    let renamed = ok(
        root,
        &[
            "content",
            "rename",
            "--path",
            "plan.md",
            "--to",
            "Roadmap.md",
        ],
    );
    assert_eq!(renamed["newPath"], "Roadmap.md");
    assert!(!root.join("plan.md").exists());
    assert!(text(root, "notes.md").contains("[Plan](Roadmap.md)"));
    assert!(text(root, "wiki/links.md").contains("(../Roadmap.md)"));
    assert!(text(root, "child/ref.md").contains("(../Roadmap.md)"));
    let affected = strings(&renamed["affectedProjectPaths"]);
    for path in ["Roadmap.md", "notes.md", "wiki/links.md", "child/ref.md"] {
        assert!(affected.contains(path), "{path}: {renamed}");
    }

    // Move into a directory-backed Page rewrites them again.
    let moved = ok(
        root,
        &[
            "content",
            "move",
            "--path",
            "Roadmap.md",
            "--to-parent",
            "archive",
        ],
    );
    assert_eq!(moved["newPath"], "archive/Roadmap.md");
    assert!(text(root, "notes.md").contains("(archive/Roadmap.md)"));
    assert!(text(root, "child/ref.md").contains("(../archive/Roadmap.md)"));

    // Create a Page, a Collection item and a Collection.
    let page = ok(
        root,
        &[
            "page",
            "create",
            "--parent",
            "",
            "--title",
            "Weekly",
            "--body",
            "Weekly body\n",
        ],
    );
    assert_eq!(page["path"], "Weekly.md");
    assert!(page["sourceVersion"].is_string(), "{page}");
    let item = ok(
        root,
        &["page", "create", "--parent", "tasks", "--title", "Beta"],
    );
    assert_eq!(item["path"], "tasks/Beta.md");
    let (exit, created) = json(
        root,
        &[
            "collection",
            "create",
            "--parent",
            "",
            "--title",
            "Backlog",
            "--columns-file",
            "-",
        ],
        Some(r#"[{"name":"Owner","type":"text"}]"#),
    );
    assert_eq!(exit, 0, "{created}");
    assert_eq!(created["schema"]["columns"][0]["name"], "Owner");
    assert_eq!(created["collectionPath"], "Backlog");
    assert!(root.join("Backlog/schema.yaml").is_file());
    let in_child = ok(
        root,
        &[
            "--space",
            "child",
            "page",
            "create",
            "--parent",
            "",
            "--title",
            "Child note",
        ],
    );
    assert_eq!(in_child["path"], "Child note.md");
    assert!(child.join("Child note.md").is_file());

    // Shape conversions in place.
    let collection = ok(
        root,
        &[
            "content",
            "convert",
            "--path",
            "ideas.md",
            "--to",
            "collection",
        ],
    );
    assert_eq!(collection["collectionPath"], "ideas");
    assert!(root.join("ideas/README.md").is_file() && root.join("ideas/schema.yaml").is_file());
    let leaf = ok(
        root,
        &[
            "content",
            "convert",
            "--path",
            "solo/README.md",
            "--to",
            "leaf",
        ],
    );
    assert_eq!(leaf["newPath"], "solo.md");
    assert!(root.join("solo.md").is_file() && !root.join("solo").exists());

    // Order of content and of child Spaces.
    ok(
        root,
        &["page", "create", "--parent", "archive", "--title", "Old"],
    );
    let reordered = ok(
        root,
        &[
            "content",
            "reorder",
            "--parent",
            "archive",
            "--child",
            "archive/Old.md",
            "--child",
            "archive/Roadmap.md",
        ],
    );
    assert_eq!(reordered["changedPaths"], json!([".svode/order.json"]));
    assert_eq!(
        reordered["previousOrder"],
        json!(["archive/Roadmap.md", "archive/Old.md"])
    );
    let spaces = ok(root, &["space", "reorder", "--id", "wiki", "--id", "child"]);
    assert_eq!(spaces["orderedSpaceIds"], json!(["wiki", "child"]));
    assert_eq!(spaces["changedPaths"], json!([".svode/config.json"]));

    // Deletes clean the relations that pointed at the deleted entry.
    let person = ok(root, &["item", "delete", "--path", "people/Ada.md"]);
    assert!(
        strings(&person["cascadeTouched"]).contains("tasks/alpha.md"),
        "{person}"
    );
    assert!(!text(root, "tasks/alpha.md").contains("Ada.md"));
    ok(root, &["item", "delete", "--path", "tasks/alpha.md"]);
    ok(root, &["page", "delete", "--path", "Weekly.md"]);
    ok(root, &["collection", "delete", "--collection", "Backlog"]);
    assert!(!root.join("Backlog").exists() && !root.join("Weekly.md").exists());

    // The index of each Space sees the result through the next read.
    let found = ok(root, &["search", "Plan body"]);
    assert_eq!(found["items"][0]["path"], "archive/Roadmap.md", "{found}");
    let found = ok(root, &["--space", "child", "search", "Child note"]);
    assert!(found.to_string().contains("Child note.md"), "{found}");

    // Nothing was committed in either repository.
    assert_eq!(git(root, &["rev-parse", "HEAD"]), heads.0);
    assert_eq!(git(&child, &["rev-parse", "HEAD"]), heads.1);
    assert!(!git(root, &["status", "--porcelain"]).is_empty());
    assert!(!git(&child, &["status", "--porcelain"]).is_empty());
}

#[test]
fn a_held_repository_of_the_touched_set_is_busy_until_it_is_released() {
    let Some((_temp, root)) = project() else {
        return;
    };
    let root = &root;
    let child = root.join("child");
    let before = sources(root);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();

    // The rename touches the root repository and, through a backlink, the
    // independent child repository: holding the child one blocks it all.
    let guard = runtime
        .block_on(svode_core::git::write_guard::acquire(
            &BTreeSet::from([child.clone()]),
            &[],
        ))
        .unwrap();
    let started = Instant::now();
    let (exit, busy) = json(
        root,
        &[
            "content",
            "rename",
            "--path",
            "plan.md",
            "--to",
            "Roadmap.md",
        ],
        None,
    );
    assert_eq!(exit, 1, "{busy}");
    assert_eq!(code(&busy), "SOURCE_BUSY");
    assert_eq!(busy["error"]["path"], "child/ref.md");
    assert!(started.elapsed() >= Duration::from_millis(1400));
    assert_eq!(sources(root), before);

    // A change of the root repository alone does not wait for the child.
    ok(root, &["page", "create", "--parent", "", "--title", "Free"]);
    drop(guard);

    // Holding the root repository refuses a create with a path in its Space.
    let guard = runtime
        .block_on(svode_core::git::write_guard::acquire(
            &BTreeSet::from([root.clone()]),
            &[],
        ))
        .unwrap();
    let (exit, busy) = json(
        root,
        &["page", "create", "--parent", "", "--title", "Blocked"],
        None,
    );
    assert_eq!((exit, code(&busy)), (1, "SOURCE_BUSY"), "{busy}");
    let path = busy["error"]["path"].as_str().unwrap();
    assert!(!path.starts_with('/'), "{busy}");
    assert!(!root.join("Blocked.md").exists());
    drop(guard);

    // After the release the same intent applies.
    let renamed = ok(
        root,
        &[
            "content",
            "rename",
            "--path",
            "plan.md",
            "--to",
            "Roadmap.md",
        ],
    );
    assert_eq!(renamed["newPath"], "Roadmap.md");
    assert!(text(root, "child/ref.md").contains("(../Roadmap.md)"));
}

#[cfg(unix)]
#[test]
fn a_link_rewrite_that_fails_keeps_the_applied_move_as_a_partial_outcome() {
    use std::os::unix::fs::PermissionsExt;

    let Some((_temp, root)) = project() else {
        return;
    };
    let root = &root;
    let reference = root.join("child/ref.md");
    let original = text(root, "child/ref.md");
    fs::set_permissions(&reference, fs::Permissions::from_mode(0o444)).unwrap();

    // The shared operation keeps the rename and reports what it changed; it
    // does not roll the rename back because a backlink could not be written.
    let renamed = ok(
        root,
        &[
            "content",
            "rename",
            "--path",
            "plan.md",
            "--to",
            "Roadmap.md",
        ],
    );
    fs::set_permissions(&reference, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(root.join("Roadmap.md").is_file() && !root.join("plan.md").exists());
    assert_eq!(text(root, "child/ref.md"), original);
    assert!(
        !strings(&renamed["affectedProjectPaths"]).contains("child/ref.md"),
        "{renamed}"
    );
}

#[test]
fn collection_check_reads_sources_standalone() {
    let (_temp, root) = fixture();
    let before = snapshot(&root);

    let (exit, value) = json(&root, &["collection", "check"], None);
    assert_eq!(exit, 0, "{value}");
    assert_eq!(value["ok"], true);
    assert_eq!(value["collectionPath"], serde_json::Value::Null);
    assert!(value["errorCount"].as_u64().unwrap() >= 1, "{value}");
    let issues = value["issuesBySeverity"]["errors"].as_array().unwrap();
    assert!(
        issues.iter().any(|issue| issue["path"] == "tasks/alpha.md"),
        "{value}"
    );

    let (exit, value) = json(
        &root,
        &["collection", "check", "--collection", "sprints"],
        None,
    );
    assert_eq!(exit, 0, "{value}");
    assert_eq!(value["target"]["collection"], "sprints");
    assert_eq!(value["errorCount"], 0);

    let human = svode(&root, &["collection", "check", "--collection", "tasks"]);
    assert_eq!(human.status.code(), Some(0));
    let stdout = String::from_utf8(human.stdout).unwrap();
    assert!(stdout.contains("tasks/alpha.md"), "{stdout}");

    for (args, expected) in [
        (&["collection", "check", "--collection", "missing"][..], 1),
        (&["collection", "check", "--collection", "../outside"], 1),
    ] {
        let (exit, value) = json(&root, args, None);
        assert_eq!(exit, expected, "{args:?}: {value}");
        assert_eq!(value["ok"], false);
    }
    assert_eq!(snapshot(&root), before);
}

#[test]
fn structural_grammar_and_input_fail_before_the_command_runs() {
    let (_temp, root) = fixture();
    write(&root.join("input/bad.json"), "{");
    let before = snapshot(&root);
    for (args, expected) in [
        // Lists need at least one repeated value.
        (
            vec!["content", "reorder", "--parent", ""],
            "INVALID_ARGUMENT",
        ),
        (vec!["space", "reorder"], "INVALID_ARGUMENT"),
        // One conversion shape out of two.
        (
            vec!["content", "convert", "--path", "notes.md", "--to", "folder"],
            "INVALID_ARGUMENT",
        ),
        (
            vec!["content", "convert", "--path", "notes.md"],
            "INVALID_ARGUMENT",
        ),
        // Destructive commands have no --force and need an exact target.
        (
            vec!["page", "delete", "--path", "notes.md", "--force"],
            "INVALID_ARGUMENT",
        ),
        (vec!["collection", "delete"], "INVALID_ARGUMENT"),
        (
            vec!["collection", "column", "delete", "--collection", "tasks"],
            "INVALID_ARGUMENT",
        ),
        (
            vec!["content", "rename", "--path", "notes.md"],
            "INVALID_ARGUMENT",
        ),
        (
            vec![
                "collection",
                "view",
                "add",
                "--collection",
                "tasks",
                "--view-file",
                "input/view.json",
                "--position",
                "-1",
            ],
            "INVALID_ARGUMENT",
        ),
        (
            vec![
                "collection",
                "create",
                "--parent",
                "",
                "--title",
                "T",
                "--body",
                "a",
                "--body-file",
                "input/columns.json",
            ],
            "INVALID_ARGUMENT",
        ),
        // One stdin per command.
        (
            vec![
                "collection",
                "create",
                "--parent",
                "",
                "--title",
                "T",
                "--columns-file",
                "-",
                "--views-file",
                "-",
            ],
            "INVALID_ARGUMENT",
        ),
        (
            vec![
                "collection",
                "column",
                "add",
                "--collection",
                "tasks",
                "--column-file",
                "input/missing.json",
            ],
            "INPUT_UNREADABLE",
        ),
        (
            vec![
                "collection",
                "view",
                "update",
                "--collection",
                "tasks",
                "--name",
                "Table",
                "--patch-file",
                "input/bad.json",
            ],
            "INVALID_ARGUMENT",
        ),
    ] {
        let (exit, value) = json(&root, &args, None);
        assert_eq!(exit, 2, "{args:?}: {value}");
        assert_eq!(code(&value), expected, "{args:?}");
    }
    let usage = svode(&root, &["content", "reorder", "--parent", ""]);
    assert_eq!(usage.status.code(), Some(2));
    assert!(usage.stdout.is_empty());
    assert!(String::from_utf8(usage.stderr).unwrap().contains("Usage"));
    assert_eq!(snapshot(&root), before);
}

#[test]
fn structural_help_explains_effects_without_a_project() {
    let temp = tempfile::tempdir().unwrap();
    for command in [
        &["collection", "create"][..],
        &["collection", "delete"],
        &["collection", "column", "add"],
        &["collection", "column", "update"],
        &["collection", "column", "delete"],
        &["collection", "view", "add"],
        &["collection", "view", "update"],
        &["collection", "view", "delete"],
        &["content", "rename"],
        &["content", "move"],
        &["content", "reorder"],
        &["content", "convert"],
        &["page", "delete"],
        &["item", "delete"],
        &["space", "reorder"],
    ] {
        let mut args = vec!["--project", "/definitely/missing"];
        args.extend_from_slice(command);
        args.push("--help");
        let output = svode(temp.path(), &args);
        assert_eq!(output.status.code(), Some(0), "{command:?}");
        let help = String::from_utf8(output.stdout).unwrap();
        for expected in ["Structural change", "no --force", "Example"] {
            assert!(help.contains(expected), "{command:?}: {expected}\n{help}");
        }
        assert!(!help.contains("MODE_UNAVAILABLE"), "{command:?}");
    }
    let check = svode(temp.path(), &["collection", "check", "--help"]);
    assert_eq!(check.status.code(), Some(0));
    let help = String::from_utf8(check.stdout).unwrap();
    assert!(help.contains("Example"), "{help}");
    assert!(!help.contains("MODE_UNAVAILABLE"), "{help}");
    assert!(fs::read_dir(temp.path()).unwrap().next().is_none());
}

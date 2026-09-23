//! Collection schema/views/integrity and structural commands through the
//! real `svode` binary with the desktop app closed. The integrity check reads
//! only sources and runs standalone, schema column and view changes are
//! served (`metadata_schema_process`); until the headless runtime serves
//! them the other structural mutations answer `MODE_UNAVAILABLE` and change
//! nothing; grammar and input fail before it with exit 2.

mod common;

use std::fs;
use std::path::PathBuf;

use common::process::{code, json, snapshot, svode, write};

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

/// Structural mutations of slice 4.4 the headless runtime of this build
/// does not serve yet, with readable input.
const MUTATIONS: [&[&str]; 10] = [
    &[
        "collection",
        "create",
        "--parent",
        "",
        "--title",
        "Backlog",
        "--columns-file",
        "input/columns.json",
    ],
    &["collection", "delete", "--collection", "sprints"],
    &[
        "content", "rename", "--path", "notes.md", "--to", "Moved.md",
    ],
    &[
        "content",
        "move",
        "--path",
        "notes.md",
        "--to-parent",
        "solo",
    ],
    &[
        "content",
        "reorder",
        "--parent",
        "",
        "--child",
        "tasks/README.md",
        "--child",
        "notes.md",
    ],
    &[
        "content",
        "convert",
        "--path",
        "solo/README.md",
        "--to",
        "leaf",
    ],
    &[
        "content",
        "convert",
        "--path",
        "notes.md",
        "--to",
        "collection",
    ],
    &["page", "delete", "--path", "notes.md"],
    &["item", "delete", "--path", "tasks/alpha.md"],
    &["space", "reorder", "--id", "child"],
];

#[test]
fn standalone_structural_mutations_are_mode_unavailable_and_change_nothing() {
    let (_temp, root) = fixture();
    let before = snapshot(&root);
    for args in MUTATIONS {
        let (exit, value) = json(&root, args, None);
        assert_eq!(exit, 1, "{args:?}: {value}");
        assert_eq!(code(&value), "MODE_UNAVAILABLE", "{args:?}");
        assert_eq!(value["error"]["target"]["spaceId"], "root", "{args:?}");
        let human = svode(&root, args);
        assert_eq!(human.status.code(), Some(1), "{args:?}");
        assert!(human.stdout.is_empty(), "{args:?}");
        assert!(
            String::from_utf8(human.stderr)
                .unwrap()
                .contains("MODE_UNAVAILABLE"),
            "{args:?}"
        );
    }
    let (_, value) = json(
        &root,
        &["collection", "delete", "--collection", "sprints"],
        None,
    );
    assert_eq!(value["error"]["target"]["collection"], "sprints");
    assert_eq!(snapshot(&root), before);
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
    // Structured input from stdin reaches the command, which then reports
    // its mode.
    let (exit, value) = json(
        &root,
        &[
            "collection",
            "create",
            "--parent",
            "",
            "--title",
            "Piped",
            "--columns-file",
            "-",
        ],
        Some(r#"[{"name":"Piped","type":"text"}]"#),
    );
    assert_eq!((exit, code(&value)), (1, "MODE_UNAVAILABLE"));
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
        // Schema column and view changes are served by this build.
        let schema =
            command[..2] == ["collection", "column"] || command[..2] == ["collection", "view"];
        assert_eq!(help.contains("MODE_UNAVAILABLE"), !schema, "{command:?}");
    }
    let check = svode(temp.path(), &["collection", "check", "--help"]);
    assert_eq!(check.status.code(), Some(0));
    let help = String::from_utf8(check.stdout).unwrap();
    assert!(help.contains("Example"), "{help}");
    assert!(!help.contains("MODE_UNAVAILABLE"), "{help}");
    assert!(fs::read_dir(temp.path()).unwrap().next().is_none());
}

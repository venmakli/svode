//! Page, owner and item writes through the real `svode` binary with the
//! desktop app closed. Until the headless runtime is connected every write
//! answers `MODE_UNAVAILABLE` and changes nothing; grammar and input fail
//! before it with exit 2.

mod common;

use std::fs;
use std::path::PathBuf;

use common::process::{code, json, snapshot, svode, write};

fn fixture() -> (tempfile::TempDir, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap().join("project");
    write(&root.join(".svode/config.json"), r#"{"name":"Project"}"#);
    write(&root.join("README.md"), "---\ntitle: Project\n---\n");
    write(&root.join("notes.md"), "---\ntitle: Notes\n---\nBody\n");
    write(
        &root.join("tasks/schema.yaml"),
        "columns:\n  - name: Status\n    type: text\nviews: []\n",
    );
    write(&root.join("tasks/README.md"), "---\ntitle: Tasks\n---\n");
    write(&root.join("tasks/alpha.md"), "---\ntitle: Alpha\n---\n");
    write(&root.join("input/body.md"), "New body\n");
    write(&root.join("input/fields.json"), r#"{"Status":"Done"}"#);
    write(
        &root.join("input/cover.json"),
        r#"{"type":"color","value":"blue"}"#,
    );
    (temp, root)
}

/// Write commands of slice 4.3 with readable input.
const WRITES: [&[&str]; 10] = [
    &[
        "page",
        "create",
        "--parent",
        "",
        "--title",
        "New",
        "--body-file",
        "input/body.md",
    ],
    &[
        "page",
        "write",
        "--path",
        "notes.md",
        "--body-file",
        "input/body.md",
    ],
    &["page", "meta", "set", "--path", "notes.md", "--icon", "x"],
    &["space", "readme", "write", "--body", "Owner"],
    &["space", "meta", "set", "--clear-description"],
    &[
        "collection",
        "readme",
        "write",
        "--collection",
        "tasks",
        "--body",
        "",
    ],
    &[
        "collection",
        "meta",
        "set",
        "--collection",
        "tasks",
        "--cover-file",
        "input/cover.json",
    ],
    &[
        "item",
        "write",
        "--path",
        "tasks/alpha.md",
        "--body-file",
        "input/body.md",
    ],
    &[
        "item",
        "fields",
        "set",
        "--path",
        "tasks/alpha.md",
        "--fields-file",
        "input/fields.json",
    ],
    &[
        "item",
        "meta",
        "set",
        "--path",
        "tasks/alpha.md",
        "--title",
        "Renamed",
    ],
];

#[test]
fn standalone_writes_are_mode_unavailable_and_change_nothing() {
    let (_temp, root) = fixture();
    let before = snapshot(&root);
    for args in WRITES {
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
    // Input from stdin is read and passed on before the mode check.
    let (exit, value) = json(
        &root,
        &["page", "write", "--path", "notes.md", "--body-file", "-"],
        Some("Piped\n"),
    );
    assert_eq!((exit, code(&value)), (1, "MODE_UNAVAILABLE"));
    assert_eq!(snapshot(&root), before);
}

#[test]
fn write_grammar_and_input_fail_before_the_command_runs() {
    let (_temp, root) = fixture();
    write(&root.join("input/bad.json"), "{");
    let before = snapshot(&root);
    for (args, expected) in [
        // Exactly one body source is required for a write.
        (
            vec!["page", "write", "--path", "notes.md"],
            "INVALID_ARGUMENT",
        ),
        (
            vec![
                "page",
                "write",
                "--path",
                "notes.md",
                "--body",
                "a",
                "--body-file",
                "input/body.md",
            ],
            "INVALID_ARGUMENT",
        ),
        (
            vec!["page", "create", "--title", "No parent"],
            "INVALID_ARGUMENT",
        ),
        (
            vec![
                "page",
                "meta",
                "set",
                "--path",
                "notes.md",
                "--icon",
                "x",
                "--clear-icon",
            ],
            "INVALID_ARGUMENT",
        ),
        (
            vec![
                "item",
                "meta",
                "set",
                "--path",
                "tasks/alpha.md",
                "--cover-file",
                "input/cover.json",
                "--clear-cover",
            ],
            "INVALID_ARGUMENT",
        ),
        (
            vec!["item", "fields", "set", "--path", "tasks/alpha.md"],
            "INVALID_ARGUMENT",
        ),
        // One stdin per command.
        (
            vec![
                "page",
                "create",
                "--parent",
                "",
                "--title",
                "T",
                "--body-file",
                "-",
                "--properties-file",
                "-",
            ],
            "INVALID_ARGUMENT",
        ),
        (
            vec![
                "item",
                "write",
                "--path",
                "tasks/alpha.md",
                "--body-file",
                "input/missing.md",
            ],
            "INPUT_UNREADABLE",
        ),
        (
            vec![
                "item",
                "fields",
                "set",
                "--path",
                "tasks/alpha.md",
                "--fields-file",
                "input/bad.json",
            ],
            "INVALID_ARGUMENT",
        ),
        (
            vec!["space", "meta", "set", "--cover-file", "input/missing.json"],
            "INPUT_UNREADABLE",
        ),
    ] {
        let (exit, value) = json(&root, &args, None);
        assert_eq!(exit, 2, "{args:?}: {value}");
        assert_eq!(code(&value), expected, "{args:?}");
    }
    let usage = svode(&root, &["page", "write", "--path", "notes.md"]);
    assert_eq!(usage.status.code(), Some(2));
    assert!(usage.stdout.is_empty());
    assert!(String::from_utf8(usage.stderr).unwrap().contains("Usage"));
    assert_eq!(snapshot(&root), before);
}

#[test]
fn write_help_shows_the_safe_cycle_without_a_project() {
    let temp = tempfile::tempdir().unwrap();
    for command in [
        &["page", "create"][..],
        &["page", "write"],
        &["page", "meta", "set"],
        &["space", "readme", "write"],
        &["space", "meta", "set"],
        &["collection", "readme", "write"],
        &["collection", "meta", "set"],
        &["item", "write"],
        &["item", "fields", "set"],
        &["item", "meta", "set"],
    ] {
        let mut args = vec!["--project", "/definitely/missing"];
        args.extend_from_slice(command);
        args.push("--help");
        let output = svode(temp.path(), &args);
        assert_eq!(output.status.code(), Some(0), "{command:?}");
        let help = String::from_utf8(output.stdout).unwrap();
        for expected in ["Safe cycle", "--body-file -", "MODE_UNAVAILABLE", "Example"] {
            assert!(help.contains(expected), "{command:?}: {expected}\n{help}");
        }
        assert!(!help.contains("--force"), "{command:?}");
    }
    assert!(fs::read_dir(temp.path()).unwrap().next().is_none());
}

//! Page, owner and item writes through the real `svode` binary with the
//! desktop app closed. Body writes are served from a read source version
//! (their cycle is covered by `source_write_process`); the other writes
//! answer `MODE_UNAVAILABLE` and change nothing until the headless runtime
//! serves them. Grammar and input fail before either with exit 2.

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

/// Writes the headless runtime of this build does not serve yet, with
/// readable input.
const UNSERVED_WRITES: [&[&str]; 6] = [
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
    &["page", "meta", "set", "--path", "notes.md", "--icon", "x"],
    &["space", "meta", "set", "--clear-description"],
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

/// Body writes with a body but without `--source-version`.
const UNVERSIONED_BODY_WRITES: [&[&str]; 4] = [
    &[
        "page",
        "write",
        "--path",
        "notes.md",
        "--body-file",
        "input/body.md",
    ],
    &["space", "readme", "write", "--body", "Owner"],
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
        "item",
        "write",
        "--path",
        "tasks/alpha.md",
        "--body-file",
        "input/body.md",
    ],
];

#[test]
fn unserved_standalone_writes_are_mode_unavailable_and_change_nothing() {
    let (_temp, root) = fixture();
    let before = snapshot(&root);
    for args in UNSERVED_WRITES {
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
        &[
            "item",
            "fields",
            "set",
            "--path",
            "tasks/alpha.md",
            "--fields-file",
            "-",
        ],
        Some(r#"{"Status":"Piped"}"#),
    );
    assert_eq!((exit, code(&value)), (1, "MODE_UNAVAILABLE"));
    assert_eq!(snapshot(&root), before);
}

#[test]
fn a_body_write_without_a_source_version_is_an_argument_error_without_effects() {
    let (_temp, root) = fixture();
    let before = snapshot(&root);
    for args in UNVERSIONED_BODY_WRITES {
        let (exit, value) = json(&root, args, None);
        assert_eq!(exit, 2, "{args:?}: {value}");
        assert_eq!(code(&value), "INVALID_ARGUMENT", "{args:?}");
        let human = svode(&root, args);
        assert_eq!(human.status.code(), Some(2), "{args:?}");
        assert!(
            String::from_utf8(human.stderr)
                .unwrap()
                .contains("--source-version"),
            "{args:?}"
        );
    }
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
            vec![
                "page",
                "write",
                "--path",
                "notes.md",
                "--source-version",
                "v",
            ],
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
                "--source-version",
                "v",
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
                "--source-version",
                "v",
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
    let body_writes = [
        &["page", "write"][..],
        &["space", "readme", "write"],
        &["collection", "readme", "write"],
        &["item", "write"],
    ];
    let other_writes = [
        &["page", "create"][..],
        &["page", "meta", "set"],
        &["space", "meta", "set"],
        &["collection", "meta", "set"],
        &["item", "fields", "set"],
        &["item", "meta", "set"],
    ];
    for (command, body_write) in body_writes
        .iter()
        .map(|command| (command, true))
        .chain(other_writes.iter().map(|command| (command, false)))
    {
        let mut args = vec!["--project", "/definitely/missing"];
        args.extend_from_slice(command);
        args.push("--help");
        let output = svode(temp.path(), &args);
        assert_eq!(output.status.code(), Some(0), "{command:?}");
        let help = String::from_utf8(output.stdout).unwrap();
        for expected in ["Safe cycle", "--body-file -", "Example"] {
            assert!(help.contains(expected), "{command:?}: {expected}\n{help}");
        }
        // Body writes are served: read -> edit -> write --source-version,
        // and file-access clients edit the body themselves.
        for expected in [
            "--source-version",
            "SOURCE_STALE",
            "SOURCE_BUSY",
            "own tools",
        ] {
            assert_eq!(
                help.contains(expected),
                body_write,
                "{command:?}: {expected}"
            );
        }
        assert_eq!(
            help.contains("MODE_UNAVAILABLE"),
            !body_write,
            "{command:?}"
        );
        assert!(!help.contains("--force"), "{command:?}");
    }
    assert!(fs::read_dir(temp.path()).unwrap().next().is_none());
}

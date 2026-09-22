//! Routine definition commands through the real `svode` binary with the
//! desktop app closed. Until the headless runtime connects the Routine
//! stores they answer `MODE_UNAVAILABLE` and change nothing; grammar and
//! input still fail first, and `routine run` is not part of the CLI.

mod common;

use std::path::PathBuf;

use common::process::{code, json, snapshot, svode, write};

const DEFINITION: &str = r#"{"name":"Review","trigger":{"type":"manual"},"action":{"type":"run_agent","executor":"agent:01arz3ndektsv4rrffq69g5fav"},"body":"Review."}"#;

fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    let root = base.join("project");
    write(&root.join(".svode/config.json"), r#"{"name":"Project"}"#);
    write(&root.join("README.md"), "---\ntitle: Project\n---\n");
    write(&root.join("tasks/schema.yaml"), "columns: []\nviews: []\n");
    write(&root.join("tasks/README.md"), "---\ntitle: Tasks\n---\n");
    let elsewhere = base.join("elsewhere");
    write(&elsewhere.join("routine.json"), DEFINITION);
    write(&elsewhere.join("broken.json"), "{ not json");
    (temp, root, elsewhere)
}

#[test]
fn standalone_routine_commands_are_mode_unavailable_and_change_nothing() {
    let (_temp, root, elsewhere) = fixture();
    let definition = elsewhere.join("routine.json");
    let definition = definition.to_str().unwrap();
    let before = snapshot(&root);
    for (args, stdin) in [
        (vec!["routine", "list", "--collection", "tasks"], None),
        (
            vec![
                "routine",
                "get",
                "--collection",
                "tasks",
                "--id",
                "routine:x",
            ],
            None,
        ),
        (
            vec![
                "routine",
                "create",
                "--collection",
                "tasks",
                "--definition-file",
                definition,
            ],
            None,
        ),
        (
            vec![
                "routine",
                "create",
                "--definition-file",
                "-",
                "--confirm-automatic-execution",
            ],
            Some(DEFINITION),
        ),
        (
            vec![
                "routine",
                "update",
                "--collection",
                "tasks",
                "--id",
                "routine:x",
                "--fingerprint",
                "f",
                "--definition-file",
                definition,
            ],
            None,
        ),
        (
            vec![
                "routine",
                "delete",
                "--collection",
                "tasks",
                "--id",
                "routine:x",
                "--fingerprint",
                "f",
            ],
            None,
        ),
    ] {
        let (exit, value) = json(&root, &args, stdin);
        assert_eq!(exit, 1, "{args:?}: {value}");
        assert_eq!(code(&value), "MODE_UNAVAILABLE", "{args:?}");
        let target = &value["error"]["target"];
        assert_eq!(target["spaceId"], "root", "{args:?}");
        if args.contains(&"--collection") {
            assert_eq!(target["collection"], "tasks", "{args:?}");
        }
        if args.contains(&"--id") {
            assert_eq!(target["id"], "routine:x", "{args:?}");
        }
    }
    let human = svode(&root, &["routine", "list"]);
    assert_eq!(human.status.code(), Some(1));
    assert!(human.stdout.is_empty());
    assert!(
        String::from_utf8(human.stderr)
            .unwrap()
            .contains("MODE_UNAVAILABLE")
    );
    assert_eq!(snapshot(&root), before);
    assert!(!root.join(".svode/routines.db").exists());
}

#[test]
fn routine_grammar_and_input_fail_before_the_command_runs() {
    let (_temp, root, _elsewhere) = fixture();
    let before = snapshot(&root);
    for (args, expected) in [
        (
            vec!["routine", "run", "--id", "routine:x"],
            "INVALID_ARGUMENT",
        ),
        (vec!["routine", "create"], "INVALID_ARGUMENT"),
        (vec!["routine", "get"], "INVALID_ARGUMENT"),
        (
            vec![
                "routine",
                "update",
                "--id",
                "routine:x",
                "--definition-file",
                "../elsewhere/routine.json",
            ],
            "INVALID_ARGUMENT",
        ),
        (
            vec!["routine", "delete", "--id", "routine:x"],
            "INVALID_ARGUMENT",
        ),
        (
            vec![
                "routine",
                "create",
                "--definition-file",
                "../elsewhere/broken.json",
            ],
            "INVALID_ARGUMENT",
        ),
        (
            vec!["routine", "create", "--definition-file", "missing.json"],
            "INPUT_UNREADABLE",
        ),
        (
            vec!["routine", "create", "--definition-file", "tasks"],
            "INPUT_UNREADABLE",
        ),
        (
            vec![
                "routine",
                "delete",
                "--id",
                "routine:x",
                "--fingerprint",
                "f",
                "--force",
            ],
            "INVALID_ARGUMENT",
        ),
    ] {
        let (exit, value) = json(&root, &args, None);
        assert_eq!(exit, 2, "{args:?}: {value}");
        assert_eq!(code(&value), expected, "{args:?}");
    }
    assert_eq!(snapshot(&root), before);
}

#[test]
fn routine_help_works_without_a_project_and_hides_run() {
    let temp = tempfile::tempdir().unwrap();
    let output = svode(temp.path(), &["routine", "--help"]);
    assert_eq!(output.status.code(), Some(0));
    let help = String::from_utf8(output.stdout).unwrap();
    for verb in ["list", "get", "create", "update", "delete"] {
        assert!(help.contains(&format!("  {verb} ")), "{help}");
    }
    assert!(!help.contains("  run "), "{help}");
    for (verb, cas, candidate) in [
        ("list", false, false),
        ("get", false, false),
        ("create", false, true),
        ("update", true, true),
        ("delete", true, false),
    ] {
        let output = svode(temp.path(), &["routine", verb, "--help"]);
        assert_eq!(output.status.code(), Some(0), "{verb}");
        let help = String::from_utf8(output.stdout).unwrap();
        assert!(help.contains("Example"), "{verb}: {help}");
        assert!(help.contains("MODE_UNAVAILABLE"), "{verb}: {help}");
        assert!(help.contains("--collection"), "{verb}: {help}");
        assert_eq!(
            help.contains("ROUTINE_FINGERPRINT_CONFLICT"),
            cas,
            "{verb}: {help}"
        );
        assert_eq!(
            help.contains("--confirm-automatic-execution"),
            candidate,
            "{verb}: {help}"
        );
    }
}

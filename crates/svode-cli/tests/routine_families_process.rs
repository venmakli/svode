//! Routine definition commands through the real `svode` binary with the
//! desktop app closed: the shared Routine service over the operational
//! store of the owner, with owner resolution, compare-and-set, the
//! automation acknowledgement and the Routine origin of a process started
//! from a Routine launch. Grammar and input still fail first, and
//! `routine run` is not part of the CLI.

mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use common::process::{ROUTINE_CALLER_TOKEN, code, json, json_with, snapshot, svode, write};
use serde_json::{Value, json};

const ACTOR: &str = "01arz3ndektsv4rrffq69g5fav";
const DEFINITION: &str = r#"{"name":"Review","trigger":{"type":"manual"},"action":{"type":"run_agent","executor":"agent:01arz3ndektsv4rrffq69g5fav"},"body":"Review."}"#;

fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    let root = base.join("project");
    write(
        &root.join(".svode/config.json"),
        r#"{"name":"Project","spaces":[{"id":"child","path":"child","repo":null}]}"#,
    );
    write(
        &root.join(".svode/agent-actors.json"),
        &json!({
            "schemaVersion": 1,
            "actors": [{ "id": ACTOR, "name": "Reviewer", "adapters": [{ "adapter": "codex" }] }]
        })
        .to_string(),
    );
    write(&root.join("README.md"), "---\ntitle: Project\n---\n");
    write(&root.join("notes.md"), "---\ntitle: Notes\n---\n");
    write(
        &root.join("tasks/schema.yaml"),
        "columns:\n  - name: Status\n    type: text\nviews: []\n",
    );
    write(&root.join("tasks/README.md"), "---\ntitle: Tasks\n---\n");
    write(
        &root.join("child/.svode/config.json"),
        r#"{"name":"Child"}"#,
    );
    write(&root.join("child/README.md"), "---\ntitle: Child\n---\n");
    write(
        &root.join("child/notes/README.md"),
        "---\ntitle: Notes\n---\n",
    );
    let elsewhere = base.join("elsewhere");
    write(&elsewhere.join("routine.json"), DEFINITION);
    write(
        &elsewhere.join("renamed.json"),
        &DEFINITION.replace("\"Review\"", "\"Weekly review\""),
    );
    write(
        &elsewhere.join("automatic.json"),
        r#"{"name":"On created","enabled":true,"trigger":{"type":"event","event":"collection.entry_created"},"action":{"type":"update_properties","target":"trigger.entry","set":{"Status":"New"}},"body":"Managed."}"#,
    );
    write(
        &elsewhere.join("unknown-executor.json"),
        &DEFINITION.replace(ACTOR, "01bx5zzkbkactav9wevgemmvrz"),
    );
    write(&elsewhere.join("broken.json"), "{ not json");
    (temp, root, elsewhere)
}

/// Commits the fixture; `None` without a Git binary.
fn commit(root: &Path) -> Option<String> {
    let git = |args: &[&str]| {
        Command::new("git")
            .args(args)
            .current_dir(root)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8(output.stdout).unwrap())
    };
    git(&["init", "-q"])?;
    git(&["config", "user.email", "agent@example.com"])?;
    git(&["config", "user.name", "Agent"])?;
    git(&["add", "-A"])?;
    git(&["commit", "-q", "-m", "fixture"])?;
    git(&["rev-parse", "HEAD"])
}

fn head(root: &Path) -> String {
    String::from_utf8(
        Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(root)
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
}

fn routine_files(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir.join(".routines")) else {
        return Vec::new();
    };
    let mut names = entries
        .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
        .collect::<Vec<_>>();
    names.sort();
    names
}

fn ok(root: &Path, args: &[&str]) -> Value {
    let (exit, value) = json(root, args, None);
    assert_eq!(exit, 0, "{args:?}: {value}");
    value
}

fn refused(root: &Path, args: &[&str]) -> Value {
    let (exit, value) = json(root, args, None);
    assert_eq!(exit, 1, "{args:?}: {value}");
    value
}

#[test]
fn routine_definition_commands_are_served_with_owner_cas_and_acknowledgement() {
    let (_temp, root, elsewhere) = fixture();
    let Some(head_before) = commit(&root) else {
        return;
    };
    let file = |name: &str| elsewhere.join(name).to_string_lossy().to_string();
    let (routine, renamed, automatic, unknown) = (
        file("routine.json"),
        file("renamed.json"),
        file("automatic.json"),
        file("unknown-executor.json"),
    );

    // The Space owner is the selected Space; a page read opens no store.
    ok(&root, &["page", "read", "--path", "notes.md"]);
    assert!(!root.join(".svode/routines.db").exists());
    let empty = ok(&root, &["routine", "list"]);
    assert_eq!(empty["total"], 0, "{empty}");
    assert_eq!(empty["owner"]["kind"], "project", "{empty}");
    assert_eq!(empty["automaticAuthorityEnabled"], false, "{empty}");
    assert!(root.join(".svode/routines.db").is_file());

    let created = ok(
        &root,
        &[
            "routine",
            "create",
            "--collection",
            "tasks",
            "--definition-file",
            &routine,
        ],
    );
    assert_eq!(created["target"]["collection"], "tasks", "{created}");
    assert_eq!(created["owner"]["ownerPath"], "tasks", "{created}");
    assert_eq!(
        created["changedPaths"],
        json!(["tasks/.routines/Review.md"])
    );
    let id = created["routineId"].as_str().unwrap().to_string();
    let first = created["fingerprint"].as_str().unwrap().to_string();
    assert_eq!(routine_files(&root.join("tasks")), ["Review.md"]);

    let read = ok(
        &root,
        &["routine", "get", "--collection", "tasks", "--id", &id],
    );
    assert_eq!(read["fingerprint"], first.as_str());
    assert_eq!(read["definition"]["name"], "Review");
    let human = svode(&root, &["routine", "list", "--collection", "tasks"]);
    assert_eq!(human.status.code(), Some(0));
    let human = String::from_utf8(human.stdout).unwrap();
    assert!(human.contains(&id) && human.contains("Review"), "{human}");

    let updated = ok(
        &root,
        &[
            "routine",
            "update",
            "--collection",
            "tasks",
            "--id",
            &id,
            "--fingerprint",
            &first,
            "--definition-file",
            &renamed,
        ],
    );
    let current = updated["fingerprint"].as_str().unwrap().to_string();
    assert_eq!(routine_files(&root.join("tasks")), ["Weekly review.md"]);

    // A stale fingerprint changes nothing and names the current one.
    let stale = refused(
        &root,
        &[
            "routine",
            "update",
            "--collection",
            "tasks",
            "--id",
            &id,
            "--fingerprint",
            &first,
            "--definition-file",
            &routine,
        ],
    );
    assert_eq!(code(&stale), "ROUTINE_FINGERPRINT_CONFLICT");
    assert_eq!(stale["error"]["currentFingerprint"], current.as_str());
    assert_eq!(stale["error"]["target"]["id"], id.as_str());
    assert_eq!(routine_files(&root.join("tasks")), ["Weekly review.md"]);

    // Enabled automation needs the acknowledgement and grants no device
    // authority; an invalid candidate writes nothing.
    let unconfirmed = refused(
        &root,
        &[
            "routine",
            "create",
            "--collection",
            "tasks",
            "--definition-file",
            &automatic,
        ],
    );
    assert_eq!(
        code(&unconfirmed),
        "ROUTINE_AUTOMATIC_CONFIRMATION_REQUIRED"
    );
    let invalid = refused(
        &root,
        &[
            "routine",
            "create",
            "--collection",
            "tasks",
            "--definition-file",
            &unknown,
        ],
    );
    assert_eq!(code(&invalid), "ROUTINE_INVALID");
    assert_eq!(routine_files(&root.join("tasks")), ["Weekly review.md"]);
    let confirmed = ok(
        &root,
        &[
            "routine",
            "create",
            "--collection",
            "tasks",
            "--definition-file",
            &automatic,
            "--confirm-automatic-execution",
        ],
    );
    assert_eq!(confirmed["detail"]["definition"]["enabled"], true);
    assert_eq!(confirmed["detail"]["automaticAuthorityEnabled"], false);

    let deleted = ok(
        &root,
        &[
            "routine",
            "delete",
            "--collection",
            "tasks",
            "--id",
            &id,
            "--fingerprint",
            &current,
        ],
    );
    assert_eq!(
        deleted["changedPaths"],
        json!(["tasks/.routines/Weekly review.md"])
    );
    let gone = refused(
        &root,
        &["routine", "get", "--collection", "tasks", "--id", &id],
    );
    assert_eq!(code(&gone), "ROUTINE_NOT_FOUND");
    assert_eq!(routine_files(&root.join("tasks")), ["On created.md"]);

    // A child Space owns its Routines, selected explicitly or by the
    // current directory.
    let child = ok(
        &root,
        &[
            "--space",
            "child",
            "routine",
            "create",
            "--definition-file",
            &routine,
        ],
    );
    assert_eq!(child["owner"]["spaceId"], "child", "{child}");
    assert_eq!(routine_files(&root.join("child")), ["Review.md"]);
    let from_cwd = ok(&root.join("child/notes"), &["routine", "list"]);
    assert_eq!(from_cwd["target"]["spaceId"], "child", "{from_cwd}");
    assert_eq!(from_cwd["total"], 1, "{from_cwd}");
    assert!(root.join("child/.svode/routines.db").is_file());
    assert!(routine_files(&root).is_empty());

    assert_eq!(head(&root), head_before, "no commit");
    let local: Value =
        serde_json::from_str(&fs::read_to_string(root.join(".svode/local.json")).unwrap()).unwrap();
    assert!(
        local["routines"]["automaticAuthority"]
            .as_object()
            .is_none_or(serde_json::Map::is_empty),
        "{local}"
    );
}

#[test]
fn a_command_started_from_a_routine_launch_cannot_save_enabled_automation() {
    let (_temp, root, elsewhere) = fixture();
    if commit(&root).is_none() {
        return;
    }
    let automatic = elsewhere.join("automatic.json");
    let routine = elsewhere.join("routine.json");
    let token = [(ROUTINE_CALLER_TOKEN, "opaque-token")];
    let (exit, value) = json_with(
        &root,
        &[
            "routine",
            "create",
            "--collection",
            "tasks",
            "--definition-file",
            automatic.to_str().unwrap(),
            "--confirm-automatic-execution",
        ],
        None,
        &token,
    );
    assert_eq!(exit, 1, "{value}");
    assert_eq!(code(&value), "ROUTINE_RECURSION_GUARD");
    assert!(routine_files(&root.join("tasks")).is_empty());
    let (exit, value) = json_with(
        &root,
        &[
            "routine",
            "create",
            "--definition-file",
            routine.to_str().unwrap(),
        ],
        None,
        &token,
    );
    assert_eq!(exit, 0, "{value}");
    assert_eq!(routine_files(&root), ["Review.md"]);
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
        assert!(!help.contains("MODE_UNAVAILABLE"), "{verb}: {help}");
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

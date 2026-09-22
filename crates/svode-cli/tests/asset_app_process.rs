//! Managed asset import and App manifest validation through the real
//! `svode` binary with the desktop app closed. Validation needs no Project
//! and runs standalone; until the headless runtime is connected the import
//! answers `MODE_UNAVAILABLE` and changes nothing.

mod common;

use std::fs;
use std::path::PathBuf;

use common::process::{code, json, snapshot, svode, write};
use serde_json::{Value, json};

const PROCESS_APP: &str = "runtime:\n  type: process\n  start:\n    argv: [tool]\n  url: http://127.0.0.1:3210\nenvironment:\n  TOKEN: ${API_TOKEN}\n  REGION: ${REGION}-eu\n";

fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    let root = base.join("project");
    write(&root.join(".svode/config.json"), r#"{"name":"Project"}"#);
    write(&root.join("README.md"), "---\ntitle: Project\n---\n");
    write(&root.join("notes.md"), "---\ntitle: Notes\n---\nBody\n");
    let elsewhere = base.join("elsewhere");
    write(&elsewhere.join("photo.png"), "image");
    write(&elsewhere.join("app.yaml"), PROCESS_APP);
    write(
        &elsewhere.join("broken.yaml"),
        "runtime:\n  type: process\n  start:\n    argv: []\n",
    );
    (temp, root, elsewhere)
}

#[test]
fn app_validate_needs_no_project_and_reports_diagnostics_as_a_result() {
    let (_temp, root, elsewhere) = fixture();
    let before = snapshot(&root);

    let (exit, valid) = json(&elsewhere, &["app", "validate", "--file", "app.yaml"], None);
    assert_eq!(exit, 0, "{valid}");
    assert_eq!(valid["ok"], true);
    assert_eq!(valid["target"], json!({}));
    assert_eq!(valid["valid"], true);
    assert_eq!(valid["runtimeType"], "process");
    assert_eq!(valid["settingsReferences"], json!(["API_TOKEN", "REGION"]));
    assert_eq!(valid["diagnostics"], json!([]));

    // Project selectors do not matter to a Project-free command.
    let (exit, stdin) = json(
        &root,
        &["--project", "missing", "app", "validate", "--file", "-"],
        Some(PROCESS_APP),
    );
    assert_eq!(exit, 0, "{stdin}");
    assert_eq!(stdin["valid"], true);

    let (exit, invalid) = json(
        &elsewhere,
        &["app", "validate", "--file", "broken.yaml"],
        None,
    );
    assert_eq!(exit, 0, "{invalid}");
    assert_eq!(invalid["ok"], true);
    assert_eq!(invalid["valid"], false);
    assert_eq!(invalid["runtimeType"], Value::Null);
    let diagnostics = invalid["diagnostics"].as_array().unwrap();
    assert!(!diagnostics.is_empty());
    assert!(diagnostics.iter().all(|diagnostic| {
        diagnostic["code"].is_string()
            && diagnostic["path"].is_string()
            && diagnostic["message"].is_string()
    }));

    let (exit, oversized) = json(
        &elsewhere,
        &["app", "validate", "--file", "-"],
        Some(&" ".repeat(64 * 1024 + 1)),
    );
    assert_eq!(exit, 0);
    assert_eq!(oversized["valid"], false);
    assert_eq!(oversized["diagnostics"][0]["code"], "resource_limit");

    let human = svode(&elsewhere, &["app", "validate", "--file", "app.yaml"]);
    assert_eq!(human.status.code(), Some(0));
    assert_eq!(
        String::from_utf8(human.stdout).unwrap(),
        "valid process App\nsetting API_TOKEN\nsetting REGION\n"
    );
    let human = svode(&elsewhere, &["app", "validate", "--file", "broken.yaml"]);
    assert_eq!(human.status.code(), Some(0));
    let stdout = String::from_utf8(human.stdout).unwrap();
    assert!(stdout.starts_with("invalid\n"), "{stdout}");
    assert!(stdout.lines().count() > 1, "{stdout}");

    // Nothing is written anywhere.
    assert_eq!(snapshot(&root), before);
    assert_eq!(
        fs::read_dir(&elsewhere).unwrap().count(),
        3,
        "no files next to the candidate"
    );
}

#[test]
fn app_validate_input_failures_exit_two() {
    let (_temp, _root, elsewhere) = fixture();
    fs::write(elsewhere.join("latin1.yaml"), [0x72, 0xe9, 0x0a]).unwrap();
    for (args, expected) in [
        (
            vec!["app", "validate", "--file", "absent.yaml"],
            "INPUT_UNREADABLE",
        ),
        (
            vec!["app", "validate", "--file", "latin1.yaml"],
            "INPUT_UNREADABLE",
        ),
        (vec!["app", "validate", "--file", "."], "INPUT_UNREADABLE"),
        (vec!["app", "validate"], "INVALID_ARGUMENT"),
        (vec!["app", "validate", "--yaml", "x"], "INVALID_ARGUMENT"),
    ] {
        let (exit, value) = json(&elsewhere, &args, None);
        assert_eq!(exit, 2, "{args:?}: {value}");
        assert_eq!(code(&value), expected, "{args:?}");
    }
}

#[test]
fn standalone_asset_import_is_mode_unavailable_and_changes_nothing() {
    let (_temp, root, elsewhere) = fixture();
    let before = snapshot(&root);
    let photo = elsewhere.join("photo.png");
    let photo = photo.to_str().unwrap();

    let (exit, value) = json(
        &root,
        &[
            "asset",
            "import",
            "--path",
            "notes.md",
            "--file",
            photo,
            "--name",
            "chart.png",
        ],
        None,
    );
    assert_eq!(exit, 1, "{value}");
    assert_eq!(code(&value), "MODE_UNAVAILABLE");
    assert_eq!(value["error"]["target"]["path"], "notes.md");
    assert_eq!(value["error"]["target"]["spaceId"], "root");

    let human = svode(
        &root,
        &["asset", "import", "--path", "notes.md", "--file", photo],
    );
    assert_eq!(human.status.code(), Some(1));
    assert!(human.stdout.is_empty());
    assert!(
        String::from_utf8(human.stderr)
            .unwrap()
            .contains("MODE_UNAVAILABLE")
    );
    assert_eq!(snapshot(&root), before);
    assert!(elsewhere.join("photo.png").is_file(), "source kept");
}

#[test]
fn asset_import_grammar_fails_before_the_command_runs() {
    let (_temp, root, _elsewhere) = fixture();
    let before = snapshot(&root);
    for args in [
        vec!["asset", "import", "--path", "notes.md"],
        vec!["asset", "import", "--file", "photo.png"],
        vec![
            "asset", "import", "--path", "notes.md", "--file", "x", "--force",
        ],
        vec!["asset", "upload", "--path", "notes.md", "--file", "x"],
    ] {
        let (exit, value) = json(&root, &args, None);
        assert_eq!(exit, 2, "{args:?}: {value}");
        assert_eq!(code(&value), "INVALID_ARGUMENT", "{args:?}");
    }
    assert_eq!(snapshot(&root), before);
}

#[test]
fn asset_and_app_help_work_without_a_project() {
    let temp = tempfile::tempdir().unwrap();
    for (args, mode) in [
        (vec!["asset", "import", "--help"], true),
        (vec!["app", "validate", "--help"], false),
    ] {
        let output = svode(temp.path(), &args);
        assert_eq!(output.status.code(), Some(0), "{args:?}");
        let help = String::from_utf8(output.stdout).unwrap();
        assert!(help.contains("Example"), "{args:?}: {help}");
        assert_eq!(help.contains("MODE_UNAVAILABLE"), mode, "{args:?}: {help}");
    }
    for noun in ["asset", "app"] {
        let output = svode(temp.path(), &[noun, "--help"]);
        assert_eq!(output.status.code(), Some(0), "{noun}");
    }
}

//! JSON, exit and output contract of every public command through the real
//! `svode` binary with the desktop app closed. Served commands succeed, and
//! served body writes from a version of no read are refused as stale; the
//! Routine store commands answer `MODE_UNAVAILABLE` until the headless
//! runtime serves them.
//! A served mutation runs on a fresh fixture in each output mode; no other
//! command changes a source file: index-backed reads only add the derived
//! index and the device-local stores it keeps in `.svode/`.

mod common;

use std::process::{Command, Stdio};

use common::commands::{CASES, Case, STALE, argv, command_paths, fixture};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use common::process::{BIN, json, snapshot, svode};
use serde_json::Value;
use svode_tools::catalog;
use svode_tools::host::ToolHost;
use svode_tools::standalone::StandaloneHost;

/// Files of `root` without the derived index, its Routine projection and
/// the device-local stores next to them.
fn sources(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut files = snapshot(root);
    files.retain(|path, _| {
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        let derived = name.starts_with("index.db")
            || name.starts_with("routines.db")
            || name == "local.json"
            || name == "variables.lock"
            || name == "write.lock";
        !(derived
            && path
                .parent()
                .is_some_and(|parent| parent.ends_with(".svode")))
    });
    files
}

fn served(tools: &[&str]) -> bool {
    tools
        .iter()
        .all(|tool| StandaloneHost::new("test").serves_tool(tool))
}

/// A served mutation that applies, so each run needs its own fixture.
fn applies(case: &Case) -> bool {
    served(case.tools)
        && !case.argv.contains(&STALE)
        && case
            .tools
            .iter()
            .any(|tool| catalog::is_mutating_tool(tool) == Some(true))
}

#[test]
fn every_command_keeps_the_json_envelope_exit_codes_and_output_streams() {
    let shared = fixture();
    let before = sources(shared.temp.path());
    for case in CASES {
        let (own_json, own_human) = if applies(case) {
            (Some(fixture()), Some(fixture()))
        } else {
            (None, None)
        };
        let fixture = own_json.as_ref().unwrap_or(&shared);
        let args = argv(fixture, case);
        let (exit, value) = json(&fixture.input, &args, None);
        assert_eq!(value["schemaVersion"], 1, "{}: {value}", case.name);
        let refused = if !served(case.tools) {
            Some("MODE_UNAVAILABLE")
        } else if args.contains(&STALE) {
            Some("SOURCE_STALE")
        } else {
            None
        };
        if let Some(code) = refused {
            assert_eq!(exit, 1, "{}: {value}", case.name);
            assert_eq!(value["ok"], false, "{}", case.name);
            let error = &value["error"];
            assert_eq!(error["code"], code, "{}", case.name);
            assert!(error["message"].is_string(), "{}", case.name);
            assert_eq!(
                error["target"]["projectPath"],
                fixture.project.to_str().unwrap(),
                "{}: failure keeps the resolved target",
                case.name
            );
        } else {
            assert_eq!(exit, 0, "{}: {value}", case.name);
            assert_eq!(value["ok"], true, "{}", case.name);
            assert!(value["target"].is_object(), "{}: {value}", case.name);
            assert!(value.get("error").is_none(), "{}", case.name);
            if applies(case) {
                assert!(
                    !value["changedPaths"].as_array().unwrap().is_empty(),
                    "{}: {value}",
                    case.name
                );
            }
        }
        if value["ok"] == true && case.name != "app validate" && case.name != "guide" {
            assert_eq!(
                value["target"]["projectPath"],
                fixture.project.to_str().unwrap(),
                "{}",
                case.name
            );
            assert_eq!(value["target"]["spaceId"], "root", "{}", case.name);
        }

        // Human mode: the same exit; a result on stdout, or the code and
        // target on stderr with nothing on stdout.
        let fixture = own_human.as_ref().unwrap_or(&shared);
        let args = argv(fixture, case);
        let human = svode(&fixture.input, &args);
        assert_eq!(human.status.code(), Some(exit), "{}", case.name);
        let stdout = String::from_utf8(human.stdout).unwrap();
        let stderr = String::from_utf8(human.stderr).unwrap();
        if exit == 0 {
            assert!(!stdout.trim().is_empty(), "{}", case.name);
            assert!(
                serde_json::from_str::<Value>(&stdout)
                    .map_or(true, |value| value.get("schemaVersion").is_none()),
                "{}: human output is not the JSON envelope",
                case.name
            );
        } else {
            assert!(stdout.is_empty(), "{}: {stdout}", case.name);
            assert!(
                stderr.starts_with(&format!("error[{}]", refused.unwrap())),
                "{}: {stderr}",
                case.name
            );
            assert!(stderr.contains("target: "), "{}: {stderr}", case.name);
        }
    }
    assert_eq!(sources(shared.temp.path()), before);
}

#[test]
fn every_command_rejects_an_unknown_flag_with_exit_two_and_usage() {
    let fixture = fixture();
    for case in CASES {
        let mut args = argv(&fixture, case);
        args.push("--no-such-flag");
        let (exit, value) = json(&fixture.input, &args, None);
        assert_eq!(exit, 2, "{}: {value}", case.name);
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["error"]["code"], "INVALID_ARGUMENT", "{}", case.name);

        let human = svode(&fixture.input, &args);
        assert_eq!(human.status.code(), Some(2), "{}", case.name);
        assert!(human.stdout.is_empty(), "{}", case.name);
        let stderr = String::from_utf8(human.stderr).unwrap();
        assert!(stderr.contains("Usage:"), "{}: {stderr}", case.name);
    }
}

/// Root, every noun, verb group and command explain themselves with a
/// working example, outside any Project and without a runtime.
#[test]
fn every_help_page_has_an_example_and_needs_no_project() {
    let empty = tempfile::tempdir().unwrap();
    let mut paths = vec![String::new()];
    paths.extend(command_paths().into_iter().map(|(path, _)| path));
    for path in paths {
        let mut args = path.split_whitespace().collect::<Vec<_>>();
        args.push("--help");
        let output = Command::new(BIN)
            .args(&args)
            .current_dir(empty.path())
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(0), "{path}");
        assert!(output.stderr.is_empty(), "{path}");
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert!(stdout.contains("Usage: svode"), "{path}: {stdout}");
        assert!(
            stdout.contains("Example"),
            "`svode {path} --help`: {stdout}"
        );
        assert!(!stdout.contains("run_routine"), "{path}");
    }
    let routine = svode(empty.path(), &["routine", "--help"]);
    let routine = String::from_utf8(routine.stdout).unwrap();
    assert!(
        !routine
            .lines()
            .any(|line| line.trim_start().starts_with("run"))
    );
    assert!(empty.path().read_dir().unwrap().next().is_none());
}

//! Diagnostic log of the real `svode` binary with the desktop app closed:
//! `tracing` events of the libraries reach stderr without ANSI escapes,
//! `warn` and above by default and what `RUST_LOG` selects otherwise, while
//! stdout keeps exactly the command result and a failed stderr write
//! changes nothing.

mod common;

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use common::process::{BIN, TEST_IDENTIFIER, write};
use serde_json::Value;

const ORDER_WARNING: &str = "cannot be read, using default order";

fn git(root: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(root)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?}");
}

/// Committed project whose root page order file holds Git conflict markers.
fn fixture() -> (tempfile::TempDir, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap().join("project");
    write(&root.join(".svode/config.json"), r#"{"name":"Project"}"#);
    write(&root.join("README.md"), "---\ntitle: Project\n---\n");
    write(&root.join("notes.md"), "---\ntitle: Notes\n---\nBody\n");
    write(
        &root.join(".svode/order.json"),
        "<<<<<<< HEAD\n{\"\":[\"notes.md\"]}\n=======\n{}\n>>>>>>> other\n",
    );
    git(&root, &["init", "-q"]);
    git(&root, &["config", "user.email", "agent@example.com"]);
    git(&root, &["config", "user.name", "Agent"]);
    git(&root, &["config", "maintenance.auto", "false"]);
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-q", "-m", "fixture"]);
    (temp, root)
}

fn command(root: &Path, title: &str, rust_log: Option<&str>) -> Command {
    let mut command = Command::new(BIN);
    command
        .args(["page", "create", "--parent", "", "--title", title, "--json"])
        .current_dir(root)
        .env("SVODE_PRODUCT_IDENTIFIER", TEST_IDENTIFIER)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env_remove("NO_COLOR")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    match rust_log {
        Some(directives) => command.env("RUST_LOG", directives),
        None => command.env_remove("RUST_LOG"),
    };
    command
}

/// The single JSON object of a successful command.
fn result(output: &Output) -> Value {
    let stdout = String::from_utf8(output.stdout.clone()).unwrap();
    assert_eq!(output.status.code(), Some(0), "{stdout}");
    assert_eq!(stdout.lines().count(), 1, "{stdout}");
    let value: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(value["ok"], true, "{value}");
    value
}

#[test]
fn library_warnings_reach_stderr_and_leave_the_json_result_alone() {
    let (_temp, root) = fixture();
    let output = command(&root, "Logged", None).output().unwrap();
    let value = result(&output);
    assert_eq!(value["page"]["path"], "Logged.md", "{value}");

    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr
            .lines()
            .any(|line| line.contains("WARN svode_core::content_tree:")
                && line.contains(ORDER_WARNING)),
        "{stderr}"
    );
    assert!(!stderr.contains("INFO"), "{stderr}");
    assert!(!stderr.contains("DEBUG"), "{stderr}");
    assert!(!stderr.contains('\u{1b}'), "{stderr}");
}

#[test]
fn rust_log_replaces_the_default_level() {
    let (_temp, root) = fixture();
    let output = command(&root, "Verbose", Some("svode_core=debug"))
        .output()
        .unwrap();
    result(&output);
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("DEBUG svode_core"), "{stderr}");
    assert!(stderr.contains(ORDER_WARNING), "{stderr}");

    let output = command(&root, "Quiet", Some("svode_core=error"))
        .output()
        .unwrap();
    result(&output);
    assert!(output.stderr.is_empty(), "{:?}", output.stderr);
}

#[test]
fn a_closed_stderr_changes_neither_the_result_nor_the_exit() {
    let (_temp, root) = fixture();
    let mut child = command(&root, "Unread", None).spawn().unwrap();
    drop(child.stderr.take());
    let output = child.wait_with_output().unwrap();
    let value = result(&output);
    assert_eq!(value["page"]["path"], "Unread.md", "{value}");
}

//! `svode git access verify` through real processes with the desktop app
//! closed: the shared service-ref verification of the remote of a Space,
//! recorded in the evidence store the install shares, returned as a result
//! for every access state, and the write gate of the next command that reads
//! that evidence without a probe.

mod common;

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use common::process::{BIN, TEST_IDENTIFIER, code, json, write};
use serde_json::Value;

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stderr(Stdio::null())
        .output()
        .unwrap();
    assert!(output.status.success(), "git {args:?}");
    String::from_utf8(output.stdout).unwrap()
}

fn has_git() -> bool {
    Command::new("git").arg("--version").output().is_ok()
}

/// Committed project; `remote` becomes its origin.
fn fixture(remote: Option<&str>) -> Option<(tempfile::TempDir, PathBuf)> {
    if !has_git() {
        return None;
    }
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap().join("project");
    write(&root.join(".svode/config.json"), r#"{"name":"Project"}"#);
    write(&root.join("README.md"), "---\ntitle: Project\n---\n");
    write(&root.join("notes.md"), "---\ntitle: Notes\n---\nBody\n");
    git(&root, &["init", "-q", "-b", "main"]);
    git(&root, &["config", "user.email", "agent@example.com"]);
    git(&root, &["config", "user.name", "Agent"]);
    git(&root, &["config", "maintenance.auto", "false"]);
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-q", "-m", "fixture"]);
    if let Some(remote) = remote {
        let url = if remote == "bare" {
            let bare = temp.path().canonicalize().unwrap().join("remote.git");
            std::fs::create_dir_all(&bare).unwrap();
            git(&bare, &["init", "-q", "--bare"]);
            git(&root, &["push", "-q", bare.to_str().unwrap(), "main"]);
            bare.to_string_lossy().to_string()
        } else {
            remote.to_string()
        };
        git(&root, &["remote", "add", "origin", &url]);
    }
    Some((temp, root))
}

/// Runs a JSON command with extra environment and returns (exit, value).
fn run(root: &Path, args: &[&str], path: Option<&str>) -> (i32, Value) {
    let mut command = Command::new(BIN);
    command
        .args(args)
        .arg("--json")
        .current_dir(root)
        .env("SVODE_PRODUCT_IDENTIFIER", TEST_IDENTIFIER)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null());
    if let Some(path) = path {
        command.env("PATH", path);
    }
    let output = command.output().unwrap();
    let stdout = String::from_utf8(output.stdout).unwrap();
    (
        output.status.code().unwrap(),
        serde_json::from_str(&stdout).unwrap_or_else(|_| panic!("{args:?}: {stdout}")),
    )
}

fn verify(root: &Path, path: Option<&str>) -> Value {
    let (exit, value) = run(root, &["git", "access", "verify"], path);
    assert_eq!(exit, 0, "{value}");
    assert_eq!(value["target"]["spaceId"], "root");
    value["repositoryAccess"].clone()
}

fn write_icon(root: &Path) -> (i32, Value) {
    json(
        root,
        &["page", "meta", "set", "--path", "notes.md", "--icon", "x"],
        None,
    )
}

#[test]
fn a_repository_without_a_remote_is_local() {
    let Some((_temp, root)) = fixture(None) else {
        return;
    };
    let access = verify(&root, None);
    assert_eq!(access["status"], "local");
    let human = Command::new(BIN)
        .args(["git", "access", "verify"])
        .current_dir(&root)
        .env("SVODE_PRODUCT_IDENTIFIER", TEST_IDENTIFIER)
        .output()
        .unwrap();
    assert_eq!(human.status.code(), Some(0));
    assert_eq!(
        String::from_utf8(human.stdout).unwrap(),
        "repository access: local\n"
    );
    assert_eq!(write_icon(&root).0, 0);
}

#[test]
fn a_verified_writable_remote_allows_the_next_write_of_another_process() {
    let Some((_temp, root)) = fixture(Some("bare")) else {
        return;
    };
    let head = git(&root, &["rev-parse", "HEAD"]);
    let branches = git(&root, &["for-each-ref", "refs/heads"]);

    // Without evidence the write is refused with the next step.
    let (exit, denied) = write_icon(&root);
    assert_eq!((exit, code(&denied)), (1, "REPOSITORY_ACCESS_DENIED"));
    assert_eq!(denied["error"]["reason"], "not_checked");

    let access = verify(&root, None);
    assert_eq!(access["status"], "writable", "{access}");
    assert!(access["checkedAt"].is_i64(), "{access}");
    assert!(access["expiresAt"].as_i64() > access["checkedAt"].as_i64());

    // The evidence is shared: another process reads it without a probe.
    let (exit, spaces) = json(&root, &["space", "list"], None);
    assert_eq!(exit, 0);
    assert_eq!(
        spaces["spaces"][0]["repositoryAccess"]["status"],
        "writable"
    );
    let (exit, applied) = write_icon(&root);
    assert_eq!(exit, 0, "{applied}");

    // The verification leaves history, branches and the working tree alone;
    // only a Svode service ref exists on the remote.
    assert_eq!(git(&root, &["rev-parse", "HEAD"]), head);
    assert_eq!(git(&root, &["for-each-ref", "refs/heads"]), branches);
    let remote = git(&root, &["ls-remote", "origin"]);
    assert!(remote.contains("refs/svode/access/"), "{remote}");
    let status = git(&root, &["status", "--porcelain"]);
    assert!(
        status.lines().all(|line| line.ends_with("notes.md")
            || line.contains(".svode/")
            || line.ends_with(".gitignore")),
        "{status}"
    );
}

#[test]
fn a_denied_push_is_read_only_and_keeps_the_write_gate_closed() {
    let Some((temp, root)) = fixture(Some("bare")) else {
        return;
    };
    // A Git on PATH whose remote answers every push with an explicit
    // permission denial.
    let real = String::from_utf8(
        Command::new("sh")
            .args(["-c", "command -v git"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .to_string();
    let bin = temp.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let wrapper = bin.join("git");
    std::fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\nfor arg in \"$@\"; do\n  if [ \"$arg\" = push ]; then\n    echo 'remote: Write access to repository not granted.' >&2\n    exit 1\n  fi\ndone\nexec '{real}' \"$@\"\n"
        ),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
    let path = format!(
        "{}:{}",
        bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );

    let access = verify(&root, Some(&path));
    assert_eq!(access["status"], "read_only", "{access}");
    let (exit, denied) = write_icon(&root);
    assert_eq!((exit, code(&denied)), (1, "REPOSITORY_ACCESS_DENIED"));
    assert_eq!(denied["error"]["status"], "read_only");
    assert!(
        std::fs::read_to_string(root.join("notes.md"))
            .unwrap()
            .ends_with("Body\n")
    );
}

#[test]
fn an_unreachable_remote_is_unknown_with_its_reason() {
    let Some((temp, root)) = fixture(None) else {
        return;
    };
    let missing = temp.path().join("missing.git");
    git(
        &root,
        &["remote", "add", "origin", missing.to_str().unwrap()],
    );
    let access = verify(&root, None);
    assert_eq!(access["status"], "unknown", "{access}");
    assert!(access["reason"].is_string(), "{access}");
    let (exit, denied) = write_icon(&root);
    assert_eq!((exit, code(&denied)), (1, "REPOSITORY_ACCESS_DENIED"));
    assert_eq!(denied["error"]["status"], "unknown");
}

#[test]
fn a_target_that_cannot_be_resolved_fails_before_any_probe() {
    let Some((_temp, root)) = fixture(None) else {
        return;
    };
    let (exit, value) = run(&root, &["git", "access", "verify", "--space", "nope"], None);
    assert_eq!(exit, 1, "{value}");
    assert_eq!(code(&value), "SPACE_UNAVAILABLE");
    let (exit, value) = run(root.parent().unwrap(), &["git", "access", "verify"], None);
    assert_eq!(exit, 1, "{value}");
    assert_eq!(code(&value), "PROJECT_UNAVAILABLE");
}

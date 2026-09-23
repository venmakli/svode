//! Consistent body writes (G02) through real `svode` processes with the
//! desktop app closed: the read → edit → write cycle with `sourceVersion`,
//! stale and busy refusals without effects, atomic publication of the new
//! bytes, a killed writer that leaves neither a truncated source nor a
//! stale lock, index publication and the repository access gate.

mod common;

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use common::process::{BIN, TEST_IDENTIFIER, code, json, write};
use serde_json::Value;

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
}

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

fn has_git() -> bool {
    Command::new("git").arg("--version").output().is_ok()
}

/// Committed project with a Page, a Collection item and both READMEs.
fn fixture() -> Option<Fixture> {
    if !has_git() {
        return None;
    }
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap().join("project");
    write(&root.join(".svode/config.json"), r#"{"name":"Project"}"#);
    write(&root.join("README.md"), "---\ntitle: Project\n---\nOwner\n");
    write(
        &root.join("notes/today.md"),
        "---\ntitle: Today\ncustom: 'kept'\n---\nFirst draft\n",
    );
    write(
        &root.join("tasks/schema.yaml"),
        "columns:\n  - name: Status\n    type: text\nviews:\n  - type: table\n    name: Table\n",
    );
    write(
        &root.join("tasks/README.md"),
        "---\ntitle: Tasks\n---\nBoard\n",
    );
    write(
        &root.join("tasks/alpha.md"),
        "---\ntitle: Alpha\nStatus: Todo\n---\nAlpha body\n",
    );
    git(&root, &["init", "-q"]);
    git(&root, &["config", "user.email", "agent@example.com"]);
    git(&root, &["config", "user.name", "Agent"]);
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-q", "-m", "fixture"]);
    Some(Fixture { _temp: temp, root })
}

fn read_version(root: &Path, args: &[&str]) -> String {
    let (exit, value) = json(root, args, None);
    assert_eq!(exit, 0, "{value}");
    value["sourceVersion"].as_str().unwrap().to_string()
}

fn page_version(root: &Path) -> String {
    read_version(root, &["page", "read", "--path", "notes/today.md"])
}

fn write_page(root: &Path, body: &str, version: &str) -> (i32, Value) {
    json(
        root,
        &[
            "page",
            "write",
            "--path",
            "notes/today.md",
            "--body-file",
            "-",
            "--source-version",
            version,
        ],
        Some(body),
    )
}

fn source(root: &Path) -> String {
    std::fs::read_to_string(root.join("notes/today.md")).unwrap()
}

#[test]
fn the_safe_cycle_writes_every_body_owner_and_chains_the_returned_version() {
    let Some(fixture) = fixture() else { return };
    let root = &fixture.root;
    let head = String::from_utf8(
        Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(root)
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();

    let read = page_version(root);
    let (exit, written) = write_page(root, "Second draft\n", &read);
    assert_eq!(exit, 0, "{written}");
    assert_eq!(
        written["changedPaths"],
        serde_json::json!(["notes/today.md"])
    );
    // The frontmatter bytes stay; only the body is replaced.
    assert_eq!(
        source(root),
        "---\ntitle: Today\ncustom: 'kept'\n---\nSecond draft\n"
    );
    let returned = written["sourceVersion"].as_str().unwrap().to_string();
    assert_ne!(returned, read);
    assert_eq!(returned, page_version(root));
    // The returned version is the precondition of the next write.
    let (exit, chained) = write_page(root, "Third draft\n", &returned);
    assert_eq!(exit, 0, "{chained}");

    for (read, write, path) in [
        (
            vec!["item", "read", "--path", "tasks/alpha.md"],
            vec![
                "item",
                "write",
                "--path",
                "tasks/alpha.md",
                "--body",
                "Item\n",
            ],
            "tasks/alpha.md",
        ),
        (
            vec!["space", "readme", "read"],
            vec!["space", "readme", "write", "--body", "Root owner\n"],
            "README.md",
        ),
        (
            vec!["collection", "readme", "read", "--collection", "tasks"],
            vec![
                "collection",
                "readme",
                "write",
                "--collection",
                "tasks",
                "--body",
                "Board owner\n",
            ],
            "tasks/README.md",
        ),
    ] {
        let version = read_version(root, &read);
        let mut write = write.clone();
        write.extend(["--source-version", &version]);
        let (exit, value) = json(root, &write, None);
        assert_eq!(exit, 0, "{write:?}: {value}");
        assert_eq!(
            value["sourceVersion"].as_str().unwrap(),
            read_version(root, &read),
            "{write:?}"
        );
        assert!(
            std::fs::read_to_string(root.join(path))
                .unwrap()
                .contains("---\ntitle:"),
            "{path}"
        );
    }
    assert!(
        std::fs::read_to_string(root.join("tasks/alpha.md"))
            .unwrap()
            .contains("Status: Todo")
    );
    // The item write published through the Routine store of its owner.
    assert!(root.join(".svode/routines.db").is_file());

    // The index of the write is current for the next index-backed read.
    let (exit, found) = json(root, &["search", "Third"], None);
    assert_eq!(exit, 0, "{found}");
    assert_eq!(found["items"][0]["path"], "notes/today.md");

    // No write commits to Git and no staged copy or lock escapes the policy.
    let after = String::from_utf8(
        Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(root)
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    assert_eq!(after, head);
    let status = String::from_utf8(
        Command::new("git")
            .args(["status", "--porcelain", "--untracked-files=all"])
            .current_dir(root)
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    assert!(!status.contains(".tmp"), "{status}");
}

#[test]
fn a_write_after_another_process_changed_the_source_is_stale_without_effects() {
    let Some(fixture) = fixture() else { return };
    let root = &fixture.root;
    let read = page_version(root);

    // Another Svode process writes first from the same read.
    let (exit, other) = write_page(root, "Other writer\n", &read);
    assert_eq!(exit, 0, "{other}");
    let (exit, stale) = write_page(root, "Late writer\n", &read);
    assert_eq!(exit, 1, "{stale}");
    assert_eq!(code(&stale), "SOURCE_STALE");
    assert_eq!(stale["error"]["path"], "notes/today.md");
    assert!(stale["error"].get("sourceVersion").is_none(), "{stale}");
    assert!(source(root).ends_with("Other writer\n"));

    // A direct edit by a program outside Svode is detected the same way.
    let read = page_version(root);
    std::fs::write(
        root.join("notes/today.md"),
        "---\ntitle: Today\ncustom: 'kept'\n---\nEdited by hand\n",
    )
    .unwrap();
    let (exit, stale) = write_page(root, "Mine\n", &read);
    assert_eq!((exit, code(&stale)), (1, "SOURCE_STALE"));
    assert!(source(root).ends_with("Edited by hand\n"));

    // Human mode says why and what to do on stderr.
    let output = Command::new(BIN)
        .args([
            "page",
            "write",
            "--path",
            "notes/today.md",
            "--body",
            "Mine\n",
            "--source-version",
            &read,
        ])
        .current_dir(root)
        .env("SVODE_PRODUCT_IDENTIFIER", TEST_IDENTIFIER)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.starts_with("error[SOURCE_STALE]"), "{stderr}");
    assert!(stderr.contains("read it again"), "{stderr}");
}

#[test]
fn a_write_while_another_process_holds_the_guard_is_busy_until_it_is_released() {
    let Some(fixture) = fixture() else { return };
    let root = &fixture.root;
    let read = page_version(root);
    let before = source(root);

    // This test process is the other writer: it holds the write guard of
    // the repository through the shared core, like a source phase does.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let guard = runtime
        .block_on(svode_core::git::write_guard::acquire(
            &std::collections::BTreeSet::from([root.clone()]),
            &[],
        ))
        .unwrap();
    let started = Instant::now();
    let (exit, busy) = write_page(root, "Blocked\n", &read);
    assert_eq!(exit, 1, "{busy}");
    assert_eq!(code(&busy), "SOURCE_BUSY");
    assert_eq!(busy["error"]["path"], "notes/today.md");
    assert!(started.elapsed() >= Duration::from_millis(1400));
    assert_eq!(source(root), before);

    // After the release a retry with the same read applies.
    drop(guard);
    let (exit, applied) = write_page(root, "Unblocked\n", &read);
    assert_eq!(exit, 0, "{applied}");
    assert!(source(root).ends_with("Unblocked\n"));
}

/// Helper process for the killed-holder test: holds the write guard of the
/// repository named by `SVODE_TEST_HOLD_REPOSITORY` until it is killed.
#[test]
#[ignore = "helper process of a_killed_guard_holder_leaves_no_stale_lock"]
fn hold_the_write_guard_until_killed() {
    let Ok(repository) = std::env::var("SVODE_TEST_HOLD_REPOSITORY") else {
        return;
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let _guard = runtime
        .block_on(svode_core::git::write_guard::acquire(
            &std::collections::BTreeSet::from([PathBuf::from(repository)]),
            &[],
        ))
        .unwrap();
    println!("held");
    std::thread::sleep(Duration::from_secs(120));
}

#[test]
fn a_killed_guard_holder_leaves_no_stale_lock() {
    let Some(fixture) = fixture() else { return };
    let root = &fixture.root;
    let mut holder = Command::new(std::env::current_exe().unwrap())
        .args([
            "hold_the_write_guard_until_killed",
            "--exact",
            "--ignored",
            "--nocapture",
        ])
        .env("SVODE_TEST_HOLD_REPOSITORY", root)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(holder.stdout.take().unwrap()).lines();
    assert!(lines.any(|line| line.unwrap().contains("held")));
    let read = page_version(root);
    let (exit, busy) = write_page(root, "Blocked\n", &read);
    assert_eq!((exit, code(&busy)), (1, "SOURCE_BUSY"));

    holder.kill().unwrap();
    holder.wait().unwrap();
    let started = Instant::now();
    let (exit, applied) = write_page(root, "After the crash\n", &read);
    assert_eq!(exit, 0, "{applied}");
    assert!(started.elapsed() < Duration::from_millis(1400));
}

#[test]
fn readers_see_the_old_or_the_new_bytes_and_a_killed_writer_truncates_nothing() {
    let Some(fixture) = fixture() else { return };
    let root = &fixture.root;
    let path = root.join("notes/today.md");
    let big = |fill: char| format!("{}\n", fill.to_string().repeat(8 << 20));

    // A concurrent reader never observes a partial source.
    let old_len = std::fs::metadata(&path).unwrap().len();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let reader = std::thread::spawn({
        let path = path.clone();
        let stop = stop.clone();
        move || {
            let mut lengths = std::collections::BTreeSet::new();
            while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                lengths.insert(std::fs::read(&path).unwrap().len() as u64);
            }
            lengths
        }
    });
    let (exit, value) = write_page(root, &big('a'), &page_version(root));
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(exit, 0, "{value}");
    let new_len = std::fs::metadata(&path).unwrap().len();
    let lengths = reader.join().unwrap();
    assert!(
        lengths.iter().all(|len| *len == old_len || *len == new_len),
        "{lengths:?}"
    );

    // A writer killed at any moment leaves the old or the new source and
    // releases its guard with the process.
    let body = root.join("input.md");
    for (delay, fill) in [(5, 'b'), (20, 'c'), (60, 'd'), (150, 'e')] {
        std::fs::write(&body, big(fill)).unwrap();
        let before = std::fs::read(&path).unwrap();
        let version = page_version(root);
        let mut writer = Command::new(BIN)
            .args([
                "page",
                "write",
                "--path",
                "notes/today.md",
                "--body-file",
                body.to_str().unwrap(),
                "--source-version",
                &version,
            ])
            .current_dir(root)
            .env("SVODE_PRODUCT_IDENTIFIER", TEST_IDENTIFIER)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_millis(delay));
        let _ = writer.kill();
        writer.wait().unwrap();
        let after = std::fs::read(&path).unwrap();
        let written = after.ends_with(big(fill).as_bytes()) && after.starts_with(b"---\n");
        assert!(after == before || written, "delay {delay}: partial source");
    }
    // The last killed writer holds nothing: the next write is not busy.
    let (exit, value) = write_page(root, "Recovered\n", &page_version(root));
    assert_eq!(exit, 0, "{value}");
}

#[test]
fn a_repository_without_access_evidence_refuses_the_write_before_any_effect() {
    let Some(fixture) = fixture() else { return };
    let root = &fixture.root;
    git(
        root,
        &[
            "remote",
            "add",
            "origin",
            "https://example.invalid/never.git",
        ],
    );
    let before = source(root);
    let (exit, denied) = write_page(root, "Denied\n", &page_version(root));
    assert_eq!(exit, 1, "{denied}");
    assert_eq!(code(&denied), "REPOSITORY_ACCESS_DENIED");
    assert!(
        denied["error"]["message"]
            .as_str()
            .unwrap()
            .contains("not_checked"),
        "{denied}"
    );
    assert_eq!(source(root), before);
}

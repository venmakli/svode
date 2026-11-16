//! The publication proof logs the step that blocked a Space (DF-364): its
//! path, class, exit code and Git stderr without URL credentials, while the
//! refusal keeps its transport shape. Its own test binary: `tracing` caches
//! callsite interest process-wide, so a scoped subscriber in a binary whose
//! other tests log without one could miss the events. A shell wrapper
//! substitutes the failing Git step, so the test runs on unix only.
#![cfg(unix)]

use std::io::Write;
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex};

use svode_core::git::cli::GitCli;
use svode_core::git::publication::{BlockedSpace, SpaceBlockClass, blocked_spaces, push};

const SECRET: &str = "s3cret";

#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl Write for Captured {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn git(repo: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args(["-c", "protocol.file.allow=always"])
        .args(args)
        .current_dir(repo)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn init(repo: &Path) {
    std::fs::create_dir(repo).unwrap();
    git(repo, &["init", "-q", "-b", "main"]);
    configure(repo);
    commit(repo, "initial");
}

fn configure(repo: &Path) {
    git(repo, &["config", "user.name", "Fixture"]);
    git(repo, &["config", "user.email", "fixture@example.test"]);
    git(repo, &["config", "commit.gpgsign", "false"]);
}

fn commit(repo: &Path, value: &str) {
    std::fs::write(repo.join("note"), value).unwrap();
    git(repo, &["add", "note"]);
    git(repo, &["commit", "-q", "-m", value]);
}

/// A published root with the Space `Space`, and an unpublished root commit
/// that moves its pointer. Git fails every command matching `failing`, with
/// a credential URL in its stderr.
fn fixture(temp: &Path, failing: &str) -> (std::path::PathBuf, GitCli) {
    let seed = temp.join("seed");
    let root = temp.join("project");
    init(&seed);
    init(&root);
    let source = temp.join("space.git");
    let remote = temp.join("project.git");
    git(
        temp,
        &[
            "clone",
            "-q",
            "--bare",
            seed.to_str().unwrap(),
            source.to_str().unwrap(),
        ],
    );
    git(
        &root,
        &["submodule", "add", "-q", source.to_str().unwrap(), "Space"],
    );
    git(&root, &["commit", "-q", "-m", "Space"]);
    git(
        temp,
        &[
            "clone",
            "-q",
            "--bare",
            root.to_str().unwrap(),
            remote.to_str().unwrap(),
        ],
    );
    git(
        &root,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    git(&root, &["push", "-q", "-u", "origin", "main"]);
    let child = root.join("Space");
    configure(&child);
    commit(&child, "local");
    git(&root, &["add", "Space"]);
    git(&root, &["commit", "-q", "-m", "Pointer"]);
    let wrapper = temp.join("git-test");
    svode_testkit::write_executable(
        &wrapper,
        format!(
            "#!/bin/sh\nexport GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1\ncase \"$*\" in *'{failing}'*) echo 'fatal: could not read from https://fixture:{SECRET}@example.test/space.git' >&2; exit 128;; esac\nexec git -c protocol.file.allow=always \"$@\"\n"
        ),
    )
    .unwrap();
    (root, GitCli::for_test(wrapper))
}

#[tokio::test]
async fn a_failed_proof_step_logs_the_space_class_and_redacted_stderr_but_not_into_the_refusal() {
    for (failing, step, class) in [
        (
            "clone --shared --bare",
            "clone Space copy",
            SpaceBlockClass::Unverified,
        ),
        (
            "fetch --prune",
            "fetch source",
            SpaceBlockClass::SourceUnavailable,
        ),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let (root, cli) = fixture(temp.path(), failing);
        let captured = Captured::default();
        let writer = captured.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(move || writer.clone())
            .finish();
        let guard = tracing::subscriber::set_default(subscriber);

        assert_eq!(
            blocked_spaces(&cli, &root).await.unwrap(),
            vec![BlockedSpace {
                path: "Space".into(),
                class,
            }],
            "{step}"
        );
        let error = push(&cli, &root, false).await.unwrap_err();
        drop(guard);

        let logs = String::from_utf8(captured.0.lock().unwrap().clone()).unwrap();
        let warning = logs
            .lines()
            .find(|line| line.contains("publication proof blocked a Space"))
            .unwrap_or_else(|| panic!("{step}: {logs}"));
        for expected in [
            format!("step=\"{step}\""),
            "space=\"Space\"".to_owned(),
            format!("class={class:?}"),
            "exit_code=128".to_owned(),
            "https://***@example.test/space.git".to_owned(),
        ] {
            assert!(
                warning.contains(&expected),
                "{step}: {expected} in {warning}"
            );
        }
        assert!(!logs.contains(SECRET), "{step}: {logs}");
        let transport = serde_json::to_string(&error).unwrap();
        for shown in [format!("{error:?}"), error.to_string(), transport.clone()] {
            assert!(!shown.contains("could not read"), "{step}: {shown}");
            assert!(!shown.contains("example.test"), "{step}: {shown}");
        }
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&transport).unwrap()["spaces"],
            serde_json::json!([{ "path": "Space", "class": serde_json::to_value(class).unwrap() }]),
            "{step}"
        );
    }
}

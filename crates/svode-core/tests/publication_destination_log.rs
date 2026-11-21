//! A remote whose push URL carries `user:token@` publishes through that URL
//! while the log never shows the token (DF-379 R2, R4). Git reaches the
//! `https` remote through a fake remote helper, which records the URL Git
//! hands it and serves a local bare repository. Its own test binary:
//! `tracing` caches callsite interest process-wide, so a scoped subscriber in
//! a binary whose other tests log without one could miss the events.
#![cfg(unix)]

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use svode_core::git::cli::GitCli;
use svode_core::git::publication::blocked_spaces;
use svode_core::git::sync::{SyncResult, sync};

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

fn git(repo: &Path, args: &[&str]) -> String {
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
    String::from_utf8(out.stdout).unwrap().trim_end().into()
}

fn commit(repo: &Path, value: &str) {
    std::fs::write(repo.join("note"), value).unwrap();
    git(repo, &["add", "note"]);
    git(repo, &["commit", "-q", "-m", value]);
}

fn init(repo: &Path) {
    std::fs::create_dir(repo).unwrap();
    git(repo, &["init", "-q", "-b", "main"]);
    git(repo, &["config", "user.name", "Fixture"]);
    git(repo, &["config", "user.email", "fixture@example.test"]);
    commit(repo, "initial");
}

fn bare(temp: &Path, from: &Path, name: &str) -> PathBuf {
    let bare = temp.join(name);
    git(
        temp,
        &[
            "clone",
            "-q",
            "--bare",
            from.to_str().unwrap(),
            bare.to_str().unwrap(),
        ],
    );
    bare
}

/// The Git executables with `git-remote-https` replaced by a helper that
/// logs the URL it is given and serves `remote` over `git remote-ext`.
fn exec_path(temp: &Path, remote: &Path, log: &Path) -> PathBuf {
    let installed = Command::new("git").arg("--exec-path").output().unwrap();
    let installed = PathBuf::from(String::from_utf8(installed.stdout).unwrap().trim_end());
    let exec = temp.join("exec-path");
    std::fs::create_dir(&exec).unwrap();
    for entry in std::fs::read_dir(installed).unwrap() {
        let entry = entry.unwrap();
        if entry.file_name() != "git-remote-https" {
            std::os::unix::fs::symlink(entry.path(), exec.join(entry.file_name())).unwrap();
        }
    }
    svode_testkit::write_executable(
        exec.join("git-remote-https"),
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$2\" >> '{}'\nexec git remote-ext \"$1\" 'git %s {}'\n",
            log.display(),
            remote.display()
        ),
    )
    .unwrap();
    exec
}

#[tokio::test]
async fn a_push_url_with_a_token_publishes_through_it_and_the_log_has_no_token() {
    let temp = tempfile::tempdir().unwrap();
    let temp = temp.path();
    let seed = temp.join("seed");
    let root = temp.join("project");
    init(&seed);
    init(&root);
    let source = bare(temp, &seed, "space.git");
    git(
        &root,
        &["submodule", "add", "-q", source.to_str().unwrap(), "Space"],
    );
    git(&root, &["commit", "-q", "-m", "Space"]);
    let remote = bare(temp, &root, "project.git");
    git(
        &root,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    git(&root, &["fetch", "-q", "origin"]);
    git(&root, &["branch", "-q", "-u", "origin/main"]);
    // A remote branch the root lacks makes the proof copy fetch.
    let other = temp.join("other");
    git(
        temp,
        &[
            "clone",
            "-q",
            remote.to_str().unwrap(),
            other.to_str().unwrap(),
        ],
    );
    git(&other, &["config", "user.name", "Fixture"]);
    git(&other, &["config", "user.email", "fixture@example.test"]);
    commit(&other, "other branch");
    git(&other, &["push", "-q", "origin", "HEAD:refs/heads/other"]);
    let child = root.join("Space");
    git(&child, &["config", "user.name", "Fixture"]);
    git(&child, &["config", "user.email", "fixture@example.test"]);
    commit(&child, "published Space revision");
    git(&child, &["push", "-q", "origin", "HEAD:main"]);
    git(&root, &["add", "Space"]);
    git(&root, &["commit", "-q", "-m", "pointer"]);
    let url = format!("https://fixture:{SECRET}@example.test/project.git");
    git(&root, &["remote", "set-url", "origin", &url]);

    let log = temp.join("helper.log");
    let exec = exec_path(temp, &remote, &log);
    let wrapper = temp.join("git-test");
    svode_testkit::write_executable(
        &wrapper,
        format!(
            "#!/bin/sh\nexport GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_EXEC_PATH='{}'\nexec git -c protocol.file.allow=always \"$@\"\n",
            exec.display()
        ),
    )
    .unwrap();
    let cli = GitCli::for_test(wrapper);

    let captured = Captured::default();
    let writer = captured.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_ansi(false)
        .with_max_level(tracing::Level::TRACE)
        .with_writer(move || writer.clone())
        .finish();
    let guard = tracing::subscriber::set_default(subscriber);
    assert_eq!(blocked_spaces(&cli, &root).await.unwrap(), Vec::new());
    let synced = sync(&cli, &root).await.unwrap();
    drop(guard);

    assert!(matches!(synced, SyncResult::Success { .. }), "{synced:?}");
    assert_eq!(
        git(&remote, &["rev-parse", "main"]),
        git(&root, &["rev-parse", "HEAD"])
    );
    let connections = std::fs::read_to_string(&log).unwrap();
    // Dry runs, advertisements, the revalidation, the proof fetch and the push.
    assert!(connections.lines().count() >= 6, "{connections}");
    assert!(connections.lines().all(|line| line == url), "{connections}");
    let logs = String::from_utf8(captured.0.lock().unwrap().clone()).unwrap();
    assert!(!logs.is_empty());
    assert!(!logs.contains(SECRET), "{logs}");
}

#![cfg(unix)]
//! The send queue of LFS content (DF-377 R4, R5), with the real git-lfs.

use std::path::{Path, PathBuf};
use std::process::Command;

use super::*;

fn lfs_available() -> bool {
    Command::new("git")
        .args(["lfs", "version"])
        .output()
        .is_ok_and(|out| out.status.success())
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

fn lfs_oid(repo: &Path, revision: &str) -> String {
    git(repo, &["show", revision])
        .lines()
        .find_map(|line| line.strip_prefix("oid sha256:"))
        .unwrap()
        .to_owned()
}

/// A repository with Git LFS for `*.bin`, published to a bare remote.
struct Repo {
    _temp: tempfile::TempDir,
    root: PathBuf,
    cli: GitCli,
}

impl Repo {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let root = base.join("project");
        let remote = base.join("remote.git");
        git(
            &base,
            &[
                "init",
                "-q",
                "--bare",
                "-b",
                "main",
                remote.to_str().unwrap(),
            ],
        );
        std::fs::create_dir(&root).unwrap();
        git(&root, &["init", "-q", "-b", "main"]);
        git(&root, &["config", "user.name", "Fixture"]);
        git(&root, &["config", "user.email", "fixture@example.test"]);
        git(&root, &["lfs", "install", "--local"]);
        git(&root, &["lfs", "track", "*.bin"]);
        std::fs::write(root.join("base.bin"), "published content\n".repeat(64)).unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-qm", "base"]);
        git(
            &root,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git(&root, &["push", "-q", "-u", "origin", "main"]);
        let wrapper = base.join("git-test");
        svode_testkit::write_executable(
            &wrapper,
            "#!/bin/sh\nexport GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1\nexec git -c protocol.file.allow=always \"$@\"\n",
        )
        .unwrap();
        Self {
            _temp: temp,
            root,
            cli: GitCli::for_test(wrapper),
        }
    }

    fn commit(&self, file: &str, content: &str) {
        std::fs::write(self.root.join(file), content).unwrap();
        git(&self.root, &["add", file]);
        git(&self.root, &["commit", "-qm", file]);
    }

    fn object(&self, revision: &str, path: &str, size: usize) -> UnsentObject {
        UnsentObject {
            oid: lfs_oid(&self.root, &format!("{revision}:{path}")),
            path: path.into(),
            size: size as u64,
        }
    }
}

#[test]
fn a_failed_send_names_its_reason_without_credentials() {
    assert_eq!(
        SendStop::of_failure(
            "batch request: ssh: connect to host 10.255.255.1 port 2222: Operation timed out: exit status 255"
        ),
        SendStop::Unreachable
    );
    assert_eq!(
        SendStop::of_failure("git@lfs.example.test: Permission denied (publickey)."),
        SendStop::NoAccess
    );
    assert_eq!(
        SendStop::of_failure(
            "batch response: Authentication required: Authorization error: https://user:secret@lfs.example.test/info/lfs/objects/batch"
        ),
        SendStop::NoAccess
    );
    assert_eq!(
        SendStop::of_failure(
            "batch response: the server is full: https://user:secret@lfs.example.test/repo"
        ),
        SendStop::Other {
            detail: "batch response: the server is full: https://***@lfs.example.test/repo".into()
        }
    );
}

/// The objects of every commit a push publishes, intermediate versions
/// included, and none of those already published.
#[tokio::test]
async fn a_push_publishes_the_lfs_objects_of_every_unpublished_commit() {
    if !lfs_available() {
        eprintln!("git-lfs is not installed; skipped");
        return;
    }
    let repo = Repo::new();
    let first = "first version\n".repeat(32);
    let second = "second version\n".repeat(32);
    repo.commit("video.bin", &first);
    repo.commit("video.bin", &second);
    repo.commit("note.md", "text\n");
    let head = git(&repo.root, &["rev-parse", "HEAD"]);

    let mut objects = objects_to_publish(&repo.cli, &repo.root, "origin", &[&head])
        .await
        .unwrap();
    objects.sort_by_key(|object| object.size);
    let mut expected = vec![
        repo.object("HEAD~2", "video.bin", first.len()),
        repo.object("HEAD~1", "video.bin", second.len()),
    ];
    expected.sort_by_key(|object| object.size);
    assert_eq!(objects, expected);
}

#[tokio::test]
async fn the_queue_adds_each_object_once_and_says_the_last_reason() {
    if !lfs_available() {
        eprintln!("git-lfs is not installed; skipped");
        return;
    }
    let repo = Repo::new();
    repo.commit("video.bin", &"content\n".repeat(32));
    let video = repo.object("HEAD", "video.bin", 8 * 32);
    assert_eq!(unsent(&repo.cli, &repo.root).await, None);

    enqueue(
        &repo.cli,
        &repo.root,
        "origin",
        vec![video.clone()],
        SendStop::Unreachable,
    )
    .await
    .unwrap();
    let stalled = SendStop::Stalled {
        path: Some("video.bin".into()),
        size: Some(256),
    };
    enqueue(
        &repo.cli,
        &repo.root,
        "origin",
        vec![video.clone()],
        stalled.clone(),
    )
    .await
    .unwrap();
    let queue = unsent(&repo.cli, &repo.root).await.unwrap();
    assert_eq!(
        queue.files,
        vec![LfsFile {
            path: "video.bin".into(),
            size: 256
        }]
    );
    assert_eq!(queue.bytes, 256);
    assert_eq!(queue.stop, stalled);
    // The queue is a state of the Git directory, not a portable file.
    assert!(repo.root.join(".git").join(QUEUE_FILE).exists());
    assert_eq!(git(&repo.root, &["status", "--porcelain"]), "");
}

/// DF-377 R4: a queued object whose content is gone from this device stays
/// in the queue with its own reason, and nothing is sent for it.
#[tokio::test]
async fn a_queued_object_without_its_content_on_the_device_stays_with_its_reason() {
    if !lfs_available() {
        eprintln!("git-lfs is not installed; skipped");
        return;
    }
    let repo = Repo::new();
    repo.commit("video.bin", &"content\n".repeat(32));
    let video = repo.object("HEAD", "video.bin", 8 * 32);
    enqueue(
        &repo.cli,
        &repo.root,
        "origin",
        vec![video.clone()],
        SendStop::Unreachable,
    )
    .await
    .unwrap();
    std::fs::remove_dir_all(repo.root.join(".git/lfs/objects")).unwrap();

    assert_eq!(resend(&repo.cli, &repo.root).await, Resend::Done);
    let queue = unsent(&repo.cli, &repo.root).await.unwrap();
    assert_eq!(queue.files.len(), 1);
    assert_eq!(queue.stop, SendStop::NotOnDevice);
}

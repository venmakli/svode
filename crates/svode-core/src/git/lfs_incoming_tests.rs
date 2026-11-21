#![cfg(unix)]
//! Incoming commits whose LFS objects the server lacks (DF-377 R6): the sync
//! merge and the resolution of a conflict carry LFS files as pointers, without
//! a download and without failing, and the download after a later sync brings
//! the content once the object is on the server. Real git-lfs with a local LFS
//! store next to a bare remote.

use std::path::{Path, PathBuf};
use std::process::Command;

use super::*;
use crate::git::conflict_file::{FileResolution, Side, resolve};
use crate::git::state::GitRuntime;
use crate::git::versions::MessageLanguage;
use crate::storage::config::AssetsSpaceConfig;
use crate::storage::lfs_download::{DownloadPlan, DownloadStop, LfsFile, download, plan_download};

fn lfs_available() -> bool {
    Command::new("git")
        .args(["lfs", "version"])
        .output()
        .is_ok_and(|out| out.status.success())
}

fn git_with(repo: &Path, args: &[&str], env: &[(&str, &str)]) -> String {
    let out = Command::new("git")
        .args(["-c", "protocol.file.allow=always"])
        .args(args)
        .current_dir(repo)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .envs(env.iter().copied())
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap()
}

fn git(repo: &Path, args: &[&str]) -> String {
    git_with(repo, args, &[])
}

fn bytes(seed: u8, size: usize) -> Vec<u8> {
    (0..size)
        .map(|index| (index as u32).wrapping_mul(2_654_435_761).to_le_bytes()[0] ^ seed)
        .collect()
}

fn is_pointer(file: &Path) -> bool {
    std::fs::read(file)
        .unwrap()
        .starts_with(b"version https://git-lfs.github.com/spec/v1\n")
}

/// A project with `doc.md` and the LFS file `pic.bin` published to a bare
/// remote with its LFS store; `other` publishes, `local` receives, cloned
/// without LFS content as Svode clones.
struct Fixture {
    _temp: tempfile::TempDir,
    other: PathBuf,
    local: PathBuf,
    cli: GitCli,
    runtime: GitRuntime,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let remote = base.join("remote.git");
        let other = base.join("other");
        let local = base.join("local");
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
        std::fs::create_dir_all(&other).unwrap();
        git(&other, &["init", "-q", "-b", "main"]);
        git(&other, &["lfs", "install", "--local"]);
        git(&other, &["lfs", "track", "*.bin"]);
        std::fs::write(other.join("doc.md"), "base\n").unwrap();
        std::fs::write(other.join("pic.bin"), bytes(1, 4_000)).unwrap();
        git(&other, &["add", "."]);
        git(
            &other,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.test",
                "commit",
                "-qm",
                "base",
            ],
        );
        git(
            &other,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git(&other, &["push", "-q", "-u", "origin", "main"]);
        git_with(
            &base,
            &[
                "clone",
                "-q",
                remote.to_str().unwrap(),
                local.to_str().unwrap(),
            ],
            &[("GIT_LFS_SKIP_SMUDGE", "1")],
        );
        git(&local, &["lfs", "install", "--local"]);
        for repo in [&other, &local] {
            git(repo, &["config", "user.name", "Fixture"]);
            git(repo, &["config", "user.email", "fixture@example.test"]);
            crate::git::policy::exclude_device_local(repo);
        }
        let wrapper = base.join("git-test");
        svode_testkit::write_executable(
            &wrapper,
            "#!/bin/sh\nexport GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1\nexec git -c protocol.file.allow=always \"$@\"\n",
        )
        .unwrap();
        let cli = GitCli::for_test(wrapper);
        Self {
            _temp: temp,
            other,
            local,
            runtime: GitRuntime::with_cli(cli.clone()),
            cli,
        }
    }

    /// `other` commits `pic.bin` with `content` (and `doc.md`, when given)
    /// and publishes the commit without sending the LFS object.
    fn publish_without_object(&self, content: &[u8], doc: Option<&str>) {
        std::fs::write(self.other.join("pic.bin"), content).unwrap();
        if let Some(doc) = doc {
            std::fs::write(self.other.join("doc.md"), doc).unwrap();
        }
        git(&self.other, &["add", "."]);
        git(&self.other, &["commit", "-qm", "incoming"]);
        git_with(
            &self.other,
            &["push", "-q", "origin", "main"],
            &[("GIT_LFS_SKIP_PUSH", "1")],
        );
    }

    /// `other` sends the LFS objects of its branch to the server.
    fn send_objects(&self) {
        git(&self.other, &["lfs", "push", "--all", "origin", "main"]);
    }

    fn status(&self) -> String {
        git(&self.local, &["status", "--porcelain"])
    }

    /// The download of DF-368 after a sync: what it leaves missing and why.
    async fn download(&self) -> Option<(Vec<LfsFile>, DownloadStop)> {
        let config: AssetsSpaceConfig =
            serde_json::from_value(serde_json::json!({ "strategy": "lfs-remote" })).unwrap();
        match plan_download(&self.runtime, &self.local, &config)
            .await
            .unwrap()
        {
            DownloadPlan::NothingMissing => None,
            DownloadPlan::Download(missing) => {
                let outcome = download(&self.runtime, &self.cli, &self.local, &missing).await;
                outcome.stop.map(|stop| (outcome.missing.files(), stop))
            }
            plan => panic!("{plan:?}"),
        }
    }
}

#[tokio::test]
async fn an_incoming_lfs_file_missing_on_the_server_comes_as_a_pointer_and_downloads_once_sent() {
    if !lfs_available() {
        eprintln!("git-lfs is not installed; skipped");
        return;
    }
    let f = Fixture::new();
    let content = bytes(2, 6_000);
    f.publish_without_object(&content, Some("two\n"));

    let result = sync(&f.cli, &f.local).await.unwrap();
    assert!(matches!(result, SyncResult::Success { .. }), "{result:?}");
    assert_eq!(
        std::fs::read_to_string(f.local.join("doc.md")).unwrap(),
        "two\n"
    );
    assert!(is_pointer(&f.local.join("pic.bin")));
    assert_eq!(f.status(), "");

    // The download after the sync names the cause and keeps the pointer.
    let (missing, stop) = f.download().await.expect("pic.bin stays missing");
    assert_eq!(stop, DownloadStop::NotOnServer);
    assert_eq!(
        missing,
        vec![LfsFile {
            path: "pic.bin".into(),
            size: content.len() as u64
        }]
    );
    assert_eq!(f.status(), "");

    // Once the author sends it, the download after the next sync brings it.
    f.send_objects();
    let result = sync(&f.cli, &f.local).await.unwrap();
    assert!(matches!(result, SyncResult::Success { .. }), "{result:?}");
    assert_eq!(f.download().await, None);
    assert_eq!(std::fs::read(f.local.join("pic.bin")).unwrap(), content);
    assert_eq!(f.status(), "");
}

#[tokio::test]
async fn a_merge_commit_of_an_incoming_lfs_file_missing_on_the_server_comes_in_too() {
    if !lfs_available() {
        eprintln!("git-lfs is not installed; skipped");
        return;
    }
    let f = Fixture::new();
    std::fs::write(f.local.join("note.md"), "mine\n").unwrap();
    git(&f.local, &["add", "note.md"]);
    git(&f.local, &["commit", "-qm", "mine"]);
    f.publish_without_object(&bytes(3, 5_000), Some("two\n"));

    let result = sync(&f.cli, &f.local).await.unwrap();
    assert!(matches!(result, SyncResult::Success { .. }), "{result:?}");
    // A merge commit, not a fast-forward, published with my commit.
    assert_eq!(
        git(&f.local, &["rev-list", "--count", "--merges", "HEAD"]).trim(),
        "1"
    );
    assert_eq!(
        std::fs::read_to_string(f.local.join("doc.md")).unwrap(),
        "two\n"
    );
    assert!(is_pointer(&f.local.join("pic.bin")));
    assert_eq!(f.status(), "");
}

/// `local` changed `pic.bin` too: the sync stops in a conflict of the LFS
/// file whose incoming object the server lacks.
async fn lfs_conflict() -> Fixture {
    let f = Fixture::new();
    std::fs::write(f.local.join("pic.bin"), bytes(4, 7_000)).unwrap();
    git(&f.local, &["add", "pic.bin"]);
    git(&f.local, &["commit", "-qm", "mine"]);
    f.publish_without_object(&bytes(5, 8_000), None);
    let result = sync(&f.cli, &f.local).await.unwrap();
    assert!(matches!(result, SyncResult::Conflict { .. }), "{result:?}");
    f
}

#[tokio::test]
async fn the_incoming_version_of_an_lfs_conflict_is_taken_as_its_pointer() {
    if !lfs_available() {
        eprintln!("git-lfs is not installed; skipped");
        return;
    }
    let f = lfs_conflict().await;
    let theirs = git(&f.local, &["rev-parse", "origin/main:pic.bin"]);

    let result = resolve(
        &f.cli,
        &f.local,
        "pic.bin",
        &FileResolution::Side { side: Side::Theirs },
    )
    .await
    .unwrap();
    assert!(matches!(result, SyncResult::Success { .. }), "{result:?}");
    assert!(is_pointer(&f.local.join("pic.bin")));
    assert_eq!(git(&f.local, &["rev-parse", "HEAD:pic.bin"]), theirs);
    assert_eq!(f.status(), "");

    f.send_objects();
    assert_eq!(f.download().await, None);
    assert_eq!(
        std::fs::read(f.local.join("pic.bin")).unwrap(),
        bytes(5, 8_000)
    );
}

#[tokio::test]
async fn keeping_both_versions_of_an_lfs_conflict_keeps_both_pointers() {
    if !lfs_available() {
        eprintln!("git-lfs is not installed; skipped");
        return;
    }
    let f = lfs_conflict().await;

    let result = resolve(
        &f.cli,
        &f.local,
        "pic.bin",
        &FileResolution::KeepBoth {
            language: MessageLanguage::En,
        },
    )
    .await
    .unwrap();
    assert!(matches!(result, SyncResult::Success { .. }), "{result:?}");
    let copy = f.local.join("pic (incoming).bin");
    assert!(is_pointer(&copy));
    assert_eq!(f.status(), "");

    // My version is in the local store; only the incoming one waits.
    let (missing, stop) = f.download().await.expect("the copy stays missing");
    assert_eq!(stop, DownloadStop::NotOnServer);
    assert_eq!(
        missing,
        vec![LfsFile {
            path: "pic (incoming).bin".into(),
            size: 8_000
        }]
    );
    assert_eq!(
        std::fs::read(f.local.join("pic.bin")).unwrap(),
        bytes(4, 7_000)
    );
    assert_eq!(f.status(), "");
}

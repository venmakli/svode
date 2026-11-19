//! LFS content travels before the publication lock (DF-369 R2), with the
//! real git-lfs and a local LFS store next to a bare remote.

use super::git;
use crate::git::cli::GitCli;
use crate::git::flow;
use crate::git::{host::GitHost, staging_tests::TestHost, state::GitRuntime};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

fn lfs_available() -> bool {
    std::process::Command::new("git")
        .args(["lfs", "version"])
        .output()
        .is_ok_and(|out| out.status.success())
}

/// The LFS store of `remote` holds the object of `oid`.
fn stored(remote: &Path, oid: &str) -> bool {
    remote
        .join("lfs/objects")
        .join(&oid[..2])
        .join(&oid[2..4])
        .join(oid)
        .exists()
}

fn lfs_oid(repo: &Path, path: &str) -> String {
    git(repo, &["show", &format!("HEAD:{path}")])
        .lines()
        .find_map(|line| line.strip_prefix("oid sha256:"))
        .unwrap()
        .to_owned()
}

async fn appears(path: &Path) {
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    while !path.exists() {
        assert!(std::time::Instant::now() < deadline, "{path:?} appears");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    remote: PathBuf,
    marks: PathBuf,
    cli: GitCli,
}

/// A project with the `lfs-remote` strategy published to a bare remote,
/// and a Git whose `lfs push` sends the content, then waits for the test's
/// `release` mark; every push records which marks of `marks` exist.
fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("project");
    let remote = temp.path().join("remote.git");
    let marks = temp.path().join("marks");
    std::fs::create_dir_all(&marks).unwrap();
    std::fs::create_dir(&root).unwrap();
    git(
        temp.path(),
        &["init", "--bare", "-b", "main", remote.to_str().unwrap()],
    );
    git(&root, &["init", "-b", "main"]);
    git(&root, &["config", "user.name", "Fixture"]);
    git(&root, &["config", "user.email", "fixture@example.test"]);
    git(&root, &["lfs", "install", "--local"]);
    git(&root, &["lfs", "track", "*.bin"]);
    std::fs::create_dir(root.join(".svode")).unwrap();
    std::fs::write(
        root.join(".svode/config.json"),
        r#"{"name":"Project","assets":{"strategy":"lfs-remote"}}"#,
    )
    .unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-m", "initial"]);
    git(
        &root,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    git(&root, &["push", "-u", "origin", "main"]);
    let wrapper = temp.path().join("git-test");
    svode_testkit::write_executable(
        &wrapper,
        format!(
            "#!/bin/sh
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
marks='{marks}'
case \" $* \" in
*' lfs push '*)
  git -c protocol.file.allow=always \"$@\" || exit $?
  touch \"$marks/sent\"
  while [ ! -e \"$marks/release\" ]; do sleep 0.05; done
  exit 0 ;;
*' push --progress '*)
  ls \"$marks\" > \"$marks/at-push\" ;;
esac
exec git -c protocol.file.allow=always \"$@\"
",
            marks = marks.display()
        ),
    )
    .unwrap();
    Fixture {
        root: std::fs::canonicalize(&root).unwrap(),
        remote,
        marks,
        cli: GitCli::for_test(wrapper),
        _temp: temp,
    }
}

#[tokio::test]
async fn lfs_content_travels_before_the_lock_and_commits_made_meanwhile_inside_the_push() {
    if !lfs_available() {
        eprintln!("git-lfs is not installed; skipped");
        return;
    }
    let f = fixture();
    std::fs::write(f.root.join("video.bin"), "first LFS content\n".repeat(4096)).unwrap();
    git(&f.root, &["add", "video.bin"]);
    git(&f.root, &["commit", "-m", "video"]);
    let first = lfs_oid(&f.root, "video.bin");

    let runtime = Arc::new(GitRuntime::with_cli(f.cli.clone()));
    let host: Arc<dyn GitHost> = Arc::new(TestHost::default());
    let sync = tokio::spawn({
        let (runtime, host, root) = (runtime.clone(), host.clone(), f.root.clone());
        async move { flow::sync(&runtime, &host, &root, false).await }
    });

    // The content is on the server while the publication still transfers.
    appears(&f.marks.join("sent")).await;
    assert!(stored(&f.remote, &first));
    assert_ne!(
        git(&f.remote, &["rev-parse", "main"]),
        git(&f.root, &["rev-parse", "HEAD"])
    );

    // Status and a commit under the repository lock do not wait for it.
    tokio::time::timeout(Duration::from_secs(10), runtime.status(&f.root, false))
        .await
        .expect("status waits for the transfer")
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        let lock = runtime.get_lock(&f.root).await;
        let _guard = lock.lock().await;
        std::fs::write(
            f.root.join("photo.bin"),
            "second LFS content\n".repeat(2048),
        )
        .unwrap();
        git(&f.root, &["add", "photo.bin"]);
        git(&f.root, &["commit", "-m", "photo"]);
    })
    .await
    .expect("a commit waits for the transfer");
    let second = lfs_oid(&f.root, "photo.bin");
    assert!(!stored(&f.remote, &second));
    assert!(!sync.is_finished());

    std::fs::write(f.marks.join("release"), "").unwrap();
    let report = sync.await.unwrap().unwrap();
    assert!(report.synced(), "{report:?}");
    assert_eq!(
        git(&f.remote, &["rev-parse", "main"]),
        git(&f.root, &["rev-parse", "HEAD"])
    );
    // The push found the first object sent and sent the second itself.
    let at_push = std::fs::read_to_string(f.marks.join("at-push")).unwrap();
    assert!(at_push.lines().any(|mark| mark == "sent"), "{at_push}");
    assert!(stored(&f.remote, &first));
    assert!(stored(&f.remote, &second));
}

#[tokio::test]
async fn a_repository_without_an_lfs_strategy_sends_nothing_before_the_push() {
    if !lfs_available() {
        eprintln!("git-lfs is not installed; skipped");
        return;
    }
    let f = fixture();
    std::fs::write(
        f.root.join(".svode/config.json"),
        r#"{"name":"Project","assets":{"strategy":"in-git"}}"#,
    )
    .unwrap();
    std::fs::write(f.root.join("note.md"), "text\n").unwrap();
    git(&f.root, &["add", "."]);
    git(&f.root, &["commit", "-m", "in git"]);
    // Released from the start: an `lfs push` would mark `sent`.
    std::fs::write(f.marks.join("release"), "").unwrap();
    let runtime = Arc::new(GitRuntime::with_cli(f.cli.clone()));
    let host: Arc<dyn GitHost> = Arc::new(TestHost::default());
    let report = flow::sync(&runtime, &host, &f.root, false).await.unwrap();
    assert!(report.synced(), "{report:?}");
    assert!(!f.marks.join("sent").exists());
    assert_eq!(
        git(&f.remote, &["rev-parse", "main"]),
        git(&f.root, &["rev-parse", "HEAD"])
    );
}

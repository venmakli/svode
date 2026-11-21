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

struct OutOfReach {
    _temp: tempfile::TempDir,
    root: PathBuf,
    remote: PathBuf,
    server: Server,
}

/// An LFS file server at an SSH host that does not answer, as `ssh` reports
/// it after its connection time limit, behind a Git whose every push
/// records `pushed` in `marks`.
struct Server {
    cli: GitCli,
    marks: PathBuf,
    log: PathBuf,
}

impl Server {
    const URL: &str = "ssh://lfs@10.255.255.1:2222/project";

    fn new(dir: &Path) -> Self {
        let marks = dir.join("marks");
        let log = dir.join("ssh.log");
        std::fs::create_dir_all(&marks).unwrap();
        let ssh = dir.join("ssh");
        svode_testkit::write_executable(
            &ssh,
            format!(
                "#!/bin/sh
echo \"$*\" >> '{log}'
echo 'ssh: connect to host 10.255.255.1 port 2222: Operation timed out' >&2
exit 255
",
                log = log.display()
            ),
        )
        .unwrap();
        let wrapper = dir.join("git-unreachable");
        svode_testkit::write_executable(
            &wrapper,
            format!(
                "#!/bin/sh
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_SSH_COMMAND='{ssh}'
case \" $* \" in
*' push --progress '*) touch '{marks}/pushed' ;;
esac
exec git -c protocol.file.allow=always \"$@\"
",
                ssh = ssh.display(),
                marks = marks.display()
            ),
        )
        .unwrap();
        Self {
            cli: GitCli::for_test(wrapper),
            marks,
            log,
        }
    }

    /// The SSH connections git-lfs made to the server since the last
    /// [`Self::connections_of_one_push`].
    fn connections(&self) -> usize {
        std::fs::read_to_string(&self.log)
            .map(|log| log.lines().count())
            .unwrap_or(0)
    }

    /// The connections of one git-lfs operation of `repo` against the
    /// server, after which the count starts again.
    async fn connections_of_one_push(&self, repo: &Path) -> usize {
        let out = self
            .cli
            .exec(repo, &["lfs", "push", "--", "origin", "HEAD"])
            .await
            .unwrap();
        assert_ne!(out.exit_code, 0, "{}", out.stderr);
        let once = self.connections();
        assert!(once > 0);
        std::fs::write(&self.log, "").unwrap();
        once
    }

    fn pushed(&self) -> bool {
        self.marks.join("pushed").exists()
    }
}

/// A published `lfs-remote` project whose file server is out of reach
/// while its Git remote stays reachable.
fn out_of_reach() -> OutOfReach {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("project");
    let remote = temp.path().join("remote.git");
    std::fs::create_dir(&root).unwrap();
    git(
        temp.path(),
        &["init", "--bare", "-b", "main", remote.to_str().unwrap()],
    );
    git(&root, &["init", "-b", "main"]);
    git(&root, &["config", "user.name", "Fixture"]);
    git(&root, &["config", "user.email", "fixture@example.test"]);
    git(
        &root,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    lfs_remote_project(&root);
    OutOfReach {
        root: std::fs::canonicalize(&root).unwrap(),
        remote,
        server: Server::new(temp.path()),
        _temp: temp,
    }
}

/// Publish `root` as an `lfs-remote` project, then move its file server to
/// [`Server::URL`].
fn lfs_remote_project(root: &Path) {
    git(root, &["lfs", "install", "--local"]);
    git(root, &["lfs", "track", "*.bin"]);
    std::fs::create_dir_all(root.join(".svode")).unwrap();
    std::fs::write(
        root.join(".svode/config.json"),
        r#"{"name":"Project","assets":{"strategy":"lfs-remote"}}"#,
    )
    .unwrap();
    git(root, &["add", ".gitattributes", ".svode/config.json"]);
    git(root, &["commit", "-m", "lfs"]);
    git(root, &["push", "-u", "origin", "main"]);
    git(root, &["config", "lfs.url", Server::URL]);
}

fn commit_video(repo: &Path) {
    std::fs::write(repo.join("video.bin"), "LFS content\n".repeat(4096)).unwrap();
    git(repo, &["add", "video.bin"]);
    git(repo, &["commit", "-m", "video"]);
}

fn file_server_unreachable(failure: Option<&crate::git::diagnostics::GitFailure>) -> bool {
    failure.is_some_and(|failure| {
        failure.stage == crate::git::diagnostics::GitStage::Push
            && failure.cause
                == Some(crate::git::diagnostics::GitFailureCause::FileServerUnreachable)
    })
}

/// DF-378 R4, R5: after the LFS send before the lock could not reach the
/// file server, the sync does not connect to it again: no push, whose hook
/// would, no download after the sync; it ends with its own cause.
#[tokio::test]
async fn an_unreachable_file_server_ends_the_sync_without_contacting_it_again() {
    if !lfs_available() {
        eprintln!("git-lfs is not installed; skipped");
        return;
    }
    let f = out_of_reach();
    commit_video(&f.root);
    let once = f.server.connections_of_one_push(&f.root).await;

    let runtime = Arc::new(GitRuntime::with_cli(f.server.cli.clone()));
    let test_host = Arc::new(TestHost::default());
    let host: Arc<dyn GitHost> = test_host.clone();
    let error = flow::sync(&runtime, &host, &f.root, false)
        .await
        .unwrap_err();
    assert!(file_server_unreachable(error.failure()), "{error:?}");
    assert_eq!(f.server.connections(), once);
    assert!(!f.server.pushed());
    assert_ne!(
        git(&f.remote, &["rev-parse", "main"]),
        git(&f.root, &["rev-parse", "HEAD"])
    );
    // The download of DF-368 follows only a successful sync.
    assert!(test_host.refreshed.lock().unwrap().is_empty());
}

/// DF-378 R4: commits without LFS content to send publish as before while
/// the file server is out of reach.
#[tokio::test]
async fn commits_without_lfs_content_publish_while_the_file_server_is_out_of_reach() {
    if !lfs_available() {
        eprintln!("git-lfs is not installed; skipped");
        return;
    }
    let f = out_of_reach();
    std::fs::write(f.root.join("note.md"), "text\n").unwrap();
    git(&f.root, &["add", "note.md"]);
    git(&f.root, &["commit", "-m", "note"]);
    let runtime = Arc::new(GitRuntime::with_cli(f.server.cli.clone()));
    let host: Arc<dyn GitHost> = Arc::new(TestHost::default());
    let report = flow::sync(&runtime, &host, &f.root, false).await.unwrap();
    assert!(report.synced(), "{report:?}");
    assert_eq!(
        git(&f.remote, &["rev-parse", "main"]),
        git(&f.root, &["rev-parse", "HEAD"])
    );
}

/// DF-378 R4: a Space sync whose project could not reach its file server
/// publishes the Space, and its pointer step does not push the project,
/// whose hook would contact the server again.
#[tokio::test]
async fn the_pointer_step_does_not_push_a_project_whose_file_server_is_out_of_reach() {
    if !lfs_available() {
        eprintln!("git-lfs is not installed; skipped");
        return;
    }
    let f = super::Fixture::new();
    lfs_remote_project(&f.root);
    crate::git::policy::write_user_policy(
        &f.root,
        &crate::git::policy::GitUserPolicy {
            auto_sync: true,
            auto_commit_structural: true,
            auto_commit_system: false,
            auto_commit_content: false,
        },
    )
    .unwrap();
    commit_video(&f.root);
    super::commit(&f.child, "note", "space edit");
    let server = Server::new(f._temp.path());
    let once = server.connections_of_one_push(&f.root).await;

    let runtime = Arc::new(GitRuntime::with_cli(server.cli.clone()));
    let host: Arc<dyn GitHost> = Arc::new(TestHost::default());
    let report = flow::sync(&runtime, &host, &f.child, false).await.unwrap();
    assert!(report.synced(), "{report:?}");
    assert_eq!(
        git(&f.source, &["rev-parse", "main"]),
        git(&f.child, &["rev-parse", "HEAD"])
    );
    let parent = report.parent.as_ref().expect("the pointer step");
    assert!(
        file_server_unreachable(parent.error.as_ref().and_then(|error| error.failure())),
        "{parent:?}"
    );
    assert_eq!(server.connections(), once);
    assert_ne!(
        git(&f.remote, &["rev-parse", "main"]),
        git(&f.root, &["rev-parse", "HEAD"])
    );
}

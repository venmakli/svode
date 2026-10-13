#![cfg(unix)]

use super::*;
use std::path::PathBuf;
use std::process::{Command, Output};
use tempfile::TempDir;

struct Fixture {
    _temp: TempDir,
    local: PathBuf,
    other: PathBuf,
    cli: GitCli,
}

fn run(repo: &Path, args: &[&str]) -> Output {
    Command::new("git")
        .args(args)
        .current_dir(repo)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap()
}

fn git(repo: &Path, args: &[&str]) -> String {
    let out = run(repo, args);
    assert!(
        out.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout)
        .unwrap()
        .trim_end()
        .to_string()
}

fn commit(repo: &Path, files: &[(&str, Option<&str>)], message: &str) {
    for (path, content) in files {
        match content {
            Some(content) => std::fs::write(repo.join(path), content).unwrap(),
            None => std::fs::remove_file(repo.join(path)).unwrap(),
        }
    }
    git(repo, &["add", "-A"]);
    git(repo, &["commit", "-m", message]);
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let remote = temp.path().join("remote.git");
        let local = temp.path().join("local");
        let other = temp.path().join("other");
        git(
            temp.path(),
            &["init", "--bare", "-b", "main", remote.to_str().unwrap()],
        );
        for repo in [&local, &other] {
            git(
                temp.path(),
                &["clone", remote.to_str().unwrap(), repo.to_str().unwrap()],
            );
            git(repo, &["config", "user.name", "Fixture"]);
            git(repo, &["config", "user.email", "fixture@example.test"]);
            git(repo, &["checkout", "-B", "main"]);
        }
        commit(
            &local,
            &[
                ("Page.md", Some("base\n")),
                ("order.json", Some("[1]\n")),
                ("gone.md", Some("base\n")),
            ],
            "initial",
        );
        git(&local, &["push", "-u", "origin", "main"]);
        git(&other, &["pull", "origin", "main"]);
        git(&other, &["branch", "--set-upstream-to=origin/main", "main"]);
        let wrapper = temp.path().join("git-test");
        svode_testkit::write_executable(
            &wrapper,
            "#!/bin/sh\nexport GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1\nexec git \"$@\"\n",
        )
        .unwrap();
        Self {
            _temp: temp,
            local,
            other,
            cli: GitCli::for_test(wrapper),
        }
    }

    /// Leave `local` in a merge with a Page, a data file and modify/delete.
    async fn conflicted_sync(&self) {
        commit(
            &self.other,
            &[
                ("Page.md", Some("remote\n")),
                ("order.json", Some("[2]\n")),
                ("gone.md", None),
            ],
            "remote",
        );
        git(&self.other, &["push"]);
        commit(
            &self.local,
            &[
                ("Page.md", Some("local\n")),
                ("order.json", Some("[3]\n")),
                ("gone.md", Some("local\n")),
            ],
            "local",
        );
        assert!(matches!(
            sync(&self.cli, &self.local).await.unwrap(),
            SyncResult::Conflict { .. }
        ));
    }

    fn remote_head(&self) -> String {
        git(&self.local, &["ls-remote", "origin", "refs/heads/main"])
    }
}

#[tokio::test]
async fn sync_during_merge_returns_the_conflict_with_its_files() {
    let f = Fixture::new();
    f.conflicted_sync().await;
    let head = git(&f.local, &["rev-parse", "HEAD"]);
    let merge_head = git(&f.local, &["rev-parse", "MERGE_HEAD"]);
    let remote = f.remote_head();

    let SyncResult::Conflict { mut files } = sync(&f.cli, &f.local).await.unwrap() else {
        panic!("sync during a merge must return the sync conflict");
    };
    files.sort();
    assert_eq!(files, ["Page.md", "gone.md", "order.json"]);
    assert_eq!(git(&f.local, &["rev-parse", "HEAD"]), head);
    assert_eq!(git(&f.local, &["rev-parse", "MERGE_HEAD"]), merge_head);
    assert_eq!(f.remote_head(), remote);
}

#[tokio::test]
async fn preflight_reads_a_merge_without_conflicted_files_and_a_clean_repository() {
    let f = Fixture::new();
    assert!(preflight(&f.cli, &f.local).await.unwrap().is_none());
    f.conflicted_sync().await;
    git(&f.local, &["add", "-A"]);
    assert!(matches!(
        preflight(&f.cli, &f.local).await.unwrap(),
        Some(SyncResult::Conflict { files }) if files.is_empty()
    ));
    git(&f.local, &["merge", "--abort"]);
    assert!(preflight(&f.cli, &f.local).await.unwrap().is_none());
}

#[tokio::test]
async fn sync_names_other_operations_without_pull_or_push() {
    for (operation, start) in [
        (GitOperation::Rebase, ["rebase", "side"]),
        (GitOperation::CherryPick, ["cherry-pick", "side"]),
        (GitOperation::Revert, ["revert", "HEAD~1"]),
    ] {
        let f = Fixture::new();
        commit(&f.other, &[("remote.md", Some("remote\n"))], "remote");
        git(&f.other, &["push"]);
        git(&f.local, &["branch", "side"]);
        git(&f.local, &["checkout", "side"]);
        commit(&f.local, &[("Page.md", Some("side\n"))], "side");
        git(&f.local, &["checkout", "main"]);
        commit(&f.local, &[("Page.md", Some("main\n"))], "main one");
        commit(&f.local, &[("Page.md", Some("main two\n"))], "main two");
        assert!(!run(&f.local, &start).status.success(), "{start:?}");
        let head = git(&f.local, &["rev-parse", "HEAD"]);
        let remote = f.remote_head();

        assert!(
            matches!(
                sync(&f.cli, &f.local).await.unwrap(),
                SyncResult::OperationInProgress { operation: actual } if actual == operation
            ),
            "{operation:?}"
        );
        assert_eq!(git(&f.local, &["rev-parse", "HEAD"]), head);
        assert_eq!(f.remote_head(), remote);
        assert!(!f.local.join("remote.md").exists());
    }
}

#[test]
fn operation_result_serializes_with_the_operation_name() {
    assert_eq!(
        serde_json::to_value(SyncResult::OperationInProgress {
            operation: GitOperation::CherryPick,
        })
        .unwrap(),
        serde_json::json!({ "type": "operationInProgress", "operation": "cherry_pick" })
    );
}

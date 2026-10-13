#![cfg(unix)]
use super::GitError;
use super::cli::GitCli;
use super::sync::{SyncResult, resolve_and_continue, sync};
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(repo: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
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

fn lines(output: String) -> Vec<String> {
    output.lines().map(str::to_string).collect()
}

fn write(repo: &Path, file: &str, value: &str) {
    let path = repo.join(file);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, value).unwrap();
}

fn init(repo: &Path) {
    std::fs::create_dir_all(repo).unwrap();
    git(repo, &["init", "-b", "main"]);
    git(repo, &["config", "user.name", "Fixture"]);
    git(repo, &["config", "user.email", "fixture@example.test"]);
}

fn test_cli(temp: &Path) -> GitCli {
    let wrapper = temp.join("git-test");
    svode_testkit::write_executable(
        &wrapper,
        "#!/bin/sh\nexport GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1\nexec git \"$@\"\n",
    )
    .unwrap();
    GitCli::for_test(wrapper)
}

/// Two clones of one remote; pulling into `local` conflicts in `plan.md`,
/// `.svode/order.json` and `old.md` (modify/delete) while `notes.md` and
/// `stray.md` carry unrelated uncommitted work.
struct MergeFixture {
    _temp: tempfile::TempDir,
    remote: PathBuf,
    local: PathBuf,
    cli: GitCli,
}

impl MergeFixture {
    async fn conflicted() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let seed = temp.path().join("seed");
        init(&seed);
        write(&seed, "plan.md", "# Plan\n\nshared line\n");
        write(&seed, "old.md", "old\n");
        write(&seed, "notes.md", "notes\n");
        write(&seed, ".svode/order.json", "{\"order\":[\"plan.md\"]}\n");
        git(&seed, &["add", "."]);
        git(&seed, &["commit", "-m", "base"]);
        let remote = temp.path().join("remote.git");
        git(
            temp.path(),
            &[
                "clone",
                "--bare",
                seed.to_str().unwrap(),
                remote.to_str().unwrap(),
            ],
        );

        let other = temp.path().join("other");
        let local = temp.path().join("local");
        for clone in [&other, &local] {
            git(
                temp.path(),
                &["clone", remote.to_str().unwrap(), clone.to_str().unwrap()],
            );
            git(clone, &["config", "user.name", "Fixture"]);
            git(clone, &["config", "user.email", "fixture@example.test"]);
        }
        write(&other, "plan.md", "# Plan\n\ntheir line\n");
        write(
            &other,
            ".svode/order.json",
            "{\"order\":[\"plan.md\",\"theirs.md\"]}\n",
        );
        git(&other, &["rm", "-q", "old.md"]);
        git(&other, &["commit", "-am", "theirs"]);
        git(&other, &["push", "-q", "origin", "main"]);

        write(&local, "plan.md", "# Plan\n\nour line\n");
        write(
            &local,
            ".svode/order.json",
            "{\"order\":[\"plan.md\",\"ours.md\"]}\n",
        );
        write(&local, "old.md", "old, kept\n");
        git(&local, &["commit", "-am", "ours"]);
        write(&local, "notes.md", "unsaved notes\n");
        write(&local, "stray.md", "stray\n");

        let cli = test_cli(temp.path());
        let result = sync(&cli, &local).await.unwrap();
        let SyncResult::Conflict { mut files } = result else {
            panic!("{result:?}");
        };
        files.sort();
        assert_eq!(files, [".svode/order.json", "old.md", "plan.md"]);
        Self {
            _temp: temp,
            remote,
            local,
            cli,
        }
    }

    async fn resolve(&self, paths: &[&str]) -> Result<SyncResult, GitError> {
        let paths = paths
            .iter()
            .map(|path| path.to_string())
            .collect::<Vec<_>>();
        resolve_and_continue(&self.cli, &self.local, &paths).await
    }

    fn unmerged(&self) -> Vec<String> {
        let mut files = lines(git(
            &self.local,
            &["diff", "--name-only", "--diff-filter=U"],
        ));
        files.dedup();
        files
    }

    fn remote_main(&self) -> String {
        git(&self.remote, &["rev-parse", "main"])
    }
}

#[tokio::test]
async fn resolving_one_path_keeps_the_merge_open_and_unrelated_work_unstaged() {
    let f = MergeFixture::conflicted().await;
    let head = git(&f.local, &["rev-parse", "HEAD"]);
    let remote = f.remote_main();

    // A lone `=======` is a Markdown heading underline, not a marker.
    write(
        &f.local,
        "plan.md",
        "Plan\n=======\n\nour line\ntheir line\n",
    );
    // A passed path that still carries markers is refused without touching the index.
    let index = git(&f.local, &["ls-files", "--stage"]);
    let refused = f.resolve(&["plan.md", ".svode/order.json"]).await;
    assert!(matches!(refused, Err(GitError::Conflict(_))), "{refused:?}");
    assert_eq!(git(&f.local, &["ls-files", "--stage"]), index);

    let result = f
        .resolve(&["plan.md", "notes.md", "stray.md"])
        .await
        .unwrap();
    let SyncResult::Conflict { mut files } = result else {
        panic!("{result:?}");
    };
    files.sort();
    assert_eq!(files, [".svode/order.json", "old.md"]);
    assert_eq!(f.unmerged(), [".svode/order.json", "old.md"]);
    assert_eq!(git(&f.local, &["rev-parse", "HEAD"]), head);
    // The merge stays in progress.
    git(&f.local, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    assert_eq!(f.remote_main(), remote);
    let staged = lines(git(&f.local, &["diff", "--cached", "--name-only"]));
    assert!(staged.contains(&"plan.md".to_string()), "{staged:?}");
    assert!(!staged.contains(&"notes.md".to_string()), "{staged:?}");
    assert!(!staged.contains(&"stray.md".to_string()), "{staged:?}");
}

#[tokio::test]
async fn merge_commit_holds_only_the_merge_and_resolved_paths_and_is_pushed() {
    let f = MergeFixture::conflicted().await;
    let ours = git(&f.local, &["rev-parse", "HEAD"]);
    write(&f.local, "plan.md", "# Plan\n\nour line\ntheir line\n");
    assert!(matches!(
        f.resolve(&["plan.md"]).await.unwrap(),
        SyncResult::Conflict { .. }
    ));
    write(
        &f.local,
        ".svode/order.json",
        "{\"order\":[\"plan.md\",\"ours.md\",\"theirs.md\"]}\n",
    );
    let result = f.resolve(&[".svode/order.json", "old.md"]).await.unwrap();
    let SyncResult::Success { published_head } = result else {
        panic!("{result:?}");
    };

    let head = git(&f.local, &["rev-parse", "HEAD"]);
    assert_eq!(published_head, head);
    assert_eq!(f.remote_main(), head);
    assert_eq!(git(&f.local, &["rev-parse", "HEAD^1"]), ours);
    assert!(f.unmerged().is_empty());
    let mut committed = lines(git(&f.local, &["diff", "--name-only", "HEAD^1", "HEAD"]));
    committed.sort();
    assert_eq!(committed, [".svode/order.json", "plan.md"]);
    assert_eq!(git(&f.local, &["show", "HEAD:old.md"]), "old, kept");
    assert_eq!(git(&f.local, &["show", "HEAD:notes.md"]), "notes");
    assert!(
        git(&f.local, &["ls-tree", "--name-only", "HEAD", "stray.md"]).is_empty(),
        "untracked work stays out of the merge"
    );
    assert_eq!(
        git(&f.local, &["status", "--porcelain"]),
        " M notes.md\n?? stray.md"
    );
}

#[tokio::test]
async fn conflicts_without_a_merge_never_commit() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    init(&repo);
    write(&repo, "plan.md", "base plan\n");
    write(&repo, "old.md", "base old\n");
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-m", "base"]);
    write(&repo, "plan.md", "stashed plan\n");
    write(&repo, "old.md", "stashed old\n");
    git(&repo, &["stash"]);
    write(&repo, "plan.md", "committed plan\n");
    write(&repo, "old.md", "committed old\n");
    git(&repo, &["commit", "-am", "committed"]);
    let pop = Command::new("git")
        .args(["stash", "pop"])
        .current_dir(&repo)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(!pop.status.success());
    let cli = test_cli(temp.path());
    let head = git(&repo, &["rev-parse", "HEAD"]);

    write(&repo, "plan.md", "resolved plan\n");
    let result = resolve_and_continue(&cli, &repo, &["plan.md".into()])
        .await
        .unwrap();
    assert!(
        matches!(&result, SyncResult::Conflict { files } if files == &["old.md"]),
        "{result:?}"
    );

    write(&repo, "old.md", "resolved old\n");
    let result = resolve_and_continue(&cli, &repo, &["old.md".into()])
        .await
        .unwrap();
    assert!(matches!(result, SyncResult::Resolved), "{result:?}");
    assert_eq!(git(&repo, &["rev-parse", "HEAD"]), head);
    assert!(git(&repo, &["ls-files", "--unmerged"]).is_empty());
    assert!(!super::ops::status(&cli, &repo).await.unwrap().has_conflicts);
}

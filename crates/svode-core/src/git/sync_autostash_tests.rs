#![cfg(unix)]
use super::*;
use std::path::PathBuf;
use std::process::{Command, Output};

fn run(repo: &Path, global: &Path, args: &[&str]) -> Output {
    Command::new("git")
        .args(args)
        .current_dir(repo)
        .env("GIT_CONFIG_GLOBAL", global)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap()
}

/// Two clones of one remote; `other` has pushed a change to the line of
/// `q.md` that `local` edits without committing. Git runs with `global` as
/// the user's config, the way Svode runs it.
struct Fixture {
    temp: tempfile::TempDir,
    global: PathBuf,
    remote: PathBuf,
    local: PathBuf,
    cli: GitCli,
}

impl Fixture {
    fn new(user_config: &str) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let global = temp.path().join("gitconfig");
        std::fs::write(
            &global,
            format!("[user]\n\tname = Fixture\n\temail = fixture@example.test\n{user_config}"),
        )
        .unwrap();
        let remote = temp.path().join("remote.git");
        let other = temp.path().join("other");
        let local = temp.path().join("local");
        let f = Self {
            global: global.clone(),
            remote: remote.clone(),
            local: local.clone(),
            cli: GitCli::for_test(temp.path().join("git-test")),
            temp,
        };
        svode_testkit::write_executable(
            &f.temp.path().join("git-test"),
            &format!(
                "#!/bin/sh\nexport GIT_CONFIG_GLOBAL='{}' GIT_CONFIG_NOSYSTEM=1\nexec git \"$@\"\n",
                global.display()
            ),
        )
        .unwrap();
        let root = f.temp.path();
        f.git(
            root,
            &["init", "--bare", "-b", "main", remote.to_str().unwrap()],
        );
        for clone in [&other, &local] {
            f.git(
                root,
                &[
                    "clone",
                    "-q",
                    remote.to_str().unwrap(),
                    clone.to_str().unwrap(),
                ],
            );
            f.git(clone, &["checkout", "-q", "-B", "main"]);
        }
        std::fs::write(local.join("q.md"), "base\n").unwrap();
        f.git(&local, &["add", "q.md"]);
        f.git(&local, &["commit", "-qm", "base"]);
        f.git(&local, &["push", "-q", "-u", "origin", "main"]);
        f.git(&other, &["pull", "-q", "origin", "main"]);
        std::fs::write(other.join("q.md"), "remote\n").unwrap();
        f.git(&other, &["commit", "-qam", "remote"]);
        f.git(&other, &["push", "-q", "origin", "main"]);
        f
    }

    fn git(&self, repo: &Path, args: &[&str]) -> String {
        let out = run(repo, &self.global, args);
        assert!(
            out.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap().trim_end().into()
    }

    fn remote_main(&self) -> String {
        self.git(&self.remote, &["rev-parse", "main"])
    }
}

/// `pull.autostash` exists since Git 2.51.
fn supports_pull_autostash(f: &Fixture) -> bool {
    let version = f.git(f.temp.path(), &["--version"]);
    let mut parts = version
        .trim_start_matches("git version ")
        .split(|c: char| !c.is_ascii_digit())
        .filter_map(|part| part.parse::<u32>().ok());
    (parts.next().unwrap_or(0), parts.next().unwrap_or(0)) >= (2, 51)
}

#[tokio::test]
async fn sync_pull_never_stashes_overlapping_work_whatever_the_user_config() {
    for user_config in [
        "",
        "[pull]\n\tautostash = true\n[merge]\n\tautoStash = true\n",
    ] {
        let f = Fixture::new(user_config);
        if !user_config.is_empty() && !supports_pull_autostash(&f) {
            eprintln!(
                "skipped pull.autostash: {}",
                f.git(f.temp.path(), &["--version"])
            );
            continue;
        }
        std::fs::write(f.local.join("q.md"), "local edit\n").unwrap();
        let head = f.git(&f.local, &["rev-parse", "HEAD"]);

        let result = sync(&f.cli, &f.local).await;
        assert!(
            matches!(&result, Err(GitError::PullBlocked { files, .. }) if files == &["q.md"]),
            "{user_config:?}: {result:?}"
        );
        assert_eq!(f.git(&f.local, &["stash", "list"]), "", "{user_config:?}");
        assert_eq!(
            std::fs::read_to_string(f.local.join("q.md")).unwrap(),
            "local edit\n"
        );
        assert_eq!(f.git(&f.local, &["rev-parse", "HEAD"]), head);
        assert!(f.git(&f.local, &["ls-files", "--unmerged"]).is_empty());
    }
}

impl Fixture {
    /// A local commit to push, and a post-merge hook that stands in for an
    /// autostash failing to apply after a successful merge.
    fn conflicting_merge(&self) {
        std::fs::write(self.local.join("local.md"), "local\n").unwrap();
        self.git(&self.local, &["add", "local.md"]);
        self.git(&self.local, &["commit", "-qm", "local"]);
        svode_testkit::write_executable(
            &self.local.join(".git/hooks/post-merge"),
            "#!/bin/sh\n\
             base=$(echo base | git hash-object -w --stdin)\n\
             ours=$(echo ours | git hash-object -w --stdin)\n\
             theirs=$(echo theirs | git hash-object -w --stdin)\n\
             printf '0 %s\\tq.md\\n100644 %s 1\\tq.md\\n100644 %s 2\\tq.md\\n100644 %s 3\\tq.md\\n' \
               0000000000000000000000000000000000000000 $base $ours $theirs | git update-index --index-info\n",
        )
        .unwrap();
    }
}

#[tokio::test]
async fn pull_that_succeeds_with_conflicted_files_is_not_pushed() {
    for (case, matching_edit) in [
        ("upstream", false),
        ("first publication", false),
        ("upstream after a matching edit", true),
        ("first publication after a matching edit", true),
    ] {
        let f = Fixture::new("");
        f.conflicting_merge();
        if case.starts_with("first publication") {
            f.git(&f.local, &["branch", "--unset-upstream"]);
        }
        if matching_edit {
            // Refuses the pull, is set aside, and the merge is retried.
            std::fs::write(f.local.join("q.md"), "remote\n").unwrap();
        }
        let remote = f.remote_main();

        let result = sync(&f.cli, &f.local).await.unwrap();
        assert!(
            matches!(&result, SyncResult::UnmergedFiles { files } if files == &["q.md"]),
            "{case}: {result:?}"
        );
        assert_eq!(
            f.git(&f.local, &["rev-parse", "HEAD^2"]),
            remote,
            "{case}: the incoming revision is merged"
        );
        assert_eq!(f.remote_main(), remote, "{case}");
    }
}

#[tokio::test]
async fn conflicted_files_without_an_operation_stop_sync_before_pull_and_keep_the_stash() {
    let f = Fixture::new("");
    std::fs::write(f.local.join("q.md"), "stashed\n").unwrap();
    f.git(&f.local, &["stash", "-q"]);
    std::fs::write(f.local.join("q.md"), "committed\n").unwrap();
    f.git(&f.local, &["commit", "-qam", "committed"]);
    assert!(!run(&f.local, &f.global, &["stash", "pop"]).status.success());
    let stash = f.git(&f.local, &["stash", "list"]);
    let head = f.git(&f.local, &["rev-parse", "HEAD"]);
    let remote = f.remote_main();

    let expected = |result: &SyncResult| matches!(result, SyncResult::UnmergedFiles { files } if files == &["q.md"]);
    let stopped = preflight(&f.cli, &f.local).await.unwrap();
    assert!(stopped.as_ref().is_some_and(expected), "{stopped:?}");
    let result = sync(&f.cli, &f.local).await.unwrap();
    assert!(expected(&result), "{result:?}");
    assert_eq!(f.git(&f.local, &["stash", "list"]), stash);
    assert_eq!(f.git(&f.local, &["rev-parse", "HEAD"]), head);
    assert_eq!(f.remote_main(), remote);
    assert_eq!(
        serde_json::to_value(result).unwrap(),
        serde_json::json!({ "type": "unmergedFiles", "files": ["q.md"] })
    );
}

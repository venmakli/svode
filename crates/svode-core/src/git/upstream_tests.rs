#![cfg(unix)]
use super::*;
use crate::git::sync::{SyncResult, sync};
use std::path::PathBuf;
use std::process::{Command, Output};

/// User configurations that change the semantics of `git pull`, `git merge`
/// or `git fetch`; sync must give the same result under each.
const USER_CONFIGS: &[&str] = &[
    "",
    "[pull]\n\tff = only\n",
    "[merge]\n\tff = only\n",
    "[pull]\n\trebase = true\n",
    "[pull]\n\tautoStash = true\n[merge]\n\tautoStash = true\n",
    "[rerere]\n\tenabled = true\n\tautoUpdate = true\n",
    "[submodule]\n\trecurse = true\n",
    "[pull]\n\ttwohead = ours\n",
    "[branch \"main\"]\n\tmergeOptions = --squash --no-commit\n",
];

fn run(repo: &Path, global: &Path, args: &[&str]) -> Output {
    Command::new("git")
        .args(args)
        .current_dir(repo)
        .env("GIT_CONFIG_GLOBAL", global)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap()
}

/// Two clones of one remote with a common `base` commit. Git runs with
/// `global` as the user's config, the way Svode runs it.
struct Fixture {
    temp: tempfile::TempDir,
    global: PathBuf,
    remote: PathBuf,
    other: PathBuf,
    local: PathBuf,
    cli: GitCli,
}

impl Fixture {
    fn new(user_config: &str) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let global = temp.path().join("gitconfig");
        std::fs::write(
            &global,
            format!(
                "[user]\n\tname = Fixture\n\temail = fixture@example.test\n\
                 [protocol \"file\"]\n\tallow = always\n{user_config}"
            ),
        )
        .unwrap();
        let wrapper = temp.path().join("git-test");
        svode_testkit::write_executable(
            &wrapper,
            &format!(
                "#!/bin/sh\nexport GIT_CONFIG_GLOBAL='{}' GIT_CONFIG_NOSYSTEM=1\nexec git \"$@\"\n",
                global.display()
            ),
        )
        .unwrap();
        let f = Self {
            remote: temp.path().join("remote.git"),
            other: temp.path().join("other"),
            local: temp.path().join("local"),
            cli: GitCli::for_test(wrapper),
            global,
            temp,
        };
        f.seed(
            &f.remote,
            &f.local,
            &[("q.md", "base\n"), ("r.md", "base\n")],
        );
        f.clone_into(&f.remote, &f.other);
        f
    }

    /// Creates the bare `remote` and its clone `clone` with one commit of
    /// `files` on `main`, published with upstream.
    fn seed(&self, remote: &Path, clone: &Path, files: &[(&str, &str)]) {
        let root = self.temp.path();
        self.git(
            root,
            &[
                "init",
                "-q",
                "--bare",
                "-b",
                "main",
                remote.to_str().unwrap(),
            ],
        );
        self.clone_into(remote, clone);
        self.git(clone, &["checkout", "-q", "-B", "main"]);
        for (path, content) in files {
            std::fs::write(clone.join(path), content).unwrap();
        }
        self.git(clone, &["add", "."]);
        self.git(clone, &["commit", "-qm", "base"]);
        self.git(clone, &["push", "-q", "-u", "origin", "main"]);
    }

    fn clone_into(&self, remote: &Path, clone: &Path) {
        self.git(
            self.temp.path(),
            &[
                "clone",
                "-q",
                remote.to_str().unwrap(),
                clone.to_str().unwrap(),
            ],
        );
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

    fn commit(&self, repo: &Path, path: &str, content: &str) -> String {
        std::fs::write(repo.join(path), content).unwrap();
        self.git(repo, &["commit", "-qam", path]);
        self.git(repo, &["rev-parse", "HEAD"])
    }

    /// `other` publishes a change of `q.md`.
    fn incoming(&self, content: &str) -> String {
        let oid = self.commit(&self.other, "q.md", content);
        self.git(&self.other, &["push", "-q", "origin", "main"]);
        oid
    }

    fn remote_main(&self) -> String {
        self.git(&self.remote, &["rev-parse", "main"])
    }

    fn head(&self) -> String {
        self.git(&self.local, &["rev-parse", "HEAD"])
    }

    fn read(&self, path: &str) -> String {
        std::fs::read_to_string(self.local.join(path)).unwrap()
    }

    fn fetch_head(&self, repo: &Path) -> PathBuf {
        repo.join(self.git(repo, &["rev-parse", "--git-path", "FETCH_HEAD"]))
    }

    /// Records in `rr-cache` a resolution of the conflict that merging
    /// `incoming` into HEAD gives, then returns to HEAD, so a user config with
    /// rerere would replay it.
    fn record_resolution(&self, incoming: &str) {
        let head = self.head();
        // Without the user config, whose merge settings would not conflict.
        let plain = self.temp.path().join("plain-gitconfig");
        std::fs::write(
            &plain,
            "[user]\n\tname = Fixture\n\temail = fixture@example.test\n[rerere]\n\tenabled = true\n",
        )
        .unwrap();
        let merge = run(&self.local, &plain, &["merge", "--no-edit", incoming]);
        assert!(!merge.status.success());
        std::fs::write(self.local.join("q.md"), "resolved\n").unwrap();
        for args in [&["add", "q.md"][..], &["commit", "-q", "--no-edit"]] {
            assert!(run(&self.local, &plain, args).status.success());
        }
        assert!(
            self.local
                .join(".git/rr-cache")
                .read_dir()
                .unwrap()
                .next()
                .is_some(),
            "a recorded resolution"
        );
        self.git(&self.local, &["reset", "-q", "--hard", &head]);
    }
}

#[tokio::test]
async fn fast_forward_is_the_same_under_every_user_config() {
    for config in USER_CONFIGS {
        let f = Fixture::new(config);
        let incoming = f.incoming("remote\n");

        let result = sync(&f.cli, &f.local).await.unwrap();
        assert!(
            matches!(result, SyncResult::Success { .. }),
            "{config:?}: {result:?}"
        );
        assert_eq!(f.head(), incoming, "{config:?}: a fast-forward");
        assert_eq!(f.read("q.md"), "remote\n", "{config:?}");
        assert_eq!(f.remote_main(), incoming, "{config:?}");
        assert!(!f.fetch_head(&f.local).exists(), "{config:?}");
    }
}

#[tokio::test]
async fn clean_merge_is_the_same_under_every_user_config() {
    for config in USER_CONFIGS {
        let f = Fixture::new(config);
        let incoming = f.incoming("remote\n");
        let local = f.commit(&f.local, "r.md", "local\n");

        let result = sync(&f.cli, &f.local).await.unwrap();
        assert!(
            matches!(result, SyncResult::Success { .. }),
            "{config:?}: {result:?}"
        );
        assert_eq!(
            f.git(&f.local, &["rev-parse", "HEAD^1", "HEAD^2"]),
            format!("{local}\n{incoming}"),
            "{config:?}: a merge commit of both sides"
        );
        assert_eq!(
            f.git(&f.local, &["log", "-1", "--format=%s"]),
            "Merge remote-tracking branch 'origin/main'",
            "{config:?}"
        );
        assert_eq!(
            (f.read("q.md"), f.read("r.md")),
            ("remote\n".into(), "local\n".into())
        );
        assert_eq!(f.remote_main(), f.head(), "{config:?}");
    }
}

#[tokio::test]
async fn conflict_is_the_same_under_every_user_config() {
    for config in USER_CONFIGS {
        let f = Fixture::new(config);
        let incoming = f.incoming("remote\n");
        let local = f.commit(&f.local, "q.md", "local\n");
        f.git(&f.local, &["fetch", "-q"]);
        f.record_resolution(&incoming);

        let result = sync(&f.cli, &f.local).await.unwrap();
        assert!(
            matches!(&result, SyncResult::Conflict { files } if files == &["q.md"]),
            "{config:?}: {result:?}"
        );
        assert_eq!(f.head(), local, "{config:?}");
        assert_eq!(
            f.git(&f.local, &["rev-parse", "MERGE_HEAD"]),
            incoming,
            "{config:?}"
        );
        assert!(
            f.read("q.md").contains("<<<<<<<"),
            "{config:?}: no recorded resolution is replayed"
        );
        assert_eq!(
            f.git(&f.local, &["ls-files", "--unmerged", "--", "q.md"])
                .lines()
                .count(),
            3,
            "{config:?}"
        );
        assert_eq!(f.git(&f.local, &["stash", "list"]), "", "{config:?}");
        assert_eq!(
            f.remote_main(),
            incoming,
            "{config:?}: nothing is published"
        );
    }
}

#[tokio::test]
async fn df190_refusal_and_matching_edit_are_the_same_under_every_user_config() {
    for config in USER_CONFIGS {
        let f = Fixture::new(config);
        let incoming = f.incoming("remote\n");
        std::fs::write(f.local.join("q.md"), "local edit\n").unwrap();
        let head = f.head();

        let result = sync(&f.cli, &f.local).await;
        assert!(
            matches!(&result, Err(GitError::PullBlocked { files, .. }) if files == &["q.md"]),
            "{config:?}: {result:?}"
        );
        assert_eq!(f.head(), head, "{config:?}");
        assert_eq!(f.read("q.md"), "local edit\n", "{config:?}");
        assert_eq!(f.git(&f.local, &["stash", "list"]), "", "{config:?}");
        assert_eq!(f.remote_main(), incoming, "{config:?}");

        // An edit equal to the incoming change does not block.
        std::fs::write(f.local.join("q.md"), "remote\n").unwrap();
        let result = sync(&f.cli, &f.local).await.unwrap();
        assert!(
            matches!(result, SyncResult::Success { .. }),
            "{config:?}: {result:?}"
        );
        assert_eq!(f.head(), incoming, "{config:?}");
        assert_eq!(
            f.git(&f.local, &["status", "--porcelain"]),
            "",
            "{config:?}"
        );
    }
}

#[tokio::test]
async fn df190_retry_merges_the_observed_revision_not_fetch_head() {
    let f = Fixture::new("");
    let incoming = f.incoming("remote\n");
    // Another process leaves FETCH_HEAD at an unrelated commit.
    let decoy = f.git(&f.local, &["commit-tree", "-m", "decoy", "HEAD^{tree}"]);
    let decoy_line = format!("{decoy}\t\tbranch 'decoy' of elsewhere\n");
    std::fs::write(f.fetch_head(&f.local), &decoy_line).unwrap();
    std::fs::write(f.local.join("q.md"), "remote\n").unwrap();

    let result = sync(&f.cli, &f.local).await.unwrap();
    assert!(matches!(result, SyncResult::Success { .. }), "{result:?}");
    assert_eq!(f.head(), incoming);
    assert_eq!(
        std::fs::read_to_string(f.fetch_head(&f.local)).unwrap(),
        decoy_line
    );
}

#[tokio::test]
async fn first_publication_fetches_the_branch_and_drops_a_stale_tracking_ref() {
    let f = Fixture::new("");
    f.git(&f.local, &["checkout", "-q", "-b", "topic"]);
    // A tracking ref of a branch the remote no longer has.
    f.git(
        &f.local,
        &["update-ref", "refs/remotes/origin/topic", "HEAD"],
    );

    let observed = fetch_counted(&f.cli, &f.local).await.unwrap().unwrap();
    assert!(!observed.upstream.configured);
    assert_eq!(observed.upstream.tracking_ref, "refs/remotes/origin/topic");
    assert_eq!(observed.revision, None);
    assert!(
        !run(
            &f.local,
            &f.global,
            &["rev-parse", "--verify", "-q", "refs/remotes/origin/topic"]
        )
        .status
        .success()
    );

    let incoming = f.incoming("remote\n");
    f.git(&f.local, &["checkout", "-q", "main"]);
    let observed = fetch_counted(&f.cli, &f.local).await.unwrap().unwrap();
    assert!(observed.upstream.configured);
    assert_eq!(observed.revision.as_deref(), Some(incoming.as_str()));
    assert_ne!(f.head(), incoming, "fetch leaves the branch alone");
}

#[tokio::test]
async fn root_fetch_leaves_submodule_space_refs_and_fetch_head_alone() {
    let f = Fixture::new("[fetch]\n\trecurseSubmodules = yes\n[submodule]\n\trecurse = true\n");
    let space_remote = f.temp.path().join("space.git");
    let space_seed = f.temp.path().join("space-seed");
    f.seed(&space_remote, &space_seed, &[("page.md", "base\n")]);
    f.git(
        &f.local,
        &[
            "submodule",
            "add",
            "-q",
            space_remote.to_str().unwrap(),
            "space",
        ],
    );
    f.git(&f.local, &["commit", "-qm", "space"]);
    f.git(&f.local, &["push", "-q", "origin", "main"]);
    // Both remotes move on.
    f.git(&f.other, &["pull", "-q", "--no-rebase", "origin", "main"]);
    let incoming = f.incoming("remote\n");
    f.commit(&space_seed, "page.md", "space remote\n");
    f.git(&space_seed, &["push", "-q", "origin", "main"]);
    let space = f.local.join("space");
    let space_refs = || f.git(&space, &["for-each-ref"]);
    let refs_before = space_refs();
    let space_fetch_head = f.fetch_head(&space);
    assert!(!space_fetch_head.exists());

    let observed = fetch_counted(&f.cli, &f.local).await.unwrap().unwrap();
    assert_eq!(observed.revision.as_deref(), Some(incoming.as_str()));
    assert_eq!(space_refs(), refs_before);
    assert!(!space_fetch_head.exists());
    assert!(!f.fetch_head(&f.local).exists());

    // Control: a plain fetch under this config does reach into the Space.
    f.git(&f.local, &["fetch", "-q"]);
    assert_ne!(space_refs(), refs_before);
}

#![cfg(unix)]
//! Operations are recognised through Git with both ref stores (invariant 12):
//! with reftable the pick and revert pseudo-refs are not files in `.git`.

use std::path::PathBuf;
use std::process::Command;

use super::GitError;
use super::branch::{GitOperation, operation_in_progress};
use super::cli::GitCli;
use super::operations::Snapshot;
use super::staging::commit_prepared;
use super::version::GitVersion;

/// `--ref-format` and the reftable backend.
const REFTABLE: GitVersion = GitVersion::new(2, 45, 0);

struct Repo {
    _temp: tempfile::TempDir,
    path: PathBuf,
    wrapper: PathBuf,
    cli: GitCli,
}

impl Repo {
    /// A repository with `note.md` on `main` and a conflicting `topic`, or
    /// `None` when this Git has no such ref store.
    async fn new(format: &str) -> Option<Self> {
        let temp = tempfile::tempdir().unwrap();
        let wrapper = temp.path().join("git-test");
        svode_testkit::write_executable(
            &wrapper,
            format!(
                "#!/bin/sh\nexport GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_CEILING_DIRECTORIES='{}' GIT_EDITOR=true GIT_AUTHOR_NAME=Fixture GIT_AUTHOR_EMAIL=fixture@example.test GIT_COMMITTER_NAME=Fixture GIT_COMMITTER_EMAIL=fixture@example.test\nexec git \"$@\"\n",
                temp.path().display()
            ),
        )
        .unwrap();
        let cli = GitCli::for_test(wrapper.clone());
        let version = cli.refresh_version().await.unwrap();
        if version < REFTABLE && format != "files" {
            eprintln!("skipped {format}: Git {version}");
            return None;
        }
        let path = temp.path().join("repo");
        std::fs::create_dir(&path).unwrap();
        let repo = Self {
            _temp: temp,
            path,
            wrapper,
            cli,
        };
        if version >= REFTABLE {
            repo.ok(&[
                "init",
                "-q",
                "-b",
                "main",
                &format!("--ref-format={format}"),
            ]);
            assert_eq!(repo.ok(&["rev-parse", "--show-ref-format"]), format);
        } else {
            repo.ok(&["init", "-q", "-b", "main"]);
        }
        repo.commit("note.md", "base\n", "base");
        repo.ok(&["checkout", "-q", "-b", "topic"]);
        repo.commit("note.md", "topic\n", "topic");
        repo.ok(&["checkout", "-q", "main"]);
        repo.commit("note.md", "main\n", "main");
        Some(repo)
    }

    fn run(&self, args: &[&str]) -> std::process::Output {
        Command::new(&self.wrapper)
            .args(args)
            .current_dir(&self.path)
            .output()
            .unwrap()
    }

    fn ok(&self, args: &[&str]) -> String {
        let out = self.run(args);
        assert!(
            out.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    }

    /// Run an operation that must stop on a conflict.
    fn stops(&self, args: &[&str]) {
        let out = self.run(args);
        assert!(!out.status.success(), "{args:?} did not stop");
    }

    fn commit(&self, path: &str, body: &str, message: &str) {
        std::fs::write(self.path.join(path), body).unwrap();
        self.ok(&["add", path]);
        self.ok(&["commit", "-q", "-m", message]);
    }

    async fn operation(&self) -> Option<GitOperation> {
        operation_in_progress(&self.cli, &self.path).await.unwrap()
    }

    /// A partial commit of an unrelated prepared path is refused while an
    /// operation holds its pseudo-ref, and leaves HEAD where it was.
    async fn partial_commit_refused(&self) {
        std::fs::write(self.path.join("other.md"), "other\n").unwrap();
        self.ok(&["add", "other.md"]);
        let head = self.ok(&["rev-parse", "HEAD"]);
        let error = commit_prepared(
            &self.cli,
            &self.path,
            &["other.md".into()],
            "partial",
            &crate::git::diagnostics::HookTrace::new(),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(
                error,
                GitError::SaveFailed {
                    ref failure,
                    reason: "command_failed",
                    ..
                } if failure.stage == crate::git::diagnostics::GitStage::Commit
            ),
            "{error:?}"
        );
        assert_eq!(self.ok(&["rev-parse", "HEAD"]), head);
    }

    fn pseudo_ref_file(&self, name: &str) -> bool {
        self.path.join(".git").join(name).exists()
    }
}

#[tokio::test]
async fn merge_rebase_pick_revert_and_sequencer_are_recognised_with_both_ref_stores() {
    for format in ["files", "reftable"] {
        let Some(repo) = Repo::new(format).await else {
            continue;
        };
        assert_eq!(repo.operation().await, None, "{format}");

        repo.stops(&["merge", "topic"]);
        assert_eq!(
            repo.operation().await,
            Some(GitOperation::Merge),
            "{format}"
        );
        repo.partial_commit_refused().await;
        repo.ok(&["merge", "--abort"]);
        repo.ok(&["reset", "-q", "--hard"]);
        assert_eq!(repo.operation().await, None, "{format}");

        repo.stops(&["cherry-pick", "topic"]);
        assert_eq!(
            repo.operation().await,
            Some(GitOperation::CherryPick),
            "{format}"
        );
        if format == "reftable" {
            // A file check misses this pick: the pseudo-ref is in the ref store.
            assert!(!repo.pseudo_ref_file("CHERRY_PICK_HEAD"));
        }
        repo.partial_commit_refused().await;
        repo.ok(&["cherry-pick", "--abort"]);
        repo.ok(&["reset", "-q", "--hard"]);

        // Revert of one commit that a later commit changed again.
        repo.commit("note.md", "after main\n", "after main");
        repo.stops(&["revert", "--no-edit", "HEAD~1"]);
        assert_eq!(
            repo.operation().await,
            Some(GitOperation::Revert),
            "{format}"
        );
        if format == "reftable" {
            assert!(!repo.pseudo_ref_file("REVERT_HEAD"));
        }
        repo.partial_commit_refused().await;
        repo.ok(&["revert", "--abort"]);
        repo.ok(&["reset", "-q", "--hard"]);

        repo.ok(&["checkout", "-q", "topic"]);
        repo.stops(&["rebase", "main"]);
        assert_eq!(
            repo.operation().await,
            Some(GitOperation::Rebase),
            "{format}"
        );
        repo.ok(&["rebase", "--abort"]);
        assert_eq!(repo.operation().await, None, "{format}");
        repo.ok(&["checkout", "-q", "main"]);

        // A multi-commit pick stopped on its first commit, which the user
        // then committed: only the sequencer state remains.
        repo.ok(&["checkout", "-q", "topic"]);
        repo.commit("extra.md", "extra\n", "extra");
        repo.ok(&["checkout", "-q", "main"]);
        repo.stops(&["cherry-pick", "topic~1", "topic"]);
        assert_eq!(
            repo.operation().await,
            Some(GitOperation::CherryPick),
            "{format}"
        );
        std::fs::write(repo.path.join("note.md"), "resolved\n").unwrap();
        repo.ok(&["add", "note.md"]);
        repo.ok(&["commit", "-q", "--no-edit"]);
        assert_eq!(
            repo.operation().await,
            Some(GitOperation::Sequencer),
            "{format}"
        );
        repo.ok(&["cherry-pick", "--quit"]);
        assert_eq!(repo.operation().await, None, "{format}");
    }
}

#[tokio::test]
async fn partial_commit_runs_without_an_operation_with_both_ref_stores() {
    for format in ["files", "reftable"] {
        let Some(repo) = Repo::new(format).await else {
            continue;
        };
        std::fs::write(repo.path.join("other.md"), "other\n").unwrap();
        repo.ok(&["add", "other.md"]);
        let out = commit_prepared(
            &repo.cli,
            &repo.path,
            &["other.md".into()],
            "partial",
            &crate::git::diagnostics::HookTrace::new(),
        )
        .await
        .unwrap();
        assert_eq!(out.exit_code, 0, "{format}: {}", out.stderr);
        assert_eq!(
            repo.ok(&["log", "-1", "--format=%s"]),
            "partial",
            "{format}"
        );
    }
}

#[tokio::test]
async fn operation_fingerprint_observes_pseudo_refs_in_the_ref_store() {
    for format in ["files", "reftable"] {
        let Some(repo) = Repo::new(format).await else {
            continue;
        };
        let original = Snapshot::read(&repo.cli, &repo.path).await.unwrap();
        for name in [
            "CHERRY_PICK_HEAD",
            "REVERT_HEAD",
            "REBASE_HEAD",
            "ORIG_HEAD",
        ] {
            repo.ok(&["update-ref", name, "topic"]);
            let changed = Snapshot::read(&repo.cli, &repo.path).await.unwrap();
            assert_ne!(changed, original, "{format}: {name}");
            repo.ok(&["update-ref", "-d", name]);
            let restored = Snapshot::read(&repo.cli, &repo.path).await.unwrap();
            assert_eq!(restored, original, "{format}: {name}");
        }
    }
}

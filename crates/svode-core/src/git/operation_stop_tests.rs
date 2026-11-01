#![cfg(unix)]
//! «Отменить <операцию>» and the stop «Идёт операция Git» (1.F) with both
//! ref stores: the abort through the operations owner returns HEAD and the
//! branch to the state before the operation, a refusal names its cause, and
//! the stop lasts only while Git reports the operation. A sequence whose
//! HEAD moved at its stop is rewound by Svode (DF-282).

use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;

use crate::git::GitError;
use crate::git::branch::{GitOperation, operation_in_progress};
use crate::git::cli::GitCli;
use crate::git::diagnostics::{GitFailureCause, GitStage};
use crate::git::flow;
use crate::git::host::GitHost;
use crate::git::operation_stop::{OperationStep, SEQUENCE_TITLES, SequenceCommits};
use crate::git::operations::SharedError;
use crate::git::staging_tests::TestHost;
use crate::git::state::GitRuntime;
use crate::git::sync::{SyncResult, preflight};
use crate::git::version::GitVersion;

/// `--ref-format` and the reftable backend.
const REFTABLE: GitVersion = GitVersion::new(2, 45, 0);

struct Repo {
    _temp: tempfile::TempDir,
    path: PathBuf,
    wrapper: PathBuf,
    cli: GitCli,
    format: &'static str,
}

impl Repo {
    /// `note.md` on `main` with a commit `kept` before any operation, and
    /// `topic` with `t1`, which conflicts with `main` in `note.md`, and `t2`,
    /// which adds `extra.md`; `None` when this Git has no such ref store.
    async fn new(format: &'static str) -> Option<Self> {
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
            format,
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
        // Svode's write lock lives in `.svode/`, kept out of Git on a device.
        std::fs::write(repo.path.join(".git/info/exclude"), ".svode/\n").unwrap();
        repo.commit("note.md", "base\n", "base");
        repo.ok(&["checkout", "-q", "-b", "topic"]);
        repo.commit("note.md", "topic\n", "t1");
        repo.commit("extra.md", "extra\n", "t2");
        repo.ok(&["checkout", "-q", "main"]);
        repo.commit("note.md", "main\n", "main");
        repo.commit("kept.md", "kept\n", "kept");
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
            "{}: {args:?}: {}",
            self.format,
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    }

    /// Run an operation that must stop on a conflict.
    fn stops(&self, args: &[&str]) {
        let out = self.run(args);
        assert!(
            !out.status.success(),
            "{}: {args:?} did not stop",
            self.format
        );
    }

    fn commit(&self, path: &str, body: &str, message: &str) {
        self.write(path, body);
        self.ok(&["add", path]);
        self.ok(&["commit", "-q", "-m", message]);
    }

    fn write(&self, path: &str, body: &str) {
        std::fs::write(self.path.join(path), body).unwrap();
    }

    fn read(&self, path: &str) -> String {
        std::fs::read_to_string(self.path.join(path)).unwrap()
    }

    /// HEAD and the branch it is on.
    fn position(&self) -> (String, String) {
        (
            self.ok(&["rev-parse", "HEAD"]),
            self.ok(&["symbolic-ref", "-q", "HEAD"]),
        )
    }

    async fn operation(&self) -> Option<GitOperation> {
        operation_in_progress(&self.cli, &self.path).await.unwrap()
    }

    async fn stop(&self) -> Option<SyncResult> {
        preflight(&self.cli, &self.path).await.unwrap()
    }

    /// Abort as the Dialog does, with the HEAD of the sequence commits its
    /// stop listed.
    async fn abort(&self, host: Arc<TestHost>) -> Result<(), SharedError> {
        let head = self.sequence().await.map(|sequence| sequence.head);
        self.abort_at(host, head).await
    }

    async fn abort_at(
        &self,
        host: Arc<TestHost>,
        expected_head: Option<String>,
    ) -> Result<(), SharedError> {
        let runtime = Arc::new(GitRuntime::with_cli(self.cli.clone()));
        let host: Arc<dyn GitHost> = host;
        let status = flow::abort_operation(&runtime, &host, &self.path, expected_head).await?;
        assert!(!status.has_conflicts, "{}", self.format);
        Ok(())
    }

    /// The commits the stop says the abort of its sequence drops.
    async fn sequence(&self) -> Option<SequenceCommits> {
        match self.stop().await {
            Some(SyncResult::OperationInProgress { sequence, .. }) => sequence,
            _ => None,
        }
    }

    /// Abort through the operations owner, which publishes the start and the
    /// end of the operation once each, and leaves no operation and no stop.
    async fn aborts(&self) {
        let host = Arc::new(TestHost::default());
        self.abort(host.clone()).await.unwrap();
        let repository = std::fs::canonicalize(&self.path).unwrap();
        assert_eq!(
            host.sync_states.lock().unwrap().clone(),
            [(repository.clone(), true), (repository, false)],
            "{}",
            self.format
        );
        assert_eq!(self.operation().await, None, "{}", self.format);
        assert!(self.stop().await.is_none(), "{}", self.format);
    }

    /// The commit made on `main` before the operation is still there.
    fn keeps_earlier_commits(&self) {
        assert_eq!(
            self.ok(&["show", "main:kept.md"]),
            "kept",
            "{}",
            self.format
        );
    }
}

fn stopped(result: Option<SyncResult>) -> (GitOperation, Option<OperationStep>, Vec<String>) {
    match result {
        Some(SyncResult::OperationInProgress {
            operation,
            step,
            files,
            kinds,
            sequence: _,
        }) => {
            assert_eq!(
                kinds
                    .iter()
                    .map(|kind| kind.path.clone())
                    .collect::<Vec<_>>(),
                files
            );
            (operation, step, files)
        }
        other => panic!("expected the operation stop, got {other:?}"),
    }
}

#[tokio::test]
async fn abort_of_a_rebase_returns_the_branch_with_both_backends_and_ref_stores() {
    for format in ["files", "reftable"] {
        for backend in ["--merge", "--apply"] {
            let Some(repo) = Repo::new(format).await else {
                continue;
            };
            repo.ok(&["checkout", "-q", "topic"]);
            let before = repo.position();
            repo.stops(&["rebase", backend, "main"]);
            assert_eq!(
                stopped(repo.stop().await),
                (
                    GitOperation::Rebase,
                    Some(OperationStep::Position {
                        current: 1,
                        total: 2
                    }),
                    vec!["note.md".to_string()],
                ),
                "{format} {backend}"
            );
            // A resolution after the stop is what the abort loses.
            repo.write("note.md", "resolved\n");
            repo.ok(&["add", "note.md"]);

            repo.aborts().await;

            assert_eq!(repo.position(), before, "{format} {backend}");
            assert_eq!(repo.read("note.md"), "topic\n", "{format} {backend}");
            assert_eq!(repo.read("extra.md"), "extra\n", "{format} {backend}");
            repo.keeps_earlier_commits();
        }
    }
}

#[tokio::test]
async fn abort_of_a_single_pick_or_revert_returns_head_with_both_ref_stores() {
    for format in ["files", "reftable"] {
        let Some(repo) = Repo::new(format).await else {
            continue;
        };
        let before = repo.position();
        repo.stops(&["cherry-pick", "topic~1"]);
        assert_eq!(
            stopped(repo.stop().await),
            (GitOperation::CherryPick, None, vec!["note.md".to_string()]),
            "{format}"
        );
        repo.aborts().await;
        assert_eq!(repo.position(), before, "{format}");
        assert_eq!(repo.read("note.md"), "main\n", "{format}");
        repo.keeps_earlier_commits();

        // A revert of `main`, which `kept` follows and `edit` changes again.
        repo.commit("note.md", "edit\n", "edit");
        let before = repo.position();
        repo.stops(&["revert", "--no-edit", "HEAD~2"]);
        assert_eq!(
            stopped(repo.stop().await),
            (GitOperation::Revert, None, vec!["note.md".to_string()]),
            "{format}"
        );
        repo.aborts().await;
        assert_eq!(repo.position(), before, "{format}");
        assert_eq!(repo.read("note.md"), "edit\n", "{format}");
        repo.keeps_earlier_commits();
    }
}

#[tokio::test]
async fn abort_of_a_sequence_returns_head_before_the_whole_sequence_with_both_ref_stores() {
    for format in ["files", "reftable"] {
        let Some(repo) = Repo::new(format).await else {
            continue;
        };
        repo.ok(&["checkout", "-q", "-b", "side", "main~2"]);
        repo.commit("side.md", "side\n", "side");
        repo.ok(&["checkout", "-q", "main"]);
        let before = repo.position();
        // `side` applies, then `t1` stops: the sequence already moved HEAD.
        repo.stops(&["cherry-pick", "side", "topic~1", "topic"]);
        assert_ne!(repo.position().0, before.0, "{format}");
        assert_eq!(
            stopped(repo.stop().await),
            (
                GitOperation::CherryPick,
                Some(OperationStep::Remaining { count: 2 }),
                vec!["note.md".to_string()],
            ),
            "{format}"
        );
        repo.aborts().await;
        assert_eq!(repo.position(), before, "{format}");
        assert!(!repo.path.join("side.md").exists(), "{format}");
        repo.keeps_earlier_commits();

        // A revert sequence; the revert pseudo-ref the person set aside
        // leaves only the sequencer, whose abort still rewinds the whole
        // sequence.
        repo.commit("note.md", "edit\n", "edit");
        let before = repo.position();
        // The revert of `kept` applies, the revert of `base` stops at the
        // later edits of `note.md`.
        repo.stops(&["revert", "--no-edit", "HEAD~1", "HEAD~3", "HEAD"]);
        assert!(!repo.path.join("kept.md").exists(), "{format}");
        let (operation, step, files) = stopped(repo.stop().await);
        assert_eq!(operation, GitOperation::Revert, "{format}");
        assert_eq!(
            step,
            Some(OperationStep::Remaining { count: 2 }),
            "{format}"
        );
        assert_eq!(files, ["note.md"], "{format}");
        repo.ok(&["reset", "-q", "--merge"]);
        assert_eq!(repo.operation().await, Some(GitOperation::Sequencer));
        repo.aborts().await;
        assert_eq!(repo.position(), before, "{format}");
        assert_eq!(repo.read("note.md"), "edit\n", "{format}");
        assert_eq!(repo.read("kept.md"), "kept\n", "{format}");
        repo.keeps_earlier_commits();
    }
}

#[tokio::test]
async fn refused_abort_names_its_cause_and_keeps_the_operation_for_a_retry() {
    for format in ["files", "reftable"] {
        let Some(repo) = Repo::new(format).await else {
            continue;
        };
        // `two` changes `note.md`, which conflicts, and `shared.md` cleanly.
        repo.commit("shared.md", "shared\n", "shared");
        repo.ok(&["checkout", "-q", "-b", "two"]);
        repo.write("shared.md", "two\n");
        repo.ok(&["add", "shared.md"]);
        repo.commit("note.md", "two\n", "two");
        repo.ok(&["checkout", "-q", "main"]);
        repo.commit("note.md", "main again\n", "main again");
        let before = repo.position();
        repo.stops(&["cherry-pick", "two"]);
        assert_eq!(repo.operation().await, Some(GitOperation::CherryPick));
        // The staged clean side is edited after the stop.
        repo.write("shared.md", "edited after the stop\n");

        let error = repo.abort(Arc::new(TestHost::default())).await.unwrap_err();
        assert!(
            matches!(
                &*error,
                GitError::SyncFailed(failure)
                    if failure.stage == GitStage::Abort
                        && failure.cause == Some(GitFailureCause::LocalChanges)
                        && failure.repository == "repo"
            ),
            "{format}: {error:?}"
        );
        assert_eq!(repo.operation().await, Some(GitOperation::CherryPick));
        assert_eq!(repo.position(), before, "{format}");
        assert_eq!(repo.read("shared.md"), "edited after the stop\n");

        // Another Git process holds the index.
        std::fs::write(repo.path.join(".git/index.lock"), "").unwrap();
        let error = repo.abort(Arc::new(TestHost::default())).await.unwrap_err();
        assert!(
            matches!(
                &*error,
                GitError::SyncFailed(failure)
                    if failure.cause == Some(GitFailureCause::IndexLocked)
            ),
            "{format}: {error:?}"
        );
        std::fs::remove_file(repo.path.join(".git/index.lock")).unwrap();

        // Access refused by the host: Git does not run.
        let denied = Arc::new(TestHost::denied(GitError::RepositoryAccessDenied {
            repository_id: "fixture".into(),
            status: "read_only".into(),
            reason: "permission_denied".into(),
        }));
        let error = repo.abort(denied).await.unwrap_err();
        assert!(
            matches!(&*error, GitError::RepositoryAccessDenied { .. }),
            "{format}: {error:?}"
        );
        assert_eq!(repo.operation().await, Some(GitOperation::CherryPick));

        // The retry succeeds once the edit is set aside.
        repo.ok(&["checkout", "--", "shared.md"]);
        repo.aborts().await;
        assert_eq!(repo.position(), before, "{format}");
        repo.keeps_earlier_commits();

        // Nothing left to abort.
        let error = repo.abort(Arc::new(TestHost::default())).await.unwrap_err();
        assert!(
            error
                .to_string()
                .contains("no rebase, cherry-pick or revert"),
            "{format}: {error}"
        );
    }
}

impl Repo {
    /// `side` from `base` adds `side.md` cleanly, then the sequence picks
    /// `side`, stops at `t1` in `note.md` and leaves `t2`.
    fn stops_in_a_pick_sequence(&self) {
        self.ok(&["checkout", "-q", "-b", "side", "main~2"]);
        self.commit("side.md", "side\n", "side");
        self.ok(&["checkout", "-q", "main"]);
        self.stops(&["cherry-pick", "side", "topic~1", "topic"]);
    }

    /// Commit the resolution of the stopped step by hand, as an agent does
    /// with `git commit` instead of `--continue`: HEAD moves past the stop.
    fn commits_the_stop_by_hand(&self) {
        self.write("note.md", "resolved\n");
        self.ok(&["add", "note.md"]);
        self.ok(&["commit", "-q", "--no-edit"]);
    }

    fn has_pseudo_refs(&self) -> bool {
        ["CHERRY_PICK_HEAD", "REVERT_HEAD"].iter().any(|name| {
            self.run(&["rev-parse", "-q", "--verify", name])
                .status
                .success()
        })
    }

    /// Nothing of the sequence is left, and the index matches HEAD.
    fn no_sequence_left(&self) {
        assert!(
            !self.path.join(".git/sequencer").exists(),
            "{}",
            self.format
        );
        assert!(!self.has_pseudo_refs(), "{}", self.format);
        assert_eq!(
            self.ok(&["diff", "--cached", "--name-only"]),
            "",
            "{}",
            self.format
        );
    }

    fn head(&self) -> String {
        self.ok(&["rev-parse", "HEAD"])
    }
}

fn refused_with(error: &SharedError, cause: GitFailureCause, format: &str) {
    assert!(
        matches!(
            &**error,
            GitError::SyncFailed(failure)
                if failure.stage == GitStage::Abort
                    && failure.cause == Some(cause)
                    && failure.repository == "repo"
        ),
        "{format}: expected {cause:?}, got {error:?}"
    );
}

#[tokio::test]
async fn sequence_stop_lists_the_commits_its_abort_drops_newest_first() {
    for format in ["files", "reftable"] {
        let Some(repo) = Repo::new(format).await else {
            continue;
        };
        let start = repo.head();
        repo.stops_in_a_pick_sequence();
        assert_eq!(
            repo.sequence().await,
            Some(SequenceCommits {
                head: repo.head(),
                count: 1,
                titles: vec!["side".into()],
            }),
            "{format}"
        );
        repo.commits_the_stop_by_hand();
        for index in 1..=6 {
            repo.commit(
                "manual.md",
                &format!("{index}\n"),
                &format!("manual {index}"),
            );
        }
        let sequence = repo.sequence().await.unwrap();
        assert_eq!(sequence.head, repo.head(), "{format}");
        assert_eq!(sequence.count, 8, "{format}");
        assert_eq!(sequence.titles.len(), SEQUENCE_TITLES, "{format}");
        assert_eq!(
            sequence.titles,
            ["manual 6", "manual 5", "manual 4", "manual 3", "manual 2"],
            "{format}"
        );

        // A rebase and a single cherry-pick list nothing.
        repo.ok(&["cherry-pick", "--quit"]);
        repo.ok(&["reset", "-q", "--hard", &start]);
        repo.stops(&["cherry-pick", "topic~1"]);
        assert_eq!(repo.operation().await, Some(GitOperation::CherryPick));
        assert_eq!(repo.sequence().await, None, "{format}");
        repo.ok(&["cherry-pick", "--abort"]);
        repo.ok(&["checkout", "-q", "topic"]);
        repo.stops(&["rebase", "main"]);
        assert_eq!(repo.sequence().await, None, "{format}");
    }
}

#[tokio::test]
async fn abort_of_a_sequence_committed_by_hand_at_the_stop_rewinds_to_its_start() {
    for format in ["files", "reftable"] {
        let Some(repo) = Repo::new(format).await else {
            continue;
        };
        // A pick sequence: `side` applied, `t1` committed by hand, then one
        // more commit by hand.
        let before = repo.position();
        repo.stops_in_a_pick_sequence();
        repo.commits_the_stop_by_hand();
        repo.commit("manual.md", "manual\n", "manual");
        assert_eq!(repo.operation().await, Some(GitOperation::Sequencer));
        assert_ne!(
            repo.read(".git/sequencer/abort-safety").trim(),
            repo.head(),
            "{format}"
        );
        assert_eq!(repo.sequence().await.unwrap().count, 3, "{format}");
        // Edits without a commit the rewind does not touch are kept.
        repo.write("kept.md", "kept edited\n");
        repo.write("scratch.md", "scratch\n");

        repo.aborts().await;

        assert_eq!(repo.position(), before, "{format}");
        assert_eq!(repo.read("note.md"), "main\n", "{format}");
        assert!(!repo.path.join("side.md").exists(), "{format}");
        assert!(!repo.path.join("manual.md").exists(), "{format}");
        assert_eq!(repo.read("kept.md"), "kept edited\n", "{format}");
        assert_eq!(repo.read("scratch.md"), "scratch\n", "{format}");
        repo.no_sequence_left();
        repo.keeps_earlier_commits();
        repo.ok(&["checkout", "--", "kept.md"]);
        std::fs::remove_file(repo.path.join("scratch.md")).unwrap();

        // A revert sequence: the revert of `kept` applies, the revert of
        // `base` stops and is committed by hand.
        repo.commit("note.md", "edit\n", "edit");
        let before = repo.position();
        repo.stops(&["revert", "--no-edit", "HEAD~1", "HEAD~3", "HEAD"]);
        repo.commits_the_stop_by_hand();
        assert_eq!(repo.operation().await, Some(GitOperation::Sequencer));
        assert_eq!(
            repo.sequence().await.unwrap().titles,
            ["Revert \"base\"", "Revert \"kept\""],
            "{format}"
        );
        repo.aborts().await;
        assert_eq!(repo.position(), before, "{format}");
        assert_eq!(repo.read("note.md"), "edit\n", "{format}");
        assert_eq!(repo.read("kept.md"), "kept\n", "{format}");
        repo.no_sequence_left();
        repo.keeps_earlier_commits();

        // A sequencer without its pseudo-ref: the person set the stopped
        // revert aside, then committed something else by hand.
        let before = repo.position();
        repo.stops(&["revert", "--no-edit", "HEAD~1", "HEAD~3", "HEAD"]);
        repo.ok(&["reset", "-q", "--merge"]);
        assert_eq!(repo.operation().await, Some(GitOperation::Sequencer));
        repo.commit("manual.md", "manual\n", "manual");
        repo.aborts().await;
        assert_eq!(repo.position(), before, "{format}");
        assert_eq!(repo.read("kept.md"), "kept\n", "{format}");
        assert!(!repo.path.join("manual.md").exists(), "{format}");
        repo.no_sequence_left();
        repo.keeps_earlier_commits();
    }
}

#[tokio::test]
async fn abort_of_a_new_stop_after_a_step_committed_by_hand_is_git_s_own() {
    for format in ["files", "reftable"] {
        let Some(repo) = Repo::new(format).await else {
            continue;
        };
        // `third` from `base` changes `note.md` again.
        repo.ok(&["checkout", "-q", "-b", "third", "main~2"]);
        repo.commit("note.md", "third\n", "third");
        repo.ok(&["checkout", "-q", "main"]);
        let before = repo.position();
        repo.stops(&["cherry-pick", "topic~1", "third"]);
        repo.commits_the_stop_by_hand();
        // Git moves past the step committed by hand and stops at `third`,
        // where HEAD is again where the sequence stopped.
        repo.stops(&["cherry-pick", "--continue"]);
        assert_eq!(repo.operation().await, Some(GitOperation::CherryPick));
        assert_eq!(
            repo.read(".git/sequencer/abort-safety").trim(),
            repo.head(),
            "{format}"
        );
        assert_eq!(repo.sequence().await.unwrap().titles, ["t1"], "{format}");

        repo.aborts().await;

        assert_eq!(repo.position(), before, "{format}");
        assert_eq!(repo.read("note.md"), "main\n", "{format}");
        repo.no_sequence_left();
        repo.keeps_earlier_commits();
    }
}

#[tokio::test]
async fn refused_rewind_of_a_sequence_names_its_cause_and_changes_nothing() {
    for format in ["files", "reftable"] {
        let Some(repo) = Repo::new(format).await else {
            continue;
        };
        let before = repo.position();
        let start = before.0.clone();
        repo.stops_in_a_pick_sequence();
        repo.commits_the_stop_by_hand();
        let moved = repo.position();
        let listed = repo.sequence().await.unwrap().head;
        let unchanged = |repo: &Repo, position: &(String, String)| {
            assert_eq!(&repo.position(), position, "{}", repo.format);
            assert!(repo.path.join(".git/sequencer").is_dir(), "{}", repo.format);
        };

        // (a) The branch was switched: it no longer continues the start.
        repo.ok(&["checkout", "-q", "topic"]);
        assert_eq!(repo.sequence().await, None, "{format}");
        let switched = repo.position();
        let error = repo
            .abort_at(Arc::new(TestHost::default()), Some(listed.clone()))
            .await
            .unwrap_err();
        refused_with(&error, GitFailureCause::BranchLeftSequence, format);
        unchanged(&repo, &switched);
        assert_eq!(repo.operation().await, Some(GitOperation::Sequencer));
        repo.ok(&["checkout", "-q", "main"]);

        // (b) The applied step is reachable from a remote-tracking ref.
        repo.ok(&["update-ref", "refs/remotes/origin/main", "HEAD~1"]);
        let error = repo
            .abort_at(Arc::new(TestHost::default()), Some(listed.clone()))
            .await
            .unwrap_err();
        refused_with(&error, GitFailureCause::CommitsPublished, format);
        unchanged(&repo, &moved);
        // Commits before the sequence may be published.
        repo.ok(&["update-ref", "refs/remotes/origin/main", &start]);

        // (c) HEAD is not the one the confirmation listed, or none was named.
        for expected in [Some(start.clone()), None] {
            let error = repo
                .abort_at(Arc::new(TestHost::default()), expected)
                .await
                .unwrap_err();
            refused_with(&error, GitFailureCause::StateChanged, format);
            unchanged(&repo, &moved);
        }

        // (d) An edit without a commit of a file the rewind changes.
        repo.write("note.md", "edited after the commit\n");
        let error = repo
            .abort_at(Arc::new(TestHost::default()), Some(listed.clone()))
            .await
            .unwrap_err();
        refused_with(&error, GitFailureCause::LocalChanges, format);
        unchanged(&repo, &moved);
        assert_eq!(repo.read("note.md"), "edited after the commit\n");
        assert!(repo.path.join("side.md").exists(), "{format}");

        // The retry rewinds once the edit is set aside.
        repo.ok(&["checkout", "--", "note.md"]);
        repo.aborts().await;
        assert_eq!(repo.position(), before, "{format}");
        repo.no_sequence_left();
        repo.keeps_earlier_commits();
    }
}

#[tokio::test]
async fn abort_of_a_sequence_without_a_moved_head_checks_publication_and_state() {
    for format in ["files", "reftable"] {
        let Some(repo) = Repo::new(format).await else {
            continue;
        };
        repo.stops_in_a_pick_sequence();
        let stopped_at = repo.position();
        let listed = repo.sequence().await.unwrap().head;

        repo.ok(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
        let error = repo
            .abort_at(Arc::new(TestHost::default()), Some(listed.clone()))
            .await
            .unwrap_err();
        refused_with(&error, GitFailureCause::CommitsPublished, format);
        assert_eq!(repo.position(), stopped_at, "{format}");
        assert_eq!(repo.operation().await, Some(GitOperation::CherryPick));
        repo.ok(&["update-ref", "-d", "refs/remotes/origin/main"]);

        let error = repo
            .abort_at(Arc::new(TestHost::default()), None)
            .await
            .unwrap_err();
        refused_with(&error, GitFailureCause::StateChanged, format);
        assert_eq!(repo.operation().await, Some(GitOperation::CherryPick));
    }
}

#[tokio::test]
async fn stop_clears_when_git_no_longer_reports_the_operation_finished_from_a_terminal() {
    for format in ["files", "reftable"] {
        let Some(repo) = Repo::new(format).await else {
            continue;
        };
        let t1 = repo.ok(&["rev-parse", "topic~1"]);
        repo.ok(&["checkout", "-q", "topic"]);
        repo.stops(&["rebase", "main"]);
        assert_eq!(stopped(repo.stop().await).0, GitOperation::Rebase);
        repo.write("note.md", "resolved\n");
        repo.ok(&["add", "note.md"]);
        repo.ok(&["rebase", "--continue"]);
        assert!(repo.stop().await.is_none(), "{format}");

        repo.ok(&["checkout", "-q", "main"]);
        repo.stops(&["cherry-pick", &t1]);
        assert_eq!(stopped(repo.stop().await).0, GitOperation::CherryPick);
        repo.write("note.md", "resolved\n");
        repo.ok(&["add", "note.md"]);
        repo.ok(&["cherry-pick", "--continue"]);
        assert!(repo.stop().await.is_none(), "{format}");
    }
}

#[test]
fn step_serializes_by_its_kind() {
    assert_eq!(
        serde_json::to_value(OperationStep::Remaining { count: 3 }).unwrap(),
        serde_json::json!({ "kind": "remaining", "count": 3 })
    );
}

#[test]
fn sequence_commits_serialize_with_their_head() {
    assert_eq!(
        serde_json::to_value(SequenceCommits {
            head: "abc".into(),
            count: 7,
            titles: vec!["Fix typo".into()],
        })
        .unwrap(),
        serde_json::json!({ "head": "abc", "count": 7, "titles": ["Fix typo"] })
    );
}

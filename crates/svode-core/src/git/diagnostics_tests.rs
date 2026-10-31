use super::*;
use crate::git::GitError;

#[test]
fn causes_are_recognized_from_git_output() {
    let cases = [
        (
            "fatal: Unable to create '/home/user/notes/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository",
            Some(GitFailureCause::IndexLocked),
        ),
        (
            "fatal: Unable to create '/home/user/notes/.git/index.lock': Permission denied",
            Some(GitFailureCause::FileSystemDenied),
        ),
        (
            "error: insufficient permission for adding an object to repository database .git/objects",
            Some(GitFailureCause::FileSystemDenied),
        ),
        (
            "Author identity unknown\n\n*** Please tell me who you are.\n\nfatal: empty ident name (for <>) not allowed",
            Some(GitFailureCause::Identity),
        ),
        (
            "fatal: no email was given and auto-detection is disabled",
            Some(GitFailureCause::Identity),
        ),
        (
            "error: gpg failed to sign the data:\n(no gpg output)\nfatal: failed to write commit object",
            Some(GitFailureCause::Signing),
        ),
        (
            "error: Couldn't load public key /home/user/.ssh/id: No such file or directory?\n\nfatal: failed to write commit object",
            Some(GitFailureCause::Signing),
        ),
        (
            "fatal: unable to access 'https://example.test/r.git/': Could not resolve host: example.test",
            Some(GitFailureCause::Network),
        ),
        ("fatal: refusing to merge unrelated histories", None),
        ("", None),
    ];
    for (stderr, expected) in cases {
        assert_eq!(cause(stderr, false), expected, "{stderr}");
    }
    // A failed hook is decisive whatever it printed, but an unreachable
    // remote of the git-lfs pre-push hook stays a network failure.
    assert_eq!(
        cause("lint: /home/user/notes/a.md: Permission denied", true),
        Some(GitFailureCause::Hook)
    );
    assert_eq!(
        cause(
            "batch request: dial tcp: lookup lfs.example.test: connection refused",
            true
        ),
        Some(GitFailureCause::Network)
    );
}

#[test]
fn only_local_causes_keep_repository_access() {
    for cause in [
        GitFailureCause::Hook,
        GitFailureCause::Signing,
        GitFailureCause::Identity,
        GitFailureCause::IndexLocked,
        GitFailureCause::FileSystemDenied,
    ] {
        assert!(cause.is_local(), "{cause:?}");
    }
    assert!(!GitFailureCause::Network.is_local());
    let failure = |cause| {
        GitError::SyncFailed(GitFailure {
            repository: "Research".into(),
            stage: GitStage::Fetch,
            cause,
        })
    };
    assert!(failure(Some(GitFailureCause::FileSystemDenied)).is_local_failure());
    assert!(!failure(Some(GitFailureCause::Network)).is_local_failure());
    assert!(!failure(None).is_local_failure());
    assert!(!GitError::AuthRequired("Permission denied (publickey).".into()).is_local_failure());
}

#[test]
fn hook_trace_counts_only_hooks_of_its_own_command() {
    let trace = HookTrace::new();
    let path = trace.path.as_ref().unwrap();
    let events = |lines: &[&str]| std::fs::write(path, lines.join("\n")).unwrap();
    events(&[
        r#"{"event":"version","sid":"S"}"#,
        r#"{"event":"child_start","sid":"S","child_id":0,"child_class":"hook","hook_name":"pre-commit"}"#,
        // A Git command the hook ran declined its own hook.
        r#"{"event":"version","sid":"S/N"}"#,
        r#"{"event":"child_start","sid":"S/N","child_id":0,"child_class":"hook"}"#,
        r#"{"event":"child_exit","sid":"S/N","child_id":0,"code":1}"#,
        r#"{"event":"child_exit","sid":"S","child_id":0,"code":0}"#,
        r#"{"event":"child_start","sid":"S","child_id":1,"child_class":"?"}"#,
        r#"{"event":"child_exit","sid":"S","child_id":1,"code":1}"#,
    ]);
    assert!(!trace.hook_failed());
    events(&[
        r#"{"event":"version","sid":"S"}"#,
        r#"{"event":"child_start","sid":"S","child_id":2,"child_class":"hook","hook_name":"commit-msg"}"#,
        r#"{"event":"child_exit","sid":"S","child_id":2,"code":1}"#,
    ]);
    assert!(trace.hook_failed());
    assert_eq!(trace.env(&[("A", "1")])[0], ("A", "1"));
    assert_eq!(trace.env(&[])[0].0, "GIT_TRACE2_EVENT");
}

#[cfg(unix)]
mod git {
    use std::path::{Path, PathBuf};
    use std::process::Command;

    use super::super::{GitFailure, GitFailureCause, GitStage};
    use crate::git::GitError;
    use crate::git::cli::GitCli;
    use crate::git::ops;

    fn git(repo: &Path, args: &[&str]) {
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
    }

    /// The repository of a Space named "Research" whose `note.md` is edited.
    struct Repo {
        _temp: tempfile::TempDir,
        temp: PathBuf,
        root: PathBuf,
        cli: GitCli,
    }

    impl Repo {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let base = temp.path().canonicalize().unwrap();
            let root = base.join("Research");
            std::fs::create_dir(&root).unwrap();
            git(&root, &["init", "-q", "-b", "main"]);
            git(&root, &["config", "user.name", "Fixture"]);
            git(&root, &["config", "user.email", "fixture@example.test"]);
            std::fs::write(root.join("note.md"), "initial\n").unwrap();
            git(&root, &["add", "."]);
            git(&root, &["commit", "-q", "-m", "initial"]);
            std::fs::write(root.join("note.md"), "changed\n").unwrap();
            let wrapper = base.join("git-test");
            svode_testkit::write_executable(
                &wrapper,
                "#!/bin/sh\nexport GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1\nexec git -c protocol.file.allow=always \"$@\"\n",
            )
            .unwrap();
            Self {
                _temp: temp,
                temp: base,
                root,
                cli: GitCli::for_test(wrapper),
            }
        }

        fn hook(&self, name: &str, script: &str) {
            svode_testkit::write_executable(self.root.join(".git/hooks").join(name), script)
                .unwrap();
        }

        async fn save(&self) -> GitError {
            ops::commit_paths(&self.cli, &self.root, &["note.md".to_string()])
                .await
                .unwrap_err()
        }

        /// The failure of a save, checked to carry no path or output of Git.
        fn failure<'a>(&self, error: &'a GitError) -> &'a GitFailure {
            let text = format!("{error} {}", serde_json::to_string(error).unwrap());
            assert!(!text.contains(self.temp.to_str().unwrap()), "{text}");
            assert!(!text.contains("lint"), "{text}");
            assert!(matches!(error, GitError::SaveFailed { .. }), "{error:?}");
            error.failure().unwrap()
        }
    }

    #[tokio::test]
    async fn save_names_a_declining_pre_commit_hook() {
        let repo = Repo::new();
        repo.hook(
            "pre-commit",
            "#!/bin/sh\necho 'lint: note.md: Permission denied' >&2\nexit 1\n",
        );
        let error = repo.save().await;
        assert_eq!(
            repo.failure(&error),
            &GitFailure {
                repository: "Research".into(),
                stage: GitStage::Commit,
                cause: Some(GitFailureCause::Hook),
            }
        );
        assert!(matches!(
            error,
            GitError::SaveFailed {
                reason: "command_failed",
                ..
            }
        ));
    }

    #[tokio::test]
    async fn save_of_one_path_names_a_declining_commit_msg_hook() {
        let repo = Repo::new();
        repo.hook(
            "commit-msg",
            "#!/bin/sh\necho 'lint: message' >&2\nexit 1\n",
        );
        let error = ops::commit_exact_path_receipt(&repo.cli, &repo.root, "note.md", "Update")
            .await
            .err()
            .unwrap();
        assert_eq!(repo.failure(&error).cause, Some(GitFailureCause::Hook));
        assert_eq!(repo.failure(&error).stage, GitStage::Commit);
    }

    #[tokio::test]
    async fn a_hook_that_passes_is_not_the_cause() {
        let repo = Repo::new();
        // The hook runs Git itself and passes; the commit then fails to sign.
        repo.hook("pre-commit", "#!/bin/sh\ngit status >/dev/null\nexit 0\n");
        git(&repo.root, &["config", "commit.gpgSign", "true"]);
        git(&repo.root, &["config", "gpg.program", "false"]);
        let error = repo.save().await;
        assert_eq!(repo.failure(&error).cause, Some(GitFailureCause::Signing));
    }

    #[tokio::test]
    async fn save_names_a_signing_failure() {
        let repo = Repo::new();
        git(&repo.root, &["config", "commit.gpgSign", "true"]);
        git(&repo.root, &["config", "gpg.program", "false"]);
        let error = repo.save().await;
        assert_eq!(
            repo.failure(&error),
            &GitFailure {
                repository: "Research".into(),
                stage: GitStage::Commit,
                cause: Some(GitFailureCause::Signing),
            }
        );
    }

    #[tokio::test]
    async fn save_names_a_missing_identity() {
        let repo = Repo::new();
        git(&repo.root, &["config", "--unset", "user.name"]);
        git(&repo.root, &["config", "--unset", "user.email"]);
        git(&repo.root, &["config", "user.useConfigOnly", "true"]);
        let error = repo.save().await;
        assert_eq!(repo.failure(&error).cause, Some(GitFailureCause::Identity));
        assert_eq!(repo.failure(&error).stage, GitStage::Commit);
    }

    #[tokio::test]
    async fn save_names_a_busy_index_lock() {
        let repo = Repo::new();
        std::fs::write(repo.root.join(".git/index.lock"), "").unwrap();
        let error = repo.save().await;
        assert_eq!(
            repo.failure(&error),
            &GitFailure {
                repository: "Research".into(),
                stage: GitStage::Prepare,
                cause: Some(GitFailureCause::IndexLocked),
            }
        );
    }

    #[tokio::test]
    async fn publishing_names_a_declining_pre_push_hook() {
        let repo = Repo::new();
        let remote = repo.temp.join("remote.git");
        git(
            &repo.temp,
            &[
                "init",
                "-q",
                "--bare",
                "-b",
                "main",
                remote.to_str().unwrap(),
            ],
        );
        git(
            &repo.root,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git(&repo.root, &["push", "-q", "-u", "origin", "main"]);
        git(&repo.root, &["commit", "-q", "-am", "local"]);
        repo.hook("pre-push", "#!/bin/sh\necho 'lint: refused' >&2\nexit 1\n");
        let error = ops::push(&repo.cli, &repo.root).await.unwrap_err();
        assert!(matches!(&error, GitError::SyncFailed(_)), "{error:?}");
        assert_eq!(
            error.failure(),
            Some(&GitFailure {
                repository: "Research".into(),
                stage: GitStage::Push,
                cause: Some(GitFailureCause::Hook),
            })
        );
        assert!(error.is_local_failure());
    }
}

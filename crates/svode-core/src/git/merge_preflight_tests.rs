//! Integration without getting stuck (module 01, 1.B) over real
//! repositories: a project published to a bare remote and cloned twice.

#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::*;
use crate::git::conflict_kind::ConflictKind;
use crate::git::host::GitHost;
use crate::git::policy::{GitUserPolicy, write_user_policy};
use crate::git::service_merge::ServiceFileState;
use crate::git::state::GitRuntime;
use crate::git::sync::{self, SyncMode, SyncResult};
use crate::git::{flow, merge_preflight, upstream, write_guard};

const ORDER: &str = ".svode/order.json";
/// The file of the rule `service_merge` adds to the set in tests only.
const PROBE: &str = "probe.svode-merge-test";

struct Fixture {
    temp: tempfile::TempDir,
    global: PathBuf,
    local: PathBuf,
    other: PathBuf,
    cli: GitCli,
}

impl Fixture {
    /// Git with merges in memory, as from 2.38.
    async fn new() -> Self {
        let f = Self::unchecked();
        assert!(f.cli.refresh_version().await.is_some());
        assert!(f.cli.background_merge(), "the tests need Git 2.38 or newer");
        f
    }

    /// A Git whose release is unknown: background sync only fast-forwards,
    /// as on Git 2.31–2.37.
    fn unchecked() -> Self {
        Self::with_wrapper("")
    }

    /// A Git that reports `release` to any version read, whatever arguments
    /// come first, and logs every other call for [`Self::take_wrapper_log`].
    fn reporting(release: &str) -> Self {
        Self::with_wrapper(&format!(
            "for arg in \"$@\"; do if [ \"$arg\" = --version ]; then echo 'git version {release}'; exit 0; fi; done\n\
             echo \"$*\" >> \"$(dirname \"$0\")/git.log\"\n"
        ))
    }

    fn with_wrapper(prelude: &str) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let global = temp.path().join("gitconfig");
        std::fs::write(
            &global,
            "[user]\n\tname = Fixture\n\temail = fixture@example.test\n\
             [init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n",
        )
        .unwrap();
        let wrapper = temp.path().join("git-test");
        svode_testkit::write_executable(
            &wrapper,
            &format!(
                "#!/bin/sh\nexport GIT_CONFIG_GLOBAL='{}' GIT_CONFIG_NOSYSTEM=1\n{prelude}exec git \"$@\"\n",
                global.display()
            ),
        )
        .unwrap();
        let f = Self {
            local: temp.path().join("local"),
            other: temp.path().join("other"),
            cli: GitCli::for_test(wrapper),
            global,
            temp,
        };
        let remote = f.temp.path().join("remote.git");
        let seed = f.temp.path().join("seed");
        f.git(
            f.temp.path(),
            &["init", "-q", "--bare", remote.to_str().unwrap()],
        );
        f.git(
            f.temp.path(),
            &[
                "clone",
                "-q",
                remote.to_str().unwrap(),
                seed.to_str().unwrap(),
            ],
        );
        f.commit(
            &seed,
            &[
                (".gitignore", ".svode/local.json\n.svode/write.lock\n"),
                (ORDER, r#"{".": ["a.md", "b.md"]}"#),
                ("page.md", "---\ntitle: Page\n---\nbase\n"),
                ("notes.txt", "base\n"),
                ("other.md", "---\ntitle: Other\n---\nother\n"),
                (PROBE, "base\n"),
            ],
        );
        f.git(&seed, &["push", "-q", "-u", "origin", "main"]);
        for clone in [&f.local, &f.other] {
            f.git(
                f.temp.path(),
                &[
                    "clone",
                    "-q",
                    remote.to_str().unwrap(),
                    clone.to_str().unwrap(),
                ],
            );
        }
        f
    }

    fn run(&self, repo: &Path, args: &[&str]) -> std::process::Output {
        Command::new("git")
            .args(args)
            .current_dir(repo)
            .env("GIT_CONFIG_GLOBAL", &self.global)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap()
    }

    fn git(&self, repo: &Path, args: &[&str]) -> String {
        let out = self.run(repo, args);
        assert!(
            out.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap().trim_end().into()
    }

    fn write(&self, repo: &Path, path: &str, content: &[u8]) {
        let target = repo.join(path);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(target, content).unwrap();
    }

    fn read(&self, repo: &Path, path: &str) -> String {
        std::fs::read_to_string(repo.join(path)).unwrap()
    }

    fn commit(&self, repo: &Path, files: &[(&str, &str)]) -> String {
        for (path, content) in files {
            self.write(repo, path, content.as_bytes());
        }
        self.git(repo, &["add", "-A"]);
        self.git(repo, &["commit", "-qm", "change"]);
        self.head(repo)
    }

    /// `other` publishes `files`.
    fn incoming(&self, files: &[(&str, &str)]) -> String {
        let oid = self.commit(&self.other, files);
        self.git(&self.other, &["push", "-q", "origin", "main"]);
        oid
    }

    fn head(&self, repo: &Path) -> String {
        self.git(repo, &["rev-parse", "HEAD"])
    }

    fn remote_head(&self) -> String {
        self.git(&self.other, &["ls-remote", "origin", "refs/heads/main"])
            .split('\t')
            .next()
            .unwrap()
            .to_owned()
    }

    fn merging(&self, repo: &Path) -> bool {
        self.run(repo, &["rev-parse", "-q", "--verify", "MERGE_HEAD"])
            .status
            .success()
    }

    /// HEAD, the index, the status and the files of the working copy.
    fn state(&self, repo: &Path) -> (String, String, String, Vec<(String, Vec<u8>)>) {
        let mut files = Vec::new();
        for path in ["page.md", "notes.txt", "other.md", ORDER, "local.txt"] {
            if let Ok(bytes) = std::fs::read(repo.join(path)) {
                files.push((path.to_owned(), bytes));
            }
        }
        (
            self.head(repo),
            self.git(repo, &["ls-files", "--stage"]),
            self.git(repo, &["status", "--porcelain=v2", "--untracked-files=all"]),
            files,
        )
    }

    /// Calls of a [`Self::reporting`] Git since the last read, one per line.
    fn take_wrapper_log(&self) -> String {
        let log = self.temp.path().join("git.log");
        let calls = std::fs::read_to_string(&log).unwrap_or_default();
        std::fs::write(&log, "").unwrap();
        calls
    }

    async fn background(&self) -> SyncResult {
        sync::sync_with(&self.cli, &self.local, SyncMode::Background)
            .await
            .unwrap()
    }

    /// The upstream of the local clone and the revision a fetch observed.
    async fn observe(&self) -> (upstream::Upstream, String) {
        let target = upstream::of_current_branch(&self.cli, &self.local)
            .await
            .unwrap()
            .unwrap();
        let observed = upstream::fetch(&self.cli, &self.local, target)
            .await
            .unwrap();
        (observed.upstream, observed.revision.unwrap())
    }

    fn hooks(&self, name: &str, script: &str) {
        let hooks = self.temp.path().join("hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        svode_testkit::write_executable(&hooks.join(name), script).unwrap();
        self.git(
            &self.local,
            &["config", "core.hooksPath", hooks.to_str().unwrap()],
        );
    }
}

fn kinds(files: &[PathConflict]) -> Vec<(&str, ConflictKind)> {
    let mut kinds: Vec<_> = files
        .iter()
        .map(|file| (file.path.as_str(), file.kind))
        .collect();
    kinds.sort_by_key(|(path, _)| *path);
    kinds
}

// ---- Preflight outcomes ----

#[tokio::test]
async fn the_preflight_tells_fast_forward_clean_service_only_and_conflicts_apart() {
    let f = Fixture::new().await;
    let (_, revision) = f.observe().await;
    let check = |revision: String| {
        let f = &f;
        async move {
            merge_preflight::check(&f.cli, &f.local, &revision)
                .await
                .unwrap()
                .outcome
        }
    };
    assert_eq!(check(revision).await, Preflight::UpToDate);

    f.incoming(&[("notes.txt", "theirs\n")]);
    let (_, revision) = f.observe().await;
    assert_eq!(check(revision).await, Preflight::FastForward);

    f.commit(&f.local, &[("other.md", "mine\n")]);
    let (_, revision) = f.observe().await;
    assert_eq!(check(revision).await, Preflight::Clean);

    f.incoming(&[(ORDER, r#"{".": ["t.md"]}"#)]);
    f.commit(&f.local, &[(ORDER, r#"{".": ["m.md"]}"#)]);
    let (_, revision) = f.observe().await;
    assert_eq!(check(revision).await, Preflight::ServiceOnly);

    f.incoming(&[("page.md", "---\ntitle: Page\n---\ntheirs\n")]);
    f.commit(&f.local, &[("page.md", "---\ntitle: Page\n---\nmine\n")]);
    let (_, revision) = f.observe().await;
    let before = f.state(&f.local);
    match check(revision).await {
        Preflight::Conflicts { files, service } => {
            assert_eq!(kinds(&files), [("page.md", ConflictKind::PageText)]);
            assert!(service.is_empty());
        }
        other => panic!("{other:?}"),
    }
    // Merging in memory changed nothing of the repository.
    assert_eq!(f.state(&f.local), before);
    assert!(!f.merging(&f.local));
}

#[tokio::test]
async fn the_stop_names_every_conflicted_path_with_its_kind() {
    let f = Fixture::new().await;
    f.commit(
        &f.other,
        &[
            ("gone.txt", "base\n"),
            ("renamed.txt", "rename me\nline 2\nline 3\n"),
            ("rename-gone.txt", "rename or delete\nline 2\nline 3\n"),
        ],
    );
    f.git(&f.other, &["push", "-q", "origin", "main"]);
    f.git(&f.local, &["pull", "-q", "--no-rebase", "origin", "main"]);

    f.write(&f.other, "image.bin", b"\x00\x01theirs");
    f.git(&f.other, &["rm", "-q", "gone.txt", "rename-gone.txt"]);
    f.git(&f.other, &["mv", "renamed.txt", "renamed-theirs.txt"]);
    f.incoming(&[
        ("page.md", "---\ntitle: Page\n---\ntheirs\n"),
        ("other.md", "---\ntitle: Theirs\n---\nother\n"),
        ("notes.txt", "theirs\n"),
        ("added.txt", "theirs\n"),
    ]);
    f.write(&f.local, "image.bin", b"\x00\x01mine");
    f.git(&f.local, &["mv", "renamed.txt", "renamed-mine.txt"]);
    f.git(&f.local, &["mv", "rename-gone.txt", "rename-kept.txt"]);
    f.commit(
        &f.local,
        &[
            ("page.md", "---\ntitle: Page\n---\nmine\n"),
            ("other.md", "---\ntitle: Mine\n---\nother\n"),
            ("notes.txt", "mine\n"),
            ("added.txt", "mine\n"),
            ("gone.txt", "changed\n"),
        ],
    );

    let SyncResult::IncomingConflict { files, service } = f.background().await else {
        panic!("a background conflict stops sync");
    };
    assert!(service.is_empty());
    assert_eq!(
        kinds(&files),
        [
            ("added.txt", ConflictKind::AddAdd),
            ("gone.txt", ConflictKind::ModifyDelete),
            // New on both sides: added, whatever its content.
            ("image.bin", ConflictKind::AddAdd),
            ("notes.txt", ConflictKind::Text),
            ("other.md", ConflictKind::PageProperties),
            ("page.md", ConflictKind::PageText),
            ("rename-kept.txt", ConflictKind::RenameDelete),
            ("renamed-mine.txt", ConflictKind::RenameRename),
            ("renamed-theirs.txt", ConflictKind::RenameRename),
            ("renamed.txt", ConflictKind::RenameRename),
        ]
    );
}

#[tokio::test]
async fn a_binary_file_changed_on_both_sides_is_binary() {
    let f = Fixture::new().await;
    f.write(&f.other, "image.bin", b"\x00\x01base");
    f.git(&f.other, &["add", "image.bin"]);
    f.git(&f.other, &["commit", "-qm", "image"]);
    f.git(&f.other, &["push", "-q", "origin", "main"]);
    f.git(&f.local, &["pull", "-q", "--no-rebase", "origin", "main"]);
    f.write(&f.other, "image.bin", b"\x00\x01theirs");
    f.incoming(&[]);
    f.write(&f.local, "image.bin", b"\x00\x01mine");
    f.commit(&f.local, &[]);

    let SyncResult::IncomingConflict { files, .. } = f.background().await else {
        panic!("a background conflict stops sync");
    };
    assert_eq!(kinds(&files), [("image.bin", ConflictKind::Binary)]);
}

// ---- Background and explicit sync ----

#[tokio::test]
async fn a_background_conflict_changes_nothing_and_publishes_nothing() {
    let f = Fixture::new().await;
    let incoming = f.incoming(&[("page.md", "---\ntitle: Page\n---\ntheirs\n")]);
    let local = f.commit(&f.local, &[("page.md", "---\ntitle: Page\n---\nmine\n")]);
    // Local work in progress: a staged and an unstaged edit and a new file.
    f.write(&f.local, "notes.txt", b"staged\n");
    f.git(&f.local, &["add", "notes.txt"]);
    f.write(&f.local, "other.md", b"unstaged\n");
    f.write(&f.local, "local.txt", b"untracked\n");
    let before = f.state(&f.local);

    let SyncResult::IncomingConflict { files, .. } = f.background().await else {
        panic!("a background conflict stops sync");
    };

    assert_eq!(kinds(&files), [("page.md", ConflictKind::PageText)]);
    assert!(!f.merging(&f.local), "no merge state");
    assert_eq!(f.state(&f.local), before, "HEAD, index and files unchanged");
    assert_eq!(f.remote_head(), incoming, "nothing published");
    assert_eq!(f.head(&f.local), local);
}

#[tokio::test]
async fn an_explicit_conflict_enters_the_merge_state_as_before() {
    let f = Fixture::new().await;
    f.incoming(&[("page.md", "---\ntitle: Page\n---\ntheirs\n")]);
    f.commit(&f.local, &[("page.md", "---\ntitle: Page\n---\nmine\n")]);

    let result = sync::sync(&f.cli, &f.local).await.unwrap();

    match result {
        SyncResult::Conflict { files, .. } => assert_eq!(files, ["page.md"]),
        other => panic!("{other:?}"),
    }
    assert!(f.merging(&f.local));
}

#[tokio::test]
async fn background_sync_integrates_a_fast_forward_and_a_clean_merge() {
    let f = Fixture::new().await;
    let incoming = f.incoming(&[("notes.txt", "theirs\n")]);
    assert!(matches!(f.background().await, SyncResult::Success { .. }));
    assert_eq!(f.head(&f.local), incoming);

    f.incoming(&[("notes.txt", "theirs again\n")]);
    f.commit(&f.local, &[("other.md", "mine\n")]);
    assert!(matches!(f.background().await, SyncResult::Success { .. }));
    assert_eq!(f.read(&f.local, "notes.txt"), "theirs again\n");
    assert_eq!(f.remote_head(), f.head(&f.local), "the merge is published");
}

#[tokio::test]
async fn a_conflict_only_in_order_json_integrates_in_the_background() {
    let f = Fixture::new().await;
    f.incoming(&[(ORDER, r#"{".": ["a.md", "b.md", "t.md"]}"#)]);
    f.commit(&f.local, &[(ORDER, r#"{".": ["a.md", "b.md", "m.md"]}"#)]);

    match f.background().await {
        SyncResult::Success { merged, .. } => assert_eq!(merged, [ORDER]),
        other => panic!("{other:?}"),
    }
    assert!(!f.merging(&f.local));
    let order: serde_json::Value = serde_json::from_str(&f.read(&f.local, ORDER)).unwrap();
    assert_eq!(
        order["."],
        serde_json::json!(["a.md", "b.md", "m.md", "t.md"])
    );
    assert_eq!(f.remote_head(), f.head(&f.local));
}

#[tokio::test]
async fn background_and_explicit_sync_count_conflicts_as_service_by_one_rule_set() {
    // The probe rule exists only in the set of service rules.
    let f = Fixture::new().await;
    f.incoming(&[(PROBE, "base\ntheirs\n")]);
    f.commit(&f.local, &[(PROBE, "base\nmine\n")]);

    match f.background().await {
        SyncResult::Success { merged, .. } => assert_eq!(merged, [PROBE]),
        other => panic!("{other:?}"),
    }
    assert_eq!(f.read(&f.local, PROBE), "base\nmine\ntheirs\n");

    // The explicit sync merges the same file by the same rule.
    f.git(&f.other, &["pull", "-q", "--no-rebase", "origin", "main"]);
    f.incoming(&[(PROBE, "base\nmine\ntheirs\nmore\n")]);
    f.commit(&f.local, &[(PROBE, "base\nmine\ntheirs\nlocal\n")]);
    match sync::sync(&f.cli, &f.local).await.unwrap() {
        SyncResult::Success { merged, .. } => assert_eq!(merged, [PROBE]),
        other => panic!("{other:?}"),
    }
    assert_eq!(f.read(&f.local, PROBE), "base\nlocal\nmine\nmore\ntheirs\n");
}

#[tokio::test]
async fn the_next_preflight_without_a_conflict_ends_the_stop() {
    let f = Fixture::new().await;
    f.incoming(&[("page.md", "---\ntitle: Page\n---\ntheirs\n")]);
    f.commit(&f.local, &[("page.md", "---\ntitle: Page\n---\nmine\n")]);
    assert!(matches!(
        f.background().await,
        SyncResult::IncomingConflict { .. }
    ));

    // The colleague takes the same text; the merge is clean now.
    f.incoming(&[("page.md", "---\ntitle: Page\n---\nmine\n")]);

    assert!(matches!(f.background().await, SyncResult::Success { .. }));
    assert_eq!(f.remote_head(), f.head(&f.local));
}

#[tokio::test]
async fn without_merges_in_memory_background_sync_only_fast_forwards() {
    let f = Fixture::unchecked();
    assert!(!f.cli.background_merge());
    let incoming = f.incoming(&[("notes.txt", "theirs\n")]);
    assert!(matches!(f.background().await, SyncResult::Success { .. }));
    assert_eq!(f.head(&f.local), incoming);

    // Diverged: even a clean merge waits for an explicit sync.
    let remote = f.incoming(&[("notes.txt", "theirs again\n")]);
    let local = f.commit(&f.local, &[("other.md", "mine\n")]);
    let before = f.state(&f.local);
    assert!(matches!(
        f.background().await,
        SyncResult::ExplicitSyncRequired
    ));
    assert_eq!(f.state(&f.local), before);
    assert_eq!(f.remote_head(), remote);

    assert!(matches!(
        sync::sync(&f.cli, &f.local).await.unwrap(),
        SyncResult::Success { .. }
    ));
    assert_ne!(f.head(&f.local), local);
    assert_eq!(f.remote_head(), f.head(&f.local));
}

#[tokio::test]
async fn on_a_recognised_git_without_merges_in_memory_background_sync_only_fast_forwards() {
    let f = Fixture::reporting("2.37.0");
    let availability = f.cli.check_availability().await;
    assert_eq!(availability.git_version.as_deref(), Some("2.37.0"));
    assert_eq!(
        f.cli.version(),
        Some(crate::git::version::GitVersion::new(2, 37, 0))
    );
    assert!(!f.cli.background_merge());

    let incoming = f.incoming(&[("notes.txt", "theirs\n")]);
    assert!(matches!(f.background().await, SyncResult::Success { .. }));
    assert_eq!(f.head(&f.local), incoming);
    assert!(!f.take_wrapper_log().is_empty());

    // Diverged: even a clean merge waits for an explicit sync.
    let remote = f.incoming(&[("notes.txt", "theirs again\n")]);
    f.commit(&f.local, &[("other.md", "mine\n")]);
    let before = f.state(&f.local);
    assert!(matches!(
        f.background().await,
        SyncResult::ExplicitSyncRequired
    ));
    let calls = f.take_wrapper_log();
    assert!(!calls.is_empty());
    for call in calls.lines() {
        assert!(
            !call
                .split_whitespace()
                .any(|arg| matches!(arg, "merge-tree" | "merge")),
            "{call}"
        );
    }
    assert_eq!(f.state(&f.local), before);
    assert_eq!(f.remote_head(), remote);
    assert!(!f.merging(&f.local));
}

// ---- Races ----

#[tokio::test]
async fn a_working_copy_change_after_the_preflight_is_the_df190_refusal() {
    let f = Fixture::new().await;
    f.incoming(&[("notes.txt", "theirs\n")]);
    f.commit(&f.local, &[("other.md", "mine\n")]);
    let (upstream, revision) = f.observe().await;
    let checked = merge_preflight::check(&f.cli, &f.local, &revision)
        .await
        .unwrap();
    assert_eq!(checked.outcome, Preflight::Clean);

    // An agent edits the file the incoming change touches.
    f.write(&f.local, "notes.txt", b"agent edit\n");
    let head = f.head(&f.local);

    let error = sync::integrate_checked(&f.cli, &f.local, &upstream, &revision, &checked)
        .await
        .unwrap_err();

    match error {
        GitError::PullBlocked { files, .. } => assert_eq!(files, ["notes.txt"]),
        other => panic!("{other:?}"),
    }
    assert!(!f.merging(&f.local));
    assert_eq!(f.head(&f.local), head);
    assert_eq!(f.read(&f.local, "notes.txt"), "agent edit\n");
}

#[tokio::test]
async fn a_head_moved_after_the_preflight_is_checked_again() {
    let f = Fixture::new().await;
    f.incoming(&[("page.md", "---\ntitle: Page\n---\ntheirs\n")]);
    let (upstream, revision) = f.observe().await;
    let checked = merge_preflight::check(&f.cli, &f.local, &revision)
        .await
        .unwrap();
    assert_eq!(checked.outcome, Preflight::FastForward);
    // A terminal commit that conflicts lands before the merge.
    let head = f.commit(&f.local, &[("page.md", "---\ntitle: Page\n---\nmine\n")]);

    let again = sync::integrate_checked(&f.cli, &f.local, &upstream, &revision, &checked)
        .await
        .unwrap();

    assert!(again.is_none());
    assert!(!f.merging(&f.local));
    assert_eq!(f.head(&f.local), head);
}

#[tokio::test]
async fn a_conflict_the_preflight_did_not_see_leaves_no_merge_state() {
    let f = Fixture::new().await;
    f.incoming(&[("page.md", "---\ntitle: Page\n---\ntheirs\n")]);
    let head = f.commit(&f.local, &[("page.md", "---\ntitle: Page\n---\nmine\n")]);
    let (upstream, revision) = f.observe().await;
    let before = f.state(&f.local);
    // A preflight of this HEAD that saw no conflict, as a race could leave it.
    let checked = Checked {
        head: Some(head),
        outcome: Preflight::Clean,
    };

    let again = sync::integrate_checked(&f.cli, &f.local, &upstream, &revision, &checked)
        .await
        .unwrap();

    assert!(again.is_none());
    assert!(!f.merging(&f.local));
    assert_eq!(f.state(&f.local), before);
}

#[tokio::test]
async fn a_source_write_during_the_integration_step_waits_or_finds_the_source_busy() {
    for (sleep, busy) in [("3", true), ("0.5", false)] {
        let f = Fixture::new().await;
        let started = f.temp.path().join("started");
        f.hooks(
            "pre-merge-commit",
            &format!("#!/bin/sh\ntouch '{}'\nsleep {sleep}\n", started.display()),
        );
        f.incoming(&[("notes.txt", "theirs\n")]);
        f.commit(&f.local, &[("other.md", "mine\n")]);
        let before = f.head(&f.local);

        let sync = tokio::spawn({
            let cli = f.cli.clone();
            let local = f.local.clone();
            async move { sync::sync_with(&cli, &local, SyncMode::Background).await }
        });
        let deadline = Instant::now() + Duration::from_secs(20);
        while !started.exists() {
            assert!(Instant::now() < deadline, "the merge did not start");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let repository = std::fs::canonicalize(&f.local).unwrap();
        let page = repository.join("other.md");
        let write = write_guard::acquire(
            &std::collections::BTreeSet::from([repository]),
            std::slice::from_ref(&page),
        )
        .await;

        if busy {
            match write {
                Err(GitError::SourceBusy { path }) => {
                    assert_eq!(path, page.display().to_string())
                }
                other => panic!("{:?}", other.map(|_| ())),
            }
        } else {
            // The writer waited until the step left the merged files.
            assert!(write.is_ok());
            assert_ne!(f.head(&f.local), before);
            assert!(!f.merging(&f.local));
            drop(write);
        }
        assert!(matches!(
            sync.await.unwrap().unwrap(),
            SyncResult::Success { .. }
        ));
    }
}

// ---- Automatic versions during the stop (1.E, n. 2) ----

#[tokio::test]
async fn versions_are_created_and_not_published_during_the_stop() {
    use crate::git::staging_tests::TestHost;
    use crate::git::versions::MessageLanguage;
    use crate::git::versions::auto::{AutoVersions, Closing, close};

    let f = Fixture::new().await;
    write_user_policy(
        &f.local,
        &GitUserPolicy {
            auto_sync: true,
            auto_commit_content: true,
            ..GitUserPolicy::default()
        },
    )
    .unwrap();
    let runtime = Arc::new(GitRuntime::with_cli(f.cli.clone()));
    let test_host = Arc::new(TestHost::default());
    let host: Arc<dyn GitHost> = test_host.clone();
    let incoming = f.incoming(&[("page.md", "---\ntitle: Page\n---\ntheirs\n")]);
    f.commit(&f.local, &[("page.md", "---\ntitle: Page\n---\nmine\n")]);

    let report = flow::sync(&runtime, &host, &f.local, true).await.unwrap();
    assert!(matches!(report.child, SyncResult::IncomingConflict { .. }));

    // An edit becomes a version while the stop lasts.
    f.write(&f.local, "other.md", b"edited during the stop\n");
    let versions = close(
        &runtime,
        &*host,
        &f.local,
        &Closing::all(Duration::from_secs(60)),
        MessageLanguage::En,
    )
    .await
    .unwrap();
    assert!(matches!(versions, AutoVersions::Done { commits: 1, .. }));
    let version = f.head(&f.local);
    assert_eq!(
        f.git(&f.local, &["show", "--name-only", "--format=", "HEAD"]),
        "other.md"
    );
    // The version asks for the background sync after it, which stops again.
    assert!(!test_host.auto_syncs.lock().unwrap().is_empty());
    let report = flow::sync(&runtime, &host, &f.local, true).await.unwrap();
    assert!(matches!(report.child, SyncResult::IncomingConflict { .. }));

    assert_eq!(f.remote_head(), incoming, "the version is not published");
    assert_eq!(f.head(&f.local), version);
    assert!(!f.merging(&f.local));
}

#[test]
fn the_stop_keeps_its_transport_shape() {
    let stop = SyncResult::IncomingConflict {
        files: vec![PathConflict {
            path: "page.md".into(),
            kind: ConflictKind::PageProperties,
            also: Vec::new(),
        }],
        service: vec![ServiceFile {
            path: "space".into(),
            state: ServiceFileState::SpaceDiverged,
        }],
    };
    assert_eq!(
        serde_json::to_value(stop).unwrap(),
        serde_json::json!({
            "type": "incomingConflict",
            "files": [{ "path": "page.md", "kind": "page_properties" }],
            "service": [{ "path": "space", "state": "space_diverged" }],
        })
    );
    assert_eq!(
        serde_json::to_value(SyncResult::ExplicitSyncRequired).unwrap(),
        serde_json::json!({ "type": "explicitSyncRequired" })
    );
}

#![cfg(unix)]
//! The light check of background sync (Stage 11 1.E): every network
//! conversation goes through a fake `ssh` that logs it, so a test counts the
//! calls a sync makes.

use super::*;
use crate::git::upstream::fetch_counted;
use std::path::PathBuf;
use std::process::Command;

struct Fixture {
    temp: tempfile::TempDir,
    global: PathBuf,
    log: PathBuf,
    remote: PathBuf,
    other: PathBuf,
    local: PathBuf,
    cli: GitCli,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let log = temp.path().join("network.log");
        let ssh = temp.path().join("fake-ssh");
        // The last argument is the command the remote side would run.
        svode_testkit::write_executable(
            &ssh,
            format!(
                "#!/bin/sh\nfor last; do :; done\n\
                 printf '%s %s\\n' \"${{GIT_TERMINAL_PROMPT-unset}}\" \"${{last%% *}}\" >> '{}'\n\
                 exec sh -c \"$last\"\n",
                log.display()
            ),
        )
        .unwrap();
        let global = temp.path().join("gitconfig");
        std::fs::write(
            &global,
            format!(
                "[user]\n\tname = Fixture\n\temail = fixture@example.test\n\
                 [protocol \"file\"]\n\tallow = always\n\
                 [core]\n\tsshCommand = {}\n[ssh]\n\tvariant = simple\n",
                ssh.display()
            ),
        )
        .unwrap();
        let wrapper = temp.path().join("git-test");
        svode_testkit::write_executable(
            &wrapper,
            format!(
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
            log,
            global,
            temp,
        };
        let root = f.temp.path();
        f.git(
            root,
            &[
                "init",
                "-q",
                "--bare",
                "-b",
                "main",
                f.remote.to_str().unwrap(),
            ],
        );
        for clone in [&f.local, &f.other] {
            f.git(
                root,
                &[
                    "clone",
                    "-q",
                    f.remote.to_str().unwrap(),
                    clone.to_str().unwrap(),
                ],
            );
            crate::git::policy::exclude_device_local(clone);
        }
        f.git(&f.other, &["checkout", "-q", "-B", "main"]);
        f.commit(&f.other, "q.md", "base\n");
        f.git(&f.other, &["push", "-q", "-u", "origin", "main"]);
        f.git(&f.local, &["pull", "-q", "origin", "main"]);
        f.git(&f.local, &["branch", "-q", "-u", "origin/main"]);
        // From here on the local clone reaches its remote over the fake ssh.
        let url = format!("ssh://fixture.invalid{}", f.remote.display());
        f.git(&f.local, &["remote", "set-url", "origin", &url]);
        f
    }

    fn git(&self, repo: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(args)
            .current_dir(repo)
            .env("GIT_CONFIG_GLOBAL", &self.global)
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

    fn commit(&self, repo: &Path, path: &str, content: &str) -> String {
        std::fs::write(repo.join(path), content).unwrap();
        self.git(repo, &["add", path]);
        self.git(repo, &["commit", "-qm", path]);
        self.git(repo, &["rev-parse", "HEAD"])
    }

    /// `other` publishes a change.
    fn incoming(&self, content: &str) -> String {
        let oid = self.commit(&self.other, "q.md", content);
        self.git(&self.other, &["push", "-q", "origin", "main"]);
        oid
    }

    fn head(&self) -> String {
        self.git(&self.local, &["rev-parse", "HEAD"])
    }

    fn remote_main(&self) -> String {
        self.git(&self.remote, &["rev-parse", "main"])
    }

    /// The network calls since the last read: `<GIT_TERMINAL_PROMPT> <service>`.
    fn calls(&self) -> Vec<String> {
        let calls = std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect();
        let _ = std::fs::remove_file(&self.log);
        calls
    }
}

#[tokio::test]
async fn background_sync_without_incoming_or_outgoing_is_one_network_call() {
    let f = Fixture::new();
    let head = f.head();

    let result = sync_with(&f.cli, &f.local, SyncMode::Background)
        .await
        .unwrap();

    assert!(
        matches!(&result, SyncResult::Success { published_head, .. } if *published_head == head),
        "{result:?}"
    );
    // One read of the upstream revision, without a terminal prompt.
    assert_eq!(f.calls(), ["0 git-upload-pack"]);
    assert_eq!(f.head(), head);
}

#[tokio::test]
async fn background_sync_publishes_only_with_outgoing_commits() {
    let f = Fixture::new();
    let local = f.commit(&f.local, "r.md", "local\n");

    let result = sync_with(&f.cli, &f.local, SyncMode::Background)
        .await
        .unwrap();

    assert!(matches!(result, SyncResult::Success { .. }), "{result:?}");
    assert_eq!(f.remote_main(), local, "the outgoing commit is published");
    let calls = f.calls();
    assert_eq!(calls.first().map(String::as_str), Some("0 git-upload-pack"));
    assert!(
        calls.iter().any(|call| call == "0 git-receive-pack"),
        "{calls:?}"
    );
    assert!(calls.iter().all(|call| call.starts_with("0 ")), "{calls:?}");

    // The next background sync has nothing to publish.
    sync_with(&f.cli, &f.local, SyncMode::Background)
        .await
        .unwrap();
    assert_eq!(f.calls(), ["0 git-upload-pack"]);
}

#[tokio::test]
async fn background_sync_fetches_and_integrates_exactly_the_new_revision() {
    let f = Fixture::new();
    let incoming = f.incoming("remote\n");

    let result = sync_with(&f.cli, &f.local, SyncMode::Background)
        .await
        .unwrap();

    assert!(
        matches!(&result, SyncResult::Success { published_head, .. } if *published_head == incoming),
        "{result:?}"
    );
    assert_eq!(f.head(), incoming);
    assert_eq!(
        f.git(&f.local, &["rev-parse", "refs/remotes/origin/main"]),
        incoming
    );
    // The light check and the fetch; a fast-forward has nothing to publish.
    assert_eq!(f.calls(), ["0 git-upload-pack", "0 git-upload-pack"]);
}

#[tokio::test]
async fn background_sync_integrates_a_revision_fetched_before_without_fetching_again() {
    let f = Fixture::new();
    let incoming = f.incoming("remote\n");
    fetch_counted(&f.cli, &f.local).await.unwrap().unwrap();
    assert_ne!(f.head(), incoming, "the counters fetch leaves the branch");
    f.calls();

    let result = sync_with(&f.cli, &f.local, SyncMode::Background)
        .await
        .unwrap();

    assert!(matches!(result, SyncResult::Success { .. }), "{result:?}");
    assert_eq!(f.head(), incoming);
    assert_eq!(f.calls(), ["0 git-upload-pack"]);
}

#[tokio::test]
async fn counters_fetch_starts_with_the_light_check() {
    let f = Fixture::new();

    let probed = fetch_counted(&f.cli, &f.local).await.unwrap().unwrap();
    assert!(!probed.fetched, "the revision was fetched already");
    assert_eq!(probed.observed.revision.as_deref(), Some(f.head().as_str()));
    assert_eq!(f.calls(), ["0 git-upload-pack"]);

    let incoming = f.incoming("remote\n");
    let probed = fetch_counted(&f.cli, &f.local).await.unwrap().unwrap();
    assert!(probed.fetched);
    assert_eq!(probed.observed.revision.as_deref(), Some(incoming.as_str()));
    assert_eq!(f.calls(), ["0 git-upload-pack", "0 git-upload-pack"]);
    assert_ne!(f.head(), incoming, "the counters fetch leaves the branch");
}

#[tokio::test]
async fn explicit_sync_keeps_its_full_fetch_and_publication_check() {
    let f = Fixture::new();

    let result = sync_with(&f.cli, &f.local, SyncMode::Explicit)
        .await
        .unwrap();

    assert!(matches!(result, SyncResult::Success { .. }), "{result:?}");
    let calls = f.calls();
    assert!(
        calls.iter().any(|call| call == "0 git-receive-pack"),
        "an explicit sync still proves its publication: {calls:?}"
    );
}

#[tokio::test]
async fn background_sync_after_an_agent_turn_integrates_the_revision_its_own_fetch_left_behind() {
    // A sync during a turn fetched and stopped before integration (1.9):
    // the tracking ref is ahead of HEAD and the remote has nothing newer.
    let f = Fixture::new();
    let incoming = f.incoming("remote\n");
    let upstream = crate::git::upstream::of_current_branch(&f.cli, &f.local)
        .await
        .unwrap()
        .unwrap();
    crate::git::upstream::fetch(&f.cli, &f.local, upstream)
        .await
        .unwrap();
    assert_ne!(f.head(), incoming);
    f.calls();

    let result = sync_with(&f.cli, &f.local, SyncMode::Background)
        .await
        .unwrap();

    assert!(matches!(result, SyncResult::Success { .. }), "{result:?}");
    assert_eq!(f.head(), incoming, "behind > 0 integrates without a fetch");
    assert_eq!(f.calls(), ["0 git-upload-pack"]);
}

#[tokio::test]
async fn observed_sync_integrates_the_revision_the_counters_fetched_without_network() {
    let f = Fixture::new();
    let incoming = f.incoming("remote\n");
    fetch_counted(&f.cli, &f.local).await.unwrap().unwrap();
    f.calls();

    let result = sync_with(&f.cli, &f.local, SyncMode::Observed)
        .await
        .unwrap();

    assert!(
        matches!(&result, SyncResult::Success { published_head, .. } if *published_head == incoming),
        "{result:?}"
    );
    assert_eq!(f.head(), incoming);
    assert_eq!(f.calls(), Vec::<String>::new());
}

#[tokio::test]
async fn observed_sync_publishes_outgoing_commits_without_checking_the_remote() {
    // The calls of a background sync that publishes: the light check, then
    // the publication.
    let background = Fixture::new();
    background.commit(&background.local, "r.md", "local\n");
    sync_with(&background.cli, &background.local, SyncMode::Background)
        .await
        .unwrap();
    let background = background.calls();
    assert_eq!(
        background.first().map(String::as_str),
        Some("0 git-upload-pack")
    );

    let f = Fixture::new();
    fetch_counted(&f.cli, &f.local).await.unwrap().unwrap();
    let local = f.commit(&f.local, "r.md", "local\n");
    f.calls();

    let result = sync_with(&f.cli, &f.local, SyncMode::Observed)
        .await
        .unwrap();

    assert!(matches!(result, SyncResult::Success { .. }), "{result:?}");
    assert_eq!(f.remote_main(), local, "the outgoing commit is published");
    let calls = f.calls();
    assert!(
        calls.iter().any(|call| call == "0 git-receive-pack"),
        "{calls:?}"
    );
    // The same publication, without the light check.
    assert_eq!(calls, background[1..]);
}

/// DF-285 acceptance 1: the counters and the background sync of one
/// repository, planned by the rhythm the way Desktop runs them, reach the
/// remote once per gap in either order; the explicit sync is not held.
#[tokio::test]
async fn the_counters_and_a_background_sync_reach_the_remote_once_per_gap() {
    use crate::git::rhythm::{MIN_GAP, Rhythm, Step, Trigger, Work};
    use std::time::{Duration, Instant};

    async fn counters(f: &Fixture, rhythm: &mut Rhythm, now: Instant) {
        if rhythm.counters(&f.local, now) {
            fetch_counted(&f.cli, &f.local).await.unwrap();
        }
    }
    async fn opened(f: &Fixture, rhythm: &mut Rhythm, now: Instant) {
        let mode = match rhythm.trigger(&f.local, Trigger::Opened, true, now) {
            Step::Run(Work::Sync) => SyncMode::Background,
            Step::Run(Work::Integrate) => SyncMode::Observed,
            _ => return,
        };
        let result = sync_with(&f.cli, &f.local, mode).await.unwrap();
        assert!(matches!(result, SyncResult::Success { .. }), "{result:?}");
        rhythm.finished(
            &f.local,
            crate::git::rhythm::Outcome::Checked { incoming: false },
            now,
        );
    }
    let second = Duration::from_secs(1);
    let f = Fixture::new();
    let start = Instant::now();

    // The counters first, with an incoming change: one call and its fetch,
    // and the sync integrates that revision.
    let mut rhythm = Rhythm::default();
    let incoming = f.incoming("remote\n");
    counters(&f, &mut rhythm, start).await;
    opened(&f, &mut rhythm, start + second).await;
    assert_eq!(f.calls(), ["0 git-upload-pack", "0 git-upload-pack"]);
    assert_eq!(f.head(), incoming);

    // The sync first: one call, and the counters read the last observation.
    let mut rhythm = Rhythm::default();
    opened(&f, &mut rhythm, start).await;
    counters(&f, &mut rhythm, start + second).await;
    assert_eq!(f.calls(), ["0 git-upload-pack"]);

    // The explicit sync inside the gap reaches the remote.
    sync_with(&f.cli, &f.local, SyncMode::Explicit)
        .await
        .unwrap();
    rhythm.explicit(&f.local, true, start + second * 2);
    assert!(!f.calls().is_empty());

    // After the gap the counters check again, once.
    counters(&f, &mut rhythm, start + second * 2 + MIN_GAP).await;
    opened(&f, &mut rhythm, start + second * 3 + MIN_GAP).await;
    assert_eq!(f.calls(), ["0 git-upload-pack"]);
}

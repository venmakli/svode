//! Versions of agent turns and Routine runs over real repositories (Stage
//! 11 1.E «Ходы агентов», «Рутины»): closing before a turn, the hold while
//! turns run, one version after the last turn, editor paths in their own
//! groups, the turn that leaves commits to the agent, and the integration
//! step that waits for the end of the turn.

use std::path::Path;
use std::time::Duration;

use super::MessageLanguage;
use super::auto::{AutoVersions, Closing, Held, close};
use super::turns::{self, TurnBegin, TurnEnd, TurnWrap};
use crate::git::autocommit::{AutocommitService, SystemCommitKind};
use crate::git::policy::{GitUserPolicy, write_user_policy};
use crate::git::staging_tests::{TestHost, cli, git, repo, write};
use crate::git::state::GitRuntime;
use crate::git::sync::{SyncMode, SyncResult, sync_with};

const PAUSE: Duration = Duration::from_secs(60);

fn policy(repo: &Path, content: bool) {
    write_user_policy(
        repo,
        &GitUserPolicy {
            auto_commit_content: content,
            auto_commit_system: true,
            ..GitUserPolicy::default()
        },
    )
    .expect("write policy");
}

async fn commit_all(root: &Path) {
    let cli = cli();
    git(&cli, root, &["add", "--all"]).await;
    git(&cli, root, &["commit", "-q", "-m", "Base"]).await;
}

async fn log(root: &Path) -> Vec<String> {
    git(&cli(), root, &["log", "--format=%s"])
        .await
        .lines()
        .map(str::to_string)
        .collect()
}

async fn dirty(root: &Path) -> Vec<String> {
    let mut paths = git(&cli(), root, &["status", "--porcelain", "-uall"])
        .await
        .lines()
        .map(|line| line[3..].to_string())
        .filter(|path| !crate::git::policy::contains(path))
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

async fn last_commit(root: &Path) -> Vec<String> {
    let mut paths = git(
        &cli(),
        root,
        &["show", "--name-only", "--no-renames", "--format=", "HEAD"],
    )
    .await
    .lines()
    .map(str::to_string)
    .collect::<Vec<_>>();
    paths.sort();
    paths
}

/// A born repository with two committed Pages and content commits on.
async fn pages() -> tempfile::TempDir {
    let tmp = repo(&cli(), true).await;
    let root = tmp.path();
    write(root, "a.md", "---\ntitle: A\n---\nA\n");
    write(root, "b.md", "---\ntitle: B\n---\nB\n");
    write(root, "c.md", "---\ntitle: C\n---\nC\n");
    write(root, ".gitignore", ".svode/local.json\n");
    commit_all(root).await;
    policy(root, true);
    tmp
}

struct Fixture {
    runtime: GitRuntime,
    host: TestHost,
}

impl Fixture {
    fn new() -> Self {
        Self {
            runtime: GitRuntime::with_cli(cli()),
            host: TestHost::default(),
        }
    }

    async fn begin(&self, repo: &Path, key: &str, wrap: TurnWrap) -> TurnBegin {
        turns::begin(
            &self.runtime,
            &self.host,
            repo,
            key,
            wrap,
            MessageLanguage::En,
        )
        .await
    }

    async fn end(&self, key: &str) -> TurnEnd {
        turns::end(&self.runtime, &self.host, key, MessageLanguage::En).await
    }

    async fn close_all(&self, repo: &Path) -> AutoVersions {
        close(
            &self.runtime,
            &self.host,
            repo,
            &Closing::all(PAUSE),
            MessageLanguage::En,
        )
        .await
        .expect("close")
    }
}

fn ended(end: TurnEnd) -> (usize, bool) {
    match end {
        TurnEnd::Ended {
            version, deferred, ..
        } => (version.expect("version of the turn"), deferred),
        other => panic!("the last turn ends: {other:?}"),
    }
}

#[tokio::test]
async fn a_turn_closes_the_groups_before_it_and_lands_as_one_version_without_the_agent() {
    let tmp = pages().await;
    let root = tmp.path();
    let fixture = Fixture::new();
    // Edits accumulated before the turn land as their own versions.
    write(root, "a.md", "---\ntitle: A\n---\nBefore the turn\n");
    write(root, "b.md", "---\ntitle: B\n---\nBefore the turn\n");
    let began = fixture.begin(root, "t1:turn", TurnWrap::Version).await;
    assert!(matches!(
        began,
        TurnBegin::First {
            closed: Some(Ok(AutoVersions::Done { commits: 2, .. }))
        }
    ));
    assert!(dirty(root).await.is_empty());
    assert_eq!(log(root).await.len(), 4);

    // Edits during the turn are not committed by any closing.
    write(root, "a.md", "---\ntitle: A\n---\nBy the agent\n");
    write(root, "Notes/new.md", "---\ntitle: New\n---\nNew\n");
    assert!(turns::holds(root));
    assert_eq!(
        fixture.close_all(root).await,
        AutoVersions::Held(Held::Turn)
    );
    assert_eq!(dirty(root).await, ["Notes/new.md", "a.md"]);

    // After the turn: one version with a template message, the device
    // person as author and no trailers.
    assert_eq!(ended(fixture.end("t1:turn").await), (1, false));
    assert!(!turns::holds(root));
    assert_eq!(last_commit(root).await, ["Notes/new.md", "a.md"]);
    assert!(dirty(root).await.is_empty());
    let message = git(&cli(), root, &["log", "-1", "--format=%B"]).await;
    let author = git(&cli(), root, &["log", "-1", "--format=%an <%ae>"]).await;
    assert_eq!(author.trim(), "Test <test@example.test>");
    let trailers = git(
        &cli(),
        root,
        &["log", "-1", "--format=%(trailers:only,unfold)"],
    )
    .await;
    assert!(trailers.trim().is_empty(), "{trailers}");
    let lower = message.to_lowercase();
    assert!(
        !lower.contains("agent") && !lower.contains("t1") && !lower.contains("turn"),
        "{message}"
    );
    // The closing before the turn and the turn each deliver their commits.
    assert_eq!(fixture.host.commits.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn parallel_turns_give_one_version_and_a_turn_without_changes_none() {
    let tmp = pages().await;
    let root = tmp.path();
    let fixture = Fixture::new();
    assert!(matches!(
        fixture.begin(root, "t2:first", TurnWrap::Version).await,
        TurnBegin::First {
            closed: Some(Ok(AutoVersions::Done { commits: 0, .. }))
        }
    ));
    assert!(matches!(
        fixture.begin(root, "t2:second", TurnWrap::Version).await,
        TurnBegin::Joined
    ));
    write(root, "a.md", "---\ntitle: A\n---\nFirst agent\n");
    write(root, "b.md", "---\ntitle: B\n---\nSecond agent\n");
    assert!(matches!(
        fixture.end("t2:first").await,
        TurnEnd::Continuing { .. }
    ));
    assert_eq!(dirty(root).await, ["a.md", "b.md"]);
    write(root, "c.md", "---\ntitle: C\n---\nSecond agent again\n");
    assert_eq!(ended(fixture.end("t2:second").await), (1, false));
    assert_eq!(last_commit(root).await, ["a.md", "b.md", "c.md"]);
    assert_eq!(log(root).await.len(), 3);

    // A turn that changes nothing makes no version.
    fixture.begin(root, "t2:idle", TurnWrap::Version).await;
    assert_eq!(ended(fixture.end("t2:idle").await), (0, false));
    assert_eq!(log(root).await.len(), 3);
    assert!(matches!(fixture.end("t2:idle").await, TurnEnd::Unknown));
}

#[tokio::test]
async fn editor_edits_on_paths_the_turn_did_not_touch_keep_their_own_groups() {
    let tmp = pages().await;
    let root = tmp.path();
    let fixture = Fixture::new();
    fixture.begin(root, "t3:turn", TurnWrap::Version).await;
    write(root, "a.md", "---\ntitle: A\n---\nBy the agent\n");
    write(root, "b.md", "---\ntitle: B\n---\nBy the editor\n");
    turns::editor_wrote(&[root.join("b.md")]);
    // The editor wrote c.md, then the agent changed it again: the turn's.
    write(root, "c.md", "---\ntitle: C\n---\nBy the editor\n");
    turns::editor_wrote(&[root.join("c.md")]);
    std::thread::sleep(Duration::from_millis(20));
    write(
        root,
        "c.md",
        "---\ntitle: C\n---\nBy the editor and the agent\n",
    );

    assert_eq!(ended(fixture.end("t3:turn").await), (1, false));
    assert_eq!(last_commit(root).await, ["a.md", "c.md"]);
    assert_eq!(dirty(root).await, ["b.md"]);
    // The editor's group closes like any other.
    assert!(matches!(
        fixture.close_all(root).await,
        AutoVersions::Done { commits: 1, .. }
    ));
    assert_eq!(last_commit(root).await, ["b.md"]);
}

#[tokio::test]
async fn a_turn_with_the_commit_request_is_not_wrapped_and_the_next_turn_is() {
    let tmp = pages().await;
    let root = tmp.path();
    let fixture = Fixture::new();
    write(root, "a.md", "---\ntitle: A\n---\nBefore the request\n");
    // Nothing is committed before the turn that asks the agent to commit.
    assert!(matches!(
        fixture
            .begin(root, "t4:request", TurnWrap::AgentCommits)
            .await,
        TurnBegin::First { closed: None }
    ));
    assert_eq!(dirty(root).await, ["a.md"]);
    // The agent commits a.md itself and leaves b.md uncommitted.
    git(
        &cli(),
        root,
        &["commit", "-q", "-m", "Agent commit", "--", "a.md"],
    )
    .await;
    write(root, "b.md", "---\ntitle: B\n---\nLeft by the agent\n");
    assert_eq!(
        fixture.close_all(root).await,
        AutoVersions::Held(Held::Turn)
    );
    assert_eq!(ended(fixture.end("t4:request").await), (0, false));
    assert_eq!(log(root).await[0], "Agent commit");
    assert_eq!(dirty(root).await, ["b.md"]);

    // The next turn of the same session is wrapped as usual: what the agent
    // left returns to the ordinary groups and closes before it.
    assert!(matches!(
        fixture.begin(root, "t4:next", TurnWrap::Version).await,
        TurnBegin::First {
            closed: Some(Ok(AutoVersions::Done { commits: 1, .. }))
        }
    ));
    assert_eq!(last_commit(root).await, ["b.md"]);
    write(root, "c.md", "---\ntitle: C\n---\nNext turn\n");
    assert_eq!(ended(fixture.end("t4:next").await), (1, false));
    assert_eq!(last_commit(root).await, ["c.md"]);
}

#[tokio::test]
async fn a_routine_run_with_update_properties_and_an_agent_turn_inside_is_one_version() {
    let tmp = pages().await;
    let root = tmp.path();
    let fixture = Fixture::new();
    // The run starts; its UpdateProperties write lands in the frontmatter.
    fixture.begin(root, "t5:routine", TurnWrap::Version).await;
    write(root, "a.md", "---\ntitle: A\nstatus: done\n---\nA\n");
    // A `run_agent` turn inside the run changes other Pages.
    assert!(matches!(
        fixture.begin(root, "t5:acp", TurnWrap::Version).await,
        TurnBegin::Joined
    ));
    write(root, "b.md", "---\ntitle: B\n---\nBy the Routine agent\n");
    write(root, "Reports/day.md", "---\ntitle: Day\n---\nReport\n");
    assert!(matches!(
        fixture.end("t5:acp").await,
        TurnEnd::Continuing { .. }
    ));
    assert_eq!(ended(fixture.end("t5:routine").await), (1, false));
    assert_eq!(last_commit(root).await, ["Reports/day.md", "a.md", "b.md"]);
    assert!(dirty(root).await.is_empty());
}

#[tokio::test]
async fn a_system_path_changed_during_a_turn_lands_as_its_own_commit() {
    let tmp = pages().await;
    let root = tmp.path();
    write(root, ".svode/config.json", "{\"name\":\"Root\"}\n");
    commit_all(root).await;
    let fixture = Fixture::new();
    fixture.begin(root, "t6:turn", TurnWrap::Version).await;
    write(root, "a.md", "---\ntitle: A\n---\nBy the agent\n");
    // The agent renames the Space through MCP: a system commit right away.
    write(root, ".svode/config.json", "{\"name\":\"Renamed\"}\n");
    let service = AutocommitService::new(
        std::sync::Arc::new(GitRuntime::with_cli(cli())),
        std::sync::Arc::new(TestHost::default()),
    );
    service
        .commit_system_now(
            root.to_path_buf(),
            root.to_path_buf(),
            SystemCommitKind::SpaceConfig,
        )
        .await
        .expect("system commit");
    assert_eq!(last_commit(root).await, [".svode/config.json"]);
    assert!(dirty(root).await.contains(&"a.md".to_string()));
    // The version of the turn takes the content path only.
    assert_eq!(ended(fixture.end("t6:turn").await), (1, false));
    assert_eq!(last_commit(root).await, ["a.md"]);
    assert!(!dirty(root).await.contains(&"a.md".to_string()));
}

#[tokio::test]
async fn without_content_commits_turns_and_routine_runs_make_no_versions() {
    let tmp = pages().await;
    let root = tmp.path();
    policy(root, false);
    let fixture = Fixture::new();
    write(root, "a.md", "---\ntitle: A\n---\nBefore\n");
    assert!(matches!(
        fixture.begin(root, "t7:turn", TurnWrap::Version).await,
        TurnBegin::Off
    ));
    assert!(!turns::holds(root));
    write(root, "b.md", "---\ntitle: B\n---\nDuring\n");
    assert!(matches!(fixture.end("t7:turn").await, TurnEnd::Unknown));
    fixture.begin(root, "t7:routine", TurnWrap::Version).await;
    assert!(matches!(fixture.end("t7:routine").await, TurnEnd::Unknown));
    assert_eq!(dirty(root).await, ["a.md", "b.md"]);
    assert_eq!(log(root).await.len(), 2);
}

/// A local clone and another clone of one bare remote, with content
/// commits on in the local one.
async fn remote_pair() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
    let cli = cli();
    let temp = tempfile::tempdir().unwrap();
    let remote = temp.path().join("remote.git");
    let local = temp.path().join("local");
    let other = temp.path().join("other");
    git(
        &cli,
        temp.path(),
        &[
            "init",
            "--bare",
            "-q",
            "-b",
            "main",
            remote.to_str().unwrap(),
        ],
    )
    .await;
    for clone in [&local, &other] {
        git(
            &cli,
            temp.path(),
            &[
                "clone",
                "-q",
                remote.to_str().unwrap(),
                clone.to_str().unwrap(),
            ],
        )
        .await;
        git(&cli, clone, &["config", "user.name", "Test"]).await;
        git(&cli, clone, &["config", "user.email", "test@example.test"]).await;
        git(&cli, clone, &["config", "commit.gpgsign", "false"]).await;
        git(&cli, clone, &["checkout", "-q", "-B", "main"]).await;
    }
    write(&local, "a.md", "---\ntitle: A\n---\nA\n");
    write(&local, ".gitignore", ".svode/local.json\n");
    commit_all(&local).await;
    git(&cli, &local, &["push", "-q", "-u", "origin", "main"]).await;
    git(&cli, &other, &["pull", "-q", "origin", "main"]).await;
    git(
        &cli,
        &other,
        &["branch", "-q", "--set-upstream-to=origin/main", "main"],
    )
    .await;
    policy(&local, true);
    (temp, local, other)
}

#[tokio::test]
async fn incoming_changes_are_fetched_during_a_turn_and_integrated_after_it() {
    let cli = cli();
    let (_temp, local, other) = remote_pair().await;
    write(&other, "incoming.md", "---\ntitle: In\n---\nIn\n");
    commit_all(&other).await;
    git(&cli, &other, &["push", "-q"]).await;
    let incoming = git(&cli, &other, &["rev-parse", "HEAD"]).await;
    let head = git(&cli, &local, &["rev-parse", "HEAD"]).await;

    let fixture = Fixture::new();
    fixture.begin(&local, "t8:turn", TurnWrap::Version).await;
    write(&local, "a.md", "---\ntitle: A\n---\nBy the agent\n");
    for mode in [SyncMode::Background, SyncMode::Explicit] {
        assert!(matches!(
            sync_with(&cli, &local, mode).await.expect("sync"),
            SyncResult::IntegrationAfterTurn
        ));
    }
    // The fetch ran; the working copy, HEAD and the remote are unchanged.
    assert_eq!(
        git(&cli, &local, &["rev-parse", "origin/main"]).await,
        incoming
    );
    assert_eq!(git(&cli, &local, &["rev-parse", "HEAD"]).await, head);
    assert!(!local.join("incoming.md").exists());

    // The end of the turn reports the deferred integration; the next sync
    // integrates and publishes the version of the turn.
    assert_eq!(ended(fixture.end("t8:turn").await), (1, true));
    // Explicit: a Git without merges in memory only fast-forwards in the
    // background, and the turn's version diverged from the incoming commit.
    let after = sync_with(&cli, &local, SyncMode::Explicit)
        .await
        .expect("sync");
    assert!(matches!(after, SyncResult::Success { .. }), "{after:?}");
    assert!(local.join("incoming.md").exists());
    assert_eq!(
        git(&cli, &local, &["rev-parse", "HEAD"]).await,
        git(&cli, &local, &["rev-parse", "origin/main"]).await
    );
}

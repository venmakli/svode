//! System changes in the lifecycle of automatic commits over real
//! repositories (Stage 11 1.E «Виды коммитов и жизненный цикл», DF-322
//! R2, R3): with content commits, system paths land with the versions of
//! their turn, operation or owner; with only system commits, they land as
//! their own commits by owner; structural paths and the paths of a pending
//! Space creation never land with either.

use std::path::Path;
use std::time::{Duration, SystemTime};

use super::MessageLanguage;
use super::auto::{AutoVersions, Closing, Held, Lifecycle, close, lifecycle};
use super::turns::{self, TurnBegin, TurnEnd, TurnWrap};
use crate::git::pending::{StructuralChange, StructuralOp};
use crate::git::policy::{GitUserPolicy, write_user_policy};
use crate::git::staging_tests::{TestHost, cli, git, repo, write};
use crate::git::state::GitRuntime;

const PAUSE: Duration = Duration::from_secs(60);
const ROOT_CONFIG: &str = "{\"name\":\"Root\"}\n";

fn set_policy(repo: &Path, content: bool, structural: bool, system: bool) {
    write_user_policy(
        repo,
        &GitUserPolicy {
            auto_commit_content: content,
            auto_commit_structural: structural,
            auto_commit_system: system,
            auto_sync: false,
        },
    )
    .expect("write policy");
}

fn changed_ago(repo: &Path, path: &str, ago: Duration) {
    std::fs::File::options()
        .write(true)
        .open(repo.join(path))
        .expect("open")
        .set_modified(SystemTime::now() - ago)
        .expect("set modified");
}

async fn commit_all(root: &Path) {
    let cli = cli();
    git(&cli, root, &["add", "--all"]).await;
    git(&cli, root, &["commit", "-q", "-m", "Base"]).await;
}

async fn subjects(root: &Path) -> Vec<String> {
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

/// A born repository with two committed Pages, a root config and ignore
/// rules.
async fn project() -> tempfile::TempDir {
    let tmp = repo(&cli(), true).await;
    let root = tmp.path();
    write(root, "a.md", "---\ntitle: A\n---\nA\n");
    write(root, "b.md", "---\ntitle: B\n---\nB\n");
    write(root, ".gitignore", ".svode/local.json\n");
    write(root, ".svode/config.json", ROOT_CONFIG);
    commit_all(root).await;
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

    async fn close(&self, repo: &Path, closing: Closing) -> AutoVersions {
        close(
            &self.runtime,
            &self.host,
            repo,
            &closing,
            MessageLanguage::En,
        )
        .await
        .expect("close")
    }

    async fn commits(&self, repo: &Path, closing: Closing) -> usize {
        match self.close(repo, closing).await {
            AutoVersions::Done { commits, .. } => commits,
            other => panic!("commits expected, got {other:?}"),
        }
    }

    async fn begin(&self, repo: &Path, key: &str) -> TurnBegin {
        turns::begin(
            &self.runtime,
            &self.host,
            repo,
            key,
            TurnWrap::Version,
            MessageLanguage::En,
        )
        .await
    }

    async fn end(&self, key: &str) -> usize {
        match turns::end(&self.runtime, &self.host, key, MessageLanguage::En).await {
            TurnEnd::Ended { version, .. } => version.expect("version of the turn"),
            other => panic!("the last turn ends: {other:?}"),
        }
    }
}

#[test]
fn the_lifecycle_follows_the_effective_policy() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    assert_eq!(lifecycle(root), None);
    set_policy(root, false, true, false);
    assert_eq!(lifecycle(root), None);
    set_policy(root, false, false, true);
    assert_eq!(lifecycle(root), Some(Lifecycle::System));
    // Content commits include system commits as read (R1).
    set_policy(root, true, false, false);
    assert_eq!(lifecycle(root), Some(Lifecycle::Content));
}

#[tokio::test]
async fn a_turn_with_content_commits_lands_its_page_space_config_and_ignore_rules_as_one_version() {
    let tmp = project().await;
    let root = tmp.path();
    // Saved as "content without system commits": read with them on.
    set_policy(root, true, false, false);
    let fixture = Fixture::new();
    assert!(matches!(
        fixture.begin(root, "df322:turn").await,
        TurnBegin::First { .. }
    ));
    write(root, "a.md", "---\ntitle: A\n---\nBy the agent\n");
    write(root, ".svode/config.json", "{\"name\":\"Renamed\"}\n");
    write(root, ".gitignore", ".svode/local.json\n*.tmp\n");
    assert_eq!(
        fixture.close(root, Closing::all(PAUSE)).await,
        AutoVersions::Held(Held::Turn)
    );

    assert_eq!(fixture.end("df322:turn").await, 1);
    assert_eq!(
        last_commit(root).await,
        [".gitignore", ".svode/config.json", "a.md"]
    );
    assert!(dirty(root).await.is_empty());
    // The message is the one of the turn's content: the system paths are
    // its tail, not a fact of their own.
    let subject = subjects(root).await.remove(0);
    assert!(subject.starts_with("A: "), "{subject}");
}

#[tokio::test]
async fn with_content_commits_a_system_change_without_a_turn_closes_by_the_pause_and_before_a_sync()
{
    let tmp = project().await;
    let root = tmp.path();
    set_policy(root, true, true, true);
    let fixture = Fixture::new();

    // As `update_space_metadata` of MCP writes it.
    write(root, ".svode/config.json", "{\"name\":\"Renamed\"}\n");
    // Changed a moment ago: neither the pause nor leaving a Page closes it.
    let left = Closing {
        left: vec![String::new(), ".svode".into(), "a.md".into()],
        ..Closing::paused(PAUSE)
    };
    let AutoVersions::Done { commits, next } = fixture.close(root, left).await else {
        panic!("versions expected");
    };
    assert_eq!(commits, 0);
    assert!(next.is_some());
    changed_ago(root, ".svode/config.json", PAUSE + Duration::from_secs(1));
    assert_eq!(fixture.commits(root, Closing::paused(PAUSE)).await, 1);
    assert_eq!(last_commit(root).await, [".svode/config.json"]);
    assert_eq!(subjects(root).await[0], "Renamed: settings");

    // Before a sync every group closes, the system ones too.
    write(root, ".gitignore", ".svode/local.json\n*.tmp\n");
    write(root, "b.md", "---\ntitle: B\n---\nB2\n");
    assert_eq!(fixture.commits(root, Closing::all(PAUSE)).await, 2);
    assert!(dirty(root).await.is_empty());
}

#[tokio::test]
async fn structural_paths_never_land_with_versions() {
    let tmp = project().await;
    let root = tmp.path();
    set_policy(root, true, true, true);
    let fixture = Fixture::new();
    write(root, "a.md", "---\ntitle: A\n---\nA2\n");
    write(root, ".svode/config.json", "{\"name\":\"Renamed\"}\n");
    write(
        root,
        ".gitmodules",
        "[submodule \"x\"]\n\tpath = x\n\turl = ./x\n",
    );
    assert_eq!(fixture.commits(root, Closing::all(PAUSE)).await, 2);
    assert_eq!(dirty(root).await, [".gitmodules"]);
}

/// A committed folder Page with its own ignore rules, deleted on disk by a
/// registered delete that names both files it removed.
async fn folder_deleted(fixture: &Fixture, root: &Path) {
    write(root, "Docs/README.md", "---\ntitle: Docs\n---\n");
    write(root, "Docs/.gitignore", "*.tmp\n");
    commit_all(root).await;
    std::fs::remove_dir_all(root.join("Docs")).unwrap();
    fixture.runtime.pending().record(
        root,
        Some(StructuralChange::new(StructuralOp::Delete("Docs".into()))),
        vec![root.join("Docs/README.md"), root.join("Docs/.gitignore")],
    );
}

#[tokio::test]
async fn with_content_commits_the_system_paths_of_a_registered_operation_land_in_its_group() {
    let tmp = project().await;
    let root = tmp.path();
    set_policy(root, true, true, true);
    let fixture = Fixture::new();
    folder_deleted(&fixture, root).await;

    assert_eq!(fixture.commits(root, Closing::paused(PAUSE)).await, 1);
    assert_eq!(
        last_commit(root).await,
        ["Docs/.gitignore", "Docs/README.md"]
    );
    assert!(dirty(root).await.is_empty());
}

#[tokio::test]
async fn with_manual_content_commits_a_save_keeps_the_system_paths_of_an_operation_apart() {
    let tmp = project().await;
    let root = tmp.path();
    set_policy(root, false, false, false);
    let fixture = Fixture::new();
    folder_deleted(&fixture, root).await;

    let report = crate::git::save::save(
        &fixture.runtime,
        &fixture.host,
        None,
        root,
        None,
        MessageLanguage::En,
    )
    .await
    .expect("save");
    assert!(report.parent.is_none());
    let log = subjects(root).await;
    let commit_of = async |subject: &str| {
        let index = log
            .iter()
            .position(|known| known == subject)
            .unwrap_or_else(|| panic!("{subject} in {log:?}"));
        let mut paths = git(
            &cli(),
            root,
            &["show", "--name-only", "--format=", &format!("HEAD~{index}")],
        )
        .await
        .lines()
        .map(str::to_string)
        .collect::<Vec<_>>();
        paths.sort();
        paths
    };
    assert_eq!(commit_of("Delete “Docs”").await, ["Docs/README.md"]);
    assert_eq!(commit_of("Docs: settings").await, ["Docs/.gitignore"]);
    assert!(dirty(root).await.is_empty());
}

#[tokio::test]
async fn with_only_system_commits_a_system_change_lands_alone_by_the_pause() {
    let tmp = project().await;
    let root = tmp.path();
    set_policy(root, false, false, true);
    let fixture = Fixture::new();
    write(root, ".svode/config.json", "{\"name\":\"Renamed\"}\n");
    write(root, "a.md", "---\ntitle: A\n---\nUncommitted\n");
    changed_ago(root, ".svode/config.json", PAUSE + Duration::from_secs(1));
    changed_ago(root, "a.md", PAUSE + Duration::from_secs(1));

    assert_eq!(fixture.commits(root, Closing::paused(PAUSE)).await, 1);
    assert_eq!(last_commit(root).await, [".svode/config.json"]);
    assert_eq!(subjects(root).await[0], "Renamed: settings");
    assert_eq!(dirty(root).await, ["a.md"]);
    // Each owner is its own commit.
    write(root, ".gitignore", ".svode/local.json\n*.tmp\n");
    write(root, "Docs/.svode/AGENTS.md", "Rules\n");
    assert_eq!(fixture.commits(root, Closing::all(PAUSE)).await, 2);
    assert_eq!(dirty(root).await, ["a.md"]);
    // Each closing delivers its commits once.
    assert_eq!(fixture.host.commits.lock().unwrap().len(), 2);

    // With system commits off nothing is committed.
    set_policy(root, false, true, false);
    write(root, ".svode/config.json", "{\"name\":\"Again\"}\n");
    assert_eq!(
        fixture.close(root, Closing::all(PAUSE)).await,
        AutoVersions::Off
    );
    assert_eq!(dirty(root).await, [".svode/config.json", "a.md"]);
}

#[tokio::test]
async fn with_only_system_commits_registered_content_operations_wait_for_a_manual_commit() {
    let tmp = project().await;
    let root = tmp.path();
    set_policy(root, false, false, true);
    let fixture = Fixture::new();
    folder_deleted(&fixture, root).await;

    assert_eq!(fixture.commits(root, Closing::all(PAUSE)).await, 0);
    assert_eq!(dirty(root).await, ["Docs/.gitignore", "Docs/README.md"]);
    assert_eq!(fixture.runtime.pending().peek_under(root).len(), 1);
}

#[tokio::test]
async fn with_only_system_commits_an_external_space_ref_keeps_its_creation_paths_out() {
    let tmp = project().await;
    let root = tmp.path();
    set_policy(root, false, false, true);
    let fixture = Fixture::new();
    // An Inline Space created by another process.
    write(
        root,
        ".svode/config.json",
        "{\"name\":\"Root\",\"spaces\":[{\"id\":\"notes\",\"path\":\"notes\"}]}\n",
    );
    write(
        root,
        ".gitignore",
        ".svode/local.json\nnotes/.svode/local.json\n",
    );
    write(root, "notes/.svode/config.json", "{\"name\":\"Notes\"}\n");
    write(root, "notes/README.md", "---\ntitle: Notes\n---\n");
    write(root, ".mailmap", "Test <test@example.test>\n");

    assert_eq!(fixture.commits(root, Closing::all(PAUSE)).await, 1);
    assert_eq!(last_commit(root).await, [".mailmap"]);
    assert_eq!(
        dirty(root).await,
        [
            ".gitignore",
            ".svode/config.json",
            "notes/.svode/config.json",
            "notes/README.md"
        ]
    );

    // The structural flag makes the creation commit first, then nothing of
    // it is left for a system commit.
    set_policy(root, false, true, true);
    assert_eq!(fixture.commits(root, Closing::all(PAUSE)).await, 0);
    assert_eq!(subjects(root).await[0], "Add inline space notes");
    assert!(dirty(root).await.is_empty());
}

#[tokio::test]
async fn with_only_system_commits_a_turn_holds_the_system_groups_until_after_it() {
    let tmp = project().await;
    let root = tmp.path();
    set_policy(root, false, false, true);
    let fixture = Fixture::new();
    let TurnBegin::First { closed } = fixture.begin(root, "df322:system").await else {
        panic!("the turn is tracked");
    };
    assert!(closed.is_none());
    assert!(turns::holds(root));
    // Only content commits hold the integration of a sync.
    assert!(!turns::defer_integration(root));
    write(root, ".svode/config.json", "{\"name\":\"Renamed\"}\n");
    write(root, "a.md", "---\ntitle: A\n---\nBy the agent\n");
    changed_ago(root, ".svode/config.json", PAUSE + Duration::from_secs(1));
    assert_eq!(
        fixture.close(root, Closing::all(PAUSE)).await,
        AutoVersions::Held(Held::Turn)
    );

    // No version of the turn: the system group closes by its own rules.
    assert_eq!(fixture.end("df322:system").await, 0);
    assert!(!turns::holds(root));
    assert_eq!(dirty(root).await, [".svode/config.json", "a.md"]);
    assert_eq!(fixture.commits(root, Closing::paused(PAUSE)).await, 1);
    assert_eq!(last_commit(root).await, [".svode/config.json"]);
    assert_eq!(dirty(root).await, ["a.md"]);
}
